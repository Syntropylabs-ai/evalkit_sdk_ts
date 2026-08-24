export interface SimulationInfo {
  simulationId: string;
  runId: string;
  scenarioId: string;
}

export const simByTraceId = new Map<string, SimulationInfo>();

export const simToolCallsByTraceId = new Map<string, { name: string; args?: Record<string, unknown> }[]>();

export function recordSimToolCall(traceId: string | undefined, name: string, args?: Record<string, unknown>): void {
  if (!traceId || !name || !simByTraceId.has(traceId)) return;
  const list = simToolCallsByTraceId.get(traceId) ?? [];
  list.push({ name, args });
  simToolCallsByTraceId.set(traceId, list);
}
