import { context as otelContext } from "@opentelemetry/api";
import { randomBytes } from "node:crypto";
import type { EvalKitClient } from "./core/client.js";
import { simByTraceId, simToolCallsByTraceId } from "./core/simulation.js";
import { evaluate } from "./evaluate.js";
import { Conversation, wantsLiveUser, type EndedBy, type SimulatedUserUsageTotals } from "./live-user.js";

export interface SimContext {
  message: string;
  sessionId: string;
  state: Record<string, unknown>;
  turn: number;
}

export interface AgentTurnResult {
  text: string;
  /**
   * The tool calls behind this reply. `result` and `error` are passed to a live
   * simulated user as what the agent was told, so it can react to what the
   * agent actually did.
   */
  toolCalls?: { name: string; args?: Record<string, unknown>; result?: unknown; error?: string }[];
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
  /**
   * false (the default): each scenario carries what a live simulated user plays
   * from (persona, user_goal, hidden_info, success_criteria, the opening message)
   * and no later turns. true: every user turn is written out, for replaying a
   * conversation verbatim.
   */
  scriptedTurns?: boolean;
}

export interface SimulateUserOptions {
  entrypoint: SimEntrypoint;
  scenarios: any[];
  metrics?: string[];
  maxTurns?: number;
  tags?: string[];
  safeMode?: boolean;
  /** Used for the simulated user when userModel is not given. */
  model?: string;
  provider?: string;
  apiKey?: string;
  /** The model configuration the simulated user runs on: its name or id in your organization. */
  userModel?: string;
  /**
   * Whether a simulated user plays the turns after the scripted ones. Defaults to
   * true for a scenario with a user_goal or conversation_plan and no turns; a
   * turns-only scenario replays its turns as written.
   */
  liveUser?: boolean;
  apiUrl?: string;
}

export interface ScenarioRunResult {
  scenarioId: string;
  name: string;
  status: "OK" | "ERROR";
  turns: number;
  scores: Record<string, number>;
  error?: string;
  /** Live scenarios only: the conversation as it was played. */
  transcript?: { role: "user" | "assistant"; content: string }[];
  endedBy?: EndedBy;
  simulatedUserUsage?: SimulatedUserUsageTotals;
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
    scriptedTurns: opts.scriptedTurns ?? false,
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
): Promise<{ result: ScenarioRunResult; traceId: string }> {
  const name = scenario.name ?? "scenario";
  const scenarioId = scenario.scenario_id ?? "scn_" + randHex(6);
  const sessionId = "sess_" + randHex(6);
  const conversation = new Conversation(
    client,
    scenario,
    wantsLiveUser(scenario, opts.liveUser),
    cfg.maxTurns,
    (opts.userModel ?? opts.model)?.trim() || undefined,
    opts.apiUrl,
  );
  const state: Record<string, unknown> = { ...(scenario.setup?.state ?? {}), __safe_mode__: opts.safeMode ?? true };

  const { traceId, end, ctx } = client.startTrace(`scenario:${name}`, { "evalkit.session_id": sessionId });
  simByTraceId.set(traceId, { simulationId: cfg.simulationId, runId: cfg.runId, scenarioId });

  let status: "OK" | "ERROR" = "OK";
  let error: string | undefined;
  const texts: string[] = [];
  const explicitTools: { name: string; args?: Record<string, unknown> }[] = [];
  let scores: Record<string, number> = {};

  try {
    await otelContext.with(ctx, async () => {
      let message = conversation.opening();
      while (message !== undefined) {
        conversation.beginTurn(message);
        const simCtx: SimContext = { message, sessionId, state, turn: conversation.turns };
        const result = await opts.entrypoint(simCtx);
        let text: string;
        if (result && typeof result === "object" && "text" in result) {
          text = result.text;
          if (result.toolCalls) explicitTools.push(...result.toolCalls);
        } else {
          text = String(result);
        }
        texts.push(text);
        conversation.endTurn(text, result);
        message = await conversation.nextMessage();
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

  const result: ScenarioRunResult = { scenarioId, name, status, turns: conversation.turns, scores };
  if (error) result.error = error;
  if (conversation.live) {
    result.transcript = conversation.history.map((m) => ({ role: m.role, content: m.content }));
    result.endedBy = conversation.endedBy ?? "error";
    result.simulatedUserUsage = conversation.usage();
  }
  return { result, traceId };
}

export async function simulateUser(
  client: EvalKitClient,
  opts: SimulateUserOptions,
): Promise<{ simulationId: string; runId: string; results: ScenarioRunResult[] }> {
  const simulationId = "sim_" + randHex(8);
  const runId = "run_" + randHex(8);
  const maxTurns = opts.maxTurns ?? 12;
  const results: ScenarioRunResult[] = [];
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
