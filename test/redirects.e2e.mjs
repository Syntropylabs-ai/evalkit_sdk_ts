// A call that carries the key follows a redirect only within its own origin: the key never reaches a server a
// redirect names elsewhere, and the refusal reads like any other.
import assert from 'node:assert';
import http from 'node:http';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import evalkit, { EvalKitClient } from '../dist/index.mjs';
import { main } from '../dist/cli/index.js';

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 30000);
watchdog.unref?.();

const KEY = 'tk_live_dummy_redirect_test';

function serve(answer) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, key: req.headers['x-subscription-key'], authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      const [status, headers, body] = answer(req);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body === undefined ? '' : JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

const PAYLOAD = { name: 'p', version: 2, template: 'hi {{who}}', variables: ['who'] };
const elsewhere = await serve(() => [200, {}, PAYLOAD]);
let status = 302;
const redirecting = await serve((req) => {
  if (req.url.startsWith('/moved')) return [200, {}, PAYLOAD];
  const same = req.url.startsWith('/v1/prompts/same');
  return [status, { Location: same ? `/moved${req.url}` : `${elsewhere.url}/elsewhere${req.url}` }];
});
const forgetSeen = () => { elsewhere.seen.length = 0; redirecting.seen.length = 0; };

const client = evalkit.init({ subscriptionKey: KEY, baseUrl: redirecting.url, apiUrl: redirecting.url, serviceName: 'redirects' });

// The prompt read: refused elsewhere, with the reason in the error; followed on the same origin.
for (const s of [301, 302, 303, 307, 308]) {
  status = s;
  forgetSeen();
  evalkit.prompts.clearCache();
  await assert.rejects(() => evalkit.prompts.get('p', { cacheTtlMs: 0 }), (err) => {
    assert.match(String(err), new RegExp(`prompt fetch failed ${s}: .*refused a redirect to http://127\\.0\\.0\\.1:`));
    return true;
  });
  assert.deepStrictEqual(elsewhere.seen, [], `HTTP ${s}: the key went elsewhere`);
}
status = 301;
forgetSeen();
const followed = await evalkit.prompts.get('same', { cacheTtlMs: 0 });
assert.strictEqual(followed.version, 2);
assert.deepStrictEqual(redirecting.seen.map((r) => [r.path.split('?')[0], r.key]), [['/v1/prompts/same', KEY], ['/moved/v1/prompts/same', KEY]]);
assert.deepStrictEqual(elsewhere.seen, []);

// feedback() posts with a 307/308 the body would follow: refused.
for (const s of [307, 308]) {
  status = s;
  forgetSeen();
  await assert.rejects(() => evalkit.feedback({ traceId: 't1', kind: 'thumbs', value: true }), /refused a redirect/);
  assert.deepStrictEqual(elsewhere.seen, []);
}

// The span exporter does not post the batch where a redirect points.
status = 307;
forgetSeen();
const host = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())] });
const exporting = new EvalKitClient({ subscriptionKey: KEY, baseUrl: redirecting.url, serviceName: 'redirects', scheduledDelayMillis: 60000, tracerProvider: host });
const realWarn = console.warn;
const realError = console.error;
console.warn = () => {};
console.error = () => {};
exporting.tracer.startSpan('s', { attributes: { 'evalkit.span_type': 'function_call' } }).end();
const ok = await exporting.flush();
console.warn = realWarn;
console.error = realError;
assert.strictEqual(ok, false);
assert.ok(redirecting.seen.some((s) => s.path === '/v1/ingest' && s.key === KEY));
assert.deepStrictEqual(elsewhere.seen, []);

// The coding-agent CLI's OTLP sender (doctor posts a synthetic turn) keeps its bearer key.
status = 307;
forgetSeen();
const out = [];
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const home = mkdtempSync(join(tmpdir(), 'evalkit-redirect-'));
const io = { out: (l) => out.push(l), err: (l) => out.push(l), home, cwd: home, binary: 'evalkit' };
assert.strictEqual(await main(['coding', 'install', '--vendor', 'codex', '--key', KEY, '--endpoint', redirecting.url], io), 0, out.join('\n'));
assert.strictEqual(await main(['coding', 'doctor'], io), 1, out.join('\n'));
rmSync(home, { recursive: true, force: true });
assert.ok(redirecting.seen.some((s) => s.authorization === `Bearer ${KEY}`), JSON.stringify(redirecting.seen));
assert.deepStrictEqual(elsewhere.seen, [], out.join('\n'));

void client;
redirecting.server.close();
elsewhere.server.close();
console.log('redirects.e2e OK');
process.exit(0);
