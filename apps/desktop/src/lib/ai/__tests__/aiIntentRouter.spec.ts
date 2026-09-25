import { describe, expect, it, vi } from "vitest";
import * as api from "@/lib/backend/api";
import { AGENT_ACTIONS, ASK_ACTIONS, buildAgentRequest, isValidActionForMode, type AiAction, type AiContext } from "@/lib/ai/ai";
import { INTENT_CLASSIFY_MAX_TEXT_CHARS, actionForIntent, classifyIntentByLlm, intentCandidatesForMode, parseClassifierAction, requestsExplicitExecution, routeIntent, routeIntentByRules, type AiIntent, type AiIntentRouteInput } from "@/lib/ai/aiIntentRouter";
import type { AiConfig } from "@/stores/settingsStore";

/**
 * #9118 — the "Auto" picker entry routes a send onto one existing action.
 * These cases pin the two-stage contract: the rule layer must be narrow (no
 * hijacking plain chat), the classifier branch must be candidate-bounded and
 * fail-safe, "auto" must never reach the transport layer, and Agent mode must
 * only reach an execution-capable action when the request explicitly asks to
 * run/query (an "explain"/"fix" request must never execute SQL).
 */

const config = { provider: "openai", apiKey: "test", authMethod: "api-key", endpoint: "https://example.invalid", model: "model", apiStyle: "completions" } as AiConfig;

function input(overrides: Partial<AiIntentRouteInput> & { text: string }): AiIntentRouteInput {
  return { hasCurrentSql: false, hasLastError: false, mode: "ask", ...overrides };
}

function context(overrides: Partial<AiContext> = {}): AiContext {
  return { connectionId: "conn-1", connectionName: "Postgres", databaseType: "postgres", database: "app", currentSql: "select 1", tables: [], sqlFiles: [], csvFiles: [], truncated: false, ...overrides };
}

/** Gate-open sample: an unambiguous data request (查一下 anchors the execution gate). */
const EXPLICIT_DATA_TEXT = "查一下这张表里的数据";

describe("routeIntentByRules — Ask mode golden cases", () => {
  // Every non-general Ask action is reachable from an unambiguous zh/en sample.
  it("routes SQL-production requests to generate", () => {
    expect(routeIntentByRules(input({ text: "帮我生成一条按用户统计订单量的 SQL" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "generate a SQL query for monthly revenue per region" }))).toBe("generate");
  });

  it("routes explanations of the current SQL to explain", () => {
    expect(routeIntentByRules(input({ text: "解释一下这段 SQL 做了什么", hasCurrentSql: true }))).toBe("explain");
    expect(routeIntentByRules(input({ text: "explain what this query does", hasCurrentSql: true }))).toBe("explain");
  });

  it("routes optimization requests to optimize", () => {
    expect(routeIntentByRules(input({ text: "优化一下这条 SQL 的查询性能", hasCurrentSql: true }))).toBe("optimize");
    expect(routeIntentByRules(input({ text: "optimize this query, it is too slow", hasCurrentSql: true }))).toBe("optimize");
  });

  it("routes error reports to fix", () => {
    expect(routeIntentByRules(input({ text: "这段 SQL 报错了，帮我看看", hasLastError: true, hasCurrentSql: true }))).toBe("fix");
    expect(routeIntentByRules(input({ text: "please fix this SQL error", hasLastError: true, hasCurrentSql: true }))).toBe("fix");
  });

  it("routes dialect rewrites to convert", () => {
    expect(routeIntentByRules(input({ text: "把这段 SQL 转成 PostgreSQL 方言", hasCurrentSql: true }))).toBe("convert");
    expect(routeIntentByRules(input({ text: "convert this query to SQL Server", hasCurrentSql: true }))).toBe("convert");
  });

  it("routes sample/mock data requests to sampleData", () => {
    expect(routeIntentByRules(input({ text: "生成一批测试数据插入到订单表" }))).toBe("sampleData");
    expect(routeIntentByRules(input({ text: "create sample data for the orders table" }))).toBe("sampleData");
  });

  it("maps run-and-explain onto explain in Ask mode (Ask never executes)", () => {
    expect(routeIntentByRules(input({ text: "执行这段 SQL 并解释结果", hasCurrentSql: true }))).toBe("explain");
  });

  it("maps data-query wording onto generate in Ask mode (Ask produces SQL, never runs it)", () => {
    expect(routeIntentByRules(input({ text: "查询订单表里最近 7 天的订单" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "fetch the latest orders for each customer" }))).toBe("generate");
  });
});

