import type { EvalKitClient } from '../../../core/client.js';

const CAP = 8192;

function extractDelta(ev: any): string {
  const d = ev?.delta;
  if (typeof d === 'string') return d;
  if (typeof d?.text === 'string') return d.text;
  if (typeof d?.transcript === 'string') return d.transcript;
  if (typeof ev?.text === 'string') return ev.text;
  if (typeof ev?.transcript === 'string') return ev.transcript;
  return '';
}

function safeJson(value: unknown, limit = 2 * 1024 * 1024): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const s = JSON.stringify(value);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  } catch {
    return undefined;
  }
}

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
    try { session.end('OK'); } catch {  }
  };

  const resetTurn = () => {
    completionBuf = '';
    inputParts = [];
    turnStart = Date.now();
  };

  on('conversation.item.input_audio_transcription.completed', (ev: any) => {
    try {
      const transcript = ev?.transcript;
      if (typeof transcript === 'string' && transcript) inputParts.push(transcript);
    } catch {  }
  });

  const onDelta = (ev: any) => {
    try { completionBuf += extractDelta(ev); } catch {  }
  };
  on('response.audio_transcript.delta', onDelta);
  on('response.text.delta', onDelta);
  on('response.output_text.delta', onDelta);

  on('response.done', (ev: any) => {
    try {
      const prompt = inputParts.join('\n').trim();
      const completion = completionBuf.trim();
      const ms = Date.now() - turnStart;
      const response = ev?.response;
      resetTurn();
      if (!prompt && !completion) return;

      const usage = response?.usage;
      const tokensIn = usage?.input_tokens ?? 0;
      const tokensOut = usage?.output_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? (tokensIn + tokensOut);
      const audioTokensIn = usage?.input_token_details?.audio_tokens ?? 0;
      const audioTokensOut = usage?.output_token_details?.audio_tokens ?? 0;
      const responseBody = safeJson(response);

      const { end } = client.startSpan('voice.turn', {
        ...base,
        'evalkit.span_type': 'llm_call',
        ...(prompt && { 'evalkit.prompt': prompt.slice(0, CAP) }),
        ...(completion && { 'evalkit.completion': completion.slice(0, CAP) }),
        'gen_ai.usage.input_tokens': tokensIn,
        'gen_ai.usage.output_tokens': tokensOut,
        'gen_ai.usage.total_tokens': totalTokens,
        ...(audioTokensIn && { 'gen_ai.usage.audio_input_tokens': audioTokensIn }),
        ...(audioTokensOut && { 'gen_ai.usage.audio_output_tokens': audioTokensOut }),
        ...(responseBody && { 'gen_ai.response.body': responseBody }),
        'llm.turn_ms': ms,
      }, session.ctx);
      end('OK');
    } catch {  }
  });

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
    } catch {  }
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
      try { rt.on(event, cb); } catch {  }
    };
    wireSession(client, rt, on, base);

    (rt as { __evalkit?: boolean }).__evalkit = true;
    return rt;
  } catch {

    return rt;
  }
}

export function traceOpenAIRealtime(
  client: EvalKitClient,
  rt: any,
  opts: { model?: string; sessionId?: string; userId?: string } = {},
): any {
  return attachRealtimeListeners(client, rt, opts);
}

export function patchOpenAIRealtime(client: EvalKitClient, RealtimeClass: any): void {
  try {
    if (typeof RealtimeClass !== 'function') return;
    if ((RealtimeClass as { __evalkit?: boolean }).__evalkit) return;
    const proto = RealtimeClass.prototype;
    if (!proto) return;

    const origOn = typeof proto.on === 'function' ? proto.on : null;
    if (!origOn) return;
    if ((proto.on as { __evalkit?: boolean }).__evalkit) return;

    proto.on = function (this: any, ...args: any[]): any {
      try {
        if (!(this as { __evalkit?: boolean }).__evalkit) {

          (this as { __evalkit?: boolean }).__evalkit = true;
          attachWith(client, this, origOn);
        }
      } catch {  }
      return origOn.apply(this, args);
    };
    (proto.on as { __evalkit?: boolean }).__evalkit = true;
    (RealtimeClass as { __evalkit?: boolean }).__evalkit = true;
  } catch {  }
}

function attachWith(client: EvalKitClient, rt: any, origOn: (...a: any[]) => any): void {
  try {
    const model = String(rt?.model ?? rt?.session?.model ?? 'gpt-realtime');
    const base: Record<string, string> = {
      'gen_ai.system': 'openai',
      'gen_ai.request.model': model,
    };
    const on = (event: string, cb: (...a: any[]) => void) => {
      try { origOn.call(rt, event, cb); } catch {  }
    };
    wireSession(client, rt, on, base);
  } catch {  }
}
