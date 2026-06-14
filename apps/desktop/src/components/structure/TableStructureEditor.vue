<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Database, Info, KeyRound, Loader2, Maximize2, Plus, RefreshCw, Save, SlidersHorizontal, Trash2, X } from "@lucide/vue";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { queryTimeoutSecsForConnection } from "@/lib/queryTimeout";
import { type EditableStructureColumn, type EditableStructureForeignKey, type EditableStructureIndex, type EditableStructureTrigger } from "@/lib/tableStructureEditorSql";
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
  generateIndexName,
  generateUniqueIndexName,
  getColumnEditorControls,
  getDataTypeOptions,
  getDefaultLengthForType,
  isProtectedManticoreIdColumn,
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
}>();

const activeTab = ref("columns");
const loading = ref(false);
const saving = ref(false);
const sqlPreviewLoading = ref(false);
const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlFetched = ref(false);

async function fetchDdl() {
  if (!props.connectionId || !props.database || !props.tableName || ddlFetched.value || !tableMetadataCapabilities.value.ddl) return;
  ddlLoading.value = true;
  try {
    ddlContent.value = await api.getTableDdl(props.connectionId, props.database, metadataSchema.value, props.tableName);
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
    columns: [28, 120, 136, 82, 60, 52, 108, 124, 128, 108],
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
    columns: [32, 144, 160, 104, 72, 64, 128, 152, 152, 136],
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
    columns: [36, 168, 188, 116, 84, 76, 152, 188, 176, 148],
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
const structureDensityMetric = computed(() => metricsForDensity(structureDensity.value));
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
const structureControlClass = "h-[var(--structure-control-height)] min-w-0 px-[var(--structure-control-px)] py-0 text-[length:var(--structure-font-size)]";
const structureMonoControlClass = `${structureControlClass} font-mono`;
const structureToolbarButtonClass = "h-[var(--structure-control-height)] gap-1 px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]";
const structureIconButtonClass = "h-[var(--structure-control-height)] w-[var(--structure-control-height)]";
const structureIconClass = "h-[var(--structure-icon-size)] w-[var(--structure-icon-size)]";
const structureCheckboxClass = "h-[var(--structure-checkbox-size)] w-[var(--structure-checkbox-size)]";
const structureHeaderCellClass = "relative border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-left";
const structureCellClass = "border-b border-r px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";
const structureLastCellClass = "border-b px-[var(--structure-cell-px)] py-[var(--structure-cell-py)]";

function applyStructureDensityWidths(density: StructureEditorDensity) {
  const metric = metricsForDensity(density);
  colWidths.value = [...metric.columns];
  indexColWidths.value = [...metric.indexes];
}

function setStructureDensity(value: unknown) {
  if (!isStructureEditorDensity(value)) return;
  settingsStore.updateEditorSettings({ structureEditorDensity: value });
}

const initialDensityMetric = metricsForDensity(structureDensity.value);
const colWidths = ref([...initialDensityMetric.columns]);
const colResizing = ref<{ col: number; startX: number; startW: number } | null>(null);
const indexColWidths = ref([...initialDensityMetric.indexes]);
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);

watch(structureDensity, (density, previousDensity) => {
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
const dataTypeOptions = computed(() => getDataTypeOptions(databaseType.value));
const columnEditorControls = computed(() => getColumnEditorControls(databaseType.value));

const indexTypesByDb: Record<string, string[]> = {
  postgres: ["BTREE", "HASH", "GIST", "SPGIST", "GIN", "BRIN"],
  mysql: ["BTREE", "HASH", "FULLTEXT", "SPATIAL", "RTREE"],
  sqlserver: ["CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "NONCLUSTERED COLUMNSTORE", "XML", "SPATIAL"],
  oracle: ["NORMAL", "BITMAP", "FUNCTION-BASED NORMAL", "FUNCTION-BASED DOMAIN", "DOMAIN", "CLUSTER"],
  sqlite: ["BTREE"],
};
const indexTypeOptions = computed(() => (structureCapabilities.value.indexType ? (indexTypesByDb[structureDialect.value] ?? []) : []));

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
let keydownListenerRegistered = false;

async function refreshSqlPreview() {
  const requestId = ++sqlPreviewRequestId;
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

const canApply = computed(() => !loading.value && !saving.value && !sqlPreviewLoading.value && pendingStatements.value.length > 0 && warnings.value.length === 0 && !!props.connectionId && (isCreateMode.value ? !!newTableName.value.trim() : !!props.tableName));

function resetState() {
  activeTab.value = "columns";
  loading.value = false;
  saving.value = false;
  sqlPreviewLoading.value = false;
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

async function loadStructure(silent = false) {
  if (!props.connectionId || !props.database || !props.tableName) return;
  if (!silent) loading.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.connectionId);
    let nextColumns = await api.getColumns(props.connectionId, props.database, metadataSchema.value, props.tableName);
    if (databaseType.value === "manticoresearch" && tableMetadataCapabilities.value.ddl) {
      try {
        const ddl = await api.getTableDdl(props.connectionId, props.database, metadataSchema.value, props.tableName);
        ddlContent.value = ddl;
        ddlFetched.value = true;
        nextColumns = applyManticoreDdlColumnExtras(nextColumns, ddl);
      } catch {
        /* ignore — Manticore column properties can still come from SHOW COLUMNS when available */
      }
    }
    const [nextIndexes, nextForeignKeys, nextTriggers] = await Promise.all([
      tableMetadataCapabilities.value.indexes ? api.listIndexes(props.connectionId, props.database, metadataSchema.value, props.tableName).catch(() => []) : Promise.resolve([]),
      tableMetadataCapabilities.value.foreignKeys ? api.listForeignKeys(props.connectionId, props.database, metadataSchema.value, props.tableName).catch(() => []) : Promise.resolve([]),
      tableMetadataCapabilities.value.triggers ? api.listTriggers(props.connectionId, props.database, metadataSchema.value, props.tableName).catch(() => []) : Promise.resolve([]),
    ]);
    columns.value = createColumnDrafts(nextColumns, databaseType.value);
    indexes.value = createIndexDrafts(nextIndexes);
    foreignKeys.value = createForeignKeyDrafts(nextForeignKeys);
    triggers.value = createTriggerDrafts(nextTriggers);
    try {
      const tables = await api.listTables(props.connectionId, props.database, metadataSchema.value);
      const table = tables.find((t) => t.name.toLowerCase() === props.tableName!.toLowerCase() && t.table_type !== "VIEW");
      originalTableComment.value = table?.comment || "";
      tableComment.value = table?.comment || "";
    } catch {
      /* ignore — table comment is optional */
    }
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function addColumn() {
  if (!canAddColumn.value) return;
  activeTab.value = "columns";
  const dataType = databaseType.value === "manticoresearch" ? combineDataTypeForDatabase(databaseType.value, dataTypeOptions.value[0] ?? "text", getDefaultLengthForType(databaseType.value, dataTypeOptions.value[0] ?? "text")) : "varchar(255)";
  columns.value.push({
    id: `new:${uuid()}`,
    name: "",
    dataType,
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    extra: {},
    markedForDrop: false,
  });
  await nextTick();
  const newRows = rootRef.value?.querySelectorAll<HTMLElement>('[data-new-column-row="true"]');
  const row = newRows?.[newRows.length - 1];
  const input = row?.querySelector<HTMLInputElement>("[data-column-name-input]");
  row?.scrollIntoView({ block: "nearest" });
  input?.focus();
  input?.select();
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
}

function canMoveColumn(index: number, direction: -1 | 1): boolean {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= columns.value.length) return false;
  if (columns.value[index]?.markedForDrop || columns.value[targetIndex]?.markedForDrop) return false;
  return canShowColumnMoveControls.value;
}

const canShowColumnMoveControls = computed(() => isCreateMode.value || structureCapabilities.value.reorderColumn);

function moveColumn(index: number, direction: -1 | 1) {
  if (!canMoveColumn(index, direction)) return;
  const targetIndex = index + direction;
  const [column] = columns.value.splice(index, 1);
  if (!column) return;
  columns.value.splice(targetIndex, 0, column);
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
  if (isColumnTypeDisabled(column)) return true;
  if (databaseType.value !== "manticoresearch") return false;
  const baseType = splitDataType(column.dataType).baseType.trim().toLowerCase();
  return baseType !== "bit" && baseType !== "float_vector";
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
  if (!structureCapabilities.value.createIndex) return;
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
  return !!index.original && !index.isPrimary && structureCapabilities.value.dropIndex;
}

const canEditMysqlForeignKeys = computed(() => structureDialect.value === "mysql");
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
  if (!canEditMysqlForeignKeys.value) return;
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
  if (!foreignKey.original) return;
  foreignKey.markedForDrop = !foreignKey.markedForDrop;
}

function canEditForeignKeyDraft(foreignKey: EditableStructureForeignKey): boolean {
  return canEditMysqlForeignKeys.value && !foreignKey.markedForDrop;
}

function addTrigger() {
  if (!canEditMysqlTriggers.value) return;
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
  if (!trigger.original) return;
  trigger.markedForDrop = !trigger.markedForDrop;
}

function canEditTriggerDraft(trigger: EditableStructureTrigger): boolean {
  return canEditMysqlTriggers.value && !trigger.markedForDrop;
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
  const startedAt = Date.now();
  try {
    const connection = store.getConfig(props.connectionId);
    const timeoutSecs = queryTimeoutSecsForConnection(connection);
    const result = await api.executeBatch(props.connectionId, props.database, pendingStatements.value, props.schema, timeoutSecs);
    await recordStructureHistory(sql, startedAt, true, result);
    toast(t("structureEditor.saved"), 2500);
    emit("saved", tableComment.value !== originalTableComment.value);
    if (isCreateMode.value) {
      emit("close");
    } else {
      await loadStructure(true);
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
  if (activeTab.value === "foreignKeys" && canEditMysqlForeignKeys.value) {
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
}

function unregisterStructureEditorShortcuts() {
  if (!keydownListenerRegistered) return;
  keydownListenerRegistered = false;
  window.removeEventListener("keydown", onStructureEditorKeydown);
}

onMounted(() => {
  resetState();
  registerStructureEditorShortcuts();
  void loadStructure();
});

onActivated(() => {
  registerStructureEditorShortcuts();
  if (!isCreateMode.value) void loadStructure(true);
});
onDeactivated(unregisterStructureEditorShortcuts);
onBeforeUnmount(() => {
  unregisterStructureEditorShortcuts();
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

watch(
  [isCreateMode, databaseType, () => props.schema, () => props.tableName, newTableName, tableComment, columns, indexes, foreignKeys, triggers],
  () => {
    void refreshSqlPreview();
  },
  { deep: true, immediate: true },
);

watch([() => props.tableName, newTableName], () => {
  for (const index of indexes.value) {
    refreshAutoIndexName(index);
  }
});

watch(refreshVersion, (version, previous) => {
  if (version === previous || !version || isCreateMode.value) return;
  void loadStructure(true);
});

watch(activeTab, (tab) => {
  if (tab === "ddl") {
    void fetchDdl();
  }
});
</script>

<template>
  <div ref="rootRef" class="flex h-full min-h-0 flex-col gap-2 overflow-hidden p-[var(--structure-shell-padding)] text-[length:var(--structure-font-size)]" :data-structure-density="structureDensity" :style="structureDensityStyle">
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
                <Select :model-value="structureDensity" @update:model-value="setStructureDensity">
                  <SelectTrigger size="sm" class="h-[var(--structure-control-height)] w-[108px] rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]" :aria-label="t('structureEditor.density')">
                    <SelectValue :placeholder="t('structureEditor.density')" />
                  </SelectTrigger>
                  <SelectContent align="end" class="min-w-28">
                    <SelectItem v-for="option in structureDensityOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button v-if="activeTab === 'columns'" size="sm" :class="structureToolbarButtonClass" :disabled="!canAddColumn" @click="addColumn">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addColumn") }}
              </Button>
              <Button v-if="activeTab === 'indexes'" size="sm" :class="structureToolbarButtonClass" :disabled="!structureCapabilities.createIndex" @click="addIndex">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addIndex") }}
              </Button>
              <Button v-if="activeTab === 'foreignKeys'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditMysqlForeignKeys" @click="addForeignKey">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addForeignKey") }}
              </Button>
              <Button v-if="activeTab === 'triggers'" size="sm" :class="structureToolbarButtonClass" :disabled="!canEditMysqlTriggers" @click="addTrigger">
                <Plus :class="structureIconClass" />
                {{ t("structureEditor.addTrigger") }}
              </Button>
            </div>
          </div>

          <TabsContent v-if="tableMetadataCapabilities.columns" value="columns" class="m-0 min-h-0 flex-1 overflow-auto p-0">
            <table class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: visibleColWidths.reduce((a, w) => a + w, 0) + 'px' }">
              <thead class="sticky top-0 z-10 bg-background">
                <tr>
                  <th v-for="(columnLabel, i) in colLabels" :key="columnLabel.key" :class="[structureHeaderCellClass, { 'text-center': columnLabel.key === 'primaryKey' }]" :style="{ width: visibleColWidths[i] + 'px', minWidth: visibleColWidths[i] + 'px' }">
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
                    <Input :model-value="splitDataType(column.dataType).params" :class="structureMonoControlClass" :disabled="isColumnLengthDisabled(column)" @update:model-value="column.dataType = combineDataTypeForDatabase(databaseType, splitDataType(column.dataType).baseType, String($event))" />
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
                    <Input v-model="column.defaultValue" :class="structureMonoControlClass" :disabled="isColumnDefaultDisabled(column)" />
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
                            class="min-h-36 w-full resize-y rounded-md border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                            :placeholder="t('structureEditor.commentPlaceholder')"
                            :disabled="isColumnCommentDisabled(column)"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </td>
                  <td v-if="showExtendedProperties" :class="structureCellClass">
                    <div class="flex items-center gap-2">
                      <!-- Manticore Search: character data type properties -->
                      <template v-if="databaseType === 'manticoresearch'">
                        <template v-if="isManticoreTextColumn(column)">
                          <label class="flex items-center gap-1 whitespace-nowrap">
                            <input :checked="!!column.extra.manticoreIndexed" type="checkbox" :class="structureCheckboxClass" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreIndexed = ($event.target as HTMLInputElement).checked" />
                            indexed
                          </label>
                          <label class="flex items-center gap-1 whitespace-nowrap">
                            <input :checked="!!column.extra.manticoreStored" type="checkbox" :class="structureCheckboxClass" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreStored = ($event.target as HTMLInputElement).checked" />
                            stored
                          </label>
                          <label class="flex items-center gap-1 whitespace-nowrap">
                            <input :checked="!!column.extra.manticoreAttribute" type="checkbox" :class="structureCheckboxClass" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreAttribute = ($event.target as HTMLInputElement).checked" />
                            attribute
                          </label>
                        </template>
                        <template v-else-if="isManticoreJsonColumn(column)">
                          <label class="flex items-center gap-1 whitespace-nowrap">
                            <input :checked="!!column.extra.manticoreSecondaryIndex" type="checkbox" :class="structureCheckboxClass" :disabled="isManticoreColumnPropertyDisabled(column)" @change="column.extra.manticoreSecondaryIndex = ($event.target as HTMLInputElement).checked" />
                            secondary_index
                          </label>
                        </template>
                      </template>
                      <!-- MySQL: AUTO_INCREMENT + ON UPDATE CURRENT_TIMESTAMP -->
                      <template v-else-if="structureDialect === 'mysql'">
                        <label class="flex items-center gap-1 whitespace-nowrap">
                          <input v-model="column.extra.autoIncrement" type="checkbox" :class="structureCheckboxClass" />
                          {{ t("structureEditor.autoIncrement") }}
                        </label>
                        <label class="flex items-center gap-1 whitespace-nowrap">
                          <input v-model="column.extra.onUpdateCurrentTimestamp" type="checkbox" :class="structureCheckboxClass" />
                          {{ t("structureEditor.onUpdateCurrentTimestamp") }}
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
                          <SelectTrigger class="h-[var(--structure-control-height)] w-28 rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
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
                        <label class="flex items-center gap-1 whitespace-nowrap">
                          <input v-model="column.extra.autoIncrement" type="checkbox" :class="structureCheckboxClass" />
                          {{ t("structureEditor.identity") }}
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
                    <div class="flex items-center gap-1">
                      <template v-if="canShowColumnMoveControls">
                        <Button variant="ghost" size="icon" :class="structureIconButtonClass" :disabled="!canMoveColumn(index, -1)" :title="t('structureEditor.moveColumnUp')" :aria-label="t('structureEditor.moveColumnUp')" @click="moveColumn(index, -1)">
                          <ChevronUp :class="structureIconClass" />
                        </Button>
                        <Button variant="ghost" size="icon" :class="structureIconButtonClass" :disabled="!canMoveColumn(index, 1)" :title="t('structureEditor.moveColumnDown')" :aria-label="t('structureEditor.moveColumnDown')" @click="moveColumn(index, 1)">
                          <ChevronDown :class="structureIconClass" />
                        </Button>
                      </template>
                      <Button v-if="column.original" variant="ghost" size="sm" :class="structureToolbarButtonClass" :disabled="!canDropColumn(column)" @click="toggleDropColumn(column)">
                        <Trash2 :class="structureIconClass" />
                        {{ column.markedForDrop ? t("structureEditor.restore") : t("structureEditor.drop") }}
                      </Button>
                      <Button v-else variant="ghost" size="sm" :class="structureToolbarButtonClass" @click="removeNewColumn(column)">
                        <X :class="structureIconClass" />
                        {{ t("structureEditor.remove") }}
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </TabsContent>

          <TabsContent v-if="tableMetadataCapabilities.indexes" value="indexes" class="m-0 min-h-0 flex-1 overflow-auto p-0">
            <table class="border-separate border-spacing-0 text-[length:var(--structure-font-size)] leading-[var(--structure-line-height)]" :style="{ minWidth: indexColWidths.reduce((a, w) => a + w, 0) + 'px' }">
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
                      <SelectTrigger class="h-[var(--structure-control-height)] w-full rounded-md px-[var(--structure-control-px)] font-mono text-[length:var(--structure-font-size)]">
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
            <div v-if="foreignKeys.length === 0" class="py-10 text-center text-muted-foreground">
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
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
                      <SelectValue :placeholder="t('structureEditor.onDelete')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="action in foreignKeyActionOptions" :key="`delete-${action || 'default'}`" :value="action || '__default'">{{ action || t("structureEditor.defaultAction") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select :model-value="fk.onUpdate || '__default'" :disabled="!canEditForeignKeyDraft(fk)" @update:model-value="(v: any) => (fk.onUpdate = String(v === '__default' ? '' : (v ?? '')))">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
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
            <div v-if="triggers.length === 0" class="py-10 text-center text-muted-foreground">
              {{ t("structureEditor.emptyReadonly") }}
            </div>
            <div v-else class="space-y-1.5">
              <div v-for="trigger in triggers" :key="trigger.id" class="rounded-md border px-[var(--structure-cell-px)] py-[var(--structure-header-py)] text-[length:var(--structure-font-size)]" :class="trigger.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                <div class="grid grid-cols-[minmax(140px,1fr)_110px_110px_auto] gap-1.5">
                  <Input v-model="trigger.name" :class="structureControlClass" :placeholder="t('structureEditor.triggerName')" :disabled="!canEditTriggerDraft(trigger)" />
                  <Select v-model="trigger.timing" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="timing in triggerTimingOptions" :key="timing" :value="timing">{{ timing }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select v-model="trigger.event" :disabled="!canEditTriggerDraft(trigger)">
                    <SelectTrigger class="h-[var(--structure-control-height)] rounded-md px-[var(--structure-control-px)] text-[length:var(--structure-font-size)]">
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
                  class="mt-1.5 min-h-28 w-full resize-y rounded-md border bg-background px-[var(--structure-control-px)] py-[var(--structure-cell-py)] font-mono text-[length:var(--structure-font-size)] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
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
