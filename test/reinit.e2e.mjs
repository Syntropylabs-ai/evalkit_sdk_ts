import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { startMockLlm } from './_mock-llm.mjs';
import { init, startTrace, withTrace, traceFunction, flush } from '../dist/index.mjs';

// A second init() replaces the client: what it sets (service name, environment, app version) applies to the
// spans that start after it, wrappers made before it included, and no library is patched a second time,
// even after another library wrapped the SDK's patch in between.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const options = { subscriptionKey: 'test', baseUrl: 'http://localhost:9', scheduledDelayMillis: 50 };
const first = init({ ...options, serviceName: 'reinit-first', environment: 'staging', appVersion: '1.0.0' });
await sleep(400);

const { default: OpenAI } = await import('openai');
const proto = OpenAI.Chat.Completions.prototype;
assert.ok(proto.create.__evalkit, 'the first init patched chat.completions.create');

// What an OpenTelemetry instrumentation does to an already patched method: wrap it, leaving no flag on top.
const patched = proto.create;
const wrapper = function (...args) { return patched.apply(this, args); };
Object.defineProperty(wrapper, '__original', { value: patched });
Object.defineProperty(wrapper, '__wrapped', { value: true });
proto.create = wrapper;

const mock = await startMockLlm();
const openai = new OpenAI({ baseURL: `${mock.url}/v1`, apiKey: 'sk-test-000000000000000000', maxRetries: 0 });
const lookup = traceFunction('orders.lookup', (id) => ({ id }));

try {
  const before = startTrace('before-reinit');
  await withTrace(before.ctx, async () => { lookup('1001'); });
  before.end();
  await flush();
  await sleep(150);
  const early = ingested.find((e) => e.operation === 'orders.lookup');
  assert.strictEqual(early.serviceName, 'reinit-first');
  assert.strictEqual(early.environment, 'staging');
  ingested.length = 0;

  const second = init({ ...options, serviceName: 'reinit-second', environment: 'production', appVersion: '2.0.0' });
  assert.notStrictEqual(second, first, 'a second init() returns a new client');
  await sleep(400);
  assert.strictEqual(proto.create, wrapper, 'the second init must not patch over the wrapper of its own patch');

  const root = startTrace('after-reinit');
  await withTrace(root.ctx, async () => {
    await openai.chat.completions.create({ model: 'text', messages: [{ role: 'user', content: 'hi' }] });
    lookup('1002');
  });
  root.end();
  await flush();
  await sleep(200);

  const llm = ingested.filter((e) => e.spanType === 'llm_call');
  assert.strictEqual(llm.length, 1, `one OpenAI call must be recorded once, got ${llm.length} llm_call spans`);
  const mine = ingested.filter((e) => ['after-reinit', 'orders.lookup', 'chat.completions.create'].includes(e.operation));
  assert.strictEqual(mine.length, 3);
  for (const e of mine) {
    assert.strictEqual(e.serviceName, 'reinit-second', `${e.operation} kept the first init's service name`);
    assert.strictEqual(e.environment, 'production', `${e.operation} kept the first init's environment`);
    assert.strictEqual(e.appVersion, '2.0.0', `${e.operation} kept the first init's app version`);
  }
  const http = ingested.filter((e) => e.spanType === 'http_call' && e.spanKind === 'CLIENT');
  assert.strictEqual(http.length, 1, `the outgoing request is recorded once, got ${http.length}`);
  assert.strictEqual(http[0].serviceName, 'reinit-second');

  await mock.close();
  console.log('PASS reinit.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
