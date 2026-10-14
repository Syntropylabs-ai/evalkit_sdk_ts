import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ingestBody } from './_ingest.mjs';
import { startMockLlm } from './_mock-llm.mjs';
import { init, patchAnthropicClient, patchCohereClient, patchOpenAIClient } from '../dist/index.mjs';

// The SDK must never break the app it instruments. Its own errors stay inside it and the call goes on;
// the provider's errors reach the app unchanged; what the app gets back keeps every method and property;
// streams pass through as they arrive and end their span once however they end; the request is never
// changed; and nothing is left rejecting unhandled. Run with --expose-gc for the unread-stream case.

const unhandled = [];
process.on('unhandledRejection', (reason) => { unhandled.push(reason); });

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.message ?? err}`);
  }
};
setTimeout(() => { console.error(results.join('\n')); console.error('FAIL: timeout'); process.exit(1); }, 60000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'instrumentation-safety-test', scheduledDelayMillis: 50 });
await sleep(400);
const mock = await startMockLlm();
const { default: OpenAI } = await import('openai');
const { Stream } = await import('openai/streaming');
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const openai = new OpenAI({ baseURL: `${mock.url}/v1`, apiKey: 'sk-test-000000000000000000', maxRetries: 0 });
const anthropic = new Anthropic({ baseURL: mock.url, apiKey: 'test-anthropic-key', maxRetries: 0 });
const MESSAGES = [{ role: 'user', content: 'Where is order 1001?' }];
const chat = (extra = {}) => ({ model: 'text', messages: MESSAGES, ...extra });

const spans = async (operation) => {
  await client.flush();
  await sleep(150);
  const found = ingested.filter((e) => e.spanType === 'llm_call' && (!operation || e.operation === operation));
  ingested.length = 0;
  return found;
};
const oneSpan = async (operation) => {
  const found = await spans(operation);
  assert.strictEqual(found.length, 1, `expected one ${operation ?? 'llm_call'} span, got ${found.length}`);
  return found[0];
};
const textOf = (chunks) => chunks.map((c) => c?.choices?.[0]?.delta?.content ?? '').join('');
const scripted = (steps) => ({
  async *[Symbol.asyncIterator]() {
    for (const step of steps) { await sleep(step.after ?? 2); yield step.value; }
  },
});

// 1. The SDK's own errors never reach the app.
await check('a hook that throws while starting the span: the call runs untraced and returns its value', async () => {
  const startSpan = client.tracer.startSpan;
  client.tracer.startSpan = () => { throw new Error('sdk bug'); };
  try {
    const reply = await openai.chat.completions.create(chat());
    assert.strictEqual(reply.choices[0].message.content, 'Order 1001 shipped.');
    const stream = await openai.chat.completions.create(chat({ stream: true }));
    const chunks = [];
    for await (const c of stream) chunks.push(c);
    assert.strictEqual(textOf(chunks), 'Order 1001 shipped.');
    const message = await anthropic.messages.create({ model: 'text', max_tokens: 64, messages: MESSAGES });
    assert.strictEqual(message.content[0].text, 'Order 1001 shipped.');
    const response = await openai.responses.create({ model: 'text', input: 'hi' });
    assert.strictEqual(response.output_text, 'Order 1001 shipped.');
  } finally {
    client.tracer.startSpan = startSpan;
  }
  await spans();
});

await check('a hook that throws while reading the reply: the app still gets the reply, the span still ends', async () => {
  const reply = { id: 'x', model: 'm', get choices() { throw new Error('a getter the SDK trips on'); }, get usage() { throw new Error('again'); } };
  const fake = { chat: { completions: { create: async () => reply } } };
  patchOpenAIClient(fake);
  assert.strictEqual(await fake.chat.completions.create(chat()), reply);
  assert.strictEqual((await oneSpan()).status, 'OK');
});

await check('a hook that throws on a stream chunk: every chunk still reaches the app', async () => {
  const bad = { get choices() { throw new Error('a chunk the SDK trips on'); } };
  const fake = { chat: { completions: { create: async () => scripted([{ value: { choices: [{ delta: { content: 'a' } }] } }, { value: bad }, { value: { choices: [{ delta: { content: 'b' } }] } }]) } } };
  patchOpenAIClient(fake);
  const seen = [];
  for await (const c of await fake.chat.completions.create(chat({ stream: true }))) seen.push(c);
  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[1], bad, 'the chunk object itself is passed through');
  assert.strictEqual((await oneSpan()).completion, 'ab');
});

// 2. The provider's errors reach the app unchanged.
await check('an API error keeps its class, message, status, headers and request id', async () => {
  const err = await openai.chat.completions.create(chat({ model: 'fail' })).catch((e) => e);
  assert.ok(err instanceof OpenAI.BadRequestError, `got ${err?.constructor?.name}`);
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.headers['x-request-id'], 'req_fail_1');
  assert.match(err.message, /forced failure/);
  const anthropicErr = await anthropic.messages.create({ model: 'fail', max_tokens: 8, messages: MESSAGES }).catch((e) => e);
  assert.ok(anthropicErr instanceof Anthropic.BadRequestError);
  assert.strictEqual(anthropicErr.status, 400);
  assert.strictEqual((await spans()).every((s) => s.status === 'ERROR'), true);
});

await check('the error object is the one the SDK raised, with its cause; a synchronous throw stays synchronous', async () => {
  const raised = Object.assign(new Error('provider down', { cause: new Error('socket') }), { status: 503 });
  const fake = { chat: { completions: { create: async () => { throw raised; } } } };
  patchOpenAIClient(fake);
  const caught = await fake.chat.completions.create(chat()).catch((e) => e);
  assert.strictEqual(caught, raised);
  assert.strictEqual(caught.cause.message, 'socket');
  const sync = { messages: { create: () => { throw raised; } } };
  patchAnthropicClient(sync);
  assert.throws(() => sync.messages.create({ model: 'm', messages: [] }), (e) => e === raised);
  await spans();
});

// 3. What the app gets back keeps every method and property.
await check('chat.completions.create keeps its APIPromise: withResponse(), asResponse(), and beta parse()', async () => {
  const { data, response } = await openai.chat.completions.create(chat()).withResponse();
  assert.strictEqual(data.choices[0].message.content, 'Order 1001 shipped.');
  assert.strictEqual(response.status, 200);
  const raw = await openai.chat.completions.create(chat()).asResponse();
  assert.strictEqual((await raw.json()).id, 'chatcmpl-mock', 'the raw body is left for the app to read');
  const parsed = await openai.beta.chat.completions.parse(chat());
  assert.strictEqual(parsed.choices[0].message.content, 'Order 1001 shipped.');
  await spans();
});

await check('a streamed reply is the SDK Stream itself: instanceof, controller, tee(), toReadableStream()', async () => {
  const stream = await openai.chat.completions.create(chat({ stream: true }));
  assert.ok(stream instanceof Stream, 'instanceof Stream');
  assert.ok(stream.controller instanceof AbortController, 'controller');
  const [left, right] = stream.tee();
  const a = []; const b = [];
  await Promise.all([(async () => { for await (const c of left) a.push(c); })(), (async () => { for await (const c of right) b.push(c); })()]);
  assert.strictEqual(textOf(a), 'Order 1001 shipped.');
  assert.strictEqual(textOf(b), 'Order 1001 shipped.');
  assert.strictEqual((await oneSpan()).completion, 'Order 1001 shipped.', 'tee() reads the stream once and its span ends once');
  const readable = (await openai.chat.completions.create(chat({ stream: true }))).toReadableStream();
  const reader = readable.getReader();
  let bytes = 0;
  for (let r = await reader.read(); !r.done; r = await reader.read()) bytes += r.value.length;
  assert.ok(bytes > 0);
  assert.strictEqual((await oneSpan()).completion, 'Order 1001 shipped.');
  const { data } = await openai.chat.completions.create(chat({ stream: true })).withResponse();
  for await (const _ of data) { /* drain */ }
  await oneSpan();
});

await check('the chat stream helper still assembles its own result', async () => {
  const helper = openai.beta.chat.completions.stream(chat());
  assert.strictEqual(await helper.finalContent(), 'Order 1001 shipped.');
  await oneSpan();
});

await check("Anthropic's MessageStream: on(), finalMessage(), finalText(), done(), currentMessage, abort()", async () => {
  const helper = anthropic.messages.stream({ model: 'text', max_tokens: 64, messages: MESSAGES });
  const texts = [];
  let current;
  helper.on('text', (t) => { texts.push(t); current = helper.currentMessage; });
  assert.strictEqual(await helper.finalText(), 'Order 1001 shipped.');
  await helper.done();
  assert.strictEqual(texts.join(''), 'Order 1001 shipped.');
  assert.strictEqual(current?.id, 'msg_mock', 'currentMessage is the snapshot while the stream runs');
  assert.strictEqual((await helper.finalMessage()).id, 'msg_mock');
  await oneSpan();
  const aborted = anthropic.messages.stream({ model: 'drip', max_tokens: 64, messages: MESSAGES });
  aborted.on('error', () => {});
  aborted.on('text', () => aborted.abort());
  await aborted.done().catch(() => {});
  await sleep(50);
  assert.strictEqual((await spans()).length, 1, 'an aborted MessageStream ends its span once');
  const { response } = await anthropic.messages.create({ model: 'text', max_tokens: 8, messages: MESSAGES }).withResponse();
  assert.strictEqual(response.status, 200);
  await spans();
});

await check('the Responses helpers: stream(), parse() and withResponse()', async () => {
  const stream = openai.responses.stream({ model: 'text', input: 'hi' });
  const types = [];
  for await (const e of stream) types.push(e.type);
  assert.ok(types.includes('response.completed'));
  assert.strictEqual((await stream.finalResponse()).id, 'resp_mock');
  await oneSpan('responses.create');
  const parsed = await openai.responses.parse({ model: 'text', input: 'hi' });
  assert.strictEqual(parsed.id, 'resp_mock');
  const { response } = await openai.responses.create({ model: 'text', input: 'hi' }).withResponse();
  assert.strictEqual(response.status, 200);
  assert.strictEqual((await spans('responses.create')).length, 2);
});

// 4. Streams pass through and end their span once, however they end.
await check('chunks reach the app as they arrive', async () => {
  const stream = await openai.chat.completions.create(chat({ model: 'drip', stream: true }));
  const arrivals = [];
  for await (const _ of stream) arrivals.push(Date.now());
  assert.ok(arrivals.at(-1) - arrivals[0] >= 150, 'the SDK did not read ahead and hand over the stream at the end');
  await oneSpan();
});

await check('break, return(), abort() and an AbortSignal each end the span once', async () => {
  let stream = await openai.chat.completions.create(chat({ model: 'drip', stream: true }));
  for await (const _ of stream) break;
  let span = await oneSpan();
  assert.strictEqual(span.status, 'OK', 'leaving early is the app\'s choice, not an error');

  stream = await openai.chat.completions.create(chat({ model: 'drip', stream: true }));
  const it = stream[Symbol.asyncIterator]();
  await it.next();
  await it.return();
  await oneSpan();

  stream = await openai.chat.completions.create(chat({ model: 'drip', stream: true }));
  stream.controller.abort();
  await sleep(50);
  await oneSpan();

  const controller = new AbortController();
  stream = await openai.chat.completions.create(chat({ model: 'drip', stream: true }), { signal: controller.signal });
  const seen = [];
  try { for await (const c of stream) { seen.push(c); if (seen.length === 2) controller.abort(); } } catch {}
  await sleep(50);
  span = await oneSpan();
  assert.ok(span.completion !== undefined);
});

await check('a stream the app never reads ends its span once it is collected', async () => {
  if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');
  await (async () => { await openai.chat.completions.create(chat({ stream: true })); })();
  for (let i = 0; i < 20 && ingested.filter((e) => e.spanType === 'llm_call').length === 0; i++) {
    globalThis.gc();
    await sleep(50);
    await client.flush();
  }
  await oneSpan();
});

await check('assembled text and tool arguments are capped', async () => {
  const huge = 'y'.repeat(100_000);
  const fake = { chat: { completions: { create: async () => scripted([
    ...Array.from({ length: 4 }, () => ({ value: { choices: [{ delta: { content: huge } }] } })),
    { value: { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: 'z'.repeat(50_000) } }] } }] } },
  ]) } } };
  patchOpenAIClient(fake);
  for await (const _ of await fake.chat.completions.create(chat({ stream: true }))) { /* drain */ }
  const span = await oneSpan();
  assert.ok(span.completion.length <= 256 * 1024 + 1 && span.completion.endsWith('…'), `completion is ${span.completion.length} long`);
  const args = span.events.find((e) => e.name === 'gen_ai.tool.call').attributes['gen_ai.tool.call.arguments'];
  assert.ok(args.length <= 32769, `arguments are ${args.length} long`);
});

// 5. The request is never changed.
await check('params are not changed, and nothing is added to the request the provider gets', async () => {
  const deepFreeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o); };
  const params = deepFreeze({ model: 'text', messages: [{ role: 'user', content: 'hi' }], stream: true });
  const before = JSON.stringify(params);
  mock.requests.length = 0;
  for await (const _ of await openai.chat.completions.create(params)) { /* drain */ }
  assert.strictEqual(JSON.stringify(params), before);
  assert.deepStrictEqual(mock.requests[0].body, JSON.parse(before), 'no stream_options or any other field was injected');
  await spans();
});

// 6. Missing exports and methods, and patching twice.
await check('patching what lacks the methods, or patching twice, neither throws nor doubles', async () => {
  patchOpenAIClient({});
  patchOpenAIClient({ chat: {} });
  patchAnthropicClient({});
  patchCohereClient({});
  patchOpenAIClient(openai);
  patchOpenAIClient(openai);
  await openai.chat.completions.create(chat());
  await oneSpan();
});

// 7. Context and rejections.
await check('AsyncLocalStorage context survives the await, the stream and the helper callbacks', async () => {
  const als = new AsyncLocalStorage();
  await als.run('app-ctx', async () => {
    const stream = await openai.chat.completions.create(chat({ stream: true }));
    assert.strictEqual(als.getStore(), 'app-ctx');
    for await (const _ of stream) assert.strictEqual(als.getStore(), 'app-ctx');
    const stores = [];
    const helper = anthropic.messages.stream({ model: 'text', max_tokens: 64, messages: MESSAGES });
    helper.on('text', () => stores.push(als.getStore()));
    await helper.finalText();
    assert.ok(stores.length > 0 && stores.every((s) => s === 'app-ctx'));
  });
  await spans();
});

await check('no unhandled rejections, including for a failed call read only through asResponse()', async () => {
  const raw = await openai.chat.completions.create(chat({ model: 'fail' })).asResponse().catch((e) => e);
  assert.ok(raw);
  await sleep(100);
  assert.deepStrictEqual(unhandled.map(String), []);
  await spans();
});

await mock.close();
console.log(results.join('\n'));
if (results.some((r) => r.startsWith('FAIL'))) {
  console.error('FAIL: instrumentation-safety.e2e.mjs');
  process.exit(1);
}
console.log('PASS instrumentation-safety.e2e.mjs');
process.exit(0);
