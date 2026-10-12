import { context as otelContext } from "@opentelemetry/api";
import type { EvalKitClient } from "./core/client.js";

/**
 * The simulated user that plays a scenario's turns after its scripted ones.
 * Each turn is one POST /simulations/user-turn: the platform plays the user from
 * the scenario's persona, goal and hidden facts, sees the conversation so far
 * (with the tool calls the agent reported), and answers with the next message or
 * that the user is done. Each call is recorded as its own span marked
 * `evalkit.simulation.role: user`, which the platform never judges as the
 * agent's turn, tool call or output.
 */

/** The platform plays at most this many user turns of one scenario. */
export const MAX_LIVE_USER_TURNS = 50;
const ROLE_KEY = "evalkit.simulation.role";
const TOOL_FIELD_CAP = 2000;

export interface ReportedToolCall {
  name: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: ReportedToolCall[];
}

export interface SimulatedUserUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null when a call's model had no price. */
  costUsd: number | null;
}

export type EndedBy = "user" | "max_turns" | "script" | "error";

export class SimulatedUserError extends Error {}

export function explicitTurns(scenario: any): string[] {
  const raw = scenario?.turns ?? scenario?.messages ?? [];
  const msgs: string[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    if (typeof t === "string" && t.trim()) msgs.push(t);
    else if (t && typeof t === "object" && t.content && (t.role ?? "user") === "user") msgs.push(String(t.content));
  }
  return msgs;
}

export function scriptedTurns(scenario: any): string[] {
  const msgs = explicitTurns(scenario);
  if (!msgs.length) {
    const opening = scenario?.starting_prompt ?? scenario?.opening_message;
    if (opening) msgs.push(String(opening));
  }
  return msgs;
}

/**
 * liveUser undefined plays a live user for a scenario that states a goal and
 * scripts no turns; a turns-only scenario replays its turns as written.
 */
export function wantsLiveUser(scenario: any, liveUser?: boolean): boolean {
  if (liveUser !== undefined) return liveUser;
  const hasGoal = Boolean(scenario?.user_goal || scenario?.conversation_plan);
  return hasGoal && explicitTurns(scenario).length === 0;
}

/** The tool calls an AgentTurnResult reports, as the platform reads them. */
export function reportedToolCalls(result: unknown): ReportedToolCall[] {
  const calls = (result as { toolCalls?: unknown })?.toolCalls;
  if (!Array.isArray(calls)) return [];
  const out: ReportedToolCall[] = [];
  for (const call of calls) {
    if (!call || typeof call !== "object") continue;
    const c = call as Record<string, unknown>;
    const name = c.name ?? c.tool;
    if (typeof name !== "string" || !name) continue;
    const entry: ReportedToolCall = { name };
    const args = c.arguments ?? c.args ?? c.input;
    if (args !== undefined) entry.arguments = capped(args);
    const res = c.result ?? c.output;
    if (res !== undefined) entry.result = capped(res);
    if (c.error) entry.error = String(c.error).slice(0, TOOL_FIELD_CAP);
    out.push(entry);
  }
  return out;
}

function capped(value: unknown): unknown {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  if (text.length <= TOOL_FIELD_CAP) return value;
  return text.slice(0, TOOL_FIELD_CAP) + "...";
}

function scenarioBrief(scenario: any, maxTurns: number): Record<string, unknown> {
  const brief: Record<string, unknown> = { maxTurns };
  const persona = scenario?.persona;
  if (persona && typeof persona === "object") {
    const p = persona as Record<string, unknown>;
    const text = p.traits ?? p.description ?? p.name;
    if (typeof text === "string" && text.trim()) brief.persona = text.trim();
  } else if (typeof persona === "string" && persona.trim()) {
    brief.persona = persona.trim();
  }
  for (const [key, field] of [
    ["userGoal", "user_goal"],
    ["conversationPlan", "conversation_plan"],
    ["name", "name"],
  ] as const) {
    const value = scenario?.[field];
    if (typeof value === "string" && value.trim()) brief[key] = value.trim();
  }
  const type = scenario?.scenario_type ?? scenario?.category;
  if (typeof type === "string" && type.trim()) brief.scenarioType = type.trim();
  if (scenario?.hidden_info) brief.hiddenInfo = scenario.hidden_info;
  const fixtures = scenario?.tool_fixtures ?? scenario?.fixtures;
  if (Array.isArray(fixtures) && fixtures.length) brief.fixtures = fixtures;
  const minTurns = scenario?.min_user_turns;
  if (Number.isInteger(minTurns) && minTurns > 0) brief.minUserTurns = Math.min(minTurns, maxTurns);
  return brief;
}

/**
 * One scenario's user side: the scripted turns first, then the turn_events
 * scheduled for a turn, then (for a live scenario) the simulated user, until the
 * user is done or maxTurns user turns have been played.
 */
export class Conversation {
  readonly scripted: string[];
  readonly history: HistoryMessage[] = [];
  readonly userMessages: string[] = [];
  readonly maxTurns: number;
  readonly liveCap: number;
  endedBy?: EndedBy;
  private readonly usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private unpriced = false;

