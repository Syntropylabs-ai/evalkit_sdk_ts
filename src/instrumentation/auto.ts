import type { EvalKitClient } from '../core/client.js';
import { dynImport, loadIfAlreadyRequired, getRequire } from '../utils/dynimport.js';
import type { TracerProvider } from '@opentelemetry/api';
import { patchOpenAI } from './llm/openai/index.js';
import { patchOpenAIResponses } from './llm/openai/responses.js';
import { patchAnthropic } from './llm/anthropic/index.js';
import { patchBedrock, patchBedrockAgentRuntime } from './llm/bedrock/index.js';
import { patchAnthropicVertex, patchVertexGenerativeModel } from './llm/vertex-ai/index.js';
import { patchCohere } from './llm/cohere/index.js';
import { patchGoogleAI } from './llm/google-ai/index.js';
import { patchGoogleGenAI } from './llm/google-genai/index.js';
import { patchGoogleLive } from './llm/google-live.js';
import { patchOpenAIRealtime } from './llm/openai-realtime/index.js';
import { patchMongoose } from './db/mongoose.js';
import { patchPg } from './db/pg.js';
import { patchMysql2 } from './db/mysql2.js';
import { patchRedis } from './db/redis.js';
import { patchAxios } from './http/axios.js';
import { patchHttp, patchFetch, patchIncomingHttp } from './http/node-http.js';
import { patchMcp } from './mcp.js';
import { patchGoogleAdk } from './google-adk.js';
import { patchLangChain } from './llm/langchain/index.js';
import { patchLangGraphModule } from './llm/langchain/langgraph.js';
import { patchConsole } from './runtime/console.js';
import { patchErrors } from './runtime/errors.js';
import { patchOllama } from './llm/ollama.js';
import { patchPineconeIndex } from './vectordb/pinecone.js';
import { patchQdrantClient } from './vectordb/qdrant.js';
import { patchChromaCollection } from './vectordb/chroma.js';
import { patchWeaviateModule } from './vectordb/weaviate.js';
import { patchLlamaIndex } from './llm/llamaindex.js';
import { patchOpenAIAudio } from './llm/openai-audio.js';
import { patchElevenLabsClientInstance } from './llm/elevenlabs.js';
import { patchAssemblyAI } from './llm/assemblyai.js';

function otelWrapped(fn: any): boolean {
  return !!(fn && (fn.__wrapped === true || fn.__original));
}

function tryPatchMongoose(client: EvalKitClient): void {
  const mongoose = loadIfAlreadyRequired('mongoose');
  if (!mongoose) return;
  if (otelWrapped(mongoose.Query?.prototype?.exec)) return;
  patchMongoose(client, mongoose);
}

function tryPatchAxios(client: EvalKitClient): void {
  const axiosMod = loadIfAlreadyRequired('axios');
  if (axiosMod) patchAxios(client, axiosMod.default ?? axiosMod);
}

async function tryPatchPgAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const pg = _req('pg');
    const Client = pg.Client ?? pg.default?.Client;
    if (Client) { if (!otelWrapped(Client.prototype?.query)) patchPg(client, Client); return; }
  } catch {}
  try {
    const pg = await dynImport('pg');
    const Client = pg.Client ?? pg.default?.Client;
    if (Client && !otelWrapped(Client.prototype?.query)) patchPg(client, Client);
  } catch {}
}

async function tryPatchMysql2Async(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mysql = _req('mysql2');
    const Conn = mysql.Connection ?? mysql.default?.Connection ?? _req('mysql2/lib/connection');
    if (Conn) { if (!otelWrapped(Conn.prototype?.query)) patchMysql2(client, Conn); return; }
  } catch {}
  try {
    const mysql = await dynImport('mysql2');
    const Conn = mysql.Connection ?? mysql.default?.Connection;
    if (Conn && !otelWrapped(Conn.prototype?.query)) patchMysql2(client, Conn);
  } catch {}
}

async function tryPatchIoredisAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('ioredis');
    const Redis = mod.default ?? mod.Redis ?? mod;
    if (Redis?.prototype) { if (!otelWrapped(Redis.prototype.sendCommand)) patchRedis(client, Redis); return; }
  } catch {}
  try {
    const mod = await dynImport('ioredis');
    const Redis = mod.default ?? mod.Redis ?? mod;
    if (Redis?.prototype && !otelWrapped(Redis.prototype.sendCommand)) patchRedis(client, Redis);
  } catch {}
}

