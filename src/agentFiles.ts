export const columns = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'ready-for-agent', title: 'Ready for Agent' },
  { id: 'building', title: 'Building' },
  { id: 'ready-for-qa', title: 'Ready for QA' },
  { id: 'qa-running', title: 'QA Running' },
  { id: 'failed-qa', title: 'Failed QA' },
  { id: 'human-review', title: 'Human Review' },
  { id: 'done', title: 'Done' },
  { id: 'merged', title: 'Merged' }
] as const;

export function agentsMarkdown(): string {
  return `# Repository Agents

## Agent Board Workflow

This repository uses Trellis as the source of truth for AI coding work. Task state lives in \`.agent-board/tasks/*.json\` in the MAIN checkout; do not rely on copied prompts as the durable task record.

Agents should follow this workflow:

1. List \`.agent-board/tasks/\` to see all tasks and read \`.agent-board/project.json\` for project overview, coding rules, agent rules, validation commands, design rules, glossary, and inferred stack context.
2. Find tasks with status \`ready-for-agent\`. Prefer tasks where \`assignedAgent\` is \`codex\` or \`unassigned\`.
3. Claim work with \`node .agent-board/scripts/claim-next-task.mjs codex\` (or \`claim-task.mjs TASK-ID codex\`). The script follows project.json \`workflowMode\`: it either creates a task worktree or explicitly selects the main checkout.
4. Do ALL code work in the printed worktree path. In \`direct-on-main\` mode this is the main checkout and only one build may run at once. Task state always lives in the MAIN checkout's \`.agent-board/\`.
5. Read the task JSON printed by the claim script. Implement only that task.
6. Update \`agentNotes\`, \`relevantFiles\`, and append clear entries to \`activityLog\` in the main checkout's task file as work progresses.
7. Commit your work in the selected workspace. In branch-per-task mode, commit on the task branch; in direct-on-main mode, commit on the current project branch.
8. Run \`node .agent-board/scripts/run-validation.mjs TASK-ID\`. This runs the task or project validation commands in the worktree and records evidence on the task. It is required: \`complete-task\` refuses without a passing validation run.
9. Move the task to QA with \`node .agent-board/scripts/complete-task.mjs TASK-ID\`.
10. QA agents claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID codex\` (or \`claude\`), review acceptance criteria and changed files in the worktree, re-run \`run-validation.mjs\`, then \`pass-qa.mjs TASK-ID "note"\` or \`fail-qa.mjs TASK-ID "specific failure reason"\`. Passing QA requires the task to be \`qa-running\`, non-empty \`qaEvidence\`, and a passing validation run.
11. If blocked, add a blocker note, append an activity entry, and set \`status\` to \`human-review\`.

Preserve unknown fields in Trellis JSON files. The scripts take a per-task lock; if you edit task JSON manually, reread the file first and avoid overwriting newer updates from another agent or the VS Code extension.
`;
}

export function claudeSkillMarkdown(): string {
  return `# Trellis

Use Trellis when asked to continue project work in this repository.

## Workflow

1. List \`.agent-board/tasks/\` and read \`.agent-board/project.json\` for project overview, rules, validation commands, design rules, glossary, and inferred repo context.
2. Pick the highest-priority task with status \`ready-for-agent\` assigned to \`claude\` or \`unassigned\`.
3. Claim it with \`node .agent-board/scripts/claim-next-task.mjs claude\` (or \`claim-task.mjs TASK-ID claude\`). The script follows project.json \`workflowMode\`: it either creates a task worktree or explicitly selects the main checkout.
4. Do ALL code work in the printed worktree path. In \`direct-on-main\` mode this is the main checkout and only one build may run at once. Task state always lives in the MAIN checkout's \`.agent-board/\`.
5. Build according to the project context, task description, acceptance criteria, constraints, and QA checklist.
6. Update \`relevantFiles\`, \`agentNotes\`, and append concise \`activityLog\` entries in the main checkout's task file as work progresses.
7. Commit your work in the selected workspace. In branch-per-task mode, commit on the task branch; in direct-on-main mode, commit on the current project branch.
8. Run \`node .agent-board/scripts/run-validation.mjs TASK-ID\` — it runs the validation commands in the worktree and records evidence. \`complete-task\` refuses without a passing validation run.
9. Move the task to QA with \`node .agent-board/scripts/complete-task.mjs TASK-ID\`.
10. If acting as QA agent, claim ready QA work with \`node .agent-board/scripts/start-qa.mjs TASK-ID claude\`, check acceptance criteria, QA checklist, design QA checklist, and changed files in the worktree, re-run \`run-validation.mjs\`, then \`pass-qa.mjs TASK-ID "note"\` or \`fail-qa.mjs TASK-ID "reason"\`.
11. Move the task to \`human-review\` if blocked or uncertain.
12. After completing a task, run \`node .agent-board/scripts/claim-next-task.mjs claude\`. Continue in the returned worktree and repeat until it prints \`{"noTask":true}\`.

The main checkout's \`.agent-board/\` folder is the source of truth. Preserve unknown fields; the scripts lock tasks while writing, so prefer them over manual JSON edits.
`;
}

