import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { evaluate as _evaluate } from "./evaluate.js";
import { generateScenarios as _generateScenarios, simulateUser as _simulateUser, evaluateSimulation as _evaluateSimulation } from "./simulate.js";
import { EvalKitClient } from "./core/client.js";
import { extractTraceparent as _extractTraceparentHelper } from "./core/context.js";
import { patchOpenAI } from "./instrumentation/llm/openai/index.js";
import { patchAnthropic } from "./instrumentation/llm/anthropic/index.js";
import { patchMongoose as _patchMongoose } from "./instrumentation/db/mongoose.js";
import { patchRedis as _patchRedis } from "./instrumentation/db/redis.js";
import { patchAxios as _patchAxios } from "./instrumentation/http/axios.js";
import { patchPg as _patchPg } from "./instrumentation/db/pg.js";
import { patchMysql2 as _patchMysql2 } from "./instrumentation/db/mysql2.js";
import { patchBedrock as _patchBedrock } from "./instrumentation/llm/bedrock/index.js";
import { patchCohere as _patchCohere } from "./instrumentation/llm/cohere/index.js";
import { patchGoogleAI as _patchGoogleAI } from "./instrumentation/llm/google-ai/index.js";
import { patchGoogleGenAI as _patchGoogleGenAI } from "./instrumentation/llm/google-genai/index.js";
import { langchainCallbackHandler as _langchainCallbackHandler } from "./instrumentation/llm/langchain/index.js";
import { patchAnthropicVertex as _patchAnthropicVertex, patchVertexGenerativeModel as _patchVertexGenerativeModel } from "./instrumentation/llm/vertex-ai/index.js";
import { createFastifyPlugin } from "./frameworks/fastify/plugin.js";
import { createExpressMiddleware } from "./frameworks/express/middleware.js";
import { createKoaMiddleware } from "./frameworks/koa/middleware.js";
import { createHonoMiddleware } from "./frameworks/hono/middleware.js";
import { createHapiPlugin } from "./frameworks/hapi/plugin.js";
import { EvalKitInterceptor } from "./frameworks/nestjs/interceptor.js";
import { autoTraceNest as _autoTraceNest } from "./frameworks/nestjs/autotrace.js";
import { patchMcp as _patchMcp } from "./instrumentation/mcp.js";
import { setupAutoInstrumentation } from "./instrumentation/auto.js";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitOptions } from "./core/types.js";

// Public type re-exports
export type { EvalKitOptions, TraceEnvelope, SpanEvent } from "./core/types.js";
export type { FastifyPluginOptions } from "./frameworks/fastify/plugin.js";
export type { ExpressMiddlewareOptions } from "./frameworks/express/middleware.js";
export type { KoaMiddlewareOptions } from "./frameworks/koa/middleware.js";
export type { HonoMiddlewareOptions } from "./frameworks/hono/middleware.js";
export type { HapiPluginOptions } from "./frameworks/hapi/plugin.js";
export { EvalKitClient } from "./core/client.js";
export { EvalKitInterceptor } from "./frameworks/nestjs/interceptor.js";

// Offline evaluation
export { evaluate } from "./evaluate.js";
export type { OfflineEvalInput, OfflineEvalResult, OfflineMetric } from "./evaluate.js";

// Scenario generation + simulation
export type { SimContext, AgentTurnResult, GenerateScenariosOptions, SimulateUserOptions, EvaluateSimulationOptions, EvaluateSimulationResult, SimEvalMetric, SimEvalScenario } from "./simulate.js";

// ---------------------------------------------------------------------------
// Global singleton — mirrors Sentry / LangFuse init pattern
// ---------------------------------------------------------------------------

let _instance: EvalKitClient | null = null;

function getInstance(): EvalKitClient {
  if (!_instance) throw new Error("[evalkit] call evalkit.init() before using the SDK");
  return _instance;
}

export function init(opts: EvalKitOptions): EvalKitClient {
  if (_instance) _instance.destroy();
  _instance = new EvalKitClient(opts);
  setupAutoInstrumentation(_instance);
  return _instance;
}

