<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, ref, watch, type Component } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  Braces,
  CheckSquare,
  Clipboard,
  Code2,
  Copy,
  CopyPlus,
  ChevronDown,
  ChevronRight,
  Download,
  Eraser,
  Eye,
  FileCode,
  GripVertical,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
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
  RotateCcw,
  Scissors,
  Search,
  ScrollText,
  Square,
  Table2,
  TableProperties,
  TerminalSquare,
  Trash2,
  WrapText,
  X,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ProcedureExecutionDialog from "@/components/objects/ProcedureExecutionDialog.vue";
import * as api from "@/lib/backend/api";
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, IndexInfo, ObjectBrowserViewMode, ObjectBrowserViewport, ObjectInfo, ObjectSourceKind, ObjectStatistics, TableInfoTab, TriggerInfo } from "@/types/database";
import { sortTablesByFkDependency, type TableWithFk } from "@/lib/table/tableDependencySort";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { supportsSchemaDiagram, supportsTableImport, supportsTableStructureEditing, supportsTableTruncate } from "@/lib/database/databaseFeatureSupport";
import { codeMirrorSqlDialect, connectionObjectTreeNodeSchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { getTableMetadataCapabilities, type TableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { buildDropObjectSql, buildDropTableSql, buildDuplicateTableStructureSql, buildCopyTableDataSql, buildEmptyTableSql, buildTruncateTableSql, supportsDropTableCascade, supportsTruncateTableCascade, type TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import { useToast } from "@/composables/useToast";
import { buildExecutableObjectSourceStatements, buildRoutineRenameObjectSourceStatements, executeObjectSourceSave, supportsSourceBackedRoutineRename } from "@/lib/table/objectSourceEditor";
import { buildRenameObjectSql, supportsObjectRename } from "@/lib/table/objectRenameSql";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { generateDatabaseExportId } from "@/lib/export/databaseExport";
import { copyToClipboard, eventTargetAllowsAppClipboardShortcut } from "@/lib/common/clipboard";
import { defaultPasteTableMode, pasteTableModeCopiesData, supportsWholeRowTableDataCopy, tableClipboardMatchesTarget, tableDataCopyColumnOptions, type PasteTableMode, type TableClipboardContext } from "@/lib/table/tableClipboard";
import { formatSqlInsert } from "@/lib/export/exportFormats";
import { buildSingleDdlExportFileContent } from "@/lib/export/ddlExport";
import { fetchTableDataForExport } from "@/lib/table/tableDataExport";
import { useConnectionStore } from "@/stores/connectionStore";
import { useExportTracker, type ExportTask } from "@/composables/useExportTracker";
import { useSettingsStore } from "@/stores/settingsStore";
import { useQueryStore } from "@/stores/queryStore";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import { sqlFormatDialectForDbType, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { isCancelSearchShortcut } from "@/lib/editor/keyboardShortcuts";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { formatShortcut } from "@/lib/editor/shortcutRegistry";
import { batchTableEmptyFeedback, buildBatchTableEmptyPlan, runBatchTableEmpty, type BatchTableEmptyPlanItem } from "@/lib/sidebar/batchTableEmpty";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  buildObjectBrowserRows,
  countObjectBrowserRowsByFilter,
  formatObjectBrowserBytes,
  formatObjectBrowserCount,
  formatObjectBrowserTimestamp,
  initialObjectBrowserSortDirection,
  sortObjectBrowserRows,
  summarizeObjectBrowserSearch,
  type ObjectBrowserFilter,
  type ObjectBrowserRow,
  type ObjectBrowserSortDirection,
  type ObjectBrowserSortKey,
} from "@/lib/table/objectBrowserRows";
import { isSourceOnlyObjectBrowserRow, resolveRowClickAction, shouldDeferSingleClick, type ObjectBrowserRowAction } from "@/lib/table/objectBrowserRowAction";
import { filterObjectBrowserTableColumns } from "@/lib/table/objectBrowserTableInfo";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { runBatchTableTruncate } from "@/lib/table/batchTableTruncate";
import { tableColumnDefaultDisplayValue } from "@/lib/table/tableColumnDefaultPresentation";

type ObjectFilter = ObjectBrowserFilter;
type ObjectBrowserColumnKey = "select" | "name" | "type" | "estimatedRows" | "totalBytes" | "created_at" | "updated_at" | "comment";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  catalog?: string;
  schema?: string;
  viewport?: ObjectBrowserViewport;
}>();

const emit = defineEmits<{
  openTable: [target: { tableName: string; schema?: string; tableType?: string; catalog?: string }];
  schemaChange: [schema: string | undefined];
  viewportChange: [viewport: ObjectBrowserViewport];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const refreshTooltip = computed(() => {
  const shortcut = formatShortcut(settingsStore.editorSettings.shortcuts.refreshData);
  return shortcut ? `${t("grid.refresh")} (${shortcut})` : t("grid.refresh");
});

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
const sourceCanEdit = ref(true);
// --- Right-side panel state ---
// Unified panel: either "table-info" (for tables) or "source" (for views/procedures/etc.)
const sidePanelRow = ref<ObjectBrowserRow | null>(null);
const sidePanelMode = ref<"table-info" | "source">("source");
// Table info panel state
const tableInfoTab = ref<TableInfoTab>("ddl");
const tableColumns = ref<ColumnInfo[]>([]);
const tableColumnsLoading = ref(false);
const tableDdlContent = ref("");
const tableDdlLoading = ref(false);
const tableIndexes = ref<IndexInfo[]>([]);
const tableIndexesLoading = ref(false);
const tableForeignKeys = ref<ForeignKeyInfo[]>([]);
const tableForeignKeysLoading = ref(false);
const tableTriggers = ref<TriggerInfo[]>([]);
const tableTriggersLoading = ref(false);
const tableInfoSearchQuery = ref("");
const tableInfoWrap = ref(true);
const tableInfoDdlPreRef = ref<HTMLPreElement | null>(null);
const SIDE_PANEL_MIN_WIDTH = 280;
const SIDE_PANEL_MAX_WIDTH = 900;
const sidePanelWidth = ref(settingsStore.editorSettings.tableInfoDrawerWidth || 420);
let sidePanelResizeStartX = 0;
let sidePanelResizeStartWidth = 0;
const isResizingSidePanel = ref(false);
const sidePanelGuard = createSidePanelRequestGuard();
const tableMetadataCapabilities = computed<TableMetadataCapabilities>(() => getTableMetadataCapabilities(effectiveDatabaseType.value));
const effectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const tableStructureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(props.connection) ?? props.connection.db_type);
const sourceEditableText = ref("");
const sourceDraft = ref("");
const sourceSaving = ref(false);
const sourceSaveError = ref("");
const error = ref("");
const showDropConfirm = ref(false);
const dropTarget = ref<ObjectBrowserRow | null>(null);
const dropPreviewSql = ref("");
const dropTableCascade = ref(false);
const batchDropCascade = ref(false);
const showRenameDialog = ref(false);
const renameTarget = ref<ObjectBrowserRow | null>(null);
const renameInput = ref("");
const renameError = ref("");
const renamePreviewSqlText = ref("");
const showTruncateConfirm = ref(false);
const truncateTarget = ref<ObjectBrowserRow | null>(null);
const truncatePreviewSql = ref("");
const truncateTableCascade = ref(false);
const showEmptyConfirm = ref(false);
const emptyTarget = ref<ObjectBrowserRow | null>(null);
const emptyPreviewSql = ref("");
const showDuplicateDialog = ref(false);
const duplicateTarget = ref<ObjectBrowserRow | null>(null);
const duplicateTableName = ref("");
const showProcedureExecutionConfirm = ref(false);
const procedureExecutionTarget = ref<ObjectBrowserRow | null>(null);
const selectedTableIds = ref<Set<string>>(new Set());
const expandedPartitionParentIds = ref<Set<string>>(new Set());
const showBatchDropConfirm = ref(false);
const batchDropPreviewSql = ref("");
const showBatchTruncateConfirm = ref(false);
const batchTruncatePreviewSql = ref("");
const batchTruncateCascade = ref(false);
const showBatchEmptyConfirm = ref(false);
const batchEmptyPreviewSql = ref("");
const batchEmptyPlan = ref<BatchTableEmptyPlanItem<ObjectBrowserRow>[]>([]);
// Paste table dialog state
const showPasteDialog = ref(false);
const pasteTableMode = ref<PasteTableMode>("structure-and-data");
const pasteTableEntries = ref<{ sourceName: string; targetName: string; schema?: string }[]>([]);
const pasteTableDataCopySupported = computed(() => supportsWholeRowTableDataCopy(effectiveDatabaseType.value));
const objectColumnWidths = ref<Record<ObjectBrowserColumnKey, number>>({
  select: 34,
  name: 260,
  type: 110,
  estimatedRows: 110,
  totalBytes: 100,
  created_at: 150,
  updated_at: 150,
  comment: 260,
});
let loadId = 0;
let stopColumnResize: (() => void) | null = null;
let preserveObjectFilterScrollOnce = false;

// Export via background tracker
const { addTask: addExportTask } = useExportTracker();

const needsSchema = computed(() => isSchemaAware(props.connection.db_type) && !connectionUsesDatabaseObjectTreeMode(props.connection));
const canDropTargetCascade = computed(() => dropTarget.value?.type === "TABLE" && supportsDropTableCascade(effectiveDatabaseType.value));
const canTruncateTargetCascade = computed(() => !!truncateTarget.value && supportsTruncateTableCascade(effectiveDatabaseType.value));
const objectCounts = computed(() => countObjectBrowserRowsByFilter(rows.value));
// Count direct search matches once; partition parents rendered only for context must not inflate badges.
const objectSearchSummary = computed(() => summarizeObjectBrowserSearch(rows.value, search.value));
const canOpenStructureEditor = computed(() => supportsTableStructureEditing(tableStructureDatabaseType.value));
const canOpenDiagram = computed(() => !!props.database && supportsSchemaDiagram(effectiveDatabaseType.value));
const canOpenTableImport = computed(() => !!props.database && supportsTableImport(effectiveDatabaseType.value));
const supportsTruncateTable = computed(() => supportsTableTruncate(effectiveDatabaseType.value));
const sourceDialect = computed(() => codeMirrorSqlDialect(effectiveDatabaseType.value));
const sourceFormatDialect = computed<SqlFormatDialect>(() => sqlFormatDialectForDbType(effectiveDatabaseType.value));
const objectFilters = computed<ObjectFilter[]>(() =>
  (
    [
      ["all", objectCounts.value.all],
      ["tables", objectCounts.value.tables],
      ["views", objectCounts.value.views],
      ["materializedViews", objectCounts.value.materializedViews],
      ["procedures", objectCounts.value.procedures],
      ["functions", objectCounts.value.functions],
      ["triggers", objectCounts.value.triggers],
      ["sequences", objectCounts.value.sequences],
      ["packages", objectCounts.value.packages],
      ["types", objectCounts.value.types],
    ] as Array<[ObjectFilter, number]>
  )
    .filter(([filter, count]) => filter === "all" || count > 0)
    .map(([filter]) => filter),
);
const showObjectFilter = computed(() => objectFilters.value.length > 2);
const hasCreatedAt = computed(() => rows.value.some((row) => row.created_at?.trim()));
const hasUpdatedAt = computed(() => rows.value.some((row) => row.updated_at?.trim()));
const hasAnyComment = computed(() => rows.value.some((row) => row.comment?.trim()));
const isListView = computed(() => settingsStore.editorSettings.objectBrowserViewMode !== "grid");

type ObjectBrowserScroller =
  | HTMLElement
  | {
      scrollToItem?: (index: number) => void;
      scrollToPosition?: (position: number) => void;
      $el?: HTMLElement;
      el?: HTMLElement | { value?: HTMLElement | null };
    };

// RecycleScroller exposes scroll helpers on its component instance. Keep the
// type loose because vue-virtual-scroller does not ship complete ref typings.
const listScrollerRef = ref<ObjectBrowserScroller | null>(null);
const gridScrollerRef = ref<ObjectBrowserScroller | null>(null);
let viewportFrame = 0;
let restoreViewportFrame = 0;

function objectBrowserViewMode(): ObjectBrowserViewMode {
  return isListView.value ? "list" : "grid";
}

function activeScroller() {
  return isListView.value ? listScrollerRef.value : gridScrollerRef.value;
}

function scrollerElement(scroller: ObjectBrowserScroller | null = activeScroller()): HTMLElement | null {
  if (!scroller) return null;
  if (scroller instanceof HTMLElement) return scroller;
  if (scroller.$el instanceof HTMLElement) return scroller.$el;
  if (scroller.el instanceof HTMLElement) return scroller.el;
  if (scroller.el?.value instanceof HTMLElement) return scroller.el.value;
  return null;
}

function emitViewportChange(scrollTop: number) {
  const viewport: ObjectBrowserViewport = {
    scrollTop: Math.max(0, Math.round(scrollTop)),
    viewMode: objectBrowserViewMode(),
  };
  if (props.viewport?.scrollTop === viewport.scrollTop && props.viewport.viewMode === viewport.viewMode) return;
  emit("viewportChange", viewport);
}

function onObjectsScroll() {
  if (viewportFrame) return;
  viewportFrame = window.requestAnimationFrame(() => {
    viewportFrame = 0;
    const el = scrollerElement();
    if (!el) return;
    emitViewportChange(el.scrollTop);
  });
}

function applyObjectBrowserScrollTop(scrollTop: number) {
  const scroller = activeScroller();
  if (scroller && !(scroller instanceof HTMLElement)) {
    scroller.scrollToPosition?.(scrollTop);
    if (scrollTop === 0) scroller.scrollToItem?.(0);
  }
  const el = scrollerElement(scroller);
  if (el) el.scrollTop = scrollTop;
}

function restoreObjectBrowserViewport() {
  const viewport = props.viewport;
  if (!viewport || viewport.viewMode !== objectBrowserViewMode()) return;
  if (restoreViewportFrame) window.cancelAnimationFrame(restoreViewportFrame);
  const scrollTop = Math.max(0, viewport.scrollTop);
  nextTick(() => {
    applyObjectBrowserScrollTop(scrollTop);
    restoreViewportFrame = window.requestAnimationFrame(() => {
      applyObjectBrowserScrollTop(scrollTop);
      restoreViewportFrame = 0;
    });
  });
}

function scrollObjectsToTop() {
  // Read the active scroller inside nextTick so that after a list <-> grid
  // switch the (re)mounted scroller is the one we reset.
  emitViewportChange(0);
  nextTick(() => {
    applyObjectBrowserScrollTop(0);
  });
}

watch(
  [listScrollerRef, gridScrollerRef, isListView],
  (_value, _oldValue, onCleanup) => {
    const el = scrollerElement();
    if (!el) return;
    el.addEventListener("scroll", onObjectsScroll, { passive: true });
    restoreObjectBrowserViewport();
    onCleanup(() => el.removeEventListener("scroll", onObjectsScroll));
  },
  { flush: "post" },
);

onActivated(() => {
  restoreObjectBrowserViewport();
});

function setViewMode(mode: "list" | "grid") {
  settingsStore.updateEditorSettings({ objectBrowserViewMode: mode });
  scrollObjectsToTop();
}

// Re-sorting reorders the rows; jump to the top so the new head is visible
// instead of leaving the view parked at a stale mid-scroll position.
// Note: watch(sortKeyOptions) may reset sortKey during setup when the persisted key
// is no longer valid, triggering this watcher before any scroller is mounted —
// scrollObjectsToTop() handles that safely via optional chaining.
watch([sortKey, sortDirection], () => scrollObjectsToTop());

// Also jump to the top when the search query or object-type filter changes —
// filtered results bear no relation to the previous scroll position.
watch(search, () => scrollObjectsToTop());
watch(objectFilter, () => {
  if (preserveObjectFilterScrollOnce) {
    preserveObjectFilterScrollOnce = false;
    return;
  }
  scrollObjectsToTop();
});

const showCheckboxColumn = computed(() => settingsStore.editorSettings.objectBrowserShowCheckbox || selectedTableCount.value > 0);

function toggleCheckboxColumn() {
  const next = !settingsStore.editorSettings.objectBrowserShowCheckbox;
  settingsStore.updateEditorSettings({ objectBrowserShowCheckbox: next });
  if (!next) clearTableSelection();
}

const objectBrowserColumns = computed<ObjectBrowserColumnKey[]>(() => {
  const columns: ObjectBrowserColumnKey[] = [];
  if (showCheckboxColumn.value) columns.push("select");
  columns.push("name", "type", "estimatedRows", "totalBytes");
  if (hasCreatedAt.value) columns.push("created_at");
  if (hasUpdatedAt.value) columns.push("updated_at");
  columns.push("comment");
  return columns;
});
const gridTemplateColumns = computed(() => {
  return objectBrowserColumns.value
    .map((key, index, columns) => {
      const width = objectColumnWidths.value[key];
      if (key === "select") return `${width}px`;
      if (index === columns.length - 1) return `minmax(${width}px,1fr)`;
      return `${width}px`;
    })
    .join(" ");
});
const objectGridMinWidth = computed(() => {
  return objectBrowserColumns.value.reduce((total, key) => total + objectColumnWidths.value[key], 0) + Math.max(0, objectBrowserColumns.value.length - 1) * 12 + 24;
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

// ---- Grid (tile) view virtualization ----
// The grid view chunks filteredRows into fixed-height rows and hands them to
// RecycleScroller, mirroring the list view so only visible rows are mounted.
// The previous flat `v-for` rendered every card (plus its CustomContextMenu)
// at once, which stalls the UI on schemas with thousands of objects.
const OBJECT_GRID_MIN_CARD_WIDTH = 160; // former `minmax(160px, 1fr)` floor
const OBJECT_GRID_GAP = 12; // 0.75rem, former grid gap (both axes)
// Card height is dataset-stable: if any object has timestamps/comments, every card
// reserves those slots (even when empty) so borders stay level across a row.
// objectGridRowHeight adapts to the dataset instead of always using the worst case.
//   Base: p-3 top+bottom(24) + icon h-11(44) + name(18) + type/bytes(18) + gap-1×2(8) = 112
//   + optional timestamp row: text-[10px](15) + gap-1(4) = 19
//   + optional comment row:   text-[10px](15) + gap-1(4) = 19
// If the card gains a new metadata row, add a matching constant and include it below.
const OBJECT_GRID_CARD_BASE_H = 112;
const OBJECT_GRID_CARD_TIMESTAMP_H = 19;
const OBJECT_GRID_CARD_COMMENT_H = 19;
const OBJECT_GRID_CARD_SAFETY = 6; // buffer for sub-pixel font differences

const objectGridRowHeight = computed(() => {
  let cardH = OBJECT_GRID_CARD_BASE_H;
  if (hasCreatedAt.value || hasUpdatedAt.value) cardH += OBJECT_GRID_CARD_TIMESTAMP_H;
  if (hasAnyComment.value) cardH += OBJECT_GRID_CARD_COMMENT_H;
  return cardH + OBJECT_GRID_GAP + OBJECT_GRID_CARD_SAFETY;
});
const gridContainerRef = ref<HTMLElement | null>(null);
const gridColumns = ref(1);
let gridResizeObserver: ResizeObserver | null = null;

function recomputeGridColumns(width: number) {
  gridColumns.value = Math.max(1, Math.floor((width + OBJECT_GRID_GAP) / (OBJECT_GRID_MIN_CARD_WIDTH + OBJECT_GRID_GAP)));
}

// The grid container lives inside a v-else, so it mounts/unmounts when the user
// toggles list <-> grid. Watch the template ref to (re)attach the observer each
// time the node appears, instead of once in onMounted (which would miss the
// case where the browser starts in list mode).
watch(
  gridContainerRef,
  (el, prevEl) => {
    if (prevEl) {
      gridResizeObserver?.disconnect();
      gridResizeObserver = null;
    }
    if (!el) return;
    // Use the content-box width (excluding padding) to match what ResizeObserver
    // delivers via entry.contentRect.width, avoiding a 1-frame column jump on mount.
    const style = getComputedStyle(el);
    recomputeGridColumns(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    gridResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) recomputeGridColumns(entry.contentRect.width);
    });
    gridResizeObserver.observe(el);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  gridResizeObserver?.disconnect();
  gridResizeObserver = null;
  if (viewportFrame) window.cancelAnimationFrame(viewportFrame);
  if (restoreViewportFrame) window.cancelAnimationFrame(restoreViewportFrame);
  window.removeEventListener("mousemove", onSidePanelResizeMove);
  window.removeEventListener("mouseup", onSidePanelResizeEnd);
  if (singleClickTimer) {
    clearTimeout(singleClickTimer);
    singleClickTimer = null;
  }
});

const gridRows = computed(() => {
  const cols = gridColumns.value;
  const cards = filteredRows.value;
  const rows: Array<{ key: string; cards: ObjectBrowserRow[] }> = [];
  for (let i = 0; i < cards.length; i += cols) {
    rows.push({ key: `row-${i}`, cards: cards.slice(i, i + cols) });
  }
  return rows;
});
const visibleSelectableRows = computed(() => filteredRows.value.filter((row) => row.type === "TABLE"));
const selectedTableRows = computed(() => {
  const ids = selectedTableIds.value;
  return selectableRows.value.filter((row) => ids.has(row.id));
});
const selectedTableCount = computed(() => selectedTableRows.value.length);
const canBatchDropCascade = computed(() => selectedTableCount.value > 0 && supportsDropTableCascade(effectiveDatabaseType.value));
const canBatchTruncateCascade = computed(() => selectedTableCount.value > 0 && supportsTruncateTableCascade(effectiveDatabaseType.value));
const allVisibleTablesSelected = computed(() => visibleSelectableRows.value.length > 0 && visibleSelectableRows.value.every((row) => selectedTableIds.value.has(row.id)));

function iconFor(row: ObjectBrowserRow) {
  if (row.type === "VIEW" || row.type === "MATERIALIZED_VIEW") return Eye;
  if (row.type === "PROCEDURE") return ScrollText;
  if (row.type === "FUNCTION") return Braces;
  if (row.type === "TRIGGER") return RotateCcw;
  if (row.type === "SEQUENCE") return ListTree;
  if (row.type === "PACKAGE" || row.type === "PACKAGE_BODY") return Package;
  if (row.type === "TYPE" || row.type === "TYPE_BODY") return Braces;
  return Table2;
}

function typeLabel(type: ObjectBrowserRow["type"]) {
  if (type === "MATERIALIZED_VIEW") return t("common.materializedView");
  if (type === "VIEW") return t("objects.view");
  if (type === "PROCEDURE") return t("objects.procedure");
  if (type === "FUNCTION") return t("objects.function");
  if (type === "TRIGGER") return t("objects.trigger");
  if (type === "SEQUENCE") return t("objects.sequence");
  if (type === "PACKAGE") return t("objects.package");
  if (type === "PACKAGE_BODY") return t("objects.packageBody");
  if (type === "TYPE") return t("objects.typeDefinition");
  if (type === "TYPE_BODY") return t("objects.typeBody");
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

const sortKeyOptions = computed<ObjectBrowserSortKey[]>(() => {
  const options: ObjectBrowserSortKey[] = ["name", "type", "estimatedRows", "totalBytes"];
  if (hasCreatedAt.value) options.push("created_at");
  if (hasUpdatedAt.value) options.push("updated_at");
  options.push("comment");
  return options;
});

watch(sortKeyOptions, (options) => {
  if (!options.includes(sortKey.value)) {
    sortKey.value = "name";
    sortDirection.value = "asc";
  }
});

function sortKeyLabel(key: ObjectBrowserSortKey): string {
  if (key === "name") return t("objects.name");
  if (key === "type") return t("objects.type");
  if (key === "estimatedRows") return t("objects.rows");
  if (key === "totalBytes") return t("objects.size");
  if (key === "created_at") return t("objects.createdAt");
  if (key === "updated_at") return t("objects.updatedAt");
  if (key === "comment") return t("objects.comment");
  return key;
}

function onSortKeyChange(key: ObjectBrowserSortKey) {
  toggleSort(key);
}

function minimumColumnWidth(key: ObjectBrowserColumnKey) {
  if (key === "select") return 34;
  if (key === "name" || key === "comment") return 120;
  return 72;
}

function onObjectColumnResizeStart(key: ObjectBrowserColumnKey, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  stopColumnResize?.();

  const startX = event.clientX;
  const startWidth = objectColumnWidths.value[key];
  const minWidth = minimumColumnWidth(key);
  document.body.classList.add("select-none", "cursor-col-resize");

  const onMove = (moveEvent: MouseEvent) => {
    objectColumnWidths.value = {
      ...objectColumnWidths.value,
      [key]: Math.max(minWidth, startWidth + moveEvent.clientX - startX),
    };
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("select-none", "cursor-col-resize");
    stopColumnResize = null;
  };

  stopColumnResize = onUp;
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function resetObjectColumnWidth(key: ObjectBrowserColumnKey, width: number, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  objectColumnWidths.value = {
    ...objectColumnWidths.value,
    [key]: width,
  };
}

function rowMatchesFilter(row: ObjectBrowserRow, filter: ObjectFilter) {
  if (filter === "tables") return row.type === "TABLE";
  if (filter === "views") return row.type === "VIEW";
  if (filter === "materializedViews") return row.type === "MATERIALIZED_VIEW";
  if (filter === "procedures") return row.type === "PROCEDURE";
  if (filter === "functions") return row.type === "FUNCTION";
  if (filter === "triggers") return row.type === "TRIGGER";
  if (filter === "sequences") return row.type === "SEQUENCE";
  if (filter === "packages") return row.type === "PACKAGE" || row.type === "PACKAGE_BODY";
  if (filter === "types") return row.type === "TYPE" || row.type === "TYPE_BODY";
  return true;
}

function rowMatchesObjectFilter(row: ObjectBrowserRow) {
  return rowMatchesFilter(row, objectFilter.value);
}

function groupedFilteredRows() {
  const query = search.value.trim();
  const candidateRows = rows.value.filter(rowMatchesObjectFilter);
  const candidateIds = new Set(candidateRows.map((row) => row.id));
  const matchingRows = objectSearchSummary.value.matchingRows.filter(rowMatchesObjectFilter);
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
  if (type === "TRIGGER") return "text-rose-500";
  if (type === "SEQUENCE") return "text-emerald-500";
  if (type === "PACKAGE" || type === "PACKAGE_BODY") return "text-cyan-500";
  if (type === "TYPE" || type === "TYPE_BODY") return "text-violet-500";
  return "text-green-500";
}

function iconBgClass(type: ObjectBrowserRow["type"]) {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return "object-browser-icon-bg object-browser-icon-bg-view";
  if (type === "PROCEDURE") return "object-browser-icon-bg object-browser-icon-bg-procedure";
  if (type === "FUNCTION") return "object-browser-icon-bg object-browser-icon-bg-function";
  if (type === "TRIGGER") return "object-browser-icon-bg object-browser-icon-bg-procedure";
  if (type === "SEQUENCE") return "object-browser-icon-bg object-browser-icon-bg-sequence";
  if (type === "PACKAGE" || type === "PACKAGE_BODY") return "object-browser-icon-bg object-browser-icon-bg-package";
  if (type === "TYPE" || type === "TYPE_BODY") return "object-browser-icon-bg object-browser-icon-bg-function";
  return "object-browser-icon-bg object-browser-icon-bg-table";
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

function canRename(row: ObjectBrowserRow) {
  return supportsObjectRename(effectiveDatabaseType.value, row.type) || supportsSourceBackedRoutineRename(effectiveDatabaseType.value, row.type as ObjectSourceKind);
}

function sourceTitle(row: ObjectBrowserRow | null) {
  if (!row) return t("objects.source");
  return `${row.name} ${t("objects.source")}`;
}

const SINGLE_CLICK_DELAY = 250;
let singleClickTimer: ReturnType<typeof setTimeout> | null = null;

function executeRowAction(row: ObjectBrowserRow, action: ObjectBrowserRowAction) {
  switch (action) {
    case "table-info":
      void openTableInfo(row);
      break;
    case "open-table":
      emit("openTable", { tableName: row.name, schema: row.schema, catalog: props.catalog });
      break;
    case "open-source":
      void openSource(row);
      break;
  }
}

function onRowClick(row: ObjectBrowserRow, event: MouseEvent) {
  const activation = settingsStore.editorSettings.sidebarActivation;
  const { action, isDouble } = resolveRowClickAction(row, event.detail, activation);
  // Double click: cancel any pending single-click and fire immediately
  if (isDouble) {
    if (singleClickTimer) {
      clearTimeout(singleClickTimer);
      singleClickTimer = null;
    }
    executeRowAction(row, action);
    return;
  }
  // Single click: defer when the row has a distinct double-click action so a
  // following second click can cancel it (e.g. TABLE single→table-info, double→open-table).
  if (shouldDeferSingleClick(row, action)) {
    if (singleClickTimer) clearTimeout(singleClickTimer);
    singleClickTimer = setTimeout(() => {
      singleClickTimer = null;
      executeRowAction(row, action);
    }, SINGLE_CLICK_DELAY);
    return;
  }
  executeRowAction(row, action);
}

// --- Table info panel (replicates DataGrid table-info-drawer) ---

type TableInfoTabItem = { id: TableInfoTab; label: string; icon: Component; count?: number };

const tableInfoTabs = computed<TableInfoTabItem[]>(() => {
  const tabs: TableInfoTabItem[] = [];
  if (tableMetadataCapabilities.value.ddl) {
    tabs.push({ id: "ddl", label: "DDL", icon: Code2 });
  }
  if (tableMetadataCapabilities.value.columns) {
    tabs.push({ id: "columns", label: t("grid.tableInfoColumns"), icon: ListTree, count: tableColumns.value.length });
  }
  if (tableMetadataCapabilities.value.indexes) {
    tabs.push({ id: "indexes", label: t("grid.tableInfoIndexes"), icon: KeyRound, count: tableIndexes.value.length });
  }
  if (tableMetadataCapabilities.value.foreignKeys) {
    tabs.push({ id: "foreignKeys", label: t("grid.tableInfoForeignKeys"), icon: Link2, count: tableForeignKeys.value.length });
  }
  if (tableMetadataCapabilities.value.triggers) {
    tabs.push({ id: "triggers", label: t("grid.tableInfoTriggers"), icon: RotateCcw, count: tableTriggers.value.length });
  }
  return tabs;
});

const tableInfoTabListStyle = computed(() => ({
  gridTemplateColumns: `repeat(${tableInfoTabs.value.length}, minmax(0, 1fr))`,
}));

const filteredTableColumns = computed(() => filterObjectBrowserTableColumns(tableColumns.value, tableInfoSearchQuery.value));

const filteredTableIndexes = computed(() => {
  if (!tableInfoSearchQuery.value) return tableIndexes.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableIndexes.value.filter((i) => i.name.toLowerCase().includes(q) || i.columns.some((c) => c.toLowerCase().includes(q)));
});

const filteredTableForeignKeys = computed(() => {
  if (!tableInfoSearchQuery.value) return tableForeignKeys.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableForeignKeys.value.filter((fk) => fk.name.toLowerCase().includes(q) || fk.column.toLowerCase().includes(q) || fk.ref_table.toLowerCase().includes(q) || fk.ref_column.toLowerCase().includes(q));
});

const filteredTableTriggers = computed(() => {
  if (!tableInfoSearchQuery.value) return tableTriggers.value;
  const q = tableInfoSearchQuery.value.toLowerCase();
  return tableTriggers.value.filter((tr) => tr.name.toLowerCase().includes(q));
});

const filteredTableDdlContent = computed(() => {
  if (!tableDdlContent.value) return "";
  const html = highlight(tableDdlContent.value);
  if (!tableInfoSearchQuery.value) return html;
  const escaped = tableInfoSearchQuery.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  return html.replace(/>([^<]*)</g, (_, text) => {
    return `>${text.replace(regex, "<mark>$1</mark>")}<`;
  });
});

async function openTableInfo(row: ObjectBrowserRow, initialTab?: TableInfoTab) {
  // Toggle off if clicking the same table
  if (sidePanelRow.value?.id === row.id && sidePanelMode.value === "table-info" && !initialTab) {
    closeSidePanel();
    return;
  }
  sidePanelRow.value = row;
  sidePanelMode.value = "table-info";
  sidePanelGuard.bump();
  // Reset state
  tableColumns.value = [];
  tableDdlContent.value = "";
  tableIndexes.value = [];
  tableForeignKeys.value = [];
  tableTriggers.value = [];
  tableInfoSearchQuery.value = "";
  // Determine initial tab: explicit request > first available > ddl
  const firstTab = initialTab ?? tableInfoTabs.value[0]?.id ?? "ddl";
  await selectTableInfoTab(firstTab);
}

async function selectTableInfoTab(tab: TableInfoTab) {
  const nextTab = tableInfoTabs.value.some((item) => item.id === tab) ? tab : tableInfoTabs.value[0]?.id;
  if (!nextTab) return;
  tableInfoTab.value = nextTab;
  tableInfoSearchQuery.value = "";
  if (nextTab === "ddl") await fetchTableDdl();
  else if (nextTab === "columns") await fetchTableColumns();
  else if (nextTab === "indexes") await fetchTableIndexes();
  else if (nextTab === "foreignKeys") await fetchTableForeignKeys();
  else if (nextTab === "triggers") await fetchTableTriggers();
}

async function fetchTableDdl() {
  const row = sidePanelRow.value;
  if (!row) return;
  const epoch = sidePanelGuard.capture();
  tableDdlLoading.value = true;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const ddl = await api.getTableDdl(props.connection.id, props.database || "", schema, row.name, tableDdlObjectType(row.type), props.catalog);
    if (sidePanelGuard.isStale(epoch)) return;
    tableDdlContent.value = ddl;
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch)) return;
    tableDdlContent.value = `-- Error: ${e?.message || e}`;
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableDdlLoading.value = false;
  }
}

async function fetchTableColumns() {
  const row = sidePanelRow.value;
  if (!row || tableColumns.value.length > 0) return;
  const epoch = sidePanelGuard.capture();
  tableColumnsLoading.value = true;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const columns = await api.getColumns(props.connection.id, props.database || "", schema, row.name, props.catalog);
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = columns;
  } catch {
    if (sidePanelGuard.isStale(epoch)) return;
    tableColumns.value = [];
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableColumnsLoading.value = false;
  }
}

async function fetchTableIndexes() {
  const row = sidePanelRow.value;
  if (!row || tableIndexes.value.length > 0) return;
  const epoch = sidePanelGuard.capture();
  tableIndexesLoading.value = true;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const indexes = await api.listIndexes(props.connection.id, props.database || "", schema, row.name, props.catalog);
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = indexes;
  } catch {
    if (sidePanelGuard.isStale(epoch)) return;
    tableIndexes.value = [];
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableIndexesLoading.value = false;
  }
}

