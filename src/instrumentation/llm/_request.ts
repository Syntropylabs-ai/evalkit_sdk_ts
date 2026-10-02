// The request side of an llm_call that identifies the agent configuration: the
// tool names the call offered and its sampling parameters. The agent-version
// fingerprint reads gen_ai.request.tools first and only falls back to parsing
// gen_ai.request.body, which the exporter drops from oversized spans and some
// providers never capture, so every provider has to set it explicitly.

const TOOLS_ATTR = "gen_ai.request.tools";

function field(obj: unknown, key: string): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// OpenAI chat and Cohere v2 nest the name under `function`, Bedrock Converse
// under `toolSpec`; Anthropic, Cohere v1 and OpenAI Responses name the tool at
// the top, and a built-in tool (web search, code execution) has only its type.
function toolName(tool: unknown): string | undefined {
  const fn = field(tool, "function");
  const fnName = fn != null ? nonEmpty(field(fn, "name")) : undefined;
  if (fnName) return fnName;
  const spec = field(tool, "toolSpec");
  const specName = spec != null ? nonEmpty(field(spec, "name")) : undefined;
  if (specName) return specName;
  return nonEmpty(field(tool, "name")) ?? nonEmpty(field(tool, "type"));
}

function collect(tools: unknown, into: string[]): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    // A Gemini tool is a group of function declarations, not a tool itself.
    const declarations = field(tool, "functionDeclarations") ?? field(tool, "function_declarations");
    if (Array.isArray(declarations)) {
      for (const declaration of declarations) {
        const name = nonEmpty(field(declaration, "name"));
        if (name && !into.includes(name)) into.push(name);
      }
      continue;
    }
    const name = toolName(tool);
    if (name && !into.includes(name)) into.push(name);
  }
}

/** The declared tool names of one or more tool lists, deduplicated in first-seen order. */
export function requestToolNames(...toolLists: unknown[]): string[] {
  const names: string[] = [];
  try {
    for (const tools of toolLists) collect(tools, names);
  } catch {
    // A tool list the caller built from exotic objects must not fail the request.
  }
  return names;
}

/** `{ "gen_ai.request.tools": [...] }` when the request offered tools, otherwise `{}`. */
export function toolAttrs(...toolLists: unknown[]): Record<string, string[]> {
  const names = requestToolNames(...toolLists);
  return names.length > 0 ? { [TOOLS_ATTR]: names } : {};
}

export type Sampling = {
  temperature?: unknown;
  topP?: unknown;
  maxTokens?: unknown;
};

function finiteNumber(value: unknown): value is number {
  // Booleans and SDK sentinels are not settings, and NaN is not a setting either.
  return typeof value === "number" && Number.isFinite(value);
}

/** The numeric sampling parameters under their gen_ai.request.* names; anything else is dropped. */
export function samplingAttrs(sampling: Sampling | undefined | null): Record<string, number> {
  const out: Record<string, number> = {};
  if (!sampling) return out;
  try {
    if (finiteNumber(sampling.temperature)) out["gen_ai.request.temperature"] = sampling.temperature;
    if (finiteNumber(sampling.topP)) out["gen_ai.request.top_p"] = sampling.topP;
    if (finiteNumber(sampling.maxTokens)) out["gen_ai.request.max_tokens"] = sampling.maxTokens;
  } catch {
    // Getters on a caller's config object must not fail the request.
  }
  return out;
}

type GenerationConfig = { temperature?: unknown; topP?: unknown; maxOutputTokens?: unknown };
type GenerativeModelLike = { tools?: unknown; generationConfig?: GenerationConfig };
type GenerativeRequestLike = { tools?: unknown; generationConfig?: GenerationConfig };

/**
 * Tools and sampling of a GenerativeModel call (@google/generative-ai, @google-cloud/vertexai):
 * both take them in getGenerativeModel({ ... }) and let a single request override them, and the
 * request's value replaces the model's rather than adding to it.
 */
export function generativeModelRequestAttrs(model: unknown, request: unknown): Record<string, number | string[]> {
  try {
    const m = (model ?? {}) as GenerativeModelLike;
    const r = (request != null && typeof request === "object" ? request : {}) as GenerativeRequestLike;
    const modelCfg = m.generationConfig ?? {};
    const requestCfg = r.generationConfig ?? {};
    return {
      ...samplingAttrs({
        temperature: requestCfg.temperature ?? modelCfg.temperature,
        topP: requestCfg.topP ?? modelCfg.topP,
        maxTokens: requestCfg.maxOutputTokens ?? modelCfg.maxOutputTokens,
      }),
      ...toolAttrs(Array.isArray(r.tools) ? r.tools : m.tools),
    };
  } catch {
    return {};
  }
}
