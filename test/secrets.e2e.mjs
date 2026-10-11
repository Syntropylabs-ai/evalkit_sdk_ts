import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { EvalKitClient, scrubSecrets, isSecretKey } from '../dist/index.mjs';

let ingested = [];

globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
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
  'gen_ai.server.time_to_first_token',
  'gen_ai.server.time_per_output_token',
  'GEN_AI.SERVER.TIME_TO_FIRST_TOKEN',
  'time-to-first-token',
  'input_cost_per_token',
  'output_cost_per_token',
  'cost_per_token',
  'gen_ai.usage.output_tokens',
  'llm.usage.total_tokens',
  'llm.token_count.prompt',
  'gen_ai.request.max_tokens',
  'max_tokens',
  'max_completion_tokens',
  'maxTokens',
];

const SECRET_KEYS = [
  'apiKey', 'API_KEY', 'SubscriptionKey', 'Set-Cookie', 'AWS_SECRET_ACCESS_KEY', 'X-Auth-Token', 'access_token',
  // The time-to-first-token and per-token exemption is a vocabulary, not a loophole: any other key
  // ending in token can still hold a credential.
  'token', 'refresh_token', 'id_token', 'auth_token', 'csrf_token', 'session_token', 'bearer_token', 'api_token',
  'github_token', 'oauth.token', 'x-access-token', 'first_token', 'per_user_token',
];

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

const URL_CASES = [
  [
    'api_key in the query of http.url is masked and page is kept',
    'http.url',
    'https://api.example.com/v1/x?api_key=AKIAIOSFODNN7EXAMPLE&page=2',
    'https://api.example.com/v1/x?api_key=***&page=2',
  ],
  [
    'userinfo is masked',
    'url.full',
    'https://user:pass@api.example.com/v1/x',
    'https://***@api.example.com/v1/x',
  ],
  [
    'a key used as the username',
    'url.full',
    `https://${LIVE_KEY}@api.example.com/v1/x`,
    'https://***@api.example.com/v1/x',
  ],
  [
    'an unrelated query is untouched',
    'http.url',
    'https://api.example.com/search?q=hello&page=2',
    'https://api.example.com/search?q=hello&page=2',
  ],
  [
    'http.target is path and query without a scheme',
    'http.target',
    '/v1/x?access_token=abc&limit=5',
    '/v1/x?access_token=***&limit=5',
  ],
  [
    'url.query is a bare query string',
    'url.query',
    'sig=abc&se=2026-01-01',
    'sig=***&se=2026-01-01',
  ],
  [
    'server.address is a plain host',
    'server.address',
    'api.example.com',
    'api.example.com',
  ],
  [
    'a scheme-prefixed string under any key is a url',
    'tool.args',
    'wss://h/socket?token=abc',
    'wss://h/socket?token=***',
  ],
  [
    'query keys match case-insensitively and after url-decoding',
    'http.url',
    'https://h/p?api%5Fkey=a&API_KEY=b&Signature=c&sig=d&stream_key=e&key_id=keep&keyword=keep',
    'https://h/p?api%5Fkey=***&API_KEY=***&Signature=***&sig=***&stream_key=***&key_id=keep&keyword=keep',
  ],
  [
    'fragment parameters are masked like query parameters',
    'http.url',
    'https://app.example.com/cb#access_token=abc&token_type=bearer',
    'https://app.example.com/cb#access_token=***&token_type=bearer',
  ],
  [
    'flags, empty params and repeated equals are kept as they were',
    'http.url',
    'https://h/p?flag&token=abc&&x=1=2',
    'https://h/p?flag&token=***&&x=1=2',
  ],
  [
    'a url inside prose is free text, not a url',
    'log.message',
    'See https://example.com/x?token=abc for details',
    'See https://example.com/x?token=abc for details',
  ],
  [
    'prose around a url still gets pattern scrubbing',
    'log.message',
    `See https://example.com/x?key=${LIVE_KEY} for details`,
    'See https://example.com/x?key=tk_live_*** for details',
  ],
];

const NESTED_URL_CASES = [
  [
    'a url inside a json request body',
    '{"url": "https://h/p?token=abc"}',
    { url: 'https://h/p?token=***' },
  ],
  [
    'a url inside a json array of objects',
    '[{"endpoint": "https://h/p?api_key=abc"}, {"endpoint": "https://h/q?page=2"}]',
    [{ endpoint: 'https://h/p?api_key=***' }, { endpoint: 'https://h/q?page=2' }],
  ],
];

const OPERATION_CASES = [
  [
    'a subscription key in the operation query is pattern scrubbed',
    `GET /v1/traces?key=${LIVE_KEY}`,
    'GET /v1/traces?key=tk_live_***',
  ],
  [
    'the operation is free text, so a plain query value is left alone',
    'GET /v1/traces?key=abc123',
    'GET /v1/traces?key=abc123',
  ],
  [
    'an ordinary operation name is untouched',
    'TracingService.findById',
    'TracingService.findById',
  ],
];

const PROSE_URL = 'See https://example.com/x?token=abc for details';

