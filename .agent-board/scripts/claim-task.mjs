#!/usr/bin/env node
import { join } from 'node:path';
import { assertDirectModeAvailable, ensureWorktree, fail, leaseExpired, leaseExpiry, newClaimId, projectWorkflowMode, readJson, resolveMainRoot, runScript, taskEligibility, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent, surface = 'chat'] = process.argv.slice(2);
  if (!taskId || !agent || !['claude', 'codex'].includes(agent) || !['chat', 'terminal'].includes(surface)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-task.mjs TASK-001 claude|codex chat|terminal');
  }

  const mainRoot = resolveMainRoot();
  const workflowMode = await projectWorkflowMode(mainRoot);
  const path = taskPath(mainRoot, taskId);
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const tasks = [];
  for (const file of await (await import('node:fs/promises')).readdir(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    try { tasks.push(await readJson(join(tasksDir, file))); } catch {}
  }
  let project = {};
  try { project = await readJson(join(mainRoot, '.agent-board', 'project.json')); } catch {}
  const candidate = await readJson(path);
  const claimMode = candidate.workflowMode || workflowMode;

  const task = await withTaskLock(mainRoot, claimMode === 'direct-on-main' ? '_board' : taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-agent' && !leaseExpired(current)) {
      const run = current.activeRun;
      const detail = run ? ' Active ' + run.phase + ' is already running with ' + run.agent + ' in ' + run.surface + '.' : '';
      throw fail(2, 'Task must be ready-for-agent before build can start.' + detail);
    }
    const blocked = taskEligibility(current, tasks, project, agent);
    if (blocked) throw fail(5, 'Task is not eligible: ' + blocked + '.');
    if (current.assignedAgent && current.assignedAgent !== 'unassigned' && current.assignedAgent !== agent) {
      throw fail(3, 'Task is assigned to ' + current.assignedAgent + ', not ' + agent + '.');
    }
    const now = new Date().toISOString();
    if (claimMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, current.id);
    const worktree = ensureWorktree(mainRoot, current, claimMode);
    current.status = 'building';
    current.assignedAgent = agent;
    current.claimedBy = agent;
    current.claimId = newClaimId();
    current.activeRun = { phase: 'build', agent, surface, claimId: current.claimId, startedAt: now };
    current.claimGeneration = Number(current.claimGeneration || 0) + 1;
    current.leaseExpiresAt = leaseExpiry();
    current.worktreeTaskId = current.id;
    current.worktreeBaseSha = worktree.baseSha || current.worktreeBaseSha || '';
    current.workflowMode = claimMode;
    current.claimWarning = worktree.warning || '';
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.claimedAt = now;
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: worktree.message + ' Running Build in ' + surface + '.' });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
