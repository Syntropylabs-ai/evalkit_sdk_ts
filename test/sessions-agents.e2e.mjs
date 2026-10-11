import assert from 'node:assert';
import { ingestBody } from './_ingest.mjs';

const ingested = [];
globalThis.fetch = async (_url, opts) => {
  try { for (const e of ingestBody(opts).events) ingested.push(e); } catch {}
  return { ok: true, status: 200, text: async () => 'ok' };
};

const evalkit = await import('../dist/index.mjs');
const { init, startTrace, startSpan, setUser, currentUser, withTrace, withSession, setAgent, currentAgent } = evalkit;

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 20000);
watchdog.unref?.();

const client = init({
  subscriptionKey: 'test',
  baseUrl: 'http://localhost:9',
  serviceName: 'sessions-agents',
  scheduledDelayMillis: 50,
});

const flush = async () => {
  await client.flush();
  await new Promise((r) => setTimeout(r, 50));
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const spanNamed = (name) => {
  const found = ingested.filter((e) => e.operation === name);
  assert.strictEqual(found.length, 1, `expected exactly one span named ${name}, got ${found.length}`);
  return found[0];
};

try {
  // A session named only as an attribute, in any spelling, binds the whole trace.
  const spellings = ['session.id', 'conversation.id', 'gen_ai.conversation.id', 'session_id', 'evalkit.session_id'];
  for (const key of spellings) {
    const root = startTrace(`spelled-${key}`, { attributes: { [key]: `s-${key}` } });
    await withTrace(root.ctx, async () => {
      startSpan(`spelled-child-${key}`).end('OK');
      client.tracer.startSpan(`spelled-foreign-${key}`).end();
    });
    root.end('OK');
  }
  const userSpellings = ['user.id', 'enduser.id', 'evalkit.user_id'];
  for (const key of userSpellings) {
    const root = startTrace(`user-spelled-${key}`, { [key]: `u-${key}` });
    await withTrace(root.ctx, async () => {
      startSpan(`user-spelled-child-${key}`).end('OK');
    });
    root.end('OK');
  }
  await flush();
  for (const key of spellings) {
    assert.strictEqual(spanNamed(`spelled-${key}`).sessionId, `s-${key}`, key);
    assert.strictEqual(spanNamed(`spelled-child-${key}`).sessionId, `s-${key}`, `child of ${key}`);
    assert.strictEqual(spanNamed(`spelled-foreign-${key}`).sessionId, `s-${key}`, `foreign child of ${key}`);
  }
  for (const key of userSpellings) {
    assert.strictEqual(spanNamed(`user-spelled-child-${key}`).userId, `u-${key}`, key);
  }

  // Explicit option beats the attribute, field by field.
  const mixed = startTrace('mixed', { sessionId: 's-explicit', attributes: { 'session.id': 's-attr', 'user.id': 'u-attr' } });
  mixed.end('OK');
  await flush();
  assert.strictEqual(spanNamed('mixed').sessionId, 's-explicit');
  assert.strictEqual(spanNamed('mixed').userId, 'u-attr');

  // setUser outside a span is scoped to the async context: interleaved requests keep their own.
  const request = async (user, first, second) => {
    setUser({ userId: user, sessionId: `sess-${user}` });
    await sleep(first);
    startSpan(`req-${user}-1`).end('OK');
    await sleep(second);
    startSpan(`req-${user}-2`).end('OK');
  };
  await Promise.all([request('a', 25, 1), request('b', 1, 25)]);
  await flush();
  for (const user of ['a', 'b']) {
    for (const n of [1, 2]) {
      const span = spanNamed(`req-${user}-${n}`);
      assert.strictEqual(span.userId, user, `req-${user}-${n} took another request's user`);
      assert.strictEqual(span.sessionId, `sess-${user}`);
    }
  }
  setUser(null);
  assert.deepStrictEqual(currentUser(), {});

  // setUser at the top level still applies to everything after it.
  setUser({ userId: 'u-top' });
  await sleep(1);
  startSpan('after-top-level').end('OK');
  setUser(null);

  // Precedence: own attribute > nearest tagged startSpan > trace binding > ambient.
  setUser({ userId: 'u-ambient', sessionId: 's-ambient' });
  const bound = startTrace('bound', { sessionId: 's-bound' });
  await withTrace(bound.ctx, async () => {
    startSpan('inherits-bound').end('OK');
    const own = startSpan('own', { 'session.id': 's-own' });
    await withTrace(own.ctx, async () => {
      startSpan('under-own').end('OK');
    });
    own.end('OK');
  });
  bound.end('OK');
  startSpan('ambient-only').end('OK');
  setUser(null);
  await flush();
  assert.strictEqual(spanNamed('after-top-level').userId, 'u-top');
  assert.strictEqual(spanNamed('inherits-bound').sessionId, 's-bound');
  assert.strictEqual(spanNamed('inherits-bound').userId, 'u-ambient');
  assert.strictEqual(spanNamed('own').sessionId, 's-own');
  assert.strictEqual(spanNamed('under-own').sessionId, 's-own');
  assert.strictEqual(spanNamed('ambient-only').sessionId, 's-ambient');

  // withSession scopes concurrent work and restores what was there before.
  setUser({ userId: 'u-outer' });
  const results = await Promise.all(['x', 'y'].map((id, i) =>
    withSession({ sessionId: `ws-${id}` }, async () => {
      await sleep(i === 0 ? 25 : 1);
      startSpan(`ws-${id}`).end('OK');
      return id;
    })));
  assert.deepStrictEqual(results, ['x', 'y']);
  assert.strictEqual(withSession({ sessionId: 'ws-sync', userId: 'u-sync' }, () => currentUser().userId), 'u-sync');
  assert.deepStrictEqual(currentUser(), { userId: 'u-outer' });
  startSpan('after-ws').end('OK');
  setUser(null);
  await flush();
  assert.strictEqual(spanNamed('ws-x').sessionId, 'ws-x');
  assert.strictEqual(spanNamed('ws-y').sessionId, 'ws-y');
  assert.strictEqual(spanNamed('ws-x').userId, 'u-outer');
  assert.strictEqual(spanNamed('after-ws').sessionId, undefined);

  // Named agents: ambient, per trace, per subtree, and every attribute spelling.
  setAgent('support-bot');
  assert.strictEqual(currentAgent(), 'support-bot');
  startSpan('agent-ambient').end('OK');
  const planner = startTrace('planner-turn', { agentName: 'planner' });
  await withTrace(planner.ctx, async () => {
    startSpan('planner-step').end('OK');
    const research = startSpan('research', { 'agent.name': 'researcher' });
    await withTrace(research.ctx, async () => {
      startSpan('research-step').end('OK');
    });
    research.end('OK');
  });
  planner.end('OK');
  startSpan('both-spellings', { 'agent.name': 'loose', 'gen_ai.agent.name': 'semconv' }).end('OK');
  setAgent(null);
  assert.strictEqual(currentAgent(), undefined);
  startSpan('no-agent').end('OK');
  await flush();

  const ambient = spanNamed('agent-ambient');
  assert.strictEqual(ambient.agentName, 'support-bot');
  assert.strictEqual(ambient.attributes['evalkit.agent_name'], 'support-bot');
  assert.strictEqual(ambient.attributes['gen_ai.agent.name'], 'support-bot');
  assert.strictEqual(spanNamed('planner-turn').agentName, 'planner');
  assert.strictEqual(spanNamed('planner-turn').attributes['gen_ai.agent.name'], 'planner');
  assert.strictEqual(spanNamed('planner-step').agentName, 'planner');
  assert.strictEqual(spanNamed('research').agentName, 'researcher');
  assert.strictEqual(spanNamed('research-step').agentName, 'researcher');
  assert.strictEqual(spanNamed('research-step').attributes['evalkit.agent_name'], 'researcher');
  assert.strictEqual(spanNamed('both-spellings').agentName, 'semconv');
  assert.strictEqual(spanNamed('no-agent').agentName, undefined);
  assert.strictEqual(spanNamed('no-agent').attributes['gen_ai.agent.name'], undefined);

  // Agents are scoped per async context exactly like users.
  const agentTask = async (name, wait) => {
    setAgent(name);
    await sleep(wait);
    startSpan(`agent-task-${name}`).end('OK');
  };
  await Promise.all([agentTask('alpha', 20), agentTask('beta', 1)]);
  setAgent(null);
  await flush();
  assert.strictEqual(spanNamed('agent-task-alpha').agentName, 'alpha');
  assert.strictEqual(spanNamed('agent-task-beta').agentName, 'beta');
} catch (err) {
  fail(err.message);
}

console.log('sessions-agents.e2e OK');
process.exit(0);
