<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Database, Info, KeyRound, Loader2, Maximize2, Plus, RefreshCw, Save, Settings, SlidersHorizontal, Trash2, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore, type StructureEditorDensity } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { type SqlHighlighter, createShikiSqlHighlighter } from "@/lib/sqlHighlighter";
import { copyToClipboard } from "@/lib/clipboard";
import { formatSqlForDisplay, sqlFormatDialectForDbType } from "@/lib/sqlFormatter";
import { queryTimeoutSecsForConnection } from "@/lib/queryTimeout";
import { type EditableStructureColumn, type EditableStructureForeignKey, type EditableStructureIndex, type EditableStructureTrigger } from "@/lib/tableStructureEditorSql";
import { PRESET_FIELDS_TEMPLATE_ID, createTableColumnTemplateDrafts } from "@/lib/tableColumnTemplates";
import { getTableMetadataCapabilities } from "@/lib/tableMetadataCapabilities";
import { canAddTableStructureColumn, getTableStructureCapabilities } from "@/lib/tableStructureCapabilities";
import { connectionObjectTreeQuerySchema, tableStructureDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import {
  buildStructureTargetLabel,
  combineDataTypeForDatabase,
  createColumnDrafts,
  createForeignKeyDrafts,
  createIndexDrafts,
  createTriggerDrafts,
  dataTypeLengthInputValue,
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  getDefaultLengthForType,
  isDataTypeLengthDisabled,
  isProtectedManticoreIdColumn,
  parseExtraToColumnExtra,
  splitDataType,
  toColumnNames,
  applyManticoreDdlColumnExtras,
  canEditManticoreColumnProperties,
} from "@/lib/tableStructureEditorState";
import * as api from "@/lib/api";

const { t } = useI18n();
const { isDark } = useTheme();
const store = useConnectionStore();
const queryStore = useQueryStore();
const historyStore = useHistoryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const rootRef = ref<HTMLElement>();
const dynamicDataTypeOptionsCache = new Map<string, string[]>();

const sqlHighlighter = ref<SqlHighlighter>();
onMounted(async () => {
  sqlHighlighter.value = await createShikiSqlHighlighter({
    appearance: () => (isDark.value ? "dark" : "light"),
  });
});

const highlightedSql = computed(() => {
  if (!pendingStatements.value.length) return "";
  const sql = pendingStatements.value.join("\n");
  return sqlHighlighter.value?.(sql) ?? sql;
});
const previewSqlText = computed(() => pendingStatements.value.join("\n"));

const props = defineProps<{
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}>();

const emit = defineEmits<{
  saved: [commentChanged: boolean];
  close: [];
  openSettings: [initialTab?: string, initialSection?: string];
}>();

const activeTab = ref("columns");
const loading = ref(false);
const saving = ref(false);
const postSaveRefreshing = ref(false);
const sqlPreviewLoading = ref(false);
const indexesLoading = ref(false);
const foreignKeysLoading = ref(false);
const triggersLoading = ref(false);
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlFetched = ref(false);

async function fetchDdl() {
  if (!props.connectionId || !props.database || !props.tableName || ddlFetched.value || !tableMetadataCapabilities.value.ddl) return;
  ddlLoading.value = true;
  try {
    const ddl = await api.getTableDdl(props.connectionId, props.database, metadataSchema.value, props.tableName);
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
const foreignKeys = ref<EditableStructureForeignKey[]>([]);
const triggers = ref<EditableStructureTrigger[]>([]);
const secondaryMetadataLoading = computed(() => indexesLoading.value || foreignKeysLoading.value || triggersLoading.value);

interface StructureRefreshScope {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  tableComment: boolean;
}

const FULL_STRUCTURE_REFRESH_SCOPE: StructureRefreshScope = {
  columns: true,
  indexes: true,
  foreignKeys: true,
  triggers: true,
  tableComment: true,
};

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
    column.originalPosition !== index ||
    column.name !== original.name ||
    column.dataType !== original.data_type ||
    column.isNullable !== original.is_nullable ||
    !sameText(column.defaultValue, original.column_default) ||
    !sameText(column.comment, original.comment) ||
    column.isPrimaryKey !== original.is_primary_key ||
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

function captureStructureRefreshScope(): StructureRefreshScope {
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
const structureDensityMetrics: Record<
  StructureEditorDensity,
  {
    columns: number[];
    indexes: number[];
    minColumnWidth: number;
    minIndexColumnWidth: number;
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
    columns: [28, 120, 136, 82, 60, 52, 108, 124, 144, 108],
    indexes: [120, 180, 60, 88, 124, 144, 120, 70],
    minColumnWidth: 24,
    minIndexColumnWidth: 48,
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
    columns: [32, 144, 160, 104, 72, 64, 128, 152, 160, 136],
    indexes: [148, 224, 72, 108, 148, 180, 148, 84],
    minColumnWidth: 28,
    minIndexColumnWidth: 60,
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
    columns: [36, 168, 188, 116, 84, 76, 152, 188, 188, 148],
    indexes: [176, 260, 84, 124, 176, 216, 176, 104],
    minColumnWidth: 32,
    minIndexColumnWidth: 64,
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
  const metric = metricsForDensity(density);
  colWidths.value = [...metric.columns];
  indexColWidths.value = [...metric.indexes];
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

const initialDensityMetric = metricsForDensity(structureDensity.value);
const colWidths = ref([...initialDensityMetric.columns]);
const colResizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const indexColWidths = ref([...initialDensityMetric.indexes]);
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);

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
});

function onColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  const widthIndex = columnWidthIndex(col);
  colResizing.value = { col: widthIndex, startX: e.clientX, startW: colWidths.value[widthIndex] };
  const onMove = (ev: MouseEvent) => {
    if (!colResizing.value) return;
    const delta = ev.clientX - colResizing.value.startX;
    colWidths.value[widthIndex] = Math.max(structureDensityMetric.value.minColumnWidth, colResizing.value.startW + delta);
  };
  const onUp = () => {
    colResizing.value = null;
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
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const connection = computed(() => (props.connectionId ? store.getConfig(props.connectionId) : undefined));
const databaseType = computed(() => tableStructureDatabaseTypeForConnection(connection.value));
const structureCapabilities = computed(() => getTableStructureCapabilities(databaseType.value));
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
  return dt === "mysql" || dt === "manticoresearch" || isPostgresIdentityType(dt) || dt === "sqlserver";
});
const extendedPropertiesColumnIndex = 8;
const visibleColumnIndexes = computed(() => colLabels.value.map((column) => column.widthIndex));
const visibleColWidths = computed(() => visibleColumnIndexes.value.map((index) => colWidths.value[index] ?? structureDensityMetric.value.minColumnWidth));

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
  if (showExtendedProperties.value) {
    labels.push({ key: "extendedProperties", label: t("structureEditor.extendedProperties"), widthIndex: extendedPropertiesColumnIndex });
  }
  labels.push({ key: "actions", label: t("structureEditor.actions"), widthIndex: 9 });
  return labels;
});
const indexColLabels = computed(() => [t("structureEditor.indexName"), t("structureEditor.indexColumns"), t("structureEditor.unique"), t("structureEditor.indexType"), t("structureEditor.includedColumns"), t("structureEditor.filter"), t("structureEditor.comment"), t("structureEditor.actions")]);
const foreignKeyActionOptions = ["", "CASCADE", "SET NULL", "RESTRICT", "NO ACTION"];
const triggerTimingOptions = ["BEFORE", "AFTER"];
const triggerEventOptions = ["INSERT", "UPDATE", "DELETE"];
const metadataSchema = computed(() => connectionObjectTreeQuerySchema(connection.value, props.database, props.schema));
const refreshVersion = computed(() => (props.connectionId && props.tableName ? queryStore.tableStructureRefreshVersion(props.connectionId, props.database, props.schema, props.tableName) : 0));
const isCreateMode = computed(() => !props.tableName);
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
  if (!hasPendingStructureChanges()) {
    clearSqlPreviewState();
    return;
  }
  if (!isCreateMode.value && secondaryMetadataLoading.value) {
    if (sqlPreviewDebounceTimer) {
      clearTimeout(sqlPreviewDebounceTimer);
      sqlPreviewDebounceTimer = undefined;
    }
    deferredSqlPreviewRefresh = true;
    sqlPreviewLoading.value = true;
    return;
  }
  deferredSqlPreviewRefresh = false;
  if (sqlPreviewDebounceTimer) clearTimeout(sqlPreviewDebounceTimer);
  sqlPreviewDebounceTimer = setTimeout(() => {
    sqlPreviewDebounceTimer = undefined;
    void refreshSqlPreview();
  }, 80);
}

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
  if (!hasPendingStructureChanges()) {
    pendingStatements.value = [];
    warnings.value = [];
    sqlPreviewLoading.value = false;
    return;
  }
  sqlPreviewLoading.value = true;
  const options = {
    databaseType: databaseType.value,
    schema: props.schema,
    tableName: isCreateMode.value ? newTableName.value : props.tableName || "",
    columns: columns.value,
    indexes: indexes.value,
    foreignKeys: foreignKeys.value,
    triggers: triggers.value,
    tableComment: tableComment.value,
    originalTableComment: isCreateMode.value ? undefined : originalTableComment.value,
  };
  try {
    const result = isCreateMode.value ? await api.buildCreateTableSql(options) : await api.buildTableStructureChangeSql(options);
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = result.statements;
    warnings.value = result.warnings;
  } catch (e: any) {
    if (requestId !== sqlPreviewRequestId) return;
    pendingStatements.value = [];
    warnings.value = [e?.message || String(e)];
  } finally {
    if (requestId === sqlPreviewRequestId) sqlPreviewLoading.value = false;
  }
}

