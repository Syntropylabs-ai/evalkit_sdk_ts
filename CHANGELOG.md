# Changelog

## 0.3.6 — 2026-10-26

The SDK runs inside the app it traces, and this release makes it unable to crash it, hold it up or grow
without bound, whatever the receiver does and whatever the app hands it.

### Fixed
- An export can no longer hang. `fetch` had no timeout, and the retry budget bounded only the waits between
  attempts, so a receiver that accepted the connection and never answered held the export, and every span
  queued behind it, forever. Each attempt now has a timeout (10 s, never past the export's 20 s budget), and
  one export is in flight at a time; an export that arrives while one is busy is dropped and counted.
- Memory is bounded. The queue held up to 2048 spans of any size; it now also keeps to a byte budget
  (`maxQueueBytes`, 32 MiB), where the oldest spans that are not model calls make room for a model call and
  other spans are dropped, both counted. The LangChain run maps keep at most 10,000 runs for at most an hour,
  as the identity and framework-span maps already did, and the hooks a LangChain handler adds per instance
  are capped.
- HTTP bodies are recorded up to 64 KiB by default (`maxBodyBytes`); the default was 10 MB.
- A request body JSON cannot express no longer fails the request: a BigInt or a circular `req.body` turned
  an Express request into a 500 in `startHttpTrace`. Bodies, headers, console arguments and a traced
  function's arguments and results are serialised by a bounded writer that stops at the cap instead of
  stringifying the whole value, writes a BigInt as its digits, a cycle as `"[Circular]"` and a throwing
  getter as `"[Unserializable]"`, and never throws.
- `console.log`, `warn` and `error` capture is guarded, cut to 2000 characters before anything is
  serialised, and rate limited to 50 a second. A `String(value)` that threw inside it reached the app.
- A span that is not recording builds none of its attributes, so a sampled-out model call serialises no body.
- Spans are no longer lost on exit: they are flushed on `beforeExit`, and on `SIGTERM` / `SIGINT` when the
  app has no listener of its own for the signal, within 3 s and then with the signal's default action. A
  `once` listener or a library like signal-exit counts as the app's own. A flush on the way out gives up
  after 5 s and abandons an export whose receiver already failed, and the waits between retries no longer
  keep an otherwise finished process alive.
- Big payloads keep their end. `gen_ai.request.body` kept only its first 2 MiB, so a long conversation lost
  its newest messages. A value past the per-value limit (`maxValueBytes`, 16 MiB, lowered by
  `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`) now keeps its start and its end around a `…[cut N bytes]…` marker, and
  `evalkit.truncated.<attribute>` records its original UTF-8 size. Sizes are measured in UTF-8 bytes, so text
  that is not ASCII no longer passes the span-size check at up to three times its real size.
- The Fastify plugin records the error it is given (it ignored it, and ended the span before the error
  handler set the status), the Nest interceptor records the error a handler fails with (it dropped it, and
  recorded nothing on Node's http server), and the Koa, Hono and hapi adapters pass theirs on too.
- A traced generator or async generator is timed over its iteration, with the spans made inside it nested
  under it; the span ended as soon as the generator object was returned.
- `captureGlobalErrors: true` no longer changes how the process ends: an uncaught exception the app has no
  handler for is printed and exits with code 1 again (after its span had up to 2 s to be sent), and an
  unhandled rejection is raised as one under Node's default `--unhandled-rejections=throw`. It stays off by
  default.
- When the SDK attaches to the app's own TracerProvider it registers no OpenTelemetry instrumentations, which
  wrapped the same libraries a second time and recorded each call twice.
- Importing the SDK on the Vercel Edge runtime, Cloudflare Workers or in a browser no longer throws. The
  `edge-light`, `workerd` and `browser` export conditions select a stub with the same API that traces
  nothing; `new Function` and zlib are no longer touched when the Node entry is imported.
- Registering the SDK's provider no longer attempts the global registration twice.
- `traceFunction`, `traceTool`, `traceObject`, `@TraceMethod`, `@Traced`, `startTrace`, `startSpan` and
  `startHttpTrace` called before `init()` run untraced, with one warning, instead of throwing: a module that
  wrapped its tools as it was imported, before the entry point called `init()`, failed to load. A wrapper made
  before `init()` traces once it has run.
- What a health probe's handler did was still recorded on Node's http server and through the Express, Koa,
  Hono, Fastify and hapi adapters: only the probe's own span was left out, so each database ping or model call
  it made became a root trace of its own on every poll. A probe now runs untraced as a whole, with no
  traceparent on the calls it makes, as it already did through the NestJS adapters and in the Python SDK.

### Added
- Errors are recorded one way everywhere, shared with the Python SDK and the receiver: status ERROR described
  as `"<Type>: <message>"`; one `exception` event with `exception.type`, `exception.message` (2 KiB),
  `exception.stacktrace` (16 KiB, cut in the middle) and `exception.escaped`; and the span attributes
  `evalkit.exception.frames` (at most 64 frames, innermost first), `evalkit.exception.source`,
  `evalkit.exception.causes` (`error.cause` chains and `AggregateError.errors`) and, when set,
  `evalkit.exception.fingerprint`. `error.type`, `error.message`, `error.source` and `error.stack` stay.
  Exception events from other libraries are held to the same caps. The query strings of URLs inside error
  messages are scrubbed.
- `captureException(error)`, `setErrorFingerprint(error, fingerprint)` and `expressErrorHandler()`.
- `inAppInclude`, `inAppExclude`, `stackTraceLimit` (unset by default; when set, raised only from V8's default) and
  `sourceMaps` options.
- A circuit breaker: after 3 export cycles in a row fail for want of the receiver, spans are dropped cheaply
  for 30 s, doubling up to 5 minutes, and the receiver is tested with one small request before the rest is
  sent. A refused key is reported clearly the first time; tracing still stops after 3 refusals in a row.
- `getStats()`: queued, exported and dropped spans by reason, export failures, the last error and the
  circuit's state.
- `flush(timeoutMs = 5000)`, which resolves false, never rejects, when the export takes longer.
- `withLambda(handler)` for AWS Lambda and `flushAfter(schedule)` for Next.js `after()` and `waitUntil`.
- `sampleRate` (`EVALKIT_SAMPLE_RATE`): keeps that share of traces by trace id, and always every model call,
  tool call and errored span. The default keeps everything.
- `maxQueueSize`, `maxQueueBytes`, `maxValueBytes`, `consoleSpanLevel` (`EVALKIT_CONSOLE_SPAN_LEVEL`),
  `captureConsole` and `exitHooks` (`EVALKIT_EXIT_HOOKS`) options.
- `EVALKIT_DISABLED=true` and `OTEL_SDK_DISABLED=true` turn the SDK off.
- Keeping things out of traces, with the same patterns and rules as the Python SDK:
  - `ignoreRoutes`: inbound requests left out whole, with everything they do (child, function, model,
    console and outgoing-call spans, and the traceparent those calls would carry). A pattern is an exact path
    (`"/metrics"`), a glob (`*` one segment, `**` any number), a route template (`"GET /v1/orders/:id"`,
    `{id}` and `<id>` too) matched against the path and the framework's route when it is known, with an
    optional leading method, a RegExp tested against the path, or a function of `{ method, path, route }`.
    A trailing slash and the query string are ignored; paths are case-sensitive and methods are not.
    Applied by Node's http server instrumentation and the Express, Fastify, NestJS, Koa, Hono and hapi
    adapters.
  - `ignoreUrls`: outgoing `http`/`https`, `fetch` and `axios` calls to a matching URL (a full URL or
    host-and-path glob, a RegExp or a function of `{ method, url, host, path }`) create no span and send no
    traceparent. A client span another OpenTelemetry instrumentation records for such a URL is not exported.
  - `ignoreFunctions`: function spans left out by name (`"OrdersService.*"`, `"cache.**"`, a RegExp or a
    function). An ignored name wins over `traceFunction`, `traceTool`, `@TraceMethod`, `@Traced`,
    `traceObject` and `enableNestjsAutoTrace`.
  - `untraced(fn)` and `withoutTracing(() => ...)`: nothing inside is traced, across awaits, timers and
    generator steps, and a concurrent request is unaffected. Function tracing leaves an `untraced` function
    as it is.
  - `traceHealthChecks: true` traces health probes, inbound and outbound, like any request.
  - `EVALKIT_IGNORE_ROUTES`, `EVALKIT_IGNORE_URLS` and `EVALKIT_IGNORE_FUNCTIONS` add comma-separated
    patterns to the options. An invalid pattern is skipped with one warning; it never stops `init()`.

### Changed
- `init()` validates its options. Options that cannot work (no key, a malformed URL, a negative number) leave
  the SDK off with one warning instead of tracing into failures; numeric options given as numeric text are
  accepted. A second `init()` with different options warns, naming them.
- Export failures are printed once, then at most once every 5 minutes with the counts, cut to 200 characters
  and without response bodies or stacks. OpenTelemetry's own warnings are printed, at most ten a minute,
  unless the app registered a diag logger of its own.
- `console.log` outside any span no longer becomes a span of its own; warnings and errors still do.
  `consoleSpanLevel: "info"` restores it. Inside a span every level is still a log event.
- The SDK exports through a batch processor of its own instead of OpenTelemetry's BatchSpanProcessor. It
  honours OTEL_BSP_MAX_QUEUE_SIZE and OTEL_BSP_EXPORT_TIMEOUT as before, and its flush never rejects into a
  host provider's flush or shutdown.

## 0.3.5 — 2026-10-14

### Fixed
- An app's incoming request bodies are no longer lost. To record `http.request.body`, the SDK listened for
  the request's `data` events, which switched the request into flowing mode: every chunk that arrived
  before the app's own framework started reading went to the SDK alone. Any app served through Node's
  `http` server was affected whenever a step before its body parser waited on something. With Express an
  async middleware before `express.json()` left `req.body` undefined; with Koa an async middleware before
  `koa-bodyparser` answered 500; with Fastify an async `onRequest` hook left the request hanging with no
  answer; with hapi `request.payload` was null on every request. The SDK now sees the body only as the
  framework reads it, and a body nothing reads is not recorded.
- `flush()` and `destroy()` never reject. When the export fails, `flush()` resolves to `false` (it
  resolves to `true` when the spans were sent) and the reason is logged with `debug: true`; an
  `await evalkit.flush()` at the end of a script used to throw when the receiver could not be reached.
  Before `init()` there is nothing to send and `flush()` resolves to `false` as well; a module-level
  `await evalkit.flush()` in code that runs without tracing (an `init()` guarded on a key that tests
  leave unset) rejected with `[evalkit] call evalkit.init() before using the SDK`.
- `enableNestjsAutoTrace(app)` works on an application that does not import `DiscoveryModule`: it reads
  the application's own module container. It looked `DiscoveryService` up through `app.get()`, and Nest
  aborts the process when such a lookup fails, so an app without the module stopped at startup. When it
  finds nothing to read it logs that and returns 0. Its parameter types accept a Nest 12 application
  under `strict`; they rejected `INestApplication`.
- The Fastify, Koa, Hono and hapi adapters record a request once on Node's `http` server. Each request
  already had the server span the SDK opens for every incoming request, and the adapter opened a second
  one; the adapter now names that span by the route its framework matched (and by its `name` option when
  given). On a runtime without Node's `http` server the adapter still opens its own.
- Health and readiness probes are recorded nowhere. `init()` skipped a probe's request, but with
  `expressMiddleware()`, `fastifyPlugin()`, `koaMiddleware()`, `honoMiddleware()`, `hapiPlugin()` or
  `createNestjsInterceptor()` registered, a request to `/health` got the adapter's own span, and
  `enableNestjsAutoTrace` recorded a probe route's handler, with the traced services it called, as a
  trace on every poll; a probe route's handler now runs with tracing suppressed. A probe is decided by
  whole path segment everywhere, as the Python SDK decides it: a last segment of `health`, `healthz`,
  `healthcheck`, `health-check`, `health_check`, `livez`, `readyz` or `startupz`, or a health segment
  followed only by `live`, `liveness`, `ready`, `readiness`, `startup`, `started` or `alive`, in any case.
  `/readyz`, `/livez`, `/health/live`, `/actuator/health/readiness` and `/health?verbose=1` were recorded
  and are skipped now; `/healthcare` and `/api/health-records` are still recorded, and
  `/v1/orders?next=/health`, which was skipped, is recorded. Outgoing `http`, `https`, `fetch` and axios
  requests follow the same rule.
- `createNestjsInterceptor()` no longer fails every request with a 500. It answered Nest with a plain
  object that had `subscribe()`, which rxjs refuses (`You provided an invalid object where a stream was
  expected`); it now answers with an Observable of the app's own rxjs, made from the class of the one the
  route handler returned. On Node's `http` server it records a request once, as the other adapters do:
  the request's server span is named by the route Nest matched, and the interceptor opens no second one.
  An error inside the interceptor passes the handler's answer through.
- An `https.createServer()` server gets a server span for each request, as an `http` server does.
- A LangGraph graph run outside any span (a script, a worker) is one trace. `invoke()` and `stream()`
  open a root span named after the graph when no span is active, and steps that reach the callbacks
  without a parent run (a graph invoked straight after an ES module app's imports runs before the SDK's
  patches land) share one root. Each model call is recorded once: a provider call made inside a LangChain
  chat model's run is its record, under the node it ran in and with its `langgraph.*` attributes, and the
  callback's own `chat.generate` span is not recorded. A model run no provider call records keeps its
  `chat.generate` span.
- A CommonJS app gives the same spans as the same app as an ES module. OpenTelemetry instrumentations
  that hook `require()` (and so ran only in CommonJS apps) recorded each Express middleware and route
  handler, each socket connect and each DNS lookup, and a second span for each OpenAI call; those for
  Express, router, connect, Koa, hapi, restify, the Nest core, net, DNS and OpenAI stay off now.
- Outgoing `http`/`https` requests are observed without listeners of the SDK's own. A `response` listener
  kept Node from discarding a response the app never read, which held its socket, and an `error` listener
  swallowed a request error the app had no handler for; both now behave as without the SDK. The same holds
  for a server response's `error` event.
- `fetch()` given a `Request` object keeps the Request's own headers. The SDK passed headers of its own in
  the second argument, which replace a Request's headers whole, so `Authorization` and every other header
  of the Request were dropped. The span's method is the Request's too.
- `client.chat.completions.create()`, `messages.create()` and the other patched calls return the provider
  SDK's own promise again, so `.withResponse()`, `.asResponse()` and `client.beta.chat.completions.parse()`
  work. They threw `... is not a function`, as the patch handed back a plain Promise.
- With `captureContent: false` (or `EVALKIT_CAPTURE_CONTENT=false`), spans from other OpenTelemetry
  instrumentation no longer carry message text. Removed now, whichever library set them:
  `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions` (the GenAI semantic
  conventions from 1.37), `gen_ai.prompt` and `gen_ai.completion` and their indexed forms
  (`gen_ai.prompt.0.content`), `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`,
  `input.value`, `output.value`, `llm.input_messages.*`, `llm.output_messages.*`, `retrieval.documents.*`,
  the Vercel AI SDK's `ai.prompt*`, `ai.response.*` and `ai.toolCall.*` content, and `mlflow.span*`, and any
  `*.observation.input` / `*.observation.output` / `*.trace.input` / `*.trace.output`. The `content`, `message`, `body` and `parts` of `gen_ai.*` events
  (`gen_ai.user.message`, `gen_ai.choice`, ...) go too; such an event keeps its name, role, index and
  finish reason, and its `tool_calls` keep only the tools' names and ids. Model, tokens, cost, timing and
  tool names stay.
- Streamed replies record the tool calls they ask for, as replies that do not stream do: one
  `gen_ai.tool.call` event per call with `gen_ai.tool.name`, `gen_ai.tool.call.id` and
  `gen_ai.tool.call.arguments`, so the console shows them and session evaluation reads them. OpenAI's
  argument fragments are assembled by index (several calls in one reply included), Anthropic's from
  `content_block_start` and `input_json_delta`, Cohere's v1 and v2 and Bedrock InvokeModel with an
  Anthropic model the same way, and Gemini's and Ollama's arrive whole. Streamed OpenAI and Anthropic spans
  also carry `gen_ai.response.id`, `gen_ai.response.model` and `gen_ai.response.finish_reasons`.
- A second `init()` applies its options to every span that starts after it: the service name,
  environment and app version of spans the SDK's provider records, and of the spans of functions wrapped
  before it (`traceFunction`, `@TraceMethod`, `@Traced`, NestJS auto-tracing, the framework
  middlewares). It used to attach to the first init's provider and keep its service name. No library is
  patched twice: a patch is recorded beside the object it patched, so it survives another library wrapping
  it (OpenTelemetry's OpenAI instrumentation did, and a second init then recorded each OpenAI call twice),
  and OpenTelemetry instrumentations are registered once per process. `destroy()` flushes and detaches the
  client's own exporter and leaves the provider in place.
- Captured function arguments and results are masked before they are cut to 4096 characters. Cut JSON no
  longer parses, so a member such as `"api_key": "..."` in a long argument went out as written unless its
  value looked like `sk-...` or `tk_live_...`. The scrubber also masks secret-named members of JSON that
  arrives already cut, including one whose value the cut left unterminated, and JSON held inside a JSON
  string.
- The secret scrubber masks more shapes everywhere it runs: PEM private keys (whole, or cut before their
  `END` line), Google API keys (`AIza...`), JSON Web Tokens, the userinfo of a URL or DSN written into text
  (`postgres://user:pass@host`), and quoted assignments to a credential name (`password: "..."`,
  `api_key='...'`). `max_tokens: "5"` and `tokens="7"` are left alone.
- `traceFunction`, `traceTool`, `@TraceMethod`, `@Traced`, `traceObject` and `enableNestjsAutoTrace` mask
  an argument by the parameter it is bound to: one named like a credential (`apiKey`, `secret`, `token`,
  `password`, `credentials`, `auth`, `cookie`, `dsn`, `jwt`, `bearer`, in camel or snake case) is recorded as
  `***`, as is a member of an options object named that way (`{ accessToken }`). A function whose own name
  reads like a credential's (`getApiKey`, `validateToken`) records neither arguments nor result. Names are
  read from the function's source; a destructured parameter, a bound or native function, and minified code
  give no usable name, and their values are masked by key and shape only. `captureSecrets: true` records
  arguments and results as given.
- Per-token prices such as `input_cost_per_audio_token`, `input_cost_per_character_token` and
  `output_cost_per_reasoning_token` are no longer masked as secrets. `access_token`, `refresh_token`,
  `id_token` and `per_user_token` still are.
- camelCase and PascalCase credential keys are masked wherever the scrubber reads a key: span and event
  attributes, JSON bodies and attribute values (JSON cut short at `maxBodyBytes` included), quoted
  assignments in text and URL query strings. `accessToken`, `authToken`, `refreshToken`, `idToken`,
  `sessionToken`, `secretKey`, `apiSecret` and `userPassword` were masked only among a traced function's
  arguments, so a JavaScript object the app logged or sent went out with its tokens. A key is split at its
  capitals and matched as its snake_case spelling is, the Python SDK's rule. `maxTokens`, `totalTokens`,
  `inputCostPerAudioToken`, `timeToFirstToken` and a flag about a token (`hasToken`, `isTokenValid`) keep
  their values, and a parameter named `hasToken` is no longer masked.
- The warning for a streamed OpenAI call without a usage chunk no longer says the call is priced at $0: the
  trace service estimates its tokens from the prompt and completion text and marks the span
  `evalkit.cost_estimated`, and `stream_options: { include_usage: true }` gives exact counts. With content
  capture off there is no text to estimate from, and the warning says that instead.
- Streamed Cohere calls are traced (`chatStream`, as `chat_stream`, and `chat` with `stream: true`), with
  time to first token and the assembled text, on `CohereClient` and on `CohereClientV2`, whose `chat`
  replies are read too.
- Reasoning text stops the time-to-first-token clock on Ollama and Bedrock InvokeModel streams, as it does
  for every other provider. Ollama streams keep their reply text, not every chunk, in
  `gen_ai.response.body`.

### Added
- The OpenAI Responses API is traced as a model call, `responses.create`, whole and streamed, including
  `responses.stream()` and `responses.parse()`: prompt (`instructions` and `input`), reply text, reasoning
  summaries, tokens (cached input and reasoning tokens included), tool calls (function calls and hosted
  tools), and time to first token. `patchOpenAIClient()` patches a client's `responses` too.
- `generateContentStream` of `@google/generative-ai` and `@google-cloud/vertexai` is traced, named
  `generateContentStream`, with time to first token, the reply text, tool calls and usage; the span ends
  when the SDK's `response` settles. Their whole replies record tool calls and reasoning text, and read
  the model, tools and sampling of the instance that made the call.

### Changed
- The SDK's own instrumentation never fails the app's call. An error inside a hook (building attributes,
  reading a reply or a chunk, assembling tool calls) is swallowed, the call goes on as if the SDK were not
  there, and with `debug: true` the error is logged once per place. The provider's own errors reach the
  app unchanged, synchronous ones synchronously.
- A streamed reply is the provider SDK's own object: an OpenAI or Anthropic `Stream` keeps `controller`,
  `tee()` and `toReadableStream()`, and the SDKs' stream helpers (`MessageStream`, `responses.stream()`,
  `beta.chat.completions.stream()`) work as without the SDK. A stream's span ends once, whether the app
  reads it to the end, leaves the loop, aborts it or drops it unread (then when it is collected), and
  the text it keeps is capped at 262,144 characters and each tool call's arguments at 32,768.
- Every exported span carries the `environment`, `appVersion` and `deviceId` given to `init()` unless it
  sets its own, model calls and spans of other libraries included. Only spans opened through the SDK's
  API carried them.

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
