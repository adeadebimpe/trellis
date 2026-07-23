import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-workflowPrompts.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/workflowPrompts.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const {
  DEFAULT_WORKFLOW_PROMPTS,
  WORKFLOW_PROMPT_PLACEHOLDERS,
  renderWorkflowPrompt
} = createRequire(import.meta.url)(outfile);

const values = {
  taskId: 'TASK-063',
  repositoryPath: "/tmp/main repo's",
  worktreePath: '/tmp/task worktree',
  branchName: 'agent-board/TASK-063',
  scriptsPath: "/tmp/main repo's/.trellis/scripts",
  agent: 'codex'
};

for (const kind of ['implementation', 'qa', 'repair']) {
  const prompt = renderWorkflowPrompt(kind, undefined, values);
  assert.ok(prompt.length > 100, `${kind} has a readable built-in prompt`);
  assert.match(prompt, /TASK-063/);
  assert.match(prompt, /agent-board\/TASK-063/);
  assert.doesNotMatch(prompt, /\{\{(?:taskId|repositoryPath|worktreePath|branchName|scriptsPath|agent|workspaceInstruction)\}\}/);
  assert.equal(renderWorkflowPrompt(kind, '   ', values), prompt, `${kind} blank template falls back to default`);
}

const custom = WORKFLOW_PROMPT_PLACEHOLDERS.map((placeholder) => `${placeholder}={{${placeholder}}}`).join('\n');
const rendered = renderWorkflowPrompt('implementation', custom, values);
for (const [key, value] of Object.entries(values)) {
  assert.match(rendered, new RegExp(`${key}=${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
}
assert.equal(DEFAULT_WORKFLOW_PROMPTS.qa.includes('{{agent}}'), false, 'templates remain independent');

console.log('Workflow prompt tests passed.');
