import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const outfile = '/private/tmp/agent-board-onboarding.cjs';
execFileSync('./node_modules/.bin/esbuild', ['src/onboarding.ts', '--bundle', '--platform=node', '--format=cjs', `--outfile=${outfile}`], { stdio: 'inherit' });
const { isSetupComplete } = createRequire(import.meta.url)(outfile);

assert.equal(isSetupComplete(false, false, 0), false, 'shows setup when no CLI or saved setup exists');
assert.equal(isSetupComplete(false, false, 1), true, 'skips setup when one supported CLI exists');
assert.equal(isSetupComplete(false, false, 2), true, 'skips setup when both supported CLIs exist');
assert.equal(isSetupComplete(true, false, 0), true, 'saved provider skips setup');
assert.equal(isSetupComplete(false, true, 0), true, 'explicitly completed onboarding skips setup');

const extensionSource = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
const storageSource = readFileSync(new URL('../src/storage.ts', import.meta.url), 'utf8');

assert.match(
  extensionSource,
  /async function refreshBoard\(\): Promise<void> \{\s+const storage = await resolveStorage\(\);\s+if \(!await storage\.isInitialized\(\)\) \{\s+return;/,
  'background refresh skips untouched workspaces'
);
assert.match(
  extensionSource,
  /async resolveWebviewView\(view: vscode\.WebviewView\)[\s\S]*?await storage\.prepareAgentFiles\(\);\s+await postState\(\);/,
  'opening the sidebar explicitly initializes Trellis'
);
assert.match(
  extensionSource,
  /async function openBoard[\s\S]*?await storage\.prepareAgentFiles\(\);/,
  'opening the full board explicitly initializes Trellis'
);
assert.doesNotMatch(
  storageSource,
  /async loadBoardState\(\)[\s\S]*?if \(!await this\.exists\(this\.boardDir\)\) \{\s+await this\.prepareAgentFiles\(\);/,
  'loading board state does not initialize an untouched workspace'
);
assert.match(
  storageSource,
  /private async loadProjectContext\(\): Promise<ProjectContext> \{\s+if \(!await this\.exists\(this\.boardDir\)\) \{\s+return this\.defaultProjectContext\(\);/,
  'loading project context remains read-only before Trellis is initialized'
);

console.log('Onboarding setup tests passed.');
