import { test } from "vitest";
import assert from "node:assert/strict";
import { createPinia, setActivePinia } from "pinia";
import { useConnectionStore } from "../../apps/desktop/src/stores/connectionStore.ts";
import { hasSidebarLayoutEntries } from "../../apps/desktop/src/lib/sidebar/sidebarLayout.ts";
import { decryptConfig } from "../../apps/desktop/src/lib/backend/configCrypto.ts";
import type { ConnectionConfig, SidebarLayout, TreeNode, TunnelProfile } from "../../apps/desktop/src/types/database.ts";

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

function installBackend(initialConnections: ConnectionConfig[], initialLayout: SidebarLayout | null, initialProfiles: TunnelProfile[] = []) {
  const originalFetch = globalThis.fetch;
  const state = { connections: initialConnections, layout: initialLayout, profiles: initialProfiles };

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
    if (url === "/api/tunnel-profiles/list") return json(state.profiles);
    if (url === "/api/tunnel-profiles/save") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { profiles?: TunnelProfile[] };
      state.profiles = body.profiles ?? [];
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
    assert.deepEqual(outline(store.treeNodes), ["[Local Folder]", "Local Folder/Local DB", "[Prod]", "Prod/Prod DB 1", "Prod/Prod DB 2", "[Dev]", "Dev/Dev DB 1", "Scratch"]);
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

function tunnelLayer(id: string, profileId: string) {
  return { type: "ssh" as const, id, host: "", port: 22, user: "", profile_id: profileId };
}

async function decryptExport(content: string) {
  return JSON.parse(await decryptConfig(JSON.parse(content), PASSPHRASE));
}

test("selective encrypted export keeps only chosen connections, layout, and tunnel profiles", async () => {
  const backend = installBackend([], null, [
    { type: "ssh", id: "tunnel-1", host: "bastion-1", port: 22, user: "root" },
    { type: "ssh", id: "tunnel-2", host: "bastion-2", port: 22, user: "root" },
  ]);
  const capture = installExportCapture();
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const prod = store.createConnectionGroup("Prod");
    const dev = store.createConnectionGroup("Dev");
    await store.addConnection({ ...conn("a-1", "Prod DB 1", 3306), transport_layers: [tunnelLayer("layer-a", "tunnel-1")] }, prod);
    await store.addConnection({ ...conn("a-2", "Prod DB 2", 3307), transport_layers: [tunnelLayer("layer-b", "tunnel-2")] }, prod);
    await store.addConnection({ ...conn("a-3", "Dev DB 1", 3308), transport_layers: [tunnelLayer("layer-c", "tunnel-1")] }, dev);
    await store.addConnection(conn("a-4", "Scratch", 3309), null);

    const selected = store.connections.filter((connection) => connection.name === "Prod DB 1" || connection.name === "Dev DB 1").map((connection) => connection.id);
    await store.exportConnectionsToFile(PASSPHRASE, selected);
    const decrypted = await decryptExport(await capture.content());

    assert.deepEqual(
      decrypted.connections.map((connection: ConnectionConfig) => connection.name),
      ["Prod DB 1", "Dev DB 1"],
    );
    assert.equal(
      decrypted.connections.some((connection: ConnectionConfig) => connection.name === "Prod DB 2" || connection.name === "Scratch"),
      false,
    );
    assert.deepEqual(
      decrypted.tunnelProfiles.map((profile: TunnelProfile) => profile.id),
      ["tunnel-1"],
    );
    assert.deepEqual(
      decrypted.layout.groups.map((group: { name: string }) => group.name),
      ["Prod", "Dev"],
    );
    const layoutIds: string[] = [];
    const walk = (entries: Array<{ type: string; id: string; children?: typeof entries }>) => {
      for (const entry of entries) {
        if (entry.type === "connection") layoutIds.push(entry.id);
        else if (entry.children) walk(entry.children);
      }
    };
    walk(decrypted.layout.order);
    assert.deepEqual(layoutIds.sort(), selected.slice().sort());
  } finally {
    storage.restore();
    capture.restore();
    backend.restore();
  }
});

