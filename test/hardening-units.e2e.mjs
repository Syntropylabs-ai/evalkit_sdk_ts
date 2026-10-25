import assert from 'node:assert';
import { trace, TraceFlags, SpanStatusCode } from '@opentelemetry/api';
import { fromSource } from './_source.mjs';

// The pieces that keep the SDK bounded and safe inside an app, each on its own: the UTF-8 cut, the bounded
// serialiser, the capped maps, the exception contract, option validation, the batch queue and the sampler.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();

const m = await fromSource('hardening-units', `
  export * from './src/core/truncate.ts';
  export * from './src/core/serialize.ts';
  export * from './src/core/exceptions.ts';
  export { validateOptions, normaliseOptions, disabledByEnvironment } from './src/core/config.ts';
  export { BoundedMap } from './src/utils/bounded-map.ts';
  export { EvalKitBatchProcessor, TraceSampler, estimateSpanBytes } from './src/core/batch-processor.ts';
  export { PipelineCounters, FailureReporter, cutReason } from './src/core/diagnostics.ts';
  export { setAttributes } from './src/instrumentation/llm/_span.ts';
  export { consoleMessage } from './src/instrumentation/runtime/console.ts';
  export { ioString } from './src/core/function-io.ts';
  export { scrubbedJson, scrubSecrets } from './src/core/secrets.ts';
`);

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};
const wellFormed = (s) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

// ── UTF-8 cut ────────────────────────────────────────────────────────────────────────────────────────

await check('cutMiddle keeps the start and the end within the limit, in UTF-8 bytes', () => {
  const value = 'A'.repeat(5000) + 'middle' + 'Z'.repeat(5000);
  const cut = m.cutMiddle(value, 1000);
  assert.ok(cut, 'a value over the limit is cut');
  assert.strictEqual(cut.originalBytes, 10006);
  assert.ok(Buffer.byteLength(cut.value) <= 1000, `${Buffer.byteLength(cut.value)} bytes`);
  assert.ok(cut.value.startsWith('AAAA') && cut.value.endsWith('ZZZZ'), 'both ends are kept');
  const marker = /…\[cut (\d+) bytes\]…/.exec(cut.value);
  assert.ok(marker, cut.value.slice(480, 540));
  const kept = Buffer.byteLength(cut.value) - Buffer.byteLength(marker[0]);
  assert.strictEqual(Number(marker[1]) + kept, 10006, 'the marker names exactly what was removed');
  assert.strictEqual(m.cutMiddle('short', 1000), undefined, 'a value within the limit is left alone');
});

await check('cutMiddle measures multibyte text in bytes and never splits a surrogate pair', () => {
  const value = '中'.repeat(2000) + '\u{1F600}'.repeat(2000);
  assert.strictEqual(value.length, 6000);
  assert.strictEqual(m.utf8Length(value), 6000 + 8000);
  const cut = m.cutMiddle(value, 4001);
  assert.ok(Buffer.byteLength(cut.value) <= 4001);
  assert.ok(wellFormed(cut.value), 'no lone surrogate');
  assert.ok(cut.value.startsWith('中') && cut.value.endsWith('\u{1F600}'));
  assert.ok(m.exceedsBytes('é'.repeat(600), 1000), 'a string short in units can be long in bytes');
  assert.ok(!m.exceedsBytes('a'.repeat(1000), 1000));
});

await check('the per-value limit follows OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT when it is lower', () => {
  process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT = '4096';
  try {
    assert.strictEqual(m.resolveValueLimitBytes(), 4096);
    assert.strictEqual(m.resolveValueLimitBytes(1000), 1000, 'an option below the environment wins');
  } finally {
    delete process.env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT;
  }
  assert.strictEqual(m.resolveValueLimitBytes(), 16 * 1024 * 1024, 'default 16 MiB');
});

// ── Bounded serialiser ───────────────────────────────────────────────────────────────────────────────

