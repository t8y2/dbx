<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Braces,
  CheckSquare,
  Code2,
  Copy,
  CopyPlus,
  ChevronDown,
  ChevronRight,
  Download,
  Eraser,
  Eye,
  FileCode,
  ListTree,
  Upload,
  Loader2,
  Network,
  Pencil,
  PencilLine,
  PencilRuler,
  Play,
  Package,
  RefreshCw,
  Scissors,
  Search,
  ScrollText,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  X,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import * as api from "@/lib/api";
import type { ConnectionConfig, ForeignKeyInfo, ObjectInfo, ObjectSourceKind } from "@/types/database";
import { sortTablesByFkDependency, type TableWithFk } from "@/lib/tableDependencySort";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { supportsSchemaDiagram, supportsTableImport, supportsTableStructureEditing, supportsTableTruncate } from "@/lib/databaseFeatureSupport";
import { codeMirrorSqlDialect, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { buildTableSelectSql } from "@/lib/tableSelectSql";
import { buildDropObjectSql, buildDuplicateTableStructureSql, buildEmptyTableSql, buildTruncateTableSql, type TableAdminSqlOptions } from "@/lib/dbAdminSql";
import { useToast } from "@/composables/useToast";
import { buildExecutableObjectSourceStatements, buildRoutineRenameObjectSourceStatements, objectSourceSaveExecutionMode, supportsSourceBackedRoutineRename } from "@/lib/objectSourceEditor";
import { buildRenameObjectSql, supportsObjectRename } from "@/lib/objectRenameSql";
import { buildViewDdl } from "@/lib/viewDdl";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { generateDatabaseExportId } from "@/lib/databaseExport";
import { copyToClipboard } from "@/lib/clipboard";
import { formatSqlInsert } from "@/lib/exportFormats";
import { fetchTableDataForExport } from "@/lib/tableDataExport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryStore } from "@/stores/queryStore";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import DdlViewDialog from "./DdlViewDialog.vue";
import type { SqlFormatDialect } from "@/lib/sqlFormatter";
import { isCancelSearchShortcut } from "@/lib/keyboardShortcuts";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buildObjectBrowserRows, filterObjectBrowserRows, formatObjectBrowserTimestamp, initialObjectBrowserSortDirection, sortObjectBrowserRows, type ObjectBrowserRow, type ObjectBrowserSortDirection, type ObjectBrowserSortKey } from "@/lib/objectBrowserRows";

type ObjectFilter = "all" | "tables" | "views" | "procedures" | "functions" | "sequences" | "packages";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  schema?: string;
}>();