const canApply = computed(
  () => !loading.value && !saving.value && !postSaveRefreshing.value && !secondaryMetadataLoading.value && !sqlPreviewLoading.value && pendingStatements.value.length > 0 && warnings.value.length === 0 && !!props.connectionId && (isCreateMode.value ? !!newTableName.value.trim() : !!props.tableName),
);

function resetState() {
  activeTab.value = "columns";
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
  foreignKeys.value = [];
  triggers.value = [];
  ddlContent.value = "";
  ddlFetched.value = false;
  newTableName.value = "";
  tableComment.value = "";
  originalTableComment.value = "";
}

function setSecondaryMetadataLoading(scope: StructureRefreshScope, value: boolean) {
  if (scope.indexes && tableMetadataCapabilities.value.indexes) indexesLoading.value = value;
  if (scope.foreignKeys && tableMetadataCapabilities.value.foreignKeys) foreignKeysLoading.value = value;
  if (scope.triggers && tableMetadataCapabilities.value.triggers) triggersLoading.value = value;
}

async function fetchTableCommentValue(connectionId: string, database: string, schema: string, tableName: string): Promise<string | undefined> {
  try {
    return (await api.getTableComment(connectionId, database, schema, tableName)) || "";
  } catch {
    try {
      const tables = await api.listTables(connectionId, database, schema);
      const table = tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase() && t.table_type !== "VIEW");
      return table?.comment || "";
    } catch {
      return undefined;
    }
  }
}

