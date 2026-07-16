import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors the scaffolded .agent-board/scripts/_lib.mjs lock: mkdir is the only
// primitive that is atomic across processes here, and stale locks (>30s) are
// stolen so a crashed holder cannot wedge the board.
async function acquireLock(locksDir: string, key: string, owner: string): Promise<string> {
  mkdirSync(locksDir, { recursive: true });
  const lockDir = join(locksDir, key);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() }));
      return lockDir;
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
      if (ageMs > LOCK_STALE_MS) {
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

export async function withLock<T>(locksDir: string, key: string, owner: string, fn: () => Promise<T>): Promise<T> {
  const lockDir = await acquireLock(locksDir, key, owner);
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
