<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Database, Info, KeyRound, ListChevronsUpDown, Loader2, Maximize2, Pencil, Plus, RefreshCw, Save, Search, Settings, SlidersHorizontal, Trash2, UserRound, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore, type StructureEditorDensity } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { useToast } from "@/composables/useToast";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sql/sqlHighlighter";
import { joinSqlStatementsForScript } from "@/lib/sql/sqlBatchScript";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { queryTimeoutSecsForConcurrentIndex, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { invalidateObjectDdl, loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { invalidateObjectMetadataCache, loadObjectMetadataFacet, type ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import { type BuildTableStructureChangeSqlOptions, type EditableStructureColumn, type EditableStructureForeignKey, type EditableStructureIndex, type EditableStructureTrigger } from "@/lib/table/tableStructureEditorSql";
import { buildMysqlAutoIncrementCounterStatement, canEditMysqlAutoIncrementCounter, refreshMysqlAutoIncrementCounterDraft } from "@/lib/table/mysqlAutoIncrementCounter";
import { MYSQL_STORAGE_ENGINES_SQL, mysqlTableEngineSql, mysqlTableEngineSqlOption, parseMysqlTableEngineMetadata, refreshMysqlTableEngineDraft, supportsMysqlTableEngine } from "@/lib/table/mysqlTableEngine";
import { PRESET_FIELDS_TEMPLATE_ID, createTableColumnTemplateDrafts } from "@/lib/table/tableColumnTemplates";
import { getMysqlDataTypeHelp } from "@/lib/table/mysqlDataTypeHelp";
import { getPostgresDataTypeHelp, gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import { getSqliteDataTypeHelp } from "@/lib/table/sqliteDataTypeHelp";
import { getTableMetadataCapabilities, firstStructureMetadataTab, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";
import { constraintsForConstraintsTab } from "@/lib/table/constraintPresentation";
import { hasTableStructureRefreshWork, unloadedTableStructureRefreshScope, visibleTableStructureRefreshScope, type TableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";
import { canAddTableStructureColumn, getTableStructureCapabilities, hasLocalTableColumnOrderChange, isPhysicalTableColumnOrderChange, sanitizeStructureIndexesForCapabilities, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";
import { getConcurrentIndexAvailability, concurrentIndexNamesInStatements, normalizeUnsupportedConcurrentIndexes, type ConcurrentIndexAvailability } from "@/lib/table/concurrentIndexAvailability";
import { orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";
import { loadTableDataGridColumnOrder, notifyTableDataGridColumnOrderChanged, removeTableDataGridColumnOrder, saveTableDataGridColumnOrder, tableDataGridColumnOrderScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { codeMirrorSqlDialectForConnection, connectionObjectTreeQuerySchema, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { postgresListRolesSql, usersFromPostgresRolesResult } from "@/lib/database/databaseUserAdmin";
import type { ColumnInfo, ConstraintInfo, TableInfo, TableInfoTab, TableStructureEditorDraft, TableStructureEditorTarget, TableStructureEditorViewport } from "@/types/database";
import {
  applyManticoreDdlColumnExtras,
  buildStructureTargetLabel,
  canEditStructuredTriggerDraft,
  canEditManticoreColumnProperties,
  cloneColumnDraftAsNew,
  combineDataTypeForDatabase,
  combineDataTypeForDatabaseWithLengthUnit,
  createCopiedColumnDrafts,
  createColumnDrafts,
  createForeignKeyDrafts,
  createIndexDrafts,
  createTriggerDrafts,
  dataTypeBaseInputValue,
  dataTypeLengthInputValue,
  dataTypeLengthUnitValue,
  defaultNewColumnDataType,
  filterStructureIndexColumnOptions,
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  getDataTypeLengthUnitOptions,
  getDefaultLengthForType,
  hasExistingColumnTypeChange,
  isDataTypeLengthDisabled,
  isDamengIdentityCompatibleDataType,
  isMysqlEnumDataType,
  isMysqlCharacterDataType,
  isProtectedManticoreIdColumn,
  isSqlServerIdentityCompatibleDataType,
  mysqlEnumDataType,
  parseExtraToColumnExtra,
  rehydrateColumnDraftsFromMetadata,
  resolveInsertColumnIndex,
  restoreCharacterLengthUnitsAfterSave,
  sameStructureIndexType,
  structureColumnSelectionRange,
  isSyntheticContextMenuClick,
  resolveColumnSelectionActiveId,
  tableStructureIdentifierComparisonKey,
  toColumnNames,
} from "@/lib/table/tableStructureEditorState";
import { CREATE_DATABASE_CHARSET_OPTIONS, createDatabaseCollationOptionsForCharset, fallbackCreateDatabaseCharsetMetadata, normalizeCreateDatabaseCharsetKey, parseCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import type { CreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import * as api from "@/lib/backend/api";
import type { EditorView } from "@codemirror/view";

const { t } = useI18n();
const { isDark, themePalette } = useTheme();
const store = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
const queryStore = useQueryStore();
const historyStore = useHistoryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const rootRef = ref<HTMLElement>();
type StructureScrollerRef = HTMLElement | { $el?: HTMLElement };
const columnsScrollerRef = ref<StructureScrollerRef>();
const indexesScrollerRef = ref<StructureScrollerRef>();
const foreignKeysScrollerRef = ref<StructureScrollerRef>();
const constraintsScrollerRef = ref<StructureScrollerRef>();
const triggersScrollerRef = ref<StructureScrollerRef>();
const ddlScrollerRef = ref<StructureScrollerRef>();
const structureHorizontalScrollbarTrackRef = ref<HTMLDivElement>();
const structureHorizontalScrollbarThumbRef = ref<HTMLDivElement>();
const hasStructureHorizontalOverflow = ref(false);
const dynamicDataTypeOptionsCache = new Map<string, string[]>();

const sqlHighlighter = ref<SqlHighlighter>();
const SQL_PREVIEW_DEBOUNCE_MS = 300;
onMounted(async () => {
  sqlHighlighter.value = await createShikiSqlHighlighter({
    appearance: () => (isDark.value ? "dark" : "light"),
  });
});

const highlightedSql = computed(() => {
  if (!pendingStatements.value.length) return "";
  const sql = previewSqlText.value;
  return sqlHighlighter.value?.(sql) ?? sql;
});
const previewSqlText = computed(() => joinSqlStatementsForScript(pendingStatements.value, databaseType.value));

const props = defineProps<{
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
  initialTab?: TableInfoTab;
  initialTabRequestId?: number;
  initialTarget?: TableStructureEditorTarget;
  draft?: TableStructureEditorDraft;
}>();

const emit = defineEmits<{
  "update:draft": [draft: TableStructureEditorDraft | undefined];
  saved: [commentChanged: boolean];
  close: [];
  openSettings: [initialTab?: string, initialSection?: string];
}>();

const activeTab = ref<TableInfoTab>("columns");
const loading = ref(false);
const saving = ref(false);
const postSaveRefreshing = ref(false);
const sqlPreviewLoading = ref(false);
const sqlPreviewPending = ref(false);
const indexesLoading = ref(false);
const foreignKeysLoading = ref(false);
const constraintsLoading = ref(false);
const triggersLoading = ref(false);
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlEditorContainer = ref<HTMLDivElement>();
const ddlSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const ddlSearchOpen = ref(false);
const ddlEditorView = shallowRef<EditorView | null>(null);
let ddlEditorInitRequestId = 0;
let ddlEditorScrollCleanup: (() => void) | null = null;
const loadedMetadataFacets = new Set<ObjectMetadataFacet>();
let structureEditorReady = false;
const ddlFetched = ref(false);

function ddlEditorDocument(): string {
  return ddlContent.value || t("structureEditor.emptyReadonly");
}

function destroyDdlEditor() {
  ddlEditorInitRequestId += 1;
  ddlEditorScrollCleanup?.();
  ddlEditorScrollCleanup = null;
  ddlEditorView.value?.destroy();
  ddlEditorView.value = null;
}

function updateDdlEditorContent(content: string): boolean {
  const view = ddlEditorView.value;
  if (!view) return false;
  if (view.state.doc.toString() !== content) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
    });
  }
  return true;
}

function observeDdlEditorScroll(view: EditorView) {
  ddlEditorScrollCleanup?.();
  const scrollDOM = view.scrollDOM;
  const onScroll = (event: Event) => onStructureContentScroll("ddl", event);
  scrollDOM.addEventListener("scroll", onScroll, { passive: true });
  ddlEditorScrollCleanup = () => scrollDOM.removeEventListener("scroll", onScroll);
}

async function initDdlEditor(content: string) {
  const container = ddlEditorContainer.value;
  if (!container) return;

  const existingView = ddlEditorView.value;
  if (existingView?.dom.parentElement === container) {
    updateDdlEditorContent(content);
    existingView.focus();
    return;
  }
  if (existingView) destroyDdlEditor();

  const requestId = ++ddlEditorInitRequestId;
  const [{ EditorView, keymap }, { EditorState, Prec }, langSql, { basicSetup }, { search: cmSearch }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror"), import("@codemirror/search")]);
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) return;

  const editorSettings = settingsStore.editorSettings;
  const themeExt = await loadEditorTheme(editorSettings.theme, isDark.value ? "dark" : "light", undefined, themePalette.value);
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) return;

  const fontExt = editorFontTheme(EditorView, editorSettings.fontSize, editorSettings.fontFamily, { fixedHeight: true, scrollable: true });
  const dialect = createDbxCodeMirrorSqlDialect(langSql, codeMirrorSqlDialectForConnection(connection.value), databaseType.value, connection.value?.driver_profile);
  const state = EditorState.create({
    doc: content,
    extensions: [
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
        scrollToMatch: (range) => EditorView.scrollIntoView(range, { y: "center" }),
      }),
      basicSetup,
      EditorState.allowMultipleSelections.of(true),
      langSql.sql({ dialect }),
      themeExt,
      fontExt,
      Prec.highest(keymap.of([{ key: "Mod-f", run: () => ddlSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }])),
      EditorView.theme({
        "&.cm-focused": { outline: "none" },
        ".cm-content": {
          cursor: "text",
          padding: "0.75rem",
          userSelect: "text",
          WebkitUserSelect: "text",
        },
        ".cm-line": {
          userSelect: "text",
          WebkitUserSelect: "text",
        },
      }),
      EditorState.readOnly.of(true),
    ],
  });
  const editorView = new EditorView({ state, parent: container });
  if (requestId !== ddlEditorInitRequestId || activeTab.value !== "ddl" || loading.value || ddlLoading.value || ddlEditorContainer.value !== container) {
    editorView.destroy();
    return;
  }
  ddlEditorView.value = editorView;
  observeDdlEditorScroll(editorView);
  editorView.focus();
  restoreStructureScrollPosition("ddl");
}

function scheduleDdlEditorInit() {
  void nextTick(() => {
    if (activeTab.value !== "ddl" || loading.value || ddlLoading.value) return;
    void initDdlEditor(ddlEditorDocument());
  });
}

function ddlRequest() {
  return {
    connectionId: props.connectionId,
    database: props.database,
    schema: metadataSchema.value,
    tableName: props.tableName,
    catalog: props.catalog,
  };
}

async function fetchDdl(force = false) {
  if (!props.connectionId || !props.database || !props.tableName || (!force && ddlFetched.value) || !tableMetadataCapabilities.value.ddl) return;
  if (force) destroyDdlEditor();
  ddlLoading.value = true;
  try {
    const { ddl } = await loadObjectDdl(ddlRequest(), { force });
    ddlContent.value = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(databaseType.value), settingsStore.editorSettings.sqlFormatter);
    ddlFetched.value = true;
  } catch (e: any) {
    ddlContent.value = `-- Error: ${e?.message || e}`;
    ddlFetched.value = true;
  } finally {
    ddlLoading.value = false;
  }
}
const errorMessage = ref("");
const secondaryMetadataErrors = ref<Partial<Record<ObjectMetadataFacet, string>>>({});
const columns = ref<EditableStructureColumn[]>([]);
const copyColumnsDialogOpen = ref(false);
const copySourceTables = ref<TableInfo[]>([]);
const copySourceTableName = ref("");
const copySourceTableSearch = ref("");
const copySourceColumns = ref<ColumnInfo[]>([]);
const copySourceColumnSearch = ref("");
const selectedCopySourceColumnNames = ref<string[]>([]);
const copySourceTablesLoading = ref(false);
const copySourceTablesOffset = ref(0);
const copySourceTablesHasMore = ref(false);
const copySourceColumnsLoading = ref(false);
const copySourceError = ref("");
const COPY_SOURCE_TABLE_PAGE_SIZE = 100;
const COPY_SOURCE_TABLE_PAGE_PROBE_SIZE = COPY_SOURCE_TABLE_PAGE_SIZE + 2;
const COPY_SOURCE_TABLE_SEARCH_DEBOUNCE_MS = 250;
let copySourceTablesRequestId = 0;
let copySourceColumnsRequestId = 0;
let copySourceTableSearchTimer: ReturnType<typeof setTimeout> | undefined;
const indexes = ref<EditableStructureIndex[]>([]);
/** PostgreSQL partitioned parent (`relkind = 'p'`): `CREATE INDEX CONCURRENTLY`
 * is rejected by the server on such tables, so the option is disabled here and
 * the SQL builder refuses any concurrent request on it (fail closed). */
const isPartitionedParent = ref(false);
/** Whether the last partition-status probe succeeded. When it cannot be
 * verified (probe failed), Concurrent is disabled — we must not assume a
 * non-partitioned table we could not check. */
const partitionStatusKnown = ref(true);
/** Set when a `concurrently: true` index draft had to be normalized away
 * because Concurrent availability became unknown/unsupported (partition probe
 * failure, partitioned parent, capability loss). While set, no SQL is
 * generated and Save stays blocked until the user re-verifies (the next
 * successful probe clears it) — a cleared flag must never silently degrade
 * into a blocking `CREATE INDEX`. */
const concurrentAvailabilityInvalidated = ref(false);
const pendingStatements = ref<string[]>([]);
const warnings = ref<string[]>([]);
const sqliteSchemaRevision = ref<string>();
const foreignKeys = ref<EditableStructureForeignKey[]>([]);
const constraints = ref<ConstraintInfo[]>([]);
const constraintsLoaded = ref(false);
// The Constraints tab hides foreign keys when the dedicated Foreign Keys tab
// is also shown, mirroring DataGrid/ObjectBrowser.
const constraintsForTab = computed(() => constraintsForConstraintsTab(constraints.value, tableMetadataCapabilities.value.foreignKeys));
const triggers = ref<EditableStructureTrigger[]>([]);
const triggersLoaded = ref(false);
const secondaryMetadataLoading = computed(() => indexesLoading.value || foreignKeysLoading.value || constraintsLoading.value || triggersLoading.value);

function sameList(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameText(left: string | null | undefined, right: string | null | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function columnChanged(column: EditableStructureColumn, index: number): boolean {
  if (!column.original || column.markedForDrop) return true;
  const original = column.original;
  return (
    isPhysicalTableColumnOrderChange(databaseType.value, connection.value?.db_type, column.originalPosition, index) ||
    column.name !== original.name ||
    column.dataType !== original.data_type ||
    column.isNullable !== original.is_nullable ||
    !sameText(column.defaultValue, original.column_default) ||
    !sameText(column.comment, original.comment) ||
    column.isPrimaryKey !== original.is_primary_key ||
    !sameText(column.characterSet, original.character_set) ||
    !sameText(column.collation, original.collation) ||
    JSON.stringify(column.extra) !== JSON.stringify(parseExtraToColumnExtra(original.extra, databaseType.value))
  );
}

function indexChanged(index: EditableStructureIndex): boolean {
  if (!index.original || index.markedForDrop) return true;
  const original = index.original;
  return (
    index.name !== original.name ||
    !sameList(index.columns, original.columns) ||
    index.isUnique !== original.is_unique ||
    !sameText(index.filter, original.filter) ||
    !sameStructureIndexType(index.indexType, original.index_type) ||
    !sameList(index.includedColumns, original.included_columns) ||
    !sameText(index.comment, original.comment) ||
    !!index.concurrently
  );
}

function foreignKeyChanged(foreignKey: EditableStructureForeignKey): boolean {
  if (!foreignKey.original || foreignKey.markedForDrop) return true;
  const original = foreignKey.original;
  return (
    foreignKey.name !== original.name ||
    foreignKey.column !== original.column ||
    !sameText(foreignKey.refSchema, original.ref_schema) ||
    foreignKey.refTable !== original.ref_table ||
    foreignKey.refColumn !== original.ref_column ||
    !sameText(foreignKey.onUpdate, original.on_update) ||
    !sameText(foreignKey.onDelete, original.on_delete)
  );
}

function triggerChanged(trigger: EditableStructureTrigger): boolean {
  if (!trigger.original || trigger.markedForDrop) return true;
  const original = trigger.original;
  return trigger.name !== original.name || trigger.timing !== original.timing || trigger.event !== original.event || !sameText(trigger.statement, original.statement);
}

function captureStructureRefreshScope(): TableStructureRefreshScope {
  return {
    columns: columns.value.some(columnChanged),
    indexes: indexes.value.some(indexChanged),
    foreignKeys: foreignKeys.value.some(foreignKeyChanged),
    // Constraints have no editable draft of their own, but column/index/FK
    // saves can change what constraints exist (e.g. toggling a primary key),
    // so refresh the tab if it was ever loaded rather than leaving it stale.
    constraints: constraintsLoaded.value,
    triggers: triggers.value.some(triggerChanged),
    tableComment: tableComment.value !== originalTableComment.value,
  };
}

function isPlainModShortcut(event: KeyboardEvent, key: string): boolean {
  if (event.isComposing || event.altKey || event.shiftKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key.toLowerCase() === key;
}

const structureDensityValues: StructureEditorDensity[] = ["compact", "standard", "comfortable"];
const STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY = "dbx-structure-editor-column-widths";
const STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY = "dbx-structure-editor-index-column-widths";
const STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY = "dbx-structure-editor-sql-preview-collapsed";
const FIELD_SHORTCUT_TOOLTIP_DELAY_MS = 500;
const STRUCTURE_COLUMN_WIDTH_COUNT = 12;
const STRUCTURE_INDEX_COLUMN_WIDTH_COUNT = 9;
const PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS = new Set([0, 1, 6]);
const structureDensityMetrics: Record<
  StructureEditorDensity,
  {
    columns: number[];
    indexes: number[];
    minColumnWidth: number;
    minLengthColumnWidth: number;
    minIndexColumnWidth: number;
    actionButtonWidth: number;
    fontSize: number;
    shellPadding: number;
    cellPaddingX: number;
    cellPaddingY: number;
    headerPaddingY: number;
    controlHeight: number;
    controlPaddingX: number;
    iconSize: number;
    checkboxSize: number;
    lineHeight: number;
  }
> = {
  compact: {
    columns: [28, 168, 136, 82, 60, 52, 108, 220, 80, 120, 144, 108],
    indexes: [120, 180, 60, 88, 124, 144, 120, 84, 70],
    minColumnWidth: 24,
    minLengthColumnWidth: 140,
    minIndexColumnWidth: 48,
    actionButtonWidth: 24,
    fontSize: 11,
    shellPadding: 10,
    cellPaddingX: 6,
    cellPaddingY: 4,
    headerPaddingY: 5,
    controlHeight: 24,
    controlPaddingX: 8,
    iconSize: 14,
    checkboxSize: 13,
    lineHeight: 1.35,
  },
  standard: {
    columns: [32, 200, 160, 104, 72, 64, 128, 260, 90, 140, 160, 136],
    indexes: [148, 224, 72, 108, 148, 180, 148, 100, 84],
    minColumnWidth: 28,
    minLengthColumnWidth: 156,
    minIndexColumnWidth: 60,
    actionButtonWidth: 28,
    fontSize: 12,
    shellPadding: 12,
    cellPaddingX: 8,
    cellPaddingY: 5,
    headerPaddingY: 7,
    controlHeight: 28,
    controlPaddingX: 10,
    iconSize: 15,
    checkboxSize: 14,
    lineHeight: 1.4,
  },
  comfortable: {
    columns: [36, 232, 188, 116, 84, 76, 152, 300, 100, 160, 188, 148],
    indexes: [176, 260, 84, 124, 176, 216, 176, 116, 104],
    minColumnWidth: 32,
    minLengthColumnWidth: 176,
    minIndexColumnWidth: 64,
    actionButtonWidth: 32,
    fontSize: 13,
    shellPadding: 16,
    cellPaddingX: 10,
    cellPaddingY: 7,
    headerPaddingY: 9,
    controlHeight: 32,
    controlPaddingX: 12,
    iconSize: 16,
    checkboxSize: 16,
    lineHeight: 1.5,
  },
};

function isStructureEditorDensity(value: unknown): value is StructureEditorDensity {
  return structureDensityValues.includes(value as StructureEditorDensity);
}

function metricsForDensity(density: StructureEditorDensity) {
  return structureDensityMetrics[density];
}

function normalizeStructureColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value)) return null;
  let widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  // Backward compatibility: pad old 11-column persisted layout to 12 by inserting
  // a default collation width at index 9.
  if (widths.length === STRUCTURE_COLUMN_WIDTH_COUNT - 1) {
    const defaultWidths = metricsForDensity(density).columns;
    widths = [...widths.slice(0, 9), defaultWidths[9], ...widths.slice(9)];
  }
  if (widths.length !== STRUCTURE_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minColumnWidth;
  return widths.map((item) => Math.max(minWidth, item));
}

function normalizeStructureIndexColumnWidths(value: unknown, density: StructureEditorDensity): number[] | null {
  if (!Array.isArray(value) || value.length !== STRUCTURE_INDEX_COLUMN_WIDTH_COUNT) return null;
  const minWidth = metricsForDensity(density).minIndexColumnWidth;
  const widths = value.map((item) => Number(item));
  if (widths.some((item) => !Number.isFinite(item))) return null;
  return widths.map((item) => Math.max(minWidth, item));
}

function loadStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity): unknown {
  const raw = safeLocalStorageGet(storageKey);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<StructureEditorDensity, unknown>>;
    return parsed?.[density];
  } catch {
    return undefined;
  }
}

function loadStructureColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).columns];
  const stored = loadStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density);
  return normalizeStructureColumnWidths(stored, density) ?? fallback;
}

function loadStructureIndexColumnWidths(density: StructureEditorDensity): number[] {
  const fallback = [...metricsForDensity(density).indexes];
  const stored = normalizeStructureIndexColumnWidths(loadStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density), density);
  if (!stored) return fallback;
  return fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? stored[index] : width));
}

function saveStructureWidthsByDensity(storageKey: string, density: StructureEditorDensity, widths: readonly number[]) {
  let payload: Partial<Record<StructureEditorDensity, number[]>> = {};
  const raw = safeLocalStorageGet(storageKey);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") payload = parsed;
    } catch {
      payload = {};
    }
  }
  payload[density] = [...widths];
  safeLocalStorageSet(storageKey, JSON.stringify(payload));
}

function saveStructureColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureColumnWidths([...widths], density);
  if (!normalized) return;
  saveStructureWidthsByDensity(STRUCTURE_COLUMNS_WIDTHS_STORAGE_KEY, density, normalized);
}

function saveStructureIndexColumnWidths(density: StructureEditorDensity, widths: readonly number[]) {
  const normalized = normalizeStructureIndexColumnWidths([...widths], density);
  if (!normalized) return;
  const fallback = metricsForDensity(density).indexes;
  const stored = fallback.map((width, index) => (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(index) ? normalized[index] : width));
  saveStructureWidthsByDensity(STRUCTURE_INDEX_COLUMNS_WIDTHS_STORAGE_KEY, density, stored);
}

function loadSqlPreviewCollapsed(): boolean {
  return safeLocalStorageGet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY) === "true";
}

const structureDensity = computed(() => settingsStore.editorSettings.structureEditorDensity);
const localStructureDensity = ref<StructureEditorDensity>(structureDensity.value);
const structureDensityMetric = computed(() => metricsForDensity(localStructureDensity.value));
const structureDensityOptions = computed(() => [
  { value: "compact", label: t("structureEditor.densityCompact") },
  { value: "standard", label: t("structureEditor.densityStandard") },
  { value: "comfortable", label: t("structureEditor.densityComfortable") },
]);
const structureDensityStyle = computed(() => {
  const metric = structureDensityMetric.value;
  return {
    "--structure-font-size": `${metric.fontSize}px`,
    "--structure-shell-padding": `${metric.shellPadding}px`,
    "--structure-cell-px": `${metric.cellPaddingX}px`,
    "--structure-cell-py": `${metric.cellPaddingY}px`,
    "--structure-header-py": `${metric.headerPaddingY}px`,
    "--structure-control-height": `${metric.controlHeight}px`,
    "--structure-control-px": `${metric.controlPaddingX}px`,
    "--structure-icon-size": `${metric.iconSize}px`,
    "--structure-checkbox-size": `${metric.checkboxSize}px`,
    "--structure-line-height": String(metric.lineHeight),
  };
});
const structureControlClass = "structure-grid-control h-[var(--structure-control-height)] min-w-0 rounded-[6px] px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25";
const structureMonoControlClass = `${structureControlClass} font-mono`;
const structureToolbarButtonClass = "h-[var(--structure-control-height)] gap-1 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]";
const structureIconButtonClass = "h-[var(--structure-control-height)] w-[var(--structure-control-height)]";
const structureIconClass = "h-[var(--structure-icon-size)] w-[var(--structure-icon-size)]";
const structureCheckboxClass = "h-[var(--structure-checkbox-size)] w-[var(--structure-checkbox-size)]";
const structureHeaderCellClass = "relative min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left last:border-r-0";
const structureCellClass = "min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] last:border-r-0";
const structureLastCellClass = "min-w-0 overflow-hidden border-b px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
const structurePropertyListClass = "flex min-w-0 items-center gap-0 overflow-hidden";
const structurePropertyLabelClass = "flex min-w-0 items-center gap-1 whitespace-nowrap";
const structureActionButtonClass = `${structureIconButtonClass} shrink-0`;
const structureDensityMenuOpen = ref(false);
const structureDensityMenuRef = ref<HTMLElement>();

