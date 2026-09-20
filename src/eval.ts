import type { EvalKitClient } from "./core/client.js";

const RULE_ID = /^[0-9a-fA-F]{24}$/;
const COUNT_KEYS = ["ok", "unparseable", "judgeError", "skipped", "unsupported"] as const;

export const MAX_ROWS_PER_BATCH = 200;

const RETRY_DELAYS_MS = [250, 750];

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export interface LocalScoreDetail {
  name?: string;
  score?: number | boolean;
  passed?: boolean;
  reason?: string;
}

export type LocalScoreValue = number | boolean | null | undefined | LocalScoreDetail;

export type LocalEvaluator = (row: Record<string, unknown>, output: string) => LocalScoreValue;

export interface LocalScore {
  name: string;
  score: number;
  passed?: boolean;
  reason?: string;
}

export interface EvalRow {
  input: unknown;
  output?: string;
  target?: unknown;
  expected?: unknown;
  context?: unknown[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EvalGate {
  minPassRate?: number;
  minAverageScore?: number;
  perMetricMinScore?: Record<string, number>;
  maxRegressionsVsBaseline?: number;
}

export interface EvalOptions {
  name: string;
  data: Iterable<EvalRow>;
  task?: (row: EvalRow) => string;
  evaluators: Array<string | LocalEvaluator>;
  judgeModel?: string;
  judgeModelConfigId?: string;
  baselineJobId?: string;
  gate?: EvalGate;
  hyperparameters?: Record<string, string | number | boolean>;
  autoBaseline?: boolean;
  batchSize?: number;
  timeoutMs?: number;
  apiUrl?: string;
}

export interface EvalRowResult {
  rowIndex?: number;
  input?: unknown;
  output?: string;
  target?: unknown;
  metrics?: Array<{ metricName?: string; score?: number | null; status?: string; [key: string]: unknown }>;
  localScores?: LocalScore[];
  overallScore?: number | null;
  passed?: boolean | null;
  status?: string;
  error?: string;
  counts?: Partial<Record<(typeof COUNT_KEYS)[number], number>>;
  [key: string]: unknown;
}

export interface EvalSummary {
  jobId: string | null;
  jobIds: Array<string | null>;
  name: string;
  datasetHash: string | null;
  totalRows: number;
  averageScore: number | null;
  passRate: number | null;
  counts: Record<string, number> | null;
  indeterminateRows: number | null;
  erroredRows: number | null;
  scoringVersion: number | null;
  overallScores: Record<string, number | null> | null;
  gateResult: Record<string, unknown> | null;
  results: EvalRowResult[];
  comparison: Record<string, unknown> | null;
  hyperparameters: Record<string, unknown> | null;
  localScores: Record<string, Array<number | null>>;
  runId: string | null;
  url: string | null;
}

export class EvalResult implements EvalSummary {
  readonly jobId: string | null;
  readonly jobIds: Array<string | null>;
  readonly name: string;
  readonly datasetHash: string | null;
  readonly totalRows: number;
  readonly averageScore: number | null;
  readonly passRate: number | null;
  readonly counts: Record<string, number> | null;
  readonly indeterminateRows: number | null;
  readonly erroredRows: number | null;
  readonly scoringVersion: number | null;
  readonly overallScores: Record<string, number | null> | null;
  readonly gateResult: Record<string, unknown> | null;
  readonly results: EvalRowResult[];
  readonly comparison: Record<string, unknown> | null;
  readonly hyperparameters: Record<string, unknown> | null;
  readonly localScores: Record<string, Array<number | null>>;
  readonly runId: string | null;
  readonly url: string | null;

  constructor(summary: EvalSummary) {
    this.jobId = summary.jobId;
    this.jobIds = summary.jobIds;
    this.name = summary.name;
    this.datasetHash = summary.datasetHash;
    this.totalRows = summary.totalRows;
    this.averageScore = summary.averageScore;
    this.passRate = summary.passRate;
    this.counts = summary.counts;
    this.indeterminateRows = summary.indeterminateRows;
    this.erroredRows = summary.erroredRows;
    this.scoringVersion = summary.scoringVersion;
    this.overallScores = summary.overallScores;
    this.gateResult = summary.gateResult;
    this.results = summary.results;
    this.comparison = summary.comparison;
    this.hyperparameters = summary.hyperparameters;
    this.localScores = summary.localScores;
    this.runId = summary.runId;
    this.url = summary.url;
  }

  get passed(): boolean | null {
    const value = this.gateResult?.passed;
    return typeof value === "boolean" ? value : null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isErrored(row: EvalRowResult): boolean {
  return Boolean(row.error) || row.status === "error";
}

function aggregate(rows: EvalRowResult[]) {
  const counts: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  let scoreSum = 0;
  let scored = 0, passed = 0, failed = 0, indeterminate = 0, errored = 0;
  for (const row of rows) {
    for (const key of COUNT_KEYS) counts[key] += row.counts?.[key] ?? 0;
    if (isErrored(row)) {
      errored += 1;
      continue;
    }
    if (isFiniteNumber(row.overallScore)) {
      scoreSum += row.overallScore;
      scored += 1;
    }
    if (row.passed === true) passed += 1;
    else if (row.passed === false) failed += 1;
    else indeterminate += 1;
  }
  const decided = passed + failed;
  return {
    averageScore: scored ? scoreSum / scored : null,
    passRate: decided ? passed / decided : null,
    counts,
    indeterminateRows: indeterminate,
    erroredRows: errored,
  };
}

function perMetricAverages(rows: EvalRowResult[]): Record<string, number | null> {
  const tallies = new Map<string, number[]>();
  for (const row of rows) {
    if (isErrored(row)) continue;
    for (const metric of row.metrics ?? []) {
      if (!metric.metricName) continue;
      const bucket = tallies.get(metric.metricName) ?? [];
      if (isFiniteNumber(metric.score) && (metric.status === undefined || metric.status === "ok")) bucket.push(metric.score);
      tallies.set(metric.metricName, bucket);
    }
  }
  return Object.fromEntries([...tallies].map(([name, values]) => [name, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null]));
}

function splitEvaluators(evaluators: Array<string | LocalEvaluator>): { ruleIds: string[]; local: Array<[string, LocalEvaluator]> } {
  const ruleIds: string[] = [];
  const local: Array<[string, LocalEvaluator]> = [];
  const labels = new Set<string>();
  evaluators.forEach((entry, index) => {
    if (typeof entry === "string" && RULE_ID.test(entry)) {
      ruleIds.push(entry);
      return;
    }
    if (typeof entry === "function") {
      let label = entry.name || `evaluator_${index}`;
      if (labels.has(label)) label = `${label}_${index}`;
      labels.add(label);
      local.push([label, entry]);
      return;
    }
    throw new Error(`evaluators[${index}] is neither a server rule id (24 hex chars) nor a function`);
  });
  if (!ruleIds.length) throw new Error("evaluators must include at least one server rule id");
  return { ruleIds, local };
}

function buildRows(data: Iterable<EvalRow>, task?: (row: EvalRow) => string): { source: EvalRow[]; outputs: string[] } {
  const source: EvalRow[] = [];
  const outputs: string[] = [];
  let index = 0;
  for (const row of data) {
    if (row.input === undefined || row.input === null) throw new Error(`data[${index}] has no 'input'`);
    const output = task ? task(row) : row.output;
    if (output === undefined || output === null) throw new Error(`data[${index}] has no 'output' and no task was given`);
    source.push(row);
    outputs.push(output);
    index += 1;
  }
  if (!source.length) throw new Error("data is empty");
  return { source, outputs };
}

function localEntry(label: string, value: LocalScoreValue): LocalScore | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return { name: label, score: value ? 1 : 0, passed: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`local evaluator '${label}' returned ${value}; expected a finite number`);
    return { name: label, score: value };
  }
  if (typeof value === "object") {
    const detail = value as LocalScoreDetail;
    let score: number | undefined;
    if (typeof detail.score === "boolean") score = detail.score ? 1 : 0;
    else if (isFiniteNumber(detail.score)) score = detail.score;
    else if (typeof detail.passed === "boolean") score = detail.passed ? 1 : 0;
    if (score === undefined) {
      throw new Error(`local evaluator '${label}' returned an object without a numeric 'score' or a boolean 'passed'`);
    }
    const entry: LocalScore = { name: detail.name || label, score };
    if (typeof detail.passed === "boolean") entry.passed = detail.passed;
    if (detail.reason !== undefined && detail.reason !== null) entry.reason = String(detail.reason);
    return entry;
  }
  throw new Error(`local evaluator '${label}' returned ${String(value)}; expected a number, a boolean, null or an object`);
}

function runLocal(
  local: Array<[string, LocalEvaluator]>,
  source: EvalRow[],
  outputs: string[],
): { localScores: Record<string, Array<number | null>>; localEntries: LocalScore[][] } {
  const localScores: Record<string, Array<number | null>> = Object.fromEntries(local.map(([label]) => [label, []]));
  const localEntries: LocalScore[][] = [];
  source.forEach((row, index) => {
    const entries: LocalScore[] = [];
    for (const [label, fn] of local) {
      const entry = localEntry(label, fn(row, outputs[index]));
      localScores[label].push(entry === null ? null : entry.score);
      if (entry !== null) entries.push(entry);
    }
    localEntries.push(entries);
  });
  return { localScores, localEntries };
}

function rowMetadata(row: EvalRow): Record<string, unknown> {
  const metadata: Record<string, unknown> =
    row.metadata && typeof row.metadata === "object" ? { ...row.metadata } : {};
  if (row.context !== undefined && row.context !== null) metadata.context = [...row.context];
  return metadata;
}

class RunSpec {
  constructor(private readonly opts: EvalOptions, readonly ruleIds: string[]) {}

  get name(): string {
    return this.opts.name;
  }

  get gate(): EvalGate | undefined {
    return this.opts.gate;
  }

  private judgeAndHyperparameters(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (this.opts.judgeModelConfigId !== undefined) body.judgeModelConfigId = this.opts.judgeModelConfigId;
    if (this.opts.judgeModel !== undefined) body.judgeModelName = this.opts.judgeModel;
    if (this.opts.hyperparameters !== undefined) body.hyperparameters = { ...this.opts.hyperparameters };
    return body;
  }

  createBody(): Record<string, unknown> {
    const body: Record<string, unknown> = { name: this.opts.name, ruleIds: [...this.ruleIds] };
    Object.assign(body, this.judgeAndHyperparameters());
    if (this.opts.baselineJobId !== undefined) body.baselineJobId = this.opts.baselineJobId;
    if (this.opts.autoBaseline !== undefined) body.autoBaseline = this.opts.autoBaseline;
    return body;
  }

  completeBody(): Record<string, unknown> {
    return this.opts.gate !== undefined ? { gate: { ...this.opts.gate } } : {};
  }

  legacyBody(rows: Array<Record<string, unknown>>, single: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = { name: this.opts.name, ruleIds: [...this.ruleIds], rows };
    Object.assign(body, this.judgeAndHyperparameters());
    if (single && this.opts.baselineJobId !== undefined) body.baselineJobId = this.opts.baselineJobId;
    if (single && this.opts.gate !== undefined) body.gate = { ...this.opts.gate };
    if (single && this.opts.autoBaseline !== undefined) body.autoBaseline = this.opts.autoBaseline;
    return body;
  }
}

class RunRows {
  constructor(
    private readonly source: EvalRow[],
    private readonly outputs: string[],
    readonly localScores: Record<string, Array<number | null>>,
    private readonly localEntries: LocalScore[][],
    private readonly batchSize: number,
  ) {}

  get length(): number {
    return this.outputs.length;
  }

  batches(): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (let start = 0; start < this.outputs.length; start += this.batchSize) {
      spans.push([start, Math.min(start + this.batchSize, this.outputs.length)]);
    }
    return spans;
  }

  appendPayload(start: number, stop: number): Array<Record<string, unknown>> {
    const payload: Array<Record<string, unknown>> = [];
    for (let index = start; index < stop; index += 1) {
      const row = this.source[index];
      const item: Record<string, unknown> = { rowIndex: index, input: row.input, output: this.outputs[index] };
      const expected = row.expected ?? row.target;
      if (expected !== undefined && expected !== null) item.expected = expected;
      const metadata = rowMetadata(row);
      if (Object.keys(metadata).length) item.metadata = metadata;
      if (this.localEntries[index].length) item.localScores = this.localEntries[index];
      payload.push(item);
    }
    return payload;
  }

  legacyPayload(start: number, stop: number): Array<Record<string, unknown>> {
    const payload: Array<Record<string, unknown>> = [];
    for (let index = start; index < stop; index += 1) {
      const row = this.source[index];
      const item: Record<string, unknown> = { input: row.input, output: this.outputs[index] };
      const target = row.target ?? row.expected;
      if (target !== undefined && target !== null) item.target = target;
      if (row.context !== undefined && row.context !== null) item.context = [...row.context];
      payload.push(item);
    }
    return payload;
  }
}

interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, any>;
  text: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RunApi {
  constructor(
    private readonly client: EvalKitClient,
    private readonly base: string,
    private readonly timeoutMs: number,
  ) {}

  async post(path: string, body: Record<string, unknown>): Promise<PostResult> {
    const res = await fetch(this.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Subscription-Key": this.client.options.subscriptionKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, status: res.status, body: {}, text };
    }
    const parsed = (await res.json().catch(() => ({}))) as Record<string, any>;
    return { ok: true, status: res.status, body: parsed ?? {}, text: "" };
  }

  async postWithRetry(path: string, body: Record<string, unknown>): Promise<PostResult> {
    let last: PostResult | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      last = await this.post(path, body);
      if (last.ok || last.status < 500) return last;
      if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
    }
    return last as PostResult;
  }
}

