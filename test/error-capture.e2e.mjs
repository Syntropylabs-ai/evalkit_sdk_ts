import assert from 'node:assert';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { ingestBody } from './_ingest.mjs';
import evalkit, {
  init, traceFunction, traceTool, startSpan, captureException, setErrorFingerprint,
  expressMiddleware, expressErrorHandler, fastifyPlugin, EvalKitInterceptor, startHttpTrace,
} from '../dist/index.mjs';

// Errors are recorded one way everywhere, the way the Python SDK and the receiver read them: the status
// "<Type>: <message>", one `exception` event (type, message, stacktrace, escaped), and the frames, source,
// causes and fingerprint as span attributes. The frameworks hand the actual error over, and the wrappers
// cover generators as they are iterated.

const THIS_FILE = fileURLToPath(import.meta.url);
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'error-capture', scheduledDelayMillis: 50 });

async function spansNamed(name) {
  await client.flush();
  return ingested.filter((e) => e.operation === name || e.operation?.endsWith?.(` ${name}`));
}
async function oneSpan(name) {
  const found = await spansNamed(name);
  assert.strictEqual(found.length, 1, `expected one "${name}" span, got ${found.length}: ${ingested.map((e) => e.operation).join(', ')}`);
  return found[0];
}
const exceptionEvents = (span) => (span.events ?? []).filter((e) => e.name === 'exception');

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};

class PaymentDeclined extends Error {}

await check('a traced function that throws: status, one exception event, escaped, frames and source', async () => {
  const charge = traceFunction('charge', () => { throw new PaymentDeclined('card declined'); });
  assert.throws(() => charge(), PaymentDeclined, 'the error reaches the caller unchanged');
  const span = await oneSpan('charge');
  assert.strictEqual(span.status, 'ERROR');
  assert.strictEqual(span.statusMessage, 'PaymentDeclined: card declined');
  const [event, ...more] = exceptionEvents(span);
  assert.strictEqual(more.length, 0, 'one event per exception');
  assert.strictEqual(event.attributes['exception.type'], 'PaymentDeclined');
  assert.strictEqual(event.attributes['exception.message'], 'card declined');
  assert.strictEqual(event.attributes['exception.escaped'], true);
  assert.ok(event.attributes['exception.stacktrace'].startsWith('Error: card declined') || event.attributes['exception.stacktrace'].includes('card declined'));
  assert.strictEqual(span.attributes['error.type'], 'PaymentDeclined');
  assert.strictEqual(span.attributes['error.message'], 'card declined');
  assert.ok(typeof span.attributes['error.stack'] === 'string' && typeof span.attributes['error.source'] === 'string');
  const frames = JSON.parse(span.attributes['evalkit.exception.frames']);
  assert.strictEqual(frames[0].file, THIS_FILE, 'the innermost frame is the throw');
  assert.strictEqual(frames[0].in_app, true);
  assert.ok(frames.some((f) => f.in_app === false), 'the SDK and Node frames are not in-app');
  for (const f of frames) assert.deepStrictEqual(Object.keys(f).filter((k) => !['file', 'line', 'col', 'function', 'module', 'in_app'].includes(k)), []);
  assert.strictEqual(span.attributes['evalkit.exception.source'], `${THIS_FILE}:${frames[0].line}`);
  assert.strictEqual(span.attributes['evalkit.exception.fingerprint'], undefined);
});

await check('an async rejection, a tool, causes and a fingerprint', async () => {
  const root = new Error('connection reset');
  const fetchRates = traceTool('fetch_rates', async () => {
    throw setErrorFingerprint(new TypeError('rates unavailable', { cause: root }), 'rates-down');
  });
  await assert.rejects(fetchRates('EUR'), TypeError);
  const span = await oneSpan('fetch_rates');
  assert.strictEqual(span.spanType, 'tool_call');
  assert.strictEqual(span.statusMessage, 'TypeError: rates unavailable');
  assert.deepStrictEqual(JSON.parse(span.attributes['evalkit.exception.causes']).map((c) => [c.type, c.message]), [['Error', 'connection reset']]);
  assert.strictEqual(span.attributes['evalkit.exception.fingerprint'], 'rates-down');
});

await check('captureException records a handled error on the active span, or a span of its own', async () => {
  const s = startSpan('handled');
  await evalkit.withTrace(s.ctx, async () => { captureException(new RangeError('retrying'), { fingerprint: 'retry' }); });
  s.end('OK');
  const span = await oneSpan('handled');
  const [event] = exceptionEvents(span);
  assert.strictEqual(event.attributes['exception.escaped'], false, 'a handled error did not escape');
  assert.strictEqual(span.statusMessage, 'RangeError: retrying');
  assert.strictEqual(span.attributes['evalkit.exception.fingerprint'], 'retry');
  captureException('a plain string');
  const alone = await oneSpan('exception');
  assert.strictEqual(alone.statusMessage, 'Error: a plain string');
});

