import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import {
  cloneMongoCollectionError,
  cloneMongoCollectionLoading,
  cloneMongoCollectionName,
  mongoCreateIndexError,
  mongoCreateIndexForm,
  mongoEditIndexOriginalName,
  mongoIndexManagerError,
  mongoIndexManagerLoading,
  mongoIndexManagerMode,
  mongoIndexManagerRows,
  mongoIndexManagerSelectedName,
  resetMongoCreateIndexForm,
  resetMongoIndexManager,
  sidebarDangerTarget,
  sidebarFormTarget,
  showCloneMongoCollectionDialog,
  showCreateMongoIndexDialog,
  showDropAllMongoIndexesConfirm,
  showDropMongoCollectionConfirm,
  showMongoIndexManagerDialog,
} from "@/components/sidebar/sidebarTreeDialogState";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  loadIndexes: vi.fn().mockResolvedValue(undefined),
  mongoListIndexSpecs: vi.fn().mockResolvedValue([]),
  listMongoCompletionFields: vi.fn().mockResolvedValue([{ name: "email", type: "string" }]),
  loadMongoCollections: vi.fn().mockResolvedValue(undefined),
  loadMongoDatabases: vi.fn().mockResolvedValue(undefined),
  removeTreeNode: vi.fn(),
  mongoCreateIndex: vi.fn().mockResolvedValue({ name: "email_1" }),
  mongoCloneCollection: vi.fn().mockResolvedValue({ documents_copied: 2, indexes_copied: 1 }),
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
  mongoListIndexSpecs: (...args: unknown[]) => mocks.mongoListIndexSpecs(...args),
  mongoCreateIndex: (...args: unknown[]) => mocks.mongoCreateIndex(...args),
  mongoCloneCollection: (...args: unknown[]) => mocks.mongoCloneCollection(...args),
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

function milvusConfig(database?: string) {
  return {
    id: "conn-1",
    name: "Milvus",
    db_type: "milvus" as const,
    host: "localhost",
    port: 19530,
    username: "",
    password: "",
    database,
  };
}

