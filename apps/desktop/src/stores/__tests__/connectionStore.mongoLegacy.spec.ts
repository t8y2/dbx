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

function mongoConnection(): ConnectionConfig {
  return {
    id: "mongo-legacy-fallback",
    name: "MongoDB",
    db_type: "mongodb",
    driver_profile: "mongodb",
    driver_label: "MongoDB",
    host: "127.0.0.1",
    port: 27017,
    username: "",
    password: "",
    database: "admin",
  } as ConnectionConfig;
}

describe("connectionStore MongoDB Legacy fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("uses the persisted Web fallback profile to hide native-only actions", async () => {
    const config = mongoConnection();
    const legacyConfig: ConnectionConfig = {
      ...config,
      driver_profile: "mongodb-legacy",
      driver_label: "MongoDB (Legacy)",
    };
    const loadConnections = vi.fn().mockResolvedValue([legacyConfig]);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      loadConnections,
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    store.connections[0] = {
      ...store.connections[0],
      note: "Updated while connecting",
    };
    await store.connect(config);

    expect(loadConnections).toHaveBeenCalledOnce();
    expect(store.getConfig(config.id)?.driver_profile).toBe("mongodb-legacy");
    expect(store.getConfig(config.id)?.driver_label).toBe("MongoDB (Legacy)");
    expect(store.getConfig(config.id)?.note).toBe("Updated while connecting");
  });

  it("does not apply a stale fallback after the connection config changes", async () => {
    const config = mongoConnection();
    const legacyConfig: ConnectionConfig = {
      ...config,
      driver_profile: "mongodb-legacy",
      driver_label: "MongoDB (Legacy)",
    };
    let resolveLoadConnections!: (configs: ConnectionConfig[]) => void;
    const loadConnections = vi.fn().mockImplementation(
      () =>
        new Promise<ConnectionConfig[]>((resolve) => {
          resolveLoadConnections = resolve;
        }),
    );

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      connectDb: vi.fn().mockResolvedValue(config.id),
      loadConnections,
      connectionDatabaseInfo: vi.fn().mockRejectedValue(new Error("metadata unavailable")),
      connectionIdentifierQuote: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    await store.addConnection(config);
    const connectPromise = store.connect(config);
    await vi.waitFor(() => expect(loadConnections).toHaveBeenCalledOnce());

    const replacement = {
      ...config,
      name: "Replacement MongoDB",
      host: "replacement.example.com",
    };
    await store.updateConnection(replacement);
    resolveLoadConnections([legacyConfig]);
    await connectPromise;

    expect(store.getConfig(config.id)).toMatchObject({
      name: "Replacement MongoDB",
      host: "replacement.example.com",
      driver_profile: "mongodb",
      driver_label: "MongoDB",
    });
  });
});
