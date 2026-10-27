import type { TracerProvider } from "@opentelemetry/api";
import type { FunctionPattern, RoutePattern, UrlPattern } from "./ignore.js";

export interface TraceEnvelope {

  traceId: string;
  spanId: string;
  parentSpanId?: string;

  spanKind?: "CLIENT" | "SERVER" | "INTERNAL" | "PRODUCER" | "CONSUMER";
  /**
   * `agent` is one agent's run (an agent framework's `invoke_agent` span); `internal` is a framework's own
   * structure that is neither a model call nor a tool call (an event-loop cycle).
   */
  spanType: "llm_call" | "tool_call" | "log" | "http_call" | "function_call" | "db_query" | "eval_result" | "agent" | "internal";
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
  /** The named agent this span belongs to (setAgent / startTrace agentName / span attribute). */
  agentName?: string;
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

export type MaskHook = (envelope: TraceEnvelope) => TraceEnvelope | null | undefined;

export type ConsoleSpanLevel = "info" | "warn" | "error" | "none";

export interface EvalKitOptions {
  subscriptionKey: string;

  baseUrl?: string;

  apiUrl?: string;

  serviceName?: string;

  debug?: boolean;

  maxExportBatchSize?: number;

  scheduledDelayMillis?: number;

  /** The most of an HTTP request or response body recorded, in bytes. Default 64 KiB. */
  maxBodyBytes?: number;

  environment?: string;

  appVersion?: string;

  deviceId?: string;

  /** Records uncaught exceptions and unhandled rejections as error spans. Off by default. */
  captureGlobalErrors?: boolean;

  captureContent?: boolean;

  captureSecrets?: boolean;

  exportGzip?: boolean;

  mask?: MaskHook;

  tracerProvider?: TracerProvider;

  /** The most spans waiting for export; past it new spans are dropped and counted. Default 2048 (OTEL_BSP_MAX_QUEUE_SIZE). */
  maxQueueSize?: number;

  /**
   * The most memory spans waiting for export may hold, in bytes. Past it the oldest spans that are not model
   * calls make room for a model call, and other spans are dropped; both are counted. Default 32 MiB.
   */
  maxQueueBytes?: number;

  /**
   * The most one attribute value keeps, in UTF-8 bytes. A longer value keeps its start and its end around a
   * `…[cut N bytes]…` marker, and `evalkit.truncated.<attribute>` records its original size. Default 16 MiB,
   * lowered by OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT when that is set.
   */
  maxValueBytes?: number;

  /**
   * The share of traces kept, from 0 to 1, decided by trace id so a trace is kept or left whole. Model calls,
   * tool calls and errored spans are always kept, and a trace sampled by the service that called this one
   * stays sampled. Default 1: every trace (EVALKIT_SAMPLE_RATE).
   */
  sampleRate?: number;

  /** Records console.log / warn / error as log events on the active span. Default true. */
  captureConsole?: boolean;

  /**
   * The lowest console level recorded as a span of its own when no span is active: "info" (console.log too),
   * "warn", "error" or "none". Default "warn" (EVALKIT_CONSOLE_SPAN_LEVEL).
   */
  consoleSpanLevel?: ConsoleSpanLevel;

  /**
   * Flushes spans when the process is about to exit: on `beforeExit`, and on SIGTERM / SIGINT when the app
   * has no handler of its own for the signal (within 3 s, then the signal's default action). Default true
   * (EVALKIT_EXIT_HOOKS=false turns it off).
   */
  exitHooks?: boolean;

  /** Frames whose file matches one of these (substring or RegExp) are the app's own, even in node_modules. */
  inAppInclude?: Array<string | RegExp>;

  /** Frames whose file matches one of these are not the app's own. Wins over `inAppInclude`. */
  inAppExclude?: Array<string | RegExp>;

  /**
   * How many frames an error's stack records. Unset by default: Error.stackTraceLimit is process-wide, so
   * raising it makes every Error the app creates collect more frames, not just the ones traced. When set, it
   * is raised only from V8's default of 10, so a limit the app set itself stays.
   */
  stackTraceLimit?: number;

  /** Maps stack frames to the original sources through source maps (process.setSourceMapsEnabled). Default false. */
  sourceMaps?: boolean;

  /**
   * Inbound requests left out of tracing whole, with everything they do: an exact path (`"/metrics"`), a glob
   * (`"/internal/*"`, `"/static/**"`), a route template (`"GET /v1/orders/:id"`), optionally led by a method, a
   * RegExp tested against the path, or a function of `{ method, path, route }`. EVALKIT_IGNORE_ROUTES adds
   * comma-separated patterns.
   */
  ignoreRoutes?: RoutePattern | RoutePattern[];

  /**
   * Outgoing HTTP calls (http/https, fetch, axios) left out of tracing: no span and no traceparent. A full URL
   * or host-and-path glob (`"https://api.example.com/v1/**"`, `"*.internal.example.com"`, `"/v1/ingest"`), a
   * RegExp tested against the URL, or a function of `{ method, url, host, path }`. EVALKIT_IGNORE_URLS adds more.
   */
  ignoreUrls?: UrlPattern | UrlPattern[];

  /**
   * Function spans left out by name (`"OrdersService.*"`, `"cache.**"`, a RegExp or a function of the name), the
   * wrappers' own included: an ignored name wins over traceFunction, @Traced and Nest auto-tracing.
   * EVALKIT_IGNORE_FUNCTIONS adds more.
   */
  ignoreFunctions?: FunctionPattern | FunctionPattern[];

  /** Traces health and readiness probes (/health, /healthz, /readyz, ...) like any request. Default false. */
  traceHealthChecks?: boolean;

  /**
   * The status codes an incoming request's span is an error for: codes (`503`) and inclusive ranges
   * (`"500-599"`). Default `["400-599"]`: every 4xx and 5xx answer is an error. `["500-599"]` follows
   * OpenTelemetry's HTTP conventions instead, where a 4xx answer is the caller's mistake, so its span keeps the
   * status code, stays OK and records no exception. Outgoing calls are not affected; a 4xx they get back stays
   * an error.
   */
  serverErrorStatusCodes?: Array<number | string>;
}
