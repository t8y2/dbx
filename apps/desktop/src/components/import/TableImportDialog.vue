<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, DatabaseBackup, FileCode, FileJson, FileSpreadsheet, FileText, FileUp, Loader2, Maximize2, Minimize2, Plus, RefreshCw, Square, Trash2, Upload, X } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import {
  autoMapImportColumns,
  buildTableImportParseOptions,
  defaultTableImportEmptyStringAsNull,
  formatTableImportPreviewCell,
  formatTableImportElapsed,
  nextTableImportWizardStep,
  previousTableImportWizardStep,
  requiredImportTargetColumns,
  resolveTableImportElapsed,
  suggestDataTypeForGenerator,
  suggestImportTargetDataTypes,
  TABLE_IMPORT_ENCODING_OPTIONS,
  TABLE_IMPORT_GENERATOR_OPTIONS,
  tableImportProgressPercent,
  type TableImportGeneratorKey,
  type TableImportWizardStep,
  validateImportMappings,
} from "@/lib/table/tableImport";
import { importPreviewInput, importSourceDisplayName, uploadedImportSourceFromPreview } from "@/lib/import/importSource";
import { getDataTypeOptions } from "@/lib/table/tableStructureEditorState";
import { uniqueKeyModelColumns } from "@/lib/table/tableEditing";
import { metadataSchemaForConnection, tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { schemaOptionsForConnection } from "@/composables/useSchemaOptions";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const store = useConnectionStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const minimized = ref(false);
const backgroundMode = ref(false);
const dialogDragOffset = ref({ x: 0, y: 0 });
const isDraggingDialog = ref(false);
let activeDialogDrag:
  | {
      pointerId: number;
      startX: number;
      startY: number;
      startLeft: number;
      startTop: number;
      width: number;
      height: number;
      offsetX: number;
      offsetY: number;
    }
  | undefined;
const dialogStyle = computed(() => ({
  transform: dialogDragOffset.value.x || dialogDragOffset.value.y ? `translate(${dialogDragOffset.value.x}px, ${dialogDragOffset.value.y}px)` : undefined,
  transition: isDraggingDialog.value ? "none" : undefined,
}));

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

type ImportTargetMode = "existing" | "create";
type ImportSource = string | File;
type SourceFormatCard = { value: api.TableImportSourceFormat | typeof NAVICAT_BACKUP_FORMAT; icon: any; labelKey: string; descriptionKey: string };

export interface GeneratedColumnItem {
  id: string;
  targetColumn: string;
  generator: TableImportGeneratorKey | string;
  targetDataType?: string;
}

interface BatchImportTask {
  id: string;
  selected: boolean;
  source: ImportSource;
  format: api.TableImportSourceFormat;
  sheetName: string;
  tableName: string;
  preview: api.TableImportPreview;
  columnMapping: Record<string, string>;
  columnGenerators: Record<string, string>;
  generatedColumns: GeneratedColumnItem[];
  columnDataTypes: Record<string, string>;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  rowsImported: number;
  rowsFailed: number;
  error?: string;
}

const SKIP_VALUE = "__skip__";
const NAVICAT_BACKUP_FORMAT = "nb3";
const NAVICAT_BACKUP_FILTER = { name: "Navicat backup", extensions: [NAVICAT_BACKUP_FORMAT] };
const NAVICAT_BACKUP_DATABASE_TYPES = new Set<DatabaseType>(["mysql", "postgres"]);
const TARGET_COLUMNS_TIMEOUT_MS = 15000;
const TARGET_COLUMNS_TIMEOUT = Symbol("target-columns-timeout");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TARGET_COLUMNS_TIMEOUT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const targetColumns = ref<ColumnInfo[]>([]);
const loadedTargetTableName = ref("");
const existingTableNames = ref<string[]>([]);
const selectedExistingTable = ref(props.prefillTable || "");
const targetMode = ref<ImportTargetMode>(props.prefillTable ? "existing" : "create");
const newTableName = ref("");
const selectedSource = ref<string | File | null>(null);
const batchTasks = ref<BatchImportTask[]>([]);
const activeTaskIndex = ref(0);
const sourceFormat = ref<api.TableImportSourceFormat>("csv");
const preview = shallowRef<api.TableImportPreview | null>(null);
const columnMapping = ref<Record<string, string>>({});
const columnGenerators = ref<Record<string, string>>({});
const generatedColumns = ref<GeneratedColumnItem[]>([]);
const columnDataTypes = ref<Record<string, string>>({});
const dynamicDataTypeOptions = ref<string[]>([]);
const loadingDataTypeOptions = ref(false);
const loadingExistingTables = ref(false);
const loadingTarget = ref(false);
const loadingPreview = ref(false);
const importMode = ref<api.TableImportMode>("append");
const batchSize = ref(500);
const running = ref(false);
const cancelling = ref(false);
const importId = ref("");
const progress = ref<api.TableImportProgress | null>(null);
const errorMessage = ref("");
const wizardStep = ref<TableImportWizardStep>("source");
const fileInput = ref<HTMLInputElement | null>(null);
const navicatBackupInput = ref<HTMLInputElement | null>(null);
const delimiter = ref(",");
const decimalSeparator = ref<"." | ",">(".");
const textEncoding = ref<api.TableImportTextEncoding>("auto");
const titleRow = ref(1);
const dataStartRow = ref(2);
const lastDataRow = ref(0);
const trimValues = ref(false);
const conflictPolicy = ref<api.TableImportConflictPolicy>("error");
// Off by default: a failed statement must still stop the import unless the
// user explicitly asks to skip failed rows (issue #13683).
const continueOnError = ref(false);
const emptyStringAsNull = ref(defaultTableImportEmptyStringAsNull(sourceFormat.value));
const selectedSheet = ref("");
const jsonShape = ref<api.TableImportJsonShape>("auto");
const previewLimit = ref(50);
const liveElapsedMs = ref(0);
let previewReloadTimer: ReturnType<typeof setTimeout> | null = null;
let importElapsedTimer: ReturnType<typeof setInterval> | null = null;
let importStartedAt = 0;
let dataTypeOptionsRequestId = 0;
let existingTablesRequestId = 0;
let targetColumnsRequestId = 0;
let previewRequestId = 0;
let batchEncodingRequestId = 0;

const formatOptions: Array<{ value: api.TableImportSourceFormat; icon: any; labelKey: string; descriptionKey: string }> = [
  { value: "csv", icon: FileText, labelKey: "tableImport.formatCsv", descriptionKey: "tableImport.formatCsvDescription" },
  { value: "tsv", icon: FileText, labelKey: "tableImport.formatTsv", descriptionKey: "tableImport.formatTsvDescription" },
  { value: "delimited", icon: FileText, labelKey: "tableImport.formatDelimited", descriptionKey: "tableImport.formatDelimitedDescription" },
  { value: "json", icon: FileJson, labelKey: "tableImport.formatJson", descriptionKey: "tableImport.formatJsonDescription" },
  { value: "excel", icon: FileSpreadsheet, labelKey: "tableImport.formatExcel", descriptionKey: "tableImport.formatExcelDescription" },
  { value: "sql", icon: FileCode, labelKey: "tableImport.formatSql", descriptionKey: "tableImport.formatSqlDescription" },
  { value: "parquet", icon: FileText, labelKey: "tableImport.formatParquet", descriptionKey: "tableImport.formatParquetDescription" },
];

const encodingOptions = TABLE_IMPORT_ENCODING_OPTIONS;

const wizardSteps: Array<{ value: TableImportWizardStep; labelKey: string }> = [
  { value: "source", labelKey: "tableImport.stepSource" },
  { value: "options", labelKey: "tableImport.stepOptions" },
  { value: "mapping", labelKey: "tableImport.stepMapping" },
  { value: "review", labelKey: "tableImport.stepReview" },
  { value: "execution", labelKey: "tableImport.stepExecution" },
];

const selectedConnection = computed(() => (props.prefillConnectionId ? store.getConfig(props.prefillConnectionId) : undefined));
const structureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(selectedConnection.value));
const supportsDuckDbParquetImport = computed(() => structureDatabaseType.value === "duckdb");
const availableFormatOptions = computed(() => formatOptions.filter((format) => format.value !== "parquet" || supportsDuckDbParquetImport.value));
// A Navicat `.nb3` archive restores a whole database, so it is only offered from the
// database-level entry of the connection types the archive reader supports.
const supportsNavicatBackupImport = computed(() => !props.prefillTable && !!selectedConnection.value && NAVICAT_BACKUP_DATABASE_TYPES.has(selectedConnection.value.db_type));
const sourceFormatCards = computed<SourceFormatCard[]>(() => [...availableFormatOptions.value, ...(supportsNavicatBackupImport.value ? [{ value: NAVICAT_BACKUP_FORMAT, icon: DatabaseBackup, labelKey: "tableImport.formatNb3", descriptionKey: "tableImport.formatNb3Description" } as const] : [])]);
const importFileExtensions = computed(() => ["csv", "tsv", "txt", "json", "xlsx", "xlsm", "xls", "sql", ...(supportsDuckDbParquetImport.value ? ["parquet"] : []), ...(supportsNavicatBackupImport.value ? [NAVICAT_BACKUP_FORMAT] : [])]);
// Mirrors the conflict SQL dispatch in transfer.rs. Other dialects must keep
// ordinary INSERT/error behavior instead of approximating an upsert.
const IMPORT_CONFLICT_DATABASE_TYPES = new Set<DatabaseType>(["postgres", "kingbase", "opengauss", "sqlite", "cloudflare-d1", "duckdb", "mysql", "doris", "starrocks"]);
const supportsImportConflictPolicy = computed(() => structureDatabaseType.value !== undefined && IMPORT_CONFLICT_DATABASE_TYPES.has(structureDatabaseType.value));
function defaultInitialSchema() {
  if (props.prefillSchema !== undefined) return props.prefillSchema;
  return metadataSchemaForConnection(selectedConnection.value, props.prefillDatabase || "", props.prefillSchema) || "";
}

const isSchemaCapable = computed(() => isSchemaAware(structureDatabaseType.value));
const showSchemaSelector = computed(() => isSchemaCapable.value && !!props.prefillConnectionId);
const selectedSchema = ref(defaultInitialSchema());
const schemaOptions = ref<string[]>([]);
const loadingSchemas = ref(false);
let schemaOptionsRequestId = 0;
const targetSchema = computed(() => {
  if (selectedSchema.value) return selectedSchema.value;
  return metadataSchemaForConnection(selectedConnection.value, props.prefillDatabase || "", props.prefillSchema) || "";
});
const dataTypeOptions = computed(() => mergeDataTypeOptions(dynamicDataTypeOptions.value, getDataTypeOptions(structureDatabaseType.value), Object.values(columnDataTypes.value)));
const hasExistingTarget = computed(() => !!props.prefillTable || loadingExistingTables.value || existingTableNames.value.length > 0);
const targetTableName = computed(() => (targetMode.value === "create" ? newTableName.value.trim() : selectedExistingTable.value));
const existingTargetMetadataReady = computed(() => targetMode.value !== "existing" || (!loadingTarget.value && !!selectedExistingTable.value && loadedTargetTableName.value === selectedExistingTable.value));
const targetColumnNames = computed(() => targetColumns.value.map((column) => column.name));
const mappedColumns = computed<api.TableImportColumnMapping[]>(() => {
  const currentPreview = preview.value;
  if (!currentPreview) return [];
  const sourceMappings = currentPreview.columns
    .map((sourceColumn) => {
      const targetColumn = columnMapping.value[sourceColumn] ?? (targetMode.value === "create" ? sourceColumn : "");
      const generator = columnGenerators.value[sourceColumn] || undefined;
      const targetDataType = targetMode.value === "create" ? String(columnDataTypes.value[sourceColumn] ?? "").trim() : undefined;
      return {
        sourceColumn,
        targetColumn,
        ...(generator ? { generator } : {}),
        ...(targetMode.value === "create" ? { targetDataType } : {}),
      };
    })
    .filter((mapping) => mapping.targetColumn);

  const extraMappings = generatedColumns.value
    .filter((item) => item.targetColumn && item.targetColumn.trim())
    .map((item) => {
      const targetColumn = item.targetColumn.trim();
      const generator = item.generator || "uuid";
      const targetDataType = targetMode.value === "create" ? String(item.targetDataType || suggestDataTypeForGenerator(generator, structureDatabaseType.value)).trim() : undefined;
      return {
        sourceColumn: "",
        targetColumn,
        generator,
        ...(targetMode.value === "create" ? { targetDataType } : {}),
      };
    });

  return [...sourceMappings, ...extraMappings];
});
const mappedCount = computed(() => mappedColumns.value.length);
const mappingValidation = computed(() => validateImportMappings(mappedColumns.value));
const isUniqueKeyModelDatabase = computed(() => structureDatabaseType.value === "doris" || structureDatabaseType.value === "starrocks");
const primaryKeyColumns = computed(() => targetColumns.value.filter((column) => column.is_primary_key || (isUniqueKeyModelDatabase.value && column.is_unique)));
const updateExistingDisabledReason = computed(() => {
  if (targetMode.value !== "existing") return t("tableImport.updateExistingRequiresExistingTable");
  if (!supportsImportConflictPolicy.value) return t("tableImport.updateExistingUnsupportedDialect");
  if (!existingTargetMetadataReady.value || primaryKeyColumns.value.length === 0) return t("tableImport.updateExistingRequiresPrimaryKey");
  return "";
});
const canSelectUpdateExisting = computed(() => updateExistingDisabledReason.value === "");
const updateExistingMappingError = computed(() => {
  if (targetMode.value !== "existing" || conflictPolicy.value !== "updateExisting") return "";
  const mappedTargets = mappedColumns.value.map((mapping) => mapping.targetColumn.toLowerCase());
  const missingKeys = primaryKeyColumns.value.filter((column) => !mappedTargets.includes(column.name.toLowerCase()));
  if (missingKeys.length > 0) return t("tableImport.updateExistingRequiresMappedPrimaryKey", { columns: missingKeys.map((column) => column.name).join(", ") });
  const primaryKeyNames = primaryKeyColumns.value.map((column) => column.name.toLowerCase());
  if (!mappedTargets.some((column) => !primaryKeyNames.includes(column))) return t("tableImport.updateExistingRequiresMappedValue");
  return "";
});
const conflictPolicyError = computed(() => (conflictPolicy.value === "updateExisting" ? updateExistingDisabledReason.value || updateExistingMappingError.value : ""));
const requiredUnmappedColumns = computed(() =>
  requiredImportTargetColumns(
    targetColumns.value,
    mappedColumns.value.map((mapping) => mapping.targetColumn),
  ),
);
const isBatchImport = computed(() => targetMode.value === "create" && batchTasks.value.length > 1);
/**
 * The dialog is reachable from two entries: a table's own import (which lands on
 * that table, `prefillTable` set) and the database-level "Import data" entry,
 * which imports a backup and may create several tables. Both said
 * "Import table data", which reads wrong for the second one (#13029).
 */
