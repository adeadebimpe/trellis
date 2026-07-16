#!/usr/bin/env node
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent] = process.argv.slice(2);
  if (!taskId || !agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-task.mjs TASK-001 claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-agent' && current.status !== 'building') {
      throw fail(2, 'Task must be ready-for-agent before build can start.');
    }
    if (current.assignedAgent && current.assignedAgent !== 'unassigned' && current.assignedAgent !== agent) {
      throw fail(3, 'Task is assigned to ' + current.assignedAgent + ', not ' + agent + '.');
    }
    const now = new Date().toISOString();
    const worktree = ensureWorktree(mainRoot, current);
    current.status = 'building';
    current.assignedAgent = agent;
    current.claimedBy = agent;
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.claimedAt = now;
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
