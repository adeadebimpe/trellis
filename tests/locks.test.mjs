import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const outfile = '/private/tmp/agent-board-locks.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/locks.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { withLock } = createRequire(import.meta.url)(outfile);

const root = await mkdtemp(join(tmpdir(), 'agent-board-lock-owner-'));
const locksDir = join(root, 'locks');
mkdirSync(locksDir);

await withLock(locksDir, 'TASK-001', 'first-owner', async () => {
  const lockDir = join(locksDir, 'TASK-001');
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ owner: 'replacement', token: 'replacement-token', pid: process.pid }));
});

assert.equal(existsSync(join(locksDir, 'TASK-001')), true, 'an old owner must not delete a replacement lock');
await assert.rejects(() => withLock(locksDir, '../escape', 'bad-owner', async () => undefined), /Invalid task ID/);
await rm(root, { recursive: true, force: true });

console.log('Lock ownership tests passed.');
