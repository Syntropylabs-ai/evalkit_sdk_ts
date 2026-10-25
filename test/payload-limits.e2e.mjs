import assert from 'node:assert';
import { trace } from '@opentelemetry/api';
import { ingestBody } from './_ingest.mjs';
import { init, startSpan, traceFunction, traceTool, withTrace, flush, getStats } from '../dist/index.mjs';

// What the SDK records stays bounded whatever the app hands it: a value past the per-value limit keeps its
// start and its end and records its size, an argument is read only as far as it is kept, console capture
// is capped, rate limited and makes spans of its own only from warn upwards, and sampleRate drops whole
// traces while keeping model calls, tool calls and errors.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const base = { subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'payload-limits', scheduledDelayMillis: 50, exitHooks: false };
let client = init({ ...base, maxValueBytes: 2000 });

async function take(name) {
  await flush();
  const found = ingested.filter((e) => e.operation === name);
  return found;
}

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};

await check('a value past maxValueBytes keeps its start and end on the SDK\'s own spans, set at start or later', async () => {
  const big = 'START' + 'é'.repeat(3000) + 'END';
  const s = startSpan('big-values', { 'test.start': big });
  const span = trace.getSpan(s.ctx);
  span.setAttribute('gen_ai.request.body', big);
  span.setAttributes({ 'gen_ai.response.body': big });
  s.end();
  const [out] = await take('big-values');
  for (const key of ['test.start', 'gen_ai.request.body', 'gen_ai.response.body']) {
    const value = out.attributes[key];
    assert.ok(Buffer.byteLength(value) <= 2000, `${key}: ${Buffer.byteLength(value)} bytes`);
    assert.ok(value.startsWith('START') && value.endsWith('END') && value.includes('…[cut '), key);
    assert.strictEqual(out.attributes[`evalkit.truncated.${key}`], Buffer.byteLength(big), key);
  }
});

await check('spans of other libraries are held to the same limit when exported', async () => {
  const foreign = trace.getTracer('some-library').startSpan('foreign-values', { attributes: { 'db.statement': 'SELECT ' + 'x'.repeat(5000) } });
  foreign.end();
  const [out] = await take('foreign-values');
  assert.ok(Buffer.byteLength(out.attributes['db.statement']) <= 2000);
  assert.strictEqual(out.attributes['evalkit.truncated.db.statement'], 5007);
});

await check('HTTP bodies are recorded up to 64 KiB by default', () => {
  const fresh = init({ ...base });
  assert.strictEqual(fresh.options.maxBodyBytes, 64 * 1024);
  assert.strictEqual(fresh.options.maxValueBytes, 16 * 1024 * 1024);
  client = fresh;
});

await check('a traced function\'s huge argument is read only as far as it is recorded', async () => {
  const rows = Array.from({ length: 300_000 }, (_, i) => ({ id: i, name: `row-${i}` }));
  const count = traceFunction('count_rows', (list) => list.length);
  const started = performance.now();
  for (let i = 0; i < 20; i++) count(rows);
  const each = (performance.now() - started) / 20;
  assert.ok(each < 20, `${each.toFixed(2)} ms a call`);
  const [first] = await take('count_rows');
  assert.ok(first.attributes['function.args'].length <= 4097);
  assert.ok(first.attributes['function.args'].startsWith('[[{"id":0,"name":"row-0"}'));
});

await check('console: events on the active span, rate limited, capped; spans of their own from warn up only', async () => {
  const writes = process.stdout.write.bind(process.stdout);
  const errWrites = process.stderr.write.bind(process.stderr);
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    const s = startSpan('noisy');
    await withTrace(s.ctx, async () => {
      for (let i = 0; i < 1000; i++) console.log('tick', i, { big: 'z'.repeat(10_000) }, 10n);
    });
    s.end();
    await new Promise((r) => setTimeout(r, 1100));
    console.log('outside any span');
    console.warn('a warning outside any span');
    const cyclic = {};
    cyclic.self = cyclic;
    console.error(cyclic, { toJSON() { throw new Error('no'); } });
  } finally {
    process.stdout.write = writes;
    process.stderr.write = errWrites;
  }
  const [noisy] = await take('noisy');
  const logs = (noisy.events ?? []).filter((e) => e.name === 'log.INFO');
  assert.ok(logs.length > 0 && logs.length <= 50, `${logs.length} log events for 1000 calls in a second`);
  assert.ok(logs.every((e) => e.attributes['log.message'].length <= 2000));
  assert.strictEqual((await take('log.INFO')).length, 0, 'console.log outside a span makes no span by default');
  assert.strictEqual((await take('log.WARN')).length, 1);
  const [error] = await take('log.ERROR');
  assert.ok(error.attributes['log.message'].includes('[Circular]'));
});

await check('consoleSpanLevel: "info" records console.log outside a span too, "none" nothing', async () => {
  const writes = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    client = init({ ...base, consoleSpanLevel: 'info' });
    console.log('now recorded');
    client = init({ ...base, consoleSpanLevel: 'none' });
    console.error('not recorded');
  } finally {
    process.stdout.write = writes;
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.ok((await take('log.INFO')).some((e) => e.attributes['log.message'] === 'now recorded'));
  assert.ok(!(await take('log.ERROR')).some((e) => e.attributes['log.message'] === 'not recorded'));
});

await check('sampleRate 0 drops plain spans but keeps tool calls and errored spans', async () => {
  client = init({ ...base, sampleRate: 0 });
  traceFunction('sampled_plain', () => 1)();
  traceTool('sampled_tool', () => 1)();
  assert.throws(() => traceFunction('sampled_error', () => { throw new Error('kept'); })());
  await flush();
  const ops = ingested.map((e) => e.operation);
  assert.ok(!ops.includes('sampled_plain'));
  assert.ok(ops.includes('sampled_tool') && ops.includes('sampled_error'));
  assert.ok(getStats().sampled_out >= 1);
  client = init({ ...base });
});

clearTimeout(watchdog);
const failed = results.filter((r) => r.startsWith('FAIL'));
process.stdout.write(results.join('\n') + '\n');
if (failed.length) fail(`${failed.length} check(s) failed`);
process.stdout.write('PASS payload-limits.e2e.mjs\n');
process.exit(0);