describe("routeIntentByRules — Agent mode golden cases", () => {
  it("routes data queries to query", () => {
    expect(routeIntentByRules(input({ text: "查询订单表里最近 7 天的订单", mode: "agent" }))).toBe("query");
    expect(routeIntentByRules(input({ text: "fetch the latest orders for each customer", mode: "agent" }))).toBe("query");
  });

  it("routes schema questions to exploreSchema", () => {
    expect(routeIntentByRules(input({ text: "这个库里有哪些表", mode: "agent" }))).toBe("exploreSchema");
    expect(routeIntentByRules(input({ text: "list tables in this database", mode: "agent" }))).toBe("exploreSchema");
  });

  it("routes run-and-explain requests to executeAndExplain", () => {
    expect(routeIntentByRules(input({ text: "执行这段 SQL 并解释结果", hasCurrentSql: true, mode: "agent" }))).toBe("executeAndExplain");
    expect(routeIntentByRules(input({ text: "run this query and explain the results", hasCurrentSql: true, mode: "agent" }))).toBe("executeAndExplain");
  });

  it("routes SQL-only production to generate", () => {
    expect(routeIntentByRules(input({ text: "写一条按用户统计订单量的 SQL", mode: "agent" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "write a SQL query that counts orders per user", mode: "agent" }))).toBe("generate");
  });

  it("maps Ask-style (non-execution) intents onto non-executing Agent actions", () => {
    // Safety (#9118 review): an explanation request must NOT reach an
    // execution-capable Agent action — Auto would run SQL the user never asked
    // to run. `general` explains without an execute contract; `generate`'s
    // SQL-first output contract would be wrong for an explanation.
    const explained = routeIntentByRules(input({ text: "解释一下这段 SQL 做了什么", hasCurrentSql: true, mode: "agent" }));
    expect(explained).toBe("general");
    expect(explained).not.toBe("executeAndExplain");
    expect(explained).not.toBe("query");

    // Error repair produces corrected SQL; it does not investigate by running it.
    const fixed = routeIntentByRules(input({ text: "这段 SQL 报错了", hasLastError: true, hasCurrentSql: true, mode: "agent" }));
    expect(fixed).toBe("generate");
    expect(fixed).not.toBe("query");
    expect(fixed).not.toBe("executeAndExplain");

    expect(routeIntentByRules(input({ text: "优化一下这条 SQL", hasCurrentSql: true, mode: "agent" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "把这段 SQL 转成 MySQL", hasCurrentSql: true, mode: "agent" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "生成一批测试数据", mode: "agent" }))).toBe("generate");
  });

  it("keeps every non-execution intent on a non-executing Agent action (table-level)", () => {
    // Guards the mapping TABLE itself, not just the samples above: reverting
    // `explain → executeAndExplain` / `fix → query` fails here even if the
    // sample-based expectations were edited to match the reverted behavior.
    const executionActions: AiAction[] = ["query", "executeAndExplain"];
    const nonExecutionIntents: AiIntent[] = ["generate", "explain", "optimize", "fix", "convert", "sampleData", "exploreSchema"];
    for (const intent of nonExecutionIntents) {
      const action = actionForIntent(intent, "agent");
      expect(executionActions, `${intent} → ${action}`).not.toContain(action);
      expect(isValidActionForMode(action, "agent"), `${intent} → ${action}`).toBe(true);
    }
    // The only execution-capable intents are the ones the guard also gates on.
    expect(actionForIntent("query", "agent")).toBe("query");
    expect(actionForIntent("executeAndExplain", "agent")).toBe("executeAndExplain");
  });

  it("keeps an explanation of the current query outside the execution gate", () => {
    // `查询` is also a noun in a static SQL explanation. It must not admit
    // execution-capable actions unless the request names a data target.
    expect(requestsExplicitExecution("解释一下这个查询")).toBe(false);
    expect(routeIntentByRules(input({ text: "解释一下这个查询", mode: "agent" }))).toBe("general");
  });

  it("still routes explicitly execution-asking requests to the execution actions", () => {
    // Guard against over-tightening: the invariant gates on an EXPLICIT
    // run/query request, and those keep their tool-backed actions.
    for (const text of ["查询订单表里最近 7 天的订单", "fetch the latest orders", "查一下今天的新增用户"]) {
      expect(routeIntentByRules(input({ text, mode: "agent" })), text).toBe("query");
    }
    for (const text of ["执行这段 SQL 并解释结果", "run this query and explain the results"]) {
      expect(routeIntentByRules(input({ text, hasCurrentSql: true, mode: "agent" })), text).toBe("executeAndExplain");
    }
  });

  it("never returns an execution-capable Agent action for a non-run request", () => {
    const nonRunSamples = [
      "解释一下这段 SQL 做了什么",
      "这段 SQL 报错了",
      "优化一下这条 SQL",
      "把这段 SQL 转成 MySQL",
      "生成一批测试数据",
      "写一条统计订单的 SQL",
      "这个库里有哪些表",
      "你好",
      "Show me how to create a table",
      "Get help writing a stored procedure",
      "查询语句的执行顺序是什么？",
      "查询语句如何使用索引？",
    ];
    for (const text of nonRunSamples) {
      const routed = routeIntentByRules(input({ text, hasCurrentSql: true, hasLastError: true, mode: "agent" }));
      expect(["query", "executeAndExplain"], `${text} → ${routed}`).not.toContain(routed);
    }
  });

  it("keeps every Ask-mode mapping non-executing", () => {
    expect(routeIntentByRules(input({ text: "查询订单数据" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "这个库里有哪些表" }))).toBe("generate");
    expect(routeIntentByRules(input({ text: "执行这段 SQL 并解释结果", hasCurrentSql: true }))).toBe("explain");
  });

  it("only ever returns actions valid for the current mode", () => {
    const samples = ["帮我生成一条 SQL", "解释一下这段 SQL", "优化这条 SQL 性能", "这段 SQL 报错了", "转成 MySQL 方言", "生成测试数据", "查询订单数据", "这个库里有哪些表", "执行这段 SQL 并解释结果", "你好"];
    for (const mode of ["ask", "agent"] as const) {
      for (const text of samples) {
        const routed = routeIntentByRules(input({ text, hasCurrentSql: true, hasLastError: true, mode }));
        if (routed) expect(isValidActionForMode(routed, mode), `${mode}/${text} → ${routed}`).toBe(true);
      }
    }
  });
});

