import { strict as assert } from "node:assert";
import test from "node:test";
import type { AiContext } from "../../apps/desktop/src/lib/ai.ts";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

const localStorage = new MemoryStorage();
localStorage.setItem("dbx-locale", "zh-CN");

Object.defineProperty(globalThis, "localStorage", {
  value: localStorage,
  configurable: true,
});

const { buildSystemPrompt } = await import("../../apps/desktop/src/lib/ai.ts");

function context(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionName: "prod-analytics",
    databaseType: "postgres",
    database: "app",
    currentSql: "",
    tables: [
      {
        schema: "public",
        name: "orders",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "uuid", is_nullable: false, is_primary_key: true },
          { name: "user_id", data_type: "uuid", is_nullable: false },
          { name: "total", data_type: "numeric", is_nullable: false },
        ],
        indexes: [{ name: "idx_orders_user_id", columns: ["user_id"], is_unique: false, is_primary: false }],
        foreignKeys: [{ column: "user_id", ref_table: "users", ref_column: "id" }],
      },
    ],
    truncated: false,
    ...overrides,
  };
}

test("agent mode prompt makes the first SQL block the executable recommendation", () => {
  const prompt = buildSystemPrompt("generate", context(), "agent");

  assert.match(prompt, /Agent 模式/);
  assert.match(prompt, /第一个 ```sql 代码块只能包含最终推荐执行的 SQL/);
  assert.match(prompt, /不要把解释性 SQL、备选 SQL、危险 SQL 放在第一个代码块/);
});

test("ask mode prompt forbids auto-execution assumptions", () => {
  const prompt = buildSystemPrompt("generate", context(), "ask");

  assert.match(prompt, /Ask 模式/);
  assert.match(prompt, /只生成 SQL 和说明/);
  assert.match(prompt, /不要暗示已经执行或即将自动执行/);
});

test("prompt gives explicit guidance for truncated schema context", () => {
  const prompt = buildSystemPrompt("generate", context({ truncated: true }), "ask");

  assert.match(prompt, /Schema context is truncated/);
  assert.match(prompt, /如果请求可能涉及未出现的表或字段，不要猜测/);
  assert.match(prompt, /@table/);
});

test("prompt enforces database dialect and single executable statement safety", () => {
  const prompt = buildSystemPrompt("generate", context({ databaseType: "sqlserver" }), "agent");

  assert.match(prompt, /严格使用当前数据库方言/);
  assert.match(prompt, /分页、日期函数、字符串拼接/);
  assert.match(prompt, /不要生成多语句 SQL/);
  assert.match(prompt, /不要在同一个回答里混合 SELECT 和写操作/);
});
