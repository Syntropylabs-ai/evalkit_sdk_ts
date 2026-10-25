import assert from 'node:assert';
import http from 'node:http';
import { ingestBody } from './_ingest.mjs';
import { startMockLlm } from './_mock-llm.mjs';
import * as sdk from '../dist/index.mjs';

// What the app keeps out of traces stays out at every layer. An ignored route records nothing, not its server
// span, not a child span, a function span, a console line, a model call or an outgoing call, and sends no
// traceparent on: on Node's http server (with Express, Koa, Fastify and hapi on it) and through each adapter on
// its own. An untraced scope hides only what runs inside it, across awaits and generators, and never a
// concurrent request. An ignored URL gets no span and no traceparent; an ignored function name wins over an
// explicit wrapper; the environment variables add patterns; invalid patterns warn and never stop the SDK; and
// traceHealthChecks brings probes back.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 60000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ingested = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/v1/ingest')) {
    try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
    return { ok: true, status: 200, text: async () => 'ok' };
  }
  return realFetch(url, opts);
};

const sdkWarnings = [];
console.warn = (...args) => { sdkWarnings.push(args.map(String).join(' ')); };

const listen = async (server) => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
};

// What other services saw arrive: the path and the traceparent it carried, if any.
const seen = [];
const downstream = http.createServer((req, res) => {
  seen.push({ path: req.url, traceparent: req.headers.traceparent });
  res.end('ok');
});
const downPort = await listen(downstream);
const down = (path) => `http://127.0.0.1:${downPort}/down/${path}`;