function failure(result: PostResult): Error {
  return new Error(`Eval failed ${result.status}: ${result.text}`);
}

function isQuiet(): boolean {
  const raw = typeof process !== "undefined" ? process.env.EVALKIT_QUIET : undefined;
  return TRUTHY.has(String(raw ?? "").trim().toLowerCase());
}

function announce(url: string): void {
  if (isQuiet()) return;
  const line = `[evalkit] evaluation run: ${url}`;
  if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function") {
    process.stdout.write(`${line}\n`);
    return;
  }
  console.log(line);
}

const rowsEndpointSupport = new WeakMap<EvalKitClient, boolean>();

function summaryResult(spec: RunSpec, rows: RunRows, runId: string, url: string | null, summary: Record<string, any>): EvalResult {
  const jobId = (summary.jobId as string | undefined) ?? runId;
  return new EvalResult({
    jobId,
    jobIds: [jobId],
    name: (summary.name as string | undefined) ?? spec.name,
    datasetHash: summary.datasetHash ?? null,
    totalRows: typeof summary.totalRows === "number" ? summary.totalRows : rows.length,
    averageScore: summary.averageScore ?? null,
    passRate: summary.passRate ?? null,
    counts: summary.counts ?? null,
    indeterminateRows: summary.indeterminateRows ?? null,
    erroredRows: summary.erroredRows ?? null,
    scoringVersion: summary.scoringVersion ?? null,
    overallScores: summary.overallScores ?? null,
    gateResult: summary.gateResult ?? null,
    results: [...((summary.results as EvalRowResult[] | undefined) ?? [])],
    comparison: summary.comparison ?? null,
    hyperparameters: summary.hyperparameters ?? null,
    localScores: rows.localScores,
    runId,
    url,
  });
}

