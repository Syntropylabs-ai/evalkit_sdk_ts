import assert from 'node:assert';
import http from 'node:http';
import { ingestBody } from './_ingest.mjs';
import {
  init, expressMiddleware, fastifyPlugin, koaMiddleware, honoMiddleware, hapiPlugin, createNestjsInterceptor,
  startTrace, withTrace, flush,
} from '../dist/index.mjs';

// Health and readiness probes are not recorded: not by init()'s http server instrumentation, not by a
// framework adapter (Express, Fastify, Koa, Hono, hapi, the NestJS interceptor) whether or not the request
// has a server span, and not as an outgoing call. A probe is told by whole path segment, the Python SDK's
// rule, so /healthcare and /api/health-records are the app's own routes and are recorded. A probe still gets
// its answer through every adapter.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'health-probes-test', scheduledDelayMillis: 50 });

const PROBES = [
  '/health', '/healthz', '/health/', '/health/live', '/health/ready', '/readyz', '/livez', '/startupz',
  '/actuator/health', '/actuator/health/liveness', '/v1/healthcheck?verbose=1', '/HEALTHZ', '/health-check',
  '/health_check', '/health?probe=k8s', '/api/v2/health', '/services/billing/healthz',
];
const APP_PATHS = [
  '/healthcare', '/api/health-records', '/healthcare/claims', '/patients/7/health/records',
  '/v1/orders?next=/health', '/wealth', '/health/records',
  '/datasets/6650a1b2c3d4e5f601234567/health', '/datasets/:datasetId/health', '/users/42/healthz',
  '/runs/0b6f6a52-6d0e-4b0c-9a51-3f1f3d4b2a10/health/ready',
];

const H = { continue: Symbol('continue') };
const pathOf = (url) => url.split('?')[0];

// Each adapter driven the way its framework calls it: `before` runs as the request arrives, `after` once the
// response was sent.
function adapters() {
  const express = expressMiddleware();
  const fastify = {};
  fastifyPlugin()({ addHook: (name, fn) => { fastify[name] = fn; } }, {}, () => {});
  const koa = koaMiddleware();
  const hono = honoMiddleware();
  const hapi = {};
  hapiPlugin().register({ ext: (name, fn) => { hapi[name] = fn; } });
  const nest = createNestjsInterceptor();
  return {
    express: {
      before: (req, res) => new Promise((resolve) => express(req, res, resolve)),
    },
    fastify: {
      async before(req, _res, state) {
        state.request = { raw: req.socket ? req : undefined, method: 'GET', url: req.url, headers: req.headers, routeOptions: { url: pathOf(req.url) } };
        await new Promise((r) => fastify.onRequest(state.request, {}, r));
        await new Promise((r) => fastify.preHandler(state.request, {}, r));
      },
      after: (_req, _res, state) => new Promise((r) => fastify.onResponse(state.request, { statusCode: 200 }, r)),
    },
    koa: {
      async before(req) {
        const ctx = { req: req.socket ? req : undefined, method: 'GET', path: pathOf(req.url), url: req.url, href: `http://x${req.url}`, request: { headers: req.headers } };
        await koa(ctx, async () => { ctx.status = 200; ctx.body = 'ok'; });
      },
    },
    hono: {
      async before(req) {
        const c = {
          env: req.socket ? { incoming: req } : undefined,
          res: { status: 200 },
          req: { url: `http://x${req.url}`, method: 'GET', header: () => undefined, raw: { headers: [] } },
        };
        await hono(c, async () => {});
      },
    },
    hapi: {
      before(req, _res, state) {
        state.request = { raw: req.socket ? { req } : undefined, method: 'get', path: pathOf(req.url), url: new URL(`http://x${req.url}`), headers: req.headers, route: { path: pathOf(req.url), method: 'get' }, response: { statusCode: 200 } };
        assert.strictEqual(hapi.onRequest(state.request, H), H.continue);
      },
      after(_req, _res, state) {
        assert.strictEqual(hapi.onPreResponse(state.request, H), H.continue);
      },
    },
    nest: {
      before(req, res) {
        const handled = { subscribe(o) { queueMicrotask(() => o.complete?.()); return { unsubscribe() {} }; }, pipe() { return this; } };
        const out = nest.intercept({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) }, { handle: () => handled });
        return new Promise((resolve) => out.subscribe({ next() {}, error: resolve, complete: resolve }));
      },
    },
  };
}

const recordedUnder = (prefix) => [...new Set(
  ingested
    .filter((e) => e.spanKind === 'SERVER' && String(e.attributes?.['http.url'] ?? '').includes(prefix))
    .map((e) => String(e.attributes['http.url']).slice(String(e.attributes['http.url']).indexOf(prefix) + prefix.length - 1)),
)].sort();

try {
  // On Node's http server, with each adapter registered.
  const onServer = adapters();
  const server = http.createServer(async (req, res) => {
    const name = req.url.split('/')[1];
    const adapter = onServer[name];
    const state = {};
    await adapter.before(req, res, state);
    res.end('ok');
    await adapter.after?.(req, res, state);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject).end();
  });

  for (const name of Object.keys(onServer)) {
    for (const path of [...PROBES, ...APP_PATHS]) {
      const answer = await get(`/${name}${path}`);
      assert.deepStrictEqual(answer, { status: 200, body: 'ok' }, `${name} ${path}: the app answers as without the SDK`);
    }
  }

  // Outgoing calls inside a trace: a probe is not a client span, the app's own call is.
  const outer = startTrace('outgoing-probes');
  await withTrace(outer.ctx, async () => {
    for (const path of ['/express/healthz', '/express/health/ready', '/express/healthcare']) await get(path);
  });
  outer.end();

  await flush();
  await sleep(200);
  const appSet = [...new Set(APP_PATHS)].sort();
  for (const name of Object.keys(onServer)) {
    assert.deepStrictEqual(recordedUnder(`/${name}/`), appSet, `${name} on Node's http server: only the app's own paths are recorded`);
  }
  const clientUrls = ingested.filter((e) => e.spanKind === 'CLIENT').map((e) => new URL(e.attributes['http.url']).pathname);
  assert.deepStrictEqual(clientUrls, ['/express/healthcare'], 'an outgoing probe is not recorded, the app\'s own call is');
  server.close();

  // Each adapter on its own, as on a runtime without Node's http server: it opens the request's span itself,
  // and not for a probe.
  ingested.length = 0;
  const alone = adapters();
  for (const name of Object.keys(alone)) {
    for (const path of [...PROBES, ...APP_PATHS]) {
      const url = `/solo-${name}${path}`;
      const req = { url, originalUrl: url, method: 'GET', headers: {} };
      const res = { statusCode: 200, setHeader() {}, getHeaders: () => ({}), write: () => true, end() {} };
      const state = {};
      await alone[name].before(req, res, state);
      res.end('ok');
      await alone[name].after?.(req, res, state);
    }
  }
  await flush();
  await sleep(200);
  for (const name of Object.keys(alone)) {
    assert.deepStrictEqual(recordedUnder(`/solo-${name}/`), appSet, `${name} on its own: only the app's own paths are recorded`);
  }

  console.log('PASS health-probes.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
