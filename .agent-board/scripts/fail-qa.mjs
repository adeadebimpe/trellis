#!/usr/bin/env node
import { fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, ...reasonParts] = process.argv.slice(2);
  const reason = reasonParts.join(' ').trim();
  if (!taskId || !reason) {
    throw fail(1, 'Usage: node .agent-board/scripts/fail-qa.mjs TASK-001 "failure reason"');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, taskId, 'fail-qa', async () => {
    const current = await readJson(path);
    const now = new Date().toISOString();
    const actor = current.qaClaimedBy || current.qaAgent || 'qa';
    current.status = 'failed-qa';
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.qaNotes.push({ timestamp: now, actor, message: reason });
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'QA failed: ' + reason });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
