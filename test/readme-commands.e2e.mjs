// The README's commands are copied into CI files as they are. On npm, `evalkit` alone is an unrelated
// package, so a bare `npx evalkit` in a repository that does not depend on this SDK fetches and runs it
// with the key in its environment: every npx command names the package.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checked = 0;
for (const name of ['README.md', 'INTEGRATION.md']) {
  const lines = readFileSync(join(root, name), 'utf8').split('\n');
  let inCode = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return;
    }
    // Commands are the fenced blocks; prose may name the bare form to warn against it.
    if (!inCode) return;
    for (const match of line.matchAll(/\bnpx\b[^\n#]*?\bevalkit\b/g)) {
      checked += 1;
      assert.match(match[0], /-p syntropylabs-evalkit\b/, `${name}:${i + 1}: ${line.trim()}`);
    }
  });
}
assert.ok(checked > 0, 'the README names no npx command at all');
console.log(`PASS readme-commands: ${checked} npx command(s) name the package`);
