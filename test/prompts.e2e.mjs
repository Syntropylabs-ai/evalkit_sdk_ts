import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import evalkit, { Prompt, withPrompt, compileTemplate, variablesOf } from '../dist/index.mjs';

const PAYLOAD = {
  name: 'support_agent_system',
  type: 'chat',
  version: 3,
  semver: '0.3.0',
  labels: ['production'],
  template: [{ role: 'system', content: 'You help {{customer}} on plan {{ plan }}.' }],
  variables: ['customer', 'plan'],
  config: { model: 'gpt-4o-mini', temperature: 0.2 },
};

const gets = [];
const captured = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if ((opts.method ?? 'GET') === 'GET') {
    gets.push({ url: u, headers: opts.headers });
    const q = new URL(u).searchParams;
    const body = { ...PAYLOAD };
    if (q.get('compile') === 'true') {
      const vars = JSON.parse(q.get('variables'));
      body.compiled = [{ role: 'system', content: `SERVER ${vars.customer}/${vars.plan}` }];
    }
    return { ok: true, status: 200, text: async () => '', json: async () => body };
  }
  try { for (const e of ingestBody(opts).events) captured.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const client = evalkit.init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', apiUrl: 'http://api.test/', serviceName: 't' });

const prompt = await evalkit.prompts.get('support_agent_system', { label: 'production' });
assert.ok(prompt instanceof Prompt);
assert.strictEqual(gets[0].url, 'http://api.test/v1/prompts/support_agent_system?label=production');
assert.strictEqual(gets[0].headers['X-Subscription-Key'], 'tk_test');
assert.strictEqual(prompt.version, 3);
assert.strictEqual(prompt.semver, '0.3.0');
assert.deepStrictEqual(prompt.variables, ['customer', 'plan']);
assert.deepStrictEqual(prompt.hyperparameters(), { promptName: 'support_agent_system', promptVersion: 3 });

await evalkit.prompts.get('support_agent_system', { label: 'production' });
assert.strictEqual(gets.length, 1, 'second read within the TTL must hit the cache');
await evalkit.prompts.get('support_agent_system', { version: 3 });
assert.strictEqual(gets.length, 1, 'a read by the resolved version is served from the same cache entry');

evalkit.prompts.clearCache();
await evalkit.prompts.get('support_agent_system', { label: 'production', cacheTtlMs: 0 });
await evalkit.prompts.get('support_agent_system', { label: 'production', cacheTtlMs: 0 });
assert.strictEqual(gets.length, 3, 'cacheTtlMs: 0 disables the cache');

assert.deepStrictEqual(prompt.compile({ customer: 'Ada', plan: 'pro' }), [{ role: 'system', content: 'You help Ada on plan pro.' }]);
assert.throws(() => prompt.compile({ customer: 'Ada' }), /missing prompt variables: plan$/);
assert.strictEqual(compileTemplate('n={{n}} ok={{ok}} obj={{obj}}', { n: 3, ok: true, obj: { a: 1 } }), 'n=3 ok=true obj={"a":1}');
assert.deepStrictEqual(variablesOf('{{a}} and {{ b }} and {{a}}'), ['a', 'b']);

const compiled = await evalkit.prompts.get('support_agent_system', { variables: { customer: 'Ada', plan: 'pro' }, cacheTtlMs: 0 });
assert.deepStrictEqual(compiled.compile(), [{ role: 'system', content: 'SERVER Ada/pro' }]);

await assert.rejects(() => evalkit.prompts.get('x', { label: 'a', version: 1 }), /either label or version/);

const inside = withPrompt(prompt, () => {
  const llm = client.startSpan('llm', { 'evalkit.span_type': 'llm_call', 'gen_ai.request.model': 'gpt-4o-mini' });
  llm.end('OK');
  const helper = client.startSpan('helper', { 'evalkit.span_type': 'function_call' });
  helper.end('OK');
  const explicit = client.startSpan('explicit', { 'evalkit.span_type': 'llm_call', 'prompt.ref': 'other@1' });
  explicit.end('OK');
  return evalkit.prompts.current();
});
assert.deepStrictEqual(inside, { name: 'support_agent_system', version: 3 });
assert.strictEqual(evalkit.prompts.current(), undefined);

const outside = client.startSpan('later', { 'evalkit.span_type': 'llm_call' });
outside.end('OK');

const active = client.startSpan('manual', { 'evalkit.span_type': 'llm_call' });
const { context: otelContext } = await import('@opentelemetry/api');
const stamped = otelContext.with(active.ctx, () => prompt.stamp());
assert.strictEqual(stamped, true);
active.end('OK');

await client.provider.forceFlush();
await new Promise((r) => setTimeout(r, 200));

const byName = (n) => captured.find((e) => e.operation === n);
assert.strictEqual(byName('llm').attributes['prompt.ref'], 'support_agent_system@3');
assert.strictEqual(byName('llm').attributes['prompt.name'], 'support_agent_system');
assert.strictEqual(byName('llm').attributes['prompt.version'], 3);
assert.strictEqual(byName('helper').attributes['prompt.ref'], undefined, 'non-LLM spans are not stamped');
assert.strictEqual(byName('explicit').attributes['prompt.ref'], 'other@1', 'explicit attributes win');
assert.strictEqual(byName('later').attributes['prompt.ref'], undefined, 'outside withPrompt nothing is stamped');
assert.strictEqual(byName('manual').attributes['prompt.ref'], 'support_agent_system@3', 'stamp() marks the active span');

console.log('prompts.e2e OK');
process.exit(0);
