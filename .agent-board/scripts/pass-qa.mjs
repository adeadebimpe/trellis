#!/usr/bin/env node
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, ...noteParts] = process.argv.slice(2);
  const note = noteParts.join(' ').trim() || 'QA passed.';
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/pass-qa.mjs TASK-001 "optional note"');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'pass-qa', async () => {
    const current = await readJson(path);
    if (current.status !== 'qa-running') {
      throw fail(2, 'Task must be qa-running to pass QA. Current status: ' + current.status + '. Run start-qa.mjs first.');
    }
    if (!Array.isArray(current.qaEvidence) || current.qaEvidence.length === 0) {
      throw fail(3, 'qaEvidence is empty. Run run-validation.mjs and record QA evidence before passing.');
    }
    if (!current.lastValidation || !current.lastValidation.passed) {
      throw fail(4, 'Validation has not passed. Run: node .agent-board/scripts/run-validation.mjs ' + taskId);
    }
    const now = new Date().toISOString();
    const actor = current.qaClaimedBy || current.qaAgent || 'qa';
    current.status = 'human-review';
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.qaNotes.push({ timestamp: now, actor, message: note });
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'QA passed. Moved task to human-review.' });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
