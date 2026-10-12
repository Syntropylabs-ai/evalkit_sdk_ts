// simulateUser with a live simulated user: the scripted turns first, then one POST /simulations/user-turn per
// turn until the user is done or maxTurns is reached, each recorded as a span marked as the simulation's user.
import assert from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import { ingestBody } from './_ingest.mjs';

const require = createRequire(import.meta.url);
const mod = require('../dist/index.js');
const evalkit = mod.default ?? mod;

const ingested = [];
globalThis.fetch = ((realFetch) => async (url, init) => {
  if (String(url).includes('/v1/ingest')) {
    ingested.push(...(ingestBody(init).events ?? []));
    return new Response('{"status":"ok"}', { status: 200 });
  }
  return realFetch(url, init);
})(globalThis.fetch);

const requests = [];
let answer = () => [200, {}];
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    requests.push({ path: req.url, key: req.headers['x-subscription-key'], body });
    const [status, payload] = answer(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const apiUrl = `http://127.0.0.1:${api.address().port}`;

evalkit.init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:9', apiUrl, serviceName: 'live-user' });

const USAGE = { inputTokens: 400, outputTokens: 12, costUsd: 0.0001 };
const scenario = {
  name: 'refund',
  starting_prompt: 'I want a refund.',
  user_goal: 'get the refund for order 1042',
  persona: 'IMPATIENT',
  category: 'tool_failure',
  hidden_info: { order: { value: 'order 1042', reveal_trigger: 'the order number' } },
  expected_tools: ['lookup_order'],
};
const agent = async (ctx) =>
  ctx.message.includes('1042')
    ? { text: 'Done, I refunded $59 for order 1042.', toolCalls: [{ name: 'lookup_order', args: { order_id: '1042' }, result: { amount: 59 } }] }
    : 'Which order is it?';

// Done once the agent confirms the refund; otherwise hands over the order number.
answer = (body) =>
  body.history.at(-1).content.includes('refunded')
    ? [200, { done: true, usage: USAGE }]
    : [200, { done: false, message: 'It is order 1042.', usage: USAGE }];

const seen = [];
const report = await evalkit.simulateUser({
  entrypoint: async (ctx) => (seen.push(ctx.message), agent(ctx)),
  scenarios: [scenario],
  userModel: 'mock gpt-4o-mini',
});
const result = report.results[0];
assert.strictEqual(result.status, 'OK', result.error);
assert.deepStrictEqual(seen, ['I want a refund.', 'It is order 1042.']);
assert.strictEqual(result.turns, 2);
assert.strictEqual(result.endedBy, 'user');
assert.deepStrictEqual(result.simulatedUserUsage, { calls: 2, inputTokens: 800, outputTokens: 24, costUsd: 0.0002 });
assert.strictEqual(result.transcript.length, 4);
assert.strictEqual(requests.length, 2);
assert.strictEqual(requests[0].path, '/simulations/user-turn');
assert.strictEqual(requests[0].key, 'tk_test');
assert.strictEqual(requests[0].body.turn, 2);
assert.strictEqual(requests[0].body.model, 'mock gpt-4o-mini');
assert.deepStrictEqual(requests[0].body.scenario, {
  maxTurns: 12, persona: 'IMPATIENT', userGoal: 'get the refund for order 1042', name: 'refund',
  scenarioType: 'tool_failure', hiddenInfo: scenario.hidden_info,
});
assert.deepStrictEqual(requests[1].body.history.at(-1).toolCalls, [
  { name: 'lookup_order', arguments: { order_id: '1042' }, result: { amount: 59 } },
]);

// maxTurns caps a user who is never satisfied.
requests.length = 0;
answer = () => [200, { done: false, message: 'Not good enough.', usage: USAGE }];
const capped = await evalkit.simulateUser({ entrypoint: async () => 'Sorry.', scenarios: [scenario], maxTurns: 3, model: 'fallback' });
assert.strictEqual(capped.results[0].turns, 3);
assert.strictEqual(capped.results[0].endedBy, 'max_turns');
assert.strictEqual(requests.length, 2);
assert.strictEqual(requests[0].body.model, 'fallback', 'model is the simulated user model when userModel is not given');

// Turns-only scenarios replay as written; liveUser: true continues after them.
requests.length = 0;
const scripted = await evalkit.simulateUser({ entrypoint: async () => 'ok', scenarios: [{ name: 's', turns: ['one', 'two'] }] });
assert.strictEqual(scripted.results[0].turns, 2);
assert.strictEqual(scripted.results[0].transcript, undefined);
assert.strictEqual(requests.length, 0);
answer = () => [200, { done: true, usage: USAGE }];
const continued = await evalkit.simulateUser({
  entrypoint: async () => 'ok', scenarios: [{ name: 's', turns: ['one', 'two'] }], liveUser: true, userModel: 'm',
});
assert.strictEqual(continued.results[0].endedBy, 'user');
assert.strictEqual(requests[0].body.turn, 3);

// A refused turn ends the scenario with the platform's reason.
answer = () => [400, { statusCode: 400, message: 'No model is configured for the simulated user.' }];
const refused = await evalkit.simulateUser({ entrypoint: agent, scenarios: [scenario] });
assert.strictEqual(refused.results[0].status, 'ERROR');
assert.match(refused.results[0].error, /simulated user failed at turn 2: 400 No model is configured/);

// generateScenarios asks for a live user unless scriptedTurns is set.
requests.length = 0;
answer = () => [200, { scenarios: [] }];
await evalkit.generateScenarios({ agentInstructions: 'agent', apiUrl });
await evalkit.generateScenarios({ agentInstructions: 'agent', apiUrl, scriptedTurns: true });
assert.deepStrictEqual(requests.map((r) => r.body.scriptedTurns), [false, true]);

await evalkit.flush();
api.close();

const users = ingested.filter((e) => e.operation === 'simulated_user');
const roots = ingested.filter((e) => String(e.operation).startsWith('scenario:'));
assert.ok(users.length >= 4, `simulated user spans recorded (${users.length})`);
for (const u of users) {
  assert.strictEqual(u.attributes['evalkit.simulation.role'], 'user');
  assert.strictEqual(u.spanType, 'function_call');
  assert.ok(roots.some((r) => r.spanId === u.parentSpanId && r.traceId === u.traceId), 'parented to its scenario root');
  assert.strictEqual(u.tokensIn, undefined, 'the user turn carries no token counts of the agent');
}
const firstRun = users.filter((u) => u.traceId === roots[0].traceId);
assert.deepStrictEqual(firstRun.map((u) => u.completion ?? null), ['It is order 1042.', null]);
assert.deepStrictEqual(firstRun.map((u) => u.attributes['evalkit.simulated_user.done']), [false, true]);
// The stand-in platform runs in this process, so its incoming requests are traced as SERVER spans; the
// SDK's own request is never a span of its own.
const userTurnHttp = ingested.filter((e) => e.spanType === 'http_call' && String(e.operation).includes('user-turn'));
assert.ok(userTurnHttp.every((e) => e.spanKind === 'SERVER'), JSON.stringify(userTurnHttp.map((e) => e.spanKind)));
const userSpanIds = new Set(users.map((u) => u.spanId));
assert.ok(userTurnHttp.every((e) => userSpanIds.has(e.parentSpanId)), 'the request ran inside its simulated user span');
console.log('live-user.e2e: ok');
process.exit(0);
