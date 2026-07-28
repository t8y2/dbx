import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { renameMongoCollectionError, renameMongoCollectionLoading, renameMongoCollectionName, showRenameMongoCollectionDialog, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  loadMongoCollections: vi.fn().mockResolvedValue(undefined),
  mongoRenameCollection: vi.fn(),
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

vi.mock("vue-i18n", () => ({
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
    treeNodes: [],
  }),
}));

vi.mock("@/lib/backend/api", () => ({
  mongoRenameCollection: (...args: unknown[]) => mocks.mongoRenameCollection(...args),
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
