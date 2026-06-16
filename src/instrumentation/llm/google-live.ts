import type { EvalKitClient } from '../../core/client.js';

// Gemini Live runs over a WebSocket, which nothing auto-instruments. We wrap the
// connect params: open a `voice.session` trace, emit one `voice.turn` span per
// model turn (text + latency), and close the session when the socket closes.
// Shared by both the auto patch (patchGoogleLive) and the explicit helper (traceLive).
function wrapConnectParams(
  client: EvalKitClient,
  params: any,
  opts: { sessionId?: string; userId?: string } = {},
): { params: any; closed: () => void } {
  const model = String(params?.model ?? 'gemini-live');
  const base: Record<string, string> = {
    'gen_ai.system': 'google',
    'gen_ai.request.model': model,
    ...(opts.sessionId ? { 'evalkit.session_id': opts.sessionId } : {}),
    ...(opts.userId ? { 'evalkit.user_id': opts.userId } : {}),
  };
  const session = client.startTrace('voice.session', base);

  let buf = '';
  let turnStart = Date.now();
  const userOnMessage = params?.callbacks?.onmessage;

  const wrapped = {
    ...params,
    callbacks: {
      ...(params?.callbacks ?? {}),
      onmessage: (msg: any) => {
        try {
          // Audio responses carry text via outputTranscription, not modelTurn.parts.
          const parts = msg?.serverContent?.modelTurn?.parts ?? [];
          for (const p of parts) if (typeof p?.text === 'string') buf += p.text;
          const otext = msg?.serverContent?.outputTranscription?.text;
          if (typeof otext === 'string') buf += otext;

          // Live tool/function calls arrive on msg.toolCall.
          const fns = msg?.toolCall?.functionCalls;
          if (Array.isArray(fns)) {
            for (const fc of fns) {
              if (!fc?.name) continue;
              const { end } = client.startSpan(String(fc.name), {
                ...base,
                'evalkit.span_type': 'tool_call',
                'gen_ai.tool.name': String(fc.name),
                'gen_ai.tool.call.arguments': JSON.stringify(fc.args ?? {}).slice(0, 8192),
                'tool.name': String(fc.name),
              }, session.ctx);
              end('OK');
            }
          }

          if (msg?.serverContent?.turnComplete) {
            const text = buf.trim();
            const ms = Date.now() - turnStart;
            buf = '';
            turnStart = Date.now();
            if (text) {  // skip empty turns (audio-only with no transcript)
              const { end } = client.startSpan('voice.turn', {
                ...base,
                'evalkit.span_type': 'llm_call',
                'evalkit.completion': text.slice(0, 8192),
                'llm.turn_ms': ms,
              }, session.ctx);
              end('OK');
            }
          }
        } catch { /* never break the audio stream */ }
        return userOnMessage?.(msg);
      },
    },
  };

  return { params: wrapped, closed: () => { try { session.end('OK'); } catch { /* ignore */ } } };
}

function attachClose(live: any, closed: () => void): any {
  const origClose = typeof live?.close === 'function' ? live.close.bind(live) : null;
  if (origClose) live.close = (...a: any[]) => { closed(); return origClose(...a); };
  return live;
}

// Explicit drop-in for `ai.live.connect(params)`.
export async function traceLive(
  client: EvalKitClient,
  ai: any,
  params: any,
  opts: { sessionId?: string; userId?: string } = {},
): Promise<any> {
  const { params: wrapped, closed } = wrapConnectParams(client, params, opts);
  return attachClose(await ai.live.connect(wrapped), closed);
}

// Auto path: patch Live.prototype.connect so plain `ai.live.connect(...)` is traced.
export function patchGoogleLive(client: EvalKitClient, LiveClass: any): void {
  const proto = LiveClass?.prototype;
  if (!proto || typeof proto.connect !== 'function') return;
  if ((proto.connect as { __evalkit?: boolean }).__evalkit) return;
  const original = proto.connect;
  proto.connect = async function (this: unknown, params: any, ...rest: any[]): Promise<unknown> {
    const { params: wrapped, closed } = wrapConnectParams(client, params ?? {});
    return attachClose(await original.call(this, wrapped, ...rest), closed);
  };
  (proto.connect as { __evalkit?: boolean }).__evalkit = true;
}
