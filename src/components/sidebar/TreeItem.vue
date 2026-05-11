<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
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
  Plug,
  Unplug,
  Pin,
  ArrowRightLeft,
  Download,
  FileCode,
  Network,
  FileUp,
  PencilRuler,
  Search,
  FolderInput,
  FolderPlus,
  Eraser,
  Scissors,
  CopyPlus,
  Plus,
  FileText,
} from "lucide-vue-next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useToast } from "@/composables/useToast";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import type { DatabaseType, QueryResult, TreeNode, TreeNodeType } from "@/types/database";
import * as api from "@/lib/api";
import { uuid } from "@/lib/utils";
import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import { canTreeNodeShowExpander, treeItemPaddingLeft } from "@/lib/sidebarTreeItemLayout";
import {
  DATABASE_EXPORT_PAGE_SIZE,
  DATABASE_EXPORT_ROW_LIMIT,
  buildDatabaseSqlExport,
  buildExportPageSql,
  type ExportedTableSql,
} from "@/lib/databaseExport";
import {
  buildTableSelectSql,
  qualifiedTableName as buildQualifiedTableName,
  quoteTableIdentifier,
} from "@/lib/tableSelectSql";
import { editablePrimaryKeys, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import {
  SQL_FILE_UNSUPPORTED_TYPES,
  DIAGRAM_SUPPORTED_TYPES,
  DATABASE_SEARCH_SUPPORTED_TYPES,
  TABLE_IMPORT_SUPPORTED_TYPES,
  TABLE_STRUCTURE_SUPPORTED_TYPES,
  FIELD_LINEAGE_SUPPORTED_TYPES,
  TREE_SCHEMA_TYPES,
  PG_LIKE_STRUCTURE_TYPES,
  CREATE_DATABASE_SUPPORTED_TYPES,
  isSchemaAware,
  usesFetchFirst,
} from "@/lib/databaseCapabilities";
import { treeNodeRowAction, treeNodeRowDoubleClickAction } from "@/lib/treeNodeClick";
import { formatCsv, formatJson, formatSqlInsert } from "@/lib/exportFormats";
import { hexToRgba } from "@/lib/color";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionErrorIndicator from "@/components/connection/ConnectionErrorIndicator.vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const savedSqlStore = useSavedSqlStore();
const { toast } = useToast();
const { getDatabaseOptions } = useDatabaseOptions();

const props = defineProps<{
  node: TreeNode;
  depth: number;
  dragDisabled?: boolean;
  pendingRename?: boolean;
}>();

const emit = defineEmits<{
  "rename-started": [];
  "search-toggle": [node: TreeNode];
}>();

const isExportingDatabase = ref(false);

function currentDatabaseType(): DatabaseType | undefined {
  return props.node.connectionId ? connectionStore.getConfig(props.node.connectionId)?.db_type : undefined;
}

function quoteIdent(name: string): string {
  return quoteTableIdentifier(currentDatabaseType(), name);
}

function qualifiedTableName(tableName: string, schema?: string): string {
  return buildQualifiedTableName({
    databaseType: currentDatabaseType(),
    schema,
    tableName,
  });
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "database";
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
      return { icon: Columns3, colorClass: "text-muted-foreground" };
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
    case "saved-sql-root":
      return { icon: FolderOpen, colorClass: "text-blue-500" };
    case "saved-sql-folder":
      return { icon: node.isExpanded ? FolderOpen : FolderClosed, colorClass: "text-blue-400" };
    case "saved-sql-file":
      return { icon: FileText, colorClass: "text-blue-300" };
    case "index":
      return { icon: Key, colorClass: "text-amber-400" };
    case "fkey":
      return { icon: Link, colorClass: "text-blue-300" };
    case "trigger":
      return { icon: Zap, colorClass: "text-orange-300" };
    case "redis-db":
      return { icon: Database, colorClass: "text-red-400" };
    case "mongo-db":
      return { icon: Database, colorClass: "text-yellow-500" };
    case "mongo-collection":
      return { icon: Table, colorClass: "text-green-400" };
    default:
      return { icon: Database, colorClass: "text-muted-foreground" };
  }
}

const groupTypes: Set<TreeNodeType> = new Set([
  "group-columns",
  "group-indexes",
  "group-fkeys",
  "group-triggers",
  "saved-sql-root",
  "saved-sql-folder",
]);
const pinnableTypes: Set<TreeNodeType> = new Set([
  "connection-group",
  "database",
  "schema",
  "table",
  "view",
  "redis-db",
  "mongo-db",
  "mongo-collection",
]);

function isGroupLabel(node: TreeNode): boolean {
  return groupTypes.has(node.type);
}

function displayLabel(node: TreeNode): string {
  if (node.type === "object-browser") return t(node.label, { count: node.objectCount ?? 0 });
  return isGroupLabel(node) ? t(node.label) : node.label;
}

async function toggle() {
  const node = props.node;
  if (node.isLoading) return;
  emit("search-toggle", node);
  const wasExpanded = !!node.isExpanded;

  if (node.type === "connection-group") {
    node.isExpanded = !node.isExpanded;
    connectionStore.toggleConnectionGroupCollapsed(node.id);
    return;
  }

  if (node.type === "saved-sql-root" || node.type === "saved-sql-folder") {
    node.isExpanded = !node.isExpanded;
    return;
  }

  if (node.isExpanded) {
    node.isExpanded = false;
    return;
  }

  try {
    if (node.type === "connection" && node.connectionId) {
      const config = connectionStore.getConfig(node.connectionId);
      if (config?.db_type === "redis") {
        await connectionStore.loadRedisDatabases(node.connectionId);
      } else if (config?.db_type === "mongodb" || config?.db_type === "elasticsearch") {
        await connectionStore.loadMongoDatabases(node.connectionId);
      } else {
        await connectionStore.loadDatabases(node.connectionId);
      }
    } else if (node.type === "redis-db" && node.connectionId && node.database) {
      const tabTitle = `${connectionStore.getConfig(node.connectionId)?.name || "Redis"}:db${node.database}`;
      queryStore.createTab(node.connectionId, node.database, tabTitle, "redis");
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await connectionStore.loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "mongo-collection" && node.connectionId && node.database) {
      const tabTitle = `${node.database}.${node.label}`;
      const tab = queryStore.createTab(node.connectionId, node.database, tabTitle, "mongo");
      queryStore.updateSql(tab, node.label);
    } else if (node.type === "database" && node.connectionId && node.database) {
      const config = connectionStore.getConfig(node.connectionId);
      if (config?.db_type === "sqlserver") {
        await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, node.database);
      } else if (config?.db_type && TREE_SCHEMA_TYPES.has(config.db_type)) {
        await connectionStore.loadSchemas(node.connectionId, node.database);
      } else {
        await connectionStore.loadTables(node.connectionId, node.database);
      }
    } else if (node.type === "schema" && node.connectionId && node.database && node.schema) {
      await connectionStore.loadTables(node.connectionId, node.database, node.schema);
    } else if ((node.type === "table" || node.type === "view") && node.connectionId && node.database) {
      await connectionStore.loadTableGroups(node.connectionId, node.database, node.label, node.schema);
    } else if (node.type === "group-columns" && node.connectionId && node.database && node.tableName) {
      await connectionStore.loadColumns(node.connectionId, node.database, node.tableName, node.schema);
    } else if (node.type === "group-indexes" && node.connectionId && node.database && node.tableName) {
      await connectionStore.loadIndexes(node.connectionId, node.database, node.tableName, node.schema);
    } else if (node.type === "group-fkeys" && node.connectionId && node.database && node.tableName) {
      await connectionStore.loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema);
    } else if (node.type === "group-triggers" && node.connectionId && node.database && node.tableName) {
      await connectionStore.loadTriggers(node.connectionId, node.database, node.tableName, node.schema);
    }
  } catch (e: any) {
    if (!wasExpanded) node.isExpanded = false;
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
  }
}

