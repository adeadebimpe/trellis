import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const output = '/tmp/agent-board-intakeState.mjs';
execFileSync('./node_modules/.bin/esbuild', [
  'webview/intakeState.ts',
  '--bundle',
  '--platform=node',
  '--format=esm',
  `--outfile=${output}`
], { stdio: 'inherit' });

const { dismissIntake, queueIntake, updateIntake } = await import(`${pathToFileURL(output).href}?${Date.now()}`);

let pending = queueIntake([], 'request-a', 'First independently submitted task');
pending = queueIntake(pending, 'request-b', 'Second independently submitted task');
pending = updateIntake(pending, 'request-a', { state: 'drafting', taskId: 'TASK-101' });

assert.deepEqual(
  pending.map(({ requestId, state, taskId }) => ({ requestId, state, taskId })),
  [
    { requestId: 'request-b', state: 'queued', taskId: undefined },
    { requestId: 'request-a', state: 'drafting', taskId: 'TASK-101' }
  ],
  'updating one submission does not alter another'
);

pending = updateIntake(pending, 'request-b', { state: 'error', message: 'Unreadable attachment' });
pending = updateIntake(pending, 'request-a', { state: 'done' });
assert.equal(pending.find((item) => item.requestId === 'request-a').state, 'done');
assert.equal(pending.find((item) => item.requestId === 'request-b').message, 'Unreadable attachment');

pending = queueIntake(pending, 'request-c', 'Third independently submitted task');
const dismissed = dismissIntake(pending, 'request-a');
assert.deepEqual(
  dismissed.map(({ requestId, state }) => ({ requestId, state })),
  [
    { requestId: 'request-c', state: 'queued' },
    { requestId: 'request-b', state: 'error' }
  ],
  'dismissing one submission removes only that row and preserves the remaining order'
);
assert.equal(pending.length, 3, 'dismissing does not mutate the existing queue');

console.log('Concurrent intake state tests passed.');
