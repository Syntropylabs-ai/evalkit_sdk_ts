import type { MaskHook, TraceEnvelope } from "./types.js";

export type { MaskHook };

export const CAPTURE_CONTENT_ENV_VARS = [
  "EVALKIT_CAPTURE_CONTENT",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
] as const;

export const CONTENT_STRIPPED_ATTRIBUTE = "evalkit.content_captured";

export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  "gen_ai.request.body",
  "gen_ai.response.body",
  "gen_ai.response.thinking",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "tool.arguments",
  "tool.result",
  "function.args",
  "function.kwargs",
  "function.result",
  "db.statement",
  "db.query",
  "db.params",
  "retriever.query",
  "log.message",
  "request.body",
  "response.body",
  "http.request.body",
  "http.response.body",
  "http.request.headers",
  "http.response.headers",
  "evalkit.prompt",
  "evalkit.completion",
]);

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  console.warn(
    `[evalkit] ${name}=${JSON.stringify(raw)} is not a boolean; ignoring it and leaving content capture unchanged`
  );
  return undefined;
}

export function resolveCaptureContent(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  for (const name of CAPTURE_CONTENT_ENV_VARS) {
    const flag = envFlag(name);
    if (flag !== undefined) return flag;
  }
  return true;
}

function stripAttributes(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    if (CONTENT_ATTRIBUTES.has(key)) delete attrs[key];
  }
}

export function stripContent(envelope: TraceEnvelope): TraceEnvelope {
  envelope.prompt = undefined;
  envelope.completion = undefined;
  const attrs = (envelope.attributes ?? {}) as Record<string, unknown>;
  stripAttributes(attrs);
  attrs[CONTENT_STRIPPED_ATTRIBUTE] = false;
  envelope.attributes = attrs as TraceEnvelope["attributes"];
  for (const event of envelope.events ?? []) {
    stripAttributes(event.attributes as Record<string, unknown> | undefined);
  }
  return envelope;
}

export function applyMask(mask: MaskHook, envelope: TraceEnvelope): TraceEnvelope | null {
  let masked: TraceEnvelope | null | undefined;
  try {
    masked = mask(envelope);
  } catch (err) {
    console.warn(
      "[evalkit] mask hook threw — dropping this span, because exporting it would defeat the hook's purpose:",
      err
    );
    return null;
  }
  if (masked === null || masked === undefined) return null;
  if (typeof masked !== "object" || Array.isArray(masked) || typeof masked.traceId !== "string") {
    console.warn("[evalkit] mask hook returned something that is not a TraceEnvelope — dropping this span");
    return null;
  }
  return masked;
}