function applyStructureDensityWidths(density: StructureEditorDensity) {
  colWidths.value = loadStructureColumnWidths(density);
  indexColWidths.value = loadStructureIndexColumnWidths(density);
}

function setStructureDensity(value: unknown) {
  if (!isStructureEditorDensity(value)) return;
  if (value === localStructureDensity.value) return;
  localStructureDensity.value = value;
}

function selectStructureDensity(value: unknown) {
  setStructureDensity(value);
  structureDensityMenuOpen.value = false;
}

function toggleStructureDensityMenu() {
  structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
}

function focusStructureDensityOption(offset: number) {
  const currentIndex = structureDensityValues.indexOf(localStructureDensity.value);
  const nextIndex = (currentIndex + offset + structureDensityValues.length) % structureDensityValues.length;
  selectStructureDensity(structureDensityValues[nextIndex]);
}

function onStructureDensityKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    structureDensityMenuOpen.value = false;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!structureDensityMenuOpen.value) {
      structureDensityMenuOpen.value = true;
      return;
    }
    focusStructureDensityOption(-1);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    structureDensityMenuOpen.value = !structureDensityMenuOpen.value;
  }
}

function onStructureDensityDocumentPointerdown(event: PointerEvent) {
  if (!structureDensityMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && structureDensityMenuRef.value?.contains(target)) return;
  structureDensityMenuOpen.value = false;
}

function persistStructureDensity(density = localStructureDensity.value) {
  if (settingsStore.editorSettings.structureEditorDensity === density) return;
  settingsStore.updateEditorSettings({ structureEditorDensity: density });
}

const colWidths = ref(loadStructureColumnWidths(structureDensity.value));
const colResizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const indexColWidths = ref(loadStructureIndexColumnWidths(structureDensity.value));
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const columnSearchInputRef = ref<InstanceType<typeof Input>>();
const columnSearchText = ref("");
const selectedColumnId = ref<string | null>(null);
// Multi-selection set (ctrl/shift-click) plus the shift-range anchor. The
// legacy `selectedColumnId` stays as the "active" column: it decides where
// new rows are inserted and which row copy/add operations anchor to.
const selectedColumnIds = ref<Set<string>>(new Set());
const columnSelectionAnchorId = ref<string | null>(null);
const highlightedColumnId = ref<string | null>(null);
const indexSearchInputRef = ref<InstanceType<typeof Input>>();
const indexSearchText = ref("");
const highlightedIndexId = ref<string | null>(null);
const sqlPreviewCollapsed = ref(loadSqlPreviewCollapsed());
let columnHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;
let indexHighlightTimer: ReturnType<typeof window.setTimeout> | undefined;

watch(
  structureDensity,
  (density) => {
    if (density === localStructureDensity.value) return;
    localStructureDensity.value = density;
  },
  { flush: "sync" },
);

watch(localStructureDensity, (density, previousDensity) => {
  if (density === previousDensity) return;
  applyStructureDensityWidths(density);
  persistStructureDensity(density);
});

function onColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  const widthIndex = columnWidthIndex(col);
  const minimumWidth = widthIndex === 3 && supportsCharacterLengthUnits.value ? structureDensityMetric.value.minLengthColumnWidth : structureDensityMetric.value.minColumnWidth;
  colResizing.value = { col: widthIndex, startX: e.clientX, startW: Math.max(colWidths.value[widthIndex] ?? minimumWidth, minimumWidth) };
  const onMove = (ev: MouseEvent) => {
    if (!colResizing.value) return;
    const delta = ev.clientX - colResizing.value.startX;
    colWidths.value[widthIndex] = Math.max(minimumWidth, colResizing.value.startW + delta);
  };
  const onUp = () => {
    colResizing.value = null;
    saveStructureColumnWidths(localStructureDensity.value, colWidths.value);
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function onIndexColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  resizing.value = { col, startX: e.clientX, startW: indexColWidths.value[col] };
  const onMove = (ev: MouseEvent) => {
    if (!resizing.value) return;
    const delta = ev.clientX - resizing.value.startX;
    indexColWidths.value[col] = Math.max(structureDensityMetric.value.minIndexColumnWidth, resizing.value.startW + delta);
  };
  const onUp = () => {
    resizing.value = null;
    if (PERSISTED_STRUCTURE_INDEX_COLUMN_WIDTHS.has(col)) {
      saveStructureIndexColumnWidths(localStructureDensity.value, indexColWidths.value);
    }
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const connection = computed(() => (props.connectionId ? store.getConfig(props.connectionId) : undefined));
const databaseType = computed(() => tableStructureDatabaseTypeForConnection(connection.value));
const supportsCharacterLengthUnits = computed(() => databaseType.value === "dameng" || databaseType.value === "oracle");
const usesMysql8SafeDefaults = computed(() => databaseType.value === "mysql" && connection.value?.db_type === "mysql" && connection.value.driver_profile === "mysql");
const structureCapabilities = computed(() => getTableStructureCapabilities(databaseType.value, connection.value?.db_type, connection.value?.database_info?.productVersion));
const tableMetadataCapabilities = computed(() => getTableMetadataCapabilities(databaseType.value));
const structureDialect = computed(() => structureCapabilities.value.dialect);
const isTableCommentDisabled = computed(() => !structureCapabilities.value.comment);
const dynamicDataTypeOptions = ref<string[]>([]);
const dataTypeOptions = computed(() => mergeDataTypeOptions(dynamicDataTypeOptions.value, getDataTypeOptions(databaseType.value)));
const columnEditorControls = computed(() => getColumnEditorControls(databaseType.value));

const indexTypesByDb: Record<string, string[]> = {
  postgres: ["BTREE", "HASH", "GIST", "SPGIST", "GIN", "BRIN"],
  mysql: ["BTREE", "HASH", "FULLTEXT", "SPATIAL", "RTREE"],
  sqlserver: ["CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "NONCLUSTERED COLUMNSTORE", "XML", "SPATIAL"],
  oracle: ["NORMAL", "BITMAP", "FUNCTION-BASED NORMAL", "FUNCTION-BASED DOMAIN", "DOMAIN", "CLUSTER"],
  sqlite: ["BTREE"],
  "gaussdb-m": ["UBTREE"],
};
const indexTypeOptions = computed(() => {
  if (!structureCapabilities.value.indexType) return [];
  if (connection.value?.driver_profile?.toLowerCase() === "gaussdb-m") {
    return indexTypesByDb["gaussdb-m"];
  }
  return indexTypesByDb[structureDialect.value] ?? [];
});

interface DefaultValuePreset {
  label: string;
  value: string;
}

const defaultValuePresets = computed((): DefaultValuePreset[] => {
  const universal: DefaultValuePreset[] = [
    { label: "''", value: "''" },
    { label: "NULL", value: "NULL" },
    { label: "0", value: "0" },
    { label: "1", value: "1" },
  ];

  const dialectPresets: Record<string, DefaultValuePreset[]> = {
    mysql: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME" },
    ],
    postgres: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "now()", value: "now()" },
      { label: "gen_random_uuid()", value: "gen_random_uuid()" },
    ],
    sqlite: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME" },
    ],
    duckdb: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
    ],
    sqlserver: [
      { label: "GETDATE()", value: "GETDATE()" },
      { label: "GETUTCDATE()", value: "GETUTCDATE()" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "NEWID()", value: "NEWID()" },
    ],
    oracle: [
      { label: "SYSDATE", value: "SYSDATE" },
      { label: "SYSTIMESTAMP", value: "SYSTIMESTAMP" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
    ],
    h2: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
    ],
    clickhouse: [
      { label: "now()", value: "now()" },
      { label: "today()", value: "today()" },
    ],
    informix: [
      { label: "CURRENT", value: "CURRENT" },
      { label: "TODAY", value: "TODAY" },
    ],
  };

  return [...universal, ...(dialectPresets[structureDialect.value] ?? [])];
});

function isPostgresIdentityType(dbType: string | undefined): boolean {
  return dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss" || dbType === "highgo" || dbType === "uxdb" || dbType === "vastbase" || dbType === "kingbase";
}

const showExtendedProperties = computed(() => {
  const dt = databaseType.value;
  return dt === "mysql" || dt === "dameng" || dt === "manticoresearch" || isPostgresIdentityType(dt) || dt === "sqlserver";
});
const showCharacterSet = computed(() => structureDialect.value === "mysql");

const serverCharsetMetadata = ref<CreateDatabaseCharsetMetadata>();
const charsetMetadataLoading = ref(false);

const mysqlCharsetOptions = computed<string[]>(() => {
  const meta = serverCharsetMetadata.value;
  return meta ? meta.charsets : ([...CREATE_DATABASE_CHARSET_OPTIONS] as string[]);
});

function collationOptionsForCharset(charset: string): string[] {
  const meta = serverCharsetMetadata.value;
  if (meta) {
    return meta.collationsByCharset[normalizeCreateDatabaseCharsetKey(charset)] ?? [];
  }
  return createDatabaseCollationOptionsForCharset(charset);
}

async function loadCharsetMetadata() {
  if (charsetMetadataLoading.value || !showCharacterSet.value) return;
  charsetMetadataLoading.value = true;
  try {
    await store.ensureConnected(props.connectionId);
    const [charsetResult, collationResult] = await Promise.all([api.executeQuery(props.connectionId, props.database, "SHOW CHARACTER SET"), api.executeQuery(props.connectionId, props.database, "SHOW COLLATION")]);
    serverCharsetMetadata.value = parseCreateDatabaseCharsetMetadata(charsetResult, collationResult);
  } catch {
    serverCharsetMetadata.value = fallbackCreateDatabaseCharsetMetadata();
  } finally {
    charsetMetadataLoading.value = false;
  }
}

function onCharsetChange(column: EditableStructureColumn, charset: string) {
  column.characterSet = charset;
  // If the collation is no longer valid for the new charset, clear it so the
  // server picks its default (COLLATE is only emitted when explicitly chosen).
  if (column.collation && !collationOptionsForCharset(charset).includes(column.collation)) {
    column.collation = "";
  }
}

function columnCharset(column: EditableStructureColumn): string {
  return column.characterSet ?? "";
}

function columnCollation(column: EditableStructureColumn): string {
  return column.collation ?? "";
}

const extendedPropertiesColumnIndex = 10;
const actionButtonGap = 2;
const columnOrdinalIndicatorGap = 4;
const columnOrdinalIndicatorTrailingChrome = 3;
const columnActionButtonCount = computed(() => (canShowColumnDragControls.value ? 3 : 2));
const columnOrdinalIndicatorWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const digitCount = String(Math.max(1, columns.value.length)).length;
  // Reserve a full em per digit plus the primary-key icon, its gap, padding,
  // and divider. The indicator is shared by every row, so it must fit the
  // largest ordinal even when that row is a primary-key column.
  const requiredWidth = metric.fontSize * digitCount + metric.iconSize + columnOrdinalIndicatorGap + columnOrdinalIndicatorTrailingChrome;
  return Math.max(metric.columns[0], requiredWidth);
});
const columnActionsWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const count = columnActionButtonCount.value;
  return columnOrdinalIndicatorWidth.value + metric.actionButtonWidth * count + actionButtonGap * count + metric.cellPaddingX * 2;
});
const visibleColumnIndexes = computed(() => colLabels.value.map((column) => column.widthIndex));
const visibleColWidths = computed(() =>
  colLabels.value.map((column) => {
    if (column.key === "actions") return columnActionsWidth.value;
    const width = colWidths.value[column.widthIndex] ?? structureDensityMetric.value.minColumnWidth;
    return column.key === "length" && supportsCharacterLengthUnits.value ? Math.max(width, structureDensityMetric.value.minLengthColumnWidth) : width;
  }),
);

function columnWidthIndex(visibleIndex: number) {
  return visibleColumnIndexes.value[visibleIndex] ?? visibleIndex;
}

const colLabels = computed(() => {
  const labels = [
    { key: "actions", label: t("structureEditor.actions"), widthIndex: 11 },
    { key: "name", label: t("structureEditor.columnName"), widthIndex: 1 },
    { key: "type", label: t("structureEditor.dataType"), widthIndex: 2 },
  ];
  if (columnEditorControls.value.length) labels.push({ key: "length", label: t("structureEditor.length"), widthIndex: 3 });
  if (columnEditorControls.value.nullable) labels.push({ key: "nullable", label: t("structureEditor.nullable"), widthIndex: 4 });
  if (columnEditorControls.value.primaryKey) labels.push({ key: "primaryKey", label: t("structureEditor.primaryKey"), widthIndex: 5 });
  if (columnEditorControls.value.defaultValue) labels.push({ key: "defaultValue", label: t("structureEditor.defaultValue"), widthIndex: 6 });
  if (columnEditorControls.value.comment) labels.push({ key: "comment", label: t("structureEditor.comment"), widthIndex: 7 });
  if (showCharacterSet.value) labels.push({ key: "characterSet", label: t("structureEditor.characterSet"), widthIndex: 8 });
  if (showCharacterSet.value) labels.push({ key: "collation", label: t("structureEditor.collation"), widthIndex: 9 });
  if (showExtendedProperties.value) {
    labels.push({ key: "extendedProperties", label: t("structureEditor.extendedProperties"), widthIndex: extendedPropertiesColumnIndex });
  }
  return labels;
});
const indexColLabels = computed(() => [
  t("structureEditor.indexName"),
  t("structureEditor.indexColumns"),
  t("structureEditor.unique"),
  t("structureEditor.indexType"),
  t("structureEditor.includedColumns"),
  t("structureEditor.filter"),
  t("structureEditor.comment"),
  t("structureEditor.concurrent"),
  t("structureEditor.actions"),
]);
const filteredColumnRowIds = computed(() => {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(
    columns.value
      .filter((column) =>
        [column.name, column.comment].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(query),
        ),
      )
      .map((column) => column.id),
  );
});
const columnSearchMatchCount = computed(() => (columnSearchText.value.trim() ? filteredColumnRowIds.value.size : 0));
const filteredIndexRowIds = computed(() => {
  const query = indexSearchText.value.trim().toLowerCase();
  if (!query) return new Set<string>();
  return new Set(indexes.value.filter((index) => indexMatchesSearch(index, query)).map((index) => index.id));
});
const indexSearchMatchCount = computed(() => (indexSearchText.value.trim() ? filteredIndexRowIds.value.size : 0));
const foreignKeyActionOptions = ["", "CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
const triggerTimingOptions = ["BEFORE", "AFTER"];
const triggerEventOptions = ["INSERT", "UPDATE", "DELETE"];
const metadataSchema = computed(() => connectionObjectTreeQuerySchema(connection.value, props.database, props.schema));
const refreshVersion = computed(() => (props.connectionId && props.tableName ? queryStore.tableStructureRefreshVersion(props.connectionId, props.database, props.schema, props.tableName) : 0));
const isCreateMode = computed(() => !props.tableName);
const usesSqliteRebuildStrategy = computed(() => !isCreateMode.value && structureCapabilities.value.alterStrategy === "sqlite-rebuild");
const hasSqliteTypeChange = computed(() => usesSqliteRebuildStrategy.value && hasExistingColumnTypeChange(columns.value));
const canAddColumn = computed(() => canAddTableStructureColumn(databaseType.value, isCreateMode.value));
const newTableName = ref("");
const tableComment = ref("");
const originalTableComment = ref("");
const mysqlAutoIncrementValue = ref<string>();
const originalMysqlAutoIncrementValue = ref<string>();
const mysqlAutoIncrementLoading = ref(false);
const mysqlAutoIncrementLoadError = ref("");
const mysqlTableEngine = ref("");
const originalMysqlTableEngine = ref("");
const mysqlTableEngineOptions = ref<string[]>([]);
const mysqlTableEngineLoading = ref(false);
const mysqlTableEngineLoadError = ref("");
const tableOwner = ref("");
const originalTableOwner = ref("");
const tableOwnerLoading = ref(false);
const tableOwnerLoadError = ref("");
const tableOwnerRoles = ref<string[]>([]);
const tableOwnerRolesLoading = ref(false);
const tableOwnerRolesLoadError = ref("");
const supportsTableOwner = computed(() => !isCreateMode.value && databaseType.value === "postgres");
const canEditMysqlAutoIncrement = computed(() => canEditMysqlAutoIncrementCounter(connection.value, isCreateMode.value, columns.value));
const canBuildMysqlAutoIncrement = computed(() => canEditMysqlAutoIncrement.value && !mysqlAutoIncrementLoading.value && !mysqlAutoIncrementLoadError.value && originalMysqlAutoIncrementValue.value !== undefined);
const supportsMysqlEngine = computed(() => supportsMysqlTableEngine(connection.value));
const hasPersistedMysqlAutoIncrementColumn = computed(() => columns.value.some((column) => !column.markedForDrop && (column.original?.extra ?? "").toLowerCase().includes("auto_increment")));
function isMysqlAutoIncrementCounterColumn(column: EditableStructureColumn): boolean {
  return canEditMysqlAutoIncrement.value && !column.markedForDrop && column.extra.autoIncrement === true;
}
function setMysqlAutoIncrement(column: EditableStructureColumn, checked: boolean) {
  column.extra.autoIncrement = checked;
  if (checked && originalMysqlAutoIncrementValue.value === undefined && !mysqlAutoIncrementLoading.value) {
    void loadMysqlAutoIncrementCounter(true);
  }
}
function onMysqlAutoIncrementInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (/^\d*$/.test(input.value)) {
    mysqlAutoIncrementValue.value = input.value;
    return;
  }
  input.value = mysqlAutoIncrementValue.value ?? "";
}
const tableOwnerOptions = computed(() => {
  const owner = tableOwner.value;
  if (!owner || tableOwnerRoles.value.includes(owner)) return tableOwnerRoles.value;
  return [owner, ...tableOwnerRoles.value];
});
const targetLabel = computed(() => buildStructureTargetLabel(connection.value?.name, props.database, props.schema, isCreateMode.value ? undefined : props.tableName));

function isManticoreTextColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase();
  return baseType === "text" || baseType === "string";
}

function isManticoreJsonColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  return dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase() === "json";
}

let sqlPreviewRequestId = 0;
let structureLoadRequestId = 0;
let tableOwnerLoadRequestId = 0;
let tableOwnerRolesLoadRequestId = 0;
let mysqlAutoIncrementLoadRequestId = 0;
let mysqlTableEngineLoadRequestId = 0;
let dataTypeOptionsRequestId = 0;
let sqlPreviewDebounceTimer: ReturnType<typeof setTimeout> | undefined;
let deferredSqlPreviewRefresh = false;
let keydownListenerRegistered = false;
let skipNextRefreshVersion = false;
let restoringDraft = false;
let syncingDraft = false;
let draftHydrated = false;
let hydratingRestoredDraft = false;
let structureScrollFrame = 0;
let structureHorizontalScrollbarThumbLeftPercent = 0;
let structureHorizontalScrollbarThumbWidthPercent = 100;
let structureHorizontalScrollbarResizeObserver: ResizeObserver | null = null;
let structureHorizontalScrollbarObserverGeneration = 0;
let structureHorizontalScrollbarPreviousUserSelect: string | null = null;
let structureHorizontalScrollbarDragState: {
  scroller: HTMLElement;
  trackRect: DOMRect;
  thumbOffsetPx: number;
  maxScrollLeft: number;
} | null = null;
// A context-menu target may arrive before metadata rows render, so search text
// and row scrolling are tracked separately for each request.
let appliedInitialTargetSearchKey = "";
let appliedInitialTargetScrollKey = "";

function cloneDraftValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const structureScrollPositions = ref<Partial<Record<TableInfoTab, TableStructureEditorViewport>>>({});

function structureScrollerElement(scroller: StructureScrollerRef | undefined): HTMLElement | undefined {
  if (!scroller) return undefined;
  if (scroller instanceof HTMLElement) return scroller;
  return scroller.$el instanceof HTMLElement ? scroller.$el : undefined;
}

function structureScrollerForTab(tab: TableInfoTab): HTMLElement | undefined {
  if (tab === "columns") return structureScrollerElement(columnsScrollerRef.value);
  if (tab === "indexes") return structureScrollerElement(indexesScrollerRef.value);
  if (tab === "foreignKeys") return structureScrollerElement(foreignKeysScrollerRef.value);
  if (tab === "constraints") return structureScrollerElement(constraintsScrollerRef.value);
  if (tab === "triggers") return structureScrollerElement(triggersScrollerRef.value);
  if (tab === "ddl") return structureScrollerElement(ddlScrollerRef.value);
  return undefined;
}

function activeStructureHorizontalScroller(): HTMLElement | undefined {
  if (activeTab.value !== "columns" && activeTab.value !== "indexes") return undefined;
  return structureScrollerForTab(activeTab.value);
}

function applyStructureHorizontalScrollbarThumbStyle(): boolean {
  const thumb = structureHorizontalScrollbarThumbRef.value;
  if (!thumb) return false;
  thumb.style.width = `${structureHorizontalScrollbarThumbWidthPercent}%`;
  thumb.style.left = `${structureHorizontalScrollbarThumbLeftPercent}%`;
  return true;
}

function updateStructureHorizontalScrollbar(scroller = activeStructureHorizontalScroller()) {
  if (!scroller) {
    hasStructureHorizontalOverflow.value = false;
    return;
  }
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const hasOverflow = maxScrollLeft > 1;
  hasStructureHorizontalOverflow.value = hasOverflow;
  const thumbWidth = scroller.scrollWidth > 0 ? Math.min(100, Math.max(6, (scroller.clientWidth / scroller.scrollWidth) * 100)) : 100;
  structureHorizontalScrollbarThumbWidthPercent = thumbWidth;
  structureHorizontalScrollbarThumbLeftPercent = maxScrollLeft > 0 ? (scroller.scrollLeft / maxScrollLeft) * Math.max(0, 100 - thumbWidth) : 0;
  if (!applyStructureHorizontalScrollbarThumbStyle() && hasOverflow) void nextTick(applyStructureHorizontalScrollbarThumbStyle);
}

function observeStructureHorizontalScroller() {
  const generation = ++structureHorizontalScrollbarObserverGeneration;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  structureHorizontalScrollbarResizeObserver = null;
  const tab = activeTab.value;
  void nextTick(() => {
    if (generation !== structureHorizontalScrollbarObserverGeneration || tab !== activeTab.value) return;
    const scroller = activeStructureHorizontalScroller();
    updateStructureHorizontalScrollbar(scroller);
    if (!scroller || typeof ResizeObserver === "undefined") return;
    structureHorizontalScrollbarResizeObserver = new ResizeObserver(() => updateStructureHorizontalScrollbar(scroller));
    structureHorizontalScrollbarResizeObserver.observe(scroller);
    for (const child of Array.from(scroller.children)) structureHorizontalScrollbarResizeObserver.observe(child);
  });
}

function applyStructureHorizontalScrollbarDrag(clientX: number) {
  const dragState = structureHorizontalScrollbarDragState;
  if (!dragState) return;
  const thumbWidthPx = dragState.trackRect.width * (structureHorizontalScrollbarThumbWidthPercent / 100);
  const maxThumbLeftPx = Math.max(1, dragState.trackRect.width - thumbWidthPx);
  const thumbLeftPx = Math.min(maxThumbLeftPx, Math.max(0, clientX - dragState.trackRect.left - dragState.thumbOffsetPx));
  dragState.scroller.scrollLeft = (thumbLeftPx / maxThumbLeftPx) * dragState.maxScrollLeft;
  updateStructureHorizontalScrollbar(dragState.scroller);
}

function onStructureHorizontalScrollbarPointerMove(event: PointerEvent) {
  if (!structureHorizontalScrollbarDragState) return;
  event.preventDefault();
  applyStructureHorizontalScrollbarDrag(event.clientX);
}

function stopStructureHorizontalScrollbarDrag() {
  if (!structureHorizontalScrollbarDragState) return;
  structureHorizontalScrollbarDragState = null;
  structureHorizontalScrollbarTrackRef.value?.classList.remove("structure-horizontal-scrollbar--dragging");
  window.removeEventListener("pointermove", onStructureHorizontalScrollbarPointerMove, true);
  window.removeEventListener("pointerup", stopStructureHorizontalScrollbarDrag, true);
  window.removeEventListener("pointercancel", stopStructureHorizontalScrollbarDrag, true);
  document.body.style.userSelect = structureHorizontalScrollbarPreviousUserSelect ?? "";
  structureHorizontalScrollbarPreviousUserSelect = null;
}

function startStructureHorizontalScrollbarDrag(event: PointerEvent) {
  if (event.button !== 0 || !event.isPrimary) return;
  const scroller = activeStructureHorizontalScroller();
  const track = structureHorizontalScrollbarTrackRef.value;
  if (!scroller || !track || !hasStructureHorizontalOverflow.value) return;
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  if (maxScrollLeft <= 1) return;
  const trackRect = track.getBoundingClientRect();
  const thumbLeftPx = trackRect.width * (structureHorizontalScrollbarThumbLeftPercent / 100);
  const thumbWidthPx = trackRect.width * (structureHorizontalScrollbarThumbWidthPercent / 100);
  const pointerX = event.clientX - trackRect.left;
  structureHorizontalScrollbarDragState = {
    scroller,
    trackRect,
    thumbOffsetPx: pointerX >= thumbLeftPx && pointerX <= thumbLeftPx + thumbWidthPx ? pointerX - thumbLeftPx : thumbWidthPx / 2,
    maxScrollLeft,
  };
  track.classList.add("structure-horizontal-scrollbar--dragging");
  structureHorizontalScrollbarPreviousUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onStructureHorizontalScrollbarPointerMove, true);
  window.addEventListener("pointerup", stopStructureHorizontalScrollbarDrag, true);
  window.addEventListener("pointercancel", stopStructureHorizontalScrollbarDrag, true);
  event.preventDefault();
  applyStructureHorizontalScrollbarDrag(event.clientX);
}

