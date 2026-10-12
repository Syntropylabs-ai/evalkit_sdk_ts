# Changelog

## 0.3.4 — 2026-10-12

### Added
- `simulateUser()` plays a live simulated user. After a scenario's scripted turns, or when it has
  none, the platform plays the user from the scenario's persona, `user_goal`, `hidden_info` and
  tool fixtures, and the user stops once its goal is met or `maxTurns` user turns were played (at
  most 50). New options: `userModel` (the model configuration the user runs on, by name or id;
  falls back to `model`) and `liveUser` (on by default for a scenario with a `user_goal` or
  `conversation_plan` and no `turns`). `AgentTurnResult.toolCalls` take `result` and `error`,
  which reach the user as what the agent was told. Each user turn is its own span marked
  `evalkit.simulation.role: user`. Live results carry `transcript`, `endedBy` and
  `simulatedUserUsage`. Needs the platform's `POST /simulations/user-turn` (paid plans with
  simulations).
- `generateScenarios()` writes scenarios for the live user by default; pass `scriptedTurns: true`
  for every turn written out.

### Changed
- A 429 from the receiver is retried like a 5xx instead of dropping the spans. On a 429 or 503,
  `Retry-After` (seconds or an HTTP-date) sets the wait, capped at 10 s; without it the backoff
  steps (200 ms, 600 ms, 1.8 s) are jittered so clients refused together do not retry together.
  One export spends at most 20 s waiting across all its requests, inside the BatchSpanProcessor's
  30 s export timeout. A 429 that outlasts the retries stops the rest of that export, as a 5xx
  does. Every other 4xx is still final.

## 0.3.3 — 2026-10-11

### Added
- Export requests are gzip-compressed and sent with `Content-Encoding: gzip`. Pass
  `exportGzip: false` to `init()`, or set `EVALKIT_EXPORT_GZIP=false`, to send plain JSON.
  A receiver without compressed ingest, such as a trace service deployed before it, answers 415,
  or 400 because it reads the gzip bytes as JSON. The SDK then sends the same request
  uncompressed, and unless that is refused with 400 too, it sends every later request
  uncompressed and logs one warning. Such a receiver loses no spans: it costs one extra request
  per process. A 400 to both the compressed and the plain request is about the spans, so
  compression stays on.
- Spans inside a LangGraph node carry where they ran: `langgraph.node`, `langgraph.step` (an
  integer), `langgraph.triggers` and `langgraph.checkpoint_ns`, copied from the metadata
  LangGraph gives each run. This covers chain, chat-model, LLM, tool and retriever spans; the
  chat-model, LLM and retriever callbacks now read the metadata LangChain passes them.
  `langgraph.triggers` is a compact JSON array in a string, such as `["branch:to:agent"]`, the
  same string the Python SDK writes. `langchain.tags` is unchanged.
- `EvalRow` takes `traceId`, `sessionId`, `messages`, `tools` and `systemPrompt`, so agent
  evaluators can score the agent's turns and tool calls. `traceId` or `sessionId` points at a
  trace or session already recorded in the key's project and environment. `messages` (OpenAI
  chat format) carries the conversation itself, with `tools` (OpenAI tool definitions) and
  `systemPrompt` beside it. They are sent as top-level row keys when present, not inside
  `metadata`, and the snake_case spellings `trace_id`, `session_id` and `system_prompt` are
  accepted too. The new `ChatMessage`, `ChatToolCall` and `ToolDefinition` types describe the
  shapes. A non-string or empty id, or `messages` or `tools` that is not an array, throws
  naming the row before the run opens.

### Changed
- A batch is exported in requests of at most 4 MiB of JSON before compression, and never more
  than `maxExportBatchSize` spans. A batch of large spans went out as one request, which could
  pass the 10 MiB the ingest proxy accepts and be refused whole. The 4 MiB is counted in UTF-8
  bytes, so text outside ASCII cannot push a request past it.
- A 413 splits the request in half and sends each half again, down to a single span. A span
  that is still refused is dropped with a warning that names it and gives its size in bytes. A
  413 used to fail the whole batch.
- When a request gets no answer, or only 5xx answers, after its 3 retries, the rest of that
  batch is dropped instead of being sent into the same failure. A 401 or 403 ends the batch the
  same way, so one batch counts as one auth failure, as before.
- An incoming request's server span is named by the route the framework matched, settled when
  the response finishes, with `http.route` set: Express's route with its router's mount path
  (`GET /api/orders/:orderId`), NestJS's route on Express and on Fastify, and the Fastify
  plugin's route. It was named by the raw path, so every id was an operation of its own, one row
  each in the Services table. A request that matched no route keeps its raw path.
- Outbound spans from `http`, `https` and axios are named by the method alone (`POST`), as
  OpenTelemetry names a client span whose URL template is unknown. They were named by the path,
  ids included. The full URL stays in `http.url`.
- `startHttpTrace(...).end(status, { route })` names the span by the route and sets `http.route`.

### Fixed
- The secret scrubber no longer masks `gen_ai.server.time_to_first_token` and
  `gen_ai.server.time_per_output_token` on bridged OpenTelemetry spans, nor per-token prices
  such as `input_cost_per_token`. A key ending in `token` was read as a credential, so those
  values arrived as `***` and the span lost its time to first token. Every other key ending in
  `token` (`access_token`, `refresh_token`, `id_token`, `csrf_token`, `token`) is still masked.
  Usage counts and `max_tokens` end in `tokens` and were never masked.
