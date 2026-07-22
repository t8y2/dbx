import { computed, watch, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { isRenamableMongoCollection, mongoCollectionKindFromNode, mongoDropAllIndexesPreview, mongoDropCollectionPreview, mongoDropDatabasePreview, mongoDropIndexPreview, mongoRenameCollectionPreview } from "@/lib/sidebar/mongoCollectionMutation";
import { runMongoSidebarMutation } from "@/lib/sidebar/runMongoSidebarMutation";
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
  showDropMongoCollectionConfirm,
  dropMongoCollectionLoading,
  showDropMongoIndexConfirm,
  dropMongoIndexLoading,
  showDropAllMongoIndexesConfirm,
  dropAllMongoIndexesLoading,
  showDropDatabaseConfirm,
  dropDatabaseLoading,
  showFlushRedisDbConfirm,
  showRenameMongoCollectionDialog,
  renameMongoCollectionName,
  renameMongoCollectionError,
  renameMongoCollectionPreview,
  renameMongoCollectionLoading,
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

  const canDropMongoDatabase = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "mongo-db" && !!activeNode.value.database && config?.driver_profile !== "mongodb-legacy";
  });

  function canMutateMongoCollectionNode(node: TreeNode): boolean {
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database) return false;
    const config = connectionStore.getConfig(node.connectionId);
    return config?.db_type === "mongodb" && config.driver_profile !== "mongodb-legacy";
  }

  function canRenameMongoCollectionNode(node: TreeNode): boolean {
    return canMutateMongoCollectionNode(node) && isRenamableMongoCollection(node.label, mongoCollectionKindFromNode(node));
  }

  const canDropMongoCollection = computed(() => canMutateMongoCollectionNode(activeNode.value));
  const canRenameMongoCollection = computed(() => canRenameMongoCollectionNode(activeNode.value));

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
    renameMongoCollectionPreview.value = mongoRenameCollectionPreview(node.database, node.label, newName);
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
      reviewText: mongoRenameCollectionPreview(database, oldName, newName),
      source: t("production.sourceSidebar"),
      loading: renameMongoCollectionLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        await api.mongoRenameCollection(connectionId, database, oldName, newName);
        await connectionStore.loadMongoCollections(connectionId, database);
      },
      onSuccess: () => {
        toast(t("contextMenu.renameObjectSuccess", { oldName, newName }), 3000);
        showRenameMongoCollectionDialog.value = false;
      },
      onError: (error) => {
        renameMongoCollectionError.value = translateBackendError(t, errorMessage(error));
      },
    });
  }

  function mongoIndexNameForNode(node: TreeNode): string {
    if (node.type !== "index") return "";
    return node.meta && "name" in node.meta ? node.meta.name : node.label.replace(/\s+\(.+\)$/, "");
  }

  function canDropMongoIndexNode(node: TreeNode): boolean {
    if (node.type !== "index" || !node.connectionId || !node.database || !node.tableName) return false;
    const config = connectionStore.getConfig(node.connectionId);
    return config?.db_type === "mongodb" && config.driver_profile !== "mongodb-legacy" && mongoIndexNameForNode(node) !== "_id_";
  }

  const canDropMongoIndex = computed(() => canDropMongoIndexNode(activeNode.value));

  function mongoIndexDropPreview(node: Pick<TreeNode, "database" | "tableName">, indexName: string): string {
    return mongoDropIndexPreview(node.database || "", node.tableName || "", indexName);
  }

  const canDropAllMongoIndexes = computed(() => canMutateMongoCollectionNode(activeNode.value));

  function mongoDropAllIndexesPreviewForNode(node: Pick<TreeNode, "database" | "label">): string {
    return mongoDropAllIndexesPreview(node.database || "", node.label);
  }

  function openCreateNacosNamespaceDialog() {
    createNacosNamespaceId.value = "";
    createNacosNamespaceName.value = "";
    createNacosNamespaceDesc.value = "";
    showCreateNacosNamespaceDialog.value = true;
  }

  async function confirmCreateNacosNamespace() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const namespaceName = createNacosNamespaceName.value.trim();
    if (!node.connectionId || !namespaceName || createNacosNamespaceLoading.value) return;
    createNacosNamespaceLoading.value = true;
    try {
      await api.nacosCreateNamespace(node.connectionId, {
        namespaceId: createNacosNamespaceId.value.trim() || undefined,
        namespaceName,
        namespaceDesc: createNacosNamespaceDesc.value.trim() || namespaceName,
      });
      showCreateNacosNamespaceDialog.value = false;
      await connectionStore.loadNacosNamespaces(node.connectionId, { force: true });
      const liveNode = findSidebarActionTarget(connectionStore.treeNodes, node);
      if (liveNode) liveNode.isExpanded = true;
      toast(t("nacos.namespaceCreated", { name: namespaceName }), 3000);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error?.message || String(error)) }), 5000);
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
    editNacosNamespaceLoading.value = true;
    try {
      await api.nacosUpdateNamespace(node.connectionId, {
        namespaceId,
        namespaceName,
        namespaceDesc: editNacosNamespaceDesc.value.trim() || namespaceName,
      });
      showEditNacosNamespaceDialog.value = false;
      await connectionStore.loadNacosNamespaces(node.connectionId, { force: true });
      toast(t("nacos.namespaceUpdated", { name: namespaceName }), 3000);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, error?.message || String(error)) }), 5000);
    } finally {
      editNacosNamespaceLoading.value = false;
    }
  }

  function dropMongoCollection() {
    dropMongoCollectionLoading.value = false;
    showDropMongoCollectionConfirm.value = true;
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
    if (node.type !== "mongo-db" || !connectionId || !database) return;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropDatabasePreview(database),
      source: t("production.sourceSidebar"),
      loading: dropDatabaseLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        await api.mongoDropDatabase(connectionId, database);
        await connectionStore.loadMongoDatabases(connectionId);
      },
      onSuccess: () => {
        toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
        showDropDatabaseConfirm.value = false;
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
      execute: async () => {
        await api.mongoDropCollection(connectionId, database, collectionName);
        await connectionStore.loadMongoCollections(connectionId, database);
      },
      onSuccess: () => {
        toast(t("contextMenu.dropCollectionSuccess", { name: collectionName }), 3000);
        showDropMongoCollectionConfirm.value = false;
      },
      onError: toastMutationError,
    });
  }

  function mongoIndexesGroupNodeId(node: Pick<TreeNode, "connectionId" | "database" | "schema" | "tableName" | "label">): string | null {
    if (!node.connectionId || !node.database) return null;
    const tableName = node.tableName || node.label;
    return node.schema ? `${node.connectionId}:${node.database}:${node.schema}:${tableName}:__indexes` : `${node.connectionId}:${node.database}:${tableName}:__indexes`;
  }

  async function refreshMongoIndexTree(node: Pick<TreeNode, "connectionId" | "database" | "schema" | "tableName" | "label">) {
    const nodeId = mongoIndexesGroupNodeId(node);
    if (!node.connectionId || !node.database || !nodeId) return;
    await connectionStore.loadIndexes(node.connectionId, node.database, node.tableName || node.label, node.schema, nodeId);
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
        await api.mongoDropIndexes(connectionId, database, tableName, JSON.stringify(indexName), true);
        await refreshMongoIndexTree(node);
      },
      onSuccess: () => {
        toast(t("contextMenu.dropTableChildObjectSuccess", { name: indexName }), 3000);
        showDropMongoIndexConfirm.value = false;
      },
      onError: toastMutationError,
    });
  }

  async function confirmDropAllMongoIndexes() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    const connectionId = node.connectionId;
    const database = node.database;
    if (!canMutateMongoCollectionNode(node) || !connectionId || !database) return;
    const collectionName = node.label;
    await runMongoSidebarMutation({
      connection: connectionStore.getConfig(connectionId),
      database,
      reviewText: mongoDropAllIndexesPreview(database, collectionName),
      source: t("production.sourceSidebar"),
      loading: dropAllMongoIndexesLoading,
      beforeExecute: () => connectionStore.ensureConnected(connectionId),
      execute: async () => {
        const result = await api.mongoDropIndexes(connectionId, database, collectionName, undefined, false);
        await refreshMongoIndexTree(node);
        return result;
      },
      onSuccess: (result) => {
        toast(t("contextMenu.dropAllIndexesSuccess", { count: result.dropped_names.length, name: collectionName }), 3000);
        showDropAllMongoIndexesConfirm.value = false;
      },
      onError: toastMutationError,
    });
  }

  return {
    canDropMongoDatabase,
    canDropMongoCollection,
    canRenameMongoCollection,
    prepareRenameMongoCollectionDialog,
    confirmRenameMongoCollection,
    showRenameMongoCollectionDialog,
    renameMongoCollectionName,
    renameMongoCollectionError,
    renameMongoCollectionPreview,
    renameMongoCollectionLoading,
    mongoIndexNameForNode,
    canDropMongoIndexNode,
    canDropMongoIndex,
    mongoIndexDropPreview,
    canDropAllMongoIndexes,
    mongoDropAllIndexesPreview: mongoDropAllIndexesPreviewForNode,
    openCreateNacosNamespaceDialog,
    confirmCreateNacosNamespace,
    openEditNacosNamespaceDialog,
    confirmEditNacosNamespace,
    dropMongoCollection,
    dropMongoIndex,
    dropAllMongoIndexes,
    flushRedisDb,
    confirmFlushRedisDb,
    confirmDropMongoDatabase,
    confirmDropMongoCollection,
    confirmDropMongoIndex,
    confirmDropAllMongoIndexes,
  };
}
