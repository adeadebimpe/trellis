#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const [taskId, agent] = process.argv.slice(2);
if (!taskId || !agent || !['claude', 'codex'].includes(agent)) {
  console.error('Usage: node .agent-board/scripts/claim-task.mjs TASK-001 claude|codex');
  process.exit(1);
}

const root = process.cwd();
const taskPath = join(root, '.agent-board', 'tasks', taskId + '.json');
const exec = promisify(execFile);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await rename(tmp, path);
}

function slug(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

async function createBranch(task) {
  const branchName = task.branchName || 'agent-board/' + task.id + '-' + slug(task.title);
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    try {
      await exec('git', ['checkout', '-b', branchName], { cwd: root });
      return { branchName, message: 'Created and checked out branch ' + branchName + '.' };
    } catch {
      await exec('git', ['checkout', branchName], { cwd: root });
      return { branchName, message: 'Checked out existing branch ' + branchName + '.' };
    }
  } catch {
    return { branchName, message: 'Claimed task. Git branch was not created because this folder is not a Git repository.' };
  }
}

const task = await readJson(taskPath);
if (task.status !== 'ready-for-agent' && task.status !== 'building') {
  console.error('Task must be ready-for-agent before build can start.');
  process.exit(2);
}
if (task.assignedAgent && task.assignedAgent !== 'unassigned' && task.assignedAgent !== agent) {
  console.error('Task is assigned to ' + task.assignedAgent + ', not ' + agent + '.');
  process.exit(3);
}

const now = new Date().toISOString();
const branch = await createBranch(task);
task.status = 'building';
task.assignedAgent = agent;
task.claimedBy = agent;
task.branchName = branch.branchName;
task.lastUpdated = now;
task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
task.activityLog.push({ timestamp: now, actor: agent, message: branch.message });
task.activityLog.push({ timestamp: now, actor: agent, message: 'Agent launch requested from Agent Board.' });

await writeJson(taskPath, task);
console.log(JSON.stringify(task, null, 2));
