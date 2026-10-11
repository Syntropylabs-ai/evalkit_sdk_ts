import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, patchGoogleGenAIModels } from '../dist/index.mjs';

const TTFT = 'gen_ai.server.time_to_first_token_ms';
const ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'ttft-test',
  scheduledDelayMillis: 50,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

class Models {
  async generateContentStream({ model }) {
    const script = this.__script;
    return (async function* () {
      for (const step of script) {
        await sleep(step.after);
        if (step.throw) throw new Error(step.throw);
        yield step.chunk;
      }
    })();
  }
}

patchGoogleGenAIModels(Models.prototype);

const drain = async (script) => {
  ingested.length = 0;
  const models = new Models();
  models.__script = script;
  const stream = await models.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
  const seen = [];
  for await (const c of stream) seen.push(c);
  await client.flush();
  await sleep(200);
  return { seen, span: ingested.find((e) => e.spanType === 'llm_call') };
};

try {
  const slowSecondDelta = await drain([
    { after: 60, chunk: chunk('Hel') },
    { after: 300, chunk: chunk('lo') },
  ]);

  assert.ok(slowSecondDelta.span, 'the streaming call produced no llm_call span at all');
  assert.strictEqual(
    slowSecondDelta.span.completion,
    'Hello',
    'the chunk shape is wrong, so the TTFT assertions below would pass vacuously'
  );

  const ttft = slowSecondDelta.span.attributes?.[TTFT];
  assert.strictEqual(
    typeof ttft,
    'number',
    'Gemini streams carried no TTFT while openai/anthropic/bedrock did — a dashboard column that is empty for ' +
      'one provider reads as a broken dashboard, not as a missing SDK feature'
  );
  assert.ok(ttft >= 20, `TTFT is ${ttft}ms after a 60ms first delta; the clock must start before the provider call`);
  assert.ok(
    slowSecondDelta.span.latencyMs - ttft >= 100,
    `latencyMs=${slowSecondDelta.span.latencyMs} TTFT=${ttft}: the second delta was 300ms behind the first, so a ` +
      'TTFT that tracks total duration means we are reporting time-to-LAST-token under a first-token name'
  );

  ingested.length = 0;
  const failing = new Models();
  failing.__script = [{ after: 20, chunk: chunk('Hel') }, { after: 20, throw: 'stream reset' }];
  const stream = await failing.generateContentStream({ model: 'gemini-2.5-flash', contents: 'hi' });
  let raised = null;
  try {
    for await (const _ of stream) { /* consume until it dies */ }
  } catch (err) {
    raised = err;
  }
  await client.flush();
  await sleep(200);

  assert.ok(raised, 'a stream that throws mid-flight must still surface the error to the caller');
  const failed = ingested.find((e) => e.spanType === 'llm_call');
  assert.ok(failed, 'a failed stream produced no span');
  assert.strictEqual(failed.status, 'ERROR', 'a stream that died mid-flight must not be recorded as a success');
  assert.strictEqual(
    failed.attributes?.[TTFT],
    undefined,
    'a truncated stream must stay out of the TTFT percentiles, or a provider outage that fails fast reads as a ' +
      'latency improvement'
  );

  console.log('PASS streaming-ttft.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
