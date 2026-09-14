import assert from 'node:assert';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { EvalKitClient, scrubSecrets, isSecretKey } from '../dist/index.mjs';

let ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of JSON.parse(opts.body).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ status: 'ok' }) };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const LIVE_KEY = 'tk_live_9f2b7c41ade05e3b';

const scrubAttrs = (attributes) =>
  scrubSecrets({ traceId: 't', spanId: 's', spanType: 'log', createdAt: 'now', attributes }).attributes;

const KEY_CASES = [
  [
    'the camel-case key the orchestrator leaked, inside a JSON-string attribute',
    { 'function.result': JSON.stringify({ id: 'env_1', subscriptionKey: LIVE_KEY, ownerEmail: 'ada@example.com' }) },
    { 'function.result': JSON.stringify({ id: 'env_1', subscriptionKey: '***', ownerEmail: 'ada@example.com' }) },
  ],
  [
    'a credentials object nested inside function args',
    { 'function.args': JSON.stringify([{ credentials: { subscriptionKey: LIVE_KEY, password: 'hunter2' } }, { email: 'ada@example.com' }]) },
    { 'function.args': JSON.stringify([{ credentials: '***' }, { email: 'ada@example.com' }]) },
  ],
  [
    'arrays of objects, each with its own secret',
    { 'tool.result': JSON.stringify({ users: [{ email: 'a@b.c', token: 't1' }, { email: 'd@e.f', token: 't2' }] }) },
    { 'tool.result': JSON.stringify({ users: [{ email: 'a@b.c', token: '***' }, { email: 'd@e.f', token: '***' }] }) },
  ],
  [
    'objects several levels deep',
    { 'request.body': JSON.stringify({ a: { b: { c: { client_secret: 'abc' } } } }) },
    { 'request.body': JSON.stringify({ a: { b: { c: { client_secret: '***' } } } }) },
  ],
  [
    'a request header map, through the header list',
    { 'http.request.headers': JSON.stringify({ 'X-Subscription-Key': LIVE_KEY, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'content-type': 'application/json' }) },
    { 'http.request.headers': JSON.stringify({ 'X-Subscription-Key': '***', authorization: '***', 'content-type': 'application/json' }) },
  ],
  [
    'a response header map',
    { 'http.response.headers': JSON.stringify({ 'set-cookie': 'session=abc123', 'content-length': '12' }) },
    { 'http.response.headers': JSON.stringify({ 'set-cookie': '***', 'content-length': '12' }) },
  ],
  [
    'the attribute key itself is a secret name',
    { 'evalkit.api_key': LIVE_KEY, 'db.statement': 'SELECT 1' },
    { 'evalkit.api_key': '***', 'db.statement': 'SELECT 1' },
  ],
  [
    'booleans and numbers under a secret key keep the masked shape',
    { 'function.kwargs': JSON.stringify({ hasToken: true, password: 1234, apiKey: null }) },
    { 'function.kwargs': JSON.stringify({ hasToken: true, password: '***', apiKey: '***' }) },
  ],
  [
    'every spelling on the list',
    { 'request.body': JSON.stringify({ api_key: '1', 'api-key': '1', apikey: '1', secret: '1', token: '1', password: '1', passwd: '1', authorization: '1', credential: '1', credentials: '1', cookie: '1', 'set-cookie': '1', private_key: '1', access_key: '1', client_secret: '1' }) },
    { 'request.body': JSON.stringify({ api_key: '***', 'api-key': '***', apikey: '***', secret: '***', token: '***', password: '***', passwd: '***', authorization: '***', credential: '***', credentials: '***', cookie: '***', 'set-cookie': '***', private_key: '***', access_key: '***', client_secret: '***' }) },
  ],
  [
    'identity and metrics are not secrets',
    { 'function.result': JSON.stringify({ email: 'ada@example.com', userId: 'u_1', tokensIn: 11, tokenizer: 'cl100k' }), 'gen_ai.usage.input_tokens': 11 },
    { 'function.result': JSON.stringify({ email: 'ada@example.com', userId: 'u_1', tokensIn: 11, tokenizer: 'cl100k' }), 'gen_ai.usage.input_tokens': 11 },
  ],
  [
    'string-array attribute values are pattern-scrubbed',
    { 'evalkit.keys': [LIVE_KEY, 'plain'] },
    { 'evalkit.keys': ['tk_live_***', 'plain'] },
  ],
];

const TELEMETRY_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.server.time_to_first_token_ms',
  'token_count',
  'prompt_token_count',
  'x-amzn-bedrock-input-token-count',
  'token_usage',
  'input_token_details',
  'tokenizer',
];