await check('a traced generator: the span covers the iteration, its children nest in it, an error mid-way ends it', async () => {
  const child = traceFunction('page', (n) => n);
  const pages = traceFunction('pages', function* (count) {
    for (let i = 0; i < count; i++) yield child(i);
  });
  const it = pages(3);
  assert.strictEqual(Object.prototype.toString.call(it), '[object Generator]', 'still a generator to the app');
  assert.strictEqual((await spansNamed('pages')).length, 0, 'not ended before it is iterated');
  assert.deepStrictEqual([...it], [0, 1, 2]);
  const span = await oneSpan('pages');
  assert.strictEqual(span.status, 'OK');
  const children = ingested.filter((e) => e.operation === 'page');
  assert.strictEqual(children.length, 3);
  assert.ok(children.every((c) => c.parentSpanId === span.spanId && c.traceId === span.traceId), 'children run inside the span');

  const broken = traceFunction('broken_pages', function* () { yield 1; throw new Error('page 2 missing'); });
  const seen = [];
  assert.throws(() => { for (const v of broken()) seen.push(v); }, /page 2 missing/);
  assert.deepStrictEqual(seen, [1]);
  const failed = await oneSpan('broken_pages');
  assert.strictEqual(failed.statusMessage, 'Error: page 2 missing');
  assert.strictEqual(exceptionEvents(failed)[0].attributes['exception.escaped'], true);

  const early = traceFunction('early_break', function* () { yield 1; yield 2; yield 3; });
  for (const v of early()) if (v === 1) break;
  assert.strictEqual((await oneSpan('early_break')).status, 'OK', 'a break ends it');
});

await check('a traced async generator covers its iteration too', async () => {
  const stream = traceFunction('token_stream', async function* () {
    yield 'a';
    await new Promise((r) => setTimeout(r, 30));
    yield 'b';
  });
  const out = [];
  const startedAt = Date.now();
  for await (const t of stream()) out.push(t);
  assert.deepStrictEqual(out, ['a', 'b']);
  const span = await oneSpan('token_stream');
  assert.ok(span.latencyMs >= 25, `the span lasted ${span.latencyMs} ms of ${Date.now() - startedAt}`);
  const failing = traceFunction('failing_stream', async function* () { yield 1; throw new Error('stream broke'); });
  await assert.rejects(async () => { for await (const _ of failing()) { /* consume */ } }, /stream broke/);
  assert.strictEqual((await oneSpan('failing_stream')).statusMessage, 'Error: stream broke');
});

await check('a result whose traps throw reaches the caller as it is', async () => {
  const hostile = new Proxy({}, { get(_t, key) { if (typeof key === 'symbol' || key === 'then') throw new TypeError('trap'); return 1; } });
  const make = traceFunction('hostile_result', () => hostile);
  assert.strictEqual(make(), hostile);
  assert.strictEqual((await oneSpan('hostile_result')).status, 'OK');
});

await check('startHttpTrace takes a BigInt or circular body without failing the request', async () => {
  const body = { amount: 10n, items: [] };
  body.self = body;
  const t = startHttpTrace('POST /orders', { method: 'POST', url: '/orders', requestBody: body, headers: { 'content-type': 'application/json' } });
  t.end('OK', { statusCode: 200, body: { ok: true, id: 1n } });
  const span = await oneSpan('POST /orders');
  assert.strictEqual(span.attributes['http.request.body'], '{"amount":"10","items":[],"self":"[Circular]"}');
  assert.strictEqual(span.attributes['http.response.body'], '{"ok":true,"id":"1"}');
});

