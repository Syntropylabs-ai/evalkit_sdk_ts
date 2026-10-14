import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { evaluate as _evaluate } from "./evaluate.js";
import { generateScenarios as _generateScenarios, simulateUser as _simulateUser, evaluateSimulation as _evaluateSimulation } from "./simulate.js";
import { feedback as _feedback, reward as _reward } from "./feedback.js";
import { Eval as _Eval } from "./eval.js";
import { getPrompt as _getPrompt, clearPromptCache, withPrompt, currentPrompt, Prompt } from "./prompts.js";
import { EvalKitClient } from "./core/client.js";
import type { StartTraceOptions } from "./core/client.js";
import {
  currentAgentName,
  currentIdentity,
  setAgent as _setAgent,
  setUser as _setUser,
  withSession as _withSession,
} from "./core/identity.js";
import type { Identity, SessionScope } from "./core/identity.js";
import { extractTraceparent as _extractTraceparentHelper } from "./core/context.js";
import { patchOpenAI } from "./instrumentation/llm/openai/index.js";
import { patchOpenAIResponses } from "./instrumentation/llm/openai/responses.js";
import { patchAnthropic } from "./instrumentation/llm/anthropic/index.js";
import { patchMongoose as _patchMongoose } from "./instrumentation/db/mongoose.js";
import { patchRedis as _patchRedis } from "./instrumentation/db/redis.js";
import { patchAxios as _patchAxios } from "./instrumentation/http/axios.js";
import { patchPg as _patchPg } from "./instrumentation/db/pg.js";
import { patchMysql2 as _patchMysql2 } from "./instrumentation/db/mysql2.js";
import { patchBedrock as _patchBedrock, patchBedrockAgentRuntime as _patchBedrockAgentRuntime } from "./instrumentation/llm/bedrock/index.js";
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
import { patchOllama as _patchOllama } from "./instrumentation/llm/ollama.js";
import { patchPineconeIndex as _patchPineconeIndex } from "./instrumentation/vectordb/pinecone.js";
import { patchQdrantClient as _patchQdrantClient } from "./instrumentation/vectordb/qdrant.js";
import { patchChromaCollection as _patchChromaCollection } from "./instrumentation/vectordb/chroma.js";
import { patchWeaviateModule as _patchWeaviateModule, patchWeaviateClientInstance as _patchWeaviateClientInstance } from "./instrumentation/vectordb/weaviate.js";
import { patchLlamaIndex as _patchLlamaIndex } from "./instrumentation/llm/llamaindex.js";
import { patchOpenAIAudio as _patchOpenAIAudio } from "./instrumentation/llm/openai-audio.js";
import { patchElevenLabsClientInstance as _patchElevenLabsClientInstance } from "./instrumentation/llm/elevenlabs.js";
import { patchAssemblyAI as _patchAssemblyAI } from "./instrumentation/llm/assemblyai.js";
import { instrumentPrisma as _instrumentPrisma } from "./instrumentation/db/prisma.js";
import { traceLive as _traceLive } from "./instrumentation/llm/google-live.js";
import { traceOpenAIRealtime as _traceOpenAIRealtime, patchOpenAIRealtime as _patchOpenAIRealtime } from "./instrumentation/llm/openai-realtime/index.js";
import { setupAutoInstrumentation } from "./instrumentation/auto.js";
import type { Context as OtelContext } from "@opentelemetry/api";
import type { EvalKitOptions } from "./core/types.js";

export type { EvalKitOptions, TraceEnvelope, SpanEvent, MaskHook } from "./core/types.js";
export type { FastifyPluginOptions } from "./frameworks/fastify/plugin.js";
export type { ExpressMiddlewareOptions } from "./frameworks/express/middleware.js";
export type { KoaMiddlewareOptions } from "./frameworks/koa/middleware.js";
export type { HonoMiddlewareOptions } from "./frameworks/hono/middleware.js";
export type { HapiPluginOptions } from "./frameworks/hapi/plugin.js";
export { EvalKitClient } from "./core/client.js";
export { scrubSecrets, isSecretKey } from "./core/secrets.js";
export { EvalKitInterceptor } from "./frameworks/nestjs/interceptor.js";

export { evaluate } from "./evaluate.js";
export type { OfflineEvalInput, OfflineEvalResult, OfflineMetric } from "./evaluate.js";