export function boardLibScript(): string {
  return `#!/usr/bin/env node
// Shared helpers for Trellis scripts. Task state always lives in the MAIN
// git worktree's .agent-board/, no matter which worktree a script runs from.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_HEARTBEAT_MS = 5000;
const TASK_ID_PATTERN = /^TASK-\\d{3,}$/;
const CLAIM_LEASE_MS = 30 * 60 * 1000;

export function assertTaskId(taskId) {
  if (!TASK_ID_PATTERN.test(String(taskId))) {
    throw fail(1, 'Invalid task ID: ' + taskId + '. Expected TASK followed by at least three digits.');
  }
  return taskId;
}

function assertLockKey(key) {
  if (key !== '_board') assertTaskId(key);
}

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function isGitRepo(cwd) {
  try {
    git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

export function codeSnapshot(cwd) {
  if (!isGitRepo(cwd)) return { git: false };
  return {
    git: true,
    head: git(['rev-parse', 'HEAD'], cwd),
    branch: git(['branch', '--show-current'], cwd),
    clean: meaningfulGitChanges(cwd).length === 0
  };
}

function meaningfulGitChanges(cwd) {
  return git(['status', '--porcelain=v1', '--untracked-files=all'], cwd)
    .split('\\n')
    .filter(Boolean)
    .filter((line) => !line.slice(3).startsWith('.agent-board/'));
}

export function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function newClaimId() {
  return randomUUID();
}

export function leaseExpiry() {
  return new Date(Date.now() + CLAIM_LEASE_MS).toISOString();
}

export function leaseExpired(task) {
  if (task.status !== 'building') return false;
  const expiry = task.leaseExpiresAt || (task.claimedAt ? new Date(Date.parse(task.claimedAt) + CLAIM_LEASE_MS).toISOString() : '');
  return Boolean(expiry) && Date.parse(expiry) <= Date.now();
}

export function taskEligibility(task, tasks, project, agent) {
  const byId = new Map(tasks.map((item) => [item.id, item]));
  const unfinished = (Array.isArray(task.dependsOn) ? task.dependsOn : []).filter((id) => !['done', 'merged'].includes(byId.get(id)?.status));
  if (unfinished.length) return 'waiting for ' + unfinished.join(', ');
  const available = new Set(Array.isArray(project?.agentCapabilities?.[agent]) ? project.agentCapabilities[agent] : []);
  const missing = (Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : []).filter((item) => !available.has(item));
  return missing.length ? 'missing capabilities: ' + missing.join(', ') : '';
}

export function effectivePriority(task) {
  const base = { high: 0, medium: 100, low: 200 }[task.priority] ?? 300;
  const since = Date.parse(task.readyAt || task.lastUpdated || new Date().toISOString());
  const waitingDays = Math.max(0, (Date.now() - since) / 86400000);
  return base - Math.min(250, waitingDays * 10);
}

export function resolveMainRoot(startDir = process.cwd()) {
  if (isGitRepo(startDir)) {
    try {
      const porcelain = git(['worktree', 'list', '--porcelain'], startDir);
      const first = porcelain.split('\\n').find((line) => line.startsWith('worktree '));
      if (first) {
        const mainPath = first.slice('worktree '.length).trim();
        if (existsSync(join(mainPath, '.agent-board'))) {
          return mainPath;
        }
      }
    } catch {
      // Fall through to directory walk.
    }
  }
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, '.agent-board'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(startDir);
    }
    dir = parent;
  }
}

export function taskPath(mainRoot, taskId) {
  assertTaskId(taskId);
  return join(mainRoot, '.agent-board', 'tasks', taskId + '.json');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\\n');
  await rename(tmp, path);
}

function sleep(ms) {
  return new Promise((resolveDone) => setTimeout(resolveDone, ms));
}

export async function acquireLock(mainRoot, key, owner) {
  assertLockKey(key);
  const locksDir = join(mainRoot, '.agent-board', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockDir = join(locksDir, key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      const token = randomUUID();
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner, token, pid: process.pid, acquiredAt: new Date().toISOString() }));
      return { lockDir, token };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue; // Lock vanished between mkdir and stat; retry immediately.
      }
      let lockOwner = null;
      try {
        lockOwner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
      } catch {
        // An owner that crashed before writing metadata is stealable once stale.
      }
      if (ageMs > LOCK_STALE_MS && !isProcessAlive(lockOwner?.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        let holder = 'unknown';
        try {
          holder = await readFile(join(lockDir, 'owner.json'), 'utf8');
        } catch {
          // Keep 'unknown'.
        }
        throw new Error('Could not lock ' + key + ' within ' + LOCK_TIMEOUT_MS + 'ms. Held by: ' + holder);
      }
      await sleep(100 + Math.floor(Math.random() * 150));
    }
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function stillOwnsLock(lock) {
  try {
    return JSON.parse(readFileSync(join(lock.lockDir, 'owner.json'), 'utf8')).token === lock.token;
  } catch {
    return false;
  }
}

export function refreshLock(lock) {
  if (!stillOwnsLock(lock)) return false;
  const now = new Date();
  utimesSync(lock.lockDir, now, now);
  return true;
}

export function releaseLock(lock) {
  if (stillOwnsLock(lock)) rmSync(lock.lockDir, { recursive: true, force: true });
}

export async function withTaskLock(mainRoot, key, owner, fn) {
  const lock = await acquireLock(mainRoot, key, owner);
  const heartbeat = setInterval(() => refreshLock(lock), LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseLock(lock);
  }
}

export function slug(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

export function ensureWorktree(mainRoot, task, workflowMode = 'branch-per-task') {
  if (workflowMode === 'direct-on-main') {
    const dirtyCount = isGitRepo(mainRoot) ? meaningfulGitChanges(mainRoot).length : 0;
    const warning = dirtyCount ? 'Main has ' + dirtyCount + ' uncommitted file(s). Review them before the agent starts.' : '';
    return { branchName: '', worktreePath: mainRoot, warning, message: 'Claimed task in direct-on-main mode.' + (warning ? ' Warning: ' + warning : '') };
  }
  const branchName = task.branchName || 'agent-board/' + task.id + '-' + slug(task.title);
  if (!isGitRepo(mainRoot)) {
    return { branchName, worktreePath: '', message: 'Claimed task. No worktree was created because this folder is not a Git repository.' };
  }
  try {
    const expectedPath = resolve(join(mainRoot, '.agent-board', 'worktrees', task.id));
    const porcelain = git(['worktree', 'list', '--porcelain'], mainRoot);
    for (const block of porcelain.split('\\n\\n')) {
      if (block.includes('branch refs/heads/' + branchName)) {
        const line = block.split('\\n').find((entry) => entry.startsWith('worktree '));
        if (line) {
          const existingPath = line.slice('worktree '.length).trim();
          if (resolve(existingPath) !== expectedPath || (task.worktreeTaskId && task.worktreeTaskId !== task.id)) {
            throw new Error('Existing worktree provenance does not match ' + task.id + '.');
          }
          return { branchName, worktreePath: existingPath, baseSha: task.worktreeBaseSha || git(['merge-base', 'HEAD', branchName], mainRoot), message: 'Reusing verified worktree at ' + existingPath + ' on branch ' + branchName + '.' };
        }
      }
    }
    const worktreePath = expectedPath;
    const baseSha = git(['rev-parse', 'HEAD'], mainRoot);
    mkdirSync(join(mainRoot, '.agent-board', 'worktrees'), { recursive: true });
    let branchExists = true;
    try {
      git(['rev-parse', '--verify', 'refs/heads/' + branchName], mainRoot);
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      git(['worktree', 'add', worktreePath, branchName], mainRoot);
      return { branchName, worktreePath, baseSha, message: 'Created worktree at ' + worktreePath + ' on existing branch ' + branchName + '.' };
    }
    git(['worktree', 'add', '-b', branchName, worktreePath], mainRoot);
    return { branchName, worktreePath, baseSha, message: 'Created worktree at ' + worktreePath + ' on new branch ' + branchName + '.' };
  } catch (error) {
    throw fail(4, 'Could not create the task worktree; the task was not claimed. ' + (error && error.message ? error.message : String(error)));
  }
}

export function normalizeWorkflowMode(project) {
  return project?.workflowMode === 'direct-on-main' ? 'direct-on-main' : 'branch-per-task';
}

export async function projectWorkflowMode(mainRoot) {
  try {
    return normalizeWorkflowMode(await readJson(join(mainRoot, '.agent-board', 'project.json')));
  } catch {
    return 'branch-per-task';
  }
}

export async function assertDirectModeAvailable(mainRoot, taskId) {
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  for (const file of await readdir(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    const other = await readJson(join(tasksDir, file));
    if (other.id !== taskId && ['building', 'qa-running'].includes(other.status) && other.workflowMode === 'direct-on-main') {
      throw fail(5, 'Direct-on-main is already active for ' + other.id + '. Finish that build or QA run before starting another task.');
    }
  }
}

export function fail(exitCode, message) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

export async function runScript(main) {
  try {
    await main();
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exit(typeof error?.exitCode === 'number' ? error.exitCode : 1);
  }
}
`;
}