// ---------------------------------------------------------------------------
// Manual patch helpers (optional — auto-patching covers most cases)
// ---------------------------------------------------------------------------

export function patchOpenAIClient(openaiInstance: any, parentCtx?: OtelContext): void {
  patchOpenAI(getInstance(), openaiInstance.chat.completions, parentCtx);
}

export function patchAnthropicClient(anthropicInstance: any, parentCtx?: OtelContext): void {
  patchAnthropic(getInstance(), anthropicInstance.messages, parentCtx);
}

export function patchBedrockClient(bedrockRuntimeClient: any): void {
  _patchBedrock(getInstance(), bedrockRuntimeClient);
}

export function patchAnthropicVertexClient(anthropicVertexInstance: any): void {
  _patchAnthropicVertex(getInstance(), anthropicVertexInstance.messages);
}

export function patchVertexGenerativeModel(model: any): void {
  _patchVertexGenerativeModel(getInstance(), model);
}

export function patchCohereClient(cohereClient: any): void {
  _patchCohere(getInstance(), cohereClient);
}

export function patchGoogleAIModel(model: any): void {
  _patchGoogleAI(getInstance(), model);
}

/** Patch the @google/genai Models prototype (new unified Google SDK). Pass the
 *  Models class prototype, e.g. `require("@google/genai").Models.prototype`. */
export function patchGoogleGenAIModels(modelsProto: any): void {
  _patchGoogleGenAI(getInstance(), modelsProto);
}

/** Build a LangChain/LangGraph callback handler for the `{ callbacks: [handler] }`
 *  path. init() also registers one globally; this is for explicit attachment. */
export function langchainHandler(): Promise<any | null> {
  return _langchainCallbackHandler(getInstance());
}

export function patchMongooseClient(mongoose: any): void {
  _patchMongoose(getInstance(), mongoose);
}

export function patchRedisClient(redisInstance: any): void {
  _patchRedis(getInstance(), redisInstance);
}

export function patchAxiosClient(axiosInstance: any): void {
  _patchAxios(getInstance(), axiosInstance);
}

export function patchPgClient(pgInstance: any): void {
  _patchPg(getInstance(), pgInstance);
}

export function patchMysql2Client(mysqlInstance: any): void {
  _patchMysql2(getInstance(), mysqlInstance);
}

export function patchMCPClient(mcpClientClassOrInstance: any): void {
  _patchMcp(getInstance(), mcpClientClassOrInstance);
}

// ---------------------------------------------------------------------------
// Framework integrations
// ---------------------------------------------------------------------------

export function expressMiddleware(
  options?: import("./frameworks/express/middleware.js").ExpressMiddlewareOptions,
): (req: any, res: any, next: any) => void {
  return createExpressMiddleware(getInstance(), options);
}

export function fastifyPlugin(
  options?: import("./frameworks/fastify/plugin.js").FastifyPluginOptions,
): ReturnType<typeof createFastifyPlugin> {
  return createFastifyPlugin(getInstance(), options, _extractTraceparent);
}

export function koaMiddleware(
  options?: import("./frameworks/koa/middleware.js").KoaMiddlewareOptions,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return createKoaMiddleware(getInstance(), options);
}

export function honoMiddleware(
  options?: import("./frameworks/hono/middleware.js").HonoMiddlewareOptions,
): (c: any, next: () => Promise<void>) => Promise<void> {
  return createHonoMiddleware(getInstance(), options);
}

export function hapiPlugin(
  options?: import("./frameworks/hapi/plugin.js").HapiPluginOptions,
): ReturnType<typeof createHapiPlugin> {
  return createHapiPlugin(getInstance(), options);
}

export function createNestjsInterceptor(): EvalKitInterceptor {
  return new EvalKitInterceptor(getInstance());
}

// ---------------------------------------------------------------------------
// Tracing helpers
// ---------------------------------------------------------------------------

