import type { EvalKitClient } from '../../../core/client.js';

// OpenAI Realtime runs over a WebSocket and is event-emitter based, so nothing
// auto-instruments it. We attach listeners to an already-created realtime
// connection: open a `voice.session` trace, emit one `voice.turn` span per model
// turn (prompt/completion/tokens/request+response body) on `response.done`, a
// `tool_call` span per function call, and close the session when the socket
// closes/errors. Mirrors google-live.ts.
//
// The realtime API shape varies by `openai` version, so everything here is
// best-effort: typeof checks, optional chaining, try/catch around every callback
// body and around attachment itself. On any failure we return the original `rt`
// untouched — tracing must NEVER throw into the host audio stream.

const CAP = 8192;

// Pull a transcript/text delta off a realtime event, tolerating shape drift
// (top-level `.delta`, or nested `.delta.text` / `.delta.transcript`).
function extractDelta(ev: any): string {
  const d = ev?.delta;
  if (typeof d === 'string') return d;
  if (typeof d?.text === 'string') return d.text;
  if (typeof d?.transcript === 'string') return d.transcript;
  if (typeof ev?.text === 'string') return ev.text;
  if (typeof ev?.transcript === 'string') return ev.transcript;
  return '';
}

function safeJson(value: unknown, limit = 16384): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const s = JSON.stringify(value);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  } catch {
    return undefined;
  }
}

// Wires up one instrumented realtime session: shared by the explicit
// `traceOpenAIRealtime` drop-in, the constructor-patch auto path, and the
// `.on`-patch auto path (`attachWith`), each of which just supplies its own
// `on(event, cb)` binder.
function wireSession(
  client: EvalKitClient,
  rt: any,
  on: (event: string, cb: (...a: any[]) => void) => void,
  base: Record<string, string>,
): { endSession: () => void } {
  const session = client.startTrace('voice.session', base);

  let completionBuf = '';
  let inputParts: string[] = [];
  let turnStart = Date.now();
  let ended = false;
  const endSession = () => {
    if (ended) return;
    ended = true;
    try { session.end('OK'); } catch { /* ignore */ }
  };

  const resetTurn = () => {
    completionBuf = '';
    inputParts = [];
    turnStart = Date.now();
  };

  // User's spoken input, transcribed server-side — the "prompt" half of the turn.
  on('conversation.item.input_audio_transcription.completed', (ev: any) => {
    try {
      const transcript = ev?.transcript;
      if (typeof transcript === 'string' && transcript) inputParts.push(transcript);
    } catch { /* never break the stream */ }
  });

  // Streaming transcript / text deltas accumulate into the current turn.
  const onDelta = (ev: any) => {
    try { completionBuf += extractDelta(ev); } catch { /* never break the stream */ }
  };
  on('response.audio_transcript.delta', onDelta);
  on('response.text.delta', onDelta);
  on('response.output_text.delta', onDelta);

  // A completed model turn → one voice.turn llm_call span.
  on('response.done', (ev: any) => {
    try {
      const prompt = inputParts.join('\n').trim();
      const completion = completionBuf.trim();
      const ms = Date.now() - turnStart;
      const response = ev?.response;
      resetTurn();
      if (!prompt && !completion) return; // skip audio-only turns with no transcript at all

      const usage = response?.usage;
      const tokensIn = usage?.input_tokens ?? 0;
      const tokensOut = usage?.output_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? (tokensIn + tokensOut);
      const responseBody = safeJson(response);

      const { end } = client.startSpan('voice.turn', {
        ...base,
        'evalkit.span_type': 'llm_call',
        ...(prompt && { 'evalkit.prompt': prompt.slice(0, CAP) }),
        ...(completion && { 'evalkit.completion': completion.slice(0, CAP) }),
        'gen_ai.usage.input_tokens': tokensIn,
        'gen_ai.usage.output_tokens': tokensOut,
        'gen_ai.usage.total_tokens': totalTokens,
        ...(responseBody && { 'gen_ai.response.body': responseBody }),
        'llm.turn_ms': ms,
      }, session.ctx);
      end('OK');
    } catch { /* never break the stream */ }
  });

  // Each function call → one tool_call span. Arguments arrive as a JSON string.
  on('response.function_call_arguments.done', (ev: any) => {
    try {
      const name = ev?.name ?? ev?.function?.name;
      if (!name) return;
      const args = ev?.arguments ?? ev?.delta ?? '';
      const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {});
      const { end } = client.startSpan(String(name), {
        ...base,
        'evalkit.span_type': 'tool_call',
        'gen_ai.tool.name': String(name),
        'gen_ai.tool.call.arguments': String(argStr).slice(0, CAP),
        'tool.name': String(name),
      }, session.ctx);
      end('OK');
    } catch { /* never break the stream */ }
  });

  on('close', endSession);
  on('error', endSession);

  return { endSession };
}

