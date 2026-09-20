import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigStore } from "./config.js";
import { readBase } from "./otlp.js";

export const EXIT_PASSED = 0;
export const EXIT_FAILED = 1;
export const EXIT_UNDECIDED = 2;
export const EXIT_ERROR = 3;

const SDK_PACKAGE = "syntropylabs-evalkit";
const SPEC_KEYS = new Set([
  "name",
  "data",
  "task",
  "evaluators",
  "judgeModel",
  "judgeModelConfigId",
  "baselineJobId",
  "gate",
  "hyperparameters",
  "autoBaseline",
  "batchSize",
  "timeoutMs",
]);

export type Verdict = "passed" | "failed" | "undecided";

export interface GateCheck {
  name: string;
  threshold: number;
  actual: number | null;
  passed: boolean | null;
}

export interface GateResult {
  passed: boolean | null;
  checks: GateCheck[];
  evaluatedAt?: string;
}

export interface RunReport {
  runId: string | null;
  jobId: string | null;
  url: string | null;
  name: string | null;
  totalRows: number | null;
  erroredRows: number | null;
  indeterminateRows: number | null;
  passRate: number | null;
  averageScore: number | null;
  overallScores: Record<string, number | null> | null;
  gate: GateResult | null;
}

export interface SdkModule {
  init(opts: { subscriptionKey: string; apiUrl: string; baseUrl: string; serviceName: string }): unknown;
  Eval(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
  flush(): Promise<void>;
}

export interface EvalCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  home?: string;
  cwd?: string;
  sdk?: () => Promise<SdkModule>;
}

export interface EvalFlags {
  key?: string;
  apiUrl?: string;
  json: boolean;
  allowUndecided: boolean;
  exportName?: string;
}

export class EvalCliError extends Error {}

export function verdict(passed: boolean | null | undefined): Verdict {
  if (passed === true) return "passed";
  if (passed === false) return "failed";
  return "undecided";
}

export function exitCode(passed: boolean | null | undefined, allowUndecided = false): number {
  if (passed === true) return EXIT_PASSED;
  if (passed === false) return EXIT_FAILED;
  return allowUndecided ? EXIT_PASSED : EXIT_UNDECIDED;
}

export function gatePassed(gate: GateResult | null): boolean | null {
  return typeof gate?.passed === "boolean" ? gate.passed : null;
}

function asGate(value: unknown): GateResult | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const checks = Array.isArray(raw.checks) ? (raw.checks as GateCheck[]) : [];
  return {
    passed: typeof raw.passed === "boolean" ? raw.passed : null,
    checks,
    ...(typeof raw.evaluatedAt === "string" ? { evaluatedAt: raw.evaluatedAt } : {}),
  };
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function reportFromBody(body: Record<string, unknown>, runId?: string): RunReport {
  return {
    runId: str(body.runId) ?? runId ?? null,
    jobId: str(body.jobId),
    url: str(body.url),
    name: str(body.name),
    totalRows: num(body.totalRows),
    erroredRows: num(body.erroredRows),
    indeterminateRows: num(body.indeterminateRows),
    passRate: num(body.passRate),
    averageScore: num(body.averageScore),
    overallScores: body.overallScores && typeof body.overallScores === "object" ? (body.overallScores as Record<string, number | null>) : null,
    gate: asGate(body.gateResult),
  };
}

export function reportJson(report: RunReport): Record<string, unknown> {
  return { ...report, verdict: verdict(gatePassed(report.gate)) };
}

function fmt(value: unknown, digits = 3): string {
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return "—";
}

function percent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function renderGateTable(gate: GateResult | null): string[] {
  if (!gate) return ["gate: none (no gate was set on this run)"];
  const rows: string[][] = [["check", "threshold", "actual", "result"]];
  for (const check of gate.checks) {
    rows.push([String(check.name ?? "?"), fmt(check.threshold), fmt(check.actual), verdict(typeof check.passed === "boolean" ? check.passed : null)]);
  }
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((row) => row[i].length)));
  const lines = ["gate:", ...rows.map((row) => `  ${row.map((cell, i) => cell.padEnd(widths[i])).join("  ")}`.trimEnd())];
  if (!gate.checks.length) lines.push("  (no checks)");
  return lines;
}

