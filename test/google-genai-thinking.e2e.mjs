import assert from 'node:assert';
import { init, patchGoogleGenAIModels } from '../dist/index.mjs';

const THINKING = 'gen_ai.response.thinking';
const TTFT = 'gen_ai.server.time_to_first_token_ms';
const SCRATCH = 'The user wants 6*7. I must not reveal this scratchpad.';
const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'gemini-thinking-test',
  scheduledDelayMillis: 50,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Models {
  async generateContent() {
    return this.__unary;
  }
  async generateContentStream() {
    const script = this.__script;
    return (async function* () {
      for (const step of script) {
        await sleep(step.after);
        yield step.chunk;
      }
    })();
  }
}

patchGoogleGenAIModels(Models.prototype);

const unary = async (response) => {
  ingested.length = 0;
  const models = new Models();
  models.__unary = response;
  await models.generateContent({ model: 'gemini-2.5-pro', contents: 'what is 6*7?' });
  await client.flush();
  await sleep(200);
  return ingested.find((e) => e.spanType === 'llm_call');
};

const streamed = async (script) => {
  ingested.length = 0;
  const models = new Models();
  models.__script = script;
  const stream = await models.generateContentStream({ model: 'gemini-2.5-pro', contents: 'what is 6*7?' });
  for await (const _ of stream) { }
  await client.flush();
  await sleep(200);
  return ingested.find((e) => e.spanType === 'llm_call');
};

try {
  const mixed = await unary({
    text: '42',
    candidates: [{ content: { parts: [{ text: SCRATCH, thought: true }, { text: '42' }] } }],
    usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 120, totalTokenCount: 131 },
  });

  assert.ok(mixed, 'the unary generateContent call produced no llm_call span at all');
  assert.strictEqual(
    mixed.completion,
    '42',
    'a Part carrying thought=true is the model private scratchpad, not the answer; concatenating it into ' +
      'evalkit.completion makes every exact-match / judge eval score the reasoning instead of the answer'
  );
  assert.strictEqual(
    mixed.attributes?.[THINKING],
    SCRATCH,
    'reasoning is billed as output tokens, so it must still be recorded somewhere - sdk-py puts it on ' +
      'gen_ai.response.thinking, and a ts span that silently drops it makes the same call unexplainable'
  );
  assert.strictEqual(
    mixed.attributes?.['gen_ai.usage.reasoning_tokens'],
    120,
    'splitting the text must not disturb the usage side; thoughtsTokenCount reading 0 prices a reasoning-heavy call at 0'
  );

  const thoughtOnly = await unary({
    text: SCRATCH,
    candidates: [{ content: { parts: [{ text: SCRATCH, thought: true }] } }],
  });

  assert.strictEqual(
    thoughtOnly.completion,
    '',
    'when every part is a thought part the .text fallback must stay disabled; raw REST payloads and older ' +
      '@google/genai builds expose the thought text on .text, so an unguarded fallback re-injects exactly what ' +
      'the part filter just removed'
  );
  assert.strictEqual(
    thoughtOnly.attributes?.[THINKING],
    SCRATCH,
    'a thought-only chunk must still record its reasoning, or an empty completion is indistinguishable from a call the model never answered'
  );

  const plain = await unary({ text: 'plain answer', candidates: [] });
  assert.strictEqual(
    plain.completion,
    'plain answer',
    'with no candidates and no thought parts the .text fallback must still run, or non-thinking Gemini models lose their completion entirely'
  );
  assert.strictEqual(
    plain.attributes?.[THINKING],
    undefined,
    'a response with no thought parts must not carry an empty gen_ai.response.thinking attribute'
  );

  const chunk = (text, thought) => ({
    candidates: [{ content: { parts: [thought ? { text, thought: true } : { text }] } }],
  });

  const stream = await streamed([
    { after: 40, chunk: chunk('scratchpad: 6*7', true) },
    { after: 250, chunk: chunk('4') },
    {
      after: 10,
      chunk: {
        candidates: [{ content: { parts: [{ text: '2' }] } }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 120, totalTokenCount: 131 },
      },
    },
  ]);

  assert.ok(stream, 'the streaming generateContentStream call produced no llm_call span at all');
  assert.strictEqual(
    stream.completion,
    '42',
    'streamed thought deltas must be excluded from evalkit.completion exactly like the unary path, otherwise the ' +
      'same prompt scores differently depending only on whether the caller streamed'
  );
  assert.strictEqual(
    stream.attributes?.[THINKING],
    'scratchpad: 6*7',
    'streamed thought deltas must accumulate onto gen_ai.response.thinking, not vanish'
  );

  const ttft = stream.attributes?.[TTFT];
  assert.strictEqual(
    typeof ttft,
    'number',
    'a stream whose first delta is a thought delta must still report TTFT as a number; a string reads back as 0 through JSONExtractFloat'
  );
  assert.ok(
    ttft < 150,
    `TTFT is ${ttft}ms but the thought delta arrived at ~40ms and the first answer delta only at ~290ms; the ` +
      'cross-SDK rule marks TTFT on the first reasoning delta too, so ignoring thought deltas inflates the ' +
      'reported first-token latency of every thinking model'
  );

  console.log('PASS google-genai-thinking.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
