import assert from 'node:assert';

// Eval with evaluator collections, against a mock of the evaluation-run endpoints:
// what is sent, what an older server does with it, and the row context both paths send.

const RULE = '665f0c1234567890abcdef12';
const RULE_B = '665f0c1234567890abcdef34';
const RULE_C = '665f0c1234567890abcdef56';
const COLLECTION = '665f0c1234567890abcdefc0';

const server = {
  mode: 'append',
  collections: new Map(),
  runs: [],
  rows: new Map(),
  requests: [],
  reset(patch = {}) {
    this.mode = 'append';
    this.collections = new Map([[COLLECTION, [RULE_B, RULE]]]);
    this.runs = [];
    this.rows = new Map();
    this.requests = [];
    Object.assign(this, patch);
  },
  paths() {
    return this.requests.map((r) => r.path);
  },
};

function judged(rows) {
  return {
    jobId: 'job_1', name: 'n', totalRows: rows.length, averageScore: 0.9, passRate: 1, scoringVersion: 2,
    gateResult: null, comparison: null,
    results: rows.map((row, rowIndex) => ({ rowIndex, input: row.input, output: row.output, overallScore: 0.9, passed: true, status: 'ok' })),
  };
}

function route(path, body) {
  if (path === '/evaluation-runs') {
    if ('rows' in body) return [200, judged(body.rows)];
    const unknown = (body.collectionIds ?? []).filter((id) => !server.collections.has(id));
    if (unknown.length) return [404, { statusCode: 404, message: `Evaluator collection(s) not found: ${unknown.join(', ')}`, error: 'Not Found' }];
    const missing = (body.ruleIds ?? []).filter((id) => ![RULE, RULE_B, RULE_C].includes(id));
    if (missing.length) return [404, { statusCode: 404, message: `Evaluation rule(s) not found: ${missing.join(', ')}`, error: 'Not Found' }];
    const runId = `run_${server.runs.length + 1}`;
    server.runs.push(runId);
    server.rows.set(runId, []);
    const opened = { runId, url: `https://app.test/o/o1/p/p1/evaluations/${runId}` };
    if (server.mode !== 'pre-collections') {
      const members = (body.collectionIds ?? []).flatMap((id) => server.collections.get(id));
      opened.ruleIds = [...new Set([...members, ...(body.ruleIds ?? [])])];
    }
    return [201, opened];
  }
  const parts = path.split('/');
  if (parts.length === 4 && parts[3] === 'rows') {
    if (server.mode === 'no-rows-endpoint') return [404, { statusCode: 404, message: `Cannot POST ${path}` }];
    server.rows.get(parts[2]).push(...body.rows);
    return [202, { accepted: body.rows.length }];
  }
  if (parts.length === 4 && parts[3] === 'complete') return [200, { ...judged(server.rows.get(parts[2])), runId: parts[2] }];
  return [404, { statusCode: 404, message: `Cannot POST ${path}` }];
}

globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v1/ingest') return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) };
  const body = JSON.parse(opts.body);
  server.requests.push({ path, body });
  const [status, payload] = route(path, body);
  const ok = status < 400;
  return { ok, status, text: async () => (ok ? '' : JSON.stringify(payload)), json: async () => payload };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 20000);
watchdog.unref?.();

process.env.EVALKIT_QUIET = '1';
const { Eval, init } = await import('../dist/index.mjs');
const fresh = () => init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', apiUrl: 'http://api.test', serviceName: 't' });
fresh();

const row = { input: 'q1', output: 'a1', target: 'a1' };

