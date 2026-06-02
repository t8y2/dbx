import { strict as assert } from "node:assert";
import test from "node:test";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
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

test("evicting cached tab results releases multi-result payloads and sessions", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  let executeCount = 0;
  const closedSessions: string[] = [];

  connectionStore.addEphemeralConnection(conn("conn-1"));

  globalThis.fetch = (async (input, init) => {
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
  }) as typeof fetch;

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

  globalThis.fetch = (async (input) => {
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
  }) as typeof fetch;

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
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
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
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

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
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

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

test("disconnecting a connection closes every tab for that connection", async () => {
  const restoreStorage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(true), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

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

  globalThis.fetch = (async (input) => {
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
  }) as typeof fetch;

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

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      return new Response(JSON.stringify({ sqlToExecute: "select 1 order by name", useAgentResultSession: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/query/execute-multi") {
      return new Response(
        JSON.stringify([{ columns: ["id", "name"], rows: [[2, "Grace"]], affected_rows: 0, execution_time_ms: 1 }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (url === "/api/query/analyze-editability") {
      return new Response(JSON.stringify({ editable: false, reason: "complex-source" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

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

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/query/prepare-pagination-plan") {
      preparedPagination = true;
      return new Response("unexpected pagination plan request", { status: 500 });
    }
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify([{ columns: ["id"], rows: [[101]], affected_rows: 0, execution_time_ms: 1 }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

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

test("reloading an empty data tab fetches table results again", async () => {
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

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/query/execute-multi") {
      executeBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify([{ columns: ["id"], rows: [[51]], affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

  try {
    await store.reloadEvictedTab(tabId);

    assert.equal(executeBody.sql, 'SELECT * FROM "public"."users" LIMIT 50 OFFSET 50;');
    assert.equal(executeBody.maxRows, 50);
    assert.equal(executeBody.fetchSize, 50);
    assert.deepEqual(tab.result?.rows, [[51]]);
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

  globalThis.fetch = (async (input, init) => {
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
      const rows = String(body.sql).includes("offset:0")
        ? Array.from({ length: 10_000 }, (_, index) => [index + 1])
        : [[10_001], [10_002]];
      return new Response(JSON.stringify([{ columns: ["id"], rows, affected_rows: 0, execution_time_ms: 1 }]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("unexpected request", { status: 500 });
  }) as typeof fetch;

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
  globalThis.fetch = (async (input) => {
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
  }) as typeof fetch;

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

  globalThis.fetch = (async (input, init) => {
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
  }) as typeof fetch;

  try {
    await store.executeTabSql(tabId, "select 1");

    assert.equal(executeBody.clientSessionId, tabId);
    assert.equal(executeBody.timeoutSecs, 30);
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

  globalThis.fetch = (async (input) => {
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
  }) as typeof fetch;

  try {
    await store.executeTabSql(tabId, "set @id = 1; select @id");

    const tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.activeResultIndex, 1);
    assert.deepEqual(tab?.result?.columns, ["@id"]);
    assert.deepEqual(tab?.result?.rows, [[1]]);
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