await check('boundedJson writes what JSON.stringify writes', () => {
  const samples = [
    { a: 1, b: 'two', c: [1, 'x', null, true], d: { e: { f: [] } }, g: undefined, h: () => 1 },
    [1, undefined, () => 2, Symbol('s'), NaN, Infinity, -0, 'é\u{1F600}\n"\\'],
    { date: new Date(0), nested: { toJSON: () => ({ replaced: true }) } },
    { 2: 'b', 1: 'a', z: 'z', y: 'y' },
    'plain', 42, true, null,
    { boxed: [new String('s'), new Number(3), new Boolean(false)] },
  ];
  for (const value of samples) {
    assert.strictEqual(m.boundedJson(value, 100000).text, JSON.stringify(value), JSON.stringify(value));
  }
  assert.strictEqual(m.boundedJson(undefined, 10), undefined);
  assert.strictEqual(m.boundedJson(() => 1, 10), undefined);
});

await check('boundedJson never throws: BigInt, cycles, throwing getters, revoked proxies, buffers', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  assert.strictEqual(m.boundedJson({ n: 10n }, 100).text, '{"n":"10"}');
  assert.strictEqual(m.boundedJson(cyclic, 100).text, '{"name":"root","self":"[Circular]"}');
  const getter = { ok: 1, get bad() { throw new Error('nope'); } };
  assert.strictEqual(m.boundedJson(getter, 100).text, '{"ok":1,"bad":"[Unserializable]"}');
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.strictEqual(m.boundedJson({ p: proxy }, 100).text, '{"p":"[Unserializable]"}');
  assert.strictEqual(m.boundedJson({ b: Buffer.alloc(5000) }, 100).text, '{"b":"[Buffer 5000 bytes]"}');
  const shared = { x: 1 };
  assert.strictEqual(m.boundedJson([shared, shared], 100).text, '[{"x":1},{"x":1}]', 'a value seen twice is not a cycle');
});

await check('boundedJson stops at the limit instead of walking the whole value', () => {
  let reads = 0;
  const huge = new Proxy(new Array(1_000_000).fill(7), {
    get(target, key) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key);
    },
  });
  const out = m.boundedJson(huge, 100);
  assert.ok(out.cut, 'the value was cut');
  assert.strictEqual(out.text.length, 100);
  assert.ok(reads < 100, `${reads} elements read for 100 characters`);
  const big = { s: 'x'.repeat(10_000_000) };
  const started = performance.now();
  const s = m.boundedJson(big, 4096);
  assert.ok(performance.now() - started < 200, 'a 10 MB string costs only what is kept');
  assert.strictEqual(s.text.length, 4096);
});

await check('ioString keeps its output for ordinary values and masks secrets as scrubbedJson does', () => {
  const value = { user: 'ada', apiKey: 'sk-1234567890abcdef1234', nested: { password: 'p', note: 'Bearer abcdefghijklmnop' } };
  assert.strictEqual(m.ioString(value, true), m.scrubbedJson(value));
  assert.strictEqual(m.ioString(value, false), JSON.stringify(value));
  const long = { items: Array.from({ length: 2000 }, (_, i) => ({ i })) };
  assert.strictEqual(m.ioString(long, false), JSON.stringify(long).slice(0, 4096) + '…', 'the same cut as before');
  assert.strictEqual(m.ioString({ n: 1n }, false), '{"n":"1"}', 'a BigInt argument no longer falls back to [object Object]');
});

// ── Bounded map ──────────────────────────────────────────────────────────────────────────────────────

await check('BoundedMap evicts the oldest past its cap and expires entries past the TTL', () => {
  let now = 0;
  const evicted = [];
  const map = new m.BoundedMap(3, 1000, (k) => evicted.push(k), () => now);
  for (const k of ['a', 'b', 'c', 'd']) map.set(k, k.toUpperCase());
  assert.strictEqual(map.size, 3);
  assert.strictEqual(map.get('a'), undefined);
  assert.deepStrictEqual(evicted, ['a']);
  now = 1500;
  assert.strictEqual(map.get('b'), undefined, 'an entry older than the TTL is gone');
  map.set('e', 'E');
  assert.deepStrictEqual(map.entriesList().map(([k]) => k), ['e'], 'the sweep removed the expired entries');
});

// ── Exception contract ───────────────────────────────────────────────────────────────────────────────

