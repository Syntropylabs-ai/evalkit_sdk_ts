import assert from 'node:assert';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { EvalKitClient } from '../dist/index.mjs';

let ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ status: 'ok' }) };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const PROMPT = 'user: my card is 4111 1111 1111 1111';

const CONTENT_ATTRS = {
  'gen_ai.request.body': '{"messages":[{"role":"user","content":"my card is 4111 1111 1111 1111"}]}',
  'gen_ai.response.body': '{"content":[{"text":"I will not repeat that"}]}',
  'gen_ai.response.thinking': 'the user pasted a card number',
  'function.args': '["4111 1111 1111 1111"]',
  'function.kwargs': '{"cvv":"123"}',
  'function.result': '{"charged":true}',
  'tool.arguments': '{"card":"4111"}',
  'tool.result': '{"ok":true}',
  'db.statement': "SELECT * FROM users WHERE ssn = '123-45-6789'",
  'db.params': '["123-45-6789"]',
  'retriever.query': 'what is my card number',
  'log.message': 'charging card 4111 1111 1111 1111',
  'request.body': '{"card":"4111"}',
  'response.body': '{"charged":true}',
  'http.request.body': '{"card":"4111"}',
  'http.response.body': '{"charged":true}',
  'http.request.headers': '{"authorization":"Bearer sk-live-abc"}',
  'http.response.headers': '{"set-cookie":"session=abc"}',
};

const KEPT_ATTRS = {
  'gen_ai.request.model': 'claude-sonnet-4-5',
  'gen_ai.usage.input_tokens': 11,
  'gen_ai.usage.output_tokens': 4,
  'gen_ai.response.finish_reasons': 'end_turn',
  'db.system': 'postgresql',
  'db.operation': 'SELECT',
  'url.full': 'https://api.example.com/charge',
  'http.response.status_code': 200,
  'gen_ai.tool.name': 'charge_card',
  'gen_ai.tool.call.id': 'call_1',
};

async function collect(opts) {
  ingested = [];
  const host = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  });
  const client = new EvalKitClient({
    subscriptionKey: 'test',
    baseUrl: 'http://localhost:9',
    serviceName: 'redaction-svc',
    scheduledDelayMillis: 50,
    tracerProvider: host,
    ...opts,
  });
  assert.strictEqual(
    client.tracingMode,
    'attached',
    'each case builds its own TracerProvider so its spans reach only its own exporter; if EvalKit fell back to ' +
      'owned or isolated mode the cases would share a pipeline and cross-contaminate the collected envelopes'
  );

  const span = client.tracer.startSpan('llm-call', {
    attributes: {
      'evalkit.span_type': 'llm_call',
      'gen_ai.system': 'anthropic',
      'evalkit.prompt': PROMPT,
      'evalkit.completion': 'I will not repeat that',
      ...CONTENT_ATTRS,
      ...KEPT_ATTRS,
    },
  });
  span.addEvent('gen_ai.tool.call', {
    'gen_ai.tool.name': 'charge_card',
    'gen_ai.tool.call.id': 'call_1',
    'gen_ai.tool.call.arguments': '{"card":"4111 1111 1111 1111"}',
    'gen_ai.tool.call.result': '{"charged":true}',
    'evalkit.prompt': PROMPT,
  });
  span.end();

  await client.flush();
  await new Promise((r) => setTimeout(r, 100));
  await client.destroy();
  return ingested;
}

