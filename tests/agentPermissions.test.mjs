import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-permissions.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/agentPermissions.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { buildAgentPermissionAllowlist, claudeAutomationArgs, claudeLaunchCommand, codexAutomationArgs, hasAgentPermissions, mergeAgentPermissions, removeAgentPermissions } = require(outfile);

assert.deepEqual(codexAutomationArgs(false), []);
assert.deepEqual(codexAutomationArgs(true), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
assert.equal(codexAutomationArgs(true).some((entry) => /danger|bypass|full-access/.test(entry)), false);

const scope = {
  worktreePath: '/tmp/a worktree',
  mainRoot: '/tmp/main checkout',
  taskId: 'TASK-041'
};
assert.deepEqual(claudeAutomationArgs(false, ['Bash(npm test)'], scope), []);
const claudeArgs = claudeAutomationArgs(true, [
  'Bash(npm test)',
  'Bash(git push origin main)',
  'Bash(git reset --hard HEAD)',
  'Bash(rm -rf dist)',
  'Read'
], scope);
assert.deepEqual(claudeArgs.slice(0, 3), ['--add-dir', '/tmp/main checkout', '--allowedTools']);
assert.ok(claudeArgs.includes('Edit(/tmp/a worktree/**)'));
assert.ok(claudeArgs.includes('Write(/tmp/a worktree/**)'));
assert.ok(claudeArgs.includes('Read(/tmp/main checkout/.agent-board/tasks/TASK-041.json)'));
assert.ok(claudeArgs.includes('Edit(/tmp/main checkout/.agent-board/tasks/TASK-041.json)'));
assert.ok(claudeArgs.includes('Bash(npm test)'));
assert.equal(claudeArgs.some((entry) => /push|reset --hard|rm -rf|bypass/.test(entry)), false);
const launch = claudeLaunchCommand("/tmp/main checkout/prompt's file.md", claudeArgs);
assert.ok(launch.startsWith("claude -p '--add-dir' '/tmp/main checkout'"));
assert.ok(launch.includes("'\\''"), 'apostrophes must use POSIX-safe single-quote escaping');
assert.equal(launch.includes('--dangerously-skip-permissions'), false);

const allowlist = buildAgentPermissionAllowlist([
  'npm run typecheck',
  'npm run build',
  'git push origin main',
  'git reset --hard HEAD',
  'rm -rf dist'
]);
assert.ok(allowlist.includes('Bash(git commit:*)'));
assert.ok(allowlist.includes('Bash(node */.agent-board/scripts/*)'));
assert.ok(allowlist.includes('Bash(npm run typecheck)'));
assert.equal(allowlist.some((entry) => /push|reset --hard|rm -rf/.test(entry)), false);

const existing = { env: { KEEP: 'yes' }, permissions: { deny: ['Read(.env)'], allow: ['Read(src/**)'] } };
const merged = mergeAgentPermissions(existing, allowlist);
assert.deepEqual(merged.env, existing.env);
assert.deepEqual(merged.permissions.deny, existing.permissions.deny);
assert.ok(merged.permissions.allow.includes('Read(src/**)'));
assert.equal(hasAgentPermissions(merged, allowlist), true);

const revoked = removeAgentPermissions(merged, allowlist);
assert.deepEqual(revoked.permissions.allow, ['Read(src/**)']);
assert.deepEqual(revoked.permissions.deny, existing.permissions.deny);
assert.deepEqual(removeAgentPermissions(existing, allowlist), existing);

console.log('Agent permission tests passed.');
