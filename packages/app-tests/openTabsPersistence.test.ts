import { strict as assert } from "node:assert";
import { test } from "vitest";
import { restoreOpenTabsState, serializeOpenTabs } from "../../apps/desktop/src/lib/openTabsPersistence.ts";
import type { QueryTab } from "../../apps/desktop/src/types/database.ts";

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    sql: "select * from users",
    pinned: true,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
    ...overrides,
  };
}

test("serializes unsaved query tabs with editor context", () => {
  const saved = serializeOpenTabs([queryTab()]);

  assert.deepEqual(saved, [
    {
      id: "tab-1",
      title: "Query 1",
      connectionId: "conn-1",
      database: "app",
      schema: "public",
      sql: "select * from users",
      savedSqlId: undefined,
      pinned: true,
      mode: "query",
      objectBrowser: undefined,
      objectSource: undefined,
      tableMeta: undefined,
    },
  ]);
});

test("serializes object source query tabs with save context", () => {
  const saved = serializeOpenTabs([
    queryTab({
      title: "fn_add",
      customTitle: true,
      objectSource: {
        schema: "public",
        name: "fn_add",
        objectType: "FUNCTION",
      },
    }),
  ]);

  assert.deepEqual(saved[0]?.objectSource, {
    schema: "public",
    name: "fn_add",
    objectType: "FUNCTION",
  });
  assert.equal(saved[0]?.customTitle, true);
});

test("serializes table tabs with reload context", () => {
  const saved = serializeOpenTabs([
    queryTab({
      mode: "data",
      lastExecutedSql: "select * from users limit 100 offset 100",
      resultPageLimit: 100,
      resultPageOffset: 100,
      whereInput: "active = true",
      orderByInput: "created_at DESC",
      tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
    }),
  ]);

  assert.deepEqual(
    {
      mode: saved[0]?.mode,
      lastExecutedSql: saved[0]?.lastExecutedSql,
      resultPageLimit: saved[0]?.resultPageLimit,
      resultPageOffset: saved[0]?.resultPageOffset,
      whereInput: saved[0]?.whereInput,
      orderByInput: saved[0]?.orderByInput,
      tableMeta: saved[0]?.tableMeta,
    },
    {
      mode: "data",
      lastExecutedSql: "select * from users limit 100 offset 100",
      resultPageLimit: 100,
      resultPageOffset: 100,
      whereInput: "active = true",
      orderByInput: "created_at DESC",
      tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
    },
  );
});

test("serializes evicted result cache handles", () => {
  const saved = serializeOpenTabs([
    queryTab({
      resultEvicted: true,
      resultCacheKey: "tab:tab-1:result",
    }),
  ]);

  assert.equal(saved[0]?.resultEvicted, true);
  assert.equal(saved[0]?.resultCacheKey, "tab:tab-1:result");
});

test("does not persist table data result cache handles across restarts", () => {
  const saved = serializeOpenTabs([
    queryTab({
      mode: "data",
      resultEvicted: true,
      resultCacheKey: "tab:tab-1:result",
    }),
  ]);

  assert.equal(saved[0]?.resultEvicted, undefined);
  assert.equal(saved[0]?.resultCacheKey, undefined);
});

test("restores evicted result cache handles as disk-backed runtime state", () => {
  const raw = JSON.stringify([queryTab({ resultEvicted: true, resultCacheKey: "tab:tab-1:result" })]);

  const restored = restoreOpenTabsState(raw, "tab-1");

  assert.equal(restored.tabs[0]?.resultEvicted, true);
  assert.equal(restored.tabs[0]?.resultCacheKey, "tab:tab-1:result");
  assert.equal(restored.tabs[0]?.resultCacheState, "disk");
});

test("serializes query result run metadata without row payloads", () => {
  const saved = serializeOpenTabs([
    queryTab({
      activeResultRunId: "run-2",
      resultRuns: [
        {
          id: "run-1",
          title: "Run 1",
          sequence: 1,
          sql: "select 1",
          createdAt: 100,
          result: {
            columns: ["id"],
            rows: [[1]],
            affected_rows: 0,
            execution_time_ms: 1,
          },
          resultCacheKey: "tab:tab-1:run:run-1",
          resultCacheState: "disk",
          resultEvicted: true,
        },
      ],
    }),
  ]);

  assert.deepEqual(saved[0]?.resultRuns, [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 100,
      activeResultIndex: undefined,
      resultCacheKey: "tab:tab-1:run:run-1",
      resultEvicted: true,
    },
  ]);
  assert.equal(JSON.stringify(saved).includes("[[1]]"), false);
  assert.equal(saved[0]?.activeResultRunId, "run-2");
});

