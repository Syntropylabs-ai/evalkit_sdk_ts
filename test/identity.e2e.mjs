import assert from 'node:assert';

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const evalkit = await import('../dist/index.mjs');
const { init, startTrace, startSpan, setUser, currentUser, withTrace } = evalkit;

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 20000);
watchdog.unref?.();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'identity',
  scheduledDelayMillis: 50,
});

const flush = async () => {
  await client.flush();
  await new Promise((r) => setTimeout(r, 50));
};

const spanNamed = (name) => {
  const found = ingested.filter((e) => e.operation === name);
  assert.strictEqual(found.length, 1, `expected exactly one span named ${name}, got ${found.length}`);
  return found[0];
};

try {
  const root = startTrace('checkout', { userId: 'u-1', sessionId: 's-1', deviceId: 'd-1', attributes: { 'custom.key': 'v' } });
  await withTrace(root.ctx, async () => {
    const child = startSpan('charge-card');
    child.end('OK');
  });
  root.end('OK');
  await flush();

  const trace = spanNamed('checkout');
  assert.strictEqual(trace.userId, 'u-1');
  assert.strictEqual(trace.sessionId, 's-1');
  assert.strictEqual(trace.deviceId, 'd-1');
  assert.strictEqual(trace.attributes['custom.key'], 'v');
  assert.strictEqual(trace.attributes['evalkit.user_id'], undefined);

  const child = spanNamed('charge-card');
  assert.strictEqual(child.traceId, root.traceId);
  assert.strictEqual(child.userId, 'u-1');
  assert.strictEqual(child.sessionId, 's-1');
  assert.strictEqual(child.deviceId, 'd-1');

  const legacy = startTrace('legacy-attrs', { 'evalkit.session_id': 's-2', 'other': 'kept' });
  await withTrace(legacy.ctx, async () => {
    startSpan('legacy-child').end('OK');
  });
  legacy.end('OK');
  await flush();
  assert.strictEqual(spanNamed('legacy-attrs').sessionId, 's-2');
  assert.strictEqual(spanNamed('legacy-attrs').attributes['other'], 'kept');
  assert.strictEqual(spanNamed('legacy-child').sessionId, 's-2');

  setUser({ userId: 'u-3', sessionId: 's-3' });
  assert.deepStrictEqual(currentUser(), { userId: 'u-3', sessionId: 's-3' });
  startSpan('ambient-span').end('OK');
  const traced = startTrace('ambient-trace');
  traced.end('OK');
  await flush();
  assert.strictEqual(spanNamed('ambient-span').userId, 'u-3');
  assert.strictEqual(spanNamed('ambient-span').sessionId, 's-3');
  assert.strictEqual(spanNamed('ambient-trace').userId, 'u-3');

  setUser({ deviceId: 'd-3' });
  assert.deepStrictEqual(currentUser(), { userId: 'u-3', sessionId: 's-3', deviceId: 'd-3' });

  setUser(null);
  assert.deepStrictEqual(currentUser(), {});
  startSpan('cleared-span').end('OK');
  await flush();
  assert.strictEqual(spanNamed('cleared-span').userId, undefined);
  assert.strictEqual(spanNamed('cleared-span').sessionId, undefined);

  const scoped = startTrace('scoped-request');
  await withTrace(scoped.ctx, async () => {
    setUser({ userId: 'u-4' });
    startSpan('scoped-child').end('OK');
  });
  scoped.end('OK');
  startSpan('outside-span').end('OK');
  await flush();
  assert.strictEqual(spanNamed('scoped-child').userId, 'u-4');
  assert.strictEqual(spanNamed('scoped-request').userId, 'u-4');
  assert.strictEqual(spanNamed('outside-span').userId, undefined, 'setUser inside a trace must not leak to other traces');

  const explicit = startTrace('explicit-wins', { userId: 'u-5' });
  explicit.end('OK');
  await flush();
  assert.strictEqual(spanNamed('explicit-wins').userId, 'u-5');
} catch (err) {
  fail(err.message);
}

console.log('identity.e2e OK');
process.exit(0);