export function claimNextTaskScript(): string {
  return `#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertDirectModeAvailable, assertTaskId, effectivePriority, ensureWorktree, fail, leaseExpired, leaseExpiry, newClaimId, projectWorkflowMode, readJson, resolveMainRoot, runScript, taskEligibility, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const agent = process.argv[2];
  if (!agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-next-task.mjs claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const workflowMode = await projectWorkflowMode(mainRoot);
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const files = (await readdir(tasksDir)).filter((file) => file.endsWith('.json'));
  const records = [];
  for (const file of files) {
    try {
      const id = file.slice(0, -'.json'.length);
      assertTaskId(id);
      const path = join(tasksDir, file);
      const task = await readJson(path);
      if (task.id !== id) throw new Error('embedded id does not match filename');
      records.push({ task, path });
    } catch (error) {
      console.error('[SKIP] ' + file + ': ' + (error?.message || error));
    }
  }
  const tasks = records.map(({ task }) => task);
  let project = {};
  try { project = await readJson(join(mainRoot, '.agent-board', 'project.json')); } catch {}

  const candidates = records
    .filter(({ task }) => (task.status === 'ready-for-agent' || leaseExpired(task)) && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .filter(({ task }) => !taskEligibility(task, tasks, project, agent))
    .sort((a, b) => effectivePriority(a.task) - effectivePriority(b.task) || String(a.task.id).localeCompare(String(b.task.id)));

  for (const candidate of candidates) {
    const path = candidate.path;
    const claimMode = candidate.task.workflowMode || workflowMode;
    const claimed = await withTaskLock(mainRoot, claimMode === 'direct-on-main' ? '_board' : candidate.task.id, agent, async () => {
      const task = await readJson(path);
      if ((task.status !== 'ready-for-agent' && !leaseExpired(task)) || (task.assignedAgent !== agent && task.assignedAgent !== 'unassigned')) {
        return null; // Lost the race; try the next candidate.
      }
      const blocked = taskEligibility(task, tasks, project, agent);
      if (blocked) return null;
      const now = new Date().toISOString();
      if (claimMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, task.id);
      const worktree = ensureWorktree(mainRoot, task, claimMode);
      task.status = 'building';
      task.assignedAgent = agent;
      task.claimedBy = agent;
      task.claimId = newClaimId();
      task.claimGeneration = Number(task.claimGeneration || 0) + 1;
      task.leaseExpiresAt = leaseExpiry();
      task.worktreeTaskId = task.id;
      task.worktreeBaseSha = worktree.baseSha || task.worktreeBaseSha || '';
      task.workflowMode = claimMode;
      task.claimWarning = worktree.warning || '';
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

  const blocked = tasks
    .filter((task) => (task.status === 'ready-for-agent' || leaseExpired(task)) && (task.assignedAgent === agent || task.assignedAgent === 'unassigned'))
    .map((task) => ({ id: task.id, reason: taskEligibility(task, tasks, project, agent) }))
    .filter((entry) => entry.reason);
  console.log(JSON.stringify({
    noTask: true,
    agent,
    message: blocked.length
      ? 'No eligible tasks. Blocked: ' + blocked.map((entry) => entry.id + ' (' + entry.reason + ')').join(', ')
      : 'No eligible ready-for-agent tasks remain.'
  }));
});
`;
}

