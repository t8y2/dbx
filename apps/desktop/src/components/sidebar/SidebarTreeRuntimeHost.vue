<script setup lang="ts">
import { computed, nextTick, watch, onBeforeUnmount, inject, reactive, shallowRef } from "vue";
import { createRoutedSidebarDialogController } from "./sidebarDialogControllerRouting";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import { useSidebarConnectionMutationRuntime } from "@/composables/useSidebarConnectionMutationRuntime";
import { useSidebarDatabaseSpecificMutationRuntime } from "@/composables/useSidebarDatabaseSpecificMutationRuntime";
import { useSidebarTableMutationRuntime } from "@/composables/useSidebarTableMutationRuntime";
import { useSidebarTreeExportRuntime } from "@/composables/useSidebarTreeExportRuntime";
import { useSidebarTreeToolRuntime } from "@/composables/useSidebarTreeToolRuntime";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  Database,
  ChevronsDown,
  FolderOpen,
  Trash2,
  TerminalSquare,
  RefreshCw,
  Copy,
  TableProperties,
  ListTree,
  Pencil,
  Play,
  Plug,
  Unplug,
  Pin,
  ArrowRightLeft,
  Download,
  Upload,
  FileCode,
  Network,
  PencilRuler,
  Search,
  FolderInput,
  FolderPlus,
  Eraser,
  Scissors,
  CopyPlus,
  Plus,
  ScrollText,
  Code2,
  ListFilter,
  Clipboard,
  UsersRound,
  Activity,
  Gauge,
  CalendarClock,
  HardDriveDownload,
  FilePlus,
  SquarePen,
  ListX,
  Info,
  X,
} from "@lucide/vue";
import type { ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useToast } from "@/composables/useToast";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import type { ColumnInfo, DatabaseType, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { canTreeNodePin, canTreeNodeShowExpander } from "@/lib/sidebar/sidebarTreeItemLayout";
import { objectTypesForGroupNode } from "@/lib/table/tableTree";
import { loadSidebarObjectGroup } from "@/lib/sidebar/sidebarObjectGroupRouting";
import { mysqlObjectTemplateForGroup } from "@/lib/sidebar/mysqlObjectTemplates";
import { buildTableDeleteTemplate, buildTableInsertTemplate, buildTableSelectTemplate, buildTableUpdateTemplate } from "@/lib/table/tableSqlTemplates";
import { driverStoreFocusForInstallError } from "@/lib/connection/agentDriverInstallHint";
import {
  canCreateConnectionNamespace,
  canCreateDatabaseNodeNamespace,
  canEditDatabaseProperties as canEditDatabasePropertiesForNode,
  connectionNamespaceCreationTarget,
  editableDatabasePropertyGroups,
  supportsDatabaseCreation,
  supportsDatabaseSearch,
  supportsFieldLineage,
  supportsObjectBrowserTreeNode,
  supportsSchemaDiagram,
  supportsSqlFileExecution,
  supportsTableImport,
  supportsTableTruncate,
  supportsTableStructureEditing,
  usesTreeSchemaMode,
} from "@/lib/database/databaseCapabilities";
import { copyNameForTreeNode, isDocumentBrowserTreeNode, objectSourceKindForTreeNode, shouldRunTreeNodeRowAction, treeNodeRowAction, treeNodeRowDoubleClickAction } from "@/lib/sidebar/treeNodeClick";
import { dataTabOpenModeFromTreeClick, type DataTabOpenMode } from "@/lib/sidebar/dataTabOpenPolicy";
import { isCopySidebarSelectionShortcut, isEditSidebarConnectionShortcut, isPasteSidebarSelectionShortcut } from "@/lib/editor/keyboardShortcuts";
import { canRefreshDataTableFromSingleActivationDoubleClick, dataTableDoubleClickAction } from "@/lib/tabs/dataTabActivation";
import { attachedDatabaseNameFromPath, buildCreateDatabaseSql, buildDuckDbAttachDatabaseSql, buildSqliteAttachDatabaseSql, supportsCreateDatabaseCharset, uniqueAttachedDatabaseName } from "@/lib/database/createDatabaseSql";
import { appendCreateDatabaseErrorHint } from "@/lib/database/createDatabaseErrorHints";
import { SQLITE_DATABASE_FILE_EXTENSIONS } from "@/lib/database/databaseFileDetection";
import {
  buildCreateSchemaSql,
  buildDropDatabaseSql,
  buildDropObjectSql,
  buildDropSchemaSql,
  buildGetDatabaseCommentSql,
  buildGetSchemaCommentSql,
  buildUpdateDatabasePropertiesSql,
  buildDropTableSql,
  buildDropTableChildObjectSql,
  buildDuplicateTableStructureSql,
  buildCopyTableDataSql,
  buildEmptyTableSql,
  buildTruncateTableSql,
  supportsDropTableCascade,
  supportsTruncateTableCascade,
  supportsSchemaComment,
  type DropTableChildObjectSqlOptions,
  type DropObjectSqlOptions,
  type TableChildObjectType,
} from "@/lib/database/dbAdminSql";
import { buildRenameObjectSql, supportsObjectRename, type RenameableObjectType } from "@/lib/table/objectRenameSql";
import { buildRoutineRenameObjectSourceStatements, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
import { buildViewDdl } from "@/lib/table/viewDdl";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { defaultPasteTableMode, pasteTableModeCopiesData, supportsWholeRowTableDataCopy, tableClipboardMatchesTarget, tableDataCopyColumnOptions, type TableClipboardContext } from "@/lib/table/tableClipboard";
import { selectedTreeNodesInVisibleOrder as orderSelectedTreeNodes } from "@/lib/sidebar/sidebarTreeSelection";
import { connectionPasteTargetGroupId, selectedConnectionClipboardTargets, selectedConnectionEditTarget } from "@/lib/sidebar/sidebarConnectionSelection";
import { connectionSupportsDatabaseUserAdmin, resolveDatabaseUserAdminProviderForConnection, type DatabaseUserIdentity } from "@/lib/database/databaseUserAdmin";
import { authorizationPlanSql, authorizationPlanStatus, buildCreateDatabaseAuthorizationPlan, executeAuthorizationPlan, type AuthorizationPlan, type AuthorizationStepResult } from "@/lib/database/databaseAuthorizationPlan";
import { connectionSupportsProcessList } from "@/lib/database/processListDrivers";
import { connectionSupportsServerDashboard } from "@/lib/database/mysqlServerStatus";
import { connectionSupportsServerDashboard as connectionSupportsPgServerDashboard } from "@/lib/database/postgresServerStatus";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { batchTableEmptyFeedback, runBatchTableEmpty } from "@/lib/sidebar/batchTableEmpty";
import { runBatchTableTruncate } from "@/lib/table/batchTableTruncate";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import { rankSavedSqlHistory, type SavedSqlHistoryScope } from "@/lib/savedSql/savedSqlHistory";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import { flattenTree } from "@/composables/useFlatTree";
import { createDatabaseCollationOptionsForCharset, nextCreateDatabaseCollation, normalizeCreateDatabaseCharset, parseCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import type { SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import { createSidebarActionTarget, findSidebarActionTarget, releaseRemovedSidebarActionTarget, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { createSidebarMenuContext, normalizeSidebarMenuDescriptors } from "@/lib/sidebar/sidebarTreeMenuDescriptors";
import type { SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";
import {
  fallbackCreateDatabaseCharset,
  sidebarTreeDialogOwner,
  sidebarDangerTarget,
  sidebarFormTarget,
  showDeleteConfirm,
  showDropTableConfirm,
  showDropTableChildObjectConfirm,
  showBatchDropConfirm,
  showBatchEmptyConfirm,
  showBatchTruncateConfirm,
  showStructurePreviewDialog,
  showStructureDocCopyDialog,
  structurePreviewSql,
  structurePreviewTitle,
  structurePreviewError,
  structureDocCopyText,
  structureDocCopyTitle,
  isLoadingStructurePreview,
  showEmptyTableConfirm,
  showTruncateTableConfirm,
  showRenameObjectDialog,
  renameObjectName,
  renameObjectError,
  renameObjectPreviewSql,
  dropTablePreviewSql,
  dropTableCascade,
  batchDropCascade,
  emptyTablePreviewSql,
  truncateTablePreviewSql,
  truncateTableCascade,
  dropObjectPreviewSql,
  showDropObjectConfirm,
  dropTableChildObjectPreviewSql,
  batchDropPreviewSql,
  batchEmptyPreviewSql,
  batchEmptyTargets,
  batchDropTargets,
  batchTruncateTargets,
  batchTruncatePreviewSql,
  batchTruncateCascade,
  dropDatabasePreviewSql,
  dropSchemaPreviewSql,
  showDuplicateDialog,
  duplicateTableName,
  duplicateStructureSource,
  showPasteDialog,
  pasteTableMode,
  pasteTableEntries,
  showCreateDatabaseDialog,
  createDatabaseName,
  createDatabaseCharset,
  createDatabaseCollation,
  createDatabaseUsers,
  createDatabaseSelectedUsers,
  createDatabaseUsersLoading,
  showCreateDatabasePreviewDialog,
  createDatabaseAuthorizationPlan,
  createDatabasePreviewSql,
  createDatabaseAuthorizationResults,
  createDatabaseAuthorizationApplying,
  showCreateNacosNamespaceDialog,
  createNacosNamespaceId,
  createNacosNamespaceName,
  createNacosNamespaceDesc,
  createNacosNamespaceLoading,
  showEditNacosNamespaceDialog,
  editNacosNamespaceName,
  editNacosNamespaceDesc,
  editNacosNamespaceLoading,
  createDatabaseCharsetOptions,
  createDatabaseCollationsByCharset,
  createDatabaseCharsetLoading,
  showDropDatabaseConfirm,
  dropDatabaseLoading,
  showDropMongoCollectionConfirm,
  dropMongoCollectionLoading,
  showDropMongoIndexConfirm,
  dropMongoIndexLoading,
  showDropAllMongoIndexesConfirm,
  dropAllMongoIndexesLoading,
  showFlushRedisDbConfirm,
  showCreateSchemaDialog,
  createSchemaName,
  showDropSchemaConfirm,
  showEditDatabasePropertiesDialog,
  editDatabasePropertiesLoading,
  editDatabasePropertiesPreviewSql,
  editDatabaseCharset,
  editDatabaseCollation,
  editDatabaseCommentText,
  showEditSchemaCommentDialog,
  schemaCommentText,
  schemaCommentLoading,
  schemaCommentPreviewSql,
  showDeleteGroupConfirm,
  showMoveToNewGroupDialog,
  moveToNewGroupName,
  type DuplicateStructureSource,
} from "./sidebarTreeDialogState";

const { t } = useI18n();

const connectionStore = useConnectionStore();

const queryStore = useQueryStore();

const settingsStore = useSettingsStore();

const savedSqlStore = useSavedSqlStore();

const { toast } = useToast();

const { highlight } = useSqlHighlighter();

const { openData } = useSidebarDataOpenRuntime();

const { getDatabaseOptions } = useDatabaseOptions();

const props = defineProps<{
  node: TreeNode;
  depth: number;
  dragDisabled?: boolean;
  pendingRename?: boolean;
  highlighted?: boolean;
}>();

const activeNode = shallowRef<TreeNode>(props.node);
let acceptedSelectionIds: readonly string[] | null = null;

function releaseActiveNodeReference(nodeIds: readonly string[]) {
  activeNode.value = releaseRemovedSidebarActionTarget(activeNode.value, nodeIds);
}

watch(
  () => connectionStore.treeNodes,
  (nodes) => {
    const liveNode = findSidebarActionTarget(nodes, createSidebarActionTarget(activeNode.value));
    activeNode.value = liveNode ?? releaseRemovedSidebarActionTarget(activeNode.value, [activeNode.value.id]);
  },
  { flush: "post" },
);

const { copyStructureAs, copyStructureDocText, copyStructurePreview, exportData, exportDataXlsx, exportStructure, saveStructurePreview, selectTextareaContent } = useSidebarTreeExportRuntime({
  activeNode,
  connectionStore,
  settingsStore,
  acceptedSelectionIds: () => acceptedSelectionIds,
});

const { openAllDatabasesExport, openDataCompare, openDatabaseExport, openDatabaseSearch, openDiagram, openFieldLineage, openScheduledBackups, openSchemaDiff, openSqlFileExecution, openStructureEditor, openTableImport, openTransfer } = useSidebarTreeToolRuntime({
  activeNode,
  connectionStore,
  queryStore,
  settingsStore,
  tableChildObjectName: tableChildDropObjectName,
});

const emit = defineEmits<{
  "rename-started": [];
  "group-created": [groupId: string];
  "request-group-rename": [groupId: string];
  "node-toggled": [node: TreeNode, wasExpanded: boolean];
  "search-toggle": [node: TreeNode];
  "context-menu": [event: MouseEvent, node: TreeNode, items: ContextMenuItem[]];
  "open-ddl": [node: TreeNode];
  "open-object-source": [node: TreeNode, initialEditing: boolean];
  "open-procedure": [node: TreeNode];
  "open-data": [node: TreeNode, requireSelection: boolean, openMode: DataTabOpenMode, runner: (node: TreeNode, request: SidebarDataOpenRequest) => Promise<void>];
  "open-visible-databases": [node: TreeNode];
  "open-visible-schemas": [node: TreeNode];
  "open-danger-dialog": [request: SidebarDangerDialogRequest];
  "open-dialog-controller": [controller: Record<string, any> | null];
  "open-install-extension": [node: TreeNode];
}>();

const {
  setNodeAsDefaultDatabase,
  clearNodeDefaultDatabase,
  connectionDeleteMenuLabel,
  connectionDuplicateMenuLabel,
  connectionDeleteConfirmMessage,
  deleteConnection,
  confirmDelete,
  copyFinalProxyPort,
  duplicateConnection,
  editConnection,
  revealConnectionFilePath,
  revealDatabaseFile,
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
} = useSidebarConnectionMutationRuntime({
  activeNode,
  releaseActiveNodeReference,
  selectedTreeNodesInVisibleOrder,
  connectionStore,
  queryStore,
  requestGroupRename: (groupId) => emit("request-group-rename", groupId),
  groupCreated: (groupId) => emit("group-created", groupId),
  openVisibleDatabases: (node) => emit("open-visible-databases", node),
  openVisibleSchemas: (node) => emit("open-visible-schemas", node),
});

const {
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
} = useSidebarDatabaseSpecificMutationRuntime({ activeNode, connectionStore });

const { isTableNotView, supportsTruncate, canDropTableCascade, canTruncateTableCascade, refreshDropTablePreviewSql, refreshTruncateTablePreviewSql, dropTable, refreshTableList, confirmDropTable, emptyTable, confirmEmptyTable, truncateTable, confirmTruncateTable } = useSidebarTableMutationRuntime({
  activeNode,
  releaseActiveNodeReference,
  connectionStore,
  currentDatabaseType,
  databaseTypeForNode,
  executeWithProductionGuard: executeTreeNodeSqlWithProductionGuard,
  closeDroppedTableObjectTabsForNode,
  refreshMutatedTableDataTabsForNode,
});

const treeItemDialogOwner = Symbol("sidebar-tree-dialog-owner");

function claimTreeItemDialogOwnership() {
  sidebarTreeDialogOwner.value = treeItemDialogOwner;
}

function routeTreeItemDialogController() {
  const controller = getTreeItemDialogController();
  const target = createSidebarActionTarget(activeNode.value);
  sidebarFormTarget.value = target;
  const routedController = createRoutedSidebarDialogController(controller, {
    node: target,
    wrapAction: (action) => {
      return (...args: unknown[]) => {
        activateActionTarget(target);
        return action(...args);
      };
    },
  });
  routedController.pasteTableDataCopySupported = pasteTableDataCopySupported.value;
  routedController.canSetCreateDatabaseCharset = canSetCreateDatabaseCharset.value;
  routedController.canEditDatabaseCharsetCollation = canEditDatabaseCharsetCollation.value;
  routedController.canEditDatabaseComment = canEditDatabaseComment.value;
  emit("open-dialog-controller", routedController);
}

const sidebarTreeContext = inject(sidebarTreeContextKey, null);

function currentDatabaseType(): DatabaseType | undefined {
  return activeNode.value.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(activeNode.value.connectionId)) : undefined;
}

function currentTableStructureDatabaseType(): DatabaseType | undefined {
  return activeNode.value.connectionId ? tableStructureDatabaseTypeForConnection(connectionStore.getConfig(activeNode.value.connectionId)) : undefined;
}

function rawDatabaseType(): DatabaseType | undefined {
  return activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId)?.db_type : undefined;
}

function databaseTypeForNode(node: TreeNode): DatabaseType | undefined {
  return node.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(node.connectionId)) : undefined;
}

function tableStructureDatabaseTypeForNode(node: TreeNode): DatabaseType | undefined {
  return node.connectionId ? tableStructureDatabaseTypeForConnection(connectionStore.getConfig(node.connectionId)) : undefined;
}

function hasNodeDatabaseContext(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return !!node.connectionId && hasTreeNodeDatabaseContext(node);
}

const groupTypes: Set<TreeNodeType> = new Set([
  "group-columns",
  "group-indexes",
  "group-fkeys",
  "group-triggers",
  "group-tables",
  "group-views",
  "group-materialized-views",
  "group-procedures",
  "group-functions",
  "group-sequences",
  "group-packages",
  "group-types",
  "group-partitions",
  "group-extensions",
]);

function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

async function toggle() {
  const node = activeNode.value;
  if (node.isLoading) {
    if (!node.isExpanded) {
      node.isExpanded = true;
      emit("node-toggled", node, false);
    }
    return;
  }
  emit("search-toggle", node);
  const wasExpanded = !!node.isExpanded;

  if (node.type === "connection-group") {
    node.isExpanded = !node.isExpanded;
    connectionStore.toggleConnectionGroupCollapsed(node.id);
    emit("node-toggled", node, wasExpanded);
    return;
  }

  if (node.type === "group-partitions") {
    node.isExpanded = !node.isExpanded;
    emit("node-toggled", node, wasExpanded);
    return;
  }

  // Keep the click path aligned with every object-group definition. In
  // particular, schema-level trigger/type groups have no tableName, so they
  // must use the generic object loader rather than the table-trigger loader.
  const databaseObjectGroup = !!objectTypesForGroupNode(node.type);
  if (databaseObjectGroup && connectionStore.isTreeNodeChildrenLoaded(node.id)) {
    node.isExpanded = !node.isExpanded;
    if (wasExpanded && !connectionStore.sidebarSearchQuery) connectionStore.releaseCollapsedTreeNodeChildren(node.id);
    emit("node-toggled", node, wasExpanded);
    return;
  }

  if (node.isExpanded) {
    node.isExpanded = false;
    if (!connectionStore.sidebarSearchQuery) connectionStore.releaseCollapsedTreeNodeChildren(node.id);
    emit("node-toggled", node, wasExpanded);
    return;
  }

  try {
    if (await loadSidebarObjectGroup(node, connectionStore)) {
      emit("node-toggled", node, wasExpanded);
      return;
    }

    if (node.type === "connection" && node.connectionId) {
      const config = connectionStore.getConfig(node.connectionId);
      if (config?.db_type === "redis") {
        await connectionStore.loadRedisDatabases(node.connectionId);
      } else if (config?.db_type === "etcd") {
        await connectionStore.loadEtcdRoot(node.connectionId);
      } else if (config?.db_type === "zookeeper") {
        await connectionStore.loadZooKeeperRoot(node.connectionId);
      } else if (config?.db_type === "mongodb") {
        await connectionStore.loadMongoDatabases(node.connectionId);
      } else if (config?.db_type === "elasticsearch") {
        await connectionStore.loadElasticsearchIndices(node.connectionId);
      } else if (config?.db_type === "milvus") {
        await connectionStore.loadMilvusDatabases(node.connectionId);
      } else if (config?.db_type === "qdrant" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
        await connectionStore.loadVectorCollections(node.connectionId);
      } else if (config?.db_type === "mq") {
        await connectionStore.loadMqTenants(node.connectionId);
      } else if (config?.db_type === "nacos") {
        await connectionStore.loadNacosNamespaces(node.connectionId);
      } else {
        await connectionStore.loadDatabases(node.connectionId);
      }
    } else if (node.type === "redis-db" && node.connectionId && node.database) {
      await connectionStore.ensureConnected(node.connectionId);
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "Redis"}:db${node.database}`;
      queryStore.createTab(node.connectionId, node.database, tabTitle, "redis");
    } else if (node.type === "mq-tenant" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      queryStore.openMqAdmin(node.connectionId, { tenant: node.mqTenant || node.label, initialTab: node.mqInitialTab });
    } else if (node.type === "nacos-namespace" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      queryStore.openNacosAdmin(node.connectionId, { namespace: node.nacosNamespace || "", namespaceName: node.nacosNamespaceName || node.label });
    } else if (node.type === "etcd-root" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "etcd"}:keys`;
      queryStore.createTab(node.connectionId, "", tabTitle, "etcd");
      refreshActiveKvBrowserAfterOpen("etcd", node.connectionId);
    } else if (node.type === "zookeeper-root" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "ZooKeeper"}:keys`;
      queryStore.createTab(node.connectionId, "", tabTitle, "zookeeper");
      refreshActiveKvBrowserAfterOpen("zookeeper", node.connectionId);
    } else if (node.type === "user-admin" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      queryStore.openUserAdmin(node.connectionId);
    } else if (node.type === "dameng-job-admin" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      queryStore.openDamengJobAdmin(node.connectionId);
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await connectionStore.loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "vector-database" && node.connectionId && node.database) {
      await connectionStore.loadVectorCollections(node.connectionId, node.database);
    } else if (node.type === "mongo-collection" && node.connectionId && node.database) {
      await connectionStore.loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id);
    } else if (node.type === "elasticsearch-index" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      const tab = queryStore.createTab(node.connectionId, node.database || "default", node.label, "mongo");
      queryStore.updateSql(tab, node.label);
    } else if (node.type === "vector-collection" && node.connectionId) {
      await connectionStore.ensureConnected(node.connectionId);
      const collectionRef = (node.meta as { collectionId?: string } | undefined)?.collectionId ?? node.label;
      const tab = queryStore.createTab(node.connectionId, node.database || "default", node.label, "vector");
      queryStore.updateSql(tab, collectionRef);
      api
        .vectorGetCollectionDetail(node.connectionId, node.database || "default", collectionRef)
        .then((info) => {
          if (info.dimension != null) {
            if (node.meta) {
              (node.meta as Record<string, unknown>).dimension = info.dimension;
            } else {
              node.meta = { dimension: info.dimension } as any;
            }
          }
        })
        .catch(() => {});
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      if (node.catalog && node.catalog !== "internal") {
        await connectionStore.loadDorisCatalogTables(node);
      } else {
        const config = connectionStore.getConfig(node.connectionId);
        const effectiveDbType = effectiveDatabaseTypeForConnection(config);
        if (config?.db_type === "sqlserver") {
          await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, node.database);
        } else if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
          await connectionStore.loadSchemas(node.connectionId, node.database);
        } else {
          await connectionStore.loadTables(node.connectionId, node.database);
        }
      }
    } else if (node.type === "doris-catalog" && node.connectionId) {
      await connectionStore.loadDorisCatalogDatabases(node);
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await connectionStore.loadTables(node.connectionId, node.database, node.schema);
    } else if (node.type === "linked-server-root" && node.connectionId) {
      await connectionStore.loadSqlServerLinkedServers(node.connectionId);
    } else if (node.type === "linked-server" && node.connectionId) {
      await connectionStore.loadSqlServerLinkedServerCatalogs(node);
    } else if (node.type === "linked-server-catalog" && node.connectionId) {
      await connectionStore.loadSqlServerLinkedServerSchemas(node);
    } else if (node.type === "linked-server-schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await connectionStore.loadTables(node.connectionId, node.database, node.schema);
    } else if ((node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await connectionStore.loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id, node.catalog);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    }
    emit("node-toggled", node, wasExpanded);
  } catch (e: any) {
    if (!wasExpanded) node.isExpanded = false;
    const errMsg = e?.message || String(e);
    if (errMsg.includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE)) return;
    toast(t("connection.connectFailed", { message: translateBackendError(t, errMsg) }), 5000);
    openDriverStoreForInstallError(errMsg);
  }
}

function runRowClickAction(clickDetail: number) {
  const node = activeNode.value;
  if (node.type === "load-more") {
    if (clickDetail > 1) return;
    void loadMoreObjectGroupChildren();
    return;
  }
  if (node.type === "object-browser") {
    if (clickDetail > 1) return;
    void openObjectBrowser();
    return;
  }
  if (node.type === "mongo-gridfs") {
    openMongoTreeData(node);
    return;
  }
  const action = treeNodeRowAction(node.type, canExpand.value, settingsStore.editorSettings.sidebarActivation);
  if (!shouldRunTreeNodeRowAction(action, clickDetail)) return;
  if (action === "open-data") {
    if (node.type === "table") {
      singleActivationDoubleClickRefreshAllowed = canRefreshDataTableFromSingleActivationDoubleClick(findExistingSameTableDataTab());
    }
    scheduleOpenData(node);
  } else if (isDocumentBrowserTreeNode(node.type)) {
    openMongoTreeData(node);
  } else if (node.type === "procedure" || node.type === "function" || node.type === "trigger" || node.type === "sequence" || node.type === "package" || node.type === "package-body" || node.type === "type" || node.type === "type-body") {
    openObjectSourceDialog(false);
  } else if (action === "toggle") {
    toggle();
  }
}

let singleActivationDoubleClickRefreshAllowed = false;

function refreshActiveKvBrowserAfterOpen(mode: "etcd" | "zookeeper", connectionId: string) {
  void nextTick(() => {
    window.dispatchEvent(new CustomEvent("dbx-refresh-active-kv-browser", { detail: { mode, connectionId } }));
  });
}

function openDriverStoreForInstallError(errMsg: string, node: TreeNode = activeNode.value) {
  const config = node.connectionId ? connectionStore.getConfig(node.connectionId) : undefined;
  const focus = driverStoreFocusForInstallError(errMsg, config?.db_type, config?.driver_profile);
  if (focus) window.dispatchEvent(new CustomEvent("dbx-open-driver-store", { detail: focus }));
}

async function loadMoreObjectGroupChildren() {
  const node = activeNode.value;
  try {
    await connectionStore.loadMoreObjectGroupChildren(node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function loadAllObjectGroupChildren() {
  const node = activeNode.value;
  try {
    await connectionStore.loadAllObjectGroupChildren(node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function visibleTreeNodes(): TreeNode[] {
  if (sidebarTreeContext) return sidebarTreeContext.getVisibleNodes();
  return flattenTree(connectionStore.treeNodes).map((item) => item.node);
}

function selectedTreeNodesInVisibleOrder(): TreeNode[] {
  return orderSelectedTreeNodes(visibleTreeNodes(), acceptedSelectionIds ?? connectionStore.selectedTreeNodeIds);
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || !!target.closest("[contenteditable='true']");
}

function onKeydown(event: KeyboardEvent) {
  claimTreeItemDialogOwnership();
  if ((!isSelected.value && !isMultiSelected.value) || isEditableShortcutTarget(event.target)) return;
  if (isPasteTreeClipboardShortcut(event)) {
    if (!requestPasteTreeClipboard()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (isEditConnectionShortcut(event)) {
    if (!requestEditSelectedConnection()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "F2") {
    if (!requestRenameSelectedNode()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key === "F5") {
    if (!requestRefreshSelectedNode()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && isDeleteTreeNodeShortcut(event)) {
    if (!requestDeleteSelectedNode()) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!isCopyTreeSelectionShortcut(event)) return;
  event.preventDefault();
  event.stopPropagation();
  copySelectedNames();
}

function isDeleteTreeNodeShortcut(event: KeyboardEvent): boolean {
  return event.key === "Delete" || event.key === "Backspace";
}

function isPasteTreeClipboardShortcut(event: KeyboardEvent): boolean {
  return isPasteSidebarSelectionShortcut(event, settingsStore.editorSettings.shortcuts);
}

function isEditConnectionShortcut(event: KeyboardEvent): boolean {
  return isEditSidebarConnectionShortcut(event, settingsStore.editorSettings.shortcuts);
}

function isCopyTreeSelectionShortcut(event: KeyboardEvent): boolean {
  return isCopySidebarSelectionShortcut(event, settingsStore.editorSettings.shortcuts);
}

function pasteTableTargetContext(): TableClipboardContext | null {
  if (!activeNode.value.connectionId || !activeNode.value.database) return null;
  return {
    connectionId: activeNode.value.connectionId,
    database: activeNode.value.database,
    schema: activeNode.value.schema,
  };
}

function canPasteTreeClipboardToCurrentNode(): boolean {
  const clipboard = connectionStore.treeClipboard;
  return clipboard?.kind === "table-copy" && tableClipboardMatchesTarget(clipboard.tables, pasteTableTargetContext());
}

function requestPasteTreeClipboard(): boolean {
  claimTreeItemDialogOwnership();
  ensureDangerDialogRouting();
  routeTreeItemDialogController();
  const clipboard = connectionStore.treeClipboard;
  if (clipboard?.kind === "connection-copy") {
    const targetGroupId = connectionPasteTargetGroupId(activeNode.value, (connectionId) => connectionStore.groupIdForConnection(connectionId));
    void connectionStore
      .pasteConnectionClipboard(targetGroupId)
      .then((count) => {
        if (count > 0) toast(count > 1 ? t("connection.duplicatedSelected", { count }) : t("connection.duplicated"), 2000);
      })
      .catch((e: any) => toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000));
    return true;
  }
  if (clipboard?.kind !== "table-copy" || !canPasteTreeClipboardToCurrentNode()) return false;
  pasteTableMode.value = defaultPasteTableMode(currentDatabaseType());
  pasteTableEntries.value = clipboard.tables.map((entry) => ({
    sourceName: entry.tableName,
    targetName: `${entry.tableName}_copy`,
    connectionId: entry.connectionId,
    database: entry.database,
    schema: entry.schema,
  }));
  showPasteDialog.value = true;
  return true;
}

function requestRefreshSelectedNode(): boolean {
  if (!canRefreshTreeNodeShortcut()) return false;
  void refresh();
  return true;
}

function canRefreshTreeNodeShortcut(): boolean {
  const type = activeNode.value.type;
  if (type === "connection" || type === "database" || type === "schema" || type === "table" || type === "view") {
    return true;
  }
  return isGroupLabel(activeNode.value) && type !== "group-partitions";
}

function requestRenameSelectedNode(): boolean {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length > 1 && selected.some((node) => node.id === activeNode.value.id)) return false;
  const editTarget = selectedConnectionEditTarget(activeNode.value, selected);
  if (editTarget) {
    connectionStore.startEditing(editTarget.connectionId);
    return true;
  }
  if (canRenameObject.value) {
    openRenameObjectDialog();
    return true;
  }
  if (activeNode.value.type === "connection-group") {
    startRenameGroup();
    return true;
  }
  return false;
}

function requestEditSelectedConnection(): boolean {
  const editTarget = selectedConnectionEditTarget(activeNode.value, selectedTreeNodesInVisibleOrder());
  if (!editTarget) return false;
  connectionStore.startEditing(editTarget.connectionId);
  return true;
}

function requestDeleteSelectedNode(): boolean {
  claimTreeItemDialogOwnership();
  ensureDangerDialogRouting();
  routeTreeItemDialogController();
  if (requestDropSelectedNodes()) return true;
  if (activeNode.value.type === "connection") {
    deleteConnection();
    return true;
  }
  if (activeNode.value.type === "connection-group") {
    deleteConnectionGroup();
    return true;
  }
  if (canDropDatabase.value) {
    dropDatabase();
    return true;
  }
  if (canDropMongoDatabase.value) {
    dropDatabase();
    return true;
  }
  if (canDropMongoCollection.value) {
    dropMongoCollection();
    return true;
  }
  if (canDropSchema.value) {
    dropSchema();
    return true;
  }
  return false;
}

function onDoubleClick(event: MouseEvent) {
  if (dataTabOpenModeFromTreeClick(activeNode.value.type, event, settingsStore.editorSettings.shortcuts.openDataInNewTab) === "new-tab") return;
  const action = treeNodeRowDoubleClickAction(activeNode.value.type, canOpenObjectBrowser.value, settingsStore.editorSettings.sidebarActivation, canExpand.value);
  if (action === "open-object-browser") {
    void openObjectBrowser();
  } else if (action === "open-object-browser-and-expand") {
    void openObjectBrowser();
    if (!activeNode.value.isExpanded) void toggle();
  } else if (action === "open-data") {
    openDataImmediately(activeNode.value);
  } else if (action === "refresh-data") {
    void refreshData();
  } else if (action === "open-source") {
    openObjectSourceDialog(false);
  } else if (action === "open-saved-sql") {
    openSavedSqlFile();
  } else if (action === "toggle" && (activeNode.value.type === "mongo-gridfs" || isDocumentBrowserTreeNode(activeNode.value.type))) {
    openMongoTreeData(activeNode.value);
  } else if (action === "toggle") {
    toggle();
  }
}

async function refreshData() {
  const node = activeNode.value;
  if (node.type !== "table" || !hasNodeDatabaseContext(node)) return;
  const singleActivationRefreshAllowed = singleActivationDoubleClickRefreshAllowed;
  singleActivationDoubleClickRefreshAllowed = false;
  const activation = settingsStore.editorSettings.sidebarActivation;
  if (activation === "single" && !singleActivationRefreshAllowed) return;
  const existingSameTableTab = findExistingSameTableDataTab();
  const action = dataTableDoubleClickAction(existingSameTableTab, activation, singleActivationRefreshAllowed);
  if (action === "none") return;
  if (action === "open") {
    openDataImmediately(node);
    return;
  }
  if (!existingSameTableTab) return;
  queryStore.switchTab(existingSameTableTab.id);
  if (action === "activate") return;
  await queryStore.refreshDataTab(existingSameTableTab.id);
}

function findExistingSameTableDataTab() {
  const node = activeNode.value;
  if (node.type !== "table" || !hasNodeDatabaseContext(node)) return undefined;
  const config = connectionStore.getConfig(node.connectionId);
  const tableSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
  return queryStore.tabs.find((tab) => tab.mode === "data" && tab.connectionId === node.connectionId && tab.database === node.database && (tab.tableMeta?.catalog || "") === (node.catalog || "") && (tab.schema || "") === (tableSchema || "") && (tab.tableMeta?.tableName || tab.title) === node.label);
}

function openMongoTreeData(node: TreeNode) {
  if (!node.connectionId || !node.database) return;
  if (node.type === "mongo-gridfs") {
    queryStore.openMongoGridFs(node.connectionId, node.database);
    return;
  }
  const tabTitle = `${node.database}.${node.label}`;
  if (node.type === "mongo-bucket") {
    queryStore.openMongoBucket(node.connectionId, node.database, node.label);
    return;
  }
  if (node.type !== "mongo-collection") return;
  const tab = queryStore.createTab(node.connectionId, node.database, tabTitle, "mongo");
  queryStore.updateSql(tab, node.label);
}

async function openSavedSqlFile() {
  const node = activeNode.value;
  if (node.type !== "saved-sql-file" || !node.savedSqlId) return;
  const file = await savedSqlStore.ensureFileContent(node.savedSqlId);
  if (!file) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
}

async function openObjectBrowser() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;

    if (hasTreeNodeDatabaseContext(node)) {
      queryStore.openObjectBrowser(node.connectionId, node.database, node.schema, node.catalog);
      return;
    }

    const connection = connectionStore.getConfig(node.connectionId);
    if (!connection) return;
    const options = await getDatabaseOptions(node.connectionId);
    const database = resolveDefaultDatabase(connection, options);
    if (database) {
      queryStore.openObjectBrowser(node.connectionId, database);
    } else {
      await toggle();
    }
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
    openDriverStoreForInstallError(e?.message || String(e));
  }
}

async function openUserAdmin() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    queryStore.openUserAdmin(node.connectionId);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openProcessList() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    queryStore.openProcessList(node.connectionId);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openServerDashboard() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    if (currentDatabaseType() === "postgres") {
      queryStore.openPostgresDashboard(node.connectionId);
    } else {
      queryStore.openMysqlDashboard(node.connectionId);
    }
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openDamengJobAdmin() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    queryStore.openDamengJobAdmin(node.connectionId);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function scheduleOpenData(node: TreeNode) {
  emit("open-data", node, true, "default", openData);
}

function openDataImmediately(node: TreeNode = activeNode.value) {
  emit("open-data", node, false, "default", openData);
}

function openDataInNewTabImmediately(node: TreeNode = activeNode.value) {
  emit("open-data", node, false, "new-tab", (target, request) => openData(target, request, "new-tab"));
}

async function newQuery() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    if (hasTreeNodeDatabaseContext(node)) {
      if (node.type === "table" || node.type === "view" || node.type === "materialized_view") {
        await newSelectTemplate();
        return;
      }
      queryStore.createTab(node.connectionId, node.database, undefined, "query", node.schema);
      return;
    }
    const connection = connectionStore.getConfig(node.connectionId);
    if (!connection) return;
    const options = await getDatabaseOptions(node.connectionId);
    queryStore.createTab(node.connectionId, resolveDefaultDatabase(connection, options), undefined, "query");
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
    openDriverStoreForInstallError(e?.message || String(e));
  }
}

// SQL template helpers have been extracted to @/lib/tableSqlTemplates.ts
// ---- Template actions ----

function openRedisInstanceInfo() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  const config = connectionStore.getConfig(node.connectionId);
  const dbName = config?.name || "Redis";
  queryStore.createTab(node.connectionId, "0", `${dbName} - ${t("contextMenu.instanceInfo")}`, "redis-dashboard");
}

async function loadTemplateContext(allowView = false) {
  const node = activeNode.value;
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return null;
  const isTableNode = node.type === "table";
  const isReadableObject = isTableNode || (allowView && (node.type === "view" || node.type === "materialized_view"));
  if (!isReadableObject) return null;

  await connectionStore.ensureConnected(node.connectionId);
  connectionStore.activeConnectionId = node.connectionId;
  const config = connectionStore.getConfig(node.connectionId);
  const dbType = config ? effectiveDatabaseTypeForConnection(config) : undefined;
  const tableSchema = node.schema || node.database;
  let columns: ColumnInfo[] = [];
  try {
    const querySchema = connectionObjectTreeQuerySchema(config, node.database, tableSchema);
    columns = await api.getColumns(node.connectionId, node.database, querySchema, node.label);
  } catch (e) {
    console.warn("[DBX][tableSqlTemplate:getColumns:error]", e);
  }

  let tableType = node.tableType;
  if (dbType === "tdengine") {
    try {
      const querySchema = connectionObjectTreeQuerySchema(config, node.database, tableSchema);
      const tables = await api.listTables(node.connectionId, node.database, querySchema, node.label, 200);
      const matched = tables.find((table) => table.name.toLowerCase() === node.label.toLowerCase());
      if (matched?.table_type) tableType = matched.table_type;
    } catch (e) {
      console.warn("[DBX][tableSqlTemplate:listTables:error]", e);
    }
  }

  return { node, dbType, tableSchema, columns, tableType };
}

function openSqlTemplateTab(connectionId: string, database: string, schema: string | undefined, sql: string, title?: string) {
  const tabId = queryStore.createTab(connectionId, database, title, "query", schema);
  queryStore.updateSql(tabId, sql);
}

async function newSelectTemplate() {
  try {
    const context = await loadTemplateContext(true);
    if (!context) return;
    const sql = buildTableSelectTemplate({
      databaseType: context.dbType,
      schema: context.tableSchema,
      tableName: context.node.label,
      columns: context.columns,
    });
    openSqlTemplateTab(context.node.connectionId!, context.node.database!, context.node.schema, sql);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function newInsertTemplate() {
  try {
    const context = await loadTemplateContext(false);
    if (!context) return;
    const sql = buildTableInsertTemplate({
      databaseType: context.dbType,
      schema: context.tableSchema,
      tableName: context.node.label,
      columns: context.columns,
      tableType: context.tableType,
    });
    openSqlTemplateTab(context.node.connectionId!, context.node.database!, context.node.schema, sql);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function newUpdateTemplate() {
  try {
    const context = await loadTemplateContext(false);
    if (!context) return;
    const sql = buildTableUpdateTemplate({
      databaseType: context.dbType,
      schema: context.tableSchema,
      tableName: context.node.label,
      columns: context.columns,
    });
    openSqlTemplateTab(context.node.connectionId!, context.node.database!, context.node.schema, sql);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function newDeleteTemplate() {
  try {
    const context = await loadTemplateContext(false);
    if (!context) return;
    const sql = buildTableDeleteTemplate({
      databaseType: context.dbType,
      schema: context.tableSchema,
      tableName: context.node.label,
      columns: context.columns,
    });
    openSqlTemplateTab(context.node.connectionId!, context.node.database!, context.node.schema, sql);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function generateDdlTemplate() {
  const node = activeNode.value;
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
  if (node.type !== "table" && node.type !== "view" && node.type !== "materialized_view") return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    const schema = node.schema || node.database;
    let ddl: string;
    if (node.type === "table") {
      ddl = await api.getTableDdl(node.connectionId, node.database, schema, node.label, undefined, node.catalog);
    } else if (node.type === "materialized_view") {
      ddl = await api.getTableDdl(node.connectionId, node.database, schema, node.label, "MATERIALIZED_VIEW", node.catalog);
    } else {
      const result = await api.getObjectSource(node.connectionId, node.database, schema, node.label, "VIEW");
      ddl = await buildViewDdl({
        databaseType: currentDatabaseType(),
        schema,
        name: node.label,
        source: result.source,
      });
    }
    const formatted = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(currentDatabaseType()), settingsStore.editorSettings.sqlFormatter);
    openSqlTemplateTab(node.connectionId, node.database, node.schema, formatted, `DDL - ${node.label}`);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

async function refresh() {
  const node = activeNode.value;
  try {
    await connectionStore.refreshTreeNode(node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
    openDriverStoreForInstallError(e?.message || String(e), node);
  }
}

async function copyName() {
  const node = activeNode.value;
  updateTreeClipboardForNodes([node]);
  try {
    await copyToClipboard(copyNameForTreeNode(node));
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copySelectedNames() {
  const selectedNodes = selectedTreeNodesInVisibleOrder();
  const nodes = selectedNodes.length > 1 && selectedNodes.some((node) => node.id === activeNode.value.id) ? selectedNodes : [activeNode.value];
  const connectionTargets = selectedConnectionClipboardTargets(activeNode.value, nodes);
  if (connectionTargets.length > 0) {
    const copiedCount = connectionStore.copyConnectionsToTreeClipboard(connectionTargets.map((node) => node.connectionId));
    if (copiedCount > 0) toast(t("connection.copied"), 2000);
    return;
  }
  updateTreeClipboardForNodes(nodes);
  try {
    await copyToClipboard(nodes.map(copyNameForTreeNode).join("\n"));
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function updateTreeClipboardForNodes(nodes: TreeNode[]) {
  const tableNodes = nodes.filter((node): node is DuplicateStructureSource => node.type === "table" && !!node.connectionId && !!node.database && typeof node.label === "string");
  if (tableNodes.length === 0) {
    connectionStore.treeClipboard = null;
    return;
  }
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: tableNodes.map((node) => ({
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      tableName: node.label,
    })),
  };
}

// --- Table Management Operations ---
const pasteTableDataCopySupported = computed(() => supportsWholeRowTableDataCopy(currentDatabaseType()));

// --- Extension Management ---
function openInstallExtensionDialog(node: TreeNode) {
  emit("open-install-extension", node);
}

// --- Procedure / Function Management ---
function dropObjectSqlOptions(): DropObjectSqlOptions | null {
  return dropObjectSqlOptionsForNode(activeNode.value);
}

function dropObjectSqlOptionsForNode(node: TreeNode): DropObjectSqlOptions | null {
  if (node.type !== "view" && node.type !== "materialized_view" && node.type !== "procedure" && node.type !== "function") return null;
  return {
    databaseType: tableStructureDatabaseTypeForNode(node),
    objectType: node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : node.type === "procedure" ? "PROCEDURE" : "FUNCTION",
    schema: node.schema,
    name: node.objectName || node.label,
    signature: node.signature,
  };
}

function tableChildDropObjectType(type: TreeNodeType): TableChildObjectType | null {
  if (type === "column") return "COLUMN";
  if (type === "index") return "INDEX";
  if (type === "fkey") return "FOREIGN_KEY";
  if (type === "trigger") return "TRIGGER";
  return null;
}

function tableChildDropObjectName(node: TreeNode): string {
  if (node.type === "column") return node.meta && "name" in node.meta ? node.meta.name : node.label.replace(/\s+\(.+\)$/, "");
  if (node.type === "index") return node.meta && "name" in node.meta ? node.meta.name : node.label.replace(/\s+\(.+\)$/, "");
  if (node.type === "fkey") return node.meta && "name" in node.meta ? node.meta.name : node.label;
  if (node.type === "trigger") return node.meta && "name" in node.meta ? node.meta.name : node.label.replace(/\s+\(.+\)$/, "");
  return node.label;
}

function dropTableChildObjectSqlOptions(): DropTableChildObjectSqlOptions | null {
  return dropTableChildObjectSqlOptionsForNode(activeNode.value);
}

function dropTableChildObjectSqlOptionsForNode(node: TreeNode): DropTableChildObjectSqlOptions | null {
  const objectType = tableChildDropObjectType(node.type);
  if (!objectType || !node.tableName) return null;
  const name = tableChildDropObjectName(node).trim();
  if (!name) return null;
  return {
    databaseType: databaseTypeForNode(node),
    objectType,
    schema: node.schema,
    tableName: node.tableName,
    name,
  };
}

const canDropTableChildObject = computed(() => {
  return canDropTableChildObjectNode(activeNode.value);
});

function canDropTableChildObjectNode(node: TreeNode): boolean {
  const options = dropTableChildObjectSqlOptionsForNode(node);
  if (!options) return false;
  const capabilities = getTableStructureCapabilities(options.databaseType);
  if (options.objectType === "COLUMN") return capabilities.dropColumn;
  if (options.objectType === "INDEX") return capabilities.dropIndex;
  return true;
}

function dropObjectMenuLabel(): string {
  if (activeNode.value.type === "view") return t("contextMenu.dropView");
  if (activeNode.value.type === "materialized_view") return t("contextMenu.dropView");
  if (activeNode.value.type === "procedure") return t("contextMenu.dropProcedure");
  if (activeNode.value.type === "function") return t("contextMenu.dropFunction");
  return t("contextMenu.dropObject");
}

function dropObjectConfirmTitle(): string {
  if (activeNode.value.type === "view") return t("contextMenu.confirmDropViewTitle");
  if (activeNode.value.type === "materialized_view") return t("contextMenu.confirmDropViewTitle");
  if (activeNode.value.type === "procedure") return t("contextMenu.confirmDropProcedureTitle");
  if (activeNode.value.type === "function") return t("contextMenu.confirmDropFunctionTitle");
  return t("contextMenu.confirmDropObjectTitle");
}

function dropObjectConfirmMessage(): string {
  if (activeNode.value.type === "view") return t("contextMenu.confirmDropViewMessage", { name: activeNode.value.label });
  if (activeNode.value.type === "materialized_view") return t("contextMenu.confirmDropViewMessage", { name: activeNode.value.label });
  if (activeNode.value.type === "procedure") return t("contextMenu.confirmDropProcedureMessage", { name: activeNode.value.label });
  if (activeNode.value.type === "function") return t("contextMenu.confirmDropFunctionMessage", { name: activeNode.value.label });
  return t("contextMenu.confirmDropObjectMessage", { name: activeNode.value.label });
}

function dropTableChildObjectMenuLabel(): string {
  if (activeNode.value.type === "column") return t("contextMenu.dropColumn");
  if (activeNode.value.type === "index") return t("contextMenu.dropIndex");
  if (activeNode.value.type === "fkey") return t("contextMenu.dropForeignKey");
  if (activeNode.value.type === "trigger") return t("contextMenu.dropTrigger");
  return t("contextMenu.dropObject");
}

function dropTableChildObjectConfirmTitle(): string {
  if (activeNode.value.type === "column") return t("contextMenu.confirmDropColumnTitle");
  if (activeNode.value.type === "index") return t("contextMenu.confirmDropIndexTitle");
  if (activeNode.value.type === "fkey") return t("contextMenu.confirmDropForeignKeyTitle");
  if (activeNode.value.type === "trigger") return t("contextMenu.confirmDropTriggerTitle");
  return t("contextMenu.confirmDropObjectTitle");
}

function dropTableChildObjectConfirmMessage(): string {
  return t("contextMenu.confirmDropTableChildObjectMessage", {
    name: tableChildDropObjectName(activeNode.value),
    table: activeNode.value.tableName || "",
  });
}

async function refreshDropObjectPreviewSql() {
  const options = dropObjectSqlOptions();
  dropObjectPreviewSql.value = "";
  dropObjectPreviewSql.value = options ? await buildDropObjectSql(options).catch(() => "") : "";
}

async function refreshDropTableChildObjectPreviewSql() {
  const options = dropTableChildObjectSqlOptions();
  dropTableChildObjectPreviewSql.value = "";
  dropTableChildObjectPreviewSql.value = options ? await buildDropTableChildObjectSql(options).catch(() => "") : "";
}

function openObjectSourceDialog(initialEditing: boolean) {
  const node = activeNode.value;
  if (!node.connectionId || !node.database) return;
  const objectType = objectSourceKindForTreeNode(node.type);
  if (!objectType) return;
  void connectionStore
    .ensureConnected(node.connectionId)
    .then(() => {
      connectionStore.activeConnectionId = node.connectionId!;
      emit("open-object-source", node, initialEditing);
    })
    .catch((e: any) => {
      toast(e?.message || String(e), 5000);
    });
}

function openProcedureExecution() {
  const node = activeNode.value;
  if (node.type !== "procedure" || !node.connectionId || !node.database) return;
  emit("open-procedure", node);
}

function requestDropObject() {
  void refreshDropObjectPreviewSql();
  showDropObjectConfirm.value = true;
}

function requestDropTableChildObject() {
  if (!canDropTableChildObject.value) return;
  void refreshDropTableChildObjectPreviewSql();
  showDropTableChildObjectConfirm.value = true;
}

function canDropTreeNode(node: TreeNode): boolean {
  if (isSqlServerLinkedNode(node)) return false;
  if (node.type === "table") return !!node.connectionId && !!node.database;
  if (node.type === "view" || node.type === "materialized_view" || node.type === "procedure" || node.type === "function") {
    return !!node.connectionId && !!node.database && !!dropObjectSqlOptionsForNode(node);
  }
  if (canDropMongoIndexNode(node)) return true;
  return canDropTableChildObjectNode(node);
}

function droppedTableObjectTypeForNode(node: TreeNode): "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | null {
  if (node.type === "table") return "TABLE";
  if (node.type === "view") return "VIEW";
  if (node.type === "materialized_view") return "MATERIALIZED_VIEW";
  return null;
}

function closeDroppedTableObjectTabsForNode(node: TreeNode) {
  const objectType = droppedTableObjectTypeForNode(node);
  if (!objectType || !node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  const dataTabSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
  queryStore.closeDroppedTableObjectTabs({
    connectionId: node.connectionId,
    database: node.database,
    schema: dataTabSchema,
    schemaCandidates: [node.schema, dataTabSchema],
    name: node.label,
    objectType,
  });
}

function tableDataRefreshTargetForNode(node: TreeNode) {
  if (!node.connectionId || !node.database) return null;
  const config = connectionStore.getConfig(node.connectionId);
  const dataTabSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
  return {
    connectionId: node.connectionId,
    database: node.database,
    schema: dataTabSchema,
    schemaCandidates: [node.schema, dataTabSchema],
    catalog: node.catalog,
    name: node.label,
  };
}

async function refreshMutatedTableDataTabsForNode(node: TreeNode) {
  const target = tableDataRefreshTargetForNode(node);
  if (!target) return;
  try {
    await queryStore.refreshDataTabsForTable(target);
  } catch (error) {
    console.warn("[DBX][table-data-refresh-after-mutation:error]", { target, error });
  }
}

async function refreshMutatedTableDataTabsForNodes(nodes: readonly TreeNode[]) {
  for (const target of nodes) {
    await refreshMutatedTableDataTabsForNode(target);
  }
}

function selectedBatchDropTargets(): TreeNode[] {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length <= 1 || !selected.some((node) => node.id === activeNode.value.id)) return [];
  const first = selected[0];
  if (!first?.connectionId || !first.database || !selected.every((node) => node.type === first.type)) return [];
  if (!selected.every((node) => node.connectionId === first.connectionId && node.database === first.database && canDropTreeNode(node))) {
    return [];
  }
  return selected;
}

function selectedBatchTableTargets(): TreeNode[] {
  const targets = selectedBatchDropTargets();
  return targets.length > 1 && targets.every((node) => node.type === "table") ? targets : [];
}

function selectedBatchTruncateTargets(): TreeNode[] {
  const targets = selectedBatchTableTargets();
  return targets.every((node) => supportsTableTruncate(databaseTypeForNode(node))) ? targets : [];
}

function selectedBatchEmptyTargets(): TreeNode[] {
  return selectedBatchTableTargets();
}

function selectedBatchIndexTableName(targets: TreeNode[]): string | null {
  const first = targets[0];
  if (!first) return null;
  const table = first.tableName || first.label;
  return table && targets.every((node) => (node.tableName || node.label) === table) ? table : null;
}

function batchDropMenuLabel(): string {
  const targets = selectedBatchDropTargets();
  if (targets.length > 1 && targets.every((node) => node.type === "index")) {
    return t("contextMenu.batchDropIndexes", { count: targets.length });
  }
  return t("contextMenu.batchDrop", { count: targets.length });
}

function batchDropConfirmTitle(): string {
  const targets = batchDropTargets.value;
  if (targets.length > 1 && targets.every((node) => node.type === "index")) {
    return t("contextMenu.confirmDropIndexTitle");
  }
  return t("contextMenu.confirmBatchDropTitle", { count: targets.length });
}

function batchDropConfirmMessage(): string {
  const targets = batchDropTargets.value;
  const table = selectedBatchIndexTableName(targets);
  if (targets.length > 1 && targets.every((node) => node.type === "index") && table) {
    return t("contextMenu.confirmDropBatchIndexesMessage", { count: targets.length, table });
  }
  return t("contextMenu.confirmBatchDropMessage", { count: targets.length });
}

function batchTruncateMenuLabel(): string {
  return t("contextMenu.batchTruncate", { count: selectedBatchTruncateTargets().length });
}

function batchEmptyMenuLabel(): string {
  return t("contextMenu.batchEmpty", { count: selectedBatchEmptyTargets().length });
}

function batchEmptyConfirmTitle(): string {
  return t("contextMenu.confirmBatchEmptyTitle", { count: batchEmptyTargets.value.length });
}

function batchEmptyConfirmMessage(): string {
  return t("contextMenu.confirmBatchEmptyMessage", { count: batchEmptyTargets.value.length });
}

function batchEmptyConfirmLabel(): string {
  return t("contextMenu.batchEmpty", { count: batchEmptyTargets.value.length });
}

function batchTruncateConfirmTitle(): string {
  return t("contextMenu.confirmBatchTruncateTitle", { count: batchTruncateTargets.value.length });
}

function batchTruncateConfirmMessage(): string {
  return t("contextMenu.confirmBatchTruncateMessage", { count: batchTruncateTargets.value.length });
}

async function dropSqlForTreeNode(node: TreeNode, options?: { cascade?: boolean }): Promise<string | null> {
  if (node.type === "table" && node.connectionId && node.database) {
    return buildDropTableSql({
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
      cascade: options?.cascade && supportsDropTableCascade(databaseTypeForNode(node)),
    });
  }
  const objectOptions = dropObjectSqlOptionsForNode(node);
  if (objectOptions) return buildDropObjectSql(objectOptions);
  if (canDropMongoIndexNode(node)) {
    return `db.getCollection("${(node.tableName || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}").dropIndex(${JSON.stringify(mongoIndexNameForNode(node))})`;
  }
  const childOptions = dropTableChildObjectSqlOptionsForNode(node);
  if (childOptions && canDropTableChildObjectNode(node)) return buildDropTableChildObjectSql(childOptions);
  return null;
}

async function truncateSqlForTreeNode(node: TreeNode, options?: { cascade?: boolean }): Promise<string | null> {
  if (node.type !== "table" || !node.connectionId || !node.database || !supportsTableTruncate(databaseTypeForNode(node))) return null;
  return buildTruncateTableSql({
    databaseType: databaseTypeForNode(node),
    schema: node.schema,
    tableName: node.label,
    cascade: options?.cascade && supportsTruncateTableCascade(databaseTypeForNode(node)),
  });
}

async function emptySqlForTreeNode(node: TreeNode): Promise<string | null> {
  if (node.type !== "table" || !node.connectionId || !node.database) return null;
  return buildEmptyTableSql({
    databaseType: databaseTypeForNode(node),
    schema: node.schema,
    tableName: node.label,
  });
}

async function refreshBatchDropPreviewSql() {
  const targets = batchDropTargets.value;
  const mongoIndexTargets = targets.filter(canDropMongoIndexNode);
  if (mongoIndexTargets.length) {
    batchDropPreviewSql.value = mongoIndexTargets.map((target) => mongoIndexDropPreview(target, mongoIndexNameForNode(target))).join("\n");
    return;
  }
  const statements: string[] = [];
  const useCascade = canBatchDropCascade.value && batchDropCascade.value;
  for (const target of targets) {
    const sql = await dropSqlForTreeNode(target, { cascade: useCascade });
    if (sql) statements.push(sql);
  }
  batchDropPreviewSql.value = statements.join("\n");
}

async function refreshBatchTruncatePreviewSql() {
  const targets = batchTruncateTargets.value;
  const statements: string[] = [];
  const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
  for (const target of targets) {
    const sql = await truncateSqlForTreeNode(target, { cascade: useCascade });
    if (sql) statements.push(sql);
  }
  batchTruncatePreviewSql.value = statements.join("\n");
}

async function refreshBatchEmptyPreviewSql(targets: TreeNode[]) {
  const statements: string[] = [];
  for (const target of targets) {
    const sql = await emptySqlForTreeNode(target);
    if (sql) statements.push(sql);
  }
  batchEmptyPreviewSql.value = statements.join("\n");
}

function requestBatchDrop() {
  const targets = selectedBatchDropTargets();
  if (!targets.length) return;
  batchDropTargets.value = targets.slice();
  batchDropCascade.value = false;
  void refreshBatchDropPreviewSql();
  showBatchDropConfirm.value = true;
}

function requestBatchTruncate() {
  const targets = selectedBatchTruncateTargets();
  if (!targets.length) return;
  batchTruncateTargets.value = targets.slice();
  batchTruncateCascade.value = false;
  void refreshBatchTruncatePreviewSql();
  showBatchTruncateConfirm.value = true;
}

function requestBatchEmpty() {
  const targets = selectedBatchEmptyTargets();
  if (!targets.length) return;
  batchEmptyTargets.value = targets.slice();
  batchEmptyPreviewSql.value = "";
  void refreshBatchEmptyPreviewSql(batchEmptyTargets.value)
    .then(() => {
      if (!batchEmptyPreviewSql.value.trim()) throw new Error("Empty table SQL preview is unavailable");
      showBatchEmptyConfirm.value = true;
    })
    .catch((e: any) => {
      batchEmptyTargets.value = [];
      toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
    });
}

function requestDropSelectedNodes(): boolean {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length > 1 && selected.some((node) => node.id === activeNode.value.id)) {
    if (!selectedBatchDropTargets().length) return false;
    requestBatchDrop();
    return true;
  }
  return requestDropSelectedNode();
}

function requestDropSelectedNode(): boolean {
  if (activeNode.value.type === "table") {
    dropTable();
    return true;
  }
  if (activeNode.value.type === "view" || activeNode.value.type === "procedure" || activeNode.value.type === "function") {
    requestDropObject();
    return true;
  }
  if (canDropMongoIndex.value) {
    dropMongoIndex();
    return true;
  }
  if (canDropTableChildObject.value) {
    requestDropTableChildObject();
    return true;
  }
  return false;
}

function nodeRenameObjectType(): RenameableObjectType | null {
  if (activeNode.value.type === "table") return "TABLE";
  if (activeNode.value.type === "view") return "VIEW";
  if (activeNode.value.type === "materialized_view") return "MATERIALIZED_VIEW";
  if (activeNode.value.type === "procedure") return "PROCEDURE";
  if (activeNode.value.type === "function") return "FUNCTION";
  return null;
}

const canRenameObject = computed(() => {
  const objectType = nodeRenameObjectType();
  return !!objectType && (supportsObjectRename(currentDatabaseType(), objectType) || supportsSourceBackedRoutineRename(currentDatabaseType(), objectType as any));
});

function openRenameObjectDialog() {
  claimTreeItemDialogOwnership();
  routeTreeItemDialogController();
  renameObjectName.value = activeNode.value.label;
  renameObjectError.value = "";
  renameObjectPreviewSql.value = "";
  showRenameObjectDialog.value = true;
}

async function executeTreeNodeSqlWithProductionGuard(node: Pick<TreeNode, "connectionId" | "database" | "schema">, sql: string, options: { database?: string; schema?: string } = {}) {
  if (!node.connectionId) return undefined;
  const database = options.database ?? node.database ?? "";
  return executeWithProductionSqlGuard({
    connection: connectionStore.getConfig(node.connectionId),
    database,
    sql,
    source: t("production.sourceSidebar"),
    execute: () => api.executeQuery(node.connectionId!, database, sql, options.schema ?? node.schema),
  });
}

let renameObjectPreviewRequestId = 0;

async function refreshRenameObjectPreviewSql() {
  const node = activeNode.value;
  const requestId = ++renameObjectPreviewRequestId;
  const objectType = nodeRenameObjectType();
  const newName = renameObjectName.value.trim();
  if (!showRenameObjectDialog.value || !objectType || !newName || newName === node.label) {
    renameObjectPreviewSql.value = "";
    return;
  }
  if (supportsSourceBackedRoutineRename(currentDatabaseType(), objectType as any)) {
    renameObjectPreviewSql.value = `-- Recreate ${objectType} from source, then drop the original object.`;
    return;
  }
  try {
    const sql = await buildRenameObjectSql({
      databaseType: currentDatabaseType(),
      objectType,
      schema: node.schema,
      oldName: node.label,
      newName,
    });
    if (requestId === renameObjectPreviewRequestId) renameObjectPreviewSql.value = sql;
  } catch {
    if (requestId === renameObjectPreviewRequestId) renameObjectPreviewSql.value = "";
  }
}

watch([showRenameObjectDialog, renameObjectName, () => activeNode.value.label, () => activeNode.value.schema, () => activeNode.value.type, () => currentDatabaseType()], () => {
  void refreshRenameObjectPreviewSql();
});

async function confirmRenameObject() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const objectType = node.type === "table" ? "TABLE" : node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : node.type === "procedure" ? "PROCEDURE" : node.type === "function" ? "FUNCTION" : null;
  const newName = renameObjectName.value.trim();
  if (!objectType || !newName || newName === node.label || !node.connectionId || !node.database) return;
  renameObjectError.value = "";
  try {
    const dbType = databaseTypeForNode(node);
    await connectionStore.ensureConnected(node.connectionId);
    if (supportsSourceBackedRoutineRename(dbType, objectType as any)) {
      const schema = node.schema || node.database;
      const source = await api.getObjectSource(node.connectionId, node.database, schema, node.objectName || node.label, objectType as any, node.signature);
      const statements = await buildRoutineRenameObjectSourceStatements({
        databaseType: dbType!,
        objectType: objectType as any,
        schema,
        name: node.label,
        newName,
        source: source.source,
      });
      for (const sql of statements) {
        await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema });
      }
    } else {
      const sql = await buildRenameObjectSql({
        databaseType: dbType,
        objectType,
        schema: node.schema,
        oldName: node.label,
        newName,
      });
      await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
    }
    toast(t("contextMenu.renameObjectSuccess", { oldName: node.label, newName }), 3000);
    showRenameObjectDialog.value = false;
    await refreshTableList(node);
  } catch (e: any) {
    renameObjectError.value = e?.message || String(e);
  }
}

async function confirmDropObject() {
  const node = sidebarDangerTarget.value ?? activeNode.value;
  if (!node.connectionId || !node.database) return;
  const options = dropObjectSqlOptionsForNode(node);
  if (!options) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = dropObjectPreviewSql.value || (await buildDropObjectSql(options));
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
    const msgKey = node.type === "view" ? "contextMenu.dropViewSuccess" : node.type === "materialized_view" ? "contextMenu.dropViewSuccess" : node.type === "procedure" ? "contextMenu.dropProcedureSuccess" : "contextMenu.dropFunctionSuccess";
    toast(t(msgKey, { name: node.label }), 3000);
    closeDroppedTableObjectTabsForNode(node);
    if (node.type === "view" || node.type === "materialized_view") {
      connectionStore.removeTreeNode(node.id);
      releaseActiveNodeReference([node.id]);
    } else {
      await refreshTableList(node);
    }
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmDropTableChildObject() {
  const node = sidebarDangerTarget.value ?? activeNode.value;
  if (!node.connectionId || !node.database) return;
  const options = dropTableChildObjectSqlOptionsForNode(node);
  if (!options) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = dropTableChildObjectPreviewSql.value || (await buildDropTableChildObjectSql(options));
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
    toast(t("contextMenu.dropTableChildObjectSuccess", { name: options.name }), 3000);
    connectionStore.removeTreeNode(node.id);
    releaseActiveNodeReference([node.id]);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmBatchDrop() {
  const targets = batchDropTargets.value.slice();
  if (!targets.length) return;
  try {
    const mongoIndexTargets = targets.filter(canDropMongoIndexNode);
    if (mongoIndexTargets.length) {
      const grouped = new Map<string, TreeNode[]>();
      for (const target of mongoIndexTargets) {
        const key = `${target.connectionId}:${target.database}:${target.tableName || ""}`;
        const list = grouped.get(key) ?? [];
        list.push(target);
        grouped.set(key, list);
      }
      let droppedCount = 0;
      for (const groupTargets of grouped.values()) {
        const first = groupTargets[0];
        if (!first?.connectionId || !first.database || !first.tableName) continue;
        await connectionStore.ensureConnected(first.connectionId);
        const names = groupTargets.map((target) => mongoIndexNameForNode(target));
        const result = await api.mongoDropIndexes(first.connectionId, first.database, first.tableName, JSON.stringify(names.length === 1 ? names[0] : names), false);
        const dropped = new Set(result.dropped_names);
        droppedCount += result.dropped_names.length;
        for (const target of groupTargets) {
          if (!dropped.has(mongoIndexNameForNode(target))) continue;
          connectionStore.removeTreeNode(target.id);
          releaseActiveNodeReference([target.id]);
        }
      }
      toast(t("contextMenu.batchDropSuccess", { count: droppedCount }), 3000);
      showBatchDropConfirm.value = false;
      return;
    }
    const useCascade = batchDropCascade.value && targets.every((node) => node.type !== "table" || supportsDropTableCascade(databaseTypeForNode(node)));
    for (const target of targets) {
      if (!target.connectionId || !target.database) continue;
      await connectionStore.ensureConnected(target.connectionId);
      const sql = await dropSqlForTreeNode(target, { cascade: useCascade });
      if (!sql) continue;
      await executeTreeNodeSqlWithProductionGuard(target, sql, { database: target.database, schema: target.schema });
      closeDroppedTableObjectTabsForNode(target);
      connectionStore.removeTreeNode(target.id);
      releaseActiveNodeReference([target.id]);
    }
    toast(t("contextMenu.batchDropSuccess", { count: targets.length }), 3000);
    showBatchDropConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmBatchTruncate() {
  const targets = batchTruncateTargets.value.slice();
  if (!targets.length) return;
  try {
    const useCascade = batchTruncateCascade.value && targets.every((node) => supportsTruncateTableCascade(databaseTypeForNode(node)));
    await runBatchTableTruncate(
      targets,
      async (target) => {
        if (!target.connectionId || !target.database) return false;
        await connectionStore.ensureConnected(target.connectionId);
        const sql = await truncateSqlForTreeNode(target, { cascade: useCascade });
        if (!sql) return false;
        const result = await executeTreeNodeSqlWithProductionGuard(target, sql, { database: target.database, schema: target.schema });
        return result === undefined ? false : undefined;
      },
      refreshMutatedTableDataTabsForNodes,
    );
    toast(t("contextMenu.batchTruncateSuccess", { count: targets.length }), 3000);
    showBatchTruncateConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmBatchEmpty() {
  const targets = batchEmptyTargets.value.slice();
  if (!targets.length) return;
  const asynchronousMutation = targets.every((target) => databaseTypeForNode(target) === "clickhouse");
  const result = await runBatchTableEmpty(targets, async (target) => {
    if (!target.connectionId || !target.database) throw new Error("Missing table connection context");
    await connectionStore.ensureConnected(target.connectionId);
    const sql = await emptySqlForTreeNode(target);
    if (!sql) throw new Error("Empty table SQL is unavailable");
    await executeTreeNodeSqlWithProductionGuard(target, sql, { database: target.database, schema: target.schema });
  });
  for (const failure of result.failed) {
    console.error(`Failed to empty table "${failure.target.label}":`, failure.error);
  }
  const feedback = batchTableEmptyFeedback(result, asynchronousMutation);
  if (feedback === "success") {
    toast(t("contextMenu.batchEmptySuccess", { count: result.succeeded.length }), 3000);
  } else if (feedback === "submitted") {
    toast(t("contextMenu.batchEmptySubmitted", { count: result.succeeded.length }), 3000);
  } else if (feedback === "submitted-partial") {
    toast(t("contextMenu.batchEmptySubmittedPartial", { success: result.succeeded.length, failed: result.failed.length }), 5000);
  } else {
    toast(t("contextMenu.batchEmptyPartialFail", { success: result.succeeded.length, failed: result.failed.length }), 5000);
  }
  await refreshMutatedTableDataTabsForNodes(result.succeeded);
  batchEmptyTargets.value = [];
  showBatchEmptyConfirm.value = false;
}

const canCreateTable = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return (activeNode.value.type === "database" || activeNode.value.type === "schema" || activeNode.value.type === "group-tables") && !isSqlServerLinkedNode(activeNode.value) && !!activeNode.value.database && supportsTableStructureEditing(tableStructureDatabaseTypeForConnection(config));
});

const canCreateDatabase = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "connection" && canCreateConnectionNamespace(config);
});

const canCreateNacosNamespace = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "connection" && config?.db_type === "nacos" && !config.read_only;
});

const canEditNacosNamespace = computed(() => {
  if (activeNode.value.type !== "nacos-namespace" || !activeNode.value.connectionId || !activeNode.value.nacosNamespace) return false;
  const config = connectionStore.getConfig(activeNode.value.connectionId);
  return config?.db_type === "nacos" && !config.read_only;
});

const isDuckDbConnection = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "connection" && config?.db_type === "duckdb" && connectionNamespaceCreationTarget(config) === "attach";
});

const isSqliteAttachConnection = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "connection" && config?.db_type === "sqlite" && connectionNamespaceCreationTarget(config) === "attach";
});

const isConnectionSchemaCreation = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "connection" && connectionNamespaceCreationTarget(config) === "schema";
});

const canSetCreateDatabaseCharset = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return connectionNamespaceCreationTarget(config) === "database" && supportsCreateDatabaseCharset(config?.db_type, config?.driver_profile);
});

const canDropDatabase = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "database" && !isSqlServerLinkedNode(activeNode.value) && supportsDatabaseCreation(config?.db_type);
});

const databasePropertyGroups = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return editableDatabasePropertyGroups(config, activeNode.value);
});

const canEditDatabaseProperties = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return canEditDatabasePropertiesForNode(config, activeNode.value) && !isSqlServerLinkedNode(activeNode.value);
});

const canEditDatabaseCharsetCollation = computed(() => databasePropertyGroups.value.includes("charsetCollation"));

const canEditDatabaseComment = computed(() => databasePropertyGroups.value.includes("databaseComment"));

const canCreateSchema = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return canCreateDatabaseNodeNamespace(config, activeNode.value) && !isSqlServerLinkedNode(activeNode.value) && !connectionUsesDatabaseObjectTreeMode(config);
});

const canDropSchema = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "schema" && !isSqlServerLinkedNode(activeNode.value) && usesTreeSchemaMode(effectiveDatabaseTypeForConnection(config)) && !connectionUsesDatabaseObjectTreeMode(config);
});

const canEditSchemaComment = computed(() => {
  const config = activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId) : undefined;
  return activeNode.value.type === "schema" && !!activeNode.value.database && !config?.read_only && supportsSchemaComment(effectiveDatabaseTypeForConnection(config));
});

const canBatchDropCascade = computed(() => {
  const targets = selectedBatchTableTargets();
  return targets.length > 1 && targets.every((node) => supportsDropTableCascade(databaseTypeForNode(node)));
});

const canBatchTruncateCascade = computed(() => {
  const targets = selectedBatchTruncateTargets();
  return targets.length > 1 && targets.every((node) => supportsTruncateTableCascade(databaseTypeForNode(node)));
});

async function refreshDropDatabasePreviewSql() {
  const node = activeNode.value;
  if (node.type === "mongo-db") {
    dropDatabasePreviewSql.value = `db.getSiblingDB(${JSON.stringify(node.label)}).dropDatabase();`;
    return;
  }
  dropDatabasePreviewSql.value = "";
  dropDatabasePreviewSql.value = await buildDropDatabaseSql({
    databaseType: currentDatabaseType(),
    name: node.label,
  }).catch(() => "");
}

async function refreshDropSchemaPreviewSql() {
  const node = activeNode.value;
  dropSchemaPreviewSql.value = "";
  dropSchemaPreviewSql.value = await buildDropSchemaSql({
    databaseType: currentDatabaseType(),
    name: node.label,
  }).catch(() => "");
}

function databasePropertyName(): string {
  return activeNode.value.database || activeNode.value.label;
}

function resultColumnValue(result: { columns?: string[]; rows?: unknown[] }, names: string[]): string {
  const firstRow = result.rows?.[0];
  if (Array.isArray(firstRow)) {
    const lowerNames = names.map((name) => name.toLowerCase());
    const index = Math.max(0, result.columns?.findIndex((column) => lowerNames.includes(column.toLowerCase())) ?? 0);
    return firstRow[index] == null ? "" : String(firstRow[index]);
  }
  if (firstRow && typeof firstRow === "object") {
    const record = firstRow as Record<string, unknown>;
    const key = Object.keys(record).find((column) => names.some((name) => name.toLowerCase() === column.toLowerCase()));
    const value = key ? record[key] : undefined;
    return value == null ? "" : String(value);
  }
  return "";
}

function databasePropertyEditOptions() {
  if (!canEditDatabaseProperties.value) return null;
  const base = {
    databaseType: currentDatabaseType(),
    driverProfile: activeNode.value.connectionId ? connectionStore.getConfig(activeNode.value.connectionId)?.driver_profile : undefined,
    target: "database" as const,
    name: databasePropertyName(),
  };
  if (canEditDatabaseCharsetCollation.value) {
    return {
      ...base,
      charset: editDatabaseCharset.value,
      collation: editDatabaseCollation.value,
    };
  }
  if (canEditDatabaseComment.value) {
    return {
      ...base,
      comment: editDatabaseCommentText.value,
    };
  }
  return null;
}

async function refreshEditDatabasePropertiesPreviewSql() {
  editDatabasePropertiesPreviewSql.value = "";
  const options = databasePropertyEditOptions();
  if (!options) return;
  editDatabasePropertiesPreviewSql.value = await buildUpdateDatabasePropertiesSql(options).catch(() => "");
}

async function loadDatabaseCharsetProperties() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  const sql = `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${databasePropertyName().replace(/'/g, "''")}';`;
  const result = await api.executeQuery(node.connectionId, databasePropertyName(), sql, undefined, undefined, { maxRows: 1 });
  const charset = resultColumnValue(result, ["charset", "DEFAULT_CHARACTER_SET_NAME"]);
  const collation = resultColumnValue(result, ["collation", "DEFAULT_COLLATION_NAME"]);
  if (charset) editDatabaseCharset.value = charset;
  if (collation) editDatabaseCollation.value = collation;
}

async function loadDatabaseCommentProperty() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  const sql = buildGetDatabaseCommentSql({
    databaseType: currentDatabaseType(),
    name: databasePropertyName(),
  });
  const result = await api.executeQuery(node.connectionId, databasePropertyName(), sql, undefined, undefined, { maxRows: 1 });
  editDatabaseCommentText.value = resultColumnValue(result, ["comment"]);
}

async function openEditDatabasePropertiesDialog() {
  const node = activeNode.value;
  if (!canEditDatabaseProperties.value || !node.connectionId) return;
  editDatabasePropertiesLoading.value = true;
  editDatabaseCharset.value = "utf8mb4";
  editDatabaseCollation.value = "utf8mb4_unicode_ci";
  editDatabaseCommentText.value = "";
  editDatabasePropertiesPreviewSql.value = "";
  createDatabaseCharsetOptions.value = fallbackCreateDatabaseCharset.charsets;
  createDatabaseCollationsByCharset.value = fallbackCreateDatabaseCharset.collationsByCharset;
  showEditDatabasePropertiesDialog.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    if (canEditDatabaseCharsetCollation.value) {
      await loadCreateDatabaseCharsetMetadata("edit");
      await loadDatabaseCharsetProperties().catch(() => undefined);
    } else if (canEditDatabaseComment.value) {
      await loadDatabaseCommentProperty().catch(() => undefined);
    }
    await refreshEditDatabasePropertiesPreviewSql();
  } finally {
    editDatabasePropertiesLoading.value = false;
  }
}

async function confirmEditDatabaseProperties() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const config = node.connectionId ? connectionStore.getConfig(node.connectionId) : undefined;
  const propertyGroups = editableDatabasePropertyGroups(config, node);
  if (!propertyGroups.length || !node.connectionId || editDatabasePropertiesLoading.value) return;
  editDatabasePropertiesLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const base = {
      databaseType: databaseTypeForNode(node),
      driverProfile: config?.driver_profile,
      target: "database" as const,
      name: node.database || node.label,
    };
    const options = propertyGroups.includes("charsetCollation") ? { ...base, charset: editDatabaseCharset.value, collation: editDatabaseCollation.value } : propertyGroups.includes("databaseComment") ? { ...base, comment: editDatabaseCommentText.value } : null;
    if (!options) return;
    const sql = await buildUpdateDatabasePropertiesSql(options);
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database || node.label });
    toast(t("contextMenu.editDatabasePropertiesSuccess", { name: node.label }), 3000);
    showEditDatabasePropertiesDialog.value = false;
    await connectionStore.loadDatabases(node.connectionId, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    editDatabasePropertiesLoading.value = false;
  }
}

watch([editDatabaseCharset, editDatabaseCollation, editDatabaseCommentText], () => {
  if (showEditDatabasePropertiesDialog.value) void refreshEditDatabasePropertiesPreviewSql();
});

async function refreshSchemaCommentPreviewSql() {
  const node = activeNode.value;
  if (!canEditSchemaComment.value) {
    schemaCommentPreviewSql.value = "";
    return;
  }
  schemaCommentPreviewSql.value = await buildUpdateDatabasePropertiesSql({
    databaseType: currentDatabaseType(),
    target: "schema",
    name: node.schema || node.label,
    comment: schemaCommentText.value,
  }).catch(() => "");
}

watch(schemaCommentText, () => {
  if (showEditSchemaCommentDialog.value) void refreshSchemaCommentPreviewSql();
});

function schemaCommentFromResult(result: { columns?: string[]; rows?: unknown[] }): string {
  return resultColumnValue(result, ["comment"]);
}

async function openEditSchemaCommentDialog() {
  const node = activeNode.value;
  if (!canEditSchemaComment.value || !node.connectionId || !node.database) return;
  schemaCommentText.value = "";
  schemaCommentLoading.value = true;
  showEditSchemaCommentDialog.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = buildGetSchemaCommentSql({
      databaseType: currentDatabaseType(),
      name: node.schema || node.label,
    });
    const result = await api.executeQuery(node.connectionId, node.database, sql, node.schema, undefined, { maxRows: 1 });
    schemaCommentText.value = schemaCommentFromResult(result);
    await refreshSchemaCommentPreviewSql();
  } catch {
    schemaCommentText.value = "";
    await refreshSchemaCommentPreviewSql();
  } finally {
    schemaCommentLoading.value = false;
  }
}

async function confirmEditSchemaComment() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  if (!canEditSchemaComment.value || !node.connectionId || !node.database || schemaCommentLoading.value) return;
  schemaCommentLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = await buildUpdateDatabasePropertiesSql({
      databaseType: databaseTypeForNode(node),
      target: "schema",
      name: node.schema || node.label,
      comment: schemaCommentText.value,
    });
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
    toast(t("contextMenu.editSchemaCommentSuccess", { name: node.label }), 3000);
    showEditSchemaCommentDialog.value = false;
    await connectionStore.loadSchemas(node.connectionId, node.database, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    schemaCommentLoading.value = false;
  }
}

async function openCreateDatabase() {
  if (isDuckDbConnection.value) {
    await createDuckDbAttachedDatabaseFile();
    return;
  }
  if (isSqliteAttachConnection.value) {
    await attachSqliteDatabaseFile();
    return;
  }
  openCreateDatabaseDialog();
}

function openCreateDatabaseDialog() {
  createDatabaseName.value = "";
  createDatabaseCharset.value = "utf8mb4";
  createDatabaseCollation.value = "utf8mb4_unicode_ci";
  createDatabaseUsers.value = [];
  createDatabaseSelectedUsers.value = [];
  createDatabaseUsersLoading.value = false;
  createDatabaseAuthorizationPlan.value = undefined;
  createDatabasePreviewSql.value = "";
  createDatabaseAuthorizationResults.value = [];
  createDatabaseCharsetOptions.value = fallbackCreateDatabaseCharset.charsets;
  createDatabaseCollationsByCharset.value = fallbackCreateDatabaseCharset.collationsByCharset;
  showCreateDatabaseDialog.value = true;
  if (canSetCreateDatabaseCharset.value) {
    void loadCreateDatabaseCharsetMetadata();
  }
  void loadCreateDatabaseUsers();
}

let createDatabaseUsersRequestId = 0;

async function loadCreateDatabaseUsers() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  if (!node.connectionId) return;
  const connectionId = node.connectionId;
  const requestId = ++createDatabaseUsersRequestId;
  const requestOwner = sidebarTreeDialogOwner.value;
  const requestIsActive = () => requestId === createDatabaseUsersRequestId && sidebarTreeDialogOwner.value === requestOwner && sidebarFormTarget.value?.connectionId === connectionId && showCreateDatabaseDialog.value;
  const config = connectionStore.getConfig(node.connectionId);
  const userProvider = resolveDatabaseUserAdminProviderForConnection(config);
  if (!userProvider) return;
  createDatabaseUsersLoading.value = true;
  try {
    await connectionStore.ensureConnected(connectionId);
    try {
      const result = await api.executeQuery(connectionId, "", userProvider.listUsersSql(), undefined, undefined, { maxRows: 5000 });
      if (requestIsActive()) createDatabaseUsers.value = userProvider.parseUsers(result);
    } catch (error) {
      if (!userProvider.fallbackListUsersSql || !userProvider.parseFallbackUsers) throw error;
      const result = await api.executeQuery(connectionId, "", userProvider.fallbackListUsersSql(), undefined, undefined, { maxRows: 5000 });
      if (requestIsActive()) createDatabaseUsers.value = userProvider.parseFallbackUsers(result);
    }
  } catch (error: any) {
    if (requestIsActive()) {
      createDatabaseUsers.value = [];
      toast(t("contextMenu.createDatabaseUsersLoadFailed", { message: error?.message || String(error) }), 5000);
    }
  } finally {
    if (requestIsActive()) createDatabaseUsersLoading.value = false;
  }
}

function createDatabaseUserKey(user: DatabaseUserIdentity): string {
  return `${user.user}\u0000${user.host}`;
}

function createDatabaseUserLabel(user: DatabaseUserIdentity): string {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const provider = resolveDatabaseUserAdminProviderForConnection(connectionStore.getConfig(node.connectionId || ""));
  return provider?.label(user) ?? user.user;
}

function createDatabaseUserSelected(user: DatabaseUserIdentity): boolean {
  const key = createDatabaseUserKey(user);
  return createDatabaseSelectedUsers.value.some((selected) => createDatabaseUserKey(selected) === key);
}

function toggleCreateDatabaseUser(user: DatabaseUserIdentity) {
  const key = createDatabaseUserKey(user);
  if (createDatabaseSelectedUsers.value.some((selected) => createDatabaseUserKey(selected) === key)) {
    createDatabaseSelectedUsers.value = createDatabaseSelectedUsers.value.filter((selected) => createDatabaseUserKey(selected) !== key);
  } else {
    createDatabaseSelectedUsers.value = [...createDatabaseSelectedUsers.value, user];
  }
}

function openConnectionNamespaceCreation() {
  if (isConnectionSchemaCreation.value) {
    openCreateSchemaDialog();
    return;
  }
  void openCreateDatabase();
}

function connectionNamespaceCreationLabel() {
  if (isDuckDbConnection.value) return t("contextMenu.createDuckDbFile");
  if (isSqliteAttachConnection.value) return t("contextMenu.attachSqliteDatabase");
  if (isConnectionSchemaCreation.value) return t("contextMenu.createSchema");
  return t("contextMenu.createDatabase");
}

function updateCreateDatabaseCharset(value: string) {
  const previousCharset = createDatabaseCharset.value;
  createDatabaseCharset.value = value;
  createDatabaseCollation.value = nextCreateDatabaseCollation(value, previousCharset, createDatabaseCollation.value, createDatabaseCollationsByCharset.value);
}

function updateEditDatabaseCharset(value: string) {
  const previousCharset = editDatabaseCharset.value;
  editDatabaseCharset.value = value;
  editDatabaseCollation.value = nextCreateDatabaseCollation(value, previousCharset, editDatabaseCollation.value, createDatabaseCollationsByCharset.value);
}

async function loadCreateDatabaseCharsetMetadata(target: "create" | "edit" = "create") {
  const node = activeNode.value;
  if (!node.connectionId || createDatabaseCharsetLoading.value) return;
  createDatabaseCharsetLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const [charsetResult, collationResult] = await Promise.all([api.executeQuery(node.connectionId, "", "SHOW CHARACTER SET", undefined, undefined, { maxRows: 1000 }), api.executeQuery(node.connectionId, "", "SHOW COLLATION", undefined, undefined, { maxRows: 10000 })]);
    if (target === "create" && !showCreateDatabaseDialog.value) return;
    if (target === "edit" && !showEditDatabasePropertiesDialog.value) return;
    const metadata = parseCreateDatabaseCharsetMetadata(charsetResult, collationResult);
    createDatabaseCharsetOptions.value = metadata.charsets;
    createDatabaseCollationsByCharset.value = metadata.collationsByCharset;
    const selectedCharset = target === "create" ? createDatabaseCharset.value : editDatabaseCharset.value;
    if (!createDatabaseCharsetOptions.value.includes(selectedCharset) && createDatabaseCharsetOptions.value.length) {
      if (target === "create") {
        updateCreateDatabaseCharset(createDatabaseCharsetOptions.value[0]);
      } else {
        updateEditDatabaseCharset(createDatabaseCharsetOptions.value[0]);
      }
    } else {
      if (target === "create") {
        createDatabaseCollation.value = nextCreateDatabaseCollation(createDatabaseCharset.value, createDatabaseCharset.value, createDatabaseCollation.value, createDatabaseCollationsByCharset.value);
      } else {
        editDatabaseCollation.value = nextCreateDatabaseCollation(editDatabaseCharset.value, editDatabaseCharset.value, editDatabaseCollation.value, createDatabaseCollationsByCharset.value);
      }
    }
  } catch {
    createDatabaseCharsetOptions.value = fallbackCreateDatabaseCharset.charsets;
    createDatabaseCollationsByCharset.value = fallbackCreateDatabaseCharset.collationsByCharset;
  } finally {
    createDatabaseCharsetLoading.value = false;
  }
}

function ensureDuckDbFileExtension(path: string): string {
  return /\.(duckdb|db)$/i.test(path) ? path : `${path}.duckdb`;
}

async function createDuckDbAttachedDatabaseFile() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  if (!isTauriRuntime()) {
    toast(t("contextMenu.createDuckDbFileDesktopOnly"), 4000);
    return;
  }

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selectedPath = await save({
      defaultPath: "database.duckdb",
      filters: [{ name: "DuckDB", extensions: ["duckdb", "db"] }],
    });
    if (!selectedPath) return;

    const path = ensureDuckDbFileExtension(selectedPath);
    await connectionStore.ensureConnected(node.connectionId);
    const existingDatabases = await api.listDatabases(node.connectionId);
    const name = uniqueAttachedDatabaseName(
      attachedDatabaseNameFromPath(path, "duckdb_database"),
      existingDatabases.map((database) => database.name),
    );
    const sql = await buildDuckDbAttachDatabaseSql(path, name);
    const executionResult = await executeTreeNodeSqlWithProductionGuard(node, sql, { database: "" });
    if (executionResult === undefined) return;

    const config = connectionStore.getConfig(node.connectionId);
    if (config) {
      await connectionStore.updateConnection({
        ...config,
        attached_databases: [...(config.attached_databases ?? []), { name, path }],
      });
    }
    await connectionStore.ensureVisibleDatabase(node.connectionId, name);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
    connectionStore.selectedTreeNodeId = `${node.connectionId}:${name}`;
    toast(t("contextMenu.createDuckDbFileSuccess", { name }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function attachSqliteDatabaseFile() {
  const node = activeNode.value;
  if (!node.connectionId) return;
  if (!isTauriRuntime()) {
    toast(t("contextMenu.attachSqliteDatabaseDesktopOnly"), 4000);
    return;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      title: t("contextMenu.attachSqliteDatabase"),
      multiple: false,
      filters: [{ name: "SQLite", extensions: SQLITE_DATABASE_FILE_EXTENSIONS }],
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path || typeof path !== "string") return;

    await connectionStore.ensureConnected(node.connectionId);
    const existingDatabases = await api.listDatabases(node.connectionId);
    const name = uniqueAttachedDatabaseName(
      attachedDatabaseNameFromPath(path, "sqlite_database"),
      existingDatabases.map((database) => database.name),
      ["main", "temp"],
    );
    const sql = await buildSqliteAttachDatabaseSql(path, name);
    const executionResult = await executeTreeNodeSqlWithProductionGuard(node, sql, { database: "" });
    if (executionResult === undefined) return;

    const config = connectionStore.getConfig(node.connectionId);
    if (config) {
      await connectionStore.updateConnection({
        ...config,
        attached_databases: [...(config.attached_databases ?? []), { name, path }],
      });
    }
    await connectionStore.ensureVisibleDatabase(node.connectionId, name);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
    connectionStore.selectedTreeNodeId = `${node.connectionId}:${name}`;
    toast(t("contextMenu.attachSqliteDatabaseSuccess", { name }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmCreateDatabase() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const name = createDatabaseName.value.trim();
  if (!name || !node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const config = connectionStore.getConfig(node.connectionId);
    if (config?.db_type === "mongodb") {
      showCreateDatabaseDialog.value = false;
      await api.mongoCreateDatabase(node.connectionId, name);
      toast(t("contextMenu.createDatabaseSuccess", { name }), 3000);
      await connectionStore.ensureVisibleDatabase(node.connectionId, name);
      await connectionStore.loadMongoDatabases(node.connectionId);
      return;
    }
    const sql = await buildCreateDatabaseSql({
      databaseType: config?.db_type,
      driverProfile: config?.driver_profile,
      target: "database",
      name,
      charset: createDatabaseCharset.value,
      collation: createDatabaseCollation.value,
    });
    const provider = resolveDatabaseUserAdminProviderForConnection(config);
    const plan: AuthorizationPlan = provider
      ? buildCreateDatabaseAuthorizationPlan({ provider, database: name, createSql: sql, users: createDatabaseSelectedUsers.value })
      : { steps: [{ id: "create-database", label: `create database ${name}`, database: "", sql, operation: "createDatabase", targetDatabase: name }] };
    createDatabaseAuthorizationPlan.value = plan;
    createDatabasePreviewSql.value = authorizationPlanSql(plan);
    createDatabaseAuthorizationResults.value = [];
    showCreateDatabaseDialog.value = false;
    showCreateDatabasePreviewDialog.value = true;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function applyCreateDatabaseAuthorizationPlan() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const plan = createDatabaseAuthorizationPlan.value;
  const name = createDatabaseName.value.trim();
  if (!node.connectionId || !plan || createDatabaseAuthorizationApplying.value) return;
  createDatabaseAuthorizationApplying.value = true;
  try {
    const config = connectionStore.getConfig(node.connectionId);
    const results = await executeWithProductionSqlGuard({
      connection: config,
      database: "",
      sql: createDatabasePreviewSql.value,
      source: t("production.sourceSidebar"),
      execute: () => executeAuthorizationPlan(plan, (step) => api.executeMulti(node.connectionId!, step.database, step.sql, undefined, undefined, { maxRows: 1000, continueOnError: true })),
    });
    if (!results) return;
    const displayResults = results.map((result) => ({
      ...result,
      message: result.message && result.step.operation === "createDatabase" ? appendCreateDatabaseErrorHint(config?.db_type, result.message, t) : result.message,
    }));
    createDatabaseAuthorizationResults.value = displayResults;
    const created = displayResults.some((result) => result.step.id === "create-database" && result.status === "success");
    const status = authorizationPlanStatus(displayResults);
    if (created) {
      await connectionStore.ensureVisibleDatabase(node.connectionId, name);
      await connectionStore.loadDatabases(node.connectionId, { force: true });
    }
    toast(t(status === "success" ? "contextMenu.createDatabaseSuccess" : status === "partial" ? "contextMenu.createDatabasePartial" : "contextMenu.createDatabaseFailed", { name }), status === "success" ? 3000 : 5000);
  } catch (error: any) {
    const message = appendCreateDatabaseErrorHint(connectionStore.getConfig(node.connectionId)?.db_type, error?.message || String(error), t);
    toast(t("contextMenu.tableOperationFailed", { message }), 8000);
  } finally {
    createDatabaseAuthorizationApplying.value = false;
  }
}

function createDatabaseAuthorizationStepLabel(result: AuthorizationStepResult): string {
  const step = result.step;
  if (step.operation === "createDatabase") return t("contextMenu.createDatabaseStep", { database: step.targetDatabase });
  if (step.operation === "grantDatabase") return t("contextMenu.createDatabaseGrantStep", { user: step.subject, database: step.targetDatabase });
  if (step.operation === "grantCurrentObjects") {
    return t("userAdmin.stepGrantCurrentObjects", {
      user: step.subject,
      database: step.targetDatabase,
      schema: step.schema,
      scope: createDatabaseAuthorizationScopeLabel(step.objectScope),
    });
  }
  if (step.operation === "grantFutureObjects") {
    return step.owner
      ? t("userAdmin.stepGrantFutureObjectsForOwner", { user: step.subject, database: step.targetDatabase, owner: step.owner, scope: createDatabaseAuthorizationScopeLabel(step.objectScope) })
      : t("userAdmin.stepGrantFutureObjects", { user: step.subject, database: step.targetDatabase, scope: createDatabaseAuthorizationScopeLabel(step.objectScope) });
  }
  return step.label;
}

function createDatabaseAuthorizationScopeLabel(scope: AuthorizationStepResult["step"]["objectScope"]): string {
  if (scope === "schemas") return t("userAdmin.scopeSchemas");
  if (scope === "tables") return t("userAdmin.scopeTables");
  if (scope === "sequences") return t("userAdmin.scopeSequences");
  if (scope === "functions") return t("userAdmin.scopeFunctions");
  return "";
}

function dropDatabase() {
  void refreshDropDatabasePreviewSql();
  dropDatabaseLoading.value = false;
  showDropDatabaseConfirm.value = true;
}

async function confirmDropDatabase() {
  const node = sidebarDangerTarget.value ?? activeNode.value;
  if (!node.connectionId || dropDatabaseLoading.value) return;
  dropDatabaseLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    if (node.type === "mongo-db" && node.database) {
      await api.mongoDropDatabase(node.connectionId, node.database);
      toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
      await connectionStore.loadMongoDatabases(node.connectionId);
      showDropDatabaseConfirm.value = false;
      return;
    }
    const sql =
      dropDatabasePreviewSql.value ||
      (await buildDropDatabaseSql({
        databaseType: databaseTypeForNode(node),
        name: node.label,
      }));
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: "" });
    toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
    showDropDatabaseConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropDatabaseLoading.value = false;
  }
}

function openCreateSchemaDialog() {
  createSchemaName.value = "";
  showCreateSchemaDialog.value = true;
}

async function confirmCreateSchema() {
  const node = sidebarFormTarget.value ?? activeNode.value;
  const name = createSchemaName.value.trim();
  const config = node.connectionId ? connectionStore.getConfig(node.connectionId) : undefined;
  const isConnectionLevelSchemaCreation = node.type === "connection" && connectionNamespaceCreationTarget(config) === "schema";
  const targetDatabase = isConnectionLevelSchemaCreation ? "" : node.database;
  if (!name || !node.connectionId || (!targetDatabase && !isConnectionLevelSchemaCreation)) return;
  showCreateSchemaDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = await buildCreateSchemaSql({
      databaseType: effectiveDatabaseTypeForConnection(config),
      name,
    });
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: targetDatabase || "" });
    toast(t("contextMenu.createSchemaSuccess", { name }), 3000);
    if (isConnectionLevelSchemaCreation) {
      await connectionStore.loadDatabases(node.connectionId, { force: true });
    } else if (config?.db_type === "sqlserver") {
      await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, targetDatabase || "", { force: true });
    } else {
      await connectionStore.loadSchemas(node.connectionId, targetDatabase || "", { force: true });
    }
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function dropSchema() {
  void refreshDropSchemaPreviewSql();
  showDropSchemaConfirm.value = true;
}

async function confirmDropSchema() {
  const node = sidebarDangerTarget.value ?? activeNode.value;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql =
      dropSchemaPreviewSql.value ||
      (await buildDropSchemaSql({
        databaseType: databaseTypeForNode(node),
        name: node.label,
      }));
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database });
    toast(t("contextMenu.dropSchemaSuccess", { name: node.label }), 3000);
    const config = connectionStore.getConfig(node.connectionId);
    if (config?.db_type === "sqlserver") {
      await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, node.database, { force: true });
    } else {
      await connectionStore.loadSchemas(node.connectionId, node.database, { force: true });
    }
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function duplicateStructure(source: TreeNode = activeNode.value) {
  if (!isDuplicateStructureSource(source)) return;
  duplicateStructureSource.value = source;
  duplicateTableName.value = `${source.label}_copy`;
  showDuplicateDialog.value = true;
}

function isDuplicateStructureSource(node: TreeNode): node is DuplicateStructureSource {
  return node.type === "table" && !!node.connectionId && !!node.database;
}

async function confirmDuplicateStructure() {
  const node = duplicateStructureSource.value || (isDuplicateStructureSource(activeNode.value) ? activeNode.value : null);
  const newName = duplicateTableName.value.trim();
  if (!newName || !node) return;
  showDuplicateDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const databaseType = databaseTypeForNode(node);
    const sql = await buildDuplicateTableStructureSql({
      databaseType,
      schema: node.schema,
      sourceName: node.label,
      targetName: newName,
    });
    await executeTreeNodeSqlWithProductionGuard(node, sql, { database: node.database, schema: node.schema });
    toast(t("contextMenu.duplicateStructureSuccess", { name: newName }), 3000);
    await refreshTableList(node);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmPasteTable() {
  const entries = pasteTableEntries.value.filter((entry) => entry.targetName.trim());
  if (entries.length === 0) return;
  const mode = pasteTableMode.value;
  const copyData = pasteTableModeCopiesData(mode) && pasteTableDataCopySupported.value;
  showPasteDialog.value = false;
  let successCount = 0;
  let failCount = 0;
  const refreshedConnections = new Set<string>();
  for (const entry of entries) {
    const targetName = entry.targetName.trim();
    try {
      await connectionStore.ensureConnected(entry.connectionId);
      const databaseType = entry.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(entry.connectionId)) : undefined;
      if (mode === "structure-and-data" || mode === "structure-only") {
        const structureSql = await buildDuplicateTableStructureSql({
          databaseType,
          schema: entry.schema,
          sourceName: entry.sourceName,
          targetName,
        });
        await executeTreeNodeSqlWithProductionGuard(entry, structureSql, { database: entry.database, schema: entry.schema });
      }
      if (copyData) {
        const sourceColumns = await api.getColumns(entry.connectionId, entry.database, entry.schema || "", entry.sourceName);
        const dataCopyColumnOptions = tableDataCopyColumnOptions(databaseType, sourceColumns);
        if (dataCopyColumnOptions.columns.length === 0) {
          throw new Error("No writable columns available for table data copy.");
        }
        const dataSql = await buildCopyTableDataSql({
          databaseType,
          schema: entry.schema,
          sourceName: entry.sourceName,
          targetName,
          ...dataCopyColumnOptions,
        });
        await executeTreeNodeSqlWithProductionGuard(entry, dataSql, { database: entry.database, schema: entry.schema });
      }
      successCount++;
      const refreshKey = `${entry.connectionId}:${entry.database}:${entry.schema || ""}`;
      if (!refreshedConnections.has(refreshKey)) {
        refreshedConnections.add(refreshKey);
        await connectionStore.refreshObjectListTreeNode(entry.connectionId, entry.database, entry.schema);
      }
    } catch (e: any) {
      failCount++;
      console.error(`Failed to paste table "${entry.sourceName}" -> "${targetName}":`, e);
    }
  }
  if (failCount === 0) {
    toast(t("contextMenu.batchPasteSuccess", { count: successCount }), 3000);
  } else {
    toast(t("contextMenu.batchPastePartialFail", { success: successCount, failed: failCount }), 5000);
  }
}

function copyTableToClipboard() {
  const node = activeNode.value;
  if (node.type !== "table" || !node.connectionId || !node.database) return;
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: [
      {
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        tableName: node.label,
      },
    ],
  };
  toast(t("contextMenu.pasteTableClipboardUpdated"), 2000);
}

function openPasteTableDialog() {
  const clipboard = connectionStore.treeClipboard;
  if (clipboard?.kind !== "table-copy" || !canPasteTreeClipboardToCurrentNode()) {
    toast(t("contextMenu.noTableToPaste"), 2000);
    return;
  }
  pasteTableMode.value = defaultPasteTableMode(currentDatabaseType());
  pasteTableEntries.value = clipboard.tables.map((entry) => ({
    sourceName: entry.tableName,
    targetName: `${entry.tableName}_copy`,
    connectionId: entry.connectionId,
    database: entry.database,
    schema: entry.schema,
  }));
  showPasteDialog.value = true;
}

function createTable() {
  const node = activeNode.value;
  if (!node.connectionId || !node.database) return;
  queryStore.openTableStructure(node.connectionId, node.database, node.schema, "");
}

function createView() {
  const node = activeNode.value;
  if (!node.connectionId || !node.database) return;
  connectionStore.activeConnectionId = node.connectionId;
  const viewName = "new_view";
  const effectiveDbType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(node.connectionId));
  const viewSqlName = effectiveDbType === "informix" || !node.schema ? viewName : `${node.schema}.${viewName}`;
  const tabId = queryStore.createTab(node.connectionId, node.database, t("contextMenu.createView"), "query", node.schema);
  queryStore.updateSql(tabId, `CREATE VIEW ${viewSqlName} AS\nSELECT\n  *\nFROM table_name;\n`);
  queryStore.setObjectSource(tabId, {
    schema: node.schema,
    name: viewName,
    objectType: "VIEW",
  });
}

function createMysqlObjectTemplate() {
  const node = activeNode.value;
  if (!node.connectionId || !node.database) return;
  const template = mysqlObjectTemplateForGroup(connectionStore.getConfig(node.connectionId), node);
  if (!template) return;
  connectionStore.activeConnectionId = node.connectionId;
  const tabId = queryStore.createTab(node.connectionId, node.database, t(template.titleKey), "query", node.schema);
  queryStore.updateSql(tabId, template.sql);
}

const canExpand = computed(() =>
  canTreeNodeShowExpander({
    type: activeNode.value.type,
    childCount: activeNode.value.children?.length ?? 0,
  }),
);

const canPin = computed(() => canTreeNodePin(activeNode.value.type));

const canOpenSqlFileExecution = computed(() => {
  return supportsSqlFileExecution(rawDatabaseType());
});

const canExportAllDatabases = computed(() => {
  if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return false;
  const dbType = connectionStore.getConfig(activeNode.value.connectionId)?.db_type;
  return !["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "nacos"].includes(dbType || "");
});

const canOpenDiagram = computed(() => {
  return !!activeNode.value.database && supportsSchemaDiagram(currentDatabaseType());
});

const canOpenDatabaseSearch = computed(() => {
  return !!activeNode.value.database && supportsDatabaseSearch(currentDatabaseType());
});

const canOpenObjectBrowser = computed(() => {
  return supportsObjectBrowserTreeNode(rawDatabaseType(), activeNode.value.type);
});

const canOpenTableImport = computed(() => {
  const node = activeNode.value;
  const supportedNode = node.type === "table" || ((node.type === "database" || node.type === "schema" || node.type === "group-tables") && canCreateTable.value);
  return supportedNode && !isSqlServerLinkedNode(node) && !!node.connectionId && !!node.database && supportsTableImport(currentDatabaseType());
});

const canOpenStructureEditor = computed(() => {
  const editableNode = activeNode.value.type === "table" || ((activeNode.value.type === "column" || activeNode.value.type === "index") && !!activeNode.value.tableName);
  return editableNode && !isSqlServerLinkedNode(activeNode.value) && !!activeNode.value.connectionId && !!activeNode.value.database && supportsTableStructureEditing(currentTableStructureDatabaseType());
});

const canOpenFieldLineage = computed(() => {
  return activeNode.value.type === "column" && !!activeNode.value.database && !!activeNode.value.tableName && supportsFieldLineage(currentDatabaseType());
});

const hasTypeMenu = computed(() => {
  const t = activeNode.value.type;
  return t === "connection" || t === "database" || t === "schema" || t === "table" || t === "view" || t === "column" || t === "procedure" || t === "function" || t === "trigger" || t === "package" || t === "package-body" || t === "type" || t === "type-body" || isGroupLabel(activeNode.value);
});

const isSelected = computed(() => connectionStore.selectedTreeNodeId === activeNode.value.id);

const isMultiSelected = computed(() => connectionStore.selectedTreeNodeIdsSet.has(activeNode.value.id));

const dangerDialogRoutes: Array<{ flag: { value: boolean }; createRequest: () => SidebarDangerDialogRequest }> = [];

let stopDangerDialogRouting: (() => void) | null = null;

function routeDangerDialog(flag: { value: boolean }, createRequest: () => SidebarDangerDialogRequest) {
  dangerDialogRoutes.push({ flag, createRequest });
}

function ensureDangerDialogRouting() {
  if (stopDangerDialogRouting) return;
  stopDangerDialogRouting = watch(
    dangerDialogRoutes.map((route) => route.flag),
    (openFlags) => {
      if (sidebarTreeDialogOwner.value !== treeItemDialogOwner) return;
      openFlags.forEach((open, index) => {
        if (!open) return;
        const route = dangerDialogRoutes[index];
        route.flag.value = false;
        emit("open-danger-dialog", route.createRequest());
      });
    },
  );
}

function dangerRequest(request: Omit<SidebarDangerDialogRequest, "target">): SidebarDangerDialogRequest {
  const target = createSidebarActionTarget(activeNode.value);
  const routedRequest = request as SidebarDangerDialogRequest;
  const confirm = request.confirm;
  routedRequest.confirm = async () => {
    activateActionTarget(target);
    await confirm();
  };
  if (request.option?.onChange) {
    const onChange = request.option.onChange;
    request.option.onChange = async (checked) => {
      activateActionTarget(target);
      await onChange(checked);
    };
  }
  routedRequest.target = target;
  sidebarDangerTarget.value = routedRequest.target;
  return routedRequest;
}

routeDangerDialog(showDropTableConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmDropTableTitle"),
    message: t("contextMenu.confirmDropTableMessage", { name: activeNode.value.label }),
    get sql() {
      return dropTablePreviewSql.value;
    },
    confirmLabel: t("contextMenu.dropTable"),
    option: canDropTableCascade.value
      ? {
          checked: dropTableCascade.value,
          label: t("contextMenu.dropTableCascade"),
          hint: t("contextMenu.dropTableCascadeHint"),
          async onChange(checked) {
            dropTableCascade.value = checked;
            await refreshDropTablePreviewSql();
          },
        }
      : undefined,
    confirm: confirmDropTable,
  }),
);

routeDangerDialog(showEmptyTableConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmEmptyTableTitle"),
    message: t("contextMenu.confirmEmptyTableMessage", { name: activeNode.value.label }),
    get sql() {
      return emptyTablePreviewSql.value;
    },
    confirmLabel: t("contextMenu.emptyTable"),
    confirm: confirmEmptyTable,
  }),
);

routeDangerDialog(showBatchEmptyConfirm, () =>
  dangerRequest({
    title: batchEmptyConfirmTitle(),
    message: batchEmptyConfirmMessage(),
    get sql() {
      return batchEmptyPreviewSql.value;
    },
    confirmLabel: batchEmptyConfirmLabel(),
    confirm: confirmBatchEmpty,
  }),
);

routeDangerDialog(showTruncateTableConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmTruncateTableTitle"),
    message: t("contextMenu.confirmTruncateTableMessage", { name: activeNode.value.label }),
    get sql() {
      return truncateTablePreviewSql.value;
    },
    confirmLabel: t("contextMenu.truncateTable"),
    option: canTruncateTableCascade.value
      ? {
          checked: truncateTableCascade.value,
          label: t("contextMenu.truncateTableCascade"),
          hint: t("contextMenu.truncateTableCascadeHint"),
          async onChange(checked) {
            truncateTableCascade.value = checked;
            await refreshTruncateTablePreviewSql();
          },
        }
      : undefined,
    confirm: confirmTruncateTable,
  }),
);

routeDangerDialog(showDropObjectConfirm, () =>
  dangerRequest({
    title: dropObjectConfirmTitle(),
    message: dropObjectConfirmMessage(),
    get sql() {
      return dropObjectPreviewSql.value;
    },
    confirmLabel: dropObjectMenuLabel(),
    confirm: confirmDropObject,
  }),
);

routeDangerDialog(showDropTableChildObjectConfirm, () =>
  dangerRequest({
    title: dropTableChildObjectConfirmTitle(),
    message: dropTableChildObjectConfirmMessage(),
    get sql() {
      return dropTableChildObjectPreviewSql.value;
    },
    confirmLabel: dropTableChildObjectMenuLabel(),
    confirm: confirmDropTableChildObject,
  }),
);

routeDangerDialog(showBatchDropConfirm, () =>
  dangerRequest({
    title: batchDropConfirmTitle(),
    message: batchDropConfirmMessage(),
    get sql() {
      return batchDropPreviewSql.value;
    },
    confirmLabel: batchDropMenuLabel(),
    option: canBatchDropCascade.value
      ? {
          checked: batchDropCascade.value,
          label: t("contextMenu.dropTableCascade"),
          hint: t("contextMenu.dropTableCascadeHint"),
          async onChange(checked) {
            batchDropCascade.value = checked;
            await refreshBatchDropPreviewSql();
          },
        }
      : undefined,
    confirm: confirmBatchDrop,
  }),
);

routeDangerDialog(showBatchTruncateConfirm, () =>
  dangerRequest({
    title: batchTruncateConfirmTitle(),
    message: batchTruncateConfirmMessage(),
    get sql() {
      return batchTruncatePreviewSql.value;
    },
    confirmLabel: batchTruncateMenuLabel(),
    option: canBatchTruncateCascade.value
      ? {
          checked: batchTruncateCascade.value,
          label: t("contextMenu.truncateTableCascade"),
          hint: t("contextMenu.truncateTableCascadeHint"),
          async onChange(checked) {
            batchTruncateCascade.value = checked;
            await refreshBatchTruncatePreviewSql();
          },
        }
      : undefined,
    confirm: confirmBatchTruncate,
  }),
);

routeDangerDialog(showDropDatabaseConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmDropDatabaseTitle"),
    message: t("contextMenu.confirmDropDatabaseMessage", { name: activeNode.value.label }),
    get sql() {
      return dropDatabasePreviewSql.value;
    },
    confirmLabel: t("contextMenu.dropDatabase"),
    get loading() {
      return dropDatabaseLoading.value;
    },
    closeOnConfirm: false,
    confirm: confirmDropDatabase,
  }),
);

routeDangerDialog(showDropMongoCollectionConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmDropCollectionTitle"),
    message: t("contextMenu.confirmDropCollectionMessage", { name: activeNode.value.label }),
    confirmLabel: t("contextMenu.dropCollection"),
    get loading() {
      return dropMongoCollectionLoading.value;
    },
    closeOnConfirm: false,
    confirm: confirmDropMongoCollection,
  }),
);

routeDangerDialog(showDropMongoIndexConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmDropIndexTitle"),
    message: t("contextMenu.confirmDropMongoIndexMessage", { name: mongoIndexNameForNode(activeNode.value), collection: activeNode.value.tableName || "" }),
    details: mongoIndexDropPreview(activeNode.value, mongoIndexNameForNode(activeNode.value)),
    confirmLabel: t("contextMenu.dropIndex"),
    get loading() {
      return dropMongoIndexLoading.value;
    },
    closeOnConfirm: false,
    confirm: confirmDropMongoIndex,
  }),
);

routeDangerDialog(showDropAllMongoIndexesConfirm, () =>
  dangerRequest({
    title: t("contextMenu.dropAllIndexes"),
    message: t("contextMenu.confirmDropMongoAllIndexesMessage", { name: activeNode.value.label }),
    detailsText: t("contextMenu.confirmDropMongoAllIndexesDetails"),
    sql: mongoDropAllIndexesPreview(activeNode.value),
    confirmLabel: t("contextMenu.dropAllIndexes"),
    get loading() {
      return dropAllMongoIndexesLoading.value;
    },
    closeOnConfirm: false,
    confirm: confirmDropAllMongoIndexes,
  }),
);

routeDangerDialog(showFlushRedisDbConfirm, () =>
  dangerRequest({
    title: t("redis.flushDb"),
    message: t("redis.flushDbMessage"),
    details: t("redis.flushDbDetails", { db: activeNode.value.database }),
    confirmLabel: t("redis.flushDbConfirm"),
    confirm: confirmFlushRedisDb,
  }),
);

routeDangerDialog(showDropSchemaConfirm, () =>
  dangerRequest({
    title: t("contextMenu.confirmDropSchemaTitle"),
    message: t("contextMenu.confirmDropSchemaMessage", { name: activeNode.value.label }),
    get sql() {
      return dropSchemaPreviewSql.value;
    },
    confirmLabel: t("contextMenu.dropSchema"),
    confirm: confirmDropSchema,
  }),
);

function moveToNewGroup() {
  moveToNewGroupName.value = "";
  showMoveToNewGroupDialog.value = true;
}

function confirmMoveToNewGroup() {
  const name = moveToNewGroupName.value.trim();
  const node = sidebarFormTarget.value ?? activeNode.value;
  if (name && node.connectionId) {
    const groupId = connectionStore.createConnectionGroup(name);
    connectionStore.moveConnectionToGroup(node.connectionId, groupId);
  }
  showMoveToNewGroupDialog.value = false;
}

let treeItemDialogController: Record<string, any> | null = null;

function connectionDialogCapabilities() {
  return {
    showDeleteConfirm,
    connectionDeleteConfirmMessage,
    confirmDelete,
    connectionDeleteMenuLabel,
    showMoveToNewGroupDialog,
    moveToNewGroupName,
    confirmMoveToNewGroup,
    showDeleteGroupConfirm,
    confirmDeleteGroup,
  };
}

function objectDialogCapabilities() {
  return {
    showRenameObjectDialog,
    renameObjectName,
    renameObjectPreviewSql,
    renameObjectError,
    confirmRenameObject,
    showStructurePreviewDialog,
    structurePreviewTitle,
    isLoadingStructurePreview,
    structurePreviewError,
    structurePreviewSql,
    copyStructurePreview,
    saveStructurePreview,
    showStructureDocCopyDialog,
    structureDocCopyTitle,
    structureDocCopyText,
    selectTextareaContent,
    copyStructureDocText,
    showDuplicateDialog,
    duplicateTableName,
    confirmDuplicateStructure,
    showPasteDialog,
    pasteTableEntries,
    pasteTableMode,
    pasteTableDataCopySupported: pasteTableDataCopySupported.value,
    confirmPasteTable,
  };
}

function databaseDialogCapabilities() {
  return {
    showCreateDatabaseDialog,
    createDatabaseName,
    canSetCreateDatabaseCharset: canSetCreateDatabaseCharset.value,
    createDatabaseCharset,
    createDatabaseCharsetOptions,
    createDatabaseCharsetLoading,
    normalizeCreateDatabaseCharset,
    createDatabaseCollation,
    createDatabaseUsers,
    createDatabaseSelectedUsers,
    createDatabaseUsersLoading,
    createDatabaseUserKey,
    createDatabaseUserLabel,
    createDatabaseUserSelected,
    toggleCreateDatabaseUser,
    showCreateDatabasePreviewDialog,
    createDatabasePreviewSql,
    createDatabaseAuthorizationResults,
    createDatabaseAuthorizationApplying,
    applyCreateDatabaseAuthorizationPlan,
    createDatabaseAuthorizationStepLabel,
    createDatabaseCollationOptionsForCharset,
    createDatabaseCollationsByCharset,
    confirmCreateDatabase,
    showEditDatabasePropertiesDialog,
    updateCreateDatabaseCharset,
    canEditDatabaseCharsetCollation: canEditDatabaseCharsetCollation.value,
    updateEditDatabaseCharset,
    editDatabasePropertiesLoading,
    editDatabaseCharset,
    editDatabaseCollation,
    canEditDatabaseComment: canEditDatabaseComment.value,
    editDatabaseCommentText,
    editDatabasePropertiesPreviewSql,
    confirmEditDatabaseProperties,
  };
}

function databaseSpecificDialogCapabilities() {
  return {
    showCreateNacosNamespaceDialog,
    createNacosNamespaceId,
    createNacosNamespaceName,
    createNacosNamespaceDesc,
    createNacosNamespaceLoading,
    confirmCreateNacosNamespace,
    showEditNacosNamespaceDialog,
    editNacosNamespaceName,
    editNacosNamespaceDesc,
    editNacosNamespaceLoading,
    confirmEditNacosNamespace,
    showCreateSchemaDialog,
    createSchemaName,
    confirmCreateSchema,
    showEditSchemaCommentDialog,
    schemaCommentText,
    schemaCommentLoading,
    schemaCommentPreviewSql,
    confirmEditSchemaComment,
  };
}

function getTreeItemDialogController(): Record<string, any> {
  if (treeItemDialogController) return treeItemDialogController;
  treeItemDialogController = reactive<Record<string, any>>({
    node: createSidebarActionTarget(activeNode.value),
    t,
    highlight,
    ...connectionDialogCapabilities(),
    ...objectDialogCapabilities(),
    ...databaseDialogCapabilities(),
    ...databaseSpecificDialogCapabilities(),
  });
  return treeItemDialogController;
}

const availableGroups = computed(() => connectionStore.sidebarLayout.groups);

const currentGroupId = computed(() => {
  if (activeNode.value.type !== "connection" || !activeNode.value.connectionId) return null;
  const find = (entries: typeof connectionStore.sidebarLayout.order): string | null => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      if ((entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? []).some((child) => child.type === "connection" && child.id === activeNode.value.connectionId)) {
        return entry.id;
      }
      const found = find(entry.children ?? []);
      if (found) return found;
    }
    return null;
  };
  return find(connectionStore.sidebarLayout.order);
});

onBeforeUnmount(() => {
  stopDangerDialogRouting?.();
});

const shortcutCopyName = computed(() => settingsStore.editorSettings.shortcuts.copySidebarSelection);

const shortcutOpenDataInNewTab = computed(() => settingsStore.editorSettings.shortcuts.openDataInNewTab);

const shortcutEditConnection = computed(() => settingsStore.editorSettings.shortcuts.editSidebarConnection);

const shortcutRename = "F2";

const shortcutRefresh = "F5";

const shortcutDelete = "Delete";

function exportDataSubmenu(): ContextMenuItem {
  return {
    label: t("contextMenu.exportData"),
    icon: Upload,
    children: [
      { label: "CSV", action: () => exportData("csv") },
      { label: "JSON", action: () => exportData("json") },
      { label: "SQL INSERT", action: () => exportData("sql") },
      { label: "XLSX", action: () => exportDataXlsx() },
    ],
  };
}

function copyStructureAsSubmenu(): ContextMenuItem {
  return {
    label: t("contextMenu.copyStructureAs"),
    icon: Clipboard,
    children: [
      { label: t("contextMenu.copyStructureAsTsv"), action: () => copyStructureAs("tsv") },
      { label: t("contextMenu.copyStructureAsMarkdown"), action: () => copyStructureAs("markdown") },
    ],
  };
}

function moreActionsSubmenu(children: ContextMenuItem[]): ContextMenuItem {
  return {
    label: t("common.more"),
    icon: ListTree,
    children,
  };
}

function savedSqlHistoryScopeForNode(node: TreeNode): SavedSqlHistoryScope | null {
  if (!node.connectionId) return null;
  if (node.type === "connection") {
    return { connectionId: node.connectionId };
  }
  if ((node.type === "database" || node.type === "schema") && hasTreeNodeDatabaseContext(node)) {
    return {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.type === "schema" ? node.schema : undefined,
    };
  }
  if ((node.type === "table" || node.type === "view") && hasTreeNodeDatabaseContext(node)) {
    return {
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      tableName: node.label,
    };
  }
  return null;
}

async function openSavedSqlHistoryFile(fileId: string) {
  const file = await savedSqlStore.ensureFileContent(fileId);
  if (!file) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
}

function savedSqlHistorySubmenu(): ContextMenuItem | null {
  const scope = savedSqlHistoryScopeForNode(activeNode.value);
  if (!scope) return null;
  const files = rankSavedSqlHistory(savedSqlStore.allFiles, { ...scope, limit: 10 });
  return {
    label: t("contextMenu.sqlHistory"),
    icon: ScrollText,
    children:
      files.length > 0
        ? files.map((file) => ({
            label: file.name,
            action: () => openSavedSqlHistoryFile(file.id),
            icon: FileCode,
          }))
        : [
            {
              label: t("contextMenu.noSqlHistory"),
              disabled: true,
            },
          ],
  };
}
interface SidebarMenuFactoryContext {
  node: TreeNode;
  items: ContextMenuItem[];
  deleteMenuLabel: (singleLabel: string) => string;
  deleteMenuAction: (singleAction: () => void) => () => void;
  truncateMenuLabel: (singleLabel: string) => string;
  truncateMenuAction: (singleAction: () => void) => () => void;
  emptyMenuLabel: (singleLabel: string) => string;
  emptyMenuAction: (singleAction: () => void) => () => void;
}

type SidebarMenuFactory = (context: SidebarMenuFactoryContext) => boolean;

function buildConnectionSidebarMenu(context: SidebarMenuFactoryContext): boolean {
  const { node, items } = context;
  // 2. Connection
  if (node.type === "connection") {
    if (isConnecting.value) {
      items.push({ label: t("connection.cancelConnecting"), action: cancelConnectionAttempt, icon: X });
    } else if (!isConnected.value) {
      items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: Plug });
    } else {
      items.push({ label: t("contextMenu.closeConnection"), action: disconnectConnection, icon: Unplug });
    }
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (currentDatabaseType() === "redis") {
      items.push({ label: t("contextMenu.instanceInfo"), action: openRedisInstanceInfo, icon: Info });
    }
    const sqlHistoryMenu = savedSqlHistorySubmenu();
    if (sqlHistoryMenu) items.push(sqlHistoryMenu);
    if (node.connectionId && connectionSupportsDatabaseUserAdmin(connectionStore.getConfig(node.connectionId))) {
      items.push({ label: t("contextMenu.userAdmin"), action: openUserAdmin, icon: UsersRound });
    }
    if (node.connectionId && connectionSupportsProcessList(connectionStore.getConfig(node.connectionId))) {
      items.push({ label: t("contextMenu.processList"), action: openProcessList, icon: Activity });
    }
    if (node.connectionId && (connectionSupportsServerDashboard(connectionStore.getConfig(node.connectionId)) || connectionSupportsPgServerDashboard(connectionStore.getConfig(node.connectionId)))) {
      items.push({ label: t("contextMenu.serverDashboard"), action: openServerDashboard, icon: Gauge });
    }
    if (currentDatabaseType() === "dameng") {
      items.push({ label: t("contextMenu.damengJobAdmin"), action: openDamengJobAdmin, icon: CalendarClock });
    }
    if (canCopyFinalProxyPort.value) {
      items.push({ label: t("contextMenu.copyFinalProxyPort"), action: copyFinalProxyPort, icon: Network });
    }
    if (canOpenSqlFileExecution.value) {
      items.push({ label: t("sqlFile.title"), action: openSqlFileExecution, icon: FileCode });
    }
    if (canExportAllDatabases.value) {
      items.push({ label: t("contextMenu.exportAllDatabases"), action: openAllDatabasesExport, icon: Upload });
      if (isTauriRuntime()) {
        items.push({ label: t("databaseBackup.title"), action: openScheduledBackups, icon: CalendarClock });
      }
    }
    if (canCreateDatabase.value) {
      items.push({
        label: connectionNamespaceCreationLabel(),
        action: openConnectionNamespaceCreation,
        icon: Plus,
      });
    }
    if (canCreateNacosNamespace.value) {
      items.push({
        label: t("nacos.createNamespace"),
        action: openCreateNacosNamespaceDialog,
        icon: FolderPlus,
      });
    }
    items.push({ label: "", separator: true });
    if (availableGroups.value.length > 0 || currentGroupId.value) {
      const groupChildren: ContextMenuItem[] = availableGroups.value.map((group: { id: string; name: string }) => ({
        label: group.name,
        action: () => moveToGroup(group.id),
        icon: FolderOpen,
        disabled: group.id === currentGroupId.value,
      }));
      if (currentGroupId.value) {
        groupChildren.push({ label: "", separator: true });
        groupChildren.push({ label: t("connectionGroup.ungrouped"), action: () => moveToGroup(null) });
      }
      groupChildren.push({ label: "", separator: true });
      groupChildren.push({ label: t("connectionGroup.newGroup"), action: moveToNewGroup, icon: FolderPlus });
      items.push({ label: t("connectionGroup.moveToGroup"), icon: FolderInput, children: groupChildren });
    } else {
      items.push({ label: t("connectionGroup.moveToNewGroup"), action: moveToNewGroup, icon: FolderPlus });
    }
    items.push({
      label: t("contextMenu.refreshChildren"),
      action: refresh,
      icon: RefreshCw,
      shortcut: shortcutRefresh,
    });
    if (canConfigureVisibleDatabases.value) {
      items.push({
        label: t("contextMenu.configureVisibleObjects"),
        action: openVisibleDatabasesDialog,
        icon: ListFilter,
      });
    } else if (canConfigureVisibleSchemas.value) {
      items.push({
        label: t("visibleSchemas.title"),
        action: openVisibleSchemasDialog,
        icon: ListFilter,
      });
    }
    if (canConfigureVisibleSchemas.value) {
      items.push({
        label: t("visibleSchemas.title"),
        action: openVisibleSchemasDialog,
        icon: ListFilter,
      });
    }
    items.push({ label: t("contextMenu.editConnection"), action: editConnection, icon: Pencil, shortcut: shortcutEditConnection.value });
    if (revealConnectionFilePath.value) {
      items.push({
        label: t("contextMenu.revealDatabaseFile"),
        action: revealDatabaseFile,
        icon: FolderOpen,
      });
    }
    if (canBackupSqliteDatabase.value) {
      items.push({
        label: t("contextMenu.backupSqliteDatabase"),
        action: backupSqliteDatabase,
        icon: HardDriveDownload,
      });
    }
    items.push({ label: connectionDuplicateMenuLabel(), action: duplicateConnection, icon: CopyPlus });
    items.push({ label: "", separator: true });
    items.push({
      label: connectionDeleteMenuLabel(),
      action: deleteConnection,
      icon: Trash2,
      shortcut: shortcutDelete,
      variant: "destructive" as const,
    });
    return true;
  }

  // 3. Connection Group
  if (node.type === "connection-group") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("toolbar.newConnection"), action: newConnectionInGroup, icon: Plus });
    items.push({ label: t("connectionGroup.newGroup"), action: newSubgroup, icon: FolderPlus });
    items.push({ label: "", separator: true });
    items.push({
      label: t("connectionGroup.renameGroup"),
      action: startRenameGroup,
      icon: Pencil,
      shortcut: shortcutRename,
    });
    items.push({ label: "", separator: true });
    items.push({
      label: t("connectionGroup.deleteGroup"),
      action: deleteConnectionGroup,
      icon: Trash2,
      shortcut: shortcutDelete,
      variant: "destructive" as const,
    });
    return true;
  }
  return false;
}

function buildDatabaseSidebarMenu(context: SidebarMenuFactoryContext): boolean {
  const { node, items } = context;
  // 4. Database / Schema
  if (node.type === "database" || node.type === "schema") {
    if (canCloseDatabaseConnection.value) {
      items.push({ label: t("contextMenu.closeDatabaseConnection"), action: closeDatabaseConnection, icon: Unplug });
      items.push({ label: "", separator: true });
    }
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    if (canOpenObjectBrowser.value) {
      items.push({ label: t("contextMenu.openObjectBrowser"), action: openObjectBrowser, icon: TableProperties });
    }
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    const sqlHistoryMenu = savedSqlHistorySubmenu();
    if (sqlHistoryMenu) items.push(sqlHistoryMenu);
    if (node.type === "database" && currentDatabaseType() !== "cloudflare-d1") {
      if (!isNodeDefaultDatabase.value) {
        items.push({ label: t("contextMenu.setDefaultDatabase"), action: setNodeAsDefaultDatabase, icon: Database });
      } else {
        items.push({ label: t("contextMenu.clearDefaultDatabase"), action: clearNodeDefaultDatabase, icon: Database });
      }
    }
    if (canEditDatabaseProperties.value) {
      items.push({ label: t("contextMenu.editDatabaseProperties"), action: openEditDatabasePropertiesDialog, icon: SquarePen });
    }
    if (canCreateTable.value) {
      items.push({ label: t("contextMenu.createTable"), action: createTable, icon: Plus });
    }
    if (canOpenTableImport.value) {
      items.push({ label: t("contextMenu.importData"), action: openTableImport, icon: Download });
    }
    if (canCreateSchema.value) {
      items.push({ label: t("contextMenu.createSchema"), action: openCreateSchemaDialog, icon: Plus });
    }
    if (canEditSchemaComment.value) {
      items.push({ label: t("contextMenu.editSchemaComment"), action: openEditSchemaCommentDialog, icon: SquarePen });
    }
    if (canOpenSqlFileExecution.value) {
      items.push({ label: t("sqlFile.title"), action: openSqlFileExecution, icon: FileCode });
    }
    if (canOpenDiagram.value) {
      items.push({ label: t("diagram.open"), action: openDiagram, icon: Network });
    }
    if (canOpenDatabaseSearch.value) {
      items.push({ label: t("databaseSearch.open"), action: openDatabaseSearch, icon: Search });
    }
    items.push({
      label: t("contextMenu.refreshChildren"),
      action: refresh,
      icon: RefreshCw,
      shortcut: shortcutRefresh,
    });
    if (canConfigureVisibleSchemas.value) {
      items.push({
        label: t("visibleSchemas.title"),
        action: openVisibleSchemasDialog,
        icon: ListFilter,
      });
    }
    items.push({ label: "", separator: true });
    items.push({ label: t("transfer.dataTransfer"), action: openTransfer, icon: ArrowRightLeft });
    items.push({ label: t("diff.title"), action: openSchemaDiff, icon: ArrowRightLeft });
    items.push({ label: t("dataCompare.title"), action: openDataCompare, icon: ArrowRightLeft });
    items.push({ label: t("contextMenu.exportDatabase"), action: openDatabaseExport, icon: Upload });
    const destructiveActions: ContextMenuItem[] = [];
    if (canDropDatabase.value) {
      destructiveActions.push({
        label: t("contextMenu.dropDatabase"),
        action: dropDatabase,
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    if (destructiveActions.length > 0) {
      items.push({ label: "", separator: true });
      items.push(moreActionsSubmenu(destructiveActions));
    }
    if (canDropSchema.value) {
      items.push({ label: "", separator: true });
    }
    if (canDropSchema.value) {
      items.push({
        label: t("contextMenu.dropSchema"),
        action: dropSchema,
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    return true;
  }
  return false;
}

function buildSpecialSidebarMenu(context: SidebarMenuFactoryContext): boolean {
  const { node, items } = context;
  // 5. Redis DB / Mongo DB
  if (node.type === "etcd-root" || node.type === "zookeeper-root") {
    items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: Database });
    return true;
  }

  if (node.type === "user-admin") {
    items.push({ label: t("contextMenu.openUserAdmin"), action: openUserAdmin, icon: UsersRound });
    return true;
  }

  if (node.type === "dameng-job-admin") {
    items.push({ label: t("contextMenu.openDamengJobAdmin"), action: openDamengJobAdmin, icon: CalendarClock });
    return true;
  }

  if (node.type === "redis-db" || node.type === "mongo-db") {
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (!isNodeDefaultDatabase.value) {
      items.push({ label: t("contextMenu.setDefaultDatabase"), action: setNodeAsDefaultDatabase, icon: Database });
    } else {
      items.push({ label: t("contextMenu.clearDefaultDatabase"), action: clearNodeDefaultDatabase, icon: Database });
    }
    if (node.type === "mongo-db") {
      items.push({ label: "", separator: true });
      items.push({ label: t("transfer.dataTransfer"), action: openTransfer, icon: ArrowRightLeft });
    }
    if (node.type === "redis-db") {
      items.push({ label: "", separator: true });
      items.push({ label: t("redis.flushDb"), action: flushRedisDb, icon: Eraser, variant: "destructive" as const });
    }
    if (canDropMongoDatabase.value) {
      items.push({ label: "", separator: true });
      items.push(
        moreActionsSubmenu([
          {
            label: t("contextMenu.dropDatabase"),
            action: dropDatabase,
            icon: Trash2,
            shortcut: shortcutDelete,
            variant: "destructive" as const,
          },
        ]),
      );
    }
    return true;
  }

  if (node.type === "nacos-namespace") {
    items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: FolderOpen });
    if (canEditNacosNamespace.value) {
      items.push({ label: t("nacos.editNamespace"), action: openEditNacosNamespaceDialog, icon: Pencil });
    }
    items.push({
      label: t("contextMenu.refreshChildren"),
      action: refresh,
      icon: RefreshCw,
      shortcut: shortcutRefresh,
    });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return true;
  }

  if (node.type === "mongo-collection") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: toggle, icon: TableProperties });
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (canDropAllMongoIndexes.value || canDropMongoCollection.value) {
      items.push({ label: "", separator: true });
      if (canDropAllMongoIndexes.value) {
        items.push({ label: t("contextMenu.dropAllIndexes"), action: dropAllMongoIndexes, icon: Trash2, variant: "destructive" as const });
      }
      if (canDropMongoCollection.value) {
        items.push({ label: t("contextMenu.dropCollection"), action: dropMongoCollection, icon: Trash2, shortcut: shortcutDelete, variant: "destructive" as const });
      }
    }
    return true;
  }

  if (node.type === "elasticsearch-index" || node.type === "vector-collection") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: toggle, icon: TableProperties });
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    return true;
  }

  // 8.5 Extension
  if (node.type === "extension") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return true;
  }
  return false;
}

function buildObjectSidebarMenu(context: SidebarMenuFactoryContext): boolean {
  const { node, items, deleteMenuLabel, deleteMenuAction, truncateMenuLabel, truncateMenuAction, emptyMenuLabel, emptyMenuAction } = context;
  // 6. Table / View / Materialized View
  if (node.type === "table" || node.type === "view" || node.type === "materialized_view") {
    const destructiveActions: ContextMenuItem[] = [];
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: openDataImmediately, icon: TableProperties });
    items.push({
      label: t("contextMenu.openInNewDataTab"),
      action: openDataInNewTabImmediately,
      icon: CopyPlus,
      shortcut: shortcutOpenDataInNewTab.value,
    });
    if (node.type === "table") {
      items.push({
        label: t("contextMenu.viewDdl"),
        action: () => emit("open-ddl", node),
        icon: FileCode,
      });
    }
    if (node.type === "view" || node.type === "materialized_view") {
      items.push({ label: t("contextMenu.editView"), action: () => openObjectSourceDialog(true), icon: Pencil });
      items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
      items.push({
        label: t("contextMenu.viewDdl"),
        action: () => emit("open-ddl", node),
        icon: FileCode,
      });
    }
    if (canOpenStructureEditor.value) {
      items.push({ label: t("contextMenu.editStructure"), action: openStructureEditor, icon: PencilRuler });
    }
    if (canRenameObject.value) {
      items.push({
        label: t("contextMenu.renameObject"),
        action: openRenameObjectDialog,
        icon: Pencil,
        shortcut: shortcutRename,
      });
    }
    if (node.type === "view" || node.type === "materialized_view") {
      destructiveActions.push({
        label: deleteMenuLabel(t("contextMenu.dropView")),
        action: deleteMenuAction(requestDropObject),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    items.push({
      label: t("contextMenu.generateSql"),
      icon: FilePlus,
      children: isTableNotView.value
        ? [
            { label: "SELECT", action: newSelectTemplate, icon: TerminalSquare },
            { label: "INSERT", action: newInsertTemplate, icon: FilePlus },
            { label: "UPDATE", action: newUpdateTemplate, icon: SquarePen },
            { label: "DELETE", action: newDeleteTemplate, icon: ListX },
            { label: "DDL", action: generateDdlTemplate, icon: FileCode },
          ]
        : [
            { label: "SELECT", action: newSelectTemplate, icon: TerminalSquare },
            { label: "DDL", action: generateDdlTemplate, icon: FileCode },
          ],
    });
    const sqlHistoryMenu = savedSqlHistorySubmenu();
    if (sqlHistoryMenu) items.push(sqlHistoryMenu);
    if (canOpenDiagram.value) {
      items.push({ label: t("diagram.open"), action: openDiagram, icon: Network });
    }
    if (canOpenTableImport.value) {
      items.push({ label: t("contextMenu.importData"), action: openTableImport, icon: Download });
    }
    if (isTableNotView.value) {
      items.push({ label: t("dataCompare.title"), action: openDataCompare, icon: ArrowRightLeft });
    }
    items.push({ label: "", separator: true });
    items.push(exportDataSubmenu());
    items.push({ label: t("contextMenu.exportDatabase"), action: openDatabaseExport, icon: Upload });
    items.push({ label: t("contextMenu.exportStructure"), action: exportStructure, icon: FileCode });
    items.push(copyStructureAsSubmenu());
    if (isTableNotView.value) {
      items.push({ label: "", separator: true });
      items.push({ label: t("contextMenu.duplicateStructure"), action: duplicateStructure, icon: CopyPlus });
      items.push({ label: t("contextMenu.copyTable"), action: copyTableToClipboard, icon: Copy });
      if (supportsTruncate.value) {
        destructiveActions.push({
          label: truncateMenuLabel(t("contextMenu.truncateTable")),
          action: truncateMenuAction(truncateTable),
          icon: Scissors,
          variant: "destructive" as const,
        });
      }
      destructiveActions.push({
        label: emptyMenuLabel(t("contextMenu.emptyTable")),
        action: emptyMenuAction(emptyTable),
        icon: Eraser,
        variant: "destructive" as const,
      });
      destructiveActions.push({
        label: deleteMenuLabel(t("contextMenu.dropTable")),
        action: deleteMenuAction(dropTable),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    if (destructiveActions.length > 0) {
      items.push({ label: "", separator: true });
      items.push(moreActionsSubmenu(destructiveActions));
    }
    items.push({ label: "", separator: true });
    items.push({
      label: t("contextMenu.refreshChildren"),
      action: refresh,
      icon: RefreshCw,
      shortcut: shortcutRefresh,
    });
    return true;
  }

  // 7. Column
  if (node.type === "column") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    const columnActions: ContextMenuItem[] = [];
    if (canOpenStructureEditor.value) {
      columnActions.push({ label: t("contextMenu.editColumn"), action: openStructureEditor, icon: PencilRuler });
    }
    if (canOpenFieldLineage.value) {
      columnActions.push({ label: t("lineage.open"), action: openFieldLineage, icon: Network });
    }
    if (columnActions.length > 0) {
      items.push({ label: "", separator: true });
      items.push(...columnActions);
    }
    if (canDropTableChildObject.value) {
      items.push({ label: "", separator: true });
      items.push({
        label: deleteMenuLabel(dropTableChildObjectMenuLabel()),
        action: deleteMenuAction(requestDropTableChildObject),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    return true;
  }

  if (node.type === "index" || node.type === "fkey" || (node.type === "trigger" && !!node.tableName)) {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    if (node.type === "index" && canOpenStructureEditor.value) {
      items.push({ label: "", separator: true });
      items.push({ label: t("contextMenu.editIndex"), action: openStructureEditor, icon: PencilRuler });
    }
    if (node.type === "index" && canDropMongoIndex.value) {
      items.push({ label: "", separator: true });
      items.push({
        label: deleteMenuLabel(t("contextMenu.dropIndex")),
        action: deleteMenuAction(dropMongoIndex),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    } else if (canDropTableChildObject.value) {
      items.push({ label: "", separator: true });
      items.push({
        label: deleteMenuLabel(dropTableChildObjectMenuLabel()),
        action: deleteMenuAction(requestDropTableChildObject),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    return true;
  }

  // 8. Procedure / Function / Package
  if (node.type === "procedure" || node.type === "function") {
    if (node.type === "procedure") {
      items.push({ label: t("contextMenu.executeProcedure"), action: openProcedureExecution, icon: Play });
    }
    items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
    if (canRenameObject.value) {
      items.push({
        label: t("contextMenu.renameObject"),
        action: openRenameObjectDialog,
        icon: Pencil,
        shortcut: shortcutRename,
      });
    }
    items.push({ label: "", separator: true });
    items.push({
      label: deleteMenuLabel(node.type === "procedure" ? t("contextMenu.dropProcedure") : t("contextMenu.dropFunction")),
      action: deleteMenuAction(requestDropObject),
      icon: Trash2,
      shortcut: shortcutDelete,
      variant: "destructive" as const,
    });
    return true;
  }

  if (node.type === "sequence") {
    items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return true;
  }

  if (node.type === "trigger" || node.type === "package" || node.type === "package-body" || node.type === "type" || node.type === "type-body") {
    items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return true;
  }
  return false;
}

function buildObjectGroupSidebarMenu(context: SidebarMenuFactoryContext): boolean {
  const { node, items } = context;
  // 9. Group Labels (group-columns, group-tables, etc.)
  if (isGroupLabel(node)) {
    const mysqlObjectTemplate = node.connectionId ? mysqlObjectTemplateForGroup(connectionStore.getConfig(node.connectionId), node) : null;
    const hasGroupCreateAction = (node.type === "group-tables" && canCreateTable.value) || (node.type === "group-views" && !!node.connectionId && !!node.database) || !!mysqlObjectTemplate;
    const canLoadAllObjectGroup = node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views";
    if (node.type === "group-tables" && canCreateTable.value) {
      items.push({ label: t("contextMenu.createTable"), action: createTable, icon: Plus });
      if (canOpenTableImport.value) {
        items.push({ label: t("contextMenu.importData"), action: openTableImport, icon: Upload });
      }
      if (canPasteTreeClipboardToCurrentNode()) {
        items.push({ label: t("contextMenu.pasteTable"), action: openPasteTableDialog, icon: Clipboard });
      }
    }
    if (node.type === "group-views" && node.connectionId && node.database) {
      items.push({ label: t("contextMenu.createView"), action: createView, icon: Plus });
    }
    if (mysqlObjectTemplate) {
      items.push({ label: t(mysqlObjectTemplate.titleKey), action: createMysqlObjectTemplate, icon: Plus });
    }
    if (hasGroupCreateAction) {
      items.push({ label: "", separator: true });
    }
    if (node.type === "group-extensions") {
      items.push({
        label: t("contextMenu.manageExtension"),
        action: () => openInstallExtensionDialog(node),
        icon: Plus,
      });
      items.push({ label: "", separator: true });
    }
    if (canLoadAllObjectGroup) {
      items.push({
        label: t("contextMenu.expandAll"),
        action: loadAllObjectGroupChildren,
        icon: ChevronsDown,
        disabled: node.isLoading,
      });
    }
    if (node.type !== "group-partitions") {
      items.push({
        label: t("contextMenu.refreshChildren"),
        action: refresh,
        icon: RefreshCw,
        shortcut: shortcutRefresh,
      });
    }
    return true;
  }
  return false;
}

const sidebarMenuFactories: readonly SidebarMenuFactory[] = [buildConnectionSidebarMenu, buildDatabaseSidebarMenu, buildSpecialSidebarMenu, buildObjectSidebarMenu, buildObjectGroupSidebarMenu];

function treeItemMenuItems(): ContextMenuItem[] {
  const node = activeNode.value;
  const items: ContextMenuItem[] = [];
  const batchDropCount = selectedBatchDropTargets().length;
  const batchEmptyCount = selectedBatchEmptyTargets().length;
  const batchTruncateCount = selectedBatchTruncateTargets().length;
  const deleteMenuLabel = (singleLabel: string) => (batchDropCount > 1 ? batchDropMenuLabel() : singleLabel);
  const deleteMenuAction = (singleAction: () => void) => (batchDropCount > 1 ? requestBatchDrop : singleAction);
  const truncateMenuLabel = (singleLabel: string) => (batchTruncateCount > 1 ? batchTruncateMenuLabel() : singleLabel);
  const truncateMenuAction = (singleAction: () => void) => (batchTruncateCount > 1 ? requestBatchTruncate : singleAction);
  const emptyMenuLabel = (singleLabel: string) => (batchEmptyCount > 1 ? batchEmptyMenuLabel() : singleLabel);
  const emptyMenuAction = (singleAction: () => void) => (batchEmptyCount > 1 ? requestBatchEmpty : singleAction);

  // 1. Pin toggle
  if (canPin.value) {
    items.push({
      label: isPinned.value ? t("contextMenu.unpin") : t("contextMenu.pin"),
      action: togglePin,
      icon: Pin,
    });
    if (hasTypeMenu.value) items.push({ label: "", separator: true });
  }
  const factoryContext: SidebarMenuFactoryContext = {
    node,
    items,
    deleteMenuLabel,
    deleteMenuAction,
    truncateMenuLabel,
    truncateMenuAction,
    emptyMenuLabel,
    emptyMenuAction,
  };
  for (const factory of sidebarMenuFactories) {
    if (factory(factoryContext)) return items;
  }

  // 10. Universal Copy Name (for all types except connection)
  if (hasTypeMenu.value) {
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
  }

  return items;
}

function activateRuntimeNode(node: TreeNode) {
  activeNode.value = node;
}

function activateActionTarget(target: SidebarActionTarget) {
  activeNode.value = findSidebarActionTarget(connectionStore.treeNodes, target) ?? target;
}

let acceptedSelectionOwner: symbol | null = null;

function bindMenuTarget(items: ContextMenuItem[], target: SidebarActionTarget, selectionIds: readonly string[]): ContextMenuItem[] {
  return items.map((item) => ({
    ...item,
    action: item.action
      ? () => {
          const owner = Symbol("sidebar-menu-action");
          acceptedSelectionOwner = owner;
          acceptedSelectionIds = selectionIds;
          activateActionTarget(target);
          const result = item.action?.() as unknown;
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            return Promise.resolve(result).finally(() => {
              if (acceptedSelectionOwner !== owner) return;
              acceptedSelectionOwner = null;
              acceptedSelectionIds = null;
            });
          }
          if (acceptedSelectionOwner === owner) {
            acceptedSelectionOwner = null;
            acceptedSelectionIds = null;
          }
          return undefined;
        }
      : undefined,
    children: item.children ? bindMenuTarget(item.children, target, selectionIds) : undefined,
  }));
}

function buildContextMenu(node: TreeNode): ContextMenuItem[] {
  const previousNode = activeNode.value;
  const menuContext = createSidebarMenuContext(node, connectionStore.selectedTreeNodeIds, databaseTypeForNode(node));
  activateRuntimeNode(node);
  claimTreeItemDialogOwnership();
  ensureDangerDialogRouting();
  routeTreeItemDialogController();
  const rawItems = treeItemMenuItems();
  // Normalization is intentionally evaluated only when a menu opens. Besides
  // parity tests, it provides deterministic action identifiers for diagnostics.
  normalizeSidebarMenuDescriptors(menuContext, rawItems);
  const items = bindMenuTarget(rawItems, menuContext.target, menuContext.selectedNodeIds);
  activateRuntimeNode(previousNode);
  return items;
}

function handleRowClick(node: TreeNode, clickDetail: number) {
  activateRuntimeNode(node);
  runRowClickAction(clickDetail);
}

function handleRowDoubleClick(node: TreeNode, event: MouseEvent) {
  activateRuntimeNode(node);
  onDoubleClick(event);
}

function handleRowKeydown(node: TreeNode, event: KeyboardEvent) {
  activateRuntimeNode(node);
  onKeydown(event);
}

function openDataInNewTab(node: TreeNode) {
  activateRuntimeNode(node);
  openDataInNewTabImmediately(node);
}

function requestPaste(node: TreeNode): boolean {
  activateRuntimeNode(node);
  return requestPasteTreeClipboard();
}

function toggleNode(node: TreeNode) {
  activateRuntimeNode(node);
  void toggle();
}

defineExpose({
  buildContextMenu,
  handleRowClick,
  handleRowDoubleClick,
  handleRowKeydown,
  openDataInNewTab,
  requestPaste,
  toggleNode,
});
</script>

<template />
