import assert from 'node:assert';

delete process.env.EVALKIT_COUNT_FOREIGN_LLM;

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
  serviceName: 'spellings',
  scheduledDelayMillis: 50,
});

try {
  client.startSpan('hand-instrumented-chat', {
    'evalkit.span_type': 'llm_call',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.request.model': 'claude-sonnet-4-5',
    'gen_ai.usage.prompt_tokens': 500,
    'gen_ai.usage.completion_tokens': 40,
    'gen_ai.usage.cache_read_tokens': 0,
    'gen_ai.usage.cache_read.input_tokens': 400,
  }).end('OK');

  client.startSpan('evaluation', {
    'evalkit.span_type': 'eval_result',
    'evalkit.eval_type': 'offline',
    'evalkit.metric.answer_relevancy': 0.91,
    'evalkit.prompt': 'SECRET-PROMPT',
  }).end('OK');

  client.tracer.startSpan('foreign-chat', {
    attributes: {
      'gen_ai.provider.name': 'openai',
      'gen_ai.usage.prompt_tokens': 900,
      'gen_ai.usage.completion_tokens': 12,
      'gen_ai.usage.cache_read.input_tokens': 700,
    },
  }).end();

  client.startSpan('exclusive-cache-chat', {
    'evalkit.span_type': 'llm_call',
    'gen_ai.system': 'bedrock',
    'gen_ai.usage.input_tokens': 12,
    'gen_ai.usage.cache_read.input_tokens': 40000,
  }).end('OK');

  await client.flush();
  await new Promise((r) => setTimeout(r, 250));

  const byOp = (name) => {
    const e = ingested.find((x) => x.operation === name);
    if (!e) fail(`no ingested span named ${name} (got ${ingested.map((x) => x.operation).join(', ')})`);
    return e;
  };

  const chat = byOp('hand-instrumented-chat');

  assert.strictEqual(
    chat.tokensIn,
    500,
    'tokensIn is undefined for a span that reported its usage under the deprecated gen_ai.usage.prompt_tokens ' +
      'spelling; the envelope then omits tokensIn, the span stores 0 tokens and prices at $0, and no ' +
      'EVALKIT_COUNT_FOREIGN_LLM is involved because the span carries evalkit.span_type and is not foreign at all'
  );
  assert.strictEqual(
    chat.tokensOut,
    40,
    'gen_ai.usage.completion_tokens was ignored the same way, so the output side of the cost is zero too'
  );
  assert.strictEqual(
    chat.provider,
    'anthropic',
    'gen_ai.system is deprecated upstream in favour of gen_ai.provider.name, so a span that names its provider the ' +
      'current way lands with provider NULL and cannot be grouped or filtered by provider'
  );
  assert.strictEqual(
    chat.cacheReadTokens,
    400,
    'the upstream cache-read spelling already worked and must keep working: the dashboard subtracts this bucket ' +
      'out of tokensIn and reprices it, so losing it bills a cached prompt at the full input rate. this span also ' +
      'reports cache_read_tokens: 0 first, so a lookup that accepts a zero lets the earlier spelling shadow the ' +
      'real 400 and hands the whole cached prompt back to the full-price bucket'
  );
  assert.strictEqual(
    chat.attributes['gen_ai.provider.name'],
    undefined,
    'gen_ai.provider.name is now promoted to the typed provider column, so leaving a copy in the attribute bag ' +
      'contradicts the promoted-keys invariant and pays for the same string twice in every stored span'
  );

  const evaluation = byOp('evaluation');

  assert.strictEqual(
    evaluation.attributes['evalkit.metric.answer_relevancy'],
    0.91,
    'evalkit.metric.answer_relevancy was deleted from the attribute bag, and it has no typed column anywhere - ' +
      "orchestrator-2 reads eval scores out of the JSON bag by the literal 'evalkit.metric.' prefix, so every score " +
      "sdk-ts's own evaluate() computes is discarded on export and the 'Built-in eval' line can never render for a " +
      'TypeScript customer'
  );
  assert.strictEqual(
    evaluation.attributes['evalkit.eval_type'],
    'offline',
    'evalkit.eval_type is one of the signals orchestrator-2 uses to recognise a simulation trace, and sdk-py keeps ' +
      'it; stripping it in sdk-ts alone makes the same instrumented app behave differently in the two languages'
  );
  assert.strictEqual(
    evaluation.attributes['evalkit.prompt'],
    undefined,
    'evalkit.prompt must stay out of the attribute bag: it is already promoted to the typed prompt field, and ' +
      'stripContent clears only the typed field plus CONTENT_ATTRIBUTES, so a copy left in the bag would keep ' +
      'shipping user prompts for a customer who set captureContent:false'
  );
  assert.strictEqual(
    evaluation.attributes['evalkit.sdk_version'],
    undefined,
    'keys promoted to typed columns must not also ride in the bag, or every span pays for them twice in the ' +
      'attributes JSON that ClickHouse stores'
  );
  assert.strictEqual(
    typeof evaluation.sdkVersion,
    'string',
    'the promoted key still has to reach its typed column - dropping it from the bag must not drop it from the span'
  );

  const foreign = byOp('foreign-chat');

  assert.strictEqual(
    foreign.tokensIn,
    undefined,
    'an unmarked gen_ai span whose usage is spelled the deprecated way became countable the moment the read side ' +
      'learned that spelling, but isForeignGenAi still did not recognise it, so it bypasses the double-count guard - ' +
      'and evalkit.traces has no dedupe, so the same call is billed twice forever'
  );
  assert.strictEqual(
    foreign.tokensOut,
    undefined,
    'the output side of a deferred foreign span must be withheld with the input side; half-counting it produces a ' +
      'cost that matches neither the real call nor zero'
  );
  assert.strictEqual(
    foreign.cacheReadTokens,
    undefined,
    'the cache buckets are cost inputs like the token counts and have to be deferred with them; leaking a 700-token ' +
      'cache bucket onto a span whose tokensIn was deliberately withheld makes the dashboard compute a negative ' +
      'full-price bucket out of max(0, tokensIn - cacheRead - cacheCreation)'
  );
  assert.strictEqual(
    foreign.spanType,
    'function_call',
    'a deferred foreign LLM span has to be typed function_call, matching sdk-py, so it never joins the ' +
      'llm_call-filtered token and cost rollups with an empty usage'
  );

  const exclusive = byOp('exclusive-cache-chat');

  assert.strictEqual(
    exclusive.tokensIn,
    40012,
    'Bedrock and Anthropic-native report input_tokens EXCLUSIVE of the cache buckets, while the dashboard computes ' +
      'full-price input as max(0, tokensIn - cacheRead - cacheCreation) and therefore treats tokensIn as inclusive; ' +
      'passing an exclusive 12 straight through collapses the full-price bucket to 0 and undercounts the call'
  );
  assert.strictEqual(
    exclusive.cacheReadTokens,
    40000,
    'folding the cache into tokensIn must not consume the bucket: the dashboard still needs it to reprice those ' +
      'tokens at the cache-read rate rather than the full input rate'
  );

  clearTimeout(watchdog);
  console.log('PASS attr-spellings.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
