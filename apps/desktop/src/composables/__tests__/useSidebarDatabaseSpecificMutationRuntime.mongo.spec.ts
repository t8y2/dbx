import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import { mongoCreateIndexError, mongoCreateIndexForm, resetMongoCreateIndexForm, sidebarDangerTarget, sidebarFormTarget, showCreateMongoIndexDialog, showDropAllMongoIndexesConfirm, showDropMongoCollectionConfirm } from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  loadIndexes: vi.fn().mockResolvedValue(undefined),
  listMongoCompletionFields: vi.fn().mockResolvedValue([{ name: "email", type: "string" }]),
  loadMongoCollections: vi.fn().mockResolvedValue(undefined),
  loadMongoDatabases: vi.fn().mockResolvedValue(undefined),
  removeTreeNode: vi.fn(),
  mongoCreateIndex: vi.fn().mockResolvedValue({ name: "email_1" }),
  mongoDropCollection: vi.fn().mockResolvedValue(undefined),
  mongoDropDatabase: vi.fn().mockResolvedValue(undefined),
  mongoDropIndexes: vi.fn().mockResolvedValue({ dropped_names: ["email_1"], affected_rows: 1 }),
  getConfig: vi.fn(),
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
  useConnectionStore: () => ({}),
}));

vi.mock("@/lib/backend/api", () => ({
  mongoCreateIndex: (...args: unknown[]) => mocks.mongoCreateIndex(...args),
  mongoDropCollection: (...args: unknown[]) => mocks.mongoDropCollection(...args),
  mongoDropDatabase: (...args: unknown[]) => mocks.mongoDropDatabase(...args),
  mongoDropIndexes: (...args: unknown[]) => mocks.mongoDropIndexes(...args),
  mongoRenameCollection: vi.fn(),
  nacosCreateNamespace: vi.fn(),
  nacosUpdateNamespace: vi.fn(),
  redisFlushDb: vi.fn(),
}));

vi.mock("@/lib/sidebar/sidebarActionTarget", () => ({
  findSidebarActionTarget: () => null,
}));

import { useSidebarDatabaseSpecificMutationRuntime } from "@/composables/useSidebarDatabaseSpecificMutationRuntime";

function mongoConfig(driverProfile?: string, production = false) {
  return {
    id: "conn-1",
    name: "Mongo",
    db_type: "mongodb" as const,
    driver_profile: driverProfile,
    host: "localhost",
    port: 27017,
    username: "op",
    password: "",
    is_production: production,
  };
}

function mongoDatabaseNode(): TreeNode {
  return {
    id: "conn-1:app",
    label: "app",
    type: "mongo-db",
    connectionId: "conn-1",
    database: "app",
    isExpanded: false,
  };
}

function mongoCollectionNode(kind: "collection" | "view" | "timeseries" = "collection"): TreeNode {
  return {
    id: "conn-1:app:users",
    label: "users",
    type: "mongo-collection",
    connectionId: "conn-1",
    database: "app",
    meta: { collectionKind: kind },
    isExpanded: false,
  };
}

function mongoIndexesGroupNode(kind: "collection" | "view" | "timeseries" = "collection"): TreeNode {
  return {
    id: "conn-1:app:users:__indexes",
    label: "tree.indexes",
    type: "group-indexes",
    connectionId: "conn-1",
    database: "app",
    tableName: "users",
    meta: { collectionKind: kind },
    isExpanded: false,
    children: [],
  };
}

function mongoIndexNode(name: string, kind: "collection" | "view" | "timeseries" = "collection", isPrimary = name === "_id_"): TreeNode {
  return {
    id: `conn-1:app:users:__indexes:${name}`,
    label: `${name} (email)`,
    type: "index",
    connectionId: "conn-1",
    database: "app",
    tableName: "users",
    meta: { name, columns: ["email"], is_primary: isPrimary, is_unique: false, collectionKind: kind },
    isExpanded: false,
  };
}

