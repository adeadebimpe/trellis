#!/usr/bin/env node
import { assertDirectModeAvailable, ensureWorktree, fail, newClaimId, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent = 'qa', requestedSurface] = process.argv.slice(2);
  if (!taskId || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/start-qa.mjs TASK-001 codex|claude chat|terminal');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, (await readJson(path)).workflowMode === 'direct-on-main' ? '_board' : taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-qa' && current.status !== 'failed-qa') {
      throw fail(2, 'Task must be ready-for-qa or failed-qa before QA can start.');
    }
    const now = new Date().toISOString();
    const inheritedSurface = current.activeRun?.surface;
    if (requestedSurface && inheritedSurface && requestedSurface !== inheritedSurface) {
      throw fail(3, 'QA is reserved for ' + inheritedSurface + ' because Build ran there. Resume that session instead of starting QA in ' + requestedSurface + '.');
    }
    const surface = requestedSurface || inheritedSurface || 'chat';
    if (!['chat', 'terminal'].includes(surface)) throw fail(1, 'QA surface must be chat or terminal.');
    if (current.workflowMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, current.id);
    const worktree = ensureWorktree(mainRoot, current, current.workflowMode);
    current.status = 'qa-running';
    current.qaClaimedBy = agent;
    current.qaClaimId = newClaimId();
    current.activeRun = { phase: 'qa', agent, surface, claimId: current.qaClaimId, startedAt: now };
    current.qaStartedAt = now;
    current.qaAgent = current.qaAgent && current.qaAgent !== 'unassigned' ? current.qaAgent : (['claude', 'codex'].includes(agent) ? agent : 'unassigned');
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: 'Started QA in ' + surface + '. ' + worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
