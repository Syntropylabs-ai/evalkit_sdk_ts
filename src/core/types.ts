/** Matches the Go trace-service TraceEnvelope exactly. */
export interface TraceEnvelope {
  // W3C trace context
  traceId: string;   // 32 hex chars
  spanId: string;    // 16 hex chars
  parentSpanId?: string;

  // Span classification
  spanKind?: "CLIENT" | "SERVER" | "INTERNAL" | "PRODUCER" | "CONSUMER";
  spanType: "llm_call" | "tool_call" | "log" | "http_call" | "function_call" | "db_query" | "eval_result";
  status?: "OK" | "ERROR" | "UNSET";
  statusMessage?: string;
  serviceName?: string;
  operation?: string;

  // GenAI semantic conventions
  model?: string;
  provider?: string;

  // Convenience text fields
  prompt?: string;
  completion?: string;

  // All OTEL attributes (gen_ai.request.*, gen_ai.response.*, etc.)
  attributes?: Record<string, string | number | boolean | string[]>;

  // Span events — tool calls, messages, choices
  events?: SpanEvent[];

  // Token accounting
  tokensIn?: number;
  tokensOut?: number;
  // Tokens served from / written to the provider's prompt cache (Anthropic
  // cache_read_input_tokens/cache_creation_input_tokens, OpenAI
  // prompt_tokens_details.cached_tokens, Gemini cached_content_token_count).
  // Already counted within tokensIn — additive breakdowns for cost math,
  // not extra tokens on top of tokensIn.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;

  // Timing
  latencyMs?: number;
  startTime?: string;
  endTime?: string;
  createdAt: string;

  // Extended context (v2)
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
  /**
   * Base URL of the trace ingest service.
   * Defaults to the hosted EvalKit service (https://ingest.evalkit.io).
   * Override for self-hosted or local development (e.g. http://localhost:8085).
   */
  baseUrl?: string;
  /** Orchestrator / control-plane base URL (scenario generation). Defaults to the hosted service. */
  apiUrl?: string;
  /** Service name attached to every span (default: "unknown") */
  serviceName?: string;
  /** Log flush details to console (default: false) */
  debug?: boolean;
  /** Max spans per export batch (default: 512) */
  maxExportBatchSize?: number;
  /** Export interval in ms (default: 5000) */
  scheduledDelayMillis?: number;
  /**
   * Max bytes of any captured HTTP request/response body stored on a span
   * (default: 10 MB). Bodies larger than this are truncated. Applies to the HTTP
   * client patches (axios/node-http) and all framework middleware.
   */
  maxBodyBytes?: number;
  /** deployment environment, e.g. "development" | "staging" | "production" */
  environment?: string;
  /** application version string, e.g. "1.2.3" */
  appVersion?: string;
  /** stable identifier for the originating client/device (e.g. browser fingerprint, machine ID) */
  deviceId?: string;
  /**
   * Install global process error hooks (uncaughtException / unhandledRejection).
   * Default: false — installing an uncaughtException listener changes Node's crash
   * semantics (the process stops exiting on fatal errors), which the host never
   * opted into. When true, EvalKit records the error AND preserves the host's exit.
   */
  captureGlobalErrors?: boolean;
}
