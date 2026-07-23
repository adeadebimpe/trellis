import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertTaskLockKey } from './taskIds';

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_HEARTBEAT_MS = 5000;

interface HeldLock {
  lockDir: string;
  token: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors the scaffolded .trellis/scripts/_lib.mjs lock: mkdir is the
// atomic acquisition primitive. Heartbeats keep asynchronous holders fresh,
// while PID liveness protects holders blocked in synchronous Git operations.
function isProcessAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockDir: string): { token?: string; pid?: number } | null {
  try {
    return JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as { token?: string; pid?: number };
  } catch {
    return null;
  }
}

async function acquireLock(locksDir: string, key: string, owner: string): Promise<HeldLock> {
  assertTaskLockKey(key);
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
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(lockDir).mtimeMs;
      } catch {
        continue;
      }
      if (ageMs > LOCK_STALE_MS && !isProcessAlive(readOwner(lockDir)?.pid)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        let holder = 'unknown';
        try {
          holder = readFileSync(join(lockDir, 'owner.json'), 'utf8');
        } catch {
          // Keep 'unknown'.
        }
        throw new Error(`Could not lock ${key} within ${LOCK_TIMEOUT_MS}ms. Held by: ${holder}`);
      }
      await sleep(100 + Math.floor(Math.random() * 150));
    }
  }
}

function stillOwnsLock(lock: HeldLock): boolean {
  return readOwner(lock.lockDir)?.token === lock.token;
}

export function refreshLock(lock: HeldLock): boolean {
  if (!stillOwnsLock(lock)) return false;
  const now = new Date();
  utimesSync(lock.lockDir, now, now);
  return true;
}

export function releaseLock(lock: HeldLock): void {
  if (stillOwnsLock(lock)) rmSync(lock.lockDir, { recursive: true, force: true });
}

export async function withLock<T>(locksDir: string, key: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(locksDir, key, owner);
  const heartbeat = setInterval(() => refreshLock(lock), LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    releaseLock(lock);
  }
}
