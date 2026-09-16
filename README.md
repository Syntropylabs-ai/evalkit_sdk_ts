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
- [Identity](#identity)
- [Offline evaluation](#offline-evaluation)
- [Evaluation runs](#evaluation-runs)
- [Prompts](#prompts)
- [Scenario simulation](#scenario-simulation)
- [Coding agents](#coding-agents-claude-code--codex--gemini-cli--cursor--windsurf--opencode)
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

## Identity

Every span can carry three ids. They are what turns a pile of spans into sessions and
users, and they are how per-user limits are counted.

| Field | What it is | Where it shows up |
|---|---|---|
| `sessionId` | one conversation, one visit | Sessions view: the turns in order, cost and latency per session |
| `userId` | the end user your app authenticated | Users view: volume, cost and failure rate per user; per-user rate limits |
| `deviceId` | the installation or browser | grouping before sign-in, when there is no user yet |

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

Or once, for everything that follows:

```ts
import { setUser, currentUser } from "syntropylabs-evalkit";

setUser({ userId: "u_8123", sessionId: "conv_55" });
setUser({ deviceId: "web-9f2" });   // merges with what is already set
setUser(null);                      // clears
```

- Called inside a trace (an active span — a framework middleware, `startTrace`,
  `withTrace`), `setUser` binds the identity to that trace only, so a request never
  leaks its user into another one. Called with no active span it sets a process-wide
  default, which is what you want in a script or a worker.
- Every span in the trace inherits the ids, including spans from third-party
  OpenTelemetry instrumentation, because they are resolved per trace at export time.
- `startTrace(name, attributes)` still works: a plain record of attributes is treated
  as attributes, and the `evalkit.user_id` / `evalkit.session_id` /
  `evalkit.device_id` spellings are picked up as identity as well.
- Precedence: what a span carries itself, then the trace's identity, then the process
  default, then the `deviceId` given to `init()`.
- `currentUser()` returns what is in effect right now.

Without these ids a trace is still recorded — it just cannot be grouped into a session
or attributed to a user.

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

## Evaluation runs

Run a dataset of rows through server-side evaluators and read back the pass rate,
per-row scores, a gate verdict and a comparison against a baseline run.

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
if (result.passed === false) process.exit(1);
console.log(result.passRate, result.overallScores, result.comparison, result.localScores);
```

### How a run is sent

1. `POST /evaluation-runs` creates the run and answers `{ runId, url }`. The link is
   printed once while the rows upload — set `EVALKIT_QUIET=1` to silence it — and is
   returned as `result.url` (with `result.runId`).
2. Rows are appended with `POST /evaluation-runs/{runId}/rows` in batches of at most
   200 rows (`batchSize`, clamped to the server cap). Every row carries its absolute
   `rowIndex`, so the server recognises a row it already has: the SDK retries a failed
   batch twice (network error or 5xx) with the identical payload and nothing is
   counted twice.
3. `POST /evaluation-runs/{runId}/complete` judges every row, applies the gate over
   the whole run and compares it against the baseline. One job, one gate verdict, one
   comparison, however many batches were uploaded.

Row fields: `input`, `output` (or a `task` that produces it), `expected` (`target` is
still accepted), `metadata`, and `context` — which is sent inside `metadata.context`.

### Local scorers

`evaluators` must include at least one server rule id (24 hex characters). Functions
run in your process and their results travel with the row as `localScores`, showing up
in the run results with evaluator source `local`. Return a number, a boolean (score
1/0 plus a verdict), `null` / `undefined` (not applicable — nothing is sent), or
`{ score, passed, reason }`. Anything else throws.

### Notes

- `result.passed` is the gate verdict: `true` / `false`, or `null` when no gate was
  set or a check could not be decided. `averageScore` and `passRate` are `null` when
  undefined — never 0.
- `result.localScores[label]` is one score per row, `null` preserved.
- Other options: `judgeModelConfigId`, `timeoutMs` (default 600 s per request),
  `apiUrl`.
- Against a deployment older than the append endpoints the SDK falls back to the
  previous single-call behaviour: one job per batch (`result.jobIds`), aggregates
  rolled up client-side, and `gateResult` / `comparison` `null` above one batch. The
  fallback is detected once per client, not once per batch.

## Feedback and rewards

Attach a human or end-user signal to a trace your app already produced. It becomes a score on the trace, next to judge scores, in Annotate and in calibration.

```ts
import { feedback, reward } from "syntropylabs-evalkit";

await feedback({ traceId, kind: "thumbs", value: true, comment: "answered in one line", userId: "u_42" });
await feedback({ traceId, kind: "rating", value: 4, sessionId: "s_9" });
await feedback({ traceId, kind: "text", value: "too verbose", spanId });
await reward(traceId, 0.8, { name: "task_reward" });
```

| kind | value | stored as |
|---|---|---|
| `thumbs` | `true`/`false`, `"up"`/`"down"`, or 1/0 | numeric 1 or 0 |
| `rating` | any number (your scale) | numeric |
| `reward` | 0..1 | numeric, source `end_user` when `userId` is given, else `sdk` |
| `text` | non-empty string | text |

Optional: `apiUrl`, `timeoutMs`, `spanId`, `sessionId`, `name`. Failures reject with the HTTP status and body.

## Prompts

Fetch a versioned prompt from the registry, compile its `{{variables}}`, and stamp the calls it drives so usage shows up per version in the UI. Reads use your subscription key and are cached for `cacheTtlMs` (default 60 s).

```ts
import evalkit, { withPrompt } from "syntropylabs-evalkit";

const prompt = await evalkit.prompts.get("support_agent_system", { label: "production" });
const messages = prompt.compile({ customer: "Ada", plan: "pro" });

await withPrompt(prompt, () => openai.chat.completions.create({ model: "gpt-4o-mini", messages }));

await Eval({ name: "support-golden", data: rows, evaluators: [RULE_ID], hyperparameters: prompt.hyperparameters() });
```

| | |
|---|---|
| `evalkit.prompts.get(name, { label?, version?, variables?, apiUrl?, cacheTtlMs?, timeoutMs? })` | resolution: `version` → `label` → `production` → latest; `variables` asks the server to compile and falls back to local compilation |
| `prompt.template`, `prompt.variables`, `prompt.config`, `prompt.semver`, `prompt.labels` | what the registry stores |
| `prompt.compile(variables)` | local Mustache-style substitution; a missing variable throws naming every missing one |
| `withPrompt(prompt, fn)` | every `llm_call` span started inside `fn` carries `prompt.ref` (`name@version`), `prompt.name`, `prompt.version`; explicit attributes win; `evalkit.prompts.current()` reads the active ref |
| `prompt.stamp()` | sets the same attributes on the currently active span |
| `prompt.hyperparameters()` | `{ promptName, promptVersion }` for `Eval(...)`, so runs link to the version |
| `evalkit.prompts.clearCache()` | drop cached reads |

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

## Coding agents (Claude Code · Codex · Gemini CLI · Cursor · Windsurf · OpenCode)

The package ships an `evalkit` command (`npx evalkit …`) that points a coding agent's own telemetry at your EvalKit environment so its sessions appear as one trace per turn — the main agent, every subagent and everything they did. The command imports nothing from the tracing runtime:

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

Flags: `--endpoint` (default `https://api.syntropylabs.ai/v1/otlp`), `--tenant` (optional: the tenant id `doctor` reads traces back with; without it doctor reads `/v1/traces/me/…`, which a receiver from 2026-09-15 on resolves from the key, so pass it only against an older receiver), `--scope user|project` (project writes into the current directory), `--capture minimal|full` (whether prompt, reply and tool text leave your machine; default minimal), `--no-traces` (keep log events only — spans are on by default wherever the vendor has them), `--no-subagents` (Claude Code: write no hooks at all), `--dry-run`, `--managed` (Claude Code: print a managed-settings snippet instead of writing).

The key and endpoint are stored once in `~/.config/evalkit/config.env` (mode 0600); `~/.config/evalkit/state.json` records exactly what was written so `uninstall` removes only that and restores any value it replaced. The key is never printed.

### What you get per vendor

| Vendor | One tree per turn | Tool calls | Tool output | Prompt & reply | Subagents | Tokens & cost |
|---|---|---|---|---|---|---|
| `claude-code` | yes — the agent's own spans (`--no-traces` falls back to flat log events) | yes | `--capture full` | `--capture full` | yes, nested under the `Agent` tool call | yes (tokens on the span, cost from the `api_request` event) |
| `codex` | yes — the turn span; Codex's ~150 internal plumbing spans are dropped by the receiver | when Codex emits them | `--capture full` | prompt with `--capture full` | no | yes (`sse_event` tokens, `turn_cost`) |
| `gemini-cli` | yes — `agent_call` / `llm_call` / `tool_call` spans | yes | no | `--capture full` | `agent_call` spans | tokens yes, cost no |
| `cursor` | yes — built by the hooks with deterministic span ids | yes | `--capture full` | `--capture full` | yes (`subagentStart` / `subagentStop`) | no — Cursor's hooks carry neither |
| `windsurf` | yes — same construction | yes | `--capture full` | `--capture full` | no (Cascade has no subagent events) | no |
| `opencode` | yes — built by the plugin | yes | `--capture full` | `--capture full` | child sessions nest under their parent turn | when OpenCode reports them on the assistant message |

### What `install` writes

| Vendor | What `install` writes | How data flows | Remove |
|---|---|---|---|
| `claude-code` | `env` keys in `~/.claude/settings.json` (or `.claude/settings.json`): `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_*_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`, endpoint, `Authorization=Bearer` header, resource attribute `evalkit.vendor=claude-code`; span mode is on by default (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, `OTEL_TRACES_EXPORTER=otlp`, `OTEL_TRACES_EXPORT_INTERVAL=1000`) and `--no-traces` removes those three; `--capture full` adds `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` and `OTEL_LOG_RAW_API_BODIES` plus `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH=524288` — Claude Code cuts each body at 60 KB by default, which is smaller than its own system prompt, so the cap is raised to 512 K characters. The same file drives the VS Code and JetBrains flavours | In span mode Claude Code opens one trace per turn: a `claude_code.interaction` root with `llm_request` and `tool` children, and a subagent's work nested under the `Agent` tool's execution span. Content and cost still arrive as log events (`api_request`, `api_request_body` / `api_response_body`, `assistant_response`, `user_prompt`, `tool_result`, `subagent_completed`) which the receiver merges onto the matching span by trace and span id. Unless `--no-subagents`, `PostToolUse` and `SubagentStop` hooks (5 s timeout, always exit 0) post `claude_code.tool_output` and `claude_code.subagent_stop` so non-Bash tool output and the subagent's last message are covered too | `uninstall` deletes those keys, restores previous values — including a key you had already set to the same value we write — and removes only the hooks whose command contains `coding hook --vendor claude-code`. Files written under the other `--scope` are remembered too |
| `codex` | an `[otel]` table between `# evalkit-managed-begin/end` markers in `~/.codex/config.toml` (or `.codex/config.toml`) with log, **trace** and metrics exporters pointing at `<endpoint>/v1/{logs,traces,metrics}`; `--no-traces` writes `trace_exporter = "none"`; refuses to run if an `[otel]` table already exists outside the markers | Codex's native export: the turn span plus `codex.api_request`, `sse_event` token counts, `turn_cost`, `tool_result`, `user_prompt` (event names live in the `event.name` attribute) | `uninstall` removes the block |
| `gemini-cli` | `telemetry` block in `~/.gemini/settings.json` (`otlpProtocol: http`, `traces: true` unless `--no-traces`, `logPrompts` false unless `--capture full`) and the `OTEL_EXPORTER_OTLP_HEADERS` line between `# evalkit-begin/end` markers in `~/.gemini/.env` | Gemini CLI's native spans (`gen_ai.operation.name` = `agent_call` / `llm_call` / `tool_call`) plus `gemini_cli.*` events correlated by `prompt_id` | `uninstall` restores the previous `telemetry` values and removes the marker block |
| `cursor` | 12 hook entries (`npx evalkit coding hook --vendor cursor --event …`, 5 s timeout) in `~/.cursor/hooks.json`; other hooks untouched | Cursor has no telemetry export, so the hook **builds the trace itself**: trace id = `sha256(conversation_id + generation_id)[:32]`, turn root span id = `sha256(generation_id)[:16]`, tool span id = `sha256(tool_use_id)[:16]` (start = now − `duration`), subagent span id = `sha256(subagent_id)[:16]` parented to `sha256(tool_call_id)[:16]`. `beforeSubmitPrompt` opens the turn, `afterAgentResponse` / `stop` complete it with an enrichment record, `subagentStop` completes the subagent | `uninstall` removes only entries whose command contains `coding hook --vendor cursor`; a reinstall also drops entries for events we no longer use |
| `windsurf` | 6 hook entries in `~/.codeium/windsurf/hooks.json` (project scope: `.windsurf/hooks.json`) | same construction with `trajectory_id` as the session and `execution_id` as the turn; `post_run_command`, `post_write_code`, `post_read_code` and `post_mcp_tool_use` become tool spans, `post_cascade_response` completes the turn | same |
| `opencode` | `~/.config/opencode/plugins/evalkit.ts` (the plugin, no key inside) and a `"plugin"` entry in `~/.config/opencode/opencode.json`; project scope writes `.opencode/plugins/evalkit.ts` and `opencode.json` in the current directory | the plugin turns `session.*`, `message.updated`, `message.part.updated` and `tool.execute.before|after` into the same span shapes, reads the key from `~/.config/evalkit/config.env` at run time, and posts OTLP JSON | `uninstall` deletes the plugin file and removes only our entry from `"plugin"` |

`status` prints the endpoint, the masked key, the capture level, the last `doctor` result and, per vendor, the scope, capture level, whether traces are on and which hooks are installed. `doctor` posts one synthetic turn — an `agent` root with an `llm_call` and a `tool_call` child, plus one enrichment record — then reads `GET <api>/v1/traces/<tenant>/<traceId>` back with the same key and checks the merged tree came back (3 spans, prompt present); the read API scopes traces by tenant, and without `--tenant` the path tenant is `me`, which a receiver from 2026-09-15 on resolves to the key's tenant — so the plain `npx evalkit coding doctor` works against a current receiver. Pass `--tenant` (remembered in `config.env`) only against a receiver older than that: it answers the `me` read with 403 and doctor reports `read back forbidden at <url>: this receiver predates the 'me' alias; pass --tenant <your tenant id> or update the receiver`. A `--tenant` the key does not belong to reports `read back forbidden at <url>: the key belongs to a different tenant than '<tenant>'`, and any other failed read ends `… at <url>`; the URL in the message is the one that was read, and the `→ exporter <endpoint>` after it is the ingest endpoint. The `hook` subcommand always exits 0, never writes to stdout, and gives up after 5 seconds so it can never block the editor.

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

### Secrets are masked before export

Every envelope goes through a secret scrubber before your `mask` hook runs and before anything
leaves the process. It runs whether or not content capture is on: turning capture off removes
strictly more, never less.

**By key.** Any object key matching one of these, case-insensitively, as the whole key or as a
dot/underscore/dash-delimited segment, has its value replaced by `"***"` — recursively through
objects and arrays, and through attribute values that are JSON strings, which are parsed, scrubbed
and re-serialized:

`api_key` / `api-key` / `apikey`, `secret`, `token`, `password`, `passwd`, `authorization`,
`credential`, `credentials`, `subscription_key` / `subscription-key`, `x-subscription-key`,
`cookie`, `set-cookie`, `private_key`, `access_key`, `client_secret`.

So `subscriptionKey`, `X-Subscription-Key`, `http.request.api_key` and `credentials.password` are
all masked. `token` is the one word matched only as the whole key or the *final* segment, because it
is also telemetry vocabulary: `prompt_token_count`, `gen_ai.server.time_to_first_token_ms`,
`input_tokens` and `tokenizer` are metrics, not credentials, and masking them would blank out a
dashboard column to protect nothing.
Booleans and numbers under a matching key become `"***"` as well, so the value's shape never hints
at what was there. `http.request.headers` and `http.response.headers` additionally go through the
sensitive-header list (`authorization`, `cookie`, `set-cookie`, `x-api-key`, `api-key`,
`x-auth-token`, `proxy-authorization`, `x-secret`, `x-access-token`, `x-subscription-key`,
`subscription-key`, `token`, `password`).

**By pattern.** Inside any string — attributes, event attributes, prompt, completion, status
message — these are replaced by their own prefix followed by `***`:

| Pattern | Becomes |
| ---------------------------------- | ------------- |
| `tk_live_[0-9a-f]{8,}`             | `tk_live_***` |
| `tk_test_[0-9a-f]{8,}`             | `tk_test_***` |
| `sk-[A-Za-z0-9_-]{16,}`            | `sk-***`      |
| `Bearer\s+[A-Za-z0-9._~+/=-]{8,}`  | `Bearer ***`  |
| `AKIA[0-9A-Z]{16}`                 | `AKIA***`     |
| `ghp_[A-Za-z0-9]{20,}`             | `ghp_***`     |

Strings that contain no secret are left byte for byte, JSON strings included — nothing is
reformatted on the way through.

Identity is deliberately **not** masked. Email addresses, user IDs, session IDs and device IDs pass
through untouched: they are what the Users view, per-user cost and session replay are built on. A
credential is never yours to lose; an identity is the product.

To turn the scrubber off — debugging your own auth failure is the usual reason:

```ts
evalkit.init({ subscriptionKey: process.env.EVALKIT_SUBSCRIPTION_KEY!, captureSecrets: true });
// or
export EVALKIT_CAPTURE_SECRETS=1
```

With the scrubber off, credential headers are recorded exactly as they were sent; with it on (the
default) their values are masked but the header names stay, so you can still see what was sent.

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
| `captureSecrets`  | Record credentials instead of masking them (default off; see [Privacy](#privacy-content-capture-and-masking)). |
| `mask`            | `(envelope) => envelope \| null` — rewrite or drop each span before export. |

See the exported `EvalKitOptions` type for the full set (`appVersion`, `deviceId`,
`debug`, batch tuning).

Environment variables: `EVALKIT_API_URL` overrides the control-plane base for `Eval()`,
feedback and prompts; `EVALKIT_QUIET=1` silences the evaluation-run link;
`EVALKIT_CAPTURE_SECRETS=1` turns off secret masking.

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
