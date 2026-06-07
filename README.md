# EvalKit TypeScript SDK

OpenTelemetry-based LLM observability, tracing, and evaluation for Node.js — by [Syntropy Labs](https://syntropylabs.ai).

One `init()` call auto-instruments your LLM providers (OpenAI, Anthropic, Bedrock, Cohere, Google, Vertex, LangChain), databases (Postgres, MySQL, MongoDB, Redis), and HTTP clients — then ships traces to the EvalKit platform.

> The Python SDK is published as [`syntropylabs-evalkit`](https://pypi.org/project/syntropylabs-evalkit/) on PyPI.

## Install

```bash
npm install syntropylabs-evalkit
```

Provider SDKs are **optional peer dependencies** — install only what you use:

```bash
npm install openai @anthropic-ai/sdk
```

## Quick start

```ts
import evalkit from "syntropylabs-evalkit";

evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,
  serviceName: "my-service",
});

// That's it — any OpenAI / Anthropic / DB / HTTP call from here is traced.
```

> Call `init()` as early as possible (top of your entrypoint, before other imports run requests) so auto-instrumentation can hook the libraries.

## Framework middleware

Each incoming request becomes a root trace, with downstream LLM/DB/HTTP calls nested underneath.

```ts
import express from "express";
import evalkit from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "api" });

const app = express();
app.use(evalkit.expressMiddleware());
```

Supported adapters: `expressMiddleware()`, `fastifyPlugin()`, `koaMiddleware()`, `honoMiddleware()`, `hapiPlugin()`, and `createNestjsInterceptor()`.

## Manual tracing helpers

```ts
import evalkit from "syntropylabs-evalkit";

// Open a span by hand
const { end } = evalkit.startSpan("embed-documents", { count: 42 });
try {
  await embed(docs);
  end("OK", { "result.count": docs.length });
} catch (e) {
  end("ERROR", { "error.message": String(e) });
  throw e;
}

await evalkit.flush(); // force-flush before process exit
```

## Tracing your own functions & tools (APM)

Auto-instrumentation covers libraries (LLM / HTTP / DB). For **your** code, opt in —
a function, a tool, a class, or a whole service object:

```ts
import evalkit, { Traced } from "syntropylabs-evalkit";

// One function -> function_call span (input / output / latency)
const rankResults = evalkit.traceFunction("rank-results", rank);

// One tool -> tool_call span (Input/Output panels + tool metrics)
const searchWeb = evalkit.traceTool("search_web", (q: string) => runSearch(q));

// Every method of a class, APM-style
@Traced()
class OrderService {
  place(order: Order) { /* ... */ }
  cancel(id: string)  { /* ... */ }
}

// Or one method
class Service {
  @evalkit.TraceMethod()
  async compute() { /* ... */ }
}

// Every function of a service object (parity with Python's trace_module)
export const orders = evalkit.traceObject({ place, cancel }, { prefix: "orders" });
```

### NestJS — trace the whole app automatically

NestJS exposes a DI registry, so the SDK can wrap **every** provider/controller
method for you — no per-class decorators. One line in `main.ts`: pass the app and
the SDK resolves `DiscoveryService` itself (no `@nestjs/core` import needed):

```ts
const app = await NestFactory.create(AppModule);
evalkit.init({ subscriptionKey: "tk_live_…", serviceName: "orchestrator" });
await evalkit.enableNestjsAutoTrace(app);   // ← the only line you add
await app.listen(5000);
```

Route metadata (`@Get`, `@Body`, guards) is preserved, so routing and auth are
unaffected. The call never throws — if discovery can't be resolved it's a no-op.
You can still pass a `DiscoveryService` directly if you prefer.

> Auto-discovery is only possible where the framework has a registry (NestJS). For
> Express / Fastify / Koa / Hono / Hapi, use `traceObject` / `traceFunction` on your
> own modules — incoming HTTP and LLM/DB/HTTP calls are already auto-traced.

> **Client-side tools you run yourself** only show their output if you wrap them with
> `traceTool` — the SDK sees the model's *request* but never your function's return
> value. Server-side tools (OpenAI `web_search`, …) and LangChain tools are captured
> automatically.

## Offline evaluation

```ts
import { evaluate } from "syntropylabs-evalkit";

// Deterministic, local scoring — runs synchronously, pushed as an eval_result span
const { scores } = evaluate({
  output: "The answer is AWS and Azure.",
  expectedTools: ["search", "summarize"],
  toolCalls: [{ name: "search" }, { name: "summarize" }],
  constraints: { requiredTerms: ["AWS", "Azure"] },
});
```

## Scenario generation & simulation

```ts
import evalkit from "syntropylabs-evalkit";

const scenarios = await evalkit.generateScenarios({ /* ... */ });
const { simulationId, results } = await evalkit.simulateUser({ /* ... */ });
```

## Configuration

| Option             | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `subscriptionKey`  | EvalKit trace-project subscription key (**required**).        |
| `serviceName`      | Logical service name attached to every trace.                 |
| `environment`      | `"development"` \| `"staging"` \| `"production"`.             |
| `baseUrl`          | Override the trace ingest endpoint (defaults to hosted).      |
| `apiUrl`           | Override the control-plane endpoint (scenario generation).    |
| `maxBodyBytes`     | Max captured HTTP request/response body size (default 10 MB). |

See the exported `EvalKitOptions` type for the full set (`appVersion`, `deviceId`, `debug`, batch tuning).

## License

Proprietary — © 2026 Syntropy Labs. See [LICENSE](./LICENSE).