export function claimTaskScript(): string {
  return `#!/usr/bin/env node
import { join } from 'node:path';
import { assertDirectModeAvailable, ensureWorktree, fail, leaseExpired, leaseExpiry, newClaimId, projectWorkflowMode, readJson, resolveMainRoot, runScript, taskEligibility, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent] = process.argv.slice(2);
  if (!taskId || !agent || !['claude', 'codex'].includes(agent)) {
    throw fail(1, 'Usage: node .agent-board/scripts/claim-task.mjs TASK-001 claude|codex');
  }

  const mainRoot = resolveMainRoot();
  const workflowMode = await projectWorkflowMode(mainRoot);
  const path = taskPath(mainRoot, taskId);
  const tasksDir = join(mainRoot, '.agent-board', 'tasks');
  const tasks = [];
  for (const file of await (await import('node:fs/promises')).readdir(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    try { tasks.push(await readJson(join(tasksDir, file))); } catch {}
  }
  let project = {};
  try { project = await readJson(join(mainRoot, '.agent-board', 'project.json')); } catch {}
  const candidate = await readJson(path);
  const claimMode = candidate.workflowMode || workflowMode;

  const task = await withTaskLock(mainRoot, claimMode === 'direct-on-main' ? '_board' : taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-agent' && !leaseExpired(current)) {
      throw fail(2, 'Task must be ready-for-agent before build can start.');
    }
    const blocked = taskEligibility(current, tasks, project, agent);
    if (blocked) throw fail(5, 'Task is not eligible: ' + blocked + '.');
    if (current.assignedAgent && current.assignedAgent !== 'unassigned' && current.assignedAgent !== agent) {
      throw fail(3, 'Task is assigned to ' + current.assignedAgent + ', not ' + agent + '.');
    }
    const now = new Date().toISOString();
    if (claimMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, current.id);
    const worktree = ensureWorktree(mainRoot, current, claimMode);
    current.status = 'building';
    current.assignedAgent = agent;
    current.claimedBy = agent;
    current.claimId = newClaimId();
    current.claimGeneration = Number(current.claimGeneration || 0) + 1;
    current.leaseExpiresAt = leaseExpiry();
    current.worktreeTaskId = current.id;
    current.worktreeBaseSha = worktree.baseSha || current.worktreeBaseSha || '';
    current.workflowMode = claimMode;
    current.claimWarning = worktree.warning || '';
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.claimedAt = now;
    current.lastUpdated = now;
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
`;
}