async function runAppended(
  api: RunApi,
  client: EvalKitClient,
  spec: RunSpec,
  rows: RunRows,
): Promise<EvalResult | null> {
  const created = await api.post("/evaluation-runs", spec.createBody());
  if (!created.ok) throw failure(created);
  const runId = created.body.runId as string | undefined;
  if (!runId) throw new Error("[evalkit] POST /evaluation-runs answered without a runId");
  const url = (created.body.url as string | undefined) ?? null;
  if (url) announce(url);

  for (const [start, stop] of rows.batches()) {
    const appended = await api.postWithRetry(`/evaluation-runs/${runId}/rows`, { rows: rows.appendPayload(start, stop) });
    if (appended.ok) continue;
    if (appended.status === 404) {
      rowsEndpointSupport.set(client, false);
      return null;
    }
    throw failure(appended);
  }
  rowsEndpointSupport.set(client, true);

  const completed = await api.post(`/evaluation-runs/${runId}/complete`, spec.completeBody());
  if (!completed.ok) throw failure(completed);
  return summaryResult(spec, rows, runId, url, completed.body);
}

function assemble(spec: RunSpec, rows: RunRows, sizes: number[], responses: Array<Record<string, any>>): EvalResult {
  const first = responses[0];
  const jobIds = responses.map((r) => r.jobId ?? null);
  if (responses.length === 1) {
    return new EvalResult({
      jobId: first.jobId ?? null,
      jobIds,
      name: first.name ?? spec.name,
      datasetHash: first.datasetHash ?? null,
      totalRows: first.totalRows ?? 0,
      averageScore: first.averageScore ?? null,
      passRate: first.passRate ?? null,
      counts: first.counts ?? null,
      indeterminateRows: first.indeterminateRows ?? null,
      erroredRows: first.erroredRows ?? null,
      scoringVersion: first.scoringVersion ?? null,
      overallScores: first.overallScores ?? null,
      gateResult: first.gateResult ?? null,
      results: [...(first.results ?? [])],
      comparison: first.comparison ?? null,
      hyperparameters: first.hyperparameters ?? null,
      localScores: rows.localScores,
      runId: null,
      url: null,
    });
  }
  const results: EvalRowResult[] = [];
  let offset = 0;
  sizes.forEach((size, i) => {
    for (const row of responses[i].results ?? []) {
      const copy = { ...row };
      if (typeof copy.rowIndex === "number") copy.rowIndex += offset;
      results.push(copy);
    }
    offset += size;
  });
  const rollup = aggregate(results);
  return new EvalResult({
    jobId: jobIds[0],
    jobIds,
    name: spec.name,
    datasetHash: null,
    totalRows: results.length,
    averageScore: rollup.averageScore,
    passRate: rollup.passRate,
    counts: rollup.counts,
    indeterminateRows: rollup.indeterminateRows,
    erroredRows: rollup.erroredRows,
    scoringVersion: first.scoringVersion ?? null,
    overallScores: perMetricAverages(results),
    gateResult: null,
    results,
    comparison: null,
    hyperparameters: first.hyperparameters ?? null,
    localScores: rows.localScores,
    runId: null,
    url: null,
  });
}

