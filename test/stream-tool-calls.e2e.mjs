import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { startMockLlm } from './_mock-llm.mjs';
import {
  init,
  patchBedrockClient,
  patchCohereClient,
  patchGoogleAIModel,
  patchOllamaClient,
  patchVertexGenerativeModel,
} from '../dist/index.mjs';

// Streamed replies record the tool calls they asked for exactly as whole replies do: one gen_ai.tool.call
// event per call, with its name, id and assembled arguments. The real OpenAI and Anthropic clients run
// against a local stand-in; the providers that are not installed here run against fakes of their shapes.

const TTFT = 'gen_ai.server.time_to_first_token_ms';
const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 40000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'stream-tool-calls-test', scheduledDelayMillis: 50 });
await sleep(400);

const mock = await startMockLlm();
// The SDK patches the copy of each library its own module format loads: the ESM build here.
const { default: OpenAI } = await import('openai');
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const openai = new OpenAI({ baseURL: `${mock.url}/v1`, apiKey: 'sk-test-000000000000000000', maxRetries: 0 });
const anthropic = new Anthropic({ baseURL: mock.url, apiKey: 'test-anthropic-key', maxRetries: 0 });
const MESSAGES = [{ role: 'user', content: 'Where is order 1001?' }];

const llmSpan = async (operation) => {
  await client.flush();
  await sleep(150);
  const spans = ingested.filter((e) => e.spanType === 'llm_call' && (!operation || e.operation === operation));
  assert.strictEqual(spans.length, 1, `expected one ${operation ?? 'llm_call'} span, got ${spans.length}`);
  ingested.length = 0;
  return spans[0];
};
const toolCalls = (span) => (span.events ?? [])
  .filter((e) => e.name === 'gen_ai.tool.call')
  .map((e) => ({ name: e.attributes['gen_ai.tool.name'], id: e.attributes['gen_ai.tool.call.id'], args: JSON.parse(e.attributes['gen_ai.tool.call.arguments']) }));
const drain = async (stream) => { const seen = []; for await (const c of stream) seen.push(c); return seen; };
const scripted = (steps) => ({
  async *[Symbol.asyncIterator]() {
    for (const step of steps) {
      await sleep(step.after ?? 5);
      if (step.throw) throw new Error(step.throw);
      yield step.value;
    }
  },
});

