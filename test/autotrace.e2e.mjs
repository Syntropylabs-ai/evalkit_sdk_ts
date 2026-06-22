import http from 'node:http';
import assert from 'node:assert';
import { init } from '../dist/index.mjs';

const KNOWN = new Set(['llm_call', 'tool_call', 'log', 'http_call', 'function_call', 'db_query', 'eval_result']);
const captured = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) captured.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'autotrace-e2e' });

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

const srv = http.createServer((_q, r) => r.end('hi')).listen(0, async () => {
  await new Promise((r) => setTimeout(r, 600));
  const port = srv.address().port;
  await new Promise((r) => http.get(`http://127.0.0.1:${port}/probe`, (res) => { res.resume(); res.on('end', r); }));
  try { await client.provider.forceFlush(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  srv.close();

  const httpSpans = captured.filter((e) => e.spanType === 'http_call');
  try {
    assert(captured.length > 0, 'no spans captured');
    assert(httpSpans.length > 0, `no http_call span (auto-instrumentation not active); got ${captured.map((e) => e.spanType)}`);
    for (const e of captured) {
      assert(e.traceId && e.traceId.length === 32, `bad traceId: ${e.traceId}`);
      assert(e.spanId && e.spanId.length === 16, `bad spanId: ${e.spanId}`);
      assert(KNOWN.has(e.spanType), `unknown spanType: ${e.spanType}`);
    }
  } catch (err) {
    fail(err.message);
  }
  console.log(`PASS: ${httpSpans.length} http_call span(s) auto-instrumented → TraceEnvelope; ${captured.length} envelope(s), all trace-service/ClickHouse-compatible`);
  process.exit(0);
});