async function fetchTableForeignKeys() {
  const row = sidePanelRow.value;
  if (!row || tableForeignKeys.value.length > 0) return;
  const epoch = sidePanelGuard.capture();
  tableForeignKeysLoading.value = true;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const fks = await api.listForeignKeys(props.connection.id, props.database || "", schema, row.name, props.catalog);
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = fks;
  } catch {
    if (sidePanelGuard.isStale(epoch)) return;
    tableForeignKeys.value = [];
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableForeignKeysLoading.value = false;
  }
}

async function fetchTableTriggers() {
  const row = sidePanelRow.value;
  if (!row || tableTriggers.value.length > 0) return;
  const epoch = sidePanelGuard.capture();
  tableTriggersLoading.value = true;
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const triggers = await api.listTriggers(props.connection.id, props.database || "", schema, row.name, props.catalog);
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = triggers;
  } catch {
    if (sidePanelGuard.isStale(epoch)) return;
    tableTriggers.value = [];
  } finally {
    if (sidePanelGuard.isFresh(epoch)) tableTriggersLoading.value = false;
  }
}

function copyTableDdl() {
  void copyToClipboard(tableDdlContent.value);
  toast(t("grid.copyDdl"), 2000);
}

function onTableInfoDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = tableInfoDdlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

// --- Side panel resize ---
function onSidePanelResizeStart(event: MouseEvent) {
  isResizingSidePanel.value = true;
  sidePanelResizeStartX = event.clientX;
  sidePanelResizeStartWidth = sidePanelWidth.value;
  window.addEventListener("mousemove", onSidePanelResizeMove);
  window.addEventListener("mouseup", onSidePanelResizeEnd);
}

