const http = require("http");
const assert = require("assert");

const captured = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const j = JSON.parse(body);
      if (Array.isArray(j.events)) captured.push(...j.events);
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
  });
});

server.listen(0, async () => {
  const port = server.address().port;
  const mod = require("../dist/index.js");
  const evalkit = mod.default ?? mod;

  const client = evalkit.init({ subscriptionKey: "tk_test", baseUrl: `http://127.0.0.1:${port}`, serviceName: "smoke" });

  const r = evalkit.evaluate({
    output: "AWS and Azure",
    expectedTools: ["a"],
    toolCalls: [{ name: "a" }],
    constraints: { requiredTerms: ["AWS"] },
  });
  assert.strictEqual(r.scores.tool_f1, 1.0, "evaluate tool_f1");
  assert.strictEqual(r.scores.response_match, 1.0, "evaluate response_match");

  class FakeModels {
    async generateContent(_req) {
      return {
        text: "hi there",
        candidates: [{ content: { parts: [{ text: "hi there" }, { functionCall: { name: "get_weather", args: { city: "london" } } }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      };
    }
  }
  class FakeThinkingModels {
    async generateContent(_req) {
      return {
        text: "ok",
        candidates: [{ content: { parts: [{ text: "ok" }] } }],
        usageMetadata: {
          promptTokenCount: 2000,
          candidatesTokenCount: 40,
          thoughtsTokenCount: 900,
          toolUsePromptTokenCount: 150,
          cachedContentTokenCount: 1800,
          totalTokenCount: 3090,
        },
      };
    }
  }

  evalkit.patchGoogleGenAIModels(FakeModels.prototype);
  await new FakeModels().generateContent({ model: "gemini-2.0-flash", contents: "weather?" });
  evalkit.patchGoogleGenAIModels(FakeThinkingModels.prototype);
  await new FakeThinkingModels().generateContent({ model: "gemini-3-pro", contents: "think?" });

  class FakePg {
    async query(_text, _values) { return { rowCount: 2, rows: [] }; }
  }
  evalkit.patchPgClient(FakePg);
  const dbTrace = evalkit.startTrace("db-req");
  await evalkit.withTrace(dbTrace.ctx, async () => {
    await new FakePg().query("SELECT * FROM users WHERE id=$1", [1]);
  });
  dbTrace.end("OK");

  const fakeOpenAI = {
    chat: { completions: { create: async () => ({
      id: "c1", model: "gpt-4o",
      choices: [{ message: { content: "done", tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }) } },
  };
  evalkit.patchOpenAIClient(fakeOpenAI);
  await fakeOpenAI.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });

  class FakeMCPClient {
    async callTool(_params) { return { content: [{ type: "text", text: "sum=42" }], isError: false }; }
  }
  evalkit.patchMCPClient(FakeMCPClient);
  await new FakeMCPClient().callTool({ name: "add", arguments: { a: 1, b: 2 } });

  class ConverseCommand { constructor(input) { this.input = input; } }
  class ConverseStreamCommand { constructor(input) { this.input = input; } }
  class InvokeModelCommand { constructor(input) { this.input = input; } }
  class InvokeModelWithResponseStreamCommand { constructor(input) { this.input = input; } }
  class InvokeAgentCommand { constructor(input) { this.input = input; } }
  class RetrieveCommand { constructor(input) { this.input = input; } }
  class RetrieveAndGenerateCommand { constructor(input) { this.input = input; } }

  const encodeJson = (obj) => new TextEncoder().encode(JSON.stringify(obj));
  const decodeText = (bytes) => new TextDecoder().decode(bytes);

  async function* converseStreamEvents() {
    yield { messageStart: { role: "assistant" } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: "let me think" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " world" } } };
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    yield { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu_stream", name: "lookup_city" } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city":' } } } };
    yield { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '"paris"}' } } } };
    yield { contentBlockStop: { contentBlockIndex: 1 } };
    yield { messageStop: { stopReason: "tool_use" } };
    yield { metadata: { metrics: { latencyMs: 42 }, usage: { inputTokens: 11, outputTokens: 5, totalTokens: 19, cacheReadInputTokens: 3 } } };
  }
  let abandonedStreamDrained = false;
  async function* abandonedStreamEvents() {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } };
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " never read" } } };
    abandonedStreamDrained = true;
    yield { metadata: { usage: { inputTokens: 99, outputTokens: 99, totalTokens: 198 } } };
  }
  async function* titanStreamEvents() {
    yield { chunk: { bytes: encodeJson({ index: 0, outputText: "Hi", inputTextTokenCount: 7, totalOutputTextTokenCount: 1 }) } };
    yield { chunk: { bytes: encodeJson({ index: 1, outputText: " there", inputTextTokenCount: 7, totalOutputTextTokenCount: 3, completionReason: "FINISHED" }) } };
  }
  async function* agentStreamEvents() {
    yield { chunk: { bytes: new TextEncoder().encode("agent ") } };
    yield { chunk: { bytes: new TextEncoder().encode("reply") } };
  }

  const claudeInvokeBody = encodeJson({
    id: "msg_1", type: "message", role: "assistant", model: "claude-3-5-haiku",
    content: [{ type: "text", text: "four" }, { type: "tool_use", id: "tu_1", name: "sum_two", input: { a: 2, b: 2 } }],
    stop_reason: "tool_use", usage: { input_tokens: 9, output_tokens: 4 },
  });

  const fakeBedrock = {
    async send(command) {
      switch (command.constructor.name) {
        case "ConverseCommand":
          if (command.input.modelId === "cohere.command-r-v1:0") {
            return { output: { message: { role: "assistant", content: "not-an-array" } }, stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 }, $metadata: {} };
          }
          return { output: { message: { role: "assistant", content: [{ text: "converse ok" }, { toolUse: { toolUseId: "tu_c", name: "get_time", input: { tz: "utc" } } }] } }, stopReason: "tool_use", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 }, $metadata: {} };
        case "ConverseStreamCommand":
          return {
            stream: command.input.modelId === "meta.llama3-70b-instruct-v1:0" ? abandonedStreamEvents() : converseStreamEvents(),
            $metadata: {},
          };
        case "InvokeModelCommand":
          return { body: claudeInvokeBody, contentType: "application/json", $metadata: {} };
        case "InvokeModelWithResponseStreamCommand":
          return { body: titanStreamEvents(), contentType: "application/json", $metadata: {} };
        default:
          return { $metadata: {} };
      }
    },
  };
  evalkit.patchBedrockClient(fakeBedrock);

  const converseRes = await fakeBedrock.send(new ConverseCommand({
    modelId: "us.anthropic.claude-3-5-sonnet-20240620-v1:0",
    system: [{ text: "be brief" }],
    messages: [{ role: "user", content: [{ text: "hi" }] }],
    inferenceConfig: { maxTokens: 64 },
  }));
  assert.strictEqual(converseRes.output.message.content[0].text, "converse ok", "converse result passthrough");

  const malformedRes = await fakeBedrock.send(new ConverseCommand({
    modelId: "cohere.command-r-v1:0",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  }));
  assert.strictEqual(malformedRes.output.message.content, "not-an-array", "a malformed converse output never rejects the caller's send");

  const converseStreamRes = await fakeBedrock.send(new ConverseStreamCommand({
    modelId: "amazon.nova-pro-v1:0",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  }));
  let converseStreamed = "";
  for await (const event of converseStreamRes.stream) {
    if (event.contentBlockDelta) converseStreamed += event.contentBlockDelta.delta.text ?? "";
  }
  assert.strictEqual(converseStreamed, "Hello world", "converse stream reaches the consumer untouched");

  const abandonedRes = await fakeBedrock.send(new ConverseStreamCommand({
    modelId: "meta.llama3-70b-instruct-v1:0",
    messages: [{ role: "user", content: [{ text: "hi" }] }],
  }));
  for await (const event of abandonedRes.stream) {
    if (event.contentBlockDelta) break;
  }
  assert.strictEqual(abandonedStreamDrained, false, "abandoning a converse stream does not drain it behind the caller");

  const invokeRes = await fakeBedrock.send(new InvokeModelCommand({
    modelId: "anthropic.claude-3-5-haiku-20241022-v1:0",
    contentType: "application/json",
    body: encodeJson({ anthropic_version: "bedrock-2023-05-31", max_tokens: 128, system: "be brief", messages: [{ role: "user", content: "2+2?" }] }),
  }));
  assert.strictEqual(invokeRes.body, claudeInvokeBody, "invoke_model response body object is not swapped out");
  assert.strictEqual(JSON.parse(decodeText(invokeRes.body)).id, "msg_1", "invoke_model response body still decodable by the caller");

  const invokeStreamRes = await fakeBedrock.send(new InvokeModelWithResponseStreamCommand({
    modelId: "amazon.titan-text-express-v1",
    body: encodeJson({ inputText: "hi", textGenerationConfig: { maxTokenCount: 32 } }),
  }));
  let titanStreamed = "";
  for await (const event of invokeStreamRes.body) {
    titanStreamed += JSON.parse(decodeText(event.chunk.bytes)).outputText;
  }
  assert.strictEqual(titanStreamed, "Hi there", "invoke_model stream reaches the consumer untouched");

  async function claudeCacheStreamEvents() {
    return (async function* () {
      yield { chunk: { bytes: encodeJson({ type: "message_start", message: { model: "claude-3-5-haiku", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 1024, cache_creation_input_tokens: 2048 } } }) } };
      yield { chunk: { bytes: encodeJson({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cached" } }) } };
      yield { chunk: { bytes: encodeJson({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }) } };
      yield { chunk: { bytes: encodeJson({ type: "message_stop", "amazon-bedrock-invocationMetrics": { inputTokenCount: 3084, outputTokenCount: 9 } }) } };
    })();
  }
  async function novaMetricsStreamEvents() {
    return (async function* () {
      yield { chunk: { bytes: encodeJson({ contentBlockDelta: { delta: { text: "pong" } } }) } };
      yield { chunk: { bytes: encodeJson({ "amazon-bedrock-invocationMetrics": { inputTokenCount: 12, outputTokenCount: 7, cacheReadInputTokenCount: 1024, cacheWriteInputTokenCount: 2048 } }) } };
    })();
  }

  const registeredMiddleware = [];
  const headerBodies = {
    "mistral.mistral-large-2407-v1:0": {
      body: encodeJson({ choices: [{ message: { content: "bonjour" }, stop_reason: "stop" }] }),
      headers: { "x-amzn-bedrock-input-token-count": "41", "x-amzn-bedrock-output-token-count": "13" },
    },
    "cohere.command-text-v14": {
      body: new TextEncoder().encode("<<<not json"),
      headers: { "X-Amzn-Bedrock-Input-Token-Count": "7", "X-Amzn-Bedrock-Output-Token-Count": "2" },
    },
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {
      body: encodeJson({ content: [{ type: "text", text: "cached claude" }], usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 1024, cache_creation_input_tokens: 2048 }, stop_reason: "end_turn" }),
      headers: { "x-amzn-bedrock-input-token-count": "999", "x-amzn-bedrock-output-token-count": "999" },
    },
    "amazon.nova-lite-v1:0": {
      body: encodeJson({ output: { message: { content: [{ text: "cached nova" }] } }, usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19, cacheReadInputTokens: 1024, cacheWriteInputTokens: 2048 }, stopReason: "end_turn" }),
      headers: {},
    },
  };
  const fakeBedrockHeaders = {
    middlewareStack: {
      add(middleware, options) { registeredMiddleware.push({ middleware, options }); },
    },
    async send(command) {
      const name = command.constructor.name;
      const terminal = async () => {
        if (name === "InvokeModelWithResponseStreamCommand") {
          const stream = command.input.modelId.startsWith("anthropic.")
            ? await claudeCacheStreamEvents()
            : await novaMetricsStreamEvents();
          return { response: { statusCode: 200, headers: {} }, output: { body: stream, $metadata: {} } };
        }
        const entry = headerBodies[command.input.modelId] ?? { body: encodeJson({}), headers: {} };
        return {
          response: { statusCode: 200, headers: entry.headers },
          output: { body: entry.body, contentType: "application/json", $metadata: {} },
        };
      };
      let handler = terminal;
      for (const registered of registeredMiddleware) handler = registered.middleware(handler, {});
      const { output } = await handler({ input: command.input });
      return output;
    },
  };
  evalkit.patchBedrockClient(fakeBedrockHeaders);
  assert.strictEqual(registeredMiddleware.length, 1, "patchBedrockClient registers exactly one deserialize middleware");
  assert.strictEqual(registeredMiddleware[0].options.step, "deserialize", "header capture runs in the deserialize step where the raw response is available");

  await fakeBedrockHeaders.send(new InvokeModelCommand({
    modelId: "mistral.mistral-large-2407-v1:0",
    body: encodeJson({ messages: [{ role: "user", content: "salut" }] }),
  }));
  await fakeBedrockHeaders.send(new InvokeModelCommand({
    modelId: "cohere.command-text-v14",
    body: encodeJson({ prompt: "hi" }),
  }));
  await fakeBedrockHeaders.send(new InvokeModelCommand({
    modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    body: encodeJson({ max_tokens: 32, messages: [{ role: "user", content: "hi" }] }),
  }));
  await fakeBedrockHeaders.send(new InvokeModelCommand({
    modelId: "amazon.nova-lite-v1:0",
    body: encodeJson({ messages: [{ role: "user", content: [{ text: "hi" }] }] }),
  }));

  const claudeCacheStreamRes = await fakeBedrockHeaders.send(new InvokeModelWithResponseStreamCommand({
    modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    body: encodeJson({ max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
  }));
  for await (const _event of claudeCacheStreamRes.body) { void _event; }

  const novaMetricsStreamRes = await fakeBedrockHeaders.send(new InvokeModelWithResponseStreamCommand({
    modelId: "amazon.nova-micro-v1:0",
    body: encodeJson({ messages: [{ role: "user", content: [{ text: "ping" }] }] }),
  }));
  for await (const _event of novaMetricsStreamRes.body) { void _event; }

  const fakeAgentRuntime = {
    async send(command) {
      switch (command.constructor.name) {
        case "InvokeAgentCommand":
          return { completion: agentStreamEvents(), sessionId: "sess_1", $metadata: {} };
        case "RetrieveCommand":
          return { retrievalResults: [{ content: { text: "doc" }, documentId: "d1", score: 0.7 }], $metadata: {} };
        case "RetrieveAndGenerateCommand":
          return { output: { text: "grounded answer" }, sessionId: "rag_1", citations: [], $metadata: {} };
        default:
          return { $metadata: {} };
      }
    },
  };
  evalkit.patchBedrockAgentRuntimeClient(fakeAgentRuntime);

  const agentRes = await fakeAgentRuntime.send(new InvokeAgentCommand({
    agentId: "AG1", agentAliasId: "AL1", sessionId: "sess_1", inputText: "ping", enableTrace: false,
  }));
  let agentText = "";
  for await (const event of agentRes.completion) agentText += decodeText(event.chunk.bytes);
  assert.strictEqual(agentText, "agent reply", "invoke_agent stream reaches the consumer untouched");

  const retrieveRes = await fakeAgentRuntime.send(new RetrieveCommand({
    knowledgeBaseId: "KB1", retrievalQuery: { text: "docs" },
  }));
  assert.strictEqual(retrieveRes.retrievalResults.length, 1, "retrieve result passthrough");

  const ragRes = await fakeAgentRuntime.send(new RetrieveAndGenerateCommand({
    input: { text: "who runs it?" },
    retrieveAndGenerateConfiguration: {
      type: "KNOWLEDGE_BASE",
      knowledgeBaseConfiguration: { knowledgeBaseId: "KB2", modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0" },
    },
  }));
  assert.strictEqual(ragRes.output.text, "grounded answer", "retrieve_and_generate result passthrough");

  const fakePrisma = {
    $extends(ext) {
      const op = ext.query.$allOperations;
      return { user: { count: () => op({ model: "User", operation: "count", args: {}, query: async () => 7 }) } };
    },
  };
  const prisma = evalkit.instrumentPrisma(fakePrisma, { system: "mongodb" });
  const prismaCount = await prisma.user.count();
  assert.strictEqual(prismaCount, 7, "instrumentPrisma passes through the result");

  let liveOnMessage;
  const fakeAi = { live: { connect: async (p) => { liveOnMessage = p.callbacks.onmessage; return { sendRealtimeInput() {}, close() {} }; } } };
  const liveSession = await evalkit.traceLive(fakeAi, { model: "gemini-live", callbacks: {} }, { sessionId: "voice_1" });
  liveOnMessage({ serverContent: { modelTurn: { parts: [{ text: "hello there" }] }, turnComplete: true } });
  liveSession.close();

  evalkit.traceFunction("voidFn", () => undefined)();
  const crashFn = evalkit.traceFunction("crashFn", () => 99);
  const origStartSpan = client.startSpan.bind(client);
  client.startSpan = () => { throw new Error("boom"); };
  const crashRes = crashFn();
  client.startSpan = origStartSpan;
  assert.strictEqual(crashRes, 99, "host fn returns even when tracing setup throws");

  const lh = await evalkit.langchainHandler();
  assert.strictEqual(lh, null, "langchainHandler null when absent");

  const report = await evalkit.simulateUser({
    entrypoint: async (ctx) => ({ text: `answer: ${ctx.message}`, toolCalls: [{ name: "search" }] }),
    scenarios: [
      { name: "s1", starting_prompt: "find docs", expected_tools: ["search"], target_keywords: ["answer"] },
      { name: "s2", starting_prompt: "again", expected_tools: ["search"] },
    ],
  });

  assert.strictEqual(report.results.length, 2, "two scenario results");
  assert.strictEqual(report.results[0].scores.tool_correctness, 1.0, "sim tool_correctness");

  let evalReq = null;
  const apiServer = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      evalReq = { path: req.url, key: req.headers["x-subscription-key"], body: JSON.parse(b || "{}") };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        simulationId: "sim_x", runId: "run_y",
        scenarios: [{ scenarioId: "scn_1", name: "s1", traceId: "t1", status: "OK", overallScore: 0.8, passed: true, metrics: [{ ruleId: "r1", ruleName: "Relevance", category: "quality", score: 0.8, passed: true, reason: "ok" }] }],
        aggregate: { averageScore: 0.8, passRate: 1.0, totalScenarios: 1, evaluatedScenarios: 1 },
      }));
    });
  });
  await new Promise((r) => apiServer.listen(0, r));
  const apiPort = apiServer.address().port;
  const simEval = await evalkit.evaluateSimulation({
    simulationId: "sim_x", collectionId: "col_1",
    provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test", maxTokens: 256,
    apiUrl: `http://127.0.0.1:${apiPort}`,
  });
  apiServer.close();
  assert.strictEqual(evalReq.path, "/simulations/evaluate", "evaluateSimulation path");
  assert.strictEqual(evalReq.key, "tk_test", "evaluateSimulation key");
  assert.strictEqual(evalReq.body.simulationId, "sim_x", "evaluateSimulation simulationId");
  assert.strictEqual(evalReq.body.collectionId, "col_1", "evaluateSimulation collectionId");
  assert.strictEqual(evalReq.body.provider, "openai", "evaluateSimulation provider");
  assert.strictEqual(evalReq.body.maxTokens, 256, "evaluateSimulation maxTokens");
  assert.strictEqual(simEval.scenarios.length, 1, "evaluateSimulation scenarios");
  assert.strictEqual(simEval.aggregate.averageScore, 0.8, "evaluateSimulation aggregate");

  await evalkit.flush();

  setTimeout(() => {
    server.close();

    const genai = captured.filter((e) => e.spanType === "llm_call" && e.provider === "google-genai");
    assert.ok(genai.length >= 1, "google-genai llm_call captured");
    assert.strictEqual(genai[0].completion, "hi there", "genai completion joined");
    assert.ok((genai[0].events || []).some((ev) => ev.attributes && ev.attributes["gen_ai.tool.name"] === "get_weather"), "genai tool event");

    const thinking = genai.find((e) => e.model === "gemini-3-pro");
    assert.ok(thinking, "gemini-3-pro llm_call captured");
    assert.strictEqual(thinking.tokensIn, 2150, "prompt tokens already include cached tokens; tool-use prompt tokens are disjoint and billed as input");
    assert.strictEqual(thinking.tokensOut, 940, "Gemini prices the response as output plus thinking tokens, so thoughts must land in tokensOut");
    assert.strictEqual(thinking.cacheReadTokens, 1800, "cached content tokens reported for cache-read pricing");
    assert.strictEqual(thinking.attributes["gen_ai.usage.total_tokens"], 3090, "reported total preserved");
    assert.strictEqual(thinking.attributes["gen_ai.usage.reasoning_tokens"], 900, "reasoning token breakdown emitted");
    assert.strictEqual(thinking.attributes["gen_ai.usage.tool_use_prompt_tokens"], 150, "tool-use prompt token breakdown emitted");

    const sim = captured.filter((e) => e.isSimulation === true);
    assert.ok(sim.length >= 1, "simulation-tagged spans exported");
    assert.ok(sim.every((e) => e.simulationId === report.simulationId), "sim id stamped");

    const roots = captured.filter((e) => (e.operation || "").startsWith("scenario:"));
    const distinctTraces = new Set(roots.map((e) => e.traceId));
    assert.strictEqual(distinctTraces.size, 2, "each scenario is its own trace");

    const evalResults = captured.filter((e) => e.spanType === "eval_result");
    assert.ok(evalResults.length >= 1, "eval_result spans exported");

    const db = captured.filter((e) => e.spanType === "db_query");
    assert.ok(db.length >= 1, "db_query span captured");
    assert.strictEqual(db[0].attributes["db.system"], "postgresql", "db.system postgresql");

    const oa = captured.filter((e) => e.spanType === "llm_call" && e.provider === "openai");
    assert.ok(oa.length >= 1, "openai llm_call captured");
    const { version } = require("../package.json");
    assert.ok(oa.every((e) => e.sdkVersion === version), "an instrumented llm_call reports the SDK version");
    const toolSpans = captured.filter((e) => e.spanType === "tool_call");
    // A tool the model asks for is an event on its llm span; the app's own execution of it is the span.
    const requestedTool = (name) =>
      captured
        .filter((e) => e.spanType === "llm_call")
        .flatMap((e) => e.events ?? [])
        .find((ev) => ev.name === "gen_ai.tool.call" && ev.attributes["gen_ai.tool.name"] === name);
    assert.ok(requestedTool("search"), "openai requested tool recorded as an llm_call event");
    assert.ok(!toolSpans.some((t) => t.operation === "search"), "a requested client-side tool is not also a tool_call span");

    const mcpSpan = toolSpans.find((t) => t.operation === "add");
    assert.ok(mcpSpan, "mcp tool_call span emitted");
    assert.strictEqual(mcpSpan.attributes["mcp.tool.name"], "add", "mcp.tool.name attr");
    assert.strictEqual(mcpSpan.attributes["tool.result"], "sum=42", "mcp tool result captured");

    const bedrockSpans = captured.filter((e) => e.spanType === "llm_call" && e.provider === "bedrock");
    assert.ok(bedrockSpans.length >= 5, `bedrock llm_call spans captured; got ${bedrockSpans.length}`);

    const converseSpan = bedrockSpans.find((e) => e.operation === "converse" && e.model === "us.anthropic.claude-3-5-sonnet-20240620-v1:0");
    assert.ok(converseSpan, "converse span emitted");
    assert.strictEqual(converseSpan.completion, "converse ok", "converse completion captured");
    assert.strictEqual(converseSpan.tokensIn, 4, "converse input tokens");
    assert.strictEqual(converseSpan.tokensOut, 2, "converse output tokens");
    assert.ok(requestedTool("get_time"), "converse toolUse block recorded as an llm_call event");

    const malformedSpan = bedrockSpans.find((e) => e.operation === "converse" && e.model === "cohere.command-r-v1:0");
    assert.ok(malformedSpan, "malformed converse output still ends and exports its span");
    assert.strictEqual(malformedSpan.tokensIn, 8, "malformed converse output still reports usage");
    assert.strictEqual(malformedSpan.tokensOut, 6, "malformed converse output still reports output tokens");

    const converseStreamSpan = bedrockSpans.find((e) => e.operation === "converse_stream" && e.model === "amazon.nova-pro-v1:0");
    assert.ok(converseStreamSpan, "converse_stream span emitted");
    assert.strictEqual(converseStreamSpan.completion, "Hello world", "converse_stream deltas accumulated");
    assert.strictEqual(converseStreamSpan.tokensIn, 14, "converse_stream input tokens include cache-read tokens");
    assert.strictEqual(converseStreamSpan.tokensOut, 5, "converse_stream output tokens from the metadata event");
    assert.strictEqual(converseStreamSpan.cacheReadTokens, 3, "converse_stream cache-read tokens");
    assert.deepStrictEqual(converseStreamSpan.attributes["gen_ai.response.finish_reasons"], ["tool_use"], "converse_stream stop reason from messageStop");
    assert.strictEqual(converseStreamSpan.attributes["gen_ai.streaming"], true, "converse_stream marked streaming");
    assert.strictEqual(converseStreamSpan.attributes["gen_ai.response.thinking"], "let me think", "converse_stream reasoningContent deltas accumulated");
    const streamTool = requestedTool("lookup_city");
    assert.ok(streamTool, "converse_stream toolUse deltas recorded as an llm_call event");
    assert.strictEqual(streamTool.attributes["gen_ai.tool.call.arguments"], '{"city":"paris"}', "converse_stream toolUse partial JSON reassembled");

    const abandonedSpan = bedrockSpans.find((e) => e.operation === "converse_stream" && e.model === "meta.llama3-70b-instruct-v1:0");
    assert.ok(abandonedSpan, "abandoned converse_stream span still ended and exported");
    assert.strictEqual(abandonedSpan.completion, "partial", "abandoned converse_stream keeps the partial completion");
    assert.strictEqual(abandonedSpan.tokensIn, undefined, "abandoned converse_stream reports no usage because metadata never arrived");

    const invokeSpan = bedrockSpans.find((e) => e.operation === "invoke_model");
    assert.ok(invokeSpan, "invoke_model span emitted");
    assert.strictEqual(invokeSpan.prompt, "system: be brief\nuser: 2+2?", "invoke_model claude prompt parsed from the body");
    assert.strictEqual(invokeSpan.completion, "four", "invoke_model claude completion parsed from the body");
    assert.strictEqual(invokeSpan.tokensIn, 9, "invoke_model claude input tokens");
    assert.strictEqual(invokeSpan.tokensOut, 4, "invoke_model claude output tokens");
    assert.strictEqual(invokeSpan.attributes["gen_ai.request.max_tokens"], 128, "invoke_model claude max_tokens");
    assert.ok(requestedTool("sum_two"), "invoke_model claude tool_use recorded as an llm_call event");

    const invokeStreamSpan = bedrockSpans.find((e) => e.operation === "invoke_model_with_response_stream");
    assert.ok(invokeStreamSpan, "invoke_model_with_response_stream span emitted");
    assert.strictEqual(invokeStreamSpan.completion, "Hi there", "titan stream chunks accumulated");
    assert.strictEqual(invokeStreamSpan.tokensIn, 7, "titan stream input tokens");
    assert.strictEqual(invokeStreamSpan.tokensOut, 3, "titan stream cumulative output tokens");

    const mistralHeaderSpan = bedrockSpans.find((e) => e.model === "mistral.mistral-large-2407-v1:0");
    assert.ok(mistralHeaderSpan, "invoke_model span emitted for a family whose body carries no usage");
    assert.strictEqual(mistralHeaderSpan.completion, "bonjour", "mistral chat completion parsed from the body");
    assert.strictEqual(mistralHeaderSpan.tokensIn, 41, "Mistral, Cohere command, AI21 J2 and DeepSeek InvokeModel bodies carry no usage object, so without the x-amzn-bedrock-*-token-count header fallback these spans report zero tokens and therefore zero cost");
    assert.strictEqual(mistralHeaderSpan.tokensOut, 13, "mistral output tokens come from the response headers");
    assert.strictEqual(mistralHeaderSpan.attributes["gen_ai.usage.total_tokens"], 54, "header-derived usage still reports a total");

    const cohereHeaderSpan = bedrockSpans.find((e) => e.model === "cohere.command-text-v14");
    assert.ok(cohereHeaderSpan, "an unparseable invoke_model body still ends and exports its span");
    assert.strictEqual(cohereHeaderSpan.tokensIn, 7, "HeaderBag keys are case-insensitive by contract, and a body EvalKit cannot parse still has billable usage in the headers");
    assert.strictEqual(cohereHeaderSpan.tokensOut, 2, "unparseable body still reports output tokens from the headers");

    const claudeCacheSpan = bedrockSpans.find((e) => e.operation === "invoke_model" && e.model === "anthropic.claude-sonnet-4-5-20250929-v1:0");
    assert.ok(claudeCacheSpan, "invoke_model span emitted for the cached claude call");
    assert.strictEqual(claudeCacheSpan.tokensIn, 3084, "Bedrock excludes cache tokens from input_tokens, so an unfolded claude span bills only the uncached remainder");
    assert.strictEqual(claudeCacheSpan.tokensOut, 7, "the x-amzn-bedrock header counts are a fallback only and must not override a body that reports usage");
    assert.strictEqual(claudeCacheSpan.cacheReadTokens, 1024, "cache-read tokens are billed at a discount, so losing the breakdown overcharges the call");
    assert.strictEqual(claudeCacheSpan.cacheCreationTokens, 2048, "cache-write tokens are billed at a premium, so losing the breakdown undercharges the call");

    const novaCacheSpan = bedrockSpans.find((e) => e.operation === "invoke_model" && e.model === "amazon.nova-lite-v1:0");
    assert.ok(novaCacheSpan, "invoke_model span emitted for the cached nova call");
    assert.strictEqual(novaCacheSpan.tokensIn, 3084, "Nova prompt caching is automatic for text prompts, so every cached call under-bills without the fold");
    assert.strictEqual(novaCacheSpan.tokensOut, 7, "nova output tokens");
    assert.strictEqual(novaCacheSpan.cacheReadTokens, 1024, "nova cache-read tokens");
    assert.strictEqual(novaCacheSpan.cacheCreationTokens, 2048, "nova cache-write tokens");
    assert.strictEqual(novaCacheSpan.attributes["gen_ai.usage.total_tokens"], 3091, "the folded total replaces Bedrock's raw totalTokens of 19");

    const claudeCacheStreamSpan = bedrockSpans.find((e) => e.operation === "invoke_model_with_response_stream" && e.model === "anthropic.claude-sonnet-4-5-20250929-v1:0");
    assert.ok(claudeCacheStreamSpan, "invoke_model_with_response_stream span emitted for the cached claude stream");
    assert.strictEqual(claudeCacheStreamSpan.completion, "cached", "claude stream text deltas accumulated");
    assert.strictEqual(claudeCacheStreamSpan.tokensIn, 3084, "the non-streaming path folds cache tokens, so leaving the stream unfolded made the same call cost different amounts depending on whether it streamed");
    assert.strictEqual(claudeCacheStreamSpan.tokensOut, 9, "claude stream output tokens come from message_delta");
    assert.strictEqual(claudeCacheStreamSpan.cacheReadTokens, 1024, "claude stream cache-read tokens from message_start");
    assert.strictEqual(claudeCacheStreamSpan.cacheCreationTokens, 2048, "claude stream cache-write tokens from message_start");

    const novaMetricsStreamSpan = bedrockSpans.find((e) => e.operation === "invoke_model_with_response_stream" && e.model === "amazon.nova-micro-v1:0");
    assert.ok(novaMetricsStreamSpan, "invoke_model_with_response_stream span emitted for the nova metrics stream");
    assert.strictEqual(novaMetricsStreamSpan.completion, "pong", "nova stream text deltas accumulated");
    assert.strictEqual(novaMetricsStreamSpan.tokensIn, 3084, "invocationMetrics reports cache counts alongside inputTokenCount and Bedrock excludes them from it, so ignoring them under-bills the prompt");
    assert.strictEqual(novaMetricsStreamSpan.tokensOut, 7, "nova stream output tokens from invocationMetrics");
    assert.strictEqual(novaMetricsStreamSpan.cacheReadTokens, 1024, "nova stream cache-read tokens from invocationMetrics");
    assert.strictEqual(novaMetricsStreamSpan.cacheCreationTokens, 2048, "nova stream cache-write tokens from invocationMetrics");

    const agentSpan = bedrockSpans.find((e) => e.operation === "invoke_agent");
    assert.ok(agentSpan, "invoke_agent span emitted");
    assert.strictEqual(agentSpan.completion, "agent reply", "invoke_agent chunk bytes accumulated");
    assert.strictEqual(agentSpan.attributes["gen_ai.conversation.id"], "sess_1", "invoke_agent session id");
    assert.strictEqual(agentSpan.sessionId, "sess_1", "invoke_agent session id reaches the envelope sessionId facet");

    const retrieveSpan = captured.find((e) => e.operation === "retrieve");
    assert.ok(retrieveSpan, "retrieve span emitted");
    assert.strictEqual(retrieveSpan.spanType, "db_query", "retrieve is a db_query span");
    assert.strictEqual(retrieveSpan.attributes["db.vector.match_count"], 1, "retrieve match count");
    assert.strictEqual(retrieveSpan.attributes["aws.bedrock.knowledge_base.id"], "KB1", "retrieve knowledge base id");

    const ragSpan = bedrockSpans.find((e) => e.operation === "retrieve_and_generate");
    assert.ok(ragSpan, "retrieve_and_generate span emitted");
    assert.strictEqual(ragSpan.prompt, "who runs it?", "retrieve_and_generate prompt comes from input.text");
    assert.strictEqual(ragSpan.completion, "grounded answer", "retrieve_and_generate output.text captured");
    assert.strictEqual(ragSpan.attributes["aws.bedrock.knowledge_base.id"], "KB2", "retrieve_and_generate knowledge base id");
    assert.strictEqual(ragSpan.model, "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20240620-v1:0", "retrieve_and_generate model from modelArn");

    const dbq = captured.filter((e) => e.spanType === "db_query");
    assert.ok(dbq.some((d) => d.operation === "User.count"), "prisma db_query span emitted");

    const voiceTurn = captured.find((e) => e.operation === "voice.turn");
    assert.ok(voiceTurn, "voice.turn span emitted");
    assert.ok((voiceTurn.completion || voiceTurn.attributes?.["evalkit.completion"] || "").includes("hello"), "voice turn captured model text");
    assert.ok(captured.some((e) => e.operation === "voice.session"), "voice.session span emitted");

    const vfSpan = captured.find((e) => e.operation === "voidFn");
    assert.ok(vfSpan, "voidFn function_call span emitted");
    assert.ok(!("function.result" in (vfSpan.attributes || {})), "undefined result is not stored as a span attribute");

    console.log(`OK — ${captured.length} spans captured; all TS smoke assertions passed`);
    process.exit(0);
  }, 800);
});

setTimeout(() => {
  console.error("TIMEOUT — smoke test did not finish");
  process.exit(1);
}, 8000);
