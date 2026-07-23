#!/usr/bin/env node
import { codeSnapshot, fail, readJson, resolveMainRoot, runScript, sameSnapshot, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const taskId = process.argv[2];
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/complete-task.mjs TASK-001');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'complete-task', async () => {
    const current = await readJson(path);
    if (current.status !== 'building') {
      throw fail(2, 'Task must be building to complete. Current status: ' + current.status + '.');
    }
    if (!current.lastValidation || !current.lastValidation.passed) {
      throw fail(3, 'Validation has not passed. Run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    if (current.lastValidation.phase !== 'build' || current.lastValidation.claimId !== current.claimId) {
      throw fail(3, 'Validation does not belong to the current build claim. Re-run validation.');
    }
    const snapshot = codeSnapshot(current.worktreePath || mainRoot);
    if (!sameSnapshot(snapshot, current.lastValidation.snapshot)) {
      throw fail(3, 'Code changed after validation. Commit changes and re-run validation.');
    }
    if (current.claimedAt && current.lastValidation.ranAt <= current.claimedAt) {
      throw fail(3, 'Validation is older than the current claim. Re-run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    const now = new Date().toISOString();
    const actor = current.claimedBy || 'agent';
    current.status = 'ready-for-qa';
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'Moved task to ready-for-qa.' });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
