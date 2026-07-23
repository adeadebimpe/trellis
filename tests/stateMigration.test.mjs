import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const outfile = '/private/tmp/trellis-state-migration.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/stateMigration.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { migratedWorktreePaths, stateDirectoryAction } = require(outfile);

assert.equal(stateDirectoryAction(false, false), 'uninitialized');
assert.equal(stateDirectoryAction(true, false), 'current');
assert.equal(stateDirectoryAction(false, true), 'migrate-legacy');
assert.equal(stateDirectoryAction(true, true), 'conflict');

assert.deepEqual(
  migratedWorktreePaths('/repo/.trellis', [['TASK-001', 2], ['README', 1], ['TASK-002', 2]], 2),
  ['/repo/.trellis/worktrees/TASK-001', '/repo/.trellis/worktrees/TASK-002']
);

const storageSource = readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');
assert.match(
  storageSource,
  /workspace\.fs\.rename\(this\.legacyBoardDir, this\.boardDir, \{ overwrite: false \}\)/,
  'legacy state is moved without overwriting current state'
);
assert.match(
  storageSource,
  /execFileAsync\('git', \['worktree', 'repair', \.\.\.worktreePaths\]/,
  'registered worktrees are repaired after their parent directory moves'
);
assert.match(
  storageSource,
  /both \.trellis and legacy \.agent-board state/,
  'split state produces a clear recovery error'
);

console.log('State directory migration tests passed.');
