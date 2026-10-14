import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, isSecretKey, scrubSecrets, traceFunction, traceTool, flush } from '../dist/index.mjs';

// A captured value is masked while it is still whole, before it is cut to 4096 characters; a value that
// arrives cut still has its secret-named members masked; the credential shapes cover PEM keys, Google API
// keys, JSON Web Tokens, URL userinfo and quoted assignments; and an argument is masked by the parameter
// it is bound to. Prices per token are not secrets.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'FAKEPLAINKEY0123456789zyxwvu';
const scrub = (text) => scrubSecrets({ traceId: 't', spanId: 's', spanType: 'log', createdAt: 'now', attributes: { 'function.args': text } }).attributes['function.args'];

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'secrets-cut-test', scheduledDelayMillis: 50 });

try {
  // Cut JSON: the member is still masked, its neighbours kept.
  const cut = `[{"jobId":"j1"},{"judgeModel":"m","apiKey":"${KEY}","credentials":{"api_key":"${KEY}","api_base":"http://h"}},[{"input":"xxxx…`;
  const cutOut = scrub(cut);
  assert.ok(!cutOut.includes(KEY), cutOut);
  assert.ok(cutOut.includes('"apiKey":"***"'));
  assert.ok(cutOut.includes('"judgeModel":"m"'));
  assert.strictEqual(scrub(`{"model":"m","apiKey":"${KEY.slice(0, 9)}…`), '{"model":"m","apiKey":"***', 'a value the cut ran through');
  const nested = scrub(`{"body":"{\\"model\\": \\"m\\", \\"api_key\\": \\"${KEY}\\"}", "rows": [1, 2`);
  assert.ok(!nested.includes(KEY), 'a member of JSON held inside a string');
  assert.ok(nested.includes('\\"model\\": \\"m\\"'));
  assert.ok(!scrub(`{"api_key":"ab\\"${KEY}"`).includes(KEY), 'an escaped quote inside the value does not end it');

  for (const [label, text, secret] of [
    ['a PEM key', '{"pk":"-----BEGIN PRIVATE KEY-----\\nFAKEPEM\\n-----END PRIVATE KEY-----\\n"}', 'FAKEPEM'],
    ['a PEM key cut before its end', '["-----BEGIN RSA PRIVATE KEY-----\\nFAKEPEM', 'FAKEPEM'],
    ['a Google API key', '["AIzaFAKEKEY0123456789abcdefghijklmnopq"]', 'FAKEKEY0123'],
    ['a JSON Web Token', '"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.FAKEJWTSIGNATURE"', 'FAKEJWTSIGNATURE'],
    ['a DSN', 'connecting to mongodb://user:FAKEDSNPASS@db.test/app', 'FAKEDSNPASS'],
    ['a quoted assignment in text', 'retrying with password: "FAKEPASSWORD99"', 'FAKEPASSWORD99'],
    ['a single-quoted assignment', "ClientConfig(api_key='FAKEAPIKEY77', region='eu')", 'FAKEAPIKEY77'],
  ]) {
    assert.ok(!scrub(text).includes(secret), `${label}: ${scrub(text)}`);
  }
  for (const text of [
    '{"maxTokens":"5","model":"gpt-4o-mini","tokensIn":"12"}',
    '{"hasToken":"yes","monkey":"banana"}',
    'write to ada@example.com, see https://example.com/a@b',
    'max_tokens: "5" and tokens="7"',
    '[1,2,3]',
  ]) {
    assert.strictEqual(scrub(text), text, `left as it is: ${text}`);
  }
  const once = scrub(`{"apiKey":"${KEY}","x":"AIzaFAKEKEY0123456789abcdefghijklmnopq","pw":"postgres://u:p@h/db"}`);
  assert.strictEqual(scrub(once), once, 'scrubbing twice changes nothing');

  // Per-token prices are not secrets; tokens still are.
  for (const key of ['input_cost_per_audio_token', 'input_cost_per_character_token', 'output_cost_per_reasoning_token', 'input_cost_per_token', 'cost_per_cached_input_token', 'time_per_output_token', 'gen_ai.server.time_to_first_token']) {
    assert.strictEqual(isSecretKey(key), false, `${key} is a measurement or a price`);
  }
  for (const key of ['access_token', 'refresh_token', 'id_token', 'per_user_token', 'first_token', 'token']) {
    assert.strictEqual(isSecretKey(key), true, `${key} can hold a credential`);
  }

  // Function I/O: masked before the cut, by key, by shape and by parameter name.
  // The secret sits inside the 4096 characters kept, in JSON the cut leaves unparseable.
  const big = traceFunction('report.build', (cfg, rows) => ({ rows: rows.length }));
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, note: 'x'.repeat(20) }));
  big({ region: 'eu', api_key: KEY, dsn: KEY, url: `postgres://app:${KEY}@db/x` }, rows);
  const charge = traceFunction('orders.charge', function charge(card, amount, apiKey) { return { amount }; });
  charge('4242', 10, KEY);
  const withOptions = traceFunction('auth.call', (cfg) => 'ok');
  withOptions({ accessToken: KEY, authToken: KEY, secretKey: KEY, model: 'gpt-4o' });
  const getApiKey = traceFunction('vault.getApiKey', async (name) => KEY);
  await getApiKey('openai');
  const lookup = traceTool('lookup_order', ({ orderId, token }) => ({ orderId }));
  lookup({ orderId: '1001', token: KEY });

  await flush();
  await sleep(200);
  const span = (op) => ingested.find((e) => e.operation === op);
  const reportArgs = span('report.build').attributes['function.args'];
  assert.ok(reportArgs.length > 4000 && reportArgs.endsWith('…'), 'the arguments were long enough to be cut');
  assert.ok(!JSON.stringify(span('report.build')).includes(KEY), 'a secret in cut JSON was masked before the cut');
  assert.ok(reportArgs.startsWith('[{"region":"eu","api_key":"***","dsn":"***","url":"postgres://***@db/x"}'), reportArgs.slice(0, 120));
  assert.strictEqual(span('orders.charge').attributes['function.args'], '["4242",10,"***"]', 'masked by its parameter name');
  const options = JSON.parse(span('auth.call').attributes['function.args'])[0];
  assert.deepStrictEqual(options, { accessToken: '***', authToken: '***', secretKey: '***', model: 'gpt-4o' }, 'an options object is masked by member name');
  const vault = span('vault.getApiKey');
  assert.strictEqual(vault.attributes['function.args'], undefined, 'a function named for a credential records no arguments');
  assert.strictEqual(vault.attributes['function.result'], undefined, 'nor its result');
  assert.deepStrictEqual(JSON.parse(span('lookup_order').attributes['tool.arguments']), { orderId: '1001', token: '***' });

  console.log('PASS secrets-cut.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
