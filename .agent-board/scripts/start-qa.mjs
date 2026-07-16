#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [taskId, agent = 'qa'] = process.argv.slice(2);
if (!taskId) {
  console.error('Usage: node .agent-board/scripts/start-qa.mjs TASK-001 codex|claude');
  process.exit(1);
}

const path = join(process.cwd(), '.agent-board', 'tasks', taskId + '.json');
const task = JSON.parse(await readFile(path, 'utf8'));
if (task.status !== 'ready-for-qa' && task.status !== 'failed-qa') {
  console.error('Task must be ready-for-qa or failed-qa before QA can start.');
  process.exit(2);
}

const now = new Date().toISOString();
task.status = 'qa-running';
task.qaClaimedBy = agent;
task.qaAgent = task.qaAgent || (['claude', 'codex'].includes(agent) ? agent : 'unassigned');
task.lastUpdated = now;
task.qaNotes = Array.isArray(task.qaNotes) ? task.qaNotes : [];
task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
task.activityLog.push({ timestamp: now, actor: agent, message: 'Started QA.' });

const tmp = path + '.tmp';
await writeFile(tmp, JSON.stringify(task, null, 2) + '\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
