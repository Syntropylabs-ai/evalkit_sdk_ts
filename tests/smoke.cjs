// End-to-end smoke test against the built dist. No real providers/network.
// Run: node tests/smoke.cjs   (after `npm run build`)
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

  evalkit.init({ subscriptionKey: "tk_test", baseUrl: `http://127.0.0.1:${port}`, serviceName: "smoke" });

  // 1) evaluate()
  const r = evalkit.evaluate({
    output: "AWS and Azure",
    expectedTools: ["a"],
    toolCalls: [{ name: "a" }],
    constraints: { requiredTerms: ["AWS"] },
  });
  assert.strictEqual(r.scores.tool_f1, 1.0, "evaluate tool_f1");
  assert.strictEqual(r.scores.response_match, 1.0, "evaluate response_match");

  // 2) new @google/genai patcher on a fake Models prototype
  class FakeModels {
    async generateContent(_req) {
      return {
        text: "hi there",
        candidates: [{ content: { parts: [{ text: "hi there" }, { functionCall: { name: "get_weather", args: { city: "london" } } }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 },
      };
    }
  }
  evalkit.patchGoogleGenAIModels(FakeModels.prototype);
  await new FakeModels().generateContent({ model: "gemini-2.0-flash", contents: "weather?" });

  // 2b) DB patcher (fake pg) → db_query span (requires an active trace)
  class FakePg {
    async query(_text, _values) { return { rowCount: 2, rows: [] }; }
  }
  evalkit.patchPgClient(FakePg);
  const dbTrace = evalkit.startTrace("db-req");
  await evalkit.withTrace(dbTrace.ctx, async () => {
    await new FakePg().query("SELECT * FROM users WHERE id=$1", [1]);
  });
  dbTrace.end("OK");

  // 2c) OpenAI-shaped client with a tool call → llm_call + nested tool_call span
  const fakeOpenAI = {
    chat: { completions: { create: async () => ({
      id: "c1", model: "gpt-4o",
      choices: [{ message: { content: "done", tool_calls: [{ id: "t1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    }) } },
  };
  evalkit.patchOpenAIClient(fakeOpenAI);
  await fakeOpenAI.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }] });

  // 3) langchainHandler() — no langchain installed → null, no crash
  const lh = await evalkit.langchainHandler();
  assert.strictEqual(lh, null, "langchainHandler null when absent");

  // 4) simulateUser with an explicit tool-returning entrypoint
  const report = await evalkit.simulateUser({
    entrypoint: async (ctx) => ({ text: `answer: ${ctx.message}`, toolCalls: [{ name: "search" }] }),
    scenarios: [
      { name: "s1", starting_prompt: "find docs", expected_tools: ["search"], target_keywords: ["answer"] },
      { name: "s2", starting_prompt: "again", expected_tools: ["search"] },
    ],
  });

  assert.strictEqual(report.results.length, 2, "two scenario results");
  assert.strictEqual(report.results[0].scores.tool_correctness, 1.0, "sim tool_correctness");

  // 5) evaluateSimulation() → POSTs to {apiUrl}/simulations/evaluate (BYOK judge)
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

  // give the exporter a tick to POST
  setTimeout(() => {
    server.close();

    const genai = captured.filter((e) => e.spanType === "llm_call" && e.provider === "google-genai");
    assert.ok(genai.length >= 1, "google-genai llm_call captured");
    assert.strictEqual(genai[0].completion, "hi there", "genai completion joined");
    assert.ok((genai[0].events || []).some((ev) => ev.attributes && ev.attributes["gen_ai.tool.name"] === "get_weather"), "genai tool event");

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
    const toolSpans = captured.filter((e) => e.spanType === "tool_call");
    assert.ok(toolSpans.some((t) => t.operation === "search"), "openai tool_call span emitted");

    console.log(`OK — ${captured.length} spans captured; all TS smoke assertions passed`);
    process.exit(0);
  }, 800);
});

setTimeout(() => {
  console.error("TIMEOUT — smoke test did not finish");
  process.exit(1);
}, 8000);
