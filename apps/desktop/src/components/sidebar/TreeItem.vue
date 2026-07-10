<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onBeforeUnmount, inject, type Component } from "vue";
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
  ChevronsDown,
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
  Server,
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
  Check,
  UsersRound,
  CalendarClock,
  Lock,
  HardDriveDownload,
  FilePlus,
  SquarePen,
  ListX,
  Info,
  Archive,
  Square,
  X,
} from "@lucide/vue";
import CustomContextMenu from "@/components/ui/CustomContextMenu.vue";
import { CONNECTION_ATTEMPT_CANCELLED_MESSAGE, useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useToast } from "@/composables/useToast";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import type { ColumnInfo, ConnectionConfig, DatabaseType, ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { canTreeNodePin, canTreeNodeShowExpander, treeItemPaddingLeft, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { buildTableDeleteTemplate, buildTableInsertTemplate, buildTableSelectTemplate, buildTableUpdateTemplate } from "@/lib/table/tableSqlTemplates";
import { connectionFilePath, defaultSqliteBackupFileName, isMemorySqlitePath, sqliteBackupSourcePath } from "@/lib/connection/connectionFile";
import { revealPathInFileManager } from "@/lib/backend/tauri";
import { clearActiveTableReferencePayload, createTableReferencePayload, createTableReferenceDropEvent, setActiveTableReferencePayload, type QueryEditorTableReferencePayload } from "@/lib/editor/queryEditorTableDrop";
import { usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { getCachedTableMetadata, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS, tableMetadataToDataTabMeta } from "@/lib/metadata/tableMetadataCache";
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
import { isCopySidebarSelectionShortcut, isEditSidebarConnectionShortcut, isPasteSidebarSelectionShortcut } from "@/lib/editor/keyboardShortcuts";
import { formatSqlInsert } from "@/lib/export/exportFormats";
import { joinExportedDdls } from "@/lib/export/ddlExport";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import { canActivateExistingDataTableTab } from "@/lib/tabs/dataTabActivation";
import { buildCreateDatabaseSql, buildDuckDbAttachDatabaseSql, duckDbAttachedDatabaseNameFromPath, supportsCreateDatabaseCharset, uniqueDuckDbAttachedDatabaseName } from "@/lib/database/createDatabaseSql";
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
  type TableAdminSqlOptions,
} from "@/lib/database/dbAdminSql";
import { buildRenameObjectSql, supportsObjectRename, type RenameableObjectType } from "@/lib/table/objectRenameSql";
import { buildRoutineRenameObjectSourceStatements, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
import { buildViewDdl } from "@/lib/table/viewDdl";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import DdlViewDialog from "@/components/objects/DdlViewDialog.vue";
import ObjectSourceDialog from "@/components/objects/ObjectSourceDialog.vue";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import { codeMirrorSqlDialect, connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { hexToRgba } from "@/lib/common/color";
import { focusSidebarRenameInput } from "@/lib/sidebar/sidebarRenameFocus";
import { hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { defaultPasteTableMode, pasteTableModeCopiesData, supportsWholeRowTableDataCopy, tableClipboardMatchesTarget, tableDataCopyColumnOptions, type PasteTableMode, type TableClipboardContext } from "@/lib/table/tableClipboard";
import { sidebarDisplayTableName } from "@/lib/sidebar/sidebarTableNameDisplay";
import { shouldMeasureSidebarLabelOverflow } from "@/lib/sidebar/sidebarLabelTooltip";
import { selectedTreeNodesInVisibleOrder as orderSelectedTreeNodes, treeSelectionRangeIdsByIndex, treeSelectionRangeIds } from "@/lib/sidebar/sidebarTreeSelection";
import { connectionPasteTargetGroupId, selectedConnectionClipboardTargets, selectedConnectionDeleteTargets, selectedConnectionDuplicateTargets, selectedConnectionEditTarget } from "@/lib/sidebar/sidebarConnectionSelection";
import { supportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";
import { canCloseSidebarDatabaseConnection, isSidebarDatabaseOpened } from "@/lib/sidebar/sidebarDatabaseOpenState";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { batchTableEmptyFeedback, runBatchTableEmpty } from "@/lib/sidebar/batchTableEmpty";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import InstallExtensionDialog from "@/components/objects/InstallExtensionDialog.vue";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import { hasEnabledTransportLayers } from "@/lib/backend/connectionTransport";
import { isWindows } from "@/lib/backend/platform";
import { rankSavedSqlHistory, type SavedSqlHistoryScope } from "@/lib/savedSql/savedSqlHistory";
import { isSqlServerLinkedNode } from "@/lib/database/sqlServerLinkedServers";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionErrorIndicator from "@/components/connection/ConnectionErrorIndicator.vue";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import VisibleDatabasesDialog from "@/components/sidebar/VisibleDatabasesDialog.vue";
import SchemaFilterDialog from "@/components/sidebar/VisibleSchemasDialog.vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { flattenTree } from "@/composables/useFlatTree";
import { createDatabaseCollationOptionsForCharset, fallbackCreateDatabaseCharsetMetadata, nextCreateDatabaseCollation, normalizeCreateDatabaseCharset, parseCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";

const { t } = useI18n();
const labelRef = ref<HTMLElement>();
const rowRef = ref<HTMLElement>();
const labelOverflowing = ref(false);
let labelResizeObserver: ResizeObserver | null = null;
let labelMeasureFrame = 0;

interface ContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  icon?: Component;
  iconClass?: string;
  shortcut?: string;
  variant?: "default" | "destructive";
  visible?: boolean;
  children?: ContextMenuItem[];
}

function cancelLabelOverflowMeasure() {
  if (!labelMeasureFrame) return;
  window.cancelAnimationFrame(labelMeasureFrame);
  labelMeasureFrame = 0;
}

function measureLabelOverflow(): boolean {
  const el = labelRef.value;
  if (!el || !shouldMeasureLabelOverflow()) return false;
  const style = window.getComputedStyle(el);
  if (style.overflowX === "visible" || style.textOverflow !== "ellipsis") return false;
  return el.scrollWidth - el.clientWidth > 2;
}

function updateLabelOverflow() {
  labelOverflowing.value = measureLabelOverflow();
}

function scheduleLabelOverflowMeasure() {
  if (typeof window === "undefined") {
    updateLabelOverflow();
    return;
  }
  cancelLabelOverflowMeasure();
  // Keep synchronous layout reads out of the hover path; they are expensive in
  // large virtualized sidebar trees, especially on Linux WebKitGTK without GPU help.
  labelMeasureFrame = window.requestAnimationFrame(() => {
    labelMeasureFrame = 0;
    updateLabelOverflow();
  });
}

function observeLabelOverflow() {
  labelResizeObserver?.disconnect();
  labelResizeObserver = null;
  if (!shouldMeasureLabelOverflow()) {
    labelOverflowing.value = false;
    return;
  }
  if (typeof ResizeObserver !== "undefined" && labelRef.value) {
    labelResizeObserver = new ResizeObserver(scheduleLabelOverflowMeasure);
    labelResizeObserver.observe(labelRef.value);
  }
  scheduleLabelOverflowMeasure();
}
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const useWindowsSidebarCommentFont = isWindows();

type StructureCopyFormat = "tsv" | "markdown";
type DuplicateStructureSource = TreeNode & { connectionId: string; database: string };
const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;
const { getDatabaseOptions } = useDatabaseOptions();
const showVisibleDatabasesDialog = ref(false);
const showVisibleSchemasDialog = ref(false);
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
  "group-created": [groupId: string];
  "node-toggled": [node: TreeNode, wasExpanded: boolean];
  "search-toggle": [node: TreeNode];
}>();

const usesFullWidthLabel = computed(() => usesFullWidthTreeLabel(props.node.type, settingsStore.editorSettings.sidebarAllowHorizontalScroll));
const sidebarTreeContext = inject(sidebarTreeContextKey, null);
const rowWidthClass = computed(() => (usesFullWidthLabel.value ? "w-max min-w-full" : "w-full min-w-0"));
const labelWidthClass = computed(() => (usesFullWidthLabel.value ? "shrink-0 whitespace-nowrap" : "min-w-0 truncate"));

function currentDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(props.node.connectionId)) : undefined;
}

function currentTableStructureDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? tableStructureDatabaseTypeForConnection(connectionStore.getConfig(props.node.connectionId)) : undefined;
}

function rawDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? connectionStore.getConfig(props.node.connectionId)?.db_type : undefined;
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

function getIconInfo(node: TreeNode): { icon: any; colorClass: string } | null {
  switch (node.type) {
    case "connection":
      return null;
    case "connection-group":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-amber-500" };
    case "database":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "linked-server-root":
      return { icon: Network, colorClass: "text-blue-500" };
    case "linked-server":
      return { icon: Server, colorClass: "text-blue-400" };
    case "linked-server-catalog":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "linked-server-schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "schema":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "table":
      return { icon: Table, colorClass: "text-green-500" };
    case "view":
      return { icon: Eye, colorClass: "text-purple-500" };
    case "materialized_view":
      return { icon: Eye, colorClass: "text-indigo-500" };
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
    case "dameng-job-admin":
      return { icon: CalendarClock, colorClass: "text-primary" };
    case "index":
      return { icon: Key, colorClass: "text-amber-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "mq-tenant":
      return { icon: FolderOpen, colorClass: "text-sky-400" };
    case "nacos-namespace":
      return { icon: FolderOpen, colorClass: "text-sky-500" };
    case "etcd-root":
      return { icon: Database, colorClass: "text-sky-500" };
    case "zookeeper-root":
      return { icon: Database, colorClass: "text-blue-500" };
    case "mongo-db":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "mongo-gridfs":
    case "mongo-buckets":
      return { icon: Archive, colorClass: "text-cyan-500" };
    case "mongo-bucket":
      return { icon: Archive, colorClass: "text-cyan-400" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    case "vector-collection":
      return { icon: TableProperties, colorClass: "text-cyan-400" };
    case "elasticsearch-index":
      return { icon: Table, colorClass: "text-emerald-400" };
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
    case "group-materialized-views":
      return { icon: Eye, colorClass: "text-indigo-500" };
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
    case "group-extensions":
      return { icon: Package, colorClass: "text-violet-500" };
    case "extension":
      return { icon: Package, colorClass: "text-violet-400" };
    case "load-more":
      return { icon: Plus, colorClass: "text-primary" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}

const groupTypes: Set<TreeNodeType> = new Set(["group-columns", "group-indexes", "group-fkeys", "group-triggers", "group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-sequences", "group-packages", "group-partitions", "group-extensions"]);
function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

function displayLabel(node: TreeNode): string {
  if (node.type === "load-more") return t(node.label);
  if (node.type === "object-browser") return t(node.label, { count: node.objectCount ?? 0 });
  if (node.type === "user-admin" || node.type === "dameng-job-admin") return t(node.label);
  if (node.type === "linked-server-root") return t(node.label);
  if (node.label === "tree.defaultDatabase") return t(node.label);
  return isGroupLabel(node) ? t(node.label) : node.label;
}

function visibleLabel(node: TreeNode): string {
  if (node.type === "table" || node.type === "view" || node.type === "materialized_view" || node.type === "mongo-collection" || node.type === "vector-collection" || node.type === "elasticsearch-index") {
    return sidebarDisplayTableName(node.label, settingsStore.editorSettings.sidebarHiddenTablePrefixes);
  }
  return displayLabel(node);
}

type DetailTooltipRow = {
  label: string;
  value: string;
  multiline?: boolean;
};

function cleanTooltipValue(value: string | number | null | undefined): string {
  return String(value ?? "").trim();
}

function isLocalFileConnection(config: Pick<ConnectionConfig, "db_type" | "port">): boolean {
  return config.db_type === "sqlite" || config.db_type === "duckdb" || config.db_type === "access" || (config.db_type === "h2" && config.port === 0);
}

function redactedConnectionString(value: string): string {
  return value.replace(/(:\/\/[^/\s:@?#;]+):([^@\s/?#;]+)@/g, "$1:***@").replace(/([?&;](?:password|pwd|pass|token|secret|key)=)[^&;]*/gi, "$1***");
}

function connectionTooltipScheme(config: Pick<ConnectionConfig, "db_type" | "ssl">): string {
  switch (config.db_type) {
    case "postgres":
    case "gaussdb":
    case "kwdb":
    case "yashandb":
    case "redshift":
    case "questdb":
      return "postgresql";
    case "sqlserver":
      return "mssql";
    case "elasticsearch":
    case "qdrant":
    case "milvus":
    case "weaviate":
    case "chromadb":
    case "rqlite":
    case "turso":
    case "mq":
      return config.ssl ? "https" : "http";
    case "dameng":
      return "dm";
    default:
      return config.db_type;
  }
}

function hostForDisplay(host: string): string {
  if (!host.includes(":") || host.startsWith("[") || host.includes("://")) return host;
  return `[${host}]`;
}

function connectionTooltipUrl(config: ConnectionConfig): string {
  const explicit = cleanTooltipValue(config.connection_string);
  if (explicit) return redactedConnectionString(explicit);

  const host = cleanTooltipValue(config.host);
  if (!host) return "";
  if (host.includes("://")) return redactedConnectionString(host);

  if (isLocalFileConnection(config)) {
    if (config.db_type === "access") return `jdbc:ucanaccess://${host}`;
    return `${config.db_type}://${host}`;
  }

  const scheme = connectionTooltipScheme(config);
  const port = Number(config.port) > 0 ? `:${config.port}` : "";
  const user = cleanTooltipValue(config.username);
  const userInfo = user ? `${encodeURIComponent(user)}@` : "";
  const database = cleanTooltipValue(config.database);
  const path = database ? `/${encodeURIComponent(database)}` : "";
  const params = cleanTooltipValue(config.url_params);
  const query = params ? (params.startsWith("?") ? params : `?${params}`) : "";
  return redactedConnectionString(`${scheme}://${userInfo}${hostForDisplay(host)}${port}${path}${query}`);
}

const connectionInfoTooltip = computed(() => {
  const node = props.node;
  if (node.type !== "connection" || !node.connectionId) return null;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return null;

  const hostLabel = isLocalFileConnection(config) ? t("connection.filePath") : t("connection.host");
  const rows: DetailTooltipRow[] = [
    { label: t("connection.name"), value: cleanTooltipValue(config.name) },
    { label: "URL", value: connectionTooltipUrl(config), multiline: true },
    { label: hostLabel, value: cleanTooltipValue(config.host), multiline: isLocalFileConnection(config) },
    { label: "Port", value: Number(config.port) > 0 ? String(config.port) : "" },
    { label: t("connection.database"), value: cleanTooltipValue(config.database) },
    { label: t("connection.user"), value: cleanTooltipValue(config.username) },
    { label: t("connection.type"), value: config.driver_label || config.driver_profile || config.db_type },
  ].filter((row) => row.value);

  return { rows };
});

const objectCommentTooltip = computed(() => {
  const node = props.node;
  const comment = node.type === "column" && node.meta && "comment" in node.meta ? (node.meta as ColumnInfo).comment : node.comment;
  if (!comment || (node.type !== "schema" && node.type !== "table" && node.type !== "view" && node.type !== "column")) return null;
  const rows: DetailTooltipRow[] = [
    { label: t("connection.name"), value: visibleLabel(node) },
    { label: t("structureEditor.comment"), value: cleanTooltipValue(comment), multiline: true },
  ].filter((row) => row.value);
  return { rows };
});

const detailTooltip = computed(() => connectionInfoTooltip.value ?? objectCommentTooltip.value);

function isTooltipDisabled(): boolean {
  if (detailTooltip.value?.rows.length) return isRenamingGroup.value;
  return isRenamingGroup.value || !labelOverflowing.value;
}

async function toggle() {
  const node = props.node;
  if (node.isLoading) {
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

  const databaseObjectGroup = node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views" || node.type === "group-procedures" || node.type === "group-functions" || node.type === "group-sequences" || node.type === "group-packages";
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
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await connectionStore.loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (databaseObjectGroup) {
      await connectionStore.loadObjectGroupChildren(node);
    }
    emit("node-toggled", node, wasExpanded);
  } catch (e: any) {
    if (!wasExpanded) node.isExpanded = false;
    const errMsg = e?.message || String(e);
    if (errMsg.includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE)) return;
    toast(t("connection.connectFailed", { message: translateBackendError(t, errMsg) }), 5000);
    if (errMsg.includes("driver is not installed") || errMsg.includes("is not installed")) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

function runRowClickAction(clickDetail: number) {
  const node = props.node;
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
    openData();
  } else if (isDocumentBrowserTreeNode(node.type)) {
    openMongoTreeData(node);
  } else if (node.type === "procedure" || node.type === "function" || node.type === "sequence" || node.type === "package" || node.type === "package-body") {
    openObjectSourceDialog(false);
  } else if (action === "toggle") {
    toggle();
  }
}

function refreshActiveKvBrowserAfterOpen(mode: "etcd" | "zookeeper", connectionId: string) {
  void nextTick(() => {
    window.dispatchEvent(new CustomEvent("dbx-refresh-active-kv-browser", { detail: { mode, connectionId } }));
  });
}

async function loadMoreObjectGroupChildren() {
  try {
    await connectionStore.loadMoreObjectGroupChildren(props.node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function loadAllObjectGroupChildren() {
  try {
    await connectionStore.loadAllObjectGroupChildren(props.node);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function onToggleClick() {
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
  void toggle();
}

function onToggleMouseDown(event: MouseEvent) {
  if (event.button !== 0) return;
  selectSingleTreeNode(props.node);
  rowRef.value?.focus({ preventScroll: true });
}

function visibleTreeNodes(): TreeNode[] {
  if (sidebarTreeContext) return sidebarTreeContext.getVisibleNodes();
  return flattenTree(connectionStore.treeNodes).map((item) => item.node);
}

function selectedTreeNodesInVisibleOrder(): TreeNode[] {
  return orderSelectedTreeNodes(visibleTreeNodes(), connectionStore.selectedTreeNodeIds);
}

function selectSingleTreeNode(node: TreeNode) {
  // Re-clicking the selected row should not replace the selection array and
  // force visible tree rows to recompute.
  if (!connectionStore.connectionMultiSelectActive && connectionStore.selectedTreeNodeId === node.id && connectionStore.treeSelectionAnchorId === node.id && connectionStore.selectedTreeNodeIds.length === 1 && connectionStore.selectedTreeNodeIds[0] === node.id) {
    return;
  }
  connectionStore.connectionMultiSelectActive = false;
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.selectedTreeNodeIds = [node.id];
  connectionStore.treeSelectionAnchorId = node.id;
}

function toggleTreeNodeSelection(node: TreeNode) {
  connectionStore.connectionMultiSelectActive = false;
  const ids = new Set(connectionStore.selectedTreeNodeIds);
  if (ids.has(node.id)) ids.delete(node.id);
  else ids.add(node.id);
  connectionStore.selectedTreeNodeIds = ids.size ? [...ids] : [node.id];
  connectionStore.selectedTreeNodeId = node.id;
  connectionStore.treeSelectionAnchorId = node.id;
}

function selectTreeNodeRange(node: TreeNode) {
  connectionStore.connectionMultiSelectActive = false;
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

function selectedConnectionIdsForAction(): string[] {
  const connectionIds = new Set(connectionStore.connections.map((connection) => connection.id));
  return connectionStore.selectedTreeNodeIds.filter((id) => connectionIds.has(id));
}

const isConnectionSelectionChecked = computed(() => {
  if (!connectionStore.connectionMultiSelectActive || props.node.type !== "connection" || !props.node.connectionId) return false;
  return connectionStore.selectedTreeNodeIds.includes(props.node.connectionId);
});

function toggleConnectionMultiSelection(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (props.node.type !== "connection" || !props.node.connectionId) return;

  // Keep connection-id normalization off the row render path; this handler only
  // runs when the checkbox is clicked, while the checked state updates often.
  const next = new Set(connectionStore.connectionMultiSelectActive ? selectedConnectionIdsForAction() : []);
  if (next.has(props.node.connectionId)) next.delete(props.node.connectionId);
  else next.add(props.node.connectionId);

  const ids = [...next];
  connectionStore.selectedTreeNodeIds = ids;
  connectionStore.selectedTreeNodeId = ids.includes(props.node.connectionId) ? props.node.connectionId : (ids[0] ?? null);
  connectionStore.treeSelectionAnchorId = props.node.connectionId;
  connectionStore.connectionMultiSelectActive = ids.length > 0;
  rowRef.value?.focus({ preventScroll: true });
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
  runRowClickAction(event.detail);
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
  if (!props.node.connectionId || !props.node.database) return null;
  return {
    connectionId: props.node.connectionId,
    database: props.node.database,
    schema: props.node.schema,
  };
}

function canPasteTreeClipboardToCurrentNode(): boolean {
  const clipboard = connectionStore.treeClipboard;
  return clipboard?.kind === "table-copy" && tableClipboardMatchesTarget(clipboard.tables, pasteTableTargetContext());
}

function requestPasteTreeClipboard(): boolean {
  const clipboard = connectionStore.treeClipboard;
  if (clipboard?.kind === "connection-copy") {
    const targetGroupId = connectionPasteTargetGroupId(props.node, (connectionId) => connectionStore.groupIdForConnection(connectionId));
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

function onSidebarRequestPasteTable(event: Event) {
  const nodeId = (event as CustomEvent<{ nodeId?: string }>).detail?.nodeId;
  if (nodeId !== props.node.id) return;
  requestPasteTreeClipboard();
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
  const editTarget = selectedConnectionEditTarget(props.node, selected);
  if (editTarget) {
    connectionStore.startEditing(editTarget.connectionId);
    return true;
  }
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

function requestEditSelectedConnection(): boolean {
  const editTarget = selectedConnectionEditTarget(props.node, selectedTreeNodesInVisibleOrder());
  if (!editTarget) return false;
  connectionStore.startEditing(editTarget.connectionId);
  return true;
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
    openObjectSourceDialog(false);
  } else if (action === "open-saved-sql") {
    openSavedSqlFile();
  } else if (action === "toggle" && (props.node.type === "mongo-gridfs" || isDocumentBrowserTreeNode(props.node.type))) {
    openMongoTreeData(props.node);
  } else if (action === "toggle") {
    toggle();
  }
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
  const node = props.node;
  if (node.type !== "saved-sql-file" || !node.savedSqlId) return;
  const file = await savedSqlStore.ensureFileContent(node.savedSqlId);
  if (!file) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
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

async function openDamengJobAdmin() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    queryStore.openDamengJobAdmin(node.connectionId);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openData() {
  const node = props.node;
  if (!(node.type === "table" || node.type === "view" || node.type === "materialized_view") || !hasNodeDatabaseContext(node)) return;
  const config = connectionStore.getConfig(node.connectionId);
  const traceId = uuid().slice(0, 8);
  const startedAt = performance.now();
  let lastPhaseAt = startedAt;
  const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
  const logPhase = (phase: string, extra: Record<string, unknown> = {}) => {
    const now = performance.now();
    console.info("[DBX][openData:phase]", {
      traceId,
      phase,
      deltaMs: Math.round(now - lastPhaseAt),
      totalMs: Math.round(now - startedAt),
      ...extra,
    });
    lastPhaseAt = now;
  };
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
  const tableType = node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : (node.tableType ?? "TABLE");
  const querySchema = config ? connectionObjectTreeQuerySchema(config, node.database, tableSchema) : (tableSchema ?? "");
  const effectiveDbType = effectiveDatabaseTypeForConnection(config);
  const metadataDatabaseType = effectiveDbType || config?.db_type || "";
  const isSameDataTableTab = (tab: (typeof queryStore.tabs)[number]) =>
    tab.mode === "data" && tab.connectionId === node.connectionId && tab.database === node.database && (tab.tableMeta?.catalog || "") === (node.catalog || "") && (tab.schema || "") === (tableSchema || "") && (tab.tableMeta?.tableName || tab.title) === node.label;
  const existingSameTableTab = queryStore.tabs.find(isSameDataTableTab);
  const resetReusedDataTabState = (tab: (typeof queryStore.tabs)[number]) => {
    tab.title = node.label;
    tab.schema = tableSchema;
    tab.whereInput = undefined;
    tab.orderByInput = undefined;
    tab.previewSql = undefined;
    tab.resultSortColumn = undefined;
    tab.resultSortColumnIndex = undefined;
    tab.resultSortDirection = undefined;
    tab.resultSortMode = undefined;
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultSortedSql = undefined;
    tab.resultPageSql = undefined;
    tab.resultPageLimit = undefined;
    tab.resultPageOffset = undefined;
    tab.resultTotalRowCount = undefined;
    tab.resultTotalRowCountLoading = undefined;
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
  };

  if (existingSameTableTab && canActivateExistingDataTableTab(existingSameTableTab)) {
    queryStore.activeTabId = existingSameTableTab.id;
    logPhase("existing-tab-activated", { table: node.label });
    return;
  }

  const tabId = (() => {
    if (existingSameTableTab) {
      queryStore.activeTabId = existingSameTableTab.id;
      resetReusedDataTabState(existingSameTableTab);
      return existingSameTableTab.id;
    }
    if (settingsStore.editorSettings.reuseDataTab) {
      const existing = queryStore.tabs.find((tab) => tab.mode === "data" && tab.connectionId === node.connectionId && tab.database === node.database);
      if (existing) {
        queryStore.activeTabId = existing.id;
        resetReusedDataTabState(existing);
        return existing.id;
      }
    }
    return queryStore.createTab(node.connectionId, node.database, node.label, "data", tableSchema);
  })();
  console.info("[DBX][openData:tab-created]", { traceId, tabId, elapsed: elapsed() });
  logPhase("tab-created", { tabId });

  // Cancel any previous execution on this tab before starting a new one
  const existingTab = queryStore.tabs.find((t) => t.id === tabId);
  if (existingTab?.isExecuting && existingTab.executionId) {
    await queryStore.cancelTabExecution(tabId);
    logPhase("previous-execution-cancelled", { tabId });
  }

  const openDataId = uuid();
  // Clear previous result so DataGrid doesn't show its internal loading overlay (without stop button)
  const tab = queryStore.tabs.find((t) => t.id === tabId);
  if (tab) {
    tab.result = undefined;
    tab.results = undefined;
  }
  const existingTableMeta = tab?.tableMeta;
  const existingTableMetaAgeMs = tab?.tableMetaUpdatedAt ? Date.now() - tab.tableMetaUpdatedAt : Number.POSITIVE_INFINITY;
  const sharedCachedTableMeta = config
    ? getCachedTableMetadata({
        connectionId: node.connectionId,
        database: node.database,
        schema: querySchema,
        tableName: node.label,
        tableType,
        databaseType: metadataDatabaseType,
        driverProfile: config.driver_profile || config.db_type,
        catalog: node.catalog,
      })
    : undefined;
  const tabCachedTableMeta =
    existingTableMeta?.tableName === node.label && (existingTableMeta.catalog || "") === (node.catalog || "") && existingTableMeta.schema === tableSchema && existingTableMeta.tableType === tableType && existingTableMeta.columns.length > 0 && existingTableMetaAgeMs < DATA_TAB_METADATA_TTL_MS
      ? existingTableMeta
      : undefined;
  const cachedTableMeta = sharedCachedTableMeta ? tableMetadataToDataTabMeta(sharedCachedTableMeta.metadata, tableSchema) : tabCachedTableMeta;
  const cachedTableMetaAgeMs = sharedCachedTableMeta?.ageMs ?? existingTableMetaAgeMs;
  const cachedTableMetaSource = sharedCachedTableMeta ? "shared" : tabCachedTableMeta ? "tab" : undefined;
  queryStore.setTableMeta(
    tabId,
    cachedTableMeta ?? {
      catalog: node.catalog,
      schema: tableSchema,
      tableName: node.label,
      tableType,
      columns: [],
      primaryKeys: [],
    },
  );
  queryStore.setExecutingWithId(tabId, openDataId);
  logPhase("state-prepared", { tabId });

  // Helper to check if this openData call is still active (not superseded by a newer click)
  const isActive = () => queryStore.tabs.find((t) => t.id === tabId)?.executionId === openDataId;
  const isCurrentDataTab = () => {
    const current = queryStore.tabs.find((t) => t.id === tabId);
    return current?.mode === "data" && current.connectionId === node.connectionId && current.database === node.database && current.schema === tableSchema && current.title === node.label;
  };

  try {
    console.info("[DBX][openData:ensure-connected:start]", { traceId, elapsed: elapsed() });
    await connectionStore.ensureConnected(node.connectionId);
    if (!isActive()) {
      logPhase("superseded-after-ensure-connected", { tabId });
      return;
    }
    console.info("[DBX][openData:ensure-connected:done]", { traceId, elapsed: elapsed() });
    logPhase("ensure-connected", { tabId });
    if (!config) throw new Error("Connection config not found");

    const limit = tableOpenPageLimit(settingsStore.editorSettings.pageSize);
    const refreshTableMetaInBackground = async () => {
      const metadataStartedAt = performance.now();
      console.info("[DBX][openData:metadata:start]", {
        traceId,
        database: node.database,
        schema: querySchema,
        table: node.label,
        elapsed: elapsed(),
      });
      try {
        const loadedMetadata = await loadTableMetadata({
          connectionId: node.connectionId,
          database: node.database,
          schema: querySchema,
          tableName: node.label,
          tableType,
          databaseType: metadataDatabaseType,
          driverProfile: config.driver_profile || config.db_type,
          catalog: node.catalog,
          traceLogger: (event) => console.debug("[DBX][openData:metadata:trace]", { sourceTraceId: traceId, ...event }),
        });
        if (!isCurrentDataTab()) {
          console.info("[DBX][openData:metadata:stale]", {
            traceId,
            tabId,
            columnCount: loadedMetadata.metadata.columns.length,
            elapsed: elapsed(),
          });
          return;
        }
        const nextTableMeta = tableMetadataToDataTabMeta(loadedMetadata.metadata, tableSchema);
        queryStore.setTableMeta(tabId, nextTableMeta);
        console.info("[DBX][openData:metadata:done]", {
          traceId,
          tabId,
          columnCount: nextTableMeta.columns.length,
          primaryKeyCount: nextTableMeta.primaryKeys.length,
          cacheStatus: loadedMetadata.cacheStatus,
          ageMs: Math.round(loadedMetadata.ageMs),
          elapsed: elapsed(),
          metadataMs: Math.round(performance.now() - metadataStartedAt),
        });
      } catch (error) {
        console.warn("[DBX][openData:metadata:error]", { traceId, tabId, elapsed: elapsed(), error });
      }
    };
    const shouldRefreshTableMeta = !cachedTableMeta;
    if (cachedTableMeta) {
      console.info("[DBX][openData:metadata:cache-hit]", {
        traceId,
        tabId,
        columnCount: cachedTableMeta.columns.length,
        primaryKeyCount: cachedTableMeta.primaryKeys.length,
        source: cachedTableMetaSource,
        ageMs: Math.round(cachedTableMetaAgeMs),
        elapsed: elapsed(),
      });
    } else {
      logPhase("metadata-deferred", { tabId });
    }

    // Check if superseded by a newer openData call
    if (!isActive()) {
      logPhase("superseded-before-build-sql", { tabId });
      return;
    }

    const columns = cachedTableMeta?.columns ?? [];
    const primaryKeys = cachedTableMeta?.primaryKeys ?? [];
    const includeRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys, tableType);
    const sql = await buildTableSelectSql({
      databaseType: effectiveDbType,
      schema: tableSchema,
      tableName: node.label,
      tableType,
      catalog: node.catalog,
      columns: columns.map((column) => column.name),
      primaryKeys,
      limit,
      includeRowId,
    });
    console.info("[DBX][openData:sql-built]", {
      traceId,
      primaryKeys,
      includeRowId,
      sql,
      elapsed: elapsed(),
    });
    logPhase("sql-built", { tabId, columnCount: columns.length, primaryKeyCount: primaryKeys.length });
    queryStore.updateSql(tabId, sql);
    logPhase("sql-updated", { tabId });

    console.info("[DBX][openData:execute:start]", { traceId, tabId, elapsed: elapsed() });
    await queryStore.executeTabSql(tabId, sql, {
      sourceTraceId: traceId,
      skipEnsureConnected: true,
      pagination: { limit, offset: 0 },
    });
    console.info("[DBX][openData:execute:done]", { traceId, tabId, elapsed: elapsed() });
    logPhase("execute-tab-sql", { tabId });
    if (shouldRefreshTableMeta && isCurrentDataTab()) {
      void refreshTableMetaInBackground();
      logPhase("metadata-started", { tabId });
    }
  } catch (e: any) {
    if (!isActive()) {
      logPhase("superseded-after-error", { tabId });
      return;
    }
    console.error("[DBX][openData:error]", { traceId, elapsed: elapsed(), error: e });
    logPhase("error", { tabId });
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
    if (e?.message?.includes("driver is not installed") || (e?.message?.includes("JRE") && e?.message?.includes("not installed"))) {
      window.dispatchEvent(new Event("dbx-open-driver-store"));
    }
  }
}

// SQL template helpers have been extracted to @/lib/tableSqlTemplates.ts
// ---- Template actions ----

function openRedisInstanceInfo() {
  const node = props.node;
  if (!node.connectionId) return;
  const config = connectionStore.getConfig(node.connectionId);
  const dbName = config?.name || "Redis";
  queryStore.createTab(node.connectionId, "0", `${dbName} - ${t("contextMenu.instanceInfo")}`, "redis-dashboard");
}

async function loadTemplateContext(allowView = false) {
  const node = props.node;
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
  const node = props.node;
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
  if (node.type !== "table" && node.type !== "view" && node.type !== "materialized_view") return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;
    const schema = node.schema || node.database;
    let ddl: string;
    if (node.type === "table") {
      ddl = await api.getTableDdl(node.connectionId, node.database, schema, node.label);
    } else if (node.type === "materialized_view") {
      ddl = await api.getTableDdl(node.connectionId, node.database, schema, node.label, "MATERIALIZED_VIEW");
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

function connectionDuplicateTargets() {
  return selectedConnectionDuplicateTargets(props.node, selectedTreeNodesInVisibleOrder());
}

function connectionDuplicateMenuLabel(): string {
  const count = connectionDuplicateTargets().length;
  return count > 1 ? t("contextMenu.duplicateSelectedConnections", { count }) : t("contextMenu.duplicateConnection");
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
  const connectionIds = targets.map((target) => target.connectionId);
  try {
    await connectionStore.removeConnections(connectionIds);
    for (const connectionId of connectionIds) {
      connectionStore.disconnect(connectionId).catch((error) => {
        console.warn("[DBX][connection:delete:disconnect-failed]", { connectionId, error });
      });
    }
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
  const connectionTargets = selectedConnectionClipboardTargets(props.node, nodes);
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

// --- Table Management Operations ---
const showDropTableConfirm = ref(false);
const showDropTableChildObjectConfirm = ref(false);
const showBatchDropConfirm = ref(false);
const showBatchEmptyConfirm = ref(false);
const showBatchTruncateConfirm = ref(false);
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
const dropTableCascade = ref(false);
const batchDropCascade = ref(false);
const emptyTablePreviewSql = ref("");
const truncateTablePreviewSql = ref("");
const truncateTableCascade = ref(false);
const dropObjectPreviewSql = ref("");
const dropTableChildObjectPreviewSql = ref("");
const batchDropPreviewSql = ref("");
const batchEmptyPreviewSql = ref("");
const batchEmptyTargets = ref<TreeNode[]>([]);
const batchTruncatePreviewSql = ref("");
const batchTruncateCascade = ref(false);
const dropDatabasePreviewSql = ref("");
const dropSchemaPreviewSql = ref("");
const showDuplicateDialog = ref(false);
const duplicateTableName = ref("");
const duplicateStructureSource = ref<DuplicateStructureSource | null>(null);

// Paste table dialog state
const showPasteDialog = ref(false);
const pasteTableMode = ref<PasteTableMode>("structure-and-data");
const pasteTableEntries = ref<{ sourceName: string; targetName: string; connectionId: string; database: string; schema?: string }[]>([]);
const pasteTableDataCopySupported = computed(() => supportsWholeRowTableDataCopy(currentDatabaseType()));

const ddlTarget = ref<TreeNode | null>(null);
const showDdlDialog = ref(false);
const ddlDialect = computed(() => {
  if (!ddlTarget.value?.connectionId) return "mysql";
  return codeMirrorSqlDialect(effectiveDatabaseTypeForConnection(connectionStore.getConfig(ddlTarget.value.connectionId)));
});
const ddlFormatDialect = computed(() => {
  if (!ddlTarget.value?.connectionId) return "generic";
  return sqlFormatDialectForDbType(effectiveDatabaseTypeForConnection(connectionStore.getConfig(ddlTarget.value.connectionId)));
});
const objectSourceTarget = ref<{ node: TreeNode; initialEditing: boolean } | null>(null);
const showObjectSourceDialog = ref(false);
const objectSourceType = computed(() => (objectSourceTarget.value ? objectSourceKindForTreeNode(objectSourceTarget.value.node.type) : null));
const objectSourceDatabaseType = computed(() => {
  const connectionId = objectSourceTarget.value?.node.connectionId;
  return connectionId ? effectiveDatabaseTypeForConnection(connectionStore.getConfig(connectionId)) : undefined;
});
const objectSourceDialect = computed(() => codeMirrorSqlDialect(objectSourceDatabaseType.value));
const objectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(objectSourceDatabaseType.value));
const showCreateDatabaseDialog = ref(false);
const createDatabaseName = ref("");
const createDatabaseCharset = ref("utf8mb4");
const createDatabaseCollation = ref("utf8mb4_unicode_ci");
const showCreateNacosNamespaceDialog = ref(false);
const createNacosNamespaceId = ref("");
const createNacosNamespaceName = ref("");
const createNacosNamespaceDesc = ref("");
const createNacosNamespaceLoading = ref(false);
const showEditNacosNamespaceDialog = ref(false);
const editNacosNamespaceName = ref("");
const editNacosNamespaceDesc = ref("");
const editNacosNamespaceLoading = ref(false);
const fallbackCreateDatabaseCharset = fallbackCreateDatabaseCharsetMetadata();
const createDatabaseCharsetOptions = ref<string[]>(fallbackCreateDatabaseCharset.charsets);
const createDatabaseCollationsByCharset = ref<Record<string, string[]>>(fallbackCreateDatabaseCharset.collationsByCharset);
const createDatabaseCharsetLoading = ref(false);
const showDropDatabaseConfirm = ref(false);
const dropDatabaseLoading = ref(false);
const showDropMongoCollectionConfirm = ref(false);
const dropMongoCollectionLoading = ref(false);
const showDropMongoIndexConfirm = ref(false);
const dropMongoIndexLoading = ref(false);
const showDropAllMongoIndexesConfirm = ref(false);
const dropAllMongoIndexesLoading = ref(false);
const showFlushRedisDbConfirm = ref(false);
const showCreateSchemaDialog = ref(false);
const createSchemaName = ref("");
const showDropSchemaConfirm = ref(false);
const showEditDatabasePropertiesDialog = ref(false);
const editDatabasePropertiesLoading = ref(false);
const editDatabasePropertiesPreviewSql = ref("");
const editDatabaseCharset = ref("utf8mb4");
const editDatabaseCollation = ref("utf8mb4_unicode_ci");
const editDatabaseCommentText = ref("");
const showEditSchemaCommentDialog = ref(false);
const schemaCommentText = ref("");
const schemaCommentLoading = ref(false);

// --- Extension Management ---
const installExtensionDialogRef = ref<InstanceType<typeof InstallExtensionDialog> | null>(null);

function openInstallExtensionDialog(_node: TreeNode) {
  installExtensionDialogRef.value?.show();
}

// --- Procedure / Function Management ---
const showDropObjectConfirm = ref(false);
const showProcedureExecutionConfirm = ref(false);

function dropObjectSqlOptions(): DropObjectSqlOptions | null {
  return dropObjectSqlOptionsForNode(props.node);
}

function dropObjectSqlOptionsForNode(node: TreeNode): DropObjectSqlOptions | null {
  if (node.type !== "view" && node.type !== "materialized_view" && node.type !== "procedure" && node.type !== "function") return null;
  return {
    databaseType: tableStructureDatabaseTypeForNode(node),
    objectType: node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : node.type === "procedure" ? "PROCEDURE" : "FUNCTION",
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
  if (props.node.type === "materialized_view") return t("contextMenu.dropView");
  if (props.node.type === "procedure") return t("contextMenu.dropProcedure");
  if (props.node.type === "function") return t("contextMenu.dropFunction");
  return t("contextMenu.dropObject");
}

function dropObjectConfirmTitle(): string {
  if (props.node.type === "view") return t("contextMenu.confirmDropViewTitle");
  if (props.node.type === "materialized_view") return t("contextMenu.confirmDropViewTitle");
  if (props.node.type === "procedure") return t("contextMenu.confirmDropProcedureTitle");
  if (props.node.type === "function") return t("contextMenu.confirmDropFunctionTitle");
  return t("contextMenu.confirmDropObjectTitle");
}

function dropObjectConfirmMessage(): string {
  if (props.node.type === "view") return t("contextMenu.confirmDropViewMessage", { name: props.node.label });
  if (props.node.type === "materialized_view") return t("contextMenu.confirmDropViewMessage", { name: props.node.label });
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

function openObjectSourceDialog(initialEditing: boolean) {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const objectType = objectSourceKindForTreeNode(node.type);
  if (!objectType) return;
  void connectionStore
    .ensureConnected(node.connectionId)
    .then(() => {
      connectionStore.activeConnectionId = node.connectionId!;
      objectSourceTarget.value = { node, initialEditing };
      showObjectSourceDialog.value = true;
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

function selectedBatchMongoIndexTargets(): TreeNode[] {
  const targets = selectedBatchDropTargets();
  return targets.length > 1 && targets.every((node) => canDropMongoIndexNode(node)) ? targets : [];
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
  const targets = selectedBatchDropTargets();
  if (targets.length > 1 && targets.every((node) => node.type === "index")) {
    return t("contextMenu.confirmDropIndexTitle");
  }
  return t("contextMenu.confirmBatchDropTitle", { count: targets.length });
}

function batchDropConfirmMessage(): string {
  const targets = selectedBatchDropTargets();
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
  return t("contextMenu.confirmBatchTruncateTitle", { count: selectedBatchTruncateTargets().length });
}

function batchTruncateConfirmMessage(): string {
  return t("contextMenu.confirmBatchTruncateMessage", { count: selectedBatchTruncateTargets().length });
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
  const targets = selectedBatchDropTargets();
  const mongoIndexTargets = selectedBatchMongoIndexTargets();
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
  const targets = selectedBatchTruncateTargets();
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
  if (!selectedBatchDropTargets().length) return;
  batchDropCascade.value = false;
  void refreshBatchDropPreviewSql();
  showBatchDropConfirm.value = true;
}

function requestBatchTruncate() {
  if (!selectedBatchTruncateTargets().length) return;
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
  if (props.node.type === "table") return "TABLE";
  if (props.node.type === "view") return "VIEW";
  if (props.node.type === "materialized_view") return "MATERIALIZED_VIEW";
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
    const msgKey = node.type === "view" ? "contextMenu.dropViewSuccess" : node.type === "materialized_view" ? "contextMenu.dropViewSuccess" : node.type === "procedure" ? "contextMenu.dropProcedureSuccess" : "contextMenu.dropFunctionSuccess";
    toast(t(msgKey, { name: node.label }), 3000);
    closeDroppedTableObjectTabsForNode(node);
    if (node.type === "view" || node.type === "materialized_view") {
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
    const mongoIndexTargets = selectedBatchMongoIndexTargets();
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
          if (dropped.has(mongoIndexNameForNode(target))) connectionStore.removeTreeNode(target.id);
        }
      }
      toast(t("contextMenu.batchDropSuccess", { count: droppedCount }), 3000);
      showBatchDropConfirm.value = false;
      return;
    }
    const useCascade = canBatchDropCascade.value && batchDropCascade.value;
    for (const target of targets) {
      if (!target.connectionId || !target.database) continue;
      await connectionStore.ensureConnected(target.connectionId);
      const sql = await dropSqlForTreeNode(target, { cascade: useCascade });
      if (!sql) continue;
      await api.executeQuery(target.connectionId, target.database, sql, target.schema);
      closeDroppedTableObjectTabsForNode(target);
      connectionStore.removeTreeNode(target.id);
    }
    toast(t("contextMenu.batchDropSuccess", { count: targets.length }), 3000);
    showBatchDropConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmBatchTruncate() {
  const targets = selectedBatchTruncateTargets();
  if (!targets.length) return;
  try {
    const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
    for (const target of targets) {
      if (!target.connectionId || !target.database) continue;
      await connectionStore.ensureConnected(target.connectionId);
      const sql = await truncateSqlForTreeNode(target, { cascade: useCascade });
      if (!sql) continue;
      await api.executeQuery(target.connectionId, target.database, sql, target.schema);
    }
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
    await api.executeQuery(target.connectionId, target.database, sql, target.schema);
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
  batchEmptyTargets.value = [];
  showBatchEmptyConfirm.value = false;
}

const isTableNotView = computed(() => props.node.type === "table" && !isSqlServerLinkedNode(props.node));

const supportsTruncate = computed(() => {
  return supportsTableTruncate(currentDatabaseType());
});

const canCreateTable = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return (props.node.type === "database" || props.node.type === "schema" || props.node.type === "group-tables") && !isSqlServerLinkedNode(props.node) && !!props.node.database && supportsTableStructureEditing(tableStructureDatabaseTypeForConnection(config));
});

const canCreateDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && canCreateConnectionNamespace(config);
});

const canCreateNacosNamespace = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && config?.db_type === "nacos" && !config.read_only;
});

const canEditNacosNamespace = computed(() => {
  if (props.node.type !== "nacos-namespace" || !props.node.connectionId || !props.node.nacosNamespace) return false;
  const config = connectionStore.getConfig(props.node.connectionId);
  return config?.db_type === "nacos" && !config.read_only;
});

const isDuckDbConnection = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && connectionNamespaceCreationTarget(config) === "attach";
});

const isConnectionSchemaCreation = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && connectionNamespaceCreationTarget(config) === "schema";
});

const canSetCreateDatabaseCharset = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return connectionNamespaceCreationTarget(config) === "database" && supportsCreateDatabaseCharset(config?.db_type, config?.driver_profile);
});

const canDropDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "database" && !isSqlServerLinkedNode(props.node) && supportsDatabaseCreation(config?.db_type);
});

const databasePropertyGroups = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return editableDatabasePropertyGroups(config, props.node);
});

const canEditDatabaseProperties = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return canEditDatabasePropertiesForNode(config, props.node) && !isSqlServerLinkedNode(props.node);
});

const canEditDatabaseCharsetCollation = computed(() => databasePropertyGroups.value.includes("charsetCollation"));
const canEditDatabaseComment = computed(() => databasePropertyGroups.value.includes("databaseComment"));

const canDropMongoDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "mongo-db" && !!props.node.database && config?.driver_profile !== "mongodb-legacy";
});

const canDropMongoCollection = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "mongo-collection" && !!props.node.database && config?.driver_profile !== "mongodb-legacy";
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

const canDropMongoIndex = computed(() => canDropMongoIndexNode(props.node));

function mongoIndexDropPreview(node: Pick<TreeNode, "tableName">, indexName: string): string {
  return `db.getCollection(${JSON.stringify(node.tableName || "")}).dropIndex(${JSON.stringify(indexName)})`;
}

const canDropAllMongoIndexes = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "mongo-collection" && !!props.node.database && config?.db_type === "mongodb" && config.driver_profile !== "mongodb-legacy";
});

function mongoDropAllIndexesPreview(node: Pick<TreeNode, "label">): string {
  return `db.getCollection(${JSON.stringify(node.label)}).dropIndexes()`;
}

const canCreateSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return canCreateDatabaseNodeNamespace(config, props.node) && !isSqlServerLinkedNode(props.node) && !connectionUsesDatabaseObjectTreeMode(config);
});

const canDropSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "schema" && !isSqlServerLinkedNode(props.node) && usesTreeSchemaMode(effectiveDatabaseTypeForConnection(config)) && !connectionUsesDatabaseObjectTreeMode(config);
});

