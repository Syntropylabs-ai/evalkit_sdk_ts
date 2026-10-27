import assert from 'node:assert';
import http from 'node:http';
import { ingestBody } from './_ingest.mjs';
import { fromSource } from './_source.mjs';
import {
  init, expressMiddleware, expressErrorHandler, fastifyPlugin, koaMiddleware, honoMiddleware, hapiPlugin,
  EvalKitInterceptor, traceFunction,
} from '../dist/index.mjs';

// By OpenTelemetry's HTTP conventions a request's server span fails for a 5xx answer only, or for an
// exception the server answers with one. A 404, a 401 or a failed validation is the caller's: the span keeps
// the status code, stays OK and records no exception. An outgoing call that gets a 4xx back still failed.
// Every adapter is driven on both of its paths: on Node's http server, where it hands the error to the
// server span, and on its own span, as on a runtime without that server.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

// The adapter checks below run with ["500-599"], the setting that leaves a 4xx to the caller, so each one shows
// that the answer decides the span; the 400-599 default, where a 4xx fails it, is checked at the end.
let client = init({
  subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'server-error-status', scheduledDelayMillis: 50,
  serverErrorStatusCodes: ['500-599'],
});

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};

async function oneSpan(name) {
  await client.flush();
  const found = ingested.filter((e) => e.operation === name);
  assert.strictEqual(found.length, 1, `expected one "${name}" span, got ${found.length}: ${ingested.map((e) => e.operation).join(', ')}`);
  return found[0];
}
const exceptionEvents = (span) => (span.events ?? []).filter((e) => e.name === 'exception');

function callersAnswer(span, code) {
  assert.notStrictEqual(span.status, 'ERROR', `a ${code} is not the server's failure`);
  assert.strictEqual(span.attributes['http.status_code'], code);
  assert.strictEqual(exceptionEvents(span).length, 0, `a ${code} records no exception`);
  assert.strictEqual(span.attributes['error.type'], undefined);
}
function serverFailure(span, code, description) {
  assert.strictEqual(span.status, 'ERROR');
  assert.strictEqual(span.attributes['http.status_code'], code);
  if (description) {
    assert.strictEqual(span.statusMessage, description);
    const events = exceptionEvents(span);
    assert.strictEqual(events.length, 1, 'one exception event');
    assert.strictEqual(`${events[0].attributes['exception.type']}: ${events[0].attributes['exception.message']}`, description);
  }
}

// The errors frameworks answer with, as their packages make them.
class HttpException extends Error {
  constructor(message, status) { super(message); this.name = new.target.name; this.status = status; }
  getStatus() { return this.status; }
  getResponse() { return { statusCode: this.status, message: this.message }; }
}
class NotFoundException extends HttpException { constructor(m = 'Not Found') { super(m, 404); } }
class UnauthorizedException extends HttpException { constructor(m = 'Unauthorized') { super(m, 401); } }
class BadRequestException extends HttpException { constructor(m = 'Bad Request') { super(m, 400); } }
class ServiceUnavailableException extends HttpException { constructor(m = 'Service Unavailable') { super(m, 503); } }
// Hono's HTTPException carries `status` and getResponse(); http-errors (Koa, Express) carries `expose`.
class HTTPException extends Error {
  constructor(status, message) { super(message); this.name = 'HTTPException'; this.status = status; }
  getResponse() { return new Response(this.message, { status: this.status }); }
}
const httpError = (status, message, name) => Object.assign(new Error(message), { name, status, statusCode: status, expose: status < 500 });
const boom = (status, message) => Object.assign(new Error(message), { isBoom: true, output: { statusCode: status, payload: {} } });
class LedgerError extends Error { constructor(m) { super(m); this.name = 'LedgerError'; } }