async function loadStructure(silent = false, scope: StructureRefreshScope = FULL_STRUCTURE_REFRESH_SCOPE, showErrors = true, options: { blockSecondaryMetadata?: boolean } = {}) {
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = metadataSchema.value;
  const tableName = props.tableName;
  if (!connectionId || !database || !tableName) return;
  const requestId = ++structureLoadRequestId;
  if (!silent) loading.value = true;
  setSecondaryMetadataLoading(scope, true);
  errorMessage.value = "";
  let secondaryMetadataScheduled = false;
  try {
    await store.ensureConnected(connectionId);

    const columnsPromise = scope.columns ? api.getColumns(connectionId, database, schema, tableName) : Promise.resolve(undefined);
    const indexesPromise = scope.indexes ? (tableMetadataCapabilities.value.indexes ? api.listIndexes(connectionId, database, schema, tableName).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const foreignKeysPromise = scope.foreignKeys ? (tableMetadataCapabilities.value.foreignKeys ? api.listForeignKeys(connectionId, database, schema, tableName).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const triggersPromise = scope.triggers ? (tableMetadataCapabilities.value.triggers ? api.listTriggers(connectionId, database, schema, tableName).catch(() => []) : Promise.resolve([])) : Promise.resolve(undefined);
    const tableCommentPromise = scope.tableComment && structureCapabilities.value.comment ? fetchTableCommentValue(connectionId, database, schema, tableName) : Promise.resolve(undefined);

    let nextColumns = await columnsPromise;
    if (nextColumns) {
      if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
        try {
          const ddl = await api.getTableDdl(connectionId, database, schema, tableName);
          ddlContent.value = await formatSqlForDisplay(ddl, sqlFormatDialectForDbType(databaseType.value), settingsStore.editorSettings.sqlFormatter);
          ddlFetched.value = true;
          nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
        } catch {
          /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
        }
      }
      columns.value = createColumnDrafts(nextColumns, databaseType.value);
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
      if (nextTriggers) triggers.value = createTriggerDrafts(nextTriggers);
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
  }
}

async function refreshStructureAfterSave(scope: StructureRefreshScope) {
  try {
    await loadStructure(true, scope, false, { blockSecondaryMetadata: true });
  } catch (e) {
    console.warn("[DBX][structure-editor:post-save-refresh-failed]", e);
  } finally {
    postSaveRefreshing.value = false;
    if (activeTab.value === "ddl") void fetchDdl();
  }
}

async function addColumn() {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const dataType = databaseType.value === "manticoresearch" ? combineDataTypeForDatabase(databaseType.value, dataTypeOptions.value[0] ?? "text", getDefaultLengthForType(databaseType.value, dataTypeOptions.value[0] ?? "text")) : "varchar(255)";
  const column: EditableStructureColumn = {
    id: `new:${uuid()}`,
    name: "",
    dataType,
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    extra: {},
    markedForDrop: false,
  };
  columns.value.push(column);
  await nextTick();
  const newRows = rootRef.value?.querySelectorAll<HTMLElement>('[data-new-column-row="true"]');
  const row = newRows?.[newRows.length - 1];
  const input = row?.querySelector<HTMLInputElement>("[data-column-name-input]");
  row?.scrollIntoView({ block: "nearest" });
  input?.focus();
  input?.select();
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
  columns.value.push(...templateColumns);
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
}

function canMoveColumn(index: number, direction: -1 | 1): boolean {
  if (loading.value || saving.value) return false;
  if (!Number.isInteger(index) || (direction !== -1 && direction !== 1)) return false;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= columns.value.length) return false;
  if (columns.value[index]?.markedForDrop || columns.value[targetIndex]?.markedForDrop) return false;
  // Draft columns can always swap order among themselves —
  // ADD COLUMN statement order determines their final physical placement.
  if (!columns.value[index]?.original && !columns.value[targetIndex]?.original) return true;
  return canShowColumnMoveControls.value;
}

const canShowColumnMoveControls = computed(() => isCreateMode.value || structureCapabilities.value.reorderColumn);

function moveColumn(index: number, direction: -1 | 1) {
  if (!canMoveColumn(index, direction)) return;
  const targetIndex = index + direction;
  const nextColumns = [...columns.value];
  const [column] = nextColumns.splice(index, 1);
  if (!column) return;
  nextColumns.splice(targetIndex, 0, column);
  columns.value = nextColumns;
}

function toggleDropColumn(column: EditableStructureColumn) {
  if (!canDropColumn(column)) return;
  column.markedForDrop = !column.markedForDrop;
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

function isColumnNullableDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || column.isPrimaryKey || (!!column.original && !structureCapabilities.value.alterNullability);
}

function isColumnDefaultDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || (!!column.original && !structureCapabilities.value.alterDefault);
}

