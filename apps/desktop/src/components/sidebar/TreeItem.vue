<script setup lang="ts">
import { ref, computed, nextTick, watch, onBeforeUnmount, inject } from "vue";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import {
  Database,
  Table,
  Columns3,
  Eye,
  ChevronRight,
  ChevronDown,
  Loader2,
  FolderOpen,
  FolderClosed,
  Trash2,
  TerminalSquare,
  RefreshCw,
  Copy,
  TableProperties,
  Key,
  Link,
  Zap,
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
  Braces,
  Code2,
  ListFilter,
  Package,
  Clipboard,
  UsersRound,
} from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import type { ColumnInfo, DatabaseType, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/api";
import { uuid } from "@/lib/utils";
import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import { canTreeNodeShowExpander, treeItemPaddingLeft, usesFullWidthTreeLabel } from "@/lib/sidebarTreeItemLayout";
import { buildTableSelectSql } from "@/lib/tableSelectSql";
import { clearActiveTableReferencePayload, createTableReferencePayload, createTableReferenceDropEvent, setActiveTableReferencePayload, type QueryEditorTableReferencePayload } from "@/lib/queryEditorTableDrop";
import { editablePrimaryKeys } from "@/lib/tableEditing";
import { supportsDatabaseCreation, supportsDatabaseSearch, supportsFieldLineage, supportsObjectBrowserTreeNode, supportsSchemaDiagram, supportsSqlFileExecution, supportsTableImport, supportsTableTruncate, supportsTableStructureEditing, usesTreeSchemaMode } from "@/lib/databaseCapabilities";
import { copyNameForTreeNode, objectSourceKindForTreeNode, sidebarSelectionCopyAction, treeNodeRowAction, treeNodeRowDoubleClickAction } from "@/lib/treeNodeClick";
import { formatSqlInsert } from "@/lib/exportFormats";
import { fetchTableDataForExport } from "@/lib/tableDataExport";
import { buildCreateDatabaseSql, buildDuckDbAttachDatabaseSql, duckDbAttachedDatabaseNameFromPath, supportsCreateDatabaseCharset, uniqueDuckDbAttachedDatabaseName } from "@/lib/createDatabaseSql";
import {
  buildCreateSchemaSql,
  buildDropDatabaseSql,
  buildDropObjectSql,
  buildDropSchemaSql,
  buildDropTableSql,
  buildDropTableChildObjectSql,
  buildDuplicateTableStructureSql,
  buildEmptyTableSql,
  buildTruncateTableSql,
  type DropTableChildObjectSqlOptions,
  type DropObjectSqlOptions,
  type TableChildObjectType,
  type TableAdminSqlOptions,
} from "@/lib/dbAdminSql";
import { buildRenameObjectSql, supportsObjectRename, type RenameableObjectType } from "@/lib/objectRenameSql";
import { buildRoutineRenameObjectSourceStatements, supportsSourceBackedRoutineRename } from "@/lib/objectSourceEditor";
import { buildViewDdl } from "@/lib/viewDdl";
import { getTableStructureCapabilities } from "@/lib/tableStructureCapabilities";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { hexToRgba } from "@/lib/color";
import { focusSidebarRenameInput } from "@/lib/sidebarRenameFocus";
import { hasTreeNodeDatabaseContext } from "@/lib/treeNodeContext";
import { sidebarDisplayTableName } from "@/lib/sidebarTableNameDisplay";
import { selectedTreeNodesInVisibleOrder as orderSelectedTreeNodes, treeSelectionRangeIdsByIndex, treeSelectionRangeIds } from "@/lib/sidebarTreeSelection";
import { selectedConnectionDeleteTargets } from "@/lib/sidebarConnectionSelection";
import { supportsDatabaseUserAdmin } from "@/lib/databaseUserAdmin";
import { sidebarTreeContextKey } from "@/lib/sidebarTreeContext";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { copyToClipboard } from "@/lib/clipboard";
import { hasEnabledTransportLayers } from "@/lib/connectionTransport";
import { formatShortcut } from "@/lib/shortcutRegistry";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionErrorIndicator from "@/components/connection/ConnectionErrorIndicator.vue";
import VisibleDatabasesDialog from "@/components/sidebar/VisibleDatabasesDialog.vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { flattenTree } from "@/composables/useFlatTree";

const { t } = useI18n();
const labelRef = ref<HTMLElement>();
const rowRef = ref<HTMLElement>();
function isLabelTruncated(): boolean {
  const el = labelRef.value;
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.overflowX === "visible" || style.textOverflow !== "ellipsis") return false;
  return el.scrollWidth - el.clientWidth > 2;
}
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();

type StructureCopyFormat = "tsv" | "markdown";
type DuplicateStructureSource = TreeNode & { connectionId: string; database: string };
const { getDatabaseOptions } = useDatabaseOptions();
const showVisibleDatabasesDialog = ref(false);
const { addTask: addExportTask } = useExportTracker();

const props = defineProps<{
  node: TreeNode;
  depth: number;
  dragDisabled?: boolean;
  pendingRename?: boolean;
  highlighted?: boolean;
}>();

const emit = defineEmits<{
  "rename-started": [];
  "node-toggled": [node: TreeNode, wasExpanded: boolean];
  "search-toggle": [node: TreeNode];
}>();

const usesFullWidthLabel = computed(() => usesFullWidthTreeLabel(props.node.type, settingsStore.editorSettings.sidebarAllowHorizontalScroll));
const sidebarTreeContext = inject(sidebarTreeContextKey, null);
const rowWidthClass = computed(() => (usesFullWidthLabel.value ? "w-max min-w-full" : "w-full min-w-0"));
const labelWidthClass = computed(() => (usesFullWidthLabel.value ? "shrink-0 whitespace-nowrap" : "min-w-0 flex-1 truncate"));

function currentDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(props.node.connectionId)) : undefined;
}

function rawDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? connectionStore.getConfig(props.node.connectionId)?.db_type : undefined;
}

function databaseTypeForNode(node: TreeNode): DatabaseType | undefined {
  return node.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(node.connectionId)) : undefined;
}

function hasNodeDatabaseContext(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return !!node.connectionId && hasTreeNodeDatabaseContext(node);
}

