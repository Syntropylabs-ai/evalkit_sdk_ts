import { context as otelContext } from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import type { EvalKitClient } from "./core/client.js";
import { simByTraceId, simToolCallsByTraceId } from "./core/simulation.js";
import { evaluate } from "./evaluate.js";

export interface SimContext {
  message: string;
  sessionId: string;
  state: Record<string, unknown>;
  turn: number;
}

export interface AgentTurnResult {
  text: string;
  toolCalls?: { name: string; args?: Record<string, unknown> }[];
  retrievedContext?: string[];
}

export type SimEntrypoint = (ctx: SimContext) => string | AgentTurnResult | Promise<string | AgentTurnResult>;

export interface GenerateScenariosOptions {
  agentInstructions: string;
  tools?: unknown[];
  functionSchemas?: unknown[];
  context?: unknown;
  rag?: Record<string, unknown>;
  count?: number;
  categories?: string[];
  model?: string;
  provider?: string;
  apiKey?: string;
  temperature?: number;
  reasoningEffort?: string;
  maxCompletionTokens?: number;
  maxTokens?: number;
  apiUrl?: string;
}

export interface SimulateUserOptions {
  entrypoint: SimEntrypoint;
  scenarios: any[];
  metrics?: string[];
  maxTurns?: number;
  tags?: string[];
  safeMode?: boolean;
  model?: string;
  provider?: string;
  apiKey?: string;
}

export interface EvaluateSimulationOptions {

  simulationId: string;

  collectionId: string;

  provider: string;

  model: string;

  apiKey: string;

  runId?: string;

  maxTokens?: number;

  apiUrl?: string;
}

export interface SimEvalMetric {
  ruleId: string;
  ruleName: string;
  category: string;
  score: number;
  passed: boolean;
  reason: string;
}

export interface SimEvalScenario {
  scenarioId: string;
  name: string;
  traceId: string;
  status: string;
  overallScore: number;
  passed: boolean;
  metrics: SimEvalMetric[];
  error?: string;
}

export interface EvaluateSimulationResult {
  simulationId: string;
  runId: string;
  scenarios: SimEvalScenario[];
  aggregate: {
    averageScore: number;
    passRate: number;
    totalScenarios: number;
    evaluatedScenarios: number;
  };
}

function randHex(n: number): string {
  return randomBytes(n).toString("hex");
}

function jsonableTool(t: any): unknown {
  if (typeof t === "function") return { name: t.name || "tool" };
  if (typeof t === "string" || (t && typeof t === "object")) return t;
  return String(t);
}

function _requireFetch(): void {
  if (typeof fetch === "undefined") {
    throw new Error("[evalkit] global fetch is required (Node 18+). Upgrade Node or install a fetch polyfill.");
  }
}

