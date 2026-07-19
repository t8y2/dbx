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

function mysqlConnection(): ConnectionConfig {
  return {
    id: "mysql-info",
    name: "MySQL",
    db_type: "mysql",
    driver_profile: "mysql",
    driver_label: "MySQL",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "secret",
    database: "app",
  };
}

describe("connectionStore database info", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("persists metadata from a successful live connection without marking it disconnected", async () => {
    const config = mysqlConnection();
    const saveConnections = vi.fn().mockResolvedValue(undefined);
    const saveConnectionDatabaseInfo = vi.fn().mockResolvedValue(undefined);
    const connectionDatabaseInfo = vi.fn().mockResolvedValue({ productName: "MySQL", productVersion: "8.0.34" });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo,
      saveConnectionDatabaseInfo,
      saveConnections,
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await store.connect(config);

    await vi.waitFor(() => expect(saveConnectionDatabaseInfo).toHaveBeenCalled());
    expect(connectionDatabaseInfo).toHaveBeenCalledWith(config.id);
    expect(saveConnectionDatabaseInfo).toHaveBeenCalledWith(config.id, {
      productName: "MySQL",
      productVersion: "8.0.34",
      currentDatabase: "app",
      serverComment: undefined,
      serverCharset: undefined,
      serverCollation: undefined,
      unquotedIdentifierCase: undefined,
      quotedIdentifierCase: undefined,
      driverName: undefined,
      driverVersion: undefined,
      jdbcVersion: undefined,
    });
    expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34");
    expect(store.connectedIds.has(config.id)).toBe(true);
  });

  it("preserves the connection tree node while background database info is stored", async () => {
    const config = mysqlConnection();
    const saveConnectionDatabaseInfo = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn().mockResolvedValue({ productName: "MySQL", productVersion: "8.0.34" }),
      saveConnectionDatabaseInfo,
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    const connectionNode = store.treeNodes[0];

    await store.connect(config);
    await vi.waitFor(() => expect(saveConnectionDatabaseInfo).toHaveBeenCalled());

    expect(store.treeNodes[0]).toBe(connectionNode);
    expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34");
    expect(store.connectedIds.has(config.id)).toBe(true);
  });

  it("does not delay connection success while optional metadata is loading", async () => {
    const config = mysqlConnection();
    let resolveDatabaseInfo!: (value: { productName: string; productVersion: string }) => void;
    const databaseInfo = new Promise<{ productName: string; productVersion: string }>((resolve) => {
      resolveDatabaseInfo = resolve;
    });

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn(() => databaseInfo),
      saveConnectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await expect(store.connect(config)).resolves.toBe(config.id);
    expect(store.connectedIds.has(config.id)).toBe(true);

    resolveDatabaseInfo({ productName: "MySQL", productVersion: "8.0.34" });
    await vi.waitFor(() => expect(store.getConfig(config.id)?.database_info?.productVersion).toBe("8.0.34"));
  });

  it("keeps a successful connection when optional metadata refresh fails", async () => {
    const config = mysqlConnection();

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    await expect(store.connect(config)).resolves.toBe(config.id);
    expect(store.connectedIds.has(config.id)).toBe(true);
  });
});
