import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-taskLifecycle.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/taskLifecycle.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { assertBoardActionAllowed, assertStatusChangeAllowed } = createRequire(import.meta.url)(outfile);

const task = {
  status: 'building',
  claimId: 'build-claim',
  lastValidation: { passed: true, phase: 'build', claimId: 'build-claim' }
};

assert.throws(() => assertBoardActionAllowed(task, 'mark-ready-qa'), /agent workflow/);
assert.throws(() => assertStatusChangeAllowed(task, 'ready-for-qa'), /agent workflow/);
assert.throws(() => assertStatusChangeAllowed({ ...task, status: 'ready-for-agent' }, 'building'), /assigned agent/);
assert.throws(() => assertStatusChangeAllowed({ ...task, status: 'qa-running' }, 'human-review'), /agent workflow/);
assert.doesNotThrow(() => assertStatusChangeAllowed({ ...task, status: 'human-review' }, 'done'));
assert.throws(() => assertStatusChangeAllowed({ ...task, status: 'building' }, 'done'), /Human Review/);

console.log('Task lifecycle tests passed.');
