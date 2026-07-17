import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-archive.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/archive.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { selectDoneTasksToArchive } = createRequire(import.meta.url)(outfile);

const tasks = Array.from({ length: 12 }, (_, index) => ({
  id: `TASK-${String(index + 1).padStart(3, '0')}`,
  status: 'done',
  lastUpdated: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`
}));
tasks.push({ id: 'TASK-099', status: 'human-review', lastUpdated: '2026-06-01T00:00:00.000Z' });

assert.deepEqual(selectDoneTasksToArchive(tasks), ['TASK-001', 'TASK-002']);
assert.deepEqual(selectDoneTasksToArchive(tasks.slice(0, 10)), []);
assert.deepEqual(selectDoneTasksToArchive(tasks, 0), tasks.filter((task) => task.status === 'done').map((task) => task.id));
assert.throws(() => selectDoneTasksToArchive(tasks, -1), /cannot be negative/);

const tied = [
  { id: 'TASK-002', status: 'done', lastUpdated: '2026-07-01T00:00:00.000Z' },
  { id: 'TASK-001', status: 'done', lastUpdated: '2026-07-01T00:00:00.000Z' }
];
assert.deepEqual(selectDoneTasksToArchive(tied, 1), ['TASK-001']);

console.log('Archive selection tests passed.');