const nestedUrlJson = (levels) => {
  let leaf = { url: 'https://h/p?token=abc' };
  for (let i = 0; i < levels; i += 1) leaf = { a: leaf };
  return JSON.stringify(leaf);
};

const scrubEnvelope = (fields) =>
  scrubSecrets({ traceId: 't', spanId: 's', spanType: 'function_call', createdAt: 'now', ...fields });

const leakyAttributes = () => ({
  'function.result': JSON.stringify({ id: 'env_1', subscriptionKey: LIVE_KEY, ownerEmail: 'ada@example.com' }),
  'function.args': JSON.stringify([{ credentials: { subscriptionKey: LIVE_KEY, password: 'hunter2' } }, { email: 'ada@example.com' }]),
  'http.request.headers': JSON.stringify({ 'X-Subscription-Key': LIVE_KEY, authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.abc', 'content-type': 'application/json' }),
  'gen_ai.usage.input_tokens': 11,
  'url.full': 'https://api.example.com/charge',
  'http.url': `https://api.example.com/v1/x?api_key=${LIVE_KEY}&page=2`,
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

  const span = client.tracer.startSpan(`GET /v1/traces?key=${LIVE_KEY}`, {
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

  const bridged = {
    'gen_ai.server.time_to_first_token': 0.42,
    'gen_ai.server.time_per_output_token': 0.012,
    'gen_ai.request.max_tokens': 256,
    'gen_ai.usage.input_tokens': 120,
    'gen_ai.usage.output_tokens': 30,
    auth_token: 'abc123',
  };
  assert.deepStrictEqual(
    scrubAttrs({ ...bridged }),
    { ...bridged, auth_token: '***' },
    'OpenTelemetry instrumentations report time-to-first-token as gen_ai.server.time_to_first_token; masking it ' +
      "to *** drops the span's TTFT from every latency view"
  );

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

  for (const [name, key, raw, expected] of URL_CASES) {
    assert.deepStrictEqual(scrubAttrs({ [key]: raw }), { [key]: expected }, name);
  }

  for (const [name, key, , expected] of URL_CASES) {
    if (key === 'log.message') continue;
    assert.deepStrictEqual(scrubAttrs({ [key]: expected }), { [key]: expected }, `${name}: scrubbing twice is idempotent`);
  }

  for (const raw of ['https://api.example.com/charge', 'https://@h/p']) {
    assert.deepStrictEqual(scrubAttrs({ 'url.full': raw }), { 'url.full': raw }, 'a url without a query or userinfo is left byte for byte');
  }

  for (const [name, raw, expected] of NESTED_URL_CASES) {
    assert.deepStrictEqual(JSON.parse(scrubAttrs({ 'request.body': raw })['request.body']), expected, name);
  }

  const shallow = scrubAttrs({ 'request.body': nestedUrlJson(3) })['request.body'];
  assert.ok(shallow.includes('token=***') && !shallow.includes('token=abc'), 'a url three objects deep is still masked');
  const deep = nestedUrlJson(20);
  assert.strictEqual(scrubAttrs({ 'request.body': deep })['request.body'], deep, 'the depth limit still applies to nested urls');

  for (const [name, raw, expected] of OPERATION_CASES) {
    assert.strictEqual(scrubEnvelope({ operation: raw }).operation, expected, name);
  }

  const prose = scrubEnvelope({ prompt: PROSE_URL, completion: `See https://example.com/x?key=${LIVE_KEY} for details` });
  assert.strictEqual(prose.prompt, PROSE_URL, 'a url inside prompt prose is free text and is not query-masked');
  assert.strictEqual(prose.completion, 'See https://example.com/x?key=tk_live_*** for details', 'prose still gets pattern scrubbing');

  const envelope = scrubSecrets({
    traceId: 't',
    spanId: 's',
    spanType: 'function_call',
    createdAt: 'now',
    operation: `GET /v1/traces?key=${LIVE_KEY}`,
    prompt: `the environment key is ${LIVE_KEY}`,
    completion: 'done',
    statusMessage: `401 rejected for ${LIVE_KEY}`,
    attributes: leakyAttributes(),
    events: [{
      name: 'log',
      timestamp: 'now',
      attributes: {
        'log.message': `calling with key ${LIVE_KEY}`,
        subscriptionKey: LIVE_KEY,
        'user.email': 'ada@example.com',
        'http.url': `https://api.example.com/v1/x?api_key=${LIVE_KEY}`,
      },
    }],
  });
  assert.strictEqual(envelope.operation, 'GET /v1/traces?key=tk_live_***', 'the operation is a string surface too');
  assert.strictEqual(envelope.attributes['http.url'], 'https://api.example.com/v1/x?api_key=***&page=2', 'query credentials are masked, the rest of the url stays');
  assert.strictEqual(envelope.events[0].attributes['http.url'], 'https://api.example.com/v1/x?api_key=***', 'event urls are scrubbed like span urls');
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
  assert.strictEqual(spans[0].attributes['http.url'], 'https://api.example.com/v1/x?api_key=***&page=2', 'url query credentials are masked on the wire');
  assert.strictEqual(spans[0].operation, 'GET /v1/traces?key=tk_live_***', 'the span name is the operation and is scrubbed on the wire');
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
