import assert from 'node:assert';
import { fromSource } from './_source.mjs';

// The ignore patterns on their own: what each kind of route, URL and function pattern matches and what it does
// not, the environment variables appended to the options, and invalid patterns, which are skipped with one
// warning each and never throw. The Python SDK decides the same cases the same way.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 60000);
watchdog.unref?.();

const m = await fromSource('ignore-patterns', `
  export * from './src/core/ignore.ts';
`);

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };
const results = [];
const check = (name, fn) => {
  warnings.length = 0;
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};

const routes = (patterns, extra = {}) => m.configureIgnore({ ignoreRoutes: patterns, ...extra });
const yes = (method, path, route) => assert.ok(m.isIgnoredRequest(method, path, route), `${method} ${path} ${route ?? ''} is ignored`);
const no = (method, path, route) => assert.ok(!m.isIgnoredRequest(method, path, route), `${method} ${path} ${route ?? ''} is traced`);

check('an exact path ignores a trailing slash and the query string, and is case-sensitive', () => {
  routes(['/metrics']);
  for (const p of ['/metrics', '/metrics/', '/metrics?format=prom', '/metrics/#x', 'http://svc:9/metrics?x=1', '//metrics']) yes('GET', p);
  for (const p of ['/metrics/extra', '/metricsx', '/Metrics', '/api/metrics', '/', '']) no('GET', p);
});

check('* is one segment, ** any number of segments, a * inside a segment a glob within it', () => {
  routes(['/internal/*', '/static/**', '**/debug', '/files/*.json']);
  for (const p of ['/internal/a', '/internal/a/', '/static', '/static/', '/static/a/b/c.css', '/debug', '/a/b/debug', '/files/a.json', '/files/.json']) yes('GET', p);
  for (const p of ['/internal', '/internal/a/b', '/staticx', '/statics/a', '/debugger', '/files/a.txt', '/files/x/a.json']) no('GET', p);
});

check('/** matches every path, the root included; / matches only the root', () => {
  routes(['/**']);
  for (const p of ['/', '', '/a', '/a/b']) yes('GET', p);
  routes(['/']);
  yes('GET', '/');
  yes('GET', '/?q=1');
  no('GET', '/a');
});

check('a leading method restricts the match to that method, case-insensitively; * is any method', () => {
  routes(['GET /status', 'post /v1/orders/:id', '* /any']);
  yes('GET', '/status');
  yes('get', '/status/');
  no('POST', '/status');
  no('', '/status');
  yes('POST', '/v1/orders/123');
  yes('Post', '/v1/orders/abc?x=1');
  no('GET', '/v1/orders/123');
  no('POST', '/v1/orders');
  no('POST', '/v1/orders/1/items');
  yes('DELETE', '/any');
});

check(':param, {param} and <param> each match one segment', () => {
  routes(['/v1/orders/:id/items', '/users/{user_id}', '/posts/<int:post_id>/edit']);
  yes('GET', '/v1/orders/9/items');
  yes('GET', '/users/abc');
  yes('GET', '/posts/7/edit');
  no('GET', '/v1/orders/items');
  no('GET', '/users/a/b');
  no('GET', '/users');
});

check('a pattern also matches the framework route template when one is known', () => {
  routes(['/users/:id', '/files/{path:path}']);
  yes('GET', '/u/7', '/users/:id');
  no('GET', '/u/7');
  yes('GET', '/files/a/b/c', '/files/{path:path}');
  no('GET', '/files/a/b/c');
});

check('repeated slashes are collapsed', () => {
  routes(['/a/b']);
  yes('GET', '//a///b/');
});

check('a RegExp is tested against the path, with and without its trailing slash, never against the query', () => {
  const global = /^\/admin\//g;
  routes([global, /^\/exact$/, /\?/, /secret/i]);
  yes('GET', '/admin/x');
  yes('GET', '/admin/x', undefined);
  yes('GET', '/admin/y');
  yes('GET', '/exact/');
  yes('GET', '/v1/SECRET');
  no('GET', '/a?b=1');
  no('GET', '/administrator');
  assert.strictEqual(global.lastIndex, 0, 'the app\'s own RegExp is left as it was');
});

