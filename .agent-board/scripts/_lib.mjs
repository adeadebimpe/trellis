#!/usr/bin/env node
// Shared helpers for Trellis scripts. Task state always lives in the MAIN
// git worktree's .agent-board/, no matter which worktree a script runs from.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

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
  const locksDir = join(mainRoot, '.agent-board', 'locks');
  mkdirSync(locksDir, { recursive: true });
  const lockDir = join(locksDir, key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() }));
      return lockDir;
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
      if (ageMs > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue; // Exactly one stealer wins the next mkdir.
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

export function releaseLock(lockDir) {
  rmSync(lockDir, { recursive: true, force: true });
}

export async function withTaskLock(mainRoot, key, owner, fn) {
  const lockDir = await acquireLock(mainRoot, key, owner);
  try {
    return await fn();
  } finally {
    releaseLock(lockDir);
  }
}

export function slug(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

export function ensureWorktree(mainRoot, task) {
  const branchName = task.branchName || 'agent-board/' + task.id + '-' + slug(task.title);
  if (!isGitRepo(mainRoot)) {
    return { branchName, worktreePath: '', message: 'Claimed task. No worktree was created because this folder is not a Git repository.' };
  }
  try {
    const porcelain = git(['worktree', 'list', '--porcelain'], mainRoot);
    for (const block of porcelain.split('\n\n')) {
      if (block.includes('branch refs/heads/' + branchName)) {
        const line = block.split('\n').find((entry) => entry.startsWith('worktree '));
        if (line) {
          const existingPath = line.slice('worktree '.length).trim();
          return { branchName, worktreePath: existingPath, message: 'Reusing existing worktree at ' + existingPath + ' on branch ' + branchName + '.' };
        }
      }
    }
    const worktreePath = join(mainRoot, '.agent-board', 'worktrees', task.id);
    mkdirSync(join(mainRoot, '.agent-board', 'worktrees'), { recursive: true });
    let branchExists = true;
    try {
      git(['rev-parse', '--verify', 'refs/heads/' + branchName], mainRoot);
    } catch {
      branchExists = false;
    }
    if (branchExists) {
      git(['worktree', 'add', worktreePath, branchName], mainRoot);
      return { branchName, worktreePath, message: 'Created worktree at ' + worktreePath + ' on existing branch ' + branchName + '.' };
    }
    git(['worktree', 'add', '-b', branchName, worktreePath], mainRoot);
    return { branchName, worktreePath, message: 'Created worktree at ' + worktreePath + ' on new branch ' + branchName + '.' };
  } catch (error) {
    return { branchName, worktreePath: '', message: 'Claimed task, but worktree creation failed: ' + (error && error.message ? error.message : String(error)) };
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
