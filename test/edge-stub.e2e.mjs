import assert from 'node:assert';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Importing the SDK on the Vercel Edge runtime, Cloudflare Workers or in a browser never throws: the
// package's edge-light, workerd and browser conditions select a stub with the Node entry's API surface that
// traces nothing and references no Node built-in.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();
const root = fileURLToPath(new URL('..', import.meta.url));

try {
  const node = await import('../dist/index.mjs');
  const stub = await import('../dist/stub.mjs');
  assert.deepStrictEqual(Object.keys(stub).sort(), Object.keys(node).sort(), 'the same named exports');
  assert.deepStrictEqual(Object.keys(stub.default).sort(), Object.keys(node.default).sort(), 'the same default export');
  for (const key of Object.keys(node)) {
    assert.strictEqual(typeof stub[key], typeof node[key], `${key} is a ${typeof node[key]} in both`);
  }
  const require = createRequire(import.meta.url);
  const cjsStub = require('../dist/stub.js');
  assert.deepStrictEqual(Object.keys(cjsStub).sort(), Object.keys(require('../dist/index.js')).sort(), 'and in CommonJS');

  for (const condition of ['edge-light', 'workerd', 'browser']) {
    const out = execFileSync(process.execPath, [
      `--conditions=${condition}`, '--input-type=module', '-e',
      "const m = await import('syntropylabs-evalkit'); const c = m.init({ subscriptionKey: 'k' }); process.stdout.write(JSON.stringify([c.tracingMode, m.getStats().circuit_state, m.traceFunction('f', (x) => x + 1)(1), await m.flush()]));",
    ], { cwd: root, encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(out), ['disabled', 'disabled', 2, false], `${condition} resolves to the stub`);
  }
  const nodeOut = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('syntropylabs-evalkit'); process.stdout.write(String(typeof m.init({ subscriptionKey: 'k', baseUrl: 'http://127.0.0.1:9', exitHooks: false }).tracer.startSpan))",
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, EVALKIT_DISABLED: 'true' } });
  assert.strictEqual(nodeOut, 'function', 'Node still gets the Node entry');

  // Bundled for a browser, the stub resolves without one Node built-in, and runs where none exists.
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../dist/stub.mjs', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'EvalKit',
    write: false,
    logLevel: 'silent',
  });
  const code = bundle.outputFiles[0].text;
  assert.ok(!/\bnode:|require\(["'](zlib|async_hooks|module|http|fs)["']\)/.test(code), 'no Node built-in in the bundle');
  const sandbox = { console: { log() {}, warn() {}, error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  const result = vm.runInContext(`(async () => {
    const e = EvalKit.default;
    const client = e.init({ subscriptionKey: 'k' });
    const traced = e.traceFunction('f', async (x) => x * 2);
    const scores = e.evaluate({ output: 'AWS and Azure', constraints: { requiredTerms: ['AWS'] } }).scores;
    let rejected = false;
    await e.prompts.get('greeting').catch(() => { rejected = true; });
    const next = [];
    e.expressMiddleware()({}, {}, () => next.push('express'));
    await e.koaMiddleware()({}, async () => next.push('koa'));
    return JSON.stringify([client.tracingMode, await traced(21), await e.flush(), scores.response_match, rejected, next, typeof process]);
  })()`, sandbox);
  assert.deepStrictEqual(JSON.parse(await result), ['disabled', 42, false, 1, true, ['express', 'koa'], 'undefined']);

  clearTimeout(watchdog);
  console.log('PASS edge-stub.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