export function startTrace(
  name: string,
  attributes?: Record<string, string>
): { traceId: string; end: (status?: "OK" | "ERROR") => void; ctx: OtelContext } {
  return getInstance().startTrace(name, attributes);
}

export async function flush(): Promise<void> {
  return getInstance().flush();
}

export function startHttpTrace(
  name: string,
  httpCtx: { method: string; url: string; headers?: Record<string, string>; requestBody?: unknown },
  attributes?: Record<string, string>
): {
  traceId: string;
  end: (status?: "OK" | "ERROR", response?: { statusCode?: number; body?: unknown; headers?: Record<string, string> }) => void;
  ctx: OtelContext;
} {
  return getInstance().startHttpTrace(name, httpCtx, attributes);
}

export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>,
  parentCtx?: OtelContext
): { end: (status?: "OK" | "ERROR", extraAttributes?: Record<string, string | number | boolean>) => void; ctx: OtelContext } {
  return getInstance().startSpan(name, attributes, parentCtx);
}

export function traceFunction<T extends (...args: any[]) => any>(
  name: string,
  fn: T,
  attributes?: Record<string, string | number | boolean>,
  captureIO: boolean = true,
): T {
  return getInstance().traceFunction(name, fn, attributes, captureIO);
}

/** Wrap your own client-side tool so it traces as a first-class tool_call span
 *  (Input/Output panels + tool metrics), like server-side / LangChain tools. */
export function traceTool<T extends (...args: any[]) => any>(
  name: string,
  fn: T,
  attributes?: Record<string, string | number | boolean>,
  captureIO: boolean = true,
): T {
  return getInstance().traceTool(name, fn, attributes, captureIO);
}

export function TraceMethod(name?: string): MethodDecorator {
  return (target, key, descriptor: any) => {
    const original = descriptor.value;
    const spanName = name ?? `${(target as any).constructor?.name ?? 'unknown'}.${String(key)}`;
    let cached: ((...a: any[]) => any) | undefined;
    descriptor.value = function (this: any, ...args: any[]) {
      if (!cached) cached = getInstance().traceFunction(spanName, original);
      return cached!.apply(this, args);
    };
    return descriptor;
  };
}

export function Traced(options?: { prefix?: string }): ClassDecorator {
  return (target: any) => {
    const proto = target.prototype as Record<string, any>;
    const prefix = options?.prefix ?? (target.name as string);
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (!desc || typeof desc.value !== 'function') continue;
      const original = desc.value as (...a: any[]) => any;
      const spanName = `${prefix}.${key}`;
      let cached: ((...a: any[]) => any) | null = null;
      Object.defineProperty(proto, key, {
        ...desc,
        value: function (this: any, ...args: any[]) {
          if (!cached) cached = getInstance().traceFunction(spanName, original);
          return cached.apply(this, args);
        },
      });
    }
    return target;
  };
}

/**
 * Trace every function-valued property of an object in place, APM-style — the
 * parity for Python's `trace_module`. Use it for a service object or a CommonJS
 * `module.exports` so all its functions are traced with one call:
 *
 *   export const orders = traceObject({ place, cancel }, { prefix: 'orders' });
 */
export function traceObject<T extends Record<string, any>>(
  obj: T,
  options?: { prefix?: string; captureIO?: boolean },
): T {
  const inst = getInstance();
  const prefix = options?.prefix;
  const captureIO = options?.captureIO ?? true;
  for (const key of Object.keys(obj)) {
    const v = (obj as any)[key];
    if (typeof v === 'function' && !(v as any).__evalkitTraced) {
      const name = prefix ? `${prefix}.${key}` : key;
      const wrapped = inst.traceFunction(name, v as any, undefined, captureIO);
      (wrapped as any).__evalkitTraced = true;
      (obj as any)[key] = wrapped;
    }
  }
  return obj;
}

