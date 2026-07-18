import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-onboarding.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/onboarding.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { isSetupComplete } = createRequire(import.meta.url)(outfile);

assert.equal(isSetupComplete(false, false, 0), false, 'shows setup when no CLI or saved setup exists');
assert.equal(isSetupComplete(false, false, 1), true, 'skips setup when one supported CLI exists');
assert.equal(isSetupComplete(false, false, 2), true, 'skips setup when both supported CLIs exist');
assert.equal(isSetupComplete(true, false, 0), true, 'saved provider skips setup');
assert.equal(isSetupComplete(false, true, 0), true, 'explicitly completed onboarding skips setup');

console.log('Onboarding setup tests passed.');