function isColumnCommentDisabled(column: EditableStructureColumn): boolean {
  return column.markedForDrop || !structureCapabilities.value.comment;
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
const canEditMysqlTriggers = computed(() => structureDialect.value === "mysql");

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
  if (!canEditMysqlTriggers.value || triggersLoading.value) return;
  activeTab.value = "triggers";
  triggers.value.push({
    id: `new:${uuid()}`,
    name: "",
    timing: "BEFORE",
    event: "INSERT",
    statement: "BEGIN\n  \nEND",
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
  return !triggersLoading.value && canEditMysqlTriggers.value && !trigger.markedForDrop;
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
      operation: primarySqlOperation(sql),
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

async function applyChanges() {
  if (!canApply.value || !props.connectionId || !props.database) return;
  saving.value = true;
  errorMessage.value = "";
  const sql = previewSqlText.value;
  const refreshScope = captureStructureRefreshScope();
  const startedAt = Date.now();
  try {
    const connection = store.getConfig(props.connectionId);
    const timeoutSecs = queryTimeoutSecsForConnection(connection);
    const result = await api.executeBatch(props.connectionId, props.database, pendingStatements.value, props.schema, timeoutSecs);
    await recordStructureHistory(sql, startedAt, true, result);
    toast(t("structureEditor.saved"), 2500);
    pendingStatements.value = [];
    warnings.value = [];
    ddlFetched.value = false;
    ddlContent.value = "";
    if (isCreateMode.value) {
      emit("saved", tableComment.value !== originalTableComment.value);
      emit("close");
    } else {
      saving.value = false;
      postSaveRefreshing.value = true;
      skipNextRefreshVersion = true;
      emit("saved", tableComment.value !== originalTableComment.value);
      void refreshStructureAfterSave(refreshScope);
    }
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
    await recordStructureHistory(sql, startedAt, false, undefined, errorMessage.value);
  } finally {
    saving.value = false;
  }
}

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
  if (activeTab.value === "triggers" && canEditMysqlTriggers.value) {
    addTrigger();
    return true;
  }
  return false;
}

function onStructureEditorKeydown(event: KeyboardEvent) {
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
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  void loadStructure();
});

onActivated(() => {
  registerStructureEditorShortcuts();
  void loadDynamicDataTypeOptions();
  if (!isCreateMode.value) void loadStructure(true);
});
onDeactivated(unregisterStructureEditorShortcuts);
onBeforeUnmount(() => {
  unregisterStructureEditorShortcuts();
  clearSqlPreviewState();
  persistStructureDensity();
});

function firstStructureMetadataTab(capabilities = tableMetadataCapabilities.value) {
  if (capabilities.columns) return "columns";
  if (capabilities.indexes) return "indexes";
  if (capabilities.foreignKeys) return "foreignKeys";
  if (capabilities.triggers) return "triggers";
  if (capabilities.ddl && !isCreateMode.value) return "ddl";
  return "columns";
}

watch(tableMetadataCapabilities, (capabilities) => {
  const supported =
    (activeTab.value === "columns" && capabilities.columns) ||
    (activeTab.value === "indexes" && capabilities.indexes) ||
    (activeTab.value === "foreignKeys" && capabilities.foreignKeys) ||
    (activeTab.value === "triggers" && capabilities.triggers) ||
    (activeTab.value === "ddl" && capabilities.ddl && !isCreateMode.value);
  if (!supported) activeTab.value = firstStructureMetadataTab(capabilities);
});

watch([() => props.connectionId, () => props.database, databaseType], () => {
  void loadDynamicDataTypeOptions();
});

watch(
  [isCreateMode, databaseType, () => props.schema, () => props.tableName, newTableName, tableComment, columns, indexes, foreignKeys, triggers],
  () => {
    scheduleSqlPreviewRefresh();
  },
  { deep: true, immediate: true },
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
  void loadStructure(true);
});

