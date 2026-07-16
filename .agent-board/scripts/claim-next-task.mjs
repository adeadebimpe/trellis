#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const agent = process.argv[2];
if (!agent || !['claude', 'codex'].includes(agent)) {
  console.error('Usage: node .agent-board/scripts/claim-next-task.mjs claude|codex');
  process.exit(1);
}

const root = process.cwd();
const tasksDir = join(root, '.agent-board', 'tasks');
const priorityRank = { high: 0, medium: 1, low: 2 };
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
    } catch (error) {
      await exec('git', ['checkout', branchName], { cwd: root });
      return { branchName, message: 'Checked out existing branch ' + branchName + '.' };
    }
  } catch {
    return { branchName, message: 'Claimed task. Git branch was not created because this folder is not a Git repository.' };
  }
}

const files = (await readdir(tasksDir)).filter((file) => file.endsWith('.json'));
const tasks = await Promise.all(files.map(async (file) => {
  const path = join(tasksDir, file);
  return { path, task: await readJson(path) };
}));

const candidates = tasks
  .filter(({ task }) => task.status === 'ready-for-agent' && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
  .sort((a, b) => {
    const priorityDelta = (priorityRank[a.task.priority] ?? 99) - (priorityRank[b.task.priority] ?? 99);
    return priorityDelta || String(a.task.id).localeCompare(String(b.task.id));
  });

if (candidates.length === 0) {
  console.error('No ready task found for ' + agent + '.');
  process.exit(2);
}

const selected = candidates[0];
const now = new Date().toISOString();
const branch = await createBranch(selected.task);
selected.task.status = 'building';
selected.task.claimedBy = agent;
selected.task.branchName = branch.branchName;
selected.task.lastUpdated = now;
selected.task.activityLog = Array.isArray(selected.task.activityLog) ? selected.task.activityLog : [];
selected.task.activityLog.push({ timestamp: now, actor: agent, message: branch.message });

await writeJson(selected.path, selected.task);
console.log(JSON.stringify(selected.task, null, 2));
