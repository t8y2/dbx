import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";

const api = vi.hoisted(() => ({
  connectDb: vi.fn(),
  connectionDatabaseInfo: vi.fn(),
  saveConnectionDatabaseInfo: vi.fn(),
  saveConnections: vi.fn(),
  saveSidebarLayout: vi.fn(),
  connectionIdentifierQuote: vi.fn(),
}));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/api", () => api);

// Cold module transformation is setup work, not part of the behavioral timeout.
import { useConnectionStore } from "@/stores/connectionStore";

function kingbaseConnection(): ConnectionConfig {
  return {
    id: "kingbase-info",
    name: "Synthetic Kingbase",
    db_type: "kingbase",
    host: "example.test",
    port: 54321,
    username: "synthetic",
    password: "synthetic-fixture",
    database: "app",
  };
}

describe("connectionStore Kingbase mode lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key),
    });
    setActivePinia(createPinia());
    api.connectDb.mockResolvedValue("kingbase-info");
    api.saveConnectionDatabaseInfo.mockResolvedValue(undefined);
    api.saveConnections.mockResolvedValue(undefined);
    api.saveSidebarLayout.mockResolvedValue(undefined);
    api.connectionIdentifierQuote.mockResolvedValue('"');
  });

  it.each(["connect", "ensureConnected"] as const)("refreshes mode before %s is ready and discards stale metadata on failure", async (method) => {
    const config = { ...kingbaseConnection(), database_info: { compatibilityMode: "mysql" } };
    let reject!: (error: Error) => void;
    api.connectionDatabaseInfo.mockReturnValue(
      new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      }),
    );
    const store = useConnectionStore();
    await store.addConnection(config);
    const connecting = method === "connect" ? store.connect(config) : store.ensureConnected(config.id);
    try {
      await vi.waitFor(() => expect(api.connectionDatabaseInfo).toHaveBeenCalled());
      expect(store.connectedIds.has(config.id)).toBe(false);
      expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBeUndefined();
    } finally {
      reject(new Error("mode metadata unavailable"));
      await connecting;
    }
    expect(store.connectedIds.has(config.id)).toBe(true);
    expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBeUndefined();
  });

  it("caches quotes for the database requested, including concurrent lookups", async () => {
    const config = kingbaseConnection();
    api.connectionDatabaseInfo.mockResolvedValue({ productName: "KingbaseES", compatibilityMode: "oracle" });
    api.connectionIdentifierQuote.mockImplementation(async (_id, database) => (database === "mysql_app" ? "`" : '"'));
    const store = useConnectionStore();
    await store.addConnection(config);
    await store.connect(config);

    expect(store.connectionIdentifierQuote(config.id)).toBe('"');
    expect(store.connectionIdentifierQuote(config.id, "mysql_app")).toBeUndefined();
    const quotes = await Promise.all([store.ensureConnectionIdentifierQuote(config.id, "oracle_app"), store.ensureConnectionIdentifierQuote(config.id, "mysql_app"), store.ensureConnectionIdentifierQuote(config.id, "mysql_app")]);

    expect(quotes).toEqual(['"', "`", "`"]);
    expect(store.connectionIdentifierQuote(config.id, "oracle_app")).toBe('"');
    expect(store.connectionIdentifierQuote(config.id, "mysql_app")).toBe("`");
    await expect(store.ensureConnectionIdentifierQuote(config.id, "oracle_app")).resolves.toBe('"');
    expect(api.connectionIdentifierQuote.mock.calls).toEqual([[config.id], [config.id, "oracle_app"], [config.id, "mysql_app"]]);
  });

  it("refreshes and persists the reported mode", async () => {
    const mode = "oracle";
    const config = kingbaseConnection();
    api.connectionDatabaseInfo.mockResolvedValue({ productName: "KingbaseES", compatibilityMode: mode });
    const store = useConnectionStore();
    await store.addConnection(config);
    await store.connect(config);
    expect(store.getConfig(config.id)?.database_info?.compatibilityMode).toBe(mode);
    expect(api.saveConnectionDatabaseInfo).toHaveBeenCalledWith(config.id, expect.objectContaining({ compatibilityMode: mode }));
  });
});
