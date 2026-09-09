import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPENCODE_PLUGIN_SOURCE, PLUGIN_SOURCE_SHA256, buildRecords, hookEvents, main } from '../dist/cli/index.js';

const KEY = 'tk_live_0123456789abcdef0123456789abcdef';
const NOW = 1700000000000000000n;
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timeout'), 60000);

const sha = (text) => createHash('sha256').update(text).digest('hex');
const traceOf = (a, b) => sha(a + b).slice(0, 32);
const spanOf = (text) => sha(text).slice(0, 16);
const attrsOf = (items) => Object.fromEntries((items ?? []).map((a) => [a.key, Object.values(a.value)[0]]));
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
function tmpHome() { return mkdtempSync(join(tmpdir(), 'evalkit-spans-')); }
async function run(argv, home, cwd) {
  const out = [], err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), home, cwd, binary: 'evalkit' });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const CURSOR = { conversation_id: 'conv-1', generation_id: 'gen-1', model: 'claude-sonnet', user_email: 'dev@example.com' };
function cursorSpan(event, extra, captureFull = true) {
  const records = buildRecords('cursor', event, { ...CURSOR, ...extra }, captureFull, NOW);
  assert.strictEqual(records.length, 1, event);
  assert.strictEqual(records[0].signal, 'traces', event);
  return records[0].payload.resourceSpans[0].scopeSpans[0].spans[0];
}
function cursorLog(event, extra, captureFull = true) {
  const records = buildRecords('cursor', event, { ...CURSOR, ...extra }, captureFull, NOW);
  assert.strictEqual(records.length, 1, event);
  assert.strictEqual(records[0].signal, 'logs', event);
  return records[0].payload.resourceLogs[0].scopeLogs[0].logRecords[0];
}

{
  const root = cursorSpan('beforeSubmitPrompt', { prompt: 'fix the flaky test' });
  assert.strictEqual(root.traceId, traceOf('conv-1', 'gen-1'));
  assert.strictEqual(root.spanId, spanOf('gen-1'));
  assert.strictEqual(root.parentSpanId, undefined);
  assert.strictEqual(root.name, 'fix the flaky test');
  assert.strictEqual(root.startTimeUnixNano, String(NOW));
  assert.strictEqual(root.endTimeUnixNano, String(NOW));
  const attrs = attrsOf(root.attributes);
  assert.strictEqual(attrs['evalkit.span_type'], 'agent');
  assert.strictEqual(attrs['gen_ai.operation.name'], 'invoke_agent');
  assert.strictEqual(attrs['agent.vendor'], 'cursor');
  assert.strictEqual(attrs['gen_ai.conversation.id'], 'conv-1');
  assert.strictEqual(attrs['agent.turn.id'], 'gen-1');
  assert.strictEqual(attrs['agent.role'], 'main');
  assert.strictEqual(attrs['gen_ai.agent.name'], 'Cursor');
  assert.strictEqual(attrs['evalkit.attribution'], 'hooks');
  assert.strictEqual(attrs['gen_ai.request.model'], 'claude-sonnet');
  assert.strictEqual(attrs.prompt, 'fix the flaky test');
  assert.strictEqual(attrs['user.id'], 'dev@example.com');

  const minimal = cursorSpan('beforeSubmitPrompt', { prompt: 'fix the flaky test' }, false);
  assert.strictEqual(minimal.name, 'turn');
  const minimalAttrs = attrsOf(minimal.attributes);
  assert.ok(!('prompt' in minimalAttrs) && !('user.id' in minimalAttrs));
}

