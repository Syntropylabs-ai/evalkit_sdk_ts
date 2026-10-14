import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';
import { init, isSecretKey, scrubSecrets, startSpan, traceFunction, flush } from '../dist/index.mjs';

// camelCase and PascalCase credential keys (accessToken, secretKey, ClientSecret) are masked wherever a key
// is read: span and event attributes, JSON bodies, JSON a cut left unparseable, quoted assignments in text,
// URL query keys, and on the wire. Counts, prices and flags about a token keep their values. The rule is the
// Python SDK's, so one key masks the same way from either SDK.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'FAKECAMELSECRET0123456789';
const envelope = (attributes, events = []) =>
  scrubSecrets({ traceId: 't', spanId: 's', spanType: 'function_call', createdAt: 'now', attributes, events });

const SECRET_KEYS = [
  'accessToken', 'authToken', 'refreshToken', 'idToken', 'sessionToken', 'csrfToken', 'bearerToken',
  'githubToken', 'secretKey', 'clientSecret', 'privateKey', 'xApiKey', 'apiKey', 'apiSecret',
  'userPassword', 'awsSecretAccessKey', 'subscriptionKey', 'authorizationHeader',
  'AccessToken', 'RefreshToken', 'SecretKey', 'ClientSecret', 'ApiKey', 'PrivateKey',
  'oauth.accessToken', 'app.secretKey', 'auth.refreshToken', 'stripe.apiSecret',
];

const KEPT_KEYS = [
  // Flags about a token hold a yes or no.
  'hasToken', 'isTokenValid', 'needsToken', 'usesToken', 'requiresToken', 'withToken', 'noToken',
  'supportsToken', 'missingToken', 'HasToken',
  // Counts and prices.
  'tokenCount', 'maxTokens', 'inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens',
  'promptTokenCount', 'completionTokens', 'reasoningTokens', 'MaxTokens', 'TotalTokens', 'tokensIn',
  'inputCostPerToken', 'outputCostPerToken', 'inputCostPerAudioToken', 'outputCostPerReasoningToken',
  'costPerCachedInputToken', 'pricePerToken', 'timeToFirstToken', 'timePerOutputToken', 'tokenizer',
  // Names that hold no credential.
  'publicKey', 'keyId', 'userId', 'sessionId', 'monkey', 'authorName',
];

try {
  for (const key of SECRET_KEYS) assert.strictEqual(isSecretKey(key), true, `${key} holds a credential`);
  for (const key of KEPT_KEYS) assert.strictEqual(isSecretKey(key), false, `${key} is a count, a price or a flag`);

  // Span attributes and event attributes, by key.
  const attrs = envelope(
    { accessToken: KEY, 'app.secretKey': KEY, ClientSecret: KEY, maxTokens: 64, hasToken: true, 'gen_ai.usage.input_tokens': 12 },
    [{ name: 'log', timestamp: 'now', attributes: { refreshToken: KEY, tokenCount: 3, 'log.message': 'ok' } }],
  );
  assert.deepStrictEqual(attrs.attributes, {
    accessToken: '***', 'app.secretKey': '***', ClientSecret: '***', maxTokens: 64, hasToken: true, 'gen_ai.usage.input_tokens': 12,
  });
  assert.deepStrictEqual(attrs.events[0].attributes, { refreshToken: '***', tokenCount: 3, 'log.message': 'ok' });

  // A JSON body: members by key, at any depth; counts, prices and flags kept as numbers and booleans.
  const body = {
    user: 'ada@example.com',
    auth: { accessToken: KEY, refreshToken: KEY, expiresIn: 3600 },
    client: { clientId: 'web', clientSecret: KEY },
    vault: [{ SecretKey: KEY, keyId: 'k1' }],
    settings: { apiKey: KEY, hasToken: true, isTokenValid: false, maxTokens: 256 },
    usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9, cachedTokens: 0 },
    pricing: { inputCostPerToken: 0.000001, inputCostPerAudioToken: 0.00004 },
  };
  const scrubbedBody = JSON.parse(envelope({ 'http.request.body': JSON.stringify(body) }).attributes['http.request.body']);
  assert.deepStrictEqual(scrubbedBody, {
    ...body,
    auth: { accessToken: '***', refreshToken: '***', expiresIn: 3600 },
    client: { clientId: 'web', clientSecret: '***' },
    vault: [{ SecretKey: '***', keyId: 'k1' }],
    settings: { apiKey: '***', hasToken: true, isTokenValid: false, maxTokens: 256 },
  });

  // JSON a cut left unparseable, including a value the cut ran through.
  const cut = `{"user":"ada","authToken":"${KEY}","maxTokens":"64","hasToken":"yes","session":{"refreshToken":"${KEY.slice(0, 10)}`;
  const cutOut = envelope({ 'http.response.body': cut }).attributes['http.response.body'];
  assert.strictEqual(cutOut, '{"user":"ada","authToken":"***","maxTokens":"64","hasToken":"yes","session":{"refreshToken":"***');

  // Quoted assignments in text and URL query keys.
  const text = envelope({ 'log.message': `Creds(accessToken='${KEY}', hasToken: 'yes', maxTokens: '5')` }).attributes['log.message'];
  assert.strictEqual(text, "Creds(accessToken='***', hasToken: 'yes', maxTokens: '5')");
  const url = envelope({ 'http.url': `https://h/cb?accessToken=${KEY}&maxTokens=5&hasToken=1` }).attributes['http.url'];
  assert.strictEqual(url, 'https://h/cb?accessToken=***&maxTokens=5&hasToken=1');

  // On the wire, through the export path.
  init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'secrets-camel-test', scheduledDelayMillis: 50 });
  const span = startSpan('camel.keys', { accessToken: KEY, secretKey: KEY, maxTokens: 64, hasToken: true });
  span.end('OK', { 'http.response.body': JSON.stringify({ refreshToken: KEY, clientSecret: KEY, totalTokens: 9 }) });
  // A parameter named for a flag keeps its value; one named for a token is masked.
  const check = traceFunction('session.check', function check(hasToken, accessToken) { return { ok: hasToken }; });
  check(true, KEY);
  await flush();
  await sleep(200);
  const wire = ingested.find((e) => e.operation === 'camel.keys');
  assert.ok(wire, 'the span was exported');
  assert.ok(!JSON.stringify(ingested).includes(KEY), 'no camelCase credential leaves the process');
  assert.strictEqual(wire.attributes.accessToken, '***');
  assert.strictEqual(wire.attributes.secretKey, '***');
  assert.strictEqual(wire.attributes.maxTokens, 64);
  assert.strictEqual(wire.attributes.hasToken, true);
  assert.deepStrictEqual(JSON.parse(wire.attributes['http.response.body']), { refreshToken: '***', clientSecret: '***', totalTokens: 9 });
  const fn = ingested.find((e) => e.operation === 'session.check');
  assert.strictEqual(fn.attributes['function.args'], '[true,"***"]', 'masked by parameter name, the flag kept');

  console.log('PASS secrets-camel.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
