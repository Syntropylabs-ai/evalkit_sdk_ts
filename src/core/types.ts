export interface TraceEnvelope {

  traceId: string;
  spanId: string;
  parentSpanId?: string;

  spanKind?: "CLIENT" | "SERVER" | "INTERNAL" | "PRODUCER" | "CONSUMER";
  spanType: "llm_call" | "tool_call" | "log" | "http_call" | "function_call" | "db_query" | "eval_result";
  status?: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  serviceName?: string;
  operation?: string;

  model?: string;
  provider?: string;

  prompt?: string;
  completion?: string;

  attributes?: Record<string, string | number | boolean | string[]>;

  events?: SpanEvent[];

  tokensIn?: number;
  tokensOut?: number;

  cacheReadTokens?: number;
  cacheCreationTokens?: number;

  latencyMs?: number;
  startTime?: string;
  endTime?: string;
  createdAt: string;

  environment?: string;
  appVersion?: string;
  userId?: string;
  sessionId?: string;
  deviceId?: string;
  traceProjectId?: string;
  sdkVersion?: string;
  isSimulation?: boolean;
  simulationId?: string;
  scenarioId?: string;
  runId?: string;
}

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface BatchIngestRequest {
  events: TraceEnvelope[];
}

export interface EvalKitOptions {
  subscriptionKey: string;

  baseUrl?: string;

  apiUrl?: string;

  serviceName?: string;

  debug?: boolean;

  maxExportBatchSize?: number;

  scheduledDelayMillis?: number;

  maxBodyBytes?: number;

  environment?: string;

  appVersion?: string;

  deviceId?: string;

  captureGlobalErrors?: boolean;
}