describe("requestsExplicitExecution — narrow execution gate", () => {
  it("does not open for explanatory/code-generation uses of broad verbs (P1 regression)", () => {
    // The gate is deliberately narrower than the rule layer's permissive
    // routing vocabulary: show/get/find/list (看看/获取/找一下/列出) also
    // introduce explanations and code-generation requests, which must never
    // make execution-capable actions available to the classifier.
    for (const text of [
      "Show me how to create a table",
      "Get help writing a stored procedure",
      "list the pros and cons of composite indexes",
      "find the best join order for this query",
      "看看别人是怎么写分页的",
      "获取一下连接超时的处理建议",
      "找一下有没有现成的分页写法",
      "查询语句的执行顺序是什么？",
      "查询语句如何使用索引？",
    ]) {
      expect(requestsExplicitExecution(text), text).toBe(false);
    }
  });

  it("opens for unambiguous run/query-data phrasing in both languages", () => {
    for (const text of ["run this", "execute the migration", "fetch the latest orders", "query the order records", "查询订单表里最近 7 天的订单", "查一下今天的新增用户", "统计一下各状态的订单数"]) {
      expect(requestsExplicitExecution(text), text).toBe(true);
    }
  });

  it("routes table-listing wording onto the non-executing schema action", () => {
    // Canonical broad-verb data requests are answered by exploreSchema
    // (list_tables) rather than the broad query bucket, so narrowing the gate
    // does not degrade them into classifier guesses.
    expect(routeIntentByRules(input({ text: "show me the tables", mode: "agent" }))).toBe("exploreSchema");
    expect(routeIntentByRules(input({ text: "列出所有表", mode: "agent" }))).toBe("exploreSchema");
    expect(routeIntentByRules(input({ text: "列出所有表" }))).toBe("generate");
  });
});

