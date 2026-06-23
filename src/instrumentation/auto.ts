import type { EvalKitClient } from '../core/client.js';
import { dynImport, loadIfAlreadyRequired, getRequire } from '../utils/dynimport.js';
import { patchOpenAI } from './llm/openai/index.js';
import { patchAnthropic } from './llm/anthropic/index.js';
import { patchBedrock } from './llm/bedrock/index.js';
import { patchAnthropicVertex, patchVertexGenerativeModel } from './llm/vertex-ai/index.js';
import { patchCohere } from './llm/cohere/index.js';
import { patchGoogleAI } from './llm/google-ai/index.js';
import { patchGoogleGenAI } from './llm/google-genai/index.js';
import { patchGoogleLive } from './llm/google-live.js';
import { patchMongoose } from './db/mongoose.js';
import { patchPg } from './db/pg.js';
import { patchMysql2 } from './db/mysql2.js';
import { patchRedis } from './db/redis.js';
import { patchAxios } from './http/axios.js';
import { patchHttp, patchFetch, patchIncomingHttp } from './http/node-http.js';
import { patchMcp } from './mcp.js';
import { patchConsole } from './runtime/console.js';
import { patchErrors } from './runtime/errors.js';

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
  // Patch pg.Client.prototype.query — covers node-postgres Client AND Pool
  // (Pool.query delegates to a Client), and ORMs on top (TypeORM, Sequelize, Knex).
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
  // Patch mysql2 Connection prototype — covers callback + promise APIs and pools.
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
  // ioredis exports the Redis class (stable prototype.sendCommand). node-redis v4
  // builds commands dynamically per-instance → use the manual patchRedisClient there.
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

async function tryPatchOpenAIAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const openaiMod = _req('openai');
    const OpenAI = openaiMod.default ?? openaiMod.OpenAI ?? openaiMod;
    const proto = OpenAI?.Chat?.Completions?.prototype;
    if (proto) { patchOpenAI(client, proto); return; }
  } catch {}
  try {
    const openaiMod = await dynImport('openai');
    const OpenAI = openaiMod.default ?? openaiMod.OpenAI ?? openaiMod;
    const proto = OpenAI?.Chat?.Completions?.prototype;
    if (proto) patchOpenAI(client, proto);
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

async function tryPatchCohereAsync(client: EvalKitClient): Promise<void> {
  try {
    const _req = getRequire();
    const mod = _req('cohere-ai');
    const CohereClient = mod.CohereClient ?? mod.default?.CohereClient ?? mod.default;
    const proto = CohereClient?.prototype;
    if (proto) { patchCohere(client, proto); return; }
  } catch {}
  try {
    const mod = await dynImport('cohere-ai');
    const CohereClient = mod.CohereClient ?? mod.default?.CohereClient ?? mod.default;
    const proto = CohereClient?.prototype;
    if (proto) patchCohere(client, proto);
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
  // @google/genai — the new unified Google SDK (used by newer Google AI + ADK).
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
  // groq-sdk mirrors the OpenAI SDK surface (chat.completions.create).
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
    const { patchLangChain } = await import('./llm/langchain/index.js');
    await patchLangChain(client);
  } catch {}
}

async function tryPatchGoogleLiveAsync(client: EvalKitClient): Promise<void> {
  // @google/genai Live (voice over WebSocket) — patch Live.prototype.connect.
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


const OTEL_INSTRUMENTATIONS: Array<[string, string]> = [
  ['@prisma/instrumentation', 'PrismaInstrumentation'],
  ['@opentelemetry/instrumentation-mongodb', 'MongoDBInstrumentation'],
  ['@opentelemetry/instrumentation-mongoose', 'MongooseInstrumentation'],
  ['@opentelemetry/instrumentation-ioredis', 'IORedisInstrumentation'],
  ['@opentelemetry/instrumentation-redis-4', 'RedisInstrumentation'],
  ['@opentelemetry/instrumentation-pg', 'PgInstrumentation'],
  ['@opentelemetry/instrumentation-mysql2', 'MySQL2Instrumentation'],
  ['@opentelemetry/instrumentation-graphql', 'GraphQLInstrumentation'],
  ['@opentelemetry/instrumentation-nestjs-core', 'NestInstrumentation'],
];

const OTEL_DISABLED_NATIVE = {
  '@opentelemetry/instrumentation-fs': { enabled: false },
  '@opentelemetry/instrumentation-undici': { enabled: false },
  '@opentelemetry/instrumentation-http': { enabled: false },
};

async function tryRegisterOtelInstrumentations(): Promise<void> {
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
    if (instrumentations.length) reg({ instrumentations });
  } catch {}
}

async function tryPatchMcpAsync(client: EvalKitClient): Promise<void> {
  // @modelcontextprotocol/sdk — patch Client.prototype.callTool → tool_call span.
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

export function setupAutoInstrumentation(client: EvalKitClient): void {
  try { patchIncomingHttp(client); } catch {}
  try { patchHttp(client); } catch {}
  patchFetch();
  tryPatchAxios(client);
  patchConsole(client);
  patchErrors(client);
  Promise.all([
    tryPatchOpenAIAsync(client),
    tryPatchAnthropicAsync(client),
    tryPatchBedrockAsync(client),
    tryPatchAnthropicVertexAsync(client),
    tryPatchVertexAIAsync(client),
    tryPatchCohereAsync(client),
    tryPatchGoogleAIAsync(client),
    tryPatchGoogleGenAIAsync(client),
    tryPatchGroqAsync(client),
    tryPatchLangChainAsync(client),
    tryPatchGoogleLiveAsync(client),
    tryPatchMcpAsync(client),
  ]).catch(() => {});

  tryRegisterOtelInstrumentations()
    .then(() => Promise.all([
      Promise.resolve(tryPatchMongoose(client)),
      tryPatchPgAsync(client),
      tryPatchMysql2Async(client),
      tryPatchIoredisAsync(client),
    ]))
    .catch(() => {});
}
