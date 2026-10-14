import assert from 'node:assert';
import { trace } from '@opentelemetry/api';
import { ingestBody } from './_ingest.mjs';
import { init } from '../dist/index.mjs';

// With captureContent: false, nothing anyone said, sent or got back leaves the process, whichever library
// recorded it: the GenAI semantic conventions' message attributes and events, their earlier spellings,
// and the content other instrumentation libraries write. What a call measured stays.

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'content-capture-off-test',
  scheduledDelayMillis: 50,
  captureContent: false,
});

const SECRET = 'my card is 4242 4242 4242 4242';
const tracer = trace.getTracer('some.other.genai.library');

const span = tracer.startSpan('chat gpt-4o', {
  attributes: {
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': 'gpt-4o',
    'gen_ai.response.model': 'gpt-4o-2024-08-06',
    'gen_ai.usage.input_tokens': 42,
    'gen_ai.usage.output_tokens': 7,
    'gen_ai.server.time_to_first_token': 0.21,
    'gen_ai.request.tools': ['lookup_order'],
    'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: SECRET }] }]),
    'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: `noted: ${SECRET}` }] }]),
    'gen_ai.system_instructions': `You are a billing agent. ${SECRET}`,
    'gen_ai.prompt': SECRET,
    'gen_ai.completion': SECRET,
    'gen_ai.prompt.0.content': SECRET,
    'gen_ai.prompt.0.role': 'user',
    'gen_ai.completion.0.content': SECRET,
    'llm.input_messages.0.message.content': SECRET,
    'input.value': SECRET,
    'output.value': SECRET,
    'ai.prompt.messages': SECRET,
    'ai.response.text': SECRET,
  },
});
span.addEvent('gen_ai.user.message', { content: SECRET, role: 'user' });
span.addEvent('gen_ai.system.message', { content: SECRET });
span.addEvent('gen_ai.choice', {
  index: 0,
  finish_reason: 'tool_calls',
  message: JSON.stringify({ role: 'assistant', content: SECRET }),
  tool_calls: JSON.stringify([{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: JSON.stringify({ note: SECRET }) } }]),
});
span.addEvent('gen_ai.client.inference.operation.details', {
  'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: SECRET }] }]),
  'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: SECRET }] }]),
});
span.end();

const tool = tracer.startSpan('execute_tool lookup_order', {
  attributes: {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': 'lookup_order',
    'gen_ai.tool.call.id': 'call_1',
    'gen_ai.tool.call.arguments': JSON.stringify({ note: SECRET }),
    'gen_ai.tool.call.result': JSON.stringify({ echoed: SECRET }),
  },
});
tool.addEvent('gen_ai.tool.message', { content: SECRET, id: 'call_1', role: 'tool' });
tool.end();

try {
  await client.flush();
  await sleep(200);
  const chat = ingested.find((e) => e.operation === 'chat gpt-4o');
  const toolSpan = ingested.find((e) => e.spanType === 'tool_call');
  assert.ok(chat && toolSpan, 'both spans exported');
  for (const e of [chat, toolSpan]) {
    assert.ok(!JSON.stringify(e).includes('4242'), `message text left the process: ${JSON.stringify(e)}`);
    assert.strictEqual(e.prompt, undefined);
    assert.strictEqual(e.completion, undefined);
    assert.strictEqual(e.attributes['evalkit.content_captured'], false);
  }
  assert.strictEqual(chat.model, 'gpt-4o-2024-08-06', 'the model stays');
  assert.strictEqual(chat.tokensIn, 42, 'tokens stay');
  assert.strictEqual(chat.tokensOut, 7);
  assert.strictEqual(chat.attributes['gen_ai.server.time_to_first_token'], 0.21, 'timing stays');
  assert.deepStrictEqual(chat.attributes['gen_ai.request.tools'], ['lookup_order'], 'tool names stay');
  assert.strictEqual(chat.attributes['gen_ai.prompt.0.role'], undefined, 'indexed message attributes go with their prefix');
  const choice = chat.events.find((e) => e.name === 'gen_ai.choice');
  assert.strictEqual(choice.attributes.finish_reason, 'tool_calls', 'the event stays, without its message');
  assert.deepStrictEqual(JSON.parse(choice.attributes.tool_calls), [{ id: 'call_1', type: 'function', function: { name: 'lookup_order' } }],
    'a message event keeps the names of the tools it asked for, not their arguments');
  assert.strictEqual(chat.events.find((e) => e.name === 'gen_ai.user.message').attributes.role, 'user');
  assert.strictEqual(toolSpan.attributes['gen_ai.tool.name'], 'lookup_order', 'a tool span keeps its tool name');
  assert.strictEqual(toolSpan.attributes['gen_ai.tool.call.id'], 'call_1');

  console.log('PASS content-capture-off.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