describe("routeIntentByRules — context signals and narrowness", () => {
  it("does not route a plain chat message that merely contains '优化'", () => {
    expect(routeIntentByRules(input({ text: "帮我优化一下下周的会议安排" }))).toBeNull();
    expect(routeIntentByRules(input({ text: "how can I optimize my team workflow?" }))).toBeNull();
  });

  it("requires SQL context for optimize/explain, but an explicit SQL object counts", () => {
    expect(routeIntentByRules(input({ text: "优化一下这条 SQL" }))).toBe("optimize");
    expect(routeIntentByRules(input({ text: "解释一下这个查询" }))).toBe("explain");
    expect(routeIntentByRules(input({ text: "优化一下" }))).toBeNull();
    expect(routeIntentByRules(input({ text: "explain this" }))).toBeNull();
  });

  it("treats a failed run plus error wording as a fix signal", () => {
    expect(routeIntentByRules(input({ text: "为什么这次执行出错了", hasLastError: true }))).toBe("fix");
    expect(routeIntentByRules(input({ text: "为什么慢", hasLastError: true }))).toBeNull();
  });

  it("does not let an unrelated failed run hijack an explicit dialect request", () => {
    expect(routeIntentByRules(input({ text: "把这段 SQL 转成 MySQL", hasCurrentSql: true, hasLastError: true }))).toBe("convert");
  });

  it("falls through for greetings, thanks and empty text", () => {
    expect(routeIntentByRules(input({ text: "你好" }))).toBeNull();
    expect(routeIntentByRules(input({ text: "hello there, nice to meet you" }))).toBeNull();
    expect(routeIntentByRules(input({ text: "谢谢" }))).toBeNull();
    expect(routeIntentByRules(input({ text: "   " }))).toBeNull();
  });

  it("treats a short confirmation/refusal reply as a continuation, not a new intent", () => {
    // "可以" answers the previous proposal (aiProposalDetect): the mode default
    // is used without a classifier call, so a write confirmation never stalls.
    expect(routeIntentByRules(input({ text: "可以", hasCurrentSql: true, mode: "agent" }))).toBe("general");
    expect(routeIntentByRules(input({ text: "go ahead", mode: "agent" }))).toBe("general");
    expect(routeIntentByRules(input({ text: "不用了" }))).toBe("general");
    // A real request that merely starts with a confirmation word is still routed.
    expect(routeIntentByRules(input({ text: "可以帮我生成一条统计订单的 SQL" }))).toBe("generate");
  });
});

