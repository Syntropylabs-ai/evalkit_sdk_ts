// ---------------------------------------------------------------------------
// Offline evaluation metrics — computed locally without LLM calls.
// Results are pushed as a span to the trace service for observability.
// ---------------------------------------------------------------------------

export type OfflineMetric =
  | 'tool_trajectory'       // order-aware LCS match of tool call sequences
  | 'tool_f1'               // precision+recall F1 on tool name sets
  | 'tool_correctness'      // recall: fraction of expected tools that were called
  | 'response_match'        // fraction of required terms found in output
  | 'constraint_compliance' // structural constraints (slide count, terms, citations)
  | 'contextual_precision'  // of retrieved context chunks, fraction that are relevant
  | 'contextual_recall';    // of expected context chunks, fraction that were retrieved

export interface OfflineEvalInput {
  /** The agent or model output to evaluate. Required. */
  output: string;
  /** The original user input / query (optional, used for context). */
  input?: string;
  /** Reference / expected output (optional, for response_match). */
  expectedOutput?: string;
  /** Actual tool calls made by the agent. */
  toolCalls?: Array<{ name: string; args?: Record<string, unknown> }>;
  /** Expected tool names in the expected call order. */
  expectedTools?: string[];
  /** Retrieved context chunks (for RAG precision/recall). */
  retrievedContext?: string[];
  /** Expected relevant context chunks (for RAG precision/recall). */
  expectedContext?: string[];
  /** Structural constraints to check in the output. */
  constraints?: {
    /** Expected number of slides/sections in the generated spec. */
    slideCount?: number;
    /** Terms that must appear in the output (case-insensitive). */
    requiredTerms?: string[];
    /** Whether the output must contain citations/references. */
    hasCitations?: boolean;
  };
  /** Which metrics to compute. Defaults to all applicable metrics. */
  metrics?: OfflineMetric[];
}

export interface OfflineEvalResult {
  /** Metric scores in the range [0.0, 1.0]. Only computed metrics are present. */
  scores: Partial<Record<OfflineMetric, number>>;
  /** Per-metric diagnostic details. */
  details: Partial<Record<OfflineMetric, Record<string, unknown>>>;
}

// ---------------------------------------------------------------------------
// Individual metric implementations
// ---------------------------------------------------------------------------

/**
 * tool_trajectory: order-aware match using Longest Common Subsequence.
 * Score = LCS(actual, expected) / len(expected)
 */