check('a function gets the method, the path without the query and the route', () => {
  const seen = [];
  routes([(info) => { seen.push(info); return info.method === 'DELETE' && info.path.startsWith('/tmp'); }]);
  yes('delete', '/tmp/a?x=1', '/tmp/:name');
  no('GET', '/tmp/a');
  assert.deepStrictEqual(seen[0], { method: 'DELETE', path: '/tmp/a', route: '/tmp/:name' });
  assert.deepStrictEqual(seen[1], { method: 'GET', path: '/tmp/a' });
});

check('a function that throws or answers with a promise counts as no match, with one warning each', () => {
  routes([() => { throw new Error('boom'); }, async () => true]);
  no('GET', '/a');
  no('GET', '/b');
  no('GET', '/c');
  assert.strictEqual(warnings.length, 2, warnings.join('\n'));
  assert.ok(warnings[0].includes('ignoreRoutes') && warnings[0].includes('boom'));
  assert.ok(warnings[1].includes('promise'));
});

check('health probes are ignored unless traceHealthChecks is on', () => {
  routes([]);
  for (const p of ['/health', '/healthz', '/readyz', '/actuator/health/liveness']) yes('GET', p);
  no('GET', '/healthcare');
  routes([], { traceHealthChecks: true });
  for (const p of ['/health', '/healthz', '/readyz']) no('GET', p);
  assert.ok(!m.isIgnoredUrl('http://svc/healthz'), 'an outgoing probe is traced too');
  assert.ok(!m.isUntracedProbe('/healthz'));
  routes([]);
  assert.ok(m.isIgnoredUrl('http://svc/healthz'));
  assert.ok(m.isUntracedProbe('/healthz'));
});

const urls = (patterns) => m.configureIgnore({ ignoreUrls: patterns });
const skip = (url, method) => assert.ok(m.isIgnoredUrl(url, method), `${url} is ignored`);
const keep = (url, method) => assert.ok(!m.isIgnoredUrl(url, method), `${url} is traced`);

check('a host alone matches every path on it, case-insensitively, and no other host', () => {
  urls(['api.stripe.com']);
  skip('https://api.stripe.com/v1/charges');
  skip('https://API.Stripe.com');
  skip('http://user:pw@api.stripe.com:8443/x?y=1');
  keep('https://api.stripe.com.evil.io/v1');
  keep('https://x.api.stripe.com/v1');
  keep('https://stripe.com/');
});

check('host labels: * is one label, ** any number', () => {
  urls(['*.internal.example.com', '**.corp.example.net']);
  skip('http://a.internal.example.com/x');
  keep('http://a.b.internal.example.com/x');
  keep('http://internal.example.com/x');
  skip('http://corp.example.net');
  skip('http://a.b.corp.example.net/y');
});

check('a full URL pattern: scheme, host, path glob; query ignored', () => {
  urls(['https://api.example.com/v1/**']);
  skip('https://api.example.com/v1');
  skip('https://api.example.com/v1/a/b?c=d');
  keep('http://api.example.com/v1/a');
  keep('https://api.example.com/v2/a');
  keep('https://api.example.com/');
});

check('a port must match the effective port; no port matches any', () => {
  urls(['localhost:8080', 'example.com:443', 'any-port.test']);
  skip('http://localhost:8080/x');
  keep('http://localhost:9090/x');
  keep('http://localhost/x');
  skip('https://example.com/');
  keep('http://example.com/');
  skip('http://any-port.test:1234/');
});

check('a path-only pattern matches on any host; a RegExp is tested against the whole URL', () => {
  urls(['/v1/ingest', /169\.254\./, '*://*/static/**']);
  skip('http://anything:1/v1/ingest?x=1');
  keep('http://anything/v1/ingest/more');
  skip('http://169.254.169.254/latest/meta-data');
  skip('ws://cdn/static/app.js');
  keep('ws://cdn/app.js');
});

check('a URL function gets the method, URL, host and path', () => {
  const seen = [];
  urls([(info) => { seen.push(info); return info.host.endsWith('.local'); }]);
  skip('http://printer.local:631/jobs?x=1', 'post');
  keep('http://printer.example/jobs');
  assert.deepStrictEqual(seen[0], { method: 'POST', url: 'http://printer.local:631/jobs?x=1', host: 'printer.local', path: '/jobs' });
});

