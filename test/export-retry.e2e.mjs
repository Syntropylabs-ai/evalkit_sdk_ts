import assert from 'node:assert';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 30000);
watchdog.unref?.();

// The exporter is not part of the public bundle, and its waits are what is under test, so it is built from
// source here and given a clock and a pause that only count.
const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = fileURLToPath(new URL('../node_modules/.cache/evalkit-export-retry/bundle.mjs', import.meta.url));
await build({
  stdin: {
    contents: "export { EvalKitExporter } from './src/core/exporter.ts'; export * from './src/core/retry.ts';",
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'export-retry-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile,
  logLevel: 'error',
});
const { EvalKitExporter, MAX_RETRY_WAIT_MS, RETRY_BUDGET_MS, isRetryableStatus, retryAfterMs, retryDelayMs } =
  await import(outfile);

const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);

// Retry-After and the backoff on their own.
assert.strictEqual(retryAfterMs('5', NOW), 5000);
assert.strictEqual(retryAfterMs(' 7 ', NOW), 7000, 'whitespace around delta-seconds is allowed');
assert.strictEqual(retryAfterMs('Thu, 01 Jan 2026 00:00:07 GMT', NOW), 7000, 'an HTTP-date counts from now');
assert.strictEqual(retryAfterMs('Wed, 31 Dec 2025 23:59:00 GMT', NOW), 0, 'a date already past means now');
for (const unreadable of [undefined, null, '', 'soon', '1.5', '-3']) {
  assert.strictEqual(retryAfterMs(unreadable, NOW), undefined, `Retry-After ${JSON.stringify(unreadable)}`);
}
assert.strictEqual(retryDelayMs(0, '3600', NOW), MAX_RETRY_WAIT_MS, 'a long Retry-After is capped');
assert.strictEqual(retryDelayMs(2, '2', NOW), 2000, 'Retry-After replaces the backoff step');
assert.strictEqual(retryDelayMs(0, null, NOW, () => 0), 100);
assert.strictEqual(retryDelayMs(0, null, NOW, () => 1), 300, 'the first step spreads over 100-300 ms');
assert.strictEqual(retryDelayMs(1, null, NOW, () => 0.5), 600);
assert.strictEqual(retryDelayMs(7, null, NOW, () => 0), 900, 'steps past the last one stay at its scale');
for (const status of [429, 500, 502, 503, 504]) assert.ok(isRetryableStatus(status), `${status} is retried`);
for (const status of [200, 202, 400, 401, 403, 404, 413, 415, 422]) assert.ok(!isRetryableStatus(status), `${status} is final`);

// The exporter against a scripted receiver: every answer it is given, and every wait it takes.
const memory = new InMemorySpanExporter();
const host = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
function spans(n) {
  memory.reset();
  for (let i = 0; i < n; i++) {
    host.getTracer('export-retry').startSpan(`span-${i}`, { attributes: { 'evalkit.span_type': 'function_call' } }).end();
  }
  return memory.getFinishedSpans();
}

const errors = [];
console.error = (...args) => { errors.push(args.map(String).join(' ')); };

let answers = [];
const calls = [];
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(Buffer.from(init.body).toString('utf8'));
  calls.push(body.events.map((e) => e.operation));
  const [status, retryAfter] = answers.length > 1 ? answers.shift() : answers[0];
  const headers = retryAfter === undefined ? {} : { 'Retry-After': retryAfter };
  return new Response(JSON.stringify(status < 300 ? { status: 'queued' } : { error: 'busy' }), { status, headers });
};

function scripted(script, options = {}) {
  answers = script;
  calls.length = 0;
  errors.length = 0;
  const exporter = new EvalKitExporter({ baseUrl: 'http://receiver.test', subscriptionKey: 'tk_test', exportGzip: false, ...options });
  const waits = [];
  let now = NOW;
  exporter.clock = () => now;
  exporter.pause = async (ms) => { waits.push(ms); now += ms; };
  const run = (batch) => new Promise((resolve) => exporter.export(batch, (r) => resolve(r.code === 0)));
  return { run, waits };
}

{
  const { run, waits } = scripted([[429, '0'], [202]]);
  assert.ok(await run(spans(1)), 'a 429 is retried and the retry is accepted');
  assert.deepStrictEqual(waits, [0]);
  assert.strictEqual(calls.length, 2);
}

{
  const { run, waits } = scripted([[503, '4'], [202]]);
  assert.ok(await run(spans(1)));
  assert.deepStrictEqual(waits, [4000], 'a 503 waits as long as its Retry-After says');
}

{
  const { run, waits } = scripted([[429, 'Thu, 01 Jan 2026 00:00:07 GMT'], [202]]);
  assert.ok(await run(spans(1)));
  assert.deepStrictEqual(waits, [7000], 'an HTTP-date Retry-After is honored');
}

{
  const { run, waits } = scripted([[429, '3600'], [202]]);
  assert.ok(await run(spans(1)));
  assert.deepStrictEqual(waits, [MAX_RETRY_WAIT_MS], 'a Retry-After past the cap waits the cap');
}

{
  const { run, waits } = scripted([[429]]);
  assert.ok(!(await run(spans(1))), 'a receiver that never takes the request fails the export');
  assert.strictEqual(calls.length, 4, 'one request and three retries');
  assert.strictEqual(waits.length, 3);
  assert.ok(waits[0] >= 100 && waits[0] <= 300, `jittered first wait ${waits[0]}`);
  assert.ok(errors.some((e) => e.includes('export failed 429')), errors.join('\n'));
}

{
  const { run, waits } = scripted([[429, '3600']]);
  assert.ok(!(await run(spans(1))));
  assert.deepStrictEqual(waits, [MAX_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS], 'no wait is taken past the budget');
  assert.strictEqual(calls.length, 3, 'the retry that would end past the budget is not sent');
  assert.ok(waits.reduce((a, b) => a + b, 0) <= RETRY_BUDGET_MS);
}

{
  // One span per request: the first takes two 8 s waits, which leaves the second too little of the budget.
  const { run, waits } = scripted([[429, '8'], [429, '8'], [202], [429, '8'], [202]], { maxExportBatchSize: 1 });
  assert.ok(!(await run(spans(2))), 'the budget is the whole export, not each request');
  assert.deepStrictEqual(waits, [8000, 8000]);
  assert.deepStrictEqual(calls, [['span-0'], ['span-0'], ['span-0'], ['span-1']]);
}

{
  const { run } = scripted([[429]], { maxExportBatchSize: 1 });
  assert.ok(!(await run(spans(2))));
  assert.ok(calls.every((c) => c[0] === 'span-0'), 'after an overloaded receiver gives up, the next request is not sent');
}

for (const status of [400, 404, 422]) {
  const { run, waits } = scripted([[status, '1']]);
  assert.ok(!(await run(spans(1))));
  assert.strictEqual(calls.length, 1, `a ${status} is not retried`);
  assert.deepStrictEqual(waits, []);
}

console.log('OK export-retry');