export { EvalResult } from "./eval.js";
export type { ChatMessage, ChatToolCall, EvalOptions, EvalRow, EvalRowResult, EvalGate, EvalSummary, LocalEvaluator, LocalScore, LocalScoreValue, ToolDefinition } from "./eval.js";
export type { Identity, SessionScope } from "./core/identity.js";
export type { StartTraceOptions } from "./core/client.js";
export type { FeedbackOptions, FeedbackResult, FeedbackKind } from "./feedback.js";
export { Prompt, withPrompt, currentPrompt, compileTemplate, variablesOf } from "./prompts.js";
export type { PromptPayload, PromptTemplate, PromptMessage, PromptVariables, GetPromptOptions } from "./prompts.js";
export type { PromptRef } from "./core/prompt-context.js";

export type { SimContext, AgentTurnResult, GenerateScenariosOptions, SimulateUserOptions, ScenarioRunResult, EvaluateSimulationOptions, EvaluateSimulationResult, SimEvalMetric, SimEvalScenario } from "./simulate.js";

let _instance: EvalKitClient | null = null;

function getInstance(): EvalKitClient {
  if (!_instance) throw new Error("[evalkit] call evalkit.init() before using the SDK");
  return _instance;
}

// What every patch and traced wrapper holds instead of a client. A library is patched once per process and a
// wrapper outlives the init() that made it, while a later init() replaces the client, so each call reaches
// the client in force through this handle. Methods run with the handle as `this`, which keeps a wrapper made
// through it resolving the client on every call too.
const _current: EvalKitClient = new Proxy(Object.create(EvalKitClient.prototype) as EvalKitClient, {
  get(_target, prop) {
    return Reflect.get(getInstance(), prop);
  },
});

function live(): EvalKitClient {
  getInstance();
  return _current;
}

export function init(opts: EvalKitOptions): EvalKitClient {
  if (_instance) void _instance.destroy();
  _instance = new EvalKitClient(opts);
  setupAutoInstrumentation(_current);
  return _instance;
}

export function patchOpenAIClient(openaiInstance: any, parentCtx?: OtelContext): void {
  const client = live();
  patchOpenAI(client, openaiInstance?.chat?.completions, parentCtx);
  patchOpenAIResponses(client, openaiInstance?.responses);
}

export function patchAnthropicClient(anthropicInstance: any, parentCtx?: OtelContext): void {
  patchAnthropic(live(), anthropicInstance?.messages, parentCtx);
}

export function patchBedrockClient(bedrockRuntimeClient: any): void {
  _patchBedrock(live(), bedrockRuntimeClient);
}

export function patchBedrockAgentRuntimeClient(bedrockAgentRuntimeClient: any): void {
  _patchBedrockAgentRuntime(live(), bedrockAgentRuntimeClient);
}

export function patchAnthropicVertexClient(anthropicVertexInstance: any): void {
  _patchAnthropicVertex(live(), anthropicVertexInstance?.messages);
}

export function patchVertexGenerativeModel(model: any): void {
  _patchVertexGenerativeModel(live(), model);
}

export function patchCohereClient(cohereClient: any): void {
  _patchCohere(live(), cohereClient);
}

export function patchGoogleAIModel(model: any): void {
  _patchGoogleAI(live(), model);
}

export function patchGoogleGenAIModels(modelsProto: any): void {
  _patchGoogleGenAI(live(), modelsProto);
}

export function langchainHandler(): Promise<any | null> {
  return _langchainCallbackHandler(live());
}

export function patchMongooseClient(mongoose: any): void {
  _patchMongoose(live(), mongoose);
}

export function patchRedisClient(redisInstance: any): void {
  _patchRedis(live(), redisInstance);
}

export function patchAxiosClient(axiosInstance: any): void {
  _patchAxios(live(), axiosInstance);
}

export function patchPgClient(pgInstance: any): void {
  _patchPg(live(), pgInstance);
}

export function patchMysql2Client(mysqlInstance: any): void {
  _patchMysql2(live(), mysqlInstance);
}

export function patchMCPClient(mcpClientClassOrInstance: any): void {
  _patchMcp(live(), mcpClientClassOrInstance);
}

export function patchOllamaClient(OllamaClass: any): void {
  _patchOllama(live(), OllamaClass);
}

export function patchPineconeClient(IndexClass: any): void {
  _patchPineconeIndex(live(), IndexClass);
}

export function patchQdrantClient(QdrantClientClass: any): void {
  _patchQdrantClient(live(), QdrantClientClass);
}

export function patchChromaClient(chromadbModule: any): void {
  _patchChromaCollection(live(), chromadbModule);
}

