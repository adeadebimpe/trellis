#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDirectModeAvailable, assertTaskId, effectivePriority, ensureWorktree, fail, leaseExpired, leaseExpiry, newClaimId, projectWorkflowMode, readJson, resolveMainRoot, runScript, taskEligibility, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [agent, surface = 'chat'] = process.argv.slice(2);
  if (!agent || !['claude', 'codex'].includes(agent) || !['chat', 'terminal'].includes(surface)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-next-task.mjs claude|codex chat|terminal');
  }

  const mainRoot = resolveMainRoot();
  const workflowMode = await projectWorkflowMode(mainRoot);
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const files = (await readdir(tasksDir)).filter((file) => file.endsWith('.json'));
  const records = [];
  for (const file of files) {
    try {
      const id = file.slice(0, -'.json'.length);
      assertTaskId(id);
      const path = join(tasksDir, file);
      const task = await readJson(path);
      if (task.id !== id) throw new Error('embedded id does not match filename');
      records.push({ task, path });
    } catch (error) {
      console.error('[SKIP] ' + file + ': ' + (error?.message || error));
    }
  }
  const tasks = records.map(({ task }) => task);
  let project = {};
  try { project = await readJson(join(mainRoot, '.agent-board', 'project.json')); } catch {}

  const candidates = records
    .filter(({ task }) => (task.status === 'ready-for-agent' || leaseExpired(task)) && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .filter(({ task }) => !taskEligibility(task, tasks, project, agent))
    .sort((a, b) => effectivePriority(a.task) - effectivePriority(b.task) || String(a.task.id).localeCompare(String(b.task.id)));

  for (const candidate of candidates) {
    const path = candidate.path;
    const claimMode = candidate.task.workflowMode || workflowMode;
    const claimed = await withTaskLock(mainRoot, claimMode === 'direct-on-main' ? '_board' : candidate.task.id, agent, async () => {
      const task = await readJson(path);
      if ((task.status !== 'ready-for-agent' && !leaseExpired(task)) || (task.assignedAgent !== agent && task.assignedAgent !== 'unassigned')) {
        return null; // Lost the race; try the next candidate.
      }
      const blocked = taskEligibility(task, tasks, project, agent);
      if (blocked) return null;
      const now = new Date().toISOString();
      if (claimMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, task.id);
      const worktree = ensureWorktree(mainRoot, task, claimMode);
      task.status = 'building';
      task.assignedAgent = agent;
      task.claimedBy = agent;
      task.claimId = newClaimId();
      task.activeRun = { phase: 'build', agent, surface, claimId: task.claimId, startedAt: now };
      task.claimGeneration = Number(task.claimGeneration || 0) + 1;
      task.leaseExpiresAt = leaseExpiry();
      task.worktreeTaskId = task.id;
      task.worktreeBaseSha = worktree.baseSha || task.worktreeBaseSha || '';
      task.workflowMode = claimMode;
      task.claimWarning = worktree.warning || '';
      task.branchName = worktree.branchName;
      task.worktreePath = worktree.worktreePath;
      task.claimedAt = now;
      task.lastUpdated = now;
      task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
      task.activityLog.push({ timestamp: now, actor: agent, message: worktree.message + ' Running Build in ' + surface + '.' });
      await writeJson(path, task);
      return task;
    });
    if (claimed) {
      console.log(JSON.stringify({ task: claimed, taskFile: path, worktreePath: claimed.worktreePath }, null, 2));
      return;
    }
  }

  const blocked = tasks
    .filter((task) => (task.status === 'ready-for-agent' || leaseExpired(task)) && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .map((task) => ({ id: task.id, reason: taskEligibility(task, tasks, project, agent) }))
    .filter((entry) => entry.reason);
  console.log(JSON.stringify({
    noTask: true,
    agent,
    message: blocked.length
      ? 'No eligible tasks. Blocked: ' + blocked.map((entry) => entry.id + ' (' + entry.reason + ')').join(', ')
      : 'No eligible ready-for-agent tasks remain.'
  }));
});
