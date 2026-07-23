import assert from 'node:assert/strict';
import { build } from 'esbuild';

const outfile = '/private/tmp/agent-board-specialists.cjs';
await build({ entryPoints: ['src/specialists.ts'], bundle: true, platform: 'node', format: 'cjs', outfile });
const { appendSpecialistBrief, missingSpecialistIds, specialistAgentFileName, specialistAgentToml, specialistsForStage } = await import(outfile);

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
assert.match(brief, /do not expand sandbox, approval, or tool permissions/);
assert.equal(specialistAgentFileName({ ...design, id: '../unsafe' }), 'trellis----unsafe.toml');
assert.match(specialistAgentToml(design), /name = "Design System"/);
assert.match(specialistAgentToml(design), /sandbox_mode = "read-only"/);

console.log('Specialist tests passed.');