// openai's chat completions, and its Responses API where the installed version has one.
function patchOpenAIModule(client: EvalKitClient, openaiMod: any): boolean {
  const OpenAI = openaiMod?.default ?? openaiMod?.OpenAI ?? openaiMod;
  const proto = OpenAI?.Chat?.Completions?.prototype;
  if (!proto) return false;
  patchOpenAI(client, proto);
  const responses = OpenAI?.Responses?.prototype;
  if (responses) patchOpenAIResponses(client, responses);
  return true;
}

async function tryPatchOpenAIAsync(client: EvalKitClient): Promise<void> {
  try {
    if (patchOpenAIModule(client, getRequire()('openai'))) return;
  } catch {}
  try {
    patchOpenAIModule(client, await dynImport('openai'));
  } catch {}
}

async function tryPatchAnthropicAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@anthropic-ai/sdk');
    const Anthropic = mod.default ?? mod.Anthropic ?? mod;
    const proto = Anthropic?.Messages?.prototype;
    if (proto) { patchAnthropic(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@anthropic-ai/sdk');
    const Anthropic = mod.default ?? mod.Anthropic ?? mod;
    const proto = Anthropic?.Messages?.prototype;
    if (proto) patchAnthropic(client, proto);
  } catch {}
}

async function tryPatchBedrockAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@aws-sdk/client-bedrock-runtime');
    const ClientClass = mod.BedrockRuntimeClient ?? mod.default?.BedrockRuntimeClient;
    const proto = ClientClass?.prototype;
    if (proto) { patchBedrock(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@aws-sdk/client-bedrock-runtime');
    const ClientClass = mod.BedrockRuntimeClient ?? mod.default?.BedrockRuntimeClient;
    const proto = ClientClass?.prototype;
    if (proto) patchBedrock(client, proto);
  } catch {}
}

async function tryPatchBedrockAgentRuntimeAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@aws-sdk/client-bedrock-agent-runtime');
    const ClientClass = mod.BedrockAgentRuntimeClient ?? mod.default?.BedrockAgentRuntimeClient;
    const proto = ClientClass?.prototype;
    if (proto) { patchBedrockAgentRuntime(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@aws-sdk/client-bedrock-agent-runtime');
    const ClientClass = mod.BedrockAgentRuntimeClient ?? mod.default?.BedrockAgentRuntimeClient;
    const proto = ClientClass?.prototype;
    if (proto) patchBedrockAgentRuntime(client, proto);
  } catch {}
}

async function tryPatchAnthropicVertexAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@anthropic-ai/sdk');
    const AnthropicVertex = mod.AnthropicVertex ?? mod.default?.AnthropicVertex;
    const proto = AnthropicVertex?.Messages?.prototype;
    if (proto) { patchAnthropicVertex(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@anthropic-ai/sdk');
    const AnthropicVertex = mod.AnthropicVertex ?? mod.default?.AnthropicVertex;
    const proto = AnthropicVertex?.Messages?.prototype;
    if (proto) patchAnthropicVertex(client, proto);
  } catch {}
}

async function tryPatchVertexAIAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@google-cloud/vertexai');
    const GenerativeModel = mod.GenerativeModel ?? mod.default?.GenerativeModel;
    const proto = GenerativeModel?.prototype;
    if (proto) { patchVertexGenerativeModel(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@google-cloud/vertexai');
    const GenerativeModel = mod.GenerativeModel ?? mod.default?.GenerativeModel;
    const proto = GenerativeModel?.prototype;
    if (proto) patchVertexGenerativeModel(client, proto);
  } catch {}
}

// CohereClient (the v1 chat API) and CohereClientV2, where the installed version has it.
function patchCohereModule(client: EvalKitClient, mod: any): boolean {
  const CohereClient = mod?.CohereClient ?? mod?.default?.CohereClient ?? mod?.default;
  if (!CohereClient?.prototype) return false;
  patchCohere(client, CohereClient.prototype);
  const V2 = mod?.CohereClientV2 ?? mod?.default?.CohereClientV2;
  if (V2?.prototype) patchCohere(client, V2.prototype);
  return true;
}

