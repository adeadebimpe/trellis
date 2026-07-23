import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-permissions.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/agentPermissions.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const require = createRequire(import.meta.url);
const { buildAgentPermissionAllowlist, codexAutomationArgs, codexLaunchCommand, hasAgentPermissions, mergeAgentPermissions, removeAgentPermissions } = require(outfile);

assert.deepEqual(codexAutomationArgs(false), []);
assert.deepEqual(codexAutomationArgs(true), ['--sandbox', 'workspace-write', '--ask-for-approval', 'never']);
assert.equal(codexAutomationArgs(true).some((entry) => /danger|bypass|full-access/.test(entry)), false);
const scopedCommand = codexLaunchCommand("/tmp/a prompt's file.md", true);
assert.ok(scopedCommand.indexOf('--ask-for-approval never') < scopedCommand.indexOf(' exec '), 'global approval policy must precede exec');
assert.ok(scopedCommand.includes('exec --skip-git-repo-check'));
assert.ok(scopedCommand.includes("'\\''"), 'prompt path must be POSIX quoted');
assert.equal(codexLaunchCommand('/tmp/prompt.md', false).includes('--ask-for-approval'), false);

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
