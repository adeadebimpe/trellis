import assert from 'node:assert/strict';
import { build } from 'esbuild';

const outfile = '/private/tmp/agent-board-specialists.cjs';
await build({ entryPoints: ['src/specialists.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
const { appendSpecialistBrief, isValidSpecialist, missingSpecialistIds, specialistAgentFileName, specialistAgentToml, specialistValidationErrors, specialistsForStage } = await import(outfile);
const draftsOutfile = '/private/tmp/agent-board-specialist-drafts.cjs';
await build({ entryPoints: ['webview/specialistDrafts.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: draftsOutfile });
const { mergeSpecialistDrafts } = await import(draftsOutfile);

const design = { id: 'design', name: 'Design System', description: 'Checks UI consistency', instructions: 'Use tokens.', accessMode: 'read-only', stages: ['before-build', 'qa'] };
const security = { id: 'security', name: 'Security', description: '', instructions: 'Do not use tokens.', accessMode: 'workspace-write', stages: ['post-build-review'] };
const project = { specialists: [design, security] };
const task = { specialistIds: ['security', 'missing', 'design'] };

assert.deepEqual(specialistsForStage(project, task, 'before-build').map((item) => item.id), ['design'], 'selection order is stable and stage filtered');
assert.deepEqual(missingSpecialistIds(project, task), ['missing'], 'deleted definitions remain recoverable task references');
assert.equal(appendSpecialistBrief('base', [], 'qa'), 'base', 'zero specialists leave prompts byte-for-byte unchanged');
const brief = appendSpecialistBrief('base', [design, security], 'qa');
assert.match(brief, /Decisions; Requirements; Acceptance criteria; Risks; Affected files or components; Conflicts/);
assert.match(brief, /do not silently choose a side/);
assert.match(brief, /run every specialist below as a separate sub-agent/);
assert.match(brief, /Do not substitute a single primary-agent reading/);
assert.match(brief, /\.codex\/agents\/trellis-design\.toml/);
assert.match(brief, /must never broaden those inherited permissions/);
assert.equal(specialistAgentFileName({ ...design, id: '../unsafe' }), 'trellis----unsafe.toml');
assert.match(specialistAgentToml(design), /name = "Design System"/);
assert.match(specialistAgentToml(design), /sandbox_mode = "read-only"/);
assert.equal(isValidSpecialist(design), true);
assert.deepEqual(specialistValidationErrors({ ...design, name: ' ', description: '', instructions: '', stages: [] }), {
  name: 'Enter a name.',
  description: 'Enter a description.',
  instructions: 'Enter instructions.',
  stages: 'Select at least one workflow stage.'
});

const invalidSecurityDraft = { ...security, description: 'Still editing', stages: [] };
const unsavedDraft = { ...design, id: 'new', name: '', stages: [] };
assert.deepEqual(
  mergeSpecialistDrafts(
    [{ ...design, name: 'Persisted edit' }, security],
    [design, invalidSecurityDraft, unsavedDraft],
    { security: { stages: 'Select at least one workflow stage.' }, new: { name: 'Enter a name.' } }
  ),
  [{ ...design, name: 'Persisted edit' }, invalidSecurityDraft, unsavedDraft],
  'autosave synchronization updates clean cards without discarding invalid or unsaved drafts'
);

console.log('Specialist tests passed.');