function restoreStructureScrollPosition(tab = activeTab.value) {
  const position = structureScrollPositions.value[tab];
  if (!position) return;
  nextTick(() => {
    if (tab === "ddl" && ddlEditorView.value) {
      ddlEditorView.value.scrollDOM.scrollTop = Math.max(0, position.scrollTop);
      ddlEditorView.value.scrollDOM.scrollLeft = Math.max(0, position.scrollLeft);
      return;
    }
    const scroller = structureScrollerForTab(tab);
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, position.scrollTop);
    scroller.scrollLeft = Math.max(0, position.scrollLeft);
    if (tab === "columns" || tab === "indexes") updateStructureHorizontalScrollbar(scroller);
  });
}

function onStructureContentScroll(tab: TableInfoTab, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  if (tab === "columns" || tab === "indexes") updateStructureHorizontalScrollbar(target);
  const position: TableStructureEditorViewport = {
    scrollTop: Math.max(0, Math.round(target.scrollTop)),
    scrollLeft: Math.max(0, Math.round(target.scrollLeft)),
  };
  const previous = structureScrollPositions.value[tab];
  if (previous?.scrollTop === position.scrollTop && previous.scrollLeft === position.scrollLeft) return;
  structureScrollPositions.value = {
    ...structureScrollPositions.value,
    [tab]: position,
  };
  if (structureScrollFrame) return;
  structureScrollFrame = window.requestAnimationFrame(() => {
    structureScrollFrame = 0;
    syncDraftToParent();
  });
}

function createCurrentDraft(initialized = true): TableStructureEditorDraft {
  return {
    dirty: hasPendingStructureChanges(),
    activeTab: activeTab.value as TableStructureEditorDraft["activeTab"],
    newTableName: newTableName.value,
    tableComment: tableComment.value,
    originalTableComment: originalTableComment.value,
    mysqlAutoIncrementValue: mysqlAutoIncrementValue.value,
    originalMysqlAutoIncrementValue: originalMysqlAutoIncrementValue.value,
    mysqlTableEngine: mysqlTableEngine.value,
    originalMysqlTableEngine: originalMysqlTableEngine.value,
    tableOwner: tableOwner.value,
    originalTableOwner: originalTableOwner.value,
    columns: cloneDraftValue(columns.value),
    indexes: cloneDraftValue(indexes.value),
    foreignKeys: cloneDraftValue(foreignKeys.value),
    constraints: cloneDraftValue(constraints.value),
    constraintsLoaded: constraintsLoaded.value,
    triggers: cloneDraftValue(triggers.value),
    triggersLoaded: triggersLoaded.value,
    loadedMetadataFacets: [...loadedMetadataFacets],
    scrollPositions: cloneDraftValue(structureScrollPositions.value),
    initialized,
  };
}

function syncDraftToParent() {
  if (!draftHydrated) return;
  if (restoringDraft || syncingDraft) return;
  syncingDraft = true;
  emit("update:draft", createCurrentDraft());
  syncingDraft = false;
}

function restoreDraft(draft: TableStructureEditorDraft) {
  restoringDraft = true;
  draftHydrated = false;
  activeTab.value = draft.activeTab || "columns";
  newTableName.value = draft.newTableName || "";
  tableComment.value = draft.tableComment || "";
  originalTableComment.value = draft.originalTableComment || "";
  mysqlAutoIncrementValue.value = draft.mysqlAutoIncrementValue;
  originalMysqlAutoIncrementValue.value = draft.originalMysqlAutoIncrementValue;
  mysqlTableEngine.value = draft.mysqlTableEngine || "";
  originalMysqlTableEngine.value = draft.originalMysqlTableEngine || "";
  tableOwner.value = draft.tableOwner || "";
  originalTableOwner.value = draft.originalTableOwner || "";
  columns.value = cloneDraftValue(draft.columns || []);
  // Existing-index edits never support Concurrent (the checkbox is disabled and
  // the core builder rejects the request), so a stale `concurrently: true`
  // saved in a restored draft must not be submitted or deadlock the save.
  indexes.value = cloneDraftValue(draft.indexes || []).map((index) => (index.original ? { ...index, concurrently: false } : index));
  // Re-run the availability normalization against the current inputs (e.g. a
  // re-activated editor may already carry an unknown/unsupported partition
  // status): restored new-index Concurrent choices that became illegal are
  // normalized away with the same fail-closed invalidation as a probe failure.
  normalizeConcurrentIndexDraftsForCurrentAvailability();
  foreignKeys.value = cloneDraftValue(draft.foreignKeys || []);
  constraints.value = cloneDraftValue(draft.constraints || []);
  // Drafts created before constraint loading existed have no saved facet.
  constraintsLoaded.value = draft.constraintsLoaded ?? false;
  triggers.value = cloneDraftValue(draft.triggers || []);
  // Drafts created before lazy trigger loading always contained live trigger metadata.
  triggersLoaded.value = draft.triggersLoaded ?? true;
  loadedMetadataFacets.clear();
  if (draft.loadedMetadataFacets) {
    for (const facet of draft.loadedMetadataFacets) loadedMetadataFacets.add(facet);
  } else {
    const activeScope = visibleTableStructureRefreshScope(draft.activeTab || "columns");
    if (activeScope.columns) loadedMetadataFacets.add("columns");
    if (activeScope.indexes || draft.indexes?.length) loadedMetadataFacets.add("indexes");
    if (activeScope.foreignKeys || draft.foreignKeys?.length) loadedMetadataFacets.add("foreign-keys");
    if (activeScope.constraints || constraintsLoaded.value) loadedMetadataFacets.add("constraints");
    if (activeScope.triggers || triggersLoaded.value) loadedMetadataFacets.add("triggers");
    if (activeScope.tableComment) loadedMetadataFacets.add("comment");
  }
  structureScrollPositions.value = cloneDraftValue(draft.scrollPositions || {});
  restoringDraft = false;
  draftHydrated = !needsColumnDraftMetadataHydration();
  restoreStructureScrollPosition();
}

function needsColumnDraftMetadataHydration() {
  return !isCreateMode.value && columns.value.some((column) => !column.original && !column.id.startsWith("new:") && !!column.name.trim());
}

async function hydrateRestoredDraftFromDatabase() {
  if (!needsColumnDraftMetadataHydration() || hydratingRestoredDraft) return;
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;

  hydratingRestoredDraft = true;
  let shouldRefreshPreview = false;
  try {
    await store.ensureConnected(connectionId);
    let { value: nextColumns } = await loadObjectMetadataFacet({ connectionId, database, schema, tableName, catalog }, "columns", () => api.getColumns(connectionId, database, schema, tableName, catalog));
    if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
      try {
        const { ddl } = await loadObjectDdl({ connectionId, database, schema, tableName, catalog });
        ddlContent.value = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(databaseType.value), settingsStore.editorSettings.sqlFormatter);
        ddlFetched.value = true;
        nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
      } catch {
        /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
      }
    }
    columns.value = rehydrateColumnDraftsFromMetadata(columns.value, nextColumns, databaseType.value);
    markDraftHydratedAndSync();
    shouldRefreshPreview = true;
  } catch (e: any) {
    console.warn("[DBX][structure-editor:draft-hydration-failed]", e);
  } finally {
    hydratingRestoredDraft = false;
    if (shouldRefreshPreview) scheduleSqlPreviewRefresh();
  }
}

function markDraftHydratedAndSync() {
  draftHydrated = true;
  syncDraftToParent();
}

function hasPendingStructureChanges(): boolean {
  if (isCreateMode.value) {
    return !!newTableName.value.trim() || !!tableComment.value.trim() || mysqlTableEngine.value !== originalMysqlTableEngine.value || columns.value.length > 0 || indexes.value.length > 0 || foreignKeys.value.length > 0 || triggers.value.length > 0;
  }
  const scope = captureStructureRefreshScope();
  return (
    scope.columns ||
    scope.indexes ||
    scope.foreignKeys ||
    scope.triggers ||
    scope.tableComment ||
    mysqlTableEngine.value.toLowerCase() !== originalMysqlTableEngine.value.toLowerCase() ||
    (canBuildMysqlAutoIncrement.value && mysqlAutoIncrementValue.value !== originalMysqlAutoIncrementValue.value) ||
    (supportsTableOwner.value && tableOwner.value.trim() !== originalTableOwner.value.trim())
  );
}

function clearSqlPreviewState() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
}

function dataTypeOptionsCacheKey(connectionId: string, database: string) {
  return `${connectionId}\u0000${database}`;
}

function mergeDataTypeOptions(primary: readonly string[], fallback: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const option of [...primary, ...fallback]) {
    const trimmed = option.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function mysqlDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "mysql") return undefined;
  const product = connection.value?.driver_profile === "mariadb" ? "mariadb" : connection.value?.driver_profile === "mysql" ? "mysql" : undefined;
  const help = getMysqlDataTypeHelp(option, { product });
  return help ? [help.key, ...(help.warningKeys ?? [])].map((key) => t(`structureEditor.mysqlDataTypeHelp.${key}`)).join("\n\n") : undefined;
}

function postgresDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "postgres") return undefined;
  const help = getPostgresDataTypeHelp(option);
  return help ? t(`structureEditor.postgresDataTypeHelp.${help.key}`) : undefined;
}

function sqliteDataTypeTooltip(option: string): string | undefined {
  if (databaseType.value !== "sqlite") return undefined;
  const help = getSqliteDataTypeHelp(option);
  return help ? t(`structureEditor.sqliteDataTypeHelp.${help.key}`) : undefined;
}

function dataTypeTooltip(option: string): string | undefined {
  if (databaseType.value === "mysql") return mysqlDataTypeTooltip(option);
  if (databaseType.value === "postgres") return postgresDataTypeTooltip(option);
  if (databaseType.value === "sqlite") return sqliteDataTypeTooltip(option);
  return undefined;
}

function gaussdbMDataTypeDisplayName(option: string): string {
  if (databaseType.value === "gaussdb") {
    const conn = connection.value;
    if (conn?.driver_profile?.toLowerCase() === "gaussdb-m") {
      return gaussdbMTypeDisplayName(option);
    }
  }
  return option;
}

async function loadDynamicDataTypeOptions() {
  const requestId = ++dataTypeOptionsRequestId;
  const connectionId = props.connectionId;
  const database = props.database;
  if (!connectionId || !database) {
    dynamicDataTypeOptions.value = [];
    return;
  }
  const cacheKey = dataTypeOptionsCacheKey(connectionId, database);
  const cached = dynamicDataTypeOptionsCache.get(cacheKey);
  if (cached) {
    dynamicDataTypeOptions.value = cached;
    return;
  }
  dynamicDataTypeOptions.value = [];
  try {
    await store.ensureConnected(connectionId);
    const options = await api.listDataTypes(connectionId, database);
    if (requestId !== dataTypeOptionsRequestId) return;
    const normalized = mergeDataTypeOptions(options, []);
    if (normalized.length > 0) {
      dynamicDataTypeOptionsCache.set(cacheKey, normalized);
      dynamicDataTypeOptions.value = normalized;
    } else {
      dynamicDataTypeOptions.value = [];
    }
  } catch {
    if (requestId === dataTypeOptionsRequestId) {
      dynamicDataTypeOptions.value = [];
    }
  }
}

function scheduleSqlPreviewRefresh() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  sqlPreviewPending.value = true;
  if (hydratingRestoredDraft || needsColumnDraftMetadataHydration()) return;
  if (!isCreateMode.value && secondaryMetadataLoading.value) {
    deferredSqlPreviewRefresh = true;
    return;
  }
  sqlPreviewDebounceTimer = setTimeout(() => {
    sqlPreviewDebounceTimer = undefined;
    void refreshSqlPreview();
  }, SQL_PREVIEW_DEBOUNCE_MS);
}

function structureChangeOptions(): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: databaseType.value,
    schema: props.schema,
    tableName: isCreateMode.value ? newTableName.value.trim() : props.tableName || "",
    columns: columns.value,
    indexes: sanitizeStructureIndexesForCapabilities(indexes.value, structureCapabilities.value),
    foreignKeys: foreignKeys.value,
    triggers: triggers.value,
    tableComment: tableComment.value,
    originalTableComment: isCreateMode.value ? undefined : originalTableComment.value,
    mysqlEngine: mysqlTableEngineSqlOption({ value: mysqlTableEngine.value, originalValue: originalMysqlTableEngine.value }, isCreateMode.value, supportsMysqlEngine.value && !mysqlTableEngineLoading.value && !mysqlTableEngineLoadError.value),
    partitioned: isPartitionedParent.value,
    isGaussdbMMode: connection.value?.driver_profile?.toLowerCase() === "gaussdb-m",
  };
}

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
  if (concurrentAvailabilityInvalidated.value) {
    // Availability gap in effect: never regenerate SQL here — doing so would
    // turn a lost Concurrent request into a silent blocking CREATE INDEX. Keep
    // the explicit error visible until a later probe re-verifies the table.
    pendingStatements.value = [];
    warnings.value = [t("structureEditor.concurrentUnavailableBlocksSave")];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  // Layer B: a stale `concurrently: true` whose availability is no longer
  // enabled must never reach the SQL builder, even if normalization was
  // skipped (race, restored draft, non-UI caller).
  const blockingConcurrentWarning = concurrentIndexBlockingWarning();
  if (blockingConcurrentWarning) {
    pendingStatements.value = [];
    warnings.value = [blockingConcurrentWarning];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    sqlPreviewPending.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  const options = structureChangeOptions();
  try {
    const [result, ownerResult, mysqlAutoIncrementStatement] = await Promise.all([
      isCreateMode.value ? api.buildCreateTableSql(options) : hasSqliteTypeChange.value ? api.previewSqliteTableStructureChange(props.connectionId, props.database, options) : api.buildTableStructureChangeSql(options),
      supportsTableOwner.value
        ? api.buildTableOwnerChangeSql({
            databaseType: databaseType.value,
            schema: metadataSchema.value,
            tableName: props.tableName || "",
            owner: tableOwner.value,
            originalOwner: originalTableOwner.value,
          })
        : Promise.resolve({ statements: [], warnings: [] }),
      buildMysqlAutoIncrementCounterStatement({
        enabled: canBuildMysqlAutoIncrement.value,
        originalValue: originalMysqlAutoIncrementValue.value,
        value: mysqlAutoIncrementValue.value,
        databaseType: databaseType.value,
        driverProfile: connection.value?.driver_profile,
        schema: props.schema || props.database,
        tableName: props.tableName || "",
        buildSql: api.buildMysqlAutoIncrementSql,
      }),
    ]);
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [...result.statements, ...ownerResult.statements, ...(mysqlAutoIncrementStatement ? [mysqlAutoIncrementStatement] : [])];
    warnings.value = [...result.warnings, ...ownerResult.warnings];
    sqliteSchemaRevision.value = "schemaRevision" in result && typeof result.schemaRevision === "string" ? result.schemaRevision : undefined;
  } catch (e: any) {
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [];
    warnings.value = [e?.message || String(e)];
    sqliteSchemaRevision.value = undefined;
  } finally {
    if (requestId === sqlPreviewRequestId) {
      sqlPreviewLoading.value = false;
      sqlPreviewPending.value = false;
    }
  }
}

const canApply = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !postSaveRefreshing.value &&
    !secondaryMetadataLoading.value &&
    !mysqlTableEngineLoading.value &&
    !sqlPreviewLoading.value &&
    !sqlPreviewPending.value &&
    pendingStatements.value.length > 0 &&
    warnings.value.length === 0 &&
    !concurrentAvailabilityInvalidated.value &&
    (!hasSqliteTypeChange.value || !!sqliteSchemaRevision.value) &&
    !!props.connectionId &&
    (isCreateMode.value ? !!newTableName.value.trim() : !!props.tableName),
);

function clearDraft() {
  draftHydrated = false;
  emit("update:draft", undefined);
}

function resetState() {
  loading.value = false;
  saving.value = false;
  postSaveRefreshing.value = false;
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  indexesLoading.value = false;
  foreignKeysLoading.value = false;
  constraintsLoading.value = false;
  triggersLoading.value = false;
  errorMessage.value = "";
  secondaryMetadataErrors.value = {};
  isPartitionedParent.value = false;
  partitionStatusKnown.value = true;
  concurrentAvailabilityInvalidated.value = false;
  columns.value = [];
  indexes.value = [];
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
  foreignKeys.value = [];
  constraints.value = [];
  constraintsLoaded.value = false;
  triggers.value = [];
  triggersLoaded.value = false;
  clearColumnSelection();
  ddlContent.value = "";
  ddlFetched.value = false;
  loadedMetadataFacets.clear();
  newTableName.value = "";
  tableComment.value = "";
  originalTableComment.value = "";
  mysqlAutoIncrementValue.value = undefined;
  originalMysqlAutoIncrementValue.value = undefined;
  mysqlAutoIncrementLoadRequestId += 1;
  mysqlAutoIncrementLoading.value = false;
  mysqlAutoIncrementLoadError.value = "";
  mysqlTableEngine.value = "";
  originalMysqlTableEngine.value = "";
  mysqlTableEngineOptions.value = [];
  mysqlTableEngineLoadRequestId += 1;
  mysqlTableEngineLoading.value = false;
  mysqlTableEngineLoadError.value = "";
  tableOwner.value = "";
  originalTableOwner.value = "";
  tableOwnerLoadRequestId += 1;
  tableOwnerLoading.value = false;
  tableOwnerLoadError.value = "";
  tableOwnerRoles.value = [];
  tableOwnerRolesLoadRequestId += 1;
  tableOwnerRolesLoading.value = false;
  tableOwnerRolesLoadError.value = "";
  columnSearchText.value = "";
  highlightedColumnId.value = null;
  indexSearchText.value = "";
  highlightedIndexId.value = null;
  appliedInitialTargetSearchKey = "";
  appliedInitialTargetScrollKey = "";
  localColumnOrderNoticeShown.value = false;
}

async function reloadStructureFromDatabase() {
  if (isCreateMode.value) return;
  draftHydrated = false;
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  if (activeTab.value !== "constraints") {
    constraints.value = [];
    constraintsLoaded.value = false;
  }
  const refreshDdl = activeTab.value === "ddl";
  const metadataMatch = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName };
  invalidateTableMetadataCache(metadataMatch);
  await invalidateObjectDdl(ddlRequest());
  loadedMetadataFacets.clear();
  if (refreshDdl) {
    ddlFetched.value = false;
    await Promise.all([fetchDdl(true), loadTableOwner(true), loadTableOwnerRoles(), loadMysqlTableEngine(true)]);
  } else {
    await Promise.all([loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true, forceDdl: true, forceMetadata: true }), loadTableOwner(true), loadTableOwnerRoles(), loadMysqlTableEngine(true)]);
  }
}

function setSecondaryMetadataLoading(scope: TableStructureRefreshScope, value: boolean) {
  if (scope.indexes && tableMetadataCapabilities.value.indexes) indexesLoading.value = value;
  if (scope.foreignKeys && tableMetadataCapabilities.value.foreignKeys) foreignKeysLoading.value = value;
  if (scope.constraints && tableMetadataCapabilities.value.constraints) constraintsLoading.value = value;
  if (scope.triggers && tableMetadataCapabilities.value.triggers) triggersLoading.value = value;
}

function withRequiredPostgresPrimaryKeyMetadata(scope: TableStructureRefreshScope): TableStructureRefreshScope {
  if (isCreateMode.value || databaseType.value !== "postgres") return scope;
  const needsPrimaryKeyMetadata = scope.columns || (activeTab.value === "columns" && !loadedMetadataFacets.has("indexes"));
  return needsPrimaryKeyMetadata && !scope.indexes ? { ...scope, indexes: true } : scope;
}

async function fetchTableCommentValue(connectionId: string, database: string, schema: string, tableName: string, catalog?: string): Promise<string | undefined> {
  try {
    return (await api.getTableComment(connectionId, database, schema, tableName, catalog)) || "";
  } catch {
    try {
      const tables = await api.listTables(connectionId, database, schema, undefined, undefined, undefined, undefined, catalog);
      const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && t.table_type !== "VIEW");
      return table?.comment || "";
    } catch {
      return undefined;
    }
  }
}

function loadCachedTableComment(request: ReturnType<typeof ddlRequest>, force = false): Promise<{ value: string | undefined; cacheStatus: "memory" | "disk" | "remote" }> {
  return loadObjectMetadataFacet(request, "comment", () => fetchTableCommentValue(request.connectionId, request.database, request.schema, request.tableName, request.catalog), { force });
}

async function loadMysqlAutoIncrementCounter(preserveDraft = false) {
  const requestId = ++mysqlAutoIncrementLoadRequestId;
  if (!canEditMysqlAutoIncrement.value || !props.connectionId || !props.database || !props.tableName) {
    mysqlAutoIncrementValue.value = undefined;
    originalMysqlAutoIncrementValue.value = undefined;
    mysqlAutoIncrementLoading.value = false;
    mysqlAutoIncrementLoadError.value = "";
    return;
  }
  mysqlAutoIncrementLoading.value = true;
  mysqlAutoIncrementLoadError.value = "";
  try {
    await store.ensureConnected(props.connectionId);
    const value = await api.getMysqlTableAutoIncrement(props.connectionId, props.database, props.tableName);
    if (requestId !== mysqlAutoIncrementLoadRequestId) return;
    const server = value === null && !hasPersistedMysqlAutoIncrementColumn.value ? "" : value;
    const draft = refreshMysqlAutoIncrementCounterDraft(server, { value: mysqlAutoIncrementValue.value, originalValue: originalMysqlAutoIncrementValue.value }, preserveDraft);
    originalMysqlAutoIncrementValue.value = draft.originalValue;
    mysqlAutoIncrementValue.value = draft.value;
  } catch (error: any) {
    if (requestId !== mysqlAutoIncrementLoadRequestId) return;
    mysqlAutoIncrementLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === mysqlAutoIncrementLoadRequestId) mysqlAutoIncrementLoading.value = false;
  }
}

async function loadMysqlTableEngine(preserveDraft = false) {
  const requestId = ++mysqlTableEngineLoadRequestId;
  const connectionId = props.connectionId;
  const database = props.database;
  if (!supportsMysqlEngine.value || !connectionId || !database) {
    mysqlTableEngine.value = "";
    originalMysqlTableEngine.value = "";
    mysqlTableEngineOptions.value = [];
    mysqlTableEngineLoading.value = false;
    mysqlTableEngineLoadError.value = "";
    return;
  }

  mysqlTableEngineLoading.value = true;
  mysqlTableEngineLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const [enginesResult, tableResult] = await Promise.all([
      api.executeQuery(connectionId, database, MYSQL_STORAGE_ENGINES_SQL, undefined, undefined, { maxRows: 100 }),
      isCreateMode.value || !props.tableName ? Promise.resolve(undefined) : api.executeQuery(connectionId, database, mysqlTableEngineSql(database, props.tableName), undefined, undefined, { maxRows: 1 }),
    ]);
    if (requestId !== mysqlTableEngineLoadRequestId) return;
    const metadata = parseMysqlTableEngineMetadata(enginesResult, tableResult);
    const draft = refreshMysqlTableEngineDraft(metadata, { value: mysqlTableEngine.value, originalValue: originalMysqlTableEngine.value }, isCreateMode.value, preserveDraft);
    const options = [...metadata.engines];
    if (draft.value && !options.some((option) => option.toLowerCase() === draft.value.toLowerCase())) options.unshift(draft.value);
    mysqlTableEngineOptions.value = options;
    mysqlTableEngine.value = draft.value;
    originalMysqlTableEngine.value = draft.originalValue;
  } catch (error: any) {
    if (requestId !== mysqlTableEngineLoadRequestId) return;
    mysqlTableEngineLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === mysqlTableEngineLoadRequestId) mysqlTableEngineLoading.value = false;
  }
}

async function loadTableOwner(force = false, preserveDraft = false) {
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  const catalog = props.catalog;
  if (!supportsTableOwner.value || !connectionId || !database || !schema || !tableName) return;
  const requestId = ++tableOwnerLoadRequestId;
  tableOwnerLoading.value = true;
  tableOwnerLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const result = await loadObjectMetadataFacet({ connectionId, database, schema, tableName, catalog }, "owner", () => api.getTableOwner(connectionId, database, schema, tableName), { force });
    if (requestId !== tableOwnerLoadRequestId) return;
    const owner = result.value || "";
    originalTableOwner.value = owner;
    if (!preserveDraft) tableOwner.value = owner;
    loadedMetadataFacets.add("owner");
  } catch (error: any) {
    if (requestId !== tableOwnerLoadRequestId) return;
    tableOwnerLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === tableOwnerLoadRequestId) tableOwnerLoading.value = false;
  }
}

async function loadTableOwnerRoles() {
  const connectionId = props.connectionId;
  const database = props.database;
  if (!supportsTableOwner.value || !connectionId || !database) return;
  const requestId = ++tableOwnerRolesLoadRequestId;
  tableOwnerRolesLoading.value = true;
  tableOwnerRolesLoadError.value = "";
  try {
    await store.ensureConnected(connectionId);
    const result = await api.executeQuery(connectionId, database, postgresListRolesSql(), undefined, undefined, { maxRows: 5000 });
    if (requestId !== tableOwnerRolesLoadRequestId) return;
    tableOwnerRoles.value = [
      ...new Set(
        usersFromPostgresRolesResult(result)
          .map((role) => role.user)
          .filter(Boolean),
      ),
    ];
  } catch (error: any) {
    if (requestId !== tableOwnerRolesLoadRequestId) return;
    tableOwnerRoles.value = [];
    tableOwnerRolesLoadError.value = error?.message || String(error);
  } finally {
    if (requestId === tableOwnerRolesLoadRequestId) tableOwnerRolesLoading.value = false;
  }
}

