import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ingestBody } from './_ingest.mjs';
import { init, fastifyPlugin, koaMiddleware, honoMiddleware, hapiPlugin, flush } from '../dist/index.mjs';

// On Node's http server every request already has its server span. The Fastify, Koa, Hono and hapi adapters
// name that span by the route their framework matched, and keep their `name` option, instead of recording
// the request a second time. An https server gets its server span too.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'adapter-single-span-test', scheduledDelayMillis: 50 });

// Each adapter driven the way its framework calls it.
const fastifyHooks = {};
fastifyPlugin()({ addHook: (name, fn) => { fastifyHooks[name] = fn; } }, {}, () => {});
const fastifyNamed = {};
fastifyPlugin({ name: 'checkout' })({ addHook: (name, fn) => { fastifyNamed[name] = fn; } }, {}, () => {});
const hapiExt = {};
hapiPlugin().register({ ext: (name, fn) => { hapiExt[name] = fn; } });
const koa = koaMiddleware();
const hono = honoMiddleware();
const H = { continue: Symbol('continue') };

const ADAPTERS = {
  async fastify(req, hooks = fastifyHooks) {
    const request = { raw: req, method: 'POST', url: req.url, headers: req.headers, routeOptions: { url: '/fastify/orders/:id' } };
    await new Promise((r) => hooks.onRequest(request, {}, r));
    await new Promise((r) => hooks.onResponse(request, { statusCode: 200 }, r));
  },
  async 'fastify-named'(req) { return ADAPTERS.fastify(req, fastifyNamed); },
  async koa(req) {
    const ctx = { req, method: 'POST', path: req.url, href: req.url, request: { headers: req.headers } };
    await koa(ctx, async () => { ctx._matchedRoute = '/koa/orders/:id'; });
  },
  async hono(req) {
    const c = { env: { incoming: req }, res: { status: 200 }, req: { url: `http://x${req.url}`, method: 'POST', header: () => undefined, raw: { headers: [] }, matchedRoutes: [{ path: '/*', method: 'ALL' }, { path: '/hono/orders/:id', method: 'POST' }] } };
    await hono(c, async () => {});
  },
  async hapi(req) {
    const request = { raw: { req }, method: 'post', path: req.url, headers: req.headers, route: { path: '/hapi/orders/{id}', method: 'post' }, response: { statusCode: 200 } };
    assert.strictEqual(hapiExt.onRequest(request, H), H.continue);
    assert.strictEqual(hapiExt.onPreResponse(request, H), H.continue);
  },
};

const server = http.createServer(async (req, res) => {
  const adapter = req.url.split('/')[1];
  await ADAPTERS[adapter](req);
  res.end('ok');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const post = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); });
  req.on('error', reject);
  req.end();
});

try {
  for (const name of Object.keys(ADAPTERS)) await post(`/${name}/orders/1001`);

  let tlsDir;
  try {
    tlsDir = mkdtempSync(join(tmpdir(), 'evalkit-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(tlsDir, 'k'), '-out', join(tlsDir, 'c'), '-subj', '/CN=localhost', '-days', '1'], { stdio: 'ignore' });
  } catch {
    tlsDir = undefined;
  }
  if (tlsDir) {
    const secure = https.createServer({ key: readFileSync(join(tlsDir, 'k')), cert: readFileSync(join(tlsDir, 'c')) }, (_req, res) => res.end('ok'));
    await new Promise((r) => secure.listen(0, '127.0.0.1', r));
    await new Promise((resolve, reject) => {
      https.request({ host: '127.0.0.1', port: secure.address().port, path: '/secure', method: 'GET', rejectUnauthorized: false }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject).end();
    });
    secure.close();
  }

  await flush();
  await new Promise((r) => setTimeout(r, 150));
  const servers = ingested.filter((e) => e.spanKind === 'SERVER');
  const named = (prefix) => servers.filter((e) => String(e.attributes['http.url']).startsWith(prefix)).map((e) => e.operation);
  assert.deepStrictEqual(named('/fastify/'), ['POST /fastify/orders/:id'], 'fastify: one server span, by route');
  assert.deepStrictEqual(named('/fastify-named/'), ['checkout'], 'fastify: the name option names it');
  assert.deepStrictEqual(named('/koa/'), ['POST /koa/orders/:id'], 'koa: one server span, by route');
  assert.deepStrictEqual(named('/hono/'), ['POST /hono/orders/:id'], 'hono: one server span, by route');
  assert.deepStrictEqual(named('/hapi/'), ['POST /hapi/orders/{id}'], 'hapi: one server span, by route');
  if (tlsDir) assert.deepStrictEqual(named('/secure'), ['GET /secure'], 'an https server gets its server span');
  else console.log('adapter-single-span: no openssl here, the https case was not run');
  server.close();
  console.log('PASS adapter-single-span.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
