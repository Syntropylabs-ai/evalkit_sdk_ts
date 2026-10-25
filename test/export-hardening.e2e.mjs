import assert from 'node:assert';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { fromSource } from './_source.mjs';
import { ingestBody } from './_ingest.mjs';

// The exporter never hangs, never piles up requests, and stops trying cheaply while the receiver is down:
// each attempt has a timeout, one export runs at a time, and after three failed cycles a circuit opens for
// 30 s (doubling up to 5 min) and is tested with one small request before anything else is sent.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();
// A real request's socket keeps the process alive while it waits; the stand-in receiver holds none.
const keepAlive = setInterval(() => {}, 1000);

const { EvalKitExporter, RETRY_BUDGET_MS } = await fromSource('export-hardening', `
  export { EvalKitExporter } from './src/core/exporter.ts';
  export { RETRY_BUDGET_MS } from './src/core/retry.ts';
`);

const memory = new InMemorySpanExporter();
const host = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
function spans(n, attributes = {}) {
  memory.reset();
  for (let i = 0; i < n; i++) {
    host.getTracer('export-hardening').startSpan(`span-${i}`, { attributes: { 'evalkit.span_type': 'function_call', ...attributes } }).end();
  }
  return memory.getFinishedSpans();
}

const lines = [];
console.error = (...a) => lines.push(a.map(String).join(' '));
console.warn = (...a) => lines.push(a.map(String).join(' '));

let behaviour = async () => new Response('{}', { status: 202 });
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push(init);
  return behaviour(url, init);
};

function exporterWithClock(options = {}) {
  const exporter = new EvalKitExporter({ baseUrl: 'http://receiver.test', subscriptionKey: 'tk_test', exportGzip: false, ...options });
  const clock = { now: Date.UTC(2026, 0, 1) };
  exporter.clock = () => clock.now;
  exporter.pause = async (ms) => { clock.now += ms; };
  const run = (batch) => new Promise((resolve) => exporter.export(batch, (r) => resolve(r.code === 0)));
  return { exporter, clock, run };
}

const results = [];
const check = async (name, fn) => {
  requests.length = 0;
  lines.length = 0;
  behaviour = async () => new Response('{}', { status: 202 });
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};

await check('every attempt carries an abort signal, and a receiver that never answers is given up on', async () => {
  // A receiver that accepts the connection and never answers: only the attempt's timeout ends it.
  behaviour = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')));
  });
  const { exporter, clock, run } = exporterWithClock();
  // At the end of the budget an attempt still gets its one-second minimum, and no wait follows it.
  const realNow = Date.now;
  const start = clock.now;
  // The export reads the clock once for its deadline; by the first attempt only 300 ms of it are left.
  let reads = 0;
  exporter.clock = () => (reads++ === 0 ? start : start + RETRY_BUDGET_MS - 300);
  const began = realNow();
  const ok = await run(spans(1));
  const took = realNow() - began;
  assert.strictEqual(ok, false);
  assert.ok(requests[0].signal instanceof AbortSignal, 'fetch got a signal');
  assert.ok(took >= 900 && took < 5000, `the hung request was abandoned after ${took} ms`);
  assert.ok(lines.some((l) => l.includes('export network error') && l.includes('timed out')), lines.join('\n'));
  assert.strictEqual(exporter.counters.droppedExportFailed, 1);
});

await check('a second export while one is in flight is dropped and counted', async () => {
  let release;
  behaviour = () => new Promise((resolve) => { release = () => resolve(new Response('{}', { status: 202 })); });
  const { exporter, run } = exporterWithClock();
  const first = run(spans(2));
  const second = await run(spans(3));
  assert.strictEqual(second, false, 'the export that came while busy failed at once');
  assert.strictEqual(exporter.counters.droppedExportFailed, 3);
  assert.strictEqual(requests.length, 1, 'no second request was made');
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(exporter.counters.exported, 2);
});

await check('three failed cycles open the circuit; it drops cheaply, then probes with one small request', async () => {
  behaviour = async () => { throw new TypeError('fetch failed'); };
  const { exporter, clock, run } = exporterWithClock();
  for (let i = 0; i < 3; i++) assert.strictEqual(await run(spans(1)), false);
  assert.strictEqual(exporter.circuitState(), 'open');
  assert.strictEqual(exporter.accepting(), false);
  const before = requests.length;
  assert.strictEqual(await run(spans(5)), false);
  assert.strictEqual(requests.length, before, 'nothing is sent while the circuit is open');
  assert.strictEqual(exporter.counters.exportFailures, 3);

  clock.now += 30_000;
  assert.strictEqual(exporter.circuitState(), 'half_open');
  assert.ok(exporter.accepting());
  requests.length = 0;
  assert.strictEqual(await run(spans(40)), false, 'the probe fails');
  assert.ok(requests.length >= 1);
  assert.ok(requests.every((r) => ingestBody(r).events.length <= 16), 'only the probe was sent');
  assert.strictEqual(exporter.circuitState(), 'open');
  clock.now += 30_000;
  assert.strictEqual(exporter.circuitState(), 'open', 'the cooldown doubled to 60 s');
  clock.now += 30_000;
  assert.strictEqual(exporter.circuitState(), 'half_open');

  behaviour = async () => new Response('{}', { status: 202 });
  requests.length = 0;
  assert.strictEqual(await run(spans(40)), true, 'a probe that succeeds lets the rest through');
  assert.strictEqual(ingestBody(requests[0]).events.length, 16, 'the first request is the small probe');
  assert.strictEqual(requests.slice(1).reduce((n, r) => n + ingestBody(r).events.length, 0), 24);
  assert.strictEqual(exporter.circuitState(), 'closed');
  assert.ok(lines.some((l) => l.includes('recovered')), 'recovery is reported once');
  assert.strictEqual(exporter.counters.lastError, null);
});

