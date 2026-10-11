import type { ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import type { TraceEnvelope } from "./types.js";
import { messageContentText, parseJsonText } from "./message-content.js";

/**
 * Agent frameworks on the OpenTelemetry GenAI conventions (Strands Agents, and any framework that names
 * its spans `invoke_agent`, `chat`, `execute_tool`) record their own structure as spans: an agent
 * invocation, the event-loop cycles inside it, each model call and each tool execution. Their gen_ai.*
 * attributes alone cannot tell these apart, so `gen_ai.operation.name` (or the convention's span name)
 * decides what each one is stored as: the trace views count model calls and tool calls by span type.
 */
const OPERATION_KEY = "gen_ai.operation.name";

const AGENT_OPERATIONS: ReadonlySet<string> = new Set(["invoke_agent", "invoke_swarm", "invoke_graph"]);
const MODEL_OPERATIONS: ReadonlySet<string> = new Set(["chat", "text_completion", "generate_content"]);
const TOOL_OPERATION = "execute_tool";
const EVENT_LOOP_OPERATION = "execute_event_loop_cycle";

/** The span type for framework structure that is neither a model call nor a tool call. */
export const INTERNAL_SPAN_TYPE = "internal";

type Attrs = Record<string, unknown>;
type SpanLike = Pick<ReadableSpan, "name" | "attributes"> & { events?: ReadableSpan["events"] };

/** The span's GenAI operation: the attribute, else the operation the convention's span name starts with. */
export function genAiOperation(span: Pick<ReadableSpan, "name" | "attributes">): string | undefined {
  const declared = span.attributes[OPERATION_KEY];
  if (typeof declared === "string" && declared.trim() !== "") return declared.trim().toLowerCase();
  const name = (span.name ?? "").trim().toLowerCase();
  if (name === "invoke_agent" || name.startsWith("invoke_agent ")) return "invoke_agent";
  if (name.startsWith(`${TOOL_OPERATION} `)) return TOOL_OPERATION;
  if (name === EVENT_LOOP_OPERATION) return EVENT_LOOP_OPERATION;
  return undefined;
}

export function isModelOperation(op: string | undefined): boolean {
  return op !== undefined && MODEL_OPERATIONS.has(op);
}

// ── calls the SDK instrumented itself ────────────────────────────────────────────────────────────────

/**
 * A framework's model-call span and the SDK's own span for the same request are one call: the SDK's span
 * is the record (it carries the request, the response and the usage), the framework's is its view of it.
 * The SDK's span starts inside the framework's (or, with the patches applied the other way round, around
 * it), so the processor notes both directions as spans start and end; a framework span is classified at
 * export, after everything inside it has ended.
 */
const MAX_TRACKED = 10000;
// Span ids of the SDK's own model calls.
const sdkModelCalls = new Map<string, true>();
// Span ids of spans the SDK's own model call ran inside.
const holdsSdkModelCall = new Map<string, true>();

function remember(store: Map<string, true>, id: string | undefined): void {
  if (!id) return;
  store.delete(id);
  store.set(id, true);
  if (store.size > MAX_TRACKED) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

function parentIdOf(span: ReadableSpan | Span): string | undefined {
  const s = span as unknown as { parentSpanContext?: { spanId?: string }; parentSpanId?: string };
  return s.parentSpanContext?.spanId ?? s.parentSpanId;
}

function isSdkModelCall(span: Pick<ReadableSpan, "attributes">): boolean {
  return span.attributes["evalkit.span_type"] === "llm_call";
}

export function noteSpanStart(span: Span): void {
  if (isSdkModelCall(span)) remember(sdkModelCalls, span.spanContext().spanId);
}

/**
 * Children end before their parents, so when a span ends every span inside it has already been noted:
 * the SDK's model call marks the span it ran in, and a span that is not itself a model call passes the
 * mark on to its parent, so a framework model call one step removed from the SDK's span still sees it.
 */
export function noteSpanEnd(span: ReadableSpan): void {
  const id = span.spanContext().spanId;
  if (isSdkModelCall(span)) {
    remember(sdkModelCalls, id);
    remember(holdsSdkModelCall, parentIdOf(span));
    return;
  }
  if (holdsSdkModelCall.has(id) && !isModelOperation(genAiOperation(span))) {
    remember(holdsSdkModelCall, parentIdOf(span));
  }
}

/** Whether a framework model-call span is the same request as a model call the SDK recorded itself. */
export function duplicatesSdkModelCall(span: ReadableSpan): boolean {
  const parent = parentIdOf(span);
  return holdsSdkModelCall.has(span.spanContext().spanId) || (parent !== undefined && sdkModelCalls.has(parent));
}

// ── what a framework span becomes ────────────────────────────────────────────────────────────────────

export interface FrameworkSpanFields {
  spanType: TraceEnvelope["spanType"];
  /** Token counts belong on model calls only; anywhere else they repeat what the model calls report. */
  keepTokens: boolean;
  operation?: string;
  agentName?: string;
  prompt?: string;
  completion?: string;
  status?: TraceEnvelope["status"];
  /** Attributes to add where the span did not set them itself. */
  attributes: Record<string, string>;
}

/**
 * How a span that another library created, and that names a GenAI operation, is stored. Undefined for
 * spans that name none (or an operation outside the conventions above): those keep the generic typing.
 * `countForeignLlm` is the EVALKIT_COUNT_FOREIGN_LLM opt-out: every framework model call is then counted.
 */
export function frameworkSpanFields(span: ReadableSpan, countForeignLlm: boolean): FrameworkSpanFields | undefined {
  const op = genAiOperation(span);
  if (op === undefined) return undefined;
  const attrs = span.attributes as Attrs;
  if (AGENT_OPERATIONS.has(op)) {
    const agentName = stringAttr(attrs, "gen_ai.agent.name") ?? nameSuffix(span.name, op);
    return {
      spanType: "agent",
      keepTokens: false,
      ...(agentName ? { agentName } : {}),
      ...optionalText("prompt", lastUserText(span)),
      ...optionalText("completion", outputText(span)),
      attributes: {},
    };
  }
  if (op === TOOL_OPERATION) return toolFields(span, attrs);
  if (op === EVENT_LOOP_OPERATION) return { spanType: INTERNAL_SPAN_TYPE, keepTokens: false, attributes: {} };
  if (MODEL_OPERATIONS.has(op)) {
    if (!countForeignLlm && duplicatesSdkModelCall(span)) {
      return { spanType: INTERNAL_SPAN_TYPE, keepTokens: false, attributes: {} };
    }
    return {
      spanType: "llm_call",
      keepTokens: true,
      ...optionalText("prompt", inputMessagesText(span)),
      ...optionalText("completion", outputText(span)),
      attributes: {},
    };
  }
  return undefined;
}

function toolFields(span: ReadableSpan, attrs: Attrs): FrameworkSpanFields {
  const name = stringAttr(attrs, "gen_ai.tool.name") ?? nameSuffix(span.name, TOOL_OPERATION);
  const added: Record<string, string> = {};
  if (name && attrs["tool.name"] === undefined) added["tool.name"] = name;
  if (attrs["tool.arguments"] === undefined) {
    const args = attrs["gen_ai.tool.call.arguments"] ?? eventAttribute(span, "gen_ai.tool.message", "content");
    const text = asText(args);
    if (text) added["tool.arguments"] = text;
  }
  if (attrs["tool.result"] === undefined) {
    const declared = attrs["gen_ai.tool.call.result"];
    const text = declared !== undefined ? asText(declared) : toolResultText(eventAttribute(span, "gen_ai.choice", "message"));
    if (text) added["tool.result"] = text;
  }
  const failed = String(attrs["gen_ai.tool.status"] ?? "").toLowerCase() === "error";
  return {
    spanType: "tool_call",
    keepTokens: false,
    ...(name ? { operation: name } : {}),
    ...(failed ? { status: "ERROR" as const } : {}),
    attributes: added,
  };
}

// ── reading the content a framework span recorded ────────────────────────────────────────────────────

const MESSAGE_EVENT = /^gen_ai\.(system|user|assistant|tool)\.message$/;
const DETAILS_EVENT = "gen_ai.client.inference.operation.details";

interface Message {
  role: string;
  content: unknown;
}

function events(span: SpanLike): Array<{ name: string; attributes: Attrs }> {
  return (span.events ?? []).map((e) => ({ name: e.name, attributes: (e.attributes ?? {}) as Attrs }));
}

function eventAttribute(span: SpanLike, eventName: string, key: string): unknown {
  return events(span).find((e) => e.name === eventName)?.attributes[key];
}

/**
 * The input messages a span recorded: one `gen_ai.<role>.message` event each (the convention before
 * 1.37, Strands' default), else the `gen_ai.input.messages` list on the operation-details event or on the
 * span itself (the latest convention).
 */
function inputMessages(span: SpanLike): Message[] {
  const out: Message[] = [];
  for (const event of events(span)) {
    const match = MESSAGE_EVENT.exec(event.name);
    if (match) out.push({ role: match[1], content: event.attributes.content ?? event.attributes.message ?? "" });
    else if (event.name === DETAILS_EVENT) out.push(...conventionMessages(event.attributes["gen_ai.input.messages"]));
  }
  if (out.length === 0) out.push(...conventionMessages((span.attributes as Attrs)["gen_ai.input.messages"]));
  return out;
}

function conventionMessages(raw: unknown): Message[] {
  const list = parseJsonText(raw);
  if (!Array.isArray(list)) return [];
  return list
    .filter((m): m is Attrs => !!m && typeof m === "object")
    .map((m) => ({ role: typeof m.role === "string" ? m.role : "user", content: m.parts ?? m.content ?? "" }));
}

function inputMessagesText(span: SpanLike): string {
  return inputMessages(span)
    .map((m) => {
      const text = messageContentText(parseJsonText(m.content)).trim();
      return text ? `${m.role}: ${text}` : "";
    })
    .filter((line) => line !== "")
    .join("\n");
}

/** What the person said: the last user message that carries text. */
function lastUserText(span: SpanLike): string {
  const users = inputMessages(span)
    .filter((m) => m.role === "user")
    .map((m) => messageContentText(parseJsonText(m.content)).trim())
    .filter((text) => text !== "");
  return users.length ? users[users.length - 1] : "";
}

/** The reply: the `gen_ai.choice` event's message, else the latest convention's `gen_ai.output.messages`. */
function outputText(span: SpanLike): string {
  for (const event of events(span)) {
    if (event.name === "gen_ai.choice") {
      const text = messageContentText(parseJsonText(event.attributes.message ?? event.attributes.content)).trim();
      if (text) return text;
    }
    if (event.name === DETAILS_EVENT && event.attributes["gen_ai.output.messages"] !== undefined) {
      const text = outputMessagesText(event.attributes["gen_ai.output.messages"]);
      if (text) return text;
    }
  }
  return outputMessagesText((span.attributes as Attrs)["gen_ai.output.messages"]);
}

function outputMessagesText(raw: unknown): string {
  return conventionMessages(raw)
    .filter((m) => m.role === "assistant")
    .map((m) => messageContentText(parseJsonText(m.content)).trim())
    .filter((text) => text !== "")
    .join("\n");
}

/** A tool result's content blocks as the text they hold; JSON the tool returned stays JSON. */
function toolResultText(raw: unknown): string {
  const value = parseJsonText(raw);
  if (!Array.isArray(value)) return asText(raw);
  const texts = value
    .map((block) => {
      if (typeof block === "string") return block;
      if (!block || typeof block !== "object") return "";
      const b = block as Attrs;
      if (typeof b.text === "string") return b.text;
      if (b.json !== undefined) return JSON.stringify(b.json);
      return "";
    })
    .filter((t) => t !== "");
  return texts.length ? texts.join("\n") : asText(raw);
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function stringAttr(attrs: Attrs, key: string): string | undefined {
  const v = attrs[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** `invoke_agent refund-agent` -> `refund-agent`: the convention's span name ends with the subject's name. */
function nameSuffix(name: string, op: string): string | undefined {
  const trimmed = (name ?? "").trim();
  if (!trimmed.toLowerCase().startsWith(`${op} `)) return undefined;
  const rest = trimmed.slice(op.length).trim();
  return rest || undefined;
}

function optionalText<K extends "prompt" | "completion">(key: K, text: string): Partial<Record<K, string>> {
  return text ? ({ [key]: text } as Record<K, string>) : {};
}
