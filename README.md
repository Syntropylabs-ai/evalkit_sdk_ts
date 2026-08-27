# EvalKit — TypeScript SDK

OpenTelemetry-based tracing and evaluation for Node.js LLM apps, by
[Syntropy Labs](https://syntropylabs.ai). A single `init()` call auto-instruments
your LLM providers, databases, and HTTP clients, then ships traces to the platform.

```bash
npm install syntropylabs-evalkit
```

> The Python SDK ships as [`syntropylabs-evalkit`](https://pypi.org/project/syntropylabs-evalkit/) on PyPI.

## Contents

- [Quick start](#quick-start)
- [What gets traced](#what-gets-traced)
- [Streaming latency (time to first token)](#streaming-latency-time-to-first-token)
- [Framework middleware](#framework-middleware)
- [Trace your own code](#trace-your-own-code)
- [Manual spans](#manual-spans)
- [Offline evaluation](#offline-evaluation)
- [Scenario simulation](#scenario-simulation)
- [Privacy: content capture and masking](#privacy-content-capture-and-masking)
- [Configuration](#configuration)
- [Coexisting with an OpenTelemetry setup you already have](#coexisting-with-an-opentelemetry-setup-you-already-have)

## Quick start

```ts
import evalkit from "syntropylabs-evalkit";

evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,   // Dashboard → Settings → Tracing
  serviceName: "my-service",
});

// Every OpenAI / Anthropic / DB / HTTP call from here on is traced automatically.
```

Call `init()` as early as possible — at the top of your entrypoint, before other
modules run requests — so auto-instrumentation can hook the libraries.

## What gets traced

| Category    | Captured automatically                                              |
| ----------- | ------------------------------------------------------------------- |
| LLM clients | OpenAI, Anthropic, Bedrock, Cohere, Google, Vertex, LangChain       |
| HTTP        | `fetch`, `axios`, `node:http` — method, URL, status, latency        |
| Databases   | Postgres, MySQL, MongoDB, Redis — query text + latency              |
| Inbound     | Every incoming HTTP request becomes a root trace                    |
| Your code   | Opt-in per function / tool / class, or whole-app on NestJS          |

Provider SDKs are **optional peer dependencies** — install only what you use:

```bash
npm install openai @anthropic-ai/sdk
```

## Streaming latency (time to first token)

Pass `stream: true` and the span carries `gen_ai.server.time_to_first_token_ms` — a number, in
milliseconds. Nothing to enable.

Four rules, and they are the same in all four EvalKit SDKs so the number is comparable across
languages:

- **The clock starts before the request is dispatched**, not at the first chunk. It covers span
  setup, connection and queueing, because that is the wait a user actually experiences.
- **Only generated text marks it** — a content delta, or a thinking/reasoning delta from an
  extended-thinking model.
- **Tool-argument deltas do not mark it.** A response that is only a tool call has no first token,
  so the attribute is absent rather than zero.
- **It is not recorded when a stream fails**, so a truncated stream cannot skew the percentiles.

Covered: OpenAI, Anthropic, Bedrock (`ConverseStream`, `InvokeModelWithResponseStream`,
`InvokeAgent`, `InvokeInlineAgent`, `RetrieveAndGenerateStream`), Google GenAI
(`generateContentStream`), and Ollama.

A stream that dies mid-flight is reported with `ERROR` status and the provider's message. Note that
the TS SDK currently attaches the response attributes — completion, token counts — only on the
success path, so a failed stream carries the error but not the partial output; the Python SDK keeps
both. If you need the partial text for debugging, consume the stream inside your own
`traceCall`/`traceTool` and record it there.

## Framework middleware

Each incoming request becomes a root trace, with downstream LLM/DB/HTTP calls nested
underneath.

```ts
import express from "express";
import evalkit from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "api" });

const app = express();
app.use(evalkit.expressMiddleware());
```

Adapters: `expressMiddleware()`, `fastifyPlugin()`, `koaMiddleware()`,
`honoMiddleware()`, `hapiPlugin()`, `createNestjsInterceptor()`.

### NestJS — trace the whole app

NestJS exposes a DI registry, so the SDK can wrap **every** provider/controller method
for you. One line in `main.ts` — pass the app; the SDK resolves `DiscoveryService`
itself (no `@nestjs/core` import needed):

```ts
evalkit.init({ subscriptionKey: "tk_live_...", serviceName: "orchestrator" });

const app = await NestFactory.create(AppModule);
await evalkit.enableNestjsAutoTrace(app);   // ← the only line you add
await app.listen(5000);
```

Route metadata (`@Get`, `@Body`, guards) is preserved, and the call never throws.

## Trace your own code

Auto-instrumentation covers libraries. For **your** code, opt in — a function, a tool,
a class, or a whole service object:

```ts
import evalkit, { Traced } from "syntropylabs-evalkit";

const rankResults = evalkit.traceFunction("rank-results", rank);   // → function_call span
const searchWeb = evalkit.traceTool("search_web", (q: string) => runSearch(q)); // → tool_call span

@Traced()                            // → every method of the class
class OrderService {
  place(order: Order) { /* ... */ }
  cancel(id: string)  { /* ... */ }
}

// Every function of a service object (parity with Python's trace_module)
export const orders = evalkit.traceObject({ place, cancel }, { prefix: "orders" });
```

> A client-side tool the model calls only shows its **output** if you wrap it with
> `traceTool` — the SDK sees the model's request, not your function's return value.
> Server-side tools (e.g. OpenAI `web_search`) and LangChain tools are automatic.

## Manual spans

```ts
import { startSpan } from "syntropylabs-evalkit";

const { end } = startSpan("embed-documents", { count: 42 });
try {
  await embed(docs);
  end("OK", { "result.count": docs.length });
} catch (e) {
  end("ERROR", { "error.message": String(e) });
  throw e;
}

await evalkit.flush();   // force-flush before process exit
```

## Offline evaluation

Deterministic, local scoring — runs synchronously, pushed as an `eval_result` span.

```ts
import { evaluate } from "syntropylabs-evalkit";

const { scores } = evaluate({
  output: "The answer is AWS and Azure.",
  expectedTools: ["search", "summarize"],
  toolCalls: [{ name: "search" }, { name: "summarize" }],
  constraints: { requiredTerms: ["AWS", "Azure"] },
});
// → { tool_trajectory: 1, tool_f1: 1, tool_correctness: 1, response_match: 1, constraint_compliance: 1 }
```

## Scenario simulation

Generate synthetic-user scenarios from your agent's prompt and tools, replay each one
against your real agent, then grade the run with LLM-as-judge evaluators.

```ts
import evalkit from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "support-bot" });

// 1 — generate scenarios (bring your own key for the generation call)
const scenarios = await evalkit.generateScenarios({
  agentInstructions: SYSTEM_PROMPT,
  tools: ["search_kb", "lookup_order", "create_ticket"],
  count: 5,
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 2 — replay each scenario against your real agent
const { simulationId, runId, results } = await evalkit.simulateUser({
  scenarios,
  entrypoint: async (ctx) => {
    const { text, toolCalls } = await runAgent(ctx.sessionId, ctx.message);
    return { text, toolCalls };
  },
  tags: ["ci"],
});

// 3 — grade the run against an evaluator collection (LLM-as-judge, BYOK)
const result = await evalkit.evaluateSimulation({
  simulationId,
  collectionId: "665f0c...",          // Dashboard → Evaluators → Collections
  provider: "openai",
  model: "gpt-4o",
  apiKey: process.env.OPENAI_API_KEY!,
  maxTokens: 1024,                    // optional judge output cap
});

console.log(result.aggregate);        // { averageScore, passRate, ... }
for (const scn of result.scenarios) {
  console.log(scn.name, scn.overallScore, scn.passed);
  for (const m of scn.metrics) console.log("  -", m.ruleName, m.score, m.reason);
}
```

`evaluateSimulation` returns per-scenario, per-criterion scores with reasons, which
also appear in the Tracing dashboard.

## Privacy: content capture and masking

Two independent controls. `captureContent` is the coarse switch; `mask` is the scalpel.

```ts
evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,
  captureContent: false,
});
```

`captureContent: false` keeps every metric and drops every payload. You still get tokens, cost,
latency, TTFT, model, provider, finish reason, status, errors, tool *names* and call IDs, span
hierarchy, `db.system` / `db.operation` / row counts. You lose prompts, completions, thinking text,
request and response bodies and headers, tool arguments and results, traced-function arguments and
return values, SQL text and bound parameters, retriever queries, and log message bodies. Spans that
were stripped carry `evalkit.content_captured=false`, so the dashboard can tell "capture is off"
apart from "the SDK failed to read the body".

It can also be set by environment variable, which is useful when the same image ships to several
environments:

```bash
export EVALKIT_CAPTURE_CONTENT=false
# or the standard OpenTelemetry variable, which EvalKit also honours:
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
```

Precedence is the `captureContent` option, then `EVALKIT_CAPTURE_CONTENT`, then
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, then on. Note that EvalKit's switch is
deliberately broader than the OpenTelemetry one: the standard variable covers GenAI message content
only, and turning it off here also removes database statements and traced-function arguments.

For anything finer, pass a `mask` callback. It runs on every envelope immediately before it is
batched for export, whichever instrumentation produced it — including spans that came from
third-party OpenTelemetry instrumentation in `attached` mode.

```ts
import type { MaskHook } from "syntropylabs-evalkit";

const CARD = /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;

const mask: MaskHook = (span) => {
  if (span.prompt) span.prompt = span.prompt.replace(CARD, "<card>");
  if (span.spanType === "db_query") return null;   // return null to drop the span entirely
  return span;
};

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, mask });
```

Mutate the envelope and return it, or return `null` to drop it. If the hook throws, or returns
anything other than an envelope or `null`, the span is **dropped** and a warning is logged — a mask
that exists to keep content inside the process fails closed rather than exporting unmasked. It is
the one place in the SDK that does; everywhere else instrumentation failures are swallowed and
tracing degrades instead of your app.

When both controls are set, `captureContent` is applied first, so `mask` sees the already-stripped
envelope.

## Configuration

| Option            | Description                                                    |
| ----------------- | ------------------------------------------------------------- |
| `subscriptionKey` | Trace-project subscription key (**required**).                |
| `serviceName`     | Logical service name attached to every trace.                 |
| `environment`     | `"development"` \| `"staging"` \| `"production"`.             |
| `baseUrl`         | Override the trace ingest endpoint (defaults to hosted).      |
| `apiUrl`          | Override the control-plane endpoint (scenario / simulation).  |
| `maxBodyBytes`    | Max captured HTTP body size (default 10 MB).                  |
| `captureContent`  | Capture prompts/bodies/arguments (default on; see [Privacy](#privacy-content-capture-and-masking)). |
| `mask`            | `(envelope) => envelope \| null` — rewrite or drop each span before export. |

See the exported `EvalKitOptions` type for the full set (`appVersion`, `deviceId`,
`debug`, batch tuning).

## Coexisting with an OpenTelemetry setup you already have

`init()` never displaces a `TracerProvider` you configured. It picks one of three
modes, reported on `client.tracingMode`:

| Your process                                        | What `init()` does                                                                                                                                             | `tracingMode` |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| No OpenTelemetry SDK started                        | Creates a provider with EvalKit's batch exporter and registers it globally, along with the async-hooks context manager and the W3C propagators                  | `owned`       |
| An OpenTelemetry SDK is already registered          | Adds EvalKit's span processor **to that provider** — your OTLP/Jaeger/Datadog exporters keep receiving every span, and EvalKit additionally receives the spans your own instrumentation produces | `attached`    |
| `tracerProvider` passed in `init()`                 | Adds EvalKit's span processor to that provider and touches no global state at all                                                                               | `attached`    |

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({ /* your exporters, sampler, resource */ });
sdk.start();

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "my-service" });
```

**Start your OpenTelemetry SDK before `init()`.** OpenTelemetry JS refuses a
duplicate global registration, so whichever side registers second is silently
orphaned — there is no error, just missing spans. Starting your SDK first lets
EvalKit attach to it; if EvalKit finds a provider it cannot attach to, it warns
once and falls back to its own pipeline, where EvalKit API spans are still
exported but your instrumentation's spans are not.

For a library that must not touch process-wide state, pass your provider
explicitly:

```ts
evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,
  serviceName: "my-service",
  tracerProvider: myProvider,
});
```

Do not also add an EvalKit exporter to that provider yourself: EvalKit attaches
exactly one export pipeline per provider, and ingest is an append-only store, so a
span sent twice is counted twice in token and cost aggregates.

`client.destroy()` matches the mode — it shuts down a provider EvalKit created, and
otherwise flushes and detaches only EvalKit's own span processor, leaving your
tracing running. In `attached` mode your resource decides `service.name`;
`serviceName` is used as the fallback when the resource carries none or carries
OpenTelemetry's `unknown_service:` placeholder.

## Links

- Website: https://syntropylabs.ai
- Documentation: https://syntropylabs.ai/docs

## License

Proprietary — © 2026 Syntropy Labs. See [LICENSE](./LICENSE).