test("restores query result run metadata as disk-backed runtime state", () => {
  const raw = JSON.stringify([
    {
      ...queryTab(),
      activeResultRunId: "run-1",
      resultRuns: [
        {
          id: "run-1",
          title: "Run 1",
          sequence: 1,
          sql: "select 1",
          createdAt: 100,
          resultCacheKey: "tab:tab-1:run:run-1",
          resultEvicted: true,
        },
      ],
    },
  ]);

  const restored = restoreOpenTabsState(raw, "tab-1");

  assert.equal(restored.tabs[0]?.activeResultRunId, "run-1");
  assert.equal(restored.tabs[0]?.resultRuns?.[0]?.id, "run-1");
  assert.equal(restored.tabs[0]?.resultRuns?.[0]?.resultCacheState, "disk");
  assert.equal(restored.tabs[0]?.resultRuns?.[0]?.result, undefined);
});

test("ignores legacy table data result cache handles on restore", () => {
  const raw = JSON.stringify([queryTab({ mode: "data", resultEvicted: true, resultCacheKey: "tab:tab-1:result" })]);

  const restored = restoreOpenTabsState(raw, "tab-1");

  assert.equal(restored.tabs[0]?.resultEvicted, undefined);
  assert.equal(restored.tabs[0]?.resultCacheKey, undefined);
  assert.equal(restored.tabs[0]?.resultCacheState, undefined);
});

test("restores unsaved query tabs and active tab after restart", () => {
  const raw = JSON.stringify([queryTab({ id: "tab-1", sql: "select 1" }), queryTab({ id: "tab-2", title: "Query 2", sql: "select 2" })]);

  const restored = restoreOpenTabsState(raw, "tab-2");

  assert.deepEqual(
    restored.tabs.map((tab) => ({ id: tab.id, sql: tab.sql, isExecuting: tab.isExecuting })),
    [
      { id: "tab-1", sql: "select 1", isExecuting: false },
      { id: "tab-2", sql: "select 2", isExecuting: false },
    ],
  );
  assert.equal(restored.activeTabId, "tab-2");
});

test("restores object source save context", () => {
  const raw = JSON.stringify([
    queryTab({
      customTitle: true,
      objectSource: {
        schema: "public",
        name: "fn_add",
        objectType: "FUNCTION",
      },
    }),
  ]);

  const restored = restoreOpenTabsState(raw, "tab-1");

  assert.deepEqual(restored.tabs[0]?.objectSource, {
    schema: "public",
    name: "fn_add",
    objectType: "FUNCTION",
  });
  assert.equal(restored.tabs[0]?.customTitle, true);
});

test("restores data and structure tabs with table state", () => {
  const raw = JSON.stringify([
    queryTab({
      id: "data",
      title: "public.users",
      mode: "data",
      sql: 'SELECT * FROM "public"."users" LIMIT 50 OFFSET 50;',
      lastExecutedSql: 'SELECT * FROM "public"."users" LIMIT 50 OFFSET 50;',
      resultPageLimit: 50,
      resultPageOffset: 50,
      whereInput: "id > 10",
      orderByInput: "id DESC",
      tableMeta: {
        schema: "public",
        tableName: "users",
        columns: [
          {
            name: "id",
            data_type: "integer",
            is_nullable: false,
            column_default: null,
            is_primary_key: true,
            extra: null,
          },
        ],
        primaryKeys: ["id"],
      },
    }),
    queryTab({
      id: "structure",
      title: "Edit users",
      mode: "structure",
      sql: "",
      structureTableName: "users",
    }),
  ]);

  const restored = restoreOpenTabsState(raw, "data");

  assert.deepEqual(
    restored.tabs.map((tab) => ({ id: tab.id, mode: tab.mode })),
    [
      { id: "data", mode: "data" },
      { id: "structure", mode: "structure" },
    ],
  );
  assert.equal(restored.activeTabId, "data");
  assert.equal(restored.tabs[0]?.tableMeta?.tableName, "users");
  assert.equal(restored.tabs[0]?.resultPageLimit, 50);
  assert.equal(restored.tabs[0]?.resultPageOffset, 50);
  assert.equal(restored.tabs[0]?.whereInput, "id > 10");
  assert.equal(restored.tabs[0]?.orderByInput, "id DESC");
  assert.equal(restored.tabs[1]?.structureTableName, "users");
});

test("query-only restore keeps legacy query tabs without a mode", () => {
  const raw = JSON.stringify([
    {
      id: "legacy",
      title: "Query 1",
      connectionId: "conn-1",
      database: "app",
      sql: "select now()",
    },
    queryTab({ id: "data", title: "users", mode: "data" }),
  ]);

  const restored = restoreOpenTabsState(raw, "data", { queryOnly: true });

  assert.deepEqual(
    restored.tabs.map((tab) => ({ id: tab.id, mode: tab.mode })),
    [{ id: "legacy", mode: "query" }],
  );
  assert.equal(restored.activeTabId, "legacy");
});

test("ignores invalid persisted tab payloads", () => {
  const restored = restoreOpenTabsState(JSON.stringify([{ id: "missing-fields" }, queryTab()]), "missing-fields");

  assert.deepEqual(
    restored.tabs.map((tab) => tab.id),
    ["tab-1"],
  );
  assert.equal(restored.activeTabId, "tab-1");
});
