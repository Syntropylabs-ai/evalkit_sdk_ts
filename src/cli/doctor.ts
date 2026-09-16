import type { SharedConfig } from "./config.js";
import { spanId, traceId } from "./ids.js";
import { getJson, logRecord, readBase, sendLogs, sendTraces } from "./otlp.js";
import { AGENT, LLM_CALL, OPERATION, STATUS_OK, TOOL_CALL, attributes, makeSpan, tracePayload, type AttributeValues } from "./spans.js";

export const VENDOR = "evalkit-doctor";
export const PROMPT = "evalkit doctor synthetic turn";
export const COMPLETION = "evalkit doctor merged this completion into the agent span";
const MODEL = "doctor-model";
const TOOL = "Bash";
const EXPECTED_SPANS = 3;
const READ_ATTEMPTS = 4;
const READ_DELAY_MS = 750;
const SECOND_NS = 1_000_000_000n;
export const DEFAULT_TENANT = "me";

export interface DoctorResult {
  ok: boolean;
  detail: string;
}

export function syntheticTurn(nowNs: bigint): { trace: string; root: string; spans: Array<Record<string, unknown>> } {
  const seed = String(nowNs);
  const trace = traceId(VENDOR, seed);
  const root = spanId("doctor-root", seed);
  const llm = spanId("doctor-llm", seed);
  const tool = spanId("doctor-tool", seed);
  const start = nowNs - 2n * SECOND_NS;
  const shared: AttributeValues = {
    "agent.vendor": VENDOR,
    "gen_ai.conversation.id": `doctor-session-${seed}`,
    "agent.turn.id": `doctor-turn-${seed}`,
    "agent.turn.sequence": 1,
    "evalkit.attribution": "hooks",
    "evalkit.doctor": true,
  };
  const agent: AttributeValues = {
    ...shared,
    "evalkit.span_type": AGENT,
    "gen_ai.operation.name": OPERATION[AGENT],
    "agent.role": "main",
    "gen_ai.agent.name": "EvalKit doctor",
    prompt: PROMPT,
  };
  const modelCall: AttributeValues = {
    ...shared,
    "evalkit.span_type": LLM_CALL,
    "gen_ai.operation.name": OPERATION[LLM_CALL],
    "agent.role": "main",
    "gen_ai.request.model": MODEL,
    "gen_ai.usage.input_tokens": 12,
    "gen_ai.usage.output_tokens": 7,
    "gen_ai.usage.cost_usd": 0.000123,
  };
  const toolCall: AttributeValues = {
    ...shared,
    "evalkit.span_type": TOOL_CALL,
    "gen_ai.operation.name": OPERATION[TOOL_CALL],
    "agent.role": "main",
    "gen_ai.tool.name": TOOL,
    "gen_ai.tool.call.id": `doctor-tool-${seed}`,
    success: true,
  };
  const spans = [
    makeSpan(trace, root, undefined, PROMPT, start, nowNs, agent),
    makeSpan(trace, llm, root, `chat ${MODEL}`, start + SECOND_NS / 2n, nowNs - SECOND_NS, modelCall, STATUS_OK),
    makeSpan(trace, tool, root, TOOL, nowNs - SECOND_NS, nowNs, toolCall, STATUS_OK),
  ];
  return { trace, root, spans };
}

export function enrichment(trace: string, root: string, nowNs: bigint): Record<string, unknown> {
  const values: AttributeValues = {
    "evalkit.enrichment": true,
    "agent.vendor": VENDOR,
    completion: COMPLETION,
    "evalkit.end_time_unix_nano": nowNs,
  };
  return logRecord(VENDOR, "enrichment", attributes(values), { prefix: "evalkit", trace, span: root });
}

function rowsOf(body: unknown): Array<Record<string, unknown>> {
  const rows = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).data : body;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && typeof row === "object") as Array<Record<string, unknown>>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function read(cfg: SharedConfig, tenant: string, trace: string): Promise<DoctorResult> {
  const url = `${readBase(cfg.endpoint)}/v1/traces/${tenant}/${trace}?fields=full`;
  let detail = "no response";
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
    if (attempt) await sleep(READ_DELAY_MS);
    const { status, body, error } = await getJson(url, cfg.key);
    if (status === 403) {
      if (tenant === DEFAULT_TENANT) return { ok: false, detail: `read back forbidden at ${url}: this receiver predates the '${DEFAULT_TENANT}' alias; pass --tenant <your tenant id> or update the receiver` };
      return { ok: false, detail: `read back forbidden at ${url}: the key belongs to a different tenant than '${tenant}'` };
    }
    if (status === null || status < 200 || status >= 300) {
      detail = status !== null ? `HTTP ${status}` : error ?? "no response";
      continue;
    }
    const rows = rowsOf(body);
    const prompt = rows.some((row) => String(row.prompt ?? "").length > 0);
    if (rows.length >= EXPECTED_SPANS && prompt) return { ok: true, detail: `${rows.length} spans merged, prompt present` };
    detail = `${rows.length} spans, prompt ${prompt ? "present" : "missing"}`;
  }
  return { ok: false, detail: `${detail} at ${url}` };
}

export async function run(cfg: SharedConfig, tenant?: string): Promise<DoctorResult> {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const { trace, root, spans } = syntheticTurn(nowNs);
  const posted = await sendTraces(cfg.endpoint, cfg.key, tracePayload(VENDOR, spans));
  if (posted.status === null || posted.status < 200 || posted.status >= 300) {
    return { ok: false, detail: `posting spans failed (${posted.status !== null ? `HTTP ${posted.status}` : posted.error ?? "no response"})` };
  }
  const merged = await sendLogs(cfg.endpoint, cfg.key, enrichment(trace, root, nowNs));
  if (merged.status === null || merged.status < 200 || merged.status >= 300) {
    return { ok: false, detail: `posting the enrichment failed (${merged.status !== null ? `HTTP ${merged.status}` : merged.error ?? "no response"})` };
  }
  const result = await read(cfg, tenant || DEFAULT_TENANT, trace);
  return { ok: result.ok, detail: `trace ${trace}: ${result.detail}` };
}
