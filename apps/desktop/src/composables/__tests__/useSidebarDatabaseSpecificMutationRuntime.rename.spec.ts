import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { renameMongoCollectionError, renameMongoCollectionLoading, renameMongoCollectionName, showRenameMongoCollectionDialog, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  loadMongoCollections: vi.fn().mockResolvedValue(undefined),
  loadVectorCollections: vi.fn().mockResolvedValue(undefined),
  mongoRenameCollection: vi.fn(),
  vectorRenameCollection: vi.fn(),
  replacePinnedTreeNode: vi.fn(),
  removeTreeNode: vi.fn(),
  getConfig: vi.fn(() => ({
    id: "conn-1",
    name: "Mongo",
    db_type: "mongodb" as const,
    host: "localhost",
    port: 27017,
    username: "op",
    password: "",
    driver_profile: undefined as string | undefined,
  })),
}));

vi.mock("vue-i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("vue-i18n")>()),
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
  }),
}));

vi.mock("@/composables/useToast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    getConfig: mocks.getConfig,
    ensureConnected: mocks.ensureConnected,
    loadMongoCollections: mocks.loadMongoCollections,
    loadVectorCollections: mocks.loadVectorCollections,
    replacePinnedTreeNode: mocks.replacePinnedTreeNode,
    removeTreeNode: mocks.removeTreeNode,
    treeNodes: [],
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  mongoRenameCollection: (...args: unknown[]) => mocks.mongoRenameCollection(...args),
  vectorRenameCollection: (...args: unknown[]) => mocks.vectorRenameCollection(...args),
  mongoDropCollection: vi.fn(),
  mongoDropDatabase: vi.fn(),
  mongoDropIndexes: vi.fn(),
  nacosCreateNamespace: vi.fn(),
  nacosUpdateNamespace: vi.fn(),
  redisFlushDb: vi.fn(),
}));

vi.mock("@/lib/sidebar/sidebarActionTarget", () => ({
  findSidebarActionTarget: () => null,
}));

import { useSidebarDatabaseSpecificMutationRuntime } from "@/composables/useSidebarDatabaseSpecificMutationRuntime";

function collectionNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "conn-1:app:users",
    label: "users",
    type: "mongo-collection",
    connectionId: "conn-1",
    database: "app",
    meta: { collectionKind: "collection" },
    isExpanded: false,
    ...overrides,
  };
}

describe("confirmRenameMongoCollection existing target failure", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({
      id: "conn-1",
      name: "Mongo",
      db_type: "mongodb",
      host: "localhost",
      port: 27017,
      username: "op",
      password: "",
      driver_profile: undefined,
    });
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.loadMongoCollections.mockResolvedValue(undefined);
    mocks.mongoRenameCollection.mockReset();

    const node = collectionNode();
    sidebarFormTarget.value = node;
    renameMongoCollectionName.value = "accounts";
    renameMongoCollectionError.value = "";
    renameMongoCollectionLoading.value = false;
    showRenameMongoCollectionDialog.value = true;
  });

  it("surfaces mock API reject for existing target without closing the dialog or toasting success", async () => {
    mocks.mongoRenameCollection.mockRejectedValue(new Error("Namespace app.accounts already exists. target namespace exists"));

    const activeNode = shallowRef(collectionNode());
    const { confirmRenameMongoCollection } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadMongoCollections: mocks.loadMongoCollections,
        treeNodes: [],
      } as any,
    });

    await confirmRenameMongoCollection();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("conn-1");
    expect(mocks.mongoRenameCollection).toHaveBeenCalledWith("conn-1", "app", "users", "accounts");
    expect(mocks.loadMongoCollections).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(showRenameMongoCollectionDialog.value).toBe(true);
    expect(renameMongoCollectionError.value).toContain("target namespace exists");
    expect(renameMongoCollectionLoading.value).toBe(false);
  });

  it("does not call rename API when production confirmation is cancelled", async () => {
    mocks.getConfig.mockReturnValue({
      id: "conn-1",
      name: "Mongo Prod",
      db_type: "mongodb",
      host: "localhost",
      port: 27017,
      username: "op",
      password: "",
      is_production: true,
    });

    const activeNode = shallowRef(collectionNode());
    const { confirmRenameMongoCollection } = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadMongoCollections: mocks.loadMongoCollections,
        treeNodes: [],
      } as any,
    });

    const pending = confirmRenameMongoCollection();
    await Promise.resolve();

    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    useProductionSafetyStore().cancel();
    await pending;

    expect(mocks.mongoRenameCollection).not.toHaveBeenCalled();
    expect(showRenameMongoCollectionDialog.value).toBe(true);
    expect(renameMongoCollectionError.value).toBe("");
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});

