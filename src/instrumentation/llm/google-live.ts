import type { EvalKitClient } from '../../core/client.js';
import { extractGoogleUsage, googleUsageAttributes } from './_google-usage.js';
import { claimPatch } from '../_patched.js';

const MAX_TEXT = 8192;

function safeJson(value: unknown, limit = 2 * 1024 * 1024): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const s = JSON.stringify(value);
    return s.length > limit ? s.slice(0, limit) + '…' : s;
  } catch {
    return undefined;
  }
}

function extractTurnsText(turns: unknown): string {
  const parts: string[] = [];
  const fromContent = (c: any) => {
    if (typeof c === 'string') { parts.push(c); return; }
    const role = c?.role ? `${c.role}: ` : '';
    const text = (c?.parts ?? [])
      .filter((p: any) => typeof p?.text === 'string' && !p?.thought)
      .map((p: any) => p.text)
      .join('');
    if (text) parts.push(`${role}${text}`);
  };
  if (Array.isArray(turns)) turns.forEach(fromContent);
  else if (turns != null) fromContent(turns);
  return parts.join('\n');
}

function modalityTokens(details: any, modality: string): number {
  let total = 0;
  try {
    for (const m of details ?? []) {
      if (m?.modality === modality) total += m?.tokenCount ?? 0;
    }
  } catch {  }
  return total;
}

class TurnState {
  inputParts: string[] = [];
  outputParts: string[] = [];
  thinkingParts: string[] = [];
  requestDump: any[] = [];
  responseDump: any[] = [];
  usage: any = null;
  turnStart = Date.now();

  reset(): void {
    this.inputParts = [];
    this.outputParts = [];
    this.thinkingParts = [];
    this.requestDump = [];
    this.responseDump = [];
    this.usage = null;
    this.turnStart = Date.now();
  }
}

function wireSession(
  client: EvalKitClient,
  base: Record<string, string>,
  opts: { sessionId?: string; userId?: string } = {},
): {
  ctx: any;
  end: (status?: 'OK' | 'ERROR') => void;
  onMessage: (msg: any) => void;
  onSendClientContent: (params: any) => void;
  onSendRealtimeInput: (params: any) => void;
  onSendToolResponse: (params: any) => void;
} {
  const attrs: Record<string, string> = {
    ...base,
    ...(opts.sessionId ? { 'evalkit.session_id': opts.sessionId } : {}),
    ...(opts.userId ? { 'evalkit.user_id': opts.userId } : {}),
  };
  const session = client.startTrace('voice.session', attrs);
  const turn = new TurnState();

  const emitToolCalls = (msg: any): void => {
    try {
      const fns = msg?.toolCall?.functionCalls;
      if (!Array.isArray(fns)) return;
      for (const fc of fns) {
        if (!fc?.name) continue;
        const argsStr = JSON.stringify(fc.args ?? {}).slice(0, MAX_TEXT);
        const { end } = client.startSpan(String(fc.name), {
          ...base,
          'evalkit.span_type': 'tool_call',
          'gen_ai.tool.name': String(fc.name),
          'gen_ai.tool.call.arguments': argsStr,
          'tool.name': String(fc.name),
        }, session.ctx);
        end('OK');
      }
    } catch {  }
  };

  const endTurn = (): void => {
    const prompt = turn.inputParts.join('\n').trim();
    const completion = turn.outputParts.join('').trim();
    const thinking = turn.thinkingParts.join('').trim();
    const ms = Date.now() - turn.turnStart;
    const { requestDump, responseDump, usage } = turn;
    turn.reset();
    if (!prompt && !completion) return;

    const reqBody = requestDump.length ? safeJson(requestDump) : undefined;
    const respBody = responseDump.length ? safeJson(responseDump) : undefined;

    const counts = extractGoogleUsage(usage);
    const audioTokensIn = modalityTokens(usage?.promptTokensDetails, 'AUDIO');
    const audioTokensOut = modalityTokens(usage?.responseTokensDetails, 'AUDIO');

    const { end } = client.startSpan('voice.turn', {
      ...base,
      'evalkit.span_type': 'llm_call',
      ...(prompt && { 'evalkit.prompt': prompt.slice(0, MAX_TEXT) }),
      ...(completion && { 'evalkit.completion': completion.slice(0, MAX_TEXT) }),
      ...(thinking && { 'gen_ai.response.thinking': thinking.slice(0, MAX_TEXT) }),
      ...(reqBody && { 'gen_ai.request.body': reqBody }),
      ...(respBody && { 'gen_ai.response.body': respBody }),
      ...(usage ? googleUsageAttributes(counts) : {}),
      ...(audioTokensIn && { 'gen_ai.usage.audio_input_tokens': audioTokensIn }),
      ...(audioTokensOut && { 'gen_ai.usage.audio_output_tokens': audioTokensOut }),
      'llm.turn_ms': ms,
    }, session.ctx);
    end('OK');
  };

  const onMessage = (msg: any): void => {
    try {
      const sc = msg?.serverContent;
      if (sc) {
        const itext = sc.inputTranscription?.text;
        if (typeof itext === 'string' && itext) turn.inputParts.push(itext);

        const parts = sc.modelTurn?.parts ?? [];
        for (const p of parts) {
          if (typeof p?.text !== 'string') continue;
          if (p.thought) turn.thinkingParts.push(p.text);
          else turn.outputParts.push(p.text);
        }

        const otext = sc.outputTranscription?.text;
        if (typeof otext === 'string' && otext) turn.outputParts.push(otext);
      }

      if (msg?.usageMetadata) {
        const um = msg.usageMetadata;
        turn.usage = um;
        turn.responseDump.push({
          usage: {
            promptTokenCount: um.promptTokenCount,
            responseTokenCount: um.responseTokenCount,
            totalTokenCount: um.totalTokenCount,
            thoughtsTokenCount: um.thoughtsTokenCount,
            cachedContentTokenCount: um.cachedContentTokenCount,
          },
        });
      }
      if (msg?.toolCall) turn.responseDump.push({ toolCall: msg.toolCall });
      if (sc?.turnComplete) turn.responseDump.push({ turnComplete: true });
      if (sc?.interrupted) turn.responseDump.push({ interrupted: true });

      emitToolCalls(msg);
      if (sc?.turnComplete) endTurn();
    } catch {  }
  };

  const onSendClientContent = (params: any): void => {
    try {
      const text = extractTurnsText(params?.turns);
      if (text) turn.inputParts.push(text);
      turn.requestDump.push({ type: 'client_content', turnComplete: params?.turnComplete, turns: params?.turns });
    } catch {  }
  };

  const onSendRealtimeInput = (params: any): void => {
    try {
      if (typeof params?.text === 'string' && params.text) {
        turn.inputParts.push(params.text);
        turn.requestDump.push({ type: 'realtime_input', text: params.text });
      } else if (params) {
        const modality = ['audio', 'video', 'activityStart', 'activityEnd'].find((k) => params[k] !== undefined);
        if (modality) turn.requestDump.push({ type: 'realtime_input', modality });
      }
    } catch {  }
  };

  const onSendToolResponse = (params: any): void => {
    try {
      turn.requestDump.push({ type: 'tool_response', functionResponses: params?.functionResponses });
    } catch {  }
  };

  return { ctx: session.ctx, end: session.end, onMessage, onSendClientContent, onSendRealtimeInput, onSendToolResponse };
}

