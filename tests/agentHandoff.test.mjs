import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-agentHandoff.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/agentHandoff.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { activeRunBlockReason, canRetryMissingBuildTerminal, canReuseBuildTerminalForQa, isTerminalOwnedHandoff, shouldStartAutomaticQa, terminalStartBlockReason } = require(outfile);

assert.equal(shouldStartAutomaticQa('ready-for-qa', 'build', false, undefined, 'v1'), false, 'QA must wait for the build process to exit');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, undefined, 'v1'), true, 'an exited build may hand off');
assert.equal(shouldStartAutomaticQa('ready-for-qa', 'qa', false, undefined, 'v1'), false, 'a live QA terminal must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, true, undefined, 'v1'), false, 'an in-flight launch must block a duplicate');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v1'), false, 'the same task version must not retry forever');
assert.equal(shouldStartAutomaticQa('ready-for-qa', undefined, false, 'v1', 'v2'), true, 'a newly updated task version may retry');
assert.equal(shouldStartAutomaticQa('building', 'build', false, undefined, 'v1'), false, 'build state must not start QA');
assert.equal(isTerminalOwnedHandoff({ claimId: 'build-1', phase: 'build', completedSuccessfully: true }, 'build-1', 'build'), true);
assert.equal(isTerminalOwnedHandoff({ claimId: 'build-1', phase: 'build' }, 'build-1', 'build'), false, 'a tracked build must exit successfully');
assert.equal(isTerminalOwnedHandoff(undefined, 'build-1', 'build'), false, 'chat claims have no terminal ownership');
assert.equal(isTerminalOwnedHandoff({ claimId: 'old', phase: 'build', completedSuccessfully: true }, 'new', 'build'), false, 'stale claims cannot hand off');
assert.equal(isTerminalOwnedHandoff({ claimId: 'qa-1', phase: 'qa', completedSuccessfully: true }, 'qa-1', 'build'), false, 'phase must match');
assert.match(
  activeRunBlockReason('TASK-001', 'build', { claimId: 'c1', phase: 'build', agent: 'codex', surface: 'chat', startedAt: 'now' }),
  /already has Build running with codex in chat/,
  'chat ownership must produce a clear duplicate-run explanation'
);
assert.equal(activeRunBlockReason('TASK-001', 'build', undefined), undefined);

assert.equal(canReuseBuildTerminalForQa('TASK-001', [{ taskId: 'TASK-001', kind: 'build' }]), true);
assert.equal(canReuseBuildTerminalForQa('TASK-001', [{ taskId: 'TASK-001', kind: 'qa' }]), false);
assert.equal(canReuseBuildTerminalForQa('TASK-001', [{ taskId: 'TASK-002', kind: 'build' }]), false);

const missingBuildTerminal = { claimId: 'c1', phase: 'build', agent: 'codex', surface: 'terminal', startedAt: 'now' };
assert.equal(canRetryMissingBuildTerminal('building', missingBuildTerminal, false), true);
assert.equal(canRetryMissingBuildTerminal('building', missingBuildTerminal, true), false, 'a live terminal must not be retried');
assert.equal(
  canRetryMissingBuildTerminal('building', { ...missingBuildTerminal, surface: 'chat' }, false),
  false,
  'chat runs must not expose terminal recovery'
);
assert.equal(canRetryMissingBuildTerminal('ready-for-qa', missingBuildTerminal, false), false, 'only active builds can retry');

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