function onSidePanelResizeMove(event: MouseEvent) {
  if (!isResizingSidePanel.value) return;
  const delta = sidePanelResizeStartX - event.clientX;
  const next = Math.min(SIDE_PANEL_MAX_WIDTH, Math.max(SIDE_PANEL_MIN_WIDTH, sidePanelResizeStartWidth + delta));
  sidePanelWidth.value = next;
}

function onSidePanelResizeEnd() {
  isResizingSidePanel.value = false;
  window.removeEventListener("mousemove", onSidePanelResizeMove);
  window.removeEventListener("mouseup", onSidePanelResizeEnd);
  settingsStore.updateEditorSettings({ tableInfoDrawerWidth: sidePanelWidth.value });
}

function closeSidePanel() {
  sidePanelRow.value = null;
  sidePanelMode.value = "source";
  sidePanelGuard.bump();
}

const canOpenTableStructureEditor = computed(() => sidePanelRow.value?.type === "TABLE" && canOpenStructureEditor.value);

function openTableStructureEditor() {
  const row = sidePanelRow.value;
  if (!row || row.type !== "TABLE" || !canOpenTableStructureEditor.value) return;
  queryStore.openTableStructure(props.connection.id, props.database, row.schema || selectedSchema.value, row.name, tableInfoTab.value, undefined, props.catalog);
}