const canEditSchemaComment = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "schema" && !!props.node.database && !config?.read_only && supportsSchemaComment(effectiveDatabaseTypeForConnection(config));
});

const canDropTableCascade = computed(() => props.node.type === "table" && supportsDropTableCascade(currentDatabaseType()));
const canTruncateTableCascade = computed(() => props.node.type === "table" && supportsTruncateTableCascade(currentDatabaseType()));
const canBatchDropCascade = computed(() => {
  const targets = selectedBatchTableTargets();
  return targets.length > 1 && targets.every((node) => supportsDropTableCascade(databaseTypeForNode(node)));
});
const canBatchTruncateCascade = computed(() => {
  const targets = selectedBatchTruncateTargets();
  return targets.length > 1 && targets.every((node) => supportsTruncateTableCascade(databaseTypeForNode(node)));
});

function tableAdminSqlOptions(options?: { cascade?: boolean }): TableAdminSqlOptions {
  const result: TableAdminSqlOptions = {
    databaseType: currentDatabaseType(),
    schema: props.node.schema,
    tableName: props.node.label,
  };
  if (options?.cascade) result.cascade = true;
  return result;
}

function dropTableSqlOptions(): TableAdminSqlOptions {
  return tableAdminSqlOptions({ cascade: canDropTableCascade.value && dropTableCascade.value });
}

