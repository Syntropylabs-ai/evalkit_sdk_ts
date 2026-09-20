import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT_ERROR, EXIT_FAILED, EXIT_PASSED, EXIT_UNDECIDED, exitCode, main, renderGateTable, reportFromBody, verdict } from '../dist/cli/index.js';

const RULE = '665f0c1234567890abcdef12';
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 60000).unref?.();

const UNDECIDED_GATE = {
  passed: null,
  checks: [
    { name: 'minPassRate', threshold: 0.9, actual: 1, passed: true },
    { name: 'maxRegressionsVsBaseline', threshold: 0, actual: null, passed: null },
  ],
  evaluatedAt: '2026-09-16T00:00:00.000Z',
};
const FAILED_GATE = { passed: false, checks: [{ name: 'minPassRate', threshold: 0.9, actual: 0.5, passed: false }], evaluatedAt: '2026-09-16T00:00:00.000Z' };

const server = {
  gate: 'server',
  mode: 'append',
  requests: [],
  runs: new Map(),
  reset(patch = {}) {
    this.gate = 'server';
    this.mode = 'append';
    this.requests = [];
    this.runs = new Map();
    Object.assign(this, patch);
  },
  handle(method, path, body) {
    if (method === 'GET') {
      const id = path.split('/')[2];
      return this.runs.has(id) ? [200, this.runs.get(id)] : [404, { statusCode: 404, message: `Cannot GET ${path}` }];
    }
    if (path === '/evaluation-runs') {
      if (this.mode === 'create-404') return [404, { statusCode: 404, message: `Evaluation rule(s) not found: ${RULE}` }];
      const runId = `run_${this.runs.size + 1}`;
      this.runs.set(runId, { runId, url: `https://app.test/o/o1/p/p1/evaluations/${runId}`, name: body.name, rows: [] });
      return [201, { runId, url: this.runs.get(runId).url }];
    }
    const [, , runId, tail] = path.split('/');
    const run = this.runs.get(runId);
    if (!run) return [404, { statusCode: 404, message: 'run not found' }];
    if (tail === 'rows') {
      run.rows.push(...body.rows);
      return [202, { accepted: body.rows.length, rows: run.rows.length }];
    }
    if (tail === 'complete') {
      const gateResult = this.gate === 'server'
        ? (body.gate ? { passed: true, checks: [{ name: 'minPassRate', threshold: body.gate.minPassRate, actual: 1, passed: true }], evaluatedAt: 'x' } : null)
        : this.gate;
      const summary = {
        jobId: `job_${runId}`, name: run.name, datasetHash: 'sha256:ab', totalRows: run.rows.length, averageScore: 0.9, passRate: 1,
        counts: { ok: run.rows.length, unparseable: 0, judgeError: 0, skipped: 0, unsupported: 0 }, indeterminateRows: 0, erroredRows: 0,
        scoringVersion: 2, overallScores: { Relevance: 0.9 }, gateResult, results: [], comparison: null,
      };
      Object.assign(run, summary);
      return [200, summary];
    }
    return [404, { statusCode: 404, message: `Cannot ${method} ${path}` }];
  },
};

globalThis.fetch = async (url, opts = {}) => {
  const path = new URL(String(url)).pathname;
  if (path === '/v1/ingest') return { ok: true, status: 200, text: async () => 'ok', json: async () => ({}) };
  const method = opts.method ?? 'GET';
  const body = opts.body ? JSON.parse(opts.body) : null;
  server.requests.push({ method, path, headers: opts.headers, body });
  const [status, payload] = server.handle(method, path, body);
  const ok = status < 400;
  return { ok, status, text: async () => JSON.stringify(payload), json: async () => payload };
};

const dir = mkdtempSync(join(tmpdir(), 'evalkit-eval-cli-'));
const home = join(dir, 'home');
const sdk = () => import('../dist/index.mjs');

function config(name, extra = {}) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ name: 'ci', data: [{ input: 'q1', output: 'a1' }, { input: 'q2', output: 'a2' }], evaluators: [RULE], ...extra }));
  return path;
}

async function run(argv) {
  const out = [], err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), home, cwd: dir, sdk });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

