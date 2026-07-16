#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [taskId, ...noteParts] = process.argv.slice(2);
const note = noteParts.join(' ').trim() || 'QA passed.';
if (!taskId) {
  console.error('Usage: node .agent-board/scripts/pass-qa.mjs TASK-001 "optional note"');
  process.exit(1);
}

const path = join(process.cwd(), '.agent-board', 'tasks', taskId + '.json');
const task = JSON.parse(await readFile(path, 'utf8'));
const now = new Date().toISOString();
const actor = task.qaClaimedBy || task.qaAgent || 'qa';
task.status = 'human-review';
task.lastUpdated = now;
task.qaNotes = Array.isArray(task.qaNotes) ? task.qaNotes : [];
task.qaNotes.push({ timestamp: now, actor, message: note });
task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
task.activityLog.push({ timestamp: now, actor, message: 'QA passed. Moved task to human-review.' });

const tmp = path + '.tmp';
await writeFile(tmp, JSON.stringify(task, null, 2) + '\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
