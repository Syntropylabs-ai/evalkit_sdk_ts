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

// Wrap a function — input/output captured automatically
const handler = evalkit.traceFunction("rank-results", rankResults);

// Or open a span by hand
const span = evalkit.startSpan("embed-documents", { count: 42 });
try {
  await embed(docs);
  span.end("OK");
} catch (e) {
  span.end("ERROR");
  throw e;
}

// Decorators
class Service {
  @evalkit.TraceMethod()
  async compute() { /* ... */ }
}

await evalkit.flush(); // force-flush before process exit
```

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

See the exported `EvalKitOptions` type for the full set (`appVersion`, `deviceId`, `debug`, batch tuning).

## License

Proprietary — © 2026 Syntropy Labs. See [LICENSE](./LICENSE).