function runRowClickAction() {
  const node = props.node;
  if (node.type === "object-browser") {
    void openObjectBrowser();
    return;
  }
  const action = treeNodeRowAction(node.type, canExpand.value);
  if (action === "open-data") {
    openData();
  } else if (node.type === "saved-sql-file") {
    openSavedSqlFile();
  } else if (action === "toggle") {
    toggle();
  }
}

function onClick(event: MouseEvent) {
  if (event.detail > 1) return;
  runRowClickAction();
}

function onDoubleClick() {
  const action = treeNodeRowDoubleClickAction(props.node.type, canOpenObjectBrowser.value);
  if (action === "open-object-browser") {
    void openObjectBrowser();
  }
}

async function openObjectBrowser() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    connectionStore.activeConnectionId = node.connectionId;

    if (node.database) {
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
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
  }
}

function openSavedSqlFile() {
  const id = props.node.savedSqlId;
  if (!id) return;
  const file = savedSqlStore.getFile(id);
  if (!file) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
}

async function openData() {
  const node = props.node;
  if (!(node.type === "table" || node.type === "view") || !node.connectionId || !node.database) return;
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
  const tabId = queryStore.createTab(node.connectionId, node.database, node.label, "data");
  console.info("[DBX][openData:tab-created]", { traceId, tabId, elapsed: elapsed() });
  queryStore.setExecuting(tabId, true);

  try {
    console.info("[DBX][openData:ensure-connected:start]", { traceId, elapsed: elapsed() });
    await connectionStore.ensureConnected(node.connectionId);
    console.info("[DBX][openData:ensure-connected:done]", { traceId, elapsed: elapsed() });
    if (!config) throw new Error("Connection config not found");

    const querySchema = node.schema || node.database;
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
    const pks = editablePrimaryKeys(config.db_type, columns);
    const sql = buildTableSelectSql({
      databaseType: config.db_type,
      schema: node.schema,
      tableName: node.label,
      primaryKeys: pks,
      includeRowId: usesSyntheticRowIdKey(config.db_type, pks),
    });
    console.info("[DBX][openData:sql-built]", {
      traceId,
      primaryKeys: pks,
      includeRowId: usesSyntheticRowIdKey(config.db_type, pks),
      sql,
      elapsed: elapsed(),
    });
    queryStore.updateSql(tabId, sql);
    queryStore.setTableMeta(tabId, {
      schema: node.schema,
      tableName: node.label,
      columns,
      primaryKeys: pks,
    });

    console.info("[DBX][openData:execute:start]", { traceId, tabId, elapsed: elapsed() });
    await queryStore.executeTabSql(tabId, sql);
    console.info("[DBX][openData:execute:done]", { traceId, tabId, elapsed: elapsed() });
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
    if (node.database) {
      queryStore.createTab(node.connectionId, node.database, undefined, "query");
      return;
    }
    const connection = connectionStore.getConfig(node.connectionId);
    if (!connection) return;
    const options = await getDatabaseOptions(node.connectionId);
    queryStore.createTab(node.connectionId, resolveDefaultDatabase(connection, options), undefined, "query");
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
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
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
  }
}

const showDeleteConfirm = ref(false);

function deleteConnection() {
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  const node = props.node;
  if (node.connectionId) {
    try {
      await connectionStore.disconnect(node.connectionId);
      await connectionStore.removeConnection(node.connectionId);
    } catch (e: any) {
      toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
    }
  }
}

function copyName() {
  navigator.clipboard.writeText(props.node.label);
}

async function duplicateConnection() {
  const connId = props.node.connectionId;
  if (!connId) return;
  const config = connectionStore.getConfig(connId);
  if (!config) return;
  const newConfig = { ...config, id: uuid(), name: `${config.name} (Copy)` };
  await connectionStore.addConnection(newConfig);
}

// --- Table Management Operations ---
const showDropTableConfirm = ref(false);
const showEmptyTableConfirm = ref(false);
const showTruncateTableConfirm = ref(false);
const showDuplicateDialog = ref(false);
const duplicateTableName = ref("");

const showCreateDatabaseDialog = ref(false);
const createDatabaseName = ref("");
const showDropDatabaseConfirm = ref(false);
const showCreateSchemaDialog = ref(false);
const createSchemaName = ref("");
const showDropSchemaConfirm = ref(false);

const isTableNotView = computed(() => props.node.type === "table");

const supportsTruncate = computed(() => {
  const dbType = currentDatabaseType();
  return dbType !== "sqlite" && dbType !== "duckdb";
});

const canCreateTable = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return (
    (props.node.type === "database" || props.node.type === "schema") &&
    !!props.node.database &&
    !!config &&
    TABLE_STRUCTURE_SUPPORTED_TYPES.has(config.db_type)
  );
});

const canCreateDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "connection" && !!config && CREATE_DATABASE_SUPPORTED_TYPES.has(config.db_type);
});

const canDropDatabase = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "database" && !!config && CREATE_DATABASE_SUPPORTED_TYPES.has(config.db_type);
});

const canCreateSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "database" && !!config && TREE_SCHEMA_TYPES.has(config.db_type);
});

const canDropSchema = computed(() => {
  const config = props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined;
  return props.node.type === "schema" && !!config && TREE_SCHEMA_TYPES.has(config.db_type);
});

