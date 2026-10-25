import { SpanKind, SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";
import { recordError } from '../core/exceptions.js';
import type { EvalKitClient } from "../core/client.js";
import { claimPatch } from "./_patched.js";

const ARGS_MAX = 32768;

type CallToolParams = { name?: string; arguments?: unknown };
type CallToolResult = { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

function toJson(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}

function truncate(s: string): string {
  return s.length <= ARGS_MAX ? s : s.slice(0, ARGS_MAX) + "…";
}

function resultText(result: CallToolResult): string {
  try {
    const parts = (result?.content ?? []).map((c) => (c?.text != null ? c.text : JSON.stringify(c)));
    return truncate(parts.join("\n"));
  } catch { return ""; }
}

export function patchMcp(client: EvalKitClient, target: any): void {
  const proto = target?.prototype ?? (target ? Object.getPrototypeOf(target) : null);
  if (!proto || typeof proto.callTool !== "function") return;
  if ((proto.callTool as { __evalkit?: boolean }).__evalkit) return;
  if (!claimPatch(proto, "callTool")) return;

  const original = proto.callTool;

  proto.callTool = async function (this: unknown, ...args: unknown[]): Promise<unknown> {

    let span: ReturnType<typeof client.tracer.startSpan>;
    let spanCtx: ReturnType<typeof trace.setSpan>;
    try {
      const params = (args[0] ?? {}) as CallToolParams;
      const name = String(params?.name ?? "tool");
      const argsJson = truncate(toJson(params?.arguments ?? {}));
      const ctx = otelContext.active();
      span = client.tracer.startSpan(
        name,
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "evalkit.span_type": "tool_call",
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.arguments": argsJson,
            "mcp.tool.name": name,
            "tool.name": name,
            "tool.arguments": argsJson,
          },
        },
        ctx,
      );
      spanCtx = trace.setSpan(ctx, span);
    } catch {
      return original.apply(this, args);
    }

    try {
      const result = (await otelContext.with(spanCtx, () => original.apply(this, args))) as CallToolResult;
      try {
        const text = resultText(result);
        if (text) {
          span.setAttribute("tool.result", text);
          span.setAttribute("gen_ai.tool.call.result", text);
        }
        span.setStatus({ code: result?.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      } catch {  }
      span.end();
      return result;
    } catch (err) {
      try {
        const e = err instanceof Error ? err : new Error(String(err));
        recordError(span, e, { escaped: true });
      } catch {  }
      span.end();
      throw err;
    }
  };

  (proto.callTool as { __evalkit?: boolean }).__evalkit = true;
}
