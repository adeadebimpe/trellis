import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-prdPrompt.cjs';
execFileSync('./node_modules/.bin/esbuild', [
  'src/prdPrompt.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${outfile}`
], { stdio: 'inherit' });

const require = createRequire(import.meta.url);
const { buildPrdPrompt, getPrdSourceBrief, normalizeSpecPatch } = require(outfile);

const task = {
  id: 'TASK-003',
  title: 'Improve checkout',
  status: 'backlog',
  priority: 'high',
  assignedAgent: 'codex',
  qaAgent: 'unassigned',
  brief: 'Let shoppers save a delivery note during checkout and show it on the order confirmation page.',
  description: 'TASK-003 JSON has a non-empty title and description that accurately reflects the implemented change.',
  acceptanceCriteria: [],
  qaChecklist: [],
  designQaChecklist: [],
  validationCommands: [],
  relevantFiles: [],
  constraints: [],
  agentNotes: '',
  qaNotes: [],
  qaEvidence: [],
  activityLog: [],
  claimedBy: '',
  qaClaimedBy: '',
  branchName: '',
  lastUpdated: '2026-06-06T00:00:00.000Z'
};

const project = {
  version: 1,
  overview: 'This is a VS Code extension called Agent Board.',
  goals: ['Coordinate coding agents'],
  architectureNotes: 'Extension backend in src and React webview in webview.',
  codingRules: ['Preserve unknown task fields.'],
  agentRules: ['Read .agent-board/project.json.'],
  validationCommands: ['npm run compile'],
  designRules: ['Dense command-centre UI.'],
  glossary: [],
  inference: {
    packageManager: 'npm',
    scripts: ['compile'],
    detectedFiles: ['package.json'],
    likelyStack: ['TypeScript'],
    suggestedValidation: ['npm run compile'],
    lastInferred: '2026-06-06T00:00:00.000Z'
  },
  lastUpdated: '2026-06-06T00:00:00.000Z'
};

assert.equal(getPrdSourceBrief(task), task.brief);

const prompt = buildPrdPrompt(task, project);
assert.match(prompt, /userBrief/);
assert.match(prompt, /Let shoppers save a delivery note/);
assert.match(prompt, /existingGeneratedDescription/);
assert.match(prompt, /Do not treat task ids, task JSON fields, Agent Board internals, or projectContext text as the feature request/);
assert.match(prompt, /Do not write about updating task JSON/);
assert.ok(prompt.indexOf('Let shoppers save a delivery note') < prompt.indexOf('TASK-003 JSON has'));

assert.match(prompt, /relevantFiles/);
assert.match(prompt, /Explore the repository/);
assert.match(prompt, /"title": "string"/);

const patch = normalizeSpecPatch({
  title: 'Delivery notes at checkout.',
  description: 'Delivery notes can be added during checkout.',
  acceptanceCriteria: ['Checkout has a delivery note field.'],
  qaChecklist: ['Place an order with a delivery note.'],
  designQaChecklist: ['Check the note field at narrow widths.'],
  validationCommands: ['npm run compile'],
  relevantFiles: ['src/checkout/OrderForm.tsx'],
  constraints: ['Do not expose notes publicly.']
}, task, project);

assert.equal(patch.description, 'Delivery notes can be added during checkout.');
assert.deepEqual(patch.acceptanceCriteria, ['Checkout has a delivery note field.']);
assert.deepEqual(patch.validationCommands, ['npm run compile']);
assert.deepEqual(patch.relevantFiles, ['src/checkout/OrderForm.tsx']);

assert.equal(patch.title, 'Delivery notes at checkout');

const fallbackPatch = normalizeSpecPatch({ description: 'x' }, task, project);
assert.deepEqual(fallbackPatch.relevantFiles, task.relevantFiles);
assert.equal(fallbackPatch.title, undefined);

const longTitlePatch = normalizeSpecPatch({ description: 'x', title: 'a'.repeat(100) }, task, project);
assert.ok(longTitlePatch.title.length <= 72);
assert.ok(longTitlePatch.title.endsWith('...'));

console.log('PRD prompt test passed.');