const emit = defineEmits<{
  openTable: [target: { tableName: string; schema?: string }];
  schemaChange: [schema: string | undefined];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();

const schemas = ref<string[]>([]);
const selectedSchema = ref<string | undefined>(props.schema);
const rows = ref<ObjectBrowserRow[]>([]);
const rootRef = ref<HTMLElement>();
const search = ref("");
const objectFilter = ref<ObjectFilter>("all");
const userHasSelectedFilter = ref(false);
const sortKey = ref<ObjectBrowserSortKey>("name");
const sortDirection = ref<ObjectBrowserSortDirection>("asc");
const loadingSchemas = ref(false);
const loadingObjects = ref(false);
const sourceLoading = ref(false);
const sourceContent = ref("");
const sourceError = ref("");
const sourceRow = ref<ObjectBrowserRow | null>(null);
const sourceEditing = ref(false);
const effectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const tableStructureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const sourceDraft = ref("");
const sourceSaving = ref(false);
const sourceSaveError = ref("");
const error = ref("");
const showDropConfirm = ref(false);
const dropTarget = ref<ObjectBrowserRow | null>(null);
const showRenameDialog = ref(false);
const renameTarget = ref<ObjectBrowserRow | null>(null);
const renameInput = ref("");
const renameError = ref("");
const renamePreviewSqlText = ref("");
const showTruncateConfirm = ref(false);
const truncateTarget = ref<ObjectBrowserRow | null>(null);
const truncatePreviewSql = ref("");
const showEmptyConfirm = ref(false);
const emptyTarget = ref<ObjectBrowserRow | null>(null);
const emptyPreviewSql = ref("");
const showDuplicateDialog = ref(false);
const duplicateTarget = ref<ObjectBrowserRow | null>(null);
const duplicateTableName = ref("");
const showProcedureExecutionConfirm = ref(false);
const procedureExecutionTarget = ref<ObjectBrowserRow | null>(null);
const ddlDialogTarget = ref<ObjectBrowserRow | null>(null);
const showDdlDialog = ref(false);
const selectedTableIds = ref<Set<string>>(new Set());
const expandedPartitionParentIds = ref<Set<string>>(new Set());
const showBatchDropConfirm = ref(false);
const batchDropPreviewSql = ref("");
let loadId = 0;

// Export via background tracker
const { addTask: addExportTask } = useExportTracker();

const needsSchema = computed(() => isSchemaAware(props.connection.db_type) && !connectionUsesDatabaseObjectTreeMode(props.connection));
const tableCount = computed(() => rows.value.filter((row) => row.type === "TABLE").length);
const viewCount = computed(() => rows.value.filter((row) => row.type === "VIEW" || row.type === "MATERIALIZED_VIEW").length);
const procedureCount = computed(() => rows.value.filter((row) => row.type === "PROCEDURE").length);
const functionCount = computed(() => rows.value.filter((row) => row.type === "FUNCTION").length);
const sequenceCount = computed(() => rows.value.filter((row) => row.type === "SEQUENCE").length);
const packageCount = computed(() => rows.value.filter((row) => row.type === "PACKAGE" || row.type === "PACKAGE_BODY").length);
const canOpenStructureEditor = computed(() => supportsTableStructureEditing(tableStructureDatabaseType.value));
const canOpenDiagram = computed(() => !!props.database && supportsSchemaDiagram(effectiveDatabaseType.value));
const canOpenTableImport = computed(() => !!props.database && supportsTableImport(effectiveDatabaseType.value));
const supportsTruncateTable = computed(() => supportsTableTruncate(effectiveDatabaseType.value));
const sourceDialect = computed(() => codeMirrorSqlDialect(effectiveDatabaseType.value));
const sourceFormatDialect = computed<SqlFormatDialect>(() => {
  switch (effectiveDatabaseType.value) {
    case "mysql":
    case "postgres":
    case "sqlite":
    case "sqlserver":
      return effectiveDatabaseType.value;
    case "rqlite":
    case "turso":
      return "sqlite";
    case "gaussdb":
    case "kwdb":
    case "opengauss":
    case "questdb":
      return "postgres";
    default:
      return "generic";
  }
});
const objectFilters = computed<ObjectFilter[]>(() =>
  (
    [
      ["all", rows.value.length],
      ["tables", tableCount.value],
      ["views", viewCount.value],
      ["procedures", procedureCount.value],
      ["functions", functionCount.value],
      ["sequences", sequenceCount.value],
      ["packages", packageCount.value],
    ] as Array<[ObjectFilter, number]>
  )
    .filter(([filter, count]) => filter === "all" || count > 0)
    .map(([filter]) => filter),
);
const showObjectFilter = computed(() => objectFilters.value.length > 2);
const hasComments = computed(() => rows.value.some((row) => row.comment?.trim()));
const hasCreatedAt = computed(() => rows.value.some((row) => row.created_at?.trim()));
const hasUpdatedAt = computed(() => rows.value.some((row) => row.updated_at?.trim()));
const gridTemplateColumns = computed(() => {
  const columns = ["34px", "minmax(0,1fr)", "120px"];
  if (hasCreatedAt.value) columns.push("150px");
  if (hasUpdatedAt.value) columns.push("150px");
  if (hasComments.value) columns.push("minmax(160px,0.7fr)");
  return columns.join(" ");
});
const partitionRowsByParentId = computed(() => {
  const groups = new Map<string, ObjectBrowserRow[]>();
  for (const row of rows.value) {
    if (!row.partitionParentId) continue;
    const group = groups.get(row.partitionParentId) ?? [];
    group.push(row);
    groups.set(row.partitionParentId, group);
  }
  return groups;
});
const filteredRows = computed(() => groupedFilteredRows());
const selectableRows = computed(() => rows.value.filter((row) => row.type === "TABLE"));
const visibleSelectableRows = computed(() => filteredRows.value.filter((row) => row.type === "TABLE"));
const selectedTableRows = computed(() => {
  const ids = selectedTableIds.value;
  return selectableRows.value.filter((row) => ids.has(row.id));
});
const selectedTableCount = computed(() => selectedTableRows.value.length);
const allVisibleTablesSelected = computed(() => visibleSelectableRows.value.length > 0 && visibleSelectableRows.value.every((row) => selectedTableIds.value.has(row.id)));

function iconFor(row: ObjectBrowserRow) {
  if (row.type === "VIEW" || row.type === "MATERIALIZED_VIEW") return Eye;
  if (row.type === "PROCEDURE") return ScrollText;
  if (row.type === "FUNCTION") return Braces;
  if (row.type === "SEQUENCE") return ListTree;
  if (row.type === "PACKAGE" || row.type === "PACKAGE_BODY") return Package;
  return Table2;
}

function typeLabel(type: ObjectBrowserRow["type"]) {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return t("objects.view");
  if (type === "PROCEDURE") return t("objects.procedure");
  if (type === "FUNCTION") return t("objects.function");
  if (type === "SEQUENCE") return t("objects.sequence");
  if (type === "PACKAGE") return t("objects.package");
  if (type === "PACKAGE_BODY") return t("objects.packageBody");
  return t("objects.table");
}

function sortIconFor(key: ObjectBrowserSortKey) {
  if (sortKey.value !== key) return null;
  return sortDirection.value === "asc" ? ArrowUp : ArrowDown;
}

function toggleSort(key: ObjectBrowserSortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = initialObjectBrowserSortDirection(key);
}

function rowMatchesObjectFilter(row: ObjectBrowserRow) {
  if (objectFilter.value === "tables") return row.type === "TABLE";
  if (objectFilter.value === "views") return row.type === "VIEW" || row.type === "MATERIALIZED_VIEW";
  if (objectFilter.value === "procedures") return row.type === "PROCEDURE";
  if (objectFilter.value === "functions") return row.type === "FUNCTION";
  if (objectFilter.value === "sequences") return row.type === "SEQUENCE";
  if (objectFilter.value === "packages") return row.type === "PACKAGE" || row.type === "PACKAGE_BODY";
  return true;
}

function groupedFilteredRows() {
  const query = search.value.trim();
  const candidateRows = rows.value.filter(rowMatchesObjectFilter);
  const candidateIds = new Set(candidateRows.map((row) => row.id));
  const matchingRows = filterObjectBrowserRows(candidateRows, query);
  const matchingIds = new Set(matchingRows.map((row) => row.id));
  const parentIdsWithMatchingPartitions = new Set(matchingRows.flatMap((row) => (row.partitionParentId ? [row.partitionParentId] : [])));
  const rootRows = candidateRows.filter((row) => {
    if (row.partitionParentId) return false;
    if (!query) return true;
    return matchingIds.has(row.id) || parentIdsWithMatchingPartitions.has(row.id);
  });
  const sortedRoots = sortObjectBrowserRows(rootRows, sortKey.value, sortDirection.value);
  const result: ObjectBrowserRow[] = [];

  for (const row of sortedRoots) {
    result.push(row);
    const partitions = partitionRowsByParentId.value.get(row.id)?.filter((partition) => candidateIds.has(partition.id));
    if (!partitions?.length) continue;
    const parentMatches = matchingIds.has(row.id);
    const shouldShowPartitions = expandedPartitionParentIds.value.has(row.id) || !!query;
    if (!shouldShowPartitions) continue;
    const visiblePartitions = query && !parentMatches ? partitions.filter((partition) => matchingIds.has(partition.id)) : partitions;
    result.push(...sortObjectBrowserRows(visiblePartitions, sortKey.value, sortDirection.value));
  }

  return result;
}

function iconClass(type: ObjectBrowserRow["type"]) {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return "text-purple-500";
  if (type === "PROCEDURE") return "text-blue-500";
  if (type === "FUNCTION") return "text-amber-500";
  if (type === "SEQUENCE") return "text-emerald-500";
  if (type === "PACKAGE" || type === "PACKAGE_BODY") return "text-cyan-500";
  return "text-green-500";
}

function isPartitionParentExpanded(row: ObjectBrowserRow) {
  return expandedPartitionParentIds.value.has(row.id);
}

function togglePartitionParent(row: ObjectBrowserRow) {
  if (!row.partitionCount) return;
  const next = new Set(expandedPartitionParentIds.value);
  if (next.has(row.id)) next.delete(row.id);
  else next.add(row.id);
  expandedPartitionParentIds.value = next;
}

function canOpenSource(row: ObjectBrowserRow) {
  return row.type === "VIEW" || row.type === "MATERIALIZED_VIEW" || row.type === "PROCEDURE" || row.type === "FUNCTION" || row.type === "SEQUENCE" || row.type === "PACKAGE" || row.type === "PACKAGE_BODY";
}

function canRename(row: ObjectBrowserRow) {
  return supportsObjectRename(effectiveDatabaseType.value, row.type) || supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind);
}

