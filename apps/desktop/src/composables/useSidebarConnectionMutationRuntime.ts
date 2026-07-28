import { computed, type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { TreeNode } from "@/types/database";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { copyToClipboard } from "@/lib/common/clipboard";
import { uuid } from "@/lib/common/utils";
import { connectionFilePath, defaultSqliteBackupFileName, isMemorySqlitePath, sqliteBackupSourcePath } from "@/lib/connection/connectionFile";
import { hasEnabledTransportLayers } from "@/lib/backend/connectionTransport";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { revealPathInFileManager } from "@/lib/backend/tauri";
import { canConfigureVisibleSchemasForTreeNode } from "@/lib/database/databaseFeatureSupport";
import { canCloseSidebarDatabaseConnection } from "@/lib/sidebar/sidebarDatabaseOpenState";
import { selectedConnectionDeleteTargets, selectedConnectionDuplicateTargets } from "@/lib/sidebar/sidebarConnectionSelection";
import { connectionDeleteTargetSnapshot, showDeleteConfirm, showDeleteGroupConfirm, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";

interface SidebarConnectionMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  releaseActiveNodeReference: (nodeIds: readonly string[]) => void;
  selectedTreeNodesInVisibleOrder: () => TreeNode[];
  connectionStore: ReturnType<typeof useConnectionStore>;
  queryStore: ReturnType<typeof useQueryStore>;
  requestGroupRename: (groupId: string) => void;
  groupCreated: (groupId: string) => void;
  openVisibleDatabases: (node: TreeNode) => void;
  openVisibleSchemas: (node: TreeNode) => void;
}

export function useSidebarConnectionMutationRuntime(options: SidebarConnectionMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, selectedTreeNodesInVisibleOrder, connectionStore, queryStore } = options;

  async function setNodeAsDefaultDatabase() {
    const node = activeNode.value;
    if (!node.connectionId || !node.database) return;
    try {
      await connectionStore.setDefaultDatabase(node.connectionId, node.database);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function clearNodeDefaultDatabase() {
    const node = activeNode.value;
    if (!node.connectionId) return;
    try {
      await connectionStore.clearDefaultDatabase(node.connectionId);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  function connectionDeleteTargets() {
    if (showDeleteConfirm.value && connectionDeleteTargetSnapshot.value.length) return connectionDeleteTargetSnapshot.value;
    return selectedConnectionDeleteTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
  }

  function connectionDeleteMenuLabel(): string {
    const count = connectionDeleteTargets().length;
    return count > 1 ? t("contextMenu.deleteSelectedConnections", { count }) : t("contextMenu.deleteConnection");
  }

  function connectionDuplicateTargets() {
    return selectedConnectionDuplicateTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
  }

  function connectionDuplicateMenuLabel(): string {
    const count = connectionDuplicateTargets().length;
    return count > 1 ? t("contextMenu.duplicateSelectedConnections", { count }) : t("contextMenu.duplicateConnection");
  }

  function connectionDeleteConfirmMessage(): string {
    const targets = connectionDeleteTargets();
    return targets.length > 1 ? t("contextMenu.confirmDeleteSelectedMessage", { count: targets.length }) : t("contextMenu.confirmDeleteMessage", { name: targets[0]?.label || sidebarFormTarget.value?.label || activeNode.value.label });
  }

  function deleteConnection() {
    const targets = selectedConnectionDeleteTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
    if (!targets.length) return;
    connectionDeleteTargetSnapshot.value = targets.slice();
    showDeleteConfirm.value = true;
  }

  async function confirmDelete() {
    const targets = connectionDeleteTargets();
    if (!targets.length) return;
    const connectionIds = targets.map((target) => target.connectionId);
    try {
      await connectionStore.removeConnections(connectionIds);
      options.releaseActiveNodeReference(targets.map((target) => target.id));
      for (const connectionId of connectionIds) {
        connectionStore.disconnect(connectionId).catch((error) => {
          // Removal has already succeeded; disconnect cleanup must not turn it into a failed delete.
          console.warn("[DBX][connection:delete:disconnect-failed]", { connectionId, error });
        });
      }
      toast(targets.length > 1 ? t("connection.deletedSelected", { count: targets.length }) : t("connection.deleted"), 2000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function copyFinalProxyPort() {
    const connectionId = activeNode.value.connectionId;
    const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    if (!config || !hasEnabledTransportLayers(config)) return;

    try {
      const port = await api.connectionFinalProxyPort(config);
      await copyToClipboard(String(port));
      toast(t("contextMenu.finalProxyPortCopied", { port }), 2000);
    } catch (error: any) {
      toast(t("grid.copyFailed", { message: translateBackendError(t, error?.message || String(error)) }), 5000);
    }
  }

  async function duplicateConnection() {
    const targets = connectionDuplicateTargets();
    if (!targets.length) return;
    let duplicatedCount = 0;
    for (const target of targets) {
      const config = connectionStore.getConfig(target.connectionId);
      if (!config) continue;
      const newConfig = { ...config, id: uuid(), name: `${config.name} (Copy)` };
      await connectionStore.addConnection(newConfig, connectionStore.groupIdForConnection(target.connectionId));
      duplicatedCount += 1;
    }
    if (!duplicatedCount) return;
    toast(duplicatedCount > 1 ? t("connection.duplicatedSelected", { count: duplicatedCount }) : t("connection.duplicated"), 2000);
  }

  function editConnection() {
    const connectionId = activeNode.value.connectionId;
    if (connectionId) connectionStore.startEditing(connectionId);
  }

  const revealConnectionFilePath = computed<string | null>(() => {
    if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return null;
    const config = connectionStore.getConfig(activeNode.value.connectionId);
    return config ? connectionFilePath(config) : null;
  });

  async function revealDatabaseFile() {
    const path = revealConnectionFilePath.value;
    if (!path) return;
    try {
      await revealPathInFileManager(path);
    } catch (error: any) {
      toast(typeof error === "string" ? error : error?.message || String(error), 5000);
    }
  }

  const sqliteBackupSource = computed<string | null>(() => {
    if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return null;
    const config = connectionStore.getConfig(activeNode.value.connectionId);
    return config ? sqliteBackupSourcePath(config) : null;
  });

  const canBackupSqliteDatabase = computed(() => {
    const source = sqliteBackupSource.value;
    if (!source || !activeNode.value.connectionId) return false;
    return isTauriRuntime() && (!isMemorySqlitePath(source) || connectionStore.connectedIds.has(activeNode.value.connectionId));
  });

  async function backupSqliteDatabase() {
    const connectionId = activeNode.value.connectionId;
    const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const sourcePath = sqliteBackupSource.value;
    if (!connectionId || !config || !sourcePath) return;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const destinationPath = await save({
        defaultPath: defaultSqliteBackupFileName(config),
        filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
      });
      if (!destinationPath) return;

      toast(t("contextMenu.backupSqliteDatabaseInProgress"), 2000);
      if (!isMemorySqlitePath(sourcePath)) await connectionStore.ensureConnected(connectionId);
      await api.backupSqliteDatabase(connectionId, destinationPath);
      toast(t("contextMenu.backupSqliteDatabaseSuccess"), 3000);
    } catch (error: any) {
      toast(t("contextMenu.backupSqliteDatabaseFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function disconnectConnection() {
    const node = activeNode.value;
    if (!node.connectionId) return;
    try {
      await connectionStore.disconnect(node.connectionId);
      node.isExpanded = false;
      node.children = [];
      toast(t("connection.disconnected"), 2000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function cancelConnectionAttempt() {
    const connectionId = activeNode.value.connectionId;
    if (!connectionId) return;
    try {
      const cancelled = await connectionStore.cancelConnecting(connectionId);
      if (cancelled) toast(t("connection.connectCancelled"), 2000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function closeDatabaseConnection() {
    const node = activeNode.value;
    if (node.type !== "database" || !node.connectionId || node.database == null) return;
    try {
      await connectionStore.closeDatabaseConnection(node.connectionId, node.database);
      toast(t("connection.databaseConnectionClosed", { name: node.label }), 2000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  const isPinned = computed(() => activeNode.value.pinned || connectionStore.isTreeNodePinned(activeNode.value));
  const isNodeDefaultDatabase = computed(
    () => (activeNode.value.type === "database" || activeNode.value.type === "redis-db" || activeNode.value.type === "mongo-db") && !!activeNode.value.connectionId && !!activeNode.value.database && connectionStore.isDefaultDatabase(activeNode.value.connectionId, activeNode.value.database),
  );
  const isConnected = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && connectionStore.connectedIds.has(activeNode.value.connectionId));
  const isConnecting = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && connectionStore.connectingIds.has(activeNode.value.connectionId));
  const canCloseDatabaseConnection = computed(() => canCloseSidebarDatabaseConnection(activeNode.value, connectionStore.isTreeNodeChildrenLoaded, (connectionId, database) => queryStore.openDatabaseKeys.has(`${connectionId}\x00${database}`)));
  const canConfigureVisibleDatabases = computed(() => {
    if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return false;
    const databaseType = connectionStore.getConfig(activeNode.value.connectionId)?.db_type;
    return databaseType !== "elasticsearch" && databaseType !== "qdrant" && databaseType !== "milvus" && databaseType !== "weaviate" && databaseType !== "chromadb" && databaseType !== "etcd" && databaseType !== "mq" && databaseType !== "nacos";
  });
  const canConfigureVisibleSchemas = computed(() => {
    if (!activeNode.value.connectionId) return false;
    const databaseType = connectionStore.getConfig(activeNode.value.connectionId)?.db_type;
    return canConfigureVisibleSchemasForTreeNode(databaseType, activeNode.value.type, activeNode.value.database);
  });
  const canCopyFinalProxyPort = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && hasEnabledTransportLayers(connectionStore.getConfig(activeNode.value.connectionId)));

  function togglePin() {
    connectionStore.toggleTreeNodePin(activeNode.value);
  }

  function openVisibleDatabasesDialog() {
    options.openVisibleDatabases(activeNode.value);
  }

  function openVisibleSchemasDialog() {
    options.openVisibleSchemas(activeNode.value);
  }

  function startRenameGroup() {
    if (activeNode.value.type === "connection-group") options.requestGroupRename(activeNode.value.id);
  }

  function deleteConnectionGroup() {
    showDeleteGroupConfirm.value = true;
  }

  function newConnectionInGroup() {
    connectionStore.startCreatingConnectionInGroup(activeNode.value.id);
  }

  function newSubgroup() {
    const groupId = connectionStore.createConnectionGroup(t("connectionGroup.newGroupDefault"), activeNode.value.id);
    connectionStore.selectedTreeNodeId = groupId;
    options.groupCreated(groupId);
  }

  function confirmDeleteGroup() {
    const node = sidebarFormTarget.value ?? activeNode.value;
    connectionStore.deleteConnectionGroup(node.id);
    options.releaseActiveNodeReference([node.id]);
    showDeleteGroupConfirm.value = false;
    toast(t("connection.groupDeleted"), 2000);
  }

  function moveToGroup(groupId: string | null) {
    const connectionId = activeNode.value.connectionId;
    if (connectionId) connectionStore.moveConnectionToGroup(connectionId, groupId);
  }

  return {
    setNodeAsDefaultDatabase,
    clearNodeDefaultDatabase,
    connectionDeleteTargets,
    connectionDeleteMenuLabel,
    connectionDuplicateTargets,
    connectionDuplicateMenuLabel,
    connectionDeleteConfirmMessage,
    deleteConnection,
    confirmDelete,
    copyFinalProxyPort,
    duplicateConnection,
    editConnection,
    revealConnectionFilePath,
    revealDatabaseFile,
    sqliteBackupSource,
    canBackupSqliteDatabase,
    backupSqliteDatabase,
    disconnectConnection,
    cancelConnectionAttempt,
    closeDatabaseConnection,
    isPinned,
    isNodeDefaultDatabase,
    isConnected,
    isConnecting,
    canCloseDatabaseConnection,
    canConfigureVisibleDatabases,
    canConfigureVisibleSchemas,
    canCopyFinalProxyPort,
    togglePin,
    openVisibleDatabasesDialog,
    openVisibleSchemasDialog,
    startRenameGroup,
    deleteConnectionGroup,
    newConnectionInGroup,
    newSubgroup,
    confirmDeleteGroup,
    moveToGroup,
  };
}