const dialogTitle = computed(() => (props.prefillTable ? t("tableImport.title") : t("tableImport.titleDatabase")));
const selectedBatchTasks = computed(() => batchTasks.value.filter((task) => task.selected));
const batchTargetNamesValid = computed(() => {
  const tableNames = selectedBatchTasks.value.map((task) => task.tableName.trim().toLowerCase());
  return tableNames.length > 0 && tableNames.every(Boolean) && new Set(tableNames).size === tableNames.length;
});
const canImport = computed(() => {
  if (running.value || !props.prefillConnectionId || !existingTargetMetadataReady.value || conflictPolicyError.value) return false;
  if (!isBatchImport.value) return !!preview.value?.rows.length && !!targetTableName.value && mappingValidation.value.valid;
  if (!batchTargetNamesValid.value) return false;
  return selectedBatchTasks.value.every((task) => {
    const sourceMappings = task.preview.columns
      .map((sourceColumn) => ({
        sourceColumn,
        targetColumn: task.columnMapping[sourceColumn] ?? "",
        generator: task.columnGenerators?.[sourceColumn] || undefined,
        targetDataType: task.columnDataTypes[sourceColumn] ?? "",
      }))
      .filter((mapping) => mapping.targetColumn);
    const extraMappings = (task.generatedColumns || [])
      .filter((item) => item.targetColumn && item.targetColumn.trim())
      .map((item) => ({
        sourceColumn: "",
        targetColumn: item.targetColumn.trim(),
        generator: item.generator || "uuid",
        targetDataType: item.targetDataType || suggestDataTypeForGenerator(item.generator, structureDatabaseType.value),
      }));
    const mappings = [...sourceMappings, ...extraMappings];
    return task.preview.rows.length > 0 && !!task.tableName.trim() && validateImportMappings(mappings).valid;
  });
});
const canGoBack = computed(() => wizardStep.value !== "source" && wizardStep.value !== "execution" && !running.value);
const canGoNext = computed(() => {
  if (wizardStep.value === "source") return !!selectedSource.value && !!sourceFormat.value;
  if (isBatchImport.value) {
    if (wizardStep.value === "options") return batchTargetNamesValid.value;
    if (wizardStep.value === "mapping") return canImport.value;
  }
  if (wizardStep.value === "options") return !!preview.value?.rows.length && !!targetTableName.value && existingTargetMetadataReady.value;
  if (wizardStep.value === "mapping") return existingTargetMetadataReady.value && mappingValidation.value.valid && !conflictPolicyError.value;
  return false;
});
const rawProgressPercent = computed(() => tableImportProgressPercent(progress.value));
const progressPercentFloor = ref(0);
const progressPercent = computed(() => Math.max(rawProgressPercent.value, progressPercentFloor.value));
const currentStepIndex = computed(() => wizardSteps.findIndex((step) => step.value === wizardStep.value));
const targetLabel = computed(() => {
  // Database-as-schema engines (MySQL/SQLite family) resolve targetSchema to
  // the database name; keep it out of the label so it does not render twice.
  const schemaPiece = targetSchema.value && targetSchema.value !== props.prefillDatabase ? targetSchema.value : "";
  const pieces = [selectedConnection.value?.name, props.prefillDatabase, schemaPiece, targetTableName.value].filter(Boolean);
  return pieces.join(" / ");
});
const selectedSourceName = computed(() => {
  const source = selectedSource.value;
  if (!source) return "";
  return typeof source === "string" ? source.split(/[\\/]/).pop() || source : source.name;
});
const createColumnSummaries = computed(() =>
  mappedColumns.value.map((mapping) => ({
    sourceColumn: mapping.sourceColumn || (mapping.generator ? `[${mapping.generator}]` : ""),
    targetColumn: mapping.targetColumn,
    targetDataType: mapping.targetDataType || "",
  })),
);
const parseOptions = computed<api.TableImportParseOptions>(() => taskParseOptions(sourceFormat.value, selectedSheet.value));
const terminalStatus = computed(() => !!progress.value?.status && ["done", "error", "cancelled"].includes(progress.value.status));
const displayedElapsedMs = computed(() => resolveTableImportElapsed(liveElapsedMs.value, progress.value?.elapsedMs, terminalStatus.value));
// Source file the progress belongs to (#13164): the queue runs one file at a
// time, so the active task is whatever activeTaskIndex points at; the
// single-file path has no task entry and reads the preview directly. The file
// stays visible once the run finishes, so the completion screen still says
// which file was imported (#13495).
const activeImportFile = computed(() => {
  if (wizardStep.value !== "execution") return "";
  if (isBatchImport.value) {
    const task = batchTasks.value[activeTaskIndex.value];
    return task ? task.preview.filePath || task.preview.fileName || "" : "";
  }
  return preview.value?.filePath || "";
});
const progressLabelKey = computed(() => {
  if (terminalStatus.value) return `tableImport.status_${progress.value?.status || "idle"}`;
  if (!running.value && !progress.value) return "tableImport.status_idle";
  return `tableImport.phase_${progress.value?.phase || "writing"}`;
});
const importFailures = computed(() => progress.value?.failures ?? []);
const failedRowListText = computed(() =>
  importFailures.value
    .map((failure) => {
      const row = t("tableImport.failureRow", { row: failure.row });
      const table = failure.table ? `${t("tableImport.failureTable", { table: failure.table })} · ` : "";
      return `${table}${row}: ${failure.error}`;
    })
    .join("\n"),
);

function importSummaryMessage(imported: number, failed: number): string {
  return failed > 0 ? t("tableImport.successWithFailures", { count: imported, failed }) : t("tableImport.success", { count: imported });
}

async function copyFailedRows() {
  if (!failedRowListText.value) return;
  await copyToClipboard(failedRowListText.value);
  toast(t("tableImport.failedRowsCopied"), 2000);
}

function previewRowsLabel(currentPreview: api.TableImportPreview | null | undefined): string {
  if (!currentPreview) return "-";
  if (currentPreview.totalRowsExact !== false) return currentPreview.totalRows.toLocaleString();
  return t("tableImport.previewPartial", { rows: currentPreview.rows.length });
}

function stopImportElapsedClock() {
  if (importElapsedTimer) {
    clearInterval(importElapsedTimer);
    importElapsedTimer = null;
  }
}

function stopDialogDrag() {
  activeDialogDrag = undefined;
  isDraggingDialog.value = false;
  window.removeEventListener("pointermove", onDialogDragMove);
  window.removeEventListener("pointerup", stopDialogDrag);
  window.removeEventListener("pointercancel", stopDialogDrag);
}

function onDialogDragMove(event: PointerEvent) {
  const drag = activeDialogDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;

  const maxLeft = Math.max(8, window.innerWidth - drag.width - 8);
  const maxTop = Math.max(8, window.innerHeight - drag.height - 8);
  const left = Math.min(maxLeft, Math.max(8, drag.startLeft + event.clientX - drag.startX));
  const top = Math.min(maxTop, Math.max(8, drag.startTop + event.clientY - drag.startY));
  dialogDragOffset.value = {
    x: drag.offsetX + left - drag.startLeft,
    y: drag.offsetY + top - drag.startTop,
  };
}

function startDialogDrag(event: PointerEvent) {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button, a, input, select, textarea")) return;
  const content = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-slot="dialog-content"]');
  if (!content) return;

  const rect = content.getBoundingClientRect();
  activeDialogDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    width: rect.width,
    height: rect.height,
    offsetX: dialogDragOffset.value.x,
    offsetY: dialogDragOffset.value.y,
  };
  isDraggingDialog.value = true;
  window.addEventListener("pointermove", onDialogDragMove);
  window.addEventListener("pointerup", stopDialogDrag);
  window.addEventListener("pointercancel", stopDialogDrag);
  event.preventDefault();
}

function handleOpenChange(value: boolean) {
  if (!value && running.value) return;
  open.value = value;
}

function minimizeImport() {
  minimized.value = true;
  backgroundMode.value = true;
}

function restoreImport() {
  minimized.value = false;
  if (!running.value) backgroundMode.value = false;
}

function refreshImportElapsedClock() {
  if (importStartedAt > 0) {
    liveElapsedMs.value = Math.max(0, Math.round(performance.now() - importStartedAt));
  }
}

function startImportElapsedClock() {
  stopImportElapsedClock();
  importStartedAt = performance.now();
  liveElapsedMs.value = 0;
  importElapsedTimer = setInterval(refreshImportElapsedClock, 100);
}

function resetState() {
  stopDialogDrag();
  minimized.value = false;
  backgroundMode.value = false;
  dialogDragOffset.value = { x: 0, y: 0 };
  progressPercentFloor.value = 0;
  stopImportElapsedClock();
  closeDataTypePicker();
  importStartedAt = 0;
  liveElapsedMs.value = 0;
  previewRequestId++;
  batchEncodingRequestId++;
  existingTablesRequestId++;
  targetColumnsRequestId++;
  schemaOptionsRequestId++;
  schemaOptions.value = [];
  loadingSchemas.value = false;
  selectedSchema.value = defaultInitialSchema();
  if (previewReloadTimer) {
    clearTimeout(previewReloadTimer);
    previewReloadTimer = null;
  }
  targetColumns.value = [];
  loadedTargetTableName.value = "";
  existingTableNames.value = [];
  selectedExistingTable.value = props.prefillTable || "";
  targetMode.value = props.prefillTable ? "existing" : "create";
  newTableName.value = "";
  selectedSource.value = null;
  batchTasks.value = [];
  activeTaskIndex.value = 0;
  sourceFormat.value = "csv";
  delimiter.value = ",";
  decimalSeparator.value = ".";
  textEncoding.value = "auto";
  titleRow.value = 1;
  dataStartRow.value = 2;
  lastDataRow.value = 0;
  trimValues.value = false;
  conflictPolicy.value = "error";
  continueOnError.value = false;
  emptyStringAsNull.value = defaultTableImportEmptyStringAsNull(sourceFormat.value);
  selectedSheet.value = "";
  jsonShape.value = "auto";
  previewLimit.value = 50;
  preview.value = null;
  columnMapping.value = {};
  columnGenerators.value = {};
  generatedColumns.value = [];
  columnDataTypes.value = {};
  importMode.value = "append";
  batchSize.value = 500;
  loadingPreview.value = false;
  loadingExistingTables.value = false;
  loadingTarget.value = false;
  running.value = false;
  cancelling.value = false;
  importId.value = "";
  progress.value = null;
  errorMessage.value = "";
  wizardStep.value = "source";
}

function detectFormat(name: string): api.TableImportSourceFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".txt")) return "delimited";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".xls") || lower.endsWith(".xlsx") || lower.endsWith(".xlsm")) return "excel";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".parquet")) return "parquet";
  return "csv";
}

function isDelimitedFormat(format: api.TableImportSourceFormat) {
  return format === "csv" || format === "tsv" || format === "delimited";
}

function encodingLabel(encoding: api.TableImportTextEncoding) {
  return t(encodingOptions.find((option) => option.value === encoding)?.labelKey || "tableImport.encodingAuto");
}

function suggestedTableName(name: string) {
  const baseName = name.split(/[\\/]/).pop() || name;
  const withoutExtension = baseName.replace(/\.[^.]+$/, "").trim();
  return withoutExtension.replace(/[\s-]+/g, "_") || "imported_data";
}

function sourceName(source: ImportSource): string {
  return importSourceDisplayName(source);
}

function uniqueTableName(baseName: string, usedNames: Set<string>): string {
  const normalizedBase = suggestedTableName(baseName);
  let candidate = normalizedBase;
  let suffix = 2;
  while (usedNames.has(candidate.toLowerCase())) candidate = `${normalizedBase}_${suffix++}`;
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

function taskParseOptions(format: api.TableImportSourceFormat, sheetName = ""): api.TableImportParseOptions {
  return buildTableImportParseOptions({
    format,
    delimiter: delimiter.value,
    decimalSeparator: decimalSeparator.value,
    textEncoding: textEncoding.value,
    titleRow: titleRow.value,
    dataStartRow: dataStartRow.value,
    lastDataRow: lastDataRow.value,
    trimValues: trimValues.value,
    emptyStringAsNull: emptyStringAsNull.value,
    sheetName,
    jsonShape: jsonShape.value,
    databaseType: structureDatabaseType.value,
  });
}

function importParseOptions(format: api.TableImportSourceFormat, currentPreview: api.TableImportPreview, sheetName = ""): api.TableImportParseOptions {
  const options = taskParseOptions(format, sheetName);
  // SQL 脚本与分隔文本一样依赖文本编码检测，导入时沿用预览阶段确定的编码避免二次检测结果不一致
  if ((isDelimitedFormat(format) || format === "sql") && currentPreview.totalRowsExact !== false && options.encoding === "auto" && currentPreview.effectiveEncoding) {
    options.encoding = currentPreview.effectiveEncoding;
  }
  return options;
}

function preparedImportSource(currentPreview: api.TableImportPreview): api.TableImportPreparedSource {
  return {
    fingerprint: currentPreview.sourceFingerprint,
    columns: currentPreview.columns,
    rows: currentPreview.rows,
    totalRows: currentPreview.totalRows,
    totalRowsExact: currentPreview.totalRowsExact !== false,
    effectiveEncoding: currentPreview.effectiveEncoding ?? null,
  };
}

function mergeDataTypeOptions(...groups: readonly string[][]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    for (const option of group) {
      const trimmed = option.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(trimmed);
    }
  }
  return result;
}