function milvusDatabaseNode(database: string): TreeNode {
  return {
    id: `conn-1:${database}`,
    label: database,
    type: "vector-database",
    connectionId: "conn-1",
    database,
    isExpanded: false,
    children: [],
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

/** Let the panel's fire-and-forget index load settle before asserting. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
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
    mocks.mongoListIndexSpecs.mockResolvedValue([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
      {
        name: "email_1",
        keys: [{ field: "email", direction: "1" }],
        is_unique: false,
        is_primary: false,
        is_sparse: true,
        expire_after_seconds: 3600,
        partial_filter_expression: '{"archived":false}',
        background: false,
        bucket_size: null,
        hidden: false,
        properties_complete: true,
        extra_options: null,
      },
    ]);
    mocks.listMongoCompletionFields.mockResolvedValue([{ name: "email", type: "string" }]);
    mocks.loadMongoCollections.mockResolvedValue(undefined);
    mocks.loadMongoDatabases.mockResolvedValue(undefined);
    mocks.mongoCreateIndex.mockResolvedValue({ name: "email_1" });
    mocks.mongoCloneCollection.mockResolvedValue({ documents_copied: 2, indexes_copied: 1 });
    mocks.mongoDropCollection.mockResolvedValue(undefined);
    mocks.mongoDropDatabase.mockResolvedValue(undefined);
    mocks.mongoDropIndexes.mockResolvedValue({ dropped_names: ["email_1"], affected_rows: 1 });
    sidebarDangerTarget.value = null;
    sidebarFormTarget.value = null;
    showCreateMongoIndexDialog.value = false;
    showCloneMongoCollectionDialog.value = false;
    showDropAllMongoIndexesConfirm.value = false;
    showDropMongoCollectionConfirm.value = false;
    showMongoIndexManagerDialog.value = false;
    resetMongoCreateIndexForm();
    resetMongoIndexManager();
    cloneMongoCollectionName.value = "";
    cloneMongoCollectionError.value = "";
    cloneMongoCollectionLoading.value = false;
  });

  it("protects the built-in and configured Milvus databases from deletion", () => {
    mocks.getConfig.mockReturnValue(milvusConfig("analytics"));
    const activeNode = shallowRef(milvusDatabaseNode("default"));
    const feature = useSidebarDatabaseSpecificMutationRuntime({
      activeNode,
      connectionStore: {
        getConfig: mocks.getConfig,
      } as any,
    });

    expect(feature.canDropMilvusDatabase.value).toBe(false);

    activeNode.value = milvusDatabaseNode("analytics");
    expect(feature.canDropMilvusDatabase.value).toBe(false);

    activeNode.value = milvusDatabaseNode("archive");
    expect(feature.canDropMilvusDatabase.value).toBe(true);

    mocks.getConfig.mockReturnValue(mongoConfig());
    activeNode.value = milvusDatabaseNode("archive-2");
    expect(feature.canDropMilvusDatabase.value).toBe(false);
  });

  it("keeps Legacy MongoDB mutations available while limiting index actions to the Indexes group", () => {
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
    expect(feature.canDropAllMongoIndexes.value).toBe(false);
    expect(feature.canRenameMongoCollection.value).toBe(false);
    expect(feature.canCloneMongoCollection.value).toBe(true);
    expect(feature.canCreateMongoIndex.value).toBe(false);
    activeNode.value = mongoIndexesGroupNode();
    expect(feature.canDropAllMongoIndexes.value).toBe(true);
    expect(feature.canCreateMongoIndex.value).toBe(true);
    activeNode.value = mongoIndexesGroupNode("timeseries");
    expect(feature.canDropAllMongoIndexes.value).toBe(true);
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
    expect(feature.canCloneMongoCollection.value).toBe(false);
    expect(feature.canDropAllMongoIndexes.value).toBe(false);
    activeNode.value = mongoIndexesGroupNode("view");
    expect(feature.canDropAllMongoIndexes.value).toBe(false);
    expect(feature.canCreateMongoIndex.value).toBe(false);
    activeNode.value = mongoIndexNode("email_1", "view");
    expect(feature.canDropMongoIndex.value).toBe(false);
  });

  it("does not expose Indexes group mutations for read-only MongoDB connections", () => {
    mocks.getConfig.mockReturnValue({ ...mongoConfig(), read_only: true });
    const feature = runtime(mongoIndexesGroupNode());

    expect(feature.canCreateMongoIndex.value).toBe(false);
    expect(feature.canDropAllMongoIndexes.value).toBe(false);
  });

  it("clones a regular MongoDB collection through the Legacy Agent and refreshes the sidebar", async () => {
    mocks.getConfig.mockReturnValue(mongoConfig("mongodb-legacy"));
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    expect(feature.canCloneMongoCollection.value).toBe(true);
    feature.prepareCloneMongoCollectionDialog();
    expect(cloneMongoCollectionName.value).toBe("users_copy");

    await feature.confirmCloneMongoCollection();

    expect(mocks.ensureConnected).toHaveBeenCalledWith("conn-1");
    expect(mocks.mongoCloneCollection).toHaveBeenCalledWith("conn-1", "app", "users", "users_copy");
    expect(mocks.loadMongoCollections).toHaveBeenCalledWith("conn-1", "app");
    expect(showCloneMongoCollectionDialog.value).toBe(false);
    expect(mocks.toast).toHaveBeenCalledWith('contextMenu.cloneCollectionSuccess:{"name":"users_copy","documents":2,"indexes":1}', 3000);
  });

  it("refreshes the collection list when cloning fails after a target may have been created", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;
    mocks.mongoCloneCollection.mockRejectedValue(new Error("index build failed"));

    feature.prepareCloneMongoCollectionDialog();
    await feature.confirmCloneMongoCollection();

    expect(mocks.loadMongoCollections).toHaveBeenCalledWith("conn-1", "app");
    expect(showCloneMongoCollectionDialog.value).toBe(true);
    expect(cloneMongoCollectionError.value).toContain("index build failed");
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
      expireAfterSeconds: "600",
      partialFilterExpression: '{"active":true}',
      background: true,
      bucketSize: "32",
    };
    mongoCreateIndexError.value = "previous failure";

    feature.prepareCreateMongoIndexDialog();

    expect(mongoCreateIndexForm.value).toEqual({
      name: "",
      fields: [{ id: 1, path: "", type: "1" }],
      unique: false,
      sparse: false,
      expireAfterSeconds: "",
      partialFilterExpression: "",
      background: false,
      bucketSize: "",
      hidden: false,
    });
    expect(mongoCreateIndexError.value).toBe("");
    expect(showCreateMongoIndexDialog.value).toBe(true);
  });

  it("does not expose index creation through a collection node", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareCreateMongoIndexDialog();
    expect(showCreateMongoIndexDialog.value).toBe(false);
    await feature.confirmCreateMongoIndex();

    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
  });

  it("opens the index manager panel from a collection node and lists its indexes", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    expect(feature.canManageMongoIndexes.value).toBe(true);
    feature.prepareMongoIndexManagerDialog();
    await flush();

    expect(showMongoIndexManagerDialog.value).toBe(true);
    expect(mocks.mongoListIndexSpecs).toHaveBeenCalledWith("conn-1", "app", "users");
    expect(mongoIndexManagerRows.value).toEqual([
      {
        name: "_id_",
        keys: "_id ASC",
        isUnique: true,
        isProtected: true,
        isSparse: false,
        expireAfterSeconds: undefined,
        partialFilterExpression: undefined,
        background: false,
        bucketSize: undefined,
        hidden: false,
        propertiesComplete: true,
        extraOptions: undefined,
      },
      {
        name: "email_1",
        keys: "email ASC",
        isUnique: false,
        isProtected: false,
        isSparse: true,
        expireAfterSeconds: 3600,
        partialFilterExpression: '{"archived":false}',
        background: false,
        bucketSize: undefined,
        hidden: false,
        propertiesComplete: true,
        extraOptions: undefined,
      },
    ]);
    // The first row is auto-selected so the property pane is never blank.
    expect(mongoIndexManagerSelectedName.value).toBe("_id_");
    expect(feature.canDropSelectedMongoIndexRow.value).toBe(false);
  });

  it("creates an index from the panel opened on a collection node and returns to view mode", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.startCreateMongoIndexDraft();
    expect(mongoIndexManagerMode.value).toBe("create");
    mongoCreateIndexForm.value = { ...mongoCreateIndexForm.value, fields: [{ id: 1, path: "email", type: "1" }], expireAfterSeconds: "3600" };
    await feature.confirmCreateMongoIndex();
    await flush();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledWith("conn-1", "app", "users", '{"email":1}', '{"expireAfterSeconds":3600}');
    // The panel stays open, drops back to read-only, and selects the new index.
    expect(showMongoIndexManagerDialog.value).toBe(true);
    expect(mongoIndexManagerMode.value).toBe("view");
    expect(mongoIndexManagerSelectedName.value).toBe("email_1");
  });

  it("drops the selected index from the panel while protecting the default index", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    expect(feature.canDropSelectedMongoIndexRow.value).toBe(true);
    await feature.dropSelectedMongoIndexRow();

    expect(mocks.mongoDropIndexes).toHaveBeenCalledWith("conn-1", "app", "users", '"email_1"', true);

    feature.selectMongoIndexRow("_id_");
    mocks.mongoDropIndexes.mockClear();
    await feature.dropSelectedMongoIndexRow();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
  });

  it("edits the selected index by dropping then creating and returns to view mode", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    expect(feature.canEditSelectedMongoIndexRow.value).toBe(true);

    feature.startEditMongoIndexDraft();
    expect(mongoIndexManagerMode.value).toBe("edit");
    expect(mongoEditIndexOriginalName.value).toBe("email_1");
    // The form is prefilled from the selected row.
    expect(mongoCreateIndexForm.value.name).toBe("email_1");
    expect(mongoCreateIndexForm.value.fields).toEqual([{ id: 1, path: "email", type: "1" }]);
    expect(mongoCreateIndexForm.value.sparse).toBe(true);
    expect(mongoCreateIndexForm.value.expireAfterSeconds).toBe("3600");

    // Rename: create new first, then drop old.
    mongoCreateIndexForm.value.name = "email_renamed";
    await feature.confirmEditMongoIndex();
    await flush();

    // Re-read happens before any mutation; then create(new) before drop(old).
    expect(mocks.mongoListIndexSpecs).toHaveBeenCalledWith("conn-1", "app", "users");
    expect(mocks.mongoCreateIndex).toHaveBeenCalledWith("conn-1", "app", "users", '{"email":1}', '{"name":"email_renamed","sparse":true,"expireAfterSeconds":3600,"partialFilterExpression":{"archived":false}}');
    expect(mocks.mongoDropIndexes).toHaveBeenCalledWith("conn-1", "app", "users", '"email_1"', true);
    expect(mongoIndexManagerMode.value).toBe("view");
    expect(mongoEditIndexOriginalName.value).toBe("");
    expect(mongoIndexManagerSelectedName.value).toBe("email_1");
  });

  it("does not edit the protected _id index", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("_id_");
    expect(feature.canEditSelectedMongoIndexRow.value).toBe(false);

    feature.startEditMongoIndexDraft();
    expect(mongoIndexManagerMode.value).toBe("view");
    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
  });

  it("does not edit or rename an index without a complete server specification", async () => {
    mocks.mongoListIndexSpecs.mockResolvedValueOnce([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
      {
        name: "email_1",
        keys: [{ field: "email", direction: "1" }],
        is_unique: false,
        is_primary: false,
        is_sparse: false,
        expire_after_seconds: null,
        partial_filter_expression: null,
        background: false,
        bucket_size: null,
        hidden: false,
        properties_complete: false,
        extra_options: null,
      },
    ]);
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();
    feature.selectMongoIndexRow("email_1");

    expect(feature.canEditSelectedMongoIndexRow.value).toBe(false);
    feature.startEditMongoIndexDraft();
    expect(mongoIndexManagerMode.value).toBe("view");
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
  });

  it("creates the new index first when renaming and does not drop if create fails", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.name = "email_v2";

    mocks.mongoCreateIndex.mockRejectedValueOnce(new Error("duplicate key"));
    await feature.confirmEditMongoIndex();
    await flush();

    // Create was attempted; drop was never called because create failed.
    expect(mocks.mongoCreateIndex).toHaveBeenCalled();
    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    // The error surfaces in the panel.
    expect(mongoCreateIndexError.value).toContain("duplicate key");
  });

  it("restores the complete original specification when a same-name rebuild fails", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.unique = true;

    mocks.mongoCreateIndex.mockRejectedValueOnce(new Error("index build failed")).mockResolvedValueOnce({ name: "email_1" });
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoDropIndexes).toHaveBeenCalledWith("conn-1", "app", "users", '"email_1"', true);
    expect(mocks.mongoCreateIndex).toHaveBeenNthCalledWith(1, "conn-1", "app", "users", '{"email":1}', '{"name":"email_1","unique":true,"sparse":true,"expireAfterSeconds":3600,"partialFilterExpression":{"archived":false}}');
    expect(mocks.mongoCreateIndex).toHaveBeenNthCalledWith(2, "conn-1", "app", "users", '{"email":1}', '{"name":"email_1","sparse":true,"expireAfterSeconds":3600,"partialFilterExpression":{"archived":false}}');
    expect(mongoCreateIndexError.value).toContain("email_1");
    expect(mongoCreateIndexError.value).toContain("index build failed");
    expect(mongoCreateIndexError.value).toContain("mongoEditIndexCreateFailedRolledBack");
  });

  it("reports both replacement and rollback errors when restoring a same-name index fails", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();
    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.unique = true;

    mocks.mongoCreateIndex.mockRejectedValueOnce(new Error("replacement failed")).mockRejectedValueOnce(new Error("rollback failed"));
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledTimes(2);
    expect(mongoCreateIndexError.value).toContain("replacement failed");
    expect(mongoCreateIndexError.value).toContain("rollback failed");
  });

  it("aborts the edit when the index no longer exists on the server", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();

    // Simulate the index being deleted by another session before confirm.
    mocks.mongoListIndexSpecs.mockResolvedValueOnce([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
    ]);
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(mongoCreateIndexError.value).toContain("email_1");
  });

  it("aborts the edit when the index keys changed since the dialog was opened", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();

    // Simulate the index being modified by another session (direction changed).
    mocks.mongoListIndexSpecs.mockResolvedValueOnce([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
      { name: "email_1", keys: [{ field: "email", direction: "-1" }], is_unique: false, is_primary: false, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
    ]);
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(mongoCreateIndexError.value).toContain("email_1");
  });

  it("aborts the edit when the keys match but the complete server options changed", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();
    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();

    mocks.mongoListIndexSpecs.mockResolvedValueOnce([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
      {
        name: "email_1",
        keys: [{ field: "email", direction: "1" }],
        is_unique: true,
        is_primary: false,
        is_sparse: true,
        expire_after_seconds: 3600,
        partial_filter_expression: '{"archived":false}',
        background: false,
        bucket_size: null,
        hidden: true,
        properties_complete: true,
        extra_options: '{"collation":{"locale":"fr"}}',
      },
    ]);
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(mongoCreateIndexError.value).toContain("mongoEditIndexStale");
  });

  it("does not report a rename as successful when drop returns structured failures", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();
    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.name = "email_v2";
    mocks.mongoCreateIndex.mockResolvedValueOnce({ name: "email_v2" });
    mocks.mongoDropIndexes.mockResolvedValueOnce({
      dropped_names: [],
      affected_rows: 0,
      failures: [{ name: "email_1", message: "not authorized" }],
    });

    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoCreateIndex).toHaveBeenCalledOnce();
    expect(mocks.mongoDropIndexes).toHaveBeenCalledOnce();
    expect(mongoIndexManagerMode.value).toBe("edit");
    expect(mongoCreateIndexError.value).toContain("not authorized");
    expect(mongoCreateIndexError.value).toContain("mongoEditIndexDropFailedAfterCreate");
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.stringContaining("mongoEditIndexSuccess"), 3000);
  });

  it("does not create or report rollback when a same-name drop returns structured failures", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    feature.prepareMongoIndexManagerDialog();
    await flush();
    feature.selectMongoIndexRow("email_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.unique = true;
    mocks.mongoDropIndexes.mockResolvedValueOnce({
      dropped_names: [],
      affected_rows: 0,
      failures: [{ name: "email_1", message: "index is busy" }],
    });

    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoCreateIndex).not.toHaveBeenCalled();
    expect(mongoIndexManagerMode.value).toBe("edit");
    expect(mongoCreateIndexError.value).toContain("index is busy");
    expect(mongoCreateIndexError.value).toContain("mongoEditIndexDropFailed");
    expect(mongoCreateIndexError.value).not.toContain("mongoEditIndexCreateFailedRolledBack");
  });

  it("preserves extra options (collation, wildcardProjection) through the edit", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;

    // Seed the list with an index that has extraOptions.
    mocks.mongoListIndexSpecs.mockReturnValue([
      { name: "_id_", keys: [{ field: "_id", direction: "1" }], is_unique: true, is_primary: true, is_sparse: false, expire_after_seconds: null, partial_filter_expression: null, background: false, bucket_size: null, hidden: false, properties_complete: true, extra_options: null },
      {
        name: "wild_1",
        keys: [{ field: "x", direction: "1" }],
        is_unique: false,
        is_primary: false,
        is_sparse: false,
        expire_after_seconds: null,
        partial_filter_expression: null,
        background: false,
        bucket_size: null,
        hidden: false,
        properties_complete: true,
        extra_options: '{"wildcardProjection":{"x":1}}',
      },
    ]);

    feature.prepareMongoIndexManagerDialog();
    await flush();

    feature.selectMongoIndexRow("wild_1");
    feature.startEditMongoIndexDraft();
    mongoCreateIndexForm.value.name = "wild_v2";
    await feature.confirmEditMongoIndex();
    await flush();

    expect(mocks.mongoCreateIndex).toHaveBeenCalled();
    const createArgs = mocks.mongoCreateIndex.mock.calls[0];
    const optionsJson = createArgs[4];
    expect(optionsJson).toContain("wildcardProjection");
  });

  it("surfaces an index-list failure in the panel instead of showing a stale list", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarFormTarget.value = node;
    mocks.mongoListIndexSpecs.mockRejectedValueOnce(new Error("listIndexes failed"));

    feature.prepareMongoIndexManagerDialog();
    await flush();

    expect(mongoIndexManagerRows.value).toEqual([]);
    expect(mongoIndexManagerSelectedName.value).toBe("");
    expect(mongoIndexManagerError.value).toContain("listIndexes failed");
    expect(mongoIndexManagerLoading.value).toBe(false);
  });

  it("does not open the index manager panel for read-only MongoDB connections", () => {
    mocks.getConfig.mockReturnValue({ ...mongoConfig(), read_only: true });
    const node = mongoCollectionNode();
    const feature = runtime(node);

    feature.prepareMongoIndexManagerDialog();

    expect(showMongoIndexManagerDialog.value).toBe(false);
    expect(mocks.mongoListIndexSpecs).not.toHaveBeenCalled();
  });

  it("does not clear indexes through a collection node", async () => {
    const node = mongoCollectionNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;

    await feature.confirmDropAllMongoIndexes();

    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
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
    const node = mongoIndexesGroupNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    showDropAllMongoIndexesConfirm.value = true;
    mocks.mongoDropIndexes.mockResolvedValueOnce({ dropped_names: ["email_1", "created_at_-1"], affected_rows: 2 });

    expect(feature.mongoDropAllIndexesPreview(node)).toBe('db.getSiblingDB("app").getCollection("users").dropIndexes()');
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
    const node = mongoIndexesGroupNode();
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

  it("does not clear indexes when production confirmation is cancelled", async () => {
    mocks.getConfig.mockReturnValue(mongoConfig(undefined, true));
    const node = mongoIndexesGroupNode();
    const feature = runtime(node);
    sidebarDangerTarget.value = node;
    showDropAllMongoIndexesConfirm.value = true;
    const pending = feature.confirmDropAllMongoIndexes();
    await Promise.resolve();

    const { useProductionSafetyStore } = await import("@/stores/productionSafetyStore");
    useProductionSafetyStore().cancel();
    await pending;

    expect(mocks.ensureConnected).not.toHaveBeenCalled();
    expect(mocks.mongoDropIndexes).not.toHaveBeenCalled();
    expect(showDropAllMongoIndexesConfirm.value).toBe(true);
  });
});