export function heartbeatTaskScript(): string {
  return `#!/usr/bin/env node
import { leaseExpiry, fail, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, claimId] = process.argv.slice(2);
  if (!taskId || !claimId) throw fail(1, 'Usage: heartbeat-task.mjs TASK-ID CLAIM-ID');
  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);
  await withTaskLock(mainRoot, taskId, 'heartbeat', async () => {
    const task = await readJson(path);
    if (task.status !== 'building' || task.claimId !== claimId) throw fail(2, 'Claim is no longer active.');
    task.leaseExpiresAt = leaseExpiry();
    task.lastUpdated = new Date().toISOString();
    await writeJson(path, task);
  });
});
`;
}

export function completeTaskScript(): string {
  return `#!/usr/bin/env node
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
`;
}

export function startQaScript(): string {
  return `#!/usr/bin/env node
import { assertDirectModeAvailable, ensureWorktree, fail, newClaimId, readJson, resolveMainRoot, runScript, taskPath, withTaskLock, writeJson } from './_lib.mjs';

await runScript(async () => {
  const [taskId, agent = 'qa'] = process.argv.slice(2);
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/start-qa.mjs TASK-001 codex|claude');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);

  const task = await withTaskLock(mainRoot, (await readJson(path)).workflowMode === 'direct-on-main' ? '_board' : taskId, agent, async () => {
    const current = await readJson(path);
    if (current.status !== 'ready-for-qa' && current.status !== 'failed-qa') {
      throw fail(2, 'Task must be ready-for-qa or failed-qa before QA can start.');
    }
    const now = new Date().toISOString();
    if (current.workflowMode === 'direct-on-main') await assertDirectModeAvailable(mainRoot, current.id);
    const worktree = ensureWorktree(mainRoot, current, current.workflowMode);
    current.status = 'qa-running';
    current.qaClaimedBy = agent;
    current.qaClaimId = newClaimId();
    current.qaStartedAt = now;
    current.qaAgent = current.qaAgent && current.qaAgent !== 'unassigned' ? current.qaAgent : (['claude', 'codex'].includes(agent) ? agent : 'unassigned');
    current.branchName = worktree.branchName;
    current.worktreePath = worktree.worktreePath;
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor: agent, message: 'Started QA. ' + worktree.message });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify({ task, taskFile: path, worktreePath: task.worktreePath }, null, 2));
});
`;
}

