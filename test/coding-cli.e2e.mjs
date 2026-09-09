import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookEvents, main } from '../dist/cli/index.js';

const KEY = 'tk_live_0123456789abcdef0123456789abcdef';
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 60000);

function tmpHome() { return mkdtempSync(join(tmpdir(), 'evalkit-cli-')); }
async function run(argv, home, cwd) {
  const out = [], err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), home, cwd, binary: 'evalkit' });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
function runBin(args, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['bin/evalkit.js', ...args], { env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

{
  const home = tmpHome();
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash'] }, env: { OTEL_LOGS_EXPORTER: 'console', FOO: 'bar' } }));
  let r = await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY, '--endpoint', 'https://x.test/otlp/'], home);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!r.out.includes(KEY));
  let data = readJson(settings);
  assert.deepStrictEqual(data.permissions, { allow: ['Bash'] });
  assert.strictEqual(data.env.FOO, 'bar');
  assert.strictEqual(data.env.OTEL_LOGS_EXPORTER, 'otlp');
  assert.strictEqual(data.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'https://x.test/otlp');
  assert.strictEqual(data.env.OTEL_EXPORTER_OTLP_HEADERS, `Authorization=Bearer ${KEY}`);
  assert.ok(!('OTEL_LOG_USER_PROMPTS' in data.env));
  assert.strictEqual(data.env.CLAUDE_CODE_ENHANCED_TELEMETRY_BETA, '1');
  assert.strictEqual(data.env.OTEL_TRACES_EXPORTER, 'otlp');
  assert.strictEqual(data.env.OTEL_TRACES_EXPORT_INTERVAL, '1000');
  const cfg = join(home, '.config', 'evalkit', 'config.env');
  assert.strictEqual(statSync(cfg).mode & 0o777, 0o600);
  assert.ok(readFileSync(cfg, 'utf8').includes(`EVALKIT_API_KEY=${KEY}`));
  const before = readFileSync(settings, 'utf8');
  r = await run(['coding', 'install', '--vendor', 'claude-code'], home);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(readFileSync(settings, 'utf8'), before);
  r = await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  assert.strictEqual(r.code, 0);
  data = readJson(settings);
  assert.deepStrictEqual(data.env, { OTEL_LOGS_EXPORTER: 'console', FOO: 'bar' });

  r = await run(['coding', 'install', '--vendor', 'claude-code', '--capture', 'full', '--traces', '--dry-run'], home);
  assert.ok(r.out.includes('would write'));
  assert.deepStrictEqual(readJson(settings).env, { OTEL_LOGS_EXPORTER: 'console', FOO: 'bar' });
  r = await run(['coding', 'install', '--vendor', 'claude-code', '--capture', 'full', '--traces'], home);
  data = readJson(settings);
  assert.strictEqual(data.env.OTEL_LOG_USER_PROMPTS, '1');
  assert.strictEqual(data.env.OTEL_LOG_TOOL_CONTENT, '1');
  assert.strictEqual(data.env.OTEL_LOG_ASSISTANT_RESPONSES, '1');
  assert.strictEqual(data.env.OTEL_LOG_RAW_API_BODIES, '1');
  assert.strictEqual(data.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH, '524288');
  assert.strictEqual(data.env.OTEL_TRACES_EXPORTER, 'otlp');
  r = await run(['coding', 'install', '--vendor', 'claude-code', '--managed'], home);
  assert.ok(r.out.includes('<EVALKIT_KEY>') && !r.out.includes(KEY));
  r = await run(['coding', 'install', '--vendor', 'claude-code', '--no-traces'], home);
  assert.strictEqual(r.code, 0, r.err);
  data = readJson(settings);
  assert.ok(!('OTEL_TRACES_EXPORTER' in data.env) && !('CLAUDE_CODE_ENHANCED_TELEMETRY_BETA' in data.env) && !('OTEL_TRACES_EXPORT_INTERVAL' in data.env));
  r = await run(['coding', 'status'], home);
  assert.ok(r.out.includes('traces off'), r.out);
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  const original = {
    env: { FOO: 'bar' },
    hooks: {
      SubagentStop: [{ matcher: 'Explore', hooks: [{ type: 'command', command: 'notify-send done' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
  };
  writeFileSync(settings, JSON.stringify(original));
  let r = await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(r.out.includes('merged 2 agent hooks'));
  let data = readJson(settings);
  assert.strictEqual(data.hooks.PostToolUse.length, 1);
  const postHook = data.hooks.PostToolUse[0].hooks[0];
  assert.strictEqual(postHook.type, 'command');
  assert.strictEqual(postHook.timeout, 5);
  assert.ok(postHook.command.includes('coding hook --vendor claude-code --event PostToolUse'));
  assert.ok(!('SubagentStart' in data.hooks));
  assert.deepStrictEqual(data.hooks.SubagentStop[0], original.hooks.SubagentStop[0]);
  assert.ok(data.hooks.SubagentStop[1].hooks[0].command.includes('--event SubagentStop'));
  assert.deepStrictEqual(data.hooks.PreToolUse, original.hooks.PreToolUse);
  await run(['coding', 'install', '--vendor', 'claude-code'], home);
  data = readJson(settings);
  assert.strictEqual(data.hooks.PostToolUse.length, 1);
  assert.strictEqual(data.hooks.SubagentStop.length, 2);
  {
    const stale = { hooks: [{ type: 'command', command: 'node bin/evalkit.js coding hook --vendor claude-code --event SubagentStart', timeout: 5 }] };
    const withStale = readJson(settings);
    withStale.hooks.SubagentStart = [stale];
    writeFileSync(settings, JSON.stringify(withStale));
    r = await run(['coding', 'install', '--vendor', 'claude-code'], home);
    assert.strictEqual(r.code, 0, r.err);
    data = readJson(settings);
    assert.ok(!('SubagentStart' in data.hooks), 'reinstall must drop owned hooks of events no longer installed');
    assert.strictEqual(data.hooks.PostToolUse.length, 1);
    assert.strictEqual(data.hooks.SubagentStop.length, 2);
  }
  r = await run(['coding', 'status'], home);
  assert.ok(r.out.includes('agent hooks: on'), r.out);
  r = await run(['coding', 'install', '--vendor', 'claude-code', '--no-subagents'], home);
  assert.ok(r.out.includes('removed 2 agent hooks'), r.out);
  assert.deepStrictEqual(readJson(settings).hooks, original.hooks);
  r = await run(['coding', 'status'], home);
  assert.ok(r.out.includes('agent hooks: off'), r.out);
  await run(['coding', 'install', '--vendor', 'claude-code'], home);
  r = await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  assert.ok(r.out.includes('removed 2 agent hooks'), r.out);
  assert.deepStrictEqual(readJson(settings), original);
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  const data = readJson(join(home, '.claude', 'settings.json'));
  assert.deepStrictEqual(Object.keys(data.hooks).sort(), ['PostToolUse', 'SubagentStop']);
  await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  assert.ok(!('hooks' in readJson(join(home, '.claude', 'settings.json'))));
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const r = await run(['coding', 'install', '--vendor', 'claude-code'], home);
  assert.strictEqual(r.code, 2);
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const cfg = join(home, '.codex', 'config.toml');
  mkdirSync(join(home, '.codex'));
  const original = 'model = "gpt-5"\n\n[sandbox]\nmode = "read-only"\n';
  writeFileSync(cfg, original);
  let r = await run(['coding', 'install', '--vendor', 'codex', '--key', KEY, '--endpoint', 'https://x.test/otlp'], home);
  assert.strictEqual(r.code, 0, r.err);
  let text = readFileSync(cfg, 'utf8');
  assert.ok(text.startsWith('model = "gpt-5"'));
  assert.ok(text.includes('# evalkit-managed-begin\n[otel]\n'));
  assert.ok(text.includes('endpoint = "https://x.test/otlp/v1/logs", protocol = "binary"'));
  assert.ok(text.includes(`"Authorization" = "Bearer ${KEY}"`));
  assert.ok(text.includes('endpoint = "https://x.test/otlp/v1/traces", protocol = "binary"'));
  const before = text;
  await run(['coding', 'install', '--vendor', 'codex'], home);
  assert.strictEqual(readFileSync(cfg, 'utf8'), before);
  await run(['coding', 'install', '--vendor', 'codex', '--no-traces', '--capture', 'full'], home);
  text = readFileSync(cfg, 'utf8');
  assert.strictEqual(text.split('[otel]').length - 1, 1);
  assert.ok(text.includes('trace_exporter = "none"') && text.includes('log_user_prompt = true'));
  r = await run(['coding', 'uninstall', '--vendor', 'codex'], home);
  assert.strictEqual(readFileSync(cfg, 'utf8'), original);
  writeFileSync(cfg, '[otel]\nexporter = "none"\n');
  r = await run(['coding', 'install', '--vendor', 'codex', '--key', KEY], home);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(readFileSync(cfg, 'utf8'), '[otel]\nexporter = "none"\n');
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const settings = join(home, '.gemini', 'settings.json');
  mkdirSync(join(home, '.gemini'));
  writeFileSync(settings, JSON.stringify({ theme: 'dark', telemetry: { enabled: false, logPrompts: true } }));
  const env = join(home, '.gemini', '.env');
  writeFileSync(env, 'GEMINI_API_KEY=abc\n');
  let r = await run(['coding', 'install', '--vendor', 'gemini-cli', '--key', KEY, '--endpoint', 'https://x.test/otlp'], home);
  assert.strictEqual(r.code, 0, r.err);
  const data = readJson(settings);
  assert.strictEqual(data.theme, 'dark');
  assert.deepStrictEqual(data.telemetry, { enabled: true, target: 'local', otlpEndpoint: 'https://x.test/otlp', otlpProtocol: 'http', logPrompts: false, traces: true });
  assert.strictEqual(readFileSync(env, 'utf8'), `GEMINI_API_KEY=abc\n\n# evalkit-begin\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${KEY}\n# evalkit-end\n`);
  assert.strictEqual(statSync(env).mode & 0o777, 0o600);
  r = await run(['coding', 'uninstall', '--vendor', 'gemini-cli'], home);
  assert.deepStrictEqual(readJson(settings), { theme: 'dark', telemetry: { enabled: false, logPrompts: true } });
  assert.strictEqual(readFileSync(env, 'utf8'), 'GEMINI_API_KEY=abc\n');
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const hooks = join(home, '.cursor', 'hooks.json');
  mkdirSync(join(home, '.cursor'));
  writeFileSync(hooks, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'notify-send done' }] } }));
  let r = await run(['coding', 'install', '--vendor', 'cursor', '--key', KEY], home);
  assert.strictEqual(r.code, 0, r.err);
  let data = readJson(hooks);
  assert.deepStrictEqual(Object.keys(data.hooks).sort(), [...hookEvents('cursor')].sort());
  assert.deepStrictEqual(data.hooks.stop[0], { command: 'notify-send done' });
  assert.ok(data.hooks.stop[1].command.includes('coding hook --vendor cursor --event stop'));
  assert.strictEqual(data.hooks.stop[1].timeout, 5000);
  await run(['coding', 'install', '--vendor', 'cursor'], home);
  assert.strictEqual(readJson(hooks).hooks.stop.length, 2);
  r = await run(['coding', 'uninstall', '--vendor', 'cursor'], home);
  assert.deepStrictEqual(readJson(hooks), { version: 1, hooks: { stop: [{ command: 'notify-send done' }] } });
  writeFileSync(hooks, '{ not json');
  r = await run(['coding', 'install', '--vendor', 'cursor', '--key', KEY], home);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(readFileSync(hooks, 'utf8'), '{ not json');
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const project = tmpHome();
  const r = await run(['coding', 'install', '--vendor', 'windsurf', '--key', KEY, '--scope', 'project'], home, project);
  assert.strictEqual(r.code, 0, r.err);
  const data = readJson(join(project, '.windsurf', 'hooks.json'));
  assert.deepStrictEqual(Object.keys(data.hooks).sort(), [...hookEvents('windsurf')].sort());
  assert.ok(!('version' in data));
  assert.ok(!('timeout' in data.hooks.pre_user_prompt[0]));
  const status = await run(['coding', 'status'], home);
  assert.ok(status.out.includes('tk_live_…cdef') && !status.out.includes(KEY));
  assert.ok(status.out.includes('windsurf: installed (project)') && status.out.includes('codex: not installed'));
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

