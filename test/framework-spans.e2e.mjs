import assert from 'node:assert';
import { context, trace } from '@opentelemetry/api';
import { ingestBody } from './_ingest.mjs';

delete process.env.EVALKIT_COUNT_FOREIGN_LLM;

const { init, patchOpenAIClient, patchAnthropicClient } = await import('../dist/index.mjs');

// Spans shaped like the ones Strands Agents 1.59 records under the OpenTelemetry GenAI conventions
// (a refund agent with a lookup_order tool, on an OpenAI-compatible model "mock-sonnet").

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
  serviceName: 'framework-spans',
  scheduledDelayMillis: 50,
});
const tracer = client.tracer;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_TEXT = 'Hi, my blender from order 48213 arrived cracked. I want my money back.';
const REPLY = 'Order 48213 (Vortex blender, $89.99) was delivered on 2 October. Shall I refund it?';
const USAGE = {
  'gen_ai.usage.input_tokens': 328,
  'gen_ai.usage.prompt_tokens': 328,
  'gen_ai.usage.output_tokens': 59,
  'gen_ai.usage.completion_tokens': 59,
  'gen_ai.usage.total_tokens': 387,
};

const within = (parent, fn) => context.with(trace.setSpan(context.active(), parent), fn);

const strandsChat = (name, extra = {}) => {
  const span = tracer.startSpan(name, {
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.system': 'strands-agents',
      'gen_ai.request.model': 'mock-sonnet',
      ...USAGE,
      ...extra,
    },
  });
  span.addEvent('gen_ai.system.message', { content: JSON.stringify([{ text: 'You are the Northwind refund agent.' }]) });
  span.addEvent('gen_ai.user.message', { content: JSON.stringify([{ text: USER_TEXT }]) });
  span.addEvent('gen_ai.choice', { finish_reason: 'end_turn', message: JSON.stringify([{ text: REPLY }]) });
  return span;
};

