import { ConfigStore } from "./config.js";
import { attr, logRecord, sendLogs, sendTraces, type OtlpAttribute } from "./otlp.js";
import { LOGS, TRACES, build, type Payload, type Record_ } from "./turns.js";

const STDIN_CAP = 1024 * 1024;
const HARD_TIMEOUT_MS = 5000;

export const CLAUDE_CODE = "claude-code";
const CLAUDE_EVENT_PREFIX = "claude_code";
const CLAUDE_EVENTS: Record<string, string> = {
  PostToolUse: "tool_output",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
};
const SUBAGENT_FIELDS: Array<[string, string]> = [
  ["session_id", "session.id"],
  ["agent_id", "agent.id"],
  ["agent_type", "agent.type"],
  ["cwd", "cwd"],
  ["permission_mode", "permission_mode"],
];
const TOOL_FIELDS: Array<[string, string]> = [
  ["session_id", "session.id"],
  ["tool_use_id", "tool_use_id"],
  ["tool_name", "tool_name"],
  ["duration_ms", "duration_ms"],
  ["agent_id", "agent.id"],
  ["agent_type", "agent.type"],
];
const CONTENT_FIELD: Record<string, [string, string]> = {
  tool_output: ["tool_response", "tool_output"],
  subagent_stop: ["last_assistant_message", "agent.last_message"],
};

function readStdin(): Promise<Payload> {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (raw.length < STDIN_CAP) raw += chunk.slice(0, STDIN_CAP - raw.length);
    });
    const done = () => {
      try {
        const data = raw.trim() ? JSON.parse(raw) : {};
        resolve(data && typeof data === "object" && !Array.isArray(data) ? data : { payload: data });
      } catch {
        resolve({});
      }
    };
    process.stdin.on("end", done);
    process.stdin.on("error", () => resolve({}));
    if (process.stdin.isTTY) done();
  });
}

function claudeRecord(event: string, payload: Payload, captureContent: boolean): Record<string, unknown> | null {
  const name = CLAUDE_EVENTS[event];
  if (!name) return null;
  const attrs: OtlpAttribute[] = [];
  for (const [field, key] of name === "tool_output" ? TOOL_FIELDS : SUBAGENT_FIELDS) {
    const value = payload[field];
    if (value !== undefined && value !== null && value !== "") attrs.push(attr(key, value));
  }
  const content = CONTENT_FIELD[name];
  if (captureContent && content) {
    const value = payload[content[0]];
    if (value !== undefined && value !== null && value !== "") attrs.push(attr(content[1], value));
  }
  return logRecord(CLAUDE_CODE, name, attrs, { prefix: CLAUDE_EVENT_PREFIX });
}

export function buildRecords(vendor: string, event: string, payload: Payload, captureContent: boolean, nowNs?: bigint): Record_[] {
  if (vendor === CLAUDE_CODE) {
    const record = claudeRecord(event, payload, captureContent);
    return record ? [{ signal: LOGS, payload: record }] : [];
  }
  return build(vendor, event, payload, captureContent, nowNs ?? BigInt(Date.now()) * 1_000_000n);
}

export async function runHook(vendor: string, event: string, home?: string): Promise<number> {
  const timer = setTimeout(() => process.exit(0), HARD_TIMEOUT_MS);
  try {
    const cfg = new ConfigStore(home).load();
    if (!cfg.key) return 0;
    const records = buildRecords(vendor, event, await readStdin(), cfg.capture === "full");
    for (const record of records) {
      const post = record.signal === TRACES ? sendTraces : sendLogs;
      await post(cfg.endpoint, cfg.key, record.payload, HARD_TIMEOUT_MS - 1000);
    }
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
  return 0;
}
