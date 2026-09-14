import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { filterLocallySearchedTables } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import { buildGroupedObjectTreeNodes, buildTableTreeNodes } from "../../apps/desktop/src/lib/table/tableTree.ts";
import { applyPinnedTreeNodeState } from "../../apps/desktop/src/lib/app/pinnedItems.ts";
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

test.each([
  { label: "PostgreSQL grouped", schema: "public", grouped: true },
  { label: "PostgreSQL simple", schema: "public", grouped: false },
  { label: "MySQL grouped", schema: undefined, grouped: true },
])("$label keeps a search pin after clearing search and allows unpinning", ({ schema, grouped }) => {
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    const context = { nodeId: "conn:app", connectionId: "conn", database: "app", schema };
    const tables = ["aaa", "orders"].map((name) => ({ name, table_type: "TABLE" }));
    const buildGroup = () => grouped
      ? buildGroupedObjectTreeNodes({ ...context, objects: tables.map((table) => ({ name: table.name, object_type: table.table_type, schema })) })[0]
      : { id: context.nodeId, label: "app", type: "schema" as const, ...context, children: buildTableTreeNodes({ ...context, tables }) };
    const group = buildGroup();
    store.treeNodes = [group];
    const liveGroup = store.treeNodes[0];
    const target = liveGroup.children!.find((node) => node.label === "orders")!;
    const project = (enabled = true) => filterLocallySearchedTables(store.treeNodes, {
      enabled, queries: store.sidebarTableSearchQueries, indexedResults: { [group.id]: tables },
    })[0].children!;

    store.setSidebarTableSearchQuery(group.id, "orders");
    assert.deepEqual(project().map((node) => node.label), ["orders"]);
    assert.deepEqual(project(false).map((node) => node.label), ["aaa", "orders"]);
    store.toggleTreeNodePin(project()[0]);
    store.setSidebarTableSearchQuery(group.id, "");
    const cleared = project();
    assert.deepEqual(cleared.map((node) => node.label), ["orders", "aaa"]);
    assert.equal(cleared[0].pinned, true);
    assert.equal(target.pinned, true);
    assert.equal(store.isTreeNodePinned(cleared[0]), true);

    store.setSidebarTableSearchQuery(group.id, "orders");
    assert.equal(project()[0].pinned, true);
    store.toggleTreeNodePin(project()[0]);
    store.setSidebarTableSearchQuery(group.id, "");
    assert.deepEqual(project().map((node) => node.label), ["aaa", "orders"]);
    assert.equal(target.pinned, false);
    assert.deepEqual(JSON.parse(storage.values.get("dbx-pinned-tree-nodes")!), []);

    // Separate from clearing search: an index-only hit survives metadata reload.
    liveGroup.children = liveGroup.children!.filter((node) => node.label !== "orders");
    store.setSidebarTableSearchQuery(group.id, "orders");
    store.toggleTreeNodePin(project()[0]);
    const saved = new Set<string>(JSON.parse(storage.values.get("dbx-pinned-tree-nodes")!));
    const restored = applyPinnedTreeNodeState(buildGroup().children!, saved);
    assert.equal(restored[0].label, "orders");
    assert.equal(restored[0].pinned, true);
    assert.equal(store.isTreeNodePinned(restored[0]), true);
    store.toggleTreeNodePin(restored[0]);
    assert.deepEqual(JSON.parse(storage.values.get("dbx-pinned-tree-nodes")!), []);
  } finally {
    storage.restore();
  }
});
