import { computed, ref, type ShallowRef } from "vue";
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
import { selectedConnectionDeleteTargets, selectedConnectionDisconnectTargets, selectedConnectionDuplicateTargets, selectedConnectionGroupDeleteTargets, selectedConnectionMoveTargets } from "@/lib/sidebar/sidebarConnectionSelection";
import { releaseConnectionFromMultiSelection } from "@/lib/sidebar/sidebarConnectionMultiSelect";
import { connectionDeleteTargetSnapshot, connectionGroupDeleteTargetSnapshot, deleteConnectionsWithGroup, showDeleteConfirm, showDeleteGroupConfirm, sidebarFormTarget } from "@/components/sidebar/sidebarTreeDialogState";
import { connectionCanConfigureSidebarVisibleDatabases } from "@/lib/sidebar/sidebarVisibleFilterMenu";
import { disconnectSidebarConnections } from "@/lib/sidebar/sidebarConnectionDisconnect";

interface SidebarConnectionMutationRuntimeOptions {
  activeNode: ShallowRef<TreeNode>;
  releaseActiveNodeReference: (nodeIds: readonly string[]) => void;
  selectedTreeNodesInVisibleOrder: () => TreeNode[];
  connectionStore: ReturnType<typeof useConnectionStore>;
  queryStore: ReturnType<typeof useQueryStore>;
  requestGroupRename: (groupId: string) => void;
  openVisibleDatabases: (node: TreeNode) => void;
  openVisibleSchemas: (node: TreeNode) => void;
}