describe("classifyIntentByLlm (slow path)", () => {
  it("accepts a strict JSON answer from the candidate set", async () => {
    // EXPLICIT_DATA_TEXT is an explicit data request, so the execution actions
    // stay in the candidate set here (see the execution-invariant block below).
    const complete = vi.fn().mockResolvedValue('{"action":"query"}');
    await expect(classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT, mode: "agent" }), { config, complete })).resolves.toBe("query");
  });

  it("only offers the current mode's actions to the model", async () => {
    const askComplete = vi.fn().mockResolvedValue('{"action":"general"}');
    await classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT, mode: "ask" }), { config, complete: askComplete });
    const askPrompt = askComplete.mock.calls[0][0].systemPrompt as string;
    expect(askPrompt).toContain(`Allowed actions: ${ASK_ACTIONS.join(", ")}.`);
    expect(askPrompt).not.toContain("executeAndExplain");

    const agentComplete = vi.fn().mockResolvedValue('{"action":"general"}');
    await classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT, mode: "agent" }), { config, complete: agentComplete });
    const agentPrompt = agentComplete.mock.calls[0][0].systemPrompt as string;
    expect(agentPrompt).toContain(`Allowed actions: ${AGENT_ACTIONS.join(", ")}.`);
    expect(agentPrompt).not.toContain("sampleData");
  });

  it("sends no history, no task contract and only the trimmed user text", async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"general"}');
    const longText = "a".repeat(INTENT_CLASSIFY_MAX_TEXT_CHARS + 500);
    await classifyIntentByLlm(input({ text: `  ${longText}  `, mode: "ask" }), { config, complete });
    const request = complete.mock.calls[0][0];
    expect(request.taskContract).toBeUndefined();
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0]).toEqual({ role: "user", content: longText.slice(0, INTENT_CLASSIFY_MAX_TEXT_CHARS) });
    expect(request.maxTokens).toBeLessThanOrEqual(64);
    expect(request.systemPrompt).not.toContain(longText);
  });

  it("falls back to general on prose, malformed JSON, unknown and out-of-candidate actions", async () => {
    for (const answer of ["I think you want to query data", "", "not json", '{"action":"nonsense"}', '{"action":42}']) {
      const complete = vi.fn().mockResolvedValue(answer);
      await expect(classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT, mode: "agent" }), { config, complete })).resolves.toBe("general");
    }
    // `query` is a valid Agent action but not an Ask one.
    const complete = vi.fn().mockResolvedValue('{"action":"query"}');
    await expect(classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT, mode: "ask" }), { config, complete })).resolves.toBe("general");
  });

  it("falls back to general when the classifier rejects or times out", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("provider down"));
    await expect(classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT }), { config, complete: failing })).resolves.toBe("general");

    const hanging = vi.fn().mockImplementation(() => new Promise<string>(() => {}));
    await expect(classifyIntentByLlm(input({ text: EXPLICIT_DATA_TEXT }), { config, complete: hanging, timeoutMs: 5 })).resolves.toBe("general");
  });

  it("skips the call entirely when there is no text to classify", async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"query"}');
    await expect(classifyIntentByLlm(input({ text: "   ", mode: "agent" }), { config, complete })).resolves.toBe("general");
    expect(complete).not.toHaveBeenCalled();
  });

  it("uses the plain completion path (never the agent loop) by default", async () => {
    const complete = vi.spyOn(api, "aiComplete").mockResolvedValue('{"action":"optimize"}');
    const agentStream = vi.spyOn(api, "aiAgentStream").mockResolvedValue("done");
    try {
      await expect(classifyIntentByLlm(input({ text: "优化一下这段 SQL", hasCurrentSql: true }), { config })).resolves.toBe("optimize");
      expect(complete).toHaveBeenCalledTimes(1);
      expect(agentStream).not.toHaveBeenCalled();
      const request = complete.mock.calls[0][0];
      expect(request.taskContract).toBeUndefined();
      expect(request.config).toBe(config);
    } finally {
      complete.mockRestore();
      agentStream.mockRestore();
    }
  });
});