try {
  // OpenAI chat completions: fragments by index, two calls, no text.
  ingested.length = 0;
  await drain(await openai.chat.completions.create({ model: 'tools', messages: MESSAGES, stream: true, stream_options: { include_usage: true } }));
  const chatStream = await llmSpan('chat.completions.create');
  assert.deepStrictEqual(toolCalls(chatStream), [
    { name: 'lookup_order', id: 'call_1', args: { order_id: '1001' } },
    { name: 'refund', id: 'call_2', args: { amount: 5 } },
  ], 'a streamed OpenAI reply must record the calls it assembled from the deltas');
  assert.strictEqual(chatStream.attributes[TTFT], undefined, 'a reply made only of tool calls has no time to first token');
  assert.deepStrictEqual(chatStream.attributes['gen_ai.response.finish_reasons'], ['tool_calls']);
  assert.strictEqual(chatStream.tokensIn, 11);
  assert.strictEqual(chatStream.attributes['gen_ai.response.id'], 'chatcmpl-mock');

  await openai.chat.completions.create({ model: 'tools', messages: MESSAGES });
  const chatWhole = await llmSpan('chat.completions.create');
  const [wholeEvent] = (chatWhole.events ?? []).filter((e) => e.name === 'gen_ai.tool.call');
  const [streamEvent] = (chatStream.events ?? []).filter((e) => e.name === 'gen_ai.tool.call');
  assert.deepStrictEqual(Object.keys(streamEvent.attributes).sort(), Object.keys(wholeEvent.attributes).sort(),
    'streamed and whole replies must record their tool calls with the same attributes');

  // Text streams keep their time to first token.
  await drain(await openai.chat.completions.create({ model: 'text', messages: MESSAGES, stream: true }));
  const chatText = await llmSpan('chat.completions.create');
  assert.strictEqual(chatText.completion, 'Order 1001 shipped.');
  assert.strictEqual(typeof chatText.attributes[TTFT], 'number');

  // Anthropic: content_block_start tool_use plus input_json_delta.
  await drain(await anthropic.messages.create({ model: 'tools', max_tokens: 64, messages: MESSAGES, stream: true }));
  const anthropicStream = await llmSpan('messages.create');
  assert.deepStrictEqual(toolCalls(anthropicStream), [{ name: 'lookup_order', id: 'toolu_1', args: { order_id: '1001' } }]);
  assert.strictEqual(anthropicStream.attributes[TTFT], undefined, 'input_json_delta is not generated text');
  assert.deepStrictEqual(anthropicStream.attributes['gen_ai.response.finish_reasons'], ['tool_use']);
  assert.strictEqual(anthropicStream.attributes['gen_ai.response.id'], 'msg_mock');

  // The Anthropic stream helper reads the same stream.
  const helper = anthropic.messages.stream({ model: 'tools', max_tokens: 64, messages: MESSAGES });
  const final = await helper.finalMessage();
  assert.strictEqual(final.content[0].name, 'lookup_order', 'MessageStream still assembles its own message');
  const anthropicHelper = await llmSpan('messages.create');
  assert.deepStrictEqual(toolCalls(anthropicHelper).map((c) => c.name), ['lookup_order']);

  // OpenAI Responses API, whole and streamed.
  const whole = await openai.responses.create({ model: 'text', input: 'Where is order 1001?', instructions: 'Be brief.' });
  assert.strictEqual(whole.output_text, 'Order 1001 shipped.', 'the SDK still adds output_text');
  const responsesWhole = await llmSpan('responses.create');
  assert.strictEqual(responsesWhole.completion, 'Order 1001 shipped.');
  assert.strictEqual(responsesWhole.prompt, 'system: Be brief.\nWhere is order 1001?');
  assert.strictEqual(responsesWhole.tokensIn, 21);
  assert.strictEqual(responsesWhole.tokensOut, 9);
  assert.strictEqual(responsesWhole.cacheReadTokens, 4);
  assert.strictEqual(responsesWhole.attributes['gen_ai.response.id'], 'resp_mock');

  await openai.responses.create({ model: 'tools', input: 'Where is order 1001?' });
  assert.deepStrictEqual(toolCalls(await llmSpan('responses.create')), [{ name: 'lookup_order', id: 'call_1', args: { order_id: '1001' } }]);

  await drain(await openai.responses.create({ model: 'tools', input: 'Where is order 1001?', stream: true }));
  const responsesStream = await llmSpan('responses.create');
  assert.deepStrictEqual(toolCalls(responsesStream), [{ name: 'lookup_order', id: 'call_1', args: { order_id: '1001' } }]);
  assert.strictEqual(responsesStream.attributes[TTFT], undefined);
  assert.strictEqual(responsesStream.attributes['gen_ai.streaming'], true);

  const helperStream = openai.responses.stream({ model: 'text', input: 'Where is order 1001?' });
  for await (const _ of helperStream) { /* the helper's own events */ }
  const helperFinal = await helperStream.finalResponse();
  assert.strictEqual(helperFinal.output?.[0]?.content?.[0]?.text, 'Order 1001 shipped.', 'responses.stream() still builds its final response');
  const responsesText = await llmSpan('responses.create');
  assert.strictEqual(responsesText.completion, 'Order 1001 shipped.');
  assert.strictEqual(typeof responsesText.attributes[TTFT], 'number');

  // Cohere v1 and v2 streams, and a whole v1 reply with tool calls.
  class CohereClient {
    async chat(_req) {
      return { text: '', generationId: 'gen_1', toolCalls: [{ name: 'lookup_order', parameters: { order_id: '1001' } }], meta: { tokens: { inputTokens: 5, outputTokens: 3 } } };
    }
    async chatStream(req) {
      return scripted(req.model === 'v2' ? [
        { value: { type: 'message-start', id: 'msg_v2' } },
        { value: { type: 'content-delta', index: 0, delta: { message: { content: { text: 'Order ' } } } } },
        { value: { type: 'content-delta', index: 0, delta: { message: { content: { text: '1001.' } } } } },
        { value: { type: 'tool-call-start', index: 1, delta: { message: { toolCalls: { id: 'tc_1', type: 'function', function: { name: 'lookup_order', arguments: '' } } } } } },
        { value: { type: 'tool-call-delta', index: 1, delta: { message: { toolCalls: { function: { arguments: '{"order_id":"1001"}' } } } } } },
        { value: { type: 'message-end', delta: { finishReason: 'TOOL_CALL', usage: { tokens: { inputTokens: 9, outputTokens: 4 } } } } },
      ] : [
        { value: { eventType: 'stream-start', generationId: 'gen_1' } },
        { value: { eventType: 'text-generation', text: 'Order ' } },
        { value: { eventType: 'text-generation', text: '1001.' } },
        { value: { eventType: 'tool-calls-chunk', toolCallDelta: { index: 0, name: 'lookup_order' } } },
        { value: { eventType: 'tool-calls-chunk', toolCallDelta: { index: 0, parameters: '{"order_id":' } } },
        { value: { eventType: 'tool-calls-chunk', toolCallDelta: { index: 0, parameters: '"1001"}' } } },
        { value: { eventType: 'stream-end', finishReason: 'COMPLETE', response: { generationId: 'gen_1', meta: { tokens: { inputTokens: 8, outputTokens: 2 } } } } },
      ]);
    }
  }
  patchCohereClient(CohereClient.prototype);
  const cohere = new CohereClient();
  await drain(await cohere.chatStream({ model: 'command-r', message: 'Where is order 1001?' }));
  const cohereV1 = await llmSpan('chat_stream');
  assert.strictEqual(cohereV1.completion, 'Order 1001.');
  assert.strictEqual(typeof cohereV1.attributes[TTFT], 'number');
  assert.deepStrictEqual(toolCalls(cohereV1), [{ name: 'lookup_order', id: '', args: { order_id: '1001' } }]);
  assert.strictEqual(cohereV1.tokensIn, 8);
  await drain(await cohere.chatStream({ model: 'v2', messages: [{ role: 'user', content: 'Where is order 1001?' }] }));
  const cohereV2 = await llmSpan('chat_stream');
  assert.strictEqual(cohereV2.completion, 'Order 1001.');
  assert.deepStrictEqual(toolCalls(cohereV2), [{ name: 'lookup_order', id: 'tc_1', args: { order_id: '1001' } }]);
  assert.strictEqual(cohereV2.tokensOut, 4);
  assert.deepStrictEqual(cohereV2.attributes['gen_ai.response.finish_reasons'], ['TOOL_CALL']);
  await cohere.chat({ model: 'command-r', message: 'Where is order 1001?' });
  assert.deepStrictEqual(toolCalls(await llmSpan('chat')).map((c) => c.name), ['lookup_order']);

  // Gemini GenerativeModel streams, @google/generative-ai and Vertex: `{ stream, response }`.
  const generativeModel = (Base) => class extends Base {
    async generateContentStream(_req) {
      const chunks = this.__chunks;
      const stream = (async function* () {
        for (const c of chunks) { await sleep(10); if (c.throw) throw new Error(c.throw); yield c; }
      })();
      // The SDK's response reads its own copy of the stream, so it fails where the stream does.
      const response = (async () => {
        const parts = [];
        for (const c of chunks) { await sleep(10); if (c.throw) throw new Error(c.throw); parts.push(...c.candidates[0].content.parts); }
        await sleep(80);
        return { candidates: [{ content: { parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4, totalTokenCount: 10 } };
      })();
      response.catch(() => {});
      return { stream, response };
    }
    async generateContent(_req) {
      return { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup_order', args: { order_id: '1001' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 1 } } };
    }
  };
  const text = (t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });
  const call = { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup_order', args: { order_id: '1001' } } }] } }] };
  for (const [label, patch, system] of [['google-ai', patchGoogleAIModel, 'google-ai'], ['vertex', patchVertexGenerativeModel, 'google-vertex']]) {
    const Model = generativeModel(class { constructor() { this.model = 'gemini-2.5-flash'; } });
    patch(Model.prototype);
    const model = new Model();
    model.__chunks = [text('Order '), text('1001.'), call];
    const result = await model.generateContentStream({ contents: [{ role: 'user', parts: [{ text: 'Where is order 1001?' }] }] });
    await drain(result.stream);
    const aggregated = await result.response;
    assert.strictEqual(aggregated.candidates[0].content.parts.length, 3, `${label}: the app's response promise is untouched`);
    const span = await llmSpan('generateContentStream');
    assert.strictEqual(span.provider, system);
    assert.strictEqual(span.model, 'gemini-2.5-flash');
    assert.strictEqual(span.completion, 'Order 1001.', `${label}: streamed text`);
    assert.strictEqual(typeof span.attributes[TTFT], 'number', `${label}: time to first token`);
    assert.deepStrictEqual(toolCalls(span).map((c) => [c.name, c.args]), [['lookup_order', { order_id: '1001' }]], `${label}: tool calls`);
    assert.strictEqual(span.tokensIn, 6);

    model.__chunks = [call];
    await drain((await model.generateContentStream({ contents: [] })).stream);
    assert.strictEqual((await llmSpan('generateContentStream')).attributes[TTFT], undefined, `${label}: a tool-only stream has no time to first token`);

    model.__chunks = [text('Par'), { throw: 'stream reset' }];
    const failing = await model.generateContentStream({ contents: [] });
    await assert.rejects(drain(failing.stream), /stream reset/);
    const failed = await llmSpan('generateContentStream');
    assert.strictEqual(failed.status, 'ERROR', `${label}: a failed stream is an error`);
    assert.strictEqual(failed.completion, 'Par', `${label}: a failed stream keeps the text that arrived`);

    await model.generateContent({ contents: [] });
    assert.deepStrictEqual(toolCalls(await llmSpan('generateContent')).map((c) => c.name), ['lookup_order'], `${label}: whole replies record tool calls too`);
  }

  // Ollama sends tool calls whole, in a chunk's message.
  class FakeOllama {
    async chat(params) {
      return params.stream
        ? scripted([{ value: { model: 'llama3.2', message: { content: '', tool_calls: [{ function: { name: 'lookup_order', arguments: { order_id: '1001' } } }] }, done_reason: 'stop', prompt_eval_count: 7, eval_count: 3 } }])
        : { model: 'llama3.2', message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'lookup_order', arguments: { order_id: '1001' } } }] }, prompt_eval_count: 7, eval_count: 3 };
    }
  }
  patchOllamaClient(FakeOllama);
  await drain(await new FakeOllama().chat({ model: 'llama3.2', messages: MESSAGES, stream: true }));
  const ollamaStream = await llmSpan('chat');
  assert.deepStrictEqual(toolCalls(ollamaStream).map((c) => [c.name, c.args]), [['lookup_order', { order_id: '1001' }]]);
  assert.strictEqual(ollamaStream.attributes[TTFT], undefined);

  // Bedrock InvokeModel with an Anthropic model, streamed.
  class InvokeModelWithResponseStreamCommand { constructor(input) { this.input = input; } }
  const bytes = (obj) => ({ chunk: { bytes: new TextEncoder().encode(JSON.stringify(obj)) } });
  const bedrock = { send: async () => ({ $metadata: {}, body: scripted([
    { value: bytes({ type: 'message_start', message: { usage: { input_tokens: 12 } } }) },
    { value: bytes({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_b', name: 'lookup_order', input: {} } }) },
    { value: bytes({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"order_id":"1001"}' } }) },
    { value: bytes({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }) },
  ]) }) };
  patchBedrockClient(bedrock);
  const invoked = await bedrock.send(new InvokeModelWithResponseStreamCommand({
    modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: MESSAGES }),
  }));
  await drain(invoked.body);
  const bedrockSpan = await llmSpan();
  assert.deepStrictEqual(toolCalls(bedrockSpan), [{ name: 'lookup_order', id: 'toolu_b', args: { order_id: '1001' } }]);
  assert.strictEqual(bedrockSpan.attributes[TTFT], undefined);

  await mock.close();
  console.log('PASS stream-tool-calls.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? err?.message ?? String(err));
}