const STACK = [
  'TypeError: boom',
  '    at handler (/srv/app/src/routes.js:10:5)',
  '    at async Promise.all (index 0)',
  '    at async run (file:///srv/app/src/main.mjs:22:7)',
  '    at new Worker (/srv/app/node_modules/@scope/pkg/lib/w.js:3:9)',
  '    at Object.<anonymous> (/srv/app/node_modules/openai/core.js:100:20)',
  '    at /srv/app/src/anon.js:1:2',
  '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  '    at Module._compile (internal/modules/cjs/loader.js:1:1)',
  '    at C:\\app\\src\\win.js:4:4',
  '    at native',
].join('\n');

await check('parseStack reads V8 frames innermost first, with in-app and module', () => {
  const frames = m.parseStack(STACK);
  assert.deepStrictEqual(frames.map((f) => [f.function, f.file, f.line, f.col, f.in_app, f.module]), [
    ['handler', '/srv/app/src/routes.js', 10, 5, true, undefined],
    ['run', '/srv/app/src/main.mjs', 22, 7, true, undefined],
    ['new Worker', '/srv/app/node_modules/@scope/pkg/lib/w.js', 3, 9, false, '@scope/pkg'],
    ['Object.<anonymous>', '/srv/app/node_modules/openai/core.js', 100, 20, false, 'openai'],
    ['<anonymous>', '/srv/app/src/anon.js', 1, 2, true, undefined],
    ['process.processTicksAndRejections', 'node:internal/process/task_queues', 95, 5, false, undefined],
    ['Module._compile', 'internal/modules/cjs/loader.js', 1, 1, false, undefined],
    ['<anonymous>', 'C:\\app\\src\\win.js', 4, 4, true, undefined],
  ]);
  assert.strictEqual(m.sourceOf(frames), '/srv/app/src/routes.js:10');
  const many = ['Error: x', ...Array.from({ length: 100 }, (_, i) => `    at f${i} (/a.js:${i + 1}:1)`)].join('\n');
  assert.strictEqual(m.parseStack(many).length, 64, 'at most 64 frames');
  assert.deepStrictEqual(m.parseStack('Error: no frames\nsecond line of the message'), []);
});

await check('inAppInclude and inAppExclude decide which frames are the app\'s own', () => {
  m.configureExceptions({ inAppInclude: ['node_modules/@scope/'], inAppExclude: [/\/src\/anon\.js$/] });
  try {
    const frames = m.parseStack(STACK);
    assert.strictEqual(frames.find((f) => f.module === '@scope/pkg').in_app, true, 'included even in node_modules');
    assert.strictEqual(frames.find((f) => f.file.endsWith('anon.js')).in_app, false, 'excluded');
  } finally {
    m.configureExceptions({});
  }
});

await check('describeError: type, capped message, middle-cut stack, causes, fingerprint', () => {
  class PaymentError extends Error {}
  const root = new Error('db down');
  const mid = new TypeError('query failed', { cause: root });
  const err = new PaymentError('charge failed: ' + 'x'.repeat(5000), { cause: mid });
  err.stack = `PaymentError: charge failed\n${Array.from({ length: 800 }, (_, i) => `    at fn${i} (/srv/app/src/f.js:${i + 1}:1)`).join('\n')}`;
  m.setErrorFingerprint(err, 'payments-timeout');
  const d = m.describeError(err);
  assert.strictEqual(d.type, 'PaymentError', 'the class name when the name is the inherited "Error"');
  assert.ok(Buffer.byteLength(d.message) <= 2048 && d.message.endsWith('…'));
  assert.ok(d.status.startsWith('PaymentError: charge failed'));
  assert.ok(Buffer.byteLength(d.stacktrace) <= 16384, 'stack within 16 KiB');
  assert.ok(d.stacktrace.startsWith('PaymentError') && d.stacktrace.includes('…[cut ') && d.stacktrace.endsWith('f.js:800:1)'), 'start and end kept');
  assert.ok(d.attributes['error.stack'].length <= 8193, 'error.stack stays at 8192');
  const frames = JSON.parse(d.attributes['evalkit.exception.frames']);
  assert.strictEqual(frames.length, 64);
  assert.strictEqual(frames[0].function, 'fn0', 'innermost first');
  assert.strictEqual(d.attributes['evalkit.exception.source'], '/srv/app/src/f.js:1');
  const causes = JSON.parse(d.attributes['evalkit.exception.causes']);
  assert.deepStrictEqual(causes.map((c) => [c.type, c.message]), [['TypeError', 'query failed'], ['Error', 'db down']]);
  assert.ok(Array.isArray(causes[0].frames) && causes[0].frames.length <= 16);
  assert.strictEqual(d.attributes['evalkit.exception.fingerprint'], 'payments-timeout');
  assert.strictEqual(m.describeError(new Error('plain')).attributes['evalkit.exception.fingerprint'], undefined, 'only when set');
});

