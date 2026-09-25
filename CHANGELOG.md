# Changelog

## 0.3.1 — 2026-09-26

### Fixed
- A tool call the model only requested is recorded as a `gen_ai.tool.call` event on its model-call
  span, as the Python SDK does, and no longer also as a `tool_call` span. The tool your code runs
  (through `traceTool`) was counted twice: once for the request and once for the run. A
  `tool_call` span is still recorded when the provider ran the tool itself and returned its result.
- Model-call spans and the other spans the SDK's instrumentation starts report the SDK version
  (`sdkVersion`), not just the spans an app opens with `startTrace` or `startSpan`.

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
