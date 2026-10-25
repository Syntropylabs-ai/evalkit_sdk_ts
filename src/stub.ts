// The SDK for runtimes without Node's APIs (the Vercel Edge runtime, Cloudflare Workers, browsers), chosen
// there by the package's `edge-light`, `workerd` and `browser` export conditions. It has the Node entry's
// API surface and traces nothing: importing it never fails, every wrapper calls straight through, every
// middleware hands on, and flushing resolves false. Only the pure helpers (offline evaluate, prompt
// templates, secret scrubbing) work as they do in Node; calls that would reach the EvalKit API reject.

import { ProxyTracerProvider, context as otelContext } from "@opentelemetry/api";
import type { Context as OtelContext, Tracer, TracerProvider } from "@opentelemetry/api";
import { emptyStats } from "./core/diagnostics.js";
import type { EvalKitStats } from "./core/diagnostics.js";
import { evaluate } from "./evaluate.js";
import { EvalResult } from "./eval.js";
import { Prompt, withPrompt, currentPrompt, compileTemplate, variablesOf } from "./prompts.js";
import { scrubSecrets, isSecretKey } from "./core/secrets.js";
import type { EvalKitOptions } from "./core/types.js";

export { evaluate, EvalResult, Prompt, withPrompt, currentPrompt, compileTemplate, variablesOf, scrubSecrets, isSecretKey };

const INVALID_TRACE_ID = "00000000000000000000000000000000";

const provider: TracerProvider = new ProxyTracerProvider();
const tracer: Tracer = provider.getTracer("evalkit");

function unavailable(what: string): Promise<never> {
  return Promise.reject(
    new Error(`[evalkit] ${what} is not available in this runtime; call it from Node.js (process.env.NEXT_RUNTIME === "nodejs")`),
  );
}

const noopEnd = (): void => {};

function traceHandle(): { traceId: string; end: (...args: unknown[]) => void; ctx: OtelContext } {
  return { traceId: INVALID_TRACE_ID, end: noopEnd, ctx: otelContext.active() };
}

export class EvalKitClient {
  readonly options: Record<string, unknown>;
  readonly provider: TracerProvider = provider;
  readonly tracingMode = "disabled" as const;
  readonly tracer: Tracer = tracer;
  readonly disabledReason = "this runtime has no Node.js APIs";
  readonly enabled = false;

  constructor(opts?: EvalKitOptions) {
    this.options = { ...(opts ?? {}) };
  }

  getStats(): EvalKitStats {
    return emptyStats("disabled");
  }

  startTrace(): { traceId: string; end: (...args: unknown[]) => void; ctx: OtelContext } {
    return traceHandle();
  }

  startHttpTrace(): { traceId: string; end: (...args: unknown[]) => void; ctx: OtelContext } {
    return traceHandle();
  }

  startSpan(): { end: (...args: unknown[]) => void; ctx: OtelContext } {
    return { end: noopEnd, ctx: otelContext.active() };
  }

  traceFunction<T extends (...args: any[]) => any>(_name: string, fn: T): T {
    return fn;
  }

  traceTool<T extends (...args: any[]) => any>(_name: string, fn: T): T {
    return fn;
  }

  flush(): Promise<boolean> {
    return Promise.resolve(false);
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }
}

export class EvalKitInterceptor {
  constructor(_client?: unknown) {}

  intercept(_executionContext: unknown, next: { handle(): unknown }): unknown {
    return next.handle();
  }
}

let instance: EvalKitClient | undefined;

export function init(opts: EvalKitOptions): EvalKitClient {
  instance = new EvalKitClient(opts);
  return instance;
}

export function getStats(): EvalKitStats {
  return emptyStats("disabled");
}

export function captureException(_error: unknown, _options?: { escaped?: boolean; fingerprint?: string }): void {}

export function setErrorFingerprint<T>(error: T, _fingerprint: string): T {
  return error;
}

const noop = (..._args: unknown[]): void => {};
const same = <T>(value: T): T => value;