export function runValidationScript(): string {
  return `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { codeSnapshot, fail, readJson, resolveMainRoot, runScript, sameSnapshot, taskPath, withTaskLock, writeJson } from './_lib.mjs';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

function runCommand(command, cwd) {
  return new Promise((resolveDone) => {
    const child = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let done = false;
    const finish = (exitCode) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveDone({ exitCode, output });
    };
    const timer = setTimeout(() => {
      output += '\\n[run-validation] Timed out after ' + COMMAND_TIMEOUT_MS / 1000 + 's.';
      child.kill('SIGTERM');
      finish(124);
    }, COMMAND_TIMEOUT_MS);
    const capture = (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 200000) {
        output = output.slice(-100000);
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => {
      output += String(error);
      finish(127);
    });
    child.on('close', (code) => finish(code ?? 1));
  });
}

await runScript(async () => {
  const taskId = process.argv[2];
  if (!taskId) {
    throw fail(1, 'Usage: node .agent-board/scripts/run-validation.mjs TASK-001');
  }

  const mainRoot = resolveMainRoot();
  const path = taskPath(mainRoot, taskId);
  const task = await readJson(path);
  let project = {};
  try {
    project = await readJson(join(mainRoot, '.agent-board', 'project.json'));
  } catch {
    // Project context is optional here.
  }

  const commands = Array.isArray(task.validationCommands) && task.validationCommands.length
    ? task.validationCommands
    : Array.isArray(project.validationCommands) && project.validationCommands.length
      ? project.validationCommands
      : project.inference?.suggestedValidation ?? [];

  const approved = new Set([
    ...(Array.isArray(project.validationCommands) ? project.validationCommands : []),
    ...(Array.isArray(project.approvedValidationCommands) ? project.approvedValidationCommands : [])
  ]);
  const unapproved = commands.filter((command) => !approved.has(command));
  if (unapproved.length) {
    throw fail(2, 'Refusing unapproved validation command(s): ' + unapproved.join(', ') + '. Add exact commands to project.approvedValidationCommands after review.');
  }

  if (!commands.length) {
    throw fail(2, 'No validation commands configured on the task or project. Add validationCommands first.');
  }

  const cwd = task.worktreePath || mainRoot;
  const phase = task.status === 'qa-running' ? 'qa' : task.status === 'building' ? 'build' : '';
  if (!phase) {
    throw fail(2, 'Validation may only run while a task is building or qa-running.');
  }
  const claimId = phase === 'qa' ? task.qaClaimId : task.claimId;
  if (!claimId) {
    throw fail(2, 'Task has no active claim. Claim the task again before validation.');
  }
  const snapshotBefore = codeSnapshot(cwd);
  if (snapshotBefore.git && !snapshotBefore.clean) {
    throw fail(2, 'Commit or remove working-tree changes before validation.');
  }
  console.log('Running ' + commands.length + ' validation command(s) in ' + cwd);
  const results = [];
  for (const command of commands) {
    const startedAt = Date.now();
    const result = await runCommand(command, cwd);
    results.push({ command, exitCode: result.exitCode, durationMs: Date.now() - startedAt, outputTail: result.output.slice(-2000) });
    console.log((result.exitCode === 0 ? '[PASS] ' : '[FAIL exit ' + result.exitCode + '] ') + command);
  }

  const passed = results.every((result) => result.exitCode === 0);
  const ranAt = new Date().toISOString();
  const snapshotAfter = codeSnapshot(cwd);
  if (!sameSnapshot(snapshotBefore, snapshotAfter)) {
    throw fail(3, 'Code changed while validation was running; results were not recorded.');
  }

  await withTaskLock(mainRoot, taskId, 'run-validation', async () => {
    const fresh = await readJson(path);
    const freshClaimId = phase === 'qa' ? fresh.qaClaimId : fresh.claimId;
    if (fresh.status !== task.status || freshClaimId !== claimId || (fresh.worktreePath || mainRoot) !== cwd) {
      throw fail(3, 'Task ownership changed while validation was running; results were not recorded.');
    }
    fresh.lastValidation = { ranAt, passed, results, phase, claimId, snapshot: snapshotAfter };
    fresh.qaEvidence = Array.isArray(fresh.qaEvidence) ? fresh.qaEvidence : [];
    for (const result of results) {
      fresh.qaEvidence.push((result.exitCode === 0 ? 'PASS' : 'FAIL (exit ' + result.exitCode + ')') + ': ' + result.command);
    }
    fresh.activityLog = Array.isArray(fresh.activityLog) ? fresh.activityLog : [];
    fresh.activityLog.push({
      timestamp: ranAt,
      actor: fresh.claimedBy || fresh.qaClaimedBy || 'agent',
      message: 'Ran validation: ' + results.length + ' command(s), ' + (passed ? 'all passed.' : 'FAILED.')
    });
    fresh.lastUpdated = ranAt;
    await writeJson(path, fresh);
  });

  if (!passed) {
    throw fail(3, 'Validation failed. See task qaEvidence and lastValidation for details.');
  }
});
`;
}