async function tryPatchCohereAsync(client: EvalKitClient): Promise<void> {
  try {
    if (patchCohereModule(client, getRequire()('cohere-ai'))) return;
  } catch {}
  try {
    patchCohereModule(client, await dynImport('cohere-ai'));
  } catch {}
}

async function tryPatchGoogleAIAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@google/generative-ai');
    const GenerativeModel = mod.GenerativeModel ?? mod.default?.GenerativeModel;
    const proto = GenerativeModel?.prototype;
    if (proto) { patchGoogleAI(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('@google/generative-ai');
    const GenerativeModel = mod.GenerativeModel ?? mod.default?.GenerativeModel;
    const proto = GenerativeModel?.prototype;
    if (proto) patchGoogleAI(client, proto);
  } catch {}
}

async function tryPatchGoogleGenAIAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('@google/genai');
    const Models = mod.Models ?? mod.default?.Models;
    if (Models?.prototype) { patchGoogleGenAI(client, Models.prototype); return; }
  } catch {}
  try {
    const mod = await dynImport('@google/genai');
    const Models = mod.Models ?? mod.default?.Models;
    if (Models?.prototype) patchGoogleGenAI(client, Models.prototype);
  } catch {}
}

async function tryPatchGroqAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('groq-sdk');
    const Groq = mod.default ?? mod.Groq ?? mod;
    const proto = Groq?.Chat?.Completions?.prototype;
    if (proto) { patchOpenAI(client, proto, undefined, 'groq'); return; }
  } catch {}
  try {
    const mod = await dynImport('groq-sdk');
    const Groq = mod.default ?? mod.Groq ?? mod;
    const proto = Groq?.Chat?.Completions?.prototype;
    if (proto) patchOpenAI(client, proto, undefined, 'groq');
  } catch {}
}

async function tryPatchLangChainAsync(client: EvalKitClient): Promise<void> {
  try {
    await patchLangChain(client);
  } catch {}
  try {
    if (patchLangGraphModule(client, getRequire()('@langchain/langgraph/pregel'))) return;
  } catch {}
  try {
    patchLangGraphModule(client, await dynImport('@langchain/langgraph/pregel'));
  } catch {}
}

async function tryPatchGoogleLiveAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('@google/genai');
    const Live = mod.Live ?? mod.default?.Live;
    if (Live?.prototype?.connect) { patchGoogleLive(client, Live); return; }
  } catch {}
  try {
    const mod = await dynImport('@google/genai');
    const Live = mod.Live ?? mod.default?.Live;
    if (Live?.prototype?.connect) patchGoogleLive(client, Live);
  } catch {}
}

async function tryPatchOpenAIRealtimeAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('openai/beta/realtime/websocket');
    const RT = mod.OpenAIRealtimeWebSocket ?? mod.default?.OpenAIRealtimeWebSocket ?? mod.default;
    if (typeof RT === 'function') { patchOpenAIRealtime(client, RT); return; }
  } catch {}
  try {
    const mod = await dynImport('openai/beta/realtime/websocket');
    const RT = mod.OpenAIRealtimeWebSocket ?? mod.default?.OpenAIRealtimeWebSocket ?? mod.default;
    if (typeof RT === 'function') patchOpenAIRealtime(client, RT);
  } catch {}
}

const OTEL_INSTRUMENTATIONS: Array<[string, string]> = [
  ['@prisma/instrumentation', 'PrismaInstrumentation'],
  ['@opentelemetry/instrumentation-mongodb', 'MongoDBInstrumentation'],
  ['@opentelemetry/instrumentation-mongoose', 'MongooseInstrumentation'],
  ['@opentelemetry/instrumentation-ioredis', 'IORedisInstrumentation'],
  ['@opentelemetry/instrumentation-redis-4', 'RedisInstrumentation'],
  ['@opentelemetry/instrumentation-pg', 'PgInstrumentation'],
  ['@opentelemetry/instrumentation-mysql2', 'MySQL2Instrumentation'],
  ['@opentelemetry/instrumentation-graphql', 'GraphQLInstrumentation'],
];