await check('causes come from AggregateError members and survive cycles', () => {
  const a = new Error('first');
  const b = new RangeError('second');
  a.cause = a;
  const agg = new AggregateError([a, b, 'not an error'], 'all failed');
  const causes = JSON.parse(m.describeError(agg).attributes['evalkit.exception.causes']);
  assert.deepStrictEqual(causes.map((c) => c.type), ['Error', 'RangeError', 'Error']);
  assert.ok(causes.length <= 5);
  const thrown = m.describeError('a string');
  assert.deepStrictEqual([thrown.type, thrown.message], ['Error', 'a string']);
  const odd = m.describeError({ toString() { throw new Error('no'); } });
  assert.strictEqual(odd.type, 'Error', 'a value that cannot even be printed is still described');
});

await check('recordError: one exception event, escaped, the status description, nothing when not recording', () => {
  const events = [];
  const attrs = {};
  let status;
  const span = {
    isRecording: () => true,
    addEvent: (name, a) => events.push([name, a]),
    setAttributes: (a) => Object.assign(attrs, a),
    setStatus: (s) => { status = s; },
  };
  const err = new TypeError('bad input');
  m.recordError(span, err, { escaped: true });
  m.recordError(span, err, { escaped: true });
  assert.strictEqual(events.length, 1, 'the same error twice is one event');
  const [name, a] = events[0];
  assert.strictEqual(name, 'exception');
  assert.strictEqual(a['exception.type'], 'TypeError');
  assert.strictEqual(a['exception.message'], 'bad input');
  assert.strictEqual(a['exception.escaped'], true);
  assert.ok(a['exception.stacktrace'].startsWith('TypeError: bad input'));
  assert.deepStrictEqual(status, { code: SpanStatusCode.ERROR, message: 'TypeError: bad input' });
  assert.strictEqual(attrs['error.type'], 'TypeError');
  assert.ok(m.hasRecordedError(span));
  let touched = false;
  m.recordError({ isRecording: () => false, addEvent: () => { touched = true; } }, err);
  assert.ok(!touched, 'a span that is not recording costs nothing');
  m.recordError(undefined, err);
});

await check('Error.stackTraceLimit is raised only from V8\'s default', () => {
  const before = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 10;
    m.configureExceptions({ stackTraceLimit: 50 });
    assert.strictEqual(Error.stackTraceLimit, 50);
    m.configureExceptions({ stackTraceLimit: 80 });
    assert.strictEqual(Error.stackTraceLimit, 80, 'the value the SDK set may be changed again');
    Error.stackTraceLimit = 200;
    m.configureExceptions({ stackTraceLimit: 50 });
    assert.strictEqual(Error.stackTraceLimit, 200, 'a limit the app raised stays');
    Error.stackTraceLimit = 5;
    m.configureExceptions({ stackTraceLimit: 50 });
    assert.strictEqual(Error.stackTraceLimit, 5, 'a limit the app lowered stays');
  } finally {
    Error.stackTraceLimit = before;
  }
});

await check('error messages are scrubbed, URL query strings inside them included', () => {
  const envelope = m.scrubSecrets({
    traceId: 't', spanId: 's', spanType: 'function_call', createdAt: 'now',
    statusMessage: 'Error: GET https://api.example.com/v1?api_key=abc123&page=2 failed',
    attributes: { 'error.message': 'GET https://h/p?token=abc. Retry later', 'log.message': 'See https://h/p?token=abc' },
    events: [{ name: 'exception', timestamp: 'now', attributes: { 'exception.message': 'https://h/x?secret=s3&ok=1' } }],
  });
  assert.strictEqual(envelope.statusMessage, 'Error: GET https://api.example.com/v1?api_key=***&page=2 failed');
  assert.strictEqual(envelope.attributes['error.message'], 'GET https://h/p?token=***. Retry later');
  assert.strictEqual(envelope.attributes['log.message'], 'See https://h/p?token=abc', 'other free text keeps the URLs it quotes');
  assert.strictEqual(envelope.events[0].attributes['exception.message'], 'https://h/x?secret=***&ok=1');
});

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────

