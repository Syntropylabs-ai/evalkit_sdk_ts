import assert from 'node:assert';

const RULE = '665f0c1234567890abcdef12';
const RULE_B = '665f0c1234567890abcdef34';
const BASELINE = '665f0c1234567890abcdefaa';
const DATASET_HASH = 'sha256:' + 'ab'.repeat(32);

const server = {
  mode: 'append',
  failRowsTimes: 0,
  rowsFailures: 0,
  runs: [],
  rows: new Map(),
  names: new Map(),
  completes: [],
  requests: [],
  legacyRespond: legacyAllPass,
  reset(patch = {}) {
    this.mode = 'append';
    this.failRowsTimes = 0;
    this.rowsFailures = 0;
    this.runs = [];
    this.rows = new Map();
    this.names = new Map();
    this.completes = [];
    this.requests = [];
    this.legacyRespond = legacyAllPass;
    Object.assign(this, patch);
  },
  paths() {
    return this.requests.map((r) => r.path);
  },
  bodies(suffix) {
    return this.requests.filter((r) => r.path.endsWith(suffix)).map((r) => r.body);
  },
  storedRows(runId = this.runs[this.runs.length - 1]) {
    const stored = this.rows.get(runId) ?? new Map();
    return [...stored.keys()].sort((a, b) => a - b).map((k) => stored.get(k));
  },
};

function judgedRow(row) {
  return {
    rowIndex: row.rowIndex,
    input: row.input,
    output: row.output,
    metrics: [{ ruleId: RULE, metricName: 'Relevance', score: 0.9, passed: true, status: 'ok', source: 'judge' }],
    localScores: row.localScores ?? [],
    overallScore: 0.9,
    passed: true,
    status: 'ok',
    counts: { ok: 1, unparseable: 0, judgeError: 0, skipped: 0, unsupported: 0 },
  };
}

function legacyAllPass(body, n) {
  const rows = body.rows;
  const payload = {
    jobId: `job_${n}`, name: body.name, datasetHash: DATASET_HASH, totalRows: rows.length,
    averageScore: 0.9, passRate: 1,
    counts: { ok: rows.length, unparseable: 0, judgeError: 0, skipped: 0, unsupported: 0 },
    indeterminateRows: 0, erroredRows: 0, scoringVersion: 2, overallScores: { Relevance: 0.9 },
    gateResult: null, hyperparameters: body.hyperparameters ?? null,
    results: rows.map((r, i) => judgedRow({ rowIndex: i, input: r.input, output: r.output })),
  };
  if (body.gate) payload.gateResult = { passed: true, checks: [{ name: 'minPassRate', threshold: body.gate.minPassRate, actual: 1, passed: true }] };
  if (body.baselineJobId) payload.comparison = { comparable: true, candidateJobId: `job_${n}`, baselineJobId: body.baselineJobId };
  return [200, payload];
}

function legacyPatterned(body, n) {
  const rows = body.rows;
  const results = rows.map((r, i) => {
    const g = Number(String(r.input).slice(1)) % 10;
    const errored = g === 0;
    const noVerdict = g === 1;
    const score = errored || noVerdict ? null : (g >= 2 && g <= 4 ? 0.4 : 0.9);
    return {
      rowIndex: i, input: r.input, output: r.output,
      metrics: [{ ruleId: RULE, metricName: 'Relevance', score, status: errored ? 'judge_error' : (noVerdict ? 'unparseable' : 'ok') }],
      overallScore: score,
      passed: errored || noVerdict ? null : score === 0.9,
      status: errored ? 'error' : 'ok',
      ...(errored ? { error: 'boom' } : {}),
      counts: { ok: errored || noVerdict ? 0 : 1, unparseable: noVerdict ? 1 : 0, judgeError: errored ? 1 : 0, skipped: 0, unsupported: 0 },
    };
  });
  return [200, { jobId: `job_${n}`, name: body.name, scoringVersion: 2, gateResult: { passed: false, checks: [] }, comparison: { comparable: false }, results }];
}

