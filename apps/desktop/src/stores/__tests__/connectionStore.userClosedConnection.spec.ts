import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function pgConnection(id: string): ConnectionConfig {
  return { id, name: id, db_type: "postgres", host: "127.0.0.1", port: 5432, username: "postgres", password: "", database: "app", read_only: false } as ConnectionConfig;
}

async function setup() {
  const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
  const connectDb = vi.fn(async (config: ConnectionConfig) => config.id);
  const disconnectDb = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth,
    connectDb,
    disconnectDb,
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore, CONNECTION_CLOSED_BY_USER_MESSAGE } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [pgConnection("conn-a")];
  return { store, connectDb, disconnectDb, CONNECTION_CLOSED_BY_USER_MESSAGE };
}

describe("connectionStore: user-closed connections do not wake up from passive paths", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("marks the connection on disconnect and blocks passive wake-ups", async () => {
    const { store, connectDb, CONNECTION_CLOSED_BY_USER_MESSAGE } = await setup();
    store.connectedIds.add("conn-a");
    await store.disconnect("conn-a");

    expect(store.connectedIds.has("conn-a")).toBe(false);
    expect(store.isConnectionClosedByUser("conn-a")).toBe(true);

    await expect(store.ensureConnected("conn-a", { skipIfClosedByUser: true })).rejects.toThrow(CONNECTION_CLOSED_BY_USER_MESSAGE);
    expect(connectDb).not.toHaveBeenCalled();
    expect(store.connectedIds.has("conn-a")).toBe(false);
  }, 20_000);

  it("lets an explicit reconnect through and clears the mark", async () => {
    const { store, connectDb } = await setup();
    store.connectedIds.add("conn-a");
    await store.disconnect("conn-a");

    // 用户主动入口（点侧栏连接节点 / 按 Run / 打开表数据）不带 skipIfClosedByUser。
    await store.ensureConnected("conn-a");
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(store.connectedIds.has("conn-a")).toBe(true);
    expect(store.isConnectionClosedByUser("conn-a")).toBe(false);

    // 标记清掉之后，页签界面的被动唤醒可以正常工作。
    await store.ensureConnected("conn-a", { skipIfClosedByUser: true });
    expect(store.connectedIds.has("conn-a")).toBe(true);
  }, 20_000);

  it("connect() clears the mark as well", async () => {
    const { store } = await setup();
    store.connectedIds.add("conn-a");
    await store.disconnect("conn-a");
    expect(store.isConnectionClosedByUser("conn-a")).toBe(true);

    await store.connect(pgConnection("conn-a"));
    expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
  }, 20_000);

  it("system-side disconnects do not mark the connection", async () => {
    const { store, connectDb } = await setup();
    store.connectedIds.add("conn-a");
    // releasePluginConnectionsAfterClose / retirePasswordAfterChange 走这条。
    await store.disconnect("conn-a", { markClosedByUser: false });
    expect(store.isConnectionClosedByUser("conn-a")).toBe(false);

    await store.ensureConnected("conn-a", { skipIfClosedByUser: true });
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(store.connectedIds.has("conn-a")).toBe(true);
  }, 20_000);

  it("removing the connection clears a stale mark", async () => {
    const { store } = await setup();
    store.connectedIds.add("conn-a");
    await store.disconnect("conn-a");
    expect(store.isConnectionClosedByUser("conn-a")).toBe(true);

    await store.removeConnection("conn-a");
    expect(store.isConnectionClosedByUser("conn-a")).toBe(false);
  }, 20_000);
});
