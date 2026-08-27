import assert from 'node:assert';
import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { init } from '../dist/index.mjs';

const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

const callerSpans = new InMemorySpanExporter();
const caller = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'library-host' }),
  spanProcessors: [new SimpleSpanProcessor(callerSpans)],
});

const globalBeforeInit = trace.getTracerProvider();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'ignored-when-host-names-itself',
  scheduledDelayMillis: 50,
  tracerProvider: caller,
});

try {
  assert.strictEqual(
    trace.getTracerProvider(),
    globalBeforeInit,
    'passing options.tracerProvider still mutated global OpenTelemetry state; a library that embeds EvalKit has no ' +
      "business changing process-wide tracing on its host's behalf"
  );

  assert.strictEqual(client.tracingMode, 'attached', `tracingMode is ${client.tracingMode}, expected "attached"`);

  client.tracer.startSpan('llm.call').end();
  await client.flush();
  await new Promise((r) => setTimeout(r, 200));

  assert.deepStrictEqual(
    callerSpans.getFinishedSpans().map((s) => s.name),
    ['llm.call'],
    "EvalKit displaced the caller's own span processors instead of registering alongside them"
  );

  assert.deepStrictEqual(
    ingested.map((e) => e.operation),
    ['llm.call'],
    'EvalKit exported nothing through the provider it was handed'
  );

  assert.strictEqual(
    ingested[0].serviceName,
    'library-host',
    `serviceName is ${ingested[0].serviceName}: a host that named its own resource is the authority on what its ` +
      'service is called, so the options.serviceName fallback must not overwrite it'
  );

  await client.destroy();
  callerSpans.reset();
  caller.getTracer('caller').startSpan('still-alive').end();
  assert.deepStrictEqual(
    callerSpans.getFinishedSpans().map((s) => s.name),
    ['still-alive'],
    'destroy() shut down the TracerProvider the caller passed in'
  );
} catch (err) {
  fail(err.message);
}

console.log('PASS: options.tracerProvider exports through the caller\'s provider and touches no global state');
process.exit(0);
