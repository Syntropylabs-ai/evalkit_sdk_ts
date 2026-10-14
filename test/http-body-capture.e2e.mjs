import assert from 'node:assert';
import http from 'node:http';
import { Writable } from 'node:stream';
import { ingestBody } from './_ingest.mjs';
import { init, startTrace, withTrace, flush } from '../dist/index.mjs';

// The SDK records an incoming request's body without reading it: the app's framework reads it as it would
// without the SDK, however it reads it and however late. Each reader below is the pattern of a framework:
// a 'data' reader attached after an async step (Express or Koa middleware before the body parser, a
// Fastify onRequest hook), a pipe (hapi's payload), 'readable' with read(), and an async iterator. The
// response and outgoing requests behave as they do without the SDK.

const ingested = [];
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/v1/ingest')) {
    try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
    return { ok: true, status: 200, text: async () => 'ok' };
  }
  return realFetch(url, opts);
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'http-body-capture-test', scheduledDelayMillis: 50 });

const readAll = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  req.on('error', reject);
});

const READERS = {
  // Express's json(), Koa's bodyparser and Fastify's parser attach 'data' when they run, after the async step.
  async 'data after an async step'(req) { await sleep(30); return readAll(req); },
  // hapi pipes the request into its payload reader.
  async 'pipe'(req) {
    const chunks = [];
    await new Promise((resolve, reject) => {
      req.pipe(new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } })).on('finish', resolve).on('error', reject);
    });
    return Buffer.concat(chunks).toString();
  },
  async "'readable' and read()"(req) {
    await sleep(30);
    return new Promise((resolve) => {
      const chunks = [];
      req.on('readable', () => { let c; while ((c = req.read()) !== null) chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
  },
  async 'async iterator'(req) {
    await sleep(30);
    let body = '';
    for await (const c of req) body += c;
    return body;
  },
  async 'nothing reads it'() { return null; },
};

const server = http.createServer(async (req, res) => {
  const reader = READERS[decodeURIComponent(req.url.slice(1))];
  try {
    const body = await reader(req);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ got: body === null ? null : JSON.parse(body) }));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const post = (path, body) => new Promise((resolve, reject) => {
  // Without the SDK in this request's way: the body is written in two parts, the second a moment later.
  const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    let data = '';
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, data }));
  });
  req.on('error', reject);
  const text = JSON.stringify(body);
  req.write(text.slice(0, 10));
  setTimeout(() => req.end(text.slice(10)), 5);
});

try {
  const BODY = { order: '1001', note: 'hello' };
  for (const name of Object.keys(READERS)) {
    const res = await post(`/${encodeURIComponent(name)}`, BODY);
    assert.strictEqual(res.status, 200, `${name}: ${res.data}`);
    const expected = name === 'nothing reads it' ? null : BODY;
    assert.deepStrictEqual(JSON.parse(res.data).got, expected, `${name}: the app read the whole body`);
  }
  await flush();
  await sleep(200);
  for (const name of Object.keys(READERS)) {
    const span = ingested.find((e) => e.spanKind === 'SERVER' && e.attributes['http.url'] === `/${encodeURIComponent(name)}`);
    assert.ok(span, `${name}: a server span`);
    if (name === 'nothing reads it') {
      assert.strictEqual(span.attributes['http.request.body'], undefined, 'a body nothing read is not recorded');
    } else {
      assert.deepStrictEqual(JSON.parse(span.attributes['http.request.body']), BODY, `${name}: the body is still recorded`);
    }
  }

  // The response: write()'s return value, 'drain' and end(callback) are the app's.
  const big = Buffer.alloc(4 * 1024 * 1024, 'x');
  const writeServer = http.createServer((req, res) => {
    const accepted = res.write(big);
    res.on('drain', () => {
      res.end('done', () => { endCallback = true; });
    });
    writeResult = accepted;
  });
  let writeResult;
  let endCallback = false;
  await new Promise((r) => writeServer.listen(0, '127.0.0.1', r));
  const got = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: writeServer.address().port, path: '/' }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; });
      res.on('end', () => resolve(n));
    }).on('error', reject);
  });
  assert.strictEqual(writeResult, false, 'write() still reports a full buffer, so the app waits for drain');
  assert.strictEqual(got, big.length + 4, 'the whole response arrived');
  await sleep(50);
  assert.strictEqual(endCallback, true, "end()'s callback still runs");
  writeServer.close();

  // Outgoing: an ignored response is still discarded, so its socket is freed for the next request.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const root = startTrace('outgoing');
  await withTrace(root.ctx, async () => {
    const ignored = http.request({ host: '127.0.0.1', port, path: `/${encodeURIComponent('nothing reads it')}`, method: 'POST', agent });
    ignored.end('{}');
    const second = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: `/${encodeURIComponent('nothing reads it')}`, method: 'POST', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end('{}');
    });
    assert.strictEqual(second, 200, 'the second request got the socket the ignored response left');

    // An error with no handler of the app's still reaches the process, as it does without the SDK.
    const uncaught = new Promise((resolve) => process.once('uncaughtException', resolve));
    http.request({ host: '127.0.0.1', port: 1, path: '/', method: 'GET' }).end();
    const err = await uncaught;
    assert.strictEqual(err.code, 'ECONNREFUSED', 'the request error was not swallowed');
  });
  root.end();
  agent.destroy();

  // fetch() with a Request keeps the Request's own headers.
  const seen = [];
  const headerServer = http.createServer((req, res) => { seen.push(req.headers); res.end('ok'); });
  await new Promise((r) => headerServer.listen(0, '127.0.0.1', r));
  const fetchRoot = startTrace('fetch-request');
  await withTrace(fetchRoot.ctx, async () => {
    const request = new Request(`http://127.0.0.1:${headerServer.address().port}/`, { method: 'POST', headers: { authorization: 'Bearer abc', 'x-app': 'mine' }, body: 'hi' });
    const res = await globalThis.fetch(request);
    assert.strictEqual(await res.text(), 'ok');
  });
  fetchRoot.end();
  assert.strictEqual(seen[0].authorization, 'Bearer abc', "a Request's headers reach the server");
  assert.strictEqual(seen[0]['x-app'], 'mine');
  headerServer.close();

  server.close();
  console.log('PASS http-body-capture.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
