import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-agentHandoff.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/agentHandoff.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { isTerminalOwnedHandoff, shouldStartAutomaticQa } = require(outfile);

assert.equal(shouldStartAutomaticQa('ready-for-qa', 'build', false, undefined, 'v1'), true, 'a completed build terminal must be replaceable');
assert.equal(shouldStartAutomaticQa('ready-for-qa', 'qa', false, undefined, 'v1'), false, 'a live QA terminal must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, true, undefined, 'v1'), false, 'an in-flight launch must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v1'), false, 'the same task version must not retry forever');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v2'), true, 'a newly updated task version may retry');
assert.equal(shouldStartAutomaticQa('building', 'build', false, undefined, 'v1'), false, 'build state must not start QA');
assert.equal(isTerminalOwnedHandoff({ claimId: 'build-1', phase: 'build' }, 'build-1', 'build'), true);
assert.equal(isTerminalOwnedHandoff(undefined, 'build-1', 'build'), false, 'chat claims have no terminal ownership');
assert.equal(isTerminalOwnedHandoff({ claimId: 'old', phase: 'build' }, 'new', 'build'), false, 'stale claims cannot hand off');
assert.equal(isTerminalOwnedHandoff({ claimId: 'qa-1', phase: 'qa' }, 'qa-1', 'build'), false, 'phase must match');

console.log('Agent handoff tests passed.');