{
  const record = cursorLog('afterAgentResponse', { text: 'all green' });
  assert.strictEqual(record.traceId, traceOf('conv-1', 'gen-1'));
  assert.strictEqual(record.spanId, spanOf('gen-1'));
  const attrs = attrsOf(record.attributes);
  assert.strictEqual(attrs['event.name'], 'evalkit.enrichment');
  assert.strictEqual(attrs['evalkit.enrichment'], true);
  assert.strictEqual(attrs['evalkit.end_time_unix_nano'], String(NOW));
  assert.strictEqual(attrs.completion, 'all green');
  assert.ok(!('completion' in attrsOf(cursorLog('afterAgentResponse', { text: 'all green' }, false).attributes)));
  assert.strictEqual(attrsOf(cursorLog('stop', {}).attributes)['evalkit.end_time_unix_nano'], String(NOW));
}

{
  const tool = cursorSpan('postToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_9', duration: 250, tool_input: { command: 'ls' }, tool_output: 'a.go' });
  assert.strictEqual(tool.spanId, spanOf('toolu_9'));
  assert.strictEqual(tool.parentSpanId, spanOf('gen-1'));
  assert.strictEqual(BigInt(tool.endTimeUnixNano) - BigInt(tool.startTimeUnixNano), 250n * 1000000n);
  assert.strictEqual(tool.endTimeUnixNano, String(NOW));
  const attrs = attrsOf(tool.attributes);
  assert.strictEqual(attrs['evalkit.span_type'], 'tool_call');
  assert.strictEqual(attrs['gen_ai.operation.name'], 'execute_tool');
  assert.strictEqual(attrs['gen_ai.tool.name'], 'Bash');
  assert.strictEqual(attrs['gen_ai.tool.call.id'], 'toolu_9');
  assert.strictEqual(attrs.duration_ms, '250');
  assert.strictEqual(attrs['tool.arguments'], '{"command":"ls"}');
  assert.strictEqual(attrs['tool.result'], 'a.go');
  assert.deepStrictEqual(tool.status, { code: 1 });

  const failed = cursorSpan('postToolUseFailure', { tool_name: 'Bash', tool_use_id: 'toolu_b', duration: 3 });
  assert.deepStrictEqual(failed.status, { code: 2 });
  assert.strictEqual(attrsOf(failed.attributes).success, false);

  const shell = cursorSpan('afterShellExecution', { command: 'ls', output: 'a.go', duration: 7, tool_use_id: 'toolu_c' });
  assert.strictEqual(shell.name, 'Shell');
  assert.strictEqual(attrsOf(shell.attributes)['tool.arguments'], 'ls');
}

{
  const sub = cursorSpan('subagentStart', { subagent_id: 'sub-7', subagent_type: 'Explore', task: 'find the callers', tool_call_id: 'toolu_9', subagent_model: 'haiku', is_parallel_worker: true });
  assert.strictEqual(sub.spanId, spanOf('sub-7'));
  assert.strictEqual(sub.parentSpanId, spanOf('toolu_9'));
  assert.strictEqual(sub.name, 'subagent:Explore');
  const attrs = attrsOf(sub.attributes);
  assert.strictEqual(attrs['evalkit.span_type'], 'agent');
  assert.strictEqual(attrs['agent.role'], 'subagent');
  assert.strictEqual(attrs['agent.subagent.id'], 'sub-7');
  assert.strictEqual(attrs['agent.subagent.type'], 'Explore');
  assert.strictEqual(attrs['gen_ai.agent.name'], 'Explore');
  assert.strictEqual(attrs['gen_ai.request.model'], 'haiku');
  assert.strictEqual(attrs.prompt, 'find the callers');
  assert.strictEqual(attrs['agent.subagent.is_parallel_worker'], true);

  const stop = cursorLog('subagentStop', { subagent_id: 'sub-7', subagent_type: 'Explore', summary: '3 callers', tool_call_count: 4, message_count: 9, status: 'completed' });
  assert.strictEqual(stop.spanId, spanOf('sub-7'));
  const stopAttrs = attrsOf(stop.attributes);
  assert.strictEqual(stopAttrs['agent.subagent.total_tool_uses'], '4');
  assert.strictEqual(stopAttrs['agent.subagent.message_count'], '9');
  assert.strictEqual(stopAttrs.completion, '3 callers');

  const inner = cursorSpan('postToolUse', { tool_name: 'Read', tool_use_id: 'toolu_x', duration: 5, subagent_id: 'sub-7', subagent_type: 'Explore' });
  assert.strictEqual(inner.parentSpanId, spanOf('sub-7'));
  assert.strictEqual(attrsOf(inner.attributes)['agent.role'], 'subagent');
}

