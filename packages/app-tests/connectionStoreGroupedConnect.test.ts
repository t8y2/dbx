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

function countConnectionNodes(nodes: TreeNode[], connectionId: string): number {
  let count = 0;
  for (const node of nodes) {
    if (node.type === "connection" && node.connectionId === connectionId) count++;
    if (node.children) count += countConnectionNodes(node.children, connectionId);
  }
  return count;
}

test("connecting a grouped connection updates it in place instead of adding a root node", async () => {
  const originalFetch = globalThis.fetch;
  const storage = installMemoryStorage();
  const layout: SidebarLayout = {
    groups: [{ id: "group-1", name: "Group", collapsed: false }],
    order: [{ type: "group", id: "group-1", connectionIds: [] }],
  };

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/connection/list") {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/layout/sidebar") {
      if (init?.method === "POST") {
        return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(layout), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/save") {
      return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/connection/connect") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return new Response(JSON.stringify(body.config.id), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("null", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();
    store.startCreatingConnectionInGroup("group-1");

    const config = conn("conn-1", "Grouped MySQL");
    await store.addConnection(config);
    await store.connect(config);

    assert.equal(store.treeNodes.length, 1);
    assert.equal(store.treeNodes[0].type, "connection-group");
    assert.deepEqual(
      store.treeNodes[0].children?.map((node) => node.id),
      ["conn-1"],
    );
    assert.equal(countConnectionNodes(store.treeNodes, "conn-1"), 1);
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});

test("duplicating a grouped connection keeps the copy in the same group", async () => {
  const originalFetch = globalThis.fetch;
  const storage = installMemoryStorage();
  const originalConnection = conn("conn-1", "Grouped MySQL");
  let savedConnections: ConnectionConfig[] = [originalConnection];
  let savedLayout: SidebarLayout | null = {
    groups: [{ id: "group-1", name: "Group", collapsed: false }],
    order: [{ type: "group", id: "group-1", connectionIds: ["conn-1"] }],
  };

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

    const copy = { ...originalConnection, id: "conn-copy", name: "Grouped MySQL (Copy)" };
    await store.addConnection(copy, store.groupIdForConnection(originalConnection.id));

    assert.deepEqual(
      store.treeNodes.map((node) => node.id),
      ["group-1"],
    );
    assert.equal(store.treeNodes[0].type, "connection-group");
    assert.deepEqual(
      store.treeNodes[0].children?.map((node) => node.id),
      ["conn-1", "conn-copy"],
    );
    assert.equal(countConnectionNodes(store.treeNodes, "conn-copy"), 1);
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});

test("importing grouped dbx connections remaps exported layout to new connection ids", async () => {
  const originalFetch = globalThis.fetch;
  const storage = installMemoryStorage();
  let savedConnections: ConnectionConfig[] = [];
  let savedLayout: SidebarLayout | null = null;

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

    const exportedLayout: SidebarLayout = {
      groups: [{ id: "group-1", name: "Imported Group", collapsed: false }],
      order: [{ type: "group", id: "group-1", connectionIds: ["old-conn-1", "old-conn-2"] }],
    };
    const content = JSON.stringify({
      connections: [conn("old-conn-1", "Grouped A"), conn("old-conn-2", "Grouped B")],
      layout: exportedLayout,
    });

    const result = await store.importConnectionsFromFile(content, null);
    assert.equal(result.count, 2);
    assert.ok(result.layout);
    store.applySidebarLayout(result.layout!);

    const group = store.treeNodes[0];
    assert.equal(group.type, "connection-group");
    assert.equal(group.label, "Imported Group");
    assert.deepEqual(
      group.children?.map((node) => node.label),
      ["Grouped A", "Grouped B"],
    );
    assert.notDeepEqual(
      group.children?.map((node) => node.id),
      ["old-conn-1", "old-conn-2"],
    );
  } finally {
    globalThis.fetch = originalFetch;
    storage.restore();
  }
});
