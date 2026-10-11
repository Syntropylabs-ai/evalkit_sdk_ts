import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import {
  init,
  patchOpenAIClient,
  patchAnthropicClient,
  patchBedrockClient,
  patchCohereClient,
  patchGoogleAIModel,
  patchGoogleGenAIModels,
  patchOllamaClient,
  patchVertexGenerativeModel,
} from '../dist/index.mjs';

const TOOLS = 'gen_ai.request.tools';
const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 20000);
watchdog.unref?.();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'request-tools-test',
  scheduledDelayMillis: 50,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs one instrumented call and returns the llm_call span it produced.
const llmSpan = async (label, call) => {
  ingested.length = 0;
  await call();
  await client.flush();
  await sleep(200);
  const span = ingested.find((e) => e.spanType === 'llm_call');
  if (!span) fail(`${label}: the call produced no llm_call span at all`);
  return span;
};

const FINGERPRINT =
  'the trace-service agent-version fingerprint reads gen_ai.request.tools before it falls back to the request ' +
  'body, and the exporter drops the body from oversized spans, so without the attribute a TS agent version ' +
  'shows no tools where the Python SDK shows them';

try {
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          id: 'c1',
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }),
      },
    },
  };
  patchOpenAIClient(openai);
  const openaiSpan = await llmSpan('openai', () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'where is my order?' }],
      temperature: 0.2,
      tools: [
        { type: 'function', function: { name: 'lookup_order', parameters: {} } },
        { type: 'function', function: { name: 'refund', parameters: {} } },
        { type: 'function', function: { name: 'lookup_order', parameters: {} } },
      ],
    }),
  );
  assert.deepStrictEqual(
    openaiSpan.attributes?.[TOOLS],
    ['lookup_order', 'refund'],
    'OpenAI chat nests the tool name under function.name; the list must be those names, deduplicated in request ' +
      'order, and a JSON array like the Python SDK sends - ' + FINGERPRINT,
  );

  const plainSpan = await llmSpan('openai without tools', () =>
    openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
  );
  assert.strictEqual(
    plainSpan.attributes?.[TOOLS],
    undefined,
    'a request that offered no tools must not carry an empty gen_ai.request.tools, which reads as a different ' +
      'agent configuration than the same request from the Python SDK',
  );

  const anthropic = {
    messages: {
      create: async () => ({
        id: 'm1',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 1 },
      }),
    },
  };
  patchAnthropicClient(anthropic);
  const anthropicSpan = await llmSpan('anthropic', () =>
    anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { name: 'get_weather', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', max_uses: 3 },
      ],
    }),
  );
  assert.deepStrictEqual(
    anthropicSpan.attributes?.[TOOLS],
    ['get_weather', 'web_search_20250305'],
    'Anthropic names a custom tool at the top and a server tool has only its type; dropping the built-in one ' +
      'hides that the agent can search the web - ' + FINGERPRINT,
  );

  class ConverseCommand {
    constructor(input) { this.input = input; }
  }
  class InvokeModelCommand {
    constructor(input) { this.input = input; }
  }
  const bedrock = {
    send: async (command) =>
      command instanceof ConverseCommand
        ? {
            $metadata: {},
            output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
            stopReason: 'end_turn',
            usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
          }
        : {
            $metadata: {},
            body: new TextEncoder().encode(
              JSON.stringify({
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 5, output_tokens: 1 },
              }),
            ),
          },
  };
  patchBedrockClient(bedrock);
  const converseSpan = await llmSpan('bedrock converse', () =>
    bedrock.send(new ConverseCommand({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      messages: [{ role: 'user', content: [{ text: 'hi' }] }],
      toolConfig: { tools: [{ toolSpec: { name: 'lookup_order', inputSchema: { json: {} } } }] },
    })),
  );
  assert.deepStrictEqual(
    converseSpan.attributes?.[TOOLS],
    ['lookup_order'],
    'Bedrock Converse declares tools under toolConfig.tools[].toolSpec.name - ' + FINGERPRINT,
  );

  const invokeSpan = await llmSpan('bedrock invoke_model', () =>
    bedrock.send(new InvokeModelCommand({
      modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'lookup_order', input_schema: { type: 'object' } }],
      }),
    })),
  );
  assert.deepStrictEqual(
    invokeSpan.attributes?.[TOOLS],
    ['lookup_order'],
    'InvokeModel carries the provider request as a JSON body; its tools have to be read from the parsed body - ' +
      FINGERPRINT,
  );

  class Models {
    async generateContent() {
      return { text: 'ok', candidates: [{ content: { parts: [{ text: 'ok' }] } }] };
    }
  }
  patchGoogleGenAIModels(Models.prototype);
  const genaiSpan = await llmSpan('google-genai', () =>
    new Models().generateContent({
      model: 'gemini-2.5-flash',
      contents: 'hi',
      config: {
        temperature: 0.4,
        topP: 0.9,
        maxOutputTokens: 256,
        tools: [
          { functionDeclarations: [{ name: 'lookup_order' }, { name: 'refund' }] },
          { functionDeclarations: [{ name: 'escalate' }] },
        ],
      },
    }),
  );
  assert.deepStrictEqual(
    genaiSpan.attributes?.[TOOLS],
    ['lookup_order', 'refund', 'escalate'],
    'a Gemini tool is a group of function declarations; the tools are the declaration names across every group - ' +
      FINGERPRINT,
  );
  assert.strictEqual(genaiSpan.attributes?.['gen_ai.request.temperature'], 0.4, 'config.temperature is part of the agent version');
  assert.strictEqual(genaiSpan.attributes?.['gen_ai.request.top_p'], 0.9, 'config.topP is part of the agent version');
  assert.strictEqual(genaiSpan.attributes?.['gen_ai.request.max_tokens'], 256, 'config.maxOutputTokens is the max_tokens of a Gemini call');

  const generativeModel = (tools) => ({
    model: 'gemini-1.5-pro',
    tools,
    generationConfig: { temperature: 0.1, maxOutputTokens: 128 },
    async generateContent() {
      return { response: { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } };
    },
  });

  const googleAI = generativeModel([{ functionDeclarations: [{ name: 'lookup_order' }] }]);
  patchGoogleAIModel(googleAI);
  const modelLevelSpan = await llmSpan('google-ai model-level tools', () =>
    googleAI.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  );
  assert.deepStrictEqual(
    modelLevelSpan.attributes?.[TOOLS],
    ['lookup_order'],
    'getGenerativeModel({ tools }) puts the tools on the model, not on each request, so a span that reads only ' +
      'the request lists no tools for the usual way this SDK is used - ' + FINGERPRINT,
  );
  assert.strictEqual(modelLevelSpan.attributes?.['gen_ai.request.temperature'], 0.1, 'the model generationConfig temperature applies when the request sets none');
  assert.strictEqual(modelLevelSpan.attributes?.['gen_ai.request.max_tokens'], 128, 'the model generationConfig maxOutputTokens applies when the request sets none');

  const requestLevelSpan = await llmSpan('google-ai request-level tools', () =>
    googleAI.generateContent({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: [{ functionDeclarations: [{ name: 'refund' }] }],
      generationConfig: { temperature: 0.7 },
    }),
  );
  assert.deepStrictEqual(
    requestLevelSpan.attributes?.[TOOLS],
    ['refund'],
    'a request that sets its own tools sends those instead of the model ones, so the span must list what was sent',
  );
  assert.strictEqual(requestLevelSpan.attributes?.['gen_ai.request.temperature'], 0.7, 'the request generationConfig overrides the model one');

  const vertex = generativeModel([{ functionDeclarations: [{ name: 'lookup_order' }] }]);
  patchVertexGenerativeModel(vertex);
  const vertexSpan = await llmSpan('vertex-ai', () =>
    vertex.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  );
  assert.deepStrictEqual(
    vertexSpan.attributes?.[TOOLS],
    ['lookup_order'],
    'Vertex AI takes tools in getGenerativeModel({ tools }) like Google AI - ' + FINGERPRINT,
  );

  const cohere = {
    chat: async () => ({ text: 'ok', generationId: 'g1', finishReason: 'COMPLETE' }),
  };
  patchCohereClient(cohere);
  const cohereV1Span = await llmSpan('cohere v1', () =>
    cohere.chat({
      model: 'command-r',
      message: 'hi',
      p: 0.75,
      tools: [{ name: 'lookup_order', parameterDefinitions: {} }],
    }),
  );
  assert.deepStrictEqual(cohereV1Span.attributes?.[TOOLS], ['lookup_order'], 'Cohere v1 names the tool at the top - ' + FINGERPRINT);
  assert.strictEqual(cohereV1Span.attributes?.['gen_ai.request.top_p'], 0.75, 'Cohere spells top_p as p, and top_p is part of the agent version');

  const cohereV2Span = await llmSpan('cohere v2', () =>
    cohere.chat({
      model: 'command-r-plus',
      message: 'hi',
      tools: [{ type: 'function', function: { name: 'refund', parameters: {} } }],
    }),
  );
  assert.deepStrictEqual(cohereV2Span.attributes?.[TOOLS], ['refund'], 'Cohere v2 nests the name under function.name like OpenAI - ' + FINGERPRINT);

  class FakeOllama {
    async chat() {
      return { model: 'llama3.2', message: { role: 'assistant', content: 'ok' }, done_reason: 'stop' };
    }
  }
  patchOllamaClient(FakeOllama);
  const ollamaSpan = await llmSpan('ollama', () =>
    new FakeOllama().chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      options: { temperature: 0.3, top_p: 0.8, num_predict: 200 },
      tools: [{ type: 'function', function: { name: 'lookup_order', parameters: {} } }],
    }),
  );
  assert.deepStrictEqual(ollamaSpan.attributes?.[TOOLS], ['lookup_order'], 'Ollama takes OpenAI-shaped tools - ' + FINGERPRINT);
  assert.strictEqual(ollamaSpan.attributes?.['gen_ai.request.temperature'], 0.3, 'Ollama puts temperature under options');
  assert.strictEqual(ollamaSpan.attributes?.['gen_ai.request.top_p'], 0.8, 'Ollama puts top_p under options');
  assert.strictEqual(ollamaSpan.attributes?.['gen_ai.request.max_tokens'], 200, 'Ollama spells max_tokens as options.num_predict');

  const oddSpan = await llmSpan('malformed tools', () =>
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        null,
        42,
        'lookup_order',
        { function: {} },
        { name: '' },
        { type: 'code_interpreter' },
        { type: 'function', function: { name: 'refund' } },
      ],
    }),
  );
  assert.deepStrictEqual(
    oddSpan.attributes?.[TOOLS],
    ['code_interpreter', 'refund'],
    'entries without a usable name are skipped and a nameless one falls back to its type, the same rule as the ' +
      'Python SDK; the call itself must still succeed',
  );

  console.log('PASS request-tools.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