- Spans from an agent framework on the OpenTelemetry GenAI conventions (Strands Agents, or any
  framework whose spans carry `gen_ai.operation.name`) are typed by that operation. They were all
  stored as `function_call`, so the trace views counted no tool calls and no model calls for them.
  - `invoke_agent` (and `invoke_swarm`, `invoke_graph`) is an `agent` span, named by
    `gen_ai.agent.name` or the span name (`invoke_agent refund-agent`). Its prompt is the last user
    message and its completion the reply. It carries no token counts, because those repeat the
    model calls inside it.
  - `execute_tool` is a `tool_call` named by its tool. `tool.arguments` and `tool.result` come from
    `gen_ai.tool.call.arguments` / `.result`, or else from the `gen_ai.tool.message` and
    `gen_ai.choice` events, with content blocks unwrapped to their text. `gen_ai.tool.status: error`
    marks it failed.
  - `chat`, `generate_content` and `text_completion` are an `llm_call` with model, prompt,
    completion and tokens. The exception is when the SDK's own instrumentation recorded the same
    request, inside the framework's span or around it. The SDK's span is then the model call, and
    the framework's is stored as `internal` without tokens, so the call is counted once.
    `EVALKIT_COUNT_FOREIGN_LLM=1` still counts both.
  - `execute_event_loop_cycle` is an `internal` span: neither a model call nor a tool call.
  - A `gen_ai.*` span that names no operation keeps the earlier handling (`function_call`, tokens
    withheld).
- The OpenAI and Anthropic model-call spans read content blocks in a request as their text. A
  message sent as `[{ type: "text", text: ... }]`, or an Anthropic `system` given as blocks, was
  stored as `[object Object]`. Blocks that are not text, such as tool use and tool results, are
  kept as JSON, and image and file blocks are named instead of inlined.

## 0.3.2 — 2026-10-02

### Added
- `Eval({ ..., collections: [...] })` runs evaluator collections from the dashboard by id,
  alone or beside rule ids and local scorers in `evaluators`. The server expands each
  collection into its rules; a run of one collection is scored the way the dashboard scores it
  (its weights, thresholds, aggregation and hard gates), and two or more run every rule once at
  weight 1. `evaluators` is now optional when `collections` is given, and `evalkit eval run`
  configs accept `collections`. Needs a server that supports collections: an older one is
  detected when the run opens and throws before any row is sent.

### Fixed
- A row's `context` given as one string is sent as one document. It was split into one entry
  per character, so a grounding evaluator judged the answer against single letters.
- An HTTP error from an evaluation run reads as the server's reason
  (`Eval failed 404: Evaluation rule(s) not found: ...`). It used to be the raw response body.
- Model-call spans list the tools the request offered as `gen_ai.request.tools` (an array of tool
  names, deduplicated in request order), as the Python SDK does, so TS agent versions on the
  dashboard show their tools even when the request body is not captured or was dropped from an
  oversized span. Covered: OpenAI and OpenAI-compatible clients, Anthropic (built-in tools by their
  type), Bedrock Converse and InvokeModel, Google GenAI (`config.tools`), Google AI and Vertex AI
  (the model's `tools`, or the request's when it sets its own), Cohere v1 and v2, Ollama, and
  LangChain (`invocation_params.tools`). Gemini tools are listed by their function declaration
  names.
- Sampling parameters are recorded where they were missing: Google GenAI, Google AI and Vertex AI
  (`temperature`, `topP`, `maxOutputTokens`), Ollama (`options.temperature`, `top_p`,
  `num_predict`), Cohere (`p`), and LangChain (from `invocation_params`).

## 0.3.1 — 2026-09-26

### Fixed
- A tool call the model only requested is recorded as a `gen_ai.tool.call` event on its model-call
  span, as the Python SDK does, and no longer also as a `tool_call` span. The tool your code runs
  (through `traceTool`) was counted twice: once for the request and once for the run. A
  `tool_call` span is still recorded when the provider ran the tool itself and returned its result.
- Model-call spans and the other spans the SDK's instrumentation starts report the SDK version
  (`sdkVersion`). Before, only the spans an app opened with `startTrace` or `startSpan` did.

## 0.3.0 — 2026-09-26

Sessions and named agents. Traces now group into conversations and agents on the dashboard
(Traces › Sessions, Traces › Agents), and conversations can be evaluated as a whole.

### Added
- `withSession({ sessionId, userId }, fn)`: runs `fn` with that session and user in force for every
  span it starts, then restores the previous scope.
- `setAgent(name)`, `currentAgent()`, and `startTrace(name, { agentName: "planner" })`. Spans carry
  the envelope field `agentName` and the attributes `evalkit.agent_name` and `gen_ai.agent.name`.
- The session and user id are read from span attributes under every common spelling:
  `session.id`, `conversation.id`, `gen_ai.conversation.id`, `session_id`, `evalkit.session_id`,
  and `user.id`, `enduser.id`, `evalkit.user_id`. The agent name from `evalkit.agent_name`,
  `gen_ai.agent.name` or `agent.name`.

### Changed
- Identity reaches child spans: a span opened inside a trace inherits its session, user and agent.
- On Node, `setUser` called outside a span is scoped to the current async context
  (AsyncLocalStorage), so two concurrent requests setting different users no longer overwrite each
  other. Where no async context exists it stays module-global, as before.