/**
 * APM-style auto-tracing for a NestJS app — wraps every provider/controller
 * method so the whole service call tree is traced, no per-class decorators.
 * NestJS is the one framework with a DI registry the SDK can enumerate; for
 * other frameworks use `traceObject` / `traceFunction` on your modules.
 *
 * Usage (main.ts), after `const app = await NestFactory.create(...)` — one line,
 * pass the app and the SDK resolves DiscoveryService itself (requires
 * DiscoveryModule in AppModule, which Nest provides by default):
 *   await evalkit.enableNestjsAutoTrace(app);
 *
 * You may also pass a DiscoveryService directly. Returns the number of methods
 * wrapped (0 if discovery couldn't be resolved — never throws).
 */
type DiscoveryService = {
  getProviders: () => Array<{ instance?: unknown }>;
  getControllers: () => Array<{ instance?: unknown }>;
};

export async function enableNestjsAutoTrace(
  appOrDiscovery: DiscoveryService | { get: (token: unknown) => unknown },
  options?: { include?: RegExp; captureIO?: boolean },
): Promise<number> {
  let discovery: DiscoveryService | undefined;
  const candidate = appOrDiscovery as Partial<DiscoveryService> & { get?: (token: unknown) => unknown };
  if (typeof candidate.getProviders === 'function' && typeof candidate.getControllers === 'function') {
    discovery = appOrDiscovery as DiscoveryService;
  } else if (typeof candidate.get === 'function') {
    // It's a Nest app — resolve DiscoveryService from its DI container so callers
    // don't have to import @nestjs/core themselves. Dynamic import keeps the SDK
    // framework-free.
    try {
      // Non-literal specifier so TS doesn't require @nestjs/core at build time —
      // it's an optional runtime dependency, present in any NestJS app.
      const nestCoreSpecifier = '@nestjs/core';
      const nestCore = (await import(nestCoreSpecifier)) as { DiscoveryService?: unknown };
      if (nestCore.DiscoveryService) {
        discovery = candidate.get(nestCore.DiscoveryService) as DiscoveryService;
      }
    } catch (e) {
      console.warn('[evalkit] enableNestjsAutoTrace: could not resolve DiscoveryService:', (e as Error)?.message);
    }
  }
  if (!discovery) return 0;
  return _autoTraceNest(getInstance(), discovery, options);
}

export function withTrace<T>(ctx: OtelContext, fn: () => Promise<T>): Promise<T> {
  return otelContext.with(ctx, fn);
}

/** Return the trace ID of the currently active span, or undefined if no span is active. */
export function currentTraceId(): string | undefined {
  const span = otelTrace.getActiveSpan();
  return span?.isRecording() ? span.spanContext().traceId : undefined;
}

export function generateScenarios(
  opts: import("./simulate.js").GenerateScenariosOptions
): Promise<any[]> {
  return _generateScenarios(getInstance(), opts);
}

export function simulateUser(
  opts: import("./simulate.js").SimulateUserOptions
): Promise<{ simulationId: string; runId: string; results: any[] }> {
  return _simulateUser(getInstance(), opts);
}

export function evaluateSimulation(
  opts: import("./simulate.js").EvaluateSimulationOptions
): Promise<import("./simulate.js").EvaluateSimulationResult> {
  return _evaluateSimulation(getInstance(), opts);
}

function _extractTraceparent(header: string | undefined): OtelContext {
  return _extractTraceparentHelper(header);
}

export default {
  init,
  evaluate: _evaluate,
  generateScenarios,
  simulateUser,
  evaluateSimulation,
  // Manual patch helpers
  patchOpenAIClient,
  patchAnthropicClient,
  patchBedrockClient,
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
  // Framework integrations
  expressMiddleware,
  fastifyPlugin,
  koaMiddleware,
  honoMiddleware,
  hapiPlugin,
  createNestjsInterceptor,
  // Tracing helpers
  startTrace,
  startHttpTrace,
  startSpan,
  traceFunction,
  traceTool,
  traceObject,
  TraceMethod,
  Traced,
  enableNestjsAutoTrace,
  withTrace,
  currentTraceId,
  flush,
};