async function loadStructure(
  silent = false,
  scope: TableStructureRefreshScope = visibleTableStructureRefreshScope(activeTab.value),
  showErrors = true,
  options: { blockSecondaryMetadata?: boolean; preserveDraft?: boolean; characterLengthUnitsAfterSave?: ReadonlyMap<string, string>; forceDdl?: boolean; forceMetadata?: boolean } = {},
) {
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  const effectiveScope = withRequiredPostgresPrimaryKeyMetadata(scope);
  const requestId = ++structureLoadRequestId;
  if (!silent) loading.value = true;
  setSecondaryMetadataLoading(effectiveScope, true);
  errorMessage.value = "";
  secondaryMetadataErrors.value = {};
  let secondaryMetadataScheduled = false;
  let loadedSuccessfully = false;
  try {
    await store.ensureConnected(connectionId);

    const metadataRequest = ddlRequest();
    const forceMetadata = options.forceMetadata === true;
    const partitionStatusPromise =
      databaseType.value === "postgres" && !isCreateMode.value
        ? api
            .getTablePartitionStatus(connectionId, database, schema, tableName)
            // No reactive mutation inside the catch: a stale request must not
            // overwrite a newer probe's result (the structureLoadRequestId
            // guard below decides). Fail closed — without a verified partition
            // status we cannot rule out a partitioned parent, so Concurrent is
            // treated as unavailable until a later reload re-runs the probe.
            .then((status) => ({ known: true, status }))
            .catch(() => ({ known: false, status: { isPartitionedParent: false, isPartition: false } }))
        : Promise.resolve({ known: true, status: { isPartitionedParent: false, isPartition: false } });
    const columnsPromise = effectiveScope.columns ? loadObjectMetadataFacet(metadataRequest, "columns", () => api.getColumns(connectionId, database, schema, tableName, catalog), { force: forceMetadata }).then((result) => result.value) : Promise.resolve(undefined);
    const indexesPromise = effectiveScope.indexes
      ? tableMetadataCapabilities.value.indexes
        ? loadObjectMetadataFacet(metadataRequest, "indexes", () => api.listIndexes(connectionId, database, schema, tableName, catalog), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const foreignKeysPromise = effectiveScope.foreignKeys
      ? tableMetadataCapabilities.value.foreignKeys
        ? loadObjectMetadataFacet(metadataRequest, "foreign-keys", () => api.listForeignKeys(connectionId, database, schema, tableName, catalog), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const constraintsPromise = effectiveScope.constraints
      ? tableMetadataCapabilities.value.constraints
        ? loadObjectMetadataFacet(metadataRequest, "constraints", () => api.listConstraints(connectionId, database, schema, tableName, catalog), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const triggersPromise = effectiveScope.triggers
      ? tableMetadataCapabilities.value.triggers
        ? loadObjectMetadataFacet(metadataRequest, "triggers", () => api.listTriggers(connectionId, database, schema, tableName, catalog), { force: forceMetadata }).then((result) => result.value)
        : Promise.resolve([])
      : Promise.resolve(undefined);
    const tableCommentPromise = effectiveScope.tableComment && structureCapabilities.value.comment ? loadCachedTableComment(metadataRequest, forceMetadata).then((result) => result.value) : Promise.resolve(undefined);

    let nextColumns = await columnsPromise;
    if (nextColumns) {
      if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
        try {
          const { ddl } = await loadObjectDdl({ connectionId, database, schema, tableName, catalog }, { force: options.forceDdl });
          ddlContent.value = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(databaseType.value), settingsStore.editorSettings.sqlFormatter);
          ddlFetched.value = true;
          nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
        } catch {
          /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
        }
      }
      // Load live charset/collation metadata from the MySQL server so the column
      // editor shows the correct options for the server version.
      void loadCharsetMetadata();
      const nextColumnDrafts = createColumnDrafts(nextColumns, databaseType.value);
      const hydratedColumnDrafts = supportsCharacterLengthUnits.value && options.characterLengthUnitsAfterSave ? restoreCharacterLengthUnitsAfterSave(databaseType.value, nextColumnDrafts, options.characterLengthUnitsAfterSave) : nextColumnDrafts;
      columns.value = applyStoredLocalColumnOrder(hydratedColumnDrafts);
      loadedMetadataFacets.add("columns");
      if (!options.preserveDraft) clearColumnSelection();
    }

    await loadMysqlAutoIncrementCounter(options.preserveDraft === true);

    const nextTableComment = await tableCommentPromise;
    if (nextTableComment !== undefined) {
      originalTableComment.value = nextTableComment;
      tableComment.value = nextTableComment;
      loadedMetadataFacets.add("comment");
    }
    const partitionStatus = await partitionStatusPromise;
    if (requestId === structureLoadRequestId) {
      partitionStatusKnown.value = partitionStatus.known;
      isPartitionedParent.value = partitionStatus.status.isPartitionedParent;
      // Availability inputs changed: fail closed while the status is unknown,
      // but preserve the user's Concurrent intent so a later successful probe
      // can regenerate the same SQL. Definitive unsupported states still clear
      // the flag. A partitioned parent or unknown status keeps Save blocked.
      normalizeConcurrentIndexDraftsForCurrentAvailability();
      if (partitionStatus.known && !partitionStatus.status.isPartitionedParent && structureCapabilities.value.indexConcurrent && structureCapabilities.value.createIndex && concurrentAvailabilityInvalidated.value) {
        concurrentAvailabilityInvalidated.value = false;
        scheduleSqlPreviewRefresh();
      }
    }
    const applySecondaryMetadata = async () => {
      const [indexesResult, foreignKeysResult, constraintsResult, triggersResult] = await Promise.allSettled([indexesPromise, foreignKeysPromise, constraintsPromise, triggersPromise]);
      if (requestId !== structureLoadRequestId) return;

      type SecondaryMetadataResult = { facet: ObjectMetadataFacet; result: PromiseSettledResult<unknown> };
      const secondaryResults: SecondaryMetadataResult[] = [
        { facet: "indexes", result: indexesResult },
        { facet: "foreign-keys", result: foreignKeysResult },
        { facet: "constraints", result: constraintsResult },
        { facet: "triggers", result: triggersResult },
      ];
      const failedFacets = secondaryResults.filter((entry): entry is { facet: ObjectMetadataFacet; result: PromiseRejectedResult } => entry.result.status === "rejected");
      for (const { facet, result } of failedFacets) {
        console.warn(`[DBX][structure-editor:${facet}-metadata-failed]`, result.reason);
      }
      if (showErrors && failedFacets.length > 0) {
        for (const { facet, result } of failedFacets) {
          secondaryMetadataErrors.value[facet] = result.reason?.message || String(result.reason);
        }
      }

      const nextIndexes = indexesResult.status === "fulfilled" ? indexesResult.value : undefined;
      const nextForeignKeys = foreignKeysResult.status === "fulfilled" ? foreignKeysResult.value : undefined;
      const nextConstraints = constraintsResult.status === "fulfilled" ? constraintsResult.value : undefined;
      const nextTriggers = triggersResult.status === "fulfilled" ? triggersResult.value : undefined;
      if (nextIndexes) {
        indexes.value = createIndexDrafts(nextIndexes);
        loadedMetadataFacets.add("indexes");
      }
      if (nextForeignKeys) {
        foreignKeys.value = createForeignKeyDrafts(nextForeignKeys);
        loadedMetadataFacets.add("foreign-keys");
      }
      if (nextConstraints) {
        constraints.value = nextConstraints;
        constraintsLoaded.value = true;
        loadedMetadataFacets.add("constraints");
      }
      if (nextTriggers) {
        triggers.value = createTriggerDrafts(nextTriggers);
        triggersLoaded.value = true;
        loadedMetadataFacets.add("triggers");
      }
    };

    secondaryMetadataScheduled = true;
    const secondaryMetadataPromise = applySecondaryMetadata()
      .catch((error) => {
        console.warn("[DBX][structure-editor:secondary-metadata-failed]", error);
      })
      .finally(() => {
        if (requestId === structureLoadRequestId) setSecondaryMetadataLoading(effectiveScope, false);
      });
    if (options.blockSecondaryMetadata) {
      await secondaryMetadataPromise;
    }
    loadedSuccessfully = true;
  } catch (e: any) {
    if (showErrors) {
      errorMessage.value = e?.message || String(e);
    } else {
      console.warn("[DBX][structure-editor:refresh-failed]", e);
    }
  } finally {
    if (!secondaryMetadataScheduled && requestId === structureLoadRequestId) {
      setSecondaryMetadataLoading(effectiveScope, false);
    }
    if (!silent) loading.value = false;
    if (!options.preserveDraft && loadedSuccessfully && requestId === structureLoadRequestId) {
      markDraftHydratedAndSync();
    }
  }
}

async function refreshStructureAfterSave(scope: TableStructureRefreshScope, characterLengthUnitsAfterSave: ReadonlyMap<string, string>) {
  try {
    await Promise.all([loadStructure(true, scope, false, { blockSecondaryMetadata: true, characterLengthUnitsAfterSave }), loadTableOwner(true), loadMysqlTableEngine(false)]);
  } catch (e) {
    console.warn("[DBX][structure-editor:post-save-refresh-failed]", e);
  } finally {
    postSaveRefreshing.value = false;
    if (mysqlAutoIncrementValue.value !== originalMysqlAutoIncrementValue.value) scheduleSqlPreviewRefresh();
    if (activeTab.value === "ddl") void fetchDdl(true);
  }
}

async function focusColumnNameInput(columnId: string) {
  await nextTick();
  const row = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []).find((element) => element.dataset.columnId === columnId);
  const input = row?.querySelector<HTMLInputElement>("[data-column-name-input]");
  row?.scrollIntoView({ block: "nearest" });
  input?.focus();
  input?.select();
}

function columnIsSelectable(column: EditableStructureColumn): boolean {
  return !column.markedForDrop && columns.value.some((item) => item.id === column.id);
}

/** Replace the whole selection state (set + active + shift anchor) atomically. */
function setColumnSelection(ids: Iterable<string>, activeId: string | null, anchorId: string | null) {
  selectedColumnIds.value = new Set(ids);
  selectedColumnId.value = activeId;
  columnSelectionAnchorId.value = anchorId;
}

function clearColumnSelection() {
  setColumnSelection([], null, null);
}

function selectSingleColumn(column: EditableStructureColumn) {
  setColumnSelection([column.id], column.id, column.id);
}

/** Ctrl/Cmd-click: toggle the row in the set and move the anchor to it. */
function toggleColumnSelection(column: EditableStructureColumn) {
  const next = new Set(selectedColumnIds.value);
  if (next.has(column.id)) next.delete(column.id);
  else next.add(column.id);
  setColumnSelection(next, resolveColumnSelectionActiveId(columns.value, next, column.id), column.id);
}

/** Shift-click: select the visible range between the anchor and this row; the anchor stays put. */
function selectColumnRangeFromAnchor(column: EditableStructureColumn) {
  const anchorId = columnSelectionAnchorId.value && columns.value.some((item) => item.id === columnSelectionAnchorId.value && !item.markedForDrop) ? columnSelectionAnchorId.value : column.id;
  setColumnSelection(structureColumnSelectionRange(columns.value, anchorId, column.id), column.id, anchorId);
}

// A mouse-driven click first triggers focusin (focus moves into the row's
// inputs) before click. While a pointer selection is in flight, focusin must
// not reset an in-progress ctrl/shift multi-selection; the flag is cleared on
// click and on any mouseup as a fallback.
let columnPointerSelectionActive = false;
let columnContextMenuButton: number | null = null;
let columnContextMenuCtrlKey = false;

function onColumnRowMouseDown(event: MouseEvent) {
  columnPointerSelectionActive = true;
  if (event.button === 0) {
    columnContextMenuButton = null;
    columnContextMenuCtrlKey = false;
  } else {
    columnContextMenuButton = event.button;
    columnContextMenuCtrlKey = event.ctrlKey;
  }
}

function onColumnSelectionPointerUp() {
  columnPointerSelectionActive = false;
}

function onColumnRowClick(column: EditableStructureColumn, event: MouseEvent) {
  if (isSyntheticContextMenuClick(columnContextMenuButton, columnContextMenuCtrlKey, event.button)) {
    columnContextMenuButton = null;
    columnContextMenuCtrlKey = false;
    columnPointerSelectionActive = false;
    return;
  }
  columnContextMenuButton = null;
  columnContextMenuCtrlKey = false;
  columnPointerSelectionActive = false;
  if (!columnIsSelectable(column)) return;
  if (event.shiftKey) {
    selectColumnRangeFromAnchor(column);
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    toggleColumnSelection(column);
    return;
  }
  selectSingleColumn(column);
}

function onColumnRowActivate(column: EditableStructureColumn) {
  // focusin path (keyboard Tab into row inputs); mouse clicks are handled by onColumnRowClick.
  if (columnPointerSelectionActive) return;
  if (!columnIsSelectable(column)) return;
  selectSingleColumn(column);
}

function normalizedColumnSearch(value: string): string {
  return value.trim().toLowerCase();
}

const copyableSourceColumns = computed(() => {
  const databaseInfo = connection.value?.database_info;
  const existingNames = new Set(columns.value.filter((column) => !column.markedForDrop).map((column) => tableStructureIdentifierComparisonKey(column.name, databaseType.value, databaseInfo)));
  return copySourceColumns.value.map((column) => ({
    column,
    alreadyExists: existingNames.has(tableStructureIdentifierComparisonKey(column.name, databaseType.value, databaseInfo)),
  }));
});

const filteredCopyableSourceColumns = computed(() => {
  const search = normalizedColumnSearch(copySourceColumnSearch.value);
  if (!search) return copyableSourceColumns.value;
  return copyableSourceColumns.value.filter(({ column }) => [column.name, column.data_type, column.comment ?? ""].some((value) => normalizedColumnSearch(value).includes(search)));
});

const copyableSourceColumnNames = computed(() => copyableSourceColumns.value.filter(({ alreadyExists }) => !alreadyExists).map(({ column }) => column.name));
const selectedCopySourceColumns = computed(() => {
  const selected = new Set(selectedCopySourceColumnNames.value);
  return copyableSourceColumns.value.filter(({ column, alreadyExists }) => !alreadyExists && selected.has(column.name)).map(({ column }) => column);
});
const allCopyableSourceColumnsSelected = computed(() => copyableSourceColumnNames.value.length > 0 && copyableSourceColumnNames.value.every((name) => selectedCopySourceColumnNames.value.includes(name)));
const copySourceTablesHasPreviousPage = computed(() => copySourceTablesOffset.value > 0);

function clearCopySourceTableSearchTimer() {
  if (copySourceTableSearchTimer === undefined) return;
  clearTimeout(copySourceTableSearchTimer);
  copySourceTableSearchTimer = undefined;
}

function isCopySourceTable(table: TableInfo): boolean {
  const databaseInfo = connection.value?.database_info;
  return isCreateMode.value || tableStructureIdentifierComparisonKey(table.name, databaseType.value, databaseInfo) !== tableStructureIdentifierComparisonKey(props.tableName, databaseType.value, databaseInfo);
}

function clearCopySourceTableSelection() {
  copySourceTableName.value = "";
  copySourceColumns.value = [];
  copySourceColumnSearch.value = "";
  selectedCopySourceColumnNames.value = [];
  copySourceColumnsRequestId++;
  copySourceColumnsLoading.value = false;
}

async function loadCopySourceTables(offset = 0) {
  if (!props.connectionId || !props.database) return;
  clearCopySourceTableSelection();
  const requestId = ++copySourceTablesRequestId;
  copySourceTablesLoading.value = true;
  copySourceError.value = "";
  try {
    await store.ensureConnected(props.connectionId);
    const tables = await api.listTables(props.connectionId, props.database, metadataSchema.value, copySourceTableSearch.value.trim() || undefined, COPY_SOURCE_TABLE_PAGE_PROBE_SIZE, offset, ["TABLE"], props.catalog);
    if (requestId !== copySourceTablesRequestId) return;
    copySourceTables.value = tables.slice(0, COPY_SOURCE_TABLE_PAGE_SIZE).filter(isCopySourceTable);
    copySourceTablesOffset.value = offset;
    // The current table is excluded locally. Probe the next two rows so its
    // presence immediately after a full page does not create an empty next page.
    copySourceTablesHasMore.value = tables.slice(COPY_SOURCE_TABLE_PAGE_SIZE).some(isCopySourceTable);
  } catch (error: any) {
    if (requestId !== copySourceTablesRequestId) return;
    copySourceTables.value = [];
    copySourceTablesHasMore.value = false;
    copySourceError.value = error?.message || String(error);
  } finally {
    if (requestId === copySourceTablesRequestId) copySourceTablesLoading.value = false;
  }
}

function updateCopySourceTableSearch(value: string | number) {
  copySourceTableSearch.value = String(value);
  clearCopySourceTableSelection();
  clearCopySourceTableSearchTimer();
  copySourceTableSearchTimer = setTimeout(() => {
    copySourceTableSearchTimer = undefined;
    void loadCopySourceTables();
  }, COPY_SOURCE_TABLE_SEARCH_DEBOUNCE_MS);
}

watch(copyColumnsDialogOpen, (open) => {
  if (open) return;
  clearCopySourceTableSearchTimer();
  copySourceTablesRequestId++;
  copySourceColumnsRequestId++;
});

async function openCopyColumnsDialog() {
  if (!canAddColumn.value || !props.connectionId || !props.database) return;
  copyColumnsDialogOpen.value = true;
  copySourceTableName.value = "";
  copySourceTableSearch.value = "";
  copySourceColumns.value = [];
  copySourceColumnSearch.value = "";
  selectedCopySourceColumnNames.value = [];
  copySourceError.value = "";
  copySourceColumnsRequestId++;
  copySourceColumnsLoading.value = false;
  copySourceTables.value = [];
  copySourceTablesOffset.value = 0;
  copySourceTablesHasMore.value = false;
  clearCopySourceTableSearchTimer();
  await loadCopySourceTables();
}

async function loadCopySourceColumns(tableName: string) {
  copySourceTableName.value = tableName;
  copySourceColumns.value = [];
  copySourceColumnSearch.value = "";
  selectedCopySourceColumnNames.value = [];
  copySourceError.value = "";
  if (!tableName || !props.connectionId || !props.database) return;
  const requestId = ++copySourceColumnsRequestId;
  copySourceColumnsLoading.value = true;
  try {
    const sourceColumns = await api.getColumns(props.connectionId, props.database, metadataSchema.value, tableName, props.catalog);
    if (requestId !== copySourceColumnsRequestId) return;
    copySourceColumns.value = sourceColumns;
    selectedCopySourceColumnNames.value = copyableSourceColumns.value.filter(({ alreadyExists }) => !alreadyExists).map(({ column }) => column.name);
  } catch (error: any) {
    if (requestId !== copySourceColumnsRequestId) return;
    copySourceError.value = error?.message || String(error);
  } finally {
    if (requestId === copySourceColumnsRequestId) copySourceColumnsLoading.value = false;
  }
}

function toggleCopySourceColumns() {
  selectedCopySourceColumnNames.value = allCopyableSourceColumnsSelected.value ? [] : [...copyableSourceColumnNames.value];
}

function applyCopiedColumns() {
  const copiedColumns = createCopiedColumnDrafts(selectedCopySourceColumns.value, databaseType.value, uuid);
  if (!copiedColumns.length) return;
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, ...copiedColumns);
  const lastCopiedColumn = copiedColumns[copiedColumns.length - 1];
  if (lastCopiedColumn) selectSingleColumn(lastCopiedColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  copyColumnsDialogOpen.value = false;
}

async function copyColumn(column: EditableStructureColumn) {
  if (!canAddColumn.value || column.markedForDrop) return;
  const sourceIndex = columns.value.findIndex((item) => item.id === column.id);
  if (sourceIndex < 0) return;
  const copiedColumn = cloneColumnDraftAsNew(column, uuid);
  columns.value.splice(sourceIndex + 1, 0, copiedColumn);
  selectSingleColumn(copiedColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(copiedColumn.id);
}

async function addColumn(afterColumn?: EditableStructureColumn) {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const dataType = defaultNewColumnDataType(databaseType.value, dataTypeOptions.value);
  const column: EditableStructureColumn = {
    id: `new:${uuid()}`,
    name: "",
    dataType,
    enumValues: [],
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    characterSet: "",
    collation: "",
    extra: {},
    markedForDrop: false,
  };
  const sourceIndex = afterColumn ? columns.value.findIndex((item) => item.id === afterColumn.id) : -1;
  const insertAt = sourceIndex >= 0 ? sourceIndex + 1 : resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, column);
  selectSingleColumn(column);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(column.id);
}

function applyColumnTemplate(templateId: string) {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const templateColumns = createTableColumnTemplateDrafts({
    templateId,
    databaseType: databaseType.value,
    columnNames: settingsStore.editorSettings.tableColumnTemplateFields,
    existingColumnNames: columns.value.map((column) => column.name),
    createId: uuid,
  });
  if (!templateColumns.length) return;
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, ...templateColumns);
  const lastTemplateColumn = templateColumns[templateColumns.length - 1];
  if (lastTemplateColumn) selectSingleColumn(lastTemplateColumn);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
  if (selectedColumnIds.value.has(column.id)) {
    const next = new Set(selectedColumnIds.value);
    next.delete(column.id);
    selectedColumnIds.value = next;
  }
  if (selectedColumnId.value === column.id) selectedColumnId.value = null;
  if (columnSelectionAnchorId.value === column.id) columnSelectionAnchorId.value = null;
}

type ColumnDragState = {
  columnId: string;
  sourceIndex: number;
  insertionIndex: number | null;
};

const columnDragState = ref<ColumnDragState | null>(null);
const localColumnOrderNoticeShown = ref(false);
let columnDragPreviousBodyUserSelect = "";
let columnDragPreviousBodyCursor = "";
let columnDragTracking = false;

function canDragColumn(index: number): boolean {
  if (loading.value || saving.value) return false;
  if (!Number.isInteger(index) || index < 0 || index >= columns.value.length) return false;
  const column = columns.value[index];
  if (!column || column.markedForDrop) return false;
  return canShowColumnDragControls.value;
}

function canDropColumnAt(sourceIndex: number, insertionIndex: number): boolean {
  if (!canDragColumn(sourceIndex)) return false;
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > columns.value.length) return false;
  if (insertionIndex === sourceIndex || insertionIndex === sourceIndex + 1) return false;
  const sourceColumn = columns.value[sourceIndex];
  if (!sourceColumn) return false;
  const crossedColumns = insertionIndex < sourceIndex ? columns.value.slice(insertionIndex, sourceIndex) : columns.value.slice(sourceIndex + 1, insertionIndex);
  if (crossedColumns.some((column) => column.markedForDrop)) return false;
  if (canShowColumnDragControls.value) return true;
  if (sourceColumn.original) return false;
  return crossedColumns.every((column) => !column.original);
}

const usesLocalTableColumnOrder = computed(() => !isCreateMode.value && supportsLocalTableColumnReorder(databaseType.value, connection.value?.db_type));
const canShowColumnDragControls = computed(() => isCreateMode.value || structureCapabilities.value.reorderColumn || usesLocalTableColumnOrder.value);

function localTableColumnOrderScopeKey(): string {
  return tableDataGridColumnOrderScopeKey({
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    tableName: props.tableName,
  });
}

function localColumnOrderKeys(items: readonly EditableStructureColumn[]): string[] {
  return uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
}

const hasLocalColumnOrderChange = computed(() => {
  if (!usesLocalTableColumnOrder.value) return false;
  return hasLocalTableColumnOrderChange(columns.value);
});

function applyStoredLocalColumnOrder(items: EditableStructureColumn[]): EditableStructureColumn[] {
  if (!usesLocalTableColumnOrder.value) return items;
  const orderedKeys = loadTableDataGridColumnOrder(localTableColumnOrderScopeKey());
  if (!orderedKeys.length) return items;
  const columnKeys = uniqueDataGridColumnOrderKeys(items.map((column) => column.name));
  const indexes = orderedColumnIndexes({
    availableIndexes: items.map((_, index) => index),
    columnKeys,
    orderedKeys,
  });
  return indexes.map((index) => items[index]).filter((column): column is EditableStructureColumn => !!column);
}

function persistLocalColumnOrder(showNotice = true) {
  if (!usesLocalTableColumnOrder.value) return;
  const scopeKey = localTableColumnOrderScopeKey();
  if (hasLocalColumnOrderChange.value) {
    saveTableDataGridColumnOrder(scopeKey, localColumnOrderKeys(columns.value));
  } else {
    removeTableDataGridColumnOrder(scopeKey);
  }
  notifyTableDataGridColumnOrderChanged(scopeKey);
  if (!showNotice || localColumnOrderNoticeShown.value) return;
  localColumnOrderNoticeShown.value = true;
  toast(t("structureEditor.localColumnOrderNotice"), 4000);
}

function isSqlServerIdentityChecked(column: EditableStructureColumn): boolean {
  return !!column.extra.autoIncrement || !!column.extra.identity;
}

function canEditSqlServerIdentity(column: EditableStructureColumn): boolean {
  return !column.original && !column.markedForDrop && isSqlServerIdentityCompatibleDataType(column.dataType);
}

function clearSqlServerIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = false;
  column.extra.identity = undefined;
}

function syncSqlServerIdentityForDataType(column: EditableStructureColumn) {
  if (databaseType.value !== "sqlserver") return;
  if (!isSqlServerIdentityChecked(column)) return;
  if (isSqlServerIdentityCompatibleDataType(column.dataType)) return;
  clearSqlServerIdentity(column);
}

function ensureSqlServerIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = true;
  column.extra.identity = {
    seed: column.extra.identity?.seed ?? 1,
    increment: column.extra.identity?.increment ?? 1,
  };
}

function setSqlServerIdentity(column: EditableStructureColumn, checked: boolean) {
  if (!canEditSqlServerIdentity(column)) return;
  if (checked) {
    ensureSqlServerIdentity(column);
    column.isNullable = false;
  } else {
    clearSqlServerIdentity(column);
  }
}

function parseOptionalNumberInput(value: string | number): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function updateSqlServerIdentitySeed(column: EditableStructureColumn, value: string | number) {
  if (!canEditSqlServerIdentity(column)) return;
  ensureSqlServerIdentity(column);
  column.extra.identity!.seed = parseOptionalNumberInput(value);
}

