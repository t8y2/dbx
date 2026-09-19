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

function postgresConnection(): ConnectionConfig {
  return {
    id: "pg-1",
    name: "Postgres",
    db_type: "postgres",
    host: "127.0.0.1",
    port: 5432,
    username: "postgres",
    password: "",
    database: "app",
  } as ConnectionConfig;
}

function installApiMocks(prewarmConnection: ReturnType<typeof vi.fn>) {
  vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
  vi.doMock("@/lib/backend/api", () => ({
    checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
    deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
    getColumns: vi.fn().mockResolvedValue([]),
    listInstalledAgents: vi.fn().mockResolvedValue([]),
    listObjects: vi.fn().mockResolvedValue([]),
    listTables: vi.fn().mockResolvedValue([]),
    loadSchemaCache: vi.fn().mockResolvedValue(null),
    prewarmConnection,
    saveConnections: vi.fn().mockResolvedValue(undefined),
    saveSchemaCache: vi.fn().mockResolvedValue(undefined),
    saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  }));
}

async function createStore() {
  const { useConnectionStore } = await import("@/stores/connectionStore");
  const store = useConnectionStore();
  const connection = postgresConnection();
  store.connections = [connection];
  store.connectedIds.add(connection.id);
  return store;
}

describe("connectionStore driver prewarm", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("warms the driver once per pool target and skips unconnected connections", async () => {
    const prewarmConnection = vi.fn().mockResolvedValue(undefined);
    installApiMocks(prewarmConnection);
    const store = await createStore();

    store.warmConnection("pg-1", { database: "app" });
    store.warmConnection("pg-1", { database: "app" });
    store.warmConnection("pg-1", { database: "app", clientSessionId: "tab-1" });
    store.warmConnection("unknown", { database: "app" });
    await Promise.resolve();
    await Promise.resolve();

    expect(prewarmConnection).toHaveBeenCalledTimes(2);
    expect(prewarmConnection).toHaveBeenCalledWith("pg-1", "app", undefined, undefined);
    expect(prewarmConnection).toHaveBeenCalledWith("pg-1", "app", undefined, "tab-1");
  });

  it("does not surface warm-up failures and retries with a fresh attempt", async () => {
    const prewarmConnection = vi.fn().mockRejectedValueOnce(new Error("driver unavailable")).mockResolvedValue(undefined);
    installApiMocks(prewarmConnection);
    const store = await createStore();

    expect(() => store.warmConnection("pg-1", { database: "app" })).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.warmConnection("pg-1", { database: "app" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prewarmConnection).toHaveBeenCalledTimes(2);
  });

  it("forgets warm-up bookkeeping when a connection is torn down", async () => {
    const prewarmConnection = vi.fn().mockResolvedValue(undefined);
    installApiMocks(prewarmConnection);
    const store = await createStore();
    const waitForCall = () => new Promise((resolve) => setTimeout(resolve, 0));

    store.warmConnection("pg-1", { database: "app", clientSessionId: "tab-1" });
    await waitForCall();
    expect(prewarmConnection).toHaveBeenCalledTimes(1);

    // Inside the TTL window the second request is deduplicated.
    store.warmConnection("pg-1", { database: "app", clientSessionId: "tab-1" });
    await waitForCall();
    expect(prewarmConnection).toHaveBeenCalledTimes(1);

    // The pool is gone after a teardown, so the next warm-up must run again
    // instead of trusting the stale timestamp.
    store.markConnectionOffline("pg-1");
    store.connectedIds.add("pg-1");
    store.warmConnection("pg-1", { database: "app", clientSessionId: "tab-1" });
    await waitForCall();
    expect(prewarmConnection).toHaveBeenCalledTimes(2);
  });
});
