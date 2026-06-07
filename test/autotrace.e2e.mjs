// Real end-to-end test for NestJS auto-trace (enableNestjsAutoTrace).
// Spins up a local HTTP server that captures the spans the SDK actually exports
// (POST /v1/ingest), runs traced class methods, and asserts the real envelopes.
//
//   node test/autotrace.e2e.mjs
//
// Exits non-zero on any failed assertion.

import http from 'node:http';
import evalkit from '../dist/index.mjs';

const captured = [];
let assertions = 0;
let failures = 0;

function check(cond, msg) {
  assertions++;
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

// 1) Local ingest server — captures the exact envelopes the SDK sends.
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body);
      for (const ev of parsed.events ?? []) captured.push(ev);
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', accepted: (JSON.parse(body || '{}').events ?? []).length }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

// 2) Init the SDK pointed at the local server.
evalkit.init({
  subscriptionKey: 'tk_test',
  baseUrl: `http://127.0.0.1:${port}`,
  serviceName: 'autotrace-e2e',
  environment: 'test',
  scheduledDelayMillis: 100,
});

// 3) Real app classes (no mocks).
class OrderService {
  place(order) { return { placed: order }; }
  async cancel(id) { return `cancelled:${id}`; }
  total(items) { return this.sum(items); }   // calls another traced method -> nesting
  sum(items) { return items.reduce((a, b) => a + b, 0); }
}
class BillingController {
  charge() { throw new Error('card declined'); }
}
class Toolbox {               // must NOT be traced (name matches no app-layer suffix)
  helper() { return 1; }
}

const orders = new OrderService();
const billing = new BillingController();
const other = new Toolbox();

// 4) Discovery-like registry (what NestJS DiscoveryService returns).
const discovery = {
  getProviders: () => [{ instance: orders }, { instance: other }],
  getControllers: () => [{ instance: billing }],
};

const wrapped = evalkit.enableNestjsAutoTrace(discovery);
check(wrapped >= 5, `wrapped methods returned a count (${wrapped})`);

// 5) Exercise the methods — behaviour must be preserved.
check(JSON.stringify(orders.place('o-1')) === JSON.stringify({ placed: 'o-1' }), 'place() returns correct value after wrapping');
check((await orders.cancel('o-2')) === 'cancelled:o-2', 'async cancel() returns correct value');
check(orders.total([1, 2, 3, 4]) === 10, 'total() returns correct value');
check(other.helper() === 1, 'Toolbox.helper() still works');
let threw = false;
try { billing.charge(); } catch (e) { threw = e.message === 'card declined'; }
check(threw, 'charge() still throws the original error');

// 6) Flush and let the export round-trip complete.
await evalkit.flush();
await new Promise((r) => setTimeout(r, 300));
await new Promise((resolve) => server.close(resolve));

// 7) Assert on the REAL exported spans.
const fnSpans = captured.filter((e) => e.spanType === 'function_call');
const byOp = (op) => fnSpans.find((e) => e.operation === op);

check(!!byOp('OrderService.place'), 'span emitted: OrderService.place');
check(!!byOp('OrderService.cancel'), 'span emitted: OrderService.cancel (async)');
check(!!byOp('OrderService.total'), 'span emitted: OrderService.total');
check(!!byOp('OrderService.sum'), 'span emitted: OrderService.sum');
check(!!byOp('BillingController.charge'), 'span emitted: BillingController.charge');
check(!byOp('Toolbox.helper'), 'Toolbox.helper NOT traced (class-name filter works)');

const place = byOp('OrderService.place');
check(place && place.attributes && 'function.args' in place.attributes, 'place span captured function.args');
check(place && place.attributes && 'function.result' in place.attributes, 'place span captured function.result');

const charge = byOp('BillingController.charge');
check(charge && charge.status === 'ERROR', 'charge span has ERROR status');

// nesting: sum() called inside total() -> sum.parent === total.span
const total = byOp('OrderService.total');
const sum = byOp('OrderService.sum');
check(total && sum && sum.parentSpanId === total.spanId, 'sum span nests under total span (real parent/child)');
check(total && sum && total.traceId === sum.traceId, 'total and sum share one trace');

console.log(`\n${assertions - failures}/${assertions} checks passed`);
process.exit(failures === 0 ? 0 : 1);
