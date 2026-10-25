import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, createNestjsInterceptor, flush, startSpan } from '../dist/index.mjs';

// Nest hands an interceptor's answer to rxjs, which takes an Observable or an interop observable and fails
// the request with a 500 for any other object, even one with subscribe(). The interceptor answers with an
// Observable of the route handler's own class, or an interop observable, records the request, and answers a
// health probe with the handler's own values, run untraced. The Observable below follows rxjs where it matters
// here.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Observable {
  constructor(subscribe) { if (subscribe) this._subscribe = subscribe; }
  subscribe(observer) {
    const subscriber = { next: (v) => observer.next?.(v), error: (e) => observer.error?.(e), complete: () => observer.complete?.() };
    const teardown = this._subscribe?.(subscriber);
    return teardown && typeof teardown.unsubscribe === 'function' ? teardown : { unsubscribe() {} };
  }
  pipe(...operators) { return operators.reduce((input, op) => op(input), this); }
}
// A subclass whose constructor takes no subscribe function, as rxjs's Subject.
class Replaying extends Observable {
  constructor(values) { super(); this.values = values; }
  subscribe(observer) { for (const v of this.values) observer.next?.(v); observer.complete?.(); return { unsubscribe() {} }; }
}
const OBSERVABLE = Symbol.observable ?? '@@observable';
// rxjs's innerFrom, the check Nest's mergeAll() puts an interceptor's answer through.
function innerFrom(input) {
  if (input instanceof Observable) return input;
  if (typeof input?.[OBSERVABLE] === 'function') return new Observable((s) => input[OBSERVABLE]().subscribe(s));
  throw new TypeError('You provided an invalid object where a stream was expected.');
}
const collect = (observable) => new Promise((resolve) => {
  const values = [];
  innerFrom(observable).subscribe({ next: (v) => values.push(v), error: (error) => resolve({ values, error }), complete: () => resolve({ values }) });
});

init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'nest-interceptor-test', scheduledDelayMillis: 50 });
const interceptor = createNestjsInterceptor();
const request = (url, route, statusCode = 200) => {
  const req = { method: 'GET', url, originalUrl: url, route: { path: route }, headers: {} };
  const res = { statusCode, setHeader() {}, write: () => true, end() {} };
  return { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
};

try {
  const cases = [
    ['an rxjs Observable', '/orders/7', '/orders/:id', () => new Observable((s) => { s.next({ id: 7 }); s.complete(); })],
    ['a subclass that takes no subscribe function', '/carts/3', '/carts/:id', () => new Replaying([{ id: 3 }])],
    ['a plain object with subscribe()', '/users/9', '/users/:id', () => ({ subscribe: (o) => { o.next?.({ id: 9 }); o.complete?.(); return { unsubscribe() {} }; } })],
  ];
  for (const [label, url, route, handle] of cases) {
    const out = interceptor.intercept(request(url, route), { handle });
    const { values, error } = await collect(out);
    assert.strictEqual(error, undefined, `${label}: rxjs takes the interceptor's answer`);
    assert.deepStrictEqual(values, [{ id: Number(url.split('/')[2]) }], `${label}: the handler's value reaches Nest`);
  }

  const boom = new Error('order not found');
  const failed = await collect(interceptor.intercept(request('/orders/404', '/orders/:id', 404), { handle: () => new Observable((s) => s.error(boom)) }));
  assert.strictEqual(failed.error, boom, 'the handler\'s error reaches Nest as raised');

  const broken = new Observable((s) => { s.next('as given'); s.complete(); });
  const throwing = { switchToHttp() { throw new Error('no http context'); } };
  assert.strictEqual(interceptor.intercept(throwing, { handle: () => broken }), broken, 'an error inside the interceptor passes the handler\'s answer through');

  const probe = new Observable((s) => { startSpan('probe.inner').end(); s.next('ok'); s.complete(); });
  const answered = interceptor.intercept(request('/health/live', '/health/live'), { handle: () => probe });
  assert.ok(answered instanceof Observable, 'a health probe is answered with an Observable of the handler\'s class');
  assert.deepStrictEqual(await collect(answered), { values: ['ok'] }, 'a health probe gets the handler\'s answer');

  await flush();
  await sleep(200);
  const spans = ingested.filter((e) => e.spanKind === 'SERVER').map((e) => `${e.attributes['http.url']} ${e.operation} ${e.status}`).sort();
  assert.deepStrictEqual(spans, [
    '/carts/3 GET /carts/:id OK',
    '/orders/404 GET /orders/:id ERROR',
    '/orders/7 GET /orders/:id OK',
    '/users/9 GET /users/:id OK',
  ], 'one span per request, named by its route, ended once with its outcome');
  assert.ok(!ingested.some((e) => String(e.attributes?.['http.url']).includes('/health')), 'the probe was not recorded');
  assert.ok(!ingested.some((e) => e.operation === 'probe.inner'), 'nor anything its handler did');

  console.log('PASS nest-interceptor.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
