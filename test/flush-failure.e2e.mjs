import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import evalkit, { EvalKitClient, flush, init, startTrace } from '../dist/index.mjs';

// flush() and destroy() resolve when the export fails, so an app that awaits them on its way out is never
// failed by tracing: flush() answers false instead of rejecting. Before init() there is nothing to send, and
// flush() resolves to false too, in the ES module and the CommonJS build.

let calls = 0;
globalThis.fetch = async () => { calls += 1; throw new TypeError('fetch failed'); };
const unhandled = [];
process.on('unhandledRejection', (r) => unhandled.push(r));
const realError = console.error;
console.error = () => {};
const fail = (m) => { console.error = realError; console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);

try {
  assert.strictEqual(await flush(), false, 'a module-level await flush() before init() resolves to false');
  assert.strictEqual(await evalkit.flush(), false, 'and so does the default export\'s');
  void flush();
  const cjs = execFileSync(process.execPath, ['-e', "require(process.argv[1]).flush().then((v) => process.stdout.write(String(v)), (e) => process.stdout.write('rejected: ' + e))", fileURLToPath(new URL('../dist/index.js', import.meta.url))], { encoding: 'utf8' });
  assert.strictEqual(cjs, 'false', 'the CommonJS build resolves to false before init() too');
  assert.strictEqual(calls, 0, 'nothing was sent before init()');

  const client = init({ subscriptionKey: 'test', baseUrl: 'http://127.0.0.1:1', serviceName: 'flush-failure-test' });
  startTrace('one').end();
  assert.strictEqual(await flush(), false, 'a failed export makes flush() resolve to false');
  assert.ok(calls > 0, 'the export was attempted');
  startTrace('two').end();
  assert.strictEqual(await client.flush(), false);
  await client.destroy();
  await client.destroy();
  assert.strictEqual(typeof (await flush()), 'boolean', 'flush() after destroy() resolves');

  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'ok' });
  const ok = new EvalKitClient({ subscriptionKey: 'test', baseUrl: 'http://127.0.0.1:1', serviceName: 'flush-ok' });
  ok.startTrace('three').end();
  assert.strictEqual(await ok.flush(), true, 'a successful export makes flush() resolve to true');
  await ok.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(unhandled, []);
  console.error = realError;
  console.log('PASS flush-failure.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