function runtime(activeNode: TreeNode) {
  const indexesGroup = activeNode.type === "group-indexes" ? activeNode : mongoIndexesGroupNode();
  return useSidebarDatabaseSpecificMutationRuntime({
    activeNode: shallowRef(activeNode),
    connectionStore: {
      getConfig: mocks.getConfig,
      ensureConnected: mocks.ensureConnected,
      loadIndexes: mocks.loadIndexes,
      listMongoCompletionFields: mocks.listMongoCompletionFields,
      loadMongoCollections: mocks.loadMongoCollections,
      loadMongoDatabases: mocks.loadMongoDatabases,
      removeTreeNode: mocks.removeTreeNode,
      treeNodes: [indexesGroup],
    } as any,
  });
}

describe("MongoDB sidebar mutation runtime", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mocks.getConfig.mockReturnValue(mongoConfig());
    mocks.ensureConnected.mockResolvedValue(undefined);
    mocks.loadIndexes.mockResolvedValue(undefined);
    mocks.listMongoCompletionFields.mockResolvedValue([{ name: "email", type: "string" }]);
    mocks.loadMongoCollections.mockResolvedValue(undefined);
    mocks.loadMongoDatabases.mockResolvedValue(undefined);
    mocks.mongoCreateIndex.mockResolvedValue({ name: "email_1" });
    mocks.mongoDropCollection.mockResolvedValue(undefined);
    mocks.mongoDropDatabase.mockResolvedValue(undefined);
    mocks.mongoDropIndexes.mockResolvedValue({ dropped_names: ["email_1"], affected_rows: 1 });
    sidebarDangerTarget.value = null;
    sidebarFormTarget.value = null;
    showCreateMongoIndexDialog.value = false;
    showDropAllMongoIndexesConfirm.value = false;
    showDropMongoCollectionConfirm.value = false;
    resetMongoCreateIndexForm();
  });

  it("allows Legacy connections to create and delete MongoDB tree objects while keeping rename native-only", () => {
    mocks.getConfig.mockReturnValue(mongoConfig("mongodb-legacy"));
    const activeNode = shallowRef(mongoDatabaseNode());
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadIndexes: mocks.loadIndexes,
        listMongoCompletionFields: mocks.listMongoCompletionFields,
        loadMongoCollections: mocks.loadMongoCollections,
        loadMongoDatabases: mocks.loadMongoDatabases,
        treeNodes: [],
      } as any,
    });

    expect(feature.canDropMongoDatabase.value).toBe(true);
    activeNode.value = mongoCollectionNode();
    expect(feature.canDropMongoCollection.value).toBe(true);
    expect(feature.canDropAllMongoIndexes.value).toBe(true);
    expect(feature.canRenameMongoCollection.value).toBe(false);
    expect(feature.canCreateMongoIndex.value).toBe(true);
    activeNode.value = mongoIndexesGroupNode();
    expect(feature.canCreateMongoIndex.value).toBe(true);
    activeNode.value = mongoIndexNode("email_1");
    expect(feature.canDropMongoIndex.value).toBe(true);
    activeNode.value = mongoIndexNode("_id_");
    expect(feature.canDropMongoIndex.value).toBe(false);
  });

  it("keeps collection deletion available for views without exposing unsupported index actions", () => {
    const activeNode = shallowRef(mongoCollectionNode("view"));
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadIndexes: mocks.loadIndexes,
        listMongoCompletionFields: mocks.listMongoCompletionFields,
        loadMongoCollections: mocks.loadMongoCollections,
        loadMongoDatabases: mocks.loadMongoDatabases,
        treeNodes: [],
      } as any,
    });

    expect(feature.canDropMongoCollection.value).toBe(true);
    expect(feature.canDropAllMongoIndexes.value).toBe(false);
    activeNode.value = mongoIndexesGroupNode("view");
    expect(feature.canCreateMongoIndex.value).toBe(false);
    activeNode.value = mongoIndexNode("email_1", "view");
    expect(feature.canDropMongoIndex.value).toBe(false);
  });

  it("creates an index from the shared sidebar dialog state", async () => {
    mocks.getConfig.mockReturnValue(mongoConfig("mongodb-legacy"));
    const node = mongoIndexesGroupNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareCreateMongoIndexDialog();
    mongoCreateIndexForm.value = {
      name: "email_created_at",
      fields: [
        { id: 1, path: "email", type: "1" },
        { id: 2, path: "createdAt", type: "-1" },
      ],
      unique: true,
      sparse: false,
    };
    await feature.confirmCreateMongoIndex();

    expect(showCreateMongoIndexDialog.value).toBe(false);
    expect(mocks.ensureConnected).toHaveBeenCalledWith("conn-1");
    expect(mocks.mongoCreateIndex).toHaveBeenCalledWith("conn-1", "app", "users", '{"email":1,"createdAt":-1}', '{"name":"email_created_at","unique":true}');
    expect(mocks.loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, "conn-1:app:users:__indexes", undefined);
    expect(mocks.toast).toHaveBeenCalledWith('contextMenu.createMongoIndexSuccess:{"name":"email_1","collection":"users"}', 3000);
  });

  it("starts every create-index dialog with safe defaults", () => {
    const feature = runtime(mongoIndexesGroupNode());
    mongoCreateIndexForm.value = {
      name: "stale_index",
      fields: [{ id: 7, path: "location", type: "2dsphere" }],
      unique: true,
      sparse: true,
    };
    mongoCreateIndexError.value = "previous failure";

    feature.prepareCreateMongoIndexDialog();

    expect(mongoCreateIndexForm.value).toEqual({
      name: "",
      fields: [{ id: 1, path: "", type: "1" }],
      unique: false,
      sparse: false,
    });
    expect(mongoCreateIndexError.value).toBe("");
    expect(showCreateMongoIndexDialog.value).toBe(true);
  });

  it("allows a collection menu to create an index before its Indexes group is expanded", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareCreateMongoIndexDialog();
    mongoCreateIndexForm.value.fields[0]!.path = "email";
    await feature.confirmCreateMongoIndex();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledWith("conn-1", "app", "users", '{"email":1}', undefined);
  });

  it("keeps the sidebar form target when the active node changes", async () => {
    const originalTarget = mongoIndexesGroupNode();
    const activeNode = shallowRef(originalTarget);
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
        ensureConnected: mocks.ensureConnected,
        loadIndexes: mocks.loadIndexes,
        listMongoCompletionFields: mocks.listMongoCompletionFields,
        loadMongoCollections: mocks.loadMongoCollections,
        loadMongoDatabases: mocks.loadMongoDatabases,
        treeNodes: [originalTarget],
      } as any,
    });

    sidebarFormTarget.value = originalTarget;
    feature.prepareCreateMongoIndexDialog();
    mongoCreateIndexForm.value.fields[0]!.path = "email";
    activeNode.value = {
      ...mongoIndexesGroupNode(),
      id: "conn-1:app:orders:__indexes",
      tableName: "orders",
    };
    await feature.confirmCreateMongoIndex();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledWith("conn-1", "app", "users", '{"email":1}', undefined);
    expect(mocks.loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, "conn-1:app:users:__indexes", undefined);
  });

  it("drops every removable index through the shared mutation and refreshes metadata", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    showDropAllMongoIndexesConfirm.value = true;
    mocks.mongoDropIndexes.mockResolvedValueOnce({ dropped_names: ["email_1", "created_at_-1"], affected_rows: 2 });

    await feature.confirmDropAllMongoIndexes();

    expect(mocks.mongoDropIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, false);
    expect(mocks.loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, "conn-1:app:users:__indexes", undefined);
    expect(showDropAllMongoIndexesConfirm.value).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith('contextMenu.dropAllIndexesSuccess:{"count":2,"name":"users"}', 3000);
  });

  it("refreshes index metadata after a failed delete request", async () => {
    const node = mongoIndexNode("email_1");
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    mocks.mongoDropIndexes.mockRejectedValueOnce(new Error("connection lost"));

    await feature.confirmDropMongoIndex();

    expect(mocks.loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, "conn-1:app:users:__indexes", undefined);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("contextMenu.tableOperationFailed"), 5000);
  });

  it("reports partial index deletion after forcing a metadata refresh", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    mocks.mongoDropIndexes.mockResolvedValueOnce({
      dropped_names: ["email_1"],
      affected_rows: 1,
      failures: [{ name: "missing_1", message: "index not found" }],
    });

    await feature.confirmDropAllMongoIndexes();

    expect(mocks.loadIndexes).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith('contextMenu.dropIndexesPartialFailure:{"success":1,"failed":1}', 5000);
  });

  it("executes Legacy delete operations and refreshes their MongoDB metadata", async () => {
    mocks.getConfig.mockReturnValue(mongoConfig("mongodb-legacy"));

    const databaseNode = mongoDatabaseNode();
    const databaseFeature = runtime(databaseNode);
    sidebarDangerTarget.value = databaseNode;
    await databaseFeature.confirmDropMongoDatabase();

    expect(mocks.mongoDropDatabase).toHaveBeenCalledWith("conn-1", "app");
    expect(mocks.loadMongoDatabases).toHaveBeenCalledWith("conn-1");

    const collectionNode = mongoCollectionNode();
    const collectionFeature = runtime(collectionNode);
    sidebarDangerTarget.value = collectionNode;
    await collectionFeature.confirmDropMongoCollection();

    expect(mocks.mongoDropCollection).toHaveBeenCalledWith("conn-1", "app", "users");
    expect(mocks.loadMongoDatabases).toHaveBeenCalledWith("conn-1");
    expect(mocks.loadMongoCollections).toHaveBeenCalledWith("conn-1", "app");

    const indexNode = mongoIndexNode("email_1");
    const indexFeature = runtime(indexNode);
    sidebarDangerTarget.value = indexNode;
    await indexFeature.confirmDropMongoIndex();

    expect(mocks.mongoDropIndexes).toHaveBeenCalledWith("conn-1", "app", "users", '"email_1"', true);
    expect(mocks.loadIndexes).toHaveBeenCalledWith("conn-1", "app", "users", undefined, "conn-1:app:users:__indexes", undefined);
  });

  it("keeps a completed collection drop successful when metadata refresh fails", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    showDropMongoCollectionConfirm.value = true;
    mocks.loadMongoDatabases.mockRejectedValueOnce(new Error("metadata unavailable"));

    await feature.confirmDropMongoCollection();

    expect(mocks.mongoDropCollection).toHaveBeenCalledWith("conn-1", "app", "users");
    expect(showDropMongoCollectionConfirm.value).toBe(false);
    expect(mocks.removeTreeNode).toHaveBeenCalledWith(node.id);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("contextMenu.dropCollectionSuccess"), 3000);
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("contextMenu.objectDropRefreshFailed"), 5000);
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("contextMenu.tableOperationFailed"), 5000);
  });

  it("does not send a default _id_ index deletion request", async () => {
    const node = mongoIndexNode("_id_");
    const feature = runtime(node);
    sidebarDangerTarget.value = node;

    await feature.confirmDropMongoIndex();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
  });

  it("also hides indexes marked primary when metadata has an unexpected name", () => {
    const feature = runtime(mongoIndexNode("unexpected_primary_name", "collection", true));

    expect(feature.canDropMongoIndex.value).toBe(false);
  });

  it("reports an index-list refresh problem without misreporting a completed create as failed", async () => {
    const node = mongoIndexesGroupNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;
    mocks.loadIndexes.mockRejectedValue(new Error("metadata unavailable"));

    feature.prepareCreateMongoIndexDialog();
    mongoCreateIndexForm.value.fields[0]!.path = "email";
    await feature.confirmCreateMongoIndex();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("contextMenu.mongoIndexRefreshFailed"), 5000);
  });

  it("does not issue a create request when production confirmation is cancelled", async () => {
    mocks.getConfig.mockReturnValue(mongoConfig(undefined, true));
    const node = mongoIndexesGroupNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;
    feature.prepareCreateMongoIndexDialog();
    mongoCreateIndexForm.value.fields[0]!.path = "email";
    const pending = feature.confirmCreateMongoIndex();
    await Promise.resolve();

    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    useProductionSafetyStore().cancel();
    await pending;

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(showCreateMongoIndexDialog.value).toBe(true);
  });
});
