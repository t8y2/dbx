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
    read_only: false,
  } as ConnectionConfig;
}

describe("connectionStore completion assistant", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("deduplicates in-flight assistant table requests", async () => {
    const completionAssistantSearch = vi.fn().mockResolvedValue({
      candidates: [{ name: "accounts", kind: "table", schema: "public" }],
      incomplete: false,
      fallback_used: false,
    });

    vi.doMock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables: vi.fn().mockResolvedValue([]),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const [first, second] = await Promise.all([store.listCompletionTables("pg-1", "app", "acc", 20, "public"), store.listCompletionTables("pg-1", "app", "acc", 20, "public")]);

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ name: "accounts", schema: "public", type: "table" });
  });

  it("returns fallback metadata when assistant table search fails", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn().mockResolvedValue([{ name: "accounts", table_type: "BASE TABLE", comment: null }]);

    vi.doMock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["public"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const tables = await store.listCompletionTables("pg-1", "app", "acc", 20, "public");

    expect(completionAssistantSearch).toHaveBeenCalledTimes(1);
    expect(listTables).toHaveBeenCalledWith("pg-1", "app", "public", "acc", 20);
    expect(tables).toEqual([{ name: "accounts", schema: "public", type: "table" }]);
  });
});