function route(path, body) {
  if (path === '/evaluation-runs') {
    if ('rows' in body) {
      const n = server.requests.filter((r) => r.path === '/evaluation-runs' && 'rows' in r.body).length;
      return server.legacyRespond(body, n);
    }
    if (server.mode === 'legacy') return [400, { statusCode: 400, message: 'rows should not be empty' }];
    if (server.mode === 'create-500') return [500, { statusCode: 500, message: 'boom' }];
    const runId = `run_${server.runs.length + 1}`;
    server.runs.push(runId);
    server.rows.set(runId, new Map());
    server.names.set(runId, body.name);
    return [201, { runId, url: `https://app.test/o/o1/p/p1/evaluations/${runId}` }];
  }
  const parts = path.split('/');
  if (parts.length === 4 && parts[1] === 'evaluation-runs' && parts[3] === 'rows') {
    if (server.mode === 'no-rows-endpoint') return [404, { statusCode: 404, message: `Cannot POST ${path}` }];
    if (server.rowsFailures < server.failRowsTimes) {
      server.rowsFailures += 1;
      return [500, { statusCode: 500, message: 'flaky' }];
    }
    const stored = server.rows.get(parts[2]) ?? new Map();
    for (const row of body.rows ?? []) stored.set(row.rowIndex, row);
    server.rows.set(parts[2], stored);
    return [202, { accepted: (body.rows ?? []).length, rows: stored.size }];
  }
  if (parts.length === 4 && parts[1] === 'evaluation-runs' && parts[3] === 'complete') {
    server.completes.push(body);
    const rows = server.storedRows(parts[2]);
    const payload = {
      jobId: `job_${parts[2]}`, runId: parts[2], name: server.names.get(parts[2]), datasetHash: DATASET_HASH,
      totalRows: rows.length, averageScore: 0.9, passRate: 1,
      counts: { ok: rows.length, unparseable: 0, judgeError: 0, skipped: 0, unsupported: 0 },
      indeterminateRows: 0, erroredRows: 0, scoringVersion: 2, overallScores: { Relevance: 0.9 },
      gateResult: null, comparison: { comparable: true, candidateJobId: `job_${parts[2]}`, baselineJobId: null },
      results: rows.map(judgedRow),
    };
    if (body.gate) {
      payload.gateResult = { passed: true, checks: [{ name: 'minPassRate', threshold: body.gate.minPassRate, actual: 1, passed: true }] };
    }
    return [200, payload];
  }
  return [404, { statusCode: 404, message: `Cannot POST ${path}` }];
}

globalThis.fetch = async (url, opts) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v1/ingest') return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) };
  const body = JSON.parse(opts.body);
  server.requests.push({ url: String(url), path, headers: opts.headers, body });
  const [status, payload] = route(path, body);
  const ok = status < 400;
  return { ok, status, text: async () => (ok ? '' : JSON.stringify(payload)), json: async () => payload };
};

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 40000);
watchdog.unref?.();

const evalkit = await import('../dist/index.mjs');
const { Eval, EvalResult, init } = evalkit;

const fresh = () => init({ subscriptionKey: 'tk_test', baseUrl: 'http://127.0.0.1:1', apiUrl: 'http://api.test', serviceName: 't' });
fresh();

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ input: `q${i}`, output: 'o' }));