try {
  assert.deepStrictEqual([EXIT_PASSED, EXIT_FAILED, EXIT_UNDECIDED, EXIT_ERROR], [0, 1, 2, 3]);
  for (const [passed, allow, expected] of [[true, false, 0], [true, true, 0], [false, false, 1], [false, true, 1], [null, false, 2], [null, true, 0], [undefined, false, 2]]) {
    assert.strictEqual(exitCode(passed, allow), expected, `exitCode(${passed}, ${allow})`);
  }
  assert.deepStrictEqual([verdict(true), verdict(false), verdict(null)], ['passed', 'failed', 'undecided']);
  assert.strictEqual(reportFromBody({ gateResult: { passed: 'true', checks: [] } }).gate.passed, null, 'only a boolean is a verdict');
  assert.strictEqual(reportFromBody({ gateResult: null }).gate, null);
  const table = renderGateTable(UNDECIDED_GATE);
  assert.strictEqual(table[0], 'gate:');
  assert.match(table[2], /minPassRate\s+0\.900\s+1\s+passed/);
  assert.match(table[3], /maxRegressionsVsBaseline\s+0\s+—\s+undecided/);
  assert.deepStrictEqual(renderGateTable(null), ['gate: none (no gate was set on this run)']);

  server.reset();
  let r = await run(['eval', 'run', config('pass.json', { gate: { minPassRate: 0.9 } }), '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_PASSED, r.err);
  assert.ok(r.out.includes('https://app.test/o/o1/p/p1/evaluations/run_1'), r.out);
  assert.ok(r.out.includes('pass rate:     100.0%'), r.out);
  assert.match(r.out, /minPassRate\s+0\.900\s+1\s+passed/);
  assert.ok(r.out.includes('verdict: passed (exit 0)'));
  assert.strictEqual(server.requests[0].headers['X-Subscription-Key'], 'tk_test');
  assert.deepStrictEqual(server.requests.map((q) => q.path), ['/evaluation-runs', '/evaluation-runs/run_1/rows', '/evaluation-runs/run_1/complete']);
  assert.deepStrictEqual(server.requests[2].body, { gate: { minPassRate: 0.9 } });

  server.reset({ gate: FAILED_GATE });
  r = await run(['eval', 'run', config('fail.json', { gate: { minPassRate: 0.9 } }), '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_FAILED);
  assert.ok(r.out.includes('verdict: failed (exit 1)'));

  server.reset({ gate: UNDECIDED_GATE });
  const undecided = config('undecided.json', { gate: { minPassRate: 0.9, maxRegressionsVsBaseline: 0 } });
  r = await run(['eval', 'run', undecided, '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_UNDECIDED, 'undecided fails closed');
  assert.ok(r.out.includes('verdict: undecided (exit 2)'));
  r = await run(['eval', 'run', undecided, '--key', 'tk_test', '--api-url', 'http://api.test', '--allow-undecided']);
  assert.strictEqual(r.code, EXIT_PASSED);
  assert.ok(r.out.includes('verdict: undecided (exit 0)'));

  server.reset();
  r = await run(['eval', 'run', config('nogate.json'), '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_UNDECIDED, 'no gate is undecided');
  assert.ok(r.out.includes('gate: none'));

  server.reset({ gate: FAILED_GATE });
  r = await run(['eval', 'run', config('json.json', { gate: { minPassRate: 0.9 } }), '--key', 'tk_test', '--api-url', 'http://api.test', '--json']);
  assert.strictEqual(r.code, EXIT_FAILED);
  const document = JSON.parse(r.out);
  assert.strictEqual(document.verdict, 'failed');
  assert.deepStrictEqual(document.gate, FAILED_GATE);
  assert.strictEqual(document.runId, 'run_1');
  assert.strictEqual(document.passRate, 1);
  assert.strictEqual(process.env.EVALKIT_QUIET, undefined);

  server.reset();
  writeFileSync(join(dir, 'rows.jsonl'), '{"input":"a","output":"b"}\n\n{"input":"c","output":"d"}\n');
  writeFileSync(join(dir, 'file.json'), JSON.stringify({ name: 'from-file', dataFile: 'rows.jsonl', evaluators: [RULE], gate: { minPassRate: 0.5 } }));
  r = await run(['eval', 'run', 'file.json', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_PASSED, r.err);
  assert.deepStrictEqual(server.requests[1].body.rows.map((row) => row.input), ['a', 'c']);

  server.reset();
  writeFileSync(join(dir, 'checkout.mjs'), `export default () => ({ name: 'from-module', data: [{ input: 'q', output: 'a' }], evaluators: ['${RULE}'], gate: { minPassRate: 0.5 } });\nexport const named = { name: 'named', data: [{ input: 'q', output: 'a' }], evaluators: ['${RULE}'] };\n`);
  r = await run(['eval', 'run', 'checkout.mjs', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_PASSED, r.err);
  assert.strictEqual(server.requests[0].body.name, 'from-module');
  server.reset();
  r = await run(['eval', 'run', 'checkout.mjs', '--export', 'named', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_UNDECIDED);
  assert.strictEqual(server.requests[0].body.name, 'named');
  r = await run(['eval', 'run', 'checkout.mjs', '--export', 'nope', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_ERROR);
  assert.ok(r.err.includes("no export 'nope'"), r.err);

  server.reset({ mode: 'create-404' });
  r = await run(['eval', 'run', config('err.json'), '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_ERROR);
  assert.ok(r.err.includes('Evaluation rule(s) not found'), r.err);
  r = await run(['eval', 'run', 'absent.json', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_ERROR);
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ name: 'n', data: [], evaluators: [], judge: 'x' }));
  r = await run(['eval', 'run', 'bad.json', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_ERROR);
  assert.ok(r.err.includes("unknown Eval field 'judge'"), r.err);

  const savedKey = process.env.EVALKIT_API_KEY;
  delete process.env.EVALKIT_API_KEY;
  delete process.env.EVALKIT_SUBSCRIPTION_KEY;
  r = await run(['eval', 'run', config('nokey.json'), '--api-url', 'http://api.test']);
  if (savedKey !== undefined) process.env.EVALKIT_API_KEY = savedKey;
  assert.strictEqual(r.code, EXIT_ERROR);
  assert.ok(r.err.includes('subscription key is required'), r.err);

  server.reset({ gate: UNDECIDED_GATE });
  await run(['eval', 'run', undecided, '--key', 'tk_test', '--api-url', 'http://api.test']);
  r = await run(['eval', 'gate', 'run_1', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_UNDECIDED, r.err);
  assert.ok(r.out.includes('run_1'));
  assert.match(r.out, /maxRegressionsVsBaseline\s+0\s+—\s+undecided/);
  r = await run(['eval', 'gate', 'run_1', '--key', 'tk_test', '--api-url', 'http://api.test', '--allow-undecided', '--json']);
  assert.strictEqual(r.code, EXIT_PASSED);
  assert.strictEqual(JSON.parse(r.out).verdict, 'undecided');
  const reads = server.requests.filter((q) => q.method === 'GET');
  assert.deepStrictEqual(reads.map((q) => q.path), ['/evaluation-runs/run_1', '/evaluation-runs/run_1']);
  assert.strictEqual(reads[0].headers['X-Subscription-Key'], 'tk_test');
  r = await run(['eval', 'gate', 'run_9', '--key', 'tk_test', '--api-url', 'http://api.test']);
  assert.strictEqual(r.code, EXIT_ERROR);
  assert.ok(r.err.includes('GET /evaluation-runs/:runId'), r.err);

  r = await run(['eval', 'nothing']);
  assert.strictEqual(r.code, 2);
  assert.ok(r.err.includes('evalkit eval run'));

  const real = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = new URL(req.url, 'http://x').pathname;
      const [status, payload] = path === '/v1/ingest' ? [200, {}] : server.handle(req.method, path, raw ? JSON.parse(raw) : null);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => real.listen(0, '127.0.0.1', resolve));
  const port = real.address().port;
  const bin = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/evalkit.js', ...args], { env: { ...process.env, EVALKIT_API_KEY: 'tk_bin' } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  server.reset({ gate: FAILED_GATE });
  let b = await bin(['eval', 'run', config('bin.json', { gate: { minPassRate: 0.9 } }), '--api-url', `http://127.0.0.1:${port}`, '--json']);
  assert.strictEqual(b.status, EXIT_FAILED, `${b.stdout}\n${b.stderr}`);
  assert.strictEqual(JSON.parse(b.stdout).verdict, 'failed');
  server.reset({ gate: UNDECIDED_GATE });
  b = await bin(['eval', 'run', config('bin2.json', { gate: { minPassRate: 0.9 } }), '--api-url', `http://127.0.0.1:${port}`]);
  assert.strictEqual(b.status, EXIT_UNDECIDED, `${b.stdout}\n${b.stderr}`);
  assert.ok(b.stdout.includes('[evalkit] evaluation run: https://app.test'), 'the run link is announced as the run starts');
  b = await bin(['eval', 'gate', 'run_1', '--api-url', `http://127.0.0.1:${port}`, '--allow-undecided']);
  assert.strictEqual(b.status, EXIT_PASSED, `${b.stdout}\n${b.stderr}`);
  real.close();
} catch (err) {
  fail(err.stack ?? err.message);
}

console.log('eval-cli.e2e OK');
process.exit(0);
