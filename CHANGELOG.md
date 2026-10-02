# Changelog

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