// A server where an Express-style chain runs: the middleware, a route that fails, the error handler.
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function request(server, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

await check('Express: the error a route passes on is recorded by the error handler, and the 500 keeps its description', async () => {
  const middleware = expressMiddleware();
  const onError = expressErrorHandler();
  assert.strictEqual(onError.length, 4, 'Express tells error handlers by four parameters');
  const server = await listen((req, res) => {
    req.originalUrl = req.url;
    req.body = { total: 5n };
    middleware(req, res, () => {
      const err = new PaymentDeclined('insufficient funds');
      onError(err, req, res, (passed) => {
        assert.strictEqual(passed, err, 'the error is handed on unchanged');
        res.statusCode = 500;
        res.end('failed');
      });
    });
  });
  const reply = await request(server, '/checkout');
  server.close();
  assert.deepStrictEqual(reply, { status: 500, text: 'failed' });
  const span = await oneSpan('/checkout');
  assert.strictEqual(span.statusMessage, 'PaymentDeclined: insufficient funds');
  const [event] = exceptionEvents(span);
  assert.strictEqual(event.attributes['exception.type'], 'PaymentDeclined');
  assert.strictEqual(event.attributes['exception.escaped'], false, 'the error became a response');
});

await check('Fastify: onError hands the actual error to the span, which ends with the status sent', async () => {
  const hooks = {};
  const fastify = { addHook: (name, fn) => { hooks[name] = fn; } };
  const plugin = fastifyPlugin();
  plugin(fastify, {}, () => {});
  const request = { method: 'GET', url: '/fx', headers: {}, raw: {}, routeOptions: { url: '/fx' } };
  const reply = { statusCode: 200 };
  await new Promise((done) => hooks.onRequest(request, reply, done));
  await new Promise((done) => hooks.onError(request, reply, new RangeError('rate out of range'), done));
  reply.statusCode = 502;
  await new Promise((done) => hooks.onSend(request, reply, '{"error":"bad gateway"}', done));
  await new Promise((done) => hooks.onResponse(request, reply, done));
  const span = await oneSpan('GET /fx');
  assert.strictEqual(span.attributes['http.status_code'], 502, 'the status the error handler answered');
  assert.strictEqual(span.statusMessage, 'RangeError: rate out of range');
  assert.strictEqual(exceptionEvents(span)[0].attributes['exception.type'], 'RangeError');
  assert.strictEqual(span.attributes['http.response.body'], '"{\\"error\\":\\"bad gateway\\"}"');
});

await check('NestJS: the error a handler fails with is recorded, with and without the http server span', async () => {
  const interceptor = new EvalKitInterceptor(client);
  const failing = (err) => ({ handle: () => ({ subscribe: (o) => { o.error?.(err); return { unsubscribe() {} }; } }) });
  const execution = (req, res) => ({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) });

  // Without Node's http server (a request the interceptor opens its own span for). Nest answers an error that
  // is not an HttpException with a 500.
  const broken = Object.assign(new Error('ledger unavailable'), { name: 'LedgerError' });
  let seen;
  interceptor.intercept(execution({ method: 'GET', url: '/orders/7', headers: {}, route: { path: '/orders/:id' } }, { statusCode: 200 }), failing(broken))
    .subscribe({ error: (e) => { seen = e; } });
  assert.strictEqual(seen, broken, 'the error reaches Nest unchanged');
  const own = await oneSpan('GET /orders/:id');
  assert.strictEqual(own.statusMessage, 'LedgerError: ledger unavailable');
  assert.strictEqual(own.attributes['http.status_code'], 500);

  // On Node's http server: the error goes on the server span the request already has.
  const server = await listen((req, res) => {
    const nestRequest = { method: req.method, url: req.url, raw: req, routeOptions: { url: '/pay' } };
    interceptor.intercept(execution(nestRequest, res), failing(new TypeError('amount must be positive'))).subscribe({
      error: () => { res.statusCode = 500; res.end('failed'); },
    });
  });
  await request(server, '/pay');
  server.close();
  const core = await oneSpan('/pay');
  assert.strictEqual(core.statusMessage, 'TypeError: amount must be positive');
  assert.strictEqual(exceptionEvents(core).length, 1);
});

await check('captureGlobalErrors: an uncaught exception is recorded and the process still prints it and exits 1', async () => {
  const received = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { received.push(...ingestBody({ headers: req.headers, body: Buffer.concat(chunks) }).events); } catch {}
      res.writeHead(200).end('{}');
    });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const dist = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
  const run = (code) => new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, URL_: url, DIST_: dist } });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('exit', (status, signal) => resolve({ status, signal, stderr }));
    });
  });
  const prelude = `const { init } = await import(process.env.DIST_); init({ subscriptionKey: 'k', baseUrl: process.env.URL_, captureGlobalErrors: true, scheduledDelayMillis: 60000 });`;

  const uncaught = await run(`${prelude} setTimeout(() => { throw new TypeError('kaboom'); }, 10);`);
  assert.strictEqual(uncaught.status, 1);
  assert.ok(uncaught.stderr.includes('TypeError: kaboom'), uncaught.stderr);
  const crash = received.find((e) => e.operation === 'error.uncaught_exception');
  assert.ok(crash, 'the crash was exported before the process exited');
  assert.strictEqual(crash.statusMessage, 'TypeError: kaboom');

  received.length = 0;
  const rejected = await run(`${prelude} Promise.reject(new Error('nobody caught me'));`);
  assert.strictEqual(rejected.status, 1, 'an unhandled rejection still ends the process, as Node does by default');
  assert.ok(rejected.stderr.includes('nobody caught me'));
  assert.ok(received.some((e) => e.operation === 'error.unhandled_rejection'));

  received.length = 0;
  const warned = await new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const child = spawn(process.execPath, ['--unhandled-rejections=warn-with-error-code', '--input-type=module', '-e', `${prelude} Promise.reject(new Error('only a warning'));`], { env: { ...process.env, URL_: url, DIST_: dist } });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      child.on('exit', (status) => resolve({ status, stderr }));
    });
  });
  assert.strictEqual(warned.status, 1, '--unhandled-rejections=warn-with-error-code still sets exit code 1');
  assert.ok(warned.stderr.includes('only a warning'), warned.stderr);

  const handled = await run(`${prelude} process.on('uncaughtException', () => { process.stdout.write('app handled'); setTimeout(() => process.exit(3), 50); }); setTimeout(() => { throw new Error('handled by the app'); }, 10);`);
  assert.strictEqual(handled.status, 3, 'an app with its own handler decides itself');
  server.close();
});

clearTimeout(watchdog);
const failed = results.filter((r) => r.startsWith('FAIL'));
process.stdout.write(results.join('\n') + '\n');
if (failed.length) fail(`${failed.length} check(s) failed`);
process.stdout.write('PASS error-capture.e2e.mjs\n');
process.exit(0);