try {
  server.reset();
  const lengthScorer = (row, output) => output.length / 10;
  const detailed = () => ({ score: 0.25, passed: false, reason: 'too terse' });
  const single = await Eval({
    name: 'single',
    data: [
      { input: 'a', output: 'short', target: 't' },
      { input: 'b', output: 'longer answer', context: ['c1'], metadata: { tier: 'pro' } },
    ],
    evaluators: [RULE, lengthScorer, RULE_B, detailed],
    judgeModel: 'gpt-5-mini',
    baselineJobId: BASELINE,
    gate: { minPassRate: 0.5 },
    hyperparameters: { model: 'gpt-5-mini', temperature: 0.2 },
    autoBaseline: false,
  });

  assert.ok(single instanceof EvalResult);
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs/run_1/complete']);
  const create = server.requests[0];
  assert.strictEqual(create.url, 'http://api.test/evaluation-runs');
  assert.strictEqual(create.headers['X-Subscription-Key'], 'tk_test');
  assert.deepStrictEqual(create.body.ruleIds, [RULE, RULE_B]);
  assert.strictEqual(create.body.judgeModelName, 'gpt-5-mini');
  assert.strictEqual(create.body.baselineJobId, BASELINE);
  assert.strictEqual(create.body.autoBaseline, false);
  assert.deepStrictEqual(create.body.hyperparameters, { model: 'gpt-5-mini', temperature: 0.2 });
  assert.strictEqual(create.body.rows, undefined);
  assert.strictEqual(create.body.gate, undefined);

  assert.deepStrictEqual(server.bodies('/rows')[0].rows, [
    {
      rowIndex: 0, input: 'a', output: 'short', expected: 't',
      localScores: [{ name: 'lengthScorer', score: 0.5 }, { name: 'detailed', score: 0.25, passed: false, reason: 'too terse' }],
    },
    {
      rowIndex: 1, input: 'b', output: 'longer answer', metadata: { tier: 'pro', context: ['c1'] },
      localScores: [{ name: 'lengthScorer', score: 1.3 }, { name: 'detailed', score: 0.25, passed: false, reason: 'too terse' }],
    },
  ]);
  assert.deepStrictEqual(server.completes, [{ gate: { minPassRate: 0.5 } }]);

  assert.strictEqual(single.runId, 'run_1');
  assert.strictEqual(single.url, 'https://app.test/o/o1/p/p1/evaluations/run_1');
  assert.strictEqual(single.jobId, 'job_run_1');
  assert.deepStrictEqual(single.jobIds, ['job_run_1']);
  assert.strictEqual(single.totalRows, 2);
  assert.strictEqual(single.passed, true);
  assert.strictEqual(single.datasetHash, DATASET_HASH);
  assert.strictEqual(single.comparison.comparable, true);
  assert.deepStrictEqual(single.localScores.lengthScorer, [0.5, 1.3]);
  assert.deepStrictEqual(single.localScores.detailed, [0.25, 0.25]);
  assert.strictEqual(single.results[1].rowIndex, 1);

  server.reset();
  const withTask = await Eval({ name: 'task', data: [{ input: 'q' }], task: (row) => `answer to ${row.input}`, evaluators: [RULE] });
  assert.strictEqual(server.bodies('/rows')[0].rows[0].output, 'answer to q');
  assert.strictEqual(withTask.totalRows, 1);
  assert.strictEqual(server.completes.length, 1);
  assert.deepStrictEqual(server.completes[0], {});

  for (const [total, expected] of [[199, [199]], [200, [200]], [201, [200, 1]], [450, [200, 200, 50]]]) {
    server.reset();
    const result = await Eval({ name: `n${total}`, data: rowsOf(total), evaluators: [RULE] });
    assert.deepStrictEqual(server.bodies('/rows').map((b) => b.rows.length), expected, `batch sizes for ${total}`);
    assert.strictEqual(server.bodies('/evaluation-runs').length, 1, `one create for ${total}`);
    assert.strictEqual(server.completes.length, 1, `one complete for ${total}`);
    const indexes = server.bodies('/rows').flatMap((b) => b.rows.map((r) => r.rowIndex));
    assert.deepStrictEqual(indexes, [...Array(total).keys()], `row indexes for ${total}`);
    assert.strictEqual(result.totalRows, total);
  }

  server.reset();
  await Eval({ name: 'clamped', data: rowsOf(300), evaluators: [RULE], batchSize: 1000 });
  assert.deepStrictEqual(server.bodies('/rows').map((b) => b.rows.length), [200, 100]);

  server.reset({ failRowsTimes: 1 });
  const retried = await Eval({ name: 'flaky', data: rowsOf(250), evaluators: [RULE] });
  const rowBodies = server.bodies('/rows');
  assert.strictEqual(rowBodies.length, 3);
  assert.deepStrictEqual(rowBodies[0], rowBodies[1], 'a retried batch must resend the identical rowIndex payload');
  assert.deepStrictEqual(rowBodies.map((b) => b.rows.length), [200, 200, 50]);
  assert.deepStrictEqual(server.storedRows().map((r) => r.rowIndex), [...Array(250).keys()]);
  assert.strictEqual(retried.totalRows, 250);

  server.reset();
  const originalWrite = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (chunk) => { printed += String(chunk); return true; };
  let printedResult;
  try {
    printedResult = await Eval({ name: 'printed', data: rowsOf(400), evaluators: [RULE] });
  } finally {
    process.stdout.write = originalWrite;
  }
  const links = printed.split('\n').filter((line) => line.includes(printedResult.url));
  assert.strictEqual(links.length, 1, `expected the run link once, got: ${JSON.stringify(printed)}`);

  server.reset();
  process.env.EVALKIT_QUIET = '1';
  let quietPrinted = '';
  process.stdout.write = (chunk) => { quietPrinted += String(chunk); return true; };
  try {
    await Eval({ name: 'quiet', data: rowsOf(1), evaluators: [RULE] });
  } finally {
    process.stdout.write = originalWrite;
    delete process.env.EVALKIT_QUIET;
  }
  assert.strictEqual(quietPrinted, '');

  await assert.rejects(() => Eval({ name: 'x', data: [{ input: 'a', output: 'b' }], evaluators: [lengthScorer] }), /at least one server rule id/);
  await assert.rejects(() => Eval({ name: 'x', data: [{ input: 'a', output: 'b' }], evaluators: ['not-a-rule-id'] }), /neither a server rule id/);
  await assert.rejects(() => Eval({ name: 'x', data: [{ input: 'a' }], evaluators: [RULE] }), /no 'output' and no task/);
  await assert.rejects(() => Eval({ name: 'x', data: [], evaluators: [RULE] }), /data is empty/);
  await assert.rejects(() => Eval({ name: 'x', data: [{ input: 'a', output: 'b' }], evaluators: [RULE], batchSize: 0 }), /batchSize/);
  await assert.rejects(
    () => Eval({ name: 'x', data: [{ input: 'a', output: 'b' }], evaluators: [RULE, () => 'great'] }),
    /local evaluator/,
  );

  fresh();
  server.reset({ mode: 'create-500' });
  await assert.rejects(() => Eval({ name: 'x', data: [{ input: 'a', output: 'b' }], evaluators: [RULE] }), /Eval failed 500/);

  fresh();
  server.reset({ mode: 'no-rows-endpoint' });
  const fallback = await Eval({
    name: 'old-server', data: [{ input: 'q1', output: 'a1', target: 't1' }], evaluators: [RULE], gate: { minPassRate: 0.5 },
  });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs']);
  assert.deepStrictEqual(server.requests[2].body.rows, [{ input: 'q1', output: 'a1', target: 't1' }]);
  assert.deepStrictEqual(server.requests[2].body.gate, { minPassRate: 0.5 });
  assert.strictEqual(fallback.jobId, 'job_1');
  assert.strictEqual(fallback.runId, null);
  assert.strictEqual(fallback.url, null);
  assert.strictEqual(fallback.passed, true);

  server.requests = [];
  await Eval({ name: 'second', data: [{ input: 'q2', output: 'a2' }], evaluators: [RULE] });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs'], 'the 404 is detected once per client, not per batch');
  assert.ok('rows' in server.requests[0].body);

  fresh();
  server.reset({ mode: 'legacy' });
  const rowless = await Eval({ name: 'old', data: [{ input: 'q1', output: 'a1' }], evaluators: [RULE] });
  assert.deepStrictEqual(server.paths(), ['/evaluation-runs', '/evaluation-runs']);
  assert.strictEqual(rowless.jobId, 'job_1');
  assert.strictEqual(rowless.url, null);

  fresh();
  server.reset({ mode: 'legacy', legacyRespond: legacyPatterned });
  const many = await Eval({
    name: 'multi', data: Array.from({ length: 450 }, (_, i) => ({ input: `q${i}`, output: 'o' })),
    evaluators: [RULE, lengthScorer], batchSize: 200, baselineJobId: BASELINE, gate: { minPassRate: 0.1 }, autoBaseline: true,
    hyperparameters: { model: 'm' },
  });
  const legacyBodies = server.bodies('/evaluation-runs').filter((b) => 'rows' in b);
  assert.deepStrictEqual(legacyBodies.map((b) => b.rows.length), [200, 200, 50]);
  assert.ok(legacyBodies.every((b) => b.baselineJobId === undefined && b.gate === undefined && b.autoBaseline === undefined));
  assert.ok(legacyBodies.every((b) => b.hyperparameters.model === 'm'));
  assert.ok(legacyBodies.every((b) => !JSON.stringify(b).includes('localScores')));
  assert.deepStrictEqual(many.jobIds, ['job_1', 'job_2', 'job_3']);
  assert.strictEqual(many.totalRows, 450);
  assert.strictEqual(many.gateResult, null);
  assert.strictEqual(many.comparison, null);
  assert.strictEqual(many.passed, null);
  assert.strictEqual(many.results[449].rowIndex, 449);
  assert.strictEqual(many.erroredRows, 45);
  assert.strictEqual(many.indeterminateRows, 45);
  assert.strictEqual(many.counts.judgeError, 45);
  assert.ok(Math.abs(many.passRate - 0.625) < 1e-9);
  assert.ok(Math.abs(many.averageScore - 0.7125) < 1e-9);
  assert.strictEqual(many.localScores.lengthScorer.length, 450);
} catch (err) {
  fail(err.stack ?? err.message);
}

console.log('eval.e2e OK');
process.exit(0);