async function openSource(row: ObjectBrowserRow) {
  // Toggle off if clicking the same source row
  if (sidePanelRow.value?.id === row.id && sidePanelMode.value === "source") {
    closeSidePanel();
    return;
  }
  // Starting a different object must invalidate slower source requests before
  // any state is reset, otherwise an old response can populate the new row.
  const epoch = sidePanelGuard.start();
  sidePanelRow.value = row;
  sidePanelMode.value = "source";
  sourceRow.value = row;
  sourceContent.value = "";
  sourceError.value = "";
  sourceEditing.value = false;
  sourceCanEdit.value = true;
  sourceEditableText.value = "";
  sourceDraft.value = "";
  sourceSaveError.value = "";
  sourceLoading.value = true;
  const connectionId = props.connection.id;
  const database = props.database;
  const schema = row.schema || selectedSchema.value || database;
  try {
    const result = await api.getObjectSource(connectionId, database, schema, row.name, row.type as ObjectSourceKind, row.signature ?? undefined);
    if (sidePanelGuard.isStale(epoch)) return;
    sourceCanEdit.value = result.editable !== false && !["SEQUENCE", "TRIGGER", "TYPE", "TYPE_BODY"].includes(row.type);
    const editable = sourceCanEdit.value
      ? await api.buildEditableObjectSource({
          databaseType: effectiveDatabaseType.value,
          objectType: row.type as ObjectSourceKind,
          schema,
          name: row.name,
          source: result.source,
        })
      : result.source;
    if (sidePanelGuard.isStale(epoch)) return;
    // Viewing database source must preserve its original whitespace and comments;
    // formatting remains an explicit editor action instead of altering it on open.
    sourceEditableText.value = editable;
    sourceContent.value = editable;
    sourceDraft.value = editable;
    sourceEditing.value = sourceCanEdit.value;
    if (!sourceCanEdit.value && row.type !== "SEQUENCE") {
      toast(t("objects.sourceReadOnly"), 3000);
    }
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch)) return;
    sourceError.value = e?.message || String(e);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) sourceLoading.value = false;
  }
}

async function openNewQuery(row: ObjectBrowserRow) {
  const tabId = queryStore.createTab(props.connection.id, props.database, row.name);
  queryStore.updateSql(
    tabId,
    await buildTableSelectSql({
      databaseType: effectiveDatabaseType.value,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
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
  dropPreviewSql.value = "";
  dropTableCascade.value = false;
  showDropConfirm.value = true;
  void refreshDropPreviewSql();
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
      const source = await api.getObjectSource(props.connection.id, props.database, schema, row.name, row.type as ObjectSourceKind, row.signature ?? undefined);
      const statements = await buildRoutineRenameObjectSourceStatements({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type as ObjectSourceKind,
        schema,
        name: row.name,
        newName,
        source: source.source,
      });
      const executed = await executeObjectBrowserSqlWithProductionGuard(statements.join(";\n"), async () => {
        for (const sql of statements) {
          await api.executeQuery(props.connection.id, props.database, sql, schema);
        }
        return true;
      });
      if (!executed) return;
    } else {
      const sql = await buildRenameObjectSql({
        databaseType: effectiveDatabaseType.value,
        objectType: row.type,
        schema,
        oldName: row.name,
        newName,
      });
      const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql, schema));
      if (!executed) return;
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
    const sql = dropPreviewSql.value || (await buildDropSqlForRow(row, { cascade: canDropTargetCascade.value && dropTableCascade.value }));
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    const successKey = row.type === "VIEW" ? "contextMenu.dropViewSuccess" : row.type === "PROCEDURE" ? "contextMenu.dropProcedureSuccess" : row.type === "FUNCTION" ? "contextMenu.dropFunctionSuccess" : "contextMenu.dropTableSuccess";
    toast(t(successKey, { name: row.name }));
    closeDroppedTableObjectTabsForRow(row);
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, row.schema || selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
  dropTarget.value = null;
  dropPreviewSql.value = "";
  dropTableCascade.value = false;
}

async function buildDropSqlForRow(row: ObjectBrowserRow, options?: { cascade?: boolean }): Promise<string> {
  if (row.type === "TABLE") {
    return buildDropTableSql(tableAdminSqlOptions(row, { cascade: options?.cascade && supportsDropTableCascade(effectiveDatabaseType.value) }));
  }
  return buildDropObjectSql({
    databaseType: effectiveDatabaseType.value,
    objectType: row.type,
    schema: row.schema || selectedSchema.value,
    name: row.name,
  });
}

let dropPreviewRequestId = 0;

async function refreshDropPreviewSql() {
  const requestId = ++dropPreviewRequestId;
  const row = dropTarget.value;
  if (!row) {
    dropPreviewSql.value = "";
    return;
  }
  dropPreviewSql.value = "";
  const sql = await buildDropSqlForRow(row, { cascade: canDropTargetCascade.value && dropTableCascade.value }).catch(() => "");
  if (requestId === dropPreviewRequestId) dropPreviewSql.value = sql;
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
  sidePanelRow.value = null;
  sourceContent.value = "";
  sourceError.value = "";
  sourceEditing.value = false;
  sourceEditableText.value = "";
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
  emit("openTable", { tableName: row.name, schema: row.schema, tableType: row.type, catalog: props.catalog });
}

function openStructureEditor(row: ObjectBrowserRow) {
  if (row.type !== "TABLE") return;
  queryStore.openTableStructure(props.connection.id, props.database, row.schema || selectedSchema.value, row.name, undefined, undefined, props.catalog);
}

function droppedTableObjectTypeForRow(row: ObjectBrowserRow): "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | null {
  if (row.type === "TABLE") return "TABLE";
  if (row.type === "VIEW") return "VIEW";
  if (row.type === "MATERIALIZED_VIEW") return "MATERIALIZED_VIEW";
  return null;
}

function closeDroppedTableObjectTabsForRow(row: ObjectBrowserRow) {
  const objectType = droppedTableObjectTypeForRow(row);
  if (!objectType) return;
  queryStore.closeDroppedTableObjectTabs({
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    name: row.name,
    objectType,
  });
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

  const fkResults = await Promise.all(rows.map((row) => api.listForeignKeys(props.connection.id, props.database, row.schema || selectedSchema.value || "", row.name, props.catalog).catch(() => [] as ForeignKeyInfo[])));

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
  const useCascade = canBatchDropCascade.value && batchDropCascade.value;
  for (const row of sortedRows) {
    const sql = await buildDropTableSql(tableAdminSqlOptions(row, { cascade: useCascade })).catch(() => "");
    if (sql) statements.push(sql);
  }
  batchDropPreviewSql.value = statements.join("\n");
}

function requestBatchDropTables() {
  if (selectedTableCount.value === 0) return;
  batchDropCascade.value = false;
  batchDropPreviewSql.value = "";
  void refreshBatchDropPreviewSql();
  showBatchDropConfirm.value = true;
}

async function confirmBatchDropTables() {
  const targets = await fetchSortedTableRowsForDrop();
  if (targets.length === 0) return;
  try {
    const useCascade = canBatchDropCascade.value && batchDropCascade.value;
    const statements = await Promise.all(
      targets.map(async (row) => ({
        row,
        sql: await buildDropTableSql(tableAdminSqlOptions(row, { cascade: useCascade })),
      })),
    );
    const executed = await executeObjectBrowserSqlWithProductionGuard(statements.map(({ sql }) => sql).join(";\n"), async () => {
      for (const { row, sql } of statements) {
        await api.executeQuery(props.connection.id, props.database, sql);
        closeDroppedTableObjectTabsForRow(row);
      }
      return true;
    });
    if (!executed) return;
    toast(t("objects.batchDropSuccess", { count: targets.length }));
    clearTableSelection();
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshBatchTruncatePreviewSql() {
  const statements: string[] = [];
  const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
  for (const row of selectedTableRows.value) {
    const sql = await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: useCascade })).catch(() => "");
    if (sql) statements.push(sql);
  }
  batchTruncatePreviewSql.value = statements.join("\n");
}