const SECRET_KEYS = ['apiKey', 'API_KEY', 'SubscriptionKey', 'Set-Cookie', 'AWS_SECRET_ACCESS_KEY', 'X-Auth-Token', 'access_token'];

const PATTERN_CASES = [
  ['live subscription key', LIVE_KEY, 'tk_live_***'],
  ['test subscription key', 'tk_test_0123456789abcdef', 'tk_test_***'],
  ['openai style key', 'sk-proj-Abcdefghij0123456789_-', 'sk-***'],
  ['bearer token', 'Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'Bearer ***'],
  ['lower case bearer keeps its prefix', 'bearer eyJhbGciOiJIUzI1NiJ9', 'bearer ***'],
  ['aws access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIA***'],
  ['github personal access token', `ghp_${'a'.repeat(20)}`, 'ghp_***'],
  ['a key inside a longer sentence', `auth failed for ${LIVE_KEY} on tenant acme`, 'auth failed for tk_live_*** on tenant acme'],
  ['a header line', `X-Subscription-Key: ${LIVE_KEY}`, 'X-Subscription-Key: tk_live_***'],
  ['too short to be a key', 'tk_live_1', 'tk_live_1'],
  ['not hex', 'tk_live_zzzzzzzzzz', 'tk_live_zzzzzzzzzz'],
  ['short bearer word', 'Bearer x', 'Bearer x'],
  ['plain prose mentioning tokens', 'we spent 40 tokens on this', 'we spent 40 tokens on this'],
  ['scrubbing twice is idempotent', 'tk_live_***', 'tk_live_***'],
];

const UNTOUCHED_STRINGS = [
  "SELECT * FROM users WHERE ssn = '123-45-6789'",
  '{"not really json',
  '[1,2,3]',
  '{"charged":true}',
  '',
  'https://api.example.com/charge?id=7',
];

const leakyAttributes = () => ({
  'function.result': JSON.stringify({ id: 'env_1', subscriptionKey: LIVE_KEY, ownerEmail: 'ada@example.com' }),
  'function.args': JSON.stringify([{ credentials: { subscriptionKey: LIVE_KEY, password: 'hunter2' } }, { email: 'ada@example.com' }]),
  'http.request.headers': JSON.stringify({ 'X-Subscription-Key': LIVE_KEY, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'content-type': 'application/json' }),
  'gen_ai.usage.input_tokens': 11,
  'url.full': 'https://api.example.com/charge',
});

async function collect(opts) {
  ingested = [];
  const host = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
  });
  const client = new EvalKitClient({
    subscriptionKey: 'test',
    baseUrl: 'http://localhost:9',
    serviceName: 'secrets-svc',
    scheduledDelayMillis: 50,
    tracerProvider: host,
    ...opts,
  });
  assert.strictEqual(client.tracingMode, 'attached', 'each case needs its own pipeline so the envelopes cannot cross-contaminate');

  const span = client.tracer.startSpan('TracingService.findById', {
    attributes: {
      'evalkit.span_type': 'function_call',
      'evalkit.prompt': `the environment key is ${LIVE_KEY}`,
      'evalkit.completion': 'done',
      ...leakyAttributes(),
    },
  });
  span.addEvent('log', {
    'log.message': `calling with key ${LIVE_KEY}`,
    subscriptionKey: LIVE_KEY,
    'user.email': 'ada@example.com',
  });
  span.end();

  await client.flush();
  await new Promise((r) => setTimeout(r, 100));
  await client.destroy();
  return ingested;
}

