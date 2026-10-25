import { diag, DiagLogLevel } from "@opentelemetry/api";
import type { DiagLogger } from "@opentelemetry/api";

export type CircuitState = "closed" | "open" | "half_open" | "disabled";

/** What `getStats()` reports about the span pipeline of the client in force. */
export interface EvalKitStats {
  /** Spans waiting to be exported, the ones of the export in flight included. */
  queued: number;
  /** Estimated memory those spans hold. */
  queued_bytes: number;
  /** Spans the receiver accepted. */
  exported: number;
  /** Spans dropped because the queue held `maxQueueSize` spans. */
  dropped_queue_full: number;
  /** Spans dropped to keep the queue within `maxQueueBytes`; spans of model calls go last. */
  dropped_bytes_budget: number;
  /** Spans dropped because exporting failed, or while the circuit was open after repeated failures. */
  dropped_export_failed: number;
  /** Spans left out by `sampleRate`. They are not failures. */
  sampled_out: number;
  /** Export cycles that failed. */
  export_failures: number;
  /** The latest failure, at most 200 characters; null once an export succeeds after it. */
  last_error: string | null;
  circuit_state: CircuitState;
}

export function emptyStats(state: CircuitState = "closed"): EvalKitStats {
  return {
    queued: 0,
    queued_bytes: 0,
    exported: 0,
    dropped_queue_full: 0,
    dropped_bytes_budget: 0,
    dropped_export_failed: 0,
    sampled_out: 0,
    export_failures: 0,
    last_error: null,
    circuit_state: state,
  };
}

/** The counters one pipeline (processor and exporter) shares. */
export class PipelineCounters {
  exported = 0;
  droppedQueueFull = 0;
  droppedBytesBudget = 0;
  droppedExportFailed = 0;
  sampledOut = 0;
  exportFailures = 0;
  lastError: string | null = null;
}

/** The most of a failure's reason any one log line or `last_error` carries. */
export const REASON_MAX = 200;

export function cutReason(text: unknown, max: number = REASON_MAX): string {
  let s: string;
  try {
    s = typeof text === "string" ? text : text instanceof Error ? `${text.name}: ${text.message}` : String(text);
  } catch {
    s = "unknown error";
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Writes one of the SDK's own lines. The console patch leaves lines that start with `[evalkit]` unrecorded. */
export function sdkLog(level: "warn" | "error", message: string): void {
  try {
    (level === "error" ? console.error : console.warn)(message);
  } catch {
    // A console that throws gets nothing more from the SDK.
  }
}

const FIVE_MINUTES = 5 * 60_000;

/**
 * Reports export failures without flooding the app's log: the first failure once, then at most one line per
 * five minutes with how many failures and dropped spans there were since, and one line when exporting
 * recovers. With `debug` every failure is printed, still cut to 200 characters and without stacks.
 */
export class FailureReporter {
  private failing = false;
  private lastReportAt = 0;
  private failuresSince = 0;
  private droppedSince = 0;
  private lastNoticeAt = -Infinity;

  constructor(
    private readonly counters: PipelineCounters,
    private readonly debug: boolean,
    private readonly clock: () => number = Date.now,
  ) {}

  failure(reason: string, droppedSpans: number): void {
    const text = cutReason(reason);
    this.counters.lastError = text;
    const now = this.clock();
    if (!this.failing) {
      this.failing = true;
      this.lastReportAt = now;
      this.failuresSince = 0;
      this.droppedSince = 0;
      sdkLog(
        "error",
        `[evalkit] ${text} (exporting spans is failing; spans that cannot be sent are dropped, and this is ` +
          "reported again at most every 5 minutes)",
      );
      return;
    }
    this.failuresSince++;
    this.droppedSince += droppedSpans;
    if (this.debug) {
      sdkLog("error", `[evalkit] ${text}`);
      return;
    }
    if (now - this.lastReportAt >= FIVE_MINUTES) {
      const minutes = Math.round((now - this.lastReportAt) / 60_000);
      sdkLog(
        "error",
        `[evalkit] exporting spans is still failing: ${this.failuresSince} more failure(s) and ` +
          `${this.droppedSince} span(s) dropped in the last ${minutes} min; latest: ${text}`,
      );
      this.lastReportAt = now;
      this.failuresSince = 0;
      this.droppedSince = 0;
    }
  }

  /** A refusal of particular spans (one too large), which says nothing about the receiver's health. */
  notice(reason: string): void {
    const text = cutReason(reason);
    this.counters.lastError = text;
    const now = this.clock();
    if (!this.debug && now - this.lastNoticeAt < FIVE_MINUTES) return;
    this.lastNoticeAt = now;
    sdkLog("warn", `[evalkit] ${text}`);
  }

  recovered(): void {
    this.counters.lastError = null;
    if (!this.failing) return;
    this.failing = false;
    sdkLog("warn", "[evalkit] exporting spans recovered");
  }
}

// OpenTelemetry's own diagnostics: warnings and errors, at most ten a minute, each line cut short.
const DIAG_WINDOW_MS = 60_000;
const DIAG_PER_WINDOW = 10;
let diagWindowStart = 0;
let diagInWindow = 0;
let diagSuppressed = 0;
let diagInstalled = false;

function diagLine(level: "warn" | "error", args: unknown[]): void {
  try {
    const text = cutReason(args.map((a) => (typeof a === "string" ? a : cutReason(a))).join(" "));
    // The app replacing this logger with its own is not worth a line, and neither is a second registration
    // of a global the SDK checks for itself before registering (it then attaches to the one installed).
    if (text.startsWith("Current logger will be overwritten")) return;
    if (text.includes("Attempted duplicate registration of API")) return;
    const now = Date.now();
    if (now - diagWindowStart >= DIAG_WINDOW_MS) {
      if (diagSuppressed > 0) sdkLog("warn", `[evalkit] OpenTelemetry: ${diagSuppressed} more diagnostic message(s) suppressed`);
      diagWindowStart = now;
      diagInWindow = 0;
      diagSuppressed = 0;
    }
    if (diagInWindow >= DIAG_PER_WINDOW) {
      diagSuppressed++;
      return;
    }
    diagInWindow++;
    sdkLog(level, `[evalkit] OpenTelemetry: ${text}`);
  } catch {
    // Diagnostics never fail the caller.
  }
}

const rateLimitedLogger: DiagLogger = {
  error: (...args: unknown[]) => diagLine("error", args),
  warn: (...args: unknown[]) => diagLine("warn", args),
  info: () => {},
  debug: () => {},
  verbose: () => {},
};

/** Whether the app registered a diag logger of its own; the SDK never replaces one. */
function hostDiagLogger(): boolean {
  try {
    const registry = (globalThis as Record<symbol, { diag?: unknown } | undefined>)[Symbol.for("opentelemetry.js.api.1")];
    return !!registry?.diag;
  } catch {
    return true;
  }
}

/** Routes OpenTelemetry's warnings and errors to the console, rate limited, unless the app has its own logger. */
export function installDiagLogger(): void {
  if (diagInstalled || hostDiagLogger()) return;
  try {
    diag.setLogger(rateLimitedLogger, { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true });
    diagInstalled = true;
  } catch {
    // Without a diag logger OpenTelemetry stays silent, as it is by default.
  }
}
