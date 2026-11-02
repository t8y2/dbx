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
    id: "mongo-1",
    name: "MongoDB",
    db_type: "mongodb",
    host: "127.0.0.1",
    port: 27017,
    username: "",
    password: "",
    database: "app",
  } as ConnectionConfig;
}

describe("connectionStore listMongoCompletionFields", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("samples fields via mongoAggregateDocuments with $sample size 100 and maxTimeMS", async () => {
    const api = {
      mongoAggregateDocuments: vi.fn().mockResolvedValue({
        documents: [
          { _id: "1", username: "alice", meta: { score: 95 } },
          { _id: "2", email: "alice@example.com" },
        ],
      }),
      mongoFindDocuments: vi.fn(),
    };
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => api);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = mongoConnection();
    store.addEphemeralConnection(config);

    const fields = await store.listMongoCompletionFields(config.id, "app", "users");

    expect(api.mongoAggregateDocuments).toHaveBeenCalledOnce();
    expect(api.mongoAggregateDocuments).toHaveBeenCalledWith(config.id, "app", "users", '[{"$sample":{"size":100}}]', 100, JSON.stringify({ maxTimeMS: 5000 }));
    expect(api.mongoFindDocuments).not.toHaveBeenCalled();

    expect(fields).toEqual([
      { name: "_id", type: "string" },
      { name: "email", type: "string" },
      { name: "meta", type: "object" },
      { name: "meta.score", type: "number" },
      { name: "username", type: "string" },
    ]);

    // Second call should hit the cache without calling api.mongoAggregateDocuments again
    const cached = await store.listMongoCompletionFields(config.id, "app", "users");
    expect(cached).toEqual(fields);
    expect(api.mongoAggregateDocuments).toHaveBeenCalledOnce();
  });

  it("falls back to mongoFindDocuments with 100 documents when aggregation fails", async () => {
    const api = {
      mongoAggregateDocuments: vi.fn().mockRejectedValue(new Error("Aggregation not supported")),
      mongoFindDocuments: vi.fn().mockResolvedValue({
        documents: [{ _id: "1", fallbackField: "val", count: 42 }],
      }),
    };
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => api);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = mongoConnection();
    store.addEphemeralConnection(config);

    const fields = await store.listMongoCompletionFields(config.id, "app", "users");

    expect(api.mongoAggregateDocuments).toHaveBeenCalledOnce();
    expect(api.mongoFindDocuments).toHaveBeenCalledOnce();
    expect(api.mongoFindDocuments).toHaveBeenCalledWith(config.id, "app", "users", 0, 100, "{}");

    expect(fields).toEqual([
      { name: "_id", type: "string" },
      { name: "count", type: "number" },
      { name: "fallbackField", type: "string" },
    ]);

    // Second call should hit cache
    const cached = await store.listMongoCompletionFields(config.id, "app", "users");
    expect(cached).toEqual(fields);
    expect(api.mongoFindDocuments).toHaveBeenCalledOnce();
  });

  it("infers types from extended_documents when returned by mongoAggregateDocuments", async () => {
    const api = {
      mongoAggregateDocuments: vi.fn().mockResolvedValue({
        documents: [{ _id: "65f0c0ffee00000000000001", createdAt: "2026-01-01T00:00:00Z", ref: "65f0c0ffee0000000000abcd" }],
        extended_documents: [{ _id: { $oid: "65f0c0ffee00000000000001" }, createdAt: { $date: "2026-01-01T00:00:00Z" }, ref: { $oid: "65f0c0ffee0000000000abcd" } }],
      }),
      mongoFindDocuments: vi.fn(),
    };
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => api);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = mongoConnection();
    store.addEphemeralConnection(config);

    const fields = await store.listMongoCompletionFields(config.id, "app", "users");

    expect(fields).toEqual([
      { name: "_id", type: "objectId" },
      { name: "createdAt", type: "date" },
      { name: "ref", type: "objectId" },
    ]);
  });

  it("infers types from extended_documents when returned by mongoFindDocuments fallback", async () => {
    const api = {
      mongoAggregateDocuments: vi.fn().mockRejectedValue(new Error("Aggregation not supported")),
      mongoFindDocuments: vi.fn().mockResolvedValue({
        documents: [{ _id: "65f0c0ffee00000000000001", createdAt: "2026-01-01T00:00:00Z", ref: "65f0c0ffee0000000000abcd" }],
        extended_documents: [{ _id: { $oid: "65f0c0ffee00000000000001" }, createdAt: { $date: "2026-01-01T00:00:00Z" }, ref: { $oid: "65f0c0ffee0000000000abcd" } }],
      }),
    };
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => api);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = mongoConnection();
    store.addEphemeralConnection(config);

    const fields = await store.listMongoCompletionFields(config.id, "app", "users");

    expect(fields).toEqual([
      { name: "_id", type: "objectId" },
      { name: "createdAt", type: "date" },
      { name: "ref", type: "objectId" },
    ]);
  });

  it("falls back to documents when extended_documents is absent or length mismatches", async () => {
    const api = {
      mongoAggregateDocuments: vi.fn().mockResolvedValue({
        documents: [{ _id: "1", fallbackField: "val" }],
        extended_documents: [],
      }),
      mongoFindDocuments: vi.fn(),
    };
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => api);

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    const config = mongoConnection();
    store.addEphemeralConnection(config);

    const fields = await store.listMongoCompletionFields(config.id, "app", "users");

    expect(fields).toEqual([
      { name: "_id", type: "string" },
      { name: "fallbackField", type: "string" },
    ]);
  });
});
