import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-taskDrafts.cjs';
execFileSync('./node_modules/.bin/esbuild', [
  'src/taskDrafts.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${outfile}`
], { stdio: 'inherit' });

const require = createRequire(import.meta.url);
const { generatedSpecDraftPatch, prdSplitDraftPatch } = require(outfile);
const timestamp = '2026-07-23T12:00:00.000Z';

const splitPatch = prdSplitDraftPatch({
  title: 'First split task',
  brief: 'Implement the first part.',
  description: 'A complete implementation draft.',
  acceptanceCriteria: ['The first part works.'],
  priority: 'high'
}, [], timestamp);
assert.equal(splitPatch.status, 'backlog');
assert.equal(splitPatch.brief, 'Implement the first part.');
assert.match(splitPatch.activityLog.at(-1).message, /Backlog for review/);

const backlogTask = {
  id: 'TASK-001',
  title: '',
  status: 'backlog',
  activityLog: []
};
const generatedPatch = generatedSpecDraftPatch(
  backlogTask,
  { description: 'Generated description.', acceptanceCriteria: ['Generated criterion.'] },
  'Generated title',
  'codex-cli',
  timestamp
);
assert.equal('status' in generatedPatch, false, 'generating a specification must not promote a Backlog task');
assert.match(generatedPatch.activityLog.at(-1).message, /current status for review/);
assert.doesNotMatch(generatedPatch.activityLog.at(-1).message, /ready-for-agent/i);

const regeneratedPatch = generatedSpecDraftPatch(
  { ...backlogTask, description: 'Old description.' },
  { description: 'Regenerated description.' },
  'Generated title',
  'claude-code',
  timestamp
);
assert.equal('status' in regeneratedPatch, false, 'regenerating a specification must preserve task status');

console.log('Task draft status test passed.');
