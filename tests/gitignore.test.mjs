import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const outfile = '/private/tmp/agent-board-gitignore.cjs';
execFileSync('./node_modules/.bin/esbuild', [
  'src/gitignore.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  `--outfile=${outfile}`
], { stdio: 'inherit' });

const require = createRequire(import.meta.url);
const { ensureAgentBoardIgnore, hasAgentBoardIgnore } = require(outfile);

assert.equal(ensureAgentBoardIgnore(''), '.agent-board/\n');
assert.equal(ensureAgentBoardIgnore('node_modules/'), 'node_modules/\n.agent-board/\n');
assert.equal(ensureAgentBoardIgnore('node_modules/\n'), 'node_modules/\n.agent-board/\n');

for (const existing of ['.agent-board', '.agent-board/', '/.agent-board', '/.agent-board/']) {
  assert.equal(hasAgentBoardIgnore(`${existing}\n`), true);
  assert.equal(ensureAgentBoardIgnore(`${existing}\n`), `${existing}\n`);
}

assert.equal(hasAgentBoardIgnore('# .agent-board/\n'), false, 'commented patterns must not count');
assert.equal(
  ensureAgentBoardIgnore('# keep this order\ndist/'),
  '# keep this order\ndist/\n.agent-board/\n'
);
assert.equal(
  ensureAgentBoardIgnore('dist/\r\n/.agent-board/\r\n'),
  'dist/\r\n/.agent-board/\r\n',
  'equivalent CRLF files must remain byte-for-byte unchanged'
);

console.log('Gitignore helper tests passed.');
