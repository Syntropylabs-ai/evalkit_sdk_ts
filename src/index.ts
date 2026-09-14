import { context as otelContext, trace as otelTrace } from "@opentelemetry/api";
import { evaluate as _evaluate } from "./evaluate.js";
import { generateScenarios as _generateScenarios, simulateUser as _simulateUser, evaluateSimulation as _evaluateSimulation } from "./simulate.js";
import { feedback as _feedback, reward as _reward } from "./feedback.js";
import { Eval as _Eval } from "./eval.js";
import { getPrompt as _getPrompt, clearPromptCache, withPrompt, currentPrompt, Prompt } from "./prompts.js";
import { EvalKitClient } from "./core/client.js";
import type { StartTraceOptions } from "./core/client.js";
import { currentIdentity, setUser as _setUser } from "./core/identity.js";
import type { Identity } from "./core/identity.js";
import { extractTraceparent as _extractTraceparentHelper } from "./core/context.js";
import { patchOpenAI } from "./instrumentation/llm/openai/index.js";
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
export type { EvalOptions, EvalRow, EvalRowResult, EvalGate, EvalSummary, LocalEvaluator, LocalScore, LocalScoreValue } from "./eval.js";
export type { Identity } from "./core/identity.js";
export type { StartTraceOptions } from "./core/client.js";
export type { FeedbackOptions, FeedbackResult, FeedbackKind } from "./feedback.js";
export { Prompt, withPrompt, currentPrompt, compileTemplate, variablesOf } from "./prompts.js";
export type { PromptPayload, PromptTemplate, PromptMessage, PromptVariables, GetPromptOptions } from "./prompts.js";
export type { PromptRef } from "./core/prompt-context.js";

export type { SimContext, AgentTurnResult, GenerateScenariosOptions, SimulateUserOptions, EvaluateSimulationOptions, EvaluateSimulationResult, SimEvalMetric, SimEvalScenario } from "./simulate.js";

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

export function patchOpenAIClient(openaiInstance: any, parentCtx?: OtelContext): void {
  patchOpenAI(getInstance(), openaiInstance.chat.completions, parentCtx);
}

export function patchAnthropicClient(anthropicInstance: any, parentCtx?: OtelContext): void {
  patchAnthropic(getInstance(), anthropicInstance.messages, parentCtx);
}

export function patchBedrockClient(bedrockRuntimeClient: any): void {
  _patchBedrock(getInstance(), bedrockRuntimeClient);
}

export function patchBedrockAgentRuntimeClient(bedrockAgentRuntimeClient: any): void {
  _patchBedrockAgentRuntime(getInstance(), bedrockAgentRuntimeClient);
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

export function patchGoogleGenAIModels(modelsProto: any): void {
  _patchGoogleGenAI(getInstance(), modelsProto);
}

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

export function patchOllamaClient(OllamaClass: any): void {
  _patchOllama(getInstance(), OllamaClass);
}

export function patchPineconeClient(IndexClass: any): void {
  _patchPineconeIndex(getInstance(), IndexClass);
}

export function patchQdrantClient(QdrantClientClass: any): void {
  _patchQdrantClient(getInstance(), QdrantClientClass);
}

export function patchChromaClient(chromadbModule: any): void {
  _patchChromaCollection(getInstance(), chromadbModule);
}

export function patchWeaviateClient(weaviateClientModule: any): void {
  _patchWeaviateModule(getInstance(), weaviateClientModule);
}

export function patchWeaviateClientInstance<T = any>(weaviateClient: T): T {
  return _patchWeaviateClientInstance(getInstance(), weaviateClient);
}

export function patchLlamaIndexClient(llamaindexModule: any): void {
  _patchLlamaIndex(getInstance(), llamaindexModule);
}

export function patchOpenAIAudioClient(OpenAIClass: any): void {
  _patchOpenAIAudio(getInstance(), OpenAIClass);
}

export function patchElevenLabsClientInstance<T = any>(elevenLabsClient: T): T {
  return _patchElevenLabsClientInstance(getInstance(), elevenLabsClient);
}

export function patchAssemblyAIClient(TranscriptService: any): void {
  _patchAssemblyAI(getInstance(), TranscriptService);
}

export function instrumentPrisma<T = any>(prisma: T, opts?: { system?: string }): T {
  return _instrumentPrisma(getInstance(), prisma, opts) as T;
}

export function traceLive(ai: any, params: any, opts?: { sessionId?: string; userId?: string }): Promise<any> {
  return _traceLive(getInstance(), ai, params, opts);
}

export function traceOpenAIRealtime(rt: any, opts?: { model?: string; sessionId?: string; userId?: string }): any {
  return _traceOpenAIRealtime(getInstance(), rt, opts);
}

export function patchOpenAIRealtimeClass(RealtimeClass: any): void {
  _patchOpenAIRealtime(getInstance(), RealtimeClass);
}

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

    try {

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