export function renderReport(report: RunReport, code: number): string[] {
  const lines = [
    `run:           ${report.url ?? report.runId ?? "—"}`,
    `job:           ${report.jobId ?? "—"}`,
    `rows:          ${fmt(report.totalRows)} (errored ${fmt(report.erroredRows)}, undecided ${fmt(report.indeterminateRows)})`,
    `pass rate:     ${percent(report.passRate)}`,
    `average score: ${fmt(report.averageScore)}`,
  ];
  for (const [metric, score] of Object.entries(report.overallScores ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${metric}: ${fmt(score)}`);
  }
  lines.push(...renderGateTable(report.gate));
  lines.push(`verdict: ${verdict(gatePassed(report.gate))} (exit ${code})`);
  return lines;
}

export function normaliseSpec(raw: Record<string, unknown>): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!SPEC_KEYS.has(key)) throw new EvalCliError(`unknown Eval field '${key}'; known: ${[...SPEC_KEYS].join(", ")}`);
    spec[key] = value;
  }
  return spec;
}

export function readRows(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) throw new EvalCliError(`${path}: data file not found`);
  const text = readFileSync(path, "utf8");
  let rows: unknown;
  if (extname(path) === ".jsonl") {
    rows = text.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
  } else {
    rows = JSON.parse(text);
    if (rows && typeof rows === "object" && Array.isArray((rows as Record<string, unknown>).rows)) rows = (rows as Record<string, unknown>).rows;
  }
  if (!Array.isArray(rows) || !rows.every((row) => row && typeof row === "object")) {
    throw new EvalCliError(`${path}: expected a JSON array of row objects (or JSONL)`);
  }
  return rows as Array<Record<string, unknown>>;
}

export function loadJsonSpec(path: string): Record<string, unknown> {
  if (!existsSync(path)) throw new EvalCliError(`${path}: config file not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new EvalCliError(`${path}: not valid JSON (${(error as Error).message})`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new EvalCliError(`${path}: expected a JSON object`);
  const { dataFile, ...rest } = raw as Record<string, unknown>;
  if (dataFile !== undefined) {
    if ("data" in rest) throw new EvalCliError(`${path}: give either data or dataFile, not both`);
    rest.data = readRows(resolve(dirname(path), String(dataFile)));
  }
  return normaliseSpec(rest);
}

export async function loadModuleSpec(path: string, exportName?: string): Promise<unknown> {
  if (!existsSync(path)) throw new EvalCliError(`${path}: file not found`);
  const loaded = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  const name = exportName ?? "default";
  if (!(name in loaded)) throw new EvalCliError(`${path} has no export '${name}'`);
  return loaded[name];
}

export async function loadTarget(target: string, cwd: string, exportName?: string): Promise<unknown> {
  const path = isAbsolute(target) ? target : resolve(cwd, target);
  return extname(path) === ".json" ? loadJsonSpec(path) : loadModuleSpec(path, exportName);
}

function isResult(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && "gateResult" in (value as object) && "passRate" in (value as object) && "jobId" in (value as object);
}

export async function resolveSpec(loaded: unknown): Promise<{ spec: Record<string, unknown> | null; result: Record<string, unknown> | null }> {
  const value = typeof loaded === "function" ? await (loaded as () => unknown)() : loaded;
  if (isResult(value)) return { spec: null, result: value };
  if (value && typeof value === "object" && !Array.isArray(value)) return { spec: normaliseSpec(value as Record<string, unknown>), result: null };
  throw new EvalCliError("the target must export Eval() options, a function returning them, or a finished EvalResult");
}

export function resolveKey(explicit: string | undefined, store: ConfigStore): string {
  return explicit ?? process.env.EVALKIT_API_KEY ?? process.env.EVALKIT_SUBSCRIPTION_KEY ?? store.load().key;
}

export function resolveApiUrl(explicit: string | undefined, store: ConfigStore): string {
  return (explicit ?? process.env.EVALKIT_API_URL ?? readBase(store.load().endpoint)).replace(/\/$/, "");
}

function loadSdk(io: EvalCliIo): Promise<SdkModule> {
  return io.sdk ? io.sdk() : (import(SDK_PACKAGE) as Promise<SdkModule>);
}

function finish(report: RunReport, flags: EvalFlags, io: EvalCliIo): number {
  const code = exitCode(gatePassed(report.gate), flags.allowUndecided);
  if (flags.json) io.out(JSON.stringify(reportJson(report), null, 2));
  else for (const line of renderReport(report, code)) io.out(line);
  return code;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runEval(target: string, flags: EvalFlags, io: EvalCliIo): Promise<number> {
  const store = new ConfigStore(io.home);
  const quietBefore = process.env.EVALKIT_QUIET;
  if (flags.json) process.env.EVALKIT_QUIET = "1";
  try {
    const { spec, result } = await resolveSpec(await loadTarget(target, io.cwd ?? process.cwd(), flags.exportName));
    let finished = result;
    if (!finished && spec) {
      const key = resolveKey(flags.key, store);
      if (!key) throw new EvalCliError("a subscription key is required: pass --key, set EVALKIT_API_KEY, or run `evalkit coding install`");
      const apiUrl = resolveApiUrl(flags.apiUrl, store);
      const sdk = await loadSdk(io);
      sdk.init({ subscriptionKey: key, apiUrl, baseUrl: apiUrl, serviceName: "evalkit-cli" });
      finished = await sdk.Eval({ ...spec, apiUrl });
      await sdk.flush();
    }
    return finish(reportFromBody(finished as Record<string, unknown>), flags, io);
  } catch (error) {
    io.err(`evalkit eval: ${error instanceof EvalCliError ? describe(error) : `the run failed (${describe(error)})`}`);
    return EXIT_ERROR;
  } finally {
    if (flags.json) {
      if (quietBefore === undefined) delete process.env.EVALKIT_QUIET;
      else process.env.EVALKIT_QUIET = quietBefore;
    }
  }
}

export async function gateEval(runId: string, flags: EvalFlags, io: EvalCliIo): Promise<number> {
  const store = new ConfigStore(io.home);
  const key = resolveKey(flags.key, store);
  if (!key) {
    io.err("evalkit eval: a subscription key is required: pass --key, set EVALKIT_API_KEY, or run `evalkit coding install`");
    return EXIT_ERROR;
  }
  const url = `${resolveApiUrl(flags.apiUrl, store)}/evaluation-runs/${encodeURIComponent(runId)}`;
  let body: unknown;
  try {
    const res = await fetch(url, { headers: { "X-Subscription-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    if (!res.ok) {
      const hint = res.status === 404 ? " (no such run, or this server has no GET /evaluation-runs/:runId yet)" : "";
      io.err(`evalkit eval: could not read run ${runId} (HTTP ${res.status}: ${messageOf(text)})${hint}`);
      return EXIT_ERROR;
    }
    body = JSON.parse(text || "{}");
  } catch (error) {
    io.err(`evalkit eval: could not read run ${runId} (${describe(error)})`);
    return EXIT_ERROR;
  }
  if (!body || typeof body !== "object") {
    io.err(`evalkit eval: run ${runId} answered with no JSON object`);
    return EXIT_ERROR;
  }
  return finish(reportFromBody(body as Record<string, unknown>, runId), flags, io);
}

function messageOf(text: string): string {
  let parsed: { message?: unknown } | null = null;
  try {
    parsed = JSON.parse(text) as { message?: unknown };
  } catch {
    parsed = null;
  }
  const message = Array.isArray(parsed?.message) ? parsed?.message.join("; ") : parsed?.message;
  return message ? String(message) : text.slice(0, 300);
}