try {
  let spans = await collect({});
  assert.strictEqual(spans.length, 1, `expected one ingested span, got ${spans.length}`);
  assert.strictEqual(
    spans[0].prompt,
    PROMPT,
    'content capture is what the product is for and must stay on unless the customer turns it off'
  );
  assert.ok(spans[0].attributes['gen_ai.request.body'], 'request bodies are captured by default');
  assert.strictEqual(
    spans[0].attributes['evalkit.content_captured'],
    undefined,
    'the marker must appear only on spans that were actually stripped, otherwise it says nothing'
  );

  spans = await collect({ captureContent: false });
  assert.strictEqual(spans.length, 1, `expected one ingested span, got ${spans.length}`);
  const [stripped] = spans;

  assert.strictEqual(stripped.prompt, undefined, 'captureContent:false must drop the prompt');
  assert.strictEqual(stripped.completion, undefined, 'captureContent:false must drop the completion');

  for (const key of Object.keys(CONTENT_ATTRS)) {
    assert.strictEqual(
      stripped.attributes[key],
      undefined,
      `${key} survived captureContent:false — every payload-bearing attribute has to go, or a customer who turned ` +
        'capture off is still shipping user data and does not know it'
    );
  }

  for (const [key, value] of Object.entries(KEPT_ATTRS)) {
    assert.strictEqual(
      stripped.attributes[key],
      value,
      `${key} was dropped by captureContent:false — metrics and identifiers are not content, and losing them would ` +
        'leave a privacy-conscious customer with no cost, latency or error data at all'
    );
  }

  assert.strictEqual(stripped.tokensIn, 11, 'tokens are what cost is computed from and must survive redaction');
  assert.strictEqual(stripped.tokensOut, 4);
  assert.strictEqual(stripped.model, 'claude-sonnet-4-5');
  assert.strictEqual(stripped.provider, 'anthropic');
  assert.strictEqual(stripped.latencyMs >= 0, true);
  assert.strictEqual(
    stripped.attributes['evalkit.content_captured'],
    false,
    'the dashboard has to tell "the customer turned capture off" apart from "the SDK could not read the body", ' +
      'which are the same empty prompt on the wire'
  );

  const event = (stripped.events ?? [])[0];
  assert.ok(event, 'the tool-call event itself must survive; only its payload is content');
  assert.strictEqual(event.attributes['gen_ai.tool.name'], 'charge_card', 'tool names drive the tool metrics');
  assert.strictEqual(event.attributes['gen_ai.tool.call.id'], 'call_1');
  assert.strictEqual(
    event.attributes['gen_ai.tool.call.arguments'],
    undefined,
    'tool arguments are user content and are the most likely place a card number or an SSN shows up'
  );
  assert.strictEqual(event.attributes['gen_ai.tool.call.result'], undefined);
  assert.strictEqual(
    event.attributes['evalkit.prompt'],
    undefined,
    'evalkit.prompt is promoted out of the span attribute bag, but nothing promotes or strips event attributes ' +
      'except CONTENT_ATTRIBUTES, so a hand-instrumented event carrying a prompt is the one place captureContent:' +
      'false still ships the exact content the customer switched off'
  );

  process.env.EVALKIT_CAPTURE_CONTENT = 'false';
  spans = await collect({});
  assert.strictEqual(
    spans[0].prompt,
    undefined,
    'EVALKIT_CAPTURE_CONTENT=false has to work without a code change, so one image can ship to environments with ' +
      'different privacy rules'
  );
  delete process.env.EVALKIT_CAPTURE_CONTENT;

  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'false';
  spans = await collect({});
  assert.strictEqual(
    spans[0].prompt,
    undefined,
    'an app already configured for OpenTelemetry must not need an EvalKit-specific variable to stay private'
  );
  delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;

  process.env.EVALKIT_CAPTURE_CONTENT = 'true';
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'false';
  spans = await collect({});
  assert.strictEqual(
    spans[0].prompt,
    PROMPT,
    'the EvalKit variable is the more specific one and must win over the OpenTelemetry variable when both are set'
  );
  delete process.env.EVALKIT_CAPTURE_CONTENT;
  delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;

  process.env.EVALKIT_CAPTURE_CONTENT = 'false';
  spans = await collect({ captureContent: true });
  assert.strictEqual(
    spans[0].prompt,
    PROMPT,
    'an explicit captureContent option must beat the environment, otherwise a stray variable in a shell profile ' +
      'silently overrides code the developer is looking at'
  );
  delete process.env.EVALKIT_CAPTURE_CONTENT;

  process.env.EVALKIT_CAPTURE_CONTENT = 'not-a-boolean';
  spans = await collect({});
  assert.strictEqual(
    spans[0].prompt,
    PROMPT,
    'an unparseable value must warn and fall through rather than being read as false: guessing either way turns a ' +
      'typo into either a silent data loss or a silent leak'
  );
  delete process.env.EVALKIT_CAPTURE_CONTENT;

  const seenPrompts = [];
  spans = await collect({
    mask: (envelope) => {
      seenPrompts.push(envelope.prompt);
      if (envelope.prompt) envelope.prompt = '<redacted>';
      return envelope;
    },
  });
  assert.strictEqual(spans[0].prompt, '<redacted>', 'a mask hook must be able to rewrite content in place');
  assert.strictEqual(spans[0].tokensIn, 11, 'masking content must not disturb the metrics');
  assert.deepStrictEqual(seenPrompts, [PROMPT], 'the hook runs once per span and sees the real content');

  const seenAfterStrip = [];
  await collect({
    captureContent: false,
    mask: (envelope) => {
      seenAfterStrip.push(envelope.prompt);
      return envelope;
    },
  });
  assert.deepStrictEqual(
    seenAfterStrip,
    [undefined],
    'captureContent is the coarse switch and mask is the fine one, so mask must run on the already-stripped ' +
      'envelope rather than being handed content the customer said not to capture'
  );

  spans = await collect({ mask: () => null });
  assert.strictEqual(spans.length, 0, 'returning null from mask is the documented way to drop a span entirely');

  spans = await collect({ mask: () => undefined });
  assert.strictEqual(
    spans.length,
    0,
    'a hook that forgets to return is indistinguishable from one that meant to drop the span, and the safe reading ' +
      'of an ambiguous privacy hook is to drop'
  );

  spans = await collect({ mask: () => { throw new Error('scrubber misconfigured'); } });
  assert.strictEqual(
    spans.length,
    0,
    'a mask hook exists to stop content leaving the process, so a broken hook must fail closed — this is the one ' +
      "place the SDK does not swallow the failure and carry on, because carrying on is the leak"
  );

  spans = await collect({ mask: () => ({ prompt: 'not an envelope' }) });
  assert.strictEqual(
    spans.length,
    0,
    'a hook returning the wrong shape must not be exported as-is: without a traceId the span cannot be stitched ' +
      'into a trace anyway, and shipping it would only leak whatever the hook did copy across'
  );

  spans = await collect({
    mask: (envelope) => {
      delete envelope.attributes['db.statement'];
      envelope.attributes['gen_ai.request.body'] = '<scrubbed>';
      return envelope;
    },
  });
  assert.strictEqual(spans[0].attributes['db.statement'], undefined, 'a mask hook must be able to drop attributes');
  assert.strictEqual(spans[0].attributes['gen_ai.request.body'], '<scrubbed>');
  assert.strictEqual(spans[0].prompt, PROMPT, 'a hook that only touches attributes must leave the rest alone');

  console.log('PASS: redaction e2e');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? err?.message ?? err);
}