try {
  // An agent invocation, with the usage Strands accumulates over the whole run.
  const agent = tracer.startSpan('invoke_agent refund-agent', {
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'refund-agent',
      'gen_ai.system': 'strands-agents',
      'gen_ai.request.model': 'mock-sonnet',
      'gen_ai.agent.tools': '["lookup_order", "search_policy"]',
      'gen_ai.usage.input_tokens': 478,
      'gen_ai.usage.output_tokens': 121,
      'session.id': 'strands-ts-1',
    },
  });
  agent.addEvent('gen_ai.system.message', { content: JSON.stringify([{ text: 'You are the Northwind refund agent.' }]) });
  agent.addEvent('gen_ai.user.message', { content: JSON.stringify([{ text: USER_TEXT }]) });
  agent.addEvent('gen_ai.choice', { finish_reason: 'end_turn', message: `${REPLY}\n` });

  const cycle = within(agent, () => tracer.startSpan('execute_event_loop_cycle', {
    attributes: { 'gen_ai.operation.name': 'execute_event_loop_cycle', 'event_loop.cycle_id': 'c-1', ...USAGE },
  }));

  // A model call no SDK instrumentation recorded: the framework's span is the only record of it.
  const lone = within(cycle, () => strandsChat('chat'));
  lone.end();

  const tool = within(cycle, () => tracer.startSpan('execute_tool lookup_order', {
    attributes: {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.system': 'strands-agents',
      'gen_ai.tool.name': 'lookup_order',
      'gen_ai.tool.call.id': 'call_lookup_order_1',
      'gen_ai.tool.status': 'success',
    },
  }));
  tool.addEvent('gen_ai.tool.message', { role: 'tool', id: 'call_lookup_order_1', content: '{"order_id": "48213"}' });
  tool.addEvent('gen_ai.choice', { id: 'call_lookup_order_1', message: JSON.stringify([{ text: '{"order_id": "48213"}' }]) });
  tool.end();

  // A failed tool, named only by the convention's span name.
  const failed = within(cycle, () => tracer.startSpan('execute_tool escalate_to_human', {
    attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.status': 'error' },
  }));
  failed.addEvent('gen_ai.choice', { message: JSON.stringify([{ json: { error: 'queue closed' } }]) });
  failed.end();
  cycle.end();
  agent.end();

  // A model call the SDK's own OpenAI instrumentation recorded inside the framework's chat span.
  const openai = {
    chat: {
      completions: {
        create: async () => ({
          id: 'c1',
          model: 'mock-sonnet',
          choices: [{ message: { content: REPLY }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 328, completion_tokens: 59, total_tokens: 387 },
        }),
      },
    },
  };
  patchOpenAIClient(openai);
  const wrapping = strandsChat('chat', { 'test.case': 'wraps-sdk-call' });
  await within(wrapping, () => openai.chat.completions.create({
    model: 'mock-sonnet',
    messages: [
      { role: 'system', content: 'You are the Northwind refund agent.' },
      { role: 'user', content: [{ type: 'text', text: USER_TEXT }] },
    ],
  }));
  wrapping.end();

  // The SDK's call one span removed from the framework's (an HTTP span between them).
  const outer = strandsChat('chat', { 'test.case': 'wraps-sdk-call-indirectly' });
  const between = within(outer, () => tracer.startSpan('POST /v1/chat/completions'));
  const sdkInner = within(between, () => tracer.startSpan('chat.completions.create', {
    attributes: { 'evalkit.span_type': 'llm_call', 'gen_ai.request.model': 'mock-sonnet', ...USAGE },
  }));
  sdkInner.end();
  between.end();
  outer.end();

  // The patches applied the other way round: the framework's model span runs inside the SDK's.
  const sdkOuter = tracer.startSpan('messages.create', {
    attributes: { 'evalkit.span_type': 'llm_call', 'gen_ai.request.model': 'mock-sonnet', ...USAGE },
  });
  const inside = within(sdkOuter, () => strandsChat('chat', { 'test.case': 'inside-sdk-call' }));
  inside.end();
  sdkOuter.end();

  // An agent named only by its span name, and an unmarked gen_ai span that names no operation.
  tracer.startSpan('invoke_agent helper', { attributes: { 'gen_ai.system': 'strands-agents' } }).end();
  tracer.startSpan('foreign-generate', {
    attributes: { 'gen_ai.system': 'gemini', 'gen_ai.request.model': 'gemini-2.5-flash', 'gen_ai.usage.input_tokens': 50 },
  }).end();

  // Content blocks in the SDK's own prompts read as text, never as "[object Object]".
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
  await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Where is order 48213?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'lookup_order', input: { order_id: '48213' } }] },
    ],
  });

  await client.flush();
  await sleep(300);

  const byId = (span) => {
    const id = span.spanContext().spanId;
    const e = ingested.find((x) => x.spanId === id);
    if (!e) fail(`span ${id} was not exported (got ${ingested.map((x) => x.operation).join(', ')})`);
    return e;
  };
  const byOp = (name) => {
    const e = ingested.find((x) => x.operation === name);
    if (!e) fail(`no ingested span named ${name} (got ${ingested.map((x) => x.operation).join(', ')})`);
    return e;
  };

  // invoke_agent -> agent
  const agentRow = byId(agent);
  assert.strictEqual(agentRow.spanType, 'agent', 'an invoke_agent span is one agent run, and the trace views group by agent spans');
  assert.strictEqual(agentRow.agentName, 'refund-agent');
  assert.strictEqual(agentRow.prompt, USER_TEXT, 'the agent row reads the user message out of its content blocks');
  assert.strictEqual(agentRow.completion, REPLY, 'the agent row carries the reply from gen_ai.choice');
  assert.strictEqual(agentRow.tokensIn, undefined, "the agent's run total would count every model call inside it twice");
  assert.strictEqual(agentRow.tokensOut, undefined);
  assert.strictEqual(agentRow.sessionId, 'strands-ts-1');
  const helper = byOp('invoke_agent helper');
  assert.strictEqual(helper.spanType, 'agent', 'the convention span name alone names an agent invocation');
  assert.strictEqual(helper.agentName, 'helper');

  // execute_event_loop_cycle -> internal
  const cycleRow = byId(cycle);
  assert.strictEqual(cycleRow.spanType, 'internal', 'an event-loop cycle is neither a model call nor a tool call');
  assert.strictEqual(cycleRow.tokensIn, undefined, 'a cycle repeats the usage of the model call inside it');

  // chat with no SDK call -> llm_call with its tokens
  const loneRow = byId(lone);
  assert.strictEqual(loneRow.spanType, 'llm_call', "a framework's model call with no SDK record of it is the model call");
  assert.strictEqual(loneRow.model, 'mock-sonnet');
  assert.strictEqual(loneRow.tokensIn, 328);
  assert.strictEqual(loneRow.tokensOut, 59);
  assert.strictEqual(loneRow.prompt, `system: You are the Northwind refund agent.\nuser: ${USER_TEXT}`);
  assert.strictEqual(loneRow.completion, REPLY);

  // execute_tool -> tool_call with its name, arguments and result
  const toolRow = byId(tool);
  assert.strictEqual(toolRow.spanType, 'tool_call');
  assert.strictEqual(toolRow.operation, 'lookup_order');
  assert.strictEqual(toolRow.attributes['tool.name'], 'lookup_order');
  assert.strictEqual(toolRow.attributes['tool.arguments'], '{"order_id": "48213"}', 'arguments from the gen_ai.tool.message event');
  assert.strictEqual(toolRow.attributes['tool.result'], '{"order_id": "48213"}', 'the result unwrapped from its content blocks');
  assert.notStrictEqual(toolRow.status, 'ERROR', 'gen_ai.tool.status success is not a failure');
  assert.strictEqual(toolRow.tokensIn, undefined);
  const failedRow = byId(failed);
  assert.strictEqual(failedRow.spanType, 'tool_call');
  assert.strictEqual(failedRow.operation, 'escalate_to_human', 'the tool name from the convention span name');
  assert.strictEqual(failedRow.status, 'ERROR', 'gen_ai.tool.status error is a failed tool call');
  assert.strictEqual(failedRow.attributes['tool.result'], '{"error":"queue closed"}', 'a json block stays JSON');

  // chat that duplicates the SDK's own call -> internal, tokens withheld; the SDK's span stays the model call
  const wrappingRow = byId(wrapping);
  assert.strictEqual(wrappingRow.spanType, 'internal', "the SDK's own span is the record of this model call; counting both counts it twice");
  assert.strictEqual(wrappingRow.tokensIn, undefined);
  assert.strictEqual(wrappingRow.tokensOut, undefined);
  const sdkRow = ingested.find((x) => x.parentSpanId === wrapping.spanContext().spanId && x.spanType === 'llm_call');
  if (!sdkRow) fail("the SDK's own OpenAI span under the framework chat span was not exported as llm_call");
  assert.strictEqual(sdkRow.tokensIn, 328);
  assert.strictEqual(
    sdkRow.prompt,
    `system: You are the Northwind refund agent.\nuser: ${USER_TEXT}`,
    'content blocks in the request read as their text, not "[object Object]"',
  );
  assert.strictEqual(byId(outer).spanType, 'internal', 'an SDK call one span removed is still the same model call');
  assert.strictEqual(byId(inside).spanType, 'internal', 'a framework span inside the SDK call is the same model call');
  assert.strictEqual(byId(sdkInner).spanType, 'llm_call');

  // a gen_ai span that names no operation keeps the existing guard
  const foreign = byOp('foreign-generate');
  assert.strictEqual(foreign.spanType, 'function_call');
  assert.strictEqual(foreign.tokensIn, undefined);

  const anthropicRow = ingested.find((x) => x.spanType === 'llm_call' && x.model === 'claude-sonnet-4-5');
  if (!anthropicRow) fail('no Anthropic llm_call span');
  assert.ok(!anthropicRow.prompt.includes('[object Object]'), `anthropic prompt: ${anthropicRow.prompt}`);
  assert.ok(anthropicRow.prompt.startsWith('system: Be brief.\nuser: Where is order 48213?\nassistant: {'), anthropicRow.prompt);
  assert.ok(anthropicRow.prompt.includes('"name":"lookup_order"'), 'a tool_use block is kept as JSON');

  clearTimeout(watchdog);
  console.log('PASS framework-spans.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.message ?? String(err));
}