async function runLegacy(api: RunApi, spec: RunSpec, rows: RunRows): Promise<EvalResult> {
  const batches = rows.batches();
  const single = batches.length === 1;
  const sizes: number[] = [];
  const responses: Array<Record<string, any>> = [];
  for (const [start, stop] of batches) {
    const result = await api.post("/evaluation-runs", spec.legacyBody(rows.legacyPayload(start, stop), single));
    if (!result.ok) throw failure(result);
    sizes.push(stop - start);
    responses.push(result.body);
  }
  return assemble(spec, rows, sizes, responses);
}

export async function Eval(client: EvalKitClient, opts: EvalOptions): Promise<EvalResult> {
  if (typeof fetch === "undefined") throw new Error("[evalkit] global fetch is required (Node 18+)");
  const batchSize = opts.batchSize ?? MAX_ROWS_PER_BATCH;
  if (batchSize < 1) throw new Error("batchSize must be at least 1");

  const { ruleIds, local } = splitEvaluators(opts.evaluators);
  const { source, outputs } = buildRows(opts.data, opts.task);
  const { localScores, localEntries } = runLocal(local, source, outputs);

  const spec = new RunSpec(opts, ruleIds);
  const rows = new RunRows(source, outputs, localScores, localEntries, Math.min(batchSize, MAX_ROWS_PER_BATCH));

  const base = (opts.apiUrl ?? process.env.EVALKIT_API_URL ?? client.options.apiUrl).replace(/\/$/, "");
  const api = new RunApi(client, base, opts.timeoutMs ?? 600_000);

  if (rowsEndpointSupport.get(client) !== false) {
    const appended = await runAppended(api, client, spec, rows);
    if (appended) return appended;
  }
  return runLegacy(api, spec, rows);
}
