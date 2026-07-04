import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { buildSqlSemanticDiagnostics } from "../../apps/desktop/src/lib/sql/semantic/diagnostics.ts";
import type { ConnectionConfig, SqlReferenceAnalysis } from "../../apps/desktop/src/types/database.ts";

const span = (startColumn: number, endColumn: number) => ({
  start_line: 1,
  start_column: startColumn,
  end_line: 1,
  end_column: endColumn,
});

function installMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
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
  return {
    restore() {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function sqlServerConn(): ConnectionConfig {
  return {
    id: "sqlserver-1",
    name: "SQL Server",
    db_type: "sqlserver",
    host: "localhost",
    port: 1433,
    username: "sa",
    password: "",
    database: "appdb",
  };
}

test("semantic diagnostics skip warnings when column metadata is inconclusive", () => {
  const analysis: SqlReferenceAnalysis = {
    tables: [{ name: "Evt_GCM_Qop_Info", span: span(15, 30) }],
    columns: [{ name: "PDReceiveDatePartInfo", span: span(40, 60) }],
  };

  const diagnostics = buildSqlSemanticDiagnostics(analysis, {
    tables: [{ name: "Evt_GCM_Qop_Info", type: "table" }],
    columnsByTable: new Map([["Evt_GCM_Qop_Info", []]]),
  });

  assert.deepEqual(diagnostics, []);
});

test("sqlserver completion columns do not query using database name as schema fallback", async () => {
  const storage = installMemoryStorage();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "/api/connection/list") {
      return new Response(JSON.stringify([sqlServerConn()]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/layout/sidebar") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/connect") {
      return new Response(JSON.stringify("ok"), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("/api/schema/columns?")) {
      throw new Error(`unexpected columns lookup: ${url}`);
    }
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const columns = await store.listCompletionColumns("sqlserver-1", "appdb", "Evt_GCM_Qop_Info");

    assert.deepEqual(columns, []);
    assert.equal(
      requests.some((url) => url.startsWith("/api/schema/columns?")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});