function truncateTableSqlOptions(): TableAdminSqlOptions {
  return tableAdminSqlOptions({ cascade: canTruncateTableCascade.value && truncateTableCascade.value });
}

async function refreshDropTablePreviewSql() {
  dropTablePreviewSql.value = "";
  dropTablePreviewSql.value = await buildDropTableSql(dropTableSqlOptions()).catch(() => "");
}

async function refreshEmptyTablePreviewSql() {
  emptyTablePreviewSql.value = "";
  emptyTablePreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions()).catch(() => "");
}

async function refreshTruncateTablePreviewSql() {
  truncateTablePreviewSql.value = "";
  truncateTablePreviewSql.value = await buildTruncateTableSql(truncateTableSqlOptions()).catch(() => "");
}

function dropTable() {
  dropTableCascade.value = false;
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
    const sql = dropTablePreviewSql.value || (await buildDropTableSql(dropTableSqlOptions()));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.dropTableSuccess", { name: node.label }), 3000);
    closeDroppedTableObjectTabsForNode(node);
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
    const messageKey = currentDatabaseType() === "clickhouse" ? "contextMenu.emptyTableSubmitted" : "contextMenu.emptyTableSuccess";
    toast(t(messageKey, { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function truncateTable() {
  truncateTableCascade.value = false;
  void refreshTruncateTablePreviewSql();
  showTruncateTableConfirm.value = true;
}

async function confirmTruncateTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = truncateTablePreviewSql.value || (await buildTruncateTableSql(truncateTableSqlOptions()));
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
    toast(t("contextMenu.truncateTableSuccess", { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshDropDatabasePreviewSql() {
  if (props.node.type === "mongo-db") {
    dropDatabasePreviewSql.value = `db.getSiblingDB(${JSON.stringify(props.node.label)}).dropDatabase();`;
    return;
  }
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

function databasePropertyName(): string {
  return props.node.database || props.node.label;
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
    driverProfile: props.node.connectionId ? connectionStore.getConfig(props.node.connectionId)?.driver_profile : undefined,
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
  const node = props.node;
  if (!node.connectionId) return;
  const sql = `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${databasePropertyName().replace(/'/g, "''")}';`;
  const result = await api.executeQuery(node.connectionId, databasePropertyName(), sql, undefined, undefined, { maxRows: 1 });
  const charset = resultColumnValue(result, ["charset", "DEFAULT_CHARACTER_SET_NAME"]);
  const collation = resultColumnValue(result, ["collation", "DEFAULT_COLLATION_NAME"]);
  if (charset) editDatabaseCharset.value = charset;
  if (collation) editDatabaseCollation.value = collation;
}

async function loadDatabaseCommentProperty() {
  const node = props.node;
  if (!node.connectionId) return;
  const sql = buildGetDatabaseCommentSql({
    databaseType: currentDatabaseType(),
    name: databasePropertyName(),
  });
  const result = await api.executeQuery(node.connectionId, databasePropertyName(), sql, undefined, undefined, { maxRows: 1 });
  editDatabaseCommentText.value = resultColumnValue(result, ["comment"]);
}

async function openEditDatabasePropertiesDialog() {
  const node = props.node;
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
  const node = props.node;
  if (!canEditDatabaseProperties.value || !node.connectionId || editDatabasePropertiesLoading.value) return;
  editDatabasePropertiesLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const options = databasePropertyEditOptions();
    if (!options) return;
    const sql = await buildUpdateDatabasePropertiesSql(options);
    await api.executeQuery(node.connectionId, databasePropertyName(), sql);
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

const schemaCommentPreviewSql = ref("");

async function refreshSchemaCommentPreviewSql() {
  if (!canEditSchemaComment.value) {
    schemaCommentPreviewSql.value = "";
    return;
  }
  schemaCommentPreviewSql.value = await buildUpdateDatabasePropertiesSql({
    databaseType: currentDatabaseType(),
    target: "schema",
    name: props.node.schema || props.node.label,
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
  const node = props.node;
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
  const node = props.node;
  if (!canEditSchemaComment.value || !node.connectionId || !node.database || schemaCommentLoading.value) return;
  schemaCommentLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = await buildUpdateDatabasePropertiesSql({
      databaseType: currentDatabaseType(),
      target: "schema",
      name: node.schema || node.label,
      comment: schemaCommentText.value,
    });
    await api.executeQuery(node.connectionId, node.database, sql, node.schema);
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
  openCreateDatabaseDialog();
}

function openCreateDatabaseDialog() {
  createDatabaseName.value = "";
  createDatabaseCharset.value = "utf8mb4";
  createDatabaseCollation.value = "utf8mb4_unicode_ci";
  createDatabaseCharsetOptions.value = fallbackCreateDatabaseCharset.charsets;
  createDatabaseCollationsByCharset.value = fallbackCreateDatabaseCharset.collationsByCharset;
  showCreateDatabaseDialog.value = true;
  if (canSetCreateDatabaseCharset.value) {
    void loadCreateDatabaseCharsetMetadata();
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
  const node = props.node;
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

function openCreateNacosNamespaceDialog() {
  createNacosNamespaceId.value = "";
  createNacosNamespaceName.value = "";
  createNacosNamespaceDesc.value = "";
  showCreateNacosNamespaceDialog.value = true;
}

async function confirmCreateNacosNamespace() {
  const node = props.node;
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
    node.isExpanded = true;
    toast(t("nacos.namespaceCreated", { name: namespaceName }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    createNacosNamespaceLoading.value = false;
  }
}

function openEditNacosNamespaceDialog() {
  editNacosNamespaceName.value = props.node.nacosNamespaceName || props.node.label;
  editNacosNamespaceDesc.value = props.node.comment || "";
  showEditNacosNamespaceDialog.value = true;
}

async function confirmEditNacosNamespace() {
  const node = props.node;
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
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  } finally {
    editNacosNamespaceLoading.value = false;
  }
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
    await connectionStore.ensureVisibleDatabase(node.connectionId, name);
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
    if (config?.db_type === "mongodb") {
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
    await api.executeQuery(node.connectionId, "", sql);
    toast(t("contextMenu.createDatabaseSuccess", { name }), 3000);
    await connectionStore.ensureVisibleDatabase(node.connectionId, name);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function dropDatabase() {
  void refreshDropDatabasePreviewSql();
  dropDatabaseLoading.value = false;
  showDropDatabaseConfirm.value = true;
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
        databaseType: currentDatabaseType(),
        name: node.label,
      }));
    await api.executeQuery(node.connectionId, "", sql);
    toast(t("contextMenu.dropDatabaseSuccess", { name: node.label }), 3000);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
    showDropDatabaseConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropDatabaseLoading.value = false;
  }
}

async function confirmDropMongoCollection() {
  const node = props.node;
  if (node.type !== "mongo-collection" || !node.connectionId || !node.database || dropMongoCollectionLoading.value) return;
  dropMongoCollectionLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.mongoDropCollection(node.connectionId, node.database, node.label);
    toast(t("contextMenu.dropCollectionSuccess", { name: node.label }), 3000);
    await connectionStore.loadMongoCollections(node.connectionId, node.database);
    showDropMongoCollectionConfirm.value = false;
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
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
  const node = props.node;
  if (!canDropMongoIndexNode(node) || !node.connectionId || !node.database || !node.tableName || dropMongoIndexLoading.value) return;
  dropMongoIndexLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const indexName = mongoIndexNameForNode(node);
    await api.mongoDropIndexes(node.connectionId, node.database, node.tableName, JSON.stringify(indexName), true);
    toast(t("contextMenu.dropTableChildObjectSuccess", { name: indexName }), 3000);
    showDropMongoIndexConfirm.value = false;
    await refreshMongoIndexTree(node);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropMongoIndexLoading.value = false;
  }
}

async function confirmDropAllMongoIndexes() {
  const node = props.node;
  if (node.type !== "mongo-collection" || !node.connectionId || !node.database || dropAllMongoIndexesLoading.value) return;
  dropAllMongoIndexesLoading.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const result = await api.mongoDropIndexes(node.connectionId, node.database, node.label, undefined, false);
    toast(t("contextMenu.dropAllIndexesSuccess", { count: result.dropped_names.length, name: node.label }), 3000);
    showDropAllMongoIndexesConfirm.value = false;
    await refreshMongoIndexTree(node);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    dropAllMongoIndexesLoading.value = false;
  }
}

function openCreateSchemaDialog() {
  createSchemaName.value = "";
  showCreateSchemaDialog.value = true;
}

async function confirmCreateSchema() {
  const node = props.node;
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
    await api.executeQuery(node.connectionId, targetDatabase || "", sql);
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
        await api.executeQuery(entry.connectionId, entry.database, structureSql, entry.schema);
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
        await api.executeQuery(entry.connectionId, entry.database, dataSql, entry.schema);
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
  const node = props.node;
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
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  queryStore.openTableStructure(node.connectionId, node.database, node.schema, "");
}

function createView() {
  const node = props.node;
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
      const ddl = await api.getTableDdl(target.connectionId, target.database, target.schema || target.database, target.label, tableDdlObjectTypeForNode(target.type));
      parts.push(ddl.trim());
    }
    structurePreviewSql.value = joinExportedDdls(parts);
  } catch (e: any) {
    structurePreviewError.value = e?.message || String(e);
    console.error("Export structure failed:", e);
  } finally {
    isLoadingStructurePreview.value = false;
  }
}

function canExportStructureNode(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return (node.type === "table" || node.type === "view" || node.type === "materialized_view") && !!node.connectionId && !!node.database;
}

function tableDdlObjectTypeForNode(type: TreeNodeType): ObjectSourceKind | undefined {
  if (type === "view") return "VIEW";
  if (type === "materialized_view") return "MATERIALIZED_VIEW";
  return undefined;
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
      tableType: node.tableType,
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
    const rowLimit = settingsStore.editorSettings.exportRowLimitEnabled ? settingsStore.editorSettings.exportRowLimit : null;
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
      rowLimit,
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

const revealConnectionFilePath = computed<string | null>(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return null;
  const config = connectionStore.getConfig(props.node.connectionId);
  if (!config) return null;
  return connectionFilePath(config);
});

async function revealDatabaseFile() {
  const path = revealConnectionFilePath.value;
  if (!path) return;
  try {
    await revealPathInFileManager(path);
  } catch (e: any) {
    const message = typeof e === "string" ? e : e?.message || String(e);
    toast(message, 5000);
  }
}

const sqliteBackupSource = computed<string | null>(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return null;
  const config = connectionStore.getConfig(props.node.connectionId);
  if (!config) return null;
  return sqliteBackupSourcePath(config);
});

const canBackupSqliteDatabase = computed(() => {
  const source = sqliteBackupSource.value;
  if (!source || !props.node.connectionId) return false;
  return isTauriRuntime() && (!isMemorySqlitePath(source) || connectionStore.connectedIds.has(props.node.connectionId));
});

async function backupSqliteDatabase() {
  const connId = props.node.connectionId;
  const config = connId ? connectionStore.getConfig(connId) : undefined;
  const sourcePath = sqliteBackupSource.value;
  if (!connId || !config || !sourcePath) return;

  try {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const destinationPath = await save({
      defaultPath: defaultSqliteBackupFileName(config),
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (!destinationPath) return;

    toast(t("contextMenu.backupSqliteDatabaseInProgress"), 2000);
    if (!isMemorySqlitePath(sourcePath)) {
      await connectionStore.ensureConnected(connId);
    }
    await api.backupSqliteDatabase(connId, destinationPath);
    toast(t("contextMenu.backupSqliteDatabaseSuccess"), 3000);
  } catch (e: any) {
    toast(t("contextMenu.backupSqliteDatabaseFailed", { message: e?.message || String(e) }), 5000);
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

async function cancelConnectionAttempt() {
  if (!props.node.connectionId) return;
  try {
    const cancelled = await connectionStore.cancelConnecting(props.node.connectionId);
    if (cancelled) toast(t("connection.connectCancelled"), 2000);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
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
    schema: node.type === "schema" || node.type === "table" || node.type === "view" || node.type === "materialized_view" ? node.schema : undefined,
    tableName: node.type === "table" || node.type === "view" || node.type === "materialized_view" ? node.label : undefined,
  };
}

function openAllDatabasesExport() {
  const node = props.node;
  if (node.type !== "connection" || !node.connectionId) return;
  connectionStore.databaseExportSource = {
    connectionId: node.connectionId,
    database: "",
    allDatabases: true,
  };
}

function openTableImport() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  connectionStore.tableImportSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.type === "table" ? node.label : undefined,
  };
}

function openStructureEditor() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  if (node.type === "table") {
    queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.label);
    return;
  }
  if (node.type === "column" && node.tableName) {
    const columnName = tableChildDropObjectName(node).trim();
    if (!columnName) return;
    queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.tableName, "columns", { kind: "column", name: columnName });
    return;
  }
  if (node.type === "index" && node.tableName) {
    const indexName = tableChildDropObjectName(node).trim();
    if (!indexName) return;
    queryStore.openTableStructure(node.connectionId, node.database, node.schema, node.tableName, "indexes", { kind: "index", name: indexName });
  }
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
const canPin = computed(() => canTreeNodePin(props.node.type));
const canOpenSqlFileExecution = computed(() => {
  return supportsSqlFileExecution(rawDatabaseType());
});
const canExportAllDatabases = computed(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return false;
  const dbType = connectionStore.getConfig(props.node.connectionId)?.db_type;
  return !["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "nacos"].includes(dbType || "");
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
  const node = props.node;
  const supportedNode = node.type === "table" || ((node.type === "database" || node.type === "schema" || node.type === "group-tables") && canCreateTable.value);
  return supportedNode && !isSqlServerLinkedNode(node) && !!node.connectionId && !!node.database && supportsTableImport(currentDatabaseType());
});
const canOpenStructureEditor = computed(() => {
  const editableNode = props.node.type === "table" || ((props.node.type === "column" || props.node.type === "index") && !!props.node.tableName);
  return editableNode && !isSqlServerLinkedNode(props.node) && !!props.node.connectionId && !!props.node.database && supportsTableStructureEditing(currentTableStructureDatabaseType());
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
const columnComment = computed(() => (!settingsStore.editorSettings.sidebarHideTableComments && props.node.type === "column" && props.node.meta && "comment" in props.node.meta ? (props.node.meta as any).comment : null));
const tableComment = computed(() =>
  !settingsStore.editorSettings.sidebarHideTableComments &&
  (props.node.type === "schema" || props.node.type === "table" || props.node.type === "view" || props.node.type === "mongo-collection" || props.node.type === "vector-collection" || props.node.type === "elasticsearch-index") &&
  props.node.comment
    ? props.node.comment
    : null,
);
const paddingLeft = computed(() => treeItemPaddingLeft(props.depth));
const tableSearchParentId = computed(() => props.node.tableSearchParentId || "");
const tableSearchValue = computed(() => {
  const parentId = tableSearchParentId.value;
  return parentId ? connectionStore.sidebarTableSearchQueries[parentId] || "" : "";
});
const isConnected = computed(() => props.node.type === "connection" && !!props.node.connectionId && connectionStore.connectedIds.has(props.node.connectionId));
const isConnecting = computed(() => props.node.type === "connection" && !!props.node.connectionId && connectionStore.connectingIds.has(props.node.connectionId));
const isConnectionReadonly = computed(() => props.node.type === "connection" && !!props.node.connectionId && (connectionStore.getConfig(props.node.connectionId)?.read_only ?? false));
const isOpenedDatabase = computed(() => isSidebarDatabaseOpened(props.node, connectionStore.isTreeNodeChildrenLoaded));
const showsDatabaseOpenIndicator = computed(() => props.node.type === "database" && (isOpenedDatabase.value || (!!props.node.connectionId && props.node.database != null && queryStore.isDatabaseOpen(props.node.connectionId, props.node.database))));
const canCloseDatabaseConnection = computed(() => canCloseSidebarDatabaseConnection(props.node, connectionStore.isTreeNodeChildrenLoaded));
const nodeIconClass = computed(() => {
  const infoClass = getIconInfo(props.node)?.colorClass;
  if (props.node.type !== "database") return infoClass;
  return isOpenedDatabase.value ? infoClass : "text-muted-foreground/65";
});

const canConfigureVisibleDatabases = computed(() => {
  if (props.node.type !== "connection" || !props.node.connectionId) return false;
  const dbType = connectionStore.getConfig(props.node.connectionId)?.db_type;
  return dbType !== "elasticsearch" && dbType !== "qdrant" && dbType !== "milvus" && dbType !== "weaviate" && dbType !== "chromadb" && dbType !== "etcd" && dbType !== "mq" && dbType !== "nacos";
});

const canConfigureVisibleSchemas = computed(() => {
  if (props.node.type === "database" && props.node.connectionId && props.node.database != null) {
    const dbType = connectionStore.getConfig(props.node.connectionId)?.db_type;
    return isSchemaAware(dbType);
  }
  if (props.node.type === "connection" && props.node.connectionId) {
    const dbType = connectionStore.getConfig(props.node.connectionId)?.db_type;
    return isSchemaAware(dbType) && !usesTreeSchemaMode(dbType);
  }
  return false;
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
const isTreeRowSelected = computed(() => isSelected.value || isMultiSelected.value);
const usesSelectionSetHighlight = computed(() => connectionStore.connectionMultiSelectActive || connectionStore.selectedTreeNodeIds.length > 1);
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
const tableSearchStyle = computed(() => {
  const color = connectionColor.value;
  const rowBackgroundColor = color ? hexToRgba(color, isActiveConnectionScope.value ? 0.14 : 0.08) : "transparent";
  return {
    paddingLeft: paddingLeft.value,
    "--tree-table-search-row-bg": rowBackgroundColor,
    "--tree-table-search-input-bg": color ? hexToRgba(color, isActiveConnectionScope.value ? 0.05 : 0.03) : "hsl(var(--background) / 0.56)",
    "--tree-table-search-border": color ? hexToRgba(color, isActiveConnectionScope.value ? 0.12 : 0.08) : "hsl(var(--border) / 0.36)",
  };
});

function togglePin() {
  connectionStore.toggleTreeNodePin(props.node.id);
}

function updateTableSearchQuery(value: string | number) {
  const parentId = tableSearchParentId.value;
  if (!parentId) return;
  const query = String(value);
  if (sidebarTreeContext?.setTableSearchQuery) {
    sidebarTreeContext.setTableSearchQuery(parentId, query);
    return;
  }
  connectionStore.setSidebarTableSearchQuery(parentId, query);
  void connectionStore.refreshSidebarTableSearch(parentId);
}

function clearTableSearchQuery() {
  updateTableSearchQuery("");
}

function openVisibleDatabasesDialog() {
  showVisibleDatabasesDialog.value = true;
}

function openVisibleSchemasDialog() {
  showVisibleSchemasDialog.value = true;
}

// --- Connection Group Management ---
const isRenamingGroup = ref(false);
const renameInput = ref("");
const renameInputRef = ref<HTMLInputElement>();

function shouldMeasureLabelOverflow(): boolean {
  return shouldMeasureSidebarLabelOverflow({
    hasDetailTooltip: !!detailTooltip.value?.rows.length,
    isRenaming: isRenamingGroup.value,
    usesFullWidthLabel: usesFullWidthLabel.value,
  });
}

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

watch(
  [() => props.node.id, () => visibleLabel(props.node), () => usesFullWidthLabel.value, () => detailTooltip.value?.rows.length ?? 0, isRenamingGroup],
  () => {
    nextTick(observeLabelOverflow);
  },
  { flush: "post", immediate: true },
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

function newSubgroup() {
  const groupId = connectionStore.createConnectionGroup(t("connectionGroup.newGroupDefault"), props.node.id);
  connectionStore.selectedTreeNodeId = groupId;
  emit("group-created", groupId);
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
  const find = (entries: typeof connectionStore.sidebarLayout.order): string | null => {
    for (const entry of entries) {
      if (entry.type !== "group") continue;
      if ((entry.children ?? entry.connectionIds?.map((id) => ({ type: "connection" as const, id })) ?? []).some((child) => child.type === "connection" && child.id === props.node.connectionId)) {
        return entry.id;
      }
      const found = find(entry.children ?? []);
      if (found) return found;
    }
    return null;
  };
  return find(connectionStore.sidebarLayout.order);
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
const canDragTableReference = computed(() => {
  if (props.dragDisabled || !props.node.connectionId) return false;
  if (props.node.type === "database") return typeof props.node.database === "string" && props.node.database.trim().length > 0;
  if (props.node.database == null) return false;
  if (props.node.type === "table" || props.node.type === "view" || props.node.type === "materialized_view") return true;
  return props.node.type === "column" && !!props.node.tableName;
});

let pendingTableReferenceDrag: {
  payload: QueryEditorTableReferencePayload;
  startX: number;
  startY: number;
} | null = null;
let draggingTableReferencePayload: QueryEditorTableReferencePayload | null = null;
let suppressNextTableReferenceClick = false;

function tableReferenceDragPayload(): QueryEditorTableReferencePayload | null {
  if (!canDragTableReference.value) return null;
  if (props.node.type === "database") {
    return createTableReferencePayload({
      connectionId: props.node.connectionId,
      database: props.node.database,
      referenceType: "database",
      databaseType: currentDatabaseType(),
    });
  }
  if (props.node.type === "column") {
    const columnName = columnNameForDrag(props.node);
    if (!props.node.tableName || !columnName) return null;
    return createTableReferencePayload({
      connectionId: props.node.connectionId,
      database: props.node.database,
      schema: props.node.schema,
      tableName: props.node.tableName,
      columnName,
      databaseType: currentDatabaseType(),
    });
  }
  const payload = createTableReferencePayload({
    connectionId: props.node.connectionId,
    database: props.node.database,
    schema: props.node.schema,
    tableName: props.node.label,
    databaseType: currentDatabaseType(),
  });
  return payload;
}

function columnNameForDrag(node: TreeNode): string {
  const column = node.meta as Partial<ColumnInfo> | undefined;
  if (typeof column?.name === "string" && column.name) return column.name;
  return node.label.replace(/\s+\([^()]*\)$/, "");
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

onMounted(() => {
  observeLabelOverflow();
  window.addEventListener("dbx:sidebar-request-paste-table", onSidebarRequestPasteTable);
});

onBeforeUnmount(() => {
  labelResizeObserver?.disconnect();
  labelResizeObserver = null;
  cancelLabelOverflowMeasure();
  window.removeEventListener("dbx:sidebar-request-paste-table", onSidebarRequestPasteTable);
  finishTableReferenceDrag();
});

// ---- CustomContextMenu ----

const shortcutCopyName = computed(() => settingsStore.editorSettings.shortcuts.copySidebarSelection);
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
  const scope = savedSqlHistoryScopeForNode(props.node);
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

function treeItemMenuItems(): ContextMenuItem[] {
  const node = props.node;
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
    if (supportsDatabaseUserAdmin(currentDatabaseType())) {
      items.push({ label: t("contextMenu.userAdmin"), action: openUserAdmin, icon: UsersRound });
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
    return items;
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
    return items;
  }

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
    if (node.type === "database") {
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
    return items;
  }

  // 5. Redis DB / Mongo DB
  if (node.type === "etcd-root" || node.type === "zookeeper-root") {
    items.push({ label: t("contextMenu.openConnection"), action: toggle, icon: Database });
    return items;
  }

  if (node.type === "user-admin") {
    items.push({ label: t("contextMenu.openUserAdmin"), action: openUserAdmin, icon: UsersRound });
    return items;
  }

  if (node.type === "dameng-job-admin") {
    items.push({ label: t("contextMenu.openDamengJobAdmin"), action: openDamengJobAdmin, icon: CalendarClock });
    return items;
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
    return items;
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
    return items;
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
    return items;
  }

  if (node.type === "elasticsearch-index" || node.type === "vector-collection") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: toggle, icon: TableProperties });
    items.push({ label: t("contextMenu.newQuery"), action: newQuery, icon: TerminalSquare });
    return items;
  }

  // 6. Table / View / Materialized View
  if (node.type === "table" || node.type === "view" || node.type === "materialized_view") {
    const destructiveActions: ContextMenuItem[] = [];
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.viewData"), action: openData, icon: TableProperties });
    if (node.type === "table") {
      items.push({
        label: t("contextMenu.viewDdl"),
        action: () => {
          ddlTarget.value = node;
          showDdlDialog.value = true;
        },
        icon: FileCode,
      });
    }
    if (node.type === "view" || node.type === "materialized_view") {
      items.push({ label: t("contextMenu.editView"), action: () => openObjectSourceDialog(true), icon: Pencil });
      items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
      items.push({
        label: t("contextMenu.viewDdl"),
        action: () => {
          ddlTarget.value = node;
          showDdlDialog.value = true;
        },
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
    return items;
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
    return items;
  }

  if (node.type === "index" || node.type === "fkey" || node.type === "trigger") {
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
    return items;
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
    return items;
  }

  if (node.type === "sequence") {
    items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return items;
  }

  if (node.type === "package" || node.type === "package-body") {
    items.push({ label: t("contextMenu.viewSource"), action: () => openObjectSourceDialog(false), icon: Code2 });
    items.push({ label: "", separator: true });
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return items;
  }

  // 8.5 Extension
  if (node.type === "extension") {
    items.push({ label: t("contextMenu.copyName"), action: copyName, icon: Copy, shortcut: shortcutCopyName.value });
    return items;
  }

  // 9. Group Labels (group-columns, group-tables, etc.)
  if (isGroupLabel(node)) {
    const hasGroupCreateAction = (node.type === "group-tables" && canCreateTable.value) || (node.type === "group-views" && !!node.connectionId && !!node.database);
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
  <div v-if="node.type === 'table-search-control'" class="tree-table-search-control flex h-7 items-center py-0.5 pr-2" :style="tableSearchStyle" @click.stop @dblclick.stop @mousedown.stop @keydown.stop>
    <div class="relative w-full min-w-0">
      <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
      <Input
        :model-value="tableSearchValue"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        class="h-6 w-full rounded border pl-7 pr-6 text-xs shadow-none focus-visible:ring-1"
        :style="{ backgroundColor: 'var(--tree-table-search-input-bg)', borderColor: 'var(--tree-table-search-border)' }"
        :placeholder="t(node.label)"
        :aria-label="t(node.label)"
        :data-sidebar-table-search-parent-id="tableSearchParentId"
        @update:model-value="updateTableSearchQuery"
      />
      <button v-if="tableSearchValue" type="button" class="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :aria-label="t('sidebar.clearTableSearch')" @click.stop="clearTableSearchQuery">
        <X class="h-3 w-3" />
      </button>
    </div>
  </div>

  <CustomContextMenu v-else :items="treeItemMenuItems" v-slot="contextMenuSlot">
    <div @contextmenu="onTreeItemContextMenu($event, contextMenuSlot.onContextMenu)">
      <LightTooltip :text="displayLabel(node)" :disabled="isTooltipDisabled()" side="right" :side-offset="8" :delay="0" :close-delay="0" :surface="detailTooltip ? 'popover' : 'foreground'">
        <div
          ref="rowRef"
          class="group flex items-center gap-1.5 py-1 px-2 cursor-pointer relative outline-none"
          style="contain: layout style"
          :class="[
            rowWidthClass,
            {
              'group/sidebar-row': true,
              'ring-1 ring-primary/50 bg-primary/5': showDropInside,
              'opacity-50': isDragging,
              'tree-item-connection-tint': connectionColor,
              'hover:bg-accent': node.type !== 'connection',
              'hover:bg-secondary/60': node.type === 'connection',
              rounded: !isTreeRowSelected,
              'tree-item-active': isTreeRowSelected,
              'tree-item-active--selection-set': usesSelectionSetHighlight && isTreeRowSelected,
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
            <button type="button" class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" @mousedown.stop="onToggleMouseDown" @click.stop="onToggleClick">
              <Loader2 v-if="node.isLoading" class="w-3.5 h-3.5 animate-spin" />
              <ChevronDown v-else-if="node.isExpanded" class="w-3.5 h-3.5" />
              <ChevronRight v-else class="w-3.5 h-3.5" />
            </button>
          </template>
          <span v-else class="w-3.5 h-3.5 shrink-0" />
          <DatabaseIcon v-if="node.type === 'connection'" :db-type="connectionIconType(node.connectionId)" class="h-3.5 w-3.5 shrink-0" />
          <Loader2 v-else-if="node.type === 'load-more' && node.isLoading" class="w-3.5 h-3.5 shrink-0 animate-spin text-primary" />
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
            v-if="
              (node.type === 'group-tables' || node.type === 'group-views' || node.type === 'group-materialized-views' || node.type === 'group-procedures' || node.type === 'group-functions' || node.type === 'group-sequences' || node.type === 'group-packages' || node.type === 'group-partitions') &&
              node.objectCount != null
            "
            class="text-muted-foreground text-[10px] shrink-0"
            >{{ node.objectCount }}</span
          >
          <Badge v-if="isNodeDefaultDatabase" variant="secondary" class="h-4 px-1.5 text-[10px]">
            {{ t("editor.defaultDatabase") }}
          </Badge>
          <span v-if="columnComment" class="sidebar-object-comment ml-auto max-w-[20%] shrink-0 truncate text-right" :class="{ 'sidebar-object-comment--windows': useWindowsSidebarCommentFont }">{{ columnComment }}</span>
          <span v-if="tableComment" class="sidebar-object-comment ml-auto max-w-[20%] shrink-0 truncate text-right" :class="{ 'sidebar-object-comment--windows': useWindowsSidebarCommentFont }">{{ tableComment }}</span>
          <span v-if="node.type === 'connection' && node.connectionId && connectionStore.connectedIds.has(node.connectionId)" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <span v-if="showsDatabaseOpenIndicator" class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <Badge v-if="isConnectionReadonly" variant="secondary" class="h-4 px-1.5 text-[10px] gap-0.5"><Lock class="w-2.5 h-2.5" />{{ t("connection.readOnlyBadge") }}</Badge>
          <ConnectionErrorIndicator v-if="node.type === 'connection'" :connection-id="node.connectionId" trigger-class="h-4 w-4" />
          <Pin v-if="isPinned" class="w-3 h-3 shrink-0 text-primary fill-current" aria-hidden="true" />
          <button
            v-if="isConnecting"
            type="button"
            class="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-secondary/45 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :aria-label="t('connection.cancelConnecting')"
            :title="t('connection.cancelConnecting')"
            @mousedown.stop
            @click.stop="cancelConnectionAttempt"
          >
            <X class="h-3 w-3" />
          </button>
          <button
            v-if="node.type === 'connection'"
            type="button"
            class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/55 opacity-0 transition-colors transition-opacity hover:bg-secondary/45 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/sidebar-row:opacity-100"
            :class="[{ 'opacity-100': isConnectionSelectionChecked || connectionStore.connectionMultiSelectActive }, isConnecting ? '' : 'ml-auto']"
            :aria-label="isConnectionSelectionChecked ? t('connectionGroup.deselectConnection') : t('connectionGroup.selectConnection')"
            @mousedown.stop
            @click="toggleConnectionMultiSelection"
          >
            <Check v-if="isConnectionSelectionChecked" class="h-3 w-3 text-primary" />
            <Square v-else class="h-3 w-3 stroke-[1.7]" />
          </button>
        </div>
        <template v-if="detailTooltip" #content>
          <div class="w-max min-w-40 max-w-[min(28rem,calc(100vw-24px))] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
            <div class="space-y-1">
              <div v-for="row in detailTooltip.rows" :key="row.label" class="grid grid-cols-[max-content_minmax(0,1fr)] gap-2 text-xs leading-5">
                <span class="text-muted-foreground">{{ row.label }}</span>
                <span v-if="row.multiline" class="max-h-20 overflow-hidden whitespace-pre-wrap break-words text-foreground/90">
                  {{ row.value }}
                </span>
                <span v-else class="truncate font-mono text-foreground/90" :title="row.value">{{ row.value }}</span>
              </div>
            </div>
          </div>
        </template>
      </LightTooltip>
    </div>
  </CustomContextMenu>

  <VisibleDatabasesDialog v-if="node.type === 'connection' && node.connectionId" v-model:open="showVisibleDatabasesDialog" :connection-id="node.connectionId" :connection-name="node.label" />

  <SchemaFilterDialog v-if="node.type === 'database' && node.connectionId && node.database != null" v-model:open="showVisibleSchemasDialog" :connection-id="node.connectionId" :connection-name="node.label" :database="node.database ?? ''" />

  <SchemaFilterDialog v-else-if="node.type === 'connection' && node.connectionId && canConfigureVisibleSchemas" v-model:open="showVisibleSchemasDialog" :connection-id="node.connectionId" :connection-name="node.label" :database="connectionStore.getConfig(node.connectionId)?.database || ''" />

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
          <Upload class="h-4 w-4" />
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

  <DangerConfirmDialog v-model:open="showDropTableConfirm" :title="t('contextMenu.confirmDropTableTitle')" :message="t('contextMenu.confirmDropTableMessage', { name: node.label })" :sql="dropTablePreviewSql" :confirm-label="t('contextMenu.dropTable')" @confirm="confirmDropTable">
    <template v-if="canDropTableCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="dropTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshDropTablePreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.dropTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.dropTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog v-model:open="showEmptyTableConfirm" :title="t('contextMenu.confirmEmptyTableTitle')" :message="t('contextMenu.confirmEmptyTableMessage', { name: node.label })" :sql="emptyTablePreviewSql" :confirm-label="t('contextMenu.emptyTable')" @confirm="confirmEmptyTable" />

  <DangerConfirmDialog v-model:open="showBatchEmptyConfirm" :title="batchEmptyConfirmTitle()" :message="batchEmptyConfirmMessage()" :sql="batchEmptyPreviewSql" :confirm-label="batchEmptyConfirmLabel()" @confirm="confirmBatchEmpty" />

  <DangerConfirmDialog
    v-model:open="showTruncateTableConfirm"
    :title="t('contextMenu.confirmTruncateTableTitle')"
    :message="t('contextMenu.confirmTruncateTableMessage', { name: node.label })"
    :sql="truncateTablePreviewSql"
    :confirm-label="t('contextMenu.truncateTable')"
    @confirm="confirmTruncateTable"
  >
    <template v-if="canTruncateTableCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="truncateTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshTruncateTablePreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.truncateTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.truncateTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog v-model:open="showDropObjectConfirm" :title="dropObjectConfirmTitle()" :message="dropObjectConfirmMessage()" :sql="dropObjectPreviewSql" :confirm-label="dropObjectMenuLabel()" @confirm="confirmDropObject" />

  <DangerConfirmDialog v-model:open="showDropTableChildObjectConfirm" :title="dropTableChildObjectConfirmTitle()" :message="dropTableChildObjectConfirmMessage()" :sql="dropTableChildObjectPreviewSql" :confirm-label="dropTableChildObjectMenuLabel()" @confirm="confirmDropTableChildObject" />

  <DangerConfirmDialog v-model:open="showBatchDropConfirm" :title="batchDropConfirmTitle()" :message="batchDropConfirmMessage()" :sql="batchDropPreviewSql" :confirm-label="batchDropMenuLabel()" @confirm="confirmBatchDrop">
    <template v-if="canBatchDropCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="batchDropCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshBatchDropPreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.dropTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.dropTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog v-model:open="showBatchTruncateConfirm" :title="batchTruncateConfirmTitle()" :message="batchTruncateConfirmMessage()" :sql="batchTruncatePreviewSql" :confirm-label="batchTruncateMenuLabel()" @confirm="confirmBatchTruncate">
    <template v-if="canBatchTruncateCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="batchTruncateCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshBatchTruncatePreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.truncateTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.truncateTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

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

  <Dialog v-model:open="showPasteDialog">
    <DialogContent class="sm:max-w-[500px]">
      <DialogHeader>
        <DialogTitle>{{ pasteTableEntries.length > 1 ? t("contextMenu.batchPasteTitle") : t("contextMenu.pasteTableConfirmTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-4">
        <div class="flex gap-2">
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="structure-and-data" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionStructureAndData") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer">
            <input v-model="pasteTableMode" type="radio" value="structure-only" class="accent-primary" />
            {{ t("contextMenu.pasteOptionStructureOnly") }}
          </label>
          <label class="flex items-center gap-1.5 text-sm cursor-pointer" :class="{ 'opacity-50 cursor-not-allowed': !pasteTableDataCopySupported }">
            <input v-model="pasteTableMode" type="radio" value="data-only" class="accent-primary" :disabled="!pasteTableDataCopySupported" />
            {{ t("contextMenu.pasteOptionDataOnly") }}
          </label>
        </div>
        <div class="space-y-2 max-h-64 overflow-y-auto">
          <div v-for="(entry, idx) in pasteTableEntries" :key="idx" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground truncate min-w-0 flex-shrink basis-1/3" :title="entry.sourceName">{{ entry.sourceName }}</span>
            <span class="text-xs text-muted-foreground flex-shrink-0">&rarr;</span>
            <Input v-model="entry.targetName" class="flex-1 h-8 text-sm" :placeholder="t('contextMenu.duplicateNamePlaceholder')" />
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showPasteDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="pasteTableEntries.every((e) => !e.targetName.trim())" @click="confirmPasteTable">{{ t("dangerDialog.confirm") }}</Button>
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
          <SearchableSelect
            :model-value="createDatabaseCharset"
            :options="createDatabaseCharsetOptions"
            :placeholder="t('contextMenu.createDatabaseCharsetPlaceholder')"
            :search-placeholder="t('contextMenu.createDatabaseCharsetSearchPlaceholder')"
            :empty-text="t('contextMenu.createDatabaseCharsetEmpty')"
            :loading-text="t('contextMenu.createDatabaseCharsetLoading')"
            :loading="createDatabaseCharsetLoading"
            :normalize-custom="normalizeCreateDatabaseCharset"
            allow-custom
            trigger-variant="outline"
            trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
            content-class="w-[var(--reka-popover-trigger-width)]"
            @update:model-value="updateCreateDatabaseCharset"
          >
            <template #custom-option-label="{ value }">
              <span class="truncate">{{ t("contextMenu.createDatabaseCharsetCustomOption", { value }) }}</span>
            </template>
          </SearchableSelect>
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCollation") }}</label>
          <SearchableSelect
            v-model="createDatabaseCollation"
            :options="createDatabaseCollationOptionsForCharset(createDatabaseCharset, createDatabaseCollationsByCharset)"
            :placeholder="t('contextMenu.createDatabaseCollationPlaceholder')"
            :search-placeholder="t('contextMenu.createDatabaseCollationSearchPlaceholder')"
            :empty-text="t('contextMenu.createDatabaseCollationEmpty')"
            :loading-text="t('contextMenu.createDatabaseCollationLoading')"
            :loading="createDatabaseCharsetLoading"
            :normalize-custom="normalizeCreateDatabaseCharset"
            allow-custom
            trigger-variant="outline"
            trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
            content-class="w-[var(--reka-popover-trigger-width)]"
          >
            <template #custom-option-label="{ value }">
              <span class="truncate">{{ t("contextMenu.createDatabaseCollationCustomOption", { value }) }}</span>
            </template>
          </SearchableSelect>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showCreateDatabaseDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createDatabaseName.trim()" @click="confirmCreateDatabase">{{ t("dangerDialog.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showEditDatabasePropertiesDialog">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.editDatabasePropertiesTitle", { name: node.label }) }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div v-if="canEditDatabaseCharsetCollation" class="grid gap-3">
          <div class="grid gap-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCharset") }}</label>
            <SearchableSelect
              :model-value="editDatabaseCharset"
              :options="createDatabaseCharsetOptions"
              :placeholder="t('contextMenu.createDatabaseCharsetPlaceholder')"
              :search-placeholder="t('contextMenu.createDatabaseCharsetSearchPlaceholder')"
              :empty-text="t('contextMenu.createDatabaseCharsetEmpty')"
              :loading-text="t('contextMenu.createDatabaseCharsetLoading')"
              :loading="createDatabaseCharsetLoading"
              :normalize-custom="normalizeCreateDatabaseCharset"
              allow-custom
              trigger-variant="outline"
              trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
              content-class="w-[var(--reka-popover-trigger-width)]"
              @update:model-value="updateEditDatabaseCharset"
            >
              <template #custom-option-label="{ value }">
                <span class="truncate">{{ t("contextMenu.createDatabaseCharsetCustomOption", { value }) }}</span>
              </template>
            </SearchableSelect>
          </div>
          <div class="grid gap-1.5">
            <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.createDatabaseCollation") }}</label>
            <SearchableSelect
              v-model="editDatabaseCollation"
              :options="createDatabaseCollationOptionsForCharset(editDatabaseCharset, createDatabaseCollationsByCharset)"
              :placeholder="t('contextMenu.createDatabaseCollationPlaceholder')"
              :search-placeholder="t('contextMenu.createDatabaseCollationSearchPlaceholder')"
              :empty-text="t('contextMenu.createDatabaseCollationEmpty')"
              :loading-text="t('contextMenu.createDatabaseCollationLoading')"
              :loading="createDatabaseCharsetLoading"
              :normalize-custom="normalizeCreateDatabaseCharset"
              allow-custom
              trigger-variant="outline"
              trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
              content-class="w-[var(--reka-popover-trigger-width)]"
            >
              <template #custom-option-label="{ value }">
                <span class="truncate">{{ t("contextMenu.createDatabaseCollationCustomOption", { value }) }}</span>
              </template>
            </SearchableSelect>
          </div>
        </div>
        <div v-if="canEditDatabaseComment" class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("contextMenu.editDatabaseComment") }}</label>
          <textarea
            v-model="editDatabaseCommentText"
            class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
            :placeholder="t('contextMenu.editDatabaseCommentPlaceholder')"
            :disabled="editDatabasePropertiesLoading"
            @keydown.meta.enter.prevent="confirmEditDatabaseProperties"
            @keydown.ctrl.enter.prevent="confirmEditDatabaseProperties"
          ></textarea>
        </div>
        <pre v-if="editDatabasePropertiesPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(editDatabasePropertiesPreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="editDatabasePropertiesLoading" @click="showEditDatabasePropertiesDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="editDatabasePropertiesLoading" @click="confirmEditDatabaseProperties">
          {{ editDatabasePropertiesLoading ? t("contextMenu.editDatabasePropertiesSaving") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateNacosNamespaceDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.createNamespace") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceId") }}</label>
          <Input v-model="createNacosNamespaceId" :placeholder="t('nacos.namespaceIdPlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceName") }}</label>
          <Input v-model="createNacosNamespaceName" :placeholder="t('nacos.namespaceNamePlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceDesc") }}</label>
          <Input v-model="createNacosNamespaceDesc" :placeholder="t('nacos.namespaceDescPlaceholder')" @keydown.enter.prevent="confirmCreateNacosNamespace" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="createNacosNamespaceLoading" @click="showCreateNacosNamespaceDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createNacosNamespaceName.trim() || createNacosNamespaceLoading" @click="confirmCreateNacosNamespace">
          {{ createNacosNamespaceLoading ? t("nacos.creatingNamespace") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showEditNacosNamespaceDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.editNamespace") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceName") }}</label>
          <Input v-model="editNacosNamespaceName" :placeholder="t('nacos.namespaceNamePlaceholder')" @keydown.enter.prevent="confirmEditNacosNamespace" />
        </div>
        <div class="grid gap-1.5">
          <label class="text-xs font-medium text-muted-foreground">{{ t("nacos.namespaceDesc") }}</label>
          <Input v-model="editNacosNamespaceDesc" :placeholder="t('nacos.namespaceDescPlaceholder')" @keydown.enter.prevent="confirmEditNacosNamespace" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="editNacosNamespaceLoading" @click="showEditNacosNamespaceDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!editNacosNamespaceName.trim() || editNacosNamespaceLoading" @click="confirmEditNacosNamespace">
          {{ editNacosNamespaceLoading ? t("nacos.updatingNamespace") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showDropDatabaseConfirm"
    :title="t('contextMenu.confirmDropDatabaseTitle')"
    :message="t('contextMenu.confirmDropDatabaseMessage', { name: node.label })"
    :sql="dropDatabasePreviewSql"
    :confirm-label="t('contextMenu.dropDatabase')"
    :loading="dropDatabaseLoading"
    :close-on-confirm="false"
    @confirm="confirmDropDatabase"
  />

  <DangerConfirmDialog
    v-model:open="showDropMongoCollectionConfirm"
    :title="t('contextMenu.confirmDropCollectionTitle')"
    :message="t('contextMenu.confirmDropCollectionMessage', { name: node.label })"
    :confirm-label="t('contextMenu.dropCollection')"
    :loading="dropMongoCollectionLoading"
    :close-on-confirm="false"
    @confirm="confirmDropMongoCollection"
  />

  <DangerConfirmDialog
    v-model:open="showDropMongoIndexConfirm"
    :title="t('contextMenu.confirmDropIndexTitle')"
    :message="t('contextMenu.confirmDropMongoIndexMessage', { name: mongoIndexNameForNode(node), collection: node.tableName || '' })"
    :details="mongoIndexDropPreview(node, mongoIndexNameForNode(node))"
    :confirm-label="t('contextMenu.dropIndex')"
    :loading="dropMongoIndexLoading"
    :close-on-confirm="false"
    @confirm="confirmDropMongoIndex"
  />

  <DangerConfirmDialog
    v-model:open="showDropAllMongoIndexesConfirm"
    :title="t('contextMenu.dropAllIndexes')"
    :message="t('contextMenu.confirmDropMongoAllIndexesMessage', { name: node.label })"
    :details-text="t('contextMenu.confirmDropMongoAllIndexesDetails')"
    :sql="mongoDropAllIndexesPreview(node)"
    :confirm-label="t('contextMenu.dropAllIndexes')"
    :loading="dropAllMongoIndexesLoading"
    :close-on-confirm="false"
    @confirm="confirmDropAllMongoIndexes"
  />

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

  <Dialog v-model:open="showEditSchemaCommentDialog">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.editSchemaCommentTitle", { name: node.label }) }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <textarea
          v-model="schemaCommentText"
          class="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-ring focus:ring-1 focus:ring-ring/40"
          :placeholder="t('contextMenu.schemaCommentPlaceholder')"
          :disabled="schemaCommentLoading"
          @keydown.meta.enter.prevent="confirmEditSchemaComment"
          @keydown.ctrl.enter.prevent="confirmEditSchemaComment"
        ></textarea>
        <pre v-if="schemaCommentPreviewSql" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(schemaCommentPreviewSql)"></pre>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="schemaCommentLoading" @click="showEditSchemaCommentDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="schemaCommentLoading" @click="confirmEditSchemaComment">
          {{ schemaCommentLoading ? t("contextMenu.schemaCommentSaving") : t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog v-model:open="showDropSchemaConfirm" :title="t('contextMenu.confirmDropSchemaTitle')" :message="t('contextMenu.confirmDropSchemaMessage', { name: node.label })" :sql="dropSchemaPreviewSql" :confirm-label="t('contextMenu.dropSchema')" @confirm="confirmDropSchema" />

  <DdlViewDialog
    v-if="ddlTarget"
    :connection-id="ddlTarget.connectionId!"
    :database="ddlTarget.database!"
    :schema="ddlTarget.schema"
    :table-name="ddlTarget.label"
    :object-type="tableDdlObjectTypeForNode(ddlTarget.type)"
    :dialect="ddlDialect"
    :format-dialect="ddlFormatDialect"
    v-model:open="showDdlDialog"
  />

  <ObjectSourceDialog
    v-if="objectSourceTarget && objectSourceType"
    v-model:open="showObjectSourceDialog"
    :connection-id="objectSourceTarget.node.connectionId!"
    :database="objectSourceTarget.node.database!"
    :schema="objectSourceTarget.node.schema"
    :name="objectSourceTarget.node.label"
    :object-type="objectSourceType"
    :database-type="objectSourceDatabaseType"
    :dialect="objectSourceDialect"
    :format-dialect="objectSourceFormatDialect"
    :initial-editing="objectSourceTarget.initialEditing"
    @saved="refresh"
  />

  <InstallExtensionDialog ref="installExtensionDialogRef" :node="node" @close="refresh" />
</template>

<style>
.sidebar-object-comment {
  color: var(--muted-foreground);
  font-size: 10px;
  line-height: 1rem;
  opacity: 0.6;
  /* Sidebar rows repaint on hover; avoid heavier font shaping and fallback here. */
  text-rendering: auto;
}

.sidebar-object-comment--windows {
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif;
  font-size: 12px;
  font-weight: 500;
  opacity: 1;
}

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

.tree-item-connection-tint.tree-item-active--selection-set:focus::before {
  background-color: var(--tree-connection-active-bg, var(--tree-connection-row-bg));
}

.tree-table-search-control {
  position: relative;
  isolation: isolate;
  background-color: transparent;
}

.tree-table-search-control::before {
  content: "";
  position: absolute;
  inset: 0 -9999px;
  z-index: 0;
  background-color: var(--tree-table-search-row-bg);
  pointer-events: none;
}

.tree-table-search-control > * {
  position: relative;
  z-index: 1;
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

/* Multi-selection treats every selected row as equal; keep focus neutral. */
.tree-item-active--selection-set:focus {
  background-color: var(--tree-connection-active-bg, rgb(235 235 235)) !important;
  box-shadow: inset 0 0 0 1px hsl(var(--foreground) / 0.14);
}
:root.dark .tree-item-active--selection-set:focus {
  background-color: var(--tree-connection-active-bg, rgb(36 36 36)) !important;
  box-shadow: inset 0 0 0 1px hsl(var(--foreground) / 0.18);
}

/* Locate highlight: instant amber, then fade on removal */
.tree-item-highlight {
  background-color: rgb(253 225 167) !important;
  background-color: oklch(0.92 0.08 85) !important;
  transition: background-color 0.28s ease-out;
}

:root.dark .tree-item-highlight {
  background-color: rgb(110 67 0) !important;
  background-color: oklch(0.42 0.12 80) !important;
  transition: background-color 0.28s ease-out;
}

.tree-item-connection-tint.tree-item-highlight::before {
  background-color: rgb(253 225 167) !important;
  background-color: oklch(0.92 0.08 85) !important;
}

:root.dark .tree-item-connection-tint.tree-item-highlight::before {
  background-color: rgb(110 67 0) !important;
  background-color: oklch(0.42 0.12 80) !important;
}
</style>
