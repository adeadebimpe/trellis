#!/usr/bin/env node
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
const TASK_ID_PATTERN = /^TASK-\d{3,}$/;
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
    .split('\n')
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
      const first = porcelain.split('\n').find((line) => line.startsWith('worktree '));
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
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
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
    for (const block of porcelain.split('\n\n')) {
      if (block.includes('branch refs/heads/' + branchName)) {
        const line = block.split('\n').find((entry) => entry.startsWith('worktree '));
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