function sourceTitle(row: ObjectBrowserRow | null) {
  if (!row) return t("objects.source");
  return `${row.name} ${t("objects.source")}`;
}

function onRowClick(row: ObjectBrowserRow, event: MouseEvent) {
  if (settingsStore.editorSettings.sidebarActivation === "double") {
    if (event.detail === 2) openRow(row);
    return;
  }
  if (event.detail > 1) return;
  openRow(row);
}

function openRow(row: ObjectBrowserRow) {
  if (row.type === "TABLE") {
    emit("openTable", { tableName: row.name, schema: row.schema });
    return;
  }
  if (canOpenSource(row)) {
    void openSource(row);
  }
}

async function openSource(row: ObjectBrowserRow) {
  sourceRow.value = row;
  sourceContent.value = "";
  sourceError.value = "";
  sourceEditing.value = false;
  sourceDraft.value = "";
  sourceSaveError.value = "";
  sourceLoading.value = true;
  try {
    const result = await api.getObjectSource(props.connection.id, props.database, row.schema || selectedSchema.value || props.database, row.name, row.type as ObjectSourceKind);
    const editable = await api.buildEditableObjectSource({
      databaseType: effectiveDatabaseType.value,
      objectType: row.type as ObjectSourceKind,
      schema: row.schema || selectedSchema.value || props.database,
      name: row.name,
      source: result.source,
    });
    sourceContent.value = editable;
    sourceDraft.value = editable;
    sourceEditing.value = row.type !== "SEQUENCE";
  } catch (e: any) {
    sourceError.value = e?.message || String(e);
  } finally {
    sourceLoading.value = false;
  }
}

async function openViewDdl(row: ObjectBrowserRow) {
  if (row.type !== "VIEW" && row.type !== "MATERIALIZED_VIEW") return;
  try {
    const result = await api.getObjectSource(props.connection.id, props.database, row.schema || selectedSchema.value || props.database, row.name, "VIEW");
    const ddl = await buildViewDdl({
      databaseType: effectiveDatabaseType.value,
      schema: row.schema || selectedSchema.value || props.database,
      name: row.name,
      source: result.source,
    });
    const tabId = queryStore.createTab(props.connection.id, props.database, `DDL - ${row.name}`);
    queryStore.updateSql(tabId, ddl);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

async function openNewQuery(row: ObjectBrowserRow) {
  const tabId = queryStore.createTab(props.connection.id, props.database, row.name);
  queryStore.updateSql(
    tabId,
    await buildTableSelectSql({
      databaseType: effectiveDatabaseType.value,
      schema: row.schema || selectedSchema.value,
      tableName: row.name,
      limit: 100,
    }),
  );
}

function openProcedureExecution(row: ObjectBrowserRow) {
  if (row.type !== "PROCEDURE") return;
  procedureExecutionTarget.value = row;
  showProcedureExecutionConfirm.value = true;
}

function openProcedureExecutionSql(sql: string) {
  const row = procedureExecutionTarget.value;
  if (!row || !sql) return;
  const schema = row.schema || selectedSchema.value;
  const tabId = queryStore.createTab(props.connection.id, props.database, `Execute - ${row.name}`, "query", schema);
  queryStore.updateSql(tabId, sql);
}

async function executeProcedureSql(sql: string) {
  const row = procedureExecutionTarget.value;
  if (!row || !sql) return;
  const schema = row.schema || selectedSchema.value;
  const tabId = queryStore.createTab(props.connection.id, props.database, `Execute - ${row.name}`, "query", schema);
  queryStore.updateSql(tabId, sql);
  await queryStore.executeTabSql(tabId, sql);
}

function requestDrop(row: ObjectBrowserRow) {
  dropTarget.value = row;
  showDropConfirm.value = true;
}

function requestRename(row: ObjectBrowserRow) {
  renameTarget.value = row;
  renameInput.value = row.name;
  renameError.value = "";
  renamePreviewSqlText.value = "";
  showRenameDialog.value = true;
}

let renamePreviewRequestId = 0;

async function refreshRenamePreviewSql() {
  const requestId = ++renamePreviewRequestId;
  const row = renameTarget.value;
  const newName = renameInput.value.trim();
  if (!showRenameDialog.value || !row || !newName || newName === row.name) {
    renamePreviewSqlText.value = "";
    return;
  }
  if (supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind)) {
    renamePreviewSqlText.value = `-- Recreate ${row.type} from source, then drop the original object.`;
    return;
  }
  try {
    const sql = await buildRenameObjectSql({
      databaseType: effectiveDatabaseType.value,
      objectType: row.type,
      schema: row.schema || selectedSchema.value,
      oldName: row.name,
      newName,
    });
    if (requestId === renamePreviewRequestId) renamePreviewSqlText.value = sql;
  } catch {
    if (requestId === renamePreviewRequestId) renamePreviewSqlText.value = "";
  }
}

watch([showRenameDialog, renameTarget, renameInput, selectedSchema], () => {
  void refreshRenamePreviewSql();
});

async function confirmRename() {
  const row = renameTarget.value;
  const newName = renameInput.value.trim();
  if (!row || !newName || newName === row.name) return;
  renameError.value = "";
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    if (supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind)) {
      const source = await api.getObjectSource(props.connection.id, props.database, schema, row.name, row.type as ObjectSourceKind);
      const statements = await buildRoutineRenameObjectSourceStatements({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type as ObjectSourceKind,
        schema,
        name: row.name,
        newName,
        source: source.source,
      });
      for (const sql of statements) {
        await api.executeQuery(props.connection.id, props.database, sql, schema);
      }
    } else {
      const sql = await buildRenameObjectSql({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type,
        schema,
        oldName: row.name,
        newName,
      });
      await api.executeQuery(props.connection.id, props.database, sql, schema);
    }
    toast(t("contextMenu.renameObjectSuccess", { oldName: row.name, newName }));
    showRenameDialog.value = false;
    if (sourceRow.value?.id === row.id) closeSource();
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
  } catch (e: any) {
    renameError.value = e?.message || String(e);
  }
}

