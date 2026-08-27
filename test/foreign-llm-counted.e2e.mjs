import assert from 'node:assert';

process.env.EVALKIT_COUNT_FOREIGN_LLM = '1';

const { init } = await import('../dist/index.mjs');

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 15000);
watchdog.unref?.();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'foreign-counted',
  scheduledDelayMillis: 50,
});

try {
  client.tracer.startSpan('foreign-chat', {
    attributes: {
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-4o',
      'gen_ai.usage.prompt_tokens': 900,
      'gen_ai.usage.completion_tokens': 12,
    },
  }).end();

  client.tracer.startSpan('non-finite-usage', {
    attributes: {
      'gen_ai.system': 'openai',
      'gen_ai.usage.input_tokens': Infinity,
      'gen_ai.usage.prompt_tokens': 7,
    },
  }).end();

  await client.flush();
  await new Promise((r) => setTimeout(r, 250));

  const byOp = (name) => {
    const e = ingested.find((x) => x.operation === name);
    if (!e) fail(`no ingested span named ${name} (got ${ingested.map((x) => x.operation).join(', ')})`);
    return e;
  };

  const foreign = byOp('foreign-chat');

  assert.strictEqual(
    foreign.spanType,
    'llm_call',
    'with EVALKIT_COUNT_FOREIGN_LLM set, a third-party gen_ai span is counted, but sdk-ts inferSpanType had no ' +
      "gen_ai branch at all and typed it 'log' while sdk-py types the identical span 'llm_call'; the daily usage " +
      "MV and the trace rollups both filter on span_type = 'llm_call', so those tokens are stored and never counted"
  );
  assert.strictEqual(
    foreign.tokensIn,
    900,
    'the whole point of the flag is that these tokens count; a counted span with no tokens is worse than a ' +
      'deferred one because it dilutes every per-call average it joins'
  );
  assert.strictEqual(
    foreign.provider,
    'openai',
    'a counted foreign span still needs its provider promoted, or it groups under NULL on every provider breakdown'
  );

  const nonFinite = byOp('non-finite-usage');

  assert.strictEqual(
    nonFinite.tokensIn,
    7,
    'Math.round(Infinity) is Infinity and is truthy, so an unguarded lookup promotes it to tokensIn where ' +
      'JSON.stringify writes it as null - trace-service2 decodes TokensIn as a Go int and rejects null for the ' +
      'whole batch, so one poisoned attribute loses every span batched with it'
  );

  clearTimeout(watchdog);
  console.log('PASS foreign-llm-counted.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
