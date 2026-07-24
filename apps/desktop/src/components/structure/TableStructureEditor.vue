<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Database, Info, KeyRound, ListChevronsUpDown, Loader2, Maximize2, Plus, RefreshCw, Save, Search, Settings, SlidersHorizontal, Trash2, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore, type StructureEditorDensity } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sql/sqlHighlighter";
import { joinSqlStatementsForScript } from "@/lib/sql/sqlBatchScript";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { type BuildTableStructureChangeSqlOptions, type EditableStructureColumn, type EditableStructureForeignKey, type EditableStructureIndex, type EditableStructureTrigger } from "@/lib/table/tableStructureEditorSql";
import { PRESET_FIELDS_TEMPLATE_ID, createTableColumnTemplateDrafts } from "@/lib/table/tableColumnTemplates";
import { getMysqlDataTypeHelp } from "@/lib/table/mysqlDataTypeHelp";
import { getPostgresDataTypeHelp } from "@/lib/table/postgresDataTypeHelp";
import { getSqliteDataTypeHelp } from "@/lib/table/sqliteDataTypeHelp";
import { getTableMetadataCapabilities, firstStructureMetadataTab, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";
import { shouldLoadTableStructureTriggers, TRIGGERS_ONLY_REFRESH_SCOPE, visibleTableStructureRefreshScope, type TableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";
import { canAddTableStructureColumn, getTableStructureCapabilities, hasLocalTableColumnOrderChange, isPhysicalTableColumnOrderChange, supportsLocalTableColumnReorder } from "@/lib/table/tableStructureCapabilities";
import { orderedColumnIndexes, uniqueDataGridColumnOrderKeys } from "@/lib/dataGrid/dataGridColumnOrder";
import { loadTableDataGridColumnOrder, notifyTableDataGridColumnOrderChanged, removeTableDataGridColumnOrder, saveTableDataGridColumnOrder, tableDataGridColumnOrderScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import { connectionObjectTreeQuerySchema, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { TableInfoTab, TableStructureEditorDraft, TableStructureEditorTarget, TableStructureEditorViewport } from "@/types/database";
import {
  applyManticoreDdlColumnExtras,
  buildStructureTargetLabel,
  canEditManticoreColumnProperties,
  combineDataTypeForDatabase,
  combineDataTypeForDatabaseWithLengthUnit,
  createColumnDrafts,
  createForeignKeyDrafts,
  createIndexDrafts,
  createTriggerDrafts,
  dataTypeLengthInputValue,
  dataTypeLengthUnitValue,
  defaultNewColumnDataType,
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
  restoreDamengLengthUnitsAfterSave,
  splitDataType,
  toColumnNames,
} from "@/lib/table/tableStructureEditorState";
import { CREATE_DATABASE_CHARSET_OPTIONS, createDatabaseCollationOptionsForCharset, fallbackCreateDatabaseCharsetMetadata, normalizeCreateDatabaseCharsetKey, parseCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import type { CreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const { isDark } = useTheme();
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
const triggersScrollerRef = ref<StructureScrollerRef>();
const ddlScrollerRef = ref<StructureScrollerRef>();
const dynamicDataTypeOptionsCache = new Map<string, string[]>();

const sqlHighlighter = ref<SqlHighlighter>();
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
const indexesLoading = ref(false);
const foreignKeysLoading = ref(false);
const triggersLoading = ref(false);
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlPreRef = ref<HTMLPreElement | null>(null);
function onDdlKeydown(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === "a") {
    e.preventDefault();
    const el = ddlPreRef.value;
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}
const ddlFetched = ref(false);

async function fetchDdl() {
  if (!props.connectionId || !props.database || !props.tableName || ddlFetched.value || !tableMetadataCapabilities.value.ddl) return;
  ddlLoading.value = true;
  try {
    const ddl = await api.getTableDdl(props.connectionId, props.database, metadataSchema.value, props.tableName, undefined, props.catalog);
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
const columns = ref<EditableStructureColumn[]>([]);
const indexes = ref<EditableStructureIndex[]>([]);
const pendingStatements = ref<string[]>([]);
const warnings = ref<string[]>([]);
const sqliteSchemaRevision = ref<string>();
const foreignKeys = ref<EditableStructureForeignKey[]>([]);
const triggers = ref<EditableStructureTrigger[]>([]);
const triggersLoaded = ref(false);
const secondaryMetadataLoading = computed(() => indexesLoading.value || foreignKeysLoading.value || triggersLoading.value);

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
    !sameText(index.indexType, original.index_type) ||
    !sameList(index.includedColumns, original.included_columns) ||
    !sameText(index.comment, original.comment)
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
const STRUCTURE_COLUMN_WIDTH_COUNT = 12;
const STRUCTURE_INDEX_COLUMN_WIDTH_COUNT = 8;
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
    indexes: [120, 180, 60, 88, 124, 144, 120, 70],
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
    indexes: [148, 224, 72, 108, 148, 180, 148, 84],
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
    indexes: [176, 260, 84, 124, 176, 216, 176, 104],
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
const structureControlClass = "h-[var(--structure-control-height)] min-w-0 rounded-[6px] px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25";
const structureMonoControlClass = `${structureControlClass} font-mono`;
const structureToolbarButtonClass = "h-[var(--structure-control-height)] gap-1 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]";
const structureIconButtonClass = "h-[var(--structure-control-height)] w-[var(--structure-control-height)]";
const structureIconClass = "h-[var(--structure-icon-size)] w-[var(--structure-icon-size)]";
const structureCheckboxClass = "h-[var(--structure-checkbox-size)] w-[var(--structure-checkbox-size)]";
const structureHeaderCellClass = "relative min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left";
const structureCellClass = "min-w-0 overflow-hidden border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
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
  const minimumWidth = widthIndex === 3 && databaseType.value === "dameng" ? structureDensityMetric.value.minLengthColumnWidth : structureDensityMetric.value.minColumnWidth;
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
const usesMysql8SafeDefaults = computed(() => databaseType.value === "mysql" && connection.value?.db_type === "mysql" && connection.value.driver_profile === "mysql");
const structureCapabilities = computed(() => getTableStructureCapabilities(databaseType.value, connection.value?.db_type));
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
};
const indexTypeOptions = computed(() => (structureCapabilities.value.indexType ? (indexTypesByDb[structureDialect.value] ?? []) : []));

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
  return dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss" || dbType === "highgo" || dbType === "vastbase" || dbType === "kingbase";
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
const columnActionButtonCount = computed(() => (canShowColumnDragControls.value ? 2 : 1));
const columnActionsWidth = computed(() => {
  const metric = structureDensityMetric.value;
  const count = columnActionButtonCount.value;
  return metric.actionButtonWidth * count + actionButtonGap * Math.max(0, count - 1) + metric.cellPaddingX * 2;
});
const visibleColumnIndexes = computed(() => colLabels.value.map((column) => column.widthIndex));
const visibleColWidths = computed(() =>
  colLabels.value.map((column) => {
    if (column.key === "actions") return columnActionsWidth.value;
    const width = colWidths.value[column.widthIndex] ?? structureDensityMetric.value.minColumnWidth;
    return column.key === "length" && databaseType.value === "dameng" ? Math.max(width, structureDensityMetric.value.minLengthColumnWidth) : width;
  }),
);

function columnWidthIndex(visibleIndex: number) {
  return visibleColumnIndexes.value[visibleIndex] ?? visibleIndex;
}

const colLabels = computed(() => {
  const labels = [
    { key: "ordinal", label: "#", widthIndex: 0 },
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
  labels.push({ key: "actions", label: t("structureEditor.actions"), widthIndex: 11 });
  return labels;
});
const indexColLabels = computed(() => [t("structureEditor.indexName"), t("structureEditor.indexColumns"), t("structureEditor.unique"), t("structureEditor.indexType"), t("structureEditor.includedColumns"), t("structureEditor.filter"), t("structureEditor.comment"), t("structureEditor.actions")]);
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
const targetLabel = computed(() => buildStructureTargetLabel(connection.value?.name, props.database, props.schema, isCreateMode.value ? undefined : props.tableName));

function isManticoreTextColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  const baseType = splitDataType(column.dataType).baseType.trim().toLowerCase();
  return baseType === "text" || baseType === "string";
}

function isManticoreJsonColumn(column: EditableStructureColumn): boolean {
  if (databaseType.value !== "manticoresearch") return false;
  return splitDataType(column.dataType).baseType.trim().toLowerCase() === "json";
}

let sqlPreviewRequestId = 0;
let structureLoadRequestId = 0;
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
  if (tab === "triggers") return structureScrollerElement(triggersScrollerRef.value);
  if (tab === "ddl") return structureScrollerElement(ddlScrollerRef.value);
  return undefined;
}

function restoreStructureScrollPosition(tab = activeTab.value) {
  const position = structureScrollPositions.value[tab];
  if (!position) return;
  nextTick(() => {
    const scroller = structureScrollerForTab(tab);
    if (!scroller) return;
    scroller.scrollTop = Math.max(0, position.scrollTop);
    scroller.scrollLeft = Math.max(0, position.scrollLeft);
  });
}

function onStructureContentScroll(tab: TableInfoTab, event: Event) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
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
    columns: cloneDraftValue(columns.value),
    indexes: cloneDraftValue(indexes.value),
    foreignKeys: cloneDraftValue(foreignKeys.value),
    triggers: cloneDraftValue(triggers.value),
    triggersLoaded: triggersLoaded.value,
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
  columns.value = cloneDraftValue(draft.columns || []);
  indexes.value = cloneDraftValue(draft.indexes || []);
  foreignKeys.value = cloneDraftValue(draft.foreignKeys || []);
  triggers.value = cloneDraftValue(draft.triggers || []);
  // Drafts created before lazy trigger loading always contained live trigger metadata.
  triggersLoaded.value = draft.triggersLoaded ?? true;
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
    let nextColumns = await api.getColumns(connectionId, database, schema, tableName, catalog);
    if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
      try {
        const ddl = await api.getTableDdl(connectionId, database, schema, tableName, undefined, catalog);
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
    return !!newTableName.value.trim() || !!tableComment.value.trim() || columns.value.length > 0 || indexes.value.length > 0 || foreignKeys.value.length > 0 || triggers.value.length > 0;
  }
  const scope = captureStructureRefreshScope();
  return scope.columns || scope.indexes || scope.foreignKeys || scope.triggers || scope.tableComment;
}

function clearSqlPreviewState() {
  if (sqlPreviewDebounceTimer) {
    clearTimeout(sqlPreviewDebounceTimer);
    sqlPreviewDebounceTimer = undefined;
  }
  sqlPreviewRequestId++;
  deferredSqlPreviewRefresh = false;
  sqlPreviewLoading.value = false;
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
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
  if (!hasPendingStructureChanges()) {
    sqlPreviewLoading.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  if (hydratingRestoredDraft || needsColumnDraftMetadataHydration()) return;
  if (!isCreateMode.value && secondaryMetadataLoading.value) {
    deferredSqlPreviewRefresh = true;
    return;
  }
  sqlPreviewDebounceTimer = setTimeout(() => {
    sqlPreviewDebounceTimer = undefined;
    void refreshSqlPreview();
  }, 80);
}

function structureChangeOptions(): BuildTableStructureChangeSqlOptions {
  return {
    databaseType: databaseType.value,
    schema: props.schema,
    tableName: isCreateMode.value ? newTableName.value.trim() : props.tableName || "",
    columns: columns.value,
    indexes: indexes.value,
    foreignKeys: foreignKeys.value,
    triggers: triggers.value,
    tableComment: tableComment.value,
    originalTableComment: isCreateMode.value ? undefined : originalTableComment.value,
  };
}

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqliteSchemaRevision.value = undefined;
    sqlPreviewLoading.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  const options = structureChangeOptions();
  try {
    const result = isCreateMode.value ? await api.buildCreateTableSql(options) : hasSqliteTypeChange.value ? await api.previewSqliteTableStructureChange(props.connectionId, props.database, options) : await api.buildTableStructureChangeSql(options);
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = result.statements;
    warnings.value = result.warnings;
    sqliteSchemaRevision.value = "schemaRevision" in result && typeof result.schemaRevision === "string" ? result.schemaRevision : undefined;
  } catch (e: any) {
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [];
    warnings.value = [e?.message || String(e)];
    sqliteSchemaRevision.value = undefined;
  } finally {
    if (requestId === sqlPreviewRequestId) sqlPreviewLoading.value = false;
  }
}

const canApply = computed(
  () =>
    !loading.value &&
    !saving.value &&
    !postSaveRefreshing.value &&
    !secondaryMetadataLoading.value &&
    !sqlPreviewLoading.value &&
    pendingStatements.value.length > 0 &&
    warnings.value.length === 0 &&
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
  indexesLoading.value = false;
  foreignKeysLoading.value = false;
  triggersLoading.value = false;
  errorMessage.value = "";
  columns.value = [];
  indexes.value = [];
  pendingStatements.value = [];
  warnings.value = [];
  sqliteSchemaRevision.value = undefined;
  foreignKeys.value = [];
  triggers.value = [];
  triggersLoaded.value = false;
  selectedColumnId.value = null;
  ddlContent.value = "";
  ddlFetched.value = false;
  newTableName.value = "";
  tableComment.value = "";
  originalTableComment.value = "";
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
  await loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true });
}

function setSecondaryMetadataLoading(scope: TableStructureRefreshScope, value: boolean) {
  if (scope.indexes && tableMetadataCapabilities.value.indexes) indexesLoading.value = value;
  if (scope.foreignKeys && tableMetadataCapabilities.value.foreignKeys) foreignKeysLoading.value = value;
  if (scope.triggers && tableMetadataCapabilities.value.triggers) triggersLoading.value = value;
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

async function loadStructure(silent = false, scope: TableStructureRefreshScope = visibleTableStructureRefreshScope(activeTab.value), showErrors = true, options: { blockSecondaryMetadata?: boolean; preserveDraft?: boolean; damengLengthUnitsAfterSave?: ReadonlyMap<string, string> } = {}) {
  const connectionId = props.connectionId;
  const database = props.database;
  const catalog = props.catalog;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  const requestId = ++structureLoadRequestId;
  if (!silent) loading.value = true;
  setSecondaryMetadataLoading(scope, true);
  errorMessage.value = "";
  let secondaryMetadataScheduled = false;
  let loadedSuccessfully = false;
  try {
    await store.ensureConnected(connectionId);

    const columnsPromise = scope.columns ? api.getColumns(connectionId, database, schema, tableName, catalog) : Promise.resolve(undefined);
    const indexesPromise = scope.indexes ? (tableMetadataCapabilities.value.indexes ? api.listIndexes(connectionId, database, schema, tableName, catalog).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const foreignKeysPromise = scope.foreignKeys ? (tableMetadataCapabilities.value.foreignKeys ? api.listForeignKeys(connectionId, database, schema, tableName, catalog).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const triggersPromise = scope.triggers ? (tableMetadataCapabilities.value.triggers ? api.listTriggers(connectionId, database, schema, tableName, catalog).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const tableCommentPromise = scope.tableComment && structureCapabilities.value.comment ? fetchTableCommentValue(connectionId, database, schema, tableName, catalog) : Promise.resolve(undefined);

    let nextColumns = await columnsPromise;
    if (nextColumns) {
      if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
        try {
          const ddl = await api.getTableDdl(connectionId, database, schema, tableName, undefined, catalog);
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
      const hydratedColumnDrafts = databaseType.value === "dameng" && options.damengLengthUnitsAfterSave ? restoreDamengLengthUnitsAfterSave(nextColumnDrafts, options.damengLengthUnitsAfterSave) : nextColumnDrafts;
      columns.value = applyStoredLocalColumnOrder(hydratedColumnDrafts);
      if (!options.preserveDraft) selectedColumnId.value = null;
    }

    const nextTableComment = await tableCommentPromise;
    if (nextTableComment !== undefined) {
      originalTableComment.value = nextTableComment;
      tableComment.value = nextTableComment;
    }
    const applySecondaryMetadata = async () => {
      const [nextIndexes, nextForeignKeys, nextTriggers] = await Promise.all([indexesPromise, foreignKeysPromise, triggersPromise]);
      if (requestId !== structureLoadRequestId) return;
      if (nextIndexes) indexes.value = createIndexDrafts(nextIndexes);
      if (nextForeignKeys) foreignKeys.value = createForeignKeyDrafts(nextForeignKeys);
      if (nextTriggers) {
        triggers.value = createTriggerDrafts(nextTriggers);
        triggersLoaded.value = true;
      }
    };

    secondaryMetadataScheduled = true;
    const secondaryMetadataPromise = applySecondaryMetadata()
      .catch((error) => {
        console.warn("[DBX][structure-editor:secondary-metadata-failed]", error);
      })
      .finally(() => {
        if (requestId === structureLoadRequestId) setSecondaryMetadataLoading(scope, false);
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
      setSecondaryMetadataLoading(scope, false);
    }
    if (!silent) loading.value = false;
    if (!options.preserveDraft && loadedSuccessfully && requestId === structureLoadRequestId) {
      markDraftHydratedAndSync();
    }
  }
}

async function refreshStructureAfterSave(scope: TableStructureRefreshScope, damengLengthUnitsAfterSave: ReadonlyMap<string, string>) {
  try {
    await loadStructure(true, scope, false, { blockSecondaryMetadata: true, damengLengthUnitsAfterSave });
  } catch (e) {
    console.warn("[DBX][structure-editor:post-save-refresh-failed]", e);
  } finally {
    postSaveRefreshing.value = false;
    if (activeTab.value === "ddl") void fetchDdl();
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

function onColumnRowActivate(column: EditableStructureColumn) {
  if (column.markedForDrop || !columns.value.some((item) => item.id === column.id)) return;
  selectedColumnId.value = column.id;
}

async function addColumn() {
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
  const insertAt = resolveInsertColumnIndex(columns.value, selectedColumnId.value);
  columns.value.splice(insertAt, 0, column);
  selectedColumnId.value = column.id;
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder();
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
  selectedColumnId.value = templateColumns[templateColumns.length - 1]?.id ?? selectedColumnId.value;
  if (usesLocalTableColumnOrder.value) persistLocalColumnOrder();
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
  if (selectedColumnId.value === column.id) selectedColumnId.value = null;
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

function canEditDamengIdentity(column: EditableStructureColumn): boolean {
  if (column.original || column.markedForDrop || !isDamengIdentityCompatibleDataType(column.dataType)) return false;
  // DM8 permits only one identity column per table, so prevent creating an invalid draft in the editor.
  return isDamengIdentityChecked(column) || !columns.value.some((candidate) => candidate !== column && !candidate.markedForDrop && isDamengIdentityChecked(candidate));
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
  column.extra.autoIncrement = true;
  column.extra.identity = {
    seed: column.extra.identity?.seed ?? 1,
    increment: column.extra.identity?.increment ?? 1,
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
  if (!canEditDamengIdentity(column)) return;
  ensureDamengIdentity(column);
  column.extra.identity!.seed = parseOptionalNumberInput(value);
}

function updateDamengIdentityIncrement(column: EditableStructureColumn, value: string | number) {
  if (!canEditDamengIdentity(column)) return;
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
  const baseType = splitDataType(column.dataType).baseType;
  column.dataType = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, String(value), dataTypeLengthUnitValue(databaseType.value, column.dataType));
  syncSqlServerIdentityForDataType(column);
  syncDamengIdentityForDataType(column);
}

function updateColumnDataTypeLengthUnit(column: EditableStructureColumn, value: unknown) {
  const baseType = splitDataType(column.dataType).baseType;
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
  const isSelected = selectedColumnId.value === column.id && !column.markedForDrop;
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
  if (column.markedForDrop && selectedColumnId.value === column.id) {
    selectedColumnId.value = null;
  }
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
  const baseType = splitDataType(column.dataType).baseType.trim().toLowerCase();
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
  if (!column.original) return false;
  return !structureCapabilities.value.alterPrimaryKey;
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
  return generateUniqueIndexName(structureIndexTableName(), columnsForName, existingIndexNamesForDraft(index));
}

function refreshAutoIndexName(index: EditableStructureIndex, previousColumns = index.columns) {
  if (index.original || index.nameEdited) return;
  const previousName = generateIndexName(structureIndexTableName(), previousColumns);
  const previousUniqueName = generateUniqueIndexName(structureIndexTableName(), previousColumns, existingIndexNamesForDraft(index));
  const currentName = index.name.trim();
  if (currentName && currentName !== previousName && currentName !== previousUniqueName) return;
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
const filteredColumnNames = computed(() => {
  const q = colSearch.value.toLowerCase().trim();
  if (!q) return availableColumnNames.value;
  return availableColumnNames.value.filter((c) => c.toLowerCase().includes(q));
});

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
  return !triggersLoading.value && canEditTriggers.value && !trigger.markedForDrop;
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
  if (!previewSqlText.value.trim()) return;
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
  const damengLengthUnitsAfterSave = new Map<string, string>();
  if (databaseType.value === "dameng") {
    for (const column of columns.value) {
      if (!column.markedForDrop && dataTypeLengthUnitValue("dameng", column.dataType)) {
        damengLengthUnitsAfterSave.set(column.name.trim().toLowerCase(), column.dataType);
      }
    }
  }
  const startedAt = Date.now();
  try {
    const result = hasSqliteTypeChange.value
      ? await api.applySqliteTableStructureChange(props.connectionId, props.database, structureChangeOptions(), sqliteSchemaRevision.value!)
      : await api.executeBatch(props.connectionId, props.database, pendingStatements.value, props.schema, queryTimeoutSecsForConnection(connection));
    await recordStructureHistory(sql, startedAt, true, result);
    toast(t("structureEditor.saved"), 2500);
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
      await refreshStructureAfterSave(refreshScope, damengLengthUnitsAfterSave);
    }
    return true;
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
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

function onStructureEditorKeydown(event: KeyboardEvent) {
  if (isPlainModShortcut(event, "f")) {
    event.preventDefault();
    event.stopPropagation();
    if (activeTab.value === "columns") focusColumnSearch();
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
}

function unregisterStructureEditorShortcuts() {
  if (!keydownListenerRegistered) return;
  keydownListenerRegistered = false;
  window.removeEventListener("keydown", onStructureEditorKeydown);
  document.removeEventListener("pointerdown", onStructureDensityDocumentPointerdown, true);
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
    void hydrateRestoredDraftFromDatabase().then(() => applyInitialStructureTarget());
  } else if (isCreateMode.value) {
    markDraftHydratedAndSync();
  } else {
    void loadStructure(false, visibleTableStructureRefreshScope(activeTab.value), true, { blockSecondaryMetadata: true }).then(() => applyInitialStructureTarget());
  }
});

onActivated(() => {
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (props.draft?.initialized && !draftHydrated) {
    restoreDraft(props.draft);
    applyInitialStructureTarget();
    void hydrateRestoredDraftFromDatabase().then(() => applyInitialStructureTarget());
  }
  restoreStructureScrollPosition();
});
onDeactivated(unregisterStructureEditorShortcuts);
onBeforeUnmount(() => {
  stopColumnDragTracking();
  unregisterStructureEditorShortcuts();
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
  [isCreateMode, () => props.connectionId, () => props.database, databaseType, () => props.schema, () => props.tableName, newTableName, tableComment, columns, indexes, foreignKeys, triggers],
  () => {
    scheduleSqlPreviewRefresh();
    syncDraftToParent();
  },
  { deep: true, immediate: true },
);

watch(activeTab, () => {
  selectedColumnId.value = null;
  highlightedColumnId.value = null;
  highlightedIndexId.value = null;
  restoreStructureScrollPosition();
  syncDraftToParent();
});

async function loadTriggersIfNeeded() {
  if (
    !shouldLoadTableStructureTriggers({
      activeTab: activeTab.value,
      isCreateMode: isCreateMode.value,
      supported: tableMetadataCapabilities.value.triggers,
      loaded: triggersLoaded.value,
      loading: triggersLoading.value,
      structureLoading: loading.value,
    })
  )
    return;
  await loadStructure(true, TRIGGERS_ONLY_REFRESH_SCOPE, true, { blockSecondaryMetadata: true, preserveDraft: true });
}

watch([activeTab, loading], () => {
  void loadTriggersIfNeeded();
});

watch(
  columns,
  (items) => {
    if (selectedColumnId.value && !items.some((column) => column.id === selectedColumnId.value)) {
      selectedColumnId.value = null;
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
  void loadStructure(true, visibleTableStructureRefreshScope(activeTab.value));
});

watch(
  activeTab,
  (tab) => {
    if (tab === "ddl") {
      void fetchDdl();
    }
  },
  { immediate: true },
);

watch([activeTab, ddlLoading], ([tab, loading]) => {
  if (tab === "ddl" && !loading) {
    void nextTick(() => {
      ddlPreRef.value?.focus();
    });
  }
});
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="localStructureDensity" :style="structureDensityStyle">
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <Database :class="[structureIconClass, 'text-muted-foreground']" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t("editor.noDatabase") }}</span>
      <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
      <Button v-if="!isCreateMode" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="loading || saving" @click="reloadStructureFromDatabase">
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
              <Button v-if="activeTab === 'columns'" size="sm" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="addColumn">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addColumn") }}
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

          <TabsContent ref="columnsScrollerRef" v-if="tableMetadataCapabilities.columns" value="columns" class="m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('columns', $event)">
            <table class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: visibleColWidths.reduce((a, w) => a + w, 0) + 'px' }">
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
                    {{ columnLabel.label }}
                    <div v-if="i < colLabels.length - 1" class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30" :class="colResizing?.col === columnWidthIndex(i) ? 'bg-primary/30' : ''" @mousedown="onColResize($event, i)" />
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(column, index) in columns"
                  :key="column.id"
                  :class="columnRowClass(column, index)"
                  :data-new-column-row="!column.original ? 'true' : undefined"
                  :data-column-row-index="index"
                  :data-column-id="column.id"
                  @click="onColumnRowActivate(column)"
                  @focusin="onColumnRowActivate(column)"
                  @dragover="onColumnDragOver(index, $event)"
                  @drop="onColumnDrop(index, $event)"
                >
                  <td :class="[structureCellClass, 'text-muted-foreground']">
                    <div class="flex items-center gap-1">
                      <span>{{ index + 1 }}</span>
                      <KeyRound v-if="column.isPrimaryKey" :class="[structureIconClass, 'text-amber-500']" />
                    </div>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="column.name" :class="[structureControlClass, columnSearchFieldClass(column, column.name)]" :disabled="isColumnNameDisabled(column)" data-column-name-input />
                  </td>
                  <td :class="structureCellClass">
                    <SearchableSelect
                      v-if="!isColumnTypeDisabled(column)"
                      :model-value="splitDataType(column.dataType).baseType"
                      :options="dataTypeOptions"
                      :placeholder="t('structureEditor.typePlaceholder')"
                      :search-placeholder="t('structureEditor.typePlaceholder')"
                      :empty-text="t('structureEditor.noMatchingType')"
                      :loading-text="t('common.loading')"
                      :allow-custom="true"
                      :option-tooltip="dataTypeTooltip"
                      :trigger-class="[structureMonoControlClass, 'w-full']"
                      @update:model-value="(v: string) => updateColumnDataType(column, v)"
                    />
                    <Input v-else :model-value="splitDataType(column.dataType).baseType" :class="[structureMonoControlClass, 'w-full']" disabled />
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
                          class="h-[var(--structure-control-height)] w-16 shrink-0 rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25"
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
                      :trigger-class="[structureMonoControlClass, 'w-20']"
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
                      :trigger-class="[structureMonoControlClass, 'w-28']"
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
                          <input v-model="column.extra.autoIncrement" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" />
                          <span>{{ t("structureEditor.autoIncrement") }}</span>
                        </label>
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
                            :disabled="!canEditDamengIdentity(column)"
                            @update:model-value="(v) => updateDamengIdentitySeed(column, v)"
                          />
                          <Input
                            :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                            type="number"
                            :class="[structureControlClass, 'w-14']"
                            :placeholder="t('structureEditor.identityIncrement')"
                            :disabled="!canEditDamengIdentity(column)"
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
                          <SelectTrigger class="h-[var(--structure-control-height)] w-28 rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
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
                  <td :class="structureLastCellClass">
                    <div class="flex min-w-0 items-center justify-start gap-0.5">
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
                      <Button
                        v-if="column.original"
                        variant="ghost"
                        size="icon"
                        :class="structureActionButtonClass"
                        :disabled="!canDropColumn(column)"
                        :title="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        :aria-label="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        @click.stop="toggleDropColumn(column)"
                      >
                        <RefreshCw v-if="column.markedForDrop" :class="structureIconClass" />
                        <Trash2 v-else :class="structureIconClass" />
                      </Button>
                      <Button v-else variant="ghost" size="icon" :class="structureActionButtonClass" :title="t('structureEditor.remove')" :aria-label="t('structureEditor.remove')" @click.stop="removeNewColumn(column)">
                        <X :class="structureIconClass" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent ref="indexesScrollerRef" v-if="tableMetadataCapabilities.indexes" value="indexes" class="m-0 min-h-0 flex-1 overflow-auto p-0" @scroll.passive="onStructureContentScroll('indexes', $event)">
            <div v-if="indexesLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <table v-else class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: indexColWidths.reduce((a, w) => a + w, 0) + 'px' }">
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
                        <DropdownMenuCheckboxItem v-for="col in filteredColumnNames" :key="col" :checked="index.columns.includes(col)" :class="index.columns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIndexColumn(index, col)">
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
                      <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-[6px] px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
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
                        <DropdownMenuCheckboxItem v-for="col in filteredColumnNames" :key="col" :checked="index.includedColumns.includes(col)" :class="index.includedColumns.includes(col) ? 'bg-primary/10' : ''" @select.prevent @click="toggleIncludedColumn(index, col)">
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

          <TabsContent ref="foreignKeysScrollerRef" v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('foreignKeys', $event)">
            <div v-if="foreignKeysLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
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

          <TabsContent ref="triggersScrollerRef" v-if="tableMetadataCapabilities.triggers" value="triggers" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]" @scroll.passive="onStructureContentScroll('triggers', $event)">
            <div v-if="triggersLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
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
              <Button v-if="ddlContent" variant="outline" size="sm" class="absolute right-3 top-3 z-10 h-7 gap-1 px-2" :title="t('grid.copyDdl')" @click="copyDdlContent">
                <Copy class="h-3.5 w-3.5" />
                {{ t("grid.copyDdl") }}
              </Button>
              <pre ref="ddlPreRef" tabindex="0" class="m-0 min-h-0 flex-1 whitespace-pre p-3 font-mono text-xs leading-5 select-text outline-none" v-html="ddlContent ? (sqlHighlighter?.(ddlContent) ?? ddlContent) : t('structureEditor.emptyReadonly')" @keydown="onDdlKeydown"></pre>
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <div :class="['flex min-w-0 shrink-0 flex-col overflow-hidden rounded-md border', sqlPreviewCollapsed ? '' : 'h-[28%] min-h-40 max-h-64']">
        <div class="flex shrink-0 items-center justify-between border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] font-medium">
          <div class="flex items-center gap-1.5">
            <span>{{ t("structureEditor.sqlPreview") }}</span>
            <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" class="h-4 px-1 text-[10px]">
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
            <Button variant="ghost" :class="structureToolbarButtonClass" :disabled="!previewSqlText.trim()" @click="copyPreviewSql">
              <Copy :class="[structureIconClass, 'mr-1']" />
              {{ t("structureEditor.copySql") }}
            </Button>
            <Badge variant="secondary">
              <Loader2 v-if="sqlPreviewLoading" class="h-3 w-3 animate-spin" />
              <span v-else>{{ pendingStatements.length }}</span>
            </Badge>
          </div>
        </div>
        <div v-if="!sqlPreviewCollapsed" class="min-h-0 flex-1 overflow-auto p-2.5">
          <div v-if="hasSqliteTypeChange" class="mb-2 flex gap-1.5 rounded-md border border-blue-300/40 bg-blue-500/10 px-[var(--structure-cell-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] text-blue-700 dark:text-blue-300">
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
  </div>
</template>

<style scoped>
/* --primary is rgb/oklch; use color-mix like DataGrid, not hsl(var(--primary)). */
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