function applyAutoMapping() {
  const currentPreview = preview.value;
  if (!currentPreview) return;
  if (targetMode.value === "create") {
    columnMapping.value = Object.fromEntries(currentPreview.columns.map((source) => [source, source]));
    return;
  }
  const headerless = titleRow.value === 0 && (isDelimitedFormat(sourceFormat.value) || sourceFormat.value === "excel");
  columnMapping.value = autoMapImportColumns(currentPreview.columns, targetColumnNames.value, headerless ? "position" : "auto");
}

function applySuggestedColumnDataTypes(currentPreview = preview.value) {
  if (targetMode.value !== "create" || !currentPreview) {
    columnDataTypes.value = {};
    return;
  }
  const suggested = suggestImportTargetDataTypes(currentPreview.columns, currentPreview.rows, structureDatabaseType.value);
  const previous = columnDataTypes.value;
  columnDataTypes.value = Object.fromEntries(currentPreview.columns.map((sourceColumn) => [sourceColumn, previous[sourceColumn]?.trim() ? previous[sourceColumn] : suggested[sourceColumn] || "TEXT"]));
}

// 200+ 列时 SearchableSelect 太重，换成一个全局 popover，
// 只有点击输入框时才挂载，避免创建上百分组件实例。
const activeDataTypeColumn = ref<string | null>(null);
const dataTypePickerOpen = ref(false);
const dataTypePickerStyle = ref<Record<string, string>>({});
const activeDataTypeOptionIndex = ref(-1);
const dataTypePickerOptions = computed(() => {
  const options = dataTypeOptions.value;
  const sourceColumn = activeDataTypeColumn.value;
  const currentValue = sourceColumn ? columnDataTypes.value[sourceColumn] : "";
  return currentValue && !options.includes(currentValue) ? [...options, currentValue] : options;
});

function closeDataTypePicker() {
  dataTypePickerOpen.value = false;
  activeDataTypeColumn.value = null;
  activeDataTypeOptionIndex.value = -1;
}

function openDataTypePicker(sourceColumn: string, input: HTMLInputElement) {
  const rect = input.getBoundingClientRect();
  dataTypePickerStyle.value = {
    position: "fixed",
    top: `${rect.bottom + 2}px`,
    left: `${rect.left}px`,
    width: `${Math.max(rect.width, 200)}px`,
  };
  activeDataTypeColumn.value = sourceColumn;
  activeDataTypeOptionIndex.value = -1;
  dataTypePickerOpen.value = true;
}

function selectDataTypeOption(value: string) {
  const sourceColumn = activeDataTypeColumn.value;
  if (sourceColumn) updateColumnDataType(sourceColumn, value);
  closeDataTypePicker();
}

function handleDataTypePickerKeydown(event: KeyboardEvent, sourceColumn: string, input: HTMLInputElement) {
  if (!dataTypePickerOpen.value && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    openDataTypePicker(sourceColumn, input);
  }
  if (!dataTypePickerOpen.value || !activeDataTypeColumn.value) return;
  const options = dataTypePickerOptions.value;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDataTypePicker();
  } else if (event.key === "ArrowDown" && options.length) {
    event.preventDefault();
    activeDataTypeOptionIndex.value = (activeDataTypeOptionIndex.value + 1) % options.length;
  } else if (event.key === "ArrowUp" && options.length) {
    event.preventDefault();
    activeDataTypeOptionIndex.value = activeDataTypeOptionIndex.value <= 0 ? options.length - 1 : activeDataTypeOptionIndex.value - 1;
  } else if (event.key === "Enter" && activeDataTypeOptionIndex.value >= 0) {
    event.preventDefault();
    selectDataTypeOption(options[activeDataTypeOptionIndex.value]);
  }
}

async function loadDataTypeOptions() {
  const requestId = ++dataTypeOptionsRequestId;
  const connectionId = props.prefillConnectionId;
  const database = props.prefillDatabase || "";
  if (!connectionId || !database || targetMode.value !== "create") {
    dynamicDataTypeOptions.value = [];
    loadingDataTypeOptions.value = false;
    return;
  }
  loadingDataTypeOptions.value = true;
  try {
    await store.ensureConnected(connectionId);
    const options = await api.listDataTypes(connectionId, database);
    if (requestId !== dataTypeOptionsRequestId) return;
    dynamicDataTypeOptions.value = mergeDataTypeOptions(options);
  } catch {
    if (requestId === dataTypeOptionsRequestId) {
      dynamicDataTypeOptions.value = [];
    }
  } finally {
    if (requestId === dataTypeOptionsRequestId) {
      loadingDataTypeOptions.value = false;
    }
  }
}

async function loadSchemaOptions() {
  const connectionId = props.prefillConnectionId;
  const database = props.prefillDatabase || "";
  if (!connectionId || !isSchemaCapable.value) {
    schemaOptions.value = [];
    loadingSchemas.value = false;
    return;
  }
  const requestId = ++schemaOptionsRequestId;
  loadingSchemas.value = true;
  try {
    await store.ensureConnected(connectionId);
    const rawSchemas = await api.listSchemas(connectionId, database);
    if (requestId !== schemaOptionsRequestId) return;
    const filtered = schemaOptionsForConnection(rawSchemas, selectedConnection.value, database);
    const active = selectedSchema.value || targetSchema.value;
    if (active && !filtered.includes(active)) {
      schemaOptions.value = [active, ...filtered];
    } else {
      schemaOptions.value = filtered;
    }
  } catch {
    if (requestId === schemaOptionsRequestId) {
      const active = selectedSchema.value || targetSchema.value;
      schemaOptions.value = active ? [active] : [];
    }
  } finally {
    if (requestId === schemaOptionsRequestId) {
      loadingSchemas.value = false;
    }
  }
}

function handleSchemaChange(newSchema: string) {
  const trimmed = newSchema.trim();
  if (selectedSchema.value === trimmed) return;
  selectedSchema.value = trimmed;
  if (trimmed && !schemaOptions.value.includes(trimmed)) {
    schemaOptions.value = [trimmed, ...schemaOptions.value];
  }
  existingTableNames.value = [];
  selectedExistingTable.value = "";
  targetColumns.value = [];
  loadedTargetTableName.value = "";
  if (targetMode.value === "existing") {
    columnMapping.value = {};
  }
  if (targetMode.value === "existing" || wizardStep.value === "options") {
    void loadExistingTables(true);
  }
}

async function loadExistingTables(force = false) {
  if (props.prefillTable || (!force && (loadingExistingTables.value || existingTableNames.value.length > 0)) || !props.prefillConnectionId || !props.prefillDatabase) return;
  const requestId = ++existingTablesRequestId;
  loadingExistingTables.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.prefillConnectionId);
    const tables = await api.listTables(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, undefined, undefined, undefined, ["TABLE"]);
    if (requestId !== existingTablesRequestId) return;
    existingTableNames.value = tables.map((table) => table.name);
  } catch (e: any) {
    if (requestId === existingTablesRequestId) {
      existingTableNames.value = [];
      errorMessage.value = String(e?.message || e);
    }
  } finally {
    if (requestId === existingTablesRequestId) loadingExistingTables.value = false;
  }
}

async function loadTargetColumns() {
  const tableName = selectedExistingTable.value;
  if (targetMode.value !== "existing" || !props.prefillConnectionId || !props.prefillDatabase || !tableName) {
    targetColumnsRequestId++;
    targetColumns.value = [];
    loadedTargetTableName.value = "";
    columnMapping.value = {};
    loadingTarget.value = false;
    return;
  }
  const requestId = ++targetColumnsRequestId;
  targetColumns.value = [];
  loadedTargetTableName.value = "";
  columnMapping.value = {};
  loadingTarget.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.prefillConnectionId);
    const columnsPromise = withTimeout(api.getColumns(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, tableName), TARGET_COLUMNS_TIMEOUT_MS);
    const indexesPromise =
      isUniqueKeyModelDatabase.value && typeof api.listIndexes === "function"
        ? withTimeout(
            api.listIndexes(props.prefillConnectionId, props.prefillDatabase, targetSchema.value || "", tableName).catch(() => []),
            TARGET_COLUMNS_TIMEOUT_MS,
          )
        : Promise.resolve([]);
    const [loadedColumns, indexes] = await Promise.all([columnsPromise, indexesPromise]);
    if (requestId !== targetColumnsRequestId) return;
    // Doris/StarRocks UNIQUE KEY columns are the conflict key but are NULLable and
    // not reported as primary keys. Flag only `is_unique`: this array is not
    // copied, so writing `is_primary_key` here would also make unrelated metadata
    // readers treat the column as a literal PRIMARY KEY.
    const keyColumns = uniqueKeyModelColumns(structureDatabaseType.value, indexes);
    const columns = keyColumns.size > 0 ? loadedColumns.map((column) => (keyColumns.has(column.name.toLowerCase()) ? { ...column, is_unique: true } : column)) : loadedColumns;
    targetColumns.value = columns;
    loadedTargetTableName.value = tableName;
    applyAutoMapping();
  } catch (e: any) {
    if (requestId === targetColumnsRequestId) {
      targetColumns.value = [];
      loadedTargetTableName.value = "";
      columnMapping.value = {};
      errorMessage.value = e === TARGET_COLUMNS_TIMEOUT ? t("tableImport.targetColumnsTimeout") : String(e?.message || e);
    }
  } finally {
    if (requestId === targetColumnsRequestId) loadingTarget.value = false;
  }
}

async function previewSelectedImportFile(fileOrPath: string | File) {
  const input = importPreviewInput(uploadedImportSourceFromPreview(preview.value), fileOrPath);
  return api.previewTableImportFile(input.fileOrPath, {
    connectionId: props.prefillConnectionId,
    database: props.prefillDatabase || "",
    sourceRef: input.sourceRef,
    sourceFormat: sourceFormat.value,
    parseOptions: parseOptions.value,
    previewLimit: Math.max(1, Number(previewLimit.value) || 50),
  });
}

async function loadPreview(fileOrPath = selectedSource.value) {
  if (!fileOrPath) return;
  const requestId = ++previewRequestId;
  loadingPreview.value = true;
  errorMessage.value = "";
  try {
    const nextPreview = await previewSelectedImportFile(fileOrPath);
    if (requestId !== previewRequestId) return;
    preview.value = nextPreview;
    if (sourceFormat.value === "excel" && !selectedSheet.value && nextPreview.sheets?.length) {
      selectedSheet.value = nextPreview.sheets[0];
    }
    applyAutoMapping();
    applySuggestedColumnDataTypes(nextPreview);
  } catch (e: any) {
    if (requestId !== previewRequestId) return;
    preview.value = null;
    columnMapping.value = {};
    columnDataTypes.value = {};
    errorMessage.value = String(e?.message || e);
  } finally {
    if (requestId === previewRequestId) loadingPreview.value = false;
  }
}

function assignSelectedSource(source: string | File) {
  const detectedFormat = detectFormat(typeof source === "string" ? source : source.name);
  if (detectedFormat === "parquet" && !supportsDuckDbParquetImport.value) {
    selectedSource.value = null;
    preview.value = null;
    errorMessage.value = t("tableImport.parquetOnlyDuckdb");
    return;
  }
  batchTasks.value = [];
  selectedSource.value = source;
  preview.value = null;
  columnMapping.value = {};
  columnGenerators.value = {};
  generatedColumns.value = [];
  columnDataTypes.value = {};
  progress.value = null;
  errorMessage.value = "";
  const name = typeof source === "string" ? source : source.name;
  sourceFormat.value = detectedFormat;
  emptyStringAsNull.value = defaultTableImportEmptyStringAsNull(sourceFormat.value);
  if (!newTableName.value.trim()) {
    newTableName.value = suggestedTableName(name);
  }
  delimiter.value = sourceFormat.value === "tsv" ? "\\t" : ",";
  selectedSheet.value = "";
  wizardStep.value = "options";
  void loadPreview(source);
}

function activateBatchTask(index: number) {
  const task = batchTasks.value[index];
  if (!task || running.value) return;
  activeTaskIndex.value = index;
  selectedSource.value = task.source;
  sourceFormat.value = task.format;
  selectedSheet.value = task.sheetName;
  newTableName.value = task.tableName;
  preview.value = task.preview;
  columnMapping.value = { ...task.columnMapping };
  columnGenerators.value = { ...task.columnGenerators };
  generatedColumns.value = (task.generatedColumns || []).map((col) => ({ ...col }));
  columnDataTypes.value = { ...task.columnDataTypes };
}

function saveActiveBatchTask() {
  if (!isBatchImport.value) return;
  const task = batchTasks.value[activeTaskIndex.value];
  if (!task) return;
  task.tableName = newTableName.value.trim();
  task.columnMapping = { ...columnMapping.value };
  task.columnGenerators = { ...columnGenerators.value };
  task.generatedColumns = generatedColumns.value.map((col) => ({ ...col }));
  task.columnDataTypes = { ...columnDataTypes.value };
}