async function confirmDrop() {
  if (!dropTarget.value) return;
  const row = dropTarget.value;
  try {
    const sql = await buildDropObjectSql({
      databaseType: effectiveDatabaseType.value,
      objectType: row.type,
      schema: row.schema || selectedSchema.value,
      name: row.name,
    });
    await api.executeQuery(props.connection.id, props.database, sql);
    const successKey = row.type === "VIEW" ? "contextMenu.dropViewSuccess" : row.type === "PROCEDURE" ? "contextMenu.dropProcedureSuccess" : row.type === "FUNCTION" ? "contextMenu.dropFunctionSuccess" : "contextMenu.dropTableSuccess";
    toast(t(successKey, { name: row.name }));
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  dropTarget.value = null;
}

function dropConfirmTitle(): string {
  if (!dropTarget.value) return "";
  const type = dropTarget.value.type;
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return t("contextMenu.confirmDropViewTitle");
  if (type === "PROCEDURE") return t("contextMenu.confirmDropProcedureTitle");
  if (type === "FUNCTION") return t("contextMenu.confirmDropFunctionTitle");
  return t("contextMenu.confirmDropTableTitle");
}

function dropConfirmMessage(): string {
  if (!dropTarget.value) return "";
  const name = dropTarget.value.name;
  const type = dropTarget.value.type;
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return t("contextMenu.confirmDropViewMessage", { name });
  if (type === "PROCEDURE") return t("contextMenu.confirmDropProcedureMessage", { name });
  if (type === "FUNCTION") return t("contextMenu.confirmDropFunctionMessage", { name });
  return t("contextMenu.confirmDropTableMessage", { name });
}

function closeSource() {
  sourceRow.value = null;
  sourceContent.value = "";
  sourceError.value = "";
  sourceEditing.value = false;
  sourceDraft.value = "";
  sourceSaveError.value = "";
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

function openViewData(row: ObjectBrowserRow) {
  emit("openTable", { tableName: row.name, schema: row.schema });
}

function openStructureEditor(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  queryStore.openTableStructure(props.connection.id, props.database, row.schema || selectedSchema.value, row.name);
}

function openDiagram(row: ObjectBrowserRow) {
  connectionStore.diagramSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" ? row.name : undefined,
  };
}

function openTableImport(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  connectionStore.tableImportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
  };
}

function openDataCompare(row: ObjectBrowserRow) {
  connectionStore.dataCompareSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" ? row.name : undefined,
  };
}

function openDatabaseExport(row: ObjectBrowserRow) {
  connectionStore.databaseExportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    tableName: row.type === "TABLE" || row.type === "VIEW" || row.type === "MATERIALIZED_VIEW" ? row.name : undefined,
  };
}

function setSelectedTableIds(ids: Set<string>) {
  selectedTableIds.value = new Set(ids);
}

function toggleTableSelection(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  const next = new Set(selectedTableIds.value);
  if (next.has(row.id)) {
    next.delete(row.id);
  } else {
    next.add(row.id);
  }
  setSelectedTableIds(next);
}

function toggleVisibleTableSelection() {
  const next = new Set(selectedTableIds.value);
  if (allVisibleTablesSelected.value) {
    for (const row of visibleSelectableRows.value) next.delete(row.id);
  } else {
    for (const row of visibleSelectableRows.value) next.add(row.id);
  }
  setSelectedTableIds(next);
}

function clearTableSelection() {
  setSelectedTableIds(new Set());
}

function openBatchDatabaseExport() {
  const selectedTables = selectedTableRows.value.map((row) => row.name);
  if (selectedTables.length === 0) return;
  connectionStore.databaseExportSource = {
    connectionId: props.connection.id,
    database: props.database,
    schema: selectedTableRows.value[0]?.schema || selectedSchema.value,
    tableNames: selectedTables,
  };
}

async function fetchSortedTableRowsForDrop(): Promise<ObjectBrowserRow[]> {
  const rows = [...selectedTableRows.value];
  if (rows.length <= 1) return rows;

  const fkResults = await Promise.all(rows.map((row) => api.listForeignKeys(props.connection.id, props.database, row.schema || selectedSchema.value || "", row.name).catch(() => [] as ForeignKeyInfo[])));

  const tablesWithFk: TableWithFk[] = rows.map((row, i) => ({
    name: row.name,
    schema: row.schema || selectedSchema.value,
    foreignKeys: fkResults[i] ?? [],
  }));

  const sorted = sortTablesByFkDependency(tablesWithFk);
  const nameToRow = new Map(rows.map((r) => [r.name, r]));
  return sorted.map((t) => nameToRow.get(t.name)!).filter(Boolean);
}

async function refreshBatchDropPreviewSql() {
  const statements: string[] = [];
  const sortedRows = await fetchSortedTableRowsForDrop();
  for (const row of sortedRows) {
    const sql = await buildDropObjectSql({
      databaseType: effectiveDatabaseType.value,
      objectType: "TABLE",
      schema: row.schema || selectedSchema.value,
      name: row.name,
    }).catch(() => "");
    if (sql) statements.push(sql);
  }
  batchDropPreviewSql.value = statements.join("\n");
}

function requestBatchDropTables() {
  if (selectedTableCount.value === 0) return;
  batchDropPreviewSql.value = "";
  void refreshBatchDropPreviewSql();
  showBatchDropConfirm.value = true;
}

