import type { MaskHook, TraceEnvelope } from "./types.js";

export type { MaskHook };

export const CAPTURE_CONTENT_ENV_VARS = [
  "EVALKIT_CAPTURE_CONTENT",
  "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT",
] as const;

export const CAPTURE_SECRETS_ENV_VARS = ["EVALKIT_CAPTURE_SECRETS"] as const;

export const CONTENT_STRIPPED_ATTRIBUTE = "evalkit.content_captured";

// Attributes that hold what was said, sent or returned, whichever library set them. Capture off removes
// each of them; what is measured about a call (model, tokens, cost, timing, tool names) stays.
export const CONTENT_ATTRIBUTES: ReadonlySet<string> = new Set([
  // OpenTelemetry GenAI semantic conventions, 1.37 and later.
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  // Their earlier spellings, which OpenTelemetry instrumentations and agent frameworks still write.
  "gen_ai.prompt",
  "gen_ai.completion",
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
  // Input and output values in the attribute names many GenAI tracers share.
  "input.value",
  "output.value",
  "llm.prompts",
  // The Vercel AI SDK.
  "ai.prompt",
  "ai.prompt.messages",
  "ai.response.text",
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.response.reasoning",
  "ai.toolCall.args",
  "ai.toolCall.result",
  "ai.value",
  "ai.values",
  // MLflow.
  "mlflow.spanInputs",
  "mlflow.spanOutputs",
]);

// Tracers that namespace an observation's or a trace's payload under their own prefix
// (`<vendor>.observation.input`), matched by ending so no vendor has to be listed.
export const CONTENT_ATTRIBUTE_SUFFIXES: readonly string[] = [
  ".observation.input",
  ".observation.output",
  ".trace.input",
  ".trace.output",
];

// Content written one message or document per attribute: gen_ai.prompt.0.content, llm.input_messages.1.
export const CONTENT_ATTRIBUTE_PREFIXES: readonly string[] = [
  "gen_ai.prompt.",
  "gen_ai.completion.",
  "llm.input_messages.",
  "llm.output_messages.",
  "llm.prompt_template.",
  "retrieval.documents.",
  "reranker.input_documents.",
  "reranker.output_documents.",
  "embedding.embeddings.",
];

// The GenAI conventions' message events (gen_ai.user.message, gen_ai.choice, ...) carry the message in
// these attributes; the events stay, so a trace still shows that a message was there and who sent it.
const MESSAGE_EVENT_CONTENT: ReadonlySet<string> = new Set(["content", "message", "body", "parts"]);

export function isContentAttribute(key: string): boolean {
  return (
    CONTENT_ATTRIBUTES.has(key) ||
    CONTENT_ATTRIBUTE_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    CONTENT_ATTRIBUTE_SUFFIXES.some((suffix) => key.endsWith(suffix))
  );
}

/** The names of the tools a message's tool_calls asked for, without their arguments. */
function toolCallNames(raw: unknown): string | undefined {
  let calls: unknown = raw;
  if (typeof raw === "string") {
    try {
      calls = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!Array.isArray(calls)) return undefined;
  const kept = calls
    .map((call) => {
      const c = (call ?? {}) as { id?: unknown; type?: unknown; name?: unknown; function?: { name?: unknown } };
      const name = typeof c.function?.name === "string" ? c.function.name : typeof c.name === "string" ? c.name : undefined;
      if (!name) return undefined;
      return { ...(typeof c.id === "string" && { id: c.id }), ...(typeof c.type === "string" && { type: c.type }), function: { name } };
    })
    .filter((call) => call !== undefined);
  return kept.length ? JSON.stringify(kept) : undefined;
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export function envFlag(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  console.warn(
    `[evalkit] ${name}=${JSON.stringify(raw)} is not a boolean; ignoring it and leaving the default in place`
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

export function resolveCaptureSecrets(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  for (const name of CAPTURE_SECRETS_ENV_VARS) {
    const flag = envFlag(name);
    if (flag !== undefined) return flag;
  }
  return false;
}

function stripAttributes(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    if (isContentAttribute(key)) delete attrs[key];
  }
}

function stripMessageEvent(attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const key of Object.keys(attrs)) {
    if (MESSAGE_EVENT_CONTENT.has(key)) delete attrs[key];
    else if (key === "tool_calls") {
      const names = toolCallNames(attrs[key]);
      if (names === undefined) delete attrs[key];
      else attrs[key] = names;
    }
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
    const eventAttrs = event.attributes as Record<string, unknown> | undefined;
    stripAttributes(eventAttrs);
    if (typeof event.name === "string" && event.name.startsWith("gen_ai.")) stripMessageEvent(eventAttrs);
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