  constructor(
    private readonly client: EvalKitClient,
    private readonly scenario: any,
    readonly live: boolean,
    maxTurns: number,
    private readonly userModel: string | undefined,
    private readonly apiUrl: string | undefined,
  ) {
    this.scripted = scriptedTurns(scenario);
    this.maxTurns = Math.max(1, Math.floor(maxTurns));
    this.liveCap = Math.min(this.maxTurns, MAX_LIVE_USER_TURNS);
  }

  get turns(): number {
    return this.userMessages.length;
  }

  opening(): string | undefined {
    if (this.scripted.length) return this.scripted[0];
    if (!this.live) return undefined;
    return String(this.scenario?.user_goal ?? this.scenario?.name ?? "Hello.");
  }

  beginTurn(message: string): void {
    this.userMessages.push(message);
    this.history.push({ role: "user", content: message });
  }

  endTurn(text: string, result: unknown): void {
    const calls = reportedToolCalls(result);
    this.history.push(calls.length ? { role: "assistant", content: text, toolCalls: calls } : { role: "assistant", content: text });
  }

  /** The user's next message after the agent's latest reply, or undefined when the conversation is over. */
  async nextMessage(): Promise<string | undefined> {
    const n = this.turns + 1;
    if (n > this.maxTurns) {
      this.endedBy = "max_turns";
      return undefined;
    }
    if (n <= this.scripted.length) return this.scripted[n - 1];
    for (const event of Array.isArray(this.scenario?.turn_events) ? this.scenario.turn_events : []) {
      if (event && event.message && Number(event.at_user_turn) === n) return String(event.message);
    }
    if (!this.live) {
      this.endedBy = "script";
      return undefined;
    }
    if (n > this.liveCap) {
      this.endedBy = "max_turns";
      return undefined;
    }
    const message = await this.ask(n);
    if (message === undefined) this.endedBy = "user";
    return message;
  }

  usage(): SimulatedUserUsageTotals {
    return { ...this.usageTotals, costUsd: this.unpriced ? null : this.usageTotals.costUsd };
  }

  private async ask(turn: number): Promise<string | undefined> {
    const base = (this.apiUrl ?? process.env.EVALKIT_API_URL ?? this.client.options.apiUrl).replace(/\/$/, "");
    const body: Record<string, unknown> = {
      scenario: scenarioBrief(this.scenario, this.liveCap),
      history: this.history,
      turn,
    };
    if (this.userModel) body.model = this.userModel;
    const span = this.client.startSpan("simulated_user", {
      [ROLE_KEY]: "user",
      "evalkit.simulated_user.turn": turn,
      ...(this.userModel ? { "evalkit.simulated_user.model": this.userModel } : {}),
    });
    let answer: { done?: unknown; message?: unknown; usage?: Record<string, unknown> } = {};
    let failure: string | undefined;
    try {
      // Inside the user span, so the request's own trace events land on it rather than on the scenario.
      const res = await otelContext.with(span.ctx, () =>
        fetch(base + "/simulations/user-turn", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Subscription-Key": this.client.options.subscriptionKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        }),
      );
      const text = await res.text().catch(() => "");
      if (!res.ok) failure = `${res.status} ${platformMessage(text)}`;
      else answer = JSON.parse(text || "{}");
    } catch (e: any) {
      failure = `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`;
    }
    const usage = answer.usage && typeof answer.usage === "object" ? answer.usage : undefined;
    this.count(usage);
    const done = failure === undefined && answer.done === true;
    const message = failure === undefined && !done ? answer.message : undefined;
    if (failure === undefined && !done && !(typeof message === "string" && message.trim()))
      failure = "the platform answered without a message";

    const extra: Record<string, string | number | boolean> = { "evalkit.simulated_user.done": done };
    if (typeof message === "string") extra["evalkit.completion"] = message;
    if (usage) {
      extra["evalkit.simulated_user.input_tokens"] = Number(usage.inputTokens ?? 0);
      extra["evalkit.simulated_user.output_tokens"] = Number(usage.outputTokens ?? 0);
      if (typeof usage.costUsd === "number") extra["evalkit.simulated_user.cost_usd"] = usage.costUsd;
    }
    if (failure !== undefined) extra["error.message"] = failure.slice(0, 2000);
    span.end(failure === undefined ? "OK" : "ERROR", extra);

    if (failure !== undefined) throw new SimulatedUserError(`simulated user failed at turn ${turn}: ${failure}`.slice(0, 500));
    return done ? undefined : String(message);
  }

  private count(usage: Record<string, unknown> | undefined): void {
    if (!usage) return;
    this.usageTotals.calls += 1;
    this.usageTotals.inputTokens += Number(usage.inputTokens ?? 0);
    this.usageTotals.outputTokens += Number(usage.outputTokens ?? 0);
    if (typeof usage.costUsd === "number") this.usageTotals.costUsd += usage.costUsd;
    else this.unpriced = true;
  }
}

function platformMessage(text: string): string {
  try {
    const body = JSON.parse(text);
    const message = body?.message;
    if (Array.isArray(message)) return message.join("; ");
    if (message) return String(message);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300);
}
