import type { ConsoleSpanLevel, EvalKitOptions } from "./types.js";
import { envFlag } from "./redact.js";
import { sdkLog } from "./diagnostics.js";
import { serverErrorStatusProblem } from "./http-status.js";

export const CONSOLE_SPAN_LEVELS: readonly ConsoleSpanLevel[] = ["info", "warn", "error", "none"];

/** Why tracing is switched off by the environment: EVALKIT_DISABLED, or OpenTelemetry's OTEL_SDK_DISABLED. */
export function disabledByEnvironment(): string | undefined {
  try {
    if (typeof process === "undefined" || !process.env) return undefined;
    if (envFlag("EVALKIT_DISABLED") === true) return "EVALKIT_DISABLED";
    if (String(process.env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true") return "OTEL_SDK_DISABLED";
  } catch {
    // An unreadable environment disables nothing.
  }
  return undefined;
}

type NumberRule = { min: number; max?: number; integer?: boolean };

const NUMBER_RULES: Partial<Record<keyof EvalKitOptions, NumberRule>> = {
  maxExportBatchSize: { min: 1, integer: true },
  scheduledDelayMillis: { min: 0 },
  maxBodyBytes: { min: 0, integer: true },
  maxQueueSize: { min: 1, integer: true },
  maxQueueBytes: { min: 1, integer: true },
  maxValueBytes: { min: 1, integer: true },
  sampleRate: { min: 0, max: 1 },
  stackTraceLimit: { min: 0, integer: true },
};

/** A number given as a number or as numeric text (an environment variable passed through); NaN otherwise. */
function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function checkNumber(name: string, value: unknown, rule: NumberRule): string | undefined {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return `${name} must be a finite number (got ${describe(value)})`;
  if (rule.integer && !Number.isInteger(n)) return `${name} must be a whole number (got ${n})`;
  if (n < rule.min) return `${name} must be at least ${rule.min} (got ${n})`;
  if (rule.max !== undefined && n > rule.max) return `${name} must be at most ${rule.max} (got ${n})`;
  return undefined;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (value === null) return "null";
  return typeof value;
}

function checkUrl(name: string, value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return `${name} must be an http(s) URL (got ${describe(value)})`;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return `${name} must be an http(s) URL (got ${url.protocol})`;
  } catch {
    return `${name} must be an http(s) URL (got ${describe(value)})`;
  }
  return undefined;
}

/**
 * Every reason `options` cannot trace. The key is never printed: only whether it is there. A numeric option
 * may come as numeric text, which `normaliseOptions` turns into a number.
 */
export function validateOptions(options: unknown): string[] {
  const problems: string[] = [];
  if (!options || typeof options !== "object") return ["init() needs an options object with subscriptionKey"];
  const o = options as Record<string, unknown>;
  if (typeof o.subscriptionKey !== "string" || o.subscriptionKey.trim() === "") {
    problems.push("subscriptionKey is missing or empty");
  }
  for (const name of ["baseUrl", "apiUrl"] as const) {
    if (o[name] !== undefined) {
      const problem = checkUrl(name, o[name]);
      if (problem) problems.push(problem);
    }
  }
  for (const [name, rule] of Object.entries(NUMBER_RULES)) {
    if (o[name] === undefined) continue;
    const problem = checkNumber(name, o[name], rule!);
    if (problem) problems.push(problem);
  }
  if (o.consoleSpanLevel !== undefined && !CONSOLE_SPAN_LEVELS.includes(o.consoleSpanLevel as ConsoleSpanLevel)) {
    problems.push(`consoleSpanLevel must be one of ${CONSOLE_SPAN_LEVELS.join(", ")} (got ${describe(o.consoleSpanLevel)})`);
  }
  if (o.mask !== undefined && typeof o.mask !== "function") problems.push("mask must be a function");
  if (o.tracerProvider !== undefined && (o.tracerProvider === null || typeof o.tracerProvider !== "object")) {
    problems.push("tracerProvider must be an OpenTelemetry TracerProvider");
  }
  for (const name of ["inAppInclude", "inAppExclude"] as const) {
    if (o[name] !== undefined && !Array.isArray(o[name])) problems.push(`${name} must be an array of strings or RegExps`);
  }
  if (o.serverErrorStatusCodes !== undefined) {
    const problem = serverErrorStatusProblem(o.serverErrorStatusCodes);
    if (problem) problems.push(problem);
  }
  return problems;
}

/** `options` with numeric text turned into numbers; call only on options that validated. */
export function normaliseOptions(options: EvalKitOptions): EvalKitOptions {
  const out: Record<string, unknown> = { ...options };
  for (const name of Object.keys(NUMBER_RULES)) {
    if (out[name] !== undefined) out[name] = asNumber(out[name]);
  }
  return out as unknown as EvalKitOptions;
}

let envWarned = new Set<string>();

function warnEnvOnce(name: string, message: string): void {
  if (envWarned.has(name)) return;
  envWarned.add(name);
  sdkLog("warn", `[evalkit] ${message}; ignoring it and leaving the default in place`);
}

/** A number from the environment within `rule`, or undefined (with one warning) when it is not one. */
export function envNumber(name: string, rule: NumberRule): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw.trim() === "") return undefined;
  const problem = checkNumber(name, raw, rule);
  if (problem) {
    warnEnvOnce(name, problem);
    return undefined;
  }
  return Number(raw);
}

export function resolveSampleRate(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  return envNumber("EVALKIT_SAMPLE_RATE", { min: 0, max: 1 }) ?? 1;
}

export function resolveConsoleSpanLevel(explicit?: ConsoleSpanLevel): ConsoleSpanLevel {
  if (explicit !== undefined) return explicit;
  const raw = typeof process !== "undefined" ? process.env?.EVALKIT_CONSOLE_SPAN_LEVEL : undefined;
  if (raw === undefined || raw.trim() === "") return "warn";
  const level = raw.trim().toLowerCase() as ConsoleSpanLevel;
  if (CONSOLE_SPAN_LEVELS.includes(level)) return level;
  warnEnvOnce("EVALKIT_CONSOLE_SPAN_LEVEL", `EVALKIT_CONSOLE_SPAN_LEVEL must be one of ${CONSOLE_SPAN_LEVELS.join(", ")}`);
  return "warn";
}

export function resolveExitHooks(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return envFlag("EVALKIT_EXIT_HOOKS") ?? true;
}

export function resolveMaxQueueSize(explicit?: number): number | undefined {
  if (explicit !== undefined) return explicit;
  return envNumber("OTEL_BSP_MAX_QUEUE_SIZE", { min: 1, integer: true });
}

/** For tests: forget which environment variables were already warned about. */
export function resetEnvWarnings(): void {
  envWarned = new Set();
}
