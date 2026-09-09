import { attr, type OtlpAttribute } from "./otlp.js";

export const SCOPE = "evalkit-cli";
export const KIND_INTERNAL = 1;
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;
export const OPERATION_NAME_MAX = 80;

export const AGENT = "agent";
export const LLM_CALL = "llm_call";
export const TOOL_CALL = "tool_call";
export const OPERATION: Record<string, string> = { [AGENT]: "invoke_agent", [LLM_CALL]: "chat", [TOOL_CALL]: "execute_tool" };

export type AttributeValues = Record<string, unknown>;

export function attributes(values: AttributeValues): OtlpAttribute[] {
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === "") continue;
    out.push(attr(key, value));
  }
  return out;
}

export function makeSpan(
  trace: string,
  span: string,
  parent: string | undefined,
  name: string,
  startNs: bigint,
  endNs: bigint,
  values: AttributeValues,
  status: number = STATUS_UNSET,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    traceId: trace,
    spanId: span,
    name: name.slice(0, OPERATION_NAME_MAX),
    kind: KIND_INTERNAL,
    startTimeUnixNano: String(startNs),
    endTimeUnixNano: String(endNs),
    attributes: attributes(values),
  };
  if (parent) out.parentSpanId = parent;
  if (status) out.status = { code: status };
  return out;
}

export function resource(vendor: string): Record<string, unknown> {
  return { attributes: attributes({ "service.name": vendor, "agent.vendor": vendor, "telemetry.sdk.name": SCOPE }) };
}

export function tracePayload(vendor: string, spans: Array<Record<string, unknown>>): Record<string, unknown> {
  return { resourceSpans: [{ resource: resource(vendor), scopeSpans: [{ scope: { name: SCOPE }, spans }] }] };
}
