# EvalKit TypeScript SDK — Integration Guide

`syntropylabs-evalkit` 

- **Package:** `syntropylabs-evalkit`
- **Requires:** Node.js ≥ 18
- **ESM + CommonJS**, types bundled.

---

## 1. Install

```bash
npm install syntropylabs-evalkit
# or: pnpm add syntropylabs-evalkit / yarn add syntropylabs-evalkit
```

---

## 2. Quick start

Call `init()` **once, as early as possible** — before you import/create your LLM
clients and web app. After that, use your code normally; LLM calls, outbound HTTP,
DB queries, and tool calls are traced automatically.

```ts
import { init } from "syntropylabs-evalkit";

init({
  subscriptionKey: "sk_live_...",   // required — get it from your dashboard
  serviceName: "my-agent",
  environment: "production",
});

// From here on, OpenAI/Anthropic/etc. calls, outbound HTTP, and DB queries
// are auto-traced and shipped to EvalKit.
```

For ESM, import the SDK before the libraries you want traced. In CommonJS the same
ordering applies — `require("syntropylabs-evalkit")` and `init()` first.

---

## 3. Configuration

```ts
init({
  subscriptionKey: "sk_live_...",            // required
  serviceName: "unknown",                     // stamped on every span
  environment: "production",                  // e.g. "staging" | "production"
  appVersion: "1.4.2",                        // optional
  baseUrl: "https://api.syntropylabs.ai",     // ingest endpoint (default: hosted)
  debug: false,                               // verbose exporter logging
  maxExportBatchSize: 512,                     // flush trigger
  scheduledDelayMillis: 5000,                  // background flush interval
  maxBodyBytes: 10 * 1024 * 1024,             // cap on captured HTTP req/resp bodies
});
```

Only `subscriptionKey` is required; everything else has sensible defaults.

---

## 4. What gets traced automatically

After `init()`, the SDK auto-instruments libraries present in your app:

- **LLM providers:** OpenAI (Chat Completions + Responses), Anthropic (Messages + streaming), Google (`@google/genai` + Vertex), Cohere, AWS Bedrock, LangChain / LangGraph. Each emits an `llm_call` span with `model`, `provider`, prompt, completion, token usage, latency, tool calls, and streaming accumulation.
- **HTTP clients:** `axios` and Node's `http`/`fetch` → `http_call` spans, with W3C `traceparent` propagation injected outbound.
- **Databases:** Mongoose, Redis (`ioredis`/`redis`), `pg`, `mysql2`, Prisma → `db_query` spans.
- **MCP** tool calls → `tool_call` spans.

> Dedup: if a library is already covered by community OpenTelemetry instrumentation, the SDK steps aside so you don't get double spans.

---

## 5. Manual LLM client patching (optional)

Auto-patching covers most setups. For a client the auto-patch can't reach, patch the
instance directly:

```ts
import OpenAI from "openai";
import { patchOpenAIClient } from "syntropylabs-evalkit";

const openai = new OpenAI();
patchOpenAIClient(openai);
```

Available helpers:

```
patchOpenAIClient(client)
patchAnthropicClient(client)
patchBedrockClient(bedrockRuntimeClient)
patchAnthropicVertexClient(client)
patchVertexGenerativeModel(model)
patchCohereClient(client)
patchGoogleAIModel(model)        patchGoogleGenAIModels(models)
langchainHandler()  ->  callback handler
patchMongooseClient / patchRedisClient / patchPgClient / patchMysql2Client
patchAxiosClient(axios)          instrumentPrisma(prisma)
patchMCPClient(clientOrClass)
```

---

## 6. Web framework integration

Add the middleware so inbound requests become server spans, continue an upstream
`traceparent`, and expose the trace id on the response.

**Express**
```ts
import express from "express";
import { expressMiddleware } from "syntropylabs-evalkit";

const app = express();
app.use(expressMiddleware());
```

**Fastify**
```ts
import { fastifyPlugin } from "syntropylabs-evalkit";
await app.register(fastifyPlugin());
```

**Koa / Hono / Hapi**
```ts
import { koaMiddleware, honoMiddleware, hapiPlugin } from "syntropylabs-evalkit";
koaApp.use(koaMiddleware());
honoApp.use(honoMiddleware());
await hapiServer.register(hapiPlugin());
```

**NestJS**
```ts
import { createNestjsInterceptor } from "syntropylabs-evalkit";
app.useGlobalInterceptors(createNestjsInterceptor());
```

---

## 7. Manual tracing

Use these for explicit spans around code the auto-tracer doesn't cover.

**Wrap a function / tool** (sync or async):
```ts
import { traceFunction, traceTool } from "syntropylabs-evalkit";

const buildPrompt = traceFunction("build-prompt", (userId: string) => { /* ... */ });

// First-class tool_call span (Input/Output panels + tool metrics):
const searchDocs = traceTool("search_docs", async (query: string) => { /* ... */ });
```

