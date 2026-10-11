import assert from 'node:assert';
import { registerHooks } from 'node:module';
import { ingestBody } from './_ingest.mjs';

if (typeof registerHooks !== 'function') {
  console.log('langgraph-metadata.e2e SKIPPED: needs module.registerHooks (Node 22.15 or later)');
  process.exit(0);
}

// @langchain/core is not a dependency of this package. The SDK only needs BaseCallbackHandler.fromMethods to
// build its handler, so a stand-in module is enough to drive the handler the way a CallbackManager does.
const STAND_INS = {
  '@langchain/core/callbacks/base':
    'export class BaseCallbackHandler { static fromMethods(methods) { return Object.assign(new BaseCallbackHandler(), methods); } }',
  '@langchain/core/callbacks/manager': 'export class CallbackManager {}',
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
  return { ok: true, status: 200, text: async () => 'ok', json: async () => ({ status: 'ok' }) };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 20000);
watchdog.unref?.();

const { init, langchainHandler, flush } = await import('../dist/index.mjs');
init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', serviceName: 'langgraph' });

const handler = await langchainHandler();
assert.ok(handler, 'the handler is built from the stand-in @langchain/core');

const agent = {
  langgraph_step: 3,
  langgraph_node: 'agent',
  langgraph_triggers: ['branch:to:agent'],
  langgraph_path: ['__pregel_pull', 'agent'],
  langgraph_checkpoint_ns: 'agent:6f0e2b7c',
  checkpoint_ns: 'agent:6f0e2b7c',
};
const tools = {
  ...agent,
  langgraph_step: 4,
  langgraph_node: 'tools',
  langgraph_triggers: ['branch:to:tools', 'agent'],
  langgraph_checkpoint_ns: 'tools:91aa',
};
const human = { _getType: () => 'human', content: 'hi' };

// Arguments in the order CallbackManager passes them to each handler method.
handler.handleChainStart({ id: ['langgraph', 'CompiledStateGraph'] }, {}, 'G', undefined, [], {}, undefined, 'LangGraph');
handler.handleChainStart({ id: ['langgraph', 'RunnableCallable'] }, {}, 'A', 'G', ['graph:step:3'], agent, undefined, 'agent');
handler.handleChatModelStart(
  { id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'] },
  [[human]],
  'B',
  'A',
  { invocation_params: { model: 'gpt-4o' } },
  ['seq:step:1'],
  agent,
  'ChatOpenAI'
);
handler.handleLLMEnd({ generations: [[{ text: 'calling search' }]] }, 'B');
handler.handleLLMStart({ id: ['langchain', 'llms', 'openai', 'OpenAI'] }, ['hi'], 'L', 'A', {}, [], agent, 'OpenAI');
handler.handleLLMEnd({ generations: [[{ text: 'done' }]] }, 'L');
handler.handleChainEnd({}, 'A');
handler.handleToolStart({ id: ['langchain', 'tools', 'search'] }, 'query', 'C', 'G', [], tools, 'search');
handler.handleToolEnd('result', 'C');
handler.handleRetrieverStart({ id: ['langchain', 'retrievers', 'Docs'] }, 'q', 'R', 'G', [], tools, 'Docs');
handler.handleRetrieverEnd([], 'R');
handler.handleChainEnd({}, 'G');
await flush();

try {
  const byOperation = new Map(ingested.map((e) => [e.operation, e.attributes]));
  const langgraphKeys = (attrs) => Object.keys(attrs ?? {}).filter((k) => k.startsWith('langgraph.'));

  assert.deepStrictEqual(
    langgraphKeys(byOperation.get('LangGraph')),
    [],
    "the graph's own run sits outside every node and carries no node metadata"
  );
  for (const operation of ['agent', 'chat.generate', 'llm.generate']) {
    const attrs = byOperation.get(operation);
    assert.ok(attrs, `no span for ${operation}`);
    assert.strictEqual(attrs['langgraph.node'], 'agent', operation);
    assert.strictEqual(attrs['langgraph.step'], 3, operation);
    assert.strictEqual(attrs['langgraph.triggers'], '["branch:to:agent"]', operation);
    assert.strictEqual(attrs['langgraph.checkpoint_ns'], 'agent:6f0e2b7c', operation);
  }
  for (const operation of ['search', 'Docs']) {
    const attrs = byOperation.get(operation);
    assert.ok(attrs, `no span for ${operation}`);
    assert.strictEqual(attrs['langgraph.node'], 'tools', operation);
    assert.strictEqual(attrs['langgraph.step'], 4, operation);
    assert.strictEqual(
      attrs['langgraph.triggers'],
      '["branch:to:tools","agent"]',
      'the same compact JSON array the Python SDK writes'
    );
    assert.strictEqual(attrs['langgraph.checkpoint_ns'], 'tools:91aa', operation);
  }
  assert.strictEqual(byOperation.get('agent')['langchain.tags'], 'graph:step:3', 'tags keep their own attribute');
  assert.strictEqual(byOperation.get('agent')['langgraph.path'], undefined);
} catch (err) {
  fail(err?.stack ?? err);
}

console.log('langgraph-metadata.e2e OK');
process.exit(0);
