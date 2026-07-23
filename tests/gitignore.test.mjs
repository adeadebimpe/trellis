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
const { ensureTrellisIgnore, hasTrellisIgnore } = require(outfile);

assert.equal(ensureTrellisIgnore(''), '.trellis/\n');
assert.equal(ensureTrellisIgnore('node_modules/'), 'node_modules/\n.trellis/\n');
assert.equal(ensureTrellisIgnore('node_modules/\n'), 'node_modules/\n.trellis/\n');

for (const existing of ['.trellis', '.trellis/', '/.trellis', '/.trellis/']) {
  assert.equal(hasTrellisIgnore(`${existing}\n`), true);
  assert.equal(ensureTrellisIgnore(`${existing}\n`), `${existing}\n`);
}

assert.equal(hasTrellisIgnore('# .trellis/\n'), false, 'commented patterns must not count');
assert.equal(
  ensureTrellisIgnore('# keep this order\ndist/'),
  '# keep this order\ndist/\n.trellis/\n'
);
assert.equal(
  ensureTrellisIgnore('dist/\r\n/.trellis/\r\n'),
  'dist/\r\n/.trellis/\r\n',
  'equivalent CRLF files must remain byte-for-byte unchanged'
);

console.log('Gitignore helper tests passed.');