function milvusCollectionNode(): TreeNode {
  return {
    id: "milvus-1:__vector_collection:analytics:events",
    label: "events",
    type: "vector-collection",
    connectionId: "milvus-1",
    database: "analytics",
    isExpanded: false,
  };
}

describe("Milvus collection rename", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue({
      id: "milvus-1",
      name: "Milvus",
      db_type: "milvus",
      host: "localhost",
      port: 19530,
      username: "",
      password: "",
    } as any);
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.loadVectorCollections.mockResolvedValue(undefined);
    mocks.vectorRenameCollection.mockResolvedValue(undefined);
    sidebarFormTarget.value = milvusCollectionNode();
  });

  it("renames a Milvus collection and refreshes its database node", async () => {
    renameMongoCollectionName.value = "events_archive";
    showRenameMongoCollectionDialog.value = true;
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(milvusCollectionNode()),
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadVectorCollections: mocks.loadVectorCollections,
        replacePinnedTreeNode: mocks.replacePinnedTreeNode,
        removeTreeNode: mocks.removeTreeNode,
        treeNodes: [],
      } as any,
    });

    expect(feature.canRenameMongoCollection.value).toBe(true);
    expect(feature.canCloneMongoCollection.value).toBe(false);
    await feature.confirmRenameMongoCollection();

    expect(mocks.vectorRenameCollection).toHaveBeenCalledWith("milvus-1", "analytics", "events", "events_archive");
    expect(mocks.loadVectorCollections).toHaveBeenCalledWith("milvus-1", "analytics");
    expect(showRenameMongoCollectionDialog.value).toBe(false);
  });

  it("preserves a pinned Milvus collection after its rename refresh", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
      removeItem: vi.fn((key: string) => storage.delete(key)),
    });
    vi.doMock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

    const { useConnectionStore } = await vi.importActual<typeof import("@/stores/connectionStore")>("@/stores/connectionStore");
    const store = useConnectionStore();
    const originalNode = milvusCollectionNode();
    const renamedNode: TreeNode = {
      ...originalNode,
      id: "milvus-1:__vector_collection:analytics:events_archive",
      label: "events_archive",
    };
    const databaseNode: TreeNode = {
      id: "milvus-1:analytics",
      label: "analytics",
      type: "vector-database",
      connectionId: "milvus-1",
      database: "analytics",
      isExpanded: true,
      children: [originalNode],
    };
    store.connections = [mocks.getConfig() as any];
    store.treeNodes = [databaseNode];
    store.toggleTreeNodePin(originalNode);
    vi.spyOn(store, "ensureConnected").mockResolvedValue(undefined);
    vi.spyOn(store, "loadVectorCollections").mockImplementation(async () => {
      databaseNode.children = [renamedNode];
    });

    sidebarFormTarget.value = originalNode;
    renameMongoCollectionName.value = "events_archive";
    showRenameMongoCollectionDialog.value = true;
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(originalNode),
      connectionStore: store,
    });

    await feature.confirmRenameMongoCollection();

    expect(store.isTreeNodePinned(renamedNode)).toBe(true);
    expect(store.isTreeNodePinned(originalNode)).toBe(false);
  });

  it("keeps a successful rename successful when metadata refresh fails", async () => {
    mocks.loadVectorCollections.mockRejectedValueOnce(new Error("metadata timeout"));
    renameMongoCollectionName.value = "events_archive";
    showRenameMongoCollectionDialog.value = true;
    const node = milvusCollectionNode();
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode: shallowRef(node),
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadVectorCollections: mocks.loadVectorCollections,
        replacePinnedTreeNode: mocks.replacePinnedTreeNode,
        removeTreeNode: mocks.removeTreeNode,
        treeNodes: [],
      } as any,
    });

    await feature.confirmRenameMongoCollection();

    expect(mocks.vectorRenameCollection).toHaveBeenCalledOnce();
    expect(showRenameMongoCollectionDialog.value).toBe(false);
    expect(mocks.removeTreeNode).toHaveBeenCalledWith(node.id);
    expect(renameMongoCollectionError.value).toBe("");
  });
});
