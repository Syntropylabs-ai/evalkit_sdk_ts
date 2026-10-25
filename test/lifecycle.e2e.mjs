import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ingestBody } from './_ingest.mjs';

// The last spans of a process are not lost on its way out, and the SDK never decides how the process ends:
// spans are flushed on beforeExit, and on SIGTERM / SIGINT when the app has no handler of its own, within
// 3 s and then with the signal's default action. Tracing can be switched off, invalid options leave it off
// with one warning, flush() is bounded, and serverless handlers flush before they return.

const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
const watchdog = setTimeout(() => fail('timeout'), 90000);
watchdog.unref?.();

const DIST = fileURLToPath(new URL('../dist/index.mjs', import.meta.url));
const received = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { received.push(...ingestBody({ headers: req.headers, body: Buffer.concat(chunks) }).events); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"queued"}');
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const URL_ = `http://127.0.0.1:${server.address().port}`;

function run(code, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, DIST_: DIST, URL_, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const PRELUDE = `const evalkit = await import(process.env.DIST_);
const client = evalkit.init({ subscriptionKey: 'tk_test_k', baseUrl: process.env.URL_, serviceName: 'lifecycle', scheduledDelayMillis: 60000 });`;

const results = [];
const check = async (name, fn) => {
  received.length = 0;
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (err) {
    results.push(`FAIL ${name}: ${err?.stack ?? err}`);
  }
};
const names = () => received.map((e) => e.operation);

await check('a script that just ends sends its last spans on beforeExit', async () => {
  const r = await run(`${PRELUDE} evalkit.startTrace('last-words').end();`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(names().includes('last-words'), names().join(','));
});

await check('SIGTERM without a handler of the app: spans are flushed, then the process ends by the signal', async () => {
  const r = await run(`${PRELUDE}
    evalkit.startTrace('before-sigterm').end();
    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);`);
  assert.strictEqual(r.signal, 'SIGTERM', `ended by ${r.signal ?? r.status}: ${r.stderr}`);
  assert.ok(names().includes('before-sigterm'), names().join(','));
});

await check('SIGINT likewise', async () => {
  const r = await run(`${PRELUDE}
    evalkit.startTrace('before-sigint').end();
    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, 'SIGINT'), 100);`);
  assert.strictEqual(r.signal, 'SIGINT', `ended by ${r.signal ?? r.status}`);
  assert.ok(names().includes('before-sigint'));
});

await check('an app with its own SIGTERM handler decides alone', async () => {
  const r = await run(`${PRELUDE}
    process.on('SIGTERM', async () => { process.stdout.write('app shutdown;'); await evalkit.flush(); process.exit(7); });
    evalkit.startTrace('app-handled').end();
    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);`);
  assert.strictEqual(r.status, 7);
  assert.strictEqual(r.stdout, 'app shutdown;');
  assert.ok(names().includes('app-handled'));
});

await check('exitHooks: false installs nothing', async () => {
  const r = await run(`const evalkit = await import(process.env.DIST_);
    evalkit.init({ subscriptionKey: 'k', baseUrl: process.env.URL_, scheduledDelayMillis: 60000, exitHooks: false });
    process.stdout.write(String(process.listenerCount('SIGTERM')) + ',' + String(process.listenerCount('beforeExit')));
    evalkit.startTrace('not-flushed').end();`);
  assert.strictEqual(r.stdout, '0,0');
  assert.ok(!names().includes('not-flushed'));
});

await check('a once() SIGTERM handler registered before init() still runs the shutdown it started', async () => {
  const r = await run(`process.once('SIGTERM', () => { process.stdout.write('draining;'); setTimeout(() => process.exit(5), 300); });
    ${PRELUDE.replace(/\n/g, ' ')}
    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);`);
  assert.strictEqual(r.status, 5, `ended by ${r.signal ?? r.status}`);
  assert.strictEqual(r.stdout, 'draining;');
});

await check('a library that raises the signal again once its listener is the last one still ends the process', async () => {
  const r = await run(`${PRELUDE}
    const onSig = () => {
      if (process.listeners('SIGTERM').length === 1) { process.removeListener('SIGTERM', onSig); process.kill(process.pid, 'SIGTERM'); }
    };
    process.on('SIGTERM', onSig);
    setInterval(() => {}, 1000);
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);`);
  assert.strictEqual(r.signal, 'SIGTERM', `ended by ${r.signal ?? r.status}`);
});

await check('a receiver that never answers does not hold the exit up for long', async () => {
  const sockets = [];
  const hung = http.createServer(() => {});
  hung.on('connection', (socket) => sockets.push(socket));
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const env = { HUNG_: `http://127.0.0.1:${hung.address().port}` };
  const script = (tail) => `const evalkit = await import(process.env.DIST_);
    evalkit.init({ subscriptionKey: 'k', baseUrl: process.env.HUNG_, scheduledDelayMillis: 60000 });
    evalkit.startTrace('unsent').end(); ${tail}`;
  try {
    // The exit flush gives up after its 5 s.
    let started = Date.now();
    let r = await run(script(''), env);
    let took = Date.now() - started;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(took < 8000, `a script that just ended took ${took} ms to exit`);
    // The app's own flush gave up after 300 ms; the export it left runs out its 10 s attempt, and the exit
    // flush then abandons it rather than trying the receiver again.
    started = Date.now();
    r = await run(script('await evalkit.flush(300);'), env);
    took = Date.now() - started;
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(took < 13000, `a script whose flush timed out took ${took} ms to exit`);
  } finally {
    for (const socket of sockets) socket.destroy();
    hung.close();
  }
});

for (const [variable, value] of [['EVALKIT_DISABLED', 'true'], ['OTEL_SDK_DISABLED', 'true']]) {
  await check(`${variable}=${value} turns the SDK off: no patches, no hooks, no requests`, async () => {
    const r = await run(`const evalkit = await import(process.env.DIST_);
      const before = console.log;
      const client = evalkit.init({ subscriptionKey: 'k', baseUrl: process.env.URL_ });
      const traced = evalkit.traceFunction('f', (x) => x * 2);
      const out = [client.tracingMode, client.enabled, console.log === before, process.listenerCount('SIGTERM'), traced(21), evalkit.getStats().circuit_state, await evalkit.flush()];
      evalkit.startTrace('off').end();
      process.stdout.write(JSON.stringify(out));`, { [variable]: value });
    assert.deepStrictEqual(JSON.parse(r.stdout), ['disabled', false, true, 0, 42, 'disabled', false], r.stderr);
    assert.strictEqual(r.stderr, '', 'switching off on purpose prints nothing');
    assert.deepStrictEqual(received, []);
  });
}

await check('invalid options leave the SDK off with one warning, and the app runs as without it', async () => {
  const r = await run(`const evalkit = await import(process.env.DIST_);
    const a = evalkit.init({ subscriptionKey: '', baseUrl: 'not a url', maxQueueSize: -5 });
    const b = evalkit.init({ subscriptionKey: process.env.MISSING_KEY });
    const traced = evalkit.traceFunction('f', async (x) => x + 1);
    process.stdout.write(JSON.stringify([a.tracingMode, b.tracingMode, await traced(1), await evalkit.flush()]));`);
  assert.deepStrictEqual(JSON.parse(r.stdout), ['disabled', 'disabled', 2, false]);
  const warnings = r.stderr.trim().split('\n').filter(Boolean);
  assert.strictEqual(warnings.length, 1, r.stderr);
  assert.ok(warnings[0].includes('subscriptionKey is missing or empty') && warnings[0].includes('baseUrl') && warnings[0].includes('maxQueueSize'), warnings[0]);
});

await check('init() again with different options warns, naming the options and never the key', async () => {
  const r = await run(`${PRELUDE}
    evalkit.init({ subscriptionKey: 'tk_test_other', baseUrl: process.env.URL_, serviceName: 'renamed', scheduledDelayMillis: 60000 });
    evalkit.init({ subscriptionKey: 'tk_test_other', baseUrl: process.env.URL_, serviceName: 'renamed', scheduledDelayMillis: 60000 });`);
  const lines = r.stderr.trim().split('\n').filter((l) => l.includes('init() was called again'));
  assert.strictEqual(lines.length, 1, 'the same options again do not warn');
  assert.ok(lines[0].includes('subscriptionKey, serviceName') && !lines[0].includes('tk_test'), lines[0]);
});

await check('wrappers made before init() run untraced, then trace once init() has run', async () => {
  const r = await run(`const evalkit = await import(process.env.DIST_);
    const early = evalkit.traceFunction('early', (x) => x + 1);
    const tool = evalkit.traceTool('early_tool', async (x) => x * 2);
    const s = evalkit.startSpan('too-soon');
    s.end();
    const before = [early(1), await tool(2), evalkit.startTrace('too-soon-trace').traceId.length];
    evalkit.init({ subscriptionKey: 'k', baseUrl: process.env.URL_, scheduledDelayMillis: 60000 });
    const after = [early(10), await tool(20)];
    process.stdout.write(JSON.stringify([before, after]));`);
  assert.deepStrictEqual(JSON.parse(r.stdout), [[2, 4, 32], [11, 40]], r.stderr);
  const warnings = r.stderr.trim().split('\n').filter(Boolean);
  assert.strictEqual(warnings.length, 1, r.stderr);
  assert.ok(warnings[0].includes('before init()'));
  assert.ok(names().includes('early') && names().includes('early_tool'), names().join(','));
  assert.ok(!names().includes('too-soon'));
});

// The rest runs in this process.
const evalkit = await import(DIST);
const realFetch = globalThis.fetch;

await check('flush(timeoutMs) resolves false when the receiver hangs, without waiting for it', async () => {
  globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const client = evalkit.init({ subscriptionKey: 'k', baseUrl: URL_, scheduledDelayMillis: 60000, exitHooks: false });
  evalkit.startTrace('hung').end();
  const started = Date.now();
  assert.strictEqual(await evalkit.flush(300), false);
  const took = Date.now() - started;
  assert.ok(took >= 250 && took < 1500, `flush took ${took} ms`);
  assert.strictEqual(await client.flush(0), false);
  globalThis.fetch = realFetch;
  await client.destroy(100);
});

await check('withLambda flushes before an async handler returns, and keeps its result and its error', async () => {
  evalkit.init({ subscriptionKey: 'k', baseUrl: URL_, scheduledDelayMillis: 60000, exitHooks: false });
  const handler = evalkit.withLambda(async (event) => {
    evalkit.startTrace('lambda-invocation').end();
    return { statusCode: 200, body: event.name };
  });
  const result = await handler({ name: 'ada' }, { getRemainingTimeInMillis: () => 30000 });
  assert.deepStrictEqual(result, { statusCode: 200, body: 'ada' });
  assert.ok(names().includes('lambda-invocation'), 'the span was sent before the handler returned');
  const failing = evalkit.withLambda(async () => {
    evalkit.startTrace('lambda-failure').end();
    throw new Error('downstream 503');
  });
  await assert.rejects(failing({}, {}), /downstream 503/);
  assert.ok(names().includes('lambda-failure'));
  assert.strictEqual(evalkit.withLambda(async (_event, _context) => 1).length, 2, 'the handler keeps its parameter count');
});

await check('withLambda for a callback-style handler calls back after the flush', async () => {
  const handler = evalkit.withLambda((event, _context, callback) => {
    evalkit.startTrace('lambda-callback').end();
    setTimeout(() => callback(null, { ok: event.n }), 5);
  });
  const answer = await new Promise((resolve) => handler({ n: 3 }, {}, (err, value) => resolve([err, value, names().includes('lambda-callback')])));
  assert.deepStrictEqual(answer, [null, { ok: 3 }, true]);
});

await check('flushAfter hands the flush to after()/waitUntil, and a scheduler that throws is harmless', async () => {
  evalkit.startTrace('after-response').end();
  let scheduled;
  const done = evalkit.flushAfter((task) => { scheduled = task; });
  assert.ok(scheduled && typeof scheduled.then === 'function');
  assert.strictEqual(await done, true);
  assert.ok(names().includes('after-response'));
  assert.strictEqual(await evalkit.flushAfter(() => { throw new Error('after() outside a request'); }), true);
});

await check('getStats counts what was exported and dropped', async () => {
  const client = evalkit.init({ subscriptionKey: 'k', baseUrl: URL_, scheduledDelayMillis: 60000, exitHooks: false, maxQueueSize: 3, maxExportBatchSize: 100 });
  // The first three fill a batch that leaves at once; three more wait while it is in flight; two are dropped.
  for (let i = 0; i < 8; i++) evalkit.startTrace(`stat-${i}`).end();
  const before = evalkit.getStats();
  assert.strictEqual(before.queued, 6);
  assert.strictEqual(before.dropped_queue_full, 2);
  assert.strictEqual(before.circuit_state, 'closed');
  assert.strictEqual(await evalkit.flush(), true);
  const after = client.getStats();
  assert.strictEqual(after.queued, 0);
  assert.strictEqual(after.exported, 6);
  assert.strictEqual(after.last_error, null);
  for (const key of ['queued', 'dropped_queue_full', 'dropped_bytes_budget', 'dropped_export_failed', 'export_failures', 'last_error', 'circuit_state']) {
    assert.ok(key in after, key);
  }
});

clearTimeout(watchdog);
server.close();
const failed = results.filter((r) => r.startsWith('FAIL'));
process.stdout.write(results.join('\n') + '\n');
if (failed.length) fail(`${failed.length} check(s) failed`);
process.stdout.write('PASS lifecycle.e2e.mjs\n');
process.exit(0);