async function prepareBatchSources(sources: ImportSource[]) {
  loadingPreview.value = true;
  errorMessage.value = "";
  const tasks: BatchImportTask[] = [];
  const usedNames = new Set<string>();
  const formats = sources.map((source) => detectFormat(sourceName(source)));
  if (formats.includes("parquet") && !supportsDuckDbParquetImport.value) {
    errorMessage.value = t("tableImport.parquetOnlyDuckdb");
    loadingPreview.value = false;
    return;
  }
  emptyStringAsNull.value = formats.length && formats.every((format) => format === formats[0]) ? defaultTableImportEmptyStringAsNull(formats[0]!) : defaultTableImportEmptyStringAsNull(formats[0] ?? "csv");
  try {
    for (const [index, source] of sources.entries()) {
      const format = formats[index]!;
      const initialPreview = await api.previewTableImportFile(source, {
        connectionId: props.prefillConnectionId,
        database: props.prefillDatabase || "",
        sourceFormat: format,
        parseOptions: taskParseOptions(format),
        previewLimit: Math.max(1, Number(previewLimit.value) || 50),
      });
      const sheets = format === "excel" && initialPreview.sheets?.length ? initialPreview.sheets : [""];
      for (const sheetName of sheets) {
        const input = importPreviewInput(uploadedImportSourceFromPreview(initialPreview), source);
        const effectiveSheetName = sheetName && sheetName === initialPreview.sheets?.[0] ? "" : sheetName;
        const taskPreview = effectiveSheetName
          ? await api.previewTableImportFile(input.fileOrPath, {
              connectionId: props.prefillConnectionId,
              database: props.prefillDatabase || "",
              sourceRef: input.sourceRef,
              sourceFormat: format,
              parseOptions: taskParseOptions(format, effectiveSheetName),
              previewLimit: Math.max(1, Number(previewLimit.value) || 50),
            })
          : initialPreview;
        const tableBase = sheetName ? `${suggestedTableName(sourceName(source))}_${sheetName}` : sourceName(source);
        tasks.push({
          id: uuid(),
          selected: taskPreview.rows.length > 0,
          source,
          format,
          sheetName: effectiveSheetName,
          tableName: uniqueTableName(tableBase, usedNames),
          preview: taskPreview,
          columnMapping: Object.fromEntries(taskPreview.columns.map((column) => [column, column])),
          columnGenerators: {},
          generatedColumns: [],
          columnDataTypes: suggestImportTargetDataTypes(taskPreview.columns, taskPreview.rows, structureDatabaseType.value),
          status: "pending",
          rowsImported: 0,
          rowsFailed: 0,
        });
      }
    }
    batchTasks.value = tasks;
    if (tasks.length) {
      const firstSelectedIndex = tasks.findIndex((task) => task.selected);
      activateBatchTask(Math.max(0, firstSelectedIndex));
      wizardStep.value = "options";
    }
  } catch (e: any) {
    batchTasks.value = [];
    errorMessage.value = String(e?.message || e);
  } finally {
    loadingPreview.value = false;
  }
}

async function selectFile() {
  if (!isTauriRuntime()) {
    fileInput.value?.click();
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: targetMode.value === "create",
    filters: [
      { name: "Data files", extensions: importFileExtensions.value },
      { name: "Text", extensions: ["csv", "tsv", "txt"] },
      { name: "JSON", extensions: ["json"] },
      { name: "Excel", extensions: ["xlsx", "xlsm", "xls"] },
      { name: "SQL", extensions: ["sql"] },
      ...(supportsDuckDbParquetImport.value ? [{ name: "Parquet", extensions: ["parquet"] }] : []),
      ...(supportsNavicatBackupImport.value ? [NAVICAT_BACKUP_FILTER] : []),
    ],
  });
  if (!selected) return;
  await applySelectedSources(Array.isArray(selected) ? selected : [selected]);
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || running.value) return;
  await applySelectedSources(files);
}

async function applySelectedSources(sources: ImportSource[]) {
  // A Navicat archive restores a whole database, so only a single-file selection may
  // take that path; a mixed batch must stay in the table-import flow for the other files.
  const navicatBackup = supportsNavicatBackupImport.value && sources.length === 1 ? sources.find((source) => sourceName(source).toLowerCase().endsWith(`.${NAVICAT_BACKUP_FORMAT}`)) : undefined;
  if (navicatBackup) await openNavicatBackupRestore(navicatBackup);
  else if (targetMode.value === "create") await prepareBatchSources(sources);
  else assignSelectedSource(sources[0]!);
}

function selectFormatCard(format: SourceFormatCard["value"]) {
  if (format === NAVICAT_BACKUP_FORMAT) void selectNavicatBackupFile();
  else sourceFormat.value = format;
}

async function selectNavicatBackupFile() {
  if (!isTauriRuntime()) {
    navicatBackupInput.value?.click();
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ multiple: false, filters: [NAVICAT_BACKUP_FILTER] });
  if (typeof selected === "string") await openNavicatBackupRestore(selected);
}

async function handleNavicatBackupInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file && !running.value) await openNavicatBackupRestore(file);
}

/**
 * Navicat archives hold whole databases (DDL, rows, routines, triggers), so they are
 * restored by the SQL file executor, prefilled with this dialog's target database.
 */
async function openNavicatBackupRestore(source: ImportSource) {
  const connectionId = props.prefillConnectionId;
  if (!connectionId) return;
  const target = { connectionId, database: props.prefillDatabase || "", ...(props.prefillSchema ? { schema: props.prefillSchema } : {}) };
  if (typeof source === "string") {
    store.sqlFileSource = { ...target, filePath: source };
  } else {
    // The web SQL file executor runs uploaded files, so upload the archive before handing it over.
    loadingPreview.value = true;
    errorMessage.value = "";
    try {
      const { previewSqlFile } = await import("@/lib/backend/http");
      store.sqlFileSource = { ...target, preview: await previewSqlFile(source) };
    } catch (e: any) {
      errorMessage.value = String(e?.message || e);
      return;
    } finally {
      loadingPreview.value = false;
    }
  }
  open.value = false;
}

function updateMapping(sourceColumn: string, value: any) {
  const target = String(value);
  columnMapping.value = {
    ...columnMapping.value,
    [sourceColumn]: target === SKIP_VALUE ? "" : target,
  };
}

function isSourceColumnSkipped(sourceColumn: string | undefined): boolean {
  if (!sourceColumn) return false;
  if (targetMode.value === "create") {
    const target = columnMapping.value[sourceColumn] ?? sourceColumn;
    return !target || !target.trim();
  }
  const target = columnMapping.value[sourceColumn];
  return !target || target === SKIP_VALUE || !target.trim();
}

function mapByPosition() {
  const currentPreview = preview.value;
  if (!currentPreview) return;
  columnMapping.value = autoMapImportColumns(currentPreview.columns, targetColumnNames.value, "position");
}

function mapByName() {
  const currentPreview = preview.value;
  if (!currentPreview) return;
  columnMapping.value = autoMapImportColumns(currentPreview.columns, targetColumnNames.value, "name");
}

function skipAllColumns() {
  const currentPreview = preview.value;
  if (!currentPreview) return;
  columnMapping.value = Object.fromEntries(currentPreview.columns.map((source) => [source, ""]));
}

function updateColumnDataType(sourceColumn: string, value: any) {
  columnDataTypes.value = {
    ...columnDataTypes.value,
    [sourceColumn]: String(value),
  };
}

const generatorPickerOpen = ref(false);
const activeGeneratorColumn = ref<{ type: "source"; sourceColumn: string } | { type: "generated"; id: string } | null>(null);
const generatorPickerStyle = ref<Record<string, string>>({});

function openGeneratorPicker(target: { type: "source"; sourceColumn: string } | { type: "generated"; id: string }, trigger: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  generatorPickerStyle.value = {
    position: "fixed",
    top: `${rect.bottom + 2}px`,
    left: `${Math.max(10, Math.min(rect.left, window.innerWidth - 260))}px`,
    width: "250px",
  };
  activeGeneratorColumn.value = target;
  generatorPickerOpen.value = true;
}

function closeGeneratorPicker() {
  generatorPickerOpen.value = false;
  activeGeneratorColumn.value = null;
}

function selectGeneratorOption(generator: string) {
  if (!activeGeneratorColumn.value) return;
  if (activeGeneratorColumn.value.type === "source") {
    updateColumnGenerator(activeGeneratorColumn.value.sourceColumn, generator);
  } else {
    updateGeneratedColumn(activeGeneratorColumn.value.id, { generator });
  }
  closeGeneratorPicker();
}

function generatorLabel(key: string | undefined): string {
  if (!key) return t("tableImport.sourceValue");
  const opt = TABLE_IMPORT_GENERATOR_OPTIONS.find((o) => o.value === key);
  return opt ? t(opt.labelKey) : key;
}

function updateColumnGenerator(sourceColumn: string, generator: string) {
  if (!generator) {
    const next = { ...columnGenerators.value };
    delete next[sourceColumn];
    columnGenerators.value = next;
  } else {
    columnGenerators.value = {
      ...columnGenerators.value,
      [sourceColumn]: generator,
    };
    if (targetMode.value === "create" && (!columnDataTypes.value[sourceColumn] || columnDataTypes.value[sourceColumn] === "TEXT")) {
      columnDataTypes.value = {
        ...columnDataTypes.value,
        [sourceColumn]: suggestDataTypeForGenerator(generator, structureDatabaseType.value),
      };
    }
  }
}

function addGeneratedColumn(targetCol = "", generator = "uuid") {
  const defaultDataType = suggestDataTypeForGenerator(generator, structureDatabaseType.value);
  generatedColumns.value = [
    ...generatedColumns.value,
    {
      id: uuid(),
      targetColumn: targetCol,
      generator,
      targetDataType: defaultDataType,
    },
  ];
}

function removeGeneratedColumn(id: string) {
  generatedColumns.value = generatedColumns.value.filter((col) => col.id !== id);
}

function updateGeneratedColumn(id: string, updates: Partial<GeneratedColumnItem>) {
  generatedColumns.value = generatedColumns.value.map((col) => {
    if (col.id !== id) return col;
    const updated = { ...col, ...updates };
    if (updates.generator && updates.generator !== col.generator && targetMode.value === "create") {
      updated.targetDataType = suggestDataTypeForGenerator(updates.generator, structureDatabaseType.value);
    }
    return updated;
  });
}

function autoGenerateRequiredColumns() {
  const unmapped = [...requiredUnmappedColumns.value];
  if (!unmapped.length) return;
  const newCols: GeneratedColumnItem[] = [];
  for (const colName of unmapped) {
    const targetCol = targetColumns.value.find((c) => c.name.toLowerCase() === colName.toLowerCase());
    let generator: TableImportGeneratorKey = "uuid";
    const lowerName = colName.toLowerCase();
    const typeLower = String(targetCol?.data_type || "").toLowerCase();
    if (typeLower.includes("int") || typeLower.includes("number") || typeLower.includes("serial")) {
      generator = "sequence";
    } else if (typeLower.includes("date") && !typeLower.includes("time")) {
      generator = "current_date";
    } else if (typeLower.includes("time") || typeLower.includes("timestamp") || lowerName.includes("time") || lowerName.includes("date") || lowerName.endsWith("_at")) {
      generator = "current_timestamp";
    } else if (lowerName.includes("uuid")) {
      generator = "uuid";
    }
    newCols.push({
      id: uuid(),
      targetColumn: colName,
      generator,
      targetDataType: targetCol?.data_type || suggestDataTypeForGenerator(generator, structureDatabaseType.value),
    });
  }
  generatedColumns.value = [...generatedColumns.value, ...newCols];
}

const activeGeneratedColumns = computed(() => generatedColumns.value.filter((col) => col.targetColumn && col.targetColumn.trim()));

function goBack() {
  wizardStep.value = previousTableImportWizardStep(wizardStep.value);
}

function canOpenStep(step: TableImportWizardStep) {
  if (running.value || step === "execution") return false;
  if (step === "source") return true;
  if (step === "options") return !!selectedSource.value;
  if (isBatchImport.value) {
    if (step === "mapping") return selectedBatchTasks.value.length > 0;
    if (step === "review") return canImport.value;
  }
  if (step === "mapping") return !!preview.value && existingTargetMetadataReady.value;
  if (step === "review") return !!preview.value && existingTargetMetadataReady.value && mappingValidation.value.valid && !conflictPolicyError.value;
  return false;
}

function wizardStepIndex(step: TableImportWizardStep) {
  return wizardSteps.findIndex((item) => item.value === step);
}

function isWizardStepActive(step: TableImportWizardStep) {
  return step === wizardStep.value;
}

function isWizardStepComplete(step: TableImportWizardStep) {
  return wizardStepIndex(step) < currentStepIndex.value;
}

function wizardStepConnectorClass(index: number, leading: boolean) {
  return (leading ? index <= currentStepIndex.value : index < currentStepIndex.value) ? "bg-primary/60" : "bg-border";
}

function wizardStepTextClass(step: TableImportWizardStep) {
  if (isWizardStepActive(step)) return "text-foreground";
  if (isWizardStepComplete(step)) return "text-foreground hover:bg-muted/40";
  return "text-muted-foreground";
}

function wizardStepCircleClass(step: TableImportWizardStep) {
  if (isWizardStepActive(step)) return "border-primary bg-primary text-primary-foreground shadow-sm";
  if (isWizardStepComplete(step)) return "border-primary/70 bg-background text-primary";
  return "border-border bg-background text-muted-foreground";
}

async function goNext() {
  if (wizardStep.value === "source" && !preview.value && selectedSource.value && !isBatchImport.value) {
    await loadPreview();
    if (!preview.value) return;
  }
  if (wizardStep.value === "options" && !preview.value) {
    await loadPreview();
    if (!preview.value) return;
  }
  wizardStep.value = nextTableImportWizardStep(wizardStep.value);
}