export const patchOpenAIClient = noop;
export const patchAnthropicClient = noop;
export const patchBedrockClient = noop;
export const patchBedrockAgentRuntimeClient = noop;
export const patchAnthropicVertexClient = noop;
export const patchVertexGenerativeModel = noop;
export const patchCohereClient = noop;
export const patchGoogleAIModel = noop;
export const patchGoogleGenAIModels = noop;
export const patchMongooseClient = noop;
export const patchRedisClient = noop;
export const patchAxiosClient = noop;
export const patchPgClient = noop;
export const patchMysql2Client = noop;
export const patchMCPClient = noop;
export const patchOllamaClient = noop;
export const patchPineconeClient = noop;
export const patchQdrantClient = noop;
export const patchChromaClient = noop;
export const patchWeaviateClient = noop;
export const patchLlamaIndexClient = noop;
export const patchOpenAIAudioClient = noop;
export const patchAssemblyAIClient = noop;
export const patchOpenAIRealtimeClass = noop;

export function patchWeaviateClientInstance<T = any>(weaviateClient: T): T {
  return weaviateClient;
}

export function patchElevenLabsClientInstance<T = any>(elevenLabsClient: T): T {
  return elevenLabsClient;
}

export function instrumentPrisma<T = any>(prisma: T, _opts?: { system?: string }): T {
  return prisma;
}

export function langchainHandler(): Promise<any | null> {
  return Promise.resolve(null);
}

export async function traceLive(ai: any, params: any, _opts?: unknown): Promise<any> {
  return ai.live.connect(params);
}

export function traceOpenAIRealtime(rt: any, _opts?: unknown): any {
  return rt;
}

export function expressMiddleware(_options?: unknown): (req: any, res: any, next: any) => void {
  return (_req, _res, next) => next();
}

export function expressErrorHandler(): (err: any, req: any, res: any, next: any) => void {
  return function evalkitErrorHandler(err: any, _req: any, _res: any, next: any): void {
    next(err);
  };
}

export function fastifyPlugin(_options?: unknown): (fastify: any, opts: any, done: () => void) => void {
  const plugin = (_fastify: any, _opts: any, done: () => void): void => done();
  (plugin as any)[Symbol.for("skip-override")] = true;
  return plugin;
}

export function koaMiddleware(_options?: unknown): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return (_ctx, next) => next();
}

export function honoMiddleware(_options?: unknown): (c: any, next: () => Promise<void>) => Promise<void> {
  return (_c, next) => next();
}

export function hapiPlugin(_options?: unknown): { name: string; register: (server: any) => void } {
  return { name: "@evalkit/hapi", register: noop };
}

export function createNestjsInterceptor(): EvalKitInterceptor {
  return new EvalKitInterceptor(instance);
}

export function startTrace(_name?: string, _attributes?: unknown): { traceId: string; end: (...args: unknown[]) => void; ctx: OtelContext } {
  return traceHandle();
}

export function startHttpTrace(_name?: string, _httpCtx?: unknown, _attributes?: unknown): { traceId: string; end: (...args: unknown[]) => void; ctx: OtelContext } {
  return traceHandle();
}

export function startSpan(_name?: string, _attributes?: unknown, parentCtx?: OtelContext): { end: (...args: unknown[]) => void; ctx: OtelContext } {
  return { end: noopEnd, ctx: parentCtx ?? otelContext.active() };
}

export const setUser = noop;

export function currentUser(): Record<string, string> {
  return {};
}

export const setAgent = noop;

export function currentAgent(): string | undefined {
  return undefined;
}

export function withSession<T>(_session: unknown, fn: () => T): T {
  return fn();
}

export function flush(_timeoutMs?: number): Promise<boolean> {
  return Promise.resolve(false);
}

export function flushAfter(schedule?: (task: Promise<unknown>) => void, _timeoutMs?: number): Promise<boolean> {
  const task = Promise.resolve(false);
  try {
    schedule?.(task);
  } catch {
    // Nothing to flush either way.
  }
  return task;
}

export const withLambda = <H>(handler: H, _options?: unknown): H => handler;

