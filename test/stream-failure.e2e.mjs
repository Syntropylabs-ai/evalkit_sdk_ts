import assert from 'node:assert';
import {
  init,
  patchOpenAIClient,
  patchAnthropicClient,
  patchBedrockClient,
  patchOllamaClient,
  patchGoogleGenAIModels,
} from '../dist/index.mjs';

const TTFT = 'gen_ai.server.time_to_first_token_ms';
const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'stream-failure-test',
  scheduledDelayMillis: 50,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scripted = (steps) => ({
  async *[Symbol.asyncIterator]() {
    for (const step of steps) {
      await sleep(step.after);
      if (step.throw) throw new Error(step.throw);
      yield step.value;
    }
  },
});

const drain = async (stream, stopAfter = Infinity) => {
  let raised = null;
  let seen = 0;
  try {
    for await (const _chunk of stream) {
      seen += 1;
      if (seen >= stopAfter) break;
    }
  } catch (err) {
    raised = err;
  }
  return { raised, seen };
};

const settle = async (provider) => {
  await client.flush();
  await sleep(200);
  return ingested.find((e) => e.spanType === 'llm_call' && e.provider === provider);
};

try {
  ingested.length = 0;
  const openai = { chat: { completions: { create: async () => scripted([
    { after: 40, value: { choices: [{ delta: { content: 'Par' } }] } },
    { after: 10, value: { choices: [{ delta: { content: 'is' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } } },
    { after: 10, throw: 'socket hang up' },
  ]) } } };
  patchOpenAIClient(openai);

  const openaiRun = await drain(await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'capital of france' }],
    stream: true,
    stream_options: { include_usage: true },
  }));
  const openaiSpan = await settle('openai');

  assert.ok(
    openaiRun.raised,
    'the wrapper swallowed a mid-flight stream failure instead of rethrowing it; a caller that never learns the ' +
      'stream died will treat a truncated answer as a complete one'
  );
  assert.ok(
    openaiSpan,
    'the failed openai stream produced no llm_call span at all, and a span never emitted is indistinguishable from ' +
      'a call that was never made — an outage would read as idle traffic'
  );
  assert.strictEqual(
    openaiSpan.status,
    'ERROR',
    'a stream that died mid-flight must not be recorded as a success'
  );
  assert.strictEqual(
    openaiSpan.completion,
    'Paris',
    'the truncated text is usually the only evidence of where the stream stopped; an ERROR span with no payload ' +
      'cannot be debugged after the fact'
  );
  assert.strictEqual(
    openaiSpan.tokensIn,
    11,
    'openai billed 11 prompt tokens before the socket died; dropping them prices the call at 0, so a provider ' +
      'having a bad hour makes spend look LOWER than a good hour'
  );
  assert.strictEqual(
    openaiSpan.tokensOut,
    2,
    'the 2 completion tokens were already streamed and billed; evalkit.traces is a plain MergeTree with no dedupe ' +
      'and no backfill, so usage dropped here is lost permanently'
  );
  assert.strictEqual(
    openaiSpan.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles, or a provider outage that fails fast reads as a ' +
      'latency improvement'
  );
  ingested.length = 0;
  const anthropic = { messages: { create: async () => scripted([
    { after: 20, value: { type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 40 } } } },
    { after: 20, value: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The ' } } },
    { after: 10, throw: 'overloaded_error' },
  ]) } };
  patchAnthropicClient(anthropic);

  const anthropicRun = await drain(await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'capital of france' }],
    stream: true,
  }));
  const anthropicSpan = await settle('anthropic');

  assert.ok(anthropicRun.raised, 'the anthropic wrapper must rethrow a mid-flight failure to its caller');
  assert.ok(anthropicSpan, 'the failed anthropic stream produced no llm_call span at all');
  assert.strictEqual(anthropicSpan.status, 'ERROR', 'a stream that died mid-flight must not be recorded as a success');
  assert.strictEqual(
    anthropicSpan.completion,
    'The ',
    'anthropic streamed one text delta before dying; that fragment is the only record of what the user actually saw'
  );
  assert.strictEqual(
    anthropicSpan.tokensIn,
    52,
    'anthropic reports input_tokens exclusive of cache and sends them in the very first message_start event, so a ' +
      'stream that dies later must still report 12 uncached + 40 cache-read = 52; orchestrator-2 treats tokensIn as ' +
      'inclusive and subtracts the cache bucket back out, so an under-reported tokensIn undercharges twice'
  );
  assert.strictEqual(
    anthropicSpan.cacheReadTokens,
    40,
    'cache reads are billed at a discount rather than free, so losing the cache bucket on the error path leaves the ' +
      'cost engine no way to reconstruct the split'
  );
  assert.strictEqual(
    anthropicSpan.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles'
  );
  ingested.length = 0;
  class ConverseStreamCommand {
    constructor(input) { this.input = input; }
  }
  const bedrock = { send: async () => ({
    $metadata: {},
    stream: scripted([
      { after: 30, value: { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Par' } } } },
      { after: 10, value: { metadata: { usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22, cacheReadInputTokens: 100 } } } },
      { after: 10, value: { modelStreamErrorException: { message: 'stream terminated by the model' } } },
    ]),
  }) };
  patchBedrockClient(bedrock);

  const converse = await bedrock.send(new ConverseStreamCommand({
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    messages: [{ role: 'user', content: [{ text: 'capital of france' }] }],
  }));
  const bedrockRun = await drain(converse.stream);
  const bedrockSpan = await settle('bedrock');

  assert.strictEqual(
    bedrockRun.raised,
    null,
    'bedrock reports mid-stream failures as an in-band exception EVENT rather than a rejection, so the caller loop ' +
      'ends normally — if this ever starts throwing, the test below is asserting the wrong failure mode'
  );
  assert.ok(bedrockSpan, 'the failed converse_stream produced no llm_call span at all');
  assert.strictEqual(
    bedrockSpan.status,
    'ERROR',
    'the span status is the only place an in-band modelStreamErrorException can surface; recording it as OK means a ' +
      'truncated answer is indistinguishable from a complete one'
  );
  assert.strictEqual(
    bedrockSpan.completion,
    'Par',
    'the accumulated converse text must survive the exception event that ended the stream'
  );
  assert.strictEqual(
    bedrockSpan.tokensIn,
    120,
    'bedrock excludes cache reads from inputTokens, so tokensIn must fold 20 uncached + 100 cache-read; the metadata ' +
      'event had already arrived, so these tokens were billed no matter how the stream ended'
  );
  assert.strictEqual(bedrockSpan.tokensOut, 2, 'the output tokens bedrock already reported must not be dropped');
  assert.strictEqual(
    bedrockSpan.cacheReadTokens,
    100,
    'losing the cache bucket makes the folded tokensIn unsplittable, which prices 100 discounted tokens at full rate'
  );
  assert.strictEqual(
    bedrockSpan.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles'
  );
  ingested.length = 0;
  class FakeOllama {
    async chat(_params) {
      return scripted(this.__script);
    }
  }
  patchOllamaClient(FakeOllama);
  const ollama = new FakeOllama();

  ollama.__script = [
    { after: 30, value: { model: 'llama3.2', message: { content: 'Par' } } },
    { after: 10, value: { model: 'llama3.2', message: { content: 'is' }, prompt_eval_count: 9, eval_count: 2 } },
    { after: 10, throw: 'ollama: connection closed' },
  ];
  const ollamaRun = await drain(await ollama.chat({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'capital of france' }],
    stream: true,
  }));
  const ollamaSpan = await settle('ollama');

  assert.ok(ollamaRun.raised, 'the ollama wrapper must rethrow a mid-flight failure to its caller');
  assert.ok(ollamaSpan, 'the failed ollama stream produced no llm_call span at all');
  assert.strictEqual(ollamaSpan.status, 'ERROR', 'a stream that died mid-flight must not be recorded as a success');
  assert.strictEqual(ollamaSpan.completion, 'Paris', 'the partial content is the only record of what was generated');
  assert.strictEqual(
    ollamaSpan.tokensIn,
    9,
    "ollama's prompt_eval_count had already arrived when the connection dropped; dropping it reports the call as " +
      'zero-token, which deletes it from throughput dashboards instead of flagging it'
  );
  assert.strictEqual(ollamaSpan.tokensOut, 2, 'the eval_count ollama already reported must not be dropped');
  assert.strictEqual(
    ollamaSpan.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles'
  );
  ingested.length = 0;
  ollama.__script = [
    { after: 30, value: { model: 'llama3.2', message: { content: 'Par' } } },
    { after: 300, value: { model: 'llama3.2', message: { content: 'is' }, prompt_eval_count: 9, eval_count: 2 } },
  ];
  const abandonedRun = await drain(await ollama.chat({
    model: 'llama3.2',
    messages: [{ role: 'user', content: 'capital of france' }],
    stream: true,
  }), 1);
  const abandonedSpan = await settle('ollama');

  assert.strictEqual(abandonedRun.raised, null, 'breaking out of a for-await is not an error for the caller');
  assert.ok(
    abandonedSpan,
    'an ollama stream the caller broke out of never ended its span, so the call vanished from the trace entirely — ' +
      'a span never emitted is indistinguishable from a call that was never made'
  );
  assert.strictEqual(
    abandonedSpan.status,
    'OK',
    'a caller that stops reading early made its own choice; billing that to the provider as an ERROR inflates the ' +
      'error rate on a healthy model'
  );
  assert.strictEqual(
    abandonedSpan.completion,
    'Par',
    'only the text the caller actually consumed should be recorded'
  );
  assert.strictEqual(
    typeof abandonedSpan.attributes?.[TTFT],
    'number',
    'an abandoned stream still measured a real first token, so it keeps its TTFT; dropping it here would bias the ' +
      'percentiles toward whichever callers happen to read to the end'
  );
  ingested.length = 0;
  class Models {
    async generateContentStream(_req) {
      return scripted(this.__script);
    }
  }
  patchGoogleGenAIModels(Models.prototype);
  const models = new Models();

  models.__script = [
    { after: 30, value: { candidates: [{ content: { parts: [{ text: 'Par' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, totalTokenCount: 8 } } },
    { after: 10, throw: '500 INTERNAL: internal error' },
  ];
  const genaiRun = await drain(await models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'capital of france' }));
  const genaiSpan = await settle('google-genai');

  assert.ok(genaiRun.raised, 'the google-genai wrapper must rethrow a mid-flight failure to its caller');
  assert.ok(genaiSpan, 'the failed google-genai stream produced no llm_call span at all');
  assert.strictEqual(genaiSpan.status, 'ERROR', 'a stream that died mid-flight must not be recorded as a success');
  assert.strictEqual(
    genaiSpan.completion,
    'Par',
    'the existing streaming-ttft e2e pins status and TTFT for this seam but never checked the partial text, which is ' +
      'exactly how the money half of the contract regressed'
  );
  assert.strictEqual(
    genaiSpan.tokensIn,
    7,
    'gemini had already reported promptTokenCount in the chunk before the failure; those tokens are billed and must ' +
      'not read as 0'
  );
  assert.strictEqual(genaiSpan.tokensOut, 1, 'the candidatesTokenCount gemini already reported must not be dropped');
  assert.strictEqual(
    genaiSpan.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles'
  );
  ingested.length = 0;
  models.__script = [
    { after: 30, value: { candidates: [{ content: { parts: [{ text: 'Par' }] } }] } },
    { after: 300, value: { candidates: [{ content: { parts: [{ text: 'is' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 } } },
  ];
  const genaiAbandonRun = await drain(await models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'capital of france' }), 1);
  const genaiAbandonSpan = await settle('google-genai');

  assert.strictEqual(genaiAbandonRun.raised, null, 'breaking out of a for-await is not an error for the caller');
  assert.ok(genaiAbandonSpan, 'an abandoned google-genai stream produced no llm_call span at all');
  assert.strictEqual(
    genaiAbandonSpan.status,
    'OK',
    'an abandoned google-genai stream shipped with status UNSET, so a perfectly good call counted as neither a ' +
      'success nor a failure and quietly fell out of every rate calculation'
  );
  assert.strictEqual(
    genaiAbandonSpan.completion,
    'Par',
    'only the text the caller actually consumed should be recorded'
  );
  assert.strictEqual(
    typeof genaiAbandonSpan.attributes?.[TTFT],
    'number',
    'an abandoned stream still measured a real first token, so it keeps its TTFT'
  );

  console.log('PASS stream-failure.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