{
  const session = attrsOf(cursorLog('sessionEnd', { duration_ms: 900, final_status: 'completed' }).attributes);
  assert.strictEqual(session['event.name'], 'cursor.sessionEnd');
  assert.strictEqual(session['evalkit.noise'], true);
  assert.strictEqual(session.duration_ms, '900');
  assert.deepStrictEqual(buildRecords('cursor', 'postToolUse', { conversation_id: 'c' }, true, NOW), []);
  assert.deepStrictEqual(buildRecords('cursor', 'beforeShellExecution', CURSOR, true, NOW), []);
  assert.deepStrictEqual(buildRecords('nope', 'postToolUse', CURSOR, true, NOW), []);
}

{
  const base = { trajectory_id: 'traj-1', execution_id: 'exec-1', model_name: 'swe-1' };
  const records = buildRecords('windsurf', 'pre_user_prompt', { ...base, prompt: 'add a test' }, true, NOW);
  const root = records[0].payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(root.traceId, traceOf('traj-1', 'exec-1'));
  assert.strictEqual(root.spanId, spanOf('exec-1'));
  const attrs = attrsOf(root.attributes);
  assert.strictEqual(attrs['gen_ai.conversation.id'], 'traj-1');
  assert.strictEqual(attrs['agent.turn.id'], 'exec-1');
  assert.strictEqual(attrs['gen_ai.agent.name'], 'Windsurf Cascade');
  assert.strictEqual(attrs['gen_ai.request.model'], 'swe-1');

  const done = buildRecords('windsurf', 'post_cascade_response', { ...base, response: 'done' }, true, NOW)[0];
  assert.strictEqual(done.signal, 'logs');
  const record = done.payload.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.strictEqual(record.spanId, root.spanId);
  assert.strictEqual(attrsOf(record.attributes).completion, 'done');

  const command = buildRecords('windsurf', 'post_run_command', { ...base, tool_info: { command: 'go test', output: 'ok', duration_ms: 40, tool_call_id: 'call-9' } }, true, NOW)[0];
  const span = command.payload.resourceSpans[0].scopeSpans[0].spans[0];
  assert.strictEqual(span.spanId, spanOf('call-9'));
  const toolAttrs = attrsOf(span.attributes);
  assert.strictEqual(toolAttrs['gen_ai.tool.name'], 'Command');
  assert.strictEqual(toolAttrs['tool.arguments'], 'go test');
  assert.strictEqual(toolAttrs['tool.result'], 'ok');
  assert.strictEqual(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano), 40n * 1000000n);

  const anonymous = (event) => buildRecords('windsurf', event, { ...base, tool_info: { file_path: 'a.go' } }, true, NOW)[0].payload.resourceSpans[0].scopeSpans[0].spans[0].spanId;
  assert.strictEqual(anonymous('post_read_code'), anonymous('post_read_code'));
  assert.notStrictEqual(anonymous('post_read_code'), anonymous('post_write_code'));
  assert.deepStrictEqual([...hookEvents('windsurf')], ['pre_user_prompt', 'post_cascade_response', 'post_run_command', 'post_write_code', 'post_read_code', 'post_mcp_tool_use']);
  assert.deepStrictEqual([...hookEvents('cursor')], ['sessionStart', 'sessionEnd', 'beforeSubmitPrompt', 'afterAgentResponse', 'stop', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'subagentStart', 'subagentStop']);
}

