import { spanId, traceId } from "./ids.js";
import { logRecord } from "./otlp.js";
import { AGENT, OPERATION, STATUS_ERROR, STATUS_OK, TOOL_CALL, attributes, makeSpan, tracePayload, type AttributeValues } from "./spans.js";

export const TRACES = "traces";
export const LOGS = "logs";
export const ATTRIBUTION = "hooks";
export const ENRICHMENT_PREFIX = "evalkit";
export const ENRICHMENT_EVENT = "enrichment";
export const ROLE_MAIN = "main";
export const ROLE_SUBAGENT = "subagent";
const SUBAGENT_ID_FIELDS = ["subagent_id", "agent_id", "subagentId"];
const SUBAGENT_TYPE_FIELDS = ["subagent_type", "agent_type", "subagentType"];
const FAILURE_FIELDS = ["error", "error_message", "failure"];
const MS_IN_NS = 1_000_000n;

export interface Record_ {
  signal: string;
  payload: Record<string, unknown>;
}

export type Payload = Record<string, unknown>;

export interface ToolEvent {
  label: string;
  nameFields: string[];
  argsFields: string[];
  resultFields: string[];
  idFields: string[];
  durationFields?: string[];
  failed?: boolean;
}

export interface TurnSpec {
  vendor: string;
  agentName: string;
  sessionFields: string[];
  turnFields: string[];
  modelFields: string[];
  promptEvent: string;
  promptFields: string[];
  completionEvents: string[];
  completionFields: string[];
  tools: Record<string, ToolEvent>;
  sessionEvents: string[];
  subagentStart?: string;
  subagentStop?: string;
  nested: string[];
}

const DURATION_FIELDS = ["duration_ms", "duration"];

export const CURSOR: TurnSpec = {
  vendor: "cursor",
  agentName: "Cursor",
  sessionFields: ["conversation_id"],
  turnFields: ["generation_id"],
  modelFields: ["model"],
  promptEvent: "beforeSubmitPrompt",
  promptFields: ["prompt"],
  completionEvents: ["afterAgentResponse", "stop"],
  completionFields: ["text", "response"],
  sessionEvents: ["sessionStart", "sessionEnd"],
  subagentStart: "subagentStart",
  subagentStop: "subagentStop",
  tools: {
    postToolUse: { label: "tool", nameFields: ["tool_name"], argsFields: ["tool_input"], resultFields: ["tool_output"], idFields: ["tool_use_id", "tool_call_id"] },
    postToolUseFailure: { label: "tool", nameFields: ["tool_name"], argsFields: ["tool_input"], resultFields: ["tool_output"], idFields: ["tool_use_id", "tool_call_id"], failed: true },
    afterShellExecution: { label: "Shell", nameFields: ["tool_name"], argsFields: ["command"], resultFields: ["output"], idFields: ["tool_use_id", "call_id"] },
    afterMCPExecution: { label: "MCP", nameFields: ["tool_name"], argsFields: ["tool_input", "arguments"], resultFields: ["tool_output", "output"], idFields: ["tool_use_id", "tool_call_id"] },
    afterFileEdit: { label: "Edit", nameFields: ["tool_name"], argsFields: ["file_path", "edits"], resultFields: [], idFields: ["tool_use_id"] },
  },
  nested: [],
};

export const WINDSURF: TurnSpec = {
  vendor: "windsurf",
  agentName: "Windsurf Cascade",
  sessionFields: ["trajectory_id"],
  turnFields: ["execution_id"],
  modelFields: ["model_name", "model"],
  promptEvent: "pre_user_prompt",
  promptFields: ["prompt", "user_prompt", "message", "text"],
  completionEvents: ["post_cascade_response"],
  completionFields: ["response", "text", "cascade_response", "message"],
  sessionEvents: [],
  tools: {
    post_run_command: { label: "Command", nameFields: ["tool_name"], argsFields: ["command"], resultFields: ["output"], idFields: ["tool_call_id", "call_id"] },
    post_write_code: { label: "WriteCode", nameFields: ["tool_name"], argsFields: ["file_path", "path", "code"], resultFields: ["diff"], idFields: ["tool_call_id", "call_id"] },
    post_read_code: { label: "ReadCode", nameFields: ["tool_name"], argsFields: ["file_path", "path"], resultFields: [], idFields: ["tool_call_id", "call_id"] },
    post_mcp_tool_use: { label: "MCP", nameFields: ["tool_name"], argsFields: ["tool_input", "arguments"], resultFields: ["tool_output", "output"], idFields: ["tool_call_id", "call_id"] },
  },
  nested: ["tool_info"],
};

