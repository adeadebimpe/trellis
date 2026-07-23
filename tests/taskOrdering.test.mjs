import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-taskOrdering.cjs';
execFileSync('./node_modules/.bin/esbuild', [
  'src/taskOrdering.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${outfile}`
], { stdio: 'inherit' });

const require = createRequire(import.meta.url);
const { compareTasksByLatestUpdate } = require(outfile);

const tasks = [
  { id: 'TASK-004', lastUpdated: 'invalid' },
  { id: 'TASK-003', lastUpdated: '2026-07-23T12:00:00.000Z' },
  { id: 'TASK-002', lastUpdated: '2026-07-23T13:00:00.000Z' },
  { id: 'TASK-001', lastUpdated: '2026-07-23T13:00:00.000Z' },
  { id: 'TASK-005', lastUpdated: '' }
];
const originalOrder = tasks.map((task) => task.id);
const ordered = tasks.slice().sort(compareTasksByLatestUpdate);

assert.deepEqual(
  ordered.map((task) => task.id),
  ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004', 'TASK-005'],
  'valid timestamps sort newest first, with task IDs breaking equal or invalid timestamp ties'
);
assert.deepEqual(tasks.map((task) => task.id), originalOrder, 'sorting a copied lane does not mutate board state');

console.log('Task ordering test passed.');
