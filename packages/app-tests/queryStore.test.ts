import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { decodeQueryResultArchive } from "../../apps/desktop/src/lib/queryResultArchive.ts";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import { useSettingsStore } from "../../apps/desktop/src/stores/settingsStore.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";
import type { QueryResult } from "../../apps/desktop/src/types/database.ts";

function installMemoryStorage() {
  const values = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  return () => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  };
}

function conn(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

function oracleConn(id: string): ConnectionConfig {
  return {
    ...conn(id),
    db_type: "oracle",
    port: 1521,
  };
}

function withConnectionHealthMock(handler: typeof fetch): typeof fetch {
  return async (input, init) => {
    if (String(input) === "/api/connection/check-health") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return handler(input, init);
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("setErrorResult stops loading and shows the error result", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db", "users", "data");

  store.setExecuting(tabId, true);
  store.setErrorResult(tabId, new Error("metadata failed"));

  const tab = store.tabs.find((item) => item.id === tabId);
  assert.equal(tab?.isExecuting, false);
  assert.equal(tab?.isCancelling, false);
  assert.equal(tab?.executionId, undefined);
  assert.deepEqual(tab?.result?.columns, ["Error"]);
  assert.deepEqual(tab?.result?.rows, [["metadata failed"]]);
});

test("renames query tab titles", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");

  assert.equal(store.renameTab(tabId, " Revenue checks "), true);

  const tab = store.tabs.find((item) => item.id === tabId);
  assert.equal(tab?.title, "Revenue checks");
  assert.equal(tab?.customTitle, true);
});

test("linkExternalSqlPath records the local path and detaches saved SQL", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db", "draft.sql");

  store.updateSql(tabId, "select 1;");
  store.linkSavedSql(tabId, "saved-1", "library.sql");
  store.linkExternalSqlPath(tabId, "/tmp/draft.sql", "draft.sql");
  const tab = store.tabs.find((item) => item.id === tabId);

  assert.equal(tab?.externalSqlPath, "/tmp/draft.sql");
  assert.equal(tab?.savedSqlId, undefined);
  assert.equal(tab?.title, "draft.sql");
  assert.equal(store.isTabDirty(tab!), false);

  store.updateSql(tabId, "");
  assert.equal(store.isTabDirty(tab!), true);
});

test("external SQL file paths persist with open query tabs", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    let store = useQueryStore();
    const tabId = store.createTab("conn-1", "db", "draft.sql");
    store.updateSql(tabId, "select 1;");
    store.linkExternalSqlPath(tabId, "/tmp/draft.sql", "draft.sql");
    store.flushPendingPersist();

    setActivePinia(createPinia());
    store = useQueryStore();
    const tab = store.tabs.find((item) => item.id === tabId);

    assert.equal(tab?.externalSqlPath, "/tmp/draft.sql");
    assert.equal(tab?.savedSqlId, undefined);
    assert.equal(tab?.sql, "select 1;");
    assert.equal(store.isTabDirty(tab!), false);

    store.updateSql(tabId, "select 2;");
    assert.equal(store.isTabDirty(tab!), true);
  } finally {
    restoreStorage();
  }
});

test("clean saved SQL tabs persist without duplicating SQL text", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    let store = useQueryStore();
    store.openSavedSql({
      id: "saved-1",
      connectionId: "conn-1",
      name: "large.sql",
      database: "db",
      sql: "SELECT * FROM large_table;".repeat(100),
      sqlLoaded: true,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    });
    store.flushPendingPersist();

    const rawTabs = localStorage.getItem("dbx-open-tabs") ?? "";
    assert.equal(rawTabs.includes("large_table"), false);

    setActivePinia(createPinia());
    store = useQueryStore();
    const tab = store.tabs.find((item) => item.savedSqlId === "saved-1");

    assert.equal(tab?.sql, "");
    assert.equal(store.isTabDirty(tab!), false);
  } finally {
    restoreStorage();
  }
});

test("dirty saved SQL tabs keep unsaved edits in open tab persistence", async () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    let store = useQueryStore();
    const tabId = store.openSavedSql({
      id: "saved-1",
      connectionId: "conn-1",
      name: "draft.sql",
      database: "db",
      sql: "SELECT 1;",
      sqlLoaded: true,
      createdAt: "2026-06-27T00:00:00.000Z",
      updatedAt: "2026-06-27T00:00:00.000Z",
    });
    store.updateSql(tabId, "SELECT 2;");
    store.flushPendingPersist();

    const rawTabs = localStorage.getItem("dbx-open-tabs") ?? "";
    assert.equal(rawTabs.includes("SELECT 2;"), true);

    setActivePinia(createPinia());
    store = useQueryStore();
    const tab = store.tabs.find((item) => item.savedSqlId === "saved-1");

    assert.equal(tab?.sql, "SELECT 2;");
    assert.equal(store.isTabDirty(tab!), true);
  } finally {
    restoreStorage();
  }
});

test("marked-clean object source tabs close without unsaved confirmation", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db", "Source - refresh_orders");
  store.updateSql(tabId, "CREATE PROCEDURE refresh_orders() SELECT 1;");
  store.setObjectSource(tabId, {
    schema: "public",
    name: "refresh_orders",
    objectType: "PROCEDURE",
  });

  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  assert.equal(store.isTabDirty(tab), true);

  store.markTabClean(tab);
  assert.equal(store.isTabDirty(tab), false);

  store.closeTab(tabId);

  assert.equal(store.showCloseConfirm, false);
  assert.equal(
    store.tabs.some((item) => item.id === tabId),
    false,
  );
});

test("editing query sql preserves the displayed result editability state", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.sql = "select id, name from users";
  tab.lastExecutedSql = tab.sql;
  tab.resultBaseSql = tab.sql;
  tab.resultSortedSql = "select id, name from users order by name";
  tab.result = {
    columns: ["id", "name"],
    rows: [[1, "Ada"]],
    affected_rows: 0,
    execution_time_ms: 1,
  };
  tab.tableMeta = {
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
  };
  tab.queryAnalysis = {
    tableName: "users",
    selectStar: false,
    columns: [
      { sourceName: "id", resultName: "id", expression: "id" },
      { sourceName: "name", resultName: "name", expression: "name" },
    ],
  };
  tab.querySourceColumns = ["id", "name"];

  store.updateSql(tabId, "select id, name from users where active = true");

  assert.equal(tab.sql, "select id, name from users where active = true");
  assert.equal(tab.resultBaseSql, "select id, name from users");
  assert.equal(tab.resultSortedSql, "select id, name from users order by name");
  assert.deepEqual(tab.querySourceColumns, ["id", "name"]);
  assert.equal(tab.queryAnalysis?.tableName, "users");
  assert.equal(tab.tableMeta?.tableName, "users");
});