export function patchWeaviateClient(weaviateClientModule: any): void {
  _patchWeaviateModule(live(), weaviateClientModule);
}

export function patchWeaviateClientInstance<T = any>(weaviateClient: T): T {
  return _patchWeaviateClientInstance(live(), weaviateClient);
}

export function patchLlamaIndexClient(llamaindexModule: any): void {
  _patchLlamaIndex(live(), llamaindexModule);
}

export function patchOpenAIAudioClient(OpenAIClass: any): void {
  _patchOpenAIAudio(live(), OpenAIClass);
}

export function patchElevenLabsClientInstance<T = any>(elevenLabsClient: T): T {
  return _patchElevenLabsClientInstance(live(), elevenLabsClient);
}

export function patchAssemblyAIClient(TranscriptService: any): void {
  _patchAssemblyAI(live(), TranscriptService);
}

export function instrumentPrisma<T = any>(prisma: T, opts?: { system?: string }): T {
  return _instrumentPrisma(live(), prisma, opts) as T;
}

export function traceLive(ai: any, params: any, opts?: { sessionId?: string; userId?: string }): Promise<any> {
  return _traceLive(live(), ai, params, opts);
}

export function traceOpenAIRealtime(rt: any, opts?: { model?: string; sessionId?: string; userId?: string }): any {
  return _traceOpenAIRealtime(live(), rt, opts);
}

export function patchOpenAIRealtimeClass(RealtimeClass: any): void {
  _patchOpenAIRealtime(live(), RealtimeClass);
}

export function expressMiddleware(
  options?: import("./frameworks/express/middleware.js").ExpressMiddlewareOptions,
): (req: any, res: any, next: any) => void {
  return createExpressMiddleware(live(), options);
}

export function fastifyPlugin(
  options?: import("./frameworks/fastify/plugin.js").FastifyPluginOptions,
): ReturnType<typeof createFastifyPlugin> {
  return createFastifyPlugin(live(), options, _extractTraceparent);
}

export function koaMiddleware(
  options?: import("./frameworks/koa/middleware.js").KoaMiddlewareOptions,
): (ctx: any, next: () => Promise<void>) => Promise<void> {
  return createKoaMiddleware(live(), options);
}

export function honoMiddleware(
  options?: import("./frameworks/hono/middleware.js").HonoMiddlewareOptions,
): (c: any, next: () => Promise<void>) => Promise<void> {
  return createHonoMiddleware(live(), options);
}

export function hapiPlugin(
  options?: import("./frameworks/hapi/plugin.js").HapiPluginOptions,
): ReturnType<typeof createHapiPlugin> {
  return createHapiPlugin(live(), options);
}

export function createNestjsInterceptor(): EvalKitInterceptor {
  return new EvalKitInterceptor(live());
}

export function startTrace(
  name: string,
  attributesOrOptions?: Record<string, string> | StartTraceOptions
): { traceId: string; end: (status?: "OK" | "ERROR") => void; ctx: OtelContext } {
  return getInstance().startTrace(name, attributesOrOptions);
}

export function setUser(identity?: Identity | null): void {
  _setUser(identity);
}

export function currentUser(): Identity {
  return currentIdentity();
}

/** Names the agent every span from here on belongs to; `null` clears it. Scoped like setUser. */
export function setAgent(agentName?: string | null): void {
  _setAgent(agentName);
}

export function currentAgent(): string | undefined {
  return currentAgentName();
}

/** Runs `fn` with `sessionId` (and `userId`) in force for every span it starts, then restores the previous scope. */
export function withSession<T>(session: SessionScope, fn: () => T): T {
  return _withSession(session, fn);
}

/**
 * Sends every span ended so far; resolves to false, never rejects, when the export failed. Before init() there
 * is nothing to send and it resolves to false: an app awaits flush() on its way out, often from a module that
 * cannot tell whether tracing was set up (init() guarded on a key that is unset in tests), and tracing must
 * not fail it there.
 */
export async function flush(): Promise<boolean> {
  try {
    return _instance ? await _instance.flush() : false;
  } catch {
    return false;
  }
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
  return live().traceFunction(name, fn, attributes, captureIO);
}

export function traceTool<T extends (...args: any[]) => any>(
  name: string,
  fn: T,
  attributes?: Record<string, string | number | boolean>,
  captureIO: boolean = true,
): T {
  return live().traceTool(name, fn, attributes, captureIO);
}

