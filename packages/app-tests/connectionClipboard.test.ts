import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "../../apps/desktop/src/types/database.ts";

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
  return {
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
    db_type: "mysql",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
  };
}

async function withConnectionStore(initialConnections: ConnectionConfig[], initialLayout: SidebarLayout | null, run: (store: ReturnType<typeof useConnectionStore>) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const storage = installMemoryStorage();
  let savedConnections = initialConnections;
  let savedLayout = initialLayout;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/connection/list") {
      return new Response(JSON.stringify(savedConnections), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/layout/sidebar") {
      if (init?.method === "POST") {
        savedLayout = JSON.parse(String(init.body ?? "null"));
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(savedLayout), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/save") {
      savedConnections = JSON.parse(String(init?.body ?? "[]"));
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();
    await run(store);
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
}

function connectionLabels(nodes: TreeNode[]): string[] {
  const labels: string[] = [];
  for (const node of nodes) {
    if (node.type === "connection") labels.push(node.label);
    if (node.children) labels.push(...connectionLabels(node.children));
  }
  return labels;
}

test("copies and pastes a root connection without writing to the OS clipboard", async () => {
  await withConnectionStore([conn("conn-1", "Main MySQL")], { groups: [], order: [{ type: "connection", id: "conn-1" }] }, async (store) => {
    assert.equal(store.copyConnectionsToTreeClipboard(["conn-1"]), 1);
    assert.equal(store.treeClipboard?.kind, "connection-copy");

    const pasted = await store.pasteConnectionClipboard(null);

    assert.equal(pasted, 1);
    assert.equal(store.connections.length, 2);
    assert.deepEqual(connectionLabels(store.treeNodes), ["Main MySQL", "Main MySQL (Copy)"]);
    assert.notEqual(store.connections[0].id, store.connections[1].id);
  });
});

test("pastes a copied grouped connection into the same group when that group is targeted", async () => {
  const originalConnection = conn("conn-1", "Grouped MySQL");
  const layout: SidebarLayout = {
    groups: [{ id: "group-1", name: "Group", collapsed: false }],
    order: [{ type: "group", id: "group-1", children: [{ type: "connection", id: "conn-1" }] }],
  };

  await withConnectionStore([originalConnection], layout, async (store) => {
    assert.equal(store.copyConnectionsToTreeClipboard(["conn-1"]), 1);
    const pasted = await store.pasteConnectionClipboard();

    assert.equal(pasted, 1);
    assert.equal(store.treeNodes[0].type, "connection-group");
    assert.deepEqual(
      store.treeNodes[0].children?.map((node) => node.label),
      ["Grouped MySQL", "Grouped MySQL (Copy)"],
    );
  });
});

test("pastes copied connections into an explicitly selected target group", async () => {
  const layout: SidebarLayout = {
    groups: [
      { id: "group-1", name: "Source", collapsed: false },
      { id: "group-2", name: "Target", collapsed: false },
    ],
    order: [
      { type: "group", id: "group-1", children: [{ type: "connection", id: "conn-1" }] },
      { type: "group", id: "group-2", children: [] },
    ],
  };

  await withConnectionStore([conn("conn-1", "Source MySQL")], layout, async (store) => {
    store.copyConnectionsToTreeClipboard(["conn-1"]);
    await store.pasteConnectionClipboard("group-2");

    assert.equal(store.treeNodes[1].type, "connection-group");
    assert.deepEqual(
      store.treeNodes[1].children?.map((node) => node.label),
      ["Source MySQL (Copy)"],
    );
  });
});

test("pastes multiple copied connections in the copied order", async () => {
  const layout: SidebarLayout = {
    groups: [],
    order: [
      { type: "connection", id: "conn-1" },
      { type: "connection", id: "conn-2" },
    ],
  };

  await withConnectionStore([conn("conn-1", "First"), conn("conn-2", "Second")], layout, async (store) => {
    store.copyConnectionsToTreeClipboard(["conn-2", "conn-1"]);
    await store.pasteConnectionClipboard(null);

    assert.deepEqual(connectionLabels(store.treeNodes), ["First", "Second", "Second (Copy)", "First (Copy)"]);
  });
});