watch(activeTab, (tab) => {
  if (tab === "ddl") {
    void fetchDdl();
  }
});
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="localStructureDensity" :style="structureDensityStyle">
    <div class="flex shrink-0 items-center gap-2 rounded-md border bg-muted/20 px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]">
      <Database :class="[structureIconClass, 'text-muted-foreground']" />
      <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t("editor.noDatabase") }}</span>
      <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
      <Button v-if="!isCreateMode" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="loading || saving" @click="loadStructure()">
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
              <TabsTrigger v-if="tableMetadataCapabilities.columns" value="columns">{{ t("structureEditor.columns") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.indexes" value="indexes">{{ t("structureEditor.indexes") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys">{{ t("structureEditor.foreignKeys") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.triggers" value="triggers">{{ t("structureEditor.triggers") }}</TabsTrigger>
              <TabsTrigger v-if="tableMetadataCapabilities.ddl && !isCreateMode" value="ddl">DDL</TabsTrigger>
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
              <Button v-if="activeTab === 'indexes'" size="sm" :class="structureToolbarButtonClass" :disabled="!structureCapabilities.createIndex || indexesLoading" @click="addIndex">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addIndex") }}
              </Button>
              <Button v-if="activeTab === 'foreignKeys'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditForeignKeys || foreignKeysLoading" @click="addForeignKey">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addForeignKey") }}
              </Button>
              <Button v-if="activeTab === 'triggers'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditMysqlTriggers || triggersLoading" @click="addTrigger">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addTrigger") }}
              </Button>
            </div>
          </div>

          <TabsContent v-if="tableMetadataCapabilities.columns" value="columns" class="m-0 min-h-0 flex-1 overflow-auto p-0">
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
                <tr v-for="(column, index) in columns" :key="column.id" :class="column.markedForDrop ? 'bg-destructive/5 opacity-60' : ''" :data-new-column-row="!column.original ? 'true' : undefined">
                  <td :class="[structureCellClass, 'text-muted-foreground']">
                    <div class="flex items-center gap-1">
                      <span>{{ index + 1 }}</span>
                      <KeyRound v-if="column.isPrimaryKey" :class="[structureIconClass, 'text-amber-500']" />
                    </div>
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="column.name" :class="structureControlClass" :disabled="isColumnNameDisabled(column)" data-column-name-input />
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
                      :trigger-class="[structureMonoControlClass, 'w-full']"
                      @update:model-value="(v: string) => (column.dataType = combineDataTypeForDatabase(databaseType, v, getDefaultLengthForType(databaseType, v)))"
                    />
                    <Input v-else :model-value="splitDataType(column.dataType).baseType" :class="[structureMonoControlClass, 'w-full']" disabled />
                  </td>
                  <td v-if="columnEditorControls.length" :class="structureCellClass">
                    <Input
                      :model-value="dataTypeLengthInputValue(databaseType, column.dataType)"
                      :class="structureMonoControlClass"
                      :disabled="isColumnLengthDisabled(column)"
                      @update:model-value="column.dataType = combineDataTypeForDatabase(databaseType, splitDataType(column.dataType).baseType, String($event))"
                    />
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
                      <Input v-model="column.comment" :class="[structureControlClass, 'flex-1']" :disabled="isColumnCommentDisabled(column)" />
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
                        <label :class="structurePropertyLabelClass" :title="t('structureEditor.identity')">
                          <input v-model="column.extra.autoIncrement" type="checkbox" :class="[structureCheckboxClass, 'shrink-0']" />
                          <span class="min-w-0 truncate">{{ t("structureEditor.identity") }}</span>
                        </label>
                        <template v-if="column.extra.autoIncrement">
                          <Input
                            :model-value="column.extra.identity?.seed?.toString() ?? '1'"
                            type="number"
                            :class="[structureControlClass, 'w-14']"
                            :placeholder="t('structureEditor.identitySeed')"
                            @update:model-value="
                              (v) => {
                                if (!column.extra.identity) column.extra.identity = {};
                                column.extra.identity.seed = v ? Number(v) : undefined;
                              }
                            "
                          />
                          <Input
                            :model-value="column.extra.identity?.increment?.toString() ?? '1'"
                            type="number"
                            :class="[structureControlClass, 'w-14']"
                            :placeholder="t('structureEditor.identityIncrement')"
                            @update:model-value="
                              (v) => {
                                if (!column.extra.identity) column.extra.identity = {};
                                column.extra.identity.increment = v ? Number(v) : undefined;
                              }
                            "
                          />
                        </template>
                      </template>
                    </div>
                  </td>
                  <td :class="structureLastCellClass">
                    <div class="flex min-w-0 items-center justify-start gap-0.5 overflow-hidden">
                      <template v-if="canShowColumnMoveControls || !column.original">
                        <Button type="button" variant="ghost" size="icon" :class="structureActionButtonClass" :disabled="!canMoveColumn(index, -1)" :title="t('structureEditor.moveColumnUp')" :aria-label="t('structureEditor.moveColumnUp')" @click.stop.prevent="moveColumn(index, -1)">
                          <ChevronUp :class="structureIconClass" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" :class="structureActionButtonClass" :disabled="!canMoveColumn(index, 1)" :title="t('structureEditor.moveColumnDown')" :aria-label="t('structureEditor.moveColumnDown')" @click.stop.prevent="moveColumn(index, 1)">
                          <ChevronDown :class="structureIconClass" />
                        </Button>
                      </template>
                      <Button
                        v-if="column.original"
                        variant="ghost"
                        size="icon"
                        :class="structureActionButtonClass"
                        :disabled="!canDropColumn(column)"
                        :title="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        :aria-label="column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop')"
                        @click="toggleDropColumn(column)"
                      >
                        <RefreshCw v-if="column.markedForDrop" :class="structureIconClass" />
                        <Trash2 v-else :class="structureIconClass" />
                      </Button>
                      <Button v-else variant="ghost" size="icon" :class="structureActionButtonClass" :title="t('structureEditor.remove')" :aria-label="t('structureEditor.remove')" @click="removeNewColumn(column)">
                        <X :class="structureIconClass" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent v-if="tableMetadataCapabilities.indexes" value="indexes" class="m-0 min-h-0 flex-1 overflow-auto p-0">
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
                <tr v-for="index in indexes" :key="index.id" :class="index.markedForDrop ? 'bg-destructive/5 opacity-60' : ''" :data-new-index-row="!index.original ? 'true' : undefined">
                  <td :class="structureCellClass">
                    <Input :model-value="index.name" :class="structureControlClass" :disabled="!canEditIndexDraft(index)" data-index-name-input @update:model-value="(value: string | number) => onIndexNameInput(index, value)" />
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
                    <Input v-model="index.filter" :class="structureMonoControlClass" :placeholder="index.original?.filter || ''" :disabled="!canEditIndexFilter(index)" />
                  </td>
                  <td :class="structureCellClass">
                    <Input v-model="index.comment" :class="structureControlClass" :disabled="!canEditIndexComment(index)" />
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

          <TabsContent v-if="tableMetadataCapabilities.foreignKeys" value="foreignKeys" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]">
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

          <TabsContent v-if="tableMetadataCapabilities.triggers" value="triggers" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]">
            <div v-if="triggersLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="triggers.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="trigger in triggers" :key="trigger.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="trigger.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(140px,1fr)_110px_110px_auto] gap-1.5">
                  <Input v-model="trigger.name" :class="structureControlClass" :placeholder="t('structureEditor.triggerName')" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-model="trigger.timing" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-[6px] px-[var(--structure-control-px)] text-[length:var(--structure-font-size)] focus-visible:border-ring/50 focus-visible:ring-1 focus-visible:ring-ring/25">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="timing in triggerTimingOptions" :key="timing" :value="timing">{{ timing }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select v-model="trigger.event" :disabled="!canEditTriggerDraft(trigger)">
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

          <TabsContent v-if="tableMetadataCapabilities.ddl" value="ddl" class="m-0 min-h-0 flex-1 overflow-auto p-[var(--structure-cell-px)]">
            <div v-if="ddlLoading" class="flex items-center justify-center gap-2 py-10 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <pre v-else class="m-0 min-h-0 flex-1 whitespace-pre p-3 font-mono text-xs leading-5 select-text" v-html="ddlContent ? (sqlHighlighter?.(ddlContent) ?? ddlContent) : t('structureEditor.emptyReadonly')"></pre>
          </TabsContent>
        </Tabs>
      </div>

      <div class="flex h-[28%] min-h-40 min-w-0 max-h-64 shrink-0 flex-col overflow-hidden rounded-md border">
        <div class="flex shrink-0 items-center justify-between border-b px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)] font-medium">
          <div class="flex items-center gap-1.5">
            <span>{{ t("structureEditor.sqlPreview") }}</span>
            <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" class="h-4 px-1 text-[10px]">
              <Check class="h-3 w-3" />
              {{ t("structureEditor.ready") }}
            </Badge>
          </div>
          <div class="flex items-center gap-1.5">
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
        <div class="min-h-0 flex-1 overflow-auto p-2.5">
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
