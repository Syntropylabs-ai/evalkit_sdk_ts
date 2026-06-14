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
- [Framework middleware](#framework-middleware)
- [Trace your own code](#trace-your-own-code)
- [Manual spans](#manual-spans)
- [Offline evaluation](#offline-evaluation)
- [Scenario simulation](#scenario-simulation)
- [Configuration](#configuration)

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

## Configuration

| Option            | Description                                                    |
| ----------------- | ------------------------------------------------------------- |
| `subscriptionKey` | Trace-project subscription key (**required**).                |
| `serviceName`     | Logical service name attached to every trace.                 |
| `environment`     | `"development"` \| `"staging"` \| `"production"`.             |
| `baseUrl`         | Override the trace ingest endpoint (defaults to hosted).      |
| `apiUrl`          | Override the control-plane endpoint (scenario / simulation).  |
| `maxBodyBytes`    | Max captured HTTP body size (default 10 MB).                  |

See the exported `EvalKitOptions` type for the full set (`appVersion`, `deviceId`,
`debug`, batch tuning).

## Links

- Website: https://syntropylabs.ai
- Documentation: https://syntropylabs.ai/docs

## License

Proprietary — © 2026 Syntropy Labs. See [LICENSE](./LICENSE).