export const SPECS: Record<string, TurnSpec> = { [CURSOR.vendor]: CURSOR, [WINDSURF.vendor]: WINDSURF };

export function events(vendor: string): string[] {
  const spec = SPECS[vendor];
  const ordered = [...spec.sessionEvents, spec.promptEvent, ...spec.completionEvents, ...Object.keys(spec.tools)];
  for (const name of [spec.subagentStart, spec.subagentStop]) if (name) ordered.push(name);
  return ordered;
}

interface Turn {
  trace: string;
  root: string;
  session: string;
  turn: string;
  captureFull: boolean;
  nowNs: bigint;
}

function scopes(payload: Payload, nested: string[]): Payload[] {
  const out: Payload[] = [payload];
  for (const name of nested) {
    const value = payload[name];
    if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Payload);
  }
  return out;
}

function value(payload: Payload, fields: string[], nested: string[] = []): unknown {
  for (const scope of scopes(payload, nested)) {
    for (const name of fields) {
      const found = scope[name];
      if (found !== null && found !== undefined && found !== "") return found;
    }
  }
  return undefined;
}

function text(payload: Payload, fields: string[], nested: string[] = []): string | undefined {
  const found = value(payload, fields, nested);
  return found === undefined ? undefined : typeof found === "string" ? found : JSON.stringify(found);
}

function millis(payload: Payload, fields: string[], nested: string[] = []): number {
  const found = value(payload, fields, nested);
  const parsed = typeof found === "number" ? found : Number(found);
  return Number.isFinite(parsed) ? Math.max(Math.trunc(parsed), 0) : 0;
}

function base(spec: TurnSpec, payload: Payload, turn: Turn): AttributeValues {
  const values: AttributeValues = {
    "agent.vendor": spec.vendor,
    "gen_ai.conversation.id": turn.session,
    "agent.turn.id": turn.turn,
    "agent.role": ROLE_MAIN,
    "gen_ai.agent.name": spec.agentName,
    "evalkit.attribution": ATTRIBUTION,
  };
  if (turn.captureFull) values["user.id"] = text(payload, ["user_email", "user_id"]);
  return values;
}

function subagent(values: AttributeValues, payload: Payload): string | undefined {
  const identifier = text(payload, SUBAGENT_ID_FIELDS);
  const kind = text(payload, SUBAGENT_TYPE_FIELDS);
  if (!identifier && !kind) return undefined;
  values["agent.role"] = ROLE_SUBAGENT;
  values["agent.subagent.id"] = identifier;
  values["agent.subagent.type"] = kind;
  if (kind) values["gen_ai.agent.name"] = kind;
  return identifier ? spanId(identifier) : undefined;
}

function turnRoot(spec: TurnSpec, payload: Payload, turn: Turn): Record_[] {
  const prompt = text(payload, spec.promptFields);
  const values = base(spec, payload, turn);
  values["evalkit.span_type"] = AGENT;
  values["gen_ai.operation.name"] = OPERATION[AGENT];
  values["gen_ai.request.model"] = text(payload, spec.modelFields, spec.nested);
  let name = "turn";
  if (turn.captureFull && prompt) {
    values.prompt = prompt;
    name = prompt;
  }
  const span = makeSpan(turn.trace, turn.root, undefined, name, turn.nowNs, turn.nowNs, values);
  return [{ signal: TRACES, payload: tracePayload(spec.vendor, [span]) }];
}

function enrichment(spec: TurnSpec, turn: Turn, span: string, values: AttributeValues): Record_ {
  const merged: AttributeValues = {
    "evalkit.enrichment": true,
    "agent.vendor": spec.vendor,
    "gen_ai.conversation.id": turn.session,
    "agent.turn.id": turn.turn,
    "evalkit.end_time_unix_nano": turn.nowNs,
    ...values,
  };
  const record = logRecord(spec.vendor, ENRICHMENT_EVENT, attributes(merged), { prefix: ENRICHMENT_PREFIX, trace: turn.trace, span });
  return { signal: LOGS, payload: record };
}

function turnCompletion(spec: TurnSpec, payload: Payload, turn: Turn): Record_[] {
  const values: AttributeValues = {};
  if (turn.captureFull) values.completion = text(payload, spec.completionFields);
  return [enrichment(spec, turn, turn.root, values)];
}

