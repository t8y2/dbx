import { computed, watch, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { notifyNacosNamespacesChanged } from "@/lib/nacos/nacosNamespaceCache";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import {
  MONGO_INDEX_KEY_TYPES,
  buildMongoCreateIndexRequest,
  isCloneableMongoCollection,
  isProtectedMongoIndex,
  isRenamableMongoCollection,
  mergeExtraOptionsIntoRequest,
  mongoCollectionKindFromNode,
  mongoCloneCollectionPreview,
  mongoCreateIndexRequestFromSpec,
  mongoCreateIndexFormFromRow,
  mongoCreateIndexPreview,
  mongoDropAllIndexesPreview,
  mongoDropCollectionPreview,
  mongoDropIndexFailureCount,
  mongoDropDatabasePreview,
  mongoDropIndexPreview,
  mongoRenameCollectionPreview,
  mongoReplaceIndexPreview,
  preflightEditIndexSpec,
  snapshotMongoIndexSpec,
  toMongoIndexRow,
  type MongoCreateIndexRequest,
  type MongoIndexSpecSnapshot,
} from "@/lib/sidebar/mongoCollectionMutation";
import { elasticsearchClearIndexPreview, isElasticsearchProtocolIndex, isPartialElasticsearchClear, notifyElasticsearchIndexCleared } from "@/lib/sidebar/elasticsearchIndexActions";
import { supportsMongoAllDriverMutations, supportsMongoIndexMutations, supportsNativeMongoDriverMutations } from "@/lib/mongo/mongoCapabilities";
import { runMongoSidebarMutation } from "@/lib/sidebar/runMongoSidebarMutation";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { uuid } from "@/lib/common/utils";
import { refreshLoadedMongoIndexes } from "@/lib/mongo/mongoIndexMetadata";
import type { NacosAdminConfig } from "@/types/nacos";
import {
  sidebarDangerTarget,
  sidebarFormTarget,
  showCreateNacosNamespaceDialog,
  createNacosNamespaceId,
  createNacosNamespaceName,
  createNacosNamespaceDesc,
  createNacosNamespaceLoading,
  showEditNacosNamespaceDialog,
  editNacosNamespaceName,
  editNacosNamespaceDesc,
  editNacosNamespaceLoading,
  showDeleteNacosNamespaceConfirm,
  deleteNacosNamespaceLoading,
  showDropMongoCollectionConfirm,
  dropMongoCollectionLoading,
  showDropMongoIndexConfirm,
  dropMongoIndexLoading,
  showDropAllMongoIndexesConfirm,
  dropAllMongoIndexesLoading,
  showDropDatabaseConfirm,
  dropDatabaseLoading,
  showClearElasticsearchIndexConfirm,
  clearElasticsearchIndexLoading,
  showFlushRedisDbConfirm,
  showRedisDatabaseAliasDialog,
  redisDatabaseAliasInput,
  redisDatabaseAliasSaving,
  showRenameMongoCollectionDialog,
  renameMongoCollectionName,
  renameMongoCollectionError,
  renameMongoCollectionPreview,
  renameMongoCollectionLoading,
  showCloneMongoCollectionDialog,
  cloneMongoCollectionName,
  cloneMongoCollectionError,
  cloneMongoCollectionLoading,
  showCreateMongoIndexDialog,
  mongoCreateIndexForm,
  mongoCreateIndexFieldOptions,
  mongoCreateIndexError,
  mongoCreateIndexLoading,
  resetMongoCreateIndexForm,
  showMongoIndexManagerDialog,
  mongoIndexManagerRows,
  mongoIndexManagerLoading,
  mongoIndexManagerError,
  mongoIndexManagerSelectedName,
  mongoIndexManagerMode,
  mongoEditIndexOriginalName,
  resetMongoIndexManager,
} from "@/components/sidebar/sidebarTreeDialogState";

interface SidebarDatabaseSpecificMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  connectionStore: ReturnType<typeof useConnectionStore>;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message || error);
  }
  return String(error);
}

