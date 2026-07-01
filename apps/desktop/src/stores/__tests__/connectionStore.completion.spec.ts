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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it("keeps schema-qualified local table completion scoped to the selected schema", async () => {
    const completionAssistantSearch = vi.fn().mockRejectedValue(new Error("assistant unavailable"));
    const listTables = vi.fn(async (_connectionId: string, _database: string, schema: string, filter: string) => {
      if (schema === "dim_game_base" && filter === "dim") {
        return [{ name: "dim_game", table_type: "BASE TABLE", comment: null }];
      }
      return [];
    });

    vi.doMock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch,
      listSchemas: vi.fn().mockResolvedValue(["dim_game_base", "dws_game_sdk_base"]),
      listTables,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const dimTables = await store.listCompletionTables("pg-1", "app", "dim", 20, "dim_game_base");
    const dwsTables = store.lookupLocalCompletionTables("pg-1", "app", "d", 20, "dws_game_sdk_base");

    expect(dimTables).toEqual([{ name: "dim_game", schema: "dim_game_base", type: "table" }]);
    expect(dwsTables).toEqual([]);
  });

  it("limits concurrent completion column metadata requests per connection database", async () => {
    const gates = [deferred<any[]>(), deferred<any[]>(), deferred<any[]>(), deferred<any[]>()];
    let activeColumns = 0;
    let maxActiveColumns = 0;
    const getColumns = vi.fn((_connectionId: string, _database: string, _schema: string, table: string) => {
      const index = Number(table.replace("table_", ""));
      activeColumns++;
      maxActiveColumns = Math.max(maxActiveColumns, activeColumns);
      return gates[index].promise.finally(() => {
        activeColumns--;
      });
    });

    vi.doMock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/api", () => ({
      checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
      completionAssistantSearch: vi.fn().mockResolvedValue({ candidates: [], incomplete: false, fallback_used: false }),
      getColumns,
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.connections = [postgresConnection()];
    store.connectedIds.add("pg-1");

    const requests = [0, 1, 2, 3].map((index) => store.listCompletionColumns("pg-1", "app", `table_${index}`, "public"));

    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(2));
    expect(maxActiveColumns).toBe(2);
    gates[0].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    await vi.waitFor(() => expect(getColumns).toHaveBeenCalledTimes(3));
    gates[1].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[2].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);
    gates[3].resolve([{ name: "id", data_type: "integer", is_nullable: false, column_default: null, is_primary_key: true, extra: null }]);

    await Promise.all(requests);
    expect(maxActiveColumns).toBe(2);
  });
});
