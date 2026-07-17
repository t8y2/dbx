import { computed, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { findSidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
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
  showFlushRedisDbConfirm,
} from "@/components/sidebar/sidebarTreeDialogState";

interface SidebarDatabaseSpecificMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  connectionStore: ReturnType<typeof useConnectionStore>;
}

export function useSidebarDatabaseSpecificMutationRuntime(options: SidebarDatabaseSpecificMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, connectionStore } = options;

  const canDropMongoDatabase = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "mongo-db" && !!activeNode.value.database && config?.driver_profile !== "mongodb-legacy";
  });

  const canDropMongoCollection = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "mongo-collection" && !!activeNode.value.database && config?.driver_profile !== "mongodb-legacy";
  });

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

  function mongoIndexDropPreview(node: Pick<TreeNode, "tableName">, indexName: string): string {
    return `db.getCollection(${JSON.stringify(node.tableName || "")}).dropIndex(${JSON.stringify(indexName)})`;
  }

  const canDropAllMongoIndexes = computed(() => {
    const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
    return activeNode.value.type === "mongo-collection" && !!activeNode.value.database && config?.db_type === "mongodb" && config.driver_profile !== "mongodb-legacy";
  });

  function mongoDropAllIndexesPreview(node: Pick<TreeNode, "label">): string {
    return `db.getCollection(${JSON.stringify(node.label)}).dropIndexes()`;
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

  async function confirmDropMongoCollection() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database || dropMongoCollectionLoading.value) return;
    dropMongoCollectionLoading.value = true;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      await api.mongoDropCollection(node.connectionId, node.database, node.label);
      toast(t("contextMenu.dropCollectionSuccess", { name: node.label }), 3000);
      await connectionStore.loadMongoCollections(node.connectionId, node.database);
      showDropMongoCollectionConfirm.value = false;
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    } finally {
      dropMongoCollectionLoading.value = false;
    }
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
    if (!canDropMongoIndexNode(node) || !node.connectionId || !node.database || !node.tableName || dropMongoIndexLoading.value) return;
    dropMongoIndexLoading.value = true;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const indexName = mongoIndexNameForNode(node);
      await api.mongoDropIndexes(node.connectionId, node.database, node.tableName, JSON.stringify(indexName), true);
      toast(t("contextMenu.dropTableChildObjectSuccess", { name: indexName }), 3000);
      showDropMongoIndexConfirm.value = false;
      await refreshMongoIndexTree(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    } finally {
      dropMongoIndexLoading.value = false;
    }
  }

  async function confirmDropAllMongoIndexes() {
    const node = sidebarDangerTarget.value ?? activeNode.value;
    if (node.type !== "mongo-collection" || !node.connectionId || !node.database || dropAllMongoIndexesLoading.value) return;
    dropAllMongoIndexesLoading.value = true;
    try {
      await connectionStore.ensureConnected(node.connectionId);
      const result = await api.mongoDropIndexes(node.connectionId, node.database, node.label, undefined, false);
      toast(t("contextMenu.dropAllIndexesSuccess", { count: result.dropped_names.length, name: node.label }), 3000);
      showDropAllMongoIndexesConfirm.value = false;
      await refreshMongoIndexTree(node);
    } catch (error: any) {
      toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
    } finally {
      dropAllMongoIndexesLoading.value = false;
    }
  }

  return {
    canDropMongoDatabase,
    canDropMongoCollection,
    mongoIndexNameForNode,
    canDropMongoIndexNode,
    canDropMongoIndex,
    mongoIndexDropPreview,
    canDropAllMongoIndexes,
    mongoDropAllIndexesPreview,
    openCreateNacosNamespaceDialog,
    confirmCreateNacosNamespace,
    openEditNacosNamespaceDialog,
    confirmEditNacosNamespace,
    dropMongoCollection,
    dropMongoIndex,
    dropAllMongoIndexes,
    flushRedisDb,
    confirmFlushRedisDb,
    confirmDropMongoCollection,
    confirmDropMongoIndex,
    confirmDropAllMongoIndexes,
  };
}
