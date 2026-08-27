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

const hostSpans = new InMemorySpanExporter();
const host = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'unknown_service:node' }),
  spanProcessors: [new SimpleSpanProcessor(hostSpans)],
});
host.register();

const globalBeforeInit = trace.getTracerProvider();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'adopted-svc',
  scheduledDelayMillis: 50,
});

try {
  assert.strictEqual(
    trace.getTracerProvider(),
    globalBeforeInit,
    'init() displaced the global TracerProvider the host had already registered. In OpenTelemetry JS, ' +
      'registerGlobal refuses a duplicate registration, so whoever registers second is silently orphaned: either ' +
      "the host's Jaeger/Datadog/OTLP exporters stop receiving spans, or EvalKit's exporter receives nothing at all " +
      'and reports no error.'
  );

  assert.strictEqual(
    client.tracingMode,
    'attached',
    `tracingMode is ${client.tracingMode}, expected "attached": with a host provider present EvalKit must add its ` +
      "span processor to that provider rather than build a second pipeline, so the host keeps every exporter it had " +
      'and EvalKit additionally sees the spans the host\'s own instrumentation produces'
  );

  client.tracer.startSpan('evalkit-span').end();
  trace.getTracer('host-instrumentation').startSpan('host-span').end();

  await client.flush();
  await new Promise((r) => setTimeout(r, 200));

  const hostNames = hostSpans.getFinishedSpans().map((s) => s.name).sort();
  assert.deepStrictEqual(
    hostNames,
    ['evalkit-span', 'host-span'],
    `the host exporter saw ${JSON.stringify(hostNames)}; it must still see every span it would have seen without ` +
      "EvalKit installed, plus EvalKit's own spans, because EvalKit only appends a processor"
  );

  const ingestedNames = ingested.map((e) => e.operation).sort();
  assert.deepStrictEqual(
    ingestedNames,
    ['evalkit-span', 'host-span'],
    `EvalKit ingested ${JSON.stringify(ingestedNames)}; attaching to the host provider is what makes the host's own ` +
      'instrumentation visible in EvalKit, and it is the only way EvalKit gets any data at all when the host owns ' +
      'the global provider'
  );

  for (const e of ingested) {
    assert.strictEqual(
      e.serviceName,
      'adopted-svc',
      `serviceName is ${e.serviceName}: when EvalKit attaches to a host provider it never gets to set the resource, ` +
        'so without the exporter-level fallback options.serviceName is dropped and every span lands in the ' +
        "dashboard under OpenTelemetry's unknown_service placeholder"
    );
  }

  await client.destroy();
  hostSpans.reset();
  trace.getTracer('host-instrumentation').startSpan('after-destroy').end();
  assert.deepStrictEqual(
    hostSpans.getFinishedSpans().map((s) => s.name),
    ['after-destroy'],
    'destroy() tore down a TracerProvider EvalKit did not create; it must only detach its own span processor'
  );
} catch (err) {
  fail(err.message);
}

console.log(`PASS: attached to the host TracerProvider; ${ingested.length} envelope(s) ingested, host pipeline intact`);
process.exit(0);