try {
  for (const [name, input, expected] of KEY_CASES) {
    assert.deepStrictEqual(scrubAttrs(input), expected, name);
  }

  for (const key of TELEMETRY_KEYS) {
    assert.ok(
      !isSecretKey(key),
      `${key} was read as a secret: token counts and TTFT are what cost and latency columns are computed from, so ` +
        'masking them blanks out a dashboard to protect nothing'
    );
  }

  for (const key of SECRET_KEYS) {
    assert.ok(isSecretKey(key), `${key} must be read as a secret`);
  }

  for (const [name, raw, expected] of PATTERN_CASES) {
    assert.deepStrictEqual(
      scrubAttrs({ 'log.message': raw }),
      { 'log.message': expected },
      `${name}: patterns keep the prefix and drop the rest`
    );
  }

  for (const raw of UNTOUCHED_STRINGS) {
    assert.deepStrictEqual(
      scrubAttrs({ 'db.statement': raw }),
      { 'db.statement': raw },
      'a scrubber that reformats innocent payloads makes every dashboard string and every diff suspect'
    );
  }

  const envelope = scrubSecrets({
    traceId: 't',
    spanId: 's',
    spanType: 'function_call',
    createdAt: 'now',
    prompt: `the environment key is ${LIVE_KEY}`,
    completion: 'done',
    statusMessage: `401 rejected for ${LIVE_KEY}`,
    attributes: leakyAttributes(),
    events: [{
      name: 'log',
      timestamp: 'now',
      attributes: { 'log.message': `calling with key ${LIVE_KEY}`, subscriptionKey: LIVE_KEY, 'user.email': 'ada@example.com' },
    }],
  });
  assert.strictEqual(envelope.prompt, 'the environment key is tk_live_***', 'the prompt is a string surface too');
  assert.strictEqual(envelope.completion, 'done');
  assert.strictEqual(envelope.statusMessage, '401 rejected for tk_live_***', 'a 401 message is where a key ends up next');
  assert.strictEqual(envelope.events[0].attributes.subscriptionKey, '***', 'event attributes are scrubbed like span attributes');
  assert.strictEqual(envelope.events[0].attributes['log.message'], 'calling with key tk_live_***');
  assert.strictEqual(envelope.events[0].attributes['user.email'], 'ada@example.com');
  assert.ok(!JSON.stringify(envelope).includes(LIVE_KEY), 'one clear-text key anywhere in the envelope is the whole bug');

  let spans = await collect({});
  assert.strictEqual(spans.length, 1, `expected one ingested span, got ${spans.length}`);
  assert.ok(
    !JSON.stringify(spans[0]).includes(LIVE_KEY),
    'the export path is the only place that matters: nothing on the wire may contain the subscription key'
  );
  assert.strictEqual(JSON.parse(spans[0].attributes['function.result']).subscriptionKey, '***');
  assert.strictEqual(
    JSON.parse(spans[0].attributes['function.result']).ownerEmail,
    'ada@example.com',
    'identity fields are what the Users view is built on and are deliberately not masked'
  );
  assert.strictEqual(JSON.parse(spans[0].attributes['http.request.headers'])['X-Subscription-Key'], '***');
  assert.strictEqual(
    JSON.parse(spans[0].attributes['http.request.headers'])['content-type'],
    'application/json',
    'only the credential headers go; a span with no headers left is not debuggable'
  );
  assert.strictEqual(spans[0].tokensIn, 11, 'scrubbing must not disturb the metrics');
  assert.strictEqual(spans[0].attributes['url.full'], 'https://api.example.com/charge');
  assert.strictEqual(
    spans[0].attributes['evalkit.content_captured'],
    undefined,
    'the scrubber is not a content switch, so it must not claim content was stripped'
  );

  spans = await collect({ captureSecrets: true });
  assert.strictEqual(
    JSON.parse(spans[0].attributes['function.result']).subscriptionKey,
    LIVE_KEY,
    'captureSecrets is the escape hatch for someone debugging their own auth, so it has to be a real bypass'
  );

  process.env.EVALKIT_CAPTURE_SECRETS = '1';
  spans = await collect({});
  assert.strictEqual(
    JSON.parse(spans[0].attributes['function.result']).subscriptionKey,
    LIVE_KEY,
    'the opt-out has to work without a code change, so one image can ship to environments with different rules'
  );
  delete process.env.EVALKIT_CAPTURE_SECRETS;

  process.env.EVALKIT_CAPTURE_SECRETS = '1';
  spans = await collect({ captureSecrets: false });
  assert.strictEqual(
    JSON.parse(spans[0].attributes['function.result']).subscriptionKey,
    '***',
    'an explicit option must beat the environment, otherwise a stray variable in a shell profile silently leaks keys'
  );
  delete process.env.EVALKIT_CAPTURE_SECRETS;

  spans = await collect({ captureContent: false });
  assert.strictEqual(spans[0].attributes['function.result'], undefined, 'stripping content removes strictly more');
  assert.ok(!JSON.stringify(spans[0]).includes(LIVE_KEY), 'the two controls have to compose');

  const seenPrompts = [];
  await collect({ mask: (span) => { seenPrompts.push(span.prompt); return span; } });
  assert.deepStrictEqual(
    seenPrompts,
    ['the environment key is tk_live_***'],
    'a mask hook is customer code, so handing it the clear-text key would leak the credential into whatever it logs'
  );

  console.log('PASS: secrets e2e');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? err?.message ?? err);
}
