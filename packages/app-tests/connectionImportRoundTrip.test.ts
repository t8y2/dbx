import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { hasSidebarLayoutEntries } from "../../apps/desktop/src/lib/sidebar/sidebarLayout.ts";
import type { ConnectionConfig, SidebarLayout, TreeNode } from "../../apps/desktop/src/types/database.ts";

const PASSPHRASE = "round-trip-pass";

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

/** Capture the blob the browser export path hands to the download anchor. */
function installExportCapture() {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let captured: Blob | null = null;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ href: "", download: "", click() {} }) },
  });
  URL.createObjectURL = ((blob: Blob) => {
    captured = blob;
    return "blob:capture";
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;

  return {
    async content() {
      assert.ok(captured, "export did not produce a file blob");
      return await captured!.text();
    },
    restore() {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

function installBackend(initialConnections: ConnectionConfig[], initialLayout: SidebarLayout | null) {
  const originalFetch = globalThis.fetch;
  const state = { connections: initialConnections, layout: initialLayout };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/connection/list") return json(state.connections);
    if (url === "/api/layout/sidebar") {
      if (init?.method === "POST") {
        state.layout = JSON.parse(String(init.body ?? "null"));
        return json(null);
      }
      return json(state.layout);
    }
    if (url === "/api/connection/save") {
      state.connections = JSON.parse(String(init?.body ?? "[]"));
      return json(null);
    }
    return json(null);
  }) as typeof fetch;

  return {
    state,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function conn(id: string, name: string, port: number): ConnectionConfig {
  return { id, name, db_type: "mysql", host: "127.0.0.1", port, username: "root", password: "secret" };
}

/** Nested "Folder/Child" -> label listing, so folder structure is compared as data. */
function outline(nodes: TreeNode[]): string[] {
  const lines: string[] = [];
  const walk = (list: TreeNode[], prefix: string) => {
    for (const node of list) {
      const path = prefix ? `${prefix}/${node.label}` : node.label;
      lines.push(node.type === "connection-group" ? `[${path}]` : path);
      if (node.type === "connection-group") walk(node.children ?? [], path);
    }
  };
  walk(nodes, "");
  return lines;
}

/** Build "machine A" through the real store API and export it through the real export path. */
async function exportFromMachineA(): Promise<string> {
  const backend = installBackend([], null);
  const capture = installExportCapture();
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const prod = store.createConnectionGroup("Prod");
    const dev = store.createConnectionGroup("Dev");
    await store.addConnection(conn("a-1", "Prod DB 1", 3306), prod);
    await store.addConnection(conn("a-2", "Prod DB 2", 3307), prod);
    await store.addConnection(conn("a-3", "Dev DB 1", 3308), dev);
    await store.addConnection(conn("a-4", "Scratch", 3309), null);

    assert.deepEqual(outline(store.treeNodes), ["[Prod]", "Prod/Prod DB 1", "Prod/Prod DB 2", "[Dev]", "Dev/Dev DB 1", "Scratch"]);

    await store.exportConnectionsToFile(PASSPHRASE);
    return await capture.content();
  } finally {
    storage.restore();
    capture.restore();
    backend.restore();
  }
}

test("importing a dbx export merges into the existing sidebar instead of replacing it", async () => {
  const exported = await exportFromMachineA();

  const localLayout: SidebarLayout = {
    groups: [{ id: "local-group", name: "Local Folder", collapsed: false }],
    order: [{ type: "group", id: "local-group", children: [{ type: "connection", id: "local-1" }] }],
  };
  const backend = installBackend([conn("local-1", "Local DB", 5432)], localLayout);
  const storage = installMemoryStorage();

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    assert.deepEqual(outline(store.treeNodes), ["[Local Folder]", "Local Folder/Local DB"]);

    const result = await store.importConnectionsFromFile(exported, PASSPHRASE);
    assert.equal(result.count, 4);
    assert.ok(result.layout);
    store.applySidebarLayout(result.layout!);

    // The machine's own folder and its connection must survive untouched, and
    // every imported connection must land in its exported folder.
    assert.deepEqual(outline(store.treeNodes), [
      "[Local Folder]",
      "Local Folder/Local DB",
      "[Prod]",
      "Prod/Prod DB 1",
      "Prod/Prod DB 2",
      "[Dev]",
      "Dev/Dev DB 1",
      "Scratch",
    ]);
    assert.equal(store.connections.length, 5);
  } finally {
    storage.restore();
    backend.restore();
  }
});

test("re-importing the same dbx export does not duplicate connections", async () => {
  const exported = await exportFromMachineA();
  const backend = installBackend([], null);
  const storage = installMemoryStorage();

  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const first = await store.importConnectionsFromFile(exported, PASSPHRASE);
    assert.equal(first.count, 4);
    assert.equal(hasSidebarLayoutEntries(first.layout), true);
    if (hasSidebarLayoutEntries(first.layout)) store.applySidebarLayout(first.layout);
    const second = await store.importConnectionsFromFile(exported, PASSPHRASE);
    assert.equal(second.count, 0);
    assert.equal(hasSidebarLayoutEntries(second.layout), true);
    if (hasSidebarLayoutEntries(second.layout)) store.applySidebarLayout(second.layout);

    assert.equal(store.connections.length, 4);
    assert.deepEqual(outline(store.treeNodes), ["[Prod]", "Prod/Prod DB 1", "Prod/Prod DB 2", "[Dev]", "Dev/Dev DB 1", "Scratch"]);
  } finally {
    storage.restore();
    backend.restore();
  }
});