function buildDropTableSql(): string {
  return `DROP TABLE ${qualifiedTableName(props.node.label, props.node.schema)};`;
}

function buildEmptyTableSql(): string {
  return `DELETE FROM ${qualifiedTableName(props.node.label, props.node.schema)};`;
}

function buildTruncateTableSql(): string {
  const dbType = currentDatabaseType();
  const name = qualifiedTableName(props.node.label, props.node.schema);
  if (dbType === "sqlite" || dbType === "duckdb") return `DELETE FROM ${name};`;
  return `TRUNCATE TABLE ${name};`;
}

function dropTable() {
  showDropTableConfirm.value = true;
}

async function refreshTableList(node: TreeNode) {
  if (!node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  if (config?.db_type === "sqlserver" && node.schema?.toLowerCase() === "dbo") {
    await connectionStore.loadSqlServerDatabaseObjects(node.connectionId, node.database, { force: true });
  } else if (node.schema) {
    await connectionStore.loadTables(node.connectionId, node.database, node.schema, { force: true });
  } else {
    await connectionStore.loadTables(node.connectionId, node.database, undefined, { force: true });
  }
}

async function confirmDropTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.executeQuery(node.connectionId, node.database, buildDropTableSql(), node.schema);
    toast(t("contextMenu.dropTableSuccess", { name: node.label }), 3000);
    await refreshTableList(node);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function emptyTable() {
  showEmptyTableConfirm.value = true;
}

async function confirmEmptyTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.executeQuery(node.connectionId, node.database, buildEmptyTableSql(), node.schema);
    toast(t("contextMenu.emptyTableSuccess", { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function truncateTable() {
  showTruncateTableConfirm.value = true;
}

async function confirmTruncateTable() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.executeQuery(node.connectionId, node.database, buildTruncateTableSql(), node.schema);
    toast(t("contextMenu.truncateTableSuccess", { name: node.label }), 3000);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function buildDropDatabaseSql(): string {
  return `DROP DATABASE ${quoteIdent(props.node.label)};`;
}

function buildDropSchemaSql(): string {
  const dbType = currentDatabaseType();
  const name = quoteIdent(props.node.label);
  if (dbType === "postgres" || dbType === "gaussdb") return `DROP SCHEMA ${name} CASCADE;`;
  return `DROP SCHEMA ${name};`;
}

function openCreateDatabaseDialog() {
  createDatabaseName.value = "";
  showCreateDatabaseDialog.value = true;
}

async function confirmCreateDatabase() {
  const node = props.node;
  const name = createDatabaseName.value.trim();
  if (!name || !node.connectionId) return;
  showCreateDatabaseDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const sql = `CREATE DATABASE ${quoteIdent(name)};`;
    await api.executeQuery(node.connectionId, "", sql);
    toast(t("contextMenu.createDatabaseSuccess", { name }), 3000);
    await connectionStore.loadDatabases(node.connectionId, { force: true });
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function dropDatabase() {
  showDropDatabaseConfirm.value = true;
}

async function confirmDropDatabase() {
  const node = props.node;
  if (!node.connectionId) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.executeQuery(node.connectionId, "", buildDropDatabaseSql());
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
    const sql = `CREATE SCHEMA ${quoteIdent(name)};`;
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
  showDropSchemaConfirm.value = true;
}

async function confirmDropSchema() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    await api.executeQuery(node.connectionId, node.database, buildDropSchemaSql());
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

function duplicateStructure() {
  duplicateTableName.value = `${props.node.label}_copy`;
  showDuplicateDialog.value = true;
}

async function confirmDuplicateStructure() {
  const node = props.node;
  const newName = duplicateTableName.value.trim();
  if (!newName || !node.connectionId || !node.database) return;
  showDuplicateDialog.value = false;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const dbType = currentDatabaseType();
    const source = qualifiedTableName(node.label, node.schema);
    const target = qualifiedTableName(newName, node.schema);
    let sql: string;
    if (dbType === "mysql") {
      sql = `CREATE TABLE ${target} LIKE ${source};`;
    } else if (dbType && PG_LIKE_STRUCTURE_TYPES.has(dbType)) {
      sql = `CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL);`;
    } else if (dbType === "sqlserver") {
      sql = `SELECT TOP 0 * INTO ${target} FROM ${source};`;
    } else if (usesFetchFirst(dbType)) {
      sql = `CREATE TABLE ${target} AS SELECT * FROM ${source} WHERE 1=0`;
    } else {
      sql = `CREATE TABLE ${target} AS SELECT * FROM ${source} WHERE 0;`;
    }
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
  connectionStore.structureEditorSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: "",
  };
}

async function collectDatabaseExportTables(): Promise<Array<{ schema?: string; name: string; displayName: string }>> {
  const node = props.node;
  if (!node.connectionId || !node.database) return [];

  const config = connectionStore.getConfig(node.connectionId);
  if (node.type === "schema" && node.schema) {
    const tables = await api.listTables(node.connectionId, node.database, node.schema);
    return tables.map((table) => ({
      schema: node.schema,
      name: table.name,
      displayName: `${node.schema}.${table.name}`,
    }));
  }

  if (isSchemaAware(config?.db_type)) {
    const schemas = await api.listSchemas(node.connectionId, node.database);
    const groups = await Promise.all(
      schemas.map(async (schema) => {
        const tables = await api.listTables(node.connectionId!, node.database!, schema);
        return tables.map((table) => ({
          schema,
          name: table.name,
          displayName: `${schema}.${table.name}`,
        }));
      }),
    );
    return groups.flat();
  }

  const tables = await api.listTables(node.connectionId, node.database, node.database);
  return tables.map((table) => ({
    name: table.name,
    displayName: table.name,
  }));
}

async function fetchExportTableRows(
  connectionId: string,
  database: string,
  table: { schema?: string; name: string },
  databaseType?: DatabaseType,
): Promise<{ columns: QueryResult["columns"]; rows: QueryResult["rows"]; truncated: boolean }> {
  const rows: QueryResult["rows"] = [];
  let columns: QueryResult["columns"] = [];
  let offset = 0;

  while (rows.length < DATABASE_EXPORT_ROW_LIMIT) {
    const remaining = DATABASE_EXPORT_ROW_LIMIT - rows.length;
    const limit =
      databaseType === "sqlserver" ? DATABASE_EXPORT_ROW_LIMIT : Math.min(DATABASE_EXPORT_PAGE_SIZE, remaining);
    const sql = buildExportPageSql({
      databaseType,
      schema: table.schema,
      tableName: table.name,
      limit,
      offset: databaseType === "sqlserver" ? undefined : offset,
    });
    const result = await api.executeQuery(connectionId, database, sql);
    if (columns.length === 0) columns = result.columns;
    rows.push(...result.rows);

    if (result.rows.length < limit || databaseType === "sqlserver") break;
    offset += result.rows.length;
  }

  return {
    columns,
    rows,
    truncated: rows.length >= DATABASE_EXPORT_ROW_LIMIT,
  };
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

async function saveBinaryFileContent(
  content: Uint8Array,
  defaultFileName: string,
  filterName: string,
  filterExt: string,
) {
  if (isTauriRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({
      defaultPath: defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    if (path) await writeFile(path, content);
  } else {
    const blob = new Blob([content], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = defaultFileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function exportDatabase() {
  const node = props.node;
  if (!(node.type === "database" || node.type === "schema") || !node.connectionId || !node.database) return;

  isExportingDatabase.value = true;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const config = connectionStore.getConfig(node.connectionId);
    const tables = await collectDatabaseExportTables();
    const exportedTables: ExportedTableSql[] = [];

    for (const table of tables) {
      const querySchema = table.schema || node.database;
      const qualifiedName = qualifiedTableName(table.name, table.schema);
      const ddl = await api.getTableDdl(node.connectionId, node.database, querySchema, table.name);
      const result = await fetchExportTableRows(node.connectionId, node.database, table, config?.db_type);
      exportedTables.push({
        displayName: table.displayName,
        qualifiedTableName: qualifiedName,
        ddl,
        columns: result.columns,
        rows: result.rows,
        truncated: result.truncated,
      });
    }

    const scopeName = node.type === "schema" && node.schema ? `${node.database}.${node.schema}` : node.database;
    const content = buildDatabaseSqlExport({
      databaseName: scopeName,
      tables: exportedTables,
      quoteIdentifier: quoteIdent,
      rowLimitPerTable: DATABASE_EXPORT_ROW_LIMIT,
    });

    await saveFileContent(content, `${safeFileName(scopeName)}.sql`, "SQL", "sql");
    toast(
      t("contextMenu.exportDatabaseSuccess", {
        count: exportedTables.length,
        limit: DATABASE_EXPORT_ROW_LIMIT,
      }),
      3000,
    );
  } catch (e: any) {
    console.error("Export database failed:", e);
    toast(t("contextMenu.exportDatabaseFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    isExportingDatabase.value = false;
  }
}

async function exportStructure() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  try {
    await connectionStore.ensureConnected(node.connectionId);
    const ddl = await api.getTableDdl(node.connectionId, node.database, node.schema || node.database, node.label);
    await saveFileContent(ddl + "\n", `${node.label}.sql`, "SQL", "sql");
  } catch (e: any) {
    console.error("Export structure failed:", e);
  }
}

async function exportData(format: "csv" | "json" | "sql") {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return;

  try {
    await connectionStore.ensureConnected(node.connectionId);
    const qualifiedName =
      isSchemaAware(config.db_type) && node.schema
        ? `${quoteIdent(node.schema)}.${quoteIdent(node.label)}`
        : quoteIdent(node.label);
    const result = await api.executeQuery(node.connectionId, node.database, `SELECT * FROM ${qualifiedName}`);

    let content: string;
    let ext: string;

    if (format === "csv") {
      ext = "csv";
      content = formatCsv(result.columns, result.rows);
    } else if (format === "json") {
      ext = "json";
      content = formatJson(result.columns, result.rows);
    } else {
      ext = "sql";
      content = formatSqlInsert(qualifiedName, result.columns, result.rows, quoteIdent);
    }

    await saveFileContent(content, `${node.label}.${ext}`, ext.toUpperCase(), ext);
    toast(result.truncated ? t("grid.exported") + " (truncated)" : t("grid.exported"));
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportDataXlsx() {
  const node = props.node;
  if (!node.connectionId || !node.database) return;
  const config = connectionStore.getConfig(node.connectionId);
  if (!config) return;

  try {
    await connectionStore.ensureConnected(node.connectionId);
    const qualifiedName =
      isSchemaAware(config.db_type) && node.schema
        ? `${quoteIdent(node.schema)}.${quoteIdent(node.label)}`
        : quoteIdent(node.label);
    const result = await api.executeQuery(node.connectionId, node.database, `SELECT * FROM ${qualifiedName}`);

    const { buildXlsxWorkbook } = await import("@/lib/xlsxExport");
    const workbook = buildXlsxWorkbook({
      sheetName: node.label,
      columns: result.columns,
      rows: result.rows,
    });
    await saveBinaryFileContent(workbook, `${node.label}.xlsx`, "Excel", "xlsx");
    toast(result.truncated ? t("grid.exported") + " (truncated)" : t("grid.exported"));
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function editConnection() {
  if (props.node.connectionId) {
    connectionStore.startEditing(props.node.connectionId);
  }
}

function disconnectConnection() {
  if (props.node.connectionId) {
    connectionStore.disconnect(props.node.connectionId);
    props.node.isExpanded = false;
    props.node.children = [];
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
  connectionStore.structureEditorSource = {
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    tableName: node.label,
  };
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
const nodeConfig = computed(() =>
  props.node.connectionId ? connectionStore.getConfig(props.node.connectionId) : undefined,
);
const canPin = computed(() => pinnableTypes.has(props.node.type));
const canOpenSqlFileExecution = computed(() => {
  return !!nodeConfig.value && !SQL_FILE_UNSUPPORTED_TYPES.has(nodeConfig.value.db_type);
});
const canOpenDiagram = computed(() => {
  return !!props.node.database && !!nodeConfig.value && DIAGRAM_SUPPORTED_TYPES.has(nodeConfig.value.db_type);
});
const canOpenDatabaseSearch = computed(() => {
  return !!props.node.database && !!nodeConfig.value && DATABASE_SEARCH_SUPPORTED_TYPES.has(nodeConfig.value.db_type);
});
const canOpenObjectBrowser = computed(() => {
  return (
    (props.node.type === "database" || props.node.type === "schema" || props.node.type === "object-browser") &&
    !!nodeConfig.value &&
    nodeConfig.value.db_type !== "redis" &&
    nodeConfig.value.db_type !== "mongodb" &&
    nodeConfig.value.db_type !== "elasticsearch"
  );
});
const canOpenTableImport = computed(() => {
  return (
    props.node.type === "table" &&
    !!props.node.database &&
    !!nodeConfig.value &&
    TABLE_IMPORT_SUPPORTED_TYPES.has(nodeConfig.value.db_type)
  );
});
const canOpenStructureEditor = computed(() => {
  return (
    props.node.type === "table" &&
    !!props.node.database &&
    !!nodeConfig.value &&
    TABLE_STRUCTURE_SUPPORTED_TYPES.has(nodeConfig.value.db_type)
  );
});
const canOpenFieldLineage = computed(() => {
  return (
    props.node.type === "column" &&
    !!props.node.database &&
    !!props.node.tableName &&
    !!nodeConfig.value &&
    FIELD_LINEAGE_SUPPORTED_TYPES.has(nodeConfig.value.db_type)
  );
});
const isPinned = computed(() => props.node.pinned || connectionStore.isTreeNodePinned(props.node.id));
const isNodeDefaultDatabase = computed(
  () =>
    (props.node.type === "database" || props.node.type === "redis-db" || props.node.type === "mongo-db") &&
    !!props.node.connectionId &&
    !!props.node.database &&
    connectionStore.isDefaultDatabase(props.node.connectionId, props.node.database),
);
const hasTypeMenu = computed(() => {
  const t = props.node.type;
  return (
    t === "connection" ||
    t === "database" ||
    t === "schema" ||
    t === "table" ||
    t === "view" ||
    t === "column" ||
    t === "saved-sql-root" ||
    t === "saved-sql-folder" ||
    t === "saved-sql-file" ||
    isGroupLabel(props.node)
  );
});
const columnComment = computed(() =>
  props.node.type === "column" && props.node.meta && "comment" in props.node.meta
    ? (props.node.meta as any).comment
    : null,
);
const paddingLeft = computed(() => treeItemPaddingLeft(props.depth));
const isConnected = computed(
  () =>
    props.node.type === "connection" &&
    !!props.node.connectionId &&
    connectionStore.connectedIds.has(props.node.connectionId),
);

function connectionIconType(connectionId?: string) {
  const config = connectionId ? connectionStore.getConfig(connectionId) : undefined;
  return config?.driver_profile || config?.db_type || "postgres";
}

const connectionColor = computed(() => {
  const connectionId = props.node.connectionId;
  return connectionId ? connectionStore.getConfig(connectionId)?.color || "" : "";
});
const isActiveConnectionScope = computed(
  () => !!props.node.connectionId && connectionStore.activeConnectionId === props.node.connectionId,
);
const rowStyle = computed(() => {
  const color = connectionColor.value;
  return {
    paddingLeft: paddingLeft.value,
    backgroundColor: hexToRgba(color, isActiveConnectionScope.value ? 0.14 : 0.08),
  };
});

function togglePin() {
  connectionStore.toggleTreeNodePin(props.node.id);
}

// --- Connection Group Management ---
const isRenamingGroup = ref(false);
const renameInput = ref("");

function startRenameGroup() {
  renameInput.value = props.node.label;
  isRenamingGroup.value = true;
  emit("rename-started");
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
  isRenamingGroup.value = false;
  const trimmed = renameInput.value.trim();
  if (!trimmed) {
    connectionStore.deleteConnectionGroup(props.node.id);
    return;
  }
  if (trimmed !== props.node.label) {
    connectionStore.renameConnectionGroup(props.node.id, trimmed);
  }
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

// --- Saved SQL Library ---
const showSavedSqlNameDialog = ref(false);
const savedSqlNameMode = ref<"folder-create" | "folder-rename" | "file-rename" | null>(null);
const savedSqlNameInput = ref("");
const showDeleteSavedSqlFileConfirm = ref(false);
const showDeleteSavedSqlFolderConfirm = ref(false);

function openCreateSavedSqlFolder() {
  savedSqlNameMode.value = "folder-create";
  savedSqlNameInput.value = t("savedSql.newFolderDefault");
  showSavedSqlNameDialog.value = true;
}

function openRenameSavedSqlFolder() {
  savedSqlNameMode.value = "folder-rename";
  savedSqlNameInput.value = props.node.label;
  showSavedSqlNameDialog.value = true;
}

function openRenameSavedSqlFile() {
  savedSqlNameMode.value = "file-rename";
  savedSqlNameInput.value = props.node.label.replace(/\.sql$/i, "");
  showSavedSqlNameDialog.value = true;
}

async function confirmSavedSqlName() {
  const name = savedSqlNameInput.value.trim();
  if (!name || !props.node.connectionId || !savedSqlNameMode.value) return;

  if (savedSqlNameMode.value === "folder-create") {
    await savedSqlStore.createFolder(props.node.connectionId, name);
  } else if (savedSqlNameMode.value === "folder-rename" && props.node.savedSqlFolderId) {
    await savedSqlStore.renameFolder(props.node.savedSqlFolderId, name);
  } else if (savedSqlNameMode.value === "file-rename" && props.node.savedSqlId) {
    await savedSqlStore.renameFile(props.node.savedSqlId, name.endsWith(".sql") ? name : `${name}.sql`);
  }

  connectionStore.refreshSavedSqlTree(props.node.connectionId);
  showSavedSqlNameDialog.value = false;
  savedSqlNameMode.value = null;
}

function deleteSavedSqlFile() {
  showDeleteSavedSqlFileConfirm.value = true;
}

async function confirmDeleteSavedSqlFile() {
  if (!props.node.savedSqlId) return;
  await savedSqlStore.deleteFile(props.node.savedSqlId);
  connectionStore.refreshSavedSqlTree(props.node.connectionId);
  showDeleteSavedSqlFileConfirm.value = false;
}

function deleteSavedSqlFolder() {
  showDeleteSavedSqlFolderConfirm.value = true;
}

async function confirmDeleteSavedSqlFolder() {
  if (!props.node.savedSqlFolderId) return;
  await savedSqlStore.deleteFolder(props.node.savedSqlFolderId);
  connectionStore.refreshSavedSqlTree(props.node.connectionId);
  showDeleteSavedSqlFolderConfirm.value = false;
}

// --- Drag and Drop ---
import { useDragSort } from "@/composables/useDragSort";

const {
  state: dragState,
  startDrag,
  updateTarget,
  clearTarget,
} = useDragSort((draggedId, targetId, position) => connectionStore.reorderSidebarEntry(draggedId, targetId, position));

const isDraggable = computed(() => {
  if (props.dragDisabled) return false;
  return props.node.type === "connection" || props.node.type === "connection-group";
});

const isDropTarget = computed(() => props.node.type === "connection" || props.node.type === "connection-group");

const showDropBefore = computed(
  () => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "before",
);
const showDropAfter = computed(
  () => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "after",
);
const showDropInside = computed(
  () => dragState.active && dragState.targetId === props.node.id && dragState.dropPosition === "inside",
);
const isDragging = computed(() => dragState.active && dragState.draggedId === props.node.id);
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div>
        <div
          class="group flex min-w-0 items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-accent transition-colors relative"
          :class="{
            'ring-1 ring-primary/50 bg-primary/5': showDropInside,
            'opacity-50': isDragging,
            'rounded-none': connectionColor,
            'rounded-sm': !connectionColor,
          }"
          :style="rowStyle"
          @click="onClick"
          @dblclick="onDoubleClick"
          @mousedown="isDraggable ? startDrag($event, node.id, node.type) : undefined"
          @mousemove="isDropTarget ? updateTarget($event, node.id, node.type) : undefined"
          @mouseleave="clearTarget(node.id)"
        >
          <div
            v-if="showDropBefore"
            class="absolute right-2 top-0 h-0.5 bg-primary rounded-full pointer-events-none"
            :style="{ left: paddingLeft }"
          />
          <div
            v-if="showDropAfter"
            class="absolute right-2 bottom-0 h-0.5 bg-primary rounded-full pointer-events-none"
            :style="{ left: paddingLeft }"
          />
          <template v-if="canExpand">
            <button
              type="button"
              class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              @click.stop="toggle"
            >
              <Loader2 v-if="node.isLoading" class="w-3.5 h-3.5 animate-spin" />
              <ChevronDown v-else-if="node.isExpanded" class="w-3.5 h-3.5" />
              <ChevronRight v-else class="w-3.5 h-3.5" />
            </button>
          </template>
          <span v-else class="w-3.5 h-3.5 shrink-0" />
          <DatabaseIcon
            v-if="node.type === 'connection'"
            :db-type="connectionIconType(node.connectionId)"
            class="w-3.5 h-3.5 shrink-0"
          />
          <component
            v-else
            :is="getIconInfo(node)?.icon || Database"
            class="w-3.5 h-3.5 shrink-0"
            :class="getIconInfo(node)?.colorClass"
          />
          <input
            v-if="isRenamingGroup"
            v-model="renameInput"
            class="min-w-0 flex-1 truncate bg-transparent border border-primary/50 rounded px-1 text-xs outline-none"
            @blur="finishRenameGroup"
            @keydown.enter.prevent="finishRenameGroup"
            @keydown.escape.prevent="isRenamingGroup = false"
            @click.stop
            @vue:mounted="($event: any) => $event.el.focus()"
          />
          <span v-else class="min-w-0 flex-1 truncate">{{ displayLabel(node) }}</span>
          <Badge v-if="isNodeDefaultDatabase" variant="secondary" class="h-4 px-1.5 text-[10px]">
            {{ t("editor.defaultDatabase") }}
          </Badge>
          <span v-if="columnComment" class="truncate text-muted-foreground/60 text-[10px] max-w-[40%]">{{
            columnComment
          }}</span>
          <span
            v-if="
              node.type === 'connection' && node.connectionId && connectionStore.connectedIds.has(node.connectionId)
            "
            class="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0"
          />
          <ConnectionErrorIndicator
            v-if="node.type === 'connection'"
            :connection-id="node.connectionId"
            trigger-class="h-4 w-4"
          />
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
      </div>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-auto min-w-36">
      <ContextMenuItem v-if="canPin" @click="togglePin">
        <Pin class="w-4 h-4" :class="{ 'fill-current': isPinned }" />
        {{ isPinned ? t("contextMenu.unpin") : t("contextMenu.pin") }}
      </ContextMenuItem>
      <ContextMenuSeparator v-if="canPin && hasTypeMenu" />

      <template v-if="node.type === 'connection'">
        <ContextMenuItem v-if="!isConnected" @click="toggle">
          <Plug class="w-4 h-4" /> {{ t("contextMenu.openConnection") }}
        </ContextMenuItem>
        <ContextMenuItem v-else @click="disconnectConnection">
          <Unplug class="w-4 h-4" /> {{ t("contextMenu.closeConnection") }}
        </ContextMenuItem>
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t("contextMenu.newQuery") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenSqlFileExecution" @click="openSqlFileExecution">
          <FileCode class="w-4 h-4" /> {{ t("sqlFile.title") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canCreateDatabase" @click="openCreateDatabaseDialog">
          <Plus class="w-4 h-4" /> {{ t("contextMenu.createDatabase") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub v-if="availableGroups.length > 0 || currentGroupId">
          <ContextMenuSubTrigger>
            <FolderInput class="w-4 h-4" /> {{ t("connectionGroup.moveToGroup") }}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem
              v-for="group in availableGroups"
              :key="group.id"
              :disabled="group.id === currentGroupId"
              @click="moveToGroup(group.id)"
            >
              <FolderOpen class="w-4 h-4" /> {{ group.name }}
            </ContextMenuItem>
            <ContextMenuSeparator v-if="currentGroupId" />
            <ContextMenuItem v-if="currentGroupId" @click="moveToGroup(null)">
              {{ t("connectionGroup.ungrouped") }}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @click="moveToNewGroup">
              <FolderPlus class="w-4 h-4" /> {{ t("connectionGroup.newGroup") }}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem v-else @click="moveToNewGroup">
          <FolderPlus class="w-4 h-4" /> {{ t("connectionGroup.moveToNewGroup") }}
        </ContextMenuItem>
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t("contextMenu.refreshChildren") }}
        </ContextMenuItem>
        <ContextMenuItem @click="editConnection">
          <Pencil class="w-4 h-4" /> {{ t("contextMenu.editConnection") }}
        </ContextMenuItem>
        <ContextMenuItem @click="duplicateConnection">
          <CopyPlus class="w-4 h-4" /> {{ t("contextMenu.duplicateConnection") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem class="text-destructive" @click="deleteConnection">
          <Trash2 class="w-4 h-4" /> {{ t("contextMenu.deleteConnection") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'connection-group'">
        <ContextMenuItem @click="newConnectionInGroup">
          <Plus class="w-4 h-4" /> {{ t("toolbar.newConnection") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @click="startRenameGroup">
          <Pencil class="w-4 h-4" /> {{ t("connectionGroup.renameGroup") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem class="text-destructive" @click="deleteConnectionGroup">
          <Trash2 class="w-4 h-4" /> {{ t("connectionGroup.deleteGroup") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'database' || node.type === 'schema'">
        <ContextMenuItem v-if="canOpenObjectBrowser" @click="openObjectBrowser">
          <TableProperties class="w-4 h-4" /> {{ t("contextMenu.openObjectBrowser") }}
        </ContextMenuItem>
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t("contextMenu.newQuery") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="node.type === 'database' && !isNodeDefaultDatabase" @click="setNodeAsDefaultDatabase">
          <Database class="w-4 h-4" /> {{ t("contextMenu.setDefaultDatabase") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="node.type === 'database' && isNodeDefaultDatabase" @click="clearNodeDefaultDatabase">
          <Database class="w-4 h-4" /> {{ t("contextMenu.clearDefaultDatabase") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canCreateTable" @click="createTable">
          <Plus class="w-4 h-4" /> {{ t("contextMenu.createTable") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canCreateSchema" @click="openCreateSchemaDialog">
          <Plus class="w-4 h-4" /> {{ t("contextMenu.createSchema") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenSqlFileExecution" @click="openSqlFileExecution">
          <FileCode class="w-4 h-4" /> {{ t("sqlFile.title") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenDiagram" @click="openDiagram">
          <Network class="w-4 h-4" /> {{ t("diagram.open") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenDatabaseSearch" @click="openDatabaseSearch">
          <Search class="w-4 h-4" /> {{ t("databaseSearch.open") }}
        </ContextMenuItem>
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t("contextMenu.refreshChildren") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @click="openTransfer">
          <ArrowRightLeft class="w-4 h-4" /> {{ t("transfer.dataTransfer") }}
        </ContextMenuItem>
        <ContextMenuItem @click="openSchemaDiff">
          <ArrowRightLeft class="w-4 h-4" /> {{ t("diff.title") }}
        </ContextMenuItem>
        <ContextMenuItem @click="openDataCompare">
          <ArrowRightLeft class="w-4 h-4" /> {{ t("dataCompare.title") }}
        </ContextMenuItem>
        <ContextMenuItem :disabled="isExportingDatabase" @click="exportDatabase">
          <Loader2 v-if="isExportingDatabase" class="w-4 h-4 animate-spin" />
          <Download v-else class="w-4 h-4" />
          {{ t("contextMenu.exportDatabase") }}
        </ContextMenuItem>
        <template v-if="canDropDatabase || canDropSchema">
          <ContextMenuSeparator />
          <ContextMenuItem v-if="canDropDatabase" class="text-destructive" @click="dropDatabase">
            <Trash2 class="w-4 h-4" /> {{ t("contextMenu.dropDatabase") }}
          </ContextMenuItem>
          <ContextMenuItem v-if="canDropSchema" class="text-destructive" @click="dropSchema">
            <Trash2 class="w-4 h-4" /> {{ t("contextMenu.dropSchema") }}
          </ContextMenuItem>
        </template>
      </template>

      <template v-if="node.type === 'redis-db' || node.type === 'mongo-db'">
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t("contextMenu.newQuery") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="!isNodeDefaultDatabase" @click="setNodeAsDefaultDatabase">
          <Database class="w-4 h-4" /> {{ t("contextMenu.setDefaultDatabase") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="isNodeDefaultDatabase" @click="clearNodeDefaultDatabase">
          <Database class="w-4 h-4" /> {{ t("contextMenu.clearDefaultDatabase") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'table' || node.type === 'view'">
        <ContextMenuItem @click="openData">
          <TableProperties class="w-4 h-4" /> {{ t("contextMenu.viewData") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenStructureEditor" @click="openStructureEditor">
          <PencilRuler class="w-4 h-4" /> {{ t("contextMenu.editStructure") }}
        </ContextMenuItem>
        <ContextMenuItem @click="newQuery">
          <TerminalSquare class="w-4 h-4" /> {{ t("contextMenu.newQuery") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenDiagram" @click="openDiagram">
          <Network class="w-4 h-4" /> {{ t("diagram.open") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="canOpenTableImport" @click="openTableImport">
          <FileUp class="w-4 h-4" /> {{ t("contextMenu.importData") }}
        </ContextMenuItem>
        <ContextMenuItem v-if="isTableNotView" @click="openDataCompare">
          <ArrowRightLeft class="w-4 h-4" /> {{ t("dataCompare.title") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Download class="w-4 h-4" /> {{ t("contextMenu.exportData") }}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem @click="exportData('csv')">CSV</ContextMenuItem>
            <ContextMenuItem @click="exportData('json')">JSON</ContextMenuItem>
            <ContextMenuItem @click="exportData('sql')">SQL INSERT</ContextMenuItem>
            <ContextMenuItem @click="exportDataXlsx">XLSX</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem @click="exportStructure">
          <FileCode class="w-4 h-4" /> {{ t("contextMenu.exportStructure") }}
        </ContextMenuItem>
        <template v-if="isTableNotView">
          <ContextMenuSeparator />
          <ContextMenuItem @click="duplicateStructure">
            <CopyPlus class="w-4 h-4" /> {{ t("contextMenu.duplicateStructure") }}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem v-if="supportsTruncate" class="text-destructive" @click="truncateTable">
            <Scissors class="w-4 h-4" /> {{ t("contextMenu.truncateTable") }}
          </ContextMenuItem>
          <ContextMenuItem class="text-destructive" @click="emptyTable">
            <Eraser class="w-4 h-4" /> {{ t("contextMenu.emptyTable") }}
          </ContextMenuItem>
          <ContextMenuItem class="text-destructive" @click="dropTable">
            <Trash2 class="w-4 h-4" /> {{ t("contextMenu.dropTable") }}
          </ContextMenuItem>
        </template>
        <ContextMenuSeparator />
        <ContextMenuItem @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t("contextMenu.refreshChildren") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'column'">
        <ContextMenuItem v-if="canOpenFieldLineage" @click="openFieldLineage">
          <Network class="w-4 h-4" /> {{ t("lineage.open") }}
        </ContextMenuItem>
      </template>

      <template v-if="isGroupLabel(node)">
        <ContextMenuItem v-if="node.type === 'saved-sql-root'" @click="openCreateSavedSqlFolder">
          <FolderPlus class="w-4 h-4" /> {{ t("savedSql.newFolder") }}
        </ContextMenuItem>
        <template v-if="node.type === 'saved-sql-folder'">
          <ContextMenuItem @click="openRenameSavedSqlFolder">
            <Pencil class="w-4 h-4" /> {{ t("savedSql.renameFolder") }}
          </ContextMenuItem>
          <ContextMenuItem class="text-destructive" @click="deleteSavedSqlFolder">
            <Trash2 class="w-4 h-4" /> {{ t("savedSql.deleteFolder") }}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem v-if="node.type !== 'saved-sql-root' && node.type !== 'saved-sql-folder'" @click="refresh">
          <RefreshCw class="w-4 h-4" /> {{ t("contextMenu.refreshChildren") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type === 'saved-sql-file'">
        <ContextMenuItem @click="openSavedSqlFile">
          <FileText class="w-4 h-4" /> {{ t("savedSql.open") }}
        </ContextMenuItem>
        <ContextMenuItem @click="openRenameSavedSqlFile">
          <Pencil class="w-4 h-4" /> {{ t("savedSql.renameFile") }}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem class="text-destructive" @click="deleteSavedSqlFile">
          <Trash2 class="w-4 h-4" /> {{ t("savedSql.deleteFile") }}
        </ContextMenuItem>
      </template>

      <template v-if="node.type !== 'connection'">
        <ContextMenuSeparator v-if="hasTypeMenu" />
        <ContextMenuItem @click="copyName"> <Copy class="w-4 h-4" /> {{ t("contextMenu.copyName") }} </ContextMenuItem>
      </template>
    </ContextMenuContent>
  </ContextMenu>

  <Dialog v-model:open="showDeleteConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.confirmDeleteTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ t("contextMenu.confirmDeleteMessage", { name: node.label }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button
          variant="destructive"
          @click="
            showDeleteConfirm = false;
            confirmDelete();
          "
          >{{ t("contextMenu.deleteConnection") }}</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showMoveToNewGroupDialog">
    <DialogContent class="sm:max-w-[360px]">
      <DialogHeader>
        <DialogTitle>{{ t("connectionGroup.createGroup") }}</DialogTitle>
      </DialogHeader>
      <Input
        v-model="moveToNewGroupName"
        :placeholder="t('connectionGroup.groupNamePlaceholder')"
        @keydown.enter.prevent="confirmMoveToNewGroup"
      />
      <DialogFooter>
        <Button variant="outline" @click="showMoveToNewGroupDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!moveToNewGroupName.trim()" @click="confirmMoveToNewGroup">{{
          t("connectionGroup.createGroup")
        }}</Button>
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

  <Dialog v-model:open="showSavedSqlNameDialog">
    <DialogContent class="sm:max-w-[380px]">
      <DialogHeader>
        <DialogTitle>
          {{
            savedSqlNameMode === "folder-create"
              ? t("savedSql.newFolder")
              : savedSqlNameMode === "folder-rename"
                ? t("savedSql.renameFolder")
                : t("savedSql.renameFile")
          }}
        </DialogTitle>
      </DialogHeader>
      <Input v-model="savedSqlNameInput" @keydown.enter.prevent="confirmSavedSqlName" />
      <DialogFooter>
        <Button variant="outline" @click="showSavedSqlNameDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!savedSqlNameInput.trim()" @click="confirmSavedSqlName">{{
          t("dangerDialog.confirm")
        }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showDeleteSavedSqlFileConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("savedSql.deleteFile") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ t("savedSql.deleteFileConfirm", { name: node.label }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteSavedSqlFileConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteSavedSqlFile">{{ t("savedSql.deleteFile") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showDeleteSavedSqlFolderConfirm">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("savedSql.deleteFolder") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">
        {{ t("savedSql.deleteFolderConfirm", { name: node.label }) }}
      </p>
      <DialogFooter>
        <Button variant="outline" @click="showDeleteSavedSqlFolderConfirm = false">{{
          t("dangerDialog.cancel")
        }}</Button>
        <Button variant="destructive" @click="confirmDeleteSavedSqlFolder">{{ t("savedSql.deleteFolder") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showDropTableConfirm"
    :title="t('contextMenu.confirmDropTableTitle')"
    :message="t('contextMenu.confirmDropTableMessage', { name: node.label })"
    :sql="buildDropTableSql()"
    :confirm-label="t('contextMenu.dropTable')"
    @confirm="confirmDropTable"
  />

  <DangerConfirmDialog
    v-model:open="showEmptyTableConfirm"
    :title="t('contextMenu.confirmEmptyTableTitle')"
    :message="t('contextMenu.confirmEmptyTableMessage', { name: node.label })"
    :sql="buildEmptyTableSql()"
    :confirm-label="t('contextMenu.emptyTable')"
    @confirm="confirmEmptyTable"
  />

  <DangerConfirmDialog
    v-model:open="showTruncateTableConfirm"
    :title="t('contextMenu.confirmTruncateTableTitle')"
    :message="t('contextMenu.confirmTruncateTableMessage', { name: node.label })"
    :sql="buildTruncateTableSql()"
    :confirm-label="t('contextMenu.truncateTable')"
    @confirm="confirmTruncateTable"
  />

  <Dialog v-model:open="showDuplicateDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.duplicateNameTitle") }}</DialogTitle>
      </DialogHeader>
      <Input
        v-model="duplicateTableName"
        :placeholder="t('contextMenu.duplicateNamePlaceholder')"
        @keydown.enter.prevent="confirmDuplicateStructure"
      />
      <DialogFooter>
        <Button variant="outline" @click="showDuplicateDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!duplicateTableName.trim()" @click="confirmDuplicateStructure">{{
          t("dangerDialog.confirm")
        }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showCreateDatabaseDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createDatabase") }}</DialogTitle>
      </DialogHeader>
      <Input
        v-model="createDatabaseName"
        :placeholder="t('contextMenu.createDatabaseNamePlaceholder')"
        @keydown.enter.prevent="confirmCreateDatabase"
      />
      <DialogFooter>
        <Button variant="outline" @click="showCreateDatabaseDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createDatabaseName.trim()" @click="confirmCreateDatabase">{{
          t("dangerDialog.confirm")
        }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showDropDatabaseConfirm"
    :title="t('contextMenu.confirmDropDatabaseTitle')"
    :message="t('contextMenu.confirmDropDatabaseMessage', { name: node.label })"
    :sql="buildDropDatabaseSql()"
    :confirm-label="t('contextMenu.dropDatabase')"
    @confirm="confirmDropDatabase"
  />

  <Dialog v-model:open="showCreateSchemaDialog">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.createSchema") }}</DialogTitle>
      </DialogHeader>
      <Input
        v-model="createSchemaName"
        :placeholder="t('contextMenu.createSchemaNamePlaceholder')"
        @keydown.enter.prevent="confirmCreateSchema"
      />
      <DialogFooter>
        <Button variant="outline" @click="showCreateSchemaDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!createSchemaName.trim()" @click="confirmCreateSchema">{{
          t("dangerDialog.confirm")
        }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showDropSchemaConfirm"
    :title="t('contextMenu.confirmDropSchemaTitle')"
    :message="t('contextMenu.confirmDropSchemaMessage', { name: node.label })"
    :sql="buildDropSchemaSql()"
    :confirm-label="t('contextMenu.dropSchema')"
    @confirm="confirmDropSchema"
  />
</template>