function updateSqlServerIdentityIncrement(column: EditableStructureColumn, value: string | number) {
  if (!canEditSqlServerIdentity(column)) return;
  ensureSqlServerIdentity(column);
  column.extra.identity!.increment = parseOptionalNumberInput(value);
}

function isDamengIdentityChecked(column: EditableStructureColumn): boolean {
  return !!column.extra.autoIncrement || !!column.extra.identity;
}

function originalHasDamengIdentity(column: EditableStructureColumn): boolean {
  return column.original?.extra?.toLowerCase().includes("identity") ?? false;
}

function canEditDamengIdentity(column: EditableStructureColumn): boolean {
  if (column.markedForDrop || !isDamengIdentityCompatibleDataType(column.dataType)) return false;
  // DM8 permits only one identity column per table, so prevent creating an invalid draft in the editor.
  return isDamengIdentityChecked(column) || !columns.value.some((candidate) => candidate !== column && !candidate.markedForDrop && isDamengIdentityChecked(candidate));
}

function canEditDamengIdentityParameters(column: EditableStructureColumn): boolean {
  return canEditDamengIdentity(column) && !originalHasDamengIdentity(column);
}

function clearDamengIdentity(column: EditableStructureColumn) {
  column.extra.autoIncrement = false;
  column.extra.identity = undefined;
}

function syncDamengIdentityForDataType(column: EditableStructureColumn) {
  if (databaseType.value !== "dameng") return;
  if (!isDamengIdentityChecked(column)) return;
  if (isDamengIdentityCompatibleDataType(column.dataType)) return;
  clearDamengIdentity(column);
}

function ensureDamengIdentity(column: EditableStructureColumn) {
  const originalIdentity = parseExtraToColumnExtra(column.original?.extra, "dameng").identity;
  column.extra.autoIncrement = true;
  column.extra.identity = {
    seed: column.extra.identity?.seed ?? originalIdentity?.seed ?? 1,
    increment: column.extra.identity?.increment ?? originalIdentity?.increment ?? 1,
  };
}

function setDamengIdentity(column: EditableStructureColumn, checked: boolean) {
  if (!canEditDamengIdentity(column)) return;
  if (checked) {
    ensureDamengIdentity(column);
    column.isNullable = false;
  } else {
    clearDamengIdentity(column);
  }
}

function updateDamengIdentitySeed(column: EditableStructureColumn, value: string | number) {
  if (!canEditDamengIdentityParameters(column)) return;
  ensureDamengIdentity(column);
  column.extra.identity!.seed = parseOptionalNumberInput(value);
}

function updateDamengIdentityIncrement(column: EditableStructureColumn, value: string | number) {
  if (!canEditDamengIdentityParameters(column)) return;
  ensureDamengIdentity(column);
  column.extra.identity!.increment = parseOptionalNumberInput(value);
}

function updateColumnDataType(column: EditableStructureColumn, baseType: string) {
  if (isMysqlEnumDataType(databaseType.value, baseType)) {
    if (!column.enumValues?.length) column.enumValues = [""];
    column.dataType = mysqlEnumDataType(column.enumValues);
  } else {
    column.dataType = combineDataTypeForDatabase(databaseType.value, baseType, getDefaultLengthForType(databaseType.value, baseType, { omitMysqlDeprecatedDefaults: usesMysql8SafeDefaults.value }));
  }
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
  // Clear charset/collation when switching to a non-character MySQL type
  if (showCharacterSet.value && !isMysqlCharacterDataType(column.dataType)) {
    column.characterSet = "";
    column.collation = "";
  }
}

function updateMysqlEnumValue(column: EditableStructureColumn, index: number, value: string | number) {
  if (!column.enumValues || index < 0 || index >= column.enumValues.length) return;
  column.enumValues[index] = String(value);
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function addMysqlEnumValue(column: EditableStructureColumn) {
  column.enumValues ??= [];
  column.enumValues.push("");
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function removeMysqlEnumValue(column: EditableStructureColumn, index: number) {
  if (!column.enumValues || column.enumValues.length <= 1) return;
  column.enumValues.splice(index, 1);
  column.dataType = mysqlEnumDataType(column.enumValues);
}

function updateColumnDataTypeLength(column: EditableStructureColumn, value: string | number) {
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType);
  column.dataType = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, String(value), dataTypeLengthUnitValue(databaseType.value, column.dataType));
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
}

function updateColumnDataTypeLengthUnit(column: EditableStructureColumn, value: unknown) {
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType);
  const unit = value === "__default" ? "" : String(value ?? "");
  column.dataType = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, dataTypeLengthInputValue(databaseType.value, column.dataType), unit);
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
}

function moveColumnTo(index: number, insertionIndex: number) {
  if (!canDropColumnAt(index, insertionIndex)) return;
  const nextColumns = [...columns.value];
  const [column] = nextColumns.splice(index, 1);
  if (!column) return;
  const adjustedInsertionIndex = insertionIndex > index ? insertionIndex - 1 : insertionIndex;
  nextColumns.splice(adjustedInsertionIndex, 0, column);
  columns.value = nextColumns;
  persistLocalColumnOrder();
}

function onColumnDragPointerDown(index: number, event: PointerEvent) {
  if (event.button !== 0 || !canDragColumn(index)) return;
  const column = columns.value[index];
  if (!column) return;
  event.preventDefault();
  event.stopPropagation();
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  columnDragPreviousBodyUserSelect = document.body.style.userSelect;
  columnDragPreviousBodyCursor = document.body.style.cursor;
  columnDragTracking = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";
  updateColumnDragInsertion(event.clientY);
  window.addEventListener("pointermove", onColumnDragPointerMove, true);
  window.addEventListener("pointerup", onColumnDragPointerUp, true);
  window.addEventListener("pointercancel", onColumnDragPointerCancel, true);
}

function onColumnDragPointerMove(event: PointerEvent) {
  if (!columnDragState.value) return;
  event.preventDefault();
  updateColumnDragInsertion(event.clientY);
}

function onColumnDragPointerUp(event: PointerEvent) {
  event.preventDefault();
  const state = columnDragState.value;
  stopColumnDragTracking();
  if (state && state.insertionIndex !== null && canDropColumnAt(state.sourceIndex, state.insertionIndex)) {
    moveColumnTo(state.sourceIndex, state.insertionIndex);
  }
  columnDragState.value = null;
}

function onColumnDragPointerCancel() {
  stopColumnDragTracking();
  columnDragState.value = null;
}

function stopColumnDragTracking() {
  if (!columnDragTracking) return;
  columnDragTracking = false;
  window.removeEventListener("pointermove", onColumnDragPointerMove, true);
  window.removeEventListener("pointerup", onColumnDragPointerUp, true);
  window.removeEventListener("pointercancel", onColumnDragPointerCancel, true);
  document.body.style.userSelect = columnDragPreviousBodyUserSelect;
  document.body.style.cursor = columnDragPreviousBodyCursor;
}

function updateColumnDragInsertion(clientY: number) {
  const state = columnDragState.value;
  if (!state) return;
  const insertionIndex = columnDragInsertionIndexFromPoint(clientY);
  state.insertionIndex = insertionIndex !== null && canDropColumnAt(state.sourceIndex, insertionIndex) ? insertionIndex : null;
}

function columnDragInsertionIndexFromPoint(clientY: number): number | null {
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []);
  if (!rows.length) return null;
  const firstRect = rows[0].getBoundingClientRect();
  if (clientY < firstRect.top) return 0;
  for (const row of rows) {
    const rowIndex = Number(row.dataset.columnRowIndex);
    if (!Number.isInteger(rowIndex)) continue;
    const rect = row.getBoundingClientRect();
    if (clientY <= rect.bottom) {
      return clientY > rect.top + rect.height / 2 ? rowIndex + 1 : rowIndex;
    }
  }
  return rows.length;
}

function onColumnDragStart(index: number, event: DragEvent) {
  if (!canDragColumn(index)) {
    event.preventDefault();
    return;
  }
  const column = columns.value[index];
  if (!column) return;
  columnDragState.value = {
    columnId: column.id,
    sourceIndex: index,
    insertionIndex: null,
  };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", column.name || column.id);
  }
}

function onColumnDragOver(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state || columns.value[index]?.markedForDrop) return;
  const insertionIndex = columnDragInsertionIndex(index, event);
  if (!canDropColumnAt(state.sourceIndex, insertionIndex)) return;
  event.preventDefault();
  state.insertionIndex = insertionIndex;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
}

function onColumnDrop(index: number, event: DragEvent) {
  const state = columnDragState.value;
  if (!state) return;
  event.preventDefault();
  moveColumnTo(state.sourceIndex, columnDragInsertionIndex(index, event));
  columnDragState.value = null;
}

function onColumnDragEnd() {
  columnDragState.value = null;
}

function columnRowClass(column: EditableStructureColumn, index: number) {
  const dragState = columnDragState.value;
  const isSearchMatch = filteredColumnRowIds.value.has(column.id);
  const isSelected = selectedColumnIds.value.has(column.id) && !column.markedForDrop;
  return {
    "bg-destructive/5 opacity-60": column.markedForDrop,
    "structure-column-search-match": isSearchMatch,
    // Reuse the existing search-current highlight for the active/selected row.
    "structure-column-search-current": highlightedColumnId.value === column.id || isSelected,
    "opacity-55": dragState?.columnId === column.id,
    "bg-primary/5": dragState && (dragState.insertionIndex === index || dragState.insertionIndex === index + 1),
    "[&>td]:border-t-2 [&>td]:border-t-primary": dragState?.insertionIndex === index,
    "[&>td]:border-b-2 [&>td]:border-b-primary": dragState?.insertionIndex === index + 1,
  };
}

function columnMatchesSearch(column: EditableStructureColumn): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  if (!query) return false;
  return [column.name, column.comment].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(query),
  );
}

function columnFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = columnSearchText.value.trim().toLowerCase();
  return (
    !!query &&
    String(value ?? "")
      .toLowerCase()
      .includes(query)
  );
}

function columnSearchFieldClass(column: EditableStructureColumn, value: string | null | undefined) {
  const matches = columnFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedColumnId.value === column.id,
  };
}

function focusColumnSearch() {
  activeTab.value = "columns";
  void nextTick(() => {
    const input = columnSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function scrollToColumnSearchMatch(direction: 1 | -1 = 1) {
  const query = columnSearchText.value.trim();
  if (!query) {
    focusColumnSearch();
    return;
  }
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-column-row-index]") ?? []);
  const matches = columns.value.map((column, index) => ({ column, index })).filter(({ column }) => columnMatchesSearch(column));
  if (!matches.length) return;
  const currentIndex = highlightedColumnId.value ? matches.findIndex(({ column }) => column.id === highlightedColumnId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedColumnId.value = nextMatch.column.id;
  rows[nextMatch.index]?.scrollIntoView({ block: "center", inline: "nearest" });
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  columnHighlightTimer = window.setTimeout(() => {
    highlightedColumnId.value = null;
  }, 1800);
}

function onColumnSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToColumnSearchMatch(event.shiftKey ? -1 : 1);
}

function indexMatchesSearch(index: EditableStructureIndex, searchQuery = indexSearchText.value.trim().toLowerCase()): boolean {
  if (!searchQuery) return false;
  return [index.name, toColumnNames(index.columns), index.includedColumns.join(", "), index.indexType, index.filter, index.comment].some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(searchQuery),
  );
}

function indexFieldMatchesSearch(value: string | null | undefined): boolean {
  const query = indexSearchText.value.trim().toLowerCase();
  return (
    !!query &&
    String(value ?? "")
      .toLowerCase()
      .includes(query)
  );
}

function indexRowClass(index: EditableStructureIndex) {
  const isSearchMatch = filteredIndexRowIds.value.has(index.id);
  return {
    "bg-destructive/5 opacity-60": index.markedForDrop,
    "structure-column-search-match": isSearchMatch,
    "structure-column-search-current": highlightedIndexId.value === index.id,
  };
}

function indexSearchFieldClass(index: EditableStructureIndex, value: string | null | undefined) {
  const matches = indexFieldMatchesSearch(value);
  return {
    "!border-primary/60 !bg-primary/10": matches,
    "!border-primary !ring-2 !ring-primary/30": matches && highlightedIndexId.value === index.id,
  };
}

function focusIndexSearch() {
  activeTab.value = "indexes";
  void nextTick(() => {
    const input = indexSearchInputRef.value?.$el as HTMLInputElement | undefined;
    input?.focus();
    input?.select();
  });
}

function scrollToIndexSearchMatch(direction: 1 | -1 = 1) {
  const query = indexSearchText.value.trim();
  if (!query) {
    focusIndexSearch();
    return;
  }
  const rows = Array.from(rootRef.value?.querySelectorAll<HTMLElement>("[data-index-row-index]") ?? []);
  const matches = indexes.value.map((index, rowIndex) => ({ index, rowIndex })).filter(({ index }) => indexMatchesSearch(index));
  if (!matches.length) return;
  const currentIndex = highlightedIndexId.value ? matches.findIndex(({ index }) => index.id === highlightedIndexId.value) : -1;
  const nextMatch = matches[(currentIndex + direction + matches.length) % matches.length] ?? matches[0];
  highlightedIndexId.value = nextMatch.index.id;
  rows[nextMatch.rowIndex]?.scrollIntoView({ block: "center", inline: "nearest" });
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  indexHighlightTimer = window.setTimeout(() => {
    highlightedIndexId.value = null;
  }, 1800);
}

function onIndexSearchKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  scrollToIndexSearchMatch(event.shiftKey ? -1 : 1);
}

function columnDragInsertionIndex(index: number, event: DragEvent): number {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return index;
  const rect = target.getBoundingClientRect();
  return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
}

function toggleDropColumn(column: EditableStructureColumn) {
  if (!canDropColumn(column)) return;
  column.markedForDrop = !column.markedForDrop;
  if (column.markedForDrop) {
    // A dropped row is no longer selectable: keep the multi-selection consistent.
    if (selectedColumnIds.value.has(column.id)) {
      const next = new Set(selectedColumnIds.value);
      next.delete(column.id);
      selectedColumnIds.value = next;
    }
    if (selectedColumnId.value === column.id) selectedColumnId.value = null;
    if (columnSelectionAnchorId.value === column.id) columnSelectionAnchorId.value = null;
  }
}

/** Selected columns in visible row order (dropped rows are not selectable). */
function selectedColumnsInOrder(): EditableStructureColumn[] {
  const ids = selectedColumnIds.value;
  if (!ids.size) return [];
  return columns.value.filter((column) => ids.has(column.id) && !column.markedForDrop);
}

/**
 * Batch copy: clone each source row and insert every copy right after its own
 * source, preserving relative order (same behavior as the row copy button,
 * applied to each target).
 */
async function copyColumnRows(targets: EditableStructureColumn[]) {
  if (!canAddColumn.value) return;
  const sources = targets.filter((column) => !column.markedForDrop);
  if (!sources.length) return;
  const copiedIds: string[] = [];
  // Insert from bottom to top so earlier inserts do not shift later source indexes.
  for (let index = sources.length - 1; index >= 0; index--) {
    const sourceIndex = columns.value.findIndex((item) => item.id === sources[index].id);
    if (sourceIndex < 0) continue;
    const copiedColumn = cloneColumnDraftAsNew(sources[index], uuid);
    columns.value.splice(sourceIndex + 1, 0, copiedColumn);
    copiedIds.unshift(copiedColumn.id);
  }
  const lastCopiedId = copiedIds[copiedIds.length - 1];
  if (!lastCopiedId) return;
  setColumnSelection(copiedIds, lastCopiedId, lastCopiedId);
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder(false);
  await focusColumnNameInput(lastCopiedId);
}

/** Batch drop: new rows are removed outright, existing rows are marked for drop. */
function dropOrRemoveColumns(targets: EditableStructureColumn[]) {
  for (const column of [...targets]) {
    if (column.original) {
      if (!column.markedForDrop) toggleDropColumn(column);
    } else {
      removeNewColumn(column);
    }
  }
}

/**
 * Context menu for a column row. When the right-clicked row is part of the
 * multi-selection the actions apply to the whole selection; otherwise they
 * apply to that row only (same convention as the object browser).
 */
function columnContextMenuItems(column: EditableStructureColumn): ContextMenuItem[] {
  if (column.markedForDrop) {
    return [{ label: t("structureEditor.restore"), icon: RefreshCw, disabled: !canDropColumn(column), action: () => toggleDropColumn(column) }];
  }
  const isBatchContext = selectedColumnIds.value.has(column.id) && selectedColumnIds.value.size > 1;
  const targets = isBatchContext ? selectedColumnsInOrder() : [column];
  const count = targets.length;
  const allDroppable = targets.every((item) => !item.original || canDropColumn(item));
  return [
    {
      label: isBatchContext ? t("structureEditor.copySelectedColumns", { count }) : t("structureEditor.copyColumn"),
      icon: Copy,
      disabled: !canAddColumn.value,
      action: () => void copyColumnRows(targets),
    },
    {
      label: isBatchContext ? t("structureEditor.dropSelectedColumns", { count }) : column.original ? t("structureEditor.drop") : t("structureEditor.remove"),
      icon: Trash2,
      variant: "destructive",
      disabled: !allDroppable,
      action: () => dropOrRemoveColumns(targets),
    },
  ];
}

function isColumnNameDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.renameColumn);
}

function isColumnTypeDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterType);
}

function isColumnLengthDisabled(column: EditableStructureColumn): boolean {
  if (isColumnTypeDisabled(column)) {
    return true;
  }
  const baseType = dataTypeBaseInputValue(databaseType.value, column.dataType).trim().toLowerCase();
  return isDataTypeLengthDisabled(databaseType.value, baseType);
}

function columnLengthUnitOptions(column: EditableStructureColumn) {
  return getDataTypeLengthUnitOptions(databaseType.value, column.dataType);
}

function isColumnLengthUnitDisabled(column: EditableStructureColumn): boolean {
  return isColumnLengthDisabled(column) || !dataTypeLengthInputValue(databaseType.value, column.dataType).trim();
}

function isColumnNullableDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || column.isPrimaryKey || (!!column.original && !structureCapabilities.value.alterNullability);
}

function isColumnDefaultDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterDefault);
}

function isColumnCommentDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || !structureCapabilities.value.comment;
}

function isColumnCharsetDisabled(column: EditableStructureColumn): boolean {
  if (column.markedForDrop) return true;
  if (!showCharacterSet.value) return true;
  return !isMysqlCharacterDataType(column.dataType);
}

function isPrimaryKeyDisabled(column: EditableStructureColumn): boolean {
  if (column.markedForDrop) return true;
  if (isCreateMode.value || structureCapabilities.value.alterPrimaryKey) return false;
  if (!structureCapabilities.value.addPrimaryKey) return true;
  return columns.value.some((candidate) => candidate.original?.is_primary_key);
}

function canDropColumn(column: EditableStructureColumn): boolean {
  return !!column.original && !column.isPrimaryKey && !isProtectedManticoreIdColumn(databaseType.value, column.original.name) && structureCapabilities.value.dropColumn;
}

function isManticoreColumnPropertyDisabled(column: EditableStructureColumn): boolean {
  return !canEditManticoreColumnProperties(databaseType.value, !!column.original) || column.markedForDrop;
}

function addIndex() {
  if (!structureCapabilities.value.createIndex || indexesLoading.value) return;
  activeTab.value = "indexes";
  indexes.value.push({
    id: `new:${uuid()}`,
    name: "",
    columns: [],
    nameEdited: false,
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    concurrently: false,
    markedForDrop: false,
  });
  void nextTick(() => {
    const indexRows = rootRef.value?.querySelectorAll<HTMLElement>('[data-new-index-row="true"]');
    const row = indexRows?.[indexRows.length - 1];
    const input = row?.querySelector<HTMLInputElement>("[data-index-name-input]");
    row?.scrollIntoView({ block: "nearest" });
    input?.focus();
    input?.select();
  });
}

function structureIndexTableName(): string {
  return (isCreateMode.value ? newTableName.value : props.tableName).trim();
}

function existingIndexNamesForDraft(index: EditableStructureIndex): string[] {
  return indexes.value.filter((item) => item.id !== index.id && !item.markedForDrop).map((item) => item.name);
}

function generatedIndexNameForDraft(index: EditableStructureIndex, columnsForName = index.columns): string {
  const name = generateUniqueIndexName(structureIndexTableName(), columnsForName, existingIndexNamesForDraft(index));
  // GaussDB M-mode expects lowercase index names (MySQL-compatible).
  return connection.value?.driver_profile?.toLowerCase() === "gaussdb-m" ? name.toLowerCase() : name;
}

function refreshAutoIndexName(index: EditableStructureIndex, previousColumns = index.columns) {
  if (index.original || index.nameEdited) return;
  const isGaussdbM = connection.value?.driver_profile?.toLowerCase() === "gaussdb-m";
  const previousName = generateIndexName(structureIndexTableName(), previousColumns);
  const previousUniqueName = generateUniqueIndexName(structureIndexTableName(), previousColumns, existingIndexNamesForDraft(index));
  const currentName = index.name.trim();
  if (currentName) {
    if (isGaussdbM) {
      if (currentName.toLowerCase() !== previousName.toLowerCase() && currentName.toLowerCase() !== previousUniqueName.toLowerCase()) return;
    } else if (currentName !== previousName && currentName !== previousUniqueName) {
      return;
    }
  }
  index.name = generatedIndexNameForDraft(index);
}

function onIndexNameInput(index: EditableStructureIndex, value: string | number) {
  index.name = String(value ?? "");
  index.nameEdited = true;
}

const availableColumnNames = computed(() =>
  columns.value
    .filter((c) => !c.markedForDrop)
    .map((c) => c.name)
    .filter(Boolean),
);

const colSearch = ref("");

function filteredIndexColumnNames(selectedColumns: readonly string[]): string[] {
  return filterStructureIndexColumnOptions(availableColumnNames.value, selectedColumns, colSearch.value);
}

function toggleIndexColumn(index: EditableStructureIndex, col: string) {
  const previousColumns = [...index.columns];
  const i = index.columns.indexOf(col);
  if (i >= 0) index.columns.splice(i, 1);
  else index.columns.push(col);
  refreshAutoIndexName(index, previousColumns);
}

function toggleIncludedColumn(index: EditableStructureIndex, col: string) {
  if (!structureCapabilities.value.indexInclude) return;
  const i = index.includedColumns.indexOf(col);
  if (i >= 0) index.includedColumns.splice(i, 1);
  else index.includedColumns.push(col);
}

function removeNewIndex(index: EditableStructureIndex) {
  indexes.value = indexes.value.filter((item) => item.id !== index.id);
}

function toggleDropIndex(index: EditableStructureIndex) {
  if (!canDropIndex(index)) return;
  index.markedForDrop = !index.markedForDrop;
}

function canEditIndexDraft(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  if (index.markedForDrop || index.isPrimary) return false;
  if (!index.original) return structureCapabilities.value.createIndex;
  return structureCapabilities.value.rebuildIndex && structureCapabilities.value.createIndex && structureCapabilities.value.dropIndex;
}

/**
 * Whether the Concurrent checkbox is actionable for this index draft.
 *
 * Plan A scope guard (PR #6361 review): concurrent builds apply only to newly
 * created indexes on non-partitioned tables. Editing an existing index would
 * require a `DROP INDEX CONCURRENTLY` + `CREATE INDEX CONCURRENTLY` replace
 * flow (not implemented yet), PostgreSQL rejects `CREATE INDEX CONCURRENTLY`
 * on partitioned parents, and an unverifiable partition status fails closed —
 * all of those disable the checkbox here. The core SQL builder enforces the
 * same scope as a hard error, so this is only the first layer.
 */
function concurrentIndexAvailability(index: EditableStructureIndex): ConcurrentIndexAvailability {
  if (indexesLoading.value) return { enabled: false, reason: "unknown" };
  return concurrentIndexAvailabilityState(index);
}

/** Same decision as [`concurrentIndexAvailability`], independent of the
 * indexes-loading flag — state-normalization runs while metadata may still be
 * in flight, and must decide on the availability inputs alone. */
function concurrentIndexAvailabilityState(index: EditableStructureIndex): ConcurrentIndexAvailability {
  return getConcurrentIndexAvailability({
    hasOriginal: !!index.original,
    isPrimary: index.isPrimary,
    markedForDrop: index.markedForDrop,
    isPartitionedParent: isPartitionedParent.value,
    partitionStatusKnown: partitionStatusKnown.value,
    supportsIndexConcurrent: structureCapabilities.value.indexConcurrent,
    supportsCreateIndex: structureCapabilities.value.createIndex,
  });
}

/**
 * Layer A — invalidate `concurrently: true` drafts whenever Concurrent becomes
 * unavailable. Transiently unknown partition status preserves the flag so a
 * later successful probe can recover the user's intent; definitive unsupported
 * states clear it. In both cases, empty pending SQL and keep Save blocked until
 * availability is verified again.
 */
function normalizeConcurrentIndexDraftsForCurrentAvailability(): boolean {
  // Engines that cannot express Concurrent (non-PostgreSQL dialects) ignore a
  // stale flag in the core builder and render no checkbox; blocking the save
  // there would only trap a draft carried over from a PostgreSQL session.
  if (!structureCapabilities.value.indexConcurrent) return false;
  const { indexes: normalized, invalidatedIds } = normalizeUnsupportedConcurrentIndexes(indexes.value, concurrentIndexAvailabilityState);
  if (invalidatedIds.length === 0) return false;
  indexes.value = normalized;
  concurrentAvailabilityInvalidated.value = true;
  pendingStatements.value = [];
  warnings.value = [t("structureEditor.concurrentUnavailableBlocksSave")];
  sqlPreviewLoading.value = false;
  sqlPreviewPending.value = false;
  errorMessage.value = t("structureEditor.concurrentUnavailableBlocksSave");
  return true;
}

/** Layer B — a `concurrently: true` draft whose availability is no longer
 * enabled must never reach the SQL builder or the execute path. Returns the
 * blocking message, or null when the request stays legal. */
