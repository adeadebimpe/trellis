import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-archive.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/archive.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { selectMergedTasksToArchive } = createRequire(import.meta.url)(outfile);

const tasks = Array.from({ length: 12 }, (_, index) => ({
  id: `TASK-${String(index + 1).padStart(3, '0')}`,
  status: 'merged',
  lastUpdated: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
}));
tasks.push({ id: 'TASK-099', status: 'human-review', lastUpdated: '2026-06-01T00:00:00.000Z' });

assert.deepEqual(selectMergedTasksToArchive(tasks), ['TASK-001', 'TASK-002']);
assert.deepEqual(selectMergedTasksToArchive(tasks.slice(0, 10)), []);
assert.deepEqual(selectMergedTasksToArchive(tasks, 0), tasks.filter((task) => task.status === 'merged').map((task) => task.id));
assert.throws(() => selectMergedTasksToArchive(tasks, -1), /cannot be negative/);

const nonMerged = [
  { id: 'TASK-020', status: 'done', lastUpdated: '2026-06-01T00:00:00.000Z' },
  { id: 'TASK-021', status: 'building', lastUpdated: '2026-06-01T00:00:00.000Z' },
  { id: 'TASK-022', status: 'backlog', lastUpdated: '2026-06-01T00:00:00.000Z' }
];
assert.deepEqual(selectMergedTasksToArchive([...tasks, ...nonMerged]), ['TASK-001', 'TASK-002']);
assert.deepEqual(selectMergedTasksToArchive(nonMerged, 0), []);

const tied = [
  { id: 'TASK-002', status: 'merged', lastUpdated: '2026-07-01T00:00:00.000Z' },
  { id: 'TASK-001', status: 'merged', lastUpdated: '2026-07-01T00:00:00.000Z' }
];
assert.deepEqual(selectMergedTasksToArchive(tied, 1), ['TASK-001']);

console.log('Archive selection tests passed.');