// OpenTelemetry instrumentations left off. They hook require(), so they ran only in CommonJS apps, and each
// records what the SDK records itself or what is noise beside it: a request's server and client spans
// (http, undici), a model call (openai), the web framework's middleware and route handlers (express, router,
// connect, koa, hapi, restify, nestjs-core) and each socket and lookup (net, dns, fs). With them off a
// CommonJS app gives the same spans as the same app as an ES module.
const OTEL_DISABLED_NATIVE = Object.fromEntries([
  'fs', 'undici', 'http', 'net', 'dns', 'openai',
  'express', 'router', 'connect', 'koa', 'hapi', 'restify', 'nestjs-core',
].map((name) => [`@opentelemetry/instrumentation-${name}`, { enabled: false }]));

// The OpenTelemetry instrumentations the SDK registered, and the provider they report to. A second set
// would wrap every library the first set wrapped and record each call twice, so a later init() only points
// the first set at its provider when that changed.
let registered: { instrumentations: unknown[]; provider: TracerProvider } | undefined;
let registering: Promise<void> | undefined;

async function tryRegisterOtelInstrumentations(client: EvalKitClient): Promise<void> {
  // An app with an OpenTelemetry setup of its own registered its instrumentations already, or chose not to;
  // a second set would wrap the same libraries again and record each call twice. Its spans reach EvalKit
  // through the processor attached to its provider.
  if (client.tracingMode !== "owned") return;
  if (registering) {
    await registering;
    repointInstrumentations(client.provider);
    return;
  }
  registering = registerOtelInstrumentations(client);
  await registering;
}

function repointInstrumentations(provider: TracerProvider): void {
  if (!registered || registered.provider === provider) return;
  registered.provider = provider;
  for (const inst of registered.instrumentations) {
    try { (inst as { setTracerProvider?: (p: TracerProvider) => void }).setTracerProvider?.(provider); } catch {}
  }
}

async function registerOtelInstrumentations(client: EvalKitClient): Promise<void> {
  try {
    const reg = (await dynImport('@opentelemetry/instrumentation'))?.registerInstrumentations;
    if (!reg) return;
    let instrumentations: unknown[] = [];
    try {
      const getAll = (await dynImport('@opentelemetry/auto-instrumentations-node'))?.getNodeAutoInstrumentations;
      if (getAll) instrumentations = getAll(OTEL_DISABLED_NATIVE);
    } catch {}
    if (!instrumentations.length) {
      for (const [mod, cls] of OTEL_INSTRUMENTATIONS) {
        try {
          const C = (await dynImport(mod))?.[cls];
          if (C) instrumentations.push(new C());
        } catch {}
      }
    }
    if (instrumentations.length) {
      const provider = client.provider;
      reg({ instrumentations, tracerProvider: provider });
      registered = { instrumentations, provider };
    }
  } catch {}
}

async function tryPatchGoogleAdkAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('@google/adk');
    if (mod?.Runner) { patchGoogleAdk(client, mod); return; }
  } catch {}
  try {
    const mod = await dynImport('@google/adk');
    if (mod?.Runner) patchGoogleAdk(client, mod);
  } catch {}
}

async function tryPatchMcpAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('@modelcontextprotocol/sdk/client/index.js');
    const Client = mod.Client ?? mod.default?.Client;
    if (Client?.prototype) { patchMcp(client, Client); return; }
  } catch {}
  try {
    const mod = await dynImport('@modelcontextprotocol/sdk/client/index.js');
    const Client = mod.Client ?? mod.default?.Client;
    if (Client?.prototype) patchMcp(client, Client);
  } catch {}
}

async function tryPatchOllamaAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('ollama');
    const OllamaClass = mod.Ollama ?? mod.default?.Ollama;
    if (OllamaClass?.prototype) { patchOllama(client, OllamaClass); return; }
  } catch {}
  try {
    const mod = await dynImport('ollama');
    const OllamaClass = mod.Ollama ?? mod.default?.Ollama;
    if (OllamaClass?.prototype) patchOllama(client, OllamaClass);
  } catch {}
}

async function tryPatchPineconeAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@pinecone-database/pinecone');
    const Index = mod.Index ?? mod.default?.Index;
    if (Index?.prototype) { patchPineconeIndex(client, Index); return; }
  } catch {}
  try {
    const mod = await dynImport('@pinecone-database/pinecone');
    const Index = mod.Index ?? mod.default?.Index;
    if (Index?.prototype) patchPineconeIndex(client, Index);
  } catch {}
}