export function useSidebarConnectionMutationRuntime(options: SidebarConnectionMutationRuntimeOptions) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { activeNode, selectedTreeNodesInVisibleOrder, connectionStore, queryStore } = options;
  const deletingConnectionGroups = ref(false);

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

  async function setNodeAsDefaultSchema() {
    const node = activeNode.value;
    if (!node.connectionId || !node.schema) return;
    try {
      await connectionStore.setDefaultSchema(node.connectionId, node.schema);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function clearNodeDefaultSchema() {
    const node = activeNode.value;
    if (!node.connectionId) return;
    try {
      await connectionStore.clearDefaultSchema(node.connectionId);
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
      toast(t("grid.copyFailed", { message: translateBackendError(t, error) }), 5000);
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
      toast(translateBackendError(t, error), 5000);
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

  async function disconnectConnectionIds(connectionIds: readonly string[]) {
    if (!connectionIds.length) return;
    const result = await disconnectSidebarConnections(connectionIds, (connectionId) => connectionStore.disconnect(connectionId));
    if (!result.failed) {
      toast(connectionIds.length > 1 ? t("connection.disconnectedSelected", { count: connectionIds.length }) : t("connection.disconnected"), 2000);
      return;
    }
    if (result.succeeded > 0) {
      toast(t("connection.disconnectSelectedPartial", { succeeded: result.succeeded, failed: result.failed }), 5000);
      return;
    }
    const message = result.firstError instanceof Error ? result.firstError.message : String(result.firstError);
    toast(t("connection.saveFailed", { message }), 5000);
  }

  async function restoreSqliteDatabase() {
    const connectionId = activeNode.value.connectionId;
    const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    if (!connectionId || !config) return;
    const usesSsh = (config.transport_layers || []).some((layer) => layer.enabled !== false && layer.type === "ssh");
    if (!usesSsh) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const sourcePath = await open({
      multiple: false,
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "bak"] }],
    });
    if (typeof sourcePath !== "string" || !sourcePath) return;
    try {
      toast(t("contextMenu.restoreSqliteDatabaseInProgress"), 2000);
      await connectionStore.ensureConnected(connectionId);
      await api.restoreSqliteDatabase(connectionId, sourcePath);
      toast(t("contextMenu.restoreSqliteDatabaseSuccess"), 3000);
    } catch (error: any) {
      toast(t("contextMenu.restoreSqliteDatabaseFailed", { message: error?.message || String(error) }), 5000);
    }
  }

  async function disconnectConnection() {
    const connectionIds = selectedConnectionDisconnectTargets(activeNode.value, selectedTreeNodesInVisibleOrder())
      .filter((target) => connectionStore.connectedIds.has(target.connectionId))
      .map((target) => target.connectionId);
    await disconnectConnectionIds(connectionIds);
  }

  function connectionDisconnectTargets() {
    return selectedConnectionDisconnectTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
  }

  function connectionDisconnectMenuLabel(): string {
    const targets = connectionDisconnectTargets();
    const connectedCount = targets.filter((target) => connectionStore.connectedIds.has(target.connectionId)).length;
    return targets.length > 1 ? t("contextMenu.closeSelectedConnections", { count: connectedCount }) : t("contextMenu.closeConnection");
  }

  function canDisconnectConnection(): boolean {
    return connectionDisconnectTargets().some((target) => connectionStore.connectedIds.has(target.connectionId));
  }

  function connectionGroupDisconnectTargets(): string[] {
    const node = activeNode.value;
    if (node.type !== "connection-group") return [];
    return connectionStore.connectionIdsInGroups([node.id]).filter((connectionId) => connectionStore.connectedIds.has(connectionId));
  }

  function connectionGroupDisconnectMenuLabel(): string {
    return t("connectionGroup.closeConnections", { count: connectionGroupDisconnectTargets().length });
  }

  function canDisconnectConnectionGroup(): boolean {
    return connectionGroupDisconnectTargets().length > 0;
  }

  async function disconnectConnectionGroup() {
    await disconnectConnectionIds(connectionGroupDisconnectTargets());
  }

  /** "断开并忘记本次密码"是否可用：save_password=false 且当前已连接（本次运行期必已输入密码）。 */
  function canForgetSessionCredential(): boolean {
    const node = activeNode.value;
    if (!node?.connectionId) return false;
    const config = connectionStore.getConfig(node.connectionId);
    return config?.save_password === false && connectionStore.connectedIds.has(node.connectionId);
  }

  /** "断开并忘记本次密码"：关闭连接池并清除该连接本次运行期的会话密码。 */
  async function disconnectAndForgetConnectionPassword() {
    const node = activeNode.value;
    if (!node?.connectionId) return;
    try {
      await connectionStore.disconnectAndForgetConnectionPassword(node.connectionId);
      toast(t("connection.passwordForgotten"), 2000);
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
    () =>
      (activeNode.value.type === "database" || activeNode.value.type === "redis-db" || activeNode.value.type === "mongo-db" || activeNode.value.type === "vector-database") &&
      !!activeNode.value.connectionId &&
      !!activeNode.value.database &&
      connectionStore.isDefaultDatabase(activeNode.value.connectionId, activeNode.value.database),
  );
  const isNodeDefaultSchema = computed(() => activeNode.value.type === "schema" && !!activeNode.value.connectionId && !!activeNode.value.schema && connectionStore.isDefaultSchema(activeNode.value.connectionId, activeNode.value.schema));
  const isConnected = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && connectionStore.connectedIds.has(activeNode.value.connectionId));
  const isConnecting = computed(() => activeNode.value.type === "connection" && !!activeNode.value.connectionId && connectionStore.connectingIds.has(activeNode.value.connectionId));
  const canCloseDatabaseConnection = computed(() => canCloseSidebarDatabaseConnection(activeNode.value, connectionStore.isTreeNodeChildrenLoaded, (connectionId, database) => queryStore.openDatabaseKeys.has(`${connectionId}\x00${database}`)));
  const canConfigureVisibleDatabases = computed(() => {
    if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return false;
    const databaseType = connectionStore.getConfig(activeNode.value.connectionId)?.db_type;
    return connectionCanConfigureSidebarVisibleDatabases(databaseType);
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

  function connectionGroupDeleteTargets() {
    if (showDeleteGroupConfirm.value && connectionGroupDeleteTargetSnapshot.value.length) return connectionGroupDeleteTargetSnapshot.value;
    return selectedConnectionGroupDeleteTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
  }

  function connectionGroupDeleteMenuLabel(): string {
    const count = connectionGroupDeleteTargets().length;
    return count > 1 ? t("connectionGroup.deleteSelectedGroups", { count }) : t("connectionGroup.deleteGroup");
  }

  function connectionGroupDeleteConfirmMessage(): string {
    const targets = connectionGroupDeleteTargets();
    return targets.length > 1 ? t("connectionGroup.deleteSelectedGroupsConfirmMessage", { count: targets.length }) : t("connectionGroup.deleteGroupConfirmMessage", { name: targets[0]?.label || sidebarFormTarget.value?.label || activeNode.value.label });
  }

  function deleteConnectionGroup() {
    const targets = selectedConnectionGroupDeleteTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
    if (!targets.length) return;
    connectionGroupDeleteTargetSnapshot.value = targets.slice();
    deleteConnectionsWithGroup.value = false;
    showDeleteGroupConfirm.value = true;
  }

  function newConnectionInGroup() {
    connectionStore.startCreatingConnectionInGroup(activeNode.value.id);
  }

  function newSubgroup() {
    const groupId = connectionStore.createConnectionGroup(t("connectionGroup.newGroupDefault"), activeNode.value.id);
    options.requestGroupRename(groupId);
  }

  async function confirmDeleteGroup() {
    const targets = connectionGroupDeleteTargets();
    if (!targets.length || deletingConnectionGroups.value) return;

    const groupIds = targets.map((target) => target.id);
    deletingConnectionGroups.value = true;
    try {
      const connectionIds = await connectionStore.deleteConnectionGroups(groupIds, deleteConnectionsWithGroup.value);
      options.releaseActiveNodeReference(groupIds);
      for (const connectionId of connectionIds) {
        connectionStore.disconnect(connectionId).catch((error) => {
          console.warn("[DBX][connection-group:delete:disconnect-failed]", { connectionId, error });
        });
      }
      showDeleteGroupConfirm.value = false;
      connectionGroupDeleteTargetSnapshot.value = [];
      deleteConnectionsWithGroup.value = false;
      toast(targets.length > 1 ? t("connection.groupsDeleted", { count: targets.length }) : t("connection.groupDeleted"), 2000);
    } catch (error: any) {
      toast(t("connection.saveFailed", { message: error?.message || String(error) }), 5000);
    } finally {
      deletingConnectionGroups.value = false;
    }
  }

  function moveToGroup(groupId: string | null) {
    const targets = selectedConnectionMoveTargets(activeNode.value, selectedTreeNodesInVisibleOrder());
    if (!targets.length) return;
    for (const target of targets) connectionStore.moveConnectionToGroup(target.connectionId, groupId);
    for (const target of targets) releaseConnectionFromMultiSelection(connectionStore, target.connectionId);
  }

  function createGroupAndMoveConnection(name: string): boolean {
    const node = sidebarFormTarget.value ?? activeNode.value;
    const normalizedName = name.trim();
    const targets = selectedConnectionMoveTargets(node, selectedTreeNodesInVisibleOrder());
    if (!normalizedName || !targets.length) return false;
    const groupId = connectionStore.createConnectionGroup(normalizedName);
    for (const target of targets) connectionStore.moveConnectionToGroup(target.connectionId, groupId);
    for (const target of targets) releaseConnectionFromMultiSelection(connectionStore, target.connectionId);
    return true;
  }

  return {
    setNodeAsDefaultDatabase,
    clearNodeDefaultDatabase,
    setNodeAsDefaultSchema,
    clearNodeDefaultSchema,
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
    restoreSqliteDatabase,
    disconnectConnection,
    connectionDisconnectMenuLabel,
    canDisconnectConnection,
    connectionGroupDisconnectMenuLabel,
    canDisconnectConnectionGroup,
    disconnectConnectionGroup,
    canForgetSessionCredential,
    disconnectAndForgetConnectionPassword,
    cancelConnectionAttempt,
    closeDatabaseConnection,
    isPinned,
    isNodeDefaultDatabase,
    isNodeDefaultSchema,
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
    connectionGroupDeleteTargets,
    connectionGroupDeleteMenuLabel,
    connectionGroupDeleteConfirmMessage,
    deleteConnectionGroup,
    newConnectionInGroup,
    newSubgroup,
    confirmDeleteGroup,
    deletingConnectionGroups,
    moveToGroup,
    createGroupAndMoveConnection,
  };
}