function scoreToolTrajectory(
  actualTools: string[],
  expectedTools: string[],
): { score: number; lcsLength: number } {
  if (expectedTools.length === 0) return { score: 1.0, lcsLength: 0 };

  const m = actualTools.length;
  const n = expectedTools.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (actualTools[i - 1] === expectedTools[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcsLength = dp[m][n];
  return { score: lcsLength / expectedTools.length, lcsLength };
}

/**
 * tool_f1: F1 score between actual and expected tool name sets.
 */
function scoreToolF1(
  actualTools: string[],
  expectedTools: string[],
): { score: number; precision: number; recall: number } {
  if (actualTools.length === 0 && expectedTools.length === 0) {
    return { score: 1.0, precision: 1.0, recall: 1.0 };
  }
  if (actualTools.length === 0 || expectedTools.length === 0) {
    return { score: 0.0, precision: 0.0, recall: 0.0 };
  }

  const actualSet = new Set(actualTools);
  const expectedSet = new Set(expectedTools);
  const intersection = new Set([...actualSet].filter(t => expectedSet.has(t)));

  const precision = intersection.size / actualSet.size;
  const recall = intersection.size / expectedSet.size;
  const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { score, precision, recall };
}

/**
 * tool_correctness: recall-only — what fraction of expected tools were called?
 */
function scoreToolCorrectness(
  actualTools: string[],
  expectedTools: string[],
): { score: number; called: number; total: number } {
  if (expectedTools.length === 0) return { score: 1.0, called: 0, total: 0 };

  const actualSet = new Set(actualTools);
  const called = expectedTools.filter(t => actualSet.has(t)).length;
  return { score: called / expectedTools.length, called, total: expectedTools.length };
}

/**
 * response_match: fraction of requiredTerms found in output (case-insensitive).
 */
function scoreResponseMatch(
  output: string,
  requiredTerms: string[],
): { score: number; matched: string[]; missing: string[] } {
  if (requiredTerms.length === 0) return { score: 1.0, matched: [], missing: [] };

  const lower = output.toLowerCase();
  const matched = requiredTerms.filter(t => lower.includes(t.toLowerCase()));
  const missing = requiredTerms.filter(t => !lower.includes(t.toLowerCase()));
  return { score: matched.length / requiredTerms.length, matched, missing };
}

/**
 * constraint_compliance: checks structural constraints.
 * Each applicable constraint contributes equally to the final score.
 */
function scoreConstraintCompliance(
  output: string,
  constraints: NonNullable<OfflineEvalInput['constraints']>,
): { score: number; checks: Record<string, boolean> } {
  const checks: Record<string, boolean> = {};
  const results: boolean[] = [];

  if (constraints.requiredTerms !== undefined && constraints.requiredTerms.length > 0) {
    const lower = output.toLowerCase();
    const allPresent = constraints.requiredTerms.every(t => lower.includes(t.toLowerCase()));
    checks['requiredTerms'] = allPresent;
    results.push(allPresent);
  }

  if (constraints.hasCitations !== undefined) {
    // Heuristic: look for common citation patterns
    const hasCite = /\[[\d]+\]|\(\w[^)]{1,80}\d{4}\)|\bhttps?:\/\//.test(output);
    checks['hasCitations'] = constraints.hasCitations ? hasCite : !hasCite;
    results.push(checks['hasCitations']);
  }

  if (constraints.slideCount !== undefined) {
    // Heuristic: count "Slide N" or numbered sections in the output
    const slidePattern = /slide\s+\d+|section\s+\d+|##\s+\d+\./gi;
    const count = (output.match(slidePattern) ?? []).length;
    const match = count === constraints.slideCount;
    checks['slideCount'] = match;
    results.push(match);
  }

  if (results.length === 0) return { score: 1.0, checks };
  const score = results.filter(Boolean).length / results.length;
  return { score, checks };
}

/**
 * contextual_precision: of retrieved chunks, what fraction are in expectedContext?
 */
function scoreContextualPrecision(
  retrieved: string[],
  expected: string[],
): { score: number; relevant: number; total: number } {
  if (retrieved.length === 0) return { score: 1.0, relevant: 0, total: 0 };
  const expectedSet = new Set(expected);
  const relevant = retrieved.filter(c => expectedSet.has(c)).length;
  return { score: relevant / retrieved.length, relevant, total: retrieved.length };
}

/**
 * contextual_recall: of expectedContext chunks, what fraction were retrieved?
 */
function scoreContextualRecall(
  retrieved: string[],
  expected: string[],
): { score: number; covered: number; total: number } {
  if (expected.length === 0) return { score: 1.0, covered: 0, total: 0 };
  const retrievedSet = new Set(retrieved);
  const covered = expected.filter(c => retrievedSet.has(c)).length;
  return { score: covered / expected.length, covered, total: expected.length };
}

// ---------------------------------------------------------------------------
// Public evaluate() function
// ---------------------------------------------------------------------------

/**
 * Compute offline evaluation metrics locally.
 *
 * Results are returned as numeric scores (0–1) and, if the EvalKit SDK has
 * been initialised via evalkit.init(), are also pushed as an `eval_result`
 * span to the trace service so they appear alongside trace data.
 *
 * @example
 * import { evaluate } from '@evalkit/sdk';
 *
 * const result = evaluate({
 *   output: 'The answer is AWS and Azure.',
 *   expectedTools: ['search_tool', 'render_tool'],
 *   toolCalls: [{ name: 'search_tool' }, { name: 'render_tool' }],
 *   constraints: { requiredTerms: ['AWS', 'Azure'] },
 * });
 * // result.scores.tool_f1 → 1.0
 * // result.scores.response_match → 1.0
 */
export function evaluate(input: OfflineEvalInput): OfflineEvalResult {
  const requestedMetrics = new Set<OfflineMetric>(
    input.metrics ?? [
      'tool_trajectory',
      'tool_f1',
      'tool_correctness',
      'response_match',
      'constraint_compliance',
      'contextual_precision',
      'contextual_recall',
    ],
  );

  const actualToolNames = (input.toolCalls ?? []).map(t => t.name);
  const expectedTools = input.expectedTools ?? [];

  const scores: Partial<Record<OfflineMetric, number>> = {};
  const details: Partial<Record<OfflineMetric, Record<string, unknown>>> = {};

  // tool_trajectory
  if (requestedMetrics.has('tool_trajectory') && expectedTools.length > 0) {
    const r = scoreToolTrajectory(actualToolNames, expectedTools);
    scores['tool_trajectory'] = r.score;
    details['tool_trajectory'] = { lcsLength: r.lcsLength, expectedCount: expectedTools.length };
  }

  // tool_f1
  if (requestedMetrics.has('tool_f1') && (actualToolNames.length > 0 || expectedTools.length > 0)) {
    const r = scoreToolF1(actualToolNames, expectedTools);
    scores['tool_f1'] = r.score;
    details['tool_f1'] = { precision: r.precision, recall: r.recall };
  }

  // tool_correctness
  if (requestedMetrics.has('tool_correctness') && expectedTools.length > 0) {
    const r = scoreToolCorrectness(actualToolNames, expectedTools);
    scores['tool_correctness'] = r.score;
    details['tool_correctness'] = { called: r.called, total: r.total };
  }

  // response_match
  const requiredTerms = input.constraints?.requiredTerms ?? [];
  if (requestedMetrics.has('response_match') && requiredTerms.length > 0) {
    const r = scoreResponseMatch(input.output, requiredTerms);
    scores['response_match'] = r.score;
    details['response_match'] = { matched: r.matched, missing: r.missing };
  }

  // constraint_compliance
  if (requestedMetrics.has('constraint_compliance') && input.constraints) {
    const r = scoreConstraintCompliance(input.output, input.constraints);
    scores['constraint_compliance'] = r.score;
    details['constraint_compliance'] = { checks: r.checks };
  }

  // contextual_precision
  if (
    requestedMetrics.has('contextual_precision') &&
    input.retrievedContext !== undefined &&
    input.expectedContext !== undefined
  ) {
    const r = scoreContextualPrecision(input.retrievedContext, input.expectedContext);
    scores['contextual_precision'] = r.score;
    details['contextual_precision'] = { relevant: r.relevant, total: r.total };
  }

  // contextual_recall
  if (
    requestedMetrics.has('contextual_recall') &&
    input.retrievedContext !== undefined &&
    input.expectedContext !== undefined
  ) {
    const r = scoreContextualRecall(input.retrievedContext, input.expectedContext);
    scores['contextual_recall'] = r.score;
    details['contextual_recall'] = { covered: r.covered, total: r.total };
  }

  const result: OfflineEvalResult = { scores, details };

  // Push scores as an eval_result span if the SDK is initialised.
  // Import lazily to avoid circular dependency — index.ts imports this file.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require('./index.js') as typeof import('./index.js');
    const spanAttrs: Record<string, string | number | boolean> = {
      'evalkit.span_type': 'eval_result',
      'evalkit.eval_type': 'offline',
    };
    for (const [metric, score] of Object.entries(scores)) {
      spanAttrs[`evalkit.metric.${metric}`] = score as number;
    }
    const { end } = sdk.startSpan('evaluation', spanAttrs);
    end('OK');
  } catch {
    // SDK not initialised — skip span push silently
  }

  return result;
}
