import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, patchOpenAIClient } from '../dist/index.mjs';

const ingested = [];
const warnings = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const realWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

const fail = (m) => { console.warn = realWarn; console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 15000);

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'stream-usage-warning-test',
  scheduledDelayMillis: 50,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const delta = (content) => ({ choices: [{ delta: { content } }] });
const usageChunk = (prompt_tokens, completion_tokens) => ({
  choices: [{ delta: {} }],
  usage: { prompt_tokens, completion_tokens },
});

const makeClient = (script) => {
  const openai = {
    chat: {
      completions: {
        create: async () =>
          (async function* () {
            for (const step of script) {
              await sleep(5);
              if (step.throw) throw new Error(step.throw);
              yield step;
            }
          })(),
      },
    },
  };
  patchOpenAIClient(openai);
  return openai;
};

const drain = async (params, script) => {
  ingested.length = 0;
  const openai = makeClient(script);
  const stream = await openai.chat.completions.create(params);
  let raised = null;
  try {
    for await (const _ of stream) { /* consume */ }
  } catch (err) {
    raised = err;
  }
  await client.flush();
  await sleep(150);
  return { raised, span: ingested.find((e) => e.spanType === 'llm_call') };
};

const STREAM_REQ = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], stream: true };

try {
  const withUsage = await drain(
    { ...STREAM_REQ, stream_options: { include_usage: true } },
    [delta('Par'), delta('is'), usageChunk(11, 2)]
  );

  assert.ok(withUsage.span, 'the streamed call produced no llm_call span, so every assertion below is vacuous');
  assert.strictEqual(withUsage.span.completion, 'Paris', 'the fake chunk shape does not match what the wrapper reads');
  assert.strictEqual(
    withUsage.span.tokensIn,
    11,
    'a stream that DID send a usage chunk must report its real prompt tokens, otherwise the warning we are about ' +
      'to test is firing for the wrong reason'
  );
  assert.strictEqual(
    warnings.length,
    0,
    `a caller who already passes stream_options: { include_usage: true } has nothing to fix, so warning at them ` +
      `trains them to ignore evalkit warnings; got: ${warnings.join(' | ')}`
  );

  const truthyNotTrue = await drain(
    { ...STREAM_REQ, stream_options: { include_usage: 1 } },
    [delta('Par')]
  );
  assert.ok(truthyNotTrue.span, 'the include_usage: 1 stream produced no span');
  assert.ok(
    !truthyNotTrue.span.tokensIn,
    'this case is only load-bearing while there is no usage chunk: with real tokens the warning is suppressed by ' +
      'the token check and the include_usage gate is never consulted'
  );
  assert.strictEqual(
    warnings.length,
    0,
    'the python SDK gates on truthiness (bool(options.get("include_usage"))) so include_usage: 1 is silent there; a ' +
      'ts gate written as !== true would warn on the same request and make the two SDKs disagree about the same code'
  );

  const failed = await drain({ ...STREAM_REQ }, [delta('Par'), { throw: 'stream reset' }]);
  assert.ok(failed.raised, 'a stream that dies mid-flight must still surface the error to the caller');
  assert.ok(failed.span, 'a failed stream produced no span');
  assert.strictEqual(failed.span.status, 'ERROR', 'a stream that died mid-flight must not be recorded as a success');
  assert.strictEqual(
    warnings.length,
    0,
    'a stream that died before the usage chunk has an obvious reason for reporting 0 tokens; telling the caller to ' +
      `add stream_options would send them chasing a config bug instead of the outage; got: ${warnings.join(' | ')}`
  );

  const missing = await drain({ ...STREAM_REQ }, [delta('Par'), delta('is')]);

  assert.ok(missing.span, 'the streamed call with no usage chunk produced no span');
  assert.strictEqual(missing.span.completion, 'Paris', 'the completion was lost, so this is not the case under test');
  assert.ok(
    !missing.span.tokensIn && !missing.span.tokensOut,
    'this test only means something if the no-usage-chunk stream really does report no tokens; the exporter maps a ' +
      'zero to undefined, so the envelope carries no token counts at all and the cost engine has nothing to price - ' +
      `got tokensIn=${missing.span.tokensIn} tokensOut=${missing.span.tokensOut}`
  );
  assert.strictEqual(
    warnings.length,
    1,
    'a streamed OpenAI call with no stream_options reports 0/0 tokens and therefore $0 cost for every such call - ' +
      'silently under-reporting spend is worse than a noisy log line, so exactly one warning must fire; got: ' +
      `${warnings.length}: ${warnings.join(' | ')}`
  );
  assert.match(
    warnings[0],
    /stream_options/,
    'a warning that does not name stream_options leaves the caller with a symptom and no fix'
  );
  assert.match(
    warnings[0],
    /include_usage/,
    'the warning must name the exact field to add, not just the option object'
  );

  await drain({ ...STREAM_REQ }, [delta('Hi')]);
  assert.strictEqual(
    warnings.length,
    1,
    'the warning must be once-per-process: a chat loop streams thousands of times, and a per-call warning would ' +
      `flood stderr and get the whole SDK muted; got ${warnings.length} warnings`
  );

  console.warn = realWarn;
  console.log('PASS stream-usage-warning.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
