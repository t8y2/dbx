import { strict as assert } from "node:assert";
import { test } from "vitest";
import { buildAiAgentPlan } from "../../apps/desktop/src/lib/ai/aiAgentPlan.ts";
import type { AiAction, AiAssistantMode } from "../../apps/desktop/src/lib/ai/ai.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

function conn(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id: "c1",
    name: "local-pg",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app_dev",
    ...overrides,
  };
}

function planInput(
  overrides: {
    mode?: AiAssistantMode;
    action?: AiAction;
    instruction?: string;
    assistantContent?: string;
    connection?: ConnectionConfig;
  } = {},
) {
  return {
    mode: overrides.mode ?? "agent",
    action: overrides.action ?? "generate",
    instruction: overrides.instruction ?? "查一下用户数量",
    assistantContent: overrides.assistantContent ?? "```sql\nSELECT count(*) FROM users\n```",
    connection: overrides.connection ?? conn(),
  };
}

test("ask mode records generated SQL but skips execution", () => {
  const plan = buildAiAgentPlan(planInput({ mode: "ask" }));

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
    { kind: "execute_sql", status: "skipped", reason: "ask_mode" },
  ]);
  assert.equal(plan.executableSql, undefined);
});

test("agent mode auto-executes read SQL when the user asks to query", () => {
  const plan = buildAiAgentPlan(planInput());

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
    {
      kind: "risk_check",
      status: "done",
      action: "auto_execute",
      environment: "non_production",
      category: "read",
      reasons: [],
    },
    { kind: "execute_sql", status: "pending", sql: "SELECT count(*) FROM users" },
  ]);
  assert.equal(plan.executableSql, "SELECT count(*) FROM users");
  assert.equal(plan.handoffSql, "SELECT count(*) FROM users");
});

test("agent mode auto-executes table inventory metadata SQL for natural Chinese questions", () => {
  const sql = "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;";
  const plan = buildAiAgentPlan(
    planInput({
      instruction: "当前有哪些表",
      assistantContent: `SQL\n\n\n\n\`\`\`sql\n${sql}\n\`\`\``,
    }),
  );

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql },
    {
      kind: "risk_check",
      status: "done",
      action: "auto_execute",
      environment: "non_production",
      category: "read",
      reasons: [],
    },
    { kind: "execute_sql", status: "pending", sql },
  ]);
  assert.equal(plan.handoffSql, sql);
});

test("agent mode skips execution when the user explicitly asks not to run", () => {
  const plan = buildAiAgentPlan(planInput({ instruction: "只生成 SQL，不要执行" }));

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
    { kind: "execute_sql", status: "skipped", reason: "no_execution_intent" },
  ]);
  assert.equal(plan.executableSql, undefined);
  assert.equal(plan.handoffSql, undefined);
});

test("non-generate actions do not execute even in agent mode", () => {
  const plan = buildAiAgentPlan(planInput({ action: "optimize", instruction: "优化这条 SQL" }));

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
  ]);
  assert.equal(plan.executableSql, undefined);
  assert.equal(plan.handoffSql, undefined);
});

test("task-oriented Agent actions do not drive client-side execution", () => {
  for (const action of ["query", "exploreSchema", "executeAndExplain"] as AiAction[]) {
    const plan = buildAiAgentPlan(planInput({ action, instruction: "查一下用户数量" }));

    assert.deepEqual(plan.steps, [
      { kind: "generate_sql", status: "done", sql: "SELECT count(*) FROM users" },
    ]);
    assert.equal(plan.executableSql, undefined);
    assert.equal(plan.handoffSql, undefined);
  }
});

test("agent plan blocks dangerous SQL", () => {
  const plan = buildAiAgentPlan(
    planInput({
      assistantContent: "```sql\nDROP TABLE users\n```",
    }),
  );

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "DROP TABLE users" },
    {
      kind: "risk_check",
      status: "done",
      action: "block",
      environment: "non_production",
      category: "dangerous",
      reasons: [],
    },
    { kind: "execute_sql", status: "skipped", reason: "blocked_by_policy" },
  ]);
  assert.equal(plan.executableSql, undefined);
  assert.equal(plan.handoffSql, "DROP TABLE users");
});

test("agent plan requires confirmation for production writes", () => {
  const plan = buildAiAgentPlan(
    planInput({
      assistantContent: "```sql\nINSERT INTO users(name) VALUES ('a')\n```",
      connection: conn({ name: "prod-db", host: "10.0.0.9", database: "app_prod" }),
    }),
  );

  assert.equal(plan.steps[1]?.kind, "risk_check");
  assert.equal(plan.steps[1]?.status, "done");
  if (plan.steps[1]?.kind === "risk_check") {
    assert.equal(plan.steps[1].action, "confirm");
    assert.equal(plan.steps[1].environment, "production");
    assert.equal(plan.steps[1].category, "low_risk_write");
  }
  assert.deepEqual(plan.steps[2], {
    kind: "execute_sql",
    status: "skipped",
    reason: "requires_confirmation",
  });
  assert.equal(plan.executableSql, undefined);
  assert.equal(plan.handoffSql, "INSERT INTO users(name) VALUES ('a')");
});

test("agent plan skips execution when no SQL block is present", () => {
  const plan = buildAiAgentPlan(planInput({ assistantContent: "我需要更多信息。" }));

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "skipped", reason: "no_sql" },
    { kind: "execute_sql", status: "skipped", reason: "no_sql" },
  ]);
  assert.equal(plan.executableSql, undefined);
});

test("agent plan ignores comment-only SQL blocks and executes the first real SQL block", () => {
  const plan = buildAiAgentPlan(
    planInput({
      instruction: "查一下当前数据库里有哪些表",
      assistantContent: ["当前数据库中的表：", "```sql", "-- 当前数据库中的表（仅从已加载的 Schema 上下文得知）：", "-- public.ihli_data", "```", "若需查看该表数据，可执行：", "```sql", "SELECT * FROM ihli_data", "LIMIT 10;", "```"].join("\n"),
    }),
  );

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "done", sql: "SELECT * FROM ihli_data\nLIMIT 10;" },
    {
      kind: "risk_check",
      status: "done",
      action: "auto_execute",
      environment: "non_production",
      category: "read",
      reasons: [],
    },
    { kind: "execute_sql", status: "pending", sql: "SELECT * FROM ihli_data\nLIMIT 10;" },
  ]);
  assert.equal(plan.handoffSql, "SELECT * FROM ihli_data\nLIMIT 10;");
});

test("agent plan treats comment-only SQL responses as no SQL", () => {
  const plan = buildAiAgentPlan(
    planInput({
      assistantContent: "```sql\n-- public.ihli_data\n```",
    }),
  );

  assert.deepEqual(plan.steps, [
    { kind: "generate_sql", status: "skipped", reason: "no_sql" },
    { kind: "execute_sql", status: "skipped", reason: "no_sql" },
  ]);
  assert.equal(plan.handoffSql, undefined);
});
