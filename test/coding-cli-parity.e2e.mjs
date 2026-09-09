import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { main } from '../dist/cli/index.js';

const KEY = 'tk_live_0123456789abcdef0123456789abcdef';
const ENDPOINT = 'https://x.test/v1/otlp';
const PY_ROOT = resolve('..', 'sdk-py');
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 120000);

if (!existsSync(join(PY_ROOT, 'evalkit_cli', 'main.py'))) {
  console.log('coding-cli-parity.e2e SKIPPED (sdk-py not checked out next to sdk-ts)');
  process.exit(0);
}
let python = '';
for (const candidate of ['python3', 'python']) {
  try {
    execFileSync(candidate, ['--version'], { stdio: 'ignore' });
    python = candidate;
    break;
  } catch {
    python = '';
  }
}
if (!python) {
  console.log('coding-cli-parity.e2e SKIPPED (no python interpreter)');
  process.exit(0);
}

const FILES = {
  'claude-code': ['.claude/settings.json'],
  codex: ['.codex/config.toml'],
  'gemini-cli': ['.gemini/settings.json', '.gemini/.env'],
  cursor: ['.cursor/hooks.json'],
  windsurf: ['.codeium/windsurf/hooks.json'],
  opencode: ['.config/opencode/opencode.json', '.config/opencode/plugins/evalkit.ts'],
};
const SHARED = ['.config/evalkit/config.env'];

const shim = mkdtempSync(join(tmpdir(), 'evalkit-shim-'));
const shimBinary = join(shim, 'evalkit');
writeFileSync(shimBinary, '#!/bin/sh\nexit 0\n');
chmodSync(shimBinary, 0o755);

function tmpHome() { return mkdtempSync(join(tmpdir(), 'evalkit-parity-')); }

function normalise(text, home) {
  return text.split(home).join('$HOME').split(shimBinary).join('evalkit');
}

async function tsInstall(home, argv) {
  const out = [], err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), home, cwd: home, binary: 'evalkit' });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function pyInstall(home, argv) {
  const result = execFileSync(python, ['-m', 'evalkit_cli.main', ...argv], {
    cwd: PY_ROOT,
    env: { ...process.env, HOME: home, PATH: `${shim}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return { code: 0, out: result };
}

let compared = 0;
for (const flags of [[], ['--capture', 'full'], ['--no-traces']]) {
  for (const vendor of Object.keys(FILES)) {
    const tsHome = tmpHome();
    const pyHome = tmpHome();
    const argv = ['coding', 'install', '--vendor', vendor, '--key', KEY, '--endpoint', ENDPOINT, ...flags];
    const ts = await tsInstall(tsHome, argv);
    assert.strictEqual(ts.code, 0, ts.err);
    pyInstall(pyHome, argv);
    for (const relative of [...FILES[vendor], ...SHARED]) {
      const tsPath = join(tsHome, relative);
      const pyPath = join(pyHome, relative);
      assert.ok(existsSync(tsPath), `typescript did not write ${relative} for ${vendor}`);
      assert.ok(existsSync(pyPath), `python did not write ${relative} for ${vendor}`);
      const left = normalise(readFileSync(tsPath, 'utf8'), tsHome);
      const right = normalise(readFileSync(pyPath, 'utf8'), pyHome);
      assert.strictEqual(left, right, `${vendor} ${relative} differs with flags ${JSON.stringify(flags)}`);
      compared++;
    }
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(pyHome, { recursive: true, force: true });
  }
}

{
  const tsHome = tmpHome();
  const pyHome = tmpHome();
  const settings = '.claude/settings.json';
  const original = JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console', FOO: 'bar' }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }] } }, null, 2);
  for (const home of [tsHome, pyHome]) {
    mkdirSync(dirname(join(home, settings)), { recursive: true });
    writeFileSync(join(home, settings), original);
  }
  const argv = ['coding', 'install', '--vendor', 'claude-code', '--key', KEY, '--endpoint', ENDPOINT, '--capture', 'full'];
  await tsInstall(tsHome, argv);
  pyInstall(pyHome, argv);
  assert.strictEqual(
    normalise(readFileSync(join(tsHome, settings), 'utf8'), tsHome),
    normalise(readFileSync(join(pyHome, settings), 'utf8'), pyHome),
    'merging into an existing settings file must be identical',
  );
  compared++;
  await tsInstall(tsHome, ['coding', 'uninstall', '--vendor', 'claude-code']);
  pyInstall(pyHome, ['coding', 'uninstall', '--vendor', 'claude-code']);
  assert.strictEqual(readFileSync(join(tsHome, settings), 'utf8'), readFileSync(join(pyHome, settings), 'utf8'), 'uninstall must restore identically');
  compared++;
  rmSync(tsHome, { recursive: true, force: true });
  rmSync(pyHome, { recursive: true, force: true });
}

rmSync(shim, { recursive: true, force: true });
console.log(`coding-cli-parity.e2e OK (${compared} files compared byte for byte)`);
process.exit(0);
