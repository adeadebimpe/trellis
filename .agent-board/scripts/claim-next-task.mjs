#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorktree, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const agent = process.argv[2];
  if (!agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-next-task.mjs claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const priorityRank = { high: 0, medium: 1, low: 2 };

  const files = (await readdir(tasksDir)).filter((file) => file.endsWith('.json'));
  const tasks = await Promise.all(files.map((file) => readJson(join(tasksDir, file))));

  const candidates = tasks
    .filter((task) => task.status === 'ready-for-agent' && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .sort((a, b) => {
      const priorityDelta = (priorityRank[a.priority] ?? 99) - (priorityRank[b.priority] ?? 99);
      return priorityDelta || String(a.id).localeCompare(String(b.id));
    });

  for (const candidate of candidates) {
    const path = taskPath(mainRoot, candidate.id);
    const claimed = await withTaskLock(mainRoot, candidate.id, agent, async () => {
      const task = await readJson(path);
      if (task.status !== 'ready-for-agent' || (task.assignedAgent !== agent && task.assignedAgent !== 'unassigned')) {
        return null; // Lost the race; try the next candidate.
      }
      const now = new Date().toISOString();
      const worktree = ensureWorktree(mainRoot, task);
      task.status = 'building';
      task.assignedAgent = agent;
      task.claimedBy = agent;
      task.branchName = worktree.branchName;
      task.worktreePath = worktree.worktreePath;
      task.claimedAt = now;
      task.lastUpdated = now;
      task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
      task.activityLog.push({ timestamp: now, actor: agent, message: worktree.message });
      await writeJson(path, task);
      return task;
    });
    if (claimed) {
      console.log(JSON.stringify({ task: claimed, taskFile: path, worktreePath: claimed.worktreePath }, null, 2));
      return;
    }
  }

  console.log(JSON.stringify({ noTask: true, agent, message: 'No eligible ready-for-agent tasks remain.' }));
});