async function startImport() {
  saveActiveBatchTask();
  if (!canImport.value) return;
  if (!(await ensureReadOnlyWriteAccess({ connection: store.getConfig(props.prefillConnectionId ?? ""), source: t("readOnlyUnlock.sourceImport"), treatAsMutation: true }))) {
    return;
  }
  if (isBatchImport.value) {
    await startBatchImport();
    return;
  }
  const currentPreview = preview.value;
  const tableName = targetTableName.value;
  if (!canImport.value || !currentPreview || !props.prefillConnectionId || !tableName) return;
  backgroundMode.value = true;
  running.value = true;
  progressPercentFloor.value = 0;
  cancelling.value = false;
  errorMessage.value = "";
  wizardStep.value = "execution";
  importId.value = uuid();
  startImportElapsedClock();
  progress.value = {
    importId: importId.value,
    status: "running",
    phase: "preparing",
    rowsImported: 0,
    totalRows: currentPreview.totalRows,
    totalRowsExact: currentPreview.totalRowsExact !== false,
    bytesRead: 0,
    totalBytes: currentPreview.sizeBytes,
    elapsedMs: 0,
  };

  try {
    const summary = await api.importTableFile(
      {
        importId: importId.value,
        connectionId: props.prefillConnectionId,
        database: props.prefillDatabase || "",
        schema: targetSchema.value,
        table: tableName,
        filePath: currentPreview.filePath,
        sourceRef: currentPreview.sourceRef || null,
        sourceFormat: sourceFormat.value,
        // Execution must parse the same worksheet that produced the preview and mappings.
        parseOptions: importParseOptions(sourceFormat.value, currentPreview, selectedSheet.value),
        mappings: mappedColumns.value,
        mode: targetMode.value === "create" ? "append" : importMode.value,
        createTable: targetMode.value === "create",
        batchSize: Math.max(1, Number(batchSize.value) || 500),
        conflictPolicy: conflictPolicy.value,
        skipDuplicateRows: conflictPolicy.value === "skip",
        continueOnError: continueOnError.value,
        dateTimeFormat: settingsStore.editorSettings.globalDateTimeImportFormat || undefined,
        preparedSource: preparedImportSource(currentPreview),
      },
      (nextProgress) => {
        progress.value = { ...nextProgress, elapsedMs: nextProgress.elapsedMs ?? liveElapsedMs.value };
      },
    );
    progress.value = {
      importId: summary.importId,
      status: "done",
      rowsImported: summary.rowsImported,
      totalRows: summary.totalRows,
      elapsedMs: summary.elapsedMs,
      rowsFailed: summary.rowsFailed ?? 0,
      failures: summary.failures ?? [],
      failuresTruncated: summary.failuresTruncated ?? false,
    };
    toast(importSummaryMessage(summary.rowsImported, summary.rowsFailed ?? 0), 2500);
    store.invalidateMetadataCache(props.prefillConnectionId, props.prefillDatabase || "", targetSchema.value || undefined, tableName);
    if (targetMode.value === "create") {
      store.refreshObjectListTreeNode(props.prefillConnectionId, props.prefillDatabase || "", targetSchema.value || undefined).catch((error) => {
        console.warn("[DBX][table-import:refresh-created-table-failed]", error);
      });
    }
  } catch (e: any) {
    const message = String(e?.message || e);
    errorMessage.value = message;
    progress.value = {
      importId: importId.value,
      status: progress.value?.status === "cancelled" ? "cancelled" : "error",
      rowsImported: progress.value?.rowsImported ?? 0,
      totalRows: progress.value?.totalRows ?? currentPreview.totalRows,
      elapsedMs: progress.value?.elapsedMs ?? liveElapsedMs.value,
      error: message,
      // Keep failed rows already reported before the fatal error/cancel (#13683).
      rowsFailed: progress.value?.rowsFailed ?? 0,
      failures: progress.value?.failures ?? [],
      failuresTruncated: progress.value?.failuresTruncated ?? false,
    };
  } finally {
    refreshImportElapsedClock();
    stopImportElapsedClock();
    running.value = false;
    cancelling.value = false;
    if (!minimized.value) backgroundMode.value = false;
  }
}

async function startBatchImport() {
  if (!props.prefillConnectionId || !canImport.value) return;
  // Keep original indices for the active preview and error state, even when
  // the import queue excludes worksheets between selected tasks.
  const tasks = batchTasks.value.map((task, index) => ({ task, index })).filter(({ task }) => task.selected);
  backgroundMode.value = true;
  running.value = true;
  progressPercentFloor.value = 0;
  cancelling.value = false;
  errorMessage.value = "";
  wizardStep.value = "execution";
  const totalRowsExact = tasks.every(({ task }) => task.preview.totalRowsExact !== false);
  const totalRows = totalRowsExact ? tasks.reduce((sum, { task }) => sum + task.preview.totalRows, 0) : 0;
  const totalBytes = tasks.reduce((sum, { task }) => sum + task.preview.sizeBytes, 0);
  let completedRows = 0;
  let completedBytes = 0;
  let completedFailures = 0;
  let completedFailureList: api.TableImportFailure[] = [];
  let completedFailuresTruncated = false;
  importId.value = uuid();
  startImportElapsedClock();
  progress.value = { importId: importId.value, status: "running", phase: "preparing", rowsImported: 0, totalRows, totalRowsExact, bytesRead: 0, totalBytes, elapsedMs: 0 };

  try {
    const tableNames = tasks.map(({ task }) => task.tableName.trim().toLowerCase());
    if (new Set(tableNames).size !== tableNames.length) throw new Error("Target table names must be unique");
    for (const [queueIndex, { task, index }] of tasks.entries()) {
      activeTaskIndex.value = index;
      task.status = "running";
      importId.value = uuid();
      const sourceMappings = task.preview.columns
        .map((sourceColumn) => ({
          sourceColumn,
          targetColumn: task.columnMapping[sourceColumn] ?? "",
          generator: task.columnGenerators?.[sourceColumn] || undefined,
          targetDataType: String(task.columnDataTypes[sourceColumn] ?? "").trim(),
        }))
        .filter((mapping) => mapping.targetColumn);
      const extraMappings = (task.generatedColumns || [])
        .filter((item) => item.targetColumn && item.targetColumn.trim())
        .map((item) => ({
          sourceColumn: "",
          targetColumn: item.targetColumn.trim(),
          generator: item.generator || "uuid",
          targetDataType: item.targetDataType || suggestDataTypeForGenerator(item.generator, structureDatabaseType.value),
        }));
      const mappings = [...sourceMappings, ...extraMappings];
      const validation = validateImportMappings(mappings);
      if (!task.tableName.trim() || !validation.valid) {
        throw new Error(validation.errors[0] || "Target table name is required");
      }

      const summary = await api.importTableFile(
        {
          importId: importId.value,
          connectionId: props.prefillConnectionId,
          database: props.prefillDatabase || "",
          schema: targetSchema.value,
          table: task.tableName,
          filePath: task.preview.filePath,
          sourceRef: task.preview.sourceRef || null,
          sourceFormat: task.format,
          parseOptions: importParseOptions(task.format, task.preview, task.sheetName),
          mappings,
          mode: "append",
          createTable: true,
          batchSize: Math.max(1, Number(batchSize.value) || 500),
          conflictPolicy: conflictPolicy.value,
          skipDuplicateRows: conflictPolicy.value === "skip",
          continueOnError: continueOnError.value,
          dateTimeFormat: settingsStore.editorSettings.globalDateTimeImportFormat || undefined,
          preparedSource: preparedImportSource(task.preview),
          retainSource: true,
        },
        (nextProgress) => {
          task.rowsImported = nextProgress.rowsImported;
          task.rowsFailed = nextProgress.rowsFailed ?? 0;
          const hasRemainingTasks = queueIndex < tasks.length - 1;
          const aggregateStatus = nextProgress.status === "done" && hasRemainingTasks ? "running" : nextProgress.status;
          const aggregatePhase = nextProgress.status === "done" && hasRemainingTasks ? "preparing" : nextProgress.phase;
          progress.value = {
            ...nextProgress,
            status: aggregateStatus,
            phase: aggregatePhase,
            rowsImported: completedRows + nextProgress.rowsImported,
            rowsFailed: completedFailures + (nextProgress.rowsFailed ?? 0),
            failures: [...completedFailureList, ...(nextProgress.failures ?? [])],
            failuresTruncated: completedFailuresTruncated || !!nextProgress.failuresTruncated,
            totalRows,
            totalRowsExact,
            bytesRead: completedBytes + (nextProgress.bytesRead ?? 0),
            totalBytes,
            elapsedMs: liveElapsedMs.value,
          };
        },
      );
      task.status = "done";
      task.rowsImported = summary.rowsImported;
      task.rowsFailed = summary.rowsFailed ?? 0;
      completedRows += summary.rowsImported;
      completedFailures += summary.rowsFailed ?? 0;
      completedFailureList = [...completedFailureList, ...(summary.failures ?? [])];
      completedFailuresTruncated ||= summary.failuresTruncated ?? false;
      completedBytes += task.preview.sizeBytes;
      store.invalidateMetadataCache(props.prefillConnectionId, props.prefillDatabase || "", targetSchema.value || undefined, task.tableName);
    }
    refreshImportElapsedClock();
    progress.value = {
      importId: importId.value,
      status: "done",
      phase: "done",
      rowsImported: completedRows,
      rowsFailed: completedFailures,
      failures: completedFailureList,
      failuresTruncated: completedFailuresTruncated,
      totalRows: completedRows,
      totalRowsExact: true,
      bytesRead: totalBytes,
      totalBytes,
      elapsedMs: liveElapsedMs.value,
    };
    toast(importSummaryMessage(completedRows, completedFailures), 2500);
    store.refreshObjectListTreeNode(props.prefillConnectionId, props.prefillDatabase || "", targetSchema.value || undefined).catch((error) => {
      console.warn("[DBX][table-import:refresh-created-table-failed]", error);
    });
  } catch (e: any) {
    const task = batchTasks.value[activeTaskIndex.value];
    const message = String(e?.message || e);
    if (task) {
      task.status = progress.value?.status === "cancelled" ? "cancelled" : "error";
      task.error = message;
    }
    errorMessage.value = message;
    progress.value = {
      importId: importId.value,
      status: progress.value?.status === "cancelled" ? "cancelled" : "error",
      rowsImported: progress.value?.rowsImported ?? completedRows,
      totalRows,
      elapsedMs: progress.value?.elapsedMs ?? liveElapsedMs.value,
      error: message,
      rowsFailed: progress.value?.rowsFailed ?? completedFailures,
      failures: progress.value?.failures ?? completedFailureList,
      failuresTruncated: progress.value?.failuresTruncated ?? completedFailuresTruncated,
    };
  } finally {
    refreshImportElapsedClock();
    stopImportElapsedClock();
    await releaseTableImportSources();
    running.value = false;
    cancelling.value = false;
    if (!minimized.value) backgroundMode.value = false;
  }
}

async function releaseTableImportSources() {
  const sourceRefs = new Set<string>();
  if (preview.value?.sourceRef) sourceRefs.add(preview.value.sourceRef);
  for (const task of batchTasks.value) {
    if (task.preview.sourceRef) sourceRefs.add(task.preview.sourceRef);
  }
  await Promise.allSettled([...sourceRefs].map((sourceRef) => api.releaseTableImportSource(sourceRef)));
}

async function cancelImport() {
  if (!importId.value) return;
  cancelling.value = true;
  await api.cancelTableImport(importId.value);
}

function schedulePreviewReload() {
  // Batch tasks own independent previews and mappings; reloading the active task would overwrite its saved configuration.
  if (isBatchImport.value || !selectedSource.value || running.value) return;
  if (previewReloadTimer) clearTimeout(previewReloadTimer);
  previewReloadTimer = setTimeout(() => {
    void loadPreview();
  }, 250);
}

function schedulePreviewReloadAfterEncodingChange() {
  if (isBatchImport.value) {
    void reloadBatchPreviewsForEncoding();
    return;
  }
  if (!selectedSource.value || running.value) return;
  previewRequestId++;
  if (previewReloadTimer) clearTimeout(previewReloadTimer);
  previewReloadTimer = setTimeout(() => {
    void loadPreview();
  }, 250);
}

async function reloadBatchPreviewsForEncoding() {
  if (!isBatchImport.value || running.value) return;
  const requestId = ++batchEncodingRequestId;
  loadingPreview.value = true;
  errorMessage.value = "";
  try {
    for (const task of batchTasks.value) {
      // SQL 脚本同样是文本源，编码变化时需要重新预览
      if (!isDelimitedFormat(task.format) && task.format !== "sql") continue;
      const input = importPreviewInput(uploadedImportSourceFromPreview(task.preview), task.source);
      const nextPreview = await api.previewTableImportFile(input.fileOrPath, {
        connectionId: props.prefillConnectionId,
        database: props.prefillDatabase || "",
        sourceRef: input.sourceRef,
        sourceFormat: task.format,
        parseOptions: taskParseOptions(task.format, task.sheetName),
        previewLimit: Math.max(1, Number(previewLimit.value) || 50),
      });
      if (requestId !== batchEncodingRequestId) return;
      task.preview = nextPreview;
      task.columnMapping = Object.fromEntries(nextPreview.columns.map((column) => [column, column]));
      task.columnDataTypes = suggestImportTargetDataTypes(nextPreview.columns, nextPreview.rows, structureDatabaseType.value);
    }
    activateBatchTask(activeTaskIndex.value);
  } catch (e: any) {
    if (requestId === batchEncodingRequestId) {
      preview.value = null;
      errorMessage.value = String(e?.message || e);
    }
  } finally {
    if (requestId === batchEncodingRequestId) loadingPreview.value = false;
  }
}

