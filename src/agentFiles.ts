import * as vscode from 'vscode';

export const columns = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready-for-agent', title: 'Ready for Agent' },
  { id: 'building', title: 'Building' },
  { id: 'ready-for-qa', title: 'Ready for QA' },
  { id: 'qa-running', title: 'QA Running' },
  { id: 'failed-qa', title: 'Failed QA' },
  { id: 'human-review', title: 'Human Review' },
  { id: 'done', title: 'Done' }
] as const;

export function agentsMarkdown(): string {
  return `# Repository Agents

## Agent Board Workflow

This repository uses Agent Board as the source of truth for AI coding work. The visual board is backed by files in \`.agent-board/\`; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. Check \`.agent-board/board.json\` before starting work.
2. Read \`.agent-board/project.json\` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
3. Find tasks with status \`ready-for-agent\`.
4. Prefer tasks where \`assignedAgent\` is \`codex\` or \`unassigned\`.
5. Claim a task with \`node .agent-board/scripts/claim-next-task.mjs codex\`, or manually update the task JSON with:
   - \`status: "building"\`
   - \`claimedBy\`: your agent name
   - \`branchName\`: a task branch such as \`agent-board/TASK-001-short-title\`
   - \`lastUpdated\`: current ISO timestamp
6. Work on the task branch when Git is available. The claim script creates and checks out the branch automatically.
7. Read the matching \`.agent-board/tasks/TASK-ID.json\`.
8. Implement only that task.
9. Update \`agentNotes\`, \`relevantFiles\`, and append clear entries to \`activityLog\` as work progresses.
10. Run relevant tests, lint, typecheck, or build commands from the task and project context.
11. Move the task to \`ready-for-qa\` when implementation and validation are complete.
12. QA agents should claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID codex\` or \`claude\`, run functional and design QA, then pass or fail the task.
13. If blocked, add a blocker note, append an activity entry, and set \`status\` to \`human-review\`.

Preserve unknown fields in Agent Board JSON files. Before writing, reread the task file and avoid overwriting newer updates from another agent or the VS Code extension.
`;
}

export function claudeSkillMarkdown(): string {
  return `# Agent Board

Use Agent Board when asked to continue project work in this repository.

## Workflow

1. Inspect \`.agent-board/board.json\`.
2. Read \`.agent-board/project.json\` for project overview, rules, validation commands, design rules, glossary, and inferred repo context.
3. Pick the highest-priority task with status \`ready-for-agent\` assigned to \`claude\` or \`unassigned\`.
4. Claim the task with \`node .agent-board/scripts/claim-next-task.mjs claude\`, or manually set:
   - \`status: "building"\`
   - \`claimedBy: "claude"\`
   - \`branchName\`: a task branch such as \`agent-board/TASK-001-short-title\`
   - \`lastUpdated\`: current ISO timestamp
5. Work on the task branch when Git is available. The claim script creates and checks out the branch automatically.
6. Read the task JSON in \`.agent-board/tasks/\`.
7. Build according to the project context, task description, acceptance criteria, constraints, and QA checklist.
8. Update the task file as work progresses.
9. Add changed files to \`relevantFiles\`.
10. Add clear implementation notes to \`agentNotes\`.
11. Append concise activity entries for major decisions and validation results.
12. Run relevant validation commands such as tests, lint, typecheck, or build.
13. Move the task to \`ready-for-qa\` when complete.
14. If acting as QA agent, claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID claude\`, check acceptance criteria, QA checklist, design QA checklist, changed files, and validation evidence.
15. Move the task to \`human-review\` if blocked or uncertain.

The \`.agent-board/\` folder is the source of truth. Preserve unknown fields and reread files before editing so other agent updates are not lost.
`;
}

export function claimNextTaskScript(): string {
  return `#!/usr/bin/env node
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
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\\n');
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
`;
}

export function claimTaskScript(): string {
  return `#!/usr/bin/env node
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
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\\n');
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
`;
}

export function completeTaskScript(): string {
  return `#!/usr/bin/env node
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
await writeFile(tmp, JSON.stringify(task, null, 2) + '\\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
`;
}

export function startQaScript(): string {
  return `#!/usr/bin/env node
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
await writeFile(tmp, JSON.stringify(task, null, 2) + '\\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
`;
}

export function passQaScript(): string {
  return `#!/usr/bin/env node
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
await writeFile(tmp, JSON.stringify(task, null, 2) + '\\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
`;
}

export function failQaScript(): string {
  return `#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [taskId, ...reasonParts] = process.argv.slice(2);
const reason = reasonParts.join(' ').trim();
if (!taskId || !reason) {
  console.error('Usage: node .agent-board/scripts/fail-qa.mjs TASK-001 "failure reason"');
  process.exit(1);
}

const path = join(process.cwd(), '.agent-board', 'tasks', taskId + '.json');
const task = JSON.parse(await readFile(path, 'utf8'));
const now = new Date().toISOString();
const actor = task.qaClaimedBy || task.qaAgent || 'qa';
task.status = 'failed-qa';
task.lastUpdated = now;
task.qaNotes = Array.isArray(task.qaNotes) ? task.qaNotes : [];
task.qaNotes.push({ timestamp: now, actor, message: reason });
task.activityLog = Array.isArray(task.activityLog) ? task.activityLog : [];
task.activityLog.push({ timestamp: now, actor, message: 'QA failed: ' + reason });

const tmp = path + '.tmp';
await writeFile(tmp, JSON.stringify(task, null, 2) + '\\n');
await rename(tmp, path);
console.log(JSON.stringify(task, null, 2));
`;
}

export async function writeExecutableFile(uri: vscode.Uri, content: string): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}
