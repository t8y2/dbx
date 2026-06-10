import { strict as assert } from "node:assert";
import { test } from "vitest";
import { classifyAiSqlExecution, classifyConnectionEnvironment, shouldAttemptAiAutoExecute } from "../../apps/desktop/src/lib/aiSqlExecutionPolicy.ts";
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

test("classifyConnectionEnvironment treats local and dev targets as non-production", () => {
  assert.equal(classifyConnectionEnvironment(conn()), "non_production");
  assert.equal(classifyConnectionEnvironment(conn({ name: "staging-db", host: "10.0.0.8" })), "non_production");
});

test("classifyConnectionEnvironment treats production signals and unknown targets as production-like", () => {
  assert.equal(classifyConnectionEnvironment(conn({ name: "prod-db", host: "10.0.0.9" })), "production");
  assert.equal(classifyConnectionEnvironment(conn({ name: "analytics", host: "10.0.0.9", database: "warehouse" })), "unknown");
});

test("read SQL auto-executes on production and non-production", () => {
  assert.equal(classifyAiSqlExecution("SELECT * FROM users", conn()).action, "auto_execute");
  assert.equal(classifyAiSqlExecution("SHOW TABLES", conn({ name: "prod-db" })).action, "auto_execute");
});

test("single insert auto-executes only on non-production targets", () => {
  assert.equal(classifyAiSqlExecution("INSERT INTO users(name) VALUES ('a')", conn()).action, "auto_execute");
  assert.equal(classifyAiSqlExecution("INSERT INTO users(name) VALUES ('a')", conn({ name: "prod-db" })).action, "confirm");
});

test("scoped single update auto-executes only on non-production targets", () => {
  const sql = "UPDATE users SET name = 'a' WHERE id = 1";
  assert.equal(classifyAiSqlExecution(sql, conn()).action, "auto_execute");
  assert.equal(classifyAiSqlExecution(sql, conn({ name: "prod-db" })).action, "confirm");
});

test("broad or destructive writes do not auto-execute", () => {
  assert.equal(classifyAiSqlExecution("UPDATE users SET name = 'a'", conn()).action, "block");
  assert.equal(classifyAiSqlExecution("UPDATE users SET name = 'a' WHERE 1=1", conn()).action, "block");
  assert.equal(classifyAiSqlExecution("DELETE FROM users WHERE id = 1", conn()).action, "confirm");
  assert.equal(classifyAiSqlExecution("DROP TABLE users", conn()).action, "block");
});

test("comments and multi-statement writes do not bypass policy", () => {
  assert.equal(classifyAiSqlExecution("-- SELECT\nDROP TABLE users", conn()).action, "block");
  assert.equal(classifyAiSqlExecution("INSERT INTO users(name) VALUES ('a'); UPDATE users SET name='b' WHERE id=1", conn()).action, "confirm");
});

test("AI auto-execution trusts generated SQL in agent generate mode unless the user opts out", () => {
  assert.equal(shouldAttemptAiAutoExecute("查一下用户数量", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("帮我查ihli的平均值", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("看下 ihli 平均是多少", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("求 ihli 的最大值", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("计算 ihli 总数", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("显示最近 10 条订单", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("获取用户数量", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("当前有哪些表", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("这个库有什么表", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("当前表列表", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("show me recent orders", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("现在库里表的情况是？", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("生成一个查询用户数量的 SQL", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("你好", "generate"), true);
  assert.equal(shouldAttemptAiAutoExecute("", "generate"), false);
  assert.equal(shouldAttemptAiAutoExecute("只生成 SQL，不要执行", "generate"), false);
  assert.equal(shouldAttemptAiAutoExecute("先别跑，帮我查一下用户数量", "generate"), false);
  assert.equal(shouldAttemptAiAutoExecute("优化这条 SQL", "optimize"), false);
});