export function passQaScript(): string {
  return `#!/usr/bin/env node
import { codeSnapshot, fail, readJson, resolveMainRoot, runScript, sameSnapshot, taskPath, withTaskLock, writeJson } from './_lib.mjs';

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
    if (current.lastValidation.phase !== 'qa' || current.lastValidation.claimId !== current.qaClaimId || current.lastValidation.ranAt <= current.qaStartedAt) {
      throw fail(4, 'QA must run fresh validation after QA starts.');
    }
    if (!sameSnapshot(codeSnapshot(current.worktreePath || mainRoot), current.lastValidation.snapshot)) {
      throw fail(4, 'Code changed after QA validation. Re-run validation.');
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
`;
}

export function failQaScript(): string {
  return `#!/usr/bin/env node
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
    if (current.status !== 'qa-running') {
      throw fail(2, 'Task must be qa-running to fail QA. Current status: ' + current.status + '.');
    }
    if (!current.qaClaimId) {
      throw fail(3, 'Task has no active QA claim. Start QA again before recording a failure.');
    }
    const now = new Date().toISOString();
    const actor = current.qaClaimedBy || current.qaAgent || 'qa';
    current.status = 'failed-qa';
    current.lastUpdated = now;
    current.qaNotes = Array.isArray(current.qaNotes) ? current.qaNotes : [];
    current.qaNotes.push({ timestamp: now, actor, claimId: current.qaClaimId, message: reason });
    current.activityLog = Array.isArray(current.activityLog) ? current.activityLog : [];
    current.activityLog.push({ timestamp: now, actor, message: 'QA failed: ' + reason });
    await writeJson(path, current);
    return current;
  });

  console.log(JSON.stringify(task, null, 2));
});
`;
}

export function boardGitignore(): string {
  return `activity.log
worktrees/
locks/
prompts/
board.json
*.tmp
`;
}
