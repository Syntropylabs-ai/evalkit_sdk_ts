// In a CommonJS app the SDK's OpenTelemetry instrumentations see every later require(), which an ES module
// app never gives them. The ones that record what the SDK records itself, or noise beside it (sockets, DNS,
// web framework middleware), stay off, so the app's span tree is the one it has as an ES module.
const assert = require('node:assert');
const { gunzipSync } = require('node:zlib');

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try {
    const raw = opts.headers['Content-Encoding'] === 'gzip' ? gunzipSync(opts.body) : opts.body;
    for (const e of JSON.parse(Buffer.from(raw).toString()).events) ingested.push(e);
  } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 30000);

const { init, startTrace, withTrace, flush } = require('../dist/index.js');
init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'cjs-same-spans-test', scheduledDelayMillis: 50 });

// Loaded after the instrumentations registered, as a framework that requires its stack while it boots.
setTimeout(async () => {
  try {
    const net = require('net');
    const dns = require('dns');
    const server = net.createServer((s) => s.end('ok'));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const root = startTrace('cjs-root');
    await withTrace(root.ctx, async () => {
      await new Promise((resolve, reject) => {
        const socket = net.connect(server.address().port, '127.0.0.1', () => socket.end());
        socket.resume();
        socket.on('close', resolve).on('error', reject);
      });
      await new Promise((r) => dns.lookup('localhost', r));
    });
    root.end();
    server.close();
    await flush();
    await new Promise((r) => setTimeout(r, 150));
    const ops = ingested.map((e) => e.operation);
    assert.ok(ops.includes('cjs-root'), `the trace was exported: ${ops}`);
    assert.deepStrictEqual(ops.filter((o) => /^(tcp\.|dns\.|net\.)/.test(o)), [], `socket and lookup spans: ${ops}`);
    console.log('PASS cjs-same-spans.e2e.cjs');
    process.exit(0);
  } catch (err) {
    fail(err?.stack ?? String(err));
  }
}, 3000);