function requestBatchTruncateTables() {
  if (selectedTableCount.value === 0 || !supportsTruncateTable.value) return;
  batchTruncateCascade.value = false;
  batchTruncatePreviewSql.value = "";
  void refreshBatchTruncatePreviewSql();
  showBatchTruncateConfirm.value = true;
}

function tableDataRefreshTargetForRow(row: ObjectBrowserRow) {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema: row.schema || selectedSchema.value,
    schemaCandidates: [row.schema, selectedSchema.value],
    catalog: props.catalog,
    name: row.name,
  };
}

async function refreshMutatedTableDataTabsForRows(rows: readonly ObjectBrowserRow[]) {
  for (const row of rows) {
    const target = tableDataRefreshTargetForRow(row);
    try {
      await queryStore.refreshDataTabsForTable(target);
    } catch (error) {
      console.warn("[DBX][table-data-refresh-after-mutation:error]", { target, error });
    }
  }
}

async function confirmBatchTruncateTables() {
  const targets = [...selectedTableRows.value];
  if (targets.length === 0) return;
  try {
    const useCascade = canBatchTruncateCascade.value && batchTruncateCascade.value;
    const statements = await Promise.all(
      targets.map(async (row) => ({
        row,
        sql: await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: useCascade })),
      })),
    );
    const executed = await executeObjectBrowserSqlWithProductionGuard(statements.map(({ sql }) => sql).join(";\n"), async () => {
      await runBatchTableTruncate(
        statements,
        async ({ sql }) => {
          await api.executeQuery(props.connection.id, props.database, sql);
        },
        async (succeeded) => refreshMutatedTableDataTabsForRows(succeeded.map(({ row }) => row)),
      );
      return true;
    });
    if (!executed) return;
    toast(t("objects.batchTruncateSuccess", { count: targets.length }));
    clearTableSelection();
    showBatchTruncateConfirm.value = false;
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function refreshBatchEmptyPreviewSql(targets: ObjectBrowserRow[]) {
  const plan = await buildBatchTableEmptyPlan(targets, (row) => buildEmptyTableSql(tableAdminSqlOptions(row)));
  // Freeze the reviewed SQL with its target so confirmation cannot execute a different destructive statement.
  batchEmptyPlan.value = plan;
  batchEmptyPreviewSql.value = plan.map(({ sql }) => sql).join("\n");
}

function requestBatchEmptyTables() {
  const targets = [...selectedTableRows.value];
  if (targets.length === 0) return;
  batchEmptyPlan.value = [];
  batchEmptyPreviewSql.value = "";
  void refreshBatchEmptyPreviewSql(targets)
    .then(() => {
      showBatchEmptyConfirm.value = true;
    })
    .catch((e: any) => {
      batchEmptyPlan.value = [];
      toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
    });
}

async function confirmBatchEmptyTables() {
  const plan = batchEmptyPlan.value.slice();
  if (plan.length === 0) return;
  const asynchronousMutation = effectiveDatabaseType.value === "clickhouse";
  const reviewSql = plan.map(({ sql }) => sql).join(";\n");
  const result = await executeObjectBrowserSqlWithProductionGuard(reviewSql, () => {
    return runBatchTableEmpty(plan, async ({ sql }) => {
      await api.executeQuery(props.connection.id, props.database, sql);
    });
  });
  if (!result) return;
  for (const failure of result.failed) {
    console.error(`Failed to empty table "${failure.target.target.name}":`, failure.error);
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
  batchEmptyPlan.value = [];
  showBatchEmptyConfirm.value = false;
  if (result.succeeded.length > 0) {
    clearTableSelection();
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
  }
}

async function exportStructure(row: ObjectBrowserRow) {
  try {
    const schema = row.schema || selectedSchema.value || props.database;
    const ddl = await api.getTableDdl(props.connection.id, props.database, schema, row.name, tableDdlObjectType(row.type), props.catalog);
    await saveFileContent(buildSingleDdlExportFileContent(ddl), `${row.name}.sql`, "SQL", "sql");
  } catch (e: any) {
    console.error("Export structure failed:", e);
  }
}

function tableDdlObjectType(type: ObjectBrowserRow["type"]): ObjectSourceKind | undefined {
  if (type === "VIEW" || type === "MATERIALIZED_VIEW") return type;
  return undefined;
}

async function exportDataLegacy(row: ObjectBrowserRow, format: "json" | "sql") {
  try {
    const schema = row.schema || selectedSchema.value;
    const tableColumns = format === "sql" ? await api.getColumns(props.connection.id, props.database, schema || props.database, row.name, props.catalog) : undefined;
    const queryColumns = props.connection.db_type === "neo4j" ? (tableColumns ?? (await api.getColumns(props.connection.id, props.database, schema || props.database, row.name, props.catalog))).map((column) => column.name) : undefined;
    const result = await fetchTableDataForExport({
      databaseType: effectiveDatabaseType.value,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(props.connection.id),
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
    const queryColumns = props.connection.db_type === "neo4j" ? (await api.getColumns(props.connection.id, props.database, schema || props.database, row.name, props.catalog)).map((column) => column.name) : undefined;

    task = addExportTask(row.name, format, filePath);
    const currentTask = task;
    const rowLimit = settingsStore.editorSettings.exportRowLimitEnabled ? settingsStore.editorSettings.exportRowLimit : null;
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
      rowLimit,
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
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql, schema));
    if (!executed) return;
    toast(t("contextMenu.duplicateStructureSuccess", { name: newName }));
    await reload();
    await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, schema);
  } catch (e: any) {
    toast(t("contextMenu.tableOperationFailed", { message: e?.message || String(e) }), 5000);
  }
}

function copySelectedTablesToClipboard() {
  const selectedRows = selectedTableRows.value;
  if (selectedRows.length === 0) return;
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: selectedRows.map((row) => ({
      connectionId: props.connection.id,
      database: props.database,
      schema: row.schema || selectedSchema.value,
      tableName: row.name,
    })),
  };
  toast(t("contextMenu.pasteTableClipboardUpdated"), 2000);
}

function canPasteTableClipboard(): boolean {
  const clipboard = connectionStore.treeClipboard;
  return clipboard?.kind === "table-copy" && tableClipboardMatchesTarget(clipboard.tables, pasteTableTargetContext());
}

function pasteTableTargetContext(): TableClipboardContext {
  return {
    connectionId: props.connection.id,
    database: props.database,
    schema: selectedSchema.value,
  };
}

function copySingleTableToClipboard(row: ObjectBrowserRow) {
  connectionStore.treeClipboard = {
    kind: "table-copy",
    tables: [
      {
        connectionId: props.connection.id,
        database: props.database,
        schema: row.schema || selectedSchema.value,
        tableName: row.name,
      },
    ],
  };
  toast(t("contextMenu.pasteTableClipboardUpdated"), 2000);
}

function openPasteTableDialog() {
  const clipboard = connectionStore.treeClipboard;
  if (!canPasteTableClipboard() || clipboard?.kind !== "table-copy") {
    toast(t("contextMenu.noTableToPaste"), 2000);
    return;
  }
  pasteTableMode.value = defaultPasteTableMode(effectiveDatabaseType.value);
  pasteTableEntries.value = clipboard.tables.map((entry) => ({
    sourceName: entry.tableName,
    targetName: `${entry.tableName}_copy`,
    schema: entry.schema,
  }));
  showPasteDialog.value = true;
}

function onObjectBrowserKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (eventTargetAllowsAppClipboardShortcut(event, "c")) {
    if (selectedTableCount.value === 0) return;
    event.preventDefault();
    event.stopPropagation();
    copySelectedTablesToClipboard();
    return;
  }
  if (eventTargetAllowsAppClipboardShortcut(event, "v")) {
    if (!canPasteTableClipboard()) return;
    event.preventDefault();
    event.stopPropagation();
    openPasteTableDialog();
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
  for (const entry of entries) {
    const targetName = entry.targetName.trim();
    const schema = entry.schema || selectedSchema.value;
    try {
      if (mode === "structure-and-data" || mode === "structure-only") {
        const structureSql = await buildDuplicateTableStructureSql({
          databaseType: effectiveDatabaseType.value,
          schema,
          sourceName: entry.sourceName,
          targetName,
        });
        const executed = await executeObjectBrowserSqlWithProductionGuard(structureSql, () => api.executeQuery(props.connection.id, props.database, structureSql, schema));
        if (!executed) return;
      }
      if (copyData) {
        const sourceColumns = await api.getColumns(props.connection.id, props.database, schema || "", entry.sourceName, props.catalog);
        const dataCopyColumnOptions = tableDataCopyColumnOptions(effectiveDatabaseType.value, sourceColumns);
        if (dataCopyColumnOptions.columns.length === 0) {
          throw new Error("No writable columns available for table data copy.");
        }
        const dataSql = await buildCopyTableDataSql({
          databaseType: effectiveDatabaseType.value,
          schema,
          sourceName: entry.sourceName,
          targetName,
          ...dataCopyColumnOptions,
        });
        const executed = await executeObjectBrowserSqlWithProductionGuard(dataSql, () => api.executeQuery(props.connection.id, props.database, dataSql, schema));
        if (!executed) return;
      }
      successCount++;
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
  await reload();
  await connectionStore.refreshObjectListTreeNode(props.connection.id, props.database, selectedSchema.value);
}

function tableAdminSqlOptions(row: ObjectBrowserRow, options?: { cascade?: boolean }): TableAdminSqlOptions {
  const result: TableAdminSqlOptions = {
    databaseType: effectiveDatabaseType.value,
    schema: row.schema || selectedSchema.value,
    tableName: row.name,
  };
  if (options?.cascade) result.cascade = true;
  return result;
}

/**
 * Routes Object Browser writes through the shared production gate. The SQL is
 * assessed before the callback runs so generated DDL cannot bypass protection
 * via executable comments, EXPLAIN ANALYZE, or qualified production targets.
 */
async function executeObjectBrowserSqlWithProductionGuard<T>(sql: string, execute: () => Promise<T>): Promise<T | undefined> {
  return executeWithProductionSqlGuard({
    connection: props.connection,
    database: props.database,
    sql,
    source: t("production.sourceObjectBrowser"),
    execute,
  });
}

async function refreshTruncatePreviewSql(row: ObjectBrowserRow) {
  truncatePreviewSql.value = "";
  truncatePreviewSql.value = await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: canTruncateTargetCascade.value && truncateTableCascade.value })).catch(() => "");
}

function requestTruncateTable(row: ObjectBrowserRow) {
  truncateTarget.value = row;
  truncateTableCascade.value = false;
  void refreshTruncatePreviewSql(row);
  showTruncateConfirm.value = true;
}

