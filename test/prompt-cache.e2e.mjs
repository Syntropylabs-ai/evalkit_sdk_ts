// The prompt cache under a failing or slow API: a failed refresh serves the cached copy (stale-if-error),
// and calls for one prompt that arrive together make one request.
import assert from 'node:assert';
import evalkit from '../dist/index.mjs';

const PAYLOAD = {
  name: 'support_agent_system',
  type: 'chat',
  version: 3,
  labels: ['production'],
  template: [{ role: 'system', content: 'You help {{customer}} on plan {{ plan }}.' }],
  variables: ['customer', 'plan'],
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

let answer = () => ({ status: 200, body: PAYLOAD });
let delayMs = 0;
let gets = 0;
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

globalThis.fetch = async (url, opts = {}) => {
  if ((opts.method ?? 'GET') !== 'GET') return { ok: true, status: 200, text: async () => 'ok' };
  gets++;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const a = answer(String(url));
  if (a.throws) throw a.throws;
  return { ok: a.status < 400, status: a.status, text: async () => JSON.stringify(a.body), json: async () => a.body };
};

evalkit.init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', apiUrl: 'http://api.test/', serviceName: 't' });
const warnings = [];
console.warn = (m) => warnings.push(String(m));
const get = (opts = {}) => evalkit.prompts.get('support_agent_system', opts);
function reset() {
  evalkit.prompts.clearCache();
  answer = () => ({ status: 200, body: PAYLOAD });
  delayMs = 0;
  gets = 0;
  offset = 0;
  warnings.length = 0;
}

// A failed refresh serves the cached copy, then waits 10 s before trying again.
reset();
await get();
offset += 61_000;
answer = () => ({ status: 503, body: { message: 'down' } });
assert.strictEqual((await get()).version, 3);
assert.strictEqual(gets, 2);
assert.ok(warnings.some((w) => w.includes('serving the cached version 3')), warnings.join('\n'));
offset += 5_000;
await get();
assert.strictEqual(gets, 2, 'inside the retry window the cached copy is served without a request');
offset += 6_000;
await get();
assert.strictEqual(gets, 3);

// No answer at all also serves the cached copy; variables are compiled from it locally.
reset();
await get();
offset += 61_000;
answer = () => ({ throws: new TypeError('fetch failed') });
const local = await get({ variables: { customer: 'Ada', plan: 'pro' } });
assert.deepStrictEqual(local.compiled, [{ role: 'system', content: 'You help Ada on plan pro.' }]);

// A refusal is raised even with a cached copy.
reset();
await get();
offset += 61_000;
answer = () => ({ status: 404, body: { message: 'Prompt not found' } });
await assert.rejects(() => get(), /prompt fetch failed 404/);

// Past staleIfErrorMs, or with it at 0, the failure is raised.
reset();
await get({ staleIfErrorMs: 100_000 });
offset += 161_000;
answer = () => ({ status: 503, body: { message: 'down' } });
await assert.rejects(() => get({ staleIfErrorMs: 100_000 }), /prompt fetch failed 503/);
reset();
await get({ staleIfErrorMs: 0 });
offset += 61_000;
answer = () => ({ status: 503, body: { message: 'down' } });
await assert.rejects(() => get({ staleIfErrorMs: 0 }), /prompt fetch failed 503/);

// Calls that arrive together make one request; those with variables compile the fetched template.
reset();
delayMs = 100;
const together = await Promise.all([get(), get(), get(), get({ variables: { customer: 'A', plan: 'p' } }), get({ variables: { customer: 'B', plan: 'p' } })]);
assert.strictEqual(gets, 1);
assert.deepStrictEqual(together.map((p) => p.version), [3, 3, 3, 3, 3]);
assert.deepStrictEqual(together[4].compiled, [{ role: 'system', content: 'You help B on plan p.' }]);

// A failure is every waiting call's answer.
reset();
delayMs = 100;
answer = () => ({ status: 500, body: { message: 'boom' } });
const failed = await Promise.allSettled([get(), get(), get()]);
assert.strictEqual(gets, 1);
assert.ok(failed.every((r) => r.status === 'rejected' && /prompt fetch failed 500/.test(String(r.reason))), JSON.stringify(failed));

// A refusal of one call's variables is not another call's answer: that one fetches on its own.
reset();
delayMs = 100;
answer = (url) => {
  const q = new URL(url).searchParams;
  if (q.get('compile') === 'true' && !('plan' in JSON.parse(q.get('variables')))) return { status: 400, body: { message: 'Missing variables: plan' } };
  return { status: 200, body: PAYLOAD };
};
const [bad, good] = await Promise.allSettled([get({ variables: { customer: 'Ada' } }), get()]);
assert.strictEqual(bad.status, 'rejected');
assert.match(String(bad.reason), /prompt fetch failed 400/);
assert.strictEqual(good.status, 'fulfilled');
assert.strictEqual(good.value.version, 3);
assert.strictEqual(gets, 2);

// cacheTtlMs: 0 still fetches every time.
reset();
await get({ cacheTtlMs: 0 });
await get({ cacheTtlMs: 0 });
assert.strictEqual(gets, 2);

console.log('prompt-cache.e2e OK');
process.exit(0);
