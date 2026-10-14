import assert from 'node:assert';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { EvalKitClient } from '../dist/index.mjs';

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 90000);
watchdog.unref?.();

const MiB = 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * MiB;
const BODY_OVERHEAD = '{"events":[]}'.length;

// A stand-in for /v1/ingest that records every request and answers with `respond(request)`: a status, or
// [status, Retry-After].
const requests = [];
let respond = () => 202;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const encoding = req.headers['content-encoding'] ?? null;
    const request = { encoding, sentBytes: raw.length, jsonBytes: null, events: null };
    try {
      const body = encoding === 'gzip' ? gunzipSync(raw) : raw;
      request.jsonBytes = body.length;
      request.events = JSON.parse(body.toString('utf8')).events;
    } catch {}
    const answer = respond(request);
    const [status, retryAfter] = Array.isArray(answer) ? answer : [answer];
    request.status = status;
    request.at = Date.now();
    requests.push(request);
    const headers = { 'Content-Type': 'application/json' };
    if (retryAfter !== undefined) headers['Retry-After'] = retryAfter;
    res.writeHead(request.status, headers);
    res.end(JSON.stringify(request.status < 300 ? { accepted: request.events?.length ?? 0, status: 'queued' } : { error: 'refused' }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const warnings = [];
const errors = [];
const realWarn = console.warn;
const realError = console.error;
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
console.error = (...args) => { errors.push(args.map(String).join(' ')); };

function reset(answer = () => 202) {
  requests.length = 0;
  warnings.length = 0;
  errors.length = 0;
  respond = answer;
}

function newClient(options = {}) {
  // Each case owns its TracerProvider, so its spans reach only its own exporter.
  const host = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
  const client = new EvalKitClient({
    subscriptionKey: 'tk_test',
    baseUrl,
    serviceName: 'export-requests',
    scheduledDelayMillis: 60000,
    tracerProvider: host,
    ...options,
  });
  assert.strictEqual(client.tracingMode, 'attached');
  return client;
}

async function exportSpans(client, spans) {
  for (const { name, payload } of spans) {
    const attributes = { 'evalkit.span_type': 'function_call' };
    if (payload) attributes['test.payload'] = 'x'.repeat(payload);
    client.tracer.startSpan(name, { attributes }).end();
  }
  // flush() resolves to whether the export succeeded; it never rejects.
  return client.flush();
}

async function waitFor(predicate, what) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const spansNamed = (n, prefix = 'span', payload = 0) =>
  Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i}`, payload }));
const accepted = () => requests.filter((r) => r.status < 300).flatMap((r) => r.events.map((e) => e.operation));
const sorted = (names) => [...names].sort();

try {
  {
    reset();
    const client = newClient();
    assert.ok(await exportSpans(client, [{ name: 'span-0', payload: 10_000 }]));
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].encoding, 'gzip', 'compression is on unless it is turned off');
    assert.deepStrictEqual(accepted(), ['span-0'], 'the body inflates to the same envelope');
    assert.ok(requests[0].sentBytes < requests[0].jsonBytes / 10, 'a repetitive payload shrinks on the wire');
    await client.destroy();
  }

  {
    reset();
    const client = newClient({ exportGzip: false });
    assert.ok(await exportSpans(client, [{ name: 'span-0' }]));
    assert.strictEqual(requests[0].encoding, null, 'exportGzip: false sends plain JSON');
    assert.deepStrictEqual(accepted(), ['span-0']);
    await client.destroy();
  }

  {
    reset();
    process.env.EVALKIT_EXPORT_GZIP = 'false';
    const fromEnv = newClient();
    const explicit = newClient({ exportGzip: true });
    delete process.env.EVALKIT_EXPORT_GZIP;
    assert.ok(await exportSpans(fromEnv, [{ name: 'env' }]));
    assert.ok(await exportSpans(explicit, [{ name: 'option' }]));
    assert.deepStrictEqual(
      requests.map((r) => [r.events[0].operation, r.encoding]),
      [['env', null], ['option', 'gzip']],
      'EVALKIT_EXPORT_GZIP=false turns compression off, and the option wins over it'
    );
    await fromEnv.destroy();
    await explicit.destroy();
  }

  {
    reset();
    const client = newClient();
    const spans = spansNamed(6, 'big', MiB);
    assert.ok(await exportSpans(client, spans));
    assert.ok(requests.length >= 2, `six 1 MiB spans need more than one request, got ${requests.length}`);
    for (const r of requests) {
      assert.ok(r.jsonBytes <= MAX_REQUEST_BYTES, `a request carried ${r.jsonBytes} bytes of JSON`);
    }
    assert.deepStrictEqual(sorted(accepted()), sorted(spans.map((s) => s.name)), 'every span arrives exactly once');
    await client.destroy();
  }

  {
    reset();
    const client = newClient();
    const spans = [{ name: 'small-a', payload: 100 }, { name: 'huge', payload: 5 * MiB }, { name: 'small-b', payload: 100 }];
    assert.ok(await exportSpans(client, spans));
    const huge = requests.find((r) => r.events.some((e) => e.operation === 'huge'));
    assert.strictEqual(huge.events.length, 1, 'a span larger than the request cap travels alone');
    assert.deepStrictEqual(sorted(accepted()), sorted(spans.map((s) => s.name)));
    await client.destroy();
  }

  {
    reset();
    const client = newClient({ maxExportBatchSize: 5 });
    const spans = spansNamed(12);
    assert.ok(await exportSpans(client, spans));
    // A full batch is exported as soon as it fills, so it can still be in flight when the flush returns.
    await waitFor(() => accepted().length === spans.length, 'all 12 spans');
    assert.ok(requests.every((r) => r.events.length <= 5), `request sizes ${requests.map((r) => r.events.length)}`);
    assert.deepStrictEqual(sorted(accepted()), sorted(spans.map((s) => s.name)));
    await client.destroy();
  }

  {
    reset((r) => (r.events.length > 2 ? 413 : 202));
    const client = newClient();
    const spans = spansNamed(8);
    assert.ok(await exportSpans(client, spans), 'every half that fits is accepted, so the export succeeds');
    assert.deepStrictEqual(requests.map((r) => r.events.length), [8, 4, 2, 2, 4, 2, 2]);
    assert.deepStrictEqual(sorted(accepted()), sorted(spans.map((s) => s.name)), 'each span is accepted exactly once');
    await client.destroy();
  }

  {
    reset((r) => (r.events.some((e) => e.operation === 'too-big') ? 413 : 202));
    const client = newClient();
    assert.strictEqual(
      await exportSpans(client, [{ name: 'fits-a' }, { name: 'too-big', payload: 20_000 }, { name: 'fits-b' }]),
      false,
      'a dropped span fails the export'
    );
    assert.deepStrictEqual(sorted(accepted()), ['fits-a', 'fits-b']);
    const alone = requests.filter((r) => r.events.length === 1 && r.events[0].operation === 'too-big');
    assert.strictEqual(alone.length, 1, 'the refused span was tried on its own before it was dropped');
    const spanBytes = alone[0].jsonBytes - BODY_OVERHEAD;
    const dropped = warnings.filter((w) => w.includes('413'));
    assert.strictEqual(dropped.length, 1, warnings.join('\n'));
    assert.ok(dropped[0].includes('"too-big"') && dropped[0].includes(`(${spanBytes} bytes)`), dropped[0]);
    await client.destroy();
  }

  for (const status of [415, 400]) {
    reset((r) => (r.encoding === 'gzip' ? status : 202));
    const client = newClient();
    assert.ok(await exportSpans(client, [{ name: 'first' }]), 'the uncompressed resend is what the receiver keeps');
    assert.ok(await exportSpans(client, [{ name: 'second' }]));
    assert.deepStrictEqual(
      requests.map((r) => [r.encoding, r.status]),
      [['gzip', status], [null, 202], [null, 202]],
      `after a ${status} to a compressed body the exporter stops compressing for good`
    );
    assert.deepStrictEqual(accepted(), ['first', 'second']);
    const notices = warnings.filter((w) => w.includes('does not accept gzip'));
    assert.strictEqual(notices.length, 1, warnings.join('\n'));
    assert.ok(notices[0].includes(`HTTP ${status}`), notices[0]);
    await client.destroy();
  }

  {
    reset(() => 400);
    const client = newClient();
    assert.strictEqual(await exportSpans(client, [{ name: 'first' }]), false);
    assert.strictEqual(await exportSpans(client, [{ name: 'second' }]), false);
    assert.deepStrictEqual(
      requests.map((r) => r.encoding),
      ['gzip', null, 'gzip', null],
      'a receiver that refuses the plain body too has said nothing about gzip'
    );
    assert.ok(!warnings.some((w) => w.includes('does not accept gzip')), warnings.join('\n'));
    assert.ok(errors.some((e) => e.includes('export failed 400')), 'the refusal is reported');
    await client.destroy();
  }

  {
    const answers = [503, 202];
    reset(() => answers.shift() ?? 202);
    const client = newClient();
    assert.ok(await exportSpans(client, [{ name: 'retried' }]));
    assert.deepStrictEqual(requests.map((r) => r.status), [503, 202], 'a 5xx is retried with the same body');
    assert.deepStrictEqual(accepted(), ['retried']);
    await client.destroy();
  }

  {
    reset(() => 503);
    const client = newClient();
    assert.strictEqual(await exportSpans(client, spansNamed(2, 'down', 3 * MiB)), false);
    assert.strictEqual(
      requests.length,
      4,
      'a request the receiver never accepts is tried 4 times, and the request after it is not sent'
    );
    assert.ok(requests.every((r) => r.events.length === 1 && r.events[0].operation === 'down-0'));
    assert.ok(errors.some((e) => e.includes('export failed 503')), 'the failure is reported');
    await client.destroy();
  }

  {
    const answers = [[429, '0'], 202];
    reset(() => answers.shift() ?? 202);
    const client = newClient();
    assert.ok(await exportSpans(client, [{ name: 'throttled' }]));
    assert.deepStrictEqual(requests.map((r) => r.status), [429, 202], 'a 429 is retried with the same body');
    assert.deepStrictEqual(accepted(), ['throttled']);
    await client.destroy();
  }

  {
    const answers = [[503, '1'], 202];
    reset(() => answers.shift() ?? 202);
    const client = newClient();
    assert.ok(await exportSpans(client, [{ name: 'later' }]));
    const gap = requests[1].at - requests[0].at;
    assert.ok(gap >= 950, `the retry came ${gap} ms after a Retry-After of 1 s`);
    await client.destroy();
  }

  {
    reset(() => 429);
    const client = newClient();
    assert.strictEqual(await exportSpans(client, spansNamed(2, 'busy', 3 * MiB)), false);
    assert.strictEqual(requests.length, 4, 'a 429 that never clears is tried 4 times, and the next request is not sent');
    assert.ok(requests.every((r) => r.events[0].operation === 'busy-0'));
    assert.ok(errors.some((e) => e.includes('export failed 429')), 'the failure is reported');
    await client.destroy();
  }

  {
    reset(() => 404);
    const client = newClient();
    assert.strictEqual(await exportSpans(client, [{ name: 'nowhere' }]), false);
    assert.strictEqual(requests.length, 1, 'a 4xx other than 429 is not retried');
    await client.destroy();
  }

  {
    reset(() => 401);
    const client = newClient();
    assert.strictEqual(await exportSpans(client, spansNamed(2, 'key', 3 * MiB)), false);
    assert.strictEqual(requests.length, 1, 'the request after a refused key would be refused too');
    await client.destroy();
  }
} catch (err) {
  console.warn = realWarn;
  console.error = realError;
  server.close();
  fail(err?.stack ?? err);
}

console.warn = realWarn;
console.error = realError;
server.close();
console.log('export-requests.e2e OK');
process.exit(0);
