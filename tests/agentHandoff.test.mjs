import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-agentHandoff.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/agentHandoff.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { shouldStartAutomaticQa, terminalStartBlockReason } = require(outfile);

assert.equal(shouldStartAutomaticQa('ready-for-qa', 'build', false, undefined, 'v1'), true, 'a completed build terminal must be replaceable');
assert.equal(shouldStartAutomaticQa('ready-for-qa', 'qa', false, undefined, 'v1'), false, 'a live QA terminal must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, true, undefined, 'v1'), false, 'an in-flight launch must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v1'), false, 'the same task version must not retry forever');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v2'), true, 'a newly updated task version may retry');
assert.equal(shouldStartAutomaticQa('building', 'build', false, undefined, 'v1'), false, 'build state must not start QA');

assert.match(
  terminalStartBlockReason('TASK-001', 'build', [{ taskId: 'TASK-001', kind: 'build' }]),
  /already has an active/,
  'the same task cannot get a duplicate terminal'
);
assert.match(
  terminalStartBlockReason('TASK-002', 'build', [{ taskId: 'TASK-001', kind: 'build' }]),
  /one at a time/,
  'build concurrency is limited across the workspace'
);
assert.equal(
  terminalStartBlockReason('TASK-002', 'qa', [{ taskId: 'TASK-001', kind: 'build' }]),
  undefined,
  'isolated QA may run while a build is active'
);

console.log('Agent handoff tests passed.');