export async function generateScenarios(
  client: EvalKitClient,
  opts: GenerateScenariosOptions,
): Promise<any[]> {
  _requireFetch();
  const base = (opts.apiUrl ?? process.env.EVALKIT_API_URL ?? client.options.apiUrl).replace(/\/$/, "");
  const body: Record<string, unknown> = {
    agentInstructions: opts.agentInstructions,
    count: opts.count ?? 5,
  };
  if (opts.tools) body.tools = opts.tools.map(jsonableTool);
  if (opts.functionSchemas) body.functionSchemas = opts.functionSchemas.map(jsonableTool);
  if (opts.context !== undefined) body.context = opts.context;
  if (opts.rag) body.rag = opts.rag;
  if (opts.categories) body.categories = opts.categories;
  if (opts.model) body.model = opts.model;
  if (opts.provider) body.provider = opts.provider;
  if (opts.apiKey) body.apiKey = opts.apiKey;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.reasoningEffort !== undefined) body.reasoningEffort = opts.reasoningEffort;
  if (opts.maxCompletionTokens !== undefined) body.maxCompletionTokens = opts.maxCompletionTokens;
  if (opts.maxTokens !== undefined) body.maxTokens = opts.maxTokens;

  const res = await fetch(base + "/scenarios/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Subscription-Key": client.options.subscriptionKey,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`generateScenarios failed ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { scenarios?: any[] };
  return data.scenarios ?? [];
}

function userTurns(scenario: any): string[] {
  const raw = scenario.turns ?? scenario.messages ?? [];
  const msgs: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") msgs.push(t);
    else if (t && typeof t === "object" && t.content && (t.role ?? "user") === "user") msgs.push(String(t.content));
  }
  if (msgs.length === 0 && scenario.starting_prompt) msgs.push(String(scenario.starting_prompt));
  return msgs;
}

function scoreScenario(
  scenario: any,
  output: string,
  toolCalls: { name: string; args?: Record<string, unknown> }[],
  metrics?: string[],
): Record<string, number> {
  const requiredTerms = Array.from(
    new Set<string>([...(scenario.constraints?.required_terms ?? []), ...(scenario.target_keywords ?? [])]),
  );
  const constraints: { requiredTerms?: string[]; hasCitations?: boolean } = {};
  if (requiredTerms.length) constraints.requiredTerms = requiredTerms;
  if (scenario.constraints?.has_citations !== undefined) constraints.hasCitations = scenario.constraints.has_citations;
  try {
    const r = evaluate({
      output,
      toolCalls,
      expectedTools: scenario.expected_tools ?? [],
      constraints,
      metrics: metrics as any,
    });
    return r.scores as Record<string, number>;
  } catch {
    return {};
  }
}

async function runScenario(
  client: EvalKitClient,
  opts: SimulateUserOptions,
  scenario: any,
  cfg: { simulationId: string; runId: string; maxTurns: number },
): Promise<{ result: any; traceId: string }> {
  const name = scenario.name ?? "scenario";
  const scenarioId = scenario.scenario_id ?? "scn_" + randHex(6);
  const sessionId = "sess_" + randHex(6);
  const turns = userTurns(scenario).slice(0, cfg.maxTurns);
  const state: Record<string, unknown> = { ...(scenario.setup?.state ?? {}), __safe_mode__: opts.safeMode ?? true };

  const { traceId, end, ctx } = client.startTrace(`scenario:${name}`, { "evalkit.session_id": sessionId });
  simByTraceId.set(traceId, { simulationId: cfg.simulationId, runId: cfg.runId, scenarioId });

  let status: "OK" | "ERROR" = "OK";
  let error: string | undefined;
  const texts: string[] = [];
  const explicitTools: { name: string; args?: Record<string, unknown> }[] = [];
  let count = 0;
  let scores: Record<string, number> = {};

  try {
    await otelContext.with(ctx, async () => {
      for (let i = 0; i < turns.length; i++) {
        const simCtx: SimContext = { message: turns[i], sessionId, state, turn: i + 1 };
        const result = await opts.entrypoint(simCtx);
        if (result && typeof result === "object" && "text" in result) {
          texts.push(result.text);
          if (result.toolCalls) explicitTools.push(...result.toolCalls);
        } else {
          texts.push(String(result));
        }
        count++;
      }

      const toolCalls = explicitTools.length ? explicitTools : (simToolCallsByTraceId.get(traceId) ?? []);
      scores = scoreScenario(scenario, texts.join("\n"), toolCalls, opts.metrics);
    });
  } catch (e: any) {
    status = "ERROR";
    error = e?.message ?? String(e);
  } finally {
    end(status);
  }

  const result: any = { scenarioId, name, status, turns: count, scores };
  if (error) result.error = error;
  return { result, traceId };
}

export async function simulateUser(
  client: EvalKitClient,
  opts: SimulateUserOptions,
): Promise<{ simulationId: string; runId: string; results: any[] }> {
  const simulationId = "sim_" + randHex(8);
  const runId = "run_" + randHex(8);
  const maxTurns = opts.maxTurns ?? 12;
  const results: any[] = [];
  const traceIds: string[] = [];

  for (const scenario of opts.scenarios) {
    const { result, traceId } = await runScenario(client, opts, scenario, { simulationId, runId, maxTurns });
    results.push(result);
    traceIds.push(traceId);
  }

  await client.flush();
  for (const id of traceIds) {
    simByTraceId.delete(id);
    simToolCallsByTraceId.delete(id);
  }

  return { simulationId, runId, results };
}

export async function evaluateSimulation(
  client: EvalKitClient,
  opts: EvaluateSimulationOptions,
): Promise<EvaluateSimulationResult> {
  _requireFetch();
  const base = (opts.apiUrl ?? process.env.EVALKIT_API_URL ?? client.options.apiUrl).replace(/\/$/, "");
  const body: Record<string, unknown> = {
    simulationId: opts.simulationId,
    collectionId: opts.collectionId,
    provider: opts.provider,
    model: opts.model,
    apiKey: opts.apiKey,
  };
  if (opts.runId !== undefined) body.runId = opts.runId;
  if (opts.maxTokens !== undefined) body.maxTokens = opts.maxTokens;

  const res = await fetch(base + "/simulations/evaluate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Subscription-Key": client.options.subscriptionKey,
    },
    body: JSON.stringify(body),

    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`evaluateSimulation failed ${res.status}: ${text}`);
  }
  return (await res.json()) as EvaluateSimulationResult;
}