// Node's http server, answering each request as `handler` does.
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}
function get(server, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function onServer(handler, paths) {
  const server = await listen(handler);
  try {
    for (const path of paths) await get(server, path);
  } finally {
    server.close();
  }
}

const CALLER = [[404, 'not-found'], [401, 'unauthorized'], [400, 'bad-request']];

// ── Node's http server ───────────────────────────────────────────────────────────────────────────────

await check('node-http: a 4xx answer leaves the server span OK, a 5xx fails it', async () => {
  await onServer((req, res) => {
    res.statusCode = Number(req.url.split('/')[2]);
    res.end('answer');
  }, ['/plain/404', '/plain/401', '/plain/400', '/plain/500', '/plain/503', '/plain/200']);
  for (const code of [404, 401, 400]) callersAnswer(await oneSpan(`GET /plain/${code}`), code);
  serverFailure(await oneSpan('GET /plain/500'), 500);
  serverFailure(await oneSpan('GET /plain/503'), 503);
  assert.strictEqual((await oneSpan('GET /plain/200')).status, 'OK');
});

await check('node-http: an outgoing call that gets a 4xx back still failed', async () => {
  const server = await listen((_req, res) => { res.statusCode = 404; res.end('missing'); });
  const url = `http://127.0.0.1:${server.address().port}/remote/missing`;
  // An outgoing call is recorded inside a trace.
  await traceFunction('RatesClient.lookup', () => new Promise((resolve, reject) => {
    const req = http.request(url, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end();
  }))();
  server.close();
  await client.flush();
  const [outgoing] = ingested.filter((e) => e.spanKind === 'CLIENT' && e.attributes?.['http.url'] === url);
  assert.ok(outgoing, 'the outgoing call has its span');
  assert.strictEqual(outgoing.status, 'ERROR');
  assert.strictEqual(outgoing.attributes['http.status_code'], 404);
  callersAnswer(await oneSpan('GET /remote/missing'), 404);
});

// ── Express ──────────────────────────────────────────────────────────────────────────────────────────

const EXPRESS_ERRORS = {
  'not-found': () => httpError(404, 'no such order', 'NotFoundError'),
  unauthorized: () => httpError(401, 'token expired', 'UnauthorizedError'),
  'bad-request': () => httpError(400, 'amount is required', 'BadRequestError'),
  broken: () => new LedgerError('ledger unavailable'),
};
// Express answers an error with its `status`, else 500.
const expressAnswer = (err) => err.status ?? 500;

await check('Express on Node\'s http server: the error handler hands over a 4xx without recording it', async () => {
  const middleware = expressMiddleware();
  const onError = expressErrorHandler();
  await onServer((req, res) => {
    req.originalUrl = req.url;
    middleware(req, res, () => {
      const err = EXPRESS_ERRORS[req.url.split('/')[2]]();
      onError(err, req, res, (passed) => { res.statusCode = expressAnswer(passed); res.end('answered'); });
    });
  }, ['/express/not-found', '/express/unauthorized', '/express/bad-request', '/express/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /express/${kind}`), code);
  serverFailure(await oneSpan('GET /express/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('Express on its own span: the same answers', async () => {
  const middleware = expressMiddleware();
  const onError = expressErrorHandler();
  for (const kind of Object.keys(EXPRESS_ERRORS)) {
    const req = { method: 'GET', url: `/express-own/${kind}`, originalUrl: `/express-own/${kind}`, headers: {} };
    const res = { statusCode: 200, setHeader() {}, getHeaders: () => ({}), write() { return true; }, end() { return this; } };
    middleware(req, res, () => {
      onError(EXPRESS_ERRORS[kind](), req, res, (passed) => { res.statusCode = expressAnswer(passed); res.end('answered'); });
    });
  }
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /express-own/${kind}`), code);
  serverFailure(await oneSpan('GET /express-own/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── Fastify ──────────────────────────────────────────────────────────────────────────────────────────

function fastifyHooks() {
  const hooks = {};
  fastifyPlugin()({ addHook: (name, fn) => { hooks[name] = fn; } }, {}, () => {});
  return hooks;
}
// Fastify's error handler answers an error with its statusCode, else 500.
async function fastifyRequest(hooks, request, err, onAnswer) {
  const reply = { statusCode: 200 };
  await new Promise((done) => hooks.onRequest(request, reply, done));
  if (err) await new Promise((done) => hooks.onError(request, reply, err, done));
  reply.statusCode = err ? err.statusCode ?? 500 : 200;
  onAnswer?.(reply.statusCode);
  await new Promise((done) => hooks.onResponse(request, reply, done));
}
const FASTIFY_ERRORS = {
  'not-found': () => httpError(404, 'Route GET:/x not found', 'NotFoundError'),
  unauthorized: () => httpError(401, 'token expired', 'UnauthorizedError'),
  'bad-request': () => Object.assign(new Error('body must have required property \'amount\''), { statusCode: 400, validation: [] }),
  broken: () => new LedgerError('ledger unavailable'),
};

await check('Fastify on its own span: onError\'s 4xx is not recorded, a 500 is', async () => {
  const hooks = fastifyHooks();
  for (const kind of Object.keys(FASTIFY_ERRORS)) {
    await fastifyRequest(hooks, { method: 'GET', url: `/fastify-own/${kind}`, headers: {}, raw: {}, routeOptions: { url: `/fastify-own/${kind}` } }, FASTIFY_ERRORS[kind]());
  }
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /fastify-own/${kind}`), code);
  serverFailure(await oneSpan('GET /fastify-own/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('Fastify on Node\'s http server: the same answers on the server span', async () => {
  const hooks = fastifyHooks();
  await onServer((req, res) => {
    const kind = req.url.split('/')[2];
    const request = { method: req.method, url: req.url, headers: req.headers, raw: req, routeOptions: { url: `/fastify/${kind}` } };
    fastifyRequest(hooks, request, FASTIFY_ERRORS[kind](), (code) => { res.statusCode = code; res.end('answered'); });
  }, ['/fastify/not-found', '/fastify/unauthorized', '/fastify/bad-request', '/fastify/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /fastify/${kind}`), code);
  serverFailure(await oneSpan('GET /fastify/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── hapi ─────────────────────────────────────────────────────────────────────────────────────────────

const HAPI_RESPONSES = {
  'not-found': () => boom(404, 'Not Found'),
  unauthorized: () => boom(401, 'Missing authentication'),
  'bad-request': () => boom(400, 'Invalid request payload input'),
  // hapi turns a handler's error into a Boom 500 on the error itself.
  broken: () => Object.assign(new LedgerError('ledger unavailable'), { isBoom: true, output: { statusCode: 500, payload: {} } }),
};
function hapiExtensions() {
  const ext = {};
  hapiPlugin().register({ ext: (name, fn) => { ext[name] = fn; } });
  return ext;
}
const H = { continue: Symbol('continue') };

await check('hapi on its own span: a Boom 4xx is not recorded, a Boom 500 is', async () => {
  const ext = hapiExtensions();
  for (const kind of Object.keys(HAPI_RESPONSES)) {
    const request = { method: 'get', path: `/hapi-own/${kind}`, url: { href: `http://x/hapi-own/${kind}` }, headers: {}, route: { method: 'get', path: `/hapi-own/${kind}` }, raw: { req: {} } };
    ext.onRequest(request, H);
    request.response = HAPI_RESPONSES[kind]();
    ext.onPreResponse(request, H);
  }
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /hapi-own/${kind}`), code);
  serverFailure(await oneSpan('GET /hapi-own/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('hapi on Node\'s http server: the same answers on the server span', async () => {
  const ext = hapiExtensions();
  await onServer((req, res) => {
    const kind = req.url.split('/')[2];
    const request = { method: 'get', path: req.url, url: { href: `http://x${req.url}` }, headers: req.headers, route: { method: 'get', path: req.url }, raw: { req, res } };
    ext.onRequest(request, H);
    request.response = HAPI_RESPONSES[kind]();
    ext.onPreResponse(request, H);
    res.statusCode = request.response.output.statusCode;
    res.end('answered');
  }, ['/hapi/not-found', '/hapi/unauthorized', '/hapi/bad-request', '/hapi/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /hapi/${kind}`), code);
  serverFailure(await oneSpan('GET /hapi/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── Hono ─────────────────────────────────────────────────────────────────────────────────────────────

// Hono's compose answers what a handler throws through app.onError and keeps it on c.error: an
// HTTPException with its own response, anything else with a 500.
const HONO_ERRORS = {
  'not-found': () => new HTTPException(404, 'no such order'),
  unauthorized: () => new HTTPException(401, 'token expired'),
  'bad-request': () => new HTTPException(400, 'amount is required'),
  broken: () => new LedgerError('ledger unavailable'),
};
function honoContext(path, incoming) {
  return {
    env: incoming ? { incoming } : {},
    req: { url: `http://x${path}`, method: 'GET', header: () => undefined, raw: { headers: [] }, matchedRoutes: [{ path, method: 'GET' }] },
    res: undefined,
    error: undefined,
  };
}
const honoHandler = (c, kind) => async () => {
  const err = HONO_ERRORS[kind]();
  c.error = err;
  c.res = err instanceof HTTPException ? err.getResponse() : new Response('Internal Server Error', { status: 500 });
};

await check('Hono on its own span: c.error is recorded for a 500 only, and a thrown 4xx records nothing', async () => {
  const hono = honoMiddleware();
  for (const kind of Object.keys(HONO_ERRORS)) {
    const c = honoContext(`/hono-own/${kind}`);
    await hono(c, honoHandler(c, kind));
    await c.res.text();
  }
  // Without app.onError the HTTPException propagates through the middleware.
  const thrown = honoContext('/hono-own/thrown');
  await assert.rejects(hono(thrown, async () => { throw new HTTPException(401, 'token expired'); }), HTTPException);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /hono-own/${kind}`), code);
  callersAnswer(await oneSpan('GET /hono-own/thrown'), 401);
  serverFailure(await oneSpan('GET /hono-own/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('Hono on its own span: a streamed answer reaches the client as it is made and ends the span at its last chunk', async () => {
  const hono = honoMiddleware();
  const c = honoContext('/hono-own/stream');
  let release;
  const held = new Promise((r) => { release = r; });
  const encoder = new TextEncoder();
  await hono(c, async () => {
    c.res = new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('data: one\n\n'));
        await held;
        controller.enqueue(encoder.encode('data: two\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const reader = c.res.body.getReader();
  const first = await reader.read();
  assert.strictEqual(new TextDecoder().decode(first.value), 'data: one\n\n', 'the first event is sent before the stream ends');
  await client.flush();
  assert.strictEqual(ingested.filter((e) => e.operation === 'GET /hono-own/stream').length, 0, 'the span is open while the answer streams');
  release();
  while (!(await reader.read()).done) { /* the rest of the stream */ }
  const span = await oneSpan('GET /hono-own/stream');
  assert.strictEqual(span.status, 'OK');
  assert.strictEqual(span.attributes['http.response.body'], JSON.stringify('data: one\n\ndata: two\n\n'), 'the body as it was sent');
});

await check('Hono on Node\'s http server: the same answers on the server span', async () => {
  const hono = honoMiddleware();
  await onServer(async (req, res) => {
    const kind = req.url.split('/')[2];
    const c = honoContext(req.url, req);
    await hono(c, honoHandler(c, kind));
    res.statusCode = c.res.status;
    res.end(await c.res.text());
  }, ['/hono/not-found', '/hono/unauthorized', '/hono/bad-request', '/hono/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /hono/${kind}`), code);
  serverFailure(await oneSpan('GET /hono/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── Koa ──────────────────────────────────────────────────────────────────────────────────────────────

// Koa answers an error thrown through its middleware with the error's status (ctx.throw(404) makes an
// http-errors error), else 500.
const KOA_ERRORS = {
  'not-found': () => httpError(404, 'Not Found', 'NotFoundError'),
  unauthorized: () => httpError(401, 'Unauthorized', 'UnauthorizedError'),
  'bad-request': () => httpError(400, 'amount is required', 'BadRequestError'),
  broken: () => new LedgerError('ledger unavailable'),
};

await check('Koa on its own span: a thrown 4xx is not recorded, an error without a status is a 500', async () => {
  const koa = koaMiddleware();
  for (const kind of Object.keys(KOA_ERRORS)) {
    const ctx = { method: 'GET', path: `/koa-own/${kind}`, url: `/koa-own/${kind}`, req: {}, request: { headers: {} } };
    await assert.rejects(koa(ctx, async () => { throw KOA_ERRORS[kind](); }));
  }
  // An answer the route set without throwing.
  const set = { method: 'GET', path: '/koa-own/set', url: '/koa-own/set', req: {}, request: { headers: {} } };
  await koa(set, async () => { set.status = 401; set.body = { error: 'token expired' }; });
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /koa-own/${kind}`), code);
  callersAnswer(await oneSpan('GET /koa-own/set'), 401);
  serverFailure(await oneSpan('GET /koa-own/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('Koa on Node\'s http server: the same answers on the server span', async () => {
  const koa = koaMiddleware();
  await onServer(async (req, res) => {
    const kind = req.url.split('/')[2];
    const ctx = { method: 'GET', path: req.url, url: req.url, req, res, request: { headers: req.headers } };
    try {
      await koa(ctx, async () => { throw KOA_ERRORS[kind](); });
    } catch (err) {
      res.statusCode = err.status ?? 500;
      res.end('answered');
    }
  }, ['/koa/not-found', '/koa/unauthorized', '/koa/bad-request', '/koa/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /koa/${kind}`), code);
  serverFailure(await oneSpan('GET /koa/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── NestJS ───────────────────────────────────────────────────────────────────────────────────────────

const NEST_ERRORS = {
  'not-found': () => new NotFoundException('order 7 not found'),
  unauthorized: () => new UnauthorizedException('invalid subscription key'),
  'bad-request': () => new BadRequestException('amount must be a positive number'),
  broken: () => new LedgerError('ledger unavailable'),
};
const failing = (err) => ({ handle: () => ({ subscribe: (o) => { o.error?.(err); return { unsubscribe() {} }; } }) });
const execution = (req, res) => ({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) });
// Nest's exception filter answers an HttpException with its status and anything else with a 500.
const nestAnswer = (err) => (typeof err.getStatus === 'function' ? err.getStatus() : 500);

await check('NestJS interceptor on its own span: an HttpException 4xx is the caller\'s, any other error a 500', async () => {
  const interceptor = new EvalKitInterceptor(client);
  for (const kind of Object.keys(NEST_ERRORS)) {
    const req = { method: 'GET', url: `/nest-own/${kind}`, headers: {}, route: { path: `/nest-own/${kind}` } };
    let seen;
    const err = NEST_ERRORS[kind]();
    interceptor.intercept(execution(req, { statusCode: 200 }), failing(err)).subscribe({ error: (e) => { seen = e; } });
    assert.strictEqual(seen, err, 'the error reaches Nest unchanged');
  }
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /nest-own/${kind}`), code);
  serverFailure(await oneSpan('GET /nest-own/broken'), 500, 'LedgerError: ledger unavailable');
});

await check('NestJS interceptor on Node\'s http server: the same answers on the server span', async () => {
  const interceptor = new EvalKitInterceptor(client);
  await onServer((req, res) => {
    const kind = req.url.split('/')[2];
    const nestRequest = { method: req.method, url: req.url, raw: req, routeOptions: { url: `/nest/${kind}` } };
    interceptor.intercept(execution(nestRequest, res), failing(NEST_ERRORS[kind]())).subscribe({
      error: (e) => { res.statusCode = nestAnswer(e); res.end('answered'); },
    });
  }, ['/nest/not-found', '/nest/unauthorized', '/nest/bad-request', '/nest/broken']);
  for (const [code, kind] of CALLER) callersAnswer(await oneSpan(`GET /nest/${kind}`), code);
  serverFailure(await oneSpan('GET /nest/broken'), 500, 'LedgerError: ledger unavailable');
});

// ── Route names on an adapter's own span ─────────────────────────────────────────────────────────────

await check('Koa, hapi and Hono name their own span by the route their framework matched, a 404 by its path', async () => {
  const koa = koaMiddleware();
  const ctx = { method: 'GET', path: '/named/koa/7', url: '/named/koa/7', req: {}, request: { headers: {} } };
  await koa(ctx, async () => { ctx._matchedRoute = '/named/koa/:id'; ctx.status = 200; ctx.body = 'ok'; });
  const thrown = { method: 'GET', path: '/named/koa-missing/7', url: '/named/koa-missing/7', req: {}, request: { headers: {} } };
  await assert.rejects(koa(thrown, async () => { thrown._matchedRoute = '/named/koa-missing/:id'; throw httpError(404, 'Not Found', 'NotFoundError'); }));

  const ext = hapiExtensions();
  const hapiRequest = { method: 'get', path: '/named/hapi/7', url: { href: 'http://x/named/hapi/7' }, headers: {}, route: { method: 'get', path: '/named/hapi/{id}' }, raw: { req: {} } };
  ext.onRequest(hapiRequest, H);
  hapiRequest.response = { statusCode: 200, source: 'ok' };
  ext.onPreResponse(hapiRequest, H);
  const unmatched = { method: 'get', path: '/named/hapi-nowhere', url: { href: 'http://x/named/hapi-nowhere' }, headers: {}, route: { method: '_special', path: '/{p*}' }, raw: { req: {} } };
  ext.onRequest(unmatched, H);
  unmatched.response = boom(404, 'Not Found');
  ext.onPreResponse(unmatched, H);

  const hono = honoMiddleware();
  const c = honoContext('/named/hono/7');
  c.req.matchedRoutes = [{ path: '/*', method: 'ALL' }, { path: '/named/hono/:id', method: 'GET' }];
  await hono(c, async () => { c.res = new Response('ok'); });
  await c.res.text();

  assert.strictEqual((await oneSpan('GET /named/koa/:id')).attributes['http.route'], '/named/koa/:id');
  callersAnswer(await oneSpan('GET /named/koa-missing/:id'), 404);
  assert.strictEqual((await oneSpan('GET /named/hapi/{id}')).attributes['http.route'], '/named/hapi/{id}');
  callersAnswer(await oneSpan('GET /named/hapi-nowhere'), 404);
  assert.strictEqual((await oneSpan('GET /named/hono/:id')).attributes['http.route'], '/named/hono/:id');
});

// ── Traced functions ─────────────────────────────────────────────────────────────────────────────────

await check('a traced function that raises an HTTP answer with a 4xx ends OK with its status, other errors fail it', async () => {
  const cases = {
    'OrdersService.findOne': [new NotFoundException('order 7 not found'), 404],
    'AuthService.verify': [new UnauthorizedException('token expired'), 401],
    'koa.load': [httpError(403, 'Forbidden', 'ForbiddenError'), 403],
    'hapi.load': [boom(404, 'Not Found'), 404],
    'hono.load': [new HTTPException(429, 'slow down'), 429],
  };
  for (const [name, [err]] of Object.entries(cases)) {
    await assert.rejects(traceFunction(name, async () => { throw err; })(), (e) => e === err, 'the error reaches the caller unchanged');
  }
  for (const [name, [, code]] of Object.entries(cases)) {
    const span = await oneSpan(name);
    assert.strictEqual(span.status, 'OK', name);
    assert.strictEqual(span.attributes['http.response.status_code'], code, name);
    assert.strictEqual(exceptionEvents(span).length, 0, name);
  }

  const unavailable = new ServiceUnavailableException('ledger down');
  assert.throws(() => traceFunction('LedgerService.post', () => { throw unavailable; })(), ServiceUnavailableException);
  serverFailureOfFunction(await oneSpan('LedgerService.post'), 'ServiceUnavailableException: ledger down');
  // An error from an outgoing call carries the status it got back, and is the app's failure.
  const outgoing = Object.assign(new Error('Request failed with status code 404'), { name: 'AxiosError', isAxiosError: true, status: 404, response: { status: 404 } });
  await assert.rejects(traceFunction('RatesClient.fetch', async () => { throw outgoing; })());
  serverFailureOfFunction(await oneSpan('RatesClient.fetch'), 'AxiosError: Request failed with status code 404');
});
function serverFailureOfFunction(span, description) {
  assert.strictEqual(span.status, 'ERROR');
  assert.strictEqual(span.statusMessage, description);
  assert.strictEqual(exceptionEvents(span).length, 1);
  assert.strictEqual(span.attributes['http.response.status_code'], undefined);
}

// ── serverErrorStatusCodes ───────────────────────────────────────────────────────────────────────────

await check('the status rule and its option, unit by unit', async () => {
  const m = await fromSource('server-error-status', `
    export * from './src/core/http-status.ts';
    export { validateOptions } from './src/core/config.ts';
  `);
  m.resetServerErrorStatus();
  assert.strictEqual(m.isServerErrorStatus(500), true);
  assert.strictEqual(m.isServerErrorStatus(599), true);
  assert.strictEqual(m.isServerErrorStatus(404), true, 'by default a 4xx fails the server span');
  assert.strictEqual(m.isServerErrorStatus(400), true);
  assert.strictEqual(m.isServerErrorStatus(399), false);
  assert.strictEqual(m.isServerErrorStatus(undefined), false);
  assert.deepStrictEqual([...m.DEFAULT_SERVER_ERROR_STATUS_CODES], ['400-599']);
  m.configureServerErrorStatus(['500-599']);
  assert.deepStrictEqual([404, 499, 500].map(m.isServerErrorStatus), [false, false, true]);
  m.configureServerErrorStatus([429, '502-504']);
  assert.deepStrictEqual([429, 500, 502, 503, 504, 505].map(m.isServerErrorStatus), [true, false, true, true, true, false]);
  m.configureServerErrorStatus(['oops']);
  assert.strictEqual(m.isServerErrorStatus(404), true, 'an invalid list leaves the 400-599 default');
  m.resetServerErrorStatus();

  assert.strictEqual(m.serverErrorStatusProblem(['500-599', 503, ' 429 ']), undefined);
  for (const bad of ['500-599', [600], ['599-500'], ['5xx'], [null], [42]]) {
    assert.ok(m.serverErrorStatusProblem(bad), `${JSON.stringify(bad)} is refused`);
  }
  assert.deepStrictEqual(m.validateOptions({ subscriptionKey: 'k', serverErrorStatusCodes: ['500-599', 429] }), []);
  assert.strictEqual(m.validateOptions({ subscriptionKey: 'k', serverErrorStatusCodes: [700] }).length, 1);

  assert.strictEqual(m.statusOfError(new NotFoundException()), 404);
  assert.strictEqual(m.statusOfError(boom(401, 'x')), 401);
  assert.strictEqual(m.statusOfError(httpError(400, 'x', 'BadRequestError')), 400);
  assert.strictEqual(m.statusOfError(new Error('x')), undefined);
  assert.strictEqual(m.httpAnswerStatus(new NotFoundException()), 404);
  assert.strictEqual(m.httpAnswerStatus(new HTTPException(401, 'x')), 401);
  assert.strictEqual(m.httpAnswerStatus({ status: 404, isAxiosError: true }), undefined, 'an outgoing call\'s error is no answer');
  assert.strictEqual(m.httpAnswerStatus(Object.assign(new Error('x'), { getStatus: () => { throw new Error('broken'); }, getResponse() {} })), undefined);
});

await check('serverErrorStatusCodes decides which answers fail a server span', async () => {
  await client.flush();
  client = init({
    subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'server-error-status', scheduledDelayMillis: 50,
    serverErrorStatusCodes: [429, '500-502'],
  });
  await onServer((req, res) => {
    res.statusCode = Number(req.url.split('/')[2]);
    res.end('answer');
  }, ['/custom/429', '/custom/404', '/custom/502', '/custom/503']);
  serverFailure(await oneSpan('GET /custom/429'), 429);
  serverFailure(await oneSpan('GET /custom/502'), 502);
  callersAnswer(await oneSpan('GET /custom/404'), 404);
  const outside = await oneSpan('GET /custom/503');
  assert.strictEqual(outside.status, 'OK', 'a code left out of the list is no failure');

  // A traced function's 429 answer fails it too, as it fails the request.
  await assert.rejects(traceFunction('RateLimiter.check', async () => { throw new HTTPException(429, 'slow down'); })());
  assert.strictEqual((await oneSpan('RateLimiter.check')).status, 'ERROR');

  // The next init() without the option is back to the default: every 4xx and 5xx fails the server span.
  await client.flush();
  client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'server-error-status', scheduledDelayMillis: 50 });
  await onServer((req, res) => {
    res.statusCode = Number(req.url.split('/')[2]);
    res.end('answer');
  }, ['/default/404', '/default/401', '/default/200']);
  serverFailure(await oneSpan('GET /default/404'), 404);
  serverFailure(await oneSpan('GET /default/401'), 401);
  assert.strictEqual((await oneSpan('GET /default/200')).status, 'OK');

  // A traced function that raises a 4xx answer fails with its exception, as the request it answers does.
  const missing = new NotFoundException('order 7 not found');
  await assert.rejects(traceFunction('OrdersService.findOne.default', async () => { throw missing; })(), (e) => e === missing);
  const span = await oneSpan('OrdersService.findOne.default');
  assert.strictEqual(span.status, 'ERROR');
  assert.strictEqual(exceptionEvents(span).length, 1, 'the 4xx exception is recorded');
});

await client.flush();
clearTimeout(watchdog);
for (const line of results) console.log(line);
const failed = results.filter((r) => r.startsWith('FAIL'));
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`\nall ${results.length} server error status checks passed`);
process.exit(0);