function getIconInfo(node: TreeNode): { icon: any; colorClass: string } | null {
  switch (node.type) {
    case "connection":
      return null;
    case "connection-group":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-amber-500" };
    case "database":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "column":
      if ((node.meta as ColumnInfo).is_primary_key) {
        return { icon: Columns3, colorClass: "text-orange-400" };
      } else {
        return { icon: Columns3, colorClass: "text-muted-foreground" };
      }
    case "group-columns":
      return { icon: ListTree, colorClass: "text-green-400" };
    case "group-indexes":
      return { icon: Key, colorClass: "text-amber-500" };
    case "group-fkeys":
      return { icon: Link, colorClass: "text-blue-400" };
    case "group-triggers":
      return { icon: Zap, colorClass: "text-orange-400" };
    case "object-browser":
      return { icon: TableProperties, colorClass: "text-primary" };
    case "user-admin":
      return { icon: UsersRound, colorClass: "text-primary" };
    case "index":
      return { icon: Key, colorClass: "text-amber-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "etcd-root":
      return { icon: Database, colorClass: "text-sky-500" };
    case "mongo-db":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    case "procedure":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "function":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "sequence":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "package":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "package-body":
      return { icon: FileCode, colorClass: "text-cyan-400" };
    case "group-tables":
      return { icon: Table, colorClass: "text-green-500" };
    case "group-views":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "group-procedures":
      return { icon: ScrollText, colorClass: "text-blue-500" };
    case "group-functions":
      return { icon: Braces, colorClass: "text-amber-500" };
    case "group-sequences":
      return { icon: ListTree, colorClass: "text-emerald-500" };
    case "group-packages":
      return { icon: Package, colorClass: "text-cyan-500" };
    case "group-partitions":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-green-400" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}

const groupTypes: Set<TreeNodeType> = new Set(["group-columns", "group-indexes", "group-fkeys", "group-triggers", "group-tables", "group-views", "group-procedures", "group-functions", "group-sequences", "group-packages", "group-partitions"]);
const pinnableTypes: Set<TreeNodeType> = new Set(["connection-group", "database", "schema", "table", "view", "redis-db", "mongo-db", "mongo-collection"]);

function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

function displayLabel(node: TreeNode): string {
  if (node.type === "object-browser") return t(node.label, { count: node.objectCount ?? 0 });
  if (node.type === "user-admin") return t(node.label);
  if (node.label === "tree.defaultDatabase") return t(node.label);
  return isGroupLabel(node) ? t(node.label) : node.label;
}

function visibleLabel(node: TreeNode): string {
  if (node.type === "table" || node.type === "view" || node.type === "mongo-collection") {
    return sidebarDisplayTableName(node.label, settingsStore.editorSettings.sidebarHiddenTablePrefixes);
  }
  return displayLabel(node);
}

function isTooltipDisabled(): boolean {
  return isRenamingGroup.value || !isLabelTruncated();
}

async function toggle() {
  const node = props.node;
  if (node.isLoading) return;
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

  const databaseObjectGroup = node.type === "group-tables" || node.type === "group-views" || node.type === "group-procedures" || node.type === "group-functions" || node.type === "group-sequences" || node.type === "group-packages";
  if (databaseObjectGroup && connectionStore.isTreeNodeChildrenLoaded(node.id)) {
    node.isExpanded = !node.isExpanded;
    emit("node-toggled", node, wasExpanded);
    return;
  }

  if (node.isExpanded) {
    node.isExpanded = false;
    emit("node-toggled", node, wasExpanded);
    return;
  }

  try {
    if (node.type === "connection" && node.connectionId) {
      const config = connectionStore.getConfig(node.connectionId);
      if (config?.db_type === "redis") {
        await connectionStore.loadRedisDatabases(node.connectionId);
      } else if (config?.db_type === "etcd") {
        await connectionStore.loadEtcdRoot(node.connectionId);
      } else if (config?.db_type === "mongodb" || config?.db_type === "elasticsearch") {
        await connectionStore.loadMongoDatabases(node.connectionId);
      } else {
        await connectionStore.loadDatabases(node.connectionId);
      }
    } else if (node.type === "redis-db" && node.connectionId && node.database) {
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "Redis"}:db${node.database}`;
      queryStore.createTab(node.connectionId, node.database, tabTitle, "redis");
    } else if (node.type === "etcd-root" && node.connectionId) {
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "etcd"}:keys`;
      queryStore.createTab(node.connectionId, "", tabTitle, "etcd");
    } else if (node.type === "user-admin" && node.connectionId) {
      queryStore.openUserAdmin(node.connectionId);
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await connectionStore.loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "mongo-collection" && node.connectionId && node.database) {
      const tabTitle = `${node.database}.${node.label}`;
      const tab = queryStore.createTab(node.connectionId, node.database, tabTitle, "mongo");
      queryStore.updateSql(tab, node.label);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = connectionStore.getConfig(node.connectionId);
      if (config?.db_type === "sqlserver") {
        await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, node.database);
      } else if (usesTreeSchemaMode(config?.db_type) && !connectionUsesDatabaseObjectTreeMode(config)) {
        await connectionStore.loadSchemas(node.connectionId, node.database);
      } else {
        await connectionStore.loadTables(node.connectionId, node.database);
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await connectionStore.loadTables(node.connectionId, node.database, node.schema);
    } else if ((node.type === "table" || node.type === "view") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await connectionStore.loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (databaseObjectGroup) {
      await connectionStore.loadObjectGroupChildren(node);
    }
    emit("node-toggled", node, wasExpanded);
  } catch (e: any) {
    if (!wasExpanded) node.isExpanded = false;
    const errMsg = e?.message || String(e);
    toast(t("connection.connectFailed", { message: translateBackendError(t, errMsg) }), 5000);
    if (errMsg.includes("driver is not installed") || errMsg.includes("is not installed")) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

function runRowClickAction() {
  const node = props.node;
  if (node.type === "object-browser") {
    void openObjectBrowser();
    return;
  }
  const action = treeNodeRowAction(node.type, canExpand.value, settingsStore.editorSettings.sidebarActivation);
  if (action === "open-data") {
    openData();
  } else if (node.type === "procedure" || node.type === "function" || node.type === "sequence" || node.type === "package" || node.type === "package-body") {
    void viewObjectSource();
  } else if (action === "toggle") {
    toggle();
  }
}

function visibleTreeNodes(): TreeNode[] {
  if (sidebarTreeContext) return sidebarTreeContext.getVisibleNodes();
  return flattenTree(connectionStore.treeNodes).map((item) => item.node);
}

function selectedTreeNodesInVisibleOrder(): TreeNode[] {
  return orderSelectedTreeNodes(visibleTreeNodes(), connectionStore.selectedTreeNodeIds);
}

function selectSingleTreeNode(node: TreeNode) {
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.selectedTreeNodeIds = [node.id];
  connectionStore.treeSelectionAnchorId = node.id;
}

function toggleTreeNodeSelection(node: TreeNode) {
  const ids = new Set(connectionStore.selectedTreeNodeIds);
  if (ids.has(node.id)) ids.delete(node.id);
  else ids.add(node.id);
  connectionStore.selectedTreeNodeIds = ids.size ? [...ids] : [node.id];
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.treeSelectionAnchorId = node.id;
}

function selectTreeNodeRange(node: TreeNode) {
  const visible = visibleTreeNodes();
  const anchorId = connectionStore.treeSelectionAnchorId || connectionStore.selectedTreeNodeId || node.id;
  const currentIndex = sidebarTreeContext ? sidebarTreeContext.getVisibleNodeIndex(node.id) : -1;
  const anchorIndex = sidebarTreeContext ? sidebarTreeContext.getVisibleNodeIndex(anchorId) : -1;

  if (sidebarTreeContext && currentIndex >= 0 && anchorIndex >= 0) {
    connectionStore.selectedTreeNodeIds = treeSelectionRangeIdsByIndex(visible, currentIndex, anchorIndex, node.id);
    connectionStore.selectedTreeNodeId = node.id;
    return;
  }

  if (!visible.some((item) => item.id === anchorId) || !visible.some((item) => item.id === node.id)) {
    selectSingleTreeNode(node);
    return;
  }

  const rangeIds = treeSelectionRangeIds(visible, node.id, anchorId, connectionStore.selectedTreeNodeId);
  connectionStore.selectedTreeNodeIds = rangeIds;
  connectionStore.selectedTreeNodeId = node.id;
}

function onClick(event: MouseEvent) {
  if (suppressNextTableReferenceClick) {
    suppressNextTableReferenceClick = false;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  // Row clicks must not bubble to the tree container, whose click handler
  // clears the selection when the blank area is clicked (issue #681).
  event.stopPropagation();
  if (event.shiftKey) {
    selectTreeNodeRange(props.node);
    rowRef.value?.focus({ preventScroll: true });
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    toggleTreeNodeSelection(props.node);
    rowRef.value?.focus({ preventScroll: true });
    return;
  }
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
  if (settingsStore.editorSettings.sidebarActivation === "double") return;
  if (event.detail > 1) return;
  runRowClickAction();
}

function onTreeItemContextMenu(event: MouseEvent, openContextMenu: (event: MouseEvent) => void) {
  if (!connectionStore.selectedTreeNodeIds.includes(props.node.id)) {
    selectSingleTreeNode(props.node);
  } else {
    connectionStore.selectedTreeNodeId = props.node.id;
  }
  rowRef.value?.focus({ preventScroll: true });
  openContextMenu(event);
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || !!target.closest("[contenteditable='true']");
}

function onKeydown(event: KeyboardEvent) {
  if ((!isSelected.value && !isMultiSelected.value) || isEditableShortcutTarget(event.target)) return;
  if (isPasteTreeClipboardShortcut(event)) {
    if (!requestPasteTreeClipboard()) return;
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
  const action = sidebarSelectionCopyAction(event);
  if (action !== "copy-name") return;
  event.preventDefault();
  event.stopPropagation();
  copySelectedNames();
}

function isDeleteTreeNodeShortcut(event: KeyboardEvent): boolean {
  return event.key === "Delete" || event.key === "Backspace";
}

function isPasteTreeClipboardShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v";
}

function requestPasteTreeClipboard(): boolean {
  const clipboard = connectionStore.treeClipboard;
  if (clipboard?.kind !== "table-structure") return false;
  duplicateStructure({
    id: `clipboard:${clipboard.connectionId}:${clipboard.database}:${clipboard.schema || ""}:${clipboard.tableName}`,
    type: "table",
    label: clipboard.tableName,
    connectionId: clipboard.connectionId,
    database: clipboard.database,
    schema: clipboard.schema,
  });
  return true;
}

function requestRefreshSelectedNode(): boolean {
  if (!canRefreshTreeNodeShortcut()) return false;
  void refresh();
  return true;
}

function canRefreshTreeNodeShortcut(): boolean {
  const type = props.node.type;
  if (type === "connection" || type === "database" || type === "schema" || type === "table" || type === "view") {
    return true;
  }
  return isGroupLabel(props.node) && type !== "group-partitions";
}

function requestRenameSelectedNode(): boolean {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length > 1 && selected.some((node) => node.id === props.node.id)) return false;
  if (canRenameObject.value) {
    openRenameObjectDialog();
    return true;
  }
  if (props.node.type === "connection-group") {
    startRenameGroup();
    return true;
  }
  return false;
}

function requestDeleteSelectedNode(): boolean {
  if (requestDropSelectedNodes()) return true;
  if (props.node.type === "connection") {
    deleteConnection();
    return true;
  }
  if (props.node.type === "connection-group") {
    deleteConnectionGroup();
    return true;
  }
  if (canDropDatabase.value) {
    dropDatabase();
    return true;
  }
  if (canDropSchema.value) {
    dropSchema();
    return true;
  }
  return false;
}

function onDoubleClick() {
  const action = treeNodeRowDoubleClickAction(props.node.type, canOpenObjectBrowser.value, settingsStore.editorSettings.sidebarActivation, canExpand.value);
  if (action === "open-object-browser") {
    void openObjectBrowser();
  } else if (action === "open-object-browser-and-expand") {
    void openObjectBrowser();
    if (!props.node.isExpanded) void toggle();
  } else if (action === "open-data") {
    openData();
  } else if (action === "open-source") {
    void viewObjectSource();
  } else if (action === "toggle") {
    toggle();
  }
}

async function openObjectBrowser() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;

    if (hasTreeNodeDatabaseContext(node)) {
      queryStore.openObjectBrowser(node.connectionId, node.database, node.schema);
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
    if (e?.message?.includes("driver is not installed") || (e?.message?.includes("JRE") && e?.message?.includes("not installed"))) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

async function openUserAdmin() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    queryStore.openUserAdmin(node.connectionId);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openData() {
  const node = props.node;
  if (!(node.type === "table" || node.type === "view") || !hasNodeDatabaseContext(node)) return;
  const config = connectionStore.getConfig(node.connectionId);
  const traceId = uuid().slice(0, 8);
  const startedAt = performance.now();
  const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
  console.info("[DBX][openData:start]", {
    traceId,
    type: node.type,
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    table: node.label,
    dbType: config?.db_type,
  });
  const tableSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
  const tabId = (() => {
    if (settingsStore.editorSettings.reuseDataTab) {
      const existing = queryStore.tabs.find((tab) => tab.mode === "data" && tab.connectionId === node.connectionId && tab.database === node.database);
      if (existing) {
        existing.title = node.label;
        existing.schema = tableSchema;
        queryStore.activeTabId = existing.id;
        return existing.id;
      }
    }
    return queryStore.createTab(node.connectionId, node.database, node.label, "data", tableSchema);
  })();
  console.info("[DBX][openData:tab-created]", { traceId, tabId, elapsed: elapsed() });
  queryStore.setTableMeta(tabId, {
    schema: tableSchema,
    tableName: node.label,
    columns: [],
    primaryKeys: [],
  });
  queryStore.setExecuting(tabId, true);

  try {
    console.info("[DBX][openData:ensure-connected:start]", { traceId, elapsed: elapsed() });
    await connectionStore.ensureConnected(node.connectionId);
    console.info("[DBX][openData:ensure-connected:done]", { traceId, elapsed: elapsed() });
    if (!config) throw new Error("Connection config not found");

    const querySchema = connectionObjectTreeQuerySchema(config, node.database, tableSchema);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const limit = settingsStore.editorSettings.pageSize;
    const sql = await buildTableSelectSql({
      databaseType: effectiveDbType,
      schema: tableSchema,
      tableName: node.label,
      columns: [],
      primaryKeys: [],
      limit,
      includeRowId: false,
    });
    console.info("[DBX][openData:sql-built]", {
      traceId,
      primaryKeys: [],
      includeRowId: false,
      sql,
      elapsed: elapsed(),
    });
    queryStore.updateSql(tabId, sql);

    const loadTableMeta = async () => {
      try {
        console.info("[DBX][openData:get-columns:start]", {
          traceId,
          database: node.database,
          schema: querySchema,
          table: node.label,
          elapsed: elapsed(),
        });
        const columns = await api.getColumns(node.connectionId, node.database, querySchema, node.label);
        console.info("[DBX][openData:get-columns:done]", {
          traceId,
          columnCount: columns.length,
          primaryKeys: columns.filter((column) => column.is_primary_key).map((column) => column.name),
          elapsed: elapsed(),
        });
        const pks = editablePrimaryKeys(effectiveDbType, columns);
        queryStore.setTableMeta(tabId, {
          schema: tableSchema,
          tableName: node.label,
          columns,
          primaryKeys: pks,
        });
      } catch (error) {
        console.warn("[DBX][openData:get-columns:error]", { traceId, elapsed: elapsed(), error });
      }
    };

    console.info("[DBX][openData:execute:start]", { traceId, tabId, elapsed: elapsed() });
    await queryStore.executeTabSql(tabId, sql);
    console.info("[DBX][openData:execute:done]", { traceId, tabId, elapsed: elapsed() });
    void loadTableMeta();
  } catch (e: any) {
    console.error("[DBX][openData:error]", { traceId, elapsed: elapsed(), error: e });
    queryStore.setErrorResult(tabId, e);
  }
}

async function newQuery() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    if (hasTreeNodeDatabaseContext(node)) {
      queryStore.createTab(node.connectionId, node.database, undefined, "query", node.schema);
      return;
    }
    const connection = connectionStore.getConfig(node.connectionId);
    if (!connection) return;
    const options = await getDatabaseOptions(node.connectionId);
    queryStore.createTab(node.connectionId, resolveDefaultDatabase(connection, options), undefined, "query");
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
    if (e?.message?.includes("driver is not installed") || (e?.message?.includes("JRE") && e?.message?.includes("not installed"))) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

async function setNodeAsDefaultDatabase() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.setDefaultDatabase(node.connectionId, node.database);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function clearNodeDefaultDatabase() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.clearDefaultDatabase(node.connectionId);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refresh() {
  try {
    await connectionStore.refreshTreeNode(props.node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
    if (e?.message?.includes("driver is not installed") || (e?.message?.includes("JRE") && e?.message?.includes("not installed"))) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

const showDeleteConfirm = ref(false);

function connectionDeleteTargets() {
  return selectedConnectionDeleteTargets(props.node, selectedTreeNodesInVisibleOrder());
}

function connectionDeleteMenuLabel(): string {
  const count = connectionDeleteTargets().length;
  return count > 1 ? t("contextMenu.deleteSelectedConnections", { count }) : t("contextMenu.deleteConnection");
}

function connectionDeleteConfirmMessage(): string {
  const targets = connectionDeleteTargets();
  return targets.length > 1 ? t("contextMenu.confirmDeleteSelectedMessage", { count: targets.length }) : t("contextMenu.confirmDeleteMessage", { name: props.node.label });
}

function deleteConnection() {
  if (!connectionDeleteTargets().length) return;
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  const targets = connectionDeleteTargets();
  if (!targets.length) return;
  try {
    for (const target of targets) {
      await connectionStore.disconnect(target.connectionId);
    }
    await connectionStore.removeConnections(targets.map((target) => target.connectionId));
    toast(targets.length > 1 ? t("connection.deletedSelected", { count: targets.length }) : t("connection.deleted"), 2000);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyName() {
  updateTreeClipboardForNodes([props.node]);
  try {
    await copyToClipboard(copyNameForTreeNode(props.node));
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyFinalProxyPort() {
  const connectionId = props.node.connectionId;
  const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
  if (!config || !hasEnabledTransportLayers(config)) return;

  try {
    const port = await api.connectionFinalProxyPort(config);
    await copyToClipboard(String(port));
    toast(t("contextMenu.finalProxyPortCopied", { port }), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function copySelectedNames() {
  const selectedNodes = selectedTreeNodesInVisibleOrder();
  const nodes = selectedNodes.length > 1 && selectedNodes.some((node) => node.id === props.node.id) ? selectedNodes : [props.node];
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
  if (nodes.length !== 1 || tableNodes.length !== 1) {
    connectionStore.treeClipboard = null;
    return;
  }
  const table = tableNodes[0]!;
  connectionStore.treeClipboard = {
    kind: "table-structure",
    connectionId: table.connectionId,
    database: table.database,
    schema: table.schema,
    tableName: table.label,
  };
}

async function duplicateConnection() {
  const connId = props.node.connectionId;
  if (!connId) return;
  const config = connectionStore.getConfig(connId);
  if (!config) return;
  const newConfig = { ...config, id: uuid(), name: `${config.name} (Copy)` };
  await connectionStore.addConnection(newConfig);
  toast(t("connection.duplicated"), 2000);
}

// --- Table Management Operations ---
const showDropTableConfirm = ref(false);
const showDropTableChildObjectConfirm = ref(false);
const showBatchDropConfirm = ref(false);
const showStructurePreviewDialog = ref(false);
const showStructureDocCopyDialog = ref(false);
const structurePreviewSql = ref("");
const structurePreviewTitle = ref("");
const structurePreviewDefaultFileName = ref("structure.sql");
const structurePreviewError = ref("");
const structureDocCopyText = ref("");
const structureDocCopyTitle = ref("");
const isLoadingStructurePreview = ref(false);
const showEmptyTableConfirm = ref(false);
const showTruncateTableConfirm = ref(false);
const showRenameObjectDialog = ref(false);
const renameObjectName = ref("");
const renameObjectError = ref("");
const renameObjectPreviewSql = ref("");
const dropTablePreviewSql = ref("");
const emptyTablePreviewSql = ref("");
const truncateTablePreviewSql = ref("");
const dropObjectPreviewSql = ref("");
const dropTableChildObjectPreviewSql = ref("");
const batchDropPreviewSql = ref("");
const dropDatabasePreviewSql = ref("");
const dropSchemaPreviewSql = ref("");
const showDuplicateDialog = ref(false);
const duplicateTableName = ref("");
const duplicateStructureSource = ref<DuplicateStructureSource | null>(null);

const showCreateDatabaseDialog = ref(false);
const createDatabaseName = ref("");
const createDatabaseCharset = ref("utf8mb4");
const createDatabaseCollation = ref("utf8mb4_unicode_ci");
const showDropDatabaseConfirm = ref(false);
const showFlushRedisDbConfirm = ref(false);
const showCreateSchemaDialog = ref(false);
const createSchemaName = ref("");
const showDropSchemaConfirm = ref(false);

// --- Procedure / Function Management ---
const showDropObjectConfirm = ref(false);
const showProcedureExecutionConfirm = ref(false);

function dropObjectSqlOptions(): DropObjectSqlOptions | null {
  return dropObjectSqlOptionsForNode(props.node);
}

function dropObjectSqlOptionsForNode(node: TreeNode): DropObjectSqlOptions | null {
  if (node.type !== "view" && node.type !== "procedure" && node.type !== "function") return null;
  return {
    databaseType: databaseTypeForNode(node),
    objectType: node.type === "view" ? "VIEW" : node.type === "procedure" ? "PROCEDURE" : "FUNCTION",
    schema: node.schema,
    name: node.label,
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
  return dropTableChildObjectSqlOptionsForNode(props.node);
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
  return canDropTableChildObjectNode(props.node);
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
  if (props.node.type === "view") return t("contextMenu.dropView");
  if (props.node.type === "procedure") return t("contextMenu.dropProcedure");
  if (props.node.type === "function") return t("contextMenu.dropFunction");
  return t("contextMenu.dropObject");
}

function dropObjectConfirmTitle(): string {
  if (props.node.type === "view") return t("contextMenu.confirmDropViewTitle");
  if (props.node.type === "procedure") return t("contextMenu.confirmDropProcedureTitle");
  if (props.node.type === "function") return t("contextMenu.confirmDropFunctionTitle");
  return t("contextMenu.confirmDropObjectTitle");
}

function dropObjectConfirmMessage(): string {
  if (props.node.type === "view") return t("contextMenu.confirmDropViewMessage", { name: props.node.label });
  if (props.node.type === "procedure") return t("contextMenu.confirmDropProcedureMessage", { name: props.node.label });
  if (props.node.type === "function") return t("contextMenu.confirmDropFunctionMessage", { name: props.node.label });
  return t("contextMenu.confirmDropObjectMessage", { name: props.node.label });
}

function dropTableChildObjectMenuLabel(): string {
  if (props.node.type === "column") return t("contextMenu.dropColumn");
  if (props.node.type === "index") return t("contextMenu.dropIndex");
  if (props.node.type === "fkey") return t("contextMenu.dropForeignKey");
  if (props.node.type === "trigger") return t("contextMenu.dropTrigger");
  return t("contextMenu.dropObject");
}

function dropTableChildObjectConfirmTitle(): string {
  if (props.node.type === "column") return t("contextMenu.confirmDropColumnTitle");
  if (props.node.type === "index") return t("contextMenu.confirmDropIndexTitle");
  if (props.node.type === "fkey") return t("contextMenu.confirmDropForeignKeyTitle");
  if (props.node.type === "trigger") return t("contextMenu.confirmDropTriggerTitle");
  return t("contextMenu.confirmDropObjectTitle");
}

function dropTableChildObjectConfirmMessage(): string {
  return t("contextMenu.confirmDropTableChildObjectMessage", {
    name: tableChildDropObjectName(props.node),
    table: props.node.tableName || "",
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

function viewObjectSource() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const objectType = objectSourceKindForTreeNode(node.type);
  if (!objectType) return;
  const schema = node.schema || node.database;
  connectionStore
    .ensureConnected(node.connectionId)
    .then(() => {
      connectionStore.activeConnectionId = node.connectionId!;
      return api.getObjectSource(node.connectionId!, node.database!, schema, node.label, objectType as any);
    })
    .then(async (result) => {
      const tabId = queryStore.createTab(node.connectionId!, node.database!, `Source - ${node.label}`);
      queryStore.updateSql(tabId, result.source);
      if (objectType !== "SEQUENCE") {
        queryStore.setObjectSource(tabId, {
          schema,
          name: node.label,
          objectType,
        });
      }
    })
    .catch((e: any) => {
      toast(e?.message || String(e), 5000);
    });
}

function viewObjectDdl() {
  const node = props.node;
  if (node.type !== "view" || !node.connectionId || !node.database) return;
  const schema = node.schema || node.database;
  connectionStore
    .ensureConnected(node.connectionId)
    .then(() => {
      connectionStore.activeConnectionId = node.connectionId!;
      return api.getObjectSource(node.connectionId!, node.database!, schema, node.label, "VIEW");
    })
    .then(async (result) => {
      const connection = connectionStore.getConfig(node.connectionId!);
      const ddl = await buildViewDdl({
        databaseType: effectiveDatabaseTypeForConnection(connection),
        schema,
        name: node.label,
        source: result.source,
      });
      const tabId = queryStore.createTab(node.connectionId!, node.database!, `DDL - ${node.label}`);
      queryStore.updateSql(tabId, ddl);
    })
    .catch((e: any) => {
      toast(e?.message || String(e), 5000);
    });
}

function openProcedureExecution() {
  const node = props.node;
  if (node.type !== "procedure" || !node.connectionId || !node.database) return;
  showProcedureExecutionConfirm.value = true;
}

function openProcedureExecutionSql(sql: string) {
  const node = props.node;
  if (node.type !== "procedure" || !node.connectionId || !node.database || !sql) return;
  const tabId = queryStore.createTab(node.connectionId, node.database, `Execute - ${node.label}`, "query", node.schema);
  queryStore.updateSql(tabId, sql);
}

async function executeProcedureSql(sql: string) {
  const node = props.node;
  if (node.type !== "procedure" || !node.connectionId || !node.database || !sql) return;
  const tabId = queryStore.createTab(node.connectionId, node.database, `Execute - ${node.label}`, "query", node.schema);
  queryStore.updateSql(tabId, sql);
  await queryStore.executeTabSql(tabId, sql);
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
  if (node.type === "table") return !!node.connectionId && !!node.database;
  if (node.type === "view" || node.type === "procedure" || node.type === "function") {
    return !!node.connectionId && !!node.database && !!dropObjectSqlOptionsForNode(node);
  }
  return canDropTableChildObjectNode(node);
}

function selectedBatchDropTargets(): TreeNode[] {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length <= 1 || !selected.some((node) => node.id === props.node.id)) return [];
  const first = selected[0];
  if (!first?.connectionId || !first.database || !selected.every((node) => node.type === first.type)) return [];
  if (!selected.every((node) => node.connectionId === first.connectionId && node.database === first.database && canDropTreeNode(node))) {
    return [];
  }
  return selected;
}

function batchDropMenuLabel(): string {
  return t("contextMenu.batchDrop", { count: selectedBatchDropTargets().length });
}

function batchDropConfirmTitle(): string {
  return t("contextMenu.confirmBatchDropTitle", { count: selectedBatchDropTargets().length });
}

function batchDropConfirmMessage(): string {
  return t("contextMenu.confirmBatchDropMessage", { count: selectedBatchDropTargets().length });
}

async function dropSqlForTreeNode(node: TreeNode): Promise<string | null> {
  if (node.type === "table" && node.connectionId && node.database) {
    return buildDropTableSql({
      databaseType: databaseTypeForNode(node),
      schema: node.schema,
      tableName: node.label,
    });
  }
  const objectOptions = dropObjectSqlOptionsForNode(node);
  if (objectOptions) return buildDropObjectSql(objectOptions);
  const childOptions = dropTableChildObjectSqlOptionsForNode(node);
  if (childOptions && canDropTableChildObjectNode(node)) return buildDropTableChildObjectSql(childOptions);
  return null;
}

async function refreshBatchDropPreviewSql() {
  const targets = selectedBatchDropTargets();
  const statements: string[] = [];
  for (const target of targets) {
    const sql = await dropSqlForTreeNode(target);
    if (sql) statements.push(sql);
  }
  batchDropPreviewSql.value = statements.join("\n");
}

function requestBatchDrop() {
  if (!selectedBatchDropTargets().length) return;
  void refreshBatchDropPreviewSql();
  showBatchDropConfirm.value = true;
}

function requestDropSelectedNodes(): boolean {
  const selected = selectedTreeNodesInVisibleOrder();
  if (selected.length > 1 && selected.some((node) => node.id === props.node.id)) {
    if (!selectedBatchDropTargets().length) return false;
    requestBatchDrop();
    return true;
  }
  return requestDropSelectedNode();
}

function requestDropSelectedNode(): boolean {
  if (props.node.type === "table") {
    dropTable();
    return true;
  }
  if (props.node.type === "view" || props.node.type === "procedure" || props.node.type === "function") {
    requestDropObject();
    return true;
  }
  if (canDropTableChildObject.value) {
    requestDropTableChildObject();
    return true;
  }
  return false;
}

function nodeRenameObjectType(): RenameableObjectType | null {
  if (props.node.type === "table") return "TABLE";
  if (props.node.type === "view") return "VIEW";
  if (props.node.type === "procedure") return "PROCEDURE";
  if (props.node.type === "function") return "FUNCTION";
  return null;
}

const canRenameObject = computed(() => {
  const objectType = nodeRenameObjectType();
  return !!objectType && (supportsObjectRename(currentDatabaseType(), objectType) || supportsSourceBackedRoutineRename(currentDatabaseType(), objectType as any));
});

function openRenameObjectDialog() {
  renameObjectName.value = props.node.label;
  renameObjectError.value = "";
  renameObjectPreviewSql.value = "";
  showRenameObjectDialog.value = true;
}

let renameObjectPreviewRequestId = 0;

async function refreshRenameObjectPreviewSql() {
  const requestId = ++renameObjectPreviewRequestId;
  const objectType = nodeRenameObjectType();
  const newName = renameObjectName.value.trim();
  if (!showRenameObjectDialog.value || !objectType || !newName || newName === props.node.label) {
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
      schema: props.node.schema,
      oldName: props.node.label,
      newName,
    });
    if (requestId === renameObjectPreviewRequestId) renameObjectPreviewSql.value = sql;
  } catch {
    if (requestId === renameObjectPreviewRequestId) renameObjectPreviewSql.value = "";
  }
}

watch([showRenameObjectDialog, renameObjectName, () => props.node.label, () => props.node.schema, () => props.node.type, () => currentDatabaseType()], () => {
  void refreshRenameObjectPreviewSql();
});

async function confirmRenameObject() {
  const node = props.node;
  const objectType = nodeRenameObjectType();
  const newName = renameObjectName.value.trim();
  if (!objectType || !newName || newName === node.label || !node.connectionId || !node.database) return;
  renameObjectError.value = "";
  try {
    const dbType = currentDatabaseType();
    await connectionStore.ensureConnected(node.connectionId);
    if (supportsSourceBackedRoutineRename(dbType, objectType as any)) {
      const schema = node.schema || node.database;
      const source = await api.getObjectSource(node.connectionId, node.database, schema, node.label, objectType as any);
      const statements = await buildRoutineRenameObjectSourceStatements({
        databaseType: dbType!,
        objectType: objectType as any,
        schema,
        name: node.label,
        newName,
        source: source.source,
      });
      for (const sql of statements) {
        await api.executeQuery(node.connectionId, node.database, sql, schema);
      }
    } else {
      const sql = await buildRenameObjectSql({
        databaseType: dbType,
        objectType,
        schema: node.schema,
        oldName: node.label,
        newName,
      });
      await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    }
    toast(t("contextMenu.renameObjectSuccess", { oldName: node.label, newName }), 3000);
    showRenameObjectDialog.value = false;
    await refreshTableList(node);
  } catch (e: any) {
    renameObjectError.value = e?.message || String(e);
  }
}

async function confirmDropObject() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const options = dropObjectSqlOptions();
  if (!options) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = dropObjectPreviewSql.value || (await buildDropObjectSql(options));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    const msgKey = node.type === "view" ? "contextMenu.dropViewSuccess" : node.type === "procedure" ? "contextMenu.dropProcedureSuccess" : "contextMenu.dropFunctionSuccess";
    toast(t(msgKey, { name: node.label }), 3000);
    if (node.type === "view") {
      connectionStore.removeTreeNode(node.id);
    } else {
      await refreshTableList(node);
    }
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmDropTableChildObject() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const options = dropTableChildObjectSqlOptions();
  if (!options) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = dropTableChildObjectPreviewSql.value || (await buildDropTableChildObjectSql(options));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.dropTableChildObjectSuccess", { name: options.name }), 3000);
    connectionStore.removeTreeNode(node.id);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmBatchDrop() {
  const targets = selectedBatchDropTargets();
  if (!targets.length) return;
  try {
    for (const target of targets) {
      if (!target.connectionId || !target.database) continue;
      await connectionStore.ensureConnected(target.connectionId);
      const sql = await dropSqlForTreeNode(target);
      if (!sql) continue;
      await api.executeQuery(target.connectionId, target.database, sql, target.schema);
      connectionStore.removeTreeNode(target.id);
    }
    toast(t("contextMenu.batchDropSuccess", { count: targets.length }), 3000);
    showBatchDropConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

const isTableNotView = computed(() => props.node.type === "table");

const supportsTruncate = computed(() => {
  return supportsTableTruncate(currentDatabaseType());
});

const canCreateTable = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return (props.node.type === "database" || props.node.type === "schema" || props.node.type === "group-tables") && !!props.node.database && supportsTableStructureEditing(effectiveDatabaseTypeForConnection(config));
});

const canCreateDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && (supportsDatabaseCreation(config?.db_type) || config?.db_type === "duckdb");
});

const isDuckDbConnection = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && config?.db_type === "duckdb";
});

const canSetCreateDatabaseCharset = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return supportsCreateDatabaseCharset(config?.db_type, config?.driver_profile);
});

const canDropDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "database" && supportsDatabaseCreation(config?.db_type);
});

const canCreateSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "database" && usesTreeSchemaMode(config?.db_type) && !connectionUsesDatabaseObjectTreeMode(config);
});

const canDropSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "schema" && usesTreeSchemaMode(config?.db_type) && !connectionUsesDatabaseObjectTreeMode(config);
});

function tableAdminSqlOptions(): TableAdminSqlOptions {
  return {
    databaseType: currentDatabaseType(),
    schema: props.node.schema,
    tableName: props.node.label,
  };
}

async function refreshDropTablePreviewSql() {
  dropTablePreviewSql.value = "";
  dropTablePreviewSql.value = await buildDropTableSql(tableAdminSqlOptions()).catch(() => "");
}

async function refreshEmptyTablePreviewSql() {
  emptyTablePreviewSql.value = "";
  emptyTablePreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions()).catch(() => "");
}

async function refreshTruncateTablePreviewSql() {
  truncateTablePreviewSql.value = "";
  truncateTablePreviewSql.value = await buildTruncateTableSql(tableAdminSqlOptions()).catch(() => "");
}

function dropTable() {
  void refreshDropTablePreviewSql();
  showDropTableConfirm.value = true;
}

async function refreshTableList(node: TreeNode) {
  if (!node.connectionId || !node.database) return;
  await connectionStore.refreshObjectListTreeNode(node.connectionId, node.database, node.schema);
}

async function confirmDropTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = dropTablePreviewSql.value || (await buildDropTableSql(tableAdminSqlOptions()));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.dropTableSuccess", { name: node.label }), 3000);
    connectionStore.removeTreeNode(node.id);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function emptyTable() {
  void refreshEmptyTablePreviewSql();
  showEmptyTableConfirm.value = true;
}

async function confirmEmptyTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = emptyTablePreviewSql.value || (await buildEmptyTableSql(tableAdminSqlOptions()));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.emptyTableSuccess", { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function truncateTable() {
  void refreshTruncateTablePreviewSql();
  showTruncateTableConfirm.value = true;
}

async function confirmTruncateTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = truncateTablePreviewSql.value || (await buildTruncateTableSql(tableAdminSqlOptions()));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.truncateTableSuccess", { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshDropDatabasePreviewSql() {
  dropDatabasePreviewSql.value = "";
  dropDatabasePreviewSql.value = await buildDropDatabaseSql({
    databaseType: currentDatabaseType(),
    name: props.node.label,
  }).catch(() => "");
}

async function refreshDropSchemaPreviewSql() {
  dropSchemaPreviewSql.value = "";
  dropSchemaPreviewSql.value = await buildDropSchemaSql({
    databaseType: currentDatabaseType(),
    name: props.node.label,
  }).catch(() => "");
}

async function openCreateDatabase() {
  if (isDuckDbConnection.value) {
    await createDuckDbAttachedDatabaseFile();
    return;
  }
  openCreateDatabaseDialog();
}

function openCreateDatabaseDialog() {
  createDatabaseName.value = "";
  createDatabaseCharset.value = "utf8mb4";
  createDatabaseCollation.value = "utf8mb4_unicode_ci";
  showCreateDatabaseDialog.value = true;
}

function ensureDuckDbFileExtension(path: string): string {
  return /\.(duckdb|db)$/i.test(path) ? path : `${path}.duckdb`;
}

async function createDuckDbAttachedDatabaseFile() {
  const node = props.node;
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
    const name = uniqueDuckDbAttachedDatabaseName(
      duckDbAttachedDatabaseNameFromPath(path),
      existingDatabases.map((database) => database.name),
    );
    await api.executeQuery(node.connectionId, "", await buildDuckDbAttachDatabaseSql(path, name));

    const config = connectionStore.getConfig(node.connectionId);
    if (config) {
      await connectionStore.updateConnection({
        ...config,
        attached_databases: [...(config.attached_databases ?? []), { name, path }],
      });
    }
    await connectionStore.loadDatabases(node.connectionId, { force: true });
    connectionStore.selectedTreeNodeId = `${node.connectionId}:${name}`;
    toast(t("contextMenu.createDuckDbFileSuccess", { name }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmCreateDatabase() {
  const node = props.node;
  const name = createDatabaseName.value.trim();
  if (!name || !node.connectionId) return;
  showCreateDatabaseDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const config = connectionStore.getConfig(node.connectionId);
    const sql = await buildCreateDatabaseSql({
      databaseType: config?.db_type,
      driverProfile: config?.driver_profile,
      name,
      charset: createDatabaseCharset.value,
      collation: createDatabaseCollation.value,
    });
    await api.executeQuery(node.connectionId, "", sql);
    toast(t("contextMenu.createDatabaseSuccess", { name }), 3000);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function dropDatabase() {
  void refreshDropDatabasePreviewSql();
  showDropDatabaseConfirm.value = true;
}

function flushRedisDb() {
  showFlushRedisDbConfirm.value = true;
}

async function confirmFlushRedisDb() {
  const node = props.node;
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
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmDropDatabase() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql =
      dropDatabasePreviewSql.value ||
      (await buildDropDatabaseSql({
        databaseType: currentDatabaseType(),
        name: node.label,
      }));
    await api.executeQuery(node.connectionId, "", sql);
    toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function openCreateSchemaDialog() {
  createSchemaName.value = "";
  showCreateSchemaDialog.value = true;
}

async function confirmCreateSchema() {
  const node = props.node;
  const name = createSchemaName.value.trim();
  if (!name || !node.connectionId || !node.database) return;
  showCreateSchemaDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = await buildCreateSchemaSql({
      databaseType: currentDatabaseType(),
      name,
    });
    await api.executeQuery(node.connectionId, node.database, sql);
    toast(t("contextMenu.createSchemaSuccess", { name }), 3000);
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

function dropSchema() {
  void refreshDropSchemaPreviewSql();
  showDropSchemaConfirm.value = true;
}

async function confirmDropSchema() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql =
      dropSchemaPreviewSql.value ||
      (await buildDropSchemaSql({
        databaseType: currentDatabaseType(),
        name: node.label,
      }));
    await api.executeQuery(node.connectionId, node.database, sql);
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

function duplicateStructure(source: TreeNode = props.node) {
  if (!isDuplicateStructureSource(source)) return;
  duplicateStructureSource.value = source;
  duplicateTableName.value = `${source.label}_copy`;
  showDuplicateDialog.value = true;
}

function isDuplicateStructureSource(node: TreeNode): node is DuplicateStructureSource {
  return node.type === "table" && !!node.connectionId && !!node.database;
}

async function confirmDuplicateStructure() {
  const node = duplicateStructureSource.value || (isDuplicateStructureSource(props.node) ? props.node : null);
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
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.duplicateStructureSuccess", { name: newName }), 3000);
    await refreshTableList(node);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function createTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  queryStore.openTableStructure(node.connectionId, node.database, node.schema, "");
}

function createView() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.activeConnectionId = node.connectionId;
  const viewName = node.schema ? `${node.schema}.new_view` : "new_view";
  const tabId = queryStore.createTab(node.connectionId, node.database, t("contextMenu.createView"), "query", node.schema);
  queryStore.updateSql(tabId, `CREATE VIEW ${viewName} AS\nSELECT\n  *\nFROM table_name;\n`);
}

async function saveFileContent(content: string, defaultFileName: string, filterName: string, filterExt: string) {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    if (path) await writeTextFile(path, content);
  } else {
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function exportStructure() {
  const targets = structureExportTargets();
  if (!targets.length) return;
  isLoadingStructurePreview.value = true;
  structurePreviewError.value = "";
  structurePreviewSql.value = "";
  structurePreviewTitle.value = targets.length === 1 ? t("contextMenu.exportStructurePreviewTitle", { name: targets[0]!.label }) : t("contextMenu.exportStructurePreviewTitleMultiple", { count: targets.length });
  structurePreviewDefaultFileName.value = targets.length === 1 ? `${targets[0]!.label}.sql` : "structures.sql";
  showStructurePreviewDialog.value = true;
  try {
    const parts: string[] = [];
    for (const target of targets) {
      await connectionStore.ensureConnected(target.connectionId);
      const ddl = await api.getTableDdl(target.connectionId, target.database, target.schema || target.database, target.label);
      parts.push(ddl.trim());
    }
    structurePreviewSql.value = `${parts.filter(Boolean).join("\n\n")}\n`;
  } catch (e: any) {
    structurePreviewError.value = e?.message || String(e);
    console.error("Export structure failed:", e);
  } finally {
    isLoadingStructurePreview.value = false;
  }
}

function canExportStructureNode(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return (node.type === "table" || node.type === "view") && !!node.connectionId && !!node.database;
}

function selectedStructureNodes(): TreeNode[] {
  const selectedIds = new Set(connectionStore.selectedTreeNodeIds);
  if (!selectedIds.size) return [];
  const nodes: TreeNode[] = [];
  const visit = (items: TreeNode[]) => {
    for (const item of items) {
      if (selectedIds.has(item.id) && canExportStructureNode(item)) nodes.push(item);
      if (item.children) visit(item.children);
    }
  };
  visit(connectionStore.treeNodes);
  return nodes;
}

function structureExportTargets(): Array<TreeNode & { connectionId: string; database: string }> {
  if (!canExportStructureNode(props.node)) return [];
  const selected = selectedStructureNodes().filter((node): node is TreeNode & { connectionId: string; database: string } => canExportStructureNode(node) && node.connectionId === props.node.connectionId && node.database === props.node.database);
  return selected.some((node) => node.id === props.node.id) ? selected : [props.node];
}

function structureTargetName(target: TreeNode): string {
  return target.schema ? `${target.schema}.${target.label}` : target.label;
}

function columnDocValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function tsvCell(value: unknown): string {
  return columnDocValue(value).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

function markdownCell(value: unknown): string {
  return columnDocValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function columnDocHeaders(includeTable: boolean): string[] {
  const headers = [t("contextMenu.structureDocColumn"), t("contextMenu.structureDocType"), t("contextMenu.structureDocPrimaryKey"), t("contextMenu.structureDocNullable"), t("contextMenu.structureDocDefault"), t("contextMenu.structureDocComment")];
  return includeTable ? [t("contextMenu.structureDocTable"), ...headers] : headers;
}

function columnDocCells(target: TreeNode, column: ColumnInfo, includeTable: boolean): unknown[] {
  const cells = [column.name, column.data_type, column.is_primary_key ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.is_nullable ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.column_default, column.comment];
  return includeTable ? [structureTargetName(target), ...cells] : cells;
}

async function tableColumnsForStructureCopy(target: TreeNode & { connectionId: string; database: string }): Promise<ColumnInfo[]> {
  await connectionStore.ensureConnected(target.connectionId);
  return (await api.getColumns(target.connectionId, target.database, target.schema || target.database, target.label)) as ColumnInfo[];
}

async function buildStructureCopyText(format: StructureCopyFormat): Promise<string> {
  const targets = structureExportTargets();
  if (!targets.length) return "";
  const includeTable = targets.length > 1;
  const headers = columnDocHeaders(includeTable);

  if (format === "tsv") {
    const lines = [headers.map(tsvCell).join("\t")];
    for (const target of targets) {
      const columns = await tableColumnsForStructureCopy(target);
      for (const column of columns) {
        lines.push(columnDocCells(target, column, includeTable).map(tsvCell).join("\t"));
      }
    }
    return `${lines.join("\n")}\n`;
  }

  const tables: string[] = [];
  const markdownHeaders = columnDocHeaders(false);
  for (const target of targets) {
    const columns = await tableColumnsForStructureCopy(target);
    const tableLines = [`### ${markdownCell(structureTargetName(target))}`, "", `| ${markdownHeaders.map(markdownCell).join(" | ")} |`, `| ${markdownHeaders.map(() => "---").join(" | ")} |`, ...columns.map((column) => `| ${columnDocCells(target, column, false).map(markdownCell).join(" | ")} |`)];
    tables.push(tableLines.join("\n"));
  }
  return `${tables.join("\n\n")}\n`;
}

async function copyStructureAs(format: StructureCopyFormat) {
  let text = "";
  try {
    text = await buildStructureCopyText(format);
    if (!text) return;
    await copyToClipboard(text);
    toast(t("contextMenu.structureDocCopied"), 2000);
  } catch (e: any) {
    if (text) {
      structureDocCopyText.value = text;
      structureDocCopyTitle.value = format === "tsv" ? t("contextMenu.copyStructureAsTsv") : t("contextMenu.copyStructureAsMarkdown");
      showStructureDocCopyDialog.value = true;
      return;
    }
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyStructureDocText() {
  if (!structureDocCopyText.value) return;
  try {
    await copyToClipboard(structureDocCopyText.value);
    toast(t("contextMenu.structureDocCopied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function selectTextareaContent(event: FocusEvent) {
  if (event.target instanceof HTMLTextAreaElement) event.target.select();
}

async function copyStructurePreview() {
  if (!structurePreviewSql.value) return;
  try {
    await copyToClipboard(structurePreviewSql.value);
    toast(t("contextMenu.exportStructureCopied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function saveStructurePreview() {
  if (!structurePreviewSql.value) return;
  try {
    await saveFileContent(structurePreviewSql.value, structurePreviewDefaultFileName.value, "SQL", "sql");
    toast(t("grid.exported"));
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportDataLegacy(format: "csv" | "json" | "sql") {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const connectionId = node.connectionId;
  const database = node.database;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return;

  try {
    await connectionStore.ensureConnected(connectionId);
    const tableColumns = format === "sql" ? await api.getColumns(connectionId, database, node.schema || database, node.label) : undefined;
    const queryColumns = config.db_type === "neo4j" ? (tableColumns ?? (await api.getColumns(connectionId, database, node.schema || database, node.label))).map((column) => column.name) : undefined;
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const result = await fetchTableDataForExport({
      databaseType: effectiveDbType,
      schema: node.schema,
      tableName: node.label,
      columns: queryColumns,
      executePage: (sql) => api.executeQuery(connectionId, database, sql),
    });

    if (format === "csv") {
      let outputPath = `${node.label}.csv`;
      if (isTauriRuntime()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: outputPath,
          filters: [{ name: "CSV", extensions: ["csv"] }],
        });
        if (!path) return;
        outputPath = path as string;
      }
      await api.exportQueryResultCsv(outputPath, result.columns, result.rows);
      toast(t("grid.exported"));
      return;
    }

    if (format === "json") {
      let outputPath = `${node.label}.json`;
      if (isTauriRuntime()) {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: outputPath,
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        outputPath = path as string;
      }
      await api.exportQueryResultJson(outputPath, result.columns, result.rows);
      toast(t("grid.exported"));
      return;
    }

    const content = await formatSqlInsert({
      databaseType: effectiveDbType,
      schema: node.schema,
      tableName: node.label,
      columns: result.columns,
      columnTypes: tableColumns ? columnTypesForResultColumns(result.columns, tableColumns) : undefined,
      rows: result.rows,
    });
    await saveFileContent(content, `${node.label}.sql`, "SQL", "sql");
    toast(t("grid.exported"));
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function columnTypesForResultColumns(columns: string[], tableColumns: ColumnInfo[]): Array<string | undefined> {
  const typesByName = new Map(tableColumns.map((column) => [column.name.toLocaleLowerCase(), column.data_type]));
  return columns.map((column) => typesByName.get(column.toLocaleLowerCase()));
}

async function exportData(format: "csv" | "json" | "sql") {
  if (format !== "csv") {
    await exportDataLegacy(format);
    return;
  }
  await exportTableData("csv");
}

async function exportTableData(format: "csv" | "xlsx") {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const connectionId = node.connectionId;
  const database = node.database;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return;

  let task: ExportTask | null = null;
  try {
    await connectionStore.ensureConnected(connectionId);

    // Step 1: Open save dialog FIRST
    let outputPath = `${node.label}.${format}`;
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: outputPath,
        filters: [{ name: format === "csv" ? "CSV" : "Excel", extensions: [format] }],
      });
      if (!path) return;
      outputPath = path as string;
    }

    // Step 2: Register task in export tracker (background)
    task = addExportTask(node.label, format, outputPath);
    const currentTask = task;

    // Step 3: Get query columns for neo4j
    const queryColumns = config.db_type === "neo4j" ? (await api.getColumns(connectionId, database, node.schema || database, node.label)).map((c) => c.name) : undefined;

    // Step 4: Start streaming export (background, non-blocking)
    const request: api.TableExportRequest = {
      exportId: currentTask.exportId,
      connectionId,
      database,
      schema: node.schema || undefined,
      tableName: node.label,
      filePath: outputPath,
      format,
      columns: queryColumns,
      batchSize: settingsStore.editorSettings.exportBatchSize,
    };

    await api.startTableExport(request, (progress) => {
      currentTask.rowsExported = progress.rowsExported;
      currentTask.totalRows = progress.totalRows;
      currentTask.status = progress.status;
      currentTask.errorMessage = progress.errorMessage || null;
      if (progress.status === "Done") {
        toast(t("grid.exported"));
      } else if (progress.status === "Error") {
        toast(t("grid.exportFailed", { message: progress.errorMessage || "" }), 5000);
      }
    });
  } catch (e: any) {
    if (task) {
      task.status = "Error";
      task.errorMessage = e?.message || String(e);
    }
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportDataXlsx() {
  await exportTableData("xlsx");
}

function editConnection() {
  if (props.node.connectionId) {
    connectionStore.startEditing(props.node.connectionId);
  }
}

async function disconnectConnection() {
  if (props.node.connectionId) {
    try {
      await connectionStore.disconnect(props.node.connectionId);
      props.node.isExpanded = false;
      props.node.children = [];
      toast(t("connection.disconnected"), 2000);
    } catch (e: any) {
      toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
    }
  }
}

async function closeDatabaseConnection() {
  const node = props.node;
  if (node.type !== "database" || !node.connectionId || node.database == null) return;
  try {
    await connectionStore.closeDatabaseConnection(node.connectionId, node.database);
    toast(t("connection.databaseConnectionClosed", { name: node.label }), 2000);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

function openTransfer() {
  if (props.node.connectionId) {
    connectionStore.transferSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}

function openSchemaDiff() {
  if (props.node.connectionId) {
    connectionStore.schemaDiffSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
      schema: props.node.schema,
    };
  }
}

function openDataCompare() {
  if (props.node.connectionId) {
    connectionStore.dataCompareSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
      schema: props.node.schema,
      tableName: props.node.type === "table" ? props.node.label : undefined,
    };
  }
}

function openSqlFileExecution() {
  if (props.node.connectionId) {
    connectionStore.sqlFileSource = {
      connectionId: props.node.connectionId,
      database: props.node.database ?? "",
    };
  }
}

function openDiagram() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.diagramSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.type === "table" ? node.label : undefined,
  };
}

function openDatabaseSearch() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.databaseSearchSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.type === "schema" ? node.schema : undefined,
  };
}

function openDatabaseExport() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.databaseExportSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.type === "schema" || node.type === "table" || node.type === "view" ? node.schema : undefined,
    tableName: node.type === "table" || node.type === "view" ? node.label : undefined,
  };
}

function openTableImport() {
  const node = props.node;
  if (node.type !== "table" || !node.connectionId || !node.database) return;
  connectionStore.tableImportSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.label,
  };
}

function openStructureEditor() {
  const node = props.node;
  if (node.type !== "table" || !node.connectionId || !node.database) return;
  queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.label);
}

function openFieldLineage() {
  const node = props.node;
  const column = node.type === "column" && node.meta && "name" in node.meta ? node.meta.name : node.label;
  if (node.type !== "column" || !node.connectionId || !node.database || !node.tableName || !column) return;
  connectionStore.fieldLineageSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.tableName,
    columnName: column,
  };
}

const canExpand = computed(() =>
  canTreeNodeShowExpander({
    type: props.node.type,
    childCount: props.node.children?.length ?? 0,
  }),
);
const canPin = computed(() => pinnableTypes.has(props.node.type));
const canOpenSqlFileExecution = computed(() => {
  return supportsSqlFileExecution(rawDatabaseType());
});
const canOpenDiagram = computed(() => {
  return !!props.node.database && supportsSchemaDiagram(currentDatabaseType());
});
const canOpenDatabaseSearch = computed(() => {
  return !!props.node.database && supportsDatabaseSearch(currentDatabaseType());
});
const canOpenObjectBrowser = computed(() => {
  return supportsObjectBrowserTreeNode(rawDatabaseType(), props.node.type);
});
const canOpenTableImport = computed(() => {
  return props.node.type === "table" && !!props.node.database && supportsTableImport(currentDatabaseType());
});
const canOpenStructureEditor = computed(() => {
  return props.node.type === "table" && !!props.node.database && supportsTableStructureEditing(currentDatabaseType());
});
const canOpenFieldLineage = computed(() => {
  return props.node.type === "column" && !!props.node.database && !!props.node.tableName && supportsFieldLineage(currentDatabaseType());
});
const isPinned = computed(() => props.node.pinned || connectionStore.isTreeNodePinned(props.node.id));
const isNodeDefaultDatabase = computed(() => (props.node.type === "database" || props.node.type === "redis-db" || props.node.type === "mongo-db") && !!props.node.connectionId && !!props.node.database && connectionStore.isDefaultDatabase(props.node.connectionId, props.node.database));
const hasTypeMenu = computed(() => {
  const t = props.node.type;
  return t === "connection" || t === "database" || t === "schema" || t === "table" || t === "view" || t === "column" || t === "procedure" || t === "function" || t === "package" || t === "package-body" || isGroupLabel(props.node);
});
const columnComment = computed(() => (props.node.type === "column" && props.node.meta && "comment" in props.node.meta ? (props.node.meta as any).comment : null));
const tableComment = computed(() => ((props.node.type === "table" || props.node.type === "view" || props.node.type === "mongo-collection") && props.node.comment ? props.node.comment : null));
const paddingLeft = computed(() => treeItemPaddingLeft(props.depth));
const isConnected = computed(() => props.node.type === "connection" && !!props.node.connectionId && connectionStore.connectedIds.has(props.node.connectionId));
const canCloseDatabaseConnection = computed(() => props.node.type === "database" && !!props.node.connectionId && props.node.database != null && connectionStore.connectedIds.has(props.node.connectionId));
const nodeIconClass = computed(() => {
  const infoClass = getIconInfo(props.node)?.colorClass;
  if (props.node.type !== "database") return infoClass;
  return canCloseDatabaseConnection.value ? infoClass : "text-muted-foreground/65";
});
const canConfigureVisibleDatabases = computed(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return false;
  const dbType = connectionStore.getConfig(props.node.connectionId)?.db_type;
  return dbType !== "elasticsearch" && dbType !== "etcd";
});
const canCopyFinalProxyPort = computed(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return false;
  return hasEnabledTransportLayers(connectionStore.getConfig(props.node.connectionId));
});

function connectionIconType(connectionId?: string) {
  const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
  return config?.driver_profile || config?.db_type || "postgres";
}

const connectionColor = computed(() => {
  const connectionId = props.node.connectionId;
  return connectionId ? connectionStore.getConfig(connectionId)?.color || "" : "";
});
const isActiveConnectionScope = computed(() => !!props.node.connectionId && connectionStore.activeConnectionId === props.node.connectionId);
const isSelected = computed(() => connectionStore.selectedTreeNodeId === props.node.id);
const isMultiSelected = computed(() => connectionStore.selectedTreeNodeIds.includes(props.node.id));
const rowStyle = computed(() => {
  const color = connectionColor.value;
  const backgroundColor = hexToRgba(color, isActiveConnectionScope.value ? 0.14 : 0.08);
  return {
    paddingLeft: paddingLeft.value,
    "--tree-connection-row-bg": backgroundColor,
    "--tree-connection-row-hover-bg": hexToRgba(color, isActiveConnectionScope.value ? 0.18 : 0.12),
    "--tree-connection-active-bg": hexToRgba(color, 0.18),
    "--tree-connection-active-focus-bg": hexToRgba(color, 0.22),
  };
});

function togglePin() {
  connectionStore.toggleTreeNodePin(props.node.id);
}

function openVisibleDatabasesDialog() {
  showVisibleDatabasesDialog.value = true;
}

// --- Connection Group Management ---
const isRenamingGroup = ref(false);
const renameInput = ref("");
const renameInputRef = ref<HTMLInputElement>();

function startRenameGroup() {
  renameInput.value = props.node.label;
  isRenamingGroup.value = true;
  emit("rename-started");
  nextTick(() => {
    focusSidebarRenameInput(() => (isRenamingGroup.value ? renameInputRef.value : undefined));
  });
}

watch(
  () => props.pendingRename,
  (val) => {
    if (val && props.node.type === "connection-group") {
      startRenameGroup();
    }
  },
  { immediate: true },
);

function finishRenameGroup() {
  // Guard against double invocation: pressing Enter sets isRenamingGroup=false
  // and unmounts the input, which then fires @blur -> finishRenameGroup again.
  // The first call can rebuild the tree and recycle props.node onto a different
  // group, so a second run would act on the wrong group and cascade across
  // groups (issue #681).
  if (!isRenamingGroup.value) return;
  isRenamingGroup.value = false;
  const trimmed = renameInput.value.trim();
  // An empty name cancels the rename and keeps the group as-is — never delete
  // here. Deleting a group is done explicitly via the context menu (issue #681).
  if (!trimmed || trimmed === props.node.label) return;
  connectionStore.renameConnectionGroup(props.node.id, trimmed);
}

function deleteConnectionGroup() {
  showDeleteGroupConfirm.value = true;
}

function newConnectionInGroup() {
  connectionStore.startCreatingConnectionInGroup(props.node.id);
}

function confirmDeleteGroup() {
  connectionStore.deleteConnectionGroup(props.node.id);
  showDeleteGroupConfirm.value = false;
  toast(t("connection.groupDeleted"), 2000);
}

const showDeleteGroupConfirm = ref(false);

function moveToGroup(groupId: string | null) {
  if (props.node.connectionId) {
    connectionStore.moveConnectionToGroup(props.node.connectionId, groupId);
  }
}

const showMoveToNewGroupDialog = ref(false);
const moveToNewGroupName = ref("");

function moveToNewGroup() {
  moveToNewGroupName.value = "";
  showMoveToNewGroupDialog.value = true;
}

function confirmMoveToNewGroup() {
  const name = moveToNewGroupName.value.trim();
  if (name && props.node.connectionId) {
    const groupId = connectionStore.createConnectionGroup(name);
    connectionStore.moveConnectionToGroup(props.node.connectionId, groupId);
  }
  showMoveToNewGroupDialog.value = false;
}

const availableGroups = computed(() => connectionStore.sidebarLayout.groups);

const currentGroupId = computed(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return null;
  for (const entry of connectionStore.sidebarLayout.order) {
    if (entry.type === "group" && entry.connectionIds.includes(props.node.connectionId)) {
      return entry.id;
    }
  }
  return null;
});

// --- Drag and Drop ---
import { useDragSort } from "@/composables/useDragSort";

const {
  state: dragState,
  startDrag,
  updateTarget,
  clearTarget,
} = useDragSort((draggedId, targetId, position) => {
  // If the grabbed row is part of a multi-selection, move all selected rows
  // together; otherwise just the grabbed one (issue #681).
  const selected = connectionStore.selectedTreeNodeIds;
  const draggedIds = selected.length > 1 && selected.includes(draggedId) ? [...selected] : [draggedId];
  connectionStore.reorderSidebarEntries(draggedIds, targetId, position);
});

const isDraggable = computed(() => {
  if (props.dragDisabled) return false;
  return props.node.type === "connection" || props.node.type === "connection-group";
});

const isDropTarget = computed(() => props.node.type === "connection" || props.node.type === "connection-group");

const showDropBefore = computed(() => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "before");
const showDropAfter = computed(() => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "after");
const showDropInside = computed(() => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "inside");
const isDragging = computed(() => dragState.active && dragState.draggedId === props.node.id);
const TABLE_REFERENCE_DRAG_THRESHOLD = 5;
const TABLE_REFERENCE_DRAGGING_CLASS = "dbx-table-reference-dragging";
const canDragTableReference = computed(() => !props.dragDisabled && (props.node.type === "table" || props.node.type === "view") && !!props.node.connectionId && props.node.database != null);

let pendingTableReferenceDrag: {
  payload: QueryEditorTableReferencePayload;
  startX: number;
  startY: number;
} | null = null;
let draggingTableReferencePayload: QueryEditorTableReferencePayload | null = null;
let suppressNextTableReferenceClick = false;

function tableReferenceDragPayload(): QueryEditorTableReferencePayload | null {
  if (!canDragTableReference.value) return null;
  const payload = createTableReferencePayload({
    connectionId: props.node.connectionId,
    database: props.node.database,
    schema: props.node.schema,
    tableName: props.node.label,
    databaseType: currentDatabaseType(),
  });
  return payload;
}

function startTableReferenceDrag(payload: QueryEditorTableReferencePayload) {
  draggingTableReferencePayload = payload;
  setActiveTableReferencePayload(payload);
  document.getSelection()?.removeAllRanges();
  document.body.style.cursor = "copy";
}

function finishTableReferenceDrag() {
  clearActiveTableReferencePayload(draggingTableReferencePayload);
  pendingTableReferenceDrag = null;
  draggingTableReferencePayload = null;
  document.body.classList.remove(TABLE_REFERENCE_DRAGGING_CLASS);
  document.body.style.cursor = "";
  document.removeEventListener("mousemove", onTableReferenceMouseMove, true);
  document.removeEventListener("mouseup", onTableReferenceMouseUp, true);
}

function onTableReferenceMouseMove(event: MouseEvent) {
  if (!pendingTableReferenceDrag && !draggingTableReferencePayload) return;
  if (pendingTableReferenceDrag && !draggingTableReferencePayload) {
    const dx = event.clientX - pendingTableReferenceDrag.startX;
    const dy = event.clientY - pendingTableReferenceDrag.startY;
    if (Math.abs(dx) < TABLE_REFERENCE_DRAG_THRESHOLD && Math.abs(dy) < TABLE_REFERENCE_DRAG_THRESHOLD) return;
    startTableReferenceDrag(pendingTableReferenceDrag.payload);
  }
  if (draggingTableReferencePayload) {
    event.preventDefault();
    document.getSelection()?.removeAllRanges();
  }
}

function onTableReferenceMouseUp(event: MouseEvent) {
  const payload = draggingTableReferencePayload;
  if (payload) {
    suppressNextTableReferenceClick = true;
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (target instanceof Element && target.closest("[data-query-editor-root]")) {
      window.dispatchEvent(
        createTableReferenceDropEvent({
          payload,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    }
  }
  finishTableReferenceDrag();
}

function startTableReferenceMouseDrag(event: MouseEvent) {
  if (event.button !== 0) return;
  const payload = tableReferenceDragPayload();
  if (!payload) return;
  event.preventDefault();
  document.getSelection()?.removeAllRanges();
  document.body.classList.add(TABLE_REFERENCE_DRAGGING_CLASS);
  pendingTableReferenceDrag = { payload, startX: event.clientX, startY: event.clientY };
  document.addEventListener("mousemove", onTableReferenceMouseMove, true);
  document.addEventListener("mouseup", onTableReferenceMouseUp, true);
}

function onRowMouseDown(event: MouseEvent) {
  if (isDraggable.value) {
    startDrag(event, props.node.id, props.node.type);
  } else if (canDragTableReference.value) {
    startTableReferenceMouseDrag(event);
  }
}

onBeforeUnmount(() => finishTableReferenceDrag());

// ---- CustomContextMenu ----

const shortcutCopyName = computed(() => formatShortcut("Mod+C"));
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

function treeItemMenuItems(): ContextMenuItem[] {
  const node = props.node;
  const items: ContextMenuItem[] = [];
  const batchDropCount = selectedBatchDropTargets().length;
  const deleteMenuLabel = (singleLabel: string) => (batchDropCount > 1 ? batchDropMenuLabel() : singleLabel);
  const deleteMenuAction = (singleAction: () => void) => (batchDropCount > 1 ? requestBatchDrop : singleAction);

  // 1. Pin toggle
  if (canPin.value) {
    items.push({
      label: isPinned.value ? t("contextMenu.unpin") : t("contextMenu.pin"),
      action: togglePin,
      icon: Pin,
    });
    if (hasTypeMenu.value) items.push({ label: "", separator: true });
  }

  // 2. Connection
  if (node.type === "connection") {
    if (!isConnected.value) {
      items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: Plug });
    } else {
      items.push({ label: t("contextMenu.closeConnection"), action: disconnectConnection, icon: Unplug });
    }
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (supportsDatabaseUserAdmin(currentDatabaseType())) {
      items.push({ label: t("contextMenu.userAdmin"), action: openUserAdmin, icon: UsersRound });
    }
    if (canCopyFinalProxyPort.value) {
      items.push({ label: t("contextMenu.copyFinalProxyPort"), action: copyFinalProxyPort, icon: Network });
    }
    if (canOpenSqlFileExecution.value) {
      items.push({ label: t("sqlFile.title"), action: openSqlFileExecution, icon: FileCode });
    }
    if (canCreateDatabase.value) {
      items.push({
        label: isDuckDbConnection.value ? t("contextMenu.createDuckDbFile") : t("contextMenu.createDatabase"),
        action: openCreateDatabase,
        icon: Plus,
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
        label: t("contextMenu.selectVisibleDatabases"),
        action: openVisibleDatabasesDialog,
        icon: ListFilter,
      });
    }
    items.push({ label: t("contextMenu.editConnection"), action: editConnection, icon: Pencil });
    items.push({ label: t("contextMenu.duplicateConnection"), action: duplicateConnection, icon: CopyPlus });
    items.push({ label: "", separator: true });
    items.push({
      label: connectionDeleteMenuLabel(),
      action: deleteConnection,
      icon: Trash2,
      shortcut: shortcutDelete,
      variant: "destructive" as const,
    });
    return items;
  }

  // 3. Connection Group
  if (node.type === "connection-group") {
    items.push({ label: t("toolbar.newConnection"), action: newConnectionInGroup, icon: Plus });
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
    return items;
  }

  // 4. Database / Schema
  if (node.type === "database" || node.type === "schema") {
    if (canOpenObjectBrowser.value) {
      items.push({ label: t("contextMenu.openObjectBrowser"), action: openObjectBrowser, icon: TableProperties });
    }
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (node.type === "database") {
      if (!isNodeDefaultDatabase.value) {
        items.push({ label: t("contextMenu.setDefaultDatabase"), action: setNodeAsDefaultDatabase, icon: Database });
      } else {
        items.push({ label: t("contextMenu.clearDefaultDatabase"), action: clearNodeDefaultDatabase, icon: Database });
      }
    }
    if (canCreateTable.value) {
      items.push({ label: t("contextMenu.createTable"), action: createTable, icon: Plus });
    }
    if (canCreateSchema.value) {
      items.push({ label: t("contextMenu.createSchema"), action: openCreateSchemaDialog, icon: Plus });
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
    items.push({ label: "", separator: true });
    items.push({ label: t("transfer.dataTransfer"), action: openTransfer, icon: ArrowRightLeft });
    items.push({ label: t("diff.title"), action: openSchemaDiff, icon: ArrowRightLeft });
    items.push({ label: t("dataCompare.title"), action: openDataCompare, icon: ArrowRightLeft });
    items.push({ label: t("contextMenu.exportDatabase"), action: openDatabaseExport, icon: Upload });
    if (canCloseDatabaseConnection.value) {
      items.push({ label: "", separator: true });
      items.push({ label: t("contextMenu.closeDatabaseConnection"), action: closeDatabaseConnection, icon: Unplug });
    }
    if (canDropDatabase.value || canDropSchema.value) {
      items.push({ label: "", separator: true });
    }
    if (canDropDatabase.value) {
      items.push({
        label: t("contextMenu.dropDatabase"),
        action: dropDatabase,
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
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
    return items;
  }

  // 5. Redis DB / Mongo DB
  if (node.type === "etcd-root") {
    items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: Database });
    return items;
  }

  if (node.type === "user-admin") {
    items.push({ label: t("contextMenu.openUserAdmin"), action: openUserAdmin, icon: UsersRound });
    return items;
  }

  if (node.type === "redis-db" || node.type === "mongo-db") {
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    if (!isNodeDefaultDatabase.value) {
      items.push({ label: t("contextMenu.setDefaultDatabase"), action: setNodeAsDefaultDatabase, icon: Database });
    } else {
      items.push({ label: t("contextMenu.clearDefaultDatabase"), action: clearNodeDefaultDatabase, icon: Database });
    }
    if (node.type === "redis-db") {
      items.push({ label: "", separator: true });
      items.push({ label: t("redis.flushDb"), action: flushRedisDb, icon: Eraser, variant: "destructive" as const });
    }
    return items;
  }

  // 6. Table / View
  if (node.type === "table" || node.type === "view") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: openData, icon: TableProperties });
    if (node.type === "view") {
      items.push({ label: t("contextMenu.editView"), action: viewObjectSource, icon: Pencil });
      items.push({ label: t("contextMenu.viewSource"), action: viewObjectSource, icon: Code2 });
      items.push({ label: t("contextMenu.viewDdl"), action: viewObjectDdl, icon: FileCode });
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
    if (node.type === "view") {
      items.push({
        label: deleteMenuLabel(t("contextMenu.dropView")),
        action: deleteMenuAction(requestDropObject),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
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
      items.push({ label: "", separator: true });
      if (supportsTruncate.value) {
        items.push({
          label: t("contextMenu.truncateTable"),
          action: truncateTable,
          icon: Scissors,
          variant: "destructive" as const,
        });
      }
      items.push({
        label: t("contextMenu.emptyTable"),
        action: emptyTable,
        icon: Eraser,
        variant: "destructive" as const,
      });
      items.push({
        label: deleteMenuLabel(t("contextMenu.dropTable")),
        action: deleteMenuAction(dropTable),
        icon: Trash2,
        shortcut: shortcutDelete,
        variant: "destructive" as const,
      });
    }
    items.push({ label: "", separator: true });
    items.push({
      label: t("contextMenu.refreshChildren"),
      action: refresh,
      icon: RefreshCw,
      shortcut: shortcutRefresh,
    });
    return items;
  }

  // 7. Column
  if (node.type === "column") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    if (canOpenFieldLineage.value) {
      items.push({ label: "", separator: true });
      items.push({ label: t("lineage.open"), action: openFieldLineage, icon: Network });
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
    return items;
  }

  if (node.type === "index" || node.type === "fkey" || node.type === "trigger") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
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
    return items;
  }

  // 8. Procedure / Function / Package
  if (node.type === "procedure" || node.type === "function") {
    if (node.type === "procedure") {
      items.push({ label: t("contextMenu.executeProcedure"), action: openProcedureExecution, icon: Play });
    }
    items.push({ label: t("contextMenu.viewSource"), action: viewObjectSource, icon: Code2 });
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
    return items;
  }

  if (node.type === "sequence") {
    items.push({ label: t("contextMenu.viewSource"), action: viewObjectSource, icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return items;
  }

  if (node.type === "package" || node.type === "package-body") {
    items.push({ label: t("contextMenu.viewSource"), action: viewObjectSource, icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return items;
  }

  // 9. Group Labels (group-columns, group-tables, etc.)
  if (isGroupLabel(node)) {
    const hasGroupCreateAction = (node.type === "group-tables" && canCreateTable.value) || (node.type === "group-views" && !!node.connectionId && !!node.database);
    if (node.type === "group-tables" && canCreateTable.value) {
      items.push({ label: t("contextMenu.createTable"), action: createTable, icon: Plus });
    }
    if (node.type === "group-views" && node.connectionId && node.database) {
      items.push({ label: t("contextMenu.createView"), action: createView, icon: Plus });
    }
    if (hasGroupCreateAction) {
      items.push({ label: "", separator: true });
    }
    if (node.type !== "group-partitions") {
      items.push({
        label: t("contextMenu.refreshChildren"),
        action: refresh,
        icon: RefreshCw,
        shortcut: shortcutRefresh,
      });
    }
    return items;
  }

  // 10. Universal Copy Name (for all types except connection)
  if (hasTypeMenu.value) {
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
  }

  return items;
}
</script>

<template>
  <CustomContextMenu :items="treeItemMenuItems()" v-slot="{ onContextMenu }">
    <div @contextmenu="onTreeItemContextMenu($event, onContextMenu)">
      <LightTooltip :text="displayLabel(node)" :disabled="isTooltipDisabled" side="right" :side-offset="8" :delay="0">
        <div
          ref="rowRef"
          class="group flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-accent relative outline-none"
          style="contain: layout style"
          :class="[
            rowWidthClass,
            {
              'ring-1 ring-primary/50 bg-primary/5': showDropInside,
              'opacity-50': isDragging,
              'tree-item-connection-tint': connectionColor,
              rounded: !isSelected && !isMultiSelected,
              'tree-item-active rounded-none': connectionColor && (isSelected || isMultiSelected),
              'tree-item-active rounded-md': !connectionColor && (isSelected || isMultiSelected),
              'tree-item-highlight': highlighted,
            },
          ]"
          :tabindex="isSelected || isMultiSelected ? 0 : -1"
          :style="rowStyle"
          @click="onClick"
          @dblclick="onDoubleClick"
          @keydown="onKeydown"
          @mousedown="onRowMouseDown"
          @mousemove="isDropTarget ? updateTarget($event, node.id, node.type) : undefined"
          @mouseleave="clearTarget(node.id)"
        >
          <div v-if="showDropBefore" class="absolute right-2 top-0 h-0.5 bg-primary rounded-full pointer-events-none" :style="{ left: paddingLeft }" />
          <div v-if="showDropAfter" class="absolute right-2 bottom-0 h-0.5 bg-primary rounded-full pointer-events-none" :style="{ left: paddingLeft }" />
          <template v-if="canExpand">
            <button type="button" class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" @click.stop="toggle">
              <Loader2 v-if="node.isLoading" class="w-3.5 h-3.5 animate-spin" />
              <ChevronDown v-else-if="node.isExpanded" class="w-3.5 h-3.5" />
              <ChevronRight v-else class="w-3.5 h-3.5" />
            </button>
          </template>
          <span v-else class="w-3.5 h-3.5 shrink-0" />
          <DatabaseIcon v-if="node.type === 'connection'" :db-type="connectionIconType(node.connectionId)" class="w-3.5 h-3.5 shrink-0" />
          <component v-else :is="getIconInfo(node)?.icon || Database" class="w-3.5 h-3.5 shrink-0" :class="nodeIconClass" />
          <input
            v-if="isRenamingGroup"
            ref="renameInputRef"
            v-model="renameInput"
            class="min-w-0 flex-1 truncate bg-transparent border border-primary/50 rounded px-1 outline-none"
            @blur="finishRenameGroup"
            @keydown.enter.prevent="finishRenameGroup"
            @keydown.escape.prevent="isRenamingGroup = false"
            @click.stop
          />
          <span v-else ref="labelRef" :class="labelWidthClass">{{ visibleLabel(node) }}</span>
          <span
            v-if="(node.type === 'group-tables' || node.type === 'group-views' || node.type === 'group-procedures' || node.type === 'group-functions' || node.type === 'group-sequences' || node.type === 'group-packages' || node.type === 'group-partitions') && node.objectCount != null"
            class="text-muted-foreground text-[10px] shrink-0"
            >{{ node.objectCount }}</span
          >
          <Badge v-if="isNodeDefaultDatabase" variant="secondary" class="h-4 px-1.5 text-[10px]">
            {{ t("editor.defaultDatabase") }}
          </Badge>
          <span v-if="columnComment" class="truncate text-muted-foreground/60 text-[10px] max-w-[40%]">{{ columnComment }}</span>
          <span v-if="tableComment && !settingsStore.editorSettings.sidebarHideTableComments" class="truncate text-muted-foreground/60 text-[10px] max-w-[25%] group-hover:hidden" :title="tableComment">{{ tableComment }}</span>
          <span v-if="node.type === 'connection' && node.connectionId && connectionStore.connectedIds.has(node.connectionId)" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <ConnectionErrorIndicator v-if="node.type === 'connection'" :connection-id="node.connectionId" trigger-class="h-4 w-4" />
          <button
            v-if="canPin"
            class="rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/15 hover:text-foreground focus:opacity-100"
            :class="isPinned ? 'opacity-100 text-primary' : 'opacity-0 group-hover:opacity-100'"
            :title="isPinned ? t('contextMenu.unpin') : t('contextMenu.pin')"
            @click.stop="togglePin"
          >
            <Pin class="w-3 h-3" :class="{ 'fill-current': isPinned }" />
          </button>
        </div>
      </LightTooltip>
    </div>
  </CustomContextMenu>
  <VisibleDatabasesDialog v-if="node.type === 'connection' && node.connectionId" v-model:open="showVisibleDatabasesDialog" :connection-id="node.connectionId" :connection-name="node.label" />

  <Dialog v-model:open="showDeleteConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.confirmDeleteTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ connectionDeleteConfirmMessage() }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button
          variant="destructive"
          @click="
            showDeleteConfirm = false;
            confirmDelete();
          "
          >{{ connectionDeleteMenuLabel() }}</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showMoveToNewGroupDialog">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t("connectionGroup.createGroup") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="moveToNewGroupName" :placeholder="t('connectionGroup.groupNamePlaceholder')" @keydown.enter.prevent="confirmMoveToNewGroup" />
      <DialogFooter>
        <Button variant="outline" @click="showMoveToNewGroupDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!moveToNewGroupName.trim()" @click="confirmMoveToNewGroup">{{ t("connectionGroup.createGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showDeleteGroupConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("connectionGroup.deleteGroupConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ t("connectionGroup.deleteGroupConfirmMessage", { name: node.label }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteGroupConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteGroup">{{ t("connectionGroup.deleteGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showRenameObjectDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.renameObjectTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <Input v-model="renameObjectName" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" @keydown.enter.prevent="confirmRenameObject" />
        <pre v-if="renameObjectPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(renameObjectPreviewSql)"></pre>
        <p v-if="renameObjectError" class="text-sm text-destructive">{{ renameObjectError }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showRenameObjectDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!renameObjectName.trim() || renameObjectName.trim() === node.label" @click="confirmRenameObject">
          {{ t("contextMenu.renameObject") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStructurePreviewDialog">
    <DialogContent class="sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle>{{ structurePreviewTitle || t("contextMenu.exportStructure") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div v-if="isLoadingStructurePreview" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("contextMenu.exportStructureLoading") }}</span>
        </div>
        <p v-else-if="structurePreviewError" class="text-sm text-destructive">{{ structurePreviewError }}</p>
        <pre v-else class="max-h-[56vh] min-h-64 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(structurePreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showStructurePreviewDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="outline" :disabled="isLoadingStructurePreview || !structurePreviewSql" @click="copyStructurePreview">
          <Clipboard class="h-4 w-4" />
          {{ t("contextMenu.copyStructure") }}
        </Button>
        <Button :disabled="isLoadingStructurePreview || !structurePreviewSql" @click="saveStructurePreview">
          <Download class="h-4 w-4" />
          {{ t("contextMenu.saveStructure") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStructureDocCopyDialog">
    <DialogContent class="sm:max-w-[760px]">
      <DialogHeader>
        <DialogTitle>{{ structureDocCopyTitle || t("contextMenu.copyStructureAs") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <p class="text-sm text-muted-foreground">{{ t("contextMenu.structureDocCopyFallbackHint") }}</p>
        <textarea readonly class="max-h-[56vh] min-h-64 resize-y overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre" :value="structureDocCopyText" @focus="selectTextareaContent"></textarea>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showStructureDocCopyDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!structureDocCopyText" @click="copyStructureDocText">
          <Clipboard class="h-4 w-4" />
          {{ t("contextMenu.copyStructure") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog v-model:open="showDropTableConfirm" :title="t('contextMenu.confirmDropTableTitle')" :message="t('contextMenu.confirmDropTableMessage', { name: node.label })" :sql="dropTablePreviewSql" :confirm-label="t('contextMenu.dropTable')" @confirm="confirmDropTable" />

  <DangerConfirmDialog v-model:open="showEmptyTableConfirm" :title="t('contextMenu.confirmEmptyTableTitle')" :message="t('contextMenu.confirmEmptyTableMessage', { name: node.label })" :sql="emptyTablePreviewSql" :confirm-label="t('contextMenu.emptyTable')" @confirm="confirmEmptyTable" />

  <DangerConfirmDialog
    v-model:open="showTruncateTableConfirm"
    :title="t('contextMenu.confirmTruncateTableTitle')"
    :message="t('contextMenu.confirmTruncateTableMessage', { name: node.label })"
    :sql="truncateTablePreviewSql"
    :confirm-label="t('contextMenu.truncateTable')"
    @confirm="confirmTruncateTable"
  />

  <DangerConfirmDialog v-model:open="showDropObjectConfirm" :title="dropObjectConfirmTitle()" :message="dropObjectConfirmMessage()" :sql="dropObjectPreviewSql" :confirm-label="dropObjectMenuLabel()" @confirm="confirmDropObject" />

  <DangerConfirmDialog v-model:open="showDropTableChildObjectConfirm" :title="dropTableChildObjectConfirmTitle()" :message="dropTableChildObjectConfirmMessage()" :sql="dropTableChildObjectPreviewSql" :confirm-label="dropTableChildObjectMenuLabel()" @confirm="confirmDropTableChildObject" />

  <DangerConfirmDialog v-model:open="showBatchDropConfirm" :title="batchDropConfirmTitle()" :message="batchDropConfirmMessage()" :sql="batchDropPreviewSql" :confirm-label="batchDropMenuLabel()" @confirm="confirmBatchDrop" />

  <ProcedureExecutionDialog
    v-if="node.type === 'procedure' && node.connectionId && node.database"
    v-model:open="showProcedureExecutionConfirm"
    :connection-id="node.connectionId"
    :database="node.database"
    :database-type="currentDatabaseType()"
    :schema="node.schema"
    :routine-name="node.label"
    @open-sql="openProcedureExecutionSql"
    @execute="executeProcedureSql"
  />

  <Dialog v-model:open="showDuplicateDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.duplicateNameTitle") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="duplicateTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" @keydown.enter.prevent="confirmDuplicateStructure" />
      <DialogFooter>
        <Button variant="outline" @click="showDuplicateDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!duplicateTableName.trim()" @click="confirmDuplicateStructure">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateDatabaseDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createDatabase") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="createDatabaseName" :placeholder="t('contextMenu.createDatabaseNamePlaceholder')" @keydown.enter.prevent="confirmCreateDatabase" />
      <div v-if="canSetCreateDatabaseCharset" class="grid gap-2">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCharset") }}</label>
          <Input v-model="createDatabaseCharset" :placeholder="t('contextMenu.createDatabaseCharsetPlaceholder')" @keydown.enter.prevent="confirmCreateDatabase" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCollation") }}</label>
          <Input v-model="createDatabaseCollation" :placeholder="t('contextMenu.createDatabaseCollationPlaceholder')" @keydown.enter.prevent="confirmCreateDatabase" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showCreateDatabaseDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createDatabaseName.trim()" @click="confirmCreateDatabase">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog v-model:open="showDropDatabaseConfirm" :title="t('contextMenu.confirmDropDatabaseTitle')" :message="t('contextMenu.confirmDropDatabaseMessage', { name: node.label })" :sql="dropDatabasePreviewSql" :confirm-label="t('contextMenu.dropDatabase')" @confirm="confirmDropDatabase" />

  <DangerConfirmDialog v-model:open="showFlushRedisDbConfirm" :title="t('redis.flushDb')" :message="t('redis.flushDbMessage')" :details="t('redis.flushDbDetails', { db: node.database })" :confirm-label="t('redis.flushDbConfirm')" @confirm="confirmFlushRedisDb" />

  <Dialog v-model:open="showCreateSchemaDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createSchema") }}</DialogTitle>
      </DialogHeader>
      <Input v-model="createSchemaName" :placeholder="t('contextMenu.createSchemaNamePlaceholder')" @keydown.enter.prevent="confirmCreateSchema" />
      <DialogFooter>
        <Button variant="outline" @click="showCreateSchemaDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createSchemaName.trim()" @click="confirmCreateSchema">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog v-model:open="showDropSchemaConfirm" :title="t('contextMenu.confirmDropSchemaTitle')" :message="t('contextMenu.confirmDropSchemaMessage', { name: node.label })" :sql="dropSchemaPreviewSql" :confirm-label="t('contextMenu.dropSchema')" @confirm="confirmDropSchema" />
</template>

<style>
.tree-item-connection-tint {
  isolation: isolate;
  background-color: transparent !important;
}

.tree-item-connection-tint::before {
  content: "";
  position: absolute;
  inset: 0 -9999px;
  z-index: 0;
  background-color: var(--tree-connection-row-bg);
  border-radius: inherit;
  pointer-events: none;
}

.tree-item-connection-tint > * {
  position: relative;
  z-index: 1;
}

.tree-item-connection-tint:hover,
.tree-item-connection-tint.tree-item-active,
.tree-item-connection-tint.tree-item-active:focus {
  background-color: transparent !important;
}

.tree-item-connection-tint:hover::before {
  background-color: var(--tree-connection-row-hover-bg, var(--tree-connection-row-bg));
}

.tree-item-connection-tint.tree-item-active::before {
  background-color: var(--tree-connection-active-bg, var(--tree-connection-row-bg));
}

.tree-item-connection-tint.tree-item-active:focus::before {
  background-color: var(--tree-connection-active-focus-bg, var(--tree-connection-active-bg));
}

/* Unfocused: subtle gray */
.tree-item-active {
  background-color: var(--tree-connection-active-bg, rgb(235 235 235)) !important;
}
:root.dark .tree-item-active {
  background-color: var(--tree-connection-active-bg, rgb(36 36 36)) !important;
}

/* Focused: soft blue */
.tree-item-active:focus {
  background-color: var(--tree-connection-active-focus-bg, rgb(211 227 245)) !important;
}
:root.dark .tree-item-active:focus {
  background-color: var(--tree-connection-active-focus-bg, rgb(33 60 89)) !important;
}

/* Locate highlight: instant amber, then fade on removal */
.tree-item-highlight {
  background-color: rgb(253 225 167) !important;
  background-color: oklch(0.92 0.08 85) !important;
  transition: background-color 0.8s ease-out 0.6s;
}

:root.dark .tree-item-highlight {
  background-color: rgb(110 67 0) !important;
  background-color: oklch(0.42 0.12 80) !important;
  transition: background-color 0.8s ease-out 0.6s;
}
</style>