test("selective encrypted import applies only chosen connections and later remaining ones", async () => {
  const exported = await exportFromMachineA();
  const backend = installBackend([], null);
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const preview = await store.parseConnectionsImport(exported, PASSPHRASE);
    assert.equal(store.connections.length, 0);
    const firstIds = preview.connections.filter((connection) => connection.name === "Prod DB 1" || connection.name === "Dev DB 1").map((connection) => connection.id);
    const first = await store.applyConnectionsImport(preview, firstIds);
    assert.equal(first.count, 2);
    if (first.layout) store.applySidebarLayout(first.layout);
    assert.deepEqual(store.connections.map((connection) => connection.name).sort(), ["Dev DB 1", "Prod DB 1"]);
    assert.deepEqual(outline(store.treeNodes), ["[Prod]", "Prod/Prod DB 1", "[Dev]", "Dev/Dev DB 1"]);

    const again = await store.applyConnectionsImport(preview, firstIds);
    assert.equal(again.count, 0);

    const remainingIds = preview.connections.filter((connection) => connection.name === "Prod DB 2").map((connection) => connection.id);
    const remaining = await store.applyConnectionsImport(preview, remainingIds);
    assert.equal(remaining.count, 1);
    if (remaining.layout) store.applySidebarLayout(remaining.layout);
    assert.deepEqual(store.connections.map((connection) => connection.name).sort(), ["Dev DB 1", "Prod DB 1", "Prod DB 2"]);
    assert.deepEqual(outline(store.treeNodes), ["[Prod]", "Prod/Prod DB 1", "Prod/Prod DB 2", "[Dev]", "Dev/Dev DB 1"]);
  } finally {
    storage.restore();
    backend.restore();
  }
});

test("duplicate imports do not overwrite tunnel profiles before connection deduplication", async () => {
  const existingProfile = { type: "ssh", id: "tunnel-duplicate", host: "local-bastion", port: 22, user: "root" } as TunnelProfile;
  const backend = installBackend([conn("local-duplicate", "Duplicate", 3306)], null, [existingProfile]);
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const preview = {
      connections: [
        { ...conn("import-duplicate", "Duplicate", 3306), transport_layers: [tunnelLayer("duplicate-layer", "tunnel-duplicate")] },
        { ...conn("import-new", "New", 3307), transport_layers: [tunnelLayer("new-layer", "tunnel-new")] },
      ],
      tunnelProfiles: [{ ...existingProfile, host: "imported-bastion" }, { type: "ssh", id: "tunnel-new", host: "new-bastion", port: 22, user: "root" } as TunnelProfile],
    };

    const result = await store.applyConnectionsImport(preview);

    assert.equal(result.count, 1);
    assert.deepEqual(
      backend.state.profiles.map((profile) => ({ id: profile.id, host: profile.host })),
      [
        { id: "tunnel-duplicate", host: "local-bastion" },
        { id: "tunnel-new", host: "new-bastion" },
      ],
    );
    assert.deepEqual(store.connections.map((connection) => connection.name).sort(), ["Duplicate", "New"]);
  } finally {
    storage.restore();
    backend.restore();
  }
});

test("wrong passphrase and preview-only parse do not mutate local connections", async () => {
  const exported = await exportFromMachineA();
  const backend = installBackend([], null);
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    await assert.rejects(() => store.parseConnectionsImport(exported, "wrong-pass"), /wrong_passphrase/);
    assert.equal(store.connections.length, 0);

    const preview = await store.parseConnectionsImport(exported, PASSPHRASE);
    assert.equal(preview.connections.length, 4);
    assert.equal(store.connections.length, 0);
  } finally {
    storage.restore();
    backend.restore();
  }
});

test("plain legacy dbx config still imports a selected subset", async () => {
  const backend = installBackend([], null);
  const storage = installMemoryStorage();
  try {
    setActivePinia(createPinia());
    const store = useConnectionStore();
    await store.initFromDisk();

    const content = JSON.stringify({
      connections: [conn("old-a", "Legacy A", 3306), conn("old-b", "Legacy B", 3307), conn("old-c", "Legacy C", 3308)],
    });
    const preview = await store.parseConnectionsImport(content, null);
    const result = await store.applyConnectionsImport(
      preview,
      preview.connections.filter((connection) => connection.name !== "Legacy B").map((connection) => connection.id),
    );
    assert.equal(result.count, 2);
    assert.deepEqual(store.connections.map((connection) => connection.name).sort(), ["Legacy A", "Legacy C"]);
  } finally {
    storage.restore();
    backend.restore();
  }
});