try {
  // Collections go beside rule ids and local scorers, in their own field.
  server.reset();
  const mixed = await Eval({
    name: 'suite', data: [row], evaluators: [RULE_C, (r, output) => (output === r.target ? 1 : 0)], collections: [COLLECTION],
    judgeModel: 'gpt-5-mini',
  });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs/run_1/complete']);
  assert.deepStrictEqual(server.requests[0].body, { name: 'suite', ruleIds: [RULE_C], collectionIds: [COLLECTION], judgeModelName: 'gpt-5-mini' });
  assert.deepStrictEqual(server.requests[1].body.rows[0].localScores, [{ name: 'evaluator_1', score: 1 }]);
  assert.strictEqual(mixed.runId, 'run_1');
  assert.deepStrictEqual(mixed.localScores, { evaluator_1: [1] });

  // A collection alone names the evaluators; a run with neither is refused before any request.
  server.reset();
  await Eval({ name: 'only', data: [row], collections: [COLLECTION] });
  assert.deepStrictEqual(server.requests[0].body, { name: 'only', ruleIds: [], collectionIds: [COLLECTION] });
  server.reset();
  await assert.rejects(() => Eval({ name: 'x', data: [row] }), /at least one server evaluator: a rule id in evaluators or a collection id in collections/);
  await assert.rejects(() => Eval({ name: 'x', data: [row], evaluators: [() => 1] }), /at least one server evaluator/);
  await assert.rejects(() => Eval({ name: 'x', data: [row], collections: [COLLECTION, 'support-suite'] }), /collections\[1\] is not a collection id/);
  await assert.rejects(() => Eval({ name: 'x', data: [row], collections: COLLECTION }), /not a single string/);
  assert.deepStrictEqual(server.paths(), []);

  // An id the key cannot use reads as the server's reason, not as a raw response body.
  server.reset();
  await assert.rejects(
    () => Eval({ name: 'x', data: [row], collections: ['665f0c1234567890abcdef99'] }),
    (err) => err.message === 'Eval failed 404: Evaluator collection(s) not found: 665f0c1234567890abcdef99',
  );
  await assert.rejects(
    () => Eval({ name: 'x', data: [row], evaluators: ['665f0c1234567890abcdef00'] }),
    (err) => err.message === 'Eval failed 404: Evaluation rule(s) not found: 665f0c1234567890abcdef00',
  );
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs']);

  // A server that predates collections would drop them silently: refused before any row is sent.
  server.reset({ mode: 'pre-collections' });
  await assert.rejects(() => Eval({ name: 'x', data: [row], evaluators: [RULE], collections: [COLLECTION] }), /does not support collections/);
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs']);

  // The single-call fallback cannot carry collections, so a 404 on append is an error for them...
  fresh();
  server.reset({ mode: 'no-rows-endpoint' });
  await assert.rejects(() => Eval({ name: 'x', data: [row], collections: [COLLECTION] }), /Eval failed 404: Cannot POST/);
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows']);

  // ...while a rule-id run on the same client still falls back, and marks the client as legacy.
  server.reset({ mode: 'no-rows-endpoint' });
  await Eval({ name: 'x', data: [row], evaluators: [RULE] });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs']);

  // Once marked legacy, a collections run still takes the appended path, the only one that carries them.
  server.reset();
  const upgraded = await Eval({ name: 'x', data: [row], collections: [COLLECTION] });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs/run_1/complete']);
  assert.strictEqual(upgraded.runId, 'run_1');

  // A context given as one string is one document, on both paths.
  fresh();
  server.reset();
  const withContext = { input: 'q1', output: 'a1', context: 'Refunds within 30 days.' };
  await Eval({ name: 'ctx', data: [withContext, { input: 'q2', output: 'a2', context: ['d1', 'd2'] }], evaluators: [RULE] });
  assert.deepStrictEqual(server.requests[1].body.rows.map((r) => r.metadata), [
    { context: ['Refunds within 30 days.'] },
    { context: ['d1', 'd2'] },
  ]);
  server.reset({ mode: 'no-rows-endpoint' });
  await Eval({ name: 'ctx', data: [withContext], evaluators: [RULE] });
  assert.deepStrictEqual(server.requests[2].body.rows[0].context, ['Refunds within 30 days.']);
} catch (err) {
  fail(err.stack ?? err.message);
}

console.log('collections.e2e OK');
process.exit(0);