{
  const home = tmpHome();
  const config = join(home, '.config', 'opencode', 'opencode.json');
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  writeFileSync(config, JSON.stringify({ theme: 'system', plugin: ['other-plugin'] }));
  let r = await run(['coding', 'install', '--vendor', 'opencode', '--key', KEY], home);
  assert.strictEqual(r.code, 0, r.err);
  let data = readJson(config);
  assert.strictEqual(data.theme, 'system');
  assert.deepStrictEqual(data.plugin, ['other-plugin', './plugins/evalkit.ts']);
  const plugin = join(home, '.config', 'opencode', 'plugins', 'evalkit.ts');
  const written = readFileSync(plugin, 'utf8');
  assert.strictEqual(written, OPENCODE_PLUGIN_SOURCE);
  assert.strictEqual(sha(written), PLUGIN_SOURCE_SHA256);
  assert.ok(!written.includes(KEY));
  assert.ok(written.includes('evalkit.enrichment') && written.includes('evalkit.span_type'));
  const asModule = join(home, 'plugin-check.mjs');
  copyFileSync(plugin, asModule);
  execFileSync(process.execPath, ['--check', asModule]);
  const before = readFileSync(config, 'utf8');
  await run(['coding', 'install', '--vendor', 'opencode'], home);
  assert.strictEqual(readFileSync(config, 'utf8'), before);
  r = await run(['coding', 'status'], home);
  assert.ok(r.out.includes('opencode: installed (user)'), r.out);
  r = await run(['coding', 'uninstall', '--vendor', 'opencode'], home);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(readJson(config), { theme: 'system', plugin: ['other-plugin'] });
  assert.ok(!existsSync(plugin));
  rmSync(home, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const project = tmpHome();
  let r = await run(['coding', 'install', '--vendor', 'opencode', '--key', KEY, '--scope', 'project'], home, project);
  assert.strictEqual(r.code, 0, r.err);
  assert.deepStrictEqual(readJson(join(project, 'opencode.json')).plugin, ['./.opencode/plugins/evalkit.ts']);
  assert.ok(existsSync(join(project, '.opencode', 'plugins', 'evalkit.ts')));
  await run(['coding', 'uninstall', '--vendor', 'opencode'], home);
  assert.deepStrictEqual(readJson(join(project, 'opencode.json')), {});
  writeFileSync(join(home, 'opencode.json'), JSON.stringify({ plugin: 'single-plugin' }));
  r = await run(['coding', 'install', '--vendor', 'opencode', '--key', KEY, '--scope', 'project'], home, home);
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(readJson(join(home, 'opencode.json')), { plugin: 'single-plugin' });
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}

{
  const home = tmpHome();
  const hooks = join(home, '.cursor', 'hooks.json');
  mkdirSync(join(home, '.cursor'));
  writeFileSync(hooks, JSON.stringify({ version: 1, hooks: { preToolUse: [{ command: 'evalkit coding hook --vendor cursor --event preToolUse', timeout: 5000 }], stop: [{ command: 'notify-send done' }] } }));
  const r = await run(['coding', 'install', '--vendor', 'cursor', '--key', KEY], home);
  assert.strictEqual(r.code, 0, r.err);
  const data = readJson(hooks);
  assert.ok(!('preToolUse' in data.hooks), 'reinstall must drop owned hooks of events we no longer use');
  assert.deepStrictEqual(Object.keys(data.hooks).sort(), [...hookEvents('cursor')].sort());
  await run(['coding', 'uninstall', '--vendor', 'cursor'], home);
  assert.deepStrictEqual(readJson(hooks), { version: 1, hooks: { stop: [{ command: 'notify-send done' }] } });
  await run(['coding', 'install', '--vendor', 'windsurf', '--key', KEY], home);
  const windsurf = join(home, '.codeium', 'windsurf', 'hooks.json');
  assert.strictEqual(Object.keys(readJson(windsurf).hooks).length, hookEvents('windsurf').length);
  await run(['coding', 'uninstall', '--vendor', 'windsurf'], home);
  assert.deepStrictEqual(readJson(windsurf), {});
  rmSync(home, { recursive: true, force: true });
}

console.log('coding-spans.e2e OK');
process.exit(0);
