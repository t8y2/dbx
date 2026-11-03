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

const ORA_NO_LISTENER = "Agent RPC error: ORA-12541: TNS:no listener";

async function setup() {
  const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);
  const connectDb = vi
    .fn()
    .mockRejectedValueOnce(new Error(ORA_NO_LISTENER))
    .mockImplementation(async (config: ConnectionConfig) => config.id);
  const disconnectDb = vi.fn().mockResolvedValue(undefined);

  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth,
    connectDb,
    disconnectDb,
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    deleteTableVGroupsForConnection: vi.fn().mockResolvedValue(undefined),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listInstalledAgentsLocal: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));

  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  store.connections = [pgConnection("conn-a")];
  return { store, connectDb, disconnectDb };
}

describe("connectionStore: passive reconnect backoff", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("does not open a second connection for passive callers inside the backoff window", async () => {
    const { store, connectDb } = await setup();

    await expect(store.ensureConnected("conn-a", { passive: true })).rejects.toThrow("ORA-12541");
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(store.connectionErrors["conn-a"]).toContain("ORA-12541");

    // 面板轮询/自动刷新/页签恢复在退避窗口内必须复用同一次失败，不能再发起连接——
    // 否则第三方安全/零信任客户端会为每次连接各弹一个框。
    await expect(store.ensureConnected("conn-a", { passive: true })).rejects.toThrow("ORA-12541");
    expect(connectDb).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("never blocks a user-triggered ensureConnected", async () => {
    const { store, connectDb } = await setup();
    await expect(store.ensureConnected("conn-a", { passive: true })).rejects.toThrow("ORA-12541");
    expect(connectDb).toHaveBeenCalledTimes(1);

    // 用户点侧栏连接/打开表等走非 passive 路径：必须真的再连一次，不能被后台退避拦住。
    await expect(store.ensureConnected("conn-a")).resolves.toBeUndefined();
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(store.connectedIds.has("conn-a")).toBe(true);
  }, 20_000);

  it("lets an explicit connect() through and clears the backoff on success", async () => {
    const { store, connectDb } = await setup();
    await expect(store.ensureConnected("conn-a", { passive: true })).rejects.toThrow("ORA-12541");
    expect(connectDb).toHaveBeenCalledTimes(1);

    await store.connect(pgConnection("conn-a"));
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(store.connectedIds.has("conn-a")).toBe(true);

    // 成功后退避清空，被动路径恢复正常且不再被拦。
    await store.ensureConnected("conn-a", { passive: true, verifyHealth: false });
    expect(connectDb).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("forceReconnect bypasses the backoff", async () => {
    const { store, connectDb } = await setup();
    await expect(store.ensureConnected("conn-a", { passive: true })).rejects.toThrow("ORA-12541");
    expect(connectDb).toHaveBeenCalledTimes(1);

    await expect(store.ensureConnected("conn-a", { passive: true, forceReconnect: true })).resolves.toBeUndefined();
    expect(connectDb).toHaveBeenCalledTimes(2);
    expect(store.connectedIds.has("conn-a")).toBe(true);
  }, 20_000);

  it("stops passive reconnects after repeated failures until an explicit connect", async () => {
    const { store, connectDb } = await setup();
    connectDb.mockReset();
    connectDb.mockRejectedValue(new Error(ORA_NO_LISTENER));

    const start = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => start);
    try {
      // 退避序列 15s → 60s → 5min；每次都要等窗口过去才会再试一次。
      const passive = { passive: true };
      await expect(store.ensureConnected("conn-a", passive)).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(1);

      nowSpy.mockImplementation(() => start + 16_000);
      await expect(store.ensureConnected("conn-a", passive)).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(2);

      nowSpy.mockImplementation(() => start + 16_000 + 61_000);
      await expect(store.ensureConnected("conn-a", passive)).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(3);

      nowSpy.mockImplementation(() => start + 16_000 + 61_000 + 301_000);
      await expect(store.ensureConnected("conn-a", passive)).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(4);

      // 连续第 4 次失败后被动路径完全停止：再等一小时也不会再发起连接（不再弹框）。
      nowSpy.mockImplementation(() => start + 16_000 + 61_000 + 301_000 + 3_600_000);
      await expect(store.ensureConnected("conn-a", passive)).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(4);

      // 用户显式 connect() 清空退避，允许真的再试一次。
      await expect(store.connect(pgConnection("conn-a"))).rejects.toThrow("ORA-12541");
      expect(connectDb).toHaveBeenCalledTimes(5);
    } finally {
      nowSpy.mockRestore();
    }
  }, 20_000);
});
