# EvalKit TypeScript SDK

The EvalKit SDK for Node.js, from [SyntropyLabs](https://syntropylabs.ai). It traces and evaluates LLM apps and is built on OpenTelemetry. One `init()` call instruments your LLM providers, databases and HTTP clients, and sends the traces to the platform.

```bash
npm install syntropylabs-evalkit
```

The Python SDK is published on PyPI as [`syntropylabs-evalkit`](https://pypi.org/project/syntropylabs-evalkit/).

## Contents

- [Quick start](#quick-start)
- [What gets traced](#what-gets-traced)
- [Streaming latency (time to first token)](#streaming-latency-time-to-first-token)
- [Framework middleware](#framework-middleware)
- [Trace your own code](#trace-your-own-code)
- [Manual spans](#manual-spans)
- [Identity](#identity)
- [Offline evaluation](#offline-evaluation)
- [Evaluation runs](#evaluation-runs)
- [Feedback and rewards](#feedback-and-rewards)
- [Prompts](#prompts)
- [Scenario simulation](#scenario-simulation)
- [Coding agents](#coding-agents)
- [Privacy: content capture and masking](#privacy-content-capture-and-masking)
- [Configuration](#configuration)
- [Coexisting with an OpenTelemetry setup you already have](#coexisting-with-an-opentelemetry-setup-you-already-have)

## Quick start

```ts
import evalkit from "syntropylabs-evalkit";

evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,   // Settings → This project → Environments
  serviceName: "my-service",
});

// Every OpenAI / Anthropic / DB / HTTP call from here on is traced automatically.
```

Call `init()` as early as you can, at the top of your entry point and before other modules send requests, so that the instrumentation hooks the libraries first.

## What gets traced

| Category | Captured automatically |
| --- | --- |
| LLM clients | OpenAI, Anthropic, Bedrock, Cohere, Google, Vertex and LangChain |
| HTTP | `fetch`, `axios` and `node:http`, with method, URL, status and latency |
| Databases | Postgres, MySQL, MongoDB and Redis, with query text and latency |
| Inbound | Every incoming HTTP request becomes a root trace |
| Your code | Opt-in per function, tool or class, or the whole app on NestJS |

Provider SDKs are optional peer dependencies, so install only the ones you use:

```bash
npm install openai @anthropic-ai/sdk
```

## Streaming latency (time to first token)

Pass `stream: true`, and the span carries `gen_ai.server.time_to_first_token_ms`, a number in milliseconds. There is nothing to turn on.

Four rules decide the value. They are the same in all four EvalKit SDKs, so the number compares across languages.

1. The clock starts before the request is sent, not at the first chunk. It covers span setup, connection and queueing, because the user waits through those too.
2. Only generated text counts as the first token: a content delta, or a thinking or reasoning delta from an extended-thinking model.
3. Tool-argument deltas do not count. A response that is only a tool call has no first token, so the attribute is absent, not zero.
4. A failed stream records no first-token time, so a truncated stream cannot skew the percentiles.

The covered providers are OpenAI, Anthropic, Bedrock (`ConverseStream`, `InvokeModelWithResponseStream`, `InvokeAgent`, `InvokeInlineAgent` and `RetrieveAndGenerateStream`), Google GenAI (`generateContentStream`) and Ollama.

A stream that fails partway is reported with status `ERROR` and the provider's message. The TypeScript SDK attaches the response attributes, such as the completion and the token counts, only when a stream succeeds, so a failed stream carries the error but not the partial output. The Python SDK keeps both. If you need the partial text for debugging, consume the stream inside your own `traceCall` or `traceTool` and record it there.

## Framework middleware

Each incoming request becomes a root trace, and the LLM, database and HTTP calls it makes nest under it.

```ts
import express from "express";
import evalkit from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "api" });

const app = express();
app.use(evalkit.expressMiddleware());
```

The adapters are `expressMiddleware()`, `fastifyPlugin()`, `koaMiddleware()`, `honoMiddleware()`, `hapiPlugin()` and `createNestjsInterceptor()`.

### Trace a whole NestJS app

NestJS has a dependency-injection registry, so the SDK can wrap every provider and controller method for you. Add one line to `main.ts` and pass it the app. The SDK resolves `DiscoveryService` itself, so you do not import `@nestjs/core`:

```ts
evalkit.init({ subscriptionKey: "tk_live_...", serviceName: "orchestrator" });

const app = await NestFactory.create(AppModule);
await evalkit.enableNestjsAutoTrace(app);   // ← the only line you add
await app.listen(5000);
```

Route metadata such as `@Get`, `@Body` and guards is kept, and the call never throws.

## Trace your own code

Auto-instrumentation covers libraries. For your own code you opt in, per function, tool, class or whole service object:

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

A client-side tool that the model calls shows its output only if you wrap it with `traceTool`, because the SDK sees the model's request, not your function's return value. Server-side tools, such as OpenAI `web_search`, and LangChain tools are traced automatically.

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

## Identity

Every span can carry three ids. They group spans into sessions and users, and per-user limits are counted by them.

| Field | What it is | Where it shows up |
| --- | --- | --- |
| `sessionId` | One conversation or visit | The Sessions view: the turns in order, and cost and latency per session |
| `userId` | The end user your app authenticated | The Users view: volume, cost and failure rate per user, and per-user rate limits |
| `deviceId` | The installation or browser | Grouping before sign-in, when there is no user yet |

Set them for one trace:

```ts
import { startTrace } from "syntropylabs-evalkit";

const trace = startTrace("chat-turn", {
  userId: "u_8123",
  sessionId: "conv_55",
  deviceId: "web-9f2",
  attributes: { "chat.channel": "widget" },
});
```

Or set them once for everything that follows:

```ts
import { setUser, currentUser } from "syntropylabs-evalkit";

setUser({ userId: "u_8123", sessionId: "conv_55" });
setUser({ deviceId: "web-9f2" });   // merges with what is already set
setUser(null);                      // clears
```

Inside a trace, meaning under an active span such as a framework middleware, `startTrace` or `withTrace`, `setUser` binds the identity to that trace only, so one request never leaks its user into another. With no active span, it applies to the current async context from then on: the rest of a script or worker, or the rest of one request handler. On Node this is an `AsyncLocalStorage`, so two requests served at the same time never overwrite each other. Runtimes without it, such as browsers and some edge workers, fall back to one process-wide value.

Every span in the trace inherits the ids, including spans from third-party OpenTelemetry instrumentation. The ambient ids are captured when each span starts, and the trace ids are applied when it is exported.

`startTrace(name, attributes)` still works. A plain record is treated as attributes, and any accepted spelling of an id (listed below) becomes the trace identity, so its child spans carry it too.

For each field, the first of these that has a value wins:

1. what the span carries itself, in any spelling;
2. the nearest `startSpan` above it that named the id in its attributes;
3. the trace identity, from the `startTrace` options or attributes, or from `setUser` inside the trace;
4. the scope in force where the span started, from `withSession` or from `setUser` outside a span;
5. the `deviceId` given to `init()`.

`currentUser()` returns the identity in effect right now.

The accepted attribute spellings, first match wins:

| Id | Keys |
|---|---|
| session | `evalkit.session_id`, `session.id`, `conversation.id`, `gen_ai.conversation.id`, `session_id` |
| user | `evalkit.user_id`, `user.id`, `enduser.id`, `user_id` |
| agent | `evalkit.agent_name`, `gen_ai.agent.name`, `agent.name` |

### Sessions

Wrap one conversation turn so that every span it starts joins the session. The previous scope comes back afterwards:

```ts
import { withSession } from "syntropylabs-evalkit";

await withSession({ sessionId: "conv_55", userId: "u_8123" }, async () => {
  await agent.reply(message);
});
```

A trace without a session id has no session. It is still recorded, and it can still be evaluated on its own.

### Agents

Name the agent that your spans belong to. The name goes on the envelope as `agentName`, and on every span as both `evalkit.agent_name` and `gen_ai.agent.name`:

```ts
import { setAgent, startTrace, startSpan, withTrace } from "syntropylabs-evalkit";

setAgent("support-bot");                 // everything after this, scoped like setUser
setAgent(null);                          // clears

const turn = startTrace("chat-turn", { agentName: "support-bot" }); // this trace only
await withTrace(turn.ctx, async () => {
  // Spans started inside this one belong to the sub-agent.
  const research = startSpan("research", { "gen_ai.agent.name": "researcher" });
  await withTrace(research.ctx, () => runResearcher());
  research.end();
});
turn.end();
```

You do not declare agent versions. The version is an automatic fingerprint, shown under the agent name.

Without these ids a trace is still recorded, but it cannot be grouped into a session or attributed to a user.

## Offline evaluation

Offline evaluation scores locally and deterministically. It runs synchronously, and the result is sent as an `eval_result` span.

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

## Evaluation runs

An evaluation run sends a dataset of rows through server-side evaluators and reads back the pass rate, the per-row scores, a gate verdict and a comparison against a baseline run.

```ts
import { Eval } from "syntropylabs-evalkit";

const result = await Eval({
  name: "support-golden · pr-1234",
  data: rows,                                  // [{ input, output?, expected?, context?, metadata? }]
  task: (row) => myAgent(row.input),           // optional: produce output when rows have none
  evaluators: [
    "665f0c1234567890abcdef12",                // server rule id
    (row, output) => output.length < 400,      // local: bool, number, null or { score, passed, reason }
  ],
  judgeModel: "gpt-5-mini",
  baselineJobId: previousRun,                  // or autoBaseline: true
  gate: { minPassRate: 0.9, maxRegressionsVsBaseline: 0 },
  hyperparameters: { model: "gpt-5-mini", promptVersion: "v12", temperature: 0.2 },
});
console.log(result.url);                       // printed once as the run starts, too
if (result.passed !== true) process.exit(result.passed === false ? 1 : 2);   // null = undecided: fail closed
console.log(result.passRate, result.overallScores, result.comparison, result.localScores);
```

### Evaluators and collections by id

Every evaluator on the Evaluators page, from the gallery or your own, has an id, and so does every collection. **Use in code** on either one shows the id with a copy button, next to a snippet that runs it. Rule ids go in `evaluators` and collection ids in `collections`. You can mix the two, and add local scorers:

```ts
import evalkit, { Eval } from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY! });   // Settings → This project → Environments

const rows = [
  {
    input: "How long do I have to return an item?",
    output: "You can return it within 30 days of delivery.",
    expected: "30 days from delivery",
    context: "Items can be returned within 30 days of delivery.",
  },
  {
    input: "Do you ship to Canada?",
    output: "Yes, in 5 to 7 business days.",
    expected: "Yes, 5-7 business days",
    context: ["We ship to the US and Canada.", "Canadian orders arrive in 5-7 business days."],
  },
];

const result = await Eval({
  name: "support-suite",
  data: rows,
  evaluators: ["665f0c1234567890abcdef12"],    // rule ids
  collections: ["665f0c1234567890abcdefc0"],   // collection ids
  judgeModel: "gpt-5-mini",   // only needed when a rule has no judge model of its own
});
console.log(result.url);
console.log(result.passRate, result.averageScore, result.overallScores);
```

The server expands a collection into its rules, in the collection's order, and a rule named twice runs once.

With one collection, each row is scored the way the dashboard scores it: by the collection's weights, per-rule thresholds, aggregation (mean, weighted or min) and hard gates. Rule ids and local scorers next to it join as ordinary members with weight 1. With two or more collections there is no single aggregation to follow, so every rule runs once with weight 1 and passes on its own threshold, as rule ids alone do.

Only the evaluators and collections of your key's organization are accepted, including the gallery's managed evaluators. Any other id is refused in the same way as an id that does not exist: `Eval failed 404: Evaluation rule(s) not found: <id>`, or `Evaluator collection(s) not found: <id>`. A rule that a collection lists but your organization cannot use is named together with its collection.

A server too old for collections is detected when the run opens. The SDK then throws before it sends any row, instead of scoring only the rule ids.

`context` holds the row's retrieved documents, as one string or an array of strings.

### How a run is sent

1. `POST /evaluation-runs` creates the run and returns `{ runId, url, ruleIds }`, where `ruleIds` are the rules it will score after collections are expanded. The link is printed once while the rows upload (set `EVALKIT_QUIET=1` to silence it), and it is returned as `result.url`, with `result.runId`.
2. `POST /evaluation-runs/{runId}/rows` appends the rows in batches of at most 200 (`batchSize`, clamped to the server's cap). Every row carries its absolute `rowIndex`, so the server recognizes a row it already has. The SDK retries a failed batch twice, on a network error or a 5xx, with the identical payload, and nothing is counted twice.
3. `POST /evaluation-runs/{runId}/complete` judges every row, applies the gate over the whole run and compares it with the baseline. However many batches were uploaded, there is one job, one gate verdict and one comparison.

A row has the fields `input`, `output` (or a `task` that produces it), `expected` (`target` is still accepted), `metadata` and `context`. `context` is sent inside `metadata.context`.

### Local scorers

A run needs at least one server evaluator: a rule id (24 hex characters) in `evaluators`, or a collection id in `collections`. Local scorers are functions that run in your process. Their results travel with the row as `localScores` and show in the run results with the evaluator source `local`.

A scorer returns one of these, and anything else throws:

- a number;
- a boolean, which becomes the score 1 or 0 and a verdict;
- `null` or `undefined`, which means not applicable, and nothing is sent;
- `{ score, passed, reason }`.

### The result

`result.passed` is the gate verdict: `true`, `false`, or `null` when no gate was set or a check could not be decided. A check is undecided when there is no comparable baseline, when a `perMetricMinScore` metric was never scored, or when every row errored. Gate on `passed !== true`, not on `passed === false`, because the second lets an undecided run through. `averageScore` and `passRate` are `null` when they are undefined, never 0.

`result.localScores[label]` holds one score per row, with `null` kept.

The other options are `judgeModelConfigId`, `timeoutMs` (600 s per request by default) and `apiUrl`.

A deployment older than the append endpoints answers 404 on `POST /evaluation-runs/{runId}/rows`. The SDK then falls back to the earlier single-call behavior: one job per batch (`result.jobIds`), aggregates rolled up on the client, and `gateResult` and `comparison` set to `null` when there is more than one batch. The fallback is detected once per client, not once per batch. A 400 or 404 from `POST /evaluation-runs` itself, such as a validation error or an evaluator id that does not exist, is thrown as `Eval failed <status>: <the server's reason>` and is never mistaken for an old server. A run with `collections` never falls back, because the old endpoint cannot carry them.

### CI: `npx evalkit eval`

The same run from the command line, with the verdict as the exit code, so a pipeline step fails both when the gate fails and when the gate cannot be decided.

```bash
npx evalkit eval run eval.json                      # a JSON config
npx evalkit eval run evals/checkout.mjs             # a module: default export = Eval options
npx evalkit eval run evals/checkout.mjs --export smoke --json
npx evalkit eval gate <runId>                       # re-read the gate of a run made elsewhere
```

| Exit | Meaning |
|---|---|
| `0` | `gate.passed === true` |
| `1` | `gate.passed === false` |
| `2` | Undecided: `gate.passed === null`, or the run had no gate. Pass `--allow-undecided` to exit `0` instead |
| `3` | The run could not be created or read (bad config, HTTP error, no key) |

`eval.json` holds the `Eval()` options under their TypeScript names (`name`, `evaluators`, `collections`, `gate`, `judgeModel`, `baselineJobId`, `autoBaseline`, `hyperparameters`, `batchSize` and `timeoutMs`). It also holds either inline `data` or a `dataFile`, which is a `.json` array or a `.jsonl` file of rows, resolved relative to the config. The rows already contain their outputs:

```json
{
  "name": "checkout · ${GITHUB_SHA}",
  "dataFile": "rows.jsonl",
  "evaluators": ["665f0c1234567890abcdef12"],
  "judgeModel": "gpt-5-mini",
  "autoBaseline": true,
  "gate": { "minPassRate": 0.9, "maxRegressionsVsBaseline": 0 }
}
```

A module target is a `.mjs`, `.cjs` or `.js` file. Compile TypeScript first, or run under a loader such as `NODE_OPTIONS=--import=tsx`. Its default export, or the export named by `--export`, is one of these:

- an options object;
- a function, sync or async, that returns an options object, which is where a `task` and local scorers go;
- a function that runs `Eval()` itself and returns the finished `EvalResult`.

The key comes from `--key`, else `EVALKIT_API_KEY`, else the config that `evalkit coding install` stored. The API base comes from `--api-url`, else `EVALKIT_API_URL`, else `https://api.syntropylabs.ai`.

The command prints the run link, the pass rate and average score, the average per metric, one table row per gate check (name, threshold, actual, and passed, failed or undecided), and the verdict with its exit code. `--json` prints one object instead, `{ runId, jobId, url, name, totalRows, erroredRows, indeterminateRows, passRate, averageScore, overallScores, gate: { passed, checks, evaluatedAt }, verdict }`, which you can paste into a job summary or parse with `jq`.

```yaml
- run: npx evalkit eval run eval.json --json > eval-result.json
  env:
    EVALKIT_API_KEY: ${{ secrets.EVALKIT_API_KEY }}
```

`eval gate <runId>` reads `GET /evaluation-runs/{runId}` with the same key and applies the same exit codes. Use it when one pipeline job runs the evaluation and another job decides.

## Feedback and rewards

Attach a human or end-user signal to a trace your app already produced. It becomes a score on the trace next to judge scores, and RL dataset builds can use it as a reward.

```ts
import { feedback, reward } from "syntropylabs-evalkit";

await feedback({ traceId, kind: "thumbs", value: true, comment: "answered in one line", userId: "u_42" });
await feedback({ traceId, kind: "rating", value: 4, sessionId: "s_9" });
await feedback({ traceId, kind: "text", value: "too verbose", spanId });
await reward(traceId, 0.8, { name: "task_reward" });
```

| Kind | Value | Stored as |
|---|---|---|
| `thumbs` | `true` or `false`, `"up"` or `"down"`, or 1 or 0 | Numeric 1 or 0 |
| `rating` | A number from 1 to 5 | Numeric |
| `reward` | A number from 0 to 1 | Numeric |
| `text` | A non-empty string | Text |

Feedback of any kind has the source `end_user` when you pass a `userId`, else `sdk`. The optional fields are `apiUrl`, `timeoutMs`, `spanId`, `sessionId` and `name`. A failed call rejects with the HTTP status and body.

## Prompts

Fetch a versioned prompt from the registry, compile its `{{variables}}`, and stamp the calls it drives, so the UI shows usage per version. Reads use your subscription key and are cached for `cacheTtlMs`, 60 s by default.

```ts
import evalkit, { withPrompt } from "syntropylabs-evalkit";

const prompt = await evalkit.prompts.get("support_agent_system", { label: "production" });
const messages = prompt.compile({ customer: "Ada", plan: "pro" });

await withPrompt(prompt, () => openai.chat.completions.create({ model: "gpt-4o-mini", messages }));

await Eval({ name: "support-golden", data: rows, evaluators: [RULE_ID], hyperparameters: prompt.hyperparameters() });
```

| API | What it does |
|---|---|
| `evalkit.prompts.get(name, { label?, version?, variables?, apiUrl?, cacheTtlMs?, timeoutMs? })` | Resolves `version`, else `label`, else `production`, else the latest version. Passing both `version` and `label` throws. With `variables`, the server compiles the prompt, and local compilation is the fallback |
| `prompt.template`, `prompt.variables`, `prompt.config`, `prompt.semver`, `prompt.labels` | What the registry stores |
| `prompt.compile(variables)` | Local Mustache-style substitution. If variables are missing, it throws one error that names all of them |
| `withPrompt(prompt, fn)` | Every `llm_call` span started inside `fn` carries `prompt.ref` (`name@version`), `prompt.name` and `prompt.version`. Attributes you set yourself win. `evalkit.prompts.current()` reads the active ref |
| `prompt.stamp()` | Sets the same attributes on the span that is active now |
| `prompt.hyperparameters()` | `{ promptName, promptVersion }` for `Eval(...)`, so that runs link to the version |
| `evalkit.prompts.clearCache()` | Empties the read cache |

## Scenario simulation

Generate synthetic-user scenarios from your agent's prompt and tools, replay each one against your real agent, then grade the run with LLM-as-judge evaluators.

```ts
import evalkit from "syntropylabs-evalkit";

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "support-bot" });

// 1. Generate scenarios (bring your own key for the generation call)
const scenarios = await evalkit.generateScenarios({
  agentInstructions: SYSTEM_PROMPT,
  tools: ["search_kb", "lookup_order", "create_ticket"],
  count: 5,
  provider: "anthropic",
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// 2. Replay each scenario against your real agent
const { simulationId, runId, results } = await evalkit.simulateUser({
  scenarios,
  entrypoint: async (ctx) => {
    const { text, toolCalls } = await runAgent(ctx.sessionId, ctx.message);
    return { text, toolCalls };
  },
  tags: ["ci"],
});

// 3. Grade the run against an evaluator collection (LLM-as-judge, BYOK)
const result = await evalkit.evaluateSimulation({
  simulationId,
  collectionId: "665f0c...",          // Evaluators → Collections
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

`evaluateSimulation` returns scores per scenario and per criterion, with reasons. They also appear in the dashboard.

## Coding agents

The package ships an `evalkit` command (`npx evalkit …`) that points the telemetry of a coding agent at your EvalKit Environment. It supports Claude Code, Codex, Gemini CLI, Cursor, Windsurf and OpenCode. Each session then shows up as one trace per turn, covering the main agent, every subagent and everything they did. The `coding` commands import nothing from the tracing runtime. Only `evalkit eval` loads the SDK, and only when it runs.

```bash
npx evalkit coding install --vendor claude-code --key tk_live_...
npx evalkit coding install --vendor codex --key tk_live_...
npx evalkit coding install --vendor gemini-cli --key tk_live_... --capture full
npx evalkit coding install --vendor cursor --key tk_live_... --scope project
npx evalkit coding install --vendor opencode --key tk_live_...
npx evalkit coding status
npx evalkit coding doctor
npx evalkit coding uninstall --vendor codex
```

| Flag | Effect |
|---|---|
| `--endpoint` | The ingest endpoint, `https://api.syntropylabs.ai/v1/otlp` by default |
| `--tenant` | Optional. The tenant id that `doctor` reads traces back with. Without it, `doctor` reads `/v1/traces/me/…`, which receivers from 2026-09-15 on resolve from the key, so pass it only against an older receiver |
| `--scope user\|project` | `project` writes into the current directory |
| `--capture minimal\|full` | Whether prompt, reply and tool text leave your machine. `minimal` by default |
| `--no-traces` | Keep log events only. Spans are on by default wherever the vendor has them |
| `--no-subagents` | Claude Code only: write no hooks at all |
| `--dry-run` | Print what would be written, without writing it |
| `--managed` | Claude Code only: print a managed-settings snippet instead of writing the settings |

The key and endpoint are stored once, in `~/.config/evalkit/config.env` (mode 0600). `~/.config/evalkit/state.json` records exactly what was written, so `uninstall` removes only that and restores any value it replaced. The key is never printed.

### What you get per vendor

| Vendor | One tree per turn | Tool calls | Tool output | Prompt and reply | Subagents | Tokens and cost |
|---|---|---|---|---|---|---|
| `claude-code` | Yes, from the agent's own spans (`--no-traces` falls back to flat log events) | Yes | `--capture full` | `--capture full` | Yes, nested under the `Agent` tool call | Yes (tokens on the span, cost from the `api_request` event) |
| `codex` | Yes, the turn span. The receiver drops Codex's ~150 internal plumbing spans | When Codex emits them | `--capture full` | The prompt, with `--capture full` | No | Yes (`sse_event` tokens, `turn_cost`) |
| `gemini-cli` | Yes, from `agent_call`, `llm_call` and `tool_call` spans | Yes | No | `--capture full` | `agent_call` spans | Tokens yes, cost no |
| `cursor` | Yes, built by the hooks with deterministic span ids | Yes | `--capture full` | `--capture full` | Yes (`subagentStart` and `subagentStop`) | No, Cursor's hooks carry neither |
| `windsurf` | Yes, built the same way as for Cursor | Yes | `--capture full` | `--capture full` | No (Cascade has no subagent events) | No |
| `opencode` | Yes, built by the plugin | Yes | `--capture full` | `--capture full` | Child sessions nest under their parent turn | When OpenCode reports them on the assistant message |

### What `install` writes

#### Claude Code

`install` writes `env` keys to `~/.claude/settings.json`, or to `.claude/settings.json` with project scope: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, the endpoint, an `Authorization=Bearer` header and the resource attribute `evalkit.vendor=claude-code`. Span mode is on by default (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp` and `OTEL_TRACES_EXPORT_INTERVAL=1000`), and `--no-traces` removes those three. The same file drives the VS Code and JetBrains versions of Claude Code.

`--capture full` adds `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES`, plus `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=524288`. Claude Code cuts each body at 60 KB by default, which is smaller than its own system prompt, so the cap is raised to 512 K characters.

In span mode, Claude Code opens one trace per turn: a `claude_code.interaction` root with `llm_request` and `tool` children, and a subagent's work nested under the execution span of the `Agent` tool. Content and cost still arrive as log events (`api_request`, `api_request_body`, `api_response_body`, `assistant_response`, `user_prompt`, `tool_result` and `subagent_completed`), and the receiver merges each one onto the matching span by trace and span id. Unless you pass `--no-subagents`, `PostToolUse` and `SubagentStop` hooks post `claude_code.tool_output` and `claude_code.subagent_stop`, so the output of non-Bash tools and the subagent's last message are covered too. The hooks time out after 5 s and always exit 0.

`uninstall` deletes those keys and restores the previous values, including a key you had already set to the value EvalKit writes. It removes only the hooks whose command contains `coding hook --vendor claude-code`. Files written under the other `--scope` are remembered too.

#### Codex

`install` writes an `[otel]` table between `# evalkit-managed-begin/end` markers in `~/.codex/config.toml`, or in `.codex/config.toml` with project scope. The table has log, trace and metrics exporters pointing at `<endpoint>/v1/{logs,traces,metrics}`, and `--no-traces` writes `trace_exporter = "none"`. `install` refuses to run if an `[otel]` table already exists outside the markers.

The data comes from Codex's native export: the turn span plus `codex.api_request`, `sse_event` token counts, `turn_cost`, `tool_result` and `user_prompt`. The event names are in the `event.name` attribute. `uninstall` removes the block.

#### Gemini CLI

`install` writes a `telemetry` block in `~/.gemini/settings.json` (`otlpProtocol: http`, `traces: true` unless `--no-traces`, and `logPrompts` false unless `--capture full`). It also writes the `OTEL_EXPORTER_OTLP_HEADERS` line between `# evalkit-begin/end` markers in `~/.gemini/.env`.

The data comes from Gemini CLI's native spans, whose `gen_ai.operation.name` is `agent_call`, `llm_call` or `tool_call`, plus `gemini_cli.*` events correlated by `prompt_id`. `uninstall` restores the previous `telemetry` values and removes the marker block.

#### Cursor

`install` adds 12 hook entries (`npx evalkit coding hook --vendor cursor --event …`, with a 5 s timeout) to `~/.cursor/hooks.json` and leaves other hooks alone.

Cursor has no telemetry export, so the hook builds the trace itself, with ids derived like this:

| Id | Derived from |
|---|---|
| Trace id | `sha256(conversation_id + generation_id)[:32]` |
| Turn root span id | `sha256(generation_id)[:16]` |
| Tool span id | `sha256(tool_use_id)[:16]`, starting at the current time minus `duration` |
| Subagent span id | `sha256(subagent_id)[:16]`, with the parent `sha256(tool_call_id)[:16]` |

`beforeSubmitPrompt` opens the turn, `afterAgentResponse` and `stop` complete it with an enrichment record, and `subagentStop` completes the subagent. `uninstall` removes only the entries whose command contains `coding hook --vendor cursor`, and a reinstall also drops entries for events that EvalKit no longer uses.

#### Windsurf

`install` adds 6 hook entries to `~/.codeium/windsurf/hooks.json`, or to `.windsurf/hooks.json` with project scope. The trace is built the same way as for Cursor, with `trajectory_id` as the session and `execution_id` as the turn. `post_run_command`, `post_write_code`, `post_read_code` and `post_mcp_tool_use` become tool spans, and `post_cascade_response` completes the turn. `uninstall` works as it does for Cursor.

#### OpenCode

`install` writes the plugin to `~/.config/opencode/plugins/evalkit.ts`, with no key inside, and adds a `"plugin"` entry to `~/.config/opencode/opencode.json`. Project scope writes `.opencode/plugins/evalkit.ts` and `opencode.json` in the current directory.

The plugin turns `session.*`, `message.updated`, `message.part.updated` and `tool.execute.before|after` into the same span shapes. It reads the key from `~/.config/evalkit/config.env` when it runs, and posts OTLP JSON. `uninstall` deletes the plugin file and removes only the EvalKit entry from `"plugin"`.

### `status`, `doctor` and `hook`

`status` prints the endpoint, the masked key, the capture level and the last `doctor` result. For each vendor it also prints the scope, the capture level, whether traces are on and which hooks are installed.

`doctor` posts one synthetic turn: an `agent` root with an `llm_call` child and a `tool_call` child, plus one enrichment record. It then reads `GET <api>/v1/traces/<tenant>/<traceId>` back with the same key and checks that the merged tree came back, with 3 spans and the prompt present.

The read API scopes traces by tenant. Without `--tenant`, the tenant in the path is `me`, which receivers from 2026-09-15 on resolve to the key's tenant, so a plain `npx evalkit coding doctor` works against a current receiver. Pass `--tenant`, which is remembered in `config.env`, only against an older receiver. An older receiver answers the `me` read with 403, and `doctor` reports `read back forbidden at <url>: this receiver predates the 'me' alias; pass --tenant <your tenant id> or update the receiver`.

A `--tenant` that the key does not belong to reports `read back forbidden at <url>: the key belongs to a different tenant than '<tenant>'`, and any other failed read ends with `… at <url>`. The URL in the message is the one that was read, and the `→ exporter <endpoint>` after it is the ingest endpoint.

The `hook` subcommand always exits 0, never writes to stdout, and gives up after 5 seconds, so it cannot block the editor.

## Privacy: content capture and masking

Two controls work independently. `captureContent` turns payload capture off as a whole, and `mask` edits or drops single spans.

```ts
evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,
  captureContent: false,
});
```

`captureContent: false` keeps every metric and drops every payload. You still get tokens, cost, latency, time to first token, model, provider, finish reason, status, errors, tool names and call IDs, the span hierarchy, and `db.system`, `db.operation` and row counts. You lose prompts, completions, thinking text, request and response bodies and headers, tool arguments and results, traced-function arguments and return values, SQL text and bound parameters, retriever queries, and log message bodies. Stripped spans carry `evalkit.content_captured=false`, so the dashboard can tell "capture is off" apart from "the SDK failed to read the body".

An environment variable can set it too, which helps when the same image ships to several environments:

```bash
export EVALKIT_CAPTURE_CONTENT=false
# or the standard OpenTelemetry variable, which EvalKit also honours:
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
```

The order of precedence is the `captureContent` option, then `EVALKIT_CAPTURE_CONTENT`, then `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`. With none of them set, capture is on. EvalKit's switch is broader than the OpenTelemetry one on purpose. The OpenTelemetry variable is defined for GenAI message content only, but turning it off here also removes database statements and traced-function arguments.

For finer control, pass a `mask` callback. It runs on every envelope right before it is batched for export, whichever instrumentation produced it. That includes spans from third-party OpenTelemetry instrumentation in `attached` mode.

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

Change the envelope and return it, or return `null` to drop it. If the hook throws, or returns anything other than an envelope or `null`, the span is dropped and a warning is logged. A mask exists to keep content inside the process, so it fails closed and never exports the span unmasked. It is the only place in the SDK that fails closed. Everywhere else an instrumentation failure is swallowed, and only tracing is lost, never your app.

When both are set, `captureContent` applies first, so `mask` sees the envelope already stripped.

### Secrets are masked before export

Every envelope goes through a secret scrubber before your `mask` hook runs and before anything leaves the process. It runs whether content capture is on or off, so turning capture off only ever removes more. The scrubber masks secrets by key, by pattern and by URL.

#### By key

A value is replaced by `"***"` when its object key matches one of these names, ignoring case, as the whole key or as one segment delimited by dots, underscores or dashes. This applies recursively through objects and arrays, and through attribute values that are JSON strings, which are parsed, scrubbed and serialized again:

`api_key`, `api-key`, `apikey`, `secret`, `token`, `password`, `passwd`, `authorization`, `credential`, `credentials`, `subscription_key`, `subscription-key`, `x-subscription-key`, `cookie`, `set-cookie`, `private_key`, `access_key`, `client_secret`.

So `subscriptionKey`, `X-Subscription-Key`, `http.request.api_key` and `credentials.password` are all masked. `token` is the one name matched only as the whole key or as the last segment, because it is also telemetry vocabulary. `prompt_token_count`, `gen_ai.server.time_to_first_token_ms`, `input_tokens` and `tokenizer` are metrics, not credentials, and masking them would blank a dashboard column and protect nothing.

Booleans and numbers under a matching key also become `"***"`, so the shape of the value gives nothing away. `http.request.headers` and `http.response.headers` also go through the list of sensitive headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `api-key`, `x-auth-token`, `proxy-authorization`, `x-secret`, `x-access-token`, `x-subscription-key`, `subscription-key`, `token` and `password`.

#### By pattern

Inside any string, including attributes, event attributes, the operation, the prompt, the completion and the status message, these patterns are replaced by their prefix followed by `***`:

| Pattern | Becomes |
| --- | --- |
| `tk_live_[0-9a-f]{8,}` | `tk_live_***` |
| `tk_test_[0-9a-f]{8,}` | `tk_test_***` |
| `sk-[A-Za-z0-9_-]{16,}` | `sk-***` |
| `Bearer\s+[A-Za-z0-9._~+/=-]{8,}` | `Bearer ***` |
| `AKIA[0-9A-Z]{16}` | `AKIA***` |
| `ghp_[A-Za-z0-9]{20,}` | `ghp_***` |

A string with no secret in it is left exactly as it was, JSON strings included. Nothing is reformatted on the way through.

#### By URL

`http.url`, `url.full`, `http.target`, `url.query` and `server.address` are always read as URLs. So is any other attribute value, including values nested inside JSON strings, that is a single `http://`, `https://`, `ws://` or `wss://` URL and nothing else.

Userinfo is masked, so `https://user:pass@host/x` becomes `https://***@host/x`. A query or fragment parameter has its value replaced by `***` when its key is on the by-key list or the sensitive-header list, or when `key`, `sig` or `signature` is the whole key or its last segment. Keys are matched ignoring case, after URL decoding. Every other parameter keeps its value and position, so `?api_key=AKIA…&page=2` becomes `?api_key=***&page=2`, and `?q=hello` is left alone. A URL inside prose, such as a prompt, a completion, an operation name or a log line, is free text and only goes through the pattern list.

Identity is not masked, on purpose. Email addresses, user IDs, session IDs and device IDs pass through as they are, because the Users view, per-user cost and session replay are built on them.

To turn the scrubber off, usually to debug your own auth failure:

```ts
evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, captureSecrets: true });
// or
export EVALKIT_CAPTURE_SECRETS=1
```

With the scrubber off, credential headers are recorded exactly as they were sent. With it on, which is the default, the values are masked and the header names are kept.

## Configuration

| Option | Description |
| --- | --- |
| `subscriptionKey` | The Environment's subscription key. Required |
| `serviceName` | The service name attached to every trace |
| `environment` | An environment name recorded on every span, such as `"production"` |
| `baseUrl` | The trace ingest endpoint. Defaults to the hosted one |
| `apiUrl` | The control-plane endpoint, used for scenarios and simulation |
| `maxBodyBytes` | The largest HTTP body captured, 10 MB by default |
| `captureContent` | Capture prompts, bodies and arguments. On by default, see [Privacy](#privacy-content-capture-and-masking) |
| `captureSecrets` | Record credentials instead of masking them. Off by default, see [Privacy](#privacy-content-capture-and-masking) |
| `mask` | `(envelope) => envelope \| null`, which rewrites or drops each span before export |

The exported `EvalKitOptions` type has the full set, including `appVersion`, `deviceId`, `debug` and the batch settings.

`EVALKIT_API_URL` overrides the control-plane base URL for `Eval()`, feedback and prompts. `EVALKIT_QUIET=1` silences the evaluation-run link, and `EVALKIT_CAPTURE_SECRETS=1` turns off secret masking.

## Coexisting with an OpenTelemetry setup you already have

`init()` never replaces a `TracerProvider` you configured. It picks one of three modes and reports it on `client.tracingMode`:

| Your process | What `init()` does | `tracingMode` |
| --- | --- | --- |
| No OpenTelemetry SDK started | Creates a provider with EvalKit's batch exporter and registers it as the global, with the async-hooks context manager and the W3C propagators | `owned` |
| An OpenTelemetry SDK is already registered | Adds EvalKit's span processor to that provider. Your OTLP, Jaeger or Datadog exporters keep receiving every span, and EvalKit also receives the spans your own instrumentation produces | `attached` |
| `tracerProvider` passed to `init()` | Adds EvalKit's span processor to that provider and changes no global state | `attached` |

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";

const sdk = new NodeSDK({ /* your exporters, sampler, resource */ });
sdk.start();

evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, serviceName: "my-service" });
```

Start your OpenTelemetry SDK before `init()`. OpenTelemetry JS refuses a second global registration, so whichever side registers second is cut off without an error, and its spans go missing. When your SDK starts first, EvalKit attaches to it. If EvalKit finds a provider it cannot attach to, it warns once and falls back to its own pipeline. EvalKit API spans are still exported then, but the spans from your instrumentation are not.

A library that must not touch process-wide state should pass its provider explicitly:

```ts
evalkit.init({
  subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!,
  serviceName: "my-service",
  tracerProvider: myProvider,
});
```

Do not add an EvalKit exporter to that provider yourself. EvalKit attaches exactly one export pipeline per provider, and ingest is append-only, so a span sent twice counts twice in the token and cost totals.

`client.destroy()` follows the mode. It shuts down a provider that EvalKit created. Otherwise it flushes and detaches only EvalKit's own span processor, and your tracing keeps running. In `attached` mode your resource sets `service.name`, and `serviceName` is the fallback when the resource has none, or has OpenTelemetry's `unknown_service:` placeholder.

## Links

- [syntropylabs.ai](https://syntropylabs.ai)
- [Documentation](https://syntropylabs.ai/docs)

## License

Apache License 2.0. See [LICENSE](./LICENSE).