function concurrentIndexBlockingWarning(): string | null {
  // Non-concurrent-capable engines cannot express the request in SQL; the core
  // builder ignores the flag, so there is no stale-concurrent hazard to block.
  if (!structureCapabilities.value.indexConcurrent) return null;
  const stale = indexes.value.find((index) => index.concurrently && !concurrentIndexAvailability(index).enabled);
  return stale ? t("structureEditor.concurrentUnavailableBlocksSave") : null;
}

function canEditIndexConcurrent(index: EditableStructureIndex): boolean {
  return concurrentIndexAvailability(index).enabled;
}

function concurrentIndexCellTitle(index: EditableStructureIndex): string {
  switch (concurrentIndexAvailability(index).reason) {
    case "existing":
      return t("structureEditor.concurrentExistingIndexTooltip");
    case "partitioned":
      return t("structureEditor.concurrentPartitionedTooltip");
    case "unknown":
      return t("structureEditor.concurrentUnavailableTooltip");
    default:
      return t("structureEditor.concurrentTooltip");
  }
}

function canEditIndexFilter(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexFilter;
}

function canEditIndexComment(index: EditableStructureIndex): boolean {
  return canEditIndexDraft(index) && structureCapabilities.value.indexComment;
}

function canDropIndex(index: EditableStructureIndex): boolean {
  if (indexesLoading.value) return false;
  return !!index.original && !index.isPrimary && structureCapabilities.value.dropIndex;
}

const canEditForeignKeys = computed(() => structureCapabilities.value.foreignKey);
const canEditTriggers = computed(() => structureDialect.value === "mysql" || structureDialect.value === "oracle");
const isOracleTriggerEditor = computed(() => structureDialect.value === "oracle");

