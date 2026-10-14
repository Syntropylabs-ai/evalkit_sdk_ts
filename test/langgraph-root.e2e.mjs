import assert from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { registerHooks } from 'node:module';
import { ingestBody } from './_ingest.mjs';

if (typeof registerHooks !== 'function') {
  console.log('langgraph-root.e2e SKIPPED: needs module.registerHooks (Node 22.15 or later)');
  process.exit(0);
}

// A LangGraph run outside any span is one trace: the graph's invocation gets a root span, and steps that
// reach the callbacks with no parent run (a graph invoked before the SDK's patches landed) share one root.
// A model call is recorded once: the provider's span, in the model run's place with its LangGraph node.

const STAND_INS = {
  '@langchain/core/callbacks/base':
    'export class BaseCallbackHandler { static fromMethods(methods) { return Object.assign(new BaseCallbackHandler(), methods); } }',
  '@langchain/core/callbacks/manager': 'export class CallbackManager {}',
  '@langchain/langgraph/pregel': `export class Pregel {
    constructor() { this.name = 'support-graph'; }
    async invoke(input) { return globalThis.__graphBody(input); }
    async stream(input) { const out = await globalThis.__graphBody(input); return (async function* () { yield out; })(); }
  }`,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const source = STAND_INS[specifier];
    if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { init, langchainHandler, patchOpenAIClient, flush } = await import('../dist/index.mjs');
init({ subscriptionKey: 'test', baseUrl: 'http://localhost:9', serviceName: 'langgraph-root-test', scheduledDelayMillis: 50 });
await sleep(400);
const handler = await langchainHandler();
const openai = { chat: { completions: { create: async () => ({ id: 'c1', model: 'gpt-4o-mini', choices: [{ message: { content: 'shipped' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } }) } } };
patchOpenAIClient(openai);

// LangChain's own context, as a node function runs inside it: the run it belongs to is its node.
const lcStorage = new AsyncLocalStorage();
globalThis[Symbol.for('ls:tracing_async_local_storage')] = lcStorage;
const inNode = (nodeRunId, fn) => lcStorage.run({ extra: { [Symbol.for('lc:child_config')]: { callbacks: { getParentRunId: () => nodeRunId } } } }, fn);
const meta = (node, step) => ({ langgraph_node: node, langgraph_step: step, langgraph_triggers: [`branch:to:${node}`] });

// One step of a graph as LangGraph reports it to the handler: the node, the model run inside it, the call.
async function agentStep(nodeRun, modelRun, step, callProvider = true) {
  handler.handleChainStart({ id: ['RunnableCallable'] }, {}, nodeRun, undefined, [], meta('agent', step), undefined, 'agent');
  handler.handleChatModelStart({ id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] }, [[]], modelRun, nodeRun, { invocation_params: { model: 'gpt-4o-mini' } }, [], meta('agent', step));
  if (callProvider) await inNode(nodeRun, () => openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }));
  handler.handleLLMEnd({ generations: [[{ text: 'shipped' }]] }, modelRun);
  handler.handleChainEnd({}, nodeRun);
}

try {
  // Steps that reach the handler with no parent run, outside any span: one trace under one root.
  await agentStep('run-agent-1', 'run-model-1', 1);
  handler.handleChainStart({ id: ['ToolNode'] }, {}, 'run-tools-2', undefined, [], meta('tools', 2), undefined, 'tools');
  handler.handleToolStart({ id: ['lookup_order'] }, '{"q":"1001"}', 'run-tool-2', 'run-tools-2', [], meta('tools', 2), 'lookup_order');
  handler.handleToolEnd('{"status":"shipped"}', 'run-tool-2');
  handler.handleChainEnd({}, 'run-tools-2');
  await agentStep('run-agent-3', 'run-model-3', 3);
  await flush();
  await sleep(150);
  const traces = new Set(ingested.map((e) => e.traceId));
  assert.strictEqual(traces.size, 1, `the graph's steps are one trace, got ${traces.size}`);
  const root = ingested.find((e) => !e.parentSpanId);
  assert.strictEqual(root.operation, 'LangGraph');
  const llm = ingested.filter((e) => e.spanType === 'llm_call');
  assert.deepStrictEqual(llm.map((e) => e.operation), ['chat.completions.create', 'chat.completions.create'], 'each model call once, as the provider span');
  for (const span of llm) {
    assert.strictEqual(span.attributes['langgraph.node'], 'agent', 'the provider span carries its node');
    assert.strictEqual(ingested.find((e) => e.spanId === span.parentSpanId)?.operation, 'agent', 'and sits under it');
  }
  ingested.length = 0;

  // A model run no provider call claimed is recorded by the handler, as before.
  await agentStep('run-agent-9', 'run-model-9', 1, false);
  await flush();
  await sleep(150);
  assert.deepStrictEqual(ingested.filter((e) => e.spanType === 'llm_call').map((e) => e.operation), ['chat.generate']);
  ingested.length = 0;

  // An invocation once the patch is in place opens its own root span.
  const { Pregel } = await import('@langchain/langgraph/pregel');
  globalThis.__graphBody = () => openai.chat.completions.create({ model: 'gpt-4o-mini', messages: [] });
  await new Pregel().invoke({});
  for await (const _ of await new Pregel().stream({})) { /* drain */ }
  await flush();
  await sleep(150);
  const roots = ingested.filter((e) => e.operation === 'support-graph');
  assert.strictEqual(roots.length, 2, 'invoke() and stream() each open a root span');
  for (const r of roots) {
    const call = ingested.find((e) => e.spanType === 'llm_call' && e.traceId === r.traceId);
    assert.strictEqual(call?.parentSpanId, r.spanId, 'the graph\'s model call is under its root');
  }
  console.log('PASS langgraph-root.e2e.mjs');
  process.exit(0);
} catch (err) {
  fail(err?.stack ?? String(err));
}