export function useSidebarDatabaseSpecificMutationRuntime(options: SidebarDatabaseSpecificMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, connectionStore } = options;
  let mongoIndexSpecsByName = new Map<string, MongoIndexSpecSnapshot>();
  let mongoEditIndexOriginalSpec: MongoIndexSpecSnapshot | undefined;

  function usesAnyMongoDriver(node: Pick<TreeNode, "connectionId">): boolean {
    return !!node.connectionId && supportsMongoAllDriverMutations(connectionStore.getConfig(node.connectionId));
  }

  function usesNativeMongoDriver(node: Pick<TreeNode, "connectionId">): boolean {
    return !!node.connectionId && supportsNativeMongoDriverMutations(connectionStore.getConfig(node.connectionId));
  }

  function canMutateMongoIndexes(node: TreeNode): boolean {
    return !!node.connectionId && supportsMongoIndexMutations(connectionStore.getConfig(node.connectionId), mongoCollectionKindFromNode(node));
  }

  const canDropMongoDatabase = computed(() => activeNode.value.type === "mongo-db" && !!activeNode.value.database && usesAnyMongoDriver(activeNode.value));
  function canDropMilvusDatabaseNode(node: TreeNode): boolean {
    const connectionId = node.connectionId;
    const database = node.database;
    if (node.type !== "vector-database" || !connectionId || !database || database === "default") return false;
    const config = connectionStore.getConfig(connectionId);
    return config?.db_type === "milvus" && config.database !== database;
  }

  const canDropMilvusDatabase = computed(() => canDropMilvusDatabaseNode(activeNode.value));

  function canMutateMongoCollectionNode(node: TreeNode): boolean {
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database) return false;
    return usesAnyMongoDriver(node);
  }

  function canMutateMilvusCollectionNode(node: TreeNode): boolean {
    return node.type === "vector-collection" && !!node.connectionId && !!node.database && connectionStore.getConfig(node.connectionId)?.db_type === "milvus";
  }

  function canRenameMongoCollectionNode(node: TreeNode): boolean {
    return canMutateMilvusCollectionNode(node) || (canMutateMongoCollectionNode(node) && usesNativeMongoDriver(node) && isRenamableMongoCollection(node.label, mongoCollectionKindFromNode(node)));
  }

  function canCloneMongoCollectionNode(node: TreeNode): boolean {
    return canMutateMongoCollectionNode(node) && isCloneableMongoCollection(node.label, mongoCollectionKindFromNode(node));
  }

  function canMutateElasticsearchIndexNode(node: TreeNode): boolean {
    if (!node.connectionId) return false;
    return isElasticsearchProtocolIndex(node.type, connectionStore.getConfig(node.connectionId)?.db_type);
  }

  const canManageElasticsearchIndex = computed(() => canMutateElasticsearchIndexNode(activeNode.value));

  const canDropMongoCollection = computed(() => canMutateMongoCollectionNode(activeNode.value));
  const canDropMilvusCollection = computed(() => activeNode.value.type === "vector-collection" && !!activeNode.value.connectionId && !!activeNode.value.database && connectionStore.getConfig(activeNode.value.connectionId)?.db_type === "milvus");
  const canRenameMongoCollection = computed(() => canRenameMongoCollectionNode(activeNode.value));
  const canCloneMongoCollection = computed(() => canCloneMongoCollectionNode(activeNode.value));

  function toastMutationError(error: unknown) {
    toast(t("contextMenu.tableOperationFailed", { message: errorMessage(error) }), 5000);
  }

  function prepareRenameMongoCollectionDialog() {
    renameMongoCollectionName.value = activeNode.value.label;
    renameMongoCollectionError.value = "";
    renameMongoCollectionPreview.value = "";
    renameMongoCollectionLoading.value = false;
    showRenameMongoCollectionDialog.value = true;
  }

  function refreshRenameMongoCollectionPreview() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    // Preserve identifier whitespace exactly as entered; only reject empty names.
    const newName = renameMongoCollectionName.value;
    if (!showRenameMongoCollectionDialog.value || !canRenameMongoCollectionNode(node) || !node.database || !newName || newName === node.label) {
      renameMongoCollectionPreview.value = "";
      return;
    }
    renameMongoCollectionPreview.value = canMutateMilvusCollectionNode(node) ? `POST /v2/vectordb/collections/rename\n${JSON.stringify({ dbName: node.database, collectionName: node.label, newCollectionName: newName })}` : mongoRenameCollectionPreview(node.database, node.label, newName);
  }

  watch([showRenameMongoCollectionDialog, renameMongoCollectionName, () => activeNode.value.label, () => activeNode.value.database], () => {
    refreshRenameMongoCollectionPreview();
  });

  async function confirmRenameMongoCollection() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const newName = renameMongoCollectionName.value;
    if (!canRenameMongoCollectionNode(node) || !connectionId || !database || !newName || newName === node.label) {
      return;
    }
    const oldName = node.label;
    renameMongoCollectionError.value = "";
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: canMutateMilvusCollectionNode(node) ? `POST /v2/vectordb/collections/rename\n${JSON.stringify({ dbName: database, collectionName: oldName, newCollectionName: newName })}` : mongoRenameCollectionPreview(database, oldName, newName),
      source: t("production.sourceSidebar"),
      loading: renameMongoCollectionLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        if (canMutateMilvusCollectionNode(node)) {
          await api.vectorRenameCollection(connectionId, database, oldName, newName);
        } else {
          await api.mongoRenameCollection(connectionId, database, oldName, newName);
        }
      },
      onSuccess: async () => {
        toast(t("contextMenu.renameObjectSuccess", { oldName, newName }), 3000);
        showRenameMongoCollectionDialog.value = false;
        try {
          if (canMutateMilvusCollectionNode(node)) {
            await connectionStore.loadVectorCollections(connectionId, database);
            connectionStore.replacePinnedTreeNode(node, {
              ...node,
              id: `${connectionId}:__vector_collection:${database}:${newName}`,
              label: newName,
              objectName: newName,
              tableName: newName,
            });
          } else {
            await connectionStore.loadMongoCollections(connectionId, database);
          }
        } catch (error) {
          connectionStore.removeTreeNode(node.id);
          toast(t("contextMenu.objectDropRefreshFailed", { message: translateBackendError(t, errorMessage(error)) }), 5000);
        }
      },
      onError: (error) => {
        renameMongoCollectionError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  function prepareCloneMongoCollectionDialog() {
    cloneMongoCollectionName.value = `${activeNode.value.label}_copy`;
    cloneMongoCollectionError.value = "";
    cloneMongoCollectionLoading.value = false;
    showCloneMongoCollectionDialog.value = true;
  }

  async function confirmCloneMongoCollection() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const targetName = cloneMongoCollectionName.value;
    if (!canCloneMongoCollectionNode(node) || !connectionId || !database || !targetName || targetName === node.label) return;

    const sourceName = node.label;
    cloneMongoCollectionError.value = "";
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoCloneCollectionPreview(database, sourceName, targetName),
      source: t("production.sourceSidebar"),
      loading: cloneMongoCollectionLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        try {
          return await api.mongoCloneCollection(connectionId, database, sourceName, targetName);
        } finally {
          // A failed write can still leave a target collection with partial data;
          // refresh so it is visible and can be inspected or removed explicitly.
          await connectionStore.loadMongoCollections(connectionId, database);
        }
      },
      onSuccess: (result) => {
        toast(
          t("contextMenu.cloneCollectionSuccess", {
            name: targetName,
            documents: result.documents_copied,
            indexes: result.indexes_copied,
          }),
          3000,
        );
        showCloneMongoCollectionDialog.value = false;
      },
      onError: (error) => {
        cloneMongoCollectionError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  function mongoIndexNameForNode(node: TreeNode): string {
    if (node.type !== "index") return "";
    return node.meta && "name" in node.meta ? node.meta.name : node.label.replace(/\s+\(.+\)$/, "");
  }

  function canDropMongoIndexNode(node: TreeNode): boolean {
    if (node.type !== "index" || !node.connectionId || !node.database || !node.tableName) return false;
    const isPrimary = !!(node.meta && "is_primary" in node.meta && node.meta.is_primary);
    return canMutateMongoIndexes(node) && !isProtectedMongoIndex({ name: mongoIndexNameForNode(node), is_primary: isPrimary });
  }

  const canDropMongoIndex = computed(() => canDropMongoIndexNode(activeNode.value));

  function mongoIndexCollectionName(node: TreeNode): string {
    return node.type === "group-indexes" ? node.tableName || "" : "";
  }

  /**
   * The manager panel is also reachable from the collection node, while direct
   * create / drop-all actions stay scoped to the Indexes group.
   */
  function mongoIndexPanelCollectionName(node: TreeNode): string {
    if (node.type === "mongo-collection") return node.label;
    return mongoIndexCollectionName(node);
  }

  function canManageMongoIndexPanelNode(node: TreeNode): boolean {
    return !!mongoIndexPanelCollectionName(node) && !!node.database && canMutateMongoIndexes(node);
  }

  function canManageMongoIndexesNode(node: TreeNode): boolean {
    return !!mongoIndexCollectionName(node) && !!node.database && canMutateMongoIndexes(node);
  }

  const canDropAllMongoIndexes = computed(() => canManageMongoIndexesNode(activeNode.value));
  const canManageMongoIndexes = computed(() => canManageMongoIndexPanelNode(activeNode.value));

  function mongoIndexDropPreview(node: Pick<TreeNode, "database" | "tableName">, indexName: string): string {
    return mongoDropIndexPreview(node.database || "", node.tableName || "", indexName);
  }

  function mongoDropAllIndexesPreviewForNode(node: TreeNode): string {
    return mongoDropAllIndexesPreview(node.database || "", mongoIndexCollectionName(node));
  }

  function canCreateMongoIndexNode(node: TreeNode): boolean {
    return canManageMongoIndexesNode(node);
  }

  const canCreateMongoIndex = computed(() => canCreateMongoIndexNode(activeNode.value));
  /** Mirror the full request validation so the button never invites a known error. */
  const mongoCreateIndexCanSubmit = computed(() => buildMongoCreateIndexRequest(mongoCreateIndexForm.value).valid);
  const mongoCreateIndexCanAddField = computed(() => mongoCreateIndexForm.value.fields.every((field) => !!field.path.trim()));

  watch(
    mongoCreateIndexForm,
    () => {
      mongoCreateIndexError.value = "";
    },
    { deep: true },
  );

  function prepareCreateMongoIndexDialog() {
    const node = activeNode.value;
    if (!canCreateMongoIndexNode(node) || !node.connectionId || !node.database) return;
    resetMongoCreateIndexForm();
    showCreateMongoIndexDialog.value = true;
    void connectionStore
      .listMongoCompletionFields(node.connectionId, node.database, mongoIndexCollectionName(node))
      .then((fields) => {
        const target = sidebarFormTarget.value ?? activeNode.value;
        if (showCreateMongoIndexDialog.value && target.id === node.id) mongoCreateIndexFieldOptions.value = fields.map((field) => field.name);
      })
      .catch(() => {
        // MongoDB is schemaless; users can still enter a field that was not sampled.
      });
  }

  async function loadMongoIndexManagerRows() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const collection = mongoIndexPanelCollectionName(node);
    if (!connectionId || !database || !collection) return;

    mongoIndexManagerLoading.value = true;
    mongoIndexManagerError.value = "";
    try {
      await connectionStore.ensureConnected(connectionId);
      // MongoDB-specific read: the shared IndexInfo shape cannot carry sparse,
      // TTL, background or bucketSize. The backend degrades to the generic
      // listing for Legacy Agent connections and flags it there.
      const specs = await api.mongoListIndexSpecs(connectionId, database, collection);
      mongoIndexSpecsByName = new Map(specs.map((spec) => [spec.name, snapshotMongoIndexSpec(spec)] as const));
      mongoIndexManagerRows.value = specs.map(toMongoIndexRow);
      const selected = mongoIndexManagerSelectedName.value;
      if (!selected || !mongoIndexManagerRows.value.some((row) => row.name === selected)) {
        mongoIndexManagerSelectedName.value = mongoIndexManagerRows.value[0]?.name ?? "";
      }
    } catch (error) {
      mongoIndexSpecsByName.clear();
      mongoIndexManagerRows.value = [];
      mongoIndexManagerSelectedName.value = "";
      mongoIndexManagerError.value = translateBackendError(t, errorMessage(error));
    } finally {
      mongoIndexManagerLoading.value = false;
    }
  }

  function prepareMongoIndexManagerDialog() {
    const node = activeNode.value;
    if (!canManageMongoIndexPanelNode(node) || !node.connectionId || !node.database) return;
    resetMongoIndexManager();
    resetMongoCreateIndexForm();
    mongoIndexSpecsByName.clear();
    mongoEditIndexOriginalSpec = undefined;
    showMongoIndexManagerDialog.value = true;
    void loadMongoIndexManagerRows();
  }

  const mongoIndexManagerSelected = computed(() => mongoIndexManagerRows.value.find((row) => row.name === mongoIndexManagerSelectedName.value));

  /** Resolve against the dialog's own target so the header survives tree selection changes. */
  const mongoIndexManagerCollectionName = computed(() => mongoIndexPanelCollectionName(sidebarFormTarget.value ?? activeNode.value));

  function selectMongoIndexRow(name: string) {
    if (mongoIndexManagerMode.value === "create" || mongoIndexManagerMode.value === "edit") return;
    mongoIndexManagerSelectedName.value = name;
  }

  /** Switch the property pane into an editable draft for a brand new index. */
  function startCreateMongoIndexDraft() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    resetMongoCreateIndexForm();
    mongoIndexManagerMode.value = "create";
    mongoIndexManagerError.value = "";
    if (!node.connectionId || !node.database) return;
    const collection = mongoIndexPanelCollectionName(node);
    if (!collection) return;
    void connectionStore
      .listMongoCompletionFields(node.connectionId, node.database, collection)
      .then((fields) => {
        if (showMongoIndexManagerDialog.value) mongoCreateIndexFieldOptions.value = fields.map((field) => field.name);
      })
      .catch(() => {
        // MongoDB is schemaless; a field that was never sampled is still valid.
      });
  }

  function cancelMongoIndexDraft() {
    mongoIndexManagerMode.value = "view";
    mongoEditIndexOriginalName.value = "";
    mongoEditIndexOriginalSpec = undefined;
    resetMongoCreateIndexForm();
  }

  /** The default _id index is never droppable, so the panel must not offer it. */
  const canDropSelectedMongoIndexRow = computed(() => {
    if (mongoIndexManagerMode.value === "create" || mongoIndexManagerMode.value === "edit") return false;
    const row = mongoIndexManagerSelected.value;
    return !!row && !row.isProtected;
  });

  /** Editing requires a complete server specification so no unmodeled options are lost. */
  const canEditSelectedMongoIndexRow = computed(() => {
    if (mongoIndexManagerMode.value === "create" || mongoIndexManagerMode.value === "edit") return false;
    const row = mongoIndexManagerSelected.value;
    return !!row && !row.isProtected && row.propertiesComplete;
  });

  /** Prefill the create form from the selected index row and enter edit mode. */
  function startEditMongoIndexDraft() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const row = mongoIndexManagerSelected.value;
    if (!canEditSelectedMongoIndexRow.value || !row || !node.connectionId || !node.database) return;
    const originalSpec = mongoIndexSpecsByName.get(row.name);
    if (!originalSpec) return;
    mongoCreateIndexForm.value = mongoCreateIndexFormFromRow(row);
    mongoEditIndexOriginalName.value = row.name;
    mongoEditIndexOriginalSpec = originalSpec;
    mongoIndexManagerMode.value = "edit";
    mongoIndexManagerError.value = "";
    const collection = mongoIndexPanelCollectionName(node);
    if (!collection) return;
    void connectionStore
      .listMongoCompletionFields(node.connectionId, node.database, collection)
      .then((fields) => {
        if (showMongoIndexManagerDialog.value) mongoCreateIndexFieldOptions.value = fields.map((field) => field.name);
      })
      .catch(() => {
        // MongoDB is schemaless; a field that was never sampled is still valid.
      });
  }

  async function dropSelectedMongoIndexRow() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const collection = mongoIndexPanelCollectionName(node);
    const row = mongoIndexManagerSelected.value;
    if (!canDropSelectedMongoIndexRow.value || !row || !connectionId || !database || !collection) return;

    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropIndexPreview(database, collection, row.name),
      source: t("production.sourceSidebar"),
      loading: mongoIndexManagerLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.mongoDropIndexes(connectionId, database, collection, JSON.stringify(row.name), true),
      onSuccess: async (result) => {
        const failed = mongoDropIndexFailureCount(result);
        if (failed > 0) {
          toast(t("contextMenu.dropIndexesPartialFailure", { success: result.dropped_names.length, failed }), 5000);
        } else {
          toast(t("contextMenu.dropTableChildObjectSuccess", { name: row.name }), 3000);
        }
        mongoIndexManagerSelectedName.value = "";
        await refreshMongoIndexTreeAfterMutation({ ...node, tableName: collection });
        await loadMongoIndexManagerRows();
      },
      onError: (error) => {
        mongoIndexManagerError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  function addMongoCreateIndexField() {
    if (!mongoCreateIndexCanAddField.value) return;
    const nextId = Math.max(0, ...mongoCreateIndexForm.value.fields.map((field) => field.id)) + 1;
    mongoCreateIndexForm.value.fields.push({ id: nextId, path: "", type: "1" });
  }

  function removeMongoCreateIndexField(id: number) {
    if (mongoCreateIndexForm.value.fields.length === 1) return;
    mongoCreateIndexForm.value.fields = mongoCreateIndexForm.value.fields.filter((field) => field.id !== id);
  }

  function mongoCreateIndexRequestErrorText(request: Extract<MongoCreateIndexRequest, { valid: false }>): string {
    switch (request.error) {
      case "field-duplicate":
        return t("mongo.duplicateField", { field: request.field });
      case "ttl-invalid":
        return t("contextMenu.createMongoIndexTtlInvalid");
      case "filter-invalid":
        return t("contextMenu.createMongoIndexFilterInvalid");
      case "bucket-size-invalid":
        return t("contextMenu.createMongoIndexBucketSizeInvalid");
      default:
        return t("contextMenu.createMongoIndexFieldRequired");
    }
  }

  async function confirmCreateMongoIndex() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    // When called from the manager panel the node may be a collection node;
    // when called from the standalone create dialog it is always a group-indexes node.
    const collectionName = showMongoIndexManagerDialog.value ? mongoIndexPanelCollectionName(node) : mongoIndexCollectionName(node);
    const canProceed = showMongoIndexManagerDialog.value ? canManageMongoIndexPanelNode(node) : canCreateMongoIndexNode(node);
    if (!canProceed || !connectionId || !database || !collectionName) return;

    const request = buildMongoCreateIndexRequest(mongoCreateIndexForm.value);
    if (!request.valid) {
      mongoCreateIndexError.value = mongoCreateIndexRequestErrorText(request);
      return;
    }

    mongoCreateIndexError.value = "";
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoCreateIndexPreview(database, collectionName, request.keysJson, request.optionsJson),
      source: t("production.sourceSidebar"),
      loading: mongoCreateIndexLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.mongoCreateIndex(connectionId, database, collectionName, request.keysJson, request.optionsJson),
      onSuccess: async (created) => {
        showCreateMongoIndexDialog.value = false;
        toast(t("contextMenu.createMongoIndexSuccess", { name: created.name, collection: collectionName }), 3000);
        // In the manager panel the dialog stays open: return the property pane to
        // read-only and reload the list so the new index shows up selected.
        if (showMongoIndexManagerDialog.value) {
          mongoIndexManagerMode.value = "view";
          mongoIndexManagerSelectedName.value = created.name;
          resetMongoCreateIndexForm();
          await loadMongoIndexManagerRows();
        }
        await refreshMongoIndexTreeAfterMutation({ ...node, tableName: collectionName });
      },
      onError: (error) => {
        mongoCreateIndexError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  /**
   * Edit an existing index by drop + recreate. The form was prefilled by
   * {@link startEditMongoIndexDraft}; this runs the two backend calls in
   * sequence inside the production-gated mutation shell.
   *
   * Safety strategy:
   * 1. Merge `extraOptions` (collation, wildcardProjection, weights, …) back
   *    into the create request so no server-reported option is silently lost.
   * 2. Re-read the current index spec from the server before any destructive
   *    operation and compare it with the complete immutable opening snapshot.
   * 3. When the user renamed the index, create the new one first, then drop
   *    the old one — if create fails the original index is untouched.
   * 4. When the name is unchanged (same-name rebuild), preserve a complete
   *    rollback request and recreate the original index if the new build fails.
   */
  async function confirmEditMongoIndex() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const collectionName = showMongoIndexManagerDialog.value ? mongoIndexPanelCollectionName(node) : mongoIndexCollectionName(node);
    const originalName = mongoEditIndexOriginalName.value;
    const originalSpec = mongoEditIndexOriginalSpec;
    if (!connectionId || !database || !collectionName || !originalName || !originalSpec || mongoIndexManagerMode.value !== "edit") return;

    const request = buildMongoCreateIndexRequest(mongoCreateIndexForm.value);
    if (!request.valid) {
      mongoCreateIndexError.value = mongoCreateIndexRequestErrorText(request);
      return;
    }

    // Preserve server-reported options the form does not model (collation,
    // wildcardProjection, weights, text defaults, geo options, …).
    const merged = mergeExtraOptionsIntoRequest(request, originalSpec.extraOptions);

    const newName = mongoCreateIndexForm.value.name.trim();
    const isRename = newName && newName !== originalName;
    if (!isRename && !originalSpec.propertiesComplete) {
      mongoCreateIndexError.value = t("contextMenu.mongoEditIndexIncompleteSameName", { name: originalName });
      return;
    }

    mongoCreateIndexError.value = "";
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      // Review text shows both commands so production confirmation is explicit.
      reviewText: mongoReplaceIndexPreview(database, collectionName, originalName, merged.keysJson, merged.optionsJson),
      source: t("production.sourceSidebar"),
      loading: mongoCreateIndexLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        // Re-read the current spec from the server to guard against concurrent
        // modifications between when the dialog was opened and when the user
        // confirmed the edit.
        const specs = await api.mongoListIndexSpecs(connectionId, database, collectionName);
        const preflight = preflightEditIndexSpec(specs, originalSpec);
        if (!preflight.safe) {
          throw new Error(preflight.reason === "not-found" ? t("contextMenu.mongoEditIndexNotFound", { name: originalName }) : t("contextMenu.mongoEditIndexStale", { name: originalName }));
        }

        if (isRename) {
          // Safe rename: create the new index first. If create fails, the
          // original index is untouched and the error surfaces cleanly.
          const created = await api.mongoCreateIndex(connectionId, database, collectionName, merged.keysJson, merged.optionsJson);
          const dropResult = await api.mongoDropIndexes(connectionId, database, collectionName, JSON.stringify(originalName), true);
          if (mongoDropIndexFailureCount(dropResult) > 0) {
            const error = dropResult.failures?.map((failure) => `${failure.name}: ${failure.message}`).join("; ") || originalName;
            throw new Error(t("contextMenu.mongoEditIndexDropFailedAfterCreate", { oldName: originalName, newName: created.name, error }));
          }
          return created;
        }

        const rollbackRequest = mongoCreateIndexRequestFromSpec(originalSpec);
        const dropResult = await api.mongoDropIndexes(connectionId, database, collectionName, JSON.stringify(originalName), true);
        if (mongoDropIndexFailureCount(dropResult) > 0) {
          const error = dropResult.failures?.map((failure) => `${failure.name}: ${failure.message}`).join("; ") || originalName;
          throw new Error(t("contextMenu.mongoEditIndexDropFailed", { name: originalName, error }));
        }
        try {
          return await api.mongoCreateIndex(connectionId, database, collectionName, merged.keysJson, merged.optionsJson);
        } catch (createError) {
          const createErrorMessage = errorMessage(createError);
          try {
            await api.mongoCreateIndex(connectionId, database, collectionName, rollbackRequest.keysJson, rollbackRequest.optionsJson);
          } catch (rollbackError) {
            throw new Error(
              t("contextMenu.mongoEditIndexCreateAndRollbackFailed", {
                name: originalName,
                createError: createErrorMessage,
                rollbackError: errorMessage(rollbackError),
              }),
            );
          }
          throw new Error(t("contextMenu.mongoEditIndexCreateFailedRolledBack", { name: originalName, error: createErrorMessage }));
        }
      },
      onSuccess: async (created) => {
        toast(t("contextMenu.mongoEditIndexSuccess", { oldName: originalName, newName: created.name, collection: collectionName }), 3000);
        mongoIndexManagerMode.value = "view";
        mongoEditIndexOriginalName.value = "";
        mongoEditIndexOriginalSpec = undefined;
        mongoIndexManagerSelectedName.value = created.name;
        resetMongoCreateIndexForm();
        await loadMongoIndexManagerRows();
        await refreshMongoIndexTreeAfterMutation({ ...node, tableName: collectionName });
      },
      onError: (error) => {
        mongoCreateIndexError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  function openCreateNacosNamespaceDialog() {
    createNacosNamespaceId.value = "";
    createNacosNamespaceName.value = "";
    createNacosNamespaceDesc.value = "";
    showCreateNacosNamespaceDialog.value = true;
  }

  interface ExplicitNacosNamespaceScopeSnapshot {
    visibleDatabases?: string[];
    managedNamespaces?: string[];
  }

  function snapshotExplicitNacosNamespaceScope(connectionId: string): ExplicitNacosNamespaceScopeSnapshot {
    const config = connectionStore.getConfig(connectionId);
    if (!config || config.db_type !== "nacos") return {};
    const externalConfig = (config.external_config || {}) as NacosAdminConfig;
    return {
      visibleDatabases: Array.isArray(config.visible_databases) ? [...config.visible_databases] : undefined,
      managedNamespaces: Array.isArray(externalConfig.managedNamespaces) && externalConfig.managedNamespaces.length > 0 ? [...externalConfig.managedNamespaces] : undefined,
    };
  }

  async function restoreExplicitNacosNamespaceScope(connectionId: string, snapshot: ExplicitNacosNamespaceScopeSnapshot): Promise<void> {
    if (!snapshot.visibleDatabases && !snapshot.managedNamespaces) return;
    const config = connectionStore.getConfig(connectionId);
    if (!config || config.db_type !== "nacos") return;
    const externalConfig = (config.external_config || {}) as NacosAdminConfig;
    await connectionStore.updateConnection({
      ...config,
      visible_databases: snapshot.visibleDatabases ? [...snapshot.visibleDatabases] : config.visible_databases,
      external_config: snapshot.managedNamespaces ? { ...externalConfig, managedNamespaces: [...snapshot.managedNamespaces] } : externalConfig,
    });
  }

  async function updateExplicitNacosNamespaceScope(connectionId: string, namespaceId: string, action: "add" | "remove"): Promise<boolean> {
    const config = connectionStore.getConfig(connectionId);
    if (!config || config.db_type !== "nacos") return false;
    const externalConfig = (config.external_config || {}) as NacosAdminConfig;
    const hasVisibleScope = Array.isArray(config.visible_databases);
    const hasManagedScope = Array.isArray(externalConfig.managedNamespaces) && externalConfig.managedNamespaces.length > 0;
    if (!hasVisibleScope && !hasManagedScope) return false;

    const mutate = (values: string[] | undefined) => {
      const normalized = new Set((values || []).map((value) => value.trim()).filter(Boolean));
      if (action === "add") normalized.add(namespaceId);
      else normalized.delete(namespaceId);
      return [...normalized];
    };
    await connectionStore.updateConnection({
      ...config,
      visible_databases: hasVisibleScope ? mutate(config.visible_databases) : config.visible_databases,
      external_config: hasManagedScope ? { ...externalConfig, managedNamespaces: mutate(externalConfig.managedNamespaces) } : externalConfig,
    });
    return true;
  }

  async function refreshNacosNamespacesAfterMutation(connectionId: string) {
    try {
      await connectionStore.loadNacosNamespaces(connectionId, { force: true });
      return true;
    } catch (error: any) {
      toast(translateBackendError(t, error), 5000);
      return false;
    }
  }

  async function confirmCreateNacosNamespace() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const namespaceName = createNacosNamespaceName.value.trim();
    if (!node.connectionId || !namespaceName || createNacosNamespaceLoading.value) return;
    const namespaceId = createNacosNamespaceId.value.trim() || uuid();
    const confirmed = await executeWithProductionContextGuard({
      connection: connectionStore.getConfig(node.connectionId),
      database: namespaceId || undefined,
      reviewText: t("nacos.createNamespace"),
      source: t("production.sourceSidebar"),
      execute: async () => true,
    });
    if (confirmed !== true) return;
    createNacosNamespaceLoading.value = true;
    try {
      await api.nacosCreateNamespace(node.connectionId, {
        namespaceId,
        namespaceName,
        namespaceDesc: createNacosNamespaceDesc.value.trim() || namespaceName,
      });
      try {
        await updateExplicitNacosNamespaceScope(node.connectionId, namespaceId, "add");
      } catch (error: any) {
        toast(t("connection.saveFailed", { message: translateBackendError(t, error) }), 5000);
      }
      notifyNacosNamespacesChanged(node.connectionId);
      showCreateNacosNamespaceDialog.value = false;
      toast(t("nacos.namespaceCreated", { name: namespaceName }), 3000);
      if (await refreshNacosNamespacesAfterMutation(node.connectionId)) {
        const liveNode = findSidebarActionTarget(connectionStore.treeNodes, node);
        if (liveNode) liveNode.isExpanded = true;
      }
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
    } finally {
      createNacosNamespaceLoading.value = false;
    }
  }

  function openEditNacosNamespaceDialog() {
    editNacosNamespaceName.value = activeNode.value.nacosNamespaceName || activeNode.value.label;
    editNacosNamespaceDesc.value = activeNode.value.comment || "";
    showEditNacosNamespaceDialog.value = true;
  }

  async function confirmEditNacosNamespace() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const namespaceId = node.nacosNamespace?.trim() || "";
    const namespaceName = editNacosNamespaceName.value.trim();
    if (!node.connectionId || !namespaceId || !namespaceName || editNacosNamespaceLoading.value) return;
    const confirmed = await executeWithProductionContextGuard({
      connection: connectionStore.getConfig(node.connectionId),
      database: namespaceId,
      reviewText: t("nacos.editNamespace"),
      source: t("production.sourceSidebar"),
      execute: async () => true,
    });
    if (confirmed !== true) return;
    editNacosNamespaceLoading.value = true;
    try {
      await api.nacosUpdateNamespace(node.connectionId, {
        namespaceId,
        namespaceName,
        namespaceDesc: editNacosNamespaceDesc.value.trim() || namespaceName,
      });
      notifyNacosNamespacesChanged(node.connectionId);
      showEditNacosNamespaceDialog.value = false;
      toast(t("nacos.namespaceUpdated", { name: namespaceName }), 3000);
      await refreshNacosNamespacesAfterMutation(node.connectionId);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
    } finally {
      editNacosNamespaceLoading.value = false;
    }
  }

  function openDeleteNacosNamespaceConfirm() {
    deleteNacosNamespaceLoading.value = false;
    showDeleteNacosNamespaceConfirm.value = true;
  }

  async function confirmDeleteNacosNamespace() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const namespaceId = node.nacosNamespace?.trim() || "";
    if (node.type !== "nacos-namespace" || !node.connectionId || !namespaceId || deleteNacosNamespaceLoading.value) return;
    const confirmed = await executeWithProductionContextGuard({
      connection: connectionStore.getConfig(node.connectionId),
      database: namespaceId,
      reviewText: `${t("nacos.deleteNamespace")}: ${node.nacosNamespaceName || node.label}`,
      source: t("production.sourceSidebar"),
      execute: async () => true,
    });
    if (confirmed !== true) return;
    deleteNacosNamespaceLoading.value = true;
    const scopeSnapshot = snapshotExplicitNacosNamespaceScope(node.connectionId);
    let scopeUpdated = false;
    try {
      // Persist the local scope first. A local save failure must abort before
      // the irreversible remote deletion. If Nacos rejects the deletion, the
      // original scope is restored below.
      scopeUpdated = await updateExplicitNacosNamespaceScope(node.connectionId, namespaceId, "remove");
      await api.nacosDeleteNamespace(node.connectionId, namespaceId);
      notifyNacosNamespacesChanged(node.connectionId);
      showDeleteNacosNamespaceConfirm.value = false;
      toast(t("nacos.namespaceDeleted", { name: node.nacosNamespaceName || node.label }), 3000);
      await refreshNacosNamespacesAfterMutation(node.connectionId);
    } catch (error: any) {
      if (scopeUpdated) {
        try {
          await restoreExplicitNacosNamespaceScope(node.connectionId, scopeSnapshot);
        } catch (rollbackError: any) {
          toast(t("connection.saveFailed", { message: translateBackendError(t, rollbackError) }), 5000);
        }
      }
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
    } finally {
      deleteNacosNamespaceLoading.value = false;
    }
  }

  function dropMongoCollection() {
    dropMongoCollectionLoading.value = false;
    showDropMongoCollectionConfirm.value = true;
  }

  function dropMilvusCollection() {
    dropMongoCollection();
  }

  function dropMongoIndex() {
    dropMongoIndexLoading.value = false;
    showDropMongoIndexConfirm.value = true;
  }

  function dropAllMongoIndexes() {
    dropAllMongoIndexesLoading.value = false;
    showDropAllMongoIndexesConfirm.value = true;
  }

  function flushRedisDb() {
    showFlushRedisDbConfirm.value = true;
  }

  function clearElasticsearchIndex() {
    clearElasticsearchIndexLoading.value = false;
    showClearElasticsearchIndexConfirm.value = true;
  }

  async function confirmClearElasticsearchIndex() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    if (!canMutateElasticsearchIndexNode(node) || !connectionId || clearElasticsearchIndexLoading.value) return;
    const index = node.label;
    // Only the mutation is guarded. Reporting the outcome sits outside the try
    // so a failure in a post-success side effect can never make a completed
    // deletion look like it failed.
    let executed: { result: Awaited<ReturnType<typeof api.elasticsearchDeleteAllDocuments>> } | undefined;
    try {
      executed = await executeWithProductionContextGuard({
        connection: connectionStore.getConfig(connectionId),
        database: node.database,
        reviewText: elasticsearchClearIndexPreview(index),
        source: t("production.sourceSidebar"),
        execute: async () => {
          clearElasticsearchIndexLoading.value = true;
          await connectionStore.ensureConnected(connectionId);
          return { result: await api.elasticsearchDeleteAllDocuments(connectionId, index) };
        },
      });
    } catch (error: unknown) {
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
      return;
    } finally {
      clearElasticsearchIndexLoading.value = false;
    }
    // The guard returns undefined only when the user declines confirmation.
    if (executed === undefined) return;
    const result = executed.result;
    if (isPartialElasticsearchClear(result)) {
      toast(t("contextMenu.elasticsearchClearIndexPartial", { index, deleted: result.deleted, total: result.total }), 6000);
    } else {
      toast(t("contextMenu.elasticsearchClearIndexDone", { index, deleted: result.deleted }), 3000);
    }
    notifyElasticsearchIndexCleared(connectionId, index);
  }

  function prepareRedisDatabaseAliasDialog() {
    const node = activeNode.value;
    redisDatabaseAliasInput.value = node.connectionId && node.database != null ? connectionStore.getRedisDatabaseAlias(node.connectionId, node.database) || "" : "";
    redisDatabaseAliasSaving.value = false;
    showRedisDatabaseAliasDialog.value = true;
  }

  async function saveRedisDatabaseAlias(alias?: string) {
    const node = sidebarFormTarget.value ?? activeNode.value;
    if (node.type !== "redis-db" || !node.connectionId || node.database == null || redisDatabaseAliasSaving.value) return;
    redisDatabaseAliasSaving.value = true;
    try {
      await connectionStore.setRedisDatabaseAlias(node.connectionId, node.database, alias);
      showRedisDatabaseAliasDialog.value = false;
      const normalizedAlias = alias?.trim();
      toast(normalizedAlias ? t("redis.databaseAliasSaved", { db: node.database, alias: normalizedAlias }) : t("redis.databaseAliasCleared", { db: node.database }), 3000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    } finally {
      redisDatabaseAliasSaving.value = false;
    }
  }

  async function confirmRedisDatabaseAlias() {
    await saveRedisDatabaseAlias(redisDatabaseAliasInput.value);
  }

  async function clearRedisDatabaseAlias() {
    redisDatabaseAliasInput.value = "";
    await saveRedisDatabaseAlias();
  }

  async function confirmFlushRedisDb() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (node.type !== "redis-db" || !node.connectionId || !node.database) return;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      await api.redisFlushDb(node.connectionId, Number(node.database));
      connectionStore.updateRedisDbKeyStats(node.connectionId, Number(node.database), { loaded: 0, total: 0 });
      window.dispatchEvent(
        new CustomEvent("dbx-redis-db-flushed", {
          detail: { connectionId: node.connectionId, db: Number(node.database) },
        }),
      );
      toast(t("redis.flushDbSuccess", { db: node.database }), 3000);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function confirmDropMongoDatabase() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (node.type !== "mongo-db" || !connectionId || !database || !usesAnyMongoDriver(node)) return;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropDatabasePreview(database),
      source: t("production.sourceSidebar"),
      loading: dropDatabaseLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.mongoDropDatabase(connectionId, database),
      onSuccess: async () => {
        toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
        showDropDatabaseConfirm.value = false;
        await refreshMongoTreeAfterDrop(node, () => connectionStore.loadMongoDatabases(connectionId));
      },
      onError: toastMutationError,
    });
  }

  async function confirmDropMongoCollection() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (!canMutateMongoCollectionNode(node) || !connectionId || !database) return;
    const collectionName = node.label;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropCollectionPreview(database, collectionName),
      source: t("production.sourceSidebar"),
      loading: dropMongoCollectionLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.mongoDropCollection(connectionId, database, collectionName),
      onSuccess: async () => {
        toast(t("contextMenu.dropCollectionSuccess", { name: collectionName }), 3000);
        showDropMongoCollectionConfirm.value = false;
        await refreshMongoTreeAfterDrop(node, async () => {
          await connectionStore.loadMongoDatabases(connectionId);
          await connectionStore.loadMongoCollections(connectionId, database);
        });
      },
      onError: toastMutationError,
    });
  }

  async function confirmDropMilvusDatabase() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (!connectionId || !database || !canDropMilvusDatabaseNode(node)) return;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: `POST /v2/vectordb/databases/drop\n{"dbName":${JSON.stringify(database)}}`,
      source: t("production.sourceSidebar"),
      loading: dropDatabaseLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.vectorDropDatabase(connectionId, database),
      onSuccess: async () => {
        toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
        showDropDatabaseConfirm.value = false;
        await refreshMongoTreeAfterDrop(node, () => connectionStore.loadMilvusDatabases(connectionId));
      },
      onError: toastMutationError,
    });
  }

  async function confirmDropMilvusCollection() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (node.type !== "vector-collection" || !connectionId || !database || connectionStore.getConfig(connectionId)?.db_type !== "milvus") return;
    const collectionName = node.label;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: `POST /v2/vectordb/collections/drop\n{"dbName":${JSON.stringify(database)},"collectionName":${JSON.stringify(collectionName)}}`,
      source: t("production.sourceSidebar"),
      loading: dropMongoCollectionLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: () => api.vectorDropCollection(connectionId, database, collectionName),
      onSuccess: async () => {
        toast(t("contextMenu.dropCollectionSuccess", { name: collectionName }), 3000);
        showDropMongoCollectionConfirm.value = false;
        await refreshMongoTreeAfterDrop(node, async () => {
          await connectionStore.loadMilvusDatabases(connectionId);
          await connectionStore.loadVectorCollections(connectionId, database);
        });
      },
      onError: toastMutationError,
    });
  }

  async function refreshMongoTreeAfterDrop(node: TreeNode, refresh: () => Promise<void>) {
    try {
      await refresh();
    } catch (error) {
      connectionStore.removeTreeNode(node.id);
      toast(t("contextMenu.objectDropRefreshFailed", { message: translateBackendError(t, errorMessage(error)) }), 5000);
    }
  }

  async function refreshMongoIndexTreeAfterMutation(node: Pick<TreeNode, "connectionId" | "database" | "tableName" | "label">) {
    if (!node.connectionId || !node.database) return;
    try {
      await refreshLoadedMongoIndexes(connectionStore, {
        connectionId: node.connectionId,
        database: node.database,
        collection: node.tableName || node.label,
      });
    } catch (error) {
      toast(t("contextMenu.mongoIndexRefreshFailed", { message: translateBackendError(t, errorMessage(error)) }), 5000);
    }
  }

  async function confirmDropMongoIndex() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    const tableName = node.tableName;
    if (!canDropMongoIndexNode(node) || !connectionId || !database || !tableName) return;
    const indexName = mongoIndexNameForNode(node);
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropIndexPreview(database, tableName, indexName),
      source: t("production.sourceSidebar"),
      loading: dropMongoIndexLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        try {
          return await api.mongoDropIndexes(connectionId, database, tableName, JSON.stringify(indexName), true);
        } finally {
          await refreshMongoIndexTreeAfterMutation(node);
        }
      },
      onSuccess: (result) => {
        const failed = mongoDropIndexFailureCount(result);
        if (failed > 0) {
          toast(t("contextMenu.dropIndexesPartialFailure", { success: result.dropped_names.length, failed }), 5000);
        } else {
          toast(t("contextMenu.dropTableChildObjectSuccess", { name: indexName }), 3000);
        }
        showDropMongoIndexConfirm.value = false;
      },
      onError: toastMutationError,
    });
  }

  async function confirmDropAllMongoIndexes() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (!canManageMongoIndexesNode(node) || !connectionId || !database) return;
    const collectionName = mongoIndexCollectionName(node);
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropAllIndexesPreview(database, collectionName),
      source: t("production.sourceSidebar"),
      loading: dropAllMongoIndexesLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        try {
          return await api.mongoDropIndexes(connectionId, database, collectionName, undefined, false);
        } finally {
          await refreshMongoIndexTreeAfterMutation(node);
        }
      },
      onSuccess: (result) => {
        const failed = mongoDropIndexFailureCount(result);
        if (failed > 0) {
          toast(t("contextMenu.dropIndexesPartialFailure", { success: result.dropped_names.length, failed }), 5000);
        } else {
          toast(t("contextMenu.dropAllIndexesSuccess", { count: result.dropped_names.length, name: collectionName }), 3000);
        }
        showDropAllMongoIndexesConfirm.value = false;
      },
      onError: toastMutationError,
    });
  }

  return {
    canDropMongoDatabase,
    canDropMilvusDatabase,
    canDropMongoCollection,
    canDropMilvusCollection,
    canRenameMongoCollection,
    canCloneMongoCollection,
    prepareRenameMongoCollectionDialog,
    confirmRenameMongoCollection,
    showRenameMongoCollectionDialog,
    renameMongoCollectionName,
    renameMongoCollectionError,
    renameMongoCollectionPreview,
    renameMongoCollectionLoading,
    prepareCloneMongoCollectionDialog,
    confirmCloneMongoCollection,
    showCloneMongoCollectionDialog,
    cloneMongoCollectionName,
    cloneMongoCollectionError,
    cloneMongoCollectionLoading,
    mongoIndexNameForNode,
    canDropMongoIndexNode,
    canDropMongoIndex,
    canDropAllMongoIndexes,
    mongoIndexDropPreview,
    mongoDropAllIndexesPreview: mongoDropAllIndexesPreviewForNode,
    refreshMongoIndexTreeAfterMutation,
    canCreateMongoIndex,
    canManageMongoIndexes,
    mongoIndexKeyTypes: MONGO_INDEX_KEY_TYPES,
    mongoCreateIndexCanSubmit,
    mongoCreateIndexCanAddField,
    prepareCreateMongoIndexDialog,
    addMongoCreateIndexField,
    removeMongoCreateIndexField,
    confirmCreateMongoIndex,
    prepareMongoIndexManagerDialog,
    loadMongoIndexManagerRows,
    mongoIndexManagerSelected,
    mongoIndexManagerCollectionName,
    selectMongoIndexRow,
    startCreateMongoIndexDraft,
    startEditMongoIndexDraft,
    cancelMongoIndexDraft,
    dropSelectedMongoIndexRow,
    canDropSelectedMongoIndexRow,
    canEditSelectedMongoIndexRow,
    confirmEditMongoIndex,
    openCreateNacosNamespaceDialog,
    confirmCreateNacosNamespace,
    openEditNacosNamespaceDialog,
    confirmEditNacosNamespace,
    openDeleteNacosNamespaceConfirm,
    confirmDeleteNacosNamespace,
    dropMongoCollection,
    dropMongoIndex,
    dropAllMongoIndexes,
    canManageElasticsearchIndex,
    clearElasticsearchIndex,
    confirmClearElasticsearchIndex,
    flushRedisDb,
    prepareRedisDatabaseAliasDialog,
    confirmRedisDatabaseAlias,
    clearRedisDatabaseAlias,
    showRedisDatabaseAliasDialog,
    redisDatabaseAliasInput,
    redisDatabaseAliasSaving,
    confirmFlushRedisDb,
    confirmDropMongoDatabase,
    confirmDropMongoCollection,
    confirmDropMilvusDatabase,
    confirmDropMilvusCollection,
    dropMilvusCollection,
    confirmDropMongoIndex,
    confirmDropAllMongoIndexes,
  };
}
