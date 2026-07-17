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
const { buildPrdPrompt, getPrdSourceBrief, normalizeSpecPatch, deriveTaskTitle, clipTitle, TITLE_MAX_LENGTH } = require(outfile);

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
assert.ok(longTitlePatch.title.length <= TITLE_MAX_LENGTH);
assert.ok(longTitlePatch.title.endsWith('…'));
assert.ok(!longTitlePatch.title.includes('...'));

// Word-boundary clipping: a long multi-word entry clips at a space, never mid-word.
const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
const clippedWords = clipTitle(words);
assert.ok(clippedWords.length <= TITLE_MAX_LENGTH);
assert.ok(clippedWords.endsWith('…'));
const stem = clippedWords.slice(0, -1);
assert.ok(words.startsWith(stem));
assert.equal(words[stem.length], ' ', 'clip must land on a word boundary');

// Entry exactly at the limit passes through untouched, no ellipsis.
const exact = 'x'.repeat(TITLE_MAX_LENGTH);
assert.equal(clipTitle(exact), exact);

// A first word longer than the limit hard-clips but still fits with the ellipsis.
const longWord = 'supercalifragilisticexpialidocious'.repeat(3);
const clippedWord = clipTitle(longWord);
assert.equal(clippedWord.length, TITLE_MAX_LENGTH);
assert.ok(clippedWord.endsWith('…'));

// Multi-line entries: only the first non-empty line feeds the derived title.
const multiLine = deriveTaskTitle({ id: 'TASK-901', title: '', brief: 'Fix the drawer layout\nAlso update the docs later', description: '' });
assert.equal(multiLine, 'Fix the drawer layout');

// Short entries keep the cleaned text as-is (verb stripped, no ellipsis).
const short = deriveTaskTitle({ id: 'TASK-902', title: '', brief: 'Add dark mode toggle', description: '' });
assert.equal(short, 'dark mode toggle');

// Long derived titles from the composer path are word-boundary clipped too.
const cleanedBrief = 'short titles based on entry for new task, and titles should fit using ellipsis and maybe a tooltip';
const longBrief = deriveTaskTitle({ id: 'TASK-903', title: '', brief: `Create ${cleanedBrief}`, description: '' });
assert.ok(longBrief.length <= TITLE_MAX_LENGTH);
assert.ok(longBrief.endsWith('…'));
const briefStem = longBrief.slice(0, -1).replace(/,$/, '');
assert.ok(cleanedBrief.startsWith(briefStem));
assert.match(cleanedBrief.slice(briefStem.length), /^[ ,]/, 'clip must land on a word boundary');

console.log('PRD prompt test passed.');
