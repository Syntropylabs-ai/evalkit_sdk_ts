export interface SimulationInfo {
  simulationId: string;
  runId: string;
  scenarioId: string;
}

export const simByTraceId = new Map<string, SimulationInfo>();

/**
 * Tool calls captured per simulation trace, so `simulateUser` can score tool
 * metrics even when the agent's entrypoint doesn't return an AgentTurnResult.
 * The LLM patchers append here (via `recordSimToolCall`) whenever the active
 * trace belongs to a running simulation.
 */
export const simToolCallsByTraceId = new Map<string, { name: string; args?: Record<string, unknown> }[]>();

/** Record a tool call against a trace IFF that trace is part of a live simulation. */
export function recordSimToolCall(traceId: string | undefined, name: string, args?: Record<string, unknown>): void {
  if (!traceId || !name || !simByTraceId.has(traceId)) return;
  const list = simToolCallsByTraceId.get(traceId) ?? [];
  list.push({ name, args });
  simToolCallsByTraceId.set(traceId, list);
}