test("sortTabResultLocally sorts current rows and restores original order", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.resultBaseSql = "select id, name from users";
  tab.resultSortedSql = "select id, name from users order by name";
  tab.result = {
    columns: ["id", "name"],
    rows: [
      [2, "Grace"],
      [1, "Ada"],
      [3, "Linus"],
    ],
    affected_rows: 0,
    execution_time_ms: 1,
  };

  store.sortTabResultLocally(tabId, "name", 1, "asc");

  assert.deepEqual(tab.result?.rows, [
    [1, "Ada"],
    [2, "Grace"],
    [3, "Linus"],
  ]);
  assert.equal(tab.resultSortColumn, "name");
  assert.equal(tab.resultSortColumnIndex, 1);
  assert.equal(tab.resultSortDirection, "asc");
  assert.equal(tab.resultSortMode, "local");
  assert.equal(tab.resultSortedSql, undefined);

  store.sortTabResultLocally(tabId, "name", 1, null);

  assert.deepEqual(tab.result?.rows, [
    [2, "Grace"],
    [1, "Ada"],
    [3, "Linus"],
  ]);
  assert.equal(tab.resultSortColumn, undefined);
  assert.equal(tab.resultSortMode, undefined);
});

test("selecting a result run restores its displayed result without changing SQL draft", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.sql = "select draft";
  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 1,
      result: { columns: ["one"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 1",
    },
    {
      id: "run-2",
      title: "Run 2",
      sequence: 2,
      sql: "select 2",
      createdAt: 2,
      result: { columns: ["two"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 2",
    },
  ];
  tab.activeResultRunId = "run-2";

  await store.setActiveResultRun(tabId, "run-1");

  assert.equal(tab.sql, "select draft");
  assert.equal(tab.activeResultRunId, "run-1");
  assert.deepEqual(tab.result?.columns, ["one"]);
  assert.deepEqual(tab.result?.rows, [[1]]);
  assert.equal(tab.resultBaseSql, "select 1");
});

test("removing the active result run selects an adjacent run", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.sql = "select draft";
  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 1,
      result: { columns: ["one"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 1",
    },
    {
      id: "run-2",
      title: "Run 2",
      sequence: 2,
      sql: "select 2",
      createdAt: 2,
      result: { columns: ["two"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 2",
    },
    {
      id: "run-3",
      title: "Run 3",
      sequence: 3,
      sql: "select 3",
      createdAt: 3,
      result: { columns: ["three"], rows: [[3]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 3",
    },
  ];
  await store.setActiveResultRun(tabId, "run-2");

  assert.equal(store.removeResultRun(tabId, "run-2"), true);

  assert.deepEqual(
    tab.resultRuns?.map((run) => run.id),
    ["run-1", "run-3"],
  );
  assert.equal(tab.activeResultRunId, "run-3");
  assert.deepEqual(tab.result?.columns, ["three"]);
  assert.deepEqual(tab.result?.rows, [[3]]);
  assert.equal(tab.sql, "select draft");

  assert.equal(store.removeResultRun(tabId, "run-3"), true);

  assert.deepEqual(
    tab.resultRuns?.map((run) => run.id),
    ["run-1"],
  );
  assert.equal(tab.activeResultRunId, "run-1");
  assert.deepEqual(tab.result?.columns, ["one"]);
});

test("removed result runs are excluded from result archives", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db", "Revenue checks", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.sql = "select draft";
  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 1,
      result: { columns: ["one"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 1",
    },
    {
      id: "run-2",
      title: "Run 2",
      sequence: 2,
      sql: "select 2",
      createdAt: 2,
      result: { columns: ["two"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 2",
    },
  ];
  store.setActiveResultRun(tabId, "run-2");

  assert.equal(store.removeResultRun(tabId, "run-1"), true);
  const archive = await store.exportResultArchive(tabId);
  assert.ok(archive);
  const decoded = await decodeQueryResultArchive(archive);

  assert.deepEqual(
    decoded?.snapshot.resultRuns?.map((run) => run.id),
    ["run-2"],
  );
  assert.deepEqual(decoded?.snapshot.resultRuns?.[0]?.result?.columns, ["two"]);
  assert.deepEqual(decoded?.snapshot.resultRuns?.[0]?.result?.rows, [[2]]);
});

test("removing the last result run clears output and makes result archive unavailable", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 1,
      result: { columns: ["one"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 1",
    },
  ];
  store.setActiveResultRun(tabId, "run-1");

  assert.equal(store.removeResultRun(tabId, "run-1"), true);

  assert.deepEqual(tab.resultRuns, []);
  assert.equal(tab.activeResultRunId, undefined);
  assert.equal(tab.result, undefined);
  assert.equal(tab.results, undefined);
  assert.equal(await store.exportResultArchive(tabId), undefined);
});

test("result archives import into a new query tab with switchable runs", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db", "Revenue checks", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.sql = "select draft";
  tab.lastExecutedSql = "select 2";
  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1",
      createdAt: 1,
      result: { columns: ["one"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 1",
    },
    {
      id: "run-2",
      title: "Run 2",
      sequence: 2,
      sql: "select 2",
      createdAt: 2,
      result: { columns: ["two"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      resultBaseSql: "select 2",
    },
  ];
  tab.activeResultRunId = "run-2";
  await store.setActiveResultRun(tabId, "run-2");

  const archive = await store.exportResultArchive(tabId);
  assert.ok(archive);

  const importedTabId = await store.importResultArchive(archive);
  assert.ok(importedTabId);
  assert.notEqual(importedTabId, tabId);

  const imported = store.tabs.find((item) => item.id === importedTabId);
  assert.equal(imported?.title, "Revenue checks");
  assert.equal(imported?.customTitle, true);
  assert.equal(imported?.connectionId, "conn-1");
  assert.equal(imported?.database, "db");
  assert.equal(imported?.schema, "public");
  assert.equal(imported?.sql, "select draft");
  assert.equal(imported?.activeResultRunId, "run-2");
  assert.deepEqual(imported?.result?.columns, ["two"]);
  assert.deepEqual(imported?.result?.rows, [[2]]);

  await store.setActiveResultRun(importedTabId, "run-1");
  assert.deepEqual(imported?.result?.columns, ["one"]);
  assert.deepEqual(imported?.result?.rows, [[1]]);
});

test("completed query executions append result runs and select the latest run", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeCount = 0;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ sqlToExecute: body.options.sql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      executeCount++;
      return new Response(JSON.stringify([{ columns: [`run_${executeCount}`], rows: [[executeCount]], affected_rows: 0, execution_time_ms: 1 }]), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabId = store.createTab("conn-1", "db", "Query");
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "select 1");
    await store.executeTabSql(tabId, "select 2");

    const tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.resultRuns?.length, 2);
    assert.deepEqual(
      tab?.resultRuns?.map((run) => run.title),
      ["Run 1", "Run 2"],
    );
    assert.equal(tab?.resultRuns?.[0]?.sql, "select 1");
    assert.equal(tab?.resultRuns?.[1]?.sql, "select 2");
    assert.equal(tab?.activeResultRunId, tab?.resultRuns?.[1]?.id);
    assert.deepEqual(tab?.result?.columns, ["run_2"]);

    await store.setActiveResultRun(tabId, tab!.resultRuns![0]!.id);
    assert.deepEqual(tab?.result?.columns, ["run_1"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("failed query executions append switchable error result runs", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ sqlToExecute: body.options.sql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response("backend exploded", { status: 500 });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabId = store.createTab("conn-1", "db", "Query");
    store.toggleResultAutoSave(tabId);
    await store.executeTabSql(tabId, "select broken");

    const tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.resultRuns?.length, 1);
    assert.equal(tab?.activeResultRunId, tab?.resultRuns?.[0]?.id);
    assert.deepEqual(tab?.resultRuns?.[0]?.result?.columns, ["Error"]);
    assert.deepEqual(tab?.result?.columns, ["Error"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query execution errors mentioning connection keep the connection active", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  connectionStore.activeConnectionId = "conn-1";
  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ sqlToExecute: body.options.sql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response('relation "connection" does not exist', { status: 500 });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabId = store.createTab("conn-1", "db", "Query");
    await store.executeTabSql(tabId, "select connection from missing_table");

    assert.equal(connectionStore.connectedIds.has("conn-1"), true);
    assert.equal(connectionStore.activeConnectionId, "conn-1");
    assert.equal(connectionStore.connectionErrors["conn-1"], undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("statement result switching is scoped to the active result run", async () => {
  setActivePinia(createPinia());
  const store = useQueryStore();
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  tab.resultRuns = [
    {
      id: "run-1",
      title: "Run 1",
      sequence: 1,
      sql: "select 1; select 10",
      createdAt: 1,
      results: [
        { columns: ["a"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
        { columns: ["b"], rows: [[10]], affected_rows: 0, execution_time_ms: 1 },
      ],
      activeResultIndex: 0,
    },
    {
      id: "run-2",
      title: "Run 2",
      sequence: 2,
      sql: "select 2; select 20",
      createdAt: 2,
      results: [
        { columns: ["c"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
        { columns: ["d"], rows: [[20]], affected_rows: 0, execution_time_ms: 1 },
      ],
      activeResultIndex: 0,
    },
  ];
  tab.activeResultRunId = "run-1";
  await store.setActiveResultRun(tabId, "run-1");

  store.setActiveResultIndex(tabId, 1);
  assert.deepEqual(tab.result?.columns, ["b"]);
  assert.equal(tab.resultRuns[0]?.activeResultIndex, 1);

  await store.setActiveResultRun(tabId, "run-2");
  assert.deepEqual(tab.result?.columns, ["c"]);
  assert.equal(tab.activeResultIndex, 0);
});

test("normalizes unquoted Oracle query identifiers before loading editable metadata", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const columnRequests: Array<{ schema: string | null; table: string | null }> = [];

  connectionStore.addEphemeralConnection(oracleConn("oracle-1"));

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/execute-multi") {
      return new Response(
        JSON.stringify([
          {
            columns: ["ID", "NAME"],
            rows: [[1, "Ada"]],
            affected_rows: 0,
            execution_time_ms: 1,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/analyze-editability") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      assert.equal(body.sql, "select id, name from users");
      return new Response(
        JSON.stringify({
          editable: true,
          analysis: {
            schema: undefined,
            schemaQuoted: false,
            tableName: "users",
            tableNameQuoted: false,
            tableAlias: undefined,
            selectStar: false,
            columns: [
              { sourceName: "id", sourceNameQuoted: false, resultName: "id", expression: "id" },
              { sourceName: "name", sourceNameQuoted: false, resultName: "name", expression: "name" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.startsWith("/api/schema/columns?")) {
      const params = new URL(url, "http://localhost").searchParams;
      columnRequests.push({ schema: params.get("schema"), table: params.get("table") });
      return new Response(
        JSON.stringify([
          {
            name: "ID",
            data_type: "NUMBER",
            is_nullable: false,
            column_default: null,
            is_primary_key: true,
            extra: null,
            comment: "identifier",
          },
          {
            name: "NAME",
            data_type: "VARCHAR2",
            is_nullable: true,
            column_default: null,
            is_primary_key: false,
            extra: null,
            comment: "display name",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ sqlToExecute: body.options.sql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabId = store.createTab("oracle-1", "ORCL", "Query 1", "query", "app");
    await store.executeTabSql(tabId, "select id, name from users");

    const tab = store.tabs.find((item) => item.id === tabId);
    await waitFor(() => columnRequests.length > 0 && tab?.tableMeta?.tableName === "USERS");
    assert.deepEqual(columnRequests, [{ schema: "APP", table: "USERS" }]);
    assert.equal(tab?.tableMeta?.schema, "APP");
    assert.equal(tab?.tableMeta?.tableName, "USERS");
    assert.deepEqual(tab?.querySourceColumns, ["ID", "NAME"]);
    assert.equal(tab?.queryEditabilityReason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("evicting cached tab results releases multi-result payloads and sessions", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeCount = 0;
  const closedSessions: string[] = [];

  connectionStore.addEphemeralConnection(conn("conn-1"));

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/execute-multi") {
      executeCount++;
      const results: QueryResult[] = [
        {
          columns: ["id"],
          rows: [[executeCount]],
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: `session-${executeCount}`,
        },
        {
          columns: ["detail"],
          rows: [[`payload-${executeCount}`]],
          affected_rows: 0,
          execution_time_ms: 1,
        },
      ];
      return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/close-session") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      closedSessions.push(body.sessionId);
      return new Response(JSON.stringify(true), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          sqlToExecute: body.options.sql,
          useAgentResultSession: false,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const tabId = store.createTab("conn-1", "db", `Query ${i + 1}`);
      tabIds.push(tabId);
      await store.executeTabSql(tabId, `select ${i + 1}; select ${i + 1} as detail`);
    }

    const evicted = store.tabs.find((tab) => tab.id === tabIds[0]);
    assert.equal(executeCount, 7);
    assert.equal(evicted?.result, undefined);
    assert.equal(evicted?.results, undefined);
    assert.equal(evicted?.activeResultIndex, undefined);
    assert.equal(evicted?.resultSessionId, undefined);
    assert.equal(evicted?.resultEvicted, true);
    assert.deepEqual(closedSessions, ["session-1"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("result cache eviction keeps recently accessed inactive tabs", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeCount = 0;

  connectionStore.addEphemeralConnection(conn("conn-1"));

  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/execute-multi") {
      executeCount++;
      const results: QueryResult[] = [
        {
          columns: ["id"],
          rows: [[executeCount]],
          affected_rows: 0,
          execution_time_ms: 1,
          session_id: `session-${executeCount}`,
        },
      ];
      return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/close-session") {
      return new Response(JSON.stringify(true), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select 1", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const tabId = store.createTab("conn-1", "db", `Query ${i + 1}`);
      tabIds.push(tabId);
      await store.executeTabSql(tabId, `select ${i + 1}`);
    }

    store.activeTabId = tabIds[0];
    await new Promise((resolve) => setTimeout(resolve, 1));

    const tabId = store.createTab("conn-1", "db", "Query 7");
    tabIds.push(tabId);
    await store.executeTabSql(tabId, "select 7");

    const recentlyViewed = store.tabs.find((tab) => tab.id === tabIds[0]);
    const leastRecentlyUsed = store.tabs.find((tab) => tab.id === tabIds[1]);
    assert.ok(recentlyViewed?.result);
    assert.equal(recentlyViewed?.resultEvicted, undefined);
    assert.equal(leastRecentlyUsed?.result, undefined);
    assert.equal(leastRecentlyUsed?.resultEvicted, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("closing tabs clears removed result payloads before dropping tab references", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  try {
    setActivePinia(createPinia());
    const store = useQueryStore();
    const keepId = store.createTab("conn-1", "db", "keep");
    const closeId = store.createTab("conn-1", "db", "close");
    const closingTab = store.tabs.find((item) => item.id === closeId);

    assert.ok(closingTab);
    closingTab.result = {
      columns: ["payload"],
      rows: [[new Array(10_000).fill("x").join("")]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-close",
    };
    closingTab.results = [closingTab.result];
    closingTab.activeResultIndex = 0;
    closingTab.resultSessionId = "session-close";

    store.closeOtherTabs(keepId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(closingTab.result, undefined);
    assert.equal(closingTab.results, undefined);
    assert.equal(closingTab.activeResultIndex, undefined);
    assert.equal(closingTab.resultSessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("closing database tabs removes browser tabs for that database only", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    setActivePinia(createPinia());
    const store = useQueryStore();
    const dataId = store.createTab("conn-1", "db", "users", "data", "public");
    const objectsId = store.openObjectBrowser("conn-1", "db", "public");
    const structureId = store.openTableStructure("conn-1", "db", "public", "users");
    const mongoId = store.createTab("conn-1", "db", "orders", "mongo");
    const queryId = store.createTab("conn-1", "db", "draft query", "query");
    const otherDbId = store.createTab("conn-1", "analytics", "users", "data", "public");
    const otherConnectionId = store.createTab("conn-2", "db", "users", "data", "public");
    const structureTab = store.tabs.find((item) => item.id === structureId);

    assert.ok(structureTab);
    structureTab.result = {
      columns: ["payload"],
      rows: [["structure"]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-structure",
    };
    structureTab.resultSessionId = "session-structure";
    store.activeTabId = structureId;

    store.closeDatabaseTabs("conn-1", "db");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      store.tabs.map((tab) => tab.id),
      [otherDbId, otherConnectionId],
    );
    assert.equal(store.activeTabId, otherConnectionId);
    assert.equal(
      store.tabs.some((tab) => [dataId, objectsId, structureId, mongoId, queryId].includes(tab.id)),
      false,
    );
    assert.equal(structureTab.result, undefined);
    assert.equal(structureTab.resultSessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("closing connection tabs removes every tab for that connection only", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    setActivePinia(createPinia());
    const store = useQueryStore();
    const queryId = store.createTab("conn-1", "db", "draft query", "query");
    const dataId = store.createTab("conn-1", "db", "users", "data", "public");
    const objectsId = store.openObjectBrowser("conn-1", "db", "public");
    const otherConnectionId = store.createTab("conn-2", "db", "users", "data", "public");
    const queryTab = store.tabs.find((item) => item.id === queryId);

    assert.ok(queryTab);
    queryTab.result = {
      columns: ["payload"],
      rows: [["query"]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-query",
    };
    queryTab.resultSessionId = "session-query";
    store.activeTabId = queryId;

    store.closeConnectionTabs("conn-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      store.tabs.map((tab) => tab.id),
      [otherConnectionId],
    );
    assert.equal(store.activeTabId, otherConnectionId);
    assert.equal(
      store.tabs.some((tab) => [queryId, dataId, objectsId].includes(tab.id)),
      false,
    );
    assert.equal(queryTab.result, undefined);
    assert.equal(queryTab.resultSessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("releasing connection tabs keeps SQL tabs and closes object tabs", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    setActivePinia(createPinia());
    const store = useQueryStore();
    const queryId = store.createTab("conn-1", "db", "draft query", "query");
    const dataId = store.createTab("conn-1", "db", "users", "data", "public");
    const objectsId = store.openObjectBrowser("conn-1", "db", "public");
    const structureId = store.openTableStructure("conn-1", "db", "public", "users");
    const otherConnectionId = store.createTab("conn-2", "db", "users", "data", "public");
    const queryTab = store.tabs.find((item) => item.id === queryId);
    const dataTab = store.tabs.find((item) => item.id === dataId);

    assert.ok(queryTab);
    assert.ok(dataTab);
    queryTab.result = {
      columns: ["payload"],
      rows: [["query"]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-query",
    };
    queryTab.resultSessionId = "session-query";
    dataTab.result = {
      columns: ["payload"],
      rows: [["data"]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-data",
    };
    dataTab.resultSessionId = "session-data";
    store.activeTabId = dataId;

    store.releaseConnectionTabs("conn-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      store.tabs.map((tab) => tab.id),
      [queryId, otherConnectionId],
    );
    assert.equal(store.activeTabId, otherConnectionId);
    assert.equal(
      store.tabs.some((tab) => [dataId, objectsId, structureId].includes(tab.id)),
      false,
    );
    assert.equal(queryTab.result, undefined);
    assert.equal(queryTab.resultSessionId, undefined);
    assert.equal(dataTab.result, undefined);
    assert.equal(dataTab.resultSessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("releasing database tabs keeps SQL tabs and closes table tabs for that database only", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    setActivePinia(createPinia());
    const store = useQueryStore();
    const queryId = store.createTab("conn-1", "db", "draft query", "query");
    const dataId = store.createTab("conn-1", "db", "users", "data", "public");
    const otherDbId = store.createTab("conn-1", "analytics", "orders", "data", "public");
    const otherConnectionId = store.createTab("conn-2", "db", "users", "data", "public");
    const queryTab = store.tabs.find((item) => item.id === queryId);

    assert.ok(queryTab);
    queryTab.result = {
      columns: ["payload"],
      rows: [["query"]],
      affected_rows: 0,
      execution_time_ms: 1,
      session_id: "session-query",
    };
    queryTab.resultSessionId = "session-query";

    store.releaseDatabaseTabs("conn-1", "db");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      store.tabs.map((tab) => tab.id),
      [queryId, otherDbId, otherConnectionId],
    );
    assert.equal(
      store.tabs.some((tab) => tab.id === dataId),
      false,
    );
    assert.equal(queryTab.result, undefined);
    assert.equal(queryTab.resultSessionId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("disconnecting a connection closes every tab for that connection", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = withConnectionHealthMock(async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  try {
    setActivePinia(createPinia());
    const connectionStore = useConnectionStore();
    const queryStore = useQueryStore();
    connectionStore.addEphemeralConnection(conn("conn-1"));
    connectionStore.addEphemeralConnection(conn("conn-2"));
    const queryId = queryStore.createTab("conn-1", "db", "draft query", "query");
    const dataId = queryStore.createTab("conn-1", "db", "users", "data", "public");
    const otherConnectionId = queryStore.createTab("conn-2", "db", "users", "data", "public");

    queryStore.activeTabId = dataId;
    await connectionStore.disconnect("conn-1");
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      queryStore.tabs.map((tab) => tab.id),
      [otherConnectionId],
    );
    assert.equal(queryStore.activeTabId, otherConnectionId);
    assert.equal(
      queryStore.tabs.some((tab) => [queryId, dataId].includes(tab.id)),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("starting a new query clears the previous result payload immediately", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.result = {
    columns: ["old"],
    rows: [[new Array(10_000).fill("old").join("")]],
    affected_rows: 0,
    execution_time_ms: 1,
  };

  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select 1", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response(JSON.stringify([{ columns: ["new"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const execution = store.executeTabSql(tabId, "select 1");
    assert.equal(tab.result, undefined);
    assert.equal(tab.results, undefined);
    await execution;
    assert.deepEqual(tab.result?.columns, ["new"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("grid refreshes can preserve the previous result while loading", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  const previousResult: QueryResult = {
    columns: ["id", "name"],
    rows: [[1, "Ada"]],
    affected_rows: 0,
    execution_time_ms: 1,
  };
  tab.result = previousResult;

  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select 1 order by name", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response(JSON.stringify([{ columns: ["id", "name"], rows: [[2, "Grace"]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const execution = store.executeTabSql(tabId, "select 1 order by name", {
      preserveResultDuringExecution: true,
    });
    assert.deepEqual(tab.result?.columns, previousResult.columns);
    assert.deepEqual(tab.result?.rows, previousResult.rows);
    assert.equal(tab.isExecuting, true);
    await execution;
    assert.deepEqual(tab.result?.rows, [[2, "Grace"]]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("data tab execution preserves pagination offset metadata", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeBody: any;
  let preparedPagination = false;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "users", "data", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      preparedPagination = true;
      return new Response("unexpected pagination plan request", { status: 500 });
    }
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify([{ columns: ["id"], rows: [[101]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, 'SELECT * FROM "users" LIMIT 100 OFFSET 100;', {
      pagination: { limit: 100, offset: 100 },
    });

    assert.equal(preparedPagination, false);
    assert.equal(executeBody.sql, 'SELECT * FROM "users" LIMIT 100 OFFSET 100;');
    assert.equal(executeBody.maxRows, 100);
    assert.equal(executeBody.fetchSize, 100);
    assert.equal(executeBody.schema, undefined);
    assert.equal(tab.resultPageLimit, 100);
    assert.equal(tab.resultPageOffset, 100);
    assert.deepEqual(tab.result?.rows, [[101]]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("activating an empty data tab waits for explicit execution", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeBody: any;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "users", "data", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.sql = 'SELECT * FROM "public"."users" LIMIT 50 OFFSET 50;';
  tab.lastExecutedSql = tab.sql;
  tab.resultPageLimit = 50;
  tab.resultPageOffset = 50;

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify([{ columns: ["id"], rows: [[51]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.reloadEvictedTab(tabId);

    assert.equal(executeBody, undefined);
    assert.equal(tab.result, undefined);
    assert.equal(tab.resultPageLimit, 50);
    assert.equal(tab.resultPageOffset, 50);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query result export fetches every paginated page", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const preparedOffsets: number[] = [];
  const executedSqls: string[] = [];
  const timeoutSecs: unknown[] = [];

  connectionStore.addEphemeralConnection({ ...conn("conn-1"), query_timeout_secs: 600 });
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "select id from users";
  tab.resultPageLimit = 100;
  tab.resultPageOffset = 0;
  tab.result = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: true,
  };

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const offset = Number(body.options.pagination.offset);
      const limit = Number(body.options.pagination.limit);
      preparedOffsets.push(offset);
      return new Response(
        JSON.stringify({
          sqlToExecute: `select id from users /* offset:${offset} */`,
          pageSql: `select id from users /* offset:${offset} */`,
          pageLimit: limit,
          pageOffset: offset,
          useAgentResultSession: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executedSqls.push(body.sql);
      timeoutSecs.push(body.timeoutSecs);
      const rows = String(body.sql).includes("offset:0") ? Array.from({ length: 10_000 }, (_, index) => [index + 1]) : [[10_001], [10_002]];
      return new Response(JSON.stringify([{ columns: ["id"], rows, affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const exported = await store.fetchTabResultForExport(tabId);

    assert.deepEqual(preparedOffsets, [0, 10_000]);
    assert.deepEqual(executedSqls, ["select id from users /* offset:0 */", "select id from users /* offset:10000 */"]);
    assert.deepEqual(timeoutSecs, [600, 600]);
    assert.equal(exported?.rows.length, 10_002);
    assert.deepEqual(exported?.rows.at(-1), [10_002]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query result export treats the known query total as a progress estimate", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const preparedOffsets: number[] = [];
  const executedSqls: string[] = [];
  const progress: Array<{ rowsExported: number; totalRows: number | null }> = [];

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "select id from users";
  tab.resultBaseSql = tab.lastExecutedSql;
  tab.resultPageLimit = 100;
  tab.resultPageOffset = 0;
  tab.resultTotalRowCount = 5;
  tab.result = {
    columns: ["id"],
    rows: [[1], [2], [3], [4], [5]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: true,
  };

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const offset = Number(body.options.pagination.offset);
      const limit = Number(body.options.pagination.limit);
      preparedOffsets.push(offset);
      return new Response(
        JSON.stringify({
          sqlToExecute: `select id from users /* offset:${offset} */`,
          pageSql: `select id from users /* offset:${offset} */`,
          pageLimit: limit,
          pageOffset: offset,
          useAgentResultSession: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executedSqls.push(body.sql);
      const rows = String(body.sql).includes("offset:0") ? Array.from({ length: 10_000 }, (_, index) => [index + 1]) : [[10_001], [10_002]];
      return new Response(JSON.stringify([{ columns: ["id"], rows, affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const exported = await store.fetchTabResultForExport(tabId, (info) => progress.push(info));

    assert.deepEqual(preparedOffsets, [0, 10_000]);
    assert.deepEqual(executedSqls, ["select id from users /* offset:0 */", "select id from users /* offset:10000 */"]);
    assert.equal(exported?.rows.length, 10_002);
    assert.deepEqual(exported?.rows.at(-1), [10_002]);
    assert.deepEqual(progress, [
      { rowsExported: 10_000, totalRows: 5 },
      { rowsExported: 10_002, totalRows: 5 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("jdbc query pagination uses result sessions without capping max rows to one page", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let prepareBody: any;
  let executeBody: any;

  connectionStore.addEphemeralConnection({
    ...conn("jdbc-1"),
    db_type: "jdbc",
    connection_string: "jdbc:Cache://127.0.0.1:1972/USER",
    jdbc_driver_class: "com.intersys.jdbc.CacheDriver",
  });
  const tabId = store.createTab("jdbc-1", "", "Query", "query", "SQLUser");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      prepareBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          sqlToExecute: "SELECT * FROM CT_Loc",
          pageLimit: 100,
          pageOffset: 0,
          useAgentResultSession: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify([
          {
            columns: ["id"],
            rows: Array.from({ length: 100 }, (_, index) => [index + 1]),
            affected_rows: 0,
            execution_time_ms: 1,
            session_id: "session-1",
            has_more: true,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "SELECT * FROM CT_Loc");

    assert.equal(prepareBody.options.useAgentCursor, true);
    assert.equal(executeBody.pageSize, 100);
    assert.equal(executeBody.fetchSize, 100);
    assert.equal(executeBody.maxRows, undefined);
    assert.equal(executeBody.clientSessionId, tabId);
    assert.equal(tab.resultSessionId, "session-1");
    assert.equal(tab.result?.has_more, true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("mongo aggregate execution uses editor page size when pagination plan has no limit", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let aggregateBody: any;

  settingsStore.updateEditorSettings({ pageSize: 1000 });
  connectionStore.addEphemeralConnection({
    ...conn("mongo-1"),
    db_type: "mongodb",
    port: 27017,
  });

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify({ sqlToExecute: body.options.sql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/mongo/aggregate-documents") {
      aggregateBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          documents: Array.from({ length: 811 }, (_, index) => ({ line: index + 1 })),
          total: 811,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const tabId = store.createTab("mongo-1", "accounting", "Query", "query", "");
    await store.executeTabSql(tabId, 'db.getCollection("accounting_reconciliations").aggregate([{ "$match": {} }])');
    const tab = store.tabs.find((item) => item.id === tabId);

    assert.equal(aggregateBody.maxRows, 1000);
    assert.equal(aggregateBody.collection, "accounting_reconciliations");
    assert.equal(tab?.result?.rows.length, 811);
    assert.equal(tab?.result?.truncated, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("table data export fetches every filtered page", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const buildRequests: unknown[] = [];
  const executedSqls: string[] = [];

  connectionStore.addEphemeralConnection({ ...conn("conn-1"), db_type: "saphana" });
  const tabId = store.createTab("conn-1", "db", "users", "data", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.whereInput = "status = 'active'";
  tab.orderByInput = '"id" DESC';
  tab.result = {
    columns: ["id", "status"],
    rows: [[1, "active"]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: true,
  };
  tab.tableMeta = {
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
      {
        name: "status",
        data_type: "varchar",
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        extra: null,
      },
    ],
    primaryKeys: ["id"],
  };

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/build-table-select-sql") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      buildRequests.push(body.options);
      const { limit, offset } = body.options;
      return new Response(JSON.stringify(`SELECT * FROM "public"."users" WHERE (status = 'active') ORDER BY "id" DESC LIMIT ${limit} OFFSET ${offset ?? 0};`), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executedSqls.push(body.sql);
      const rows = String(body.sql).includes("OFFSET 0")
        ? Array.from({ length: 10_000 }, (_, index) => [index + 1, "active"])
        : [
            [10_001, "active"],
            [10_002, "active"],
          ];
      return new Response(JSON.stringify([{ columns: ["id", "status"], rows, affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const exported = await store.fetchTabResultForExport(tabId);

    assert.deepEqual(
      buildRequests.map((request) => ({
        databaseType: (request as any).databaseType,
        schema: (request as any).schema,
        tableName: (request as any).tableName,
        whereInput: (request as any).whereInput,
        orderBy: (request as any).orderBy,
        limit: (request as any).limit,
        offset: (request as any).offset,
      })),
      [
        {
          databaseType: "saphana",
          schema: "public",
          tableName: "users",
          whereInput: "status = 'active'",
          orderBy: '"id" DESC',
          limit: 10_000,
          offset: 0,
        },
        {
          databaseType: "saphana",
          schema: "public",
          tableName: "users",
          whereInput: "status = 'active'",
          orderBy: '"id" DESC',
          limit: 10_000,
          offset: 10_000,
        },
      ],
    );
    assert.deepEqual(executedSqls, ['SELECT * FROM "public"."users" WHERE (status = \'active\') ORDER BY "id" DESC LIMIT 10000 OFFSET 0;', 'SELECT * FROM "public"."users" WHERE (status = \'active\') ORDER BY "id" DESC LIMIT 10000 OFFSET 10000;']);
    assert.equal(exported?.rows.length, 10_002);
    assert.deepEqual(exported?.rows.at(-1), [10_002, "active"]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("agent-session query export raises maxRows to the configured export limit", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ exportRowLimit: 50_000, exportRowLimitEnabled: true });
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const executeBodies: any[] = [];

  connectionStore.addEphemeralConnection({
    ...conn("jdbc-1"),
    db_type: "jdbc",
    connection_string: "jdbc:sqlserver://127.0.0.1:1433;databaseName=db",
    jdbc_driver_class: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
  });
  const tabId = store.createTab("jdbc-1", "db", "Query", "query", "dbo");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "SELECT * FROM big_table";
  tab.result = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: true,
  };

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "SELECT * FROM big_table", pageLimit: 10_000, pageOffset: 0, useAgentResultSession: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executeBodies.push(body);
      const page = executeBodies.length;
      return new Response(
        JSON.stringify([
          {
            columns: ["id"],
            rows: Array.from({ length: 10_000 }, (_, index) => [(page - 1) * 10_000 + index + 1]),
            affected_rows: 0,
            execution_time_ms: 1,
            session_id: "session-1",
            has_more: page < 2,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/close-session") {
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/close-client-session") {
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const exported = await store.fetchTabResultForExport(tabId);

    // Every agent-session execute call must carry the configured export limit
    // as maxRows so the agent's cumulative cap doesn't truncate at 10000.
    assert.ok(executeBodies.length >= 2);
    for (const body of executeBodies) {
      assert.equal(body.maxRows, 50_000);
    }
    assert.equal(exported?.rows.length, 20_000);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query export stops at the configured row limit when enabled", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ exportRowLimit: 15_000, exportRowLimitEnabled: true });
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const planLimits: number[] = [];
  const executeMaxRows: number[] = [];

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "analytics", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "SELECT * FROM events";
  tab.result = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
    truncated: false,
    has_more: true,
  };

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const pagination = body.options.pagination;
      planLimits.push(pagination.limit);
      return new Response(
        JSON.stringify({
          sqlToExecute: `SELECT * FROM events LIMIT ${pagination.limit} OFFSET ${pagination.offset}`,
          pageLimit: pagination.limit,
          pageOffset: pagination.offset,
          useAgentResultSession: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      executeMaxRows.push(body.maxRows);
      const start = executeMaxRows.length === 1 ? 1 : 10_001;
      return new Response(
        JSON.stringify([
          {
            columns: ["id"],
            rows: Array.from({ length: body.maxRows }, (_, index) => [start + index]),
            affected_rows: 0,
            execution_time_ms: 1,
            has_more: true,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/close-client-session") {
      return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    const exported = await store.fetchTabResultForExport(tabId);

    assert.deepEqual(planLimits, [10_000, 5_000]);
    assert.deepEqual(executeMaxRows, [10_000, 5_000]);
    assert.equal(exported?.rows.length, 15_000);
    assert.deepEqual(exported?.rows.at(-1), [15_000]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("buildQueryResultExportRequest uses sorted SQL and independent row-limit settings", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({
    exportBatchSize: 2500,
    exportRowLimit: 200000,
    exportRowLimitEnabled: false,
    queryExportKeysetOptimizationEnabled: false,
  });
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "analytics", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.sql = "SELECT * FROM events";
  tab.lastExecutedSql = "SELECT * FROM events";
  tab.resultBaseSql = "SELECT * FROM events";
  tab.resultSortedSql = "SELECT * FROM (SELECT * FROM events) t ORDER BY created_at DESC";
  tab.resultTotalRowCount = 123456;
  tab.result = {
    columns: ["id", "created_at"],
    rows: [[1, "2026-06-24"]],
    affected_rows: 0,
    execution_time_ms: 1,
  };

  globalThis.fetch = withConnectionHealthMock(async () => new Response("unexpected request", { status: 500 }));

  try {
    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-1",
      filePath: "C:\\tmp\\events.csv",
      format: "csv",
    });

    assert.equal(request?.exportId, "export-1");
    assert.equal(request?.connectionId, "conn-1");
    assert.equal(request?.database, "analytics");
    assert.equal(request?.schema, "public");
    assert.equal(request?.sql, "SELECT * FROM (SELECT * FROM events) t ORDER BY created_at DESC");
    assert.equal(request?.queryBaseSql, "SELECT * FROM events");
    assert.equal(request?.databaseType, "postgres");
    assert.equal(request?.useAgentCursor, false);
    assert.equal(request?.filePath, "C:\\tmp\\events.csv");
    assert.equal(request?.format, "csv");
    assert.equal(request?.pageSize, 2500);
    assert.equal(request?.rowLimit, null);
    assert.equal(request?.totalRows, 123456);
    assert.equal(request?.keysetOptimizationEnabled, false);
    assert.equal(request?.clientSessionId, `${tabId}:export`);
    assert.match(request?.executionId ?? "", /^[0-9a-f-]{36}$/i);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("buildQueryResultExportRequest uses exportRowLimit when enabled", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ exportBatchSize: 2500, exportRowLimit: 200000, exportRowLimitEnabled: true });
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "analytics", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "SELECT * FROM events";
  tab.result = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
  };

  globalThis.fetch = withConnectionHealthMock(async () => new Response("unexpected request", { status: 500 }));

  try {
    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-2",
      filePath: "C:\\tmp\\events.xlsx",
      format: "xlsx",
    });

    assert.equal(request?.pageSize, 2500);
    assert.equal(request?.rowLimit, 200000);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("buildQueryResultExportRequest caps progress total when export row limit is enabled", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ exportBatchSize: 2500, exportRowLimit: 100000, exportRowLimitEnabled: true });
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "analytics", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.lastExecutedSql = "SELECT * FROM events";
  tab.resultTotalRowCount = 120000;
  tab.result = {
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_time_ms: 1,
  };

  globalThis.fetch = withConnectionHealthMock(async () => new Response("unexpected request", { status: 500 }));

  try {
    const request = await store.buildQueryResultExportRequest(tabId, {
      exportId: "export-3",
      filePath: "C:\\tmp\\events.csv",
      format: "csv",
    });

    assert.equal(request?.rowLimit, 100000);
    assert.equal(request?.totalRows, 100000);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query execution finishes without waiting for metadata analysis", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  let resolveMetadata: ((value: Response) => void) | undefined;
  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select id from users", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response(JSON.stringify([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Promise<Response>((resolve) => {
        resolveMetadata = resolve;
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "select id from users");

    assert.equal(tab.isExecuting, false);
    assert.equal(tab.executionId, undefined);
    assert.deepEqual(tab.result?.columns, ["id"]);

    resolveMetadata?.(
      new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query execution is scoped to the tab client session", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query");
  let executeBody: any;

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select 1", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify([{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "select 1");

    assert.equal(executeBody.clientSessionId, tabId);
    assert.equal(executeBody.timeoutSecs, 30);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query execution keeps automatically counting total rows in the background", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);

  let resolveCount: ((value: Response) => void) | undefined;
  let countBody: any;
  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(
        JSON.stringify({
          sqlToExecute: "select id from users limit 100",
          pageSql: "select id from users limit 100",
          pageLimit: 100,
          pageOffset: 0,
          countSql: "select count(*) from users",
          useAgentResultSession: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      return new Response(
        JSON.stringify([
          {
            columns: ["id"],
            rows: Array.from({ length: 100 }, (_, index) => [index + 1]),
            affected_rows: 0,
            execution_time_ms: 1,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute") {
      countBody = JSON.parse(String(init?.body ?? "{}"));
      return new Promise<Response>((resolve) => {
        resolveCount = resolve;
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "select id from users");

    assert.equal(tab.executionId, undefined);
    assert.equal(tab.resultTotalRowCount, undefined);
    assert.equal(tab.resultTotalRowCountLoading, true);
    assert.equal(countBody.sql, "select count(*) from users");
    assert.equal(countBody.schema, "public");

    resolveCount?.(
      new Response(
        JSON.stringify({
          columns: ["count"],
          rows: [[250]],
          affected_rows: 0,
          execution_time_ms: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() => tab.resultTotalRowCount === 250);
    assert.equal(tab.resultTotalRowCountLoading, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("paginated query execution keeps the previous total while refreshing it in the background", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query", "query", "public");
  const tab = store.tabs.find((item) => item.id === tabId);
  assert.ok(tab);
  tab.resultTotalRowCount = 250;

  let resolveCount: ((value: Response) => void) | undefined;
  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(
        JSON.stringify({
          sqlToExecute: "select id from users limit 100 offset 100",
          pageSql: "select id from users limit 100 offset 100",
          pageLimit: 100,
          pageOffset: 100,
          countSql: "select count(*) from users",
          useAgentResultSession: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute-multi") {
      return new Response(
        JSON.stringify([
          {
            columns: ["id"],
            rows: Array.from({ length: 100 }, (_, index) => [index + 101]),
            affected_rows: 0,
            execution_time_ms: 1,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/execute") {
      return new Promise<Response>((resolve) => {
        resolveCount = resolve;
      });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "select id from users", {
      pagination: { limit: 100, offset: 100 },
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
    });

    assert.equal(tab.resultTotalRowCount, 250);
    assert.equal(tab.resultTotalRowCountLoading, true);

    resolveCount?.(
      new Response(
        JSON.stringify({
          columns: ["count"],
          rows: [[275]],
          affected_rows: 0,
          execution_time_ms: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await waitFor(() => tab.resultTotalRowCount === 275);
    assert.equal(tab.resultTotalRowCountLoading, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("multi statement execution shows the first result set by default", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;

  connectionStore.addEphemeralConnection(conn("conn-1"));
  const tabId = store.createTab("conn-1", "db", "Query");

  globalThis.fetch = withConnectionHealthMock(async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "set @id = 1; select @id", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response(
        JSON.stringify([
          { columns: [], rows: [], affected_rows: 0, execution_time_ms: 1 },
          { columns: ["@id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "set @id = 1; select @id");

    const tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.activeResultIndex, 1);
    assert.deepEqual(tab?.result?.columns, ["@id"]);
    assert.deepEqual(tab?.result?.rows, [[1]]);
    assert.equal(isReactive(tab?.result?.rows), false);
    assert.equal(isReactive(tab?.result?.rows[0]), false);
    assert.equal(
      tab?.results?.every((result) => !isReactive(result.rows)),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("query results keep readable table source labels with active database context", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let currentSql = "";

  connectionStore.addEphemeralConnection({ ...conn("conn-1"), database: "aaa" });
  const tabId = store.createTab("conn-1", "db", "Query");
  const defaultDatabaseTabId = store.createTab("conn-1", "", "Default database query");

  globalThis.fetch = withConnectionHealthMock(async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      currentSql = body.options.sql;
      return new Response(JSON.stringify({ sqlToExecute: currentSql, useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      const results =
        currentSql === "select * from users; select * from orders"
          ? [
              { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
              { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
            ]
          : currentSql === "SELECT *\nFROM apis AS ap\nLIMIT 10;\n\nSELECT *\nFROM menus AS mn\nLIMIT 10;"
            ? [
                { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
                { columns: ["id"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
              ]
          : currentSql === "select * from public.users"
            ? [{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]
            : currentSql === "select u.id from users u join orders o on o.user_id = u.id"
              ? [{ columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 }]
              : [
                  { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 },
                  { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
                ];
      return new Response(JSON.stringify(results), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  });

  try {
    await store.executeTabSql(tabId, "select * from users; select * from orders");
    let tab = store.tabs.find((item) => item.id === tabId);
    assert.deepEqual(tab?.results?.map((result) => result.sourceLabel), ["db.users", "db.orders"]);
    assert.deepEqual(tab?.results?.map((result) => result.sourceStatement), ["select * from users", "select * from orders"]);

    await store.executeTabSql(
      defaultDatabaseTabId,
      "SELECT *\nFROM apis AS ap\nLIMIT 10;\n\nSELECT *\nFROM menus AS mn\nLIMIT 10;",
    );
    tab = store.tabs.find((item) => item.id === defaultDatabaseTabId);
    assert.deepEqual(tab?.results?.map((result) => result.sourceLabel), ["aaa.apis", "aaa.menus"]);

    await store.executeTabSql(tabId, "select * from public.users");
    tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.result?.sourceLabel, "public.users");

    await store.executeTabSql(tabId, "select u.id from users u join orders o on o.user_id = u.id");
    tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.result?.sourceLabel, undefined);
    assert.equal(tab?.result?.sourceStatement, "select u.id from users u join orders o on o.user_id = u.id");

    await store.executeTabSql(tabId, "update users set active = true; select * from users");
    tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.results?.[0]?.sourceLabel, undefined);
    assert.equal(tab?.results?.[1]?.sourceLabel, "db.users");
    assert.equal(tab?.results?.[1]?.sourceStatement, "select * from users");
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("tab reuse is scoped by mode and schema instead of title alone", () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useQueryStore();

    const dataTabId = store.createTab("conn-1", "db", "users", "data", "public");
    const sourceTabId = store.createTab("conn-1", "db", "users", "query", "public");
    const otherSchemaTabId = store.createTab("conn-1", "db", "users", "data", "audit");
    const reusedDataTabId = store.createTab("conn-1", "db", "users", "data", "public");

    assert.notEqual(sourceTabId, dataTabId);
    assert.notEqual(otherSchemaTabId, dataTabId);
    assert.equal(reusedDataTabId, dataTabId);
    assert.equal(store.tabs.length, 3);
  } finally {
    restoreStorage();
  }
});

test("new table structure tabs can open multiple drafts while existing tables still reuse tabs", () => {
  const restoreStorage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useQueryStore();

    const firstDraftId = store.openTableStructure("conn-1", "db", "public", "");
    const secondDraftId = store.openTableStructure("conn-1", "db", "public", "");
    const firstEditId = store.openTableStructure("conn-1", "db", "public", "users");
    const secondEditId = store.openTableStructure("conn-1", "db", "public", "users");

    assert.notEqual(secondDraftId, firstDraftId);
    assert.equal(secondEditId, firstEditId);
    assert.equal(store.tabs.length, 3);
  } finally {
    restoreStorage();
  }
});

test("table structure refresh versions are scoped by table target", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();

  assert.equal(store.tableStructureRefreshVersion("conn-1", "db", "public", "users"), 0);

  store.invalidateTableStructure("conn-1", "db", "public", "users");
  store.invalidateTableStructure("conn-1", "db", "public", "users");
  store.invalidateTableStructure("conn-1", "db", undefined, "users");

  assert.equal(store.tableStructureRefreshVersion("conn-1", "db", "public", "users"), 2);
  assert.equal(store.tableStructureRefreshVersion("conn-1", "db", undefined, "users"), 1);
  assert.equal(store.tableStructureRefreshVersion("conn-1", "db", "public", "orders"), 0);
});

test("reorderTab keeps pinned tabs before unpinned tabs after reorder", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();

  const tabA = store.createTab("conn-1", "db", "A", "query");
  const tabB = store.createTab("conn-1", "db", "B", "query");
  const tabC = store.createTab("conn-1", "db", "C", "query");
  const tabD = store.createTab("conn-1", "db", "D", "query");

  store.tabs[0].pinned = false;
  store.tabs[1].pinned = true;
  store.tabs[2].pinned = false;
  store.tabs[3].pinned = true;

  // Force store to apply pinned ordering
  store.togglePinnedTab(tabB);
  store.togglePinnedTab(tabB);
  // Now tabs: D(b), B(b), A, C

  // Try dragging unpinned tab A before pinned tab B
  store.reorderTab(tabA, tabB, "before");
  const idsAfter = store.tabs.map((t) => t.id);
  const pinnedIndices = store.tabs.map((t, i) => ({ pinned: t.pinned, i })).filter((t) => t.pinned);
  const unpinnedIndices = store.tabs.map((t, i) => ({ pinned: t.pinned, i })).filter((t) => !t.pinned);

  // All pinned tabs should come before any unpinned tab
  assert.equal(Math.max(...pinnedIndices.map((t) => t.i)) < Math.min(...unpinnedIndices.map((t) => t.i)), true);
});

test("reorderTab preserves relative order within pinned group", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();

  const tabA = store.createTab("conn-1", "db", "A", "query");
  const tabB = store.createTab("conn-1", "db", "B", "query");
  const tabC = store.createTab("conn-1", "db", "C", "query");
  const tabD = store.createTab("conn-1", "db", "D", "query");
  const tabE = store.createTab("conn-1", "db", "E", "query");

  // Pin A, B, C; leave D, E unpinned
  store.togglePinnedTab(tabA);
  // toggle so orderPinnedFirst runs: [A, B, C, D, E]
  store.togglePinnedTab(tabB);
  // [A, B, C, D, E]
  assert.equal(store.tabs.filter((t) => t.pinned).length, 2);

  store.togglePinnedTab(tabC);
  // pinned = [A, B, C], unpinned = [D, E]
  assert.equal(store.tabs.filter((t) => t.pinned).length, 3);

  // Now: A, B, C (pinned), D, E (unpinned)
  // Drag C before A (within pinned group)
  store.reorderTab(tabC, tabA, "before");
  // After orderPinnedFirst: C, A, B, D, E
  const ids = store.tabs.map((t) => t.id);
  assert.equal(ids[0], tabC, "C should be first pinned tab");
  assert.equal(ids[1], tabA, "A should be second pinned tab");
  assert.equal(ids[2], tabB, "B should be third pinned tab");
  assert.equal(ids[3], tabD, "D should be first unpinned");
  assert.equal(ids[4], tabE, "E should be second unpinned");
});

test("reorderTab preserves relative order within unpinned group", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();

  const tabA = store.createTab("conn-1", "db", "A", "query");
  const tabB = store.createTab("conn-1", "db", "B", "query");
  const tabC = store.createTab("conn-1", "db", "C", "query");
  const tabD = store.createTab("conn-1", "db", "D", "query");

  store.tabs[0].pinned = true;
  store.tabs[1].pinned = false;
  store.tabs[2].pinned = false;
  store.tabs[3].pinned = false;

  store.togglePinnedTab(tabA);
  store.togglePinnedTab(tabA);

  // Now tabs: A(pinned), B, C, D(unpinned)
  // Drag D before B
  store.reorderTab(tabD, tabB, "before");
  // After orderPinnedFirst: A, D, B, C
  const ids = store.tabs.map((t) => t.id);
  assert.equal(ids[0], tabA, "A should stay pinned");
  assert.equal(ids[1], tabD, "D should be first unpinned");
  assert.equal(ids[2], tabB, "B should be second unpinned");
  assert.equal(ids[3], tabC, "C should be last unpinned");
});

test("reorderTab with after position places tab correctly", () => {
  setActivePinia(createPinia());
  const store = useQueryStore();

  const tabA = store.createTab("conn-1", "db", "A", "query");
  const tabB = store.createTab("conn-1", "db", "B", "query");
  const tabC = store.createTab("conn-1", "db", "C", "query");

  // Drag A after C
  store.reorderTab(tabA, tabC, "after");
  assert.deepEqual(
    store.tabs.map((t) => t.id),
    [tabB, tabC, tabA],
  );
});