function attachRealtimeListeners(
  client: EvalKitClient,
  rt: any,
  opts: { model?: string; sessionId?: string; userId?: string } = {},
): any {
  try {
    if (!rt || typeof rt.on !== 'function') return rt;
    // Idempotency — never double-instrument the same connection.
    if ((rt as { __evalkit?: boolean }).__evalkit) return rt;

    const model = String(
      opts.model ?? rt?.model ?? rt?.session?.model ?? 'gpt-realtime',
    );
    const base: Record<string, string> = {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': model,
      ...(opts.sessionId ? { 'evalkit.session_id': opts.sessionId } : {}),
      ...(opts.userId ? { 'evalkit.user_id': opts.userId } : {}),
    };
    const on = (event: string, cb: (...a: any[]) => void) => {
      try { rt.on(event, cb); } catch { /* never break the host */ }
    };
    wireSession(client, rt, on, base);

    (rt as { __evalkit?: boolean }).__evalkit = true;
    return rt;
  } catch {
    // Attachment failed — return the connection untouched, fail open.
    return rt;
  }
}

// Explicit drop-in: attach tracing to an already-created realtime connection.
//   const rt = new OpenAIRealtimeWebSocket({ model });
//   traceOpenAIRealtime(client, rt);
export function traceOpenAIRealtime(
  client: EvalKitClient,
  rt: any,
  opts: { model?: string; sessionId?: string; userId?: string } = {},
): any {
  return attachRealtimeListeners(client, rt, opts);
}

// Auto path: patch the realtime class so any new connection is auto-traced.
// We wrap the constructor to attach listeners on the freshly built instance.
// Best-effort — if no realtime class is resolvable, this is a no-op.
export function patchOpenAIRealtime(client: EvalKitClient, RealtimeClass: any): void {
  try {
    if (typeof RealtimeClass !== 'function') return;
    if ((RealtimeClass as { __evalkit?: boolean }).__evalkit) return;
    const proto = RealtimeClass.prototype;
    if (!proto) return;

    // OpenAI's realtime emitter exposes `on`; patch it so the first listener
    // registration triggers our attachment, without subclassing the constructor
    // (which would require re-exporting). We hook `on` once per instance.
    const origOn = typeof proto.on === 'function' ? proto.on : null;
    if (!origOn) return;
    if ((proto.on as { __evalkit?: boolean }).__evalkit) return;

    proto.on = function (this: any, ...args: any[]): any {
      try {
        if (!(this as { __evalkit?: boolean }).__evalkit) {
          // Mark first so wireSession (which also calls .on) doesn't recurse,
          // then attach our listeners via the original `on`.
          (this as { __evalkit?: boolean }).__evalkit = true;
          attachWith(client, this, origOn);
        }
      } catch { /* never break the host */ }
      return origOn.apply(this, args);
    };
    (proto.on as { __evalkit?: boolean }).__evalkit = true;
    (RealtimeClass as { __evalkit?: boolean }).__evalkit = true;
  } catch { /* fail open — never throw into the host */ }
}

// Like attachRealtimeListeners but uses a captured original `on` (the instance's
// `on` may already be our patched wrapper). Idempotency is handled by the caller.
function attachWith(client: EvalKitClient, rt: any, origOn: (...a: any[]) => any): void {
  try {
    const model = String(rt?.model ?? rt?.session?.model ?? 'gpt-realtime');
    const base: Record<string, string> = {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': model,
    };
    const on = (event: string, cb: (...a: any[]) => void) => {
      try { origOn.call(rt, event, cb); } catch { /* ignore */ }
    };
    wireSession(client, rt, on, base);
  } catch { /* fail open */ }
}
