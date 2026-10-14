import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { startMockLlm } from './_mock-llm.mjs';
import { init, patchCohereClient } from '../dist/index.mjs';

// The rules every streamed call follows: the clock starts before the request is sent; a stream that fails
// is an error span that keeps the text that arrived and has no time to first token; a stream that fails
// before it opens is an error span too. Checked on the real OpenAI and Anthropic clients against a local
// stand-in, and on Cohere, whose streamed calls went untraced.

const TTFT = 'gen_ai.server.time_to_first_token_ms';
const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 40000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'stream-rules-test', scheduledDelayMillis: 50 });
await sleep(400);
const mock = await startMockLlm();
const { default: OpenAI } = await import('openai');
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const openai = new OpenAI({ baseURL: `${mock.url}/v1`, apiKey: 'sk-test-000000000000000000', maxRetries: 0 });
const anthropic = new Anthropic({ baseURL: mock.url, apiKey: 'test-anthropic-key', maxRetries: 0 });
const nowhere = new OpenAI({ baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-test-000000000000000000', maxRetries: 0 });
const MESSAGES = [{ role: 'user', content: 'Where is order 1001?' }];

const llmSpan = async () => {
  await client.flush();
  await sleep(150);
  const spans = ingested.filter((e) => e.spanType === 'llm_call');
  assert.strictEqual(spans.length, 1, `expected one llm_call span, got ${spans.length}`);
  ingested.length = 0;
  return spans[0];
};
const read = async (open) => {
  let text = '';
  let raised = null;
  try {
    for await (const chunk of await open()) {
      text += chunk?.choices?.[0]?.delta?.content ?? chunk?.delta?.text ?? (chunk?.type === 'response.output_text.delta' ? chunk.delta : '') ?? '';
    }
  } catch (err) {
    raised = err;
  }
  return { text, raised };
};

const calls = {
  'chat completions': (model) => () => openai.chat.completions.create({ model, messages: MESSAGES, stream: true }),
  'responses': (model) => () => openai.responses.create({ model, input: 'Where is order 1001?', stream: true }),
  'anthropic messages': (model) => () => anthropic.messages.create({ model, max_tokens: 64, messages: MESSAGES, stream: true }),
};

try {
  for (const [label, call] of Object.entries(calls)) {
    ingested.length = 0;
    await read(call('slow'));
    const slow = await llmSpan();
    assert.ok(slow.attributes[TTFT] >= 140, `${label}: the reply's headers came 150 ms after the request, TTFT was ${slow.attributes[TTFT]}`);

    const broken = await read(call('broken'));
    assert.ok(broken.raised, `${label}: the dropped connection reaches the app`);
    const brokenSpan = await llmSpan();
    assert.strictEqual(brokenSpan.status, 'ERROR', `${label}: a stream that failed is an error`);
    assert.ok(brokenSpan.completion && brokenSpan.completion.length > 0, `${label}: the text that arrived is kept`);
    assert.strictEqual(brokenSpan.completion, broken.text, `${label}: exactly the text the app read`);
    assert.strictEqual(brokenSpan.attributes[TTFT], undefined, `${label}: a failed stream has no time to first token`);

    const refused = await read(call('fail'));
    assert.strictEqual(refused.raised?.status, 400, `${label}: the API's error reaches the app as it was raised`);
    const refusedSpan = await llmSpan();
    assert.strictEqual(refusedSpan.status, 'ERROR', `${label}: a stream refused before it opened is an error span`);
  }

  const unreachable = await read(() => nowhere.chat.completions.create({ model: 'gpt-4o-mini', messages: MESSAGES, stream: true }));
  assert.strictEqual(unreachable.raised?.constructor?.name, 'APIConnectionError');
  const unreachableSpan = await llmSpan();
  assert.strictEqual(unreachableSpan.status, 'ERROR', 'a stream whose connection was refused is an error span');

  // Cohere: streamed calls are traced like every other provider's.
  const events = (steps) => ({
    async *[Symbol.asyncIterator]() {
      for (const step of steps) {
        await sleep(step.after ?? 5);
        if (step.throw) throw new Error(step.throw);
        yield step.value;
      }
    },
  });
  class CohereClient {
    async chatStream(req) {
      if (req.model === 'refused') throw Object.assign(new Error('invalid api token'), { statusCode: 401 });
      await sleep(req.model === 'slow' ? 120 : 0);
      return events(req.model === 'broken'
        ? [{ value: { eventType: 'text-generation', text: 'Par' } }, { throw: 'socket hang up' }]
        : [{ value: { eventType: 'text-generation', text: 'Paris' } }, { value: { eventType: 'stream-end', finishReason: 'COMPLETE', response: { meta: { tokens: { inputTokens: 4, outputTokens: 1 } } } } }]);
    }
  }
  patchCohereClient(CohereClient.prototype);
  const cohere = new CohereClient();
  const cohereRead = (model) => read(() => cohere.chatStream({ model, message: 'capital of france' }));

  await cohereRead('slow');
  const cohereSlow = await llmSpan();
  assert.strictEqual(cohereSlow.operation, 'chat_stream');
  assert.strictEqual(cohereSlow.provider, 'cohere');
  assert.strictEqual(cohereSlow.completion, 'Paris');
  assert.ok(cohereSlow.attributes[TTFT] >= 110, `cohere: the clock starts before the request, TTFT was ${cohereSlow.attributes[TTFT]}`);
  assert.strictEqual(cohereSlow.tokensIn, 4);

  const cohereBroken = await cohereRead('broken');
  assert.ok(cohereBroken.raised);
  const cohereBrokenSpan = await llmSpan();
  assert.strictEqual(cohereBrokenSpan.status, 'ERROR');
  assert.strictEqual(cohereBrokenSpan.completion, 'Par');
  assert.strictEqual(cohereBrokenSpan.attributes[TTFT], undefined);

  const cohereRefused = await cohereRead('refused');
  assert.strictEqual(cohereRefused.raised?.statusCode, 401);
  assert.strictEqual((await llmSpan()).status, 'ERROR', 'cohere: a stream refused before it opened is an error span');

  await mock.close();
  console.log('PASS stream-rules.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