async function confirmBatchDropTables() {
  const targets = await fetchSortedTableRowsForDrop();
  if (targets.length === 0) return;
  try {
    for (const row of targets) {
      const sql = await buildDropObjectSql({
        databaseType: effectiveDatabaseType.value,
        objectType: "TABLE",
        schema: row.schema || selectedSchema.value,
        name: row.name,
      });
      await api.executeQuery(props.connection.id, props.database, sql);
    }
    toast(t("objects.batchDropSuccess", { count: targets.length }));
    clearTableSelection();
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function exportStructure(row: ObjectBrowserRow) {
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const ddl = await api.getTableDdl(props.connection.id, props.database, schema, row.name, row.type === "VIEW" || row.type === "MATERIALIZED_VIEW" ? "VIEW" : undefined);
    await saveFileContent(ddl + "\n", `${row.name}.sql`, "SQL", "sql");
  } catch (e: any) {
    console.error("Export structure failed:", e);
  }
}

async function exportDataLegacy(row: ObjectBrowserRow, format: "json" | "sql") {
  try {
    const schema = row.schema || selectedSchema.value;
    const tableColumns = format === "sql" ? await api.getColumns(props.connection.id, props.database, schema || props.database, row.name) : undefined;
    const queryColumns = props.connection.db_type === "neo4j" ? (tableColumns ?? (await api.getColumns(props.connection.id, props.database, schema || props.database, row.name))).map((column) => column.name) : undefined;
    const result = await fetchTableDataForExport({
      databaseType: effectiveDatabaseType.value,
      schema,
      tableName: row.name,
      columns: queryColumns,
      executePage: (sql) => api.executeQuery(props.connection.id, props.database, sql),
    });

    if (format === "json") {
      let outputPath = `${row.name}.json`;
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
      databaseType: effectiveDatabaseType.value,
      schema,
      tableName: row.name,
      columns: result.columns,
      columnTypes: tableColumns ? columnTypesForResultColumns(result.columns, tableColumns) : undefined,
      rows: result.rows,
    });
    await saveFileContent(content, `${row.name}.sql`, "SQL", "sql");
    toast(t("grid.exported"));
  } catch (e: any) {
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function columnTypesForResultColumns(columns: string[], tableColumns: Array<{ name: string; data_type: string }>): Array<string | undefined> {
  const typesByName = new Map(tableColumns.map((column) => [column.name.toLocaleLowerCase(), column.data_type]));
  return columns.map((column) => typesByName.get(column.toLocaleLowerCase()));
}

async function exportData(row: ObjectBrowserRow, format: "csv" | "json" | "sql") {
  if (format === "csv") {
    await exportTableData(row, "csv");
    return;
  }
  await exportDataLegacy(row, format);
}

async function exportDataXlsx(row: ObjectBrowserRow) {
  await exportTableData(row, "xlsx");
}

async function exportTableData(row: ObjectBrowserRow, format: "csv" | "xlsx") {
  const schema = row.schema || selectedSchema.value;

  // Save dialog first
  let filePath = "";
  const defaultName = `${row.name}.${format}`;

  if (isTauriRuntime()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const filter = format === "csv" ? { name: "CSV", extensions: ["csv"] } : { name: "Excel", extensions: ["xlsx"] };
      const path = await save({
        defaultPath: defaultName,
        filters: [filter],
      });
      if (!path) return;
      filePath = path as string;
    } catch (e: any) {
      toast(e?.message || String(e), 5000);
      return;
    }
  } else {
    const webExportId = generateDatabaseExportId();
    filePath = `__web_export_${webExportId}.${format}`;
  }

  let task: ExportTask | null = null;
  try {
    const queryColumns = props.connection.db_type === "neo4j" ? (await api.getColumns(props.connection.id, props.database, schema || props.database, row.name)).map((column) => column.name) : undefined;

    task = addExportTask(row.name, format, filePath);
    const currentTask = task;
    const request: api.TableExportRequest = {
      exportId: currentTask.exportId,
      connectionId: props.connection.id,
      database: props.database,
      schema,
      tableName: row.name,
      filePath,
      format,
      columns: queryColumns,
      batchSize: settingsStore.editorSettings.exportBatchSize,
    };

    const terminalProgress = await api.startTableExport(request, (progress) => {
      currentTask.rowsExported = progress.rowsExported;
      currentTask.totalRows = progress.totalRows;
      currentTask.status = progress.status;
      currentTask.errorMessage = progress.errorMessage || null;
    });
    if (terminalProgress.status === "Done") {
      toast(t("grid.exported"));
    }
  } catch (e: any) {
    if (task) {
      task.status = "Error";
      task.errorMessage = e?.message || String(e);
    }
    toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function requestDuplicateStructure(row: ObjectBrowserRow) {
  duplicateTarget.value = row;
  duplicateTableName.value = `${row.name}_copy`;
  showDuplicateDialog.value = true;
}

async function confirmDuplicateStructure() {
  const row = duplicateTarget.value;
  const newName = duplicateTableName.value.trim();
  if (!row || !newName) return;
  showDuplicateDialog.value = false;
  try {
    const schema = row.schema || selectedSchema.value;
    const sql = await buildDuplicateTableStructureSql({
      databaseType: effectiveDatabaseType.value,
      schema,
      sourceName: row.name,
      targetName: newName,
    });
    await api.executeQuery(props.connection.id, props.database, sql, schema);
    toast(t("contextMenu.duplicateStructureSuccess", { name: newName }));
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, schema);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function tableAdminSqlOptions(row: ObjectBrowserRow): TableAdminSqlOptions {
  return {
    databaseType: effectiveDatabaseType.value,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
  };
}

async function refreshTruncatePreviewSql(row: ObjectBrowserRow) {
  truncatePreviewSql.value = "";
  truncatePreviewSql.value = await buildTruncateTableSql(tableAdminSqlOptions(row)).catch(() => "");
}

function requestTruncateTable(row: ObjectBrowserRow) {
  truncateTarget.value = row;
  void refreshTruncatePreviewSql(row);
  showTruncateConfirm.value = true;
}

async function confirmTruncateTable() {
  const row = truncateTarget.value;
  if (!row) return;
  try {
    const sql = truncatePreviewSql.value || (await buildTruncateTableSql(tableAdminSqlOptions(row)));
    await api.executeQuery(props.connection.id, props.database, sql);
    toast(t("contextMenu.truncateTableSuccess", { name: row.name }));
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  truncateTarget.value = null;
}

async function refreshEmptyPreviewSql(row: ObjectBrowserRow) {
  emptyPreviewSql.value = "";
  emptyPreviewSql.value = await buildEmptyTableSql(tableAdminSqlOptions(row)).catch(() => "");
}

function requestEmptyTable(row: ObjectBrowserRow) {
  emptyTarget.value = row;
  void refreshEmptyPreviewSql(row);
  showEmptyConfirm.value = true;
}

async function confirmEmptyTable() {
  const row = emptyTarget.value;
  if (!row) return;
  try {
    const sql = emptyPreviewSql.value || (await buildEmptyTableSql(tableAdminSqlOptions(row)));
    await api.executeQuery(props.connection.id, props.database, sql);
    toast(t("contextMenu.emptyTableSuccess", { name: row.name }));
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  emptyTarget.value = null;
}

async function copyName(row: ObjectBrowserRow) {
  try {
    await copyToClipboard(row.name);
    toast(t("connection.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copySource() {
  if (!sourceContent.value) return;
  try {
    await copyToClipboard(sourceContent.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function editSource() {
  if (!sourceRow.value || !sourceContent.value) return;
  sourceDraft.value = sourceContent.value;
  sourceSaveError.value = "";
  sourceEditing.value = true;
}

function cancelEditSource() {
  sourceEditing.value = false;
  sourceDraft.value = "";
  sourceSaveError.value = "";
}

async function saveSource() {
  if (!sourceRow.value || !sourceDraft.value.trim()) return;
  const row = sourceRow.value;
  const schema = row.schema || selectedSchema.value || props.database;
  sourceSaving.value = true;
  sourceSaveError.value = "";
  try {
    const statements = await buildExecutableObjectSourceStatements({
      databaseType: effectiveDatabaseType.value,
      objectType: row.type as ObjectSourceKind,
      schema,
      name: row.name,
      source: sourceDraft.value,
    });
    for (const sql of statements) {
      if (objectSourceSaveExecutionMode(effectiveDatabaseType.value) === "single") {
        await api.executeQuery(props.connection.id, props.database, sql, schema);
      } else {
        await api.executeScript(props.connection.id, props.database, sql, schema);
      }
    }
    toast(t("objects.sourceSaved"));
    sourceEditing.value = false;
    sourceDraft.value = "";
    await openSource(row);
  } catch (e: any) {
    sourceSaveError.value = e?.message || String(e);
  } finally {
    sourceSaving.value = false;
  }
}

async function loadSchemas() {
  if (!needsSchema.value) {
    schemas.value = [];
    selectedSchema.value = undefined;
    return;
  }
  loadingSchemas.value = true;
  try {
    const names = await api.listSchemas(props.connection.id, props.database);
    schemas.value = names;
    if (!selectedSchema.value || !names.includes(selectedSchema.value)) {
      selectedSchema.value = names.includes("public") ? "public" : names[0];
    }
  } finally {
    loadingSchemas.value = false;
  }
}

async function loadObjects() {
  const id = ++loadId;
  loadingObjects.value = true;
  error.value = "";
  rows.value = [];
  try {
    const schema = needsSchema.value ? selectedSchema.value || "" : props.database;
    const objects: ObjectInfo[] = await api.listObjects(props.connection.id, props.database, schema);
    if (id !== loadId) return;
    rows.value = buildObjectBrowserRows({
      objects,
      database: props.database,
      fallbackSchema: schema,
      needsSchema: needsSchema.value,
    });
    const availableTableIds = new Set(rows.value.filter((row) => row.type === "TABLE").map((row) => row.id));
    setSelectedTableIds(new Set([...selectedTableIds.value].filter((id) => availableTableIds.has(id))));
    expandedPartitionParentIds.value = new Set([...expandedPartitionParentIds.value].filter((id) => rows.value.some((row) => row.id === id && row.partitionCount)));
  } catch (e: any) {
    if (id !== loadId) return;
    error.value = e?.message || String(e);
  } finally {
    if (id === loadId) {
      loadingObjects.value = false;
      if (!userHasSelectedFilter.value && tableCount.value > 0) {
        objectFilter.value = "tables";
      }
    }
  }
}

async function reload() {
  await loadSchemas();
  await loadObjects();
}

function onSchemaChange(value: any) {
  selectedSchema.value = typeof value === "string" && value ? value : undefined;
  emit("schemaChange", selectedSchema.value);
  userHasSelectedFilter.value = false;
  objectFilter.value = "all";
  void loadObjects();
}

function filterCount(filter: ObjectFilter) {
  if (filter === "tables") return tableCount.value;
  if (filter === "views") return viewCount.value;
  if (filter === "procedures") return procedureCount.value;
  if (filter === "functions") return functionCount.value;
  if (filter === "sequences") return sequenceCount.value;
  if (filter === "packages") return packageCount.value;
  return rows.value.length;
}

function filterLabel(filter: ObjectFilter) {
  const key = filter === "tables" ? "objects.tables" : filter === "views" ? "objects.views" : filter === "procedures" ? "objects.procedures" : filter === "functions" ? "objects.functions" : filter === "sequences" ? "objects.sequences" : filter === "packages" ? "objects.packages" : "objects.all";
  return `${t(key)} ${filterCount(filter)}`;
}

function getSearchInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-object-search-input]") ?? null;
}

function focusSearch(): boolean {
  const input = getSearchInput();
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (!isCancelSearchShortcut(event)) return;
  event.preventDefault();
  search.value = "";
}

defineExpose({ focusSearch });

watch(
  () => [props.connection.id, props.database, props.schema] as const,
  () => {
    selectedSchema.value = props.schema;
    userHasSelectedFilter.value = false;
    objectFilter.value = "all";
    clearTableSelection();
    void reload();
  },
  { immediate: true },
);

// ---- CustomContextMenu helpers ----

function exportDataSubmenu(item: ObjectBrowserRow): ContextMenuItem {
  return {
    label: t("contextMenu.exportData"),
    icon: Upload,
    children: [
      { label: "CSV", action: () => exportData(item, "csv") },
      { label: "JSON", action: () => exportData(item, "json") },
      { label: "SQL INSERT", action: () => exportData(item, "sql") },
      { label: "XLSX", action: () => exportDataXlsx(item) },
    ],
  };
}

function getTableMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    { label: t("contextMenu.viewData"), action: () => openRow(item), icon: Table2 },
    {
      label: t("contextMenu.viewDdl"),
      action: () => {
        ddlDialogTarget.value = item;
        showDdlDialog.value = true;
      },
      icon: FileCode,
    },
    ...(canOpenStructureEditor.value ? [{ label: t("contextMenu.editStructure"), action: () => openStructureEditor(item), icon: PencilRuler }] : []),
    ...(canRename(item) ? [{ label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { label: t("contextMenu.newQuery"), action: () => openNewQuery(item), icon: TerminalSquare },
    ...(canOpenDiagram.value ? [{ label: t("diagram.open"), action: () => openDiagram(item), icon: Network }] : []),
    ...(canOpenTableImport.value ? [{ label: t("contextMenu.importData"), action: () => openTableImport(item), icon: Download }] : []),
    { label: t("dataCompare.title"), action: () => openDataCompare(item), icon: ArrowRightLeft },
    { label: "", separator: true },
    exportDataSubmenu(item),
    { label: t("contextMenu.exportDatabase"), action: () => openDatabaseExport(item), icon: Upload },
    { label: t("contextMenu.exportStructure"), action: () => exportStructure(item), icon: FileCode },
    { label: "", separator: true },
    { label: t("contextMenu.duplicateStructure"), action: () => requestDuplicateStructure(item), icon: CopyPlus },
    { label: "", separator: true },
    ...(supportsTruncateTable.value
      ? [
          {
            label: t("contextMenu.truncateTable"),
            action: () => requestTruncateTable(item),
            icon: Scissors,
            variant: "destructive" as const,
          },
        ]
      : []),
    {
      label: t("contextMenu.emptyTable"),
      action: () => requestEmptyTable(item),
      icon: Eraser,
      variant: "destructive" as const,
    },
    {
      label: t("contextMenu.dropTable"),
      action: () => requestDrop(item),
      icon: Trash2,
      variant: "destructive" as const,
    },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getViewMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    { label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
    { label: t("contextMenu.editView"), action: () => openSource(item), icon: PencilLine },
    { label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    { label: t("contextMenu.viewDdl"), action: () => openViewDdl(item), icon: ScrollText },
    ...(canRename(item) ? [{ label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { label: t("contextMenu.newQuery"), action: () => openNewQuery(item), icon: TerminalSquare },
    ...(canOpenDiagram.value ? [{ label: t("diagram.open"), action: () => openDiagram(item), icon: Network }] : []),
    { label: "", separator: true },
    exportDataSubmenu(item),
    { label: t("contextMenu.exportDatabase"), action: () => openDatabaseExport(item), icon: Upload },
    { label: t("contextMenu.exportStructure"), action: () => exportStructure(item), icon: FileCode },
    { label: "", separator: true },
    {
      label: t("contextMenu.dropView"),
      action: () => requestDrop(item),
      icon: Trash2,
      variant: "destructive" as const,
    },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getProcFuncMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    ...(item.type === "PROCEDURE" ? [{ label: t("contextMenu.executeProcedure"), action: () => openProcedureExecution(item), icon: Play }] : []),
    { label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    ...(canRename(item) ? [{ label: t("contextMenu.renameObject"), action: () => requestRename(item), icon: Pencil }] : []),
    { label: "", separator: true },
    {
      label: item.type === "PROCEDURE" ? t("contextMenu.dropProcedure") : t("contextMenu.dropFunction"),
      action: () => requestDrop(item),
      icon: Trash2,
      variant: "destructive" as const,
    },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getPackageMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  return [
    { label: t("contextMenu.viewSource"), action: () => openSource(item), icon: Code2 },
    { label: "", separator: true },
    { label: t("contextMenu.copyName"), action: () => copyName(item), icon: Copy },
  ];
}

function getObjectBrowserMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  if (item.type === "TABLE") return getTableMenuItems(item);
  if (item.type === "VIEW" || item.type === "MATERIALIZED_VIEW") return getViewMenuItems(item);
  if (item.type === "SEQUENCE") return getPackageMenuItems(item);
  if (item.type === "PACKAGE" || item.type === "PACKAGE_BODY") return getPackageMenuItems(item);
  return getProcFuncMenuItems(item);
}
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Table2 class="h-4 w-4 text-muted-foreground" />
        <div class="min-w-0 truncate text-sm font-medium">
          {{ props.database }}<template v-if="selectedSchema"> / {{ selectedSchema }}</template>
        </div>
        <div class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">{{ filteredRows.length }} / {{ rows.length }}</div>
      </div>
      <div class="flex min-w-[240px] flex-1 items-center gap-2">
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input v-model="search" data-object-search-input class="h-7 text-xs" :placeholder="t('objects.search')" @keydown="onSearchKeydown" />
        <div v-if="showObjectFilter" class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
          <button
            v-for="filter in objectFilters"
            :key="filter"
            type="button"
            class="h-6 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            :class="{ 'bg-background text-foreground shadow-sm': objectFilter === filter }"
            @click="
              userHasSelectedFilter = true;
              objectFilter = filter;
            "
          >
            {{ filterLabel(filter) }}
          </button>
        </div>
      </div>
      <Select v-if="needsSchema" :model-value="selectedSchema" :disabled="loadingSchemas" @update:model-value="onSchemaChange">
        <SelectTrigger class="h-7 w-36 text-xs">
          <SelectValue :placeholder="loadingSchemas ? t('objects.loadingSchemas') : t('objects.schema')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="schema in schemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="loadingObjects" @click="reload">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingObjects }" />
      </Button>
    </div>
    <div v-if="selectedTableCount > 0" class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/30 px-3 text-xs">
      <div class="min-w-0 flex-1 truncate text-muted-foreground">
        {{ t("objects.selectedTables", { count: selectedTableCount }) }}
      </div>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openBatchDatabaseExport">
        <Download class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.exportSelected") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchDropTables">
        <Trash2 class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.dropSelected") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearTableSelection">
        <X class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.clearSelection") }}
      </Button>
    </div>

    <div v-if="loadingObjects" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("objects.loading") }}
    </div>
    <div v-else-if="error" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
      {{ error }}
    </div>
    <div v-else-if="filteredRows.length === 0" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      {{ t("objects.empty") }}
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <div class="grid h-8 shrink-0 items-center gap-3 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground" :style="{ gridTemplateColumns }">
        <button class="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent" type="button" :disabled="visibleSelectableRows.length === 0" @click="toggleVisibleTableSelection">
          <CheckSquare v-if="allVisibleTablesSelected" class="h-3.5 w-3.5 text-primary" />
          <Square v-else class="h-3.5 w-3.5" />
        </button>
        <button class="flex min-w-0 items-center gap-1 truncate text-left" type="button" @click="toggleSort('name')">
          <span class="truncate">{{ t("objects.name") }}</span>
          <component :is="sortIconFor('name')" v-if="sortIconFor('name')" class="h-3 w-3 shrink-0" />
        </button>
        <button class="flex min-w-0 items-center gap-1 truncate text-left" type="button" @click="toggleSort('type')">
          <span class="truncate">{{ t("objects.type") }}</span>
          <component :is="sortIconFor('type')" v-if="sortIconFor('type')" class="h-3 w-3 shrink-0" />
        </button>
        <button v-if="hasCreatedAt" class="flex min-w-0 items-center gap-1 truncate text-left" type="button" @click="toggleSort('created_at')">
          <span class="truncate">{{ t("objects.createdAt") }}</span>
          <component :is="sortIconFor('created_at')" v-if="sortIconFor('created_at')" class="h-3 w-3 shrink-0" />
        </button>
        <button v-if="hasUpdatedAt" class="flex min-w-0 items-center gap-1 truncate text-left" type="button" @click="toggleSort('updated_at')">
          <span class="truncate">{{ t("objects.updatedAt") }}</span>
          <component :is="sortIconFor('updated_at')" v-if="sortIconFor('updated_at')" class="h-3 w-3 shrink-0" />
        </button>
        <button v-if="hasComments" class="flex min-w-0 items-center gap-1 truncate text-left" type="button" @click="toggleSort('comment')">
          <span class="truncate">{{ t("objects.comment") }}</span>
          <component :is="sortIconFor('comment')" v-if="sortIconFor('comment')" class="h-3 w-3 shrink-0" />
        </button>
      </div>
      <RecycleScroller class="object-browser-scroller min-h-0 flex-1" :items="filteredRows" :item-size="38" :buffer="600" :skip-hover="true" key-field="id">
        <template #default="{ item }">
          <CustomContextMenu :items="getObjectBrowserMenuItems(item)" v-slot="{ onContextMenu }">
            <div
              class="grid h-[38px] cursor-pointer items-center gap-3 border-b px-3 hover:bg-accent/50"
              :class="{
                'bg-accent/40': sourceRow?.id === item.id,
                'bg-primary/5': selectedTableIds.has(item.id),
              }"
              :style="{ gridTemplateColumns }"
              @click="onRowClick(item, $event)"
              @contextmenu="onContextMenu"
            >
              <button class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" :class="{ invisible: item.type !== 'TABLE' }" @click.stop="toggleTableSelection(item)">
                <CheckSquare v-if="selectedTableIds.has(item.id)" class="h-3.5 w-3.5 text-primary" />
                <Square v-else class="h-3.5 w-3.5" />
              </button>
              <div class="flex min-w-0 items-center gap-2">
                <button
                  v-if="item.partitionCount"
                  type="button"
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  :aria-label="t('objects.partitions', { count: item.partitionCount })"
                  @click.stop="togglePartitionParent(item)"
                >
                  <ChevronDown v-if="isPartitionParentExpanded(item)" class="h-3.5 w-3.5" />
                  <ChevronRight v-else class="h-3.5 w-3.5" />
                </button>
                <span v-else class="h-5 w-5 shrink-0" :class="{ 'ml-4': item.partitionParentId }" />
                <component :is="iconFor(item)" class="h-3.5 w-3.5 shrink-0" :class="iconClass(item.type)" />
                <span class="truncate text-[13px] font-medium text-foreground">{{ item.name }}</span>
                <span v-if="item.partitionCount" class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                  {{ t("objects.partitions", { count: item.partitionCount }) }}
                </span>
              </div>
              <div class="truncate text-xs text-muted-foreground">{{ typeLabel(item.type) }}</div>
              <div v-if="hasCreatedAt" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.created_at)">
                {{ formatObjectBrowserTimestamp(item.created_at) }}
              </div>
              <div v-if="hasUpdatedAt" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.updated_at)">
                {{ formatObjectBrowserTimestamp(item.updated_at) }}
              </div>
              <div v-if="hasComments" class="truncate text-xs text-muted-foreground" :title="item.comment || ''">
                {{ item.comment || "" }}
              </div>
            </div>
          </CustomContextMenu>
        </template>
      </RecycleScroller>
      <div v-if="sourceRow" class="flex h-[42%] min-h-44 shrink-0 flex-col border-t bg-background">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
          <Code2 class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ sourceTitle(sourceRow) }}</span>
          <Button v-if="sourceEditing" variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="sourceSaving || !sourceDraft.trim()" @click="saveSource">
            <Loader2 v-if="sourceSaving" class="mr-1 h-3 w-3 animate-spin" />
            {{ t("objects.saveSource") }}
          </Button>
          <Button v-if="sourceEditing" variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="sourceSaving" @click="cancelEditSource">
            {{ t("objects.cancelEdit") }}
          </Button>
          <Button v-if="!sourceEditing" variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="copySource">
            <Copy class="h-3 w-3" />
          </Button>
          <Button v-if="!sourceEditing" variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="editSource">
            <PencilLine class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeSource">
            <X class="h-3 w-3" />
          </Button>
        </div>
        <div v-if="sourceLoading" class="flex flex-1 items-center justify-center">
          <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="sourceError" class="flex flex-1 items-center justify-center px-4 text-sm text-destructive">
          {{ sourceError }}
        </div>
        <div v-else-if="sourceEditing" class="flex min-h-0 flex-1 flex-col" data-object-source-editor>
          <QueryEditor v-model="sourceDraft" class="min-h-0 flex-1" :connection-id="props.connection.id" :database="props.database" :schema="selectedSchema" :database-type="props.connection.db_type" :dialect="sourceDialect" :format-dialect="sourceFormatDialect" force-word-wrap @save="saveSource" />
          <div v-if="sourceSaveError" class="shrink-0 border-t px-3 py-2 text-xs text-destructive">
            {{ sourceSaveError }}
          </div>
        </div>
        <QueryEditor
          v-else
          :key="`source-preview-${sourceRow.id}`"
          :model-value="sourceContent"
          class="min-h-0 flex-1"
          :connection-id="props.connection.id"
          :database="props.database"
          :schema="selectedSchema"
          :database-type="props.connection.db_type"
          :dialect="sourceDialect"
          :format-dialect="sourceFormatDialect"
          force-word-wrap
          read-only
          data-object-source-preview
        />
      </div>
    </div>
  </div>

  <DangerConfirmDialog v-model:open="showDropConfirm" :title="dropConfirmTitle()" :details="dropConfirmMessage()" :confirm-label="t('dangerDialog.deleteConfirm')" @confirm="confirmDrop" />

  <DangerConfirmDialog v-model:open="showBatchDropConfirm" :title="t('objects.confirmBatchDropTitle')" :message="t('objects.confirmBatchDropMessage', { count: selectedTableCount })" :sql="batchDropPreviewSql" :confirm-label="t('objects.dropSelected')" @confirm="confirmBatchDropTables" />

  <Dialog v-model:open="showRenameDialog">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.renameObjectTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <Input v-model="renameInput" :placeholder="t('contextMenu.renameObjectNamePlaceholder')" @keydown.enter.prevent="confirmRename" />
        <pre v-if="renamePreviewSqlText" class="max-h-32 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap" v-html="highlight(renamePreviewSqlText)"></pre>
        <p v-if="renameError" class="text-sm text-destructive">{{ renameError }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="showRenameDialog = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!renameInput.trim() || renameInput.trim() === renameTarget?.name" @click="confirmRename">
          {{ t("contextMenu.renameObject") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showTruncateConfirm"
    :title="t('contextMenu.confirmTruncateTableTitle')"
    :message="t('contextMenu.confirmTruncateTableMessage', { name: truncateTarget?.name ?? '' })"
    :sql="truncatePreviewSql"
    :confirm-label="t('contextMenu.truncateTable')"
    @confirm="confirmTruncateTable"
  />

  <DangerConfirmDialog v-model:open="showEmptyConfirm" :title="t('contextMenu.confirmEmptyTableTitle')" :message="t('contextMenu.confirmEmptyTableMessage', { name: emptyTarget?.name ?? '' })" :sql="emptyPreviewSql" :confirm-label="t('contextMenu.emptyTable')" @confirm="confirmEmptyTable" />

  <ProcedureExecutionDialog
    v-if="procedureExecutionTarget"
    v-model:open="showProcedureExecutionConfirm"
    :connection-id="props.connection.id"
    :database="props.database"
    :database-type="props.connection.db_type"
    :schema="procedureExecutionTarget.schema || selectedSchema"
    :routine-name="procedureExecutionTarget.name"
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
        <Button :disabled="!duplicateTableName.trim()" @click="confirmDuplicateStructure">
          {{ t("dangerDialog.confirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DdlViewDialog v-if="ddlDialogTarget" :connection-id="props.connection.id" :database="props.database" :schema="ddlDialogTarget.schema || selectedSchema" :table-name="ddlDialogTarget.name" :dialect="sourceDialect" v-model:open="showDdlDialog" />
</template>

<style scoped>
.object-browser-scroller {
  will-change: scroll-position;
  contain: content;
}

.object-browser-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}
</style>
