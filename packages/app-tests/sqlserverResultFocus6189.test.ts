/**
 * Issue #6189 investigation — "focus jumps to the last result set" on SQL Server.
 *
 * Exercises the REAL queryStore.executeTabSql over two consecutive executions to test
 * the theory that `preservedResultIndex` (queryStore.ts:238-241) can leak a previously
 * focused index onto a later, differently-shaped result set.
 */
import { strict as assert } from "node:assert";
import { afterEach, test } from "vitest";
import { createPinia, disposePinia, getActivePinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { useQueryStore } from "../../apps/desktop/src/stores/queryStore.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

afterEach(() => {
  const pinia = getActivePinia();
  if (pinia) disposePinia(pinia);
  setActivePinia(undefined);
});

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

function sqlServerConn(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    db_type: "sqlserver",
    host: "localhost",
    port: 1433,
    username: "sa",
    password: "",
  };
}

const THREE_RESULTS = "SELECT 1 AS a; SELECT 2 AS b; SELECT 3 AS c;";
const TRAILING_MESSAGE = "SELECT 9 AS z; PRINT N'DBCC execution completed.';";

/** Mirrors the shapes crates/dbx-core/src/db/sqlserver.rs:523-542 actually produces. */
function resultsFor(sql: string) {
  if (sql.includes("SELECT 3 AS c")) {
    return [
      { columns: ["a"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["b"], rows: [[2]], affected_rows: 0, execution_time_ms: 1 },
      { columns: ["c"], rows: [[3]], affected_rows: 0, execution_time_ms: 1 },
    ];
  }
  return [
    { columns: ["z"], rows: [[9]], affected_rows: 0, execution_time_ms: 1 },
    {
      columns: ["Message"],
      column_types: ["nvarchar"],
      rows: [["DBCC execution completed."]],
      affected_rows: 0,
      execution_time_ms: 1,
      server_message: true,
    },
  ];
}

function stubFetch(record: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/connection/check-health") return json(null);
    if (url === "/api/query/prepare-pagination-plan") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({ sqlToExecute: body.options.sql, useAgentResultSession: false });
    }
    if (url === "/api/query/execute-multi") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json(resultsFor(String(body.sql ?? "")));
    }
    if (url === "/api/query/analyze-editability") return json({ editable: false, reason: "complex-source" });
    record.push(url);
    return json(null);
  };
}

test("#6189: a later SQL Server execution does not inherit the previously focused result index", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  const unexpected: string[] = [];
  globalThis.fetch = stubFetch(unexpected);

  connectionStore.addEphemeralConnection({ ...sqlServerConn("conn-1"), database: "dbx" });
  const tabId = store.createTab("conn-1", "dbx", "Query");

  try {
    // 1) three data results; the user manually focuses the LAST one.
    await store.executeTabSql(tabId, THREE_RESULTS);
    let tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.results?.length, 3, "first execution should produce three results");
    assert.equal(tab?.activeResultIndex, 0, "first execution focuses the first result with columns");

    store.setActiveResultIndex(tabId, 2);
    tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.activeResultIndex, 2, "user selected the third card");

    // 2) a DIFFERENT batch: one data result plus a trailing server-message pseudo-result.
    await store.executeTabSql(tabId, TRAILING_MESSAGE);
    tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.results?.length, 2, "second execution should produce two results");
    assert.equal(tab?.activeResultIndex, 0, "the stale index must not leak onto the new result set");
    assert.equal(tab?.result?.server_message, undefined, "the trailing message must not be focused");
    assert.deepEqual(tab?.result?.rows, [[9]]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});

test("#6189: a SQL Server batch whose message result is last still focuses the first data result", async () => {
  const restoreStorage = installMemoryStorage();
  setActivePinia(createPinia());
  const connectionStore = useConnectionStore();
  const store = useQueryStore();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch([]);

  connectionStore.addEphemeralConnection({ ...sqlServerConn("conn-1"), database: "dbx" });
  const tabId = store.createTab("conn-1", "dbx", "Query");

  try {
    await store.executeTabSql(tabId, TRAILING_MESSAGE);
    const tab = store.tabs.find((item) => item.id === tabId);
    assert.equal(tab?.activeResultIndex, 0);
    assert.deepEqual(tab?.result?.rows, [[9]]);
  } finally {
    globalThis.fetch = originalFetch;
    restoreStorage();
  }
});
