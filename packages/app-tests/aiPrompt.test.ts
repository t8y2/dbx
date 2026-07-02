import { strict as assert } from "node:assert";
import { test } from "vitest";
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

const { buildSystemPrompt, isVectorDbType, buildUserPrompt } = await import("../../apps/desktop/src/lib/ai.ts");

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
  assert.match(prompt, /第一个 ```sql 代码块只放最终推荐 SQL/);
  assert.match(prompt, /execute_query/);
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

test("focused table context is not presented as a complete table list", () => {
  const prompt = buildSystemPrompt("generate", context({ schemaScope: "focused_table" }), "agent");

  assert.match(prompt, /focused table only; not a complete database table list/);
  assert.match(prompt, /当前打开的表/);
  assert.match(prompt, /只读元数据查询/);
  assert.doesNotMatch(prompt, /Schema context is complete\./);
});

test("prompt enforces database dialect and single executable statement safety", () => {
  const prompt = buildSystemPrompt("generate", context({ databaseType: "sqlserver" }), "agent");

  assert.match(prompt, /严格使用当前数据库方言/);
  assert.match(prompt, /分页、日期函数、字符串拼接/);
  assert.match(prompt, /不要生成多语句 SQL/);
  assert.match(prompt, /不要在同一个回答里混合 SELECT 和写操作/);
});

// Vector database tests

function vectorContext(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionName: "my-qdrant",
    databaseType: "qdrant",
    database: "default",
    currentSql: "articles",
    tables: [
      {
        name: "articles",
        tableType: "COLLECTION",
        comment: "384d vector",
        columns: [],
      },
    ],
    truncated: false,
    ...overrides,
  };
}

test("isVectorDbType returns true for vector databases", () => {
  assert.equal(isVectorDbType("qdrant"), true);
  assert.equal(isVectorDbType("milvus"), true);
  assert.equal(isVectorDbType("weaviate"), true);
  assert.equal(isVectorDbType("chromadb"), true);
});

test("isVectorDbType returns false for SQL databases", () => {
  assert.equal(isVectorDbType("mysql"), false);
  assert.equal(isVectorDbType("postgres"), false);
  assert.equal(isVectorDbType("sqlserver"), false);
});

test("vector system prompt does not contain SQL references", () => {
  const prompt = buildSystemPrompt("generate", vectorContext(), "ask");

  assert.doesNotMatch(prompt, /```sql/);
  assert.doesNotMatch(prompt, /execute_query/);
  assert.match(prompt, /collection/);
  assert.match(prompt, /REST API/);
});

test("vector agent mode lists vector tools", () => {
  const prompt = buildSystemPrompt("generate", vectorContext(), "agent");

  assert.match(prompt, /list_collections/);
  assert.match(prompt, /browse_collection/);
  assert.doesNotMatch(prompt, /execute_query/);
  assert.doesNotMatch(prompt, /list_tables/);
});

test("vector focused table prompt warns about unknown collections", () => {
  const prompt = buildSystemPrompt("generate", vectorContext({ schemaScope: "focused_table" }), "agent");

  assert.match(prompt, /不是完整的集合列表/);
  assert.match(prompt, /当前打开的集合/);
  assert.match(prompt, /list_collections/);
});

test("vector ask mode mentions REST API format", () => {
  const prompt = buildSystemPrompt("generate", vectorContext(), "ask");

  assert.match(prompt, /REST API/);
  assert.match(prompt, /Qdrant/);
  assert.match(prompt, /list_collections/);
  assert.match(prompt, /do not browse collection data|不要浏览集合数据/);
  assert.doesNotMatch(prompt, /```sql/);
  assert.doesNotMatch(prompt, /execute_query/);
});

test("vector system prompt preserves last error and result preview", () => {
  const prompt = buildSystemPrompt(
    "generate",
    vectorContext({
      lastError: "Qdrant error",
      lastResultPreview: "id | payload\n1 | {}",
    }),
    "ask",
  );

  assert.match(prompt, /Last error:\nQdrant error/);
  assert.match(prompt, /Last result preview:\nid \| payload/);
});

test("buildUserPrompt skips action instruction for vector databases", () => {
  const vectorCtx = vectorContext();
  const sqlCtx = context();

  const vectorPrompt = buildUserPrompt("generate", vectorCtx, "show me articles", true);
  assert.equal(vectorPrompt, "show me articles");

  const sqlPrompt = buildUserPrompt("generate", sqlCtx, "show me users", true);
  assert.match(sqlPrompt, /Action: generate/);
  assert.match(sqlPrompt, /生成 SQL/);
});
