# EvalKit TypeScript SDK integration guide

The package is `syntropylabs-evalkit`. It needs Node.js 18 or later, works from ESM and CommonJS, and ships its own types.

## 1. Install

```bash
npm install syntropylabs-evalkit
# or: pnpm add syntropylabs-evalkit / yarn add syntropylabs-evalkit
```

## 2. Quick start

Call `init()` once, as early as you can, before you import or create your LLM clients and your web app. After that, write your code as usual. LLM calls, outbound HTTP, database queries and tool calls are traced for you.

```ts
import { init } from "syntropylabs-evalkit";

init({
  subscriptionKey: "sk_live_...",   // required. Settings → This project → Environments
  serviceName: "my-agent",
  environment: "production",
});

// From here on, OpenAI/Anthropic/etc. calls, outbound HTTP, and DB queries
// are auto-traced and shipped to EvalKit.
```

With ESM, import the SDK before the libraries you want traced. With CommonJS the order is the same: `require("syntropylabs-evalkit")` and call `init()` first.

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

Only `subscriptionKey` is required. Every other option has a default.

## 4. What gets traced automatically

After `init()`, the SDK instruments these libraries when your app uses them:

| Library | Span |
|---|---|
| OpenAI (Chat Completions and Responses), Anthropic (Messages, including streaming), Google (`@google/genai` and Vertex), Cohere, AWS Bedrock, LangChain and LangGraph | `llm_call`, with the model, provider, prompt, completion, token usage, latency and tool calls. Streams are accumulated |
| `axios`, and Node's `http` and `fetch` | `http_call`. A W3C `traceparent` header is added to outbound requests |
| Mongoose, Redis (`ioredis` and `redis`), `pg` and `mysql2`, and Prisma when `@prisma/instrumentation` is installed | `db_query` |
| MCP tool calls | `tool_call` |

When `@opentelemetry/instrumentation` is installed, the SDK also registers the OpenTelemetry instrumentations it finds. That is everything in `@opentelemetry/auto-instrumentations-node` except `fs`, `undici` and `http`, or, without that package, the Prisma, MongoDB, Mongoose, ioredis, Redis, pg, mysql2, GraphQL and NestJS instrumentations that are installed.

Another OpenTelemetry instrumentation can report the same LLM call as EvalKit. Its span is still exported, but as a `function_call` with no token counts, so tokens and cost are counted once, from EvalKit's own `llm_call` span. Set `EVALKIT_COUNT_FOREIGN_LLM=1` to count those spans too.

## 5. Patching an LLM client by hand (optional)

Automatic patching covers most setups. When it cannot reach a client, patch the instance yourself:

```ts
import OpenAI from "openai";
import { patchOpenAIClient } from "syntropylabs-evalkit";

const openai = new OpenAI();
patchOpenAIClient(openai);
```

The helpers:

```
patchOpenAIClient(client)
patchAnthropicClient(client)
patchBedrockClient(bedrockRuntimeClient)
patchBedrockAgentRuntimeClient(bedrockAgentRuntimeClient)
patchAnthropicVertexClient(client)
patchVertexGenerativeModel(model)
patchCohereClient(client)
patchGoogleAIModel(model)        patchGoogleGenAIModels(models)
langchainHandler()  ->  callback handler
patchMongooseClient / patchRedisClient / patchPgClient / patchMysql2Client
patchAxiosClient(axios)          instrumentPrisma(prisma)
patchMCPClient(clientOrClass)
```

## 6. Web frameworks

The middleware turns each inbound request into a server span, continues an upstream `traceparent`, and puts the trace id on the response.

Express:

```ts
import express from "express";
import { expressMiddleware } from "syntropylabs-evalkit";

const app = express();
app.use(expressMiddleware());
```

Fastify:

```ts
import { fastifyPlugin } from "syntropylabs-evalkit";
await app.register(fastifyPlugin());
```

Koa, Hono and Hapi:

```ts
import { koaMiddleware, honoMiddleware, hapiPlugin } from "syntropylabs-evalkit";
koaApp.use(koaMiddleware());
honoApp.use(honoMiddleware());
await hapiServer.register(hapiPlugin());
```

NestJS:

```ts
import { createNestjsInterceptor } from "syntropylabs-evalkit";
app.useGlobalInterceptors(createNestjsInterceptor());
```

## 7. Manual tracing

Use these for explicit spans around code that automatic tracing does not cover.

Wrap a function or a tool, sync or async:

```ts
import { traceFunction, traceTool } from "syntropylabs-evalkit";

const buildPrompt = traceFunction("build-prompt", (userId: string) => { /* ... */ });

// A tool_call span, with Input and Output panels and tool metrics:
const searchDocs = traceTool("search_docs", async (query: string) => { /* ... */ });
```

Decorators:

```ts
import { TraceMethod, Traced } from "syntropylabs-evalkit";

@Traced()                       // wraps every method on the class
class Agent {
  @TraceMethod()                // or wrap a single method
  async plan(input: string) { /* ... */ }
}
```

Spans you open and end yourself:

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

`captureIO`, the last argument of `traceFunction` and `traceTool`, records the arguments and the result as span attributes, truncated. It is `true` by default. Pass `false` for sensitive payloads.

## 8. Realtime and voice (WebSocket)

Wrap a streaming voice session to get `voice.session`, `voice.turn` and `tool_call` spans:

```ts
import { traceLive, traceOpenAIRealtime } from "syntropylabs-evalkit";

// Google Gemini Live
const session = await traceLive(ai, { model: "gemini-2.0-flash-live" });

// OpenAI Realtime: attach to an already-created connection
const rt = new OpenAIRealtimeWebSocket({ model: "gpt-realtime" });
traceOpenAIRealtime(rt);
```

## 9. Offline evaluation with `evaluate()`

`evaluate()` computes deterministic metrics locally, without calling an LLM. It returns a `{ metricName: score }` map with scores from 0 to 1. After `init()`, it also records an `eval_result` span.

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

A metric is computed only when its inputs are present. The tool metrics need `expectedTools`, and the RAG metrics need `retrievedContext` and `expectedContext`.

## 10. Scenarios and simulation (optional)

Generate test scenarios and run a synthetic user against your agent. You bring the key for the judge and generator model, and it is never stored.

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

Each scenario runs as one trace, `scenario:<name>`, in a session of its own. Every span in that trace carries the simulation, run and scenario ids, so the dashboard can filter by them. A scenario that throws is recorded with status `ERROR` and its message, and the other scenarios keep running.

## 11. Flushing and shutdown

Spans are batched and exported in the background. Flush them yourself in short-lived scripts, in serverless functions and before the process exits:

```ts
import { flush } from "syntropylabs-evalkit";
await flush();
```

## 12. Troubleshooting

Nothing shows up: check that `init()` runs before your clients and your app are created, and that the `subscriptionKey` is valid. After 3 consecutive `401` or `403` responses the exporter turns itself off for the life of the process, so fix the key and restart.

Duplicate spans: a `patch*` helper on a client that is already instrumented does nothing, because a patched method is marked and never wrapped twice. `instrumentPrisma` works differently. It returns an extended copy of the Prisma client and leaves the one you pass unchanged, so use the copy and call it once. Skip it when `@prisma/instrumentation` is installed, because the SDK already traces Prisma through it. If token and cost totals double, look for a second EvalKit exporter on the same provider (see the README section [Coexisting with an OpenTelemetry setup you already have](./README.md#coexisting-with-an-opentelemetry-setup-you-already-have)).

Sensitive payloads: pass `captureIO: false` to `traceFunction` and `traceTool`, and lower `maxBodyBytes`. Captured HTTP bodies are always capped at `maxBodyBytes`.

The span types you will see are `llm_call`, `tool_call`, `http_call`, `db_query`, `function_call`, `log` and `eval_result`.
