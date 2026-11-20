import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  notify: vi.fn(async () => {}),
  connect: vi.fn(),
  disconnect: vi.fn(async () => {}),
  closeTabs: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/connection/connectionStateEvents", () => ({ notifyConnectionStateChanged: mocks.notify }));
vi.mock("@/lib/backend/api", () => ({
  connectionIsOpen: mocks.open,
  connectDb: mocks.connect,
  disconnectDb: mocks.disconnect,
  loadSchemaCache: async () => null,
  saveSchemaCache: async () => {},
  saveSidebarLayout: async () => {},
}));
vi.mock("@/stores/queryStore", () => ({
  useQueryStore: () => ({ closeConnectionTabs: mocks.closeTabs, flushPendingPersist: async () => {} }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  setActivePinia(createPinia());
  mocks.open.mockResolvedValue(true);
});

async function loadStore() {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [{ id: "pg", name: "Postgres", db_type: "postgres", host: "localhost", port: 5432, username: "postgres", password: "", database: "app" } as ConnectionConfig];
  store.treeNodes = [{ id: "pg", type: "connection", label: "Postgres", connectionId: "pg", isExpanded: false, children: [] }];
  return store;
}

describe("connection state shared by desktop windows", () => {
  it("shows a connection opened elsewhere without connecting, echoing or changing navigation", async () => {
    const store = await loadStore();
    store.activeConnectionId = "other";
    await store.syncSharedConnectionState("pg");
    expect(store.connectedIds.has("pg")).toBe(true);
    expect(store.activeConnectionId).toBe("other");
    expect(store.treeNodes[0].isExpanded).toBe(false);
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.closeTabs).not.toHaveBeenCalled();
  });

  it("publishes local successful connections", async () => {
    const store = await loadStore();
    store.markConnectionConnected("pg");
    expect(mocks.notify).toHaveBeenCalledWith({ connectionId: "pg" });
  });

  it("publishes a local disconnect only after the backend closes", async () => {
    const store = await loadStore();
    store.connectedIds.add("pg");
    let release!: () => void;
    mocks.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = store.disconnect("pg");
    await vi.waitFor(() => expect(mocks.disconnect).toHaveBeenCalled());
    expect(mocks.notify).not.toHaveBeenCalled();
    release();
    await pending;
    expect(mocks.notify).toHaveBeenCalledWith({ connectionId: "pg", closedByUser: true });
  });

  it("does not publish a disconnect that failed in the backend", async () => {
    const store = await loadStore();
    store.connectedIds.add("pg");
    mocks.disconnect.mockRejectedValueOnce(new Error("disconnect failed"));
    await expect(store.disconnect("pg")).rejects.toThrow("disconnect failed");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("confirms remote closes without disconnecting the backend again or closing local tabs", async () => {
    const store = await loadStore();
    store.connectedIds.add("pg");
    mocks.open.mockResolvedValue(false);
    await store.syncSharedConnectionState("pg", true);
    expect(store.connectedIds.has("pg")).toBe(false);
    expect(store.isConnectionClosedByUser("pg")).toBe(true);
    expect(mocks.disconnect).not.toHaveBeenCalled();
    expect(mocks.closeTabs).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
    mocks.open.mockResolvedValue(true);
    await store.syncSharedConnectionState("pg");
    expect(store.connectedIds.has("pg")).toBe(true);
    expect(store.isConnectionClosedByUser("pg")).toBe(false);
  });

  it("does not let a delayed close notification override a backend reconnect", async () => {
    const store = await loadStore();
    store.connectedIds.add("pg");
    await store.syncSharedConnectionState("pg", true);
    expect(store.connectedIds.has("pg")).toBe(true);
    expect(store.isConnectionClosedByUser("pg")).toBe(false);
  });

  it("ignores stale status replies when a newer sync completed", async () => {
    const store = await loadStore();
    let resolveOlder!: (open: boolean) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    const older = store.syncSharedConnectionState("pg");
    await store.syncSharedConnectionState("pg");
    resolveOlder(false);
    await older;
    expect(store.connectedIds.has("pg")).toBe(true);
  });

  it("does not overwrite an in-progress local connect or a changed configuration", async () => {
    const store = await loadStore();
    store.connectingIds.add("pg");
    await store.syncSharedConnectionState("pg");
    expect(mocks.open).not.toHaveBeenCalled();
    store.connectingIds.delete("pg");
    let resolve!: (open: boolean) => void;
    mocks.open.mockImplementationOnce(
      () =>
        new Promise((release) => {
          resolve = release;
        }),
    );
    const pending = store.syncSharedConnectionState("pg");
    store.connections[0].host = "another-host";
    resolve(true);
    await pending;
    expect(store.connectedIds.has("pg")).toBe(false);
  });

  it("keeps the indicator unchanged if a read-only status check fails", async () => {
    const store = await loadStore();
    store.connectedIds.add("pg");
    mocks.open.mockRejectedValue(new Error("IPC unavailable"));
    await store.syncSharedConnectionState("pg");
    expect(store.connectedIds.has("pg")).toBe(true);
  });
});