watch(
  open,
  (value) => {
    if (value) {
      resetState();
      if (showSchemaSelector.value) void loadSchemaOptions();
      void loadTargetColumns();
      void loadDataTypeOptions();
    } else {
      minimized.value = false;
      backgroundMode.value = false;
      dialogDragOffset.value = { x: 0, y: 0 };
      if (previewReloadTimer) {
        clearTimeout(previewReloadTimer);
        previewReloadTimer = null;
      }
      if (!running.value) void releaseTableImportSources();
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopDialogDrag();
  if (previewReloadTimer) {
    clearTimeout(previewReloadTimer);
    previewReloadTimer = null;
  }
});

watch([sourceFormat, delimiter, titleRow, dataStartRow, lastDataRow, trimValues, emptyStringAsNull, selectedSheet, jsonShape, previewLimit], schedulePreviewReload);
watch([textEncoding, decimalSeparator], schedulePreviewReloadAfterEncodingChange);
watch([newTableName, columnMapping, columnGenerators, generatedColumns, columnDataTypes], saveActiveBatchTask, { deep: true });
watch(wizardStep, (step) => {
  if (step !== "mapping") {
    closeDataTypePicker();
    closeGeneratorPicker();
  }
  if (step === "options") {
    if (showSchemaSelector.value) void loadSchemaOptions();
    void loadExistingTables();
    if (!preview.value && selectedSource.value && !isBatchImport.value && !loadingPreview.value) {
      void loadPreview();
    }
  }
});
watch(targetMode, (mode) => {
  if (mode === "existing") {
    columnDataTypes.value = {};
    dynamicDataTypeOptions.value = [];
    if (!existingTableNames.value.length) void loadExistingTables();
    void loadTargetColumns();
  } else {
    targetColumnsRequestId++;
    targetColumns.value = [];
    loadedTargetTableName.value = "";
    loadingTarget.value = false;
    importMode.value = "append";
    conflictPolicy.value = "error";
    applyAutoMapping();
    applySuggestedColumnDataTypes();
    void loadDataTypeOptions();
  }
});
watch(selectedExistingTable, () => {
  if (targetMode.value === "existing") {
    conflictPolicy.value = "error";
    void loadTargetColumns();
  }
});

watch(rawProgressPercent, (percent) => {
  if (progress.value?.status === "running") {
    progressPercentFloor.value = Math.max(progressPercentFloor.value, percent);
  } else if (progress.value?.status === "done") {
    progressPercentFloor.value = 100;
  }
});
</script>

<template>
  <Dialog :open="open" :modal="!backgroundMode" @update:open="handleOpenChange">
    <DialogScrollContent v-if="!minimized" class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 flex-col overflow-hidden sm:max-w-[980px]" :style="dialogStyle" :trap-focus="false" :show-overlay="!backgroundMode" :show-close-button="false" @interact-outside.prevent>
      <DialogHeader class="shrink-0 flex-row items-center pr-8" @pointerdown="startDialogDrag">
        <DialogTitle class="flex min-w-0 flex-1 items-center gap-2 text-base">
          <FileUp class="h-4 w-4" />
          {{ dialogTitle }}
        </DialogTitle>
        <Button variant="ghost" size="icon-sm" :aria-label="t('tableImport.minimize')" :title="t('tableImport.minimize')" @pointerdown.stop @click="minimizeImport">
          <Minimize2 class="h-4 w-4" />
        </Button>
        <Button v-if="!running" variant="ghost" size="icon-sm" :aria-label="t('common.close')" :title="t('common.close')" @pointerdown.stop @click="handleOpenChange(false)">
          <X class="h-4 w-4" />
        </Button>
      </DialogHeader>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <input ref="fileInput" type="file" :accept="importFileExtensions.map((extension) => `.${extension}`).join(',')" :multiple="targetMode === 'create'" class="hidden" @change="handleFileInputChange" />
          <input v-if="supportsNavicatBackupImport" ref="navicatBackupInput" data-testid="table-import-nb3-input" type="file" :accept="`.${NAVICAT_BACKUP_FORMAT}`" class="hidden" @change="handleNavicatBackupInputChange" />
          <div class="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-muted/20 px-3">
            <span class="shrink-0 text-xs text-muted-foreground">{{ t("tableImport.target") }}</span>
            <span class="min-w-0 truncate text-sm font-medium">
              {{ targetLabel || t("editor.noDatabase") }}
            </span>
          </div>
          <Button variant="outline" class="h-10 px-3" :disabled="running || loadingPreview" @click="selectFile">
            <Loader2 v-if="loadingPreview" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            <Upload v-else class="mr-1.5 h-3.5 w-3.5" />
            {{ selectedSource ? t("tableImport.changeFile") : t("tableImport.selectFile") }}
          </Button>
        </div>

        <div v-if="isBatchImport" class="rounded-md border">
          <div class="flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
            <span>{{ t("tableImport.selectedTasks", { selected: selectedBatchTasks.length, total: batchTasks.length }) }}</span>
            <span class="text-muted-foreground">{{ selectedSourceName }}</span>
          </div>
          <div class="flex max-h-32 flex-wrap gap-1.5 overflow-auto p-2">
            <div v-for="(task, index) in batchTasks" :key="task.id" class="flex max-w-[260px] items-center gap-1.5 rounded-md border pl-2 text-xs transition-colors" :class="index === activeTaskIndex ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/60'">
              <input v-model="task.selected" type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-primary" :aria-label="t('tableImport.selectTask', { name: task.tableName })" :disabled="running || !task.preview.rows.length" />
              <button
                type="button"
                class="flex min-w-0 items-center gap-1.5 py-1 pr-2"
                :disabled="running"
                @click="
                  saveActiveBatchTask();
                  activateBatchTask(index);
                "
              >
                <CheckCircle2 v-if="task.status === 'done'" class="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <Loader2 v-else-if="task.status === 'running'" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                <AlertTriangle v-else-if="task.status === 'error'" class="h-3.5 w-3.5 shrink-0 text-destructive" />
                <FileSpreadsheet v-else-if="task.format === 'excel'" class="h-3.5 w-3.5 shrink-0" />
                <FileText v-else class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ task.tableName }}</span>
                <span v-if="!task.preview.rows.length" class="shrink-0 text-muted-foreground">{{ t("tableImport.rows") }}: 0</span>
                <span v-else-if="task.rowsFailed > 0" class="shrink-0 text-amber-600 dark:text-amber-400">{{ t("tableImport.failedRows", { count: task.rowsFailed }) }}</span>
              </button>
            </div>
          </div>
          <p v-if="!selectedBatchTasks.length" class="px-3 pb-2 text-xs text-muted-foreground">{{ t("tableImport.noTasksSelected") }}</p>
        </div>

        <nav class="rounded-md border bg-muted/20 px-3 py-2" :aria-label="t('tableImport.progress')">
          <ol class="grid grid-cols-5">
            <li v-for="(step, index) in wizardSteps" :key="step.value" class="relative flex min-w-0 justify-center">
              <div v-if="index > 0" class="pointer-events-none absolute left-0 right-1/2 top-3.5 h-px" :class="wizardStepConnectorClass(index, true)" />
              <div v-if="index < wizardSteps.length - 1" class="pointer-events-none absolute left-1/2 right-0 top-3.5 h-px" :class="wizardStepConnectorClass(index, false)" />
              <button
                type="button"
                class="relative z-10 flex min-w-0 flex-col items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors"
                :class="[wizardStepTextClass(step.value), canOpenStep(step.value) ? 'cursor-pointer' : 'cursor-default']"
                :disabled="!canOpenStep(step.value)"
                :aria-current="isWizardStepActive(step.value) ? 'step' : undefined"
                @click="wizardStep = step.value"
              >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold" :class="wizardStepCircleClass(step.value)">
                  <Check v-if="isWizardStepComplete(step.value)" class="h-3.5 w-3.5" />
                  <span v-else>{{ index + 1 }}</span>
                </span>
                <span class="max-w-full truncate">{{ t(step.labelKey) }}</span>
              </button>
            </li>
          </ol>
        </nav>

        <div v-if="wizardStep === 'source'" class="space-y-4">
          <div class="rounded-md border border-dashed p-6 text-center">
            <FileUp class="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <div class="text-sm font-medium">{{ selectedSourceName || t("tableImport.noFileSelected") }}</div>
            <Button class="mt-4" size="sm" @click="selectFile">
              <Upload class="mr-1.5 h-3.5 w-3.5" />
              {{ t("tableImport.selectFile") }}
            </Button>
          </div>
          <div
            data-testid="table-import-format-options"
            class="grid grid-cols-2 gap-2 sm:grid-cols-3"
            :class="{
              'lg:grid-cols-6': sourceFormatCards.length === 6,
              'lg:grid-cols-7': sourceFormatCards.length === 7,
            }"
          >
            <button
              v-for="format in sourceFormatCards"
              :key="format.value"
              type="button"
              :data-format="format.value"
              class="min-h-20 rounded-md border px-3 py-2 text-left"
              :class="sourceFormat === format.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'"
              :disabled="loadingPreview"
              @click="selectFormatCard(format.value)"
            >
              <component :is="format.icon" class="mb-2 h-4 w-4 text-muted-foreground" />
              <div class="text-xs font-medium">{{ t(format.labelKey) }}</div>
              <div class="mt-1 text-[11px] leading-snug text-muted-foreground">{{ t(format.descriptionKey) }}</div>
            </button>
          </div>
        </div>

        <div v-else-if="wizardStep === 'options'" class="space-y-4">
          <div class="grid grid-cols-3 gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.sourceFormat") }}</Label>
              <Select :model-value="sourceFormat" @update:model-value="(value: any) => (sourceFormat = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="format in availableFormatOptions" :key="format.value" :value="format.value">
                    {{ t(format.labelKey) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.previewRows") }}</Label>
              <Input v-model.number="previewLimit" type="number" min="1" max="500" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.sourceFile") }}</Label>
              <div class="flex h-8 items-center rounded-md border px-2 text-xs">
                <span class="truncate">{{ selectedSourceName || t("tableImport.noFileSelected") }}</span>
              </div>
            </div>
          </div>

          <div class="grid gap-3 rounded-md border p-3" :class="showSchemaSelector ? 'grid-cols-1 md:grid-cols-[minmax(0,1.2fr)_minmax(140px,1fr)_minmax(180px,1.2fr)]' : 'grid-cols-[minmax(0,1fr)_minmax(220px,320px)]'">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.targetMode") }}</Label>
              <div class="grid grid-cols-2 gap-2">
                <button type="button" class="rounded-md border px-3 py-2 text-left text-xs" :class="targetMode === 'existing' ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'" :disabled="!hasExistingTarget" @click="targetMode = 'existing'">
                  <div class="font-medium">{{ t("tableImport.existingTable") }}</div>
                  <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ selectedExistingTable || t("tableImport.noExistingTarget") }}</div>
                </button>
                <button type="button" class="rounded-md border px-3 py-2 text-left text-xs" :class="targetMode === 'create' ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'" @click="targetMode = 'create'">
                  <div class="font-medium">{{ t("tableImport.createTable") }}</div>
                  <div class="mt-1 text-[11px] text-muted-foreground">{{ t("tableImport.createTableHint") }}</div>
                </button>
              </div>
            </div>
            <div v-if="showSchemaSelector" class="space-y-1.5">
              <Label class="text-xs">{{ t("transfer.targetSchema") }}</Label>
              <div v-if="props.prefillTable" class="flex h-8 items-center rounded-md border px-2 text-xs font-mono">
                <span class="truncate">{{ targetSchema || props.prefillSchema || "-" }}</span>
              </div>
              <SearchableSelect
                v-else
                data-testid="target-schema-select"
                :model-value="selectedSchema"
                :options="schemaOptions.length ? schemaOptions : selectedSchema ? [selectedSchema] : []"
                :placeholder="t('transfer.selectSchema')"
                :search-placeholder="t('transfer.searchSchema')"
                :empty-text="t('common.noResults')"
                :loading-text="t('common.loading')"
                :loading="loadingSchemas"
                :allow-custom="true"
                trigger-class="h-8 font-mono text-xs"
                @update:model-value="handleSchemaChange"
                @update:open="
                  (isOpen) => {
                    if (isOpen) void loadSchemaOptions();
                  }
                "
              />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.targetTableName") }}</Label>
              <Input v-if="targetMode === 'create'" v-model="newTableName" class="h-8 text-xs font-mono" />
              <div v-else-if="props.prefillTable" class="flex h-8 items-center rounded-md border px-2 text-xs">
                <span class="truncate">{{ props.prefillTable }}</span>
              </div>
              <SearchableSelect
                v-else
                data-testid="target-table-select"
                :model-value="selectedExistingTable"
                :options="existingTableNames"
                :placeholder="t('tableImport.noExistingTarget')"
                :search-placeholder="t('tableImport.searchExistingTables')"
                :empty-text="t('tableImport.noTables')"
                :loading-text="t('tableImport.loadingTables')"
                :loading="loadingExistingTables"
                :disabled="loadingExistingTables || !existingTableNames.length"
                trigger-class="h-8 font-mono text-xs"
                @update:model-value="(value) => (selectedExistingTable = value)"
              />
            </div>
          </div>

          <div v-if="sourceFormat === 'csv' || sourceFormat === 'tsv' || sourceFormat === 'delimited'" class="grid grid-cols-2 gap-3 rounded-md border p-3 md:grid-cols-3 xl:grid-cols-6">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.encoding") }}</Label>
              <Select :model-value="textEncoding" @update:model-value="(value: any) => (textEncoding = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in encodingOptions" :key="option.value" :value="option.value">
                    {{ t(option.labelKey) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div v-if="textEncoding === 'auto' && preview?.effectiveEncoding" class="truncate text-[11px] text-muted-foreground" :title="t('tableImport.encodingDetected', { encoding: encodingLabel(preview.effectiveEncoding) })">
                {{ t("tableImport.encodingDetected", { encoding: encodingLabel(preview.effectiveEncoding) }) }}
              </div>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.delimiter") }}</Label>
              <Input v-model="delimiter" :disabled="sourceFormat !== 'delimited'" class="h-8 text-xs font-mono" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.decimalSeparator") }}</Label>
              <Select v-model="decimalSeparator">
                <SelectTrigger class="h-8 text-xs font-mono" :aria-label="t('tableImport.decimalSeparator')">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value=".">.</SelectItem>
                  <SelectItem value=",">,</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.titleRow") }}</Label>
              <Input v-model.number="titleRow" type="number" min="0" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.dataStartRow") }}</Label>
              <Input v-model.number="dataStartRow" type="number" min="1" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.lastDataRow") }}</Label>
              <Input v-model.number="lastDataRow" type="number" min="0" class="h-8 text-xs" />
            </div>
            <label class="flex items-center gap-2 text-xs">
              <input v-model="trimValues" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
              {{ t("tableImport.trimValues") }}
            </label>
            <div class="space-y-1">
              <label class="flex items-center gap-2 text-xs">
                <input v-model="emptyStringAsNull" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
                {{ t("tableImport.emptyStringAsNull") }}
              </label>
              <p class="text-[11px] text-muted-foreground">{{ t("tableImport.emptyStringAsNullHint") }}</p>
            </div>
          </div>

          <div v-else-if="sourceFormat === 'sql'" class="grid grid-cols-5 gap-3 rounded-md border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.encoding") }}</Label>
              <Select :model-value="textEncoding" @update:model-value="(value: any) => (textEncoding = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in encodingOptions" :key="option.value" :value="option.value">
                    {{ t(option.labelKey) }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <div v-if="textEncoding === 'auto' && preview?.effectiveEncoding" class="truncate text-[11px] text-muted-foreground" :title="t('tableImport.encodingDetected', { encoding: encodingLabel(preview.effectiveEncoding) })">
                {{ t("tableImport.encodingDetected", { encoding: encodingLabel(preview.effectiveEncoding) }) }}
              </div>
            </div>
          </div>

          <div v-else-if="sourceFormat === 'json'" class="grid grid-cols-2 gap-3 rounded-md border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.jsonShape") }}</Label>
              <Select :model-value="jsonShape" @update:model-value="(value: any) => (jsonShape = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{{ t("tableImport.jsonShapeAuto") }}</SelectItem>
                  <SelectItem value="objects">{{ t("tableImport.jsonShapeObjects") }}</SelectItem>
                  <SelectItem value="arrays">{{ t("tableImport.jsonShapeArrays") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div v-else-if="sourceFormat === 'excel'" class="grid grid-cols-4 gap-3 rounded-md border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.sheet") }}</Label>
              <Input v-if="isBatchImport" :model-value="selectedSheet || preview?.sheets?.[0] || t('tableImport.firstSheet')" :aria-label="t('tableImport.sheet')" readonly class="h-8 text-xs" />
              <Select v-else :model-value="selectedSheet" :disabled="!preview?.sheets?.length" @update:model-value="(value: any) => (selectedSheet = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('tableImport.firstSheet')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="sheet in preview?.sheets || []" :key="sheet" :value="sheet">{{ sheet }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.titleRow") }}</Label>
              <Input v-model.number="titleRow" type="number" min="0" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.dataStartRow") }}</Label>
              <Input v-model.number="dataStartRow" type="number" min="1" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.lastDataRow") }}</Label>
              <Input v-model.number="lastDataRow" type="number" min="0" class="h-8 text-xs" />
            </div>
            <div class="col-span-4 space-y-1">
              <label class="flex items-center gap-2 text-xs">
                <input v-model="emptyStringAsNull" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
                {{ t("tableImport.emptyStringAsNull") }}
              </label>
              <p class="text-[11px] text-muted-foreground">{{ t("tableImport.emptyStringAsNullExcelHint") }}</p>
            </div>
          </div>

          <div v-if="supportsImportConflictPolicy" class="space-y-1.5 rounded-md border p-3">
            <Label for="table-import-conflict-policy" class="text-xs">{{ t("tableImport.conflictPolicy") }}</Label>
            <select id="table-import-conflict-policy" v-model="conflictPolicy" data-testid="table-import-conflict-policy" class="flex h-8 w-full rounded-md border border-input bg-background text-foreground px-2 text-xs [color-scheme:light] dark:[color-scheme:dark]">
              <option value="error" class="bg-popover text-popover-foreground">{{ t("tableImport.conflictError") }}</option>
              <option value="skip" class="bg-popover text-popover-foreground">{{ t("tableImport.skipDuplicateRows") }}</option>
              <option v-if="targetMode === 'existing'" value="updateExisting" :disabled="!canSelectUpdateExisting" class="bg-popover text-popover-foreground">
                {{ t("tableImport.updateExistingRows") }}
              </option>
            </select>
            <p v-if="targetMode === 'existing' && !canSelectUpdateExisting" class="text-[11px] text-muted-foreground">
              {{ updateExistingDisabledReason }}
            </p>
          </div>

          <div class="space-y-1 rounded-md border p-3">
            <label class="flex items-center gap-2 text-xs">
              <input v-model="continueOnError" type="checkbox" data-testid="table-import-continue-on-error" class="h-3.5 w-3.5 accent-primary" />
              {{ t("tableImport.continueOnError") }}
            </label>
            <p class="text-[11px] text-muted-foreground">{{ t("tableImport.continueOnErrorHint") }}</p>
          </div>

          <div class="flex items-center gap-2">
            <Button size="sm" :disabled="!selectedSource || loadingPreview" @click="loadPreview()">
              <Loader2 v-if="loadingPreview" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
              <RefreshCw v-else class="mr-1.5 h-3.5 w-3.5" />
              {{ preview ? t("tableImport.reloadPreview") : t("tableImport.loadPreview") }}
            </Button>
            <span v-if="preview" class="text-xs text-muted-foreground">
              {{ preview.totalRowsExact !== false ? t("tableImport.previewReady", { rows: preview.totalRows, columns: preview.columns.length }) : t("tableImport.previewReadyPartial", { rows: preview.rows.length, columns: preview.columns.length }) }}
            </span>
          </div>
        </div>

        <div v-else-if="wizardStep === 'mapping'" class="space-y-3">
          <div v-if="preview" class="grid grid-cols-3 gap-2 text-xs">
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.file") }}</div>
              <div class="truncate font-medium">{{ preview.fileName }}</div>
            </div>
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.rows") }}</div>
              <div class="font-medium">{{ previewRowsLabel(preview) }}</div>
            </div>
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.mapped") }}</div>
              <div class="font-medium">{{ mappedCount }} / {{ preview.columns.length }}</div>
            </div>
          </div>

          <div v-if="preview" class="grid gap-3" :class="targetMode === 'create' ? 'grid-cols-[minmax(460px,580px)_1fr]' : 'grid-cols-[minmax(380px,480px)_1fr]'">
            <div class="rounded-md border">
              <div class="flex items-center justify-between border-b px-3 py-1.5 text-xs font-medium">
                <span>{{ t("tableImport.mapping") }}</span>
                <div class="flex items-center gap-1.5 font-normal">
                  <button type="button" data-action="add-generated-column" class="flex items-center gap-1 text-xs text-primary hover:underline font-medium" @click="() => addGeneratedColumn()">
                    <Plus class="h-3.5 w-3.5" />
                    {{ t("tableImport.addGeneratedColumn") }}
                  </button>
                  <template v-if="targetMode === 'existing'">
                    <span class="text-muted-foreground/40">·</span>
                    <button type="button" data-action="map-by-position" class="text-xs text-muted-foreground hover:text-foreground hover:underline" @click="mapByPosition">
                      {{ t("tableImport.mapByPosition") }}
                    </button>
                    <span class="text-muted-foreground/40">·</span>
                    <button type="button" data-action="map-by-name" class="text-xs text-muted-foreground hover:text-foreground hover:underline" @click="mapByName">
                      {{ t("tableImport.mapByName") }}
                    </button>
                    <span class="text-muted-foreground/40">·</span>
                    <button type="button" data-action="skip-all" class="text-xs text-muted-foreground hover:text-foreground hover:underline" @click="skipAllColumns">
                      {{ t("tableImport.skipAll") }}
                    </button>
                  </template>
                </div>
              </div>
              <div class="max-h-[320px] overflow-auto p-2">
                <div class="grid items-center gap-2 border-b px-1 pb-1 text-[11px] font-medium text-muted-foreground" :class="targetMode === 'create' ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)_minmax(92px,120px)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)]'">
                  <span>{{ t("tableImport.sourceColumn") }}</span>
                  <span>{{ t("tableImport.targetColumn") }}</span>
                  <span>{{ t("tableImport.generator") }}</span>
                  <span v-if="targetMode === 'create'">{{ t("tableImport.targetDataType") }}</span>
                </div>
                <div v-for="sourceColumn in preview.columns" :key="sourceColumn" class="grid items-center gap-2 py-1" :class="targetMode === 'create' ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)_minmax(92px,120px)]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)]'">
                  <div class="truncate font-mono text-xs" :title="sourceColumn">
                    {{ sourceColumn }}
                  </div>
                  <!-- 原生 input/select: 200+ 列时 Vue Input/Select 组件是渲染瓶颈 -->
                  <input
                    v-if="targetMode === 'create'"
                    :value="columnMapping[sourceColumn] ?? sourceColumn"
                    class="h-7 w-full min-w-0 rounded-md border bg-background px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                    @input="(e) => updateMapping(sourceColumn, (e.target as HTMLInputElement).value)"
                  />
                  <select
                    v-else
                    :value="columnMapping[sourceColumn] || SKIP_VALUE"
                    class="h-7 w-full min-w-0 rounded-md border border-input bg-background text-foreground px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25 [color-scheme:light] dark:[color-scheme:dark]"
                    @change="(e) => updateMapping(sourceColumn, (e.target as HTMLSelectElement).value)"
                  >
                    <option :value="SKIP_VALUE" class="bg-popover text-popover-foreground">{{ t("tableImport.skipColumn") }}</option>
                    <option v-for="column in targetColumns" :key="column.name" :value="column.name" class="bg-popover text-popover-foreground">
                      {{ column.name }}
                    </option>
                  </select>
                  <!-- Generator selector button -->
                  <button
                    type="button"
                    data-generator-picker
                    class="h-7 w-full truncate rounded-md border bg-background px-2 text-left text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                    :class="columnGenerators[sourceColumn] ? 'text-primary font-medium' : 'text-muted-foreground'"
                    @click="(e) => openGeneratorPicker({ type: 'source', sourceColumn }, e.currentTarget as HTMLElement)"
                  >
                    {{ generatorLabel(columnGenerators[sourceColumn]) }}
                  </button>
                  <!-- 数据类型：plain input + 全局 popover，点击才弹出 -->
                  <div v-if="targetMode === 'create'" class="relative">
                    <input
                      data-dt-input
                      :value="columnDataTypes[sourceColumn] || ''"
                      :placeholder="t('tableImport.targetDataType')"
                      role="combobox"
                      aria-autocomplete="list"
                      :aria-expanded="activeDataTypeColumn === sourceColumn && dataTypePickerOpen"
                      aria-controls="table-import-data-type-options"
                      :aria-activedescendant="activeDataTypeColumn === sourceColumn && activeDataTypeOptionIndex >= 0 ? `table-import-data-type-option-${activeDataTypeOptionIndex}` : undefined"
                      class="h-7 w-full min-w-0 rounded-md border bg-background px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                      @focus="(event) => openDataTypePicker(sourceColumn, event.currentTarget as HTMLInputElement)"
                      @blur="closeDataTypePicker"
                      @keydown="(event) => handleDataTypePickerKeydown(event, sourceColumn, event.currentTarget as HTMLInputElement)"
                      @input="(e) => updateColumnDataType(sourceColumn, (e.target as HTMLInputElement).value)"
                    />
                  </div>
                </div>

                <!-- 自定义生成列列表 -->
                <div v-if="generatedColumns.length" class="mt-2 border-t pt-2 space-y-1">
                  <div class="px-1 pb-1 text-[11px] font-medium text-muted-foreground">
                    {{ t("tableImport.generatedColumns") }}
                  </div>
                  <div
                    v-for="genCol in generatedColumns"
                    :key="genCol.id"
                    class="grid items-center gap-2 py-1"
                    :class="targetMode === 'create' ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)_minmax(92px,120px)_28px]' : 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(110px,130px)_28px]'"
                  >
                    <div class="truncate font-mono text-xs text-muted-foreground italic">({{ t("tableImport.generator") }})</div>
                    <input
                      v-if="targetMode === 'create'"
                      :value="genCol.targetColumn"
                      :placeholder="t('tableImport.targetColumn')"
                      class="h-7 w-full min-w-0 rounded-md border bg-background px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                      @input="(e) => updateGeneratedColumn(genCol.id, { targetColumn: (e.target as HTMLInputElement).value })"
                    />
                    <select
                      v-else
                      data-generated-target-select
                      :value="genCol.targetColumn || ''"
                      class="h-7 w-full min-w-0 rounded-md border border-input bg-background text-foreground px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25 [color-scheme:light] dark:[color-scheme:dark]"
                      @change="(e) => updateGeneratedColumn(genCol.id, { targetColumn: (e.target as HTMLSelectElement).value })"
                    >
                      <option value="" disabled class="bg-popover text-popover-foreground">{{ t("tableImport.selectTargetColumn") }}</option>
                      <option v-for="column in targetColumns" :key="column.name" :value="column.name" class="bg-popover text-popover-foreground">
                        {{ column.name }}
                      </option>
                    </select>
                    <button
                      type="button"
                      data-generator-picker
                      class="h-7 w-full truncate rounded-md border bg-background px-2 text-left text-xs font-mono font-medium text-primary shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                      @click="(e) => openGeneratorPicker({ type: 'generated', id: genCol.id }, e.currentTarget as HTMLElement)"
                    >
                      {{ generatorLabel(genCol.generator) }}
                    </button>
                    <input
                      v-if="targetMode === 'create'"
                      :value="genCol.targetDataType || ''"
                      :placeholder="t('tableImport.targetDataType')"
                      class="h-7 w-full min-w-0 rounded-md border bg-background px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25"
                      @input="(e) => updateGeneratedColumn(genCol.id, { targetDataType: (e.target as HTMLInputElement).value })"
                    />
                    <button type="button" class="flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground hover:bg-destructive/10 hover:text-destructive" :title="t('tableImport.removeGeneratedColumn')" @click="removeGeneratedColumn(genCol.id)">
                      <Trash2 class="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div class="min-w-0 rounded-md border">
              <div class="border-b px-3 py-2 text-xs font-medium">{{ t("tableImport.preview") }}</div>
              <div class="max-h-[320px] overflow-auto">
                <table class="min-w-full border-separate border-spacing-0 text-xs">
                  <thead class="sticky top-0 bg-background">
                    <tr>
                      <th v-for="column in preview.columns" :key="column" class="border-b border-r px-2 py-1.5 text-left font-medium transition-colors" :class="{ 'text-muted-foreground/60': isSourceColumnSkipped(column) }">
                        <span
                          class="block max-w-[140px] truncate"
                          :class="{ 'line-through text-muted-foreground': isSourceColumnSkipped(column) }"
                          :data-column-skipped="isSourceColumnSkipped(column) ? 'true' : undefined"
                          :title="isSourceColumnSkipped(column) ? `${column} (${t('tableImport.skipColumn')})` : column"
                        >
                          {{ column }}
                          <span v-if="columnGenerators[column]" class="ml-1 text-[10px] text-primary not-italic font-normal"> [{{ columnGenerators[column] }}] </span>
                        </span>
                      </th>
                      <th v-for="genCol in activeGeneratedColumns" :key="genCol.id" class="border-b border-r px-2 py-1.5 text-left font-medium transition-colors bg-muted/10">
                        <span class="block max-w-[140px] truncate text-primary font-medium" :title="`${genCol.targetColumn} (${genCol.generator})`">
                          {{ genCol.targetColumn }}
                          <span class="ml-1 text-[10px] text-muted-foreground">[{{ genCol.generator }}]</span>
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, rowIndex) in preview.rows" :key="rowIndex">
                      <td
                        v-for="(cell, colIndex) in row"
                        :key="colIndex"
                        class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono transition-colors"
                        :class="{
                          'text-muted-foreground': cell === null,
                          'text-muted-foreground/50 bg-muted/20': isSourceColumnSkipped(preview.columns[colIndex]),
                        }"
                      >
                        <span class="block truncate" :class="{ 'line-through': isSourceColumnSkipped(preview.columns[colIndex]) }" :data-cell-skipped="isSourceColumnSkipped(preview.columns[colIndex]) ? 'true' : undefined">
                          {{ formatTableImportPreviewCell(cell, columnGenerators[preview.columns[colIndex]], rowIndex) }}
                        </span>
                      </td>
                      <td v-for="genCol in activeGeneratedColumns" :key="genCol.id" class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono text-primary/80 bg-muted/5 transition-colors">
                        <span class="block truncate">
                          {{ formatTableImportPreviewCell(null, genCol.generator, rowIndex) }}
                        </span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div v-if="mappingValidation.errors.length" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {{ mappingValidation.errors.join("; ") }}
          </div>
          <div v-else-if="conflictPolicyError" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {{ conflictPolicyError }}
          </div>
          <div v-else-if="requiredUnmappedColumns.length" class="flex items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <div class="flex items-start gap-2 min-w-0">
              <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span class="break-words">{{ t("tableImport.requiredUnmapped", { columns: requiredUnmappedColumns.join(", ") }) }}</span>
            </div>
            <button
              type="button"
              data-action="auto-generate-required"
              class="shrink-0 rounded border border-amber-400 bg-white dark:bg-amber-950 px-2 py-1 text-xs font-medium text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900 transition-colors"
              @click="autoGenerateRequiredColumns"
            >
              {{ t("tableImport.autoGenerateRequired") }}
            </button>
          </div>
        </div>

        <div v-else-if="wizardStep === 'review'" class="space-y-3">
          <div class="grid grid-cols-2 gap-3 text-xs">
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.target") }}</div>
              <div class="truncate font-medium">{{ targetLabel }}</div>
            </div>
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.sourceFile") }}</div>
              <div class="truncate font-medium">{{ preview?.fileName }}</div>
            </div>
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.rows") }}</div>
              <div class="font-medium">{{ previewRowsLabel(preview) }}</div>
            </div>
            <div class="rounded-md border px-3 py-2">
              <div class="text-muted-foreground">{{ t("tableImport.mapped") }}</div>
              <div class="font-medium">{{ mappedCount }} / {{ preview?.columns.length || 0 }}</div>
            </div>
          </div>
          <div class="grid grid-cols-3 gap-3">
            <div v-if="targetMode === 'existing'" class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.mode") }}</Label>
              <Select :model-value="importMode" @update:model-value="(value: any) => (importMode = value)">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">{{ t("tableImport.append") }}</SelectItem>
                  <SelectItem value="truncate">{{ t("tableImport.truncate") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("transfer.batchSize") }}</Label>
              <Input v-model.number="batchSize" type="number" min="1" class="h-8 text-xs" />
            </div>
          </div>
          <div v-if="targetMode === 'create' && createColumnSummaries.length" class="rounded-md border">
            <div class="border-b px-3 py-2 text-xs font-medium">{{ t("tableImport.createColumns") }}</div>
            <div class="max-h-40 overflow-auto">
              <table class="min-w-full border-separate border-spacing-0 text-xs">
                <thead class="sticky top-0 bg-background">
                  <tr>
                    <th class="border-b border-r px-2 py-1.5 text-left font-medium">{{ t("tableImport.sourceColumn") }}</th>
                    <th class="border-b border-r px-2 py-1.5 text-left font-medium">{{ t("tableImport.targetColumn") }}</th>
                    <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("tableImport.targetDataType") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="column in createColumnSummaries" :key="column.sourceColumn">
                    <td class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono">
                      <span class="block truncate">{{ column.sourceColumn }}</span>
                    </td>
                    <td class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono">
                      <span class="block truncate">{{ column.targetColumn }}</span>
                    </td>
                    <td class="max-w-[140px] border-b px-2 py-1.5 font-mono">
                      <span class="block truncate">{{ column.targetDataType }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-if="importMode === 'truncate'" class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{{ t("tableImport.truncateWarning") }}</span>
          </div>
        </div>

        <div v-else class="space-y-4">
          <div class="rounded-md border px-4 py-5">
            <div class="flex items-center gap-3">
              <Square v-if="cancelling || progress?.status === 'cancelled'" class="h-5 w-5 fill-current text-destructive" />
              <CheckCircle2 v-else-if="progress?.status === 'done'" class="h-5 w-5 text-emerald-600" />
              <AlertTriangle v-else-if="progress?.status === 'error'" class="h-5 w-5 text-destructive" />
              <Loader2 v-else-if="running" class="h-5 w-5 animate-spin text-primary" />
              <FileUp v-else class="h-5 w-5 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium">{{ t(progressLabelKey) }}</div>
                <div class="mt-1 text-xs text-muted-foreground tabular-nums">
                  <template v-if="progress?.totalRowsExact !== false && (progress?.totalRows ?? 0) > 0">{{ progress?.rowsImported ?? 0 }} / {{ progress?.totalRows ?? 0 }}</template>
                  <template v-else>{{ progress?.rowsImported ?? 0 }} {{ t("tableImport.rowsImported") }}</template>
                  · {{ progressPercent }}% ·
                  {{ t("tableImport.elapsed", { duration: formatTableImportElapsed(displayedElapsedMs) }) }}
                  <template v-if="(progress?.rowsFailed ?? 0) > 0">
                    · <span class="text-amber-600 dark:text-amber-400">{{ t("tableImport.failedRows", { count: progress?.rowsFailed ?? 0 }) }}</span>
                  </template>
                </div>
              </div>
            </div>
            <div class="mt-4 h-2 overflow-hidden rounded bg-muted">
              <div class="h-full bg-primary transition-all" :style="{ width: `${progressPercent}%` }" />
            </div>
            <div v-if="activeImportFile" class="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <FileText class="h-3.5 w-3.5 shrink-0" />
              <span class="shrink-0">{{ t("tableImport.currentFile") }}</span>
              <span class="min-w-0 truncate font-mono" :title="activeImportFile">{{ activeImportFile }}</span>
            </div>
          </div>
          <div v-if="running" class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{{ t("tableImport.backgroundWarning") }}</span>
          </div>
          <div v-if="errorMessage || progress?.error" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {{ errorMessage || progress?.error }}
          </div>
          <div v-if="terminalStatus && importFailures.length" class="rounded-md border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20">
            <div class="flex items-center gap-2 border-b border-amber-200 px-3 py-2 text-xs font-medium text-amber-900 dark:border-amber-800 dark:text-amber-200">
              <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
              <span class="flex-1">{{ t("tableImport.failedRowsTitle") }}</span>
              <Button variant="outline" size="sm" class="h-6 px-2 text-xs" data-testid="table-import-copy-failures" @click="copyFailedRows">
                {{ t("tableImport.copyFailedRows") }}
              </Button>
            </div>
            <div class="max-h-40 overflow-auto p-2" data-testid="table-import-failures">
              <div v-for="(failure, index) in importFailures" :key="`${failure.table}-${failure.row}-${index}`" class="flex gap-2 rounded px-1 py-0.5 text-[11px] font-mono">
                <span class="shrink-0 text-amber-700 dark:text-amber-300">
                  <template v-if="failure.table">{{ t("tableImport.failureTable", { table: failure.table }) }} · </template>{{ t("tableImport.failureRow", { row: failure.row }) }}:
                </span>
                <span class="min-w-0 break-all text-foreground">{{ failure.error }}</span>
              </div>
            </div>
            <p v-if="progress?.failuresTruncated" class="px-3 pb-2 text-[11px] text-amber-800 dark:text-amber-300">
              {{ t("tableImport.failureListTruncated", { count: importFailures.length }) }}
            </p>
          </div>
        </div>

        <div v-if="loadingTarget" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-if="errorMessage && wizardStep !== 'execution'" class="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span class="flex-1">{{ errorMessage }}</span>
          <Button v-if="targetMode === 'existing' && !loadingTarget && !existingTargetMetadataReady" variant="outline" size="sm" class="h-6 px-2 text-xs" @click="loadTargetColumns()">
            {{ t("tableImport.retry") }}
          </Button>
        </div>
      </div>

      <!-- 全局数据类型 popover：仅一个实例，替代每列的 SearchableSelect -->
      <Teleport to="body">
        <div v-if="activeDataTypeColumn && dataTypePickerOpen" id="table-import-data-type-options" role="listbox" :style="dataTypePickerStyle" class="pointer-events-auto z-[9999] max-h-48 overflow-auto rounded-md border bg-popover p-0.5 shadow-md">
          <button
            v-for="(opt, index) in dataTypePickerOptions"
            :key="opt"
            :id="`table-import-data-type-option-${index}`"
            type="button"
            role="option"
            :aria-selected="opt === (activeDataTypeColumn ? columnDataTypes[activeDataTypeColumn] : '')"
            class="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground"
            :class="{ 'bg-accent/50': index === activeDataTypeOptionIndex || opt === (activeDataTypeColumn ? columnDataTypes[activeDataTypeColumn] : '') }"
            @pointerenter="activeDataTypeOptionIndex = index"
            @pointerdown.prevent="selectDataTypeOption(opt)"
          >
            {{ opt }}
          </button>
        </div>
      </Teleport>

      <!-- 全局生成器 popover -->
      <Teleport to="body">
        <div v-if="generatorPickerOpen" class="fixed inset-0 z-[9998]" @click="closeGeneratorPicker" />
        <div v-if="generatorPickerOpen" id="table-import-generator-options" role="listbox" :style="generatorPickerStyle" class="pointer-events-auto z-[9999] max-h-60 overflow-auto rounded-md border bg-popover p-1 shadow-md">
          <div class="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
            {{ t("tableImport.valueSource") }}
          </div>
          <button v-if="activeGeneratorColumn?.type === 'source'" type="button" role="option" class="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground" @click="selectGeneratorOption('')">
            {{ t("tableImport.sourceValue") }}
          </button>
          <button v-for="opt in TABLE_IMPORT_GENERATOR_OPTIONS" :key="opt.value" type="button" role="option" class="flex h-7 w-full items-center rounded-sm px-2 text-left text-xs font-mono hover:bg-accent hover:text-accent-foreground" @click="selectGeneratorOption(opt.value)">
            {{ t(opt.labelKey) }}
          </button>
        </div>
      </Teleport>

      <DialogFooter class="shrink-0">
        <Button variant="outline" :disabled="running" @click="open = false">
          <X class="mr-1.5 h-3.5 w-3.5" />
          {{ terminalStatus ? t("common.close") : t("dangerDialog.cancel") }}
        </Button>
        <Button v-if="canGoBack" variant="outline" @click="goBack">
          <ArrowLeft class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.back") }}
        </Button>
        <Button v-if="wizardStep === 'source' || wizardStep === 'options' || wizardStep === 'mapping'" :disabled="!canGoNext || loadingPreview" @click="goNext">
          <ArrowRight class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.next") }}
        </Button>
        <Button v-else-if="wizardStep === 'review'" :disabled="!canImport" @click="startImport">
          <Upload class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.start") }}
        </Button>
        <Button v-else-if="running" variant="destructive" :disabled="cancelling" @click="cancelImport">
          <Loader2 v-if="cancelling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          <Square v-else class="mr-1.5 h-3.5 w-3.5 fill-current" />
          {{ t("sqlFile.cancel") }}
        </Button>
        <Button v-else-if="progress?.status === 'done'" @click="open = false">
          <Check class="mr-1.5 h-3.5 w-3.5" />
          {{ t("common.done") }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>

  <Teleport to="body">
    <div v-if="minimized" class="fixed bottom-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-md border bg-popover px-3 py-2 text-popover-foreground shadow-lg" :title="running ? t('tableImport.backgroundWarning') : undefined">
      <Loader2 v-if="running" class="h-4 w-4 shrink-0 animate-spin text-primary" />
      <CheckCircle2 v-else-if="progress?.status === 'done'" class="h-4 w-4 shrink-0 text-emerald-600" />
      <AlertTriangle v-else class="h-4 w-4 shrink-0 text-destructive" />
      <span class="min-w-0 truncate text-xs">{{ t(progressLabelKey) }} · {{ progressPercent }}%</span>
      <span v-if="activeImportFile" class="max-w-44 truncate font-mono text-xs text-muted-foreground" :title="activeImportFile">{{ activeImportFile }}</span>
      <Button variant="ghost" size="icon-sm" :aria-label="t('tableImport.restoreImport')" :title="t('tableImport.restoreImport')" @click="restoreImport">
        <Maximize2 class="h-4 w-4" />
      </Button>
      <Button v-if="!running" variant="ghost" size="icon-sm" :aria-label="t('common.close')" :title="t('common.close')" @click="handleOpenChange(false)">
        <X class="h-4 w-4" />
      </Button>
    </div>
  </Teleport>
</template>
