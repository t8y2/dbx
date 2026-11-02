import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

function esConnection(dbType: "elasticsearch" | "easysearch" = "elasticsearch", id = "es-1"): ConnectionConfig {
  return {
    id,
    name: dbType === "easysearch" ? "Easysearch" : "Elasticsearch",
    db_type: dbType,
    host: "127.0.0.1",
    port: 9200,
    username: "",
    password: "",
    database: "",
  } as ConnectionConfig;
}

function seedConnectionNode(store: { treeNodes: TreeNode[]; connectedIds: Set<string> }, id = "es-1", label = "Elasticsearch") {
  store.connectedIds.add(id);
  store.treeNodes.push({
    id,
    label,
    type: "connection",
    connectionId: id,
    isExpanded: false,
    children: [],
  });
}

describe("connectionStore Elasticsearch open/expand", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    installLocalStorage();
    setActivePinia(createPinia());
  });

  it("openElasticsearchConnectionTree only ensures connectivity, does not expand or list indices", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([
      { name: "orders", id: "orders", kind: "index" },
      { name: "users", id: "users", kind: "index" },
    ]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices: vi.fn(),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(esConnection());
    seedConnectionNode(store);

    await store.openElasticsearchConnectionTree("es-1");

    expect(documentListCollections).not.toHaveBeenCalled();
    const node = store.treeNodes.find((n) => n.id === "es-1");
    // openElasticsearchConnectionTree does NOT expand the node
    expect(node?.isExpanded).toBe(false);
    expect(node?.children?.some((c) => c.type === "elasticsearch-index")).toBe(false);
  });

  it("refreshTreeNode lists indices", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([
      { name: "orders", id: "orders", kind: "index" },
      { name: "users", id: "users", kind: "index" },
    ]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices: vi.fn(),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(esConnection());
    seedConnectionNode(store);
    const node = store.treeNodes.find((n) => n.id === "es-1")!;

    await store.refreshTreeNode(node);

    expect(documentListCollections).toHaveBeenCalledWith("es-1", "default");
    expect(
      node.children
        ?.filter((c) => c.type === "elasticsearch-index")
        .map((c) => c.label)
        .sort(),
    ).toEqual(["orders", "users"]);
  });

  it("loadElasticsearchIndices lists indices and expands", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([
      { name: "orders", id: "orders", kind: "index" },
      { name: "users", id: "users", kind: "index" },
    ]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices: vi.fn(),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(esConnection());
    seedConnectionNode(store);

    await store.loadElasticsearchIndices("es-1");

    expect(documentListCollections).toHaveBeenCalledWith("es-1", "default");
    const node = store.treeNodes.find((n) => n.id === "es-1");
    expect(
      node?.children
        ?.filter((c) => c.type === "elasticsearch-index")
        .map((c) => c.label)
        .sort(),
    ).toEqual(["orders", "users"]);
  });

  it("loads Easysearch indices through the Elasticsearch-compatible tree", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([
      { name: "orders", id: "orders", kind: "index" },
      { name: "users", id: "users", kind: "index" },
    ]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices: vi.fn(),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(esConnection("easysearch", "easysearch-1"));
    seedConnectionNode(store, "easysearch-1", "Easysearch");

    await store.loadElasticsearchIndices("easysearch-1");

    expect(documentListCollections).toHaveBeenCalledWith("easysearch-1", "default");
    expect(
      store.treeNodes
        .find((node) => node.id === "easysearch-1")
        ?.children?.filter((node) => node.type === "elasticsearch-index")
        .map((node) => node.label)
        .sort(),
    ).toEqual(["orders", "users"]);
  });

  it("keeps aliases on the same index row instead of adding a second node", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([
      { name: "orders", id: "orders", aliases: ["orders-write"] },
      { name: "users", id: "users", aliases: [] },
    ]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices: vi.fn(),
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection(esConnection());
    seedConnectionNode(store);

    await store.loadElasticsearchIndices("es-1");

    const nodes = store.treeNodes.find((node) => node.id === "es-1")?.children?.filter((node) => node.type === "elasticsearch-index");
    expect(
      nodes?.map((node) => ({
        label: node.label,
        searchAliases: node.searchAliases,
      })),
    ).toEqual([
      { label: "orders", searchAliases: ["orders-write"] },
      { label: "users", searchAliases: undefined },
    ]);
  });

  it("uses the shared Meilisearch index-list method for the Meilisearch tree", async () => {
    const documentListCollections = vi.fn().mockResolvedValue([{ name: "wrong-index", id: "wrong-index", kind: "index" }]);
    const elasticsearchListIndices = vi.fn().mockResolvedValue(["wrong-index"]);
    const meilisearchListIndexes = vi.fn().mockResolvedValue(["movies", "books"]);
    const checkConnectionHealth = vi.fn().mockResolvedValue(undefined);

    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
    vi.doMock("@/lib/backend/api", () => ({
      checkConnectionHealth,
      documentListCollections,
      elasticsearchListIndices,
      meilisearchListIndexes,
      deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
      loadSchemaCache: vi.fn().mockResolvedValue(null),
      saveSchemaCache: vi.fn().mockResolvedValue(undefined),
      saveConnections: vi.fn().mockResolvedValue(undefined),
      saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
    }));

    const { useConnectionStore } = await import("@/stores/connectionStore");
    const store = useConnectionStore();
    store.addEphemeralConnection({ ...esConnection(), id: "meili-1", name: "Meilisearch", db_type: "meilisearch", port: 7700 });
    seedConnectionNode(store, "meili-1", "Meilisearch");

    await store.loadElasticsearchIndices("meili-1");

    expect(meilisearchListIndexes).toHaveBeenCalledWith("meili-1");
    expect(documentListCollections).not.toHaveBeenCalled();
    expect(elasticsearchListIndices).not.toHaveBeenCalled();
    expect(
      store.treeNodes
        .find((node) => node.id === "meili-1")
        ?.children?.filter((node) => node.type === "elasticsearch-index")
        .map((node) => node.label)
        .sort(),
    ).toEqual(["books", "movies"]);
  });
});