export function traceFunction<T extends (...args: any[]) => any>(_name: string, fn: T): T {
  return fn;
}

export function traceTool<T extends (...args: any[]) => any>(_name: string, fn: T): T {
  return fn;
}

export function TraceMethod(_name?: string): MethodDecorator {
  return (_target, _key, descriptor) => descriptor;
}

export function Traced(_options?: { prefix?: string }): ClassDecorator {
  return (target) => target;
}

export const traceObject = <T>(obj: T, _options?: unknown): T => same(obj);

export function enableNestjsAutoTrace(_appOrDiscovery?: unknown, _options?: unknown): Promise<number> {
  return Promise.resolve(0);
}

export function withTrace<T>(ctx: OtelContext, fn: () => Promise<T>): Promise<T> {
  return otelContext.with(ctx, fn);
}

// Nothing is traced here, so a scope kept out of traces is the function itself.
export function untraced<T extends (...args: any[]) => any>(fn: T): T {
  return fn;
}

export function withoutTracing<T>(fn: () => T): T {
  return fn();
}

export function currentTraceId(): string | undefined {
  return undefined;
}

export function generateScenarios(_opts?: unknown): Promise<any[]> {
  return unavailable("generateScenarios()");
}

export function simulateUser(_opts?: unknown): Promise<{ simulationId: string; runId: string; results: any[] }> {
  return unavailable("simulateUser()");
}

export function evaluateSimulation(_opts?: unknown): Promise<any> {
  return unavailable("evaluateSimulation()");
}

export function feedback(_opts?: unknown): Promise<{ recorded?: boolean; [key: string]: unknown }> {
  return Promise.resolve({ recorded: false });
}

export function reward(_traceId?: string, _value?: number, _opts?: unknown): Promise<{ recorded?: boolean; [key: string]: unknown }> {
  return Promise.resolve({ recorded: false });
}

export function Eval(_opts?: unknown): Promise<EvalResult> {
  return unavailable("Eval()");
}

export const prompts = {
  get(name: string, _opts?: unknown): Promise<Prompt> {
    return unavailable(`prompts.get(${JSON.stringify(name)})`);
  },
  clearCache: noop,
  withPrompt,
  current: currentPrompt,
};

export default {
  init,
  evaluate,
  Eval,
  feedback,
  reward,
  prompts,
  Prompt,
  withPrompt,
  generateScenarios,
  simulateUser,
  evaluateSimulation,

  patchOpenAIClient,
  patchAnthropicClient,
  patchBedrockClient,
  patchBedrockAgentRuntimeClient,
  patchAnthropicVertexClient,
  patchVertexGenerativeModel,
  patchCohereClient,
  patchGoogleAIModel,
  patchGoogleGenAIModels,
  langchainHandler,
  patchMongooseClient,
  patchRedisClient,
  patchAxiosClient,
  patchPgClient,
  patchMysql2Client,
  patchMCPClient,
  patchOllamaClient,
  patchPineconeClient,
  patchQdrantClient,
  patchChromaClient,
  patchWeaviateClient,
  patchWeaviateClientInstance,
  patchLlamaIndexClient,
  patchOpenAIAudioClient,
  patchElevenLabsClientInstance,
  patchAssemblyAIClient,
  instrumentPrisma,
  traceLive,
  traceOpenAIRealtime,
  patchOpenAIRealtimeClass,

  expressMiddleware,
  expressErrorHandler,
  fastifyPlugin,
  koaMiddleware,
  honoMiddleware,
  hapiPlugin,
  createNestjsInterceptor,

  startTrace,
  startHttpTrace,
  startSpan,
  setUser,
  currentUser,
  setAgent,
  currentAgent,
  withSession,
  traceFunction,
  traceTool,
  traceObject,
  TraceMethod,
  Traced,
  enableNestjsAutoTrace,
  withTrace,
  untraced,
  withoutTracing,
  currentTraceId,
  flush,
  flushAfter,
  withLambda,
  getStats,
  captureException,
  setErrorFingerprint,
};