{
  const store = { posts: [], gets: [], spans: new Map(), enrichments: [] };
  let status = 200;
  const attrsOf = (items) => Object.fromEntries((items ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      const parts = req.url.split('?')[0].split('/').filter(Boolean);
      const trace = parts[parts.length - 1];
      store.gets.push({ tenant: parts[parts.length - 2], trace, auth: req.headers.authorization });
      const rows = (store.spans.get(trace) ?? []).map((span) => {
        const extra = store.enrichments.find((e) => e.spanId === span.spanId) ?? { attrs: {} };
        return { traceId: span.traceId, spanId: span.spanId, prompt: span.attrs.prompt ?? extra.attrs.prompt ?? '', completion: extra.attrs.completion ?? '' };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: rows, meta: { count: rows.length } }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      store.posts.push({ path: req.url, auth: req.headers.authorization, body: parsed });
      for (const rs of parsed.resourceSpans ?? []) {
        for (const ss of rs.scopeSpans ?? []) {
          for (const sp of ss.spans ?? []) {
            const row = { traceId: sp.traceId, spanId: sp.spanId, parentSpanId: sp.parentSpanId, name: sp.name, attrs: attrsOf(sp.attributes) };
            store.spans.set(row.traceId, [...(store.spans.get(row.traceId) ?? []), row]);
          }
        }
      }
      for (const rl of parsed.resourceLogs ?? []) {
        for (const sl of rl.scopeLogs ?? []) {
          for (const rec of sl.logRecords ?? []) store.enrichments.push({ traceId: rec.traceId, spanId: rec.spanId, attrs: attrsOf(rec.attributes) });
        }
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/otlp`;

  const home = tmpHome();
  await run(['coding', 'install', '--vendor', 'codex', '--key', KEY, '--endpoint', endpoint, '--tenant', 'tenant-1'], home);
  let r = await run(['coding', 'doctor'], home);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(r.out.includes('round trip: ok'), r.out);
  assert.ok(r.out.includes('3 spans merged, prompt present'), r.out);
  assert.ok(r.out.includes('codex: installed (user) · capture minimal · traces on'), r.out);
  assert.deepStrictEqual(store.posts.map((call) => call.path), ['/v1/otlp/v1/traces', '/v1/otlp/v1/logs']);
  assert.strictEqual(store.posts[0].auth, `Bearer ${KEY}`);
  assert.strictEqual(store.gets[0].tenant, 'tenant-1');
  assert.strictEqual(store.gets[0].auth, `Bearer ${KEY}`);
  const tree = store.spans.get(store.gets[0].trace);
  assert.deepStrictEqual(tree.map((s) => s.attrs['evalkit.span_type']), ['agent', 'llm_call', 'tool_call']);
  assert.deepStrictEqual(tree.slice(1).map((s) => s.parentSpanId), [tree[0].spanId, tree[0].spanId]);
  assert.strictEqual(tree[0].attrs['gen_ai.operation.name'], 'invoke_agent');
  assert.strictEqual(store.enrichments[0].spanId, tree[0].spanId);
  assert.strictEqual(store.enrichments[0].attrs['evalkit.enrichment'], true);
  assert.ok(store.enrichments[0].attrs.completion.length > 0);
  r = await run(['coding', 'status'], home);
  assert.ok(r.out.includes('last doctor: ok at '), r.out);
  status = 500;
  r = await run(['coding', 'doctor'], home);
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.includes('posting spans failed'), r.out);
  status = 200;

  await run(['coding', 'install', '--vendor', 'cursor', '--key', KEY, '--endpoint', endpoint], home);
  const payload = JSON.stringify({ conversation_id: 'c1', generation_id: 'g1', tool_name: 'Bash', tool_use_id: 'tu1', duration: 12, tool_input: { command: 'ls' }, tool_output: 'secret text' });
  const proc = await runBin(['coding', 'hook', '--vendor', 'cursor', '--event', 'postToolUse'], payload, { HOME: home });
  assert.strictEqual(proc.status, 0, proc.stderr);
  assert.strictEqual(proc.stdout, '');
  const hookCall = store.posts[store.posts.length - 1];
  assert.strictEqual(hookCall.path, '/v1/otlp/v1/traces');
  const hookSpan = hookCall.body.resourceSpans[0].scopeSpans[0].spans[0];
  const hookAttrs = attrsOf(hookSpan.attributes);
  assert.strictEqual(hookSpan.name, 'Bash');
  assert.strictEqual(hookAttrs['evalkit.span_type'], 'tool_call');
  assert.strictEqual(hookAttrs['gen_ai.tool.name'], 'Bash');
  assert.strictEqual(hookAttrs['gen_ai.tool.call.id'], 'tu1');
  assert.strictEqual(hookAttrs.duration_ms, '12');
  assert.ok(!('tool.result' in hookAttrs) && !('tool.arguments' in hookAttrs));
  const resource = attrsOf(hookCall.body.resourceSpans[0].resource.attributes);
  assert.strictEqual(resource['agent.vendor'], 'cursor');

  const dead = await runBin(['coding', 'hook', '--vendor', 'cursor', '--event', 'stop'], 'not json', { HOME: home, EVALKIT_OTLP_ENDPOINT: 'http://127.0.0.1:9' });
  assert.strictEqual(dead.status, 0);
  assert.strictEqual(dead.stdout, '');

  await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY, '--endpoint', endpoint], home);
  const subagent = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', cwd: '/work', hook_event_name: 'SubagentStop', agent_id: 'agent-42', agent_type: 'Explore', last_assistant_message: 'done' };
  const marker = await runBin(['coding', 'hook', '--vendor', 'claude-code', '--event', 'SubagentStop'], JSON.stringify(subagent), { HOME: home });
  assert.strictEqual(marker.status, 0, marker.stderr);
  assert.strictEqual(marker.stdout, '');
  const markerCall = store.posts[store.posts.length - 1];
  assert.strictEqual(markerCall.path, '/v1/otlp/v1/logs');
  const markerAttrs = attrsOf(markerCall.body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes);
  assert.strictEqual(markerAttrs['event.name'], 'claude_code.subagent_stop');
  assert.strictEqual(markerAttrs['session.id'], 'sess-1');
  assert.strictEqual(markerAttrs['agent.id'], 'agent-42');
  assert.strictEqual(markerAttrs['agent.type'], 'Explore');
  assert.ok(!('agent.last_message' in markerAttrs) && !('transcript_path' in markerAttrs));
  const markerResource = attrsOf(markerCall.body.resourceLogs[0].resource.attributes);
  assert.strictEqual(markerResource['service.name'], 'claude-code');
  const seen = store.posts.length;
  const ignored = await runBin(['coding', 'hook', '--vendor', 'claude-code', '--event', 'PreToolUse'], JSON.stringify(subagent), { HOME: home });
  assert.strictEqual(ignored.status, 0);
  assert.strictEqual(store.posts.length, seen);

  const toolPayload = { session_id: 'sess-1', transcript_path: '/tmp/t.jsonl', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_7', duration_ms: 412, agent_id: 'agent-42', agent_type: 'Explore', tool_input: { command: 'ls' }, tool_response: 'a.go' };
  const minimalRun = await runBin(['coding', 'hook', '--vendor', 'claude-code', '--event', 'PostToolUse'], JSON.stringify(toolPayload), { HOME: home });
  assert.strictEqual(minimalRun.status, 0, minimalRun.stderr);
  const minimal = attrsOf(store.posts[store.posts.length - 1].body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes);
  assert.strictEqual(minimal['event.name'], 'claude_code.tool_output');
  assert.strictEqual(minimal.tool_use_id, 'toolu_7');
  assert.strictEqual(minimal.tool_name, 'Bash');
  assert.strictEqual(minimal.duration_ms, '412');
  assert.strictEqual(minimal['agent.id'], 'agent-42');
  assert.strictEqual(minimal['agent.type'], 'Explore');
  assert.ok(!('tool_output' in minimal) && !('transcript_path' in minimal) && !('tool_input' in minimal), JSON.stringify(minimal));
  await run(['coding', 'install', '--vendor', 'claude-code', '--capture', 'full', '--endpoint', endpoint], home);
  const fullRun = await runBin(['coding', 'hook', '--vendor', 'claude-code', '--event', 'PostToolUse'], JSON.stringify(toolPayload), { HOME: home });
  assert.strictEqual(fullRun.status, 0, fullRun.stderr);
  assert.strictEqual(attrsOf(store.posts[store.posts.length - 1].body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes).tool_output, 'a.go');

  await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  await run(['coding', 'uninstall', '--vendor', 'cursor'], home);
  await run(['coding', 'uninstall', '--vendor', 'codex', '--purge'], home);
  assert.ok(!existsSync(join(home, '.config', 'evalkit')));
  server.close();
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  const original = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_METRICS_EXPORTER: 'otlp', FOO: 'bar' } };
  writeFileSync(settings, JSON.stringify(original));
  await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  assert.deepStrictEqual(readJson(settings).env, original.env);
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const project = tmpHome();
  await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  await run(['coding', 'install', '--vendor', 'claude-code', '--scope', 'project'], home, project);
  const userSettings = join(home, '.claude', 'settings.json');
  const projectSettings = join(project, '.claude', 'settings.json');
  const state = readJson(join(home, '.config', 'evalkit', 'state.json'));
  assert.deepStrictEqual(Object.keys(state.vendors['claude-code'].files).sort(), [userSettings, projectSettings].sort());
  await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  for (const path of [userSettings, projectSettings]) assert.ok(!readFileSync(path, 'utf8').includes(KEY), path);
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const settings = join(home, '.claude', 'settings.json');
  mkdirSync(join(home, '.claude'));
  const original = { hooks: { Notification: { legacy: 'shape' }, Stop: [], PreToolUse: [{ hooks: [{ type: 'command', command: 'echo pre' }] }] } };
  writeFileSync(settings, JSON.stringify(original));
  await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  await run(['coding', 'uninstall', '--vendor', 'claude-code'], home);
  assert.deepStrictEqual(readJson(settings), original);

  const refused = JSON.stringify({ hooks: { PostToolUse: { legacy: 'shape' } } });
  writeFileSync(settings, refused);
  const r = await run(['coding', 'install', '--vendor', 'claude-code', '--key', KEY], home);
  assert.strictEqual(r.code, 1, r.out);
  assert.strictEqual(readFileSync(settings, 'utf8'), refused);
  rmSync(home, { recursive: true, force: true });
}

console.log('coding-cli.e2e OK');
process.exit(0);
