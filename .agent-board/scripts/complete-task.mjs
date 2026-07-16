#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const taskId = process.argv[2];
if (!taskId) {
  console.error('Usage: node .agent-board/scripts/complete-task.mjs TASK-001');
  process.exit(1);
}

const path = join(process.cwd(), '.agent-board', 'tasks', taskId + '.json');
const task = JSON.parse(await readFile(path, 'utf8'));
const now = new Date().toISOString();
const actor = task.claimedBy || 'agent';
task.status = 'ready-for-qa';
task.lastUpdated = now;
task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
task.activityLog.push({ timestamp: now, actor, message: 'Moved task to ready-for-qa.' });

const tmp = path + '.tmp';
await writeFile(tmp, JSON.stringify(task, null, 2) + '\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