function generatedForeignKeyName(column = ""): string {
  const table = structureIndexTableName() || "table";
  const suffix = column || "column";
  const base = `fk_${table}_${suffix}`
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const taken = new Set(foreignKeys.value.map((item) => item.name.trim().toLowerCase()).filter(Boolean));
  if (!taken.has(base.toLowerCase())) return base;
  for (let counter = 2; counter < 10_000; counter++) {
    const candidate = `${base}_${counter}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return base;
}

function addForeignKey() {
  if (!canEditForeignKeys.value || foreignKeysLoading.value) return;
  activeTab.value = "foreignKeys";
  foreignKeys.value.push({
    id: `new:${uuid()}`,
    name: generatedForeignKeyName(),
    column: "",
    refSchema: "",
    refTable: "",
    refColumn: "",
    onUpdate: "",
    onDelete: "",
    markedForDrop: false,
  });
}

function removeNewForeignKey(foreignKey: EditableStructureForeignKey) {
  foreignKeys.value = foreignKeys.value.filter((item) => item.id !== foreignKey.id);
}

function toggleDropForeignKey(foreignKey: EditableStructureForeignKey) {
  if (foreignKeysLoading.value || !foreignKey.original) return;
  foreignKey.markedForDrop = !foreignKey.markedForDrop;
}

function canEditForeignKeyDraft(foreignKey: EditableStructureForeignKey): boolean {
  return !foreignKeysLoading.value && canEditForeignKeys.value && !foreignKey.markedForDrop;
}

function addTrigger() {
  if (!canEditTriggers.value || triggersLoading.value) return;
  activeTab.value = "triggers";
  triggers.value.push({
    id: `new:${uuid()}`,
    name: "",
    timing: isOracleTriggerEditor.value ? "BEFORE EACH ROW" : "BEFORE",
    event: "INSERT",
    statement: isOracleTriggerEditor.value ? "BEGIN\n  NULL;\nEND" : "BEGIN\n  \nEND",
    markedForDrop: false,
  });
}

function removeNewTrigger(trigger: EditableStructureTrigger) {
  triggers.value = triggers.value.filter((item) => item.id !== trigger.id);
}

function toggleDropTrigger(trigger: EditableStructureTrigger) {
  if (triggersLoading.value || !trigger.original) return;
  trigger.markedForDrop = !trigger.markedForDrop;
}

function canEditTriggerDraft(trigger: EditableStructureTrigger): boolean {
  return !triggersLoading.value && canEditTriggers.value && !trigger.markedForDrop && canEditStructuredTriggerDraft(databaseType.value, trigger);
}

function primarySqlOperation(sql: string): string {
  const statement = sql
    .split(";")
    .map((part) => part.trim())
    .find(Boolean);
  return statement?.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "SQL";
}

async function recordStructureHistory(sql: string, start: number, success: boolean, result?: { affected_rows?: number }, error?: string) {
  const connection = store.getConfig(props.connectionId);
  try {
    await historyStore.add({
      connection_id: props.connectionId,
      connection_name: connection?.name || "",
      database: props.database,
      sql,
      execution_time_ms: Date.now() - start,
      success,
      error,
      activity_kind: "schema_change",
      operation: hasSqliteTypeChange.value ? "ALTER TABLE" : primarySqlOperation(sql),
      target: isCreateMode.value ? newTableName.value.trim() : props.tableName,
      affected_rows: success ? result?.affected_rows : undefined,
    });
  } catch (e) {
    console.warn("[DBX][structure-history:save-failed]", e);
  }
}

async function copyPreviewSql() {
  if (sqlPreviewPending.value || sqlPreviewLoading.value || !previewSqlText.value.trim()) return;
  try {
    await copyToClipboard(previewSqlText.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyDdlContent() {
  if (!ddlContent.value.trim()) return;
  try {
    await copyToClipboard(ddlContent.value);
    toast(t("contextMenu.ddlCopied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function toggleSqlPreviewCollapsed() {
  sqlPreviewCollapsed.value = !sqlPreviewCollapsed.value;
  safeLocalStorageSet(STRUCTURE_SQL_PREVIEW_COLLAPSED_STORAGE_KEY, String(sqlPreviewCollapsed.value));
}

async function applyChanges() {
  if (!canApply.value || !props.connectionId || !props.database) return false;
  // Layer B runtime guard: a stale `concurrently: true` whose availability is
  // no longer enabled must never be executed — reject the save with an
  // explicit error even if normalization was skipped (race / non-UI caller).
  const blockingConcurrentWarning = concurrentIndexBlockingWarning() ?? (concurrentAvailabilityInvalidated.value ? t("structureEditor.concurrentUnavailableBlocksSave") : null);
  if (blockingConcurrentWarning) {
    errorMessage.value = blockingConcurrentWarning;
    return false;
  }
  const sql = previewSqlText.value;
  const connection = store.getConfig(props.connectionId);
  const productionContext = productionContextForDatabase(connection, props.database);
  if (productionContext.active) {
    const confirmed = await productionSafetyStore.requestConfirmation({
      sql,
      connectionName: connection?.name,
      database: props.database,
      productionDatabases: productionContext.databases,
      source: t("production.sourceStructure"),
    });
    if (!confirmed) return false;
  }
  saving.value = true;
  errorMessage.value = "";
  const refreshScope = captureStructureRefreshScope();
  // Plan A guard: concurrent builds only run with a long-enough query timeout
  // (a cancelled build leaves an INVALID index behind), and are blocked
  // up-front when a same-name INVALID index already exists.
  const hasConcurrentIndexBuild = pendingStatements.value.some((statement) => statement.includes("CONCURRENTLY"));
  if (hasConcurrentIndexBuild && !isCreateMode.value && databaseType.value === "postgres" && props.tableName) {
    const concurrentIndexNames = concurrentIndexNamesInStatements(pendingStatements.value);
    if (concurrentIndexNames.length > 0) {
      try {
        const invalidIndexes = await api.listInvalidIndexes(props.connectionId, props.database, metadataSchema.value, props.tableName);
        const blocked = concurrentIndexNames.filter((name) => invalidIndexes.includes(name));
        if (blocked.length > 0) {
          errorMessage.value = t("structureEditor.invalidIndexBlocksSave", { indexNames: blocked.join(", ") });
          saving.value = false;
          return false;
        }
      } catch {
        // Metadata probe failure must not block the save; the failure-time
        // hint below still surfaces leftovers if the build errors out.
      }
    }
  }
  const characterLengthUnitsAfterSave = new Map<string, string>();
  if (supportsCharacterLengthUnits.value) {
    for (const column of columns.value) {
      if (!column.markedForDrop && dataTypeLengthUnitValue(databaseType.value, column.dataType)) {
        characterLengthUnitsAfterSave.set(column.name.trim().toLowerCase(), column.dataType);
      }
    }
  }
  const startedAt = Date.now();
  // Concurrent batches get at least the dedicated 30-minute floor while
  // preserving an unlimited setting (0) and any larger configured timeout;
  // non-concurrent batches keep the configured timeout unchanged.
  const configuredTimeoutSecs = queryTimeoutSecsForConnection(connection, settingsStore.editorSettings.globalQueryTimeoutSecs);
  const executionTimeoutSecs = queryTimeoutSecsForConcurrentIndex(configuredTimeoutSecs, hasConcurrentIndexBuild);
  try {
    const result = hasSqliteTypeChange.value
      ? await api.applySqliteTableStructureChange(props.connectionId, props.database, structureChangeOptions(), sqliteSchemaRevision.value!)
      : await api.executeBatch(props.connectionId, props.database, pendingStatements.value, props.schema, executionTimeoutSecs);
    await recordStructureHistory(sql, startedAt, true, result);
    if (!isCreateMode.value && props.tableName) {
      const metadataMatch = { connectionId: props.connectionId, database: props.database, schema: metadataSchema.value, tableName: props.tableName };
      invalidateTableMetadataCache(metadataMatch);
      await invalidateObjectMetadataCache(metadataMatch);
      await invalidateObjectDdl(ddlRequest());
      loadedMetadataFacets.clear();
    }
    toast(t("structureEditor.saved"), 2500);
    sqlPreviewPending.value = false;
    sqlPreviewLoading.value = false;
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    ddlFetched.value = false;
    ddlContent.value = "";
    if (isCreateMode.value) {
      clearDraft();
      emit("saved", tableComment.value !== originalTableComment.value);
      emit("close");
    } else {
      // Refresh persisted keys after successful renames/additions before metadata reloads.
      persistLocalColumnOrder(false);
      saving.value = false;
      postSaveRefreshing.value = true;
      skipNextRefreshVersion = true;
      emit("saved", tableComment.value !== originalTableComment.value);
      await refreshStructureAfterSave(refreshScope, characterLengthUnitsAfterSave);
    }
    return true;
  } catch (e: any) {
    const rawMessage = e?.message || String(e);
    // A cancelled/errored concurrent build leaves a same-name INVALID index
    // behind; surface that so retries are not silently doomed.
    const invalidIndexHint = hasConcurrentIndexBuild && /already exists/i.test(rawMessage) ? `\n\n${t("structureEditor.invalidIndexRetryHint")}` : "";
    errorMessage.value = `${rawMessage}${invalidIndexHint}`;
    await recordStructureHistory(sql, startedAt, false, undefined, errorMessage.value);
    return false;
  } finally {
    saving.value = false;
  }
}

defineExpose({ applyChanges });

function addItemForActiveTab(): boolean {
  if (activeTab.value === "columns" && canAddColumn.value) {
    void addColumn();
    return true;
  }
  if (activeTab.value === "indexes" && structureCapabilities.value.createIndex) {
    addIndex();
    return true;
  }
  if (activeTab.value === "foreignKeys" && canEditForeignKeys.value) {
    addForeignKey();
    return true;
  }
  if (activeTab.value === "triggers" && canEditTriggers.value && !triggersLoading.value) {
    addTrigger();
    return true;
  }
  return false;
}

function focusedEditableColumn(eventTarget: EventTarget | null): EditableStructureColumn | undefined {
  if (!(eventTarget instanceof HTMLInputElement || eventTarget instanceof HTMLTextAreaElement) || eventTarget.disabled || eventTarget.readOnly) return;
  const row = eventTarget.closest<HTMLElement>("[data-column-id]");
  const columnId = row?.dataset.columnId;
  if (!columnId) return;
  return columns.value.find((column) => column.id === columnId && !column.markedForDrop);
}

function isShiftEnterShortcut(event: KeyboardEvent): boolean {
  return !event.isComposing && event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
}

function isPlainModDeleteShortcut(event: KeyboardEvent): boolean {
  if (isPlainModShortcut(event, "delete")) return true;
  if (!event.metaKey || event.ctrlKey || !isPlainModShortcut(event, "backspace")) return false;
  // ⌘⌫ is macOS "delete to beginning of line" while editing text; only treat it as a
  // field delete when the focused input is empty so normal text editing keeps working.
  const target = event.target;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value === "" : true;
}

function onStructureEditorKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const focusedColumn = activeTab.value === "columns" ? focusedEditableColumn(event.target) : undefined;
  if (focusedColumn && isShiftEnterShortcut(event) && canAddColumn.value) {
    event.preventDefault();
    event.stopPropagation();
    void addColumn(focusedColumn);
    return;
  }
  if (focusedColumn && isPlainModShortcut(event, "d") && canAddColumn.value) {
    event.preventDefault();
    event.stopPropagation();
    void copyColumn(focusedColumn);
    return;
  }
  if (focusedColumn && isPlainModDeleteShortcut(event) && (!focusedColumn.original || canDropColumn(focusedColumn))) {
    event.preventDefault();
    event.stopPropagation();
    if (focusedColumn.original) toggleDropColumn(focusedColumn);
    else removeNewColumn(focusedColumn);
    return;
  }
  if (isPlainModShortcut(event, "f")) {
    event.preventDefault();
    event.stopPropagation();
    if (activeTab.value === "columns") focusColumnSearch();
    else if (activeTab.value === "ddl") ddlSearchPanelRef.value?.openSearch();
    return;
  }
  if (isPlainModShortcut(event, "s")) {
    event.preventDefault();
    event.stopPropagation();
    void applyChanges();
    return;
  }
  if (isPlainModShortcut(event, "n")) {
    event.preventDefault();
    event.stopPropagation();
    addItemForActiveTab();
  }
}

function registerStructureEditorShortcuts() {
  if (keydownListenerRegistered) return;
  keydownListenerRegistered = true;
  window.addEventListener("keydown", onStructureEditorKeydown);
  document.addEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
  document.addEventListener("mouseup", onColumnSelectionPointerUp);
}

function unregisterStructureEditorShortcuts() {
  if (!keydownListenerRegistered) return;
  keydownListenerRegistered = false;
  window.removeEventListener("keydown", onStructureEditorKeydown);
  document.removeEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
  document.removeEventListener("mouseup", onColumnSelectionPointerUp);
}

onMounted(() => {
  resetState();
  applyInitialStructureTab();
  applyInitialStructureTarget();
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (props.draft?.initialized) {
    restoreDraft(props.draft);
    // A restored draft owns its saved tab unless navigation explicitly requested another one.
    applyInitialStructureTab(false);
    applyInitialStructureTarget();
  }
  structureEditorReady = true;
  observeStructureHorizontalScroller();
  void loadTableOwner(false, props.draft?.tableOwner !== undefined);
  void loadTableOwnerRoles();
  void loadMysqlTableEngine(props.draft?.mysqlTableEngine !== undefined);
  if (props.draft?.initialized) {
    void hydrateRestoredDraftFromDatabase().then(() => {
      applyInitialStructureTarget();
      void loadMysqlAutoIncrementCounter(true);
      void loadActiveTableStructureMetadataIfNeeded();
    });
  } else if (isCreateMode.value) {
    markDraftHydratedAndSync();
  } else if (activeTab.value === "ddl") {
    void fetchDdl();
  } else {
    void loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true }).then(() => applyInitialStructureTarget());
  }
});

onActivated(() => {
  registerStructureEditorShortcuts();
  observeStructureHorizontalScroller();
  void loadDynamicDataTypeOptions();
  if (supportsTableOwner.value && !loadedMetadataFacets.has("owner")) void loadTableOwner(false, props.draft?.tableOwner !== undefined);
  if (supportsTableOwner.value && !tableOwnerRolesLoading.value && tableOwnerRoles.value.length === 0 && !tableOwnerRolesLoadError.value) void loadTableOwnerRoles();
  if (supportsMysqlEngine.value && !mysqlTableEngineLoading.value && mysqlTableEngineOptions.value.length === 0 && !mysqlTableEngineLoadError.value) {
    void loadMysqlTableEngine(props.draft?.mysqlTableEngine !== undefined);
  }
  if (props.draft?.initialized && !draftHydrated) {
    restoreDraft(props.draft);
    applyInitialStructureTarget();
    void hydrateRestoredDraftFromDatabase().then(() => {
      applyInitialStructureTarget();
      void loadMysqlAutoIncrementCounter(true);
      void loadActiveTableStructureMetadataIfNeeded();
    });
  }
  restoreStructureScrollPosition();
  if (activeTab.value === "ddl") scheduleDdlEditorInit();
});
onDeactivated(() => {
  unregisterStructureEditorShortcuts();
  structureHorizontalScrollbarObserverGeneration += 1;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  structureHorizontalScrollbarResizeObserver = null;
  stopStructureHorizontalScrollbarDrag();
  destroyDdlEditor();
});
onBeforeUnmount(() => {
  clearCopySourceTableSearchTimer();
  stopColumnDragTracking();
  stopStructureHorizontalScrollbarDrag();
  structureHorizontalScrollbarObserverGeneration += 1;
  structureHorizontalScrollbarResizeObserver?.disconnect();
  unregisterStructureEditorShortcuts();
  destroyDdlEditor();
  clearSqlPreviewState();
  if (columnHighlightTimer) window.clearTimeout(columnHighlightTimer);
  if (indexHighlightTimer) window.clearTimeout(indexHighlightTimer);
  if (structureScrollFrame) window.cancelAnimationFrame(structureScrollFrame);
  persistStructureDensity();
});

function localFirstStructureMetadataTab(capabilities = tableMetadataCapabilities.value) {
  return firstStructureMetadataTab(capabilities, isCreateMode.value);
}

function localIsStructureMetadataTabSupported(tab: TableInfoTab, capabilities = tableMetadataCapabilities.value) {
  return isStructureMetadataTabSupported(tab, capabilities, isCreateMode.value);
}

function resolveStructureMetadataTab(tab: TableInfoTab | undefined, capabilities = tableMetadataCapabilities.value): TableInfoTab {
  if (tab && localIsStructureMetadataTabSupported(tab, capabilities)) return tab;
  return localFirstStructureMetadataTab(capabilities);
}

function applyInitialStructureTab(useDefault = true) {
  if (props.initialTab) {
    activeTab.value = resolveStructureMetadataTab(props.initialTab);
  } else if (useDefault) {
    activeTab.value = resolveStructureMetadataTab(undefined);
  }
}

function initialTargetKey(target: TableStructureEditorTarget): string {
  return `${props.initialTabRequestId ?? 0}:${target.kind}:${target.name}`;
}

function applyInitialStructureTarget() {
  const target = props.initialTarget;
  const targetName = target?.name.trim();
  if (!target || !targetName) return;

  const key = initialTargetKey(target);
  if (appliedInitialTargetSearchKey !== key) {
    if (target.kind === "column") {
      activeTab.value = resolveStructureMetadataTab("columns");
      columnSearchText.value = targetName;
      highlightedColumnId.value = null;
    } else {
      activeTab.value = resolveStructureMetadataTab("indexes");
      indexSearchText.value = targetName;
      highlightedIndexId.value = null;
    }
    appliedInitialTargetSearchKey = key;
  }

  if (appliedInitialTargetScrollKey === key) return;
  const hasMatch = target.kind === "column" ? columns.value.some((column) => columnMatchesSearch(column)) : indexes.value.some((index) => indexMatchesSearch(index));
  if (!hasMatch) return;
  appliedInitialTargetScrollKey = key;
  void nextTick(() => {
    if (target.kind === "column") {
      scrollToColumnSearchMatch(1);
    } else {
      scrollToIndexSearchMatch(1);
    }
  });
}

watch(tableMetadataCapabilities, (capabilities) => {
  if (!localIsStructureMetadataTabSupported(activeTab.value, capabilities)) activeTab.value = localFirstStructureMetadataTab(capabilities);
});

watch(structureCapabilities, () => {
  // Capability loss (e.g. PostgreSQL < 11 without concurrent index support)
  // invalidates any selected Concurrent flag the same way a probe failure
  // does; the normalization is idempotent and no-ops while availability stays
  // enabled.
  normalizeConcurrentIndexDraftsForCurrentAvailability();
});

watch([() => props.initialTab, () => props.initialTabRequestId, () => props.initialTarget], () => {
  if (props.initialTab) applyInitialStructureTab();
  applyInitialStructureTarget();
});

watch([columns, indexes], () => {
  applyInitialStructureTarget();
});

watch([() => props.connectionId, () => props.database, databaseType], () => {
  void loadDynamicDataTypeOptions();
});

watch(
  [
    isCreateMode,
    () => props.connectionId,
    () => props.database,
    databaseType,
    () => props.schema,
    () => props.tableName,
    newTableName,
    tableComment,
    mysqlAutoIncrementValue,
    originalMysqlAutoIncrementValue,
    mysqlAutoIncrementLoading,
    mysqlAutoIncrementLoadError,
    mysqlTableEngine,
    originalMysqlTableEngine,
    mysqlTableEngineLoading,
    mysqlTableEngineLoadError,
    tableOwner,
    columns,
    indexes,
    foreignKeys,
    triggers,
  ],
  () => {
    scheduleSqlPreviewRefresh();
    syncDraftToParent();
  },
  { deep: true, immediate: true },
);

watch(activeTab, () => {
  stopStructureHorizontalScrollbarDrag();
  if (activeTab.value !== "ddl") destroyDdlEditor();
  clearColumnSelection();
  highlightedColumnId.value = null;
  highlightedIndexId.value = null;
  restoreStructureScrollPosition();
  syncDraftToParent();
});

watch([activeTab, loading, indexesLoading, visibleColWidths, indexColWidths], observeStructureHorizontalScroller, { deep: true, flush: "post", immediate: true });

watch(
  columns,
  (items) => {
    const existingIds = new Set(items.map((column) => column.id));
    if (selectedColumnId.value && !existingIds.has(selectedColumnId.value)) {
      selectedColumnId.value = null;
    }
    if (columnSelectionAnchorId.value && !existingIds.has(columnSelectionAnchorId.value)) {
      columnSelectionAnchorId.value = null;
    }
    const prunedIds = [...selectedColumnIds.value].filter((id) => existingIds.has(id));
    if (prunedIds.length !== selectedColumnIds.value.size) {
      selectedColumnIds.value = new Set(prunedIds);
    }
  },
  { deep: false },
);

watch(secondaryMetadataLoading, (value) => {
  if (value || !deferredSqlPreviewRefresh) return;
  scheduleSqlPreviewRefresh();
});

watch([() => props.tableName, newTableName], () => {
  for (const index of indexes.value) {
    refreshAutoIndexName(index);
  }
});

watch(refreshVersion, (version, previous) => {
  if (version === previous || !version || isCreateMode.value) return;
  if (skipNextRefreshVersion) {
    skipNextRefreshVersion = false;
    return;
  }
  if (activeTab.value !== "triggers") {
    triggers.value = [];
    triggersLoaded.value = false;
  }
  if (activeTab.value !== "constraints") {
    constraints.value = [];
    constraintsLoaded.value = false;
  }
  void loadStructure(true, visibleTableStructureRefreshScope(activeTab.value));
});

async function loadActiveTableStructureMetadataIfNeeded() {
  if (!structureEditorReady || isCreateMode.value) return;
  if (activeTab.value === "ddl") {
    await fetchDdl();
    return;
  }
  if (loading.value || secondaryMetadataLoading.value) return;
  const scope = withRequiredPostgresPrimaryKeyMetadata(unloadedTableStructureRefreshScope(activeTab.value, loadedMetadataFacets));
  if (!hasTableStructureRefreshWork(scope)) return;
  await loadStructure(true, scope, true, { blockSecondaryMetadata: true, preserveDraft: true });
  applyInitialStructureTarget();
}

watch([activeTab, loading, secondaryMetadataLoading], () => void loadActiveTableStructureMetadataIfNeeded(), { flush: "sync" });

watch([activeTab, loading, ddlLoading, ddlContent], ([tab, structureIsLoading, ddlIsLoading]) => {
  if (tab === "ddl" && !structureIsLoading && !ddlIsLoading) scheduleDdlEditorInit();
});
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="localStructureDensity" :style="structureDensityStyle">
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <Database :class="[structureIconClass, 'text-muted-foreground']" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t("editor.noDatabase") }}</span>
      <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
      <Button v-if="!isCreateMode" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="loading || saving || ddlLoading" @click="reloadStructureFromDatabase">
        <RefreshCw :class="structureIconClass" />
        {{ t("structureEditor.refresh") }}
      </Button>
    </div>

    <div v-if="isCreateMode" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.tableName") }}</label>
      <Input v-model="newTableName" :placeholder="t('contextMenu.duplicateNamePlaceholder')" :class="[structureControlClass, 'max-w-[220px]']" />
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.comment") }}</label>
      <Input v-model="tableComment" :placeholder="t('structureEditor.tableCommentPlaceholder')" :class="[structureControlClass, 'max-w-[320px]']" :disabled="isTableCommentDisabled" />
      <Tooltip v-if="isTableCommentDisabled">
        <TooltipTrigger as-child>
          <Info :class="[structureIconClass, 'shrink-0 text-muted-foreground']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.tableCommentUnsupported") }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="supportsMysqlEngine" class="flex shrink-0 items-center gap-2">
      <label class="shrink-0 font-medium text-muted-foreground">{{ t("structureEditor.mysqlTableEngine") }}</label>
      <SearchableSelect
        v-model="mysqlTableEngine"
        :options="mysqlTableEngineOptions"
        :placeholder="t('structureEditor.mysqlTableEnginePlaceholder')"
        :search-placeholder="t('structureEditor.mysqlTableEngineSearchPlaceholder')"
        :empty-text="t('structureEditor.mysqlTableEngineEmpty')"
        :loading-text="t('common.loading')"
        :loading="mysqlTableEngineLoading"
        :disabled="mysqlTableEngineLoading || !!mysqlTableEngineLoadError || saving"
        :trigger-class="[structureMonoControlClass, 'w-[220px] max-w-[220px]']"
        data-mysql-table-engine-select
      />
      <Loader2 v-if="mysqlTableEngineLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
      <Tooltip v-else-if="mysqlTableEngineLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-destructive']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.mysqlTableEngineLoadFailed", { message: mysqlTableEngineLoadError }) }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="supportsTableOwner" class="flex shrink-0 items-center gap-2">
      <label class="flex shrink-0 items-center gap-1 font-medium text-muted-foreground">
        <UserRound :class="structureIconClass" />
        {{ t("structureEditor.owner") }}
      </label>
      <SearchableSelect
        v-model="tableOwner"
        :options="tableOwnerOptions"
        :placeholder="t('structureEditor.ownerPlaceholder')"
        :search-placeholder="t('structureEditor.ownerSearchPlaceholder')"
        :empty-text="t('structureEditor.ownerRolesEmpty')"
        :loading-text="t('common.loading')"
        :loading="tableOwnerRolesLoading"
        :allow-custom="true"
        :trim-custom="false"
        :disabled="tableOwnerLoading || !!tableOwnerLoadError"
        :trigger-class="[structureMonoControlClass, 'w-[220px] max-w-[220px]']"
        data-owner-select
      />
      <Loader2 v-if="tableOwnerLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
      <Tooltip v-else-if="tableOwnerLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-destructive']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.ownerLoadFailed", { message: tableOwnerLoadError }) }}</TooltipContent>
      </Tooltip>
      <Tooltip v-else-if="tableOwnerRolesLoadError">
        <TooltipTrigger as-child>
          <AlertTriangle :class="[structureIconClass, 'shrink-0 text-amber-500']" />
        </TooltipTrigger>
        <TooltipContent>{{ t("structureEditor.ownerRolesLoadFailed", { message: tableOwnerRolesLoadError }) }}</TooltipContent>
      </Tooltip>
    </div>

    <div v-if="loading" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[length:var(--structure-font-size)] text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("common.loading") }}
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden rounded-md border">
        <Tabs v-model="activeTab" class="flex h-full min-h-0 flex-col">
          <div class="flex shrink-0 items-center justify-between gap-2 border-b px-2 py-[var(--structure-header-py)]">
            <TabsList>
              <TabsTrigger v-if="tableMetadataCapabilities.ddl && !isCreateMode" value="ddl">DDL</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.columns" value="columns">{{ t("structureEditor.columns") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.indexes" value="indexes">{{ t("structureEditor.indexes") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys">{{ t("structureEditor.foreignKeys") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.constraints" value="constraints">{{ t("structureEditor.constraints") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.triggers" value="triggers">{{ t("structureEditor.triggers") }}</TabsTrigger>
            </TabsList>
            <div class="flex shrink-0 items-center gap-1.5">
              <div class="flex items-center gap-1.5">
                <SlidersHorizontal :class="[structureIconClass, 'text-muted-foreground']" />
                <div ref="structureDensityMenuRef" class="relative">
                  <button
                    type="button"
                    class="grid h-[var(--structure-control-height)] min-w-[76px] grid-cols-[1fr_var(--structure-control-height)] items-center rounded-[6px] border bg-background pl-[var(--structure-control-px)] text-[length:var(--structure-font-size)] outline-none hover:bg-muted focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                    :aria-label="t('structureEditor.density')"
                    :aria-expanded="structureDensityMenuOpen"
                    aria-haspopup="listbox"
                    @click="toggleStructureDensityMenu"
                    @keydown="onStructureDensityKeydown"
                  >
                    <span class="min-w-0 text-center truncate">{{ structureDensityOptions.find((option) => option.value === localStructureDensity)?.label }}</span>
                    <span class="flex h-full items-center justify-center">
                      <ChevronDown :class="[structureIconClass, 'shrink-0 opacity-50']" />
                    </span>
                  </button>
                  <div v-if="structureDensityMenuOpen" class="absolute right-0 top-[calc(100%+4px)] z-50 min-w-full rounded-[6px] bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10" role="listbox" :aria-label="t('structureEditor.density')">
                    <button
                      v-for="option in structureDensityOptions"
                      :key="option.value"
                      type="button"
                      class="flex h-7 w-full items-center rounded-[6px] px-1.5 text-left text-[length:var(--structure-font-size)] outline-none hover:bg-accent hover:text-accent-foreground"
                      :class="option.value === localStructureDensity ? 'bg-accent text-accent-foreground' : ''"
                      role="option"
                      :aria-selected="option.value === localStructureDensity"
                      @click="selectStructureDensity(option.value)"
                    >
                      {{ option.label }}
                    </button>
                  </div>
                </div>
              </div>
              <div v-if="activeTab === 'columns'" class="relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input
                  ref="columnSearchInputRef"
                  v-model="columnSearchText"
                  :placeholder="t('structureEditor.searchColumns')"
                  :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']"
                  @keydown="onColumnSearchKeydown"
                />
                <button
                  v-if="columnSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextColumnMatch')"
                  @click="scrollToColumnSearchMatch(1)"
                >
                  {{ columnSearchMatchCount }}
                </button>
              </div>
              <Tooltip v-if="activeTab === 'columns'" :delay-duration="FIELD_SHORTCUT_TOOLTIP_DELAY_MS" data-add-column-shortcut-tooltip>
                <TooltipTrigger as-child>
                  <Button size="sm" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="addColumn">
                    <Plus :class="structureIconClass" />
                    {{ t("structureEditor.addColumn") }}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="font-mono font-medium" data-add-column-shortcut-content>Shift+Enter</TooltipContent>
              </Tooltip>
              <Button v-if="activeTab === 'columns'" size="sm" variant="outline" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="openCopyColumnsDialog">
                <Copy :class="structureIconClass" />
                {{ t("structureEditor.copyColumns") }}
              </Button>
              <Button v-if="isCreateMode && activeTab === 'columns'" size="sm" variant="outline" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="applyColumnTemplate(PRESET_FIELDS_TEMPLATE_ID)">
                <Copy :class="structureIconClass" />
                {{ t("structureEditor.columnTemplates") }}
              </Button>
              <Tooltip v-if="isCreateMode && activeTab === 'columns'">
                <TooltipTrigger as-child>
                  <Button size="sm" variant="ghost" :class="structureToolbarButtonClass" :disabled="!canAddColumn" :aria-label="t('structureEditor.configureColumnTemplates')" @click="emit('openSettings', 'data', 'tableColumnTemplates')">
                    <Settings :class="structureIconClass" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{{ t("structureEditor.configureColumnTemplates") }}</TooltipContent>
              </Tooltip>
              <div v-if="activeTab === 'indexes'" class="relative flex w-40 shrink-0 items-center">
                <Search :class="[structureIconClass, 'pointer-events-none absolute left-2 text-muted-foreground']" />
                <Input ref="indexSearchInputRef" v-model="indexSearchText" :placeholder="t('structureEditor.searchIndexes')" :class="[structureControlClass, 'pl-7 pr-14 text-[length:var(--structure-font-size)] placeholder:text-[length:var(--structure-font-size)]']" @keydown="onIndexSearchKeydown" />
                <button
                  v-if="indexSearchText"
                  type="button"
                  class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded px-1 text-[length:var(--structure-font-size)] text-muted-foreground hover:bg-muted hover:text-foreground"
                  :title="t('structureEditor.nextIndexMatch')"
                  @click="scrollToIndexSearchMatch(1)"
                >
                  {{ indexSearchMatchCount }}
                </button>
              </div>
              <Button v-if="activeTab === 'indexes'" size="sm" :class="structureToolbarButtonClass" :disabled="!structureCapabilities.createIndex || indexesLoading" @click="addIndex">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addIndex") }}
              </Button>
              <Button v-if="activeTab === 'foreignKeys'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditForeignKeys || foreignKeysLoading" @click="addForeignKey">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addForeignKey") }}
              </Button>
              <Button v-if="activeTab === 'triggers'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditTriggers || triggersLoading" @click="addTrigger">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addTrigger") }}
              </Button>
            </div>
          </div>

          <TabsContent ref="columnsScrollerRef" v-if="tableMetadataCapabilities.columns" value="columns" class="structure-table-scroller m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('columns', $event)">
            <table class="structure-edit-grid border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: visibleColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th
                    v-for="(columnLabel, i) in colLabels"
                    :key="columnLabel.key"
                    :class="[structureHeaderCellClass, { 'text-center': columnLabel.key === 'primaryKey' }]"
                    :style="{
                      width: visibleColWidths[i] + 'px',
                      minWidth: visibleColWidths[i] + 'px',
                    }"
                  >
                    <template v-if="columnLabel.key === 'actions'">
                      <div class="flex min-w-0 items-center">
                        <span class="shrink-0 border-r pr-0.5 text-center text-muted-foreground" :style="{ width: columnOrdinalIndicatorWidth + 'px' }">#</span>
                        <span class="min-w-0 flex-1 pl-0.5 text-center">{{ columnLabel.label }}</span>
                      </div>
                    </template>
                    <template v-else>{{ columnLabel.label }}</template>
                    <div v-if="columnLabel.key !== 'actions' && i < colLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="colResizing?.col === columnWidthIndex(i) ? 'bg-primary/30' : ''" @mousedown="onColResize($event, i)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <CustomContextMenu v-for="(column, index) in columns" :key="column.id" :items="() => columnContextMenuItems(column)" v-slot="{ onContextMenu, isOpen }">
                  <tr
                    :class="[columnRowClass(column, index), { 'structure-column-search-current': isOpen && !column.markedForDrop && !selectedColumnIds.has(column.id) }]"
                    :data-new-column-row="!column.original ? 'true' : undefined"
                    :data-column-row-index="index"
                    :data-column-id="column.id"
                    @mousedown="onColumnRowMouseDown($event)"
                    @click="onColumnRowClick(column, $event)"
                    @focusin="onColumnRowActivate(column)"
                    @contextmenu="onContextMenu"
                    @dragover="onColumnDragOver(index, $event)"
                    @drop="onColumnDrop(index, $event)"
                  >
                    <td :class="structureCellClass">
                      <div class="flex min-w-0 items-center">
                        <div class="flex shrink-0 items-center justify-center gap-1 border-r pr-0.5 text-muted-foreground" :style="{ width: columnOrdinalIndicatorWidth + 'px' }">
                          <span class="tabular-nums">{{ index + 1 }}</span>
                          <KeyRound v-if="column.isPrimaryKey" :class="[structureIconClass, 'shrink-0 text-amber-500']" />
                        </div>
                        <div class="flex min-w-0 items-center gap-0.5 pl-0.5">
                          <Button
                            v-if="canShowColumnDragControls"
                            type="button"
                            variant="ghost"
                            size="icon"
                            :class="[structureActionButtonClass, canDragColumn(index) ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed', hasLocalColumnOrderChange ? 'border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary' : '']"
                            :disabled="!canDragColumn(index)"
                            :title="t('structureEditor.dragColumn')"
                            :aria-label="t('structureEditor.dragColumn')"
                            :draggable="canDragColumn(index)"
                            @pointerdown="onColumnDragPointerDown(index, $event)"
                            @dragstart="onColumnDragStart(index, $event)"
                            @dragend="onColumnDragEnd"
                          >
                            <ListChevronsUpDown :class="structureIconClass" />
                          </Button>
                          <Tooltip :delay-duration="FIELD_SHORTCUT_TOOLTIP_DELAY_MS" data-copy-column-shortcut-tooltip>
                            <TooltipTrigger as-child>
                              <Button variant="ghost" size="icon" :class="structureActionButtonClass" :disabled="!canAddColumn || column.markedForDrop" :aria-label="t('structureEditor.copyColumn')" @click.stop="copyColumn(column)">
                                <Copy :class="structureIconClass" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" class="font-mono font-medium" data-copy-column-shortcut-content>⌘/Ctrl+D</TooltipContent>
                          </Tooltip>
                          <Tooltip :delay-duration="FIELD_SHORTCUT_TOOLTIP_DELAY_MS" data-delete-column-shortcut-tooltip>
                            <TooltipTrigger as-child>
                              <Button v-if="column.original" variant="ghost" size="icon" :class="structureActionButtonClass" :disabled="!canDropColumn(column)" :aria-label="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')" @click.stop="toggleDropColumn(column)">
                                <RefreshCw v-if="column.markedForDrop" :class="structureIconClass" />
                                <Trash2 v-else :class="structureIconClass" />
                              </Button>
                              <Button v-else variant="ghost" size="icon" :class="structureActionButtonClass" :aria-label="t('structureEditor.remove')" @click.stop="removeNewColumn(column)">
                                <X :class="structureIconClass" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" class="font-mono font-medium" data-delete-column-shortcut-content>
                              {{ column.markedForDrop ? t("structureEditor.restore") : "⌘/Ctrl+Del" }}
                            </TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    </td>
                    <td :class="structureCellClass">
                      <Input v-model="column.name" :class="[structureControlClass, columnSearchFieldClass(column, column.name)]" :disabled="isColumnNameDisabled(column)" data-column-name-input />
                    </td>
                    <td :class="structureCellClass">
                      <SearchableSelect
                        v-if="!isColumnTypeDisabled(column)"
                        :model-value="dataTypeBaseInputValue(databaseType, column.dataType)"
                        :options="dataTypeOptions"
                        :placeholder="t('structureEditor.typePlaceholder')"
                        :search-placeholder="t('structureEditor.typePlaceholder')"
                        :empty-text="t('structureEditor.noMatchingType')"
                        :loading-text="t('common.loading')"
                        :allow-custom="true"
                        :option-tooltip="dataTypeTooltip"
                        :display-name="gaussdbMDataTypeDisplayName"
                        :trigger-class="[structureMonoControlClass, 'w-full']"
                        @update:model-value="(v: string) => updateColumnDataType(column, v)"
                      />
                      <Input v-else :model-value="gaussdbMDataTypeDisplayName(dataTypeBaseInputValue(databaseType, column.dataType))" :class="[structureMonoControlClass, 'w-full']" disabled />
                    </td>
                    <td v-if="columnEditorControls.length" :class="structureCellClass">
                      <Popover v-if="isMysqlEnumDataType(databaseType, column.dataType)">
                        <PopoverTrigger as-child>
                          <Button variant="outline" size="sm" :class="[structureMonoControlClass, 'w-full justify-between px-2']" :disabled="isColumnTypeDisabled(column)">
                            <span>{{ t("structureEditor.enumValueCount", { count: column.enumValues?.length ?? 0 }) }}</span>
                            <ListChevronsUpDown :class="structureIconClass" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent class="w-80 p-3" align="start">
                          <div class="mb-2 flex items-center justify-between gap-2">
                            <span class="text-sm font-medium">{{ t("structureEditor.enumValues") }}</span>
                            <Button variant="outline" size="sm" class="h-7 px-2" @click="addMysqlEnumValue(column)">
                              <Plus class="mr-1 h-3.5 w-3.5" />
                              {{ t("structureEditor.addEnumValue") }}
                            </Button>
                          </div>
                          <div class="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                            <div v-for="(value, valueIndex) in column.enumValues" :key="valueIndex" class="flex items-center gap-1.5">
                              <Input :model-value="value" :class="structureMonoControlClass" :placeholder="t('structureEditor.enumValuePlaceholder')" @update:model-value="updateMysqlEnumValue(column, valueIndex, $event)" />
                              <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" :disabled="(column.enumValues?.length ?? 0) <= 1" :title="t('structureEditor.removeEnumValue')" @click="removeMysqlEnumValue(column, valueIndex)">
                                <Trash2 class="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                      <div v-else class="flex min-w-0 items-center gap-1">
                        <Input :model-value="dataTypeLengthInputValue(databaseType, column.dataType)" :class="[structureMonoControlClass, 'min-w-0 flex-1']" :disabled="isColumnLengthDisabled(column)" @update:model-value="updateColumnDataTypeLength(column, $event)" />
                        <Select v-if="columnLengthUnitOptions(column).length" :model-value="dataTypeLengthUnitValue(databaseType, column.dataType) || '__default'" :disabled="isColumnLengthUnitDisabled(column)" @update:model-value="updateColumnDataTypeLengthUnit(column, $event)">
                          <SelectTrigger
                            :aria-label="t('structureEditor.lengthUnit')"
                            :title="t('structureEditor.lengthUnit')"
                            class="structure-grid-control h-[var(--structure-control-height)] w-16 shrink-0 rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
                          >
                            <SelectValue :placeholder="t('structureEditor.unitPlaceholder')" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__default">{{ t("structureEditor.defaultAction") }}</SelectItem>
                            <SelectItem v-for="unit in columnLengthUnitOptions(column)" :key="unit" :value="unit">{{ unit }}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </td>
                    <td v-if="columnEditorControls.nullable" :class="structureCellClass">
                      <label class="flex items-center gap-1.5">
                        <input v-model="column.isNullable" type="checkbox" :class="structureCheckboxClass" :disabled="isColumnNullableDisabled(column)" />
                        <span>{{ column.isNullable ? t("structureEditor.yes") : t("structureEditor.no") }}</span>
                      </label>
                    </td>
                    <td v-if="columnEditorControls.primaryKey" :class="[structureCellClass, 'text-center']">
                      <input
                        v-model="column.isPrimaryKey"
                        type="checkbox"
                        :class="structureCheckboxClass"
                        :disabled="isPrimaryKeyDisabled(column)"
                        @change="
                          () => {
                            if (column.isPrimaryKey) column.isNullable = false;
                          }
                        "
                      />
                    </td>
                    <td v-if="columnEditorControls.defaultValue" :class="structureCellClass">
                      <div class="flex min-w-0 items-center gap-1">
                        <Input v-model="column.defaultValue" :class="[structureMonoControlClass, 'flex-1']" :disabled="isColumnDefaultDisabled(column)" />
                        <DropdownMenu>
                          <DropdownMenuTrigger as-child>
                            <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnDefaultDisabled(column)" :aria-label="t('structureEditor.defaultValuePresets')" :title="t('structureEditor.defaultValuePresets')">
                              <ChevronDown :class="structureIconClass" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" class="max-h-56 min-w-36 overflow-y-auto">
                            <DropdownMenuItem v-for="preset in defaultValuePresets" :key="preset.value" @click="column.defaultValue = preset.value">
                              <code class="font-mono text-[length:var(--structure-font-size)]">{{ preset.label }}</code>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </td>
                    <td v-if="columnEditorControls.comment" :class="structureCellClass">
                      <div class="flex min-w-0 items-center gap-1">
                        <Input v-model="column.comment" :class="[structureControlClass, 'flex-1', columnSearchFieldClass(column, column.comment)]" :disabled="isColumnCommentDisabled(column)" />
                        <Popover>
                          <PopoverTrigger as-child>
                            <Button variant="ghost" size="icon" :class="[structureIconButtonClass, 'shrink-0']" :disabled="isColumnCommentDisabled(column)" :aria-label="t('structureEditor.editComment')" :title="t('structureEditor.editComment')">
                              <Maximize2 :class="structureIconClass" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent align="end" class="w-[420px] p-2.5">
                            <div class="mb-2 flex items-center justify-between gap-2">
                              <span class="min-w-0 truncate text-xs font-medium">
                                {{ t("structureEditor.editComment") }}
                              </span>
                              <span class="max-w-44 truncate font-mono text-[length:var(--structure-font-size)] text-muted-foreground">
                                {{ column.name || t("structureEditor.columnName") }}
                              </span>
                            </div>
                            <textarea
                              v-model="column.comment"
                              class="min-h-36 w-full resize-y rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                              :placeholder="t('structureEditor.commentPlaceholder')"
                              :disabled="isColumnCommentDisabled(column)"
                            />
                          </PopoverContent>
                        </Popover>
                      </div>
                    </td>
                    <td v-if="showCharacterSet" :class="structureCellClass">
                      <SearchableSelect
                        :model-value="columnCharset(column)"
                        :options="mysqlCharsetOptions"
                        :placeholder="t('structureEditor.charsetPlaceholder')"
                        :search-placeholder="t('structureEditor.charsetPlaceholder')"
                        :empty-text="t('structureEditor.noMatchingType')"
                        :allow-custom="true"
                        :disabled="isColumnCharsetDisabled(column)"
                        :trigger-class="[structureMonoControlClass, 'w-full']"
                        @update:model-value="(v: string) => onCharsetChange(column, v)"
                      />
                    </td>
                    <td v-if="showCharacterSet" :class="structureCellClass">
                      <SearchableSelect
                        :model-value="columnCollation(column)"
                        :options="collationOptionsForCharset(columnCharset(column))"
                        :placeholder="t('structureEditor.collationPlaceholder')"
                        :search-placeholder="t('structureEditor.collationPlaceholder')"
                        :empty-text="t('structureEditor.noMatchingType')"
                        :allow-custom="true"
                        :disabled="isColumnCharsetDisabled(column)"
                        :trigger-class="[structureMonoControlClass, 'w-full']"
                        @update:model-value="(v: string) => (column.collation = v)"
                      />
                    </td>
                    <td v-if="showExtendedProperties" :class="structureCellClass">
                      <div :class="structurePropertyListClass">
                        <!-- Manticore Search: character data type properties -->
                        <template v-if="databaseType === 'manticoresearch'">
                          <template v-if="isManticoreTextColumn(column)">
                            <label :class="structurePropertyLabelClass" title="indexed">
                              <input :checked="!!column.extra.manticoreIndexed" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreIndexed = ($event.target as HTMLInputElement).checked" />
                              <span class="min-w-0 truncate">indexed</span>
                            </label>
                            <label :class="structurePropertyLabelClass" title="stored">
                              <input :checked="!!column.extra.manticoreStored" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreStored = ($event.target as HTMLInputElement).checked" />
                              <span class="min-w-0 truncate">stored</span>
                            </label>
                            <label :class="structurePropertyLabelClass" title="attribute">
                              <input :checked="!!column.extra.manticoreAttribute" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreAttribute = ($event.target as HTMLInputElement).checked" />
                              <span class="min-w-0 truncate">attribute</span>
                            </label>
                          </template>
                          <template v-else-if="isManticoreJsonColumn(column)">
                            <label :class="structurePropertyLabelClass" title="secondary_index">
                              <input :checked="!!column.extra.manticoreSecondaryIndex" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreSecondaryIndex = ($event.target as HTMLInputElement).checked" />
                              <span class="min-w-0 truncate">secondary_index</span>
                            </label>
                          </template>
                        </template>
                        <!-- MySQL: AUTO_INCREMENT + ON UPDATE CURRENT_TIMESTAMP -->
                        <template v-else-if="structureDialect === 'mysql'">
                          <label :class="[structurePropertyLabelClass, 'shrink-0 pr-1']" :title="t('structureEditor.autoIncrement')">
                            <input :checked="column.extra.autoIncrement" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" @change="setMysqlAutoIncrement(column, ($event.target as HTMLInputElement).checked)" />
                            <span>{{ t("structureEditor.autoIncrement") }}</span>
                          </label>
                          <Popover v-if="isMysqlAutoIncrementCounterColumn(column)">
                            <PopoverTrigger as-child>
                              <Button
                                variant="ghost"
                                size="icon"
                                :class="[structureIconButtonClass, 'mr-1 shrink-0']"
                                :title="t('structureEditor.editMysqlAutoIncrementValue', { value: mysqlAutoIncrementValue || '—' })"
                                :aria-label="t('structureEditor.editMysqlAutoIncrementValue', { value: mysqlAutoIncrementValue || '—' })"
                                data-mysql-auto-increment-editor-trigger
                              >
                                <Loader2 v-if="mysqlAutoIncrementLoading" :class="[structureIconClass, 'animate-spin text-muted-foreground']" />
                                <AlertTriangle v-else-if="mysqlAutoIncrementLoadError" :class="[structureIconClass, 'text-destructive']" />
                                <Pencil v-else :class="structureIconClass" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="start" class="w-80 space-y-2 p-3">
                              <label class="block text-xs font-medium text-foreground">{{ t("structureEditor.mysqlAutoIncrementNextValue") }}</label>
                              <Input
                                :model-value="mysqlAutoIncrementValue"
                                inputmode="numeric"
                                pattern="[0-9]*"
                                autocomplete="off"
                                data-mysql-auto-increment-counter
                                :aria-label="t('structureEditor.mysqlAutoIncrementNextValue')"
                                :placeholder="mysqlAutoIncrementLoading ? t('common.loading') : '—'"
                                :title="mysqlAutoIncrementLoadError || undefined"
                                class="w-full font-mono"
                                :disabled="mysqlAutoIncrementLoading || !!mysqlAutoIncrementLoadError || originalMysqlAutoIncrementValue === undefined || saving"
                                @input.capture="onMysqlAutoIncrementInput"
                              />
                              <p v-if="mysqlAutoIncrementLoadError" class="text-xs text-destructive">{{ mysqlAutoIncrementLoadError }}</p>
                              <p class="text-xs leading-5 text-muted-foreground">{{ t("contextMenu.mysqlAutoIncrementNonemptyHint") }}</p>
                            </PopoverContent>
                          </Popover>
                          <label :class="[structurePropertyLabelClass, 'flex-1 basis-0']" :title="t('structureEditor.onUpdateCurrentTimestamp')">
                            <input v-model="column.extra.onUpdateCurrentTimestamp" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" />
                            <span class="min-w-0 truncate">{{ t("structureEditor.onUpdateCurrentTimestamp") }}</span>
                          </label>
                        </template>
                        <!-- Dameng: IDENTITY -->
                        <template v-else-if="databaseType === 'dameng'">
                          <label :class="structurePropertyLabelClass" :title="t('structureEditor.identity')">
                            <input :checked="isDamengIdentityChecked(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="!canEditDamengIdentity(column)" @change="setDamengIdentity(column, ($event.target as HTMLInputElement).checked)" />
                            <span class="min-w-0 truncate">{{ t("structureEditor.autoIncrement") }}</span>
                          </label>
                          <template v-if="isDamengIdentityChecked(column)">
                            <Input
                              :model-value="column.extra.identity?.seed?.toString() ?? '1'"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identitySeed')"
                              :disabled="!canEditDamengIdentityParameters(column)"
                              @update:model-value="(v) => updateDamengIdentitySeed(column, v)"
                            />
                            <Input
                              :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identityIncrement')"
                              :disabled="!canEditDamengIdentityParameters(column)"
                              @update:model-value="(v) => updateDamengIdentityIncrement(column, v)"
                            />
                          </template>
                        </template>
                        <!-- PostgreSQL: IDENTITY -->
                        <template v-else-if="structureDialect === 'postgres'">
                          <Select
                            :model-value="column.extra.identity?.generation ?? 'none'"
                            @update:model-value="
                              (value: any) => {
                                const generation = String(value ?? '');
                                if (generation && generation !== 'none') {
                                  column.extra.identity = {
                                    ...column.extra.identity,
                                    generation: generation as 'BY DEFAULT' | 'ALWAYS',
                                  };
                                } else {
                                  column.extra.identity = undefined;
                                }
                              }
                            "
                          >
                            <SelectTrigger class="structure-grid-control h-[var(--structure-control-height)] w-28 rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">{{ t("structureEditor.no") }}</SelectItem>
                              <SelectItem value="BY DEFAULT">BY DEFAULT</SelectItem>
                              <SelectItem value="ALWAYS">ALWAYS</SelectItem>
                            </SelectContent>
                          </Select>
                          <template v-if="column.extra.identity?.generation">
                            <Input
                              :model-value="column.extra.identity.seed?.toString() ?? ''"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identitySeed')"
                              @update:model-value="
                                (v) => {
                                  if (column.extra.identity) {
                                    column.extra.identity.seed = v ? Number(v) : undefined;
                                  }
                                }
                              "
                            />
                            <Input
                              :model-value="column.extra.identity.increment?.toString() ?? ''"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identityIncrement')"
                              @update:model-value="
                                (v) => {
                                  if (column.extra.identity) {
                                    column.extra.identity.increment = v ? Number(v) : undefined;
                                  }
                                }
                              "
                            />
                          </template>
                        </template>
                        <!-- SQL Server: IDENTITY -->
                        <template v-else-if="structureDialect === 'sqlserver'">
                          <label :class="structurePropertyLabelClass" :title="canEditSqlServerIdentity(column) || isSqlServerIdentityChecked(column) ? t('structureEditor.identity') : t('structureEditor.sqlServerIdentityTypeHint')">
                            <input :checked="isSqlServerIdentityChecked(column)" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" :disabled="!canEditSqlServerIdentity(column)" @change="setSqlServerIdentity(column, ($event.target as HTMLInputElement).checked)" />
                            <span class="min-w-0 truncate">{{ t("structureEditor.autoIncrement") }}</span>
                          </label>
                          <template v-if="isSqlServerIdentityChecked(column)">
                            <Input
                              :model-value="column.extra.identity?.seed?.toString() ?? '1'"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identitySeed')"
                              :disabled="!canEditSqlServerIdentity(column)"
                              @update:model-value="(v) => updateSqlServerIdentitySeed(column, v)"
                            />
                            <Input
                              :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                              type="number"
                              :class="[structureControlClass, 'w-14']"
                              :placeholder="t('structureEditor.identityIncrement')"
                              :disabled="!canEditSqlServerIdentity(column)"
                              @update:model-value="(v) => updateSqlServerIdentityIncrement(column, v)"
                            />
                          </template>
                        </template>
                      </div>
                    </td>
                  </tr>
                </CustomContextMenu>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent ref="indexesScrollerRef" v-if="tableMetadataCapabilities.indexes" value="indexes" class="structure-table-scroller m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('indexes', $event)">
            <div v-if="indexesLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.indexes" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.indexes }}
            </div>
            <table v-else class="structure-edit-grid border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: indexColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th
                    v-for="(label, i) in indexColLabels"
                    :key="i"
                    :class="structureHeaderCellClass"
                    :style="{
                      width: indexColWidths[i] + 'px',
                      minWidth: indexColWidths[i] + 'px',
                    }"
                  >
                    {{ label }}
                    <div v-if="i < indexColLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="resizing?.col === i ? 'bg-primary/30' : ''" @mousedown="onIndexColResize($event, i)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(index, rowIndex) in indexes" :key="index.id" :class="indexRowClass(index)" :data-new-index-row="!index.original ? 'true' : undefined" :data-index-row-index="rowIndex">
                  <td :class="structureCellClass">
                    <Input :model-value="index.name" :class="[structureControlClass, indexSearchFieldClass(index, index.name)]" :disabled="!canEditIndexDraft(index)" data-index-name-input @update:model-value="(value: string | number) => onIndexNameInput(index, value)" />
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <DropdownMenu v-if="canEditIndexDraft(index)">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" :class="[structureMonoControlClass, 'w-full justify-between']">
                          <span class="truncate">{{ toColumnNames(index.columns) || t("structureEditor.indexColumnsPlaceholder") }}</span>
                          <ChevronDown :class="[structureIconClass, 'ml-1 shrink-0 opacity-50']" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="max-h-56 min-w-44 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                        <div class="px-[var(--structure-cell-px)] pb-1 pt-0.5">
                          <Input v-model="colSearch" :class="structureControlClass" :placeholder="t('grid.search')" @click.stop />
                        </div>
                        <DropdownMenuCheckboxItem v-for="col in filteredIndexColumnNames(index.columns)" :key="col" :checked="index.columns.includes(col)" :class="index.columns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIndexColumn(index, col)">
                          {{ col }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span v-else class="font-mono text-[length:var(--structure-font-size)] text-muted-foreground">{{ toColumnNames(index.columns) }}</span>
                  </td>
                  <td :class="structureCellClass">
                    <label class="flex items-center gap-1.5">
                      <input v-model="index.isUnique" type="checkbox" :class="structureCheckboxClass" :disabled="!canEditIndexDraft(index)" />
                      <span>{{ index.isUnique ? t("structureEditor.yes") : t("structureEditor.no") }}</span>
                    </label>
                  </td>
                  <td :class="structureCellClass">
                    <Select v-if="indexTypeOptions.length > 0" :model-value="index.indexType || 'BTREE'" :disabled="!canEditIndexDraft(index)" @update:model-value="(v: any) => (index.indexType = String(v ?? ''))">
                      <SelectTrigger class="structure-grid-control h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in indexTypeOptions" :key="opt" :value="opt">{{ opt }}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input v-else v-model="index.indexType" :class="structureMonoControlClass" placeholder="BTREE" :disabled="!canEditIndexDraft(index) || !structureCapabilities.indexType" />
                  </td>
                  <td :class="[structureCellClass, 'overflow-hidden']">
                    <DropdownMenu v-if="canEditIndexDraft(index) && structureCapabilities.indexInclude">
                      <DropdownMenuTrigger as-child>
                        <Button variant="outline" :class="[structureMonoControlClass, 'w-full justify-between']">
                          <span class="truncate">{{ index.includedColumns.join(", ") || t("structureEditor.includedColumnsPlaceholder") }}</span>
                          <ChevronDown :class="[structureIconClass, 'ml-1 shrink-0 opacity-50']" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent class="max-h-56 min-w-44 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                        <div class="px-[var(--structure-cell-px)] pb-1 pt-0.5">
                          <Input v-model="colSearch" :class="structureControlClass" :placeholder="t('grid.search')" @click.stop />
                        </div>
                        <DropdownMenuCheckboxItem v-for="col in filteredIndexColumnNames(index.includedColumns)" :key="col" :checked="index.includedColumns.includes(col)" :class="index.includedColumns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIncludedColumn(index, col)">
                          {{ col }}
                        </DropdownMenuCheckboxItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <span v-else class="text-[length:var(--structure-font-size)] text-muted-foreground">{{ index.includedColumns.join(", ") }}</span>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.filter" :class="[structureMonoControlClass, indexSearchFieldClass(index, index.filter)]" :placeholder="index.original?.filter || ''" :disabled="!canEditIndexFilter(index)" />
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.comment" :class="[structureControlClass, indexSearchFieldClass(index, index.comment)]" :disabled="!canEditIndexComment(index)" />
                  </td>
                  <td :class="structureCellClass">
                    <label v-if="structureCapabilities.indexConcurrent" class="flex items-center gap-1.5" :title="concurrentIndexCellTitle(index)">
                      <input v-model="index.concurrently" type="checkbox" :class="structureCheckboxClass" :disabled="!canEditIndexConcurrent(index)" />
                      <span>{{ index.concurrently ? t("structureEditor.yes") : t("structureEditor.no") }}</span>
                    </label>
                    <span v-else class="text-[length:var(--structure-font-size)] text-muted-foreground">—</span>
                  </td>
                  <td :class="structureLastCellClass">
                    <Badge v-if="index.isPrimary" variant="outline">{{ t("structureEditor.primary") }}</Badge>
                    <Button v-else-if="index.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canDropIndex(index)" @click="toggleDropIndex(index)">
                      <Trash2 :class="structureIconClass" />
                      {{ index.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewIndex(index)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <div v-if="hasStructureHorizontalOverflow && (activeTab === 'columns' || activeTab === 'indexes')" ref="structureHorizontalScrollbarTrackRef" class="structure-horizontal-scrollbar" @pointerdown="startStructureHorizontalScrollbarDrag">
            <div ref="structureHorizontalScrollbarThumbRef" class="structure-horizontal-scrollbar__thumb" />
          </div>

          <TabsContent ref="foreignKeysScrollerRef" v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('foreignKeys', $event)">
            <div v-if="foreignKeysLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors['foreign-keys']" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors["foreign-keys"] }}
            </div>
            <div v-else-if="foreignKeys.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="fk in foreignKeys" :key="fk.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="fk.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(110px,1fr)_minmax(110px,1fr)_minmax(110px,1fr)_minmax(90px,0.8fr)_minmax(90px,0.8fr)_auto] gap-1.5">
                  <Input v-model="fk.name" :class="structureControlClass" :placeholder="t('structureEditor.foreignKeyName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.column" :class="structureControlClass" :placeholder="t('structureEditor.columnName')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refTable" :class="structureControlClass" :placeholder="t('structureEditor.referencedTable')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refColumn" :class="structureControlClass" :placeholder="t('structureEditor.referencedColumn')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <Input v-model="fk.refSchema" :class="structureControlClass" :placeholder="t('structureEditor.referencedSchema')" :disabled="!canEditForeignKeyDraft(fk)" />
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="fk.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="toggleDropForeignKey(fk)">
                      <Trash2 :class="structureIconClass" />
                      {{ fk.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewForeignKey(fk)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
                <div class="mt-1.5 grid grid-cols-[minmax(110px,0.5fr)_minmax(110px,0.5fr)_1fr] gap-1.5">
                  <Select :model-value="fk.onDelete || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onDelete = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onDelete')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`delete-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select :model-value="fk.onUpdate || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onUpdate = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue :placeholder="t('structureEditor.onUpdate')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`update-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <div class="truncate font-mono text-muted-foreground">{{ fk.column }} -> {{ fk.refSchema ? `${fk.refSchema}.` : "" }}{{ fk.refTable }}.{{ fk.refColumn }}</div>
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="constraintsScrollerRef" v-if="tableMetadataCapabilities.constraints" value="constraints" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('constraints', $event)">
            <div v-if="constraintsLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.constraints" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.constraints }}
            </div>
            <div v-else-if="constraintsForTab.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="constraint in constraintsForTab" :key="constraint.name" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="constraint.enabled ? '' : 'opacity-60'">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-mono font-medium">{{ constraint.name }}</span>
                  <Badge variant="outline" class="shrink-0">{{ constraint.constraint_type }}</Badge>
                  <Badge v-if="!constraint.enabled" variant="outline" class="shrink-0 text-muted-foreground">{{ t("structureEditor.constraintDisabled") }}</Badge>
                  <Badge v-else-if="!constraint.valid" variant="outline" class="shrink-0 text-muted-foreground">{{ t("structureEditor.constraintNotValidated") }}</Badge>
                </div>
                <div v-if="constraint.columns.length" class="mt-1 truncate font-mono text-muted-foreground">{{ constraint.columns.join(", ") }}</div>
                <div v-if="constraint.ref_table" class="mt-1 truncate font-mono text-muted-foreground">-> {{ constraint.ref_schema ? `${constraint.ref_schema}.` : "" }}{{ constraint.ref_table }}{{ constraint.ref_columns.length ? `(${constraint.ref_columns.join(", ")})` : "" }}</div>
                <div v-if="constraint.definition" class="mt-1 whitespace-pre-wrap break-words font-mono text-muted-foreground">{{ constraint.definition }}</div>
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="triggersScrollerRef" v-if="tableMetadataCapabilities.triggers" value="triggers" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('triggers', $event)">
            <div v-if="triggersLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="secondaryMetadataErrors.triggers" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {{ secondaryMetadataErrors.triggers }}
            </div>
            <div v-else-if="triggers.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="trigger in triggers" :key="trigger.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="trigger.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(140px,1fr)_minmax(130px,180px)_minmax(140px,1fr)_auto] gap-1.5">
                  <Input v-model="trigger.name" :class="structureControlClass" :placeholder="t('structureEditor.triggerName')" :disabled="!canEditTriggerDraft(trigger)" />
                  <Input v-if="isOracleTriggerEditor" v-model="trigger.timing" :class="structureControlClass" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-else v-model="trigger.timing" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="timing in triggerTimingOptions" :key="timing" :value="timing">{{ timing }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input v-if="isOracleTriggerEditor" v-model="trigger.event" :class="structureControlClass" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-else v-model="trigger.event" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="event in triggerEventOptions" :key="event" :value="event">{{ event }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <div class="flex items-center justify-end gap-1">
                    <Button v-if="trigger.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="toggleDropTrigger(trigger)">
                      <Trash2 :class="structureIconClass" />
                      {{ trigger.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                    </Button>
                    <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewTrigger(trigger)">
                      <X :class="structureIconClass" />
                      {{ t("structureEditor.remove") }}
                    </Button>
                  </div>
                </div>
                <textarea
                  v-model="trigger.statement"
                  class="mt-1.5 min-h-28 w-full resize-y rounded-[6px] border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] font-mono text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                  :placeholder="t('structureEditor.triggerStatement')"
                  :disabled="!canEditTriggerDraft(trigger)"
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent ref="ddlScrollerRef" v-if="tableMetadataCapabilities.ddl" value="ddl" class="relative m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('ddl', $event)">
            <div v-if="ddlLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <template v-else>
              <Button v-if="ddlContent && !ddlSearchOpen" variant="outline" size="sm" class="absolute right-3 top-3 z-10 h-7 gap-1 px-2" :title="t('grid.copyDdl')" @click="copyDdlContent">
                <Copy class="h-3.5 w-3.5" />
                {{ t("grid.copyDdl") }}
              </Button>
              <div ref="ddlEditorContainer" class="structure-ddl-editor h-full min-h-full min-w-0 w-full"></div>
              <EditorSearchPanel v-if="ddlEditorView" ref="ddlSearchPanelRef" :view="ddlEditorView" @open="ddlSearchOpen = true" @close="ddlSearchOpen = false" />
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <div :class="['flex min-w-0 shrink-0 flex-col overflow-hidden rounded-md border', sqlPreviewCollapsed ? '' : 'h-[28%] min-h-40 max-h-64']">
        <div class="flex shrink-0 items-center justify-between border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] font-medium">
          <div class="flex items-center gap-1.5">
            <span>{{ t("structureEditor.sqlPreview") }}</span>
            <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" :class="['h-4 px-1 text-[10px]', sqlPreviewPending || sqlPreviewLoading ? 'invisible' : '']" :aria-hidden="sqlPreviewPending || sqlPreviewLoading">
              <Check class="h-3 w-3" />
              {{ t("structureEditor.ready") }}
            </Badge>
          </div>
          <div class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              :class="structureIconButtonClass"
              :aria-label="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              :title="sqlPreviewCollapsed ? t('structureEditor.expandSqlPreview') : t('structureEditor.collapseSqlPreview')"
              @click="toggleSqlPreviewCollapsed"
            >
              <ChevronUp v-if="sqlPreviewCollapsed" :class="structureIconClass" />
              <ChevronDown v-else :class="structureIconClass" />
            </Button>
            <Button variant="ghost" :class="structureToolbarButtonClass" :disabled="sqlPreviewPending || sqlPreviewLoading || !previewSqlText.trim()" @click="copyPreviewSql">
              <Copy :class="[structureIconClass, 'mr-1']" />
              {{ t("structureEditor.copySql") }}
            </Button>
            <Badge variant="secondary" class="min-w-6 justify-center tabular-nums">
              <Loader2 v-if="(sqlPreviewPending || sqlPreviewLoading) && !pendingStatements.length" class="h-3 w-3 animate-spin" />
              <span v-else>{{ pendingStatements.length }}</span>
            </Badge>
          </div>
        </div>
        <div v-if="!sqlPreviewCollapsed" class="min-h-0 flex-1 overflow-auto p-2.5" :aria-busy="sqlPreviewPending || sqlPreviewLoading">
          <div v-if="hasSqliteTypeChange" class="mb-2 flex gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-primary">
            <Info :class="[structureIconClass, 'mt-0.5 shrink-0']" />
            <span>{{ t("structureEditor.sqliteRebuildNotice") }}</span>
          </div>
          <div v-if="warnings.length" class="mb-2 space-y-1">
            <div v-for="warning in warnings" :key="warning" class="flex gap-1.5 rounded-md border border-yellow-300/40 bg-yellow-500/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-yellow-700 dark:text-yellow-300">
              <AlertTriangle :class="[structureIconClass, 'mt-0.5 shrink-0']" />
              <span>{{ warning }}</span>
            </div>
          </div>
          <pre v-if="pendingStatements.length" class="select-text whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2.5 font-mono text-[calc(var(--structure-font-size)+1px)] leading-5" v-html="highlightedSql" />
          <div v-else-if="sqlPreviewPending || sqlPreviewLoading" class="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
          </div>
          <div v-else class="flex h-full items-center justify-center text-[length:var(--structure-font-size)] text-muted-foreground">
            {{ t("structureEditor.noChanges") }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="errorMessage" class="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] text-destructive">
      {{ errorMessage }}
    </div>

    <div class="flex shrink-0 items-center justify-end gap-2">
      <Button :class="structureToolbarButtonClass" :disabled="!canApply" @click="applyChanges">
        <Loader2 v-if="saving" :class="[structureIconClass, 'mr-1.5 animate-spin']" />
        <Save v-else :class="[structureIconClass, 'mr-1.5']" />
        {{ t("structureEditor.apply") }}
      </Button>
    </div>

    <Dialog v-model:open="copyColumnsDialogOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ t("structureEditor.copyColumnsTitle") }}</DialogTitle>
        </DialogHeader>

        <div class="space-y-3 overflow-hidden">
          <div class="grid gap-1.5 text-sm font-medium">
            <label for="copy-source-table-search">{{ t("structureEditor.copyColumnsSourceTable") }}</label>
            <Input id="copy-source-table-search" :model-value="copySourceTableSearch" :placeholder="t('structureEditor.copyColumnsSearchSourceTables')" @update:model-value="updateCopySourceTableSearch" />
          </div>

          <div v-if="copySourceTablesLoading" class="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t("common.loading") }}
          </div>
          <div v-else-if="copySourceError" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {{ copySourceError }}
          </div>
          <div v-else-if="copySourceTables.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
            {{ copySourceTableSearch ? t("structureEditor.copyColumnsNoMatchingSourceTables") : t("structureEditor.copyColumnsNoSourceTables") }}
          </div>
          <template v-else>
            <div class="max-h-52 overflow-y-auto rounded-md border" :aria-label="t('structureEditor.copyColumnsSourceTable')">
              <button
                v-for="table in copySourceTables"
                :key="table.name"
                type="button"
                :aria-pressed="table.name === copySourceTableName"
                :class="['flex h-9 w-full items-center px-3 text-left font-mono text-sm hover:bg-muted/50 focus-visible:bg-muted focus-visible:outline-none', table.name === copySourceTableName ? 'bg-muted' : '']"
                @click="loadCopySourceColumns(table.name)"
              >
                <span class="truncate" :title="table.name">{{ table.name }}</span>
              </button>
            </div>
            <div v-if="copySourceTablesHasPreviousPage || copySourceTablesHasMore" class="flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7"
                :disabled="copySourceTablesLoading || !copySourceTablesHasPreviousPage"
                :title="t('structureEditor.copyColumnsPreviousSourceTablePage')"
                :aria-label="t('structureEditor.copyColumnsPreviousSourceTablePage')"
                @click="loadCopySourceTables(Math.max(0, copySourceTablesOffset - COPY_SOURCE_TABLE_PAGE_SIZE))"
              >
                <ChevronLeft class="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                class="h-7 w-7"
                :disabled="copySourceTablesLoading || !copySourceTablesHasMore"
                :title="t('structureEditor.copyColumnsNextSourceTablePage')"
                :aria-label="t('structureEditor.copyColumnsNextSourceTablePage')"
                @click="loadCopySourceTables(copySourceTablesOffset + COPY_SOURCE_TABLE_PAGE_SIZE)"
              >
                <ChevronRight class="h-4 w-4" />
              </Button>
            </div>
          </template>
          <template v-if="copySourceTableName">
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{{ t("structureEditor.copyColumnsSelectFields") }}</span>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="copySourceColumnsLoading || copyableSourceColumnNames.length === 0" @click="toggleCopySourceColumns">
                {{ allCopyableSourceColumnsSelected ? t("structureEditor.copyColumnsClearSelection") : t("structureEditor.copyColumnsSelectAll") }}
              </Button>
            </div>
            <Input v-model="copySourceColumnSearch" :placeholder="t('structureEditor.copyColumnsSearchFields')" />
            <div v-if="copySourceColumnsLoading" class="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="copySourceColumns.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              {{ t("structureEditor.copyColumnsNoFields") }}
            </div>
            <div v-else-if="filteredCopyableSourceColumns.length === 0" class="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              {{ t("structureEditor.copyColumnsNoMatchingFields") }}
            </div>
            <div v-else class="max-h-72 overflow-y-auto rounded-md border">
              <label v-for="{ column, alreadyExists } in filteredCopyableSourceColumns" :key="column.name" class="flex cursor-pointer items-center gap-2 border-b px-3 py-2 last:border-b-0 hover:bg-muted/50" :class="alreadyExists ? 'cursor-not-allowed opacity-60' : ''">
                <input v-model="selectedCopySourceColumnNames" type="checkbox" :value="column.name" :disabled="alreadyExists" class="size-4 rounded border-input" />
                <span class="min-w-0 flex-1 truncate font-mono text-sm">{{ column.name }}</span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ column.data_type }}</span>
                <Badge v-if="alreadyExists" variant="secondary" class="shrink-0 text-[10px]">{{ t("structureEditor.copyColumnsAlreadyExists") }}</Badge>
              </label>
            </div>
          </template>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="copyColumnsDialogOpen = false">{{ t("structureEditor.copyColumnsCancel") }}</Button>
          <Button :disabled="copySourceColumnsLoading || selectedCopySourceColumns.length === 0" @click="applyCopiedColumns">
            {{ t("structureEditor.copyColumnsApply", { count: selectedCopySourceColumns.length }) }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.structure-ddl-editor :deep(.cm-editor) {
  min-height: 100%;
  background: transparent;
}

.structure-ddl-editor :deep(.cm-content),
.structure-ddl-editor :deep(.cm-line) {
  cursor: text;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.structure-ddl-editor :deep(.cm-selectionBackground),
.structure-ddl-editor :deep(.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.structure-ddl-editor :deep(.cm-content ::selection) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.structure-table-scroller::-webkit-scrollbar {
  width: 8px;
  height: 0;
}

.structure-horizontal-scrollbar {
  position: relative;
  height: 10px;
  flex-shrink: 0;
  cursor: pointer;
  touch-action: none;
  background: var(--background);
}

.structure-horizontal-scrollbar__thumb {
  position: absolute;
  top: 3px;
  height: 4px;
  min-width: 24px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  transition:
    top 120ms ease,
    height 120ms ease,
    background-color 120ms ease;
}

.structure-horizontal-scrollbar:hover .structure-horizontal-scrollbar__thumb,
.structure-horizontal-scrollbar--dragging .structure-horizontal-scrollbar__thumb {
  top: 2px;
  height: 6px;
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
}

/* Editable values behave like grid cells, not a row of independent pill controls. */
.structure-edit-grid :deep(.structure-grid-control) {
  border-color: transparent;
  border-radius: 0;
  background-color: transparent;
  box-shadow: none;
}

.structure-edit-grid > tbody > tr > td:hover {
  background-color: color-mix(in oklab, var(--muted) 36%, transparent);
}

.structure-edit-grid > tbody > tr > td:focus-within {
  background-color: color-mix(in oklab, var(--primary) 7%, transparent);
  outline: 1px solid color-mix(in oklab, var(--primary) 55%, transparent);
  outline-offset: -1px;
}

.structure-edit-grid > tbody > tr > td:focus-within :deep(.structure-grid-control) {
  border-color: transparent;
  background-color: transparent;
  box-shadow: none;
}

/* --primary is rgb/oklch; use color-mix like DataGrid, not channel-based hsl wrappers. */
.structure-column-search-match > td:first-child {
  box-shadow: inset 3px 0 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td {
  background-color: color-mix(in oklab, var(--primary) 8%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

.structure-column-search-current > td:first-child {
  box-shadow:
    inset 3px 0 0 var(--primary),
    inset 0 1px 0 color-mix(in oklab, var(--primary) 55%, transparent),
    inset 0 -1px 0 color-mix(in oklab, var(--primary) 55%, transparent);
}

/* Inputs are bg-transparent; give them a solid surface on the selected row so fields stay readable. */
.structure-column-search-current :is(input, button, [role="combobox"], [data-slot="select-trigger"]) {
  background-color: var(--background);
}
</style>
