import assert from 'node:assert';
import { EvalKitClient, feedback, reward } from '../dist/index.mjs';
import evalkit from '../dist/index.mjs';

const calls = [];
let nextStatus = 200;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
  const ok = nextStatus >= 200 && nextStatus < 300;
  return { ok, status: nextStatus, text: async () => 'nope', json: async () => ({ scoreId: 's1', recorded: true }) };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 20000);

const client = evalkit.init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', apiUrl: 'http://api.test/', serviceName: 't' });
assert.ok(client instanceof EvalKitClient);

const traceId = 'a'.repeat(32);
const res = await feedback({ traceId, kind: 'thumbs', value: true, comment: 'great', userId: 'u1', sessionId: 's1' });
assert.deepStrictEqual(res, { scoreId: 's1', recorded: true });
assert.strictEqual(calls[0].url, 'http://api.test/v1/feedback');
assert.strictEqual(calls[0].headers['X-Subscription-Key'], 'tk_test');
assert.deepStrictEqual(calls[0].body, { traceId, kind: 'thumbs', value: 1, sessionId: 's1', comment: 'great', userId: 'u1' });

await reward(traceId, 0.8, { spanId: 'sp1', name: 'task_reward' });
assert.deepStrictEqual(calls[1].body, { traceId, kind: 'reward', value: 0.8, spanId: 'sp1', name: 'task_reward' });

await feedback({ traceId, kind: 'thumbs', value: 'down' });
assert.strictEqual(calls[2].body.value, 0);
await feedback({ traceId, kind: 'text', value: 'too verbose' });
assert.strictEqual(calls[3].body.value, 'too verbose');

await assert.rejects(() => feedback({ traceId, kind: 'stars', value: 5 }), /kind must be one of/);
await assert.rejects(() => feedback({ traceId: '', kind: 'thumbs', value: true }), /traceId is required/);
await assert.rejects(() => feedback({ traceId, kind: 'rating', value: 'high' }), /numeric/);
await assert.rejects(() => feedback({ traceId, kind: 'text', value: '   ' }), /non-empty/);

nextStatus = 404;
await assert.rejects(() => feedback({ traceId, kind: 'thumbs', value: true }), /feedback failed 404: nope/);

console.log('feedback.e2e OK');
process.exit(0);
