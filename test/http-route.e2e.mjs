// HTTP span names: a server span is named by the framework's route template, a client span by its
// method. Named by the raw path, every order id and charge id was an operation of its own, one row
// each in the Services table. Express is emulated the way it leaves its match on the request
// (`req.baseUrl` + `req.route.path`); a Fastify request goes through the NestJS interceptor.
import http from 'node:http';
import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, EvalKitInterceptor } from '../dist/index.mjs';

const captured = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) captured.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'http-route-e2e' });
const interceptor = new EvalKitInterceptor(client);

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

let port = 0;

function post(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST' }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end('{}');
  });
}

// Nest on Fastify hands the interceptor Fastify's request, which keeps the Node request as `raw`.
function asNestOnFastify(req, res, route, handle) {
  const fastifyRequest = { method: req.method, url: req.url, raw: req, routeOptions: { url: route } };
  const executionContext = { switchToHttp: () => ({ getRequest: () => fastifyRequest, getResponse: () => res }) };
  const next = { handle: () => ({ subscribe: (o) => { handle(); o.next?.('ok'); o.complete?.(); return { unsubscribe() {} }; } }) };
  interceptor.intercept(executionContext, next).subscribe({});
}

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/orders/')) {
    req.baseUrl = '/api';
    req.route = { path: '/orders/:id' };
    post('/charges/ch_demo_4821/refunds').then(() => res.end('{"ok":true}'), () => res.end('{"ok":false}'));
    return;
  }
  if (req.url.startsWith('/charges/')) {
    asNestOnFastify(req, res, '/charges/:chargeId/refunds', () => res.end('{"refunded":true}'));
    return;
  }
  res.statusCode = 404;
  res.end('no route');
}).listen(0, async () => {
  port = srv.address().port;
  await new Promise((r) => setTimeout(r, 600));
  for (const path of ['/api/orders/4429', '/nowhere/77']) {
    await new Promise((r) => http.get(`http://127.0.0.1:${port}${path}`, (res) => { res.resume(); res.on('end', r); }));
  }
  try { await client.provider.forceFlush(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  srv.close();

  const http_ = captured.filter((e) => e.spanType === 'http_call');
  const url = (e) => String(e.attributes?.['http.url'] ?? '');
  const servers = (suffix) => http_.filter((e) => e.spanKind === 'SERVER' && url(e).endsWith(suffix));
  try {
    const order = servers('/api/orders/4429');
    assert.strictEqual(order.length, 1, `one server span for the order request; got ${JSON.stringify(order.map((e) => e.operation))}`);
    assert.strictEqual(order[0].operation, 'GET /api/orders/:id', 'the server span is named by the Express route, mount path included');
    assert.strictEqual(order[0].attributes['http.route'], '/api/orders/:id');

    const outbound = http_.filter((e) => e.spanKind === 'CLIENT' && url(e).includes('/charges/ch_demo_4821/refunds'));
    assert.strictEqual(outbound.length, 1, `one client span for the refund call; got ${outbound.length}`);
    assert.strictEqual(outbound[0].operation, 'POST', 'a client span with no known URL template is named by its method alone');
    assert.strictEqual(outbound[0].traceId, order[0].traceId);

    const charge = http_.filter((e) => url(e).endsWith('/charges/ch_demo_4821/refunds') && e.spanKind === 'SERVER');
    assert.strictEqual(charge.length, 1, 'the downstream request has one server span: the NestJS interceptor names it and opens none of its own');
    for (const span of charge) {
      assert.strictEqual(span.operation, 'POST /charges/:chargeId/refunds', `${span.operation}: the Fastify route reaches the server span the http instrumentation opened`);
    }

    const unmatched = servers('/nowhere/77');
    assert.strictEqual(unmatched.length, 1);
    assert.strictEqual(unmatched[0].operation, 'GET /nowhere/77', 'with no route matched the raw path is all there is');
    assert.strictEqual(unmatched[0].attributes['http.route'], undefined);
  } catch (err) {
    fail(`${err.message}\n${JSON.stringify(http_.map((e) => [e.spanKind, e.operation, url(e)]), null, 1)}`);
  }
  console.log('PASS: server spans are named by the route template, client spans by the method');
  process.exit(0);
});