async function confirmTruncateTable() {
  const row = truncateTarget.value;
  if (!row) return;
  try {
    const sql = truncatePreviewSql.value || (await buildTruncateTableSql(tableAdminSqlOptions(row, { cascade: canTruncateTargetCascade.value && truncateTableCascade.value })));
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    toast(t("contextMenu.truncateTableSuccess", { name: row.name }));
    await refreshMutatedTableDataTabsForRows([row]);
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
    const executed = await executeObjectBrowserSqlWithProductionGuard(sql, () => api.executeQuery(props.connection.id, props.database, sql));
    if (!executed) return;
    toast(t("contextMenu.emptyTableSuccess", { name: row.name }));
    await refreshMutatedTableDataTabsForRows([row]);
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
  if (!sourceRow.value || !sourceEditableText.value) return;
  if (!sourceCanEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  sourceDraft.value = sourceEditableText.value;
  sourceSaveError.value = "";
  sourceEditing.value = true;
}

function cancelEditSource() {
  sourceEditing.value = false;
  sourceDraft.value = "";
  sourceSaveError.value = "";
}

async function saveSource() {
  if (!sourceCanEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  if (!sourceRow.value || !sourceDraft.value.trim()) return;
  const row = sourceRow.value;
  const epoch = sidePanelGuard.capture();
  const connectionId = props.connection.id;
  const database = props.database;
  const schema = row.schema || selectedSchema.value || database;
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
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection: props.connection,
        database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          await executeObjectSourceSave(connectionId, database, effectiveDatabaseType.value, statements, schema);
          return true;
        },
      });
      if (!saved || sidePanelGuard.isStale(epoch)) return;
    } else {
      await executeObjectSourceSave(connectionId, database, effectiveDatabaseType.value, statements, schema);
      if (sidePanelGuard.isStale(epoch)) return;
    }
    toast(t("objects.sourceSaved"));
    sourceEditing.value = false;
    sourceDraft.value = "";
    await openSource(row);
  } catch (e: any) {
    if (sidePanelGuard.isStale(epoch)) return;
    sourceSaveError.value = e?.message || String(e);
  } finally {
    if (sidePanelGuard.isFresh(epoch)) sourceSaving.value = false;
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
    const objects: ObjectInfo[] = await api.listObjects(props.connection.id, props.database, schema, undefined, undefined, undefined, undefined, props.catalog);
    if (id !== loadId) return;
    rows.value = buildObjectBrowserRows({
      objects,
      database: props.database,
      fallbackSchema: schema,
      rowSchema: connectionObjectTreeNodeSchema(props.connection, props.database, selectedSchema.value),
    });
    const availableTableIds = new Set(rows.value.filter((row) => row.type === "TABLE").map((row) => row.id));
    setSelectedTableIds(new Set([...selectedTableIds.value].filter((id) => availableTableIds.has(id))));
    expandedPartitionParentIds.value = new Set([...expandedPartitionParentIds.value].filter((id) => rows.value.some((row) => row.id === id && row.partitionCount)));
    void loadObjectStatistics(id, schema);
  } catch (e: any) {
    if (id !== loadId) return;
    error.value = e?.message || String(e);
  } finally {
    if (id === loadId) {
      loadingObjects.value = false;
      if (!userHasSelectedFilter.value && objectCounts.value.tables > 0) {
        // The default table filter is a presentation choice, not a user query
        // change, so preserve the tab's saved scroll offset across remounts.
        preserveObjectFilterScrollOnce = objectFilter.value !== "tables";
        objectFilter.value = "tables";
      }
      restoreObjectBrowserViewport();
    }
  }
}

async function loadObjectStatistics(id: number, schema: string) {
  if (!rows.value.some((row) => row.type === "TABLE")) return;
  try {
    const stats = await api.listObjectStatistics(props.connection.id, props.database, schema);
    if (id !== loadId || stats.length === 0) return;
    mergeObjectStatistics(stats, schema);
  } catch (e) {
    console.debug("[ObjectBrowser] table statistics unavailable", e);
  }
}

function mergeObjectStatistics(stats: ObjectStatistics[], fallbackSchema: string) {
  const statsByKey = new Map(stats.map((stat) => [objectStatisticKey(stat.schema || fallbackSchema, stat.name), stat]));
  rows.value = rows.value.map((row) => {
    if (row.type !== "TABLE") return row;
    const stat = statsByKey.get(objectStatisticKey(row.schema || fallbackSchema, row.name));
    if (!stat) return row;
    return {
      ...row,
      estimatedRows: normalizeStatisticNumber(stat.estimated_rows),
      totalBytes: normalizeStatisticNumber(stat.total_bytes),
    };
  });
}

function objectStatisticKey(schema: string | undefined, name: string) {
  return `${schema || ""}\0${name}`.toLowerCase();
}

function normalizeStatisticNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function reload() {
  await loadSchemas();
  await loadObjects();
}

function refresh(): boolean {
  void reload();
  return true;
}

function onSchemaChange(value: any) {
  selectedSchema.value = typeof value === "string" && value ? value : undefined;
  emit("schemaChange", selectedSchema.value);
  userHasSelectedFilter.value = false;
  objectFilter.value = "all";
  void loadObjects();
}

function filterCount(filter: ObjectFilter) {
  return objectSearchSummary.value.counts[filter];
}

