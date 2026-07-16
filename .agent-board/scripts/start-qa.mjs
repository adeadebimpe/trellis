#!/usr/bin/env node
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent = 'qa'] = process.argv.slice(2);
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/start-qa.mjs TASK-001 codex|claude');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-qa' && current.status !== 'failed-qa') {
      throw fail(2, 'Task must be ready-for-qa or failed-qa before QA can start.');
    }
    const now = new Date().toISOString();
    const worktree = ensureWorktree(mainRoot, current);
    current.status = 'qa-running';
    current.qaClaimedBy = agent;
    current.qaAgent = current.qaAgent && current.qaAgent !== 'unassigned' ? current.qaAgent : (['claude', 'codex'].includes(agent) ? agent : 'unassigned');
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: 'Started QA. ' + worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