const fns = (patterns) => m.configureIgnore({ ignoreFunctions: patterns });
const fnYes = (name) => assert.ok(m.isIgnoredFunction(name), `${name} is ignored`);
const fnNo = (name) => assert.ok(!m.isIgnoredFunction(name), `${name} is traced`);

check('function names: * is one component, ** any number, * inside a component a glob', () => {
  fns(['myapp.cache.*', 'myapp.jobs.**', 'OrdersService.find*', '**.slugify']);
  fnYes('myapp.cache.get');
  fnNo('myapp.cache.Client.get');
  fnNo('myapp.cachex.get');
  fnNo('myapp.cache');
  fnYes('myapp.jobs');
  fnYes('myapp.jobs.nightly.run');
  fnYes('OrdersService.findAll');
  fnNo('OrdersService.create');
  fnYes('slugify');
  fnYes('myapp.utils.slugify');
  fnNo('myapp.utils.slugify_all');
});

check('a function-name RegExp and function', () => {
  fns([/^Health/, (name) => name.endsWith('.ping')]);
  fnYes('HealthController.check');
  fnYes('db.ping');
  fnNo('OrdersController.list');
});

check('environment variables are appended to the options, comma-separated and trimmed', () => {
  process.env.EVALKIT_IGNORE_ROUTES = ' /env-a , ,/env-b/* ';
  process.env.EVALKIT_IGNORE_URLS = 'env.example.com';
  process.env.EVALKIT_IGNORE_FUNCTIONS = 'env.fn';
  try {
    m.configureIgnore({ ignoreRoutes: ['/code'] });
    yes('GET', '/code');
    yes('GET', '/env-a');
    yes('GET', '/env-b/x');
    no('GET', '/env-c');
    skip('https://env.example.com/x');
    fnYes('env.fn');
    assert.strictEqual(warnings.length, 0, warnings.join('\n'));
  } finally {
    delete process.env.EVALKIT_IGNORE_ROUTES;
    delete process.env.EVALKIT_IGNORE_URLS;
    delete process.env.EVALKIT_IGNORE_FUNCTIONS;
  }
});

check('an invalid pattern is skipped with one warning naming the option, and the valid ones still apply', () => {
  process.env.EVALKIT_IGNORE_ROUTES = 'no-slash';
  try {
    m.configureIgnore({
      ignoreRoutes: ['', 'metrics', 'G3T /x', 'GET /a b', 42, null, {}, '/ok'],
      ignoreUrls: ['http://', 'host:abc', 'host:99999', 'a..b', 'ht tp://x', 'http:///x', 'good.example'],
      ignoreFunctions: ['a..b', '', 'a b', 'good.fn'],
    });
  } finally {
    delete process.env.EVALKIT_IGNORE_ROUTES;
  }
  assert.strictEqual(warnings.length, 8 + 6 + 3, warnings.join('\n'));
  assert.strictEqual(warnings.filter((w) => w.includes('ignoreRoutes:')).length, 7);
  assert.strictEqual(warnings.filter((w) => w.includes('EVALKIT_IGNORE_ROUTES:')).length, 1);
  assert.strictEqual(warnings.filter((w) => w.includes('ignoreUrls:')).length, 6);
  assert.strictEqual(warnings.filter((w) => w.includes('ignoreFunctions:')).length, 3);
  yes('GET', '/ok');
  skip('https://good.example/x');
  fnYes('good.fn');
});

check('an option that is not a list warns once; a single pattern counts as a list of one', () => {
  m.configureIgnore({ ignoreRoutes: 42, ignoreUrls: 'single.example', ignoreFunctions: /^one$/ });
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  skip('http://single.example/');
  fnYes('one');
  m.configureIgnore(undefined);
  no('GET', '/anything');
});

console.warn = realWarn;
m.resetIgnore();
for (const line of results) console.log(line);
clearTimeout(watchdog);
if (results.some((line) => line.startsWith('FAIL'))) fail(`${results.filter((l) => l.startsWith('FAIL')).length} check(s) failed`);
console.log('PASS ignore-patterns.e2e.mjs');