function filterLabel(filter: ObjectFilter) {
  const key =
    filter === "tables"
      ? "objects.tables"
      : filter === "views"
        ? "objects.views"
        : filter === "materializedViews"
          ? "tree.materializedViews"
          : filter === "procedures"
            ? "objects.procedures"
            : filter === "functions"
              ? "objects.functions"
              : filter === "triggers"
                ? "tree.triggers"
                : filter === "sequences"
                  ? "objects.sequences"
                  : filter === "packages"
                    ? "objects.packages"
                    : filter === "types"
                      ? "tree.types"
                      : "objects.all";
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

defineExpose({ focusSearch, refresh });

onBeforeUnmount(() => {
  stopColumnResize?.();
});

watch(
  [() => props.connection.id, () => props.database, () => props.schema],
  async () => {
    selectedSchema.value = props.schema;
    userHasSelectedFilter.value = false;
    objectFilter.value = "all";
    clearTableSelection();
    // Close side panel and invalidate any pending source/table-info requests
    // so stale results from the old context don't overwrite new state.
    closeSidePanel();
    sourceRow.value = null;
    sourceContent.value = "";
    sourceError.value = "";
    sourceLoading.value = false;
    sourceEditing.value = false;
    sourceSaving.value = false;
    try {
      await connectionStore.ensureConnected(props.connection.id);
    } catch (e) {
      console.warn("[DBX] ensureConnected failed for", props.connection.id, e);
    }
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

function isSelectedBatchTableContext(item: ObjectBrowserRow): boolean {
  return item.type === "TABLE" && selectedTableCount.value > 1 && selectedTableIds.value.has(item.id);
}

function selectedBatchTableCountLabel(key: "batchDrop" | "batchTruncate" | "batchEmpty"): string {
  return t(`contextMenu.${key}`, { count: selectedTableCount.value });
}

function getTableMenuItems(item: ObjectBrowserRow): ContextMenuItem[] {
  const useBatchActions = isSelectedBatchTableContext(item);
  return [
    { label: t("contextMenu.viewData"), action: () => openViewData(item), icon: Table2 },
    {
      label: t("contextMenu.viewDdl"),
      action: () => openTableInfo(item, "ddl"),
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
    { label: t("contextMenu.copyTable"), action: () => copySingleTableToClipboard(item), icon: Copy },
    { label: "", separator: true },
    ...(supportsTruncateTable.value
      ? [
          {
            label: useBatchActions ? selectedBatchTableCountLabel("batchTruncate") : t("contextMenu.truncateTable"),
            action: useBatchActions ? requestBatchTruncateTables : () => requestTruncateTable(item),
            icon: Scissors,
            variant: "destructive" as const,
          },
        ]
      : []),
    {
      label: useBatchActions ? selectedBatchTableCountLabel("batchEmpty") : t("contextMenu.emptyTable"),
      action: useBatchActions ? requestBatchEmptyTables : () => requestEmptyTable(item),
      icon: Eraser,
      variant: "destructive" as const,
    },
    {
      label: useBatchActions ? selectedBatchTableCountLabel("batchDrop") : t("contextMenu.dropTable"),
      action: useBatchActions ? requestBatchDropTables : () => requestDrop(item),
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
    {
      label: t("contextMenu.viewDdl"),
      action: () => openTableInfo(item, "ddl"),
      icon: ScrollText,
    },
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
  if (isSourceOnlyObjectBrowserRow(item)) return getPackageMenuItems(item);
  return getProcFuncMenuItems(item);
}
</script>

<template>
  <div ref="rootRef" data-object-browser-root class="flex h-full min-h-0 min-w-0 flex-col bg-background outline-none" tabindex="0" @keydown="onObjectBrowserKeydown">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <div class="flex min-w-0 items-center gap-2">
        <span class="inline-flex max-w-[14rem] min-w-0 items-center rounded border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium truncate" :title="selectedSchema || props.database">
          {{ selectedSchema || props.database }}
        </span>
        <span v-if="selectedSchema" class="inline-flex max-w-[14rem] min-w-0 items-center rounded border border-border bg-muted/30 px-2 py-0.5 text-xs text-muted-foreground truncate" :title="props.database">
          {{ props.database }}
        </span>
      </div>
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <div class="relative min-w-0 flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" data-object-search-input class="h-7 pl-8 text-xs" :placeholder="t('objects.search')" @keydown="onSearchKeydown" />
        </div>
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
      <SearchableSelect
        v-if="needsSchema"
        :model-value="selectedSchema || ''"
        :options="schemas"
        :placeholder="t('objects.schema')"
        :search-placeholder="t('editor.searchSchema')"
        :empty-text="t('grid.noSearchResults')"
        :loading-text="t('objects.loadingSchemas')"
        :loading="loadingSchemas"
        :disabled="loadingSchemas"
        trigger-variant="outline"
        trigger-class="h-7 w-36 max-w-36 px-2 text-xs font-normal"
        content-class="w-56"
        @update:model-value="onSchemaChange"
      />
      <!-- Sort selector -->
      <div class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <select
          class="h-6 cursor-pointer appearance-none rounded-sm bg-transparent px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
          :value="sortKey"
          :aria-label="t('objects.sortBy')"
          @change="onSortKeyChange(($event.target as HTMLSelectElement).value as ObjectBrowserSortKey)"
        >
          <option v-for="key in sortKeyOptions" :key="key" :value="key" class="bg-background text-foreground">
            {{ sortKeyLabel(key) }}
          </option>
        </select>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :title="sortDirection === 'asc' ? t('objects.sortAsc') : t('objects.sortDesc')" @click="sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'">
          <ArrowUp v-if="sortDirection === 'asc'" class="h-3 w-3" />
          <ArrowDown v-else class="h-3 w-3" />
        </button>
      </div>
      <div class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': isListView }" :title="t('objects.viewList')" @click="setViewMode('list')">
          <List class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': !isListView }" :title="t('objects.viewGrid')" @click="setViewMode('grid')">
          <LayoutGrid class="h-3.5 w-3.5" />
        </button>
      </div>
      <Button variant="ghost" size="icon" class="h-7 w-7" :class="{ 'text-primary': settingsStore.editorSettings.objectBrowserShowCheckbox }" :title="t('objects.toggleCheckbox')" @click="toggleCheckboxColumn">
        <CheckSquare v-if="settingsStore.editorSettings.objectBrowserShowCheckbox" class="h-3.5 w-3.5" />
        <Square v-else class="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="refreshTooltip" :disabled="loadingObjects" @click="reload">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingObjects }" />
      </Button>
      <Button v-if="canPasteTableClipboard()" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openPasteTableDialog">
        <Clipboard class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.pasteTableSelected") }}
      </Button>
    </div>
    <div v-if="selectedTableCount > 0" class="flex h-9 shrink-0 items-center gap-2 overflow-x-auto border-b bg-muted/30 px-3 text-xs">
      <div class="min-w-0 flex-1 truncate text-muted-foreground">
        {{ t("objects.selectedTables", { count: selectedTableCount }) }}
      </div>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openBatchDatabaseExport">
        <Upload class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.exportSelected") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="copySelectedTablesToClipboard">
        <Clipboard class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.copyTableSelected") }}
      </Button>
      <Button v-if="supportsTruncateTable" variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchTruncateTables">
        <Scissors class="mr-1.5 h-3.5 w-3.5" />
        {{ t("objects.truncateSelected") }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-destructive" @click="requestBatchEmptyTables">
        <Eraser class="mr-1.5 h-3.5 w-3.5" />
        {{ t("contextMenu.batchEmpty", { count: selectedTableCount }) }}
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
    <div v-else class="flex min-h-0 min-w-0 flex-1">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <div v-if="isListView" class="object-browser-table flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-hidden">
          <div class="grid h-7 shrink-0 items-center gap-3 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground" :style="{ gridTemplateColumns, minWidth: `${objectGridMinWidth}px` }">
            <div v-if="showCheckboxColumn" class="relative flex min-w-0 items-center">
              <button class="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-accent" type="button" :disabled="visibleSelectableRows.length === 0" @click="toggleVisibleTableSelection">
                <CheckSquare v-if="allVisibleTablesSelected" class="h-3.5 w-3.5 text-primary" />
                <Square v-else class="h-3.5 w-3.5" />
              </button>
              <div class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary" @mousedown="onObjectColumnResizeStart('select', $event)" @dblclick="resetObjectColumnWidth('select', 34, $event)">
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort('name')">
                <span class="truncate">{{ t("objects.name") }}</span>
                <component :is="sortIconFor('name')" v-if="sortIconFor('name')" class="h-3 w-3 shrink-0" />
              </button>
              <div class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary" @mousedown="onObjectColumnResizeStart('name', $event)" @dblclick="resetObjectColumnWidth('name', 260, $event)">
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort('type')">
                <span class="truncate">{{ t("objects.type") }}</span>
                <component :is="sortIconFor('type')" v-if="sortIconFor('type')" class="h-3 w-3 shrink-0" />
              </button>
              <div class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary" @mousedown="onObjectColumnResizeStart('type', $event)" @dblclick="resetObjectColumnWidth('type', 110, $event)">
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :title="t('objects.statisticsHint')" @click="toggleSort('estimatedRows')">
                <span class="truncate">{{ t("objects.rows") }}</span>
                <component :is="sortIconFor('estimatedRows')" v-if="sortIconFor('estimatedRows')" class="h-3 w-3 shrink-0" />
              </button>
              <div
                class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                @mousedown="onObjectColumnResizeStart('estimatedRows', $event)"
                @dblclick="resetObjectColumnWidth('estimatedRows', 110, $event)"
              >
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" :title="t('objects.statisticsHint')" @click="toggleSort('totalBytes')">
                <span class="truncate">{{ t("objects.size") }}</span>
                <component :is="sortIconFor('totalBytes')" v-if="sortIconFor('totalBytes')" class="h-3 w-3 shrink-0" />
              </button>
              <div
                class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                @mousedown="onObjectColumnResizeStart('totalBytes', $event)"
                @dblclick="resetObjectColumnWidth('totalBytes', 100, $event)"
              >
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div v-if="hasCreatedAt" class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort('created_at')">
                <span class="truncate">{{ t("objects.createdAt") }}</span>
                <component :is="sortIconFor('created_at')" v-if="sortIconFor('created_at')" class="h-3 w-3 shrink-0" />
              </button>
              <div
                class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                @mousedown="onObjectColumnResizeStart('created_at', $event)"
                @dblclick="resetObjectColumnWidth('created_at', 150, $event)"
              >
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div v-if="hasUpdatedAt" class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort('updated_at')">
                <span class="truncate">{{ t("objects.updatedAt") }}</span>
                <component :is="sortIconFor('updated_at')" v-if="sortIconFor('updated_at')" class="h-3 w-3 shrink-0" />
              </button>
              <div
                class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                @mousedown="onObjectColumnResizeStart('updated_at', $event)"
                @dblclick="resetObjectColumnWidth('updated_at', 150, $event)"
              >
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
            <div class="relative flex min-w-0 items-center">
              <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort('comment')">
                <span class="truncate">{{ t("objects.comment") }}</span>
                <component :is="sortIconFor('comment')" v-if="sortIconFor('comment')" class="h-3 w-3 shrink-0" />
              </button>
              <div
                class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
                @mousedown="onObjectColumnResizeStart('comment', $event)"
                @dblclick="resetObjectColumnWidth('comment', 260, $event)"
              >
                <GripVertical class="h-3 w-3" />
              </div>
            </div>
          </div>
          <RecycleScroller ref="listScrollerRef" class="object-browser-scroller min-h-0 flex-1" :style="{ minWidth: `${objectGridMinWidth}px` }" :items="filteredRows" :item-size="34" :buffer="600" :skip-hover="true" key-field="id">
            <template #default="{ item }">
              <CustomContextMenu :items="getObjectBrowserMenuItems(item)" v-slot="{ onContextMenu }">
                <div
                  class="grid h-[34px] cursor-pointer items-center gap-3 border-b px-3 hover:bg-accent/50"
                  :class="{
                    'bg-accent/40': sourceRow?.id === item.id,
                    'bg-primary/10': sidePanelRow?.id === item.id && !selectedTableIds.has(item.id),
                    'bg-primary/5': selectedTableIds.has(item.id),
                  }"
                  :style="{ gridTemplateColumns, boxShadow: sidePanelRow?.id === item.id && !selectedTableIds.has(item.id) ? 'inset 3px 0 0 hsl(var(--primary))' : undefined }"
                  @click="onRowClick(item, $event)"
                  @contextmenu="onContextMenu"
                >
                  <button v-if="showCheckboxColumn" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" :class="{ invisible: item.type !== 'TABLE' }" @click.stop="toggleTableSelection(item)">
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
                    <span v-else-if="item.partitionParentId" class="ml-4 h-5 w-5 shrink-0" />
                    <component :is="iconFor(item)" class="h-3.5 w-3.5 shrink-0" :class="iconClass(item.type)" />
                    <span class="truncate text-[13px] font-medium text-foreground" :title="item.displayName">{{ item.displayName }}</span>
                    <span v-if="item.partitionCount" class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                      {{ t("objects.partitions", { count: item.partitionCount }) }}
                    </span>
                  </div>
                  <div class="truncate text-xs text-muted-foreground">{{ typeLabel(item.type) }}</div>
                  <div class="truncate text-xs tabular-nums text-muted-foreground" :title="item.estimatedRows == null ? '' : formatObjectBrowserCount(item.estimatedRows)">
                    {{ formatObjectBrowserCount(item.estimatedRows) }}
                  </div>
                  <div class="truncate text-xs tabular-nums text-muted-foreground" :title="item.totalBytes == null ? '' : formatObjectBrowserBytes(item.totalBytes)">
                    {{ formatObjectBrowserBytes(item.totalBytes) }}
                  </div>
                  <div v-if="hasCreatedAt" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.created_at)">
                    {{ formatObjectBrowserTimestamp(item.created_at) }}
                  </div>
                  <div v-if="hasUpdatedAt" class="truncate text-xs tabular-nums text-muted-foreground" :title="formatObjectBrowserTimestamp(item.updated_at)">
                    {{ formatObjectBrowserTimestamp(item.updated_at) }}
                  </div>
                  <div class="truncate text-xs text-muted-foreground" :title="item.comment || ''">
                    {{ item.comment || "" }}
                  </div>
                </div>
              </CustomContextMenu>
            </template>
          </RecycleScroller>
        </div>
        <div v-else ref="gridContainerRef" class="object-browser-grid-wrapper min-h-0 flex-1 p-2">
          <RecycleScroller ref="gridScrollerRef" v-if="gridRows.length > 0" class="object-browser-grid-scroller h-full" :items="gridRows" :item-size="objectGridRowHeight" :buffer="600" :skip-hover="true" key-field="key">
            <template #default="{ item: row }">
              <div class="object-browser-grid-row" :style="{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))`, height: `${objectGridRowHeight - OBJECT_GRID_GAP}px` }">
                <CustomContextMenu v-for="item in row.cards" :key="item.id" :items="getObjectBrowserMenuItems(item)" v-slot="{ onContextMenu }">
                  <div
                    class="relative flex h-full min-h-0 cursor-pointer flex-col items-center gap-1 rounded-lg border bg-card p-3 text-center transition-all hover:border-primary/40 hover:shadow-sm"
                    :class="{
                      'border-primary bg-primary/5': selectedTableIds.has(item.id),
                      'border-primary/60': sourceRow?.id === item.id && !selectedTableIds.has(item.id),
                      'border-primary bg-primary/8 shadow-sm': sidePanelRow?.id === item.id && !selectedTableIds.has(item.id),
                    }"
                    :title="item.displayName"
                    @click="onRowClick(item, $event)"
                    @contextmenu="onContextMenu"
                  >
                    <button v-if="showCheckboxColumn" class="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" type="button" :class="{ invisible: item.type !== 'TABLE' }" @click.stop="toggleTableSelection(item)">
                      <CheckSquare v-if="selectedTableIds.has(item.id)" class="h-3.5 w-3.5 text-primary" />
                      <Square v-else class="h-3.5 w-3.5" />
                    </button>
                    <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full shadow-sm" :class="iconBgClass(item.type)">
                      <component :is="iconFor(item)" class="h-6 w-6" :class="iconClass(item.type)" />
                    </div>
                    <span class="w-full truncate text-sm font-medium leading-tight text-foreground">{{ item.displayName }}</span>
                    <div class="flex items-center gap-1.5">
                      <span class="text-xs text-muted-foreground">{{ typeLabel(item.type) }}</span>
                      <span v-if="item.estimatedRows != null && item.estimatedRows > 0" class="object-browser-stat-badge object-browser-stat-badge-rows rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">{{
                        formatObjectBrowserCount(item.estimatedRows)
                      }}</span>
                      <span v-if="item.totalBytes != null && item.totalBytes > 0" class="object-browser-stat-badge object-browser-stat-badge-bytes rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{{ formatObjectBrowserBytes(item.totalBytes) }}</span>
                    </div>
                    <!-- Always reserve timestamp/comment slots when the dataset has them so every card shares one height. -->
                    <div v-if="hasCreatedAt || hasUpdatedAt" class="flex min-h-[15px] items-center gap-1 text-[10px] leading-[15px] text-muted-foreground/70">
                      <span v-if="item.created_at?.trim()">{{ formatObjectBrowserTimestamp(item.created_at) }}</span>
                      <span v-if="item.created_at?.trim() && item.updated_at?.trim()">·</span>
                      <span v-if="item.updated_at?.trim()">{{ formatObjectBrowserTimestamp(item.updated_at) }}</span>
                    </div>
                    <div v-if="hasAnyComment" class="w-full truncate text-[10px] leading-[15px] text-muted-foreground/60" :title="item.comment?.trim() || undefined">
                      {{ item.comment?.trim() || "\u00A0" }}
                    </div>
                  </div>
                </CustomContextMenu>
              </div>
            </template>
          </RecycleScroller>
        </div>
      </div>
      <!-- Right-side panel: table info or source -->
      <div v-if="sidePanelRow" class="object-browser-side-panel relative flex min-h-0 shrink-0 flex-col border-l bg-background" :class="{ 'side-panel-resizing': isResizingSidePanel }" :style="{ width: `${sidePanelWidth}px` }">
        <div class="absolute left-0 top-0 bottom-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="onSidePanelResizeStart" />
        <!-- Table info mode -->
        <template v-if="sidePanelMode === 'table-info'">
          <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20 h-9">
            <TableProperties class="w-3.5 h-3.5 text-muted-foreground" />
            <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ sidePanelRow?.name }}</span>
            <div v-if="tableInfoTab === 'ddl'" class="table-info-actions flex min-w-0 shrink-0 items-center gap-1">
              <Button variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyTableDdl">
                <Copy class="w-3 h-3" />
                <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
              </Button>
              <Button variant="ghost" size="icon" class="h-6 w-6" :class="{ 'bg-accent': tableInfoWrap }" @click="tableInfoWrap = !tableInfoWrap">
                <WrapText class="w-3 h-3" />
              </Button>
            </div>
            <Button v-if="canOpenTableStructureEditor" variant="ghost" size="sm" class="table-info-action-button h-6 px-2 text-xs" :title="t('contextMenu.editStructure')" :aria-label="t('contextMenu.editStructure')" @click="openTableStructureEditor">
              <PencilRuler class="w-3 h-3" />
              <span class="table-info-action-label">{{ t("contextMenu.editStructure") }}</span>
            </Button>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeSidePanel">
              <X class="w-3 h-3" />
            </Button>
          </div>
          <div class="grid border-b bg-background shrink-0" :style="tableInfoTabListStyle">
            <button
              v-for="tab in tableInfoTabs"
              :key="tab.id"
              class="h-9 min-w-0 px-1.5 text-[11px] border-b-2 transition-colors"
              :class="tableInfoTab === tab.id ? 'border-primary bg-gray-300/80 text-foreground dark:bg-gray-700/80' : 'border-transparent text-muted-foreground hover:bg-gray-200 hover:text-foreground dark:hover:bg-gray-800/50'"
              :title="tab.label"
              @click="selectTableInfoTab(tab.id)"
            >
              <component :is="tab.icon" class="mx-auto h-3.5 w-3.5" />
              <span class="block truncate">{{ tab.label }}</span>
            </button>
          </div>
          <div class="px-2 py-1.5 border-b shrink-0 bg-background">
            <div class="relative">
              <Search class="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <input v-model="tableInfoSearchQuery" :placeholder="t('grid.tableInfoSearch')" class="w-full h-7 pl-7 pr-6 text-xs bg-muted/50 rounded border border-border focus:outline-none focus:border-primary/50" @keydown.escape="tableInfoSearchQuery = ''" />
              <button v-if="tableInfoSearchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="tableInfoSearchQuery = ''">
                <X class="w-3 h-3" />
              </button>
            </div>
          </div>
          <div v-if="tableInfoTab === 'columns'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableColumnsLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableColumns.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <table v-else class="w-full text-xs">
              <thead class="sticky top-0 bg-muted text-muted-foreground">
                <tr class="border-b">
                  <th class="text-left text-nowrap font-medium px-3 py-2 w-8">#</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnName") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.columnType") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("grid.tableInfoNullable") }}</th>
                  <th class="text-left text-nowrap font-medium px-3 py-2">{{ t("structureEditor.defaultValue") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(column, index) in filteredTableColumns" :key="column.name" class="border-b hover:bg-gray-200 dark:hover:bg-gray-800/30" :title="column.name">
                  <td class="px-3 py-2 text-muted-foreground w-8">{{ index + 1 }}</td>
                  <td class="px-3 py-2 font-medium">
                    <span class="inline-flex items-center gap-1.5">
                      <KeyRound v-if="column.is_primary_key" class="h-3 w-3 text-amber-500" />
                      {{ column.name }}
                    </span>
                    <div v-if="column.comment" class="mt-0.5 text-[11px] text-muted-foreground truncate">
                      {{ column.comment }}
                    </div>
                  </td>
                  <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground">{{ column.data_type }}</td>
                  <td class="px-3 py-2">{{ column.is_nullable ? "YES" : "NO" }}</td>
                  <td data-table-info-column-default class="max-w-56 px-3 py-2 font-mono text-[11px]" :class="{ 'text-muted-foreground/70': column.column_default == null }" :title="column.column_default ?? undefined">
                    <span class="block max-w-56 truncate">{{ tableColumnDefaultDisplayValue(column.column_default) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="tableInfoTab === 'indexes'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableIndexesLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableIndexes.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="index in filteredTableIndexes" :key="index.name" class="p-3 text-xs">
                <div class="flex items-start gap-2">
                  <div class="min-w-0 flex-1">
                    <div class="font-medium truncate">{{ index.name }}</div>
                    <div class="mt-1 flex flex-wrap gap-1">
                      <span v-if="index.is_primary" class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-600">PK</span>
                      <span v-if="index.is_unique" class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-600">UNIQUE</span>
                      <span v-if="index.index_type" class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{{ index.index_type }}</span>
                    </div>
                    <div class="mt-2 font-mono text-[11px] text-muted-foreground break-all">
                      {{ index.columns.join(", ") }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'foreignKeys'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableForeignKeysLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableForeignKeys.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="fk in filteredTableForeignKeys" :key="`${fk.name}:${fk.column}`" class="p-3 text-xs">
                <div class="font-medium truncate">{{ fk.name }}</div>
                <div class="mt-1 font-mono text-[11px] text-muted-foreground break-all">{{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}</div>
              </div>
            </div>
          </div>
          <div v-else-if="tableInfoTab === 'triggers'" class="flex-1 min-h-0 overflow-auto">
            <div v-if="tableTriggersLoading" class="h-full flex items-center justify-center">
              <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
            <div v-else-if="tableInfoSearchQuery && filteredTableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoNoResults") }}
            </div>
            <div v-else-if="tableTriggers.length === 0" class="p-6 text-center text-xs text-muted-foreground">
              {{ t("grid.tableInfoEmpty") }}
            </div>
            <div v-else class="divide-y">
              <div v-for="trigger in filteredTableTriggers" :key="trigger.name" class="p-3 text-xs">
                <div class="font-medium truncate">{{ trigger.name }}</div>
                <div class="mt-1 text-[11px] text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
              </div>
            </div>
          </div>
          <pre
            v-else-if="tableInfoTab === 'ddl' && !tableDdlLoading"
            ref="tableInfoDdlPreRef"
            data-native-clipboard
            tabindex="0"
            class="flex-1 min-w-0 text-xs font-mono p-3 overflow-auto ddl-code leading-5 select-text outline-none"
            :class="tableInfoWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
            v-html="filteredTableDdlContent"
            @keydown="onTableInfoDdlKeydown"
          ></pre>
          <div v-else class="flex-1 flex items-center justify-center">
            <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        </template>
        <!-- Source mode (views, procedures, functions, sequences) -->
        <template v-else>
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
            <Button v-if="!sourceEditing && sourceCanEdit" variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="editSource">
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
            <QueryEditor
              v-model="sourceDraft"
              class="min-h-0 flex-1"
              :connection-id="props.connection.id"
              :database="props.database"
              :schema="selectedSchema"
              :database-type="props.connection.db_type"
              :dialect="sourceDialect"
              :format-dialect="sourceFormatDialect"
              force-word-wrap
              @save="saveSource"
            />
            <div v-if="sourceSaveError" class="shrink-0 border-t px-3 py-2 text-xs text-destructive">
              {{ sourceSaveError }}
            </div>
          </div>
          <QueryEditor
            v-else
            :key="`source-preview-${sourceRow?.id}`"
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
        </template>
      </div>
    </div>
  </div>

  <DangerConfirmDialog v-model:open="showDropConfirm" :title="dropConfirmTitle()" :message="dropConfirmMessage()" :sql="dropPreviewSql" :confirm-label="t('dangerDialog.deleteConfirm')" @confirm="confirmDrop">
    <template v-if="canDropTargetCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="dropTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="refreshDropPreviewSql()" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.dropTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.dropTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

  <DangerConfirmDialog v-model:open="showBatchDropConfirm" :title="t('objects.confirmBatchDropTitle')" :message="t('objects.confirmBatchDropMessage', { count: selectedTableCount })" :sql="batchDropPreviewSql" :confirm-label="t('objects.dropSelected')" @confirm="confirmBatchDropTables">
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

  <DangerConfirmDialog
    v-model:open="showBatchTruncateConfirm"
    :title="t('objects.confirmBatchTruncateTitle')"
    :message="t('objects.confirmBatchTruncateMessage', { count: selectedTableCount })"
    :sql="batchTruncatePreviewSql"
    :confirm-label="t('objects.truncateSelected')"
    @confirm="confirmBatchTruncateTables"
  >
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

  <DangerConfirmDialog
    v-model:open="showBatchEmptyConfirm"
    :title="t('contextMenu.confirmBatchEmptyTitle', { count: batchEmptyPlan.length })"
    :message="t('contextMenu.confirmBatchEmptyMessage', { count: batchEmptyPlan.length })"
    :sql="batchEmptyPreviewSql"
    :confirm-label="t('contextMenu.batchEmpty', { count: batchEmptyPlan.length })"
    @confirm="confirmBatchEmptyTables"
  />

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
  >
    <template v-if="canTruncateTargetCascade" #options>
      <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <input v-model="truncateTableCascade" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="truncateTarget && refreshTruncatePreviewSql(truncateTarget)" />
        <span class="grid gap-0.5">
          <span class="font-medium text-foreground">{{ t("contextMenu.truncateTableCascade") }}</span>
          <span class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.truncateTableCascadeHint") }}</span>
        </span>
      </label>
    </template>
  </DangerConfirmDialog>

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
</template>

<style scoped>
.object-browser-table {
  scrollbar-width: thin;
}

.object-browser-scroller {
  will-change: scroll-position;
  contain: content;
}

.object-browser-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.object-browser-grid-wrapper {
  scrollbar-width: thin;
}

.object-browser-grid-scroller {
  will-change: scroll-position;
  contain: content;
  scrollbar-width: thin;
}

.object-browser-grid-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.object-browser-grid-row {
  display: grid;
  column-gap: 12px;
  /* Stretch so cards with/without comment share one border height in the row. */
  align-items: stretch;
}

.object-browser-icon-bg-table {
  background-color: rgba(34, 197, 94, 0.1);
}

.object-browser-icon-bg-view {
  background-color: rgba(168, 85, 247, 0.1);
}

.object-browser-icon-bg-procedure {
  background-color: rgba(59, 130, 246, 0.1);
}

.object-browser-icon-bg-function {
  background-color: rgba(245, 158, 11, 0.1);
}

.object-browser-icon-bg-sequence {
  background-color: rgba(16, 185, 129, 0.1);
}

.object-browser-icon-bg-package {
  background-color: rgba(6, 182, 212, 0.1);
}

.object-browser-stat-badge {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  line-height: 1rem;
  white-space: nowrap;
}

.object-browser-stat-badge-rows {
  color: var(--primary);
  background-color: rgba(23, 23, 23, 0.1);
}

.object-browser-stat-badge-bytes {
  color: var(--muted-foreground);
  background-color: var(--muted);
}

:global(.dark) .object-browser-stat-badge-rows {
  background-color: rgba(208, 208, 214, 0.12);
}

.side-panel-resizing {
  user-select: none;
  pointer-events: none;
}

.ddl-code {
  container-type: inline-size;
}

.object-browser-side-panel {
  container-type: inline-size;
}

.table-info-action-button {
  gap: 0.25rem;
  max-width: 8rem;
  overflow: hidden;
  transition:
    max-width 180ms ease,
    padding-inline 180ms ease;
}

.table-info-action-label {
  min-width: 0;
  max-width: 6rem;
  overflow: hidden;
  white-space: nowrap;
  opacity: 1;
  transition:
    max-width 180ms ease,
    opacity 120ms ease;
}

@container (max-width: 360px) {
  .table-info-action-button {
    width: 1.5rem;
    max-width: 1.5rem;
    padding-inline: 0;
  }

  .table-info-action-label {
    max-width: 0;
    opacity: 0;
  }
}
</style>