async function tryPatchQdrantAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('@qdrant/js-client-rest');
    const QdrantClient = mod.QdrantClient ?? mod.default?.QdrantClient;
    if (QdrantClient?.prototype) { patchQdrantClient(client, QdrantClient); return; }
  } catch {}
  try {
    const mod = await dynImport('@qdrant/js-client-rest');
    const QdrantClient = mod.QdrantClient ?? mod.default?.QdrantClient;
    if (QdrantClient?.prototype) patchQdrantClient(client, QdrantClient);
  } catch {}
}

async function tryPatchChromaAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('chromadb');
    if (mod?.CollectionHandle?.prototype) { patchChromaCollection(client, mod); return; }
  } catch {}
  try {
    const mod = await dynImport('chromadb');
    if (mod?.CollectionHandle?.prototype) patchChromaCollection(client, mod);
  } catch {}
}

async function tryPatchWeaviateAsync(client: EvalKitClient): Promise<void> {

  try {
    const _req = getRequire();
    const mod = _req('weaviate-client');
    if (typeof mod?.connectToLocal === 'function') { patchWeaviateModule(client, mod); return; }
  } catch {}
  try {
    const mod = await dynImport('weaviate-client');
    if (typeof mod?.connectToLocal === 'function') patchWeaviateModule(client, mod);
  } catch {}
}

async function tryPatchLlamaIndexAsync(client: EvalKitClient): Promise<void> {
  try {
    const mod = await dynImport('llamaindex');
    patchLlamaIndex(client, mod);
  } catch {}
}

async function tryPatchOpenAIAudioAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const openaiMod = _req('openai');
    const OpenAI = openaiMod.default ?? openaiMod.OpenAI ?? openaiMod;
    if (OpenAI?.Audio) { patchOpenAIAudio(client, OpenAI); return; }
  } catch {}
  try {
    const openaiMod = await dynImport('openai');
    const OpenAI = openaiMod.default ?? openaiMod.OpenAI ?? openaiMod;
    if (OpenAI?.Audio) patchOpenAIAudio(client, OpenAI);
  } catch {}
}

async function tryPatchAssemblyAIAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('assemblyai');
    if (mod?.TranscriptService) { patchAssemblyAI(client, mod.TranscriptService); return; }
  } catch {}
  try {
    const mod = await dynImport('assemblyai');
    if (mod?.TranscriptService) patchAssemblyAI(client, mod.TranscriptService);
  } catch {}
}

export function setupAutoInstrumentation(client: EvalKitClient): void {
  try { patchIncomingHttp(client); } catch {}
  try { patchHttp(client); } catch {}
  try { patchFetch(); } catch {}
  try { tryPatchAxios(client); } catch {}
  // Patched on the first init() that captures the console; each call reads the options in force.
  try { if (client.options.captureConsole !== false) patchConsole(client); } catch {}
  try { patchErrors(client); } catch {}
  Promise.all([
    tryPatchOpenAIAsync(client),
    tryPatchAnthropicAsync(client),
    tryPatchBedrockAsync(client),
    tryPatchBedrockAgentRuntimeAsync(client),
    tryPatchAnthropicVertexAsync(client),
    tryPatchVertexAIAsync(client),
    tryPatchCohereAsync(client),
    tryPatchGoogleAIAsync(client),
    tryPatchGoogleGenAIAsync(client),
    tryPatchGroqAsync(client),
    tryPatchLangChainAsync(client),
    tryPatchGoogleLiveAsync(client),
    tryPatchOpenAIRealtimeAsync(client),
    tryPatchMcpAsync(client),
    tryPatchGoogleAdkAsync(client),
    tryPatchOllamaAsync(client),
    tryPatchPineconeAsync(client),
    tryPatchQdrantAsync(client),
    tryPatchChromaAsync(client),
    tryPatchWeaviateAsync(client),
    tryPatchLlamaIndexAsync(client),
    tryPatchOpenAIAudioAsync(client),
    tryPatchAssemblyAIAsync(client),
  ]).catch(() => {});

  tryRegisterOtelInstrumentations(client)
    .then(() => Promise.all([
      Promise.resolve(tryPatchMongoose(client)),
      tryPatchPgAsync(client),
      tryPatchMysql2Async(client),
      tryPatchIoredisAsync(client),
    ]))
    .catch(() => {});
}
