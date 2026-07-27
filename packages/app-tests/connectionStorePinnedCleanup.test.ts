import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig } from "../../apps/desktop/src/types/database.ts";

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
    values,
    restore() {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function conn(id: string, name: string): ConnectionConfig {
  return {
    id,
    name,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
  };
}

test("removeConnection prunes pinned ids and persists the pruned set", async () => {
  const storage = installMemoryStorage({
    "dbx-pinned-tree-nodes": JSON.stringify(["conn-a", "conn-a:db:main", "conn-b:db:main"]),
  });
  const originalFetch = globalThis.fetch;
  const savedPayloads: unknown[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/connection/list") {
      return new Response(JSON.stringify([conn("conn-a", "A"), conn("conn-b", "B")]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/layout/sidebar") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/save") {
      savedPayloads.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    assert.equal(store.isTreeNodePinned("conn-a"), true);
    assert.equal(store.isTreeNodePinned("conn-a:db:main"), true);
    assert.equal(store.isTreeNodePinned("conn-b:db:main"), true);

    await store.removeConnection("conn-a");

    assert.equal(store.isTreeNodePinned("conn-a"), false);
    assert.equal(store.isTreeNodePinned("conn-a:db:main"), false);
    assert.equal(store.isTreeNodePinned("conn-b:db:main"), true);
    assert.deepEqual(JSON.parse(storage.values.get("dbx-pinned-tree-nodes") || "[]"), ["conn-b:db:main"]);
    assert.equal(savedPayloads.length >= 1, true);
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});

test("removeConnection clears persisted sidebar table filters for the removed connection", async () => {
  const storage = installMemoryStorage();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/connection/list") {
      return new Response(JSON.stringify([conn("conn-a", "A"), conn("conn-b", "B")]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/layout/sidebar") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/save") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();
    const removedScope = store.tableNameFilterScopeKey({ connectionId: "conn-a", database: "app", schema: "public", nodeKind: "group-tables" });
    const keptScope = store.tableNameFilterScopeKey({ connectionId: "conn-b", database: "app", schema: "public", nodeKind: "group-tables" });
    store.setSidebarTableNameFilter(removedScope, { includePatterns: ["a_%"], excludePatterns: [] });
    store.setSidebarTableNameFilter(keptScope, { includePatterns: ["b_%"], excludePatterns: [] });

    await store.removeConnection("conn-a");

    assert.equal(store.sidebarTableNameFilters[removedScope], undefined);
    assert.deepEqual(store.sidebarTableNameFilters[keptScope], { includePatterns: ["b_%"], excludePatterns: [] });
    assert.deepEqual(JSON.parse(storage.values.get("dbx-sidebar-table-name-filters") || "{}"), {
      [keptScope]: { includePatterns: ["b_%"], excludePatterns: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});

test("removeConnections clears persisted sidebar table filters for every removed connection", async () => {
  const storage = installMemoryStorage();
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/connection/list") {
      return new Response(JSON.stringify([conn("conn-a", "A"), conn("conn-b", "B"), conn("conn-c", "C")]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/layout/sidebar") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/save") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();
    const scopeA = store.tableNameFilterScopeKey({ connectionId: "conn-a", database: "app", schema: "public", nodeKind: "group-tables" });
    const scopeB = store.tableNameFilterScopeKey({ connectionId: "conn-b", database: "app", schema: "public", nodeKind: "group-tables" });
    const scopeC = store.tableNameFilterScopeKey({ connectionId: "conn-c", database: "app", schema: "public", nodeKind: "group-tables" });
    store.setSidebarTableNameFilter(scopeA, { includePatterns: ["a_%"], excludePatterns: [] });
    store.setSidebarTableNameFilter(scopeB, { includePatterns: ["b_%"], excludePatterns: [] });
    store.setSidebarTableNameFilter(scopeC, { includePatterns: ["c_%"], excludePatterns: [] });

    await store.removeConnections(["conn-a", "conn-b"]);

    assert.equal(store.sidebarTableNameFilters[scopeA], undefined);
    assert.equal(store.sidebarTableNameFilters[scopeB], undefined);
    assert.deepEqual(store.sidebarTableNameFilters[scopeC], { includePatterns: ["c_%"], excludePatterns: [] });
    assert.deepEqual(JSON.parse(storage.values.get("dbx-sidebar-table-name-filters") || "{}"), {
      [scopeC]: { includePatterns: ["c_%"], excludePatterns: [] },
    });
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});