**Decorators:**
```ts
import { TraceMethod, Traced } from "syntropylabs-evalkit";

@Traced()                       // wraps every method on the class
class Agent {
  @TraceMethod()                // or wrap a single method
  async plan(input: string) { /* ... */ }
}
```

**Imperative spans:**
```ts
import { startSpan, startTrace, startHttpTrace, withTrace, currentTraceId } from "syntropylabs-evalkit";

// Generic span
const { end, ctx } = startSpan("retrieve", { k: 5 });
try { /* ... */ } finally { end("OK"); }   // or end("ERROR")

// Root / logical trace
const { traceId, end: endTrace } = startTrace("nightly-job");
endTrace("OK");

// HTTP span
const http = startHttpTrace("call-vendor", { method: "POST", url: "https://api.vendor.com/x", requestBody: {/*...*/} });
http.end("OK", { statusCode: 200, body: {/*...*/} });

// Nest work under an explicit context
await withTrace(ctx, async () => { /* ... */ });

currentTraceId();               // active trace id, for log correlation
```

`captureIO` (last arg of `traceFunction`/`traceTool`, default `true`) records
args/results as span attributes (truncated). Pass `false` for sensitive payloads.

---

## 8. Realtime / voice (WebSocket)

Wrap a streaming voice session to get `voice.session` / `voice.turn` / `tool_call`
spans:

```ts
import { traceLive, traceOpenAIRealtime } from "syntropylabs-evalkit";

// Google Gemini Live
const session = await traceLive(ai, { model: "gemini-2.0-flash-live" });

// OpenAI Realtime — attach to an already-created connection
const rt = new OpenAIRealtimeWebSocket({ model: "gpt-realtime" });
traceOpenAIRealtime(rt);
```

---

## 9. Offline evaluation — `evaluate()`

Deterministic metrics computed **locally, with no LLM call**. Returns a
`{ metricName: score }` map (0.0–1.0) and, when initialized, also records an
`eval_result` span.

```ts
import { evaluate } from "syntropylabs-evalkit";

const scores = evaluate({
  output: "The capital of France is Paris [1].",
  input: "What is the capital of France?",
  toolCalls: [{ name: "search" }, { name: "summarize" }],
  expectedTools: ["search", "summarize"],
  retrievedContext: ["doc_a", "doc_b"],
  expectedContext: ["doc_a"],
  constraints: { requiredTerms: ["Paris"], hasCitations: true },
});
// -> { tool_trajectory: 1, tool_f1: 1, response_match: 1, contextual_precision: 0.5, ... }
```

Each metric is computed only when its inputs are present (tool metrics need
`expectedTools`, RAG metrics need `retrievedContext` + `expectedContext`, etc.).

---

## 10. Scenarios & simulation (optional)

Generate test scenarios and run a synthetic user against your agent. The judge/
generator model is **bring-your-own-key** and never stored.

```ts
import { generateScenarios, simulateUser, evaluateSimulation } from "syntropylabs-evalkit";

const scenarios = await generateScenarios({
  agentInstructions: "You are a support bot for an e-commerce store.",
  count: 5,
  categories: ["happy_path", "edge_case", "adversarial"],
  provider: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY,
});

const result = await simulateUser({
  entrypoint: async (ctx) => {
    // ctx.message = simulated user's turn; ctx.state persists across turns
    const reply = await runMyAgent(ctx.message, ctx.state);
    return { text: reply };
  },
  scenarios,
  metrics: ["tool_correctness", "response_match"],
  maxTurns: 12,
});

// Optional LLM-judge pass over a finished simulation:
const report = await evaluateSimulation({
  simulationId: result.simulationId,
  collectionId: "<your evaluator collection id from the dashboard>",
  provider: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY,
});
```

All spans produced during a scenario are tagged so they're filterable in the
dashboard.

---

## 11. Flushing & shutdown

Spans are batched and exported in the background. To force a synchronous flush
(short-lived scripts, serverless, before exit):

```ts
import { flush } from "syntropylabs-evalkit";
await flush();
```

---

## 12. Notes & troubleshooting

- **Nothing showing up?** Make sure `init()` runs before your clients/app are created and the `subscriptionKey` is valid. A repeatedly-rejected key disables the exporter for the process — fix the key and restart.
- **Duplicate spans?** You probably manually patched a client that's also auto-instrumented; drop the manual `patch*` call.
- **Sensitive payloads:** pass `captureIO: false` to `traceFunction`/`traceTool` and lower `maxBodyBytes`. Captured HTTP bodies are size-capped.
- **Span types you'll see:** `llm_call`, `tool_call`, `http_call`, `db_query`, `function_call`, `log`, `eval_result`.