const httpGet = (url) => new Promise((resolve, reject) => {
  const req = http.request(url, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', reject);
  req.end();
});

process.env.EVALKIT_IGNORE_ROUTES = '/env-route/**';

const base = { subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'ignore-test', scheduledDelayMillis: 50 };
const ignoreRoutes = [
  '/down/**',
  '/v1/chat/completions',
  '/plain/ignored',
  'GET /express/ignored/:id',
  '/koa/ignored/**',
  (info) => info.route === '/fastify/by-route/:name',
  (info) => info.route === '/hapi/by-route/{name}',
  '/solo/*/ignored/**',
  'no-slash',
  42,
];
const client = sdk.init({
  ...base,
  ignoreRoutes,
  ignoreUrls: [`127.0.0.1:${downPort}/down/skip/**`, 'http://'],
  ignoreFunctions: ['myapp.cache.*', 'a..b'],
});

const H = { continue: Symbol('continue') };
const mock = await startMockLlm();
let openai;

/** What a request handler does: a span, a traced function, a log line, a model call and two outgoing calls. */
async function work(tag) {
  const { end } = sdk.startSpan(`${tag}.child`);
  end();
  sdk.traceFunction(`${tag}.fn`, () => 1)();
  console.warn(`log line ${tag}`);
  await openai.chat.completions.create({ model: 'text', messages: [{ role: 'user', content: `hello ${tag}` }] });
  await (await globalThis.fetch(down(`${tag}/fetch`))).text();
  await httpGet(down(`${tag}/http`));
}

const tagOf = (path) => path.split('/').filter(Boolean).join('-');
const contains = (tag) => ingested.filter((e) => JSON.stringify(e).includes(tag));
const arrived = (tag) => seen.filter((s) => s.path.startsWith(`/down/${tag}/`));
const llmRequests = (tag) => mock.requests.filter((r) => JSON.stringify(r.body).includes(`hello ${tag}`));

function assertNothingOf(tag) {
  assert.deepStrictEqual(contains(tag).map((e) => e.operation), [], `${tag}: nothing is recorded`);
}

function assertNoContextOut(tag) {
  const calls = arrived(tag);
  assert.ok(calls.length >= 2, `${tag}: both outgoing calls arrived`);
  for (const call of calls) assert.strictEqual(call.traceparent, undefined, `${tag}: ${call.path} carried no traceparent`);
  const llm = llmRequests(tag);
  assert.ok(llm.length >= 1, `${tag}: the model was called`);
  for (const call of llm) assert.strictEqual(call.headers.traceparent, undefined, `${tag}: the model call carried no traceparent`);
}

function assertTraced(tag) {
  const ops = new Set(ingested.map((e) => e.operation));
  assert.ok(ops.has(`${tag}.child`), `${tag}: the child span is recorded`);
  assert.ok(ops.has(`${tag}.fn`), `${tag}: the function span is recorded`);
  assert.ok(ingested.some((e) => e.spanType === 'llm_call' && String(e.prompt ?? '').includes(tag)), `${tag}: the model call is recorded`);
  for (const call of arrived(tag)) assert.ok(call.traceparent, `${tag}: ${call.path} carried a traceparent`);
}

try {
  assert.strictEqual(client.enabled, true, 'invalid patterns leave the SDK on');
  const invalid = sdkWarnings.filter((w) => w.includes('skipped the invalid pattern'));
  assert.strictEqual(invalid.length, 4, invalid.join('\n'));
  for (const name of ['ignoreRoutes', 'ignoreUrls', 'ignoreFunctions']) {
    assert.ok(invalid.some((w) => w.includes(`${name}:`)), `${name}'s invalid pattern is named`);
  }

  await sleep(400);
  const { default: OpenAI } = await import('openai');
  openai = new OpenAI({ baseURL: `${mock.url}/v1`, apiKey: 'sk-test-000000000000000000', maxRetries: 0 });

  // ── on Node's http server ───────────────────────────────────────────────────────────────────────────
  const express = sdk.expressMiddleware();
  const koa = sdk.koaMiddleware();
  const fastify = {};
  sdk.fastifyPlugin()({ addHook: (name, fn) => { fastify[name] = fn; } }, {}, () => {});
  const hapi = {};
  sdk.hapiPlugin().register({ ext: (name, fn) => { hapi[name] = fn; } });
  const fastifyRoute = (path) => (path.startsWith('/fastify/by-route/') ? '/fastify/by-route/:name' : path);
  const hapiRoute = (path) => (path.startsWith('/hapi/by-route/') ? '/hapi/by-route/{name}' : path);

  const special = {
    // Only part of this request runs untraced; the concurrent one runs traced throughout.
    async '/plain/scoped'() {
      sdk.startSpan('scoped.visible-before').end();
      await sdk.withoutTracing(async () => { await sleep(30); await work('scoped-hidden'); });
      sdk.startSpan('scoped.visible-after').end();
    },
    async '/plain/concurrent'() {
      await sleep(10);
      await work('concurrent-visible');
    },
  };

  const app = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    const name = path.split('/')[1];
    const tag = tagOf(path);
    const finish = (p) => Promise.resolve(p).then(
      () => { if (!res.writableEnded) res.end('ok'); },
      (err) => { res.statusCode = 500; res.end(String(err?.stack ?? err)); },
    );
    if (special[path]) return finish(special[path]());
    switch (name) {
      case 'express':
        return express(req, res, () => finish(work(tag)));
      case 'koa': {
        const ctx = { req, method: req.method, path, url: req.url, href: `http://x${req.url}`, request: { headers: req.headers } };
        return finish(koa(ctx, () => work(tag)));
      }
      case 'fastify': {
        const request = { raw: req, method: req.method, url: req.url, headers: req.headers, routeOptions: { url: fastifyRoute(path) } };
        // Fastify runs each next stage from the hook's done callback.
        return fastify.onRequest(request, {}, () => fastify.preHandler(request, {}, () => finish(
          work(tag).then(() => new Promise((r) => fastify.onResponse(request, { statusCode: 200 }, r))),
        )));
      }
      case 'hapi': {
        const request = { raw: { req }, method: req.method.toLowerCase(), path, url: new URL(`http://x${req.url}`), headers: req.headers, route: { path: hapiRoute(path), method: 'get' }, response: { statusCode: 200 } };
        assert.strictEqual(hapi.onRequest(request, H), H.continue);
        return finish(work(tag).then(() => hapi.onPreResponse(request, H)));
      }
      default:
        return finish(work(tag));
    }
  });
  const appPort = await listen(app);
  const get = (path) => httpGet(`http://127.0.0.1:${appPort}${path}`);

  const ignoredOnServer = [
    '/plain/ignored', '/plain/ignored/?q=1', '/plain/healthz', '/env-route/x', '/express/ignored/7', '/koa/ignored/a/b',
    '/fastify/by-route/x', '/hapi/by-route/y',
  ];
  const tracedOnServer = ['/plain/traced', '/express/traced', '/koa/traced', '/fastify/traced', '/hapi/traced', '/express/ignored/8/more'];
  for (const path of [...ignoredOnServer, ...tracedOnServer]) await get(path);
  // POST is not the method the Express pattern names.
  await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${appPort}/express/ignored/8`, { method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  });
  await Promise.all([get('/plain/scoped'), get('/plain/concurrent')]);

  // ── each adapter on its own, as on a runtime without Node's http server ─────────────────────────────
  const nest = sdk.createNestjsInterceptor();
  const hono = sdk.honoMiddleware();
  const soloExpress = sdk.expressMiddleware();
  const soloKoa = sdk.koaMiddleware();
  const soloFastify = {};
  sdk.fastifyPlugin()({ addHook: (name, fn) => { soloFastify[name] = fn; } }, {}, () => {});
  const solo = {
    express: (url, tag) => new Promise((resolve) => {
      const req = { method: 'GET', url, originalUrl: url, headers: {} };
      const res = { statusCode: 200, setHeader() {}, getHeaders: () => ({}), write: () => true, end() {} };
      soloExpress(req, res, () => resolve(work(tag).then(() => res.end('ok'))));
    }),
    koa: (url, tag) => soloKoa({ method: 'GET', path: url, url, href: `http://x${url}`, request: { headers: {} } }, () => work(tag)),
    fastify: (url, tag) => new Promise((resolve) => {
      const request = { method: 'GET', url, headers: {}, routeOptions: { url } };
      soloFastify.onRequest(request, {}, () => soloFastify.preHandler(request, {}, () => resolve(
        work(tag).then(() => new Promise((r) => soloFastify.onResponse(request, { statusCode: 200 }, r))),
      )));
    }),
    hono: (url, tag) => hono({ res: { status: 200 }, req: { url: `http://x${url}`, method: 'GET', header: () => undefined, raw: { headers: [] } } }, () => work(tag)),
    nest: (url, tag) => new Promise((resolve, reject) => {
      const handled = { subscribe(o) { work(tag).then(() => o.complete?.(), (e) => o.error?.(e)); return { unsubscribe() {} }; }, pipe() { return this; } };
      const req = { method: 'GET', url, originalUrl: url, headers: {} };
      const res = { statusCode: 200 };
      const out = nest.intercept({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }, { handle: () => handled });
      out.subscribe({ next() {}, error: reject, complete: resolve });
    }),
  };
  for (const [name, run] of Object.entries(solo)) {
    await run(`/solo/${name}/ignored/1`, `solo-${name}-ignored-1`);
    await run(`/solo/${name}/traced`, `solo-${name}-traced`);
  }

  // ── untraced scopes inside a trace ──────────────────────────────────────────────────────────────────
  const hidden = sdk.untraced(async (tag) => { await sleep(20); await work(tag); });
  const gen = sdk.untraced(function* (tag) {
    sdk.startSpan(`${tag}.step1`).end();
    yield 1;
    sdk.startSpan(`${tag}.step2`).end();
    yield 2;
  });
  const agen = sdk.untraced(async function* (tag) {
    await sleep(1);
    sdk.startSpan(`${tag}.astep`).end();
    yield 1;
  });
  const root = sdk.startTrace('untraced-root');
  await sdk.withTrace(root.ctx, async () => {
    await Promise.all([hidden('untraced-hidden'), (async () => { await sleep(5); await work('untraced-sibling'); })()]);
    const values = [];
    for (const v of gen('gen-hidden')) {
      values.push(v);
      sdk.startSpan('gen-consumer').end();
    }
    assert.deepStrictEqual(values, [1, 2], 'the generator yields as it would');
    for await (const v of agen('agen-hidden')) values.push(v);
    assert.deepStrictEqual(values, [1, 2, 1]);
    assert.strictEqual(sdk.withoutTracing(() => 'answer'), 'answer', 'withoutTracing returns what its function does');
  });
  root.end();

  // ── ignored URLs and function names ─────────────────────────────────────────────────────────────────
  const cacheGet = () => 'cached';
  assert.strictEqual(sdk.traceFunction('myapp.cache.get', cacheGet), cacheGet, 'an ignored name wins over traceFunction');
  const ordersGet = sdk.traceFunction('myapp.orders.get', () => 'order');
  assert.notStrictEqual(ordersGet, undefined);
  const plain = sdk.untraced(() => 'plain');
  assert.strictEqual(sdk.traceFunction('myapp.orders.plain', plain), plain, 'an untraced function is not wrapped again');
  const descriptor = { value: function put() { return 'put'; } };
  sdk.TraceMethod('myapp.cache.put')({}, 'put', descriptor);
  const object = { flush() { return 'flushed'; } };
  const originalFlush = object.flush;
  sdk.traceObject(object, { prefix: 'myapp.cache' });
  assert.strictEqual(object.flush, originalFlush, 'traceObject leaves an ignored function in place');

  const outbound = sdk.startTrace('outbound-root');
  await sdk.withTrace(outbound.ctx, async () => {
    await (await globalThis.fetch(down('skip/fetch'))).text();
    await httpGet(down('skip/http'));
    await (await globalThis.fetch(down('keep/fetch'))).text();
    await httpGet(down('keep/http'));
    assert.strictEqual(cacheGet(), 'cached');
    assert.strictEqual(ordersGet(), 'order');
    assert.strictEqual(descriptor.value(), 'put');
    assert.strictEqual(plain(), 'plain');
    assert.strictEqual(object.flush(), 'flushed');
  });
  outbound.end();

  await sdk.flush();
  await sleep(300);

  for (const path of ignoredOnServer) {
    const tag = tagOf(path.split('?')[0]);
    assertNothingOf(tag);
    // hapi runs the rest of a request outside its hooks, so a route it alone can tell is ignored is left out
    // of the export, though its calls still carry the http server's context.
    if (!path.startsWith('/hapi/')) assertNoContextOut(tag);
    assert.ok(!ingested.some((e) => e.spanKind === 'SERVER' && String(e.attributes?.['http.url'] ?? '').startsWith(path.split('?')[0])),
      `${path}: no server span`);
  }
  for (const path of tracedOnServer) {
    assertTraced(tagOf(path));
    assert.ok(ingested.some((e) => e.spanKind === 'SERVER' && String(e.attributes?.['http.url'] ?? '') === path), `${path}: its server span is recorded`);
  }
  assert.ok(ingested.some((e) => e.spanKind === 'SERVER' && e.attributes?.['http.url'] === '/express/ignored/8'), 'a POST is not the GET the pattern names');

  for (const name of Object.keys(solo)) {
    assertNothingOf(`solo-${name}-ignored-1`);
    assertNoContextOut(`solo-${name}-ignored-1`);
    assertTraced(`solo-${name}-traced`);
  }

  assertNothingOf('scoped-hidden');
  assertNoContextOut('scoped-hidden');
  const scopedOps = new Set(ingested.map((e) => e.operation));
  assert.ok(scopedOps.has('scoped.visible-before') && scopedOps.has('scoped.visible-after'), 'what runs around the scope is traced');
  assertTraced('concurrent-visible');
  const concurrentServer = ingested.find((e) => e.spanKind === 'SERVER' && e.attributes?.['http.url'] === '/plain/concurrent');
  for (const op of ['concurrent-visible.child', 'concurrent-visible.fn']) {
    assert.strictEqual(ingested.find((e) => e.operation === op).traceId, concurrentServer.traceId, `${op} belongs to its own request`);
  }

  assertNothingOf('untraced-hidden');
  assertNoContextOut('untraced-hidden');
  assertTraced('untraced-sibling');
  assert.strictEqual(ingested.find((e) => e.operation === 'untraced-sibling.child').traceId, root.traceId);
  assertNothingOf('gen-hidden');
  assertNothingOf('agen-hidden');
  assert.strictEqual(ingested.filter((e) => e.operation === 'gen-consumer').length, 2, 'the consumer between the steps is traced');

  for (const path of ['/down/skip/fetch', '/down/skip/http']) {
    assert.strictEqual(seen.find((s) => s.path === path).traceparent, undefined, `${path}: an ignored URL carries no traceparent`);
  }
  for (const path of ['/down/keep/fetch', '/down/keep/http']) {
    assert.ok(seen.find((s) => s.path === path).traceparent, `${path}: a call not ignored carries the trace on`);
  }
  assertNothingOf('/down/skip/');
  assert.ok(ingested.some((e) => e.spanKind === 'CLIENT' && String(e.attributes?.['http.url']).endsWith('/down/keep/http')), 'the call not ignored is a client span');
  const ops = new Set(ingested.map((e) => e.operation));
  assert.ok(ops.has('myapp.orders.get'), 'a function not ignored is traced');
  for (const op of ['myapp.cache.get', 'myapp.cache.put', 'myapp.cache.flush', 'myapp.orders.plain']) assert.ok(!ops.has(op), `${op} is not traced`);

  // ── traceHealthChecks brings probes back ────────────────────────────────────────────────────────────
  sdk.init({ ...base, ignoreRoutes: ['/down/**', '/v1/chat/completions'], traceHealthChecks: true });
  await sleep(100);
  ingested.length = 0;
  seen.length = 0;
  mock.requests.length = 0;
  await get('/plain/healthz');
  await sdk.flush();
  await sleep(300);
  assert.ok(ingested.some((e) => e.spanKind === 'SERVER' && e.attributes?.['http.url'] === '/plain/healthz'), 'a probe is traced with traceHealthChecks');
  assertTraced('plain-healthz');
  await get('/plain/ignored');
  await sdk.flush();
  await sleep(300);
  assert.ok(ingested.some((e) => e.spanKind === 'SERVER' && e.attributes?.['http.url'] === '/plain/ignored'), 'the new options replace the old ones');

  app.close();
  downstream.close();
  await mock.close();
  console.log('PASS ignore.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