await check('validateOptions names every problem without printing the key', () => {
  assert.deepStrictEqual(m.validateOptions({ subscriptionKey: 'tk_live_1', baseUrl: 'http://localhost:9' }), []);
  assert.deepStrictEqual(m.validateOptions({ subscriptionKey: 'k', maxExportBatchSize: '256', sampleRate: '0.5' }), [], 'numeric text is accepted');
  const problems = m.validateOptions({
    subscriptionKey: '  ', baseUrl: 'ftp://x', maxQueueSize: 0, scheduledDelayMillis: -1, sampleRate: 2,
    maxBodyBytes: 'lots', consoleSpanLevel: 'debug', inAppInclude: 'src',
  });
  assert.strictEqual(problems.length, 8, problems.join('\n'));
  assert.ok(!problems.join(' ').includes('tk_'), 'no key value');
  assert.ok(m.validateOptions(undefined).length === 1);
  assert.strictEqual(m.normaliseOptions({ subscriptionKey: 'k', maxExportBatchSize: '256' }).maxExportBatchSize, 256);
});

await check('EVALKIT_DISABLED and OTEL_SDK_DISABLED switch tracing off', () => {
  assert.strictEqual(m.disabledByEnvironment(), undefined);
  process.env.EVALKIT_DISABLED = 'true';
  assert.strictEqual(m.disabledByEnvironment(), 'EVALKIT_DISABLED');
  delete process.env.EVALKIT_DISABLED;
  process.env.OTEL_SDK_DISABLED = 'true';
  assert.strictEqual(m.disabledByEnvironment(), 'OTEL_SDK_DISABLED');
  delete process.env.OTEL_SDK_DISABLED;
});

// ── Batch queue ──────────────────────────────────────────────────────────────────────────────────────

let spanSeq = 0;
function fakeSpan({ type = 'function_call', bytes = 0, traceId, status = SpanStatusCode.UNSET, sampled = true, remoteParent } = {}) {
  const id = (++spanSeq).toString(16).padStart(16, '0');
  const tid = traceId ?? id.padStart(32, '0');
  return {
    name: `span-${spanSeq}`,
    attributes: { 'evalkit.span_type': type, ...(bytes ? { payload: 'x'.repeat(bytes) } : {}) },
    events: [],
    status: { code: status },
    resource: { attributes: {} },
    spanContext: () => ({ traceId: tid, spanId: id, traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE }),
    parentSpanContext: remoteParent,
  };
}

function fakeExporter({ delayMs = 0, ok = true } = {}) {
  const exp = {
    batches: [],
    inFlight: 0,
    maxInFlight: 0,
    open: true,
    accepting: () => exp.open,
    export(spans, cb) {
      exp.inFlight++;
      exp.maxInFlight = Math.max(exp.maxInFlight, exp.inFlight);
      exp.batches.push(spans.map((s) => s.name));
      setTimeout(() => { exp.inFlight--; cb({ code: ok ? 0 : 1 }); }, delayMs);
    },
    shutdown: () => Promise.resolve(),
  };
  return exp;
}

function processor(exporter, options = {}) {
  const counters = new m.PipelineCounters();
  const p = new m.EvalKitBatchProcessor(exporter, {
    maxExportBatchSize: 2, scheduledDelayMillis: 60000, maxQueueSize: 100, maxQueueBytes: 1 << 30, sampleRate: 1, ...options,
  }, counters);
  return { p, counters };
}

await check('one export in flight at a time; a flush drains every batch in order and never rejects', async () => {
  const exporter = fakeExporter({ delayMs: 20 });
  const { p } = processor(exporter, { maxExportBatchSize: 3 });
  for (let i = 0; i < 10; i++) p.onEnd(fakeSpan());
  assert.strictEqual(await p.flushAll(), true);
  assert.strictEqual(exporter.maxInFlight, 1, 'never two exports at once');
  assert.deepStrictEqual(exporter.batches.flat().length, 10);
  const failing = fakeExporter({ ok: false });
  const { p: p2 } = processor(failing);
  p2.onEnd(fakeSpan());
  assert.strictEqual(await p2.flushAll(), false, 'a failed export is reported');
  await p2.forceFlush();
  await p2.shutdown();
});