describe("classifyIntentByLlm — Agent execution invariant", () => {
  const NON_RUN_TEXT = "帮我把这段 SQL 描述得更清楚一点";
  const RUN_TEXT = "查一下今天的新增用户";

  it("keeps execution actions out of the candidate prompt for a non-run request", async () => {
    expect(requestsExplicitExecution(NON_RUN_TEXT)).toBe(false);
    const complete = vi.fn().mockResolvedValue('{"action":"general"}');
    await classifyIntentByLlm(input({ text: NON_RUN_TEXT, hasCurrentSql: true, mode: "agent" }), { config, complete });
    const prompt = complete.mock.calls[0][0].systemPrompt as string;
    expect(prompt).toContain("Allowed actions: general, exploreSchema, generate.");
    expect(prompt).not.toContain("executeAndExplain");
    expect(prompt).not.toMatch(/Allowed actions:[^.]*\bquery\b/);
  });

  it("rejects a hallucinated execution pick for a non-run request", async () => {
    for (const answer of ['{"action":"query"}', '{"action":"executeAndExplain"}']) {
      const complete = vi.fn().mockResolvedValue(answer);
      await expect(classifyIntentByLlm(input({ text: NON_RUN_TEXT, hasCurrentSql: true, mode: "agent" }), { config, complete }), answer).resolves.toBe("general");
    }
    // The same answers are honored when the user did ask to run.
    const runComplete = vi.fn().mockResolvedValue('{"action":"query"}');
    await expect(classifyIntentByLlm(input({ text: RUN_TEXT, mode: "agent" }), { config, complete: runComplete })).resolves.toBe("query");
    const runPrompt = runComplete.mock.calls[0][0].systemPrompt as string;
    expect(runPrompt).toContain(`Allowed actions: ${AGENT_ACTIONS.join(", ")}.`);
  });

  it("keeps execution actions unreachable for explanatory show/get requests (P1 regression)", async () => {
    // Review finding: "Show me how to create a table" matched the broad
    // data-request vocabulary, which used to admit `query` into the classifier
    // candidates. The narrow gate must keep it closed end to end — rule layer
    // AND classifier — even against a hostile `{"action":"query"}` answer.
    for (const text of ["Show me how to create a table", "Get help writing a stored procedure", "查询语句的执行顺序是什么？", "查询语句如何使用索引？"]) {
      expect(requestsExplicitExecution(text), text).toBe(false);
      const rules = routeIntentByRules(input({ text, mode: "agent" }));
      expect(rules === null || !["query", "executeAndExplain"].includes(rules as AiAction), `${text} → ${rules}`).toBe(true);
      const complete = vi.fn().mockResolvedValue('{"action":"query"}');
      const resolved = await routeIntent(input({ text, mode: "agent" }), { config, complete });
      expect(resolved, text).toBe("general");
      const prompt = complete.mock.calls[0][0].systemPrompt as string;
      expect(prompt).toContain("Allowed actions: general, exploreSchema, generate.");
    }
  });

  it("filters the candidate list programmatically, for both modes", () => {
    const agentDefault = intentCandidatesForMode("agent", true);
    expect(agentDefault).toEqual(AGENT_ACTIONS);
    const agentReduced = intentCandidatesForMode("agent", false);
    expect(agentReduced).toEqual(["general", "exploreSchema", "generate"]);
    expect(agentReduced).not.toContain("query");
    expect(agentReduced).not.toContain("executeAndExplain");
    // Ask mode has no execution-capable action, so nothing changes there.
    expect(intentCandidatesForMode("ask", false)).toEqual(ASK_ACTIONS);
    expect(intentCandidatesForMode("ask", true)).toEqual(ASK_ACTIONS);
  });

  it("never resolves an execution action through routeIntent for a non-run request", async () => {
    // The rule layer misses this text, so the (restricted) classifier answers.
    const complete = vi.fn().mockResolvedValue('{"action":"executeAndExplain"}');
    const resolved = await routeIntent(input({ text: NON_RUN_TEXT, hasCurrentSql: true, mode: "agent" }), { config, complete });
    expect(resolved).toBe("general");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("parseClassifierAction", () => {
  it("extracts the action from a JSON object even when wrapped in prose or a fence", () => {
    expect(parseClassifierAction('```json\n{"action":"fix"}\n```', "ask")).toBe("fix");
    expect(parseClassifierAction('Sure: {"action":"optimize"}', "ask")).toBe("optimize");
    expect(parseClassifierAction('{"action":"  fix  "}', "ask")).toBe("fix");
  });

  it("rejects answers outside the mode's candidate set", () => {
    expect(parseClassifierAction('{"action":"auto"}', "ask")).toBeNull();
    expect(parseClassifierAction('{"action":"exploreSchema"}', "ask")).toBeNull();
    expect(parseClassifierAction('{"action":"exploreSchema"}', "agent")).toBe("exploreSchema");
  });
});

describe("routeIntent (two-stage entry point)", () => {
  it("never calls the model when the rule layer already matched", async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"general"}');
    await expect(routeIntent(input({ text: "把这段 SQL 转成 PostgreSQL", hasCurrentSql: true }), { config, complete })).resolves.toBe("convert");
    expect(complete).not.toHaveBeenCalled();
  });

  it("consults the classifier only after a rule miss", async () => {
    const complete = vi.fn().mockResolvedValue('{"action":"exploreSchema"}');
    // "帮我总结一下这份报告" matches no rule pattern, so the slow path runs.
    await expect(routeIntent(input({ text: "帮我总结一下这份报告", mode: "agent" }), { config, complete })).resolves.toBe("exploreSchema");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("'auto' never reaches the transport layer", () => {
  it("keeps the concrete action tables free of 'auto'", () => {
    expect(ASK_ACTIONS).not.toContain("auto");
    expect(AGENT_ACTIONS).not.toContain("auto");
    expect(isValidActionForMode("auto" as unknown as AiAction, "ask")).toBe(false);
    expect(isValidActionForMode("auto" as unknown as AiAction, "agent")).toBe(false);
  });

  it("resolves every routed action into a concrete taskContract.action", async () => {
    const samples = ["帮我生成一条 SQL", "解释一下这段 SQL", "优化这条 SQL 性能", "这段 SQL 报错了", "转成 MySQL 方言", "生成测试数据", "查询订单数据", "这个库里有哪些表", "执行这段 SQL 并解释结果"];
    for (const mode of ["ask", "agent"] as const) {
      for (const text of samples) {
        const routeInput = input({ text, hasCurrentSql: true, hasLastError: true, mode });
        const resolved = (await routeIntent(routeInput, { config, complete: vi.fn().mockResolvedValue('{"action":"general"}') })) as AiAction;
        expect(isValidActionForMode(resolved, mode)).toBe(true);
        const request = buildAgentRequest({ config, action: resolved, mode, instruction: text, context: context() }, undefined, undefined);
        expect(request.taskContract.action).toBe(resolved);
        expect(request.taskContract.action).not.toBe("auto");
      }
    }
  });

  it("never puts an Agent execution action on the wire for an explain/fix request", async () => {
    // End-to-end shape of the safety finding: the resolved action is what lands
    // in `taskContract.action`, so it must be non-executing for these inputs.
    // Both are resolved by the rule layer (the injected classifier answer is a
    // deliberately hostile "execute!" pick), and the classifier-only path is
    // covered by the execution-invariant block above.
    const cases = [
      { text: "解释一下这段 SQL 做了什么", answer: '{"action":"executeAndExplain"}' },
      { text: "这段 SQL 报错了", answer: '{"action":"query"}' },
    ];
    for (const { text, answer } of cases) {
      const resolved = await routeIntent(input({ text, hasCurrentSql: true, hasLastError: true, mode: "agent" }), { config, complete: vi.fn().mockResolvedValue(answer) });
      expect(["query", "executeAndExplain"], `${text} → ${resolved}`).not.toContain(resolved);
      const request = buildAgentRequest({ config, action: resolved, mode: "agent", instruction: text, context: context() }, undefined, undefined);
      expect(request.taskContract.action).toBe(resolved);
    }
  });
});