export function TraceMethod(name?: string): MethodDecorator {
  return (target, key, descriptor: any) => {
    const original = descriptor.value;
    const spanName = name ?? `${(target as any).constructor?.name ?? 'unknown'}.${String(key)}`;
    let cached: ((...a: any[]) => any) | undefined;
    descriptor.value = function (this: any, ...args: any[]) {
      if (!cached) cached = live().traceFunction(spanName, original);
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
          if (!cached) cached = live().traceFunction(spanName, original);
          return cached.apply(this, args);
        },
      });
    }
    return target;
  };
}

export function traceObject<T extends Record<string, any>>(
  obj: T,
  options?: { prefix?: string; captureIO?: boolean },
): T {
  const inst = live();
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

/** What `enableNestjsAutoTrace` reads providers and controllers from: Nest's DiscoveryService. */
export interface NestDiscoveryLike {
  getProviders(...args: any[]): Array<{ instance?: unknown }>;
  getControllers(...args: any[]): Array<{ instance?: unknown }>;
}

/** A Nest application or application context: anything with Nest's `get()`. */
export interface NestApplicationLike {
  get(typeOrToken: any, options?: any): any;
}

type NestModuleLike = { providers?: Map<unknown, { instance?: unknown }>; controllers?: Map<unknown, { instance?: unknown }> };

/**
 * The providers and controllers of every module in a Nest application, read from its container. Looking up
 * Nest's DiscoveryService through `app.get()` needs DiscoveryModule imported, and a failed lookup through
 * the application aborts the process, so the container the application already holds is read instead.
 */
function nestDiscoveryOf(app: unknown): NestDiscoveryLike | undefined {
  const container = (app as { container?: { getModules?: () => Map<unknown, NestModuleLike> } } | undefined)?.container;
  if (!container || typeof container.getModules !== 'function') return undefined;
  const wrappers = (key: 'providers' | 'controllers') => (): Array<{ instance?: unknown }> => {
    const out: Array<{ instance?: unknown }> = [];
    for (const module of container.getModules!().values()) {
      for (const wrapper of module?.[key]?.values() ?? []) out.push(wrapper);
    }
    return out;
  };
  return { getProviders: wrappers('providers'), getControllers: wrappers('controllers') };
}

/**
 * Wraps the methods of a Nest application's controllers and services in function spans. Takes the
 * application itself, or a DiscoveryService. No module has to be imported for it; when it finds nothing to
 * read it logs that and returns 0, and it never fails the application's startup.
 */
export async function enableNestjsAutoTrace(
  appOrDiscovery: NestApplicationLike | NestDiscoveryLike,
  options?: { include?: RegExp; captureIO?: boolean },
): Promise<number> {
  try {
    const client = live();
    const candidate = appOrDiscovery as Partial<NestDiscoveryLike>;
    const discovery = typeof candidate?.getProviders === 'function' && typeof candidate?.getControllers === 'function'
      ? (appOrDiscovery as NestDiscoveryLike)
      : nestDiscoveryOf(appOrDiscovery);
    if (!discovery) {
      console.warn('[evalkit] enableNestjsAutoTrace: pass the Nest application or its DiscoveryService; nothing was traced');
      return 0;
    }
    return _autoTraceNest(client, discovery, options);
  } catch (e) {
    console.warn('[evalkit] enableNestjsAutoTrace: skipped:', (e as Error)?.message);
    return 0;
  }
}

export function withTrace<T>(ctx: OtelContext, fn: () => Promise<T>): Promise<T> {
  return otelContext.with(ctx, fn);
}

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

export function feedback(opts: import("./feedback.js").FeedbackOptions): Promise<import("./feedback.js").FeedbackResult> {
  return _feedback(getInstance(), opts);
}

export const prompts = {
  get(name: string, opts?: import("./prompts.js").GetPromptOptions): Promise<Prompt> {
    return _getPrompt(getInstance(), name, opts);
  },
  clearCache: clearPromptCache,
  withPrompt,
  current: currentPrompt,
};

export function reward(
  traceId: string,
  value: number,
  opts: Omit<import("./feedback.js").FeedbackOptions, "traceId" | "kind" | "value"> = {},
): Promise<import("./feedback.js").FeedbackResult> {
  return _reward(getInstance(), traceId, value, opts);
}

export function Eval(opts: import("./eval.js").EvalOptions): Promise<import("./eval.js").EvalResult> {
  return _Eval(getInstance(), opts);
}

function _extractTraceparent(header: string | undefined): OtelContext {
  return _extractTraceparentHelper(header);
}

export default {
  init,
  evaluate: _evaluate,
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
  currentTraceId,
  flush,
};