await check('the queue keeps within maxQueueSize, model calls displacing other spans', async () => {
  // The first four fill a batch that goes out at once and stays in flight; the queue then holds four more.
  const exporter = fakeExporter({ delayMs: 50 });
  const { p, counters } = processor(exporter, { maxQueueSize: 4, maxExportBatchSize: 4 });
  for (let i = 0; i < 8; i++) p.onEnd(fakeSpan());
  assert.strictEqual(counters.droppedQueueFull, 0);
  p.onEnd(fakeSpan());
  assert.strictEqual(counters.droppedQueueFull, 1, 'a ninth plain span is dropped');
  p.onEnd(fakeSpan({ type: 'llm_call' }));
  assert.strictEqual(counters.droppedQueueFull, 2, 'a model call makes room by dropping the oldest plain span');
  assert.strictEqual(p.queuedSpans, 8, 'four in flight, four queued');
  await p.flushAll();
  assert.ok(exporter.batches.flat().includes('span-' + spanSeq), 'the model call was exported');
  assert.strictEqual(exporter.maxInFlight, 1);
});

await check('the byte budget drops other spans before model calls', async () => {
  const exporter = fakeExporter();
  const { p, counters } = processor(exporter, { maxQueueBytes: 50_000, maxExportBatchSize: 100 });
  for (let i = 0; i < 4; i++) p.onEnd(fakeSpan({ bytes: 10_000 }));
  p.onEnd(fakeSpan({ bytes: 10_000 }));
  assert.strictEqual(counters.droppedBytesBudget, 1, 'a plain span past the budget is dropped');
  const before = p.queuedSize;
  p.onEnd(fakeSpan({ type: 'llm_call', bytes: 20_000 }));
  assert.ok(counters.droppedBytesBudget >= 3, 'older plain spans made room for the model call');
  assert.ok(p.queuedSize <= 50_000 && p.queuedSize > 0, `${before} -> ${p.queuedSize}`);
  p.onEnd(fakeSpan({ type: 'llm_call', bytes: 60_000 }));
  assert.ok(p.queuedSize <= 50_000, 'a span larger than the whole budget is dropped');
  assert.ok(m.estimateSpanBytes(fakeSpan({ bytes: 1000 })) >= 1000);
});

await check('a model call too large for the budget is dropped alone, without emptying the queue', async () => {
  const exporter = fakeExporter();
  const { p, counters } = processor(exporter, { maxQueueBytes: 50_000, maxExportBatchSize: 100 });
  for (let i = 0; i < 3; i++) p.onEnd(fakeSpan({ bytes: 10_000 }));
  const before = p.queuedSpans;
  p.onEnd(fakeSpan({ type: 'llm_call', bytes: 60_000 }));
  assert.strictEqual(p.queuedSpans, before, 'nothing was evicted for a span that could not fit anyway');
  assert.strictEqual(counters.droppedBytesBudget, 1);
  await p.flushAll();
});

await check('a batch the watchdog gave up on: the queue waits for the exporter instead of dropping', async () => {
  let busy = false;
  let idle = [];
  const calls = [];
  const exporter = {
    accepting: () => true,
    isBusy: () => busy,
    whenIdle: () => (busy ? new Promise((r) => idle.push(r)) : Promise.resolve()),
    export(spans, cb) {
      assert.ok(!busy, 'never handed a batch while busy');
      busy = true;
      calls.push(spans.length);
      setTimeout(() => { busy = false; idle.forEach((r) => r()); idle = []; cb({ code: 0 }); }, 120);
    },
    shutdown: () => Promise.resolve(),
  };
  const { p, counters } = processor(exporter, { maxExportBatchSize: 2, exportTimeoutMillis: 30 });
  for (let i = 0; i < 6; i++) p.onEnd(fakeSpan());
  await p.flushAll();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepStrictEqual(calls, [2, 2, 2], 'every batch was exported, one after another');
  assert.strictEqual(counters.droppedExportFailed, 0);
});