await check('refused bodies do not open the circuit', async () => {
  behaviour = async () => new Response('{"error":"bad"}', { status: 400 });
  const { exporter, run } = exporterWithClock();
  for (let i = 0; i < 5; i++) await run(spans(1));
  assert.strictEqual(exporter.circuitState(), 'closed');
  assert.strictEqual(lines.filter((l) => l.includes('export failed 400')).length, 1, 'reported once, not five times');
});

await check('a refused key is reported clearly once, and three refusals disable exporting', async () => {
  behaviour = async () => new Response('x'.repeat(5000), { status: 401 });
  const { exporter, run } = exporterWithClock();
  await run(spans(1));
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('refused the subscription key (HTTP 401)') && lines[0].length < 500, lines[0]);
  await run(spans(1));
  await run(spans(1));
  assert.strictEqual(exporter.circuitState(), 'disabled');
  assert.ok(lines.some((l) => l.includes('tracing is disabled')));
  const sent = requests.length;
  assert.strictEqual(await run(spans(1)), false);
  assert.strictEqual(requests.length, sent, 'nothing more is sent');
  assert.ok(!lines.some((l) => l.includes('tk_test')), 'the key is never printed');
});

await check('a failure line never carries a whole response body or a stack', async () => {
  behaviour = async () => new Response(`<html>${'oops '.repeat(4000)}</html>`, { status: 502 });
  const { run } = exporterWithClock();
  await run(spans(1));
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].length < 450, `${lines[0].length} characters`);
  assert.ok(!/\n\s+at /.test(lines[0]), 'no stack');
});

await check('span sizes are measured in UTF-8 bytes, and spans of other libraries are held to the value limit', async () => {
  const { run } = exporterWithClock();
  // 2.5 million CJK characters: 7.5 MB in UTF-8, though only 2.5 million UTF-16 units.
  const text = '中'.repeat(2_500_000);
  const batch = spans(1, { 'gen_ai.request.body': text, 'gen_ai.response.body': text, 'other.note': text });
  assert.strictEqual(await run(batch), true);
  const sent = ingestBody(requests[0]).events[0];
  const bytes = Buffer.byteLength(JSON.stringify(sent));
  assert.ok(bytes <= 16 * 1024 * 1024, `the span went out at ${bytes} bytes`);
  assert.strictEqual(sent.attributes['evalkit.truncated.gen_ai.request.body'], 7_500_000, 'the original size is recorded');
  assert.ok(sent.attributes['gen_ai.request.body'].startsWith('中') && sent.attributes['gen_ai.request.body'].endsWith('中'));
});

await check('an exception event another library recorded is capped, and its stack gives the span frames', async () => {
  const { run } = exporterWithClock();
  memory.reset();
  const span = host.getTracer('other-lib').startSpan('query');
  const err = new Error('m'.repeat(10_000));
  span.recordException(err);
  span.end();
  assert.strictEqual(await run(memory.getFinishedSpans()), true);
  const sent = ingestBody(requests[0]).events[0];
  const event = sent.events.find((e) => e.name === 'exception');
  assert.ok(Buffer.byteLength(event.attributes['exception.message']) <= 2048);
  assert.ok(Buffer.byteLength(event.attributes['exception.stacktrace']) <= 16384);
  const frames = JSON.parse(sent.attributes['evalkit.exception.frames']);
  assert.ok(frames.length > 0 && frames[0].file.endsWith('export-hardening.e2e.mjs'), JSON.stringify(frames[0]));
  assert.ok(sent.attributes['evalkit.exception.source'].includes('export-hardening.e2e.mjs:'));
});

clearTimeout(watchdog);
clearInterval(keepAlive);
const failed = results.filter((r) => r.startsWith('FAIL'));
process.stdout.write(results.join('\n') + '\n');
if (failed.length) fail(`${failed.length} check(s) failed`);
process.stdout.write('PASS export-hardening.e2e.mjs\n');
process.exit(0);