function subagentRoot(spec: TurnSpec, payload: Payload, turn: Turn): Record_[] {
  const values = base(spec, payload, turn);
  const child = subagent(values, payload);
  if (!child) return [];
  const kind = (values["agent.subagent.type"] as string | undefined) || "subagent";
  const parentCall = text(payload, ["tool_call_id", "tool_use_id"]);
  values["evalkit.span_type"] = AGENT;
  values["gen_ai.operation.name"] = OPERATION[AGENT];
  values["gen_ai.request.model"] = text(payload, ["subagent_model", ...spec.modelFields]);
  values["agent.subagent.is_parallel_worker"] = payload.is_parallel_worker;
  if (turn.captureFull) values.prompt = text(payload, ["task", "prompt", "description"]);
  const parent = parentCall ? spanId(parentCall) : turn.root;
  const span = makeSpan(turn.trace, child, parent, `subagent:${kind}`, turn.nowNs, turn.nowNs, values);
  return [{ signal: TRACES, payload: tracePayload(spec.vendor, [span]) }];
}

function subagentCompletion(spec: TurnSpec, payload: Payload, turn: Turn): Record_[] {
  const identifier = text(payload, SUBAGENT_ID_FIELDS);
  const kind = text(payload, SUBAGENT_TYPE_FIELDS);
  const values: AttributeValues = {
    "agent.role": ROLE_SUBAGENT,
    "agent.subagent.id": identifier,
    "agent.subagent.type": kind,
    "agent.subagent.total_tool_uses": value(payload, ["tool_call_count"]),
    "agent.subagent.message_count": value(payload, ["message_count"]),
    "agent.subagent.status": text(payload, ["status", "final_status"]),
  };
  if (turn.captureFull) values.completion = text(payload, ["summary", "last_assistant_message", "text"]);
  if (!identifier) {
    return [{ signal: LOGS, payload: logRecord(spec.vendor, "subagent_stop", attributes(values), { trace: turn.trace }) }];
  }
  return [enrichment(spec, turn, spanId(identifier), values)];
}

function toolSpan(spec: TurnSpec, event: string, tool: ToolEvent, payload: Payload, turn: Turn): Record_[] {
  const durationMs = millis(payload, tool.durationFields ?? DURATION_FIELDS, spec.nested);
  const name = text(payload, tool.nameFields, spec.nested) || tool.label;
  const callId = text(payload, tool.idFields, spec.nested);
  const span = callId ? spanId(callId) : spanId(turn.turn, event, String(turn.nowNs));
  const values = base(spec, payload, turn);
  const parent = subagent(values, payload) ?? turn.root;
  const failed = Boolean(tool.failed) || value(payload, FAILURE_FIELDS) !== undefined;
  values["evalkit.span_type"] = TOOL_CALL;
  values["gen_ai.operation.name"] = OPERATION[TOOL_CALL];
  values["gen_ai.tool.name"] = name;
  values["gen_ai.tool.call.id"] = callId;
  values.duration_ms = durationMs || undefined;
  values.success = !failed;
  if (turn.captureFull) {
    values["tool.arguments"] = value(payload, tool.argsFields, spec.nested);
    values["tool.result"] = value(payload, tool.resultFields, spec.nested);
  }
  const status = failed ? STATUS_ERROR : STATUS_OK;
  const start = turn.nowNs - BigInt(durationMs) * MS_IN_NS;
  return [{ signal: TRACES, payload: tracePayload(spec.vendor, [makeSpan(turn.trace, span, parent, name, start, turn.nowNs, values, status)]) }];
}

function sessionLog(spec: TurnSpec, event: string, payload: Payload, turn: Turn): Record_[] {
  const values: AttributeValues = {
    "agent.vendor": spec.vendor,
    "gen_ai.conversation.id": turn.session,
    "gen_ai.agent.name": spec.agentName,
    "evalkit.noise": true,
    duration_ms: value(payload, ["duration_ms"]),
    final_status: text(payload, ["final_status"]),
  };
  return [{ signal: LOGS, payload: logRecord(spec.vendor, event, attributes(values)) }];
}

export function build(vendor: string, event: string, payload: Payload, captureFull: boolean, nowNs: bigint): Record_[] {
  const spec = SPECS[vendor];
  if (!spec) return [];
  const session = text(payload, spec.sessionFields) ?? "";
  const identifier = text(payload, spec.turnFields) ?? "";
  const turn: Turn = { trace: traceId(session, identifier), root: spanId(identifier), session, turn: identifier, captureFull, nowNs };
  if (spec.sessionEvents.includes(event)) return sessionLog(spec, event, payload, turn);
  if (!identifier) return [];
  if (event === spec.promptEvent) return turnRoot(spec, payload, turn);
  if (spec.completionEvents.includes(event)) return turnCompletion(spec, payload, turn);
  if (event === spec.subagentStart) return subagentRoot(spec, payload, turn);
  if (event === spec.subagentStop) return subagentCompletion(spec, payload, turn);
  const tool = spec.tools[event];
  if (tool) return toolSpan(spec, event, tool, payload, turn);
  return [];
}