await check('an open circuit drops spans before they are queued', () => {
  const exporter = fakeExporter();
  exporter.open = false;
  const { p, counters } = processor(exporter);
  p.onEnd(fakeSpan());
  assert.strictEqual(p.queuedSpans, 0);
  assert.strictEqual(counters.droppedExportFailed, 1);
  p.onEnd(fakeSpan({ sampled: false }));
  assert.strictEqual(counters.droppedExportFailed, 1, 'an unsampled span is not even counted');
});

await check('sampleRate keeps whole traces by id, and always model calls, tool calls and errors', () => {
  const none = new m.TraceSampler(0);
  assert.ok(!none.keep(fakeSpan()), 'rate 0 drops a plain span');
  assert.ok(none.keep(fakeSpan({ type: 'llm_call' })));
  assert.ok(none.keep(fakeSpan({ type: 'tool_call' })));
  assert.ok(none.keep(fakeSpan({ status: SpanStatusCode.ERROR })));
  const remote = fakeSpan({ remoteParent: { isRemote: true, traceFlags: TraceFlags.SAMPLED } });
  none.onStart(remote);
  assert.ok(none.keep(remote), 'a trace another service sampled stays sampled');
  assert.ok(none.keep(fakeSpan({ traceId: remote.spanContext().traceId })), 'and so do its other spans here');
  const half = new m.TraceSampler(0.5);
  let kept = 0;
  for (let i = 0; i < 2000; i++) {
    const traceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    const a = half.keep(fakeSpan({ traceId }));
    const b = half.keep(fakeSpan({ traceId }));
    assert.strictEqual(a, b, 'one decision per trace');
    if (a) kept++;
  }
  assert.ok(kept > 800 && kept < 1200, `kept ${kept} of 2000`);
  assert.ok(new m.TraceSampler(1).keep(fakeSpan()));
});

// ── Recording costs ──────────────────────────────────────────────────────────────────────────────────

await check('setAttributes builds nothing for a span that is not recording', () => {
  let built = false;
  m.setAttributes(trace.wrapSpanContext({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 0 }), () => { built = true; return {}; }, 'test');
  assert.ok(!built);
});

await check('consoleMessage is capped before serialising and never throws', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const evil = { toString() { throw new Error('no'); }, toJSON() { throw new Error('no'); } };
  const msg = m.consoleMessage(['a', 1n, cyclic, evil, new Error('e'), Symbol('s')]);
  assert.ok(msg.startsWith('a "1" {"self":"[Circular]"} "[Unserializable]" e\nError: e'), msg);
  const big = m.consoleMessage(['x'.repeat(10_000), { huge: 'y'.repeat(1_000_000) }]);
  assert.strictEqual(big.length, 2000);
});

await check('the failure reporter prints the first failure, then at most every 5 minutes, cut to 200', () => {
  const lines = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (l) => lines.push(l);
  console.warn = (l) => lines.push(l);
  try {
    let now = 0;
    const counters = new m.PipelineCounters();
    const reporter = new m.FailureReporter(counters, false, () => now);
    const body = 'x'.repeat(10_000);
    reporter.failure(`export failed 500: ${body}`, 3);
    for (let i = 0; i < 50; i++) { now += 1000; reporter.failure('export failed 503: busy', 1); }
    assert.strictEqual(lines.length, 1, 'one line for 51 failures within 5 minutes');
    assert.ok(lines[0].length < 400 && !lines[0].includes(body), 'no full body');
    now += 5 * 60_000;
    reporter.failure('export failed 503: busy', 2);
    assert.strictEqual(lines.length, 2);
    assert.ok(/51 more failure\(s\) and 52 span\(s\) dropped/.test(lines[1]), lines[1]);
    reporter.recovered();
    assert.ok(lines[2].includes('recovered'));
    assert.strictEqual(counters.lastError, null);
    assert.ok(m.cutReason('y'.repeat(500)).length === 200);
  } finally {
    console.error = realError;
    console.warn = realWarn;
  }
});

clearTimeout(watchdog);
const failed = results.filter((r) => r.startsWith('FAIL'));
console.log(results.join('\n'));
if (failed.length) fail(`${failed.length} check(s) failed`);
console.log('PASS hardening-units.e2e.mjs');