function instrumentSession(session: any, wiring: ReturnType<typeof wireSession>, closed: () => void): any {
  if (!session || typeof session !== 'object') return session;
  try {
    const origSendClientContent = typeof session.sendClientContent === 'function' ? session.sendClientContent.bind(session) : null;
    if (origSendClientContent) {
      session.sendClientContent = (params: any) => {
        wiring.onSendClientContent(params);
        return origSendClientContent(params);
      };
    }
    const origSendRealtimeInput = typeof session.sendRealtimeInput === 'function' ? session.sendRealtimeInput.bind(session) : null;
    if (origSendRealtimeInput) {
      session.sendRealtimeInput = (params: any) => {
        wiring.onSendRealtimeInput(params);
        return origSendRealtimeInput(params);
      };
    }
    const origSendToolResponse = typeof session.sendToolResponse === 'function' ? session.sendToolResponse.bind(session) : null;
    if (origSendToolResponse) {
      session.sendToolResponse = (params: any) => {
        wiring.onSendToolResponse(params);
        return origSendToolResponse(params);
      };
    }
    const origClose = typeof session.close === 'function' ? session.close.bind(session) : null;
    if (origClose) session.close = (...a: any[]) => { closed(); return origClose(...a); };
  } catch {  }
  return session;
}

function wrapConnectParams(
  client: EvalKitClient,
  params: any,
  opts: { sessionId?: string; userId?: string } = {},
): { params: any; attach: (session: any) => any } {
  const model = String(params?.model ?? 'gemini-live');
  const base: Record<string, string> = {
    'gen_ai.system': 'google',
    'gen_ai.request.model': model,
  };
  const wiring = wireSession(client, base, opts);
  const userOnMessage = params?.callbacks?.onmessage;

  const wrapped = {
    ...params,
    callbacks: {
      ...(params?.callbacks ?? {}),
      onmessage: (msg: any) => {
        wiring.onMessage(msg);
        return userOnMessage?.(msg);
      },
    },
  };

  let ended = false;
  const closed = () => { if (ended) return; ended = true; try { wiring.end('OK'); } catch {  } };

  return { params: wrapped, attach: (session: any) => instrumentSession(session, wiring, closed) };
}

export async function traceLive(
  client: EvalKitClient,
  ai: any,
  params: any,
  opts: { sessionId?: string; userId?: string } = {},
): Promise<any> {
  const { params: wrapped, attach } = wrapConnectParams(client, params, opts);
  return attach(await ai.live.connect(wrapped));
}

export function patchGoogleLive(client: EvalKitClient, LiveClass: any): void {
  const proto = LiveClass?.prototype;
  if (!proto || typeof proto.connect !== 'function') return;
  if ((proto.connect as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(proto, "connect")) return;
  const original = proto.connect;
  proto.connect = async function (this: unknown, params: any, ...rest: any[]): Promise<unknown> {
    const { params: wrapped, attach } = wrapConnectParams(client, params ?? {});
    return attach(await original.call(this, wrapped, ...rest));
  };
  (proto.connect as { __evalkit?: boolean }).__evalkit = true;
}
