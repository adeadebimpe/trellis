import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-inference.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/inferenceSummary.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { parseReadme, inferredContextNotes, legacyContextNotes, shouldReplaceNotes, shouldReplaceValidation, shouldReplaceArchitecture } = createRequire(import.meta.url)(outfile);

// --- parseReadme ---

const readme = parseReadme([
  '# Trellis',
  '',
  '![build](https://example.com/badge.svg)',
  '[![npm](https://example.com/npm.svg)](https://example.com)',
  '',
  'A kanban board for coding agents inside VS Code.',
  'Tasks flow from backlog to merged with automated QA.',
  '',
  '## Install',
  'Not part of the summary.'
].join('\n'));
assert.equal(readme.title, 'Trellis', 'first heading becomes the title');
assert.equal(
  readme.summary,
  'A kanban board for coding agents inside VS Code. Tasks flow from backlog to merged with automated QA.',
  'first prose paragraph becomes the summary, badges skipped'
);

const longReadme = parseReadme(`# Big\n\n${'word '.repeat(120).trim()}`);
assert.ok(longReadme.summary.length <= 300, 'summary is capped');
assert.ok(longReadme.summary.endsWith('…'), 'capped summary ends with an ellipsis');

assert.deepEqual(parseReadme(''), {}, 'empty readme yields nothing');

// --- inferredContextNotes ---

const inference = {
  packageManager: 'npm',
  scripts: ['build', 'test', 'typecheck'],
  detectedFiles: ['package.json', 'tsconfig.json', 'README.md'],
  likelyStack: ['VS Code extension (React webview UI)', 'TypeScript', 'esbuild'],
  suggestedValidation: ['npm run typecheck', 'npm run build', 'npm run test'],
  lastInferred: '2026-07-19T00:00:00.000Z',
  projectName: 'Trellis',
  projectDescription: 'Kanban board for coding agents',
  readmeTitle: 'Trellis',
  readmeSummary: 'A kanban board for coding agents inside VS Code.',
  topLevelDirs: ['media', 'src', 'tests', 'webview']
};

const notes = inferredContextNotes(inference);
assert.equal(notes.split('\n')[0], 'Trellis — Kanban board for coding agents', 'headline names and describes the project');
assert.ok(notes.includes('A kanban board for coding agents inside VS Code.'), 'readme summary included');
assert.ok(notes.includes('Stack: VS Code extension (React webview UI), TypeScript, esbuild'), 'stack line present');
assert.ok(notes.includes('Layout: media/, src/, tests/, webview/'), 'layout line present');
assert.ok(notes.includes('Package manager: npm · Scripts: build, test, typecheck'), 'tooling line present');
assert.ok(notes.includes('Validation: npm run typecheck, npm run build, npm run test'), 'validation line present');

const bare = inferredContextNotes({
  packageManager: 'npm',
  scripts: [],
  detectedFiles: [],
  likelyStack: ['Node.js'],
  suggestedValidation: [],
  lastInferred: '2026-07-19T00:00:00.000Z'
});
assert.equal(bare, 'Stack: Node.js\nPackage manager: npm', 'missing fields are skipped without blank lines');

// --- regenerate policy ---

const previous = { ...inference, generatedNotes: notes, generatedValidation: [...inference.suggestedValidation] };

assert.equal(shouldReplaceNotes('', previous), true, 'empty notes are always seeded');
assert.equal(shouldReplaceNotes(`  ${notes}\n`, previous), true, 'untouched generated notes are refreshed');
assert.equal(shouldReplaceNotes('My own carefully written notes.', previous), false, 'user prose is preserved');
assert.equal(shouldReplaceNotes('My own notes.', undefined), false, 'no previous inference means user text wins');
assert.equal(
  shouldReplaceNotes(legacyContextNotes(previous), { ...previous, generatedNotes: undefined }),
  true,
  'boards seeded with the pre-description format refresh on first re-run'
);

assert.equal(shouldReplaceValidation([], previous), true, 'empty validation list is seeded');
assert.equal(shouldReplaceValidation(['npm run typecheck', 'npm run build', 'npm run test'], previous), true, 'untouched validation list is refreshed');
assert.equal(shouldReplaceValidation(['npm run e2e'], previous), false, 'edited validation list is preserved');

assert.equal(shouldReplaceArchitecture('', previous), true, 'empty architecture notes are seeded');
assert.equal(shouldReplaceArchitecture('Custom architecture decisions.', previous), false, 'edited architecture notes are preserved');

console.log('Inference summary tests passed.');
