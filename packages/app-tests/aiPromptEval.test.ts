import { strict as assert } from "node:assert";
import { test } from "vitest";
import type { AiAction, AiAssistantMode, AiContext } from "../../apps/desktop/src/lib/ai/ai.ts";

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

const { buildSystemPrompt } = await import("../../apps/desktop/src/lib/ai/ai.ts");

function baseContext(overrides: Partial<AiContext> = {}): AiContext {
  return {
    connectionId: "conn-1",
    connectionName: "prod-analytics",
    databaseType: "postgres",
    database: "warehouse",
    currentSql: "select user_id, count(*) from public.orders group by user_id",
    lastError: undefined,
    lastResultPreview: 'user_id="u1", count=3\nuser_id="u2", count=7',
    tables: [
      {
        schema: "public",
        name: "orders",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "uuid", is_nullable: false, is_primary_key: true },
          { name: "user_id", data_type: "uuid", is_nullable: false },
          { name: "created_at", data_type: "timestamp", is_nullable: false },
          { name: "total", data_type: "numeric", is_nullable: false },
        ],
        indexes: [
          { name: "idx_orders_user_id", columns: ["user_id"], is_unique: false, is_primary: false },
          { name: "idx_orders_created_at", columns: ["created_at"], is_unique: false, is_primary: false },
        ],
        foreignKeys: [{ column: "user_id", ref_table: "users", ref_column: "id" }],
      },
      {
        schema: "public",
        name: "users",
        tableType: "TABLE",
        columns: [
          { name: "id", data_type: "uuid", is_nullable: false, is_primary_key: true },
          { name: "email", data_type: "text", is_nullable: false },
        ],
      },
    ],
    sqlFiles: [],
    truncated: false,
    ...overrides,
  };
}

interface PromptEvalCase {
  name: string;
  action: AiAction;
  mode: AiAssistantMode;
  context?: Partial<AiContext>;
  mustInclude: RegExp[];
  mustNotInclude?: RegExp[];
}

const cases: PromptEvalCase[] = [
  {
    name: "agent generate keeps the first SQL block executable and read-oriented",
    action: "generate",
    mode: "agent",
    mustInclude: [/Agent 模式/, /execute_query/, /第一个 ```sql 代码块只放最终推荐 SQL/, /只有 SELECT.*WITH.*SHOW.*DESCRIBE.*EXPLAIN.*可以通过 execute_query 执行/],
  },
  {
    name: "ask generate never implies auto execution",
    action: "generate",
    mode: "ask",
    mustInclude: [/Ask 模式/, /只生成 SQL 和说明/, /不要暗示已经执行或即将自动执行/],
  },
  {
    name: "truncated schema blocks guessing and points users to table mentions",
    action: "generate",
    mode: "ask",
    context: { truncated: true },
    mustInclude: [/Schema context is truncated/, /不要猜测/, /@table/, /只读探索\/元数据查询/],
  },
  {
    name: "focused table context tells agent to verify table inventory with metadata SQL",
    action: "generate",
    mode: "agent",
    context: { schemaScope: "focused_table" },
    mustInclude: [/focused table only; not a complete database table list/, /不要直接断言不存在/, /只读元数据查询/, /有哪些表/],
    mustNotInclude: [/Schema context is complete\./],
  },
  {
    name: "sqlserver generation requires dialect-specific pagination and quoting",
    action: "generate",
    mode: "agent",
    context: { databaseType: "sqlserver" },
    mustInclude: [/Database type: sqlserver/, /严格使用当前数据库方言/, /LIMIT\/TOP\/OFFSET/],
  },
  {
    name: "optimization uses index evidence and calls out full scans",
    action: "optimize",
    mode: "ask",
    mustInclude: [/idx_orders_user_id/, /索引信息/, /全表扫描/, /最多 3 条说明/],
  },
  {
    name: "fixing SQL includes the backend error and a corrected SQL contract",
    action: "fix",
    mode: "ask",
    context: { lastError: 'column "userid" does not exist' },
    mustInclude: [/Last error:\ncolumn "userid" does not exist/, /修正后的 SQL/, /错误原因/, /改动说明/],
  },
  {
    name: "explain action keeps execution logic, risks, and performance in scope",
    action: "explain",
    mode: "ask",
    mustInclude: [/Current SQL:\nselect user_id/, /执行逻辑/, /风险点/, /性能注意事项/],
  },
  {
    name: "convert action requires target dialect caveats",
    action: "convert",
    mode: "ask",
    mustInclude: [/转换后的 SQL/, /目标方言/, /语法差异或不兼容点/],
  },
  {
    name: "sample data action separates mock data from real production data",
    action: "sampleData",
    mode: "ask",
    mustInclude: [/安全的示例 SQL/, /模拟数据/, /生产库写操作只给建议/],
  },
  {
    name: "base prompt keeps destructive SQL and multi-statement safety rails",
    action: "generate",
    mode: "agent",
    mustInclude: [/不要生成多语句 SQL/, /不要在同一个回答里混合 SELECT 和写操作/, /UPDATE 或 DELETE，必须带 WHERE/],
  },
  {
    name: "schema evidence includes foreign keys and indexes for join reasoning",
    action: "generate",
    mode: "ask",
    mustInclude: [/FK: user_id → users\.id/, /Index: idx_orders_user_id\(user_id\)/, /利用外键关系推断 JOIN 条件/],
  },
];

for (const item of cases) {
  test(`AI prompt eval: ${item.name}`, () => {
    const prompt = buildSystemPrompt(item.action, baseContext(item.context), item.mode);

    for (const pattern of item.mustInclude) {
      assert.match(prompt, pattern, `${item.name} should include ${pattern}`);
    }

    for (const pattern of item.mustNotInclude ?? []) {
      assert.doesNotMatch(prompt, pattern, `${item.name} should not include ${pattern}`);
    }
  });
}
