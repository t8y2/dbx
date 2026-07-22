<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogScrollContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, FileJson, FileSpreadsheet, FileText, FileUp, Loader2, RefreshCw, Square, Upload, X } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import {
  autoMapImportColumns,
  buildTableImportParseOptions,
  formatTableImportElapsed,
  nextTableImportWizardStep,
  previousTableImportWizardStep,
  requiredImportTargetColumns,
  resolveTableImportElapsed,
  suggestImportTargetDataTypes,
  tableImportProgressPercent,
  validateImportMappings,
  type TableImportWizardStep,
} from "@/lib/table/tableImport";
import { getDataTypeOptions } from "@/lib/table/tableStructureEditorState";
import { tableStructureDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { ColumnInfo } from "@/types/database";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const store = useConnectionStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

type ImportTargetMode = "existing" | "create";
type ImportSource = string | File;

interface BatchImportTask {
  id: string;
  source: ImportSource;
  format: api.TableImportSourceFormat;
  sheetName: string;
  tableName: string;
  preview: api.TableImportPreview;
  columnMapping: Record<string, string>;
  columnDataTypes: Record<string, string>;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  rowsImported: number;
  error?: string;
}

const SKIP_VALUE = "__skip__";
const targetColumns = ref<ColumnInfo[]>([]);
const targetMode = ref<ImportTargetMode>(props.prefillTable ? "existing" : "create");
const newTableName = ref("");
const selectedSource = ref<string | File | null>(null);
const batchTasks = ref<BatchImportTask[]>([]);
const activeTaskIndex = ref(0);
const sourceFormat = ref<api.TableImportSourceFormat>("csv");
const preview = ref<api.TableImportPreview | null>(null);
const columnMapping = ref<Record<string, string>>({});
const columnDataTypes = ref<Record<string, string>>({});
const dynamicDataTypeOptions = ref<string[]>([]);
const loadingDataTypeOptions = ref(false);
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
const delimiter = ref(",");
const textEncoding = ref<api.TableImportTextEncoding>("auto");
const titleRow = ref(1);
const dataStartRow = ref(2);
const lastDataRow = ref(0);
const trimValues = ref(false);
const emptyStringAsNull = ref(true);
const selectedSheet = ref("");
const jsonShape = ref<api.TableImportJsonShape>("auto");
const previewLimit = ref(50);
const liveElapsedMs = ref(0);
let previewReloadTimer: ReturnType<typeof setTimeout> | null = null;
let importElapsedTimer: ReturnType<typeof setInterval> | null = null;
let importStartedAt = 0;
let dataTypeOptionsRequestId = 0;
let previewRequestId = 0;
let batchEncodingRequestId = 0;

const formatOptions: Array<{ value: api.TableImportSourceFormat; icon: any; labelKey: string; descriptionKey: string }> = [
  { value: "csv", icon: FileText, labelKey: "tableImport.formatCsv", descriptionKey: "tableImport.formatCsvDescription" },
  { value: "tsv", icon: FileText, labelKey: "tableImport.formatTsv", descriptionKey: "tableImport.formatTsvDescription" },
  { value: "delimited", icon: FileText, labelKey: "tableImport.formatDelimited", descriptionKey: "tableImport.formatDelimitedDescription" },
  { value: "json", icon: FileJson, labelKey: "tableImport.formatJson", descriptionKey: "tableImport.formatJsonDescription" },
  { value: "excel", icon: FileSpreadsheet, labelKey: "tableImport.formatExcel", descriptionKey: "tableImport.formatExcelDescription" },
];

const encodingOptions: Array<{ value: api.TableImportTextEncoding; labelKey: string }> = [
  { value: "auto", labelKey: "tableImport.encodingAuto" },
  { value: "utf8", labelKey: "tableImport.encodingUtf8" },
  { value: "gbk", labelKey: "tableImport.encodingGbk" },
  { value: "utf16Le", labelKey: "tableImport.encodingUtf16Le" },
  { value: "utf16Be", labelKey: "tableImport.encodingUtf16Be" },
];

const wizardSteps: Array<{ value: TableImportWizardStep; labelKey: string }> = [
  { value: "source", labelKey: "tableImport.stepSource" },
  { value: "options", labelKey: "tableImport.stepOptions" },
  { value: "mapping", labelKey: "tableImport.stepMapping" },
  { value: "review", labelKey: "tableImport.stepReview" },
  { value: "execution", labelKey: "tableImport.stepExecution" },
];

const selectedConnection = computed(() => (props.prefillConnectionId ? store.getConfig(props.prefillConnectionId) : undefined));
const structureDatabaseType = computed(() => tableStructureDatabaseTypeForConnection(selectedConnection.value));
const dataTypeOptions = computed(() => mergeDataTypeOptions(dynamicDataTypeOptions.value, getDataTypeOptions(structureDatabaseType.value), Object.values(columnDataTypes.value)));
const hasExistingTarget = computed(() => !!props.prefillTable);
const targetTableName = computed(() => (targetMode.value === "create" ? newTableName.value.trim() : props.prefillTable || ""));
const targetColumnNames = computed(() => targetColumns.value.map((column) => column.name));
const mappedColumns = computed<api.TableImportColumnMapping[]>(() => {
  const currentPreview = preview.value;
  if (!currentPreview) return [];
  return currentPreview.columns
    .map((sourceColumn) => {
      const targetDataType = targetMode.value === "create" ? String(columnDataTypes.value[sourceColumn] ?? "").trim() : undefined;
      return {
        sourceColumn,
        targetColumn: columnMapping.value[sourceColumn] ?? "",
        ...(targetMode.value === "create" ? { targetDataType } : {}),
      };
    })
    .filter((mapping) => mapping.targetColumn);
});
const mappedCount = computed(() => mappedColumns.value.length);
const mappingValidation = computed(() => validateImportMappings(mappedColumns.value));
const requiredUnmappedColumns = computed(() =>
  requiredImportTargetColumns(
    targetColumns.value,
    mappedColumns.value.map((mapping) => mapping.targetColumn),
  ),
);
const isBatchImport = computed(() => targetMode.value === "create" && batchTasks.value.length > 1);
const canImport = computed(() => {
  if (running.value || !props.prefillConnectionId) return false;
  if (!isBatchImport.value) return !!preview.value && !!targetTableName.value && mappingValidation.value.valid;
  const tableNames = batchTasks.value.map((task) => task.tableName.trim().toLowerCase());
  if (new Set(tableNames).size !== tableNames.length) return false;
  return batchTasks.value.every((task) => {
    const mappings = task.preview.columns.map((sourceColumn) => ({ sourceColumn, targetColumn: task.columnMapping[sourceColumn] ?? "", targetDataType: task.columnDataTypes[sourceColumn] ?? "" })).filter((mapping) => mapping.targetColumn);
    return !!task.tableName.trim() && validateImportMappings(mappings).valid;
  });
});
const canGoBack = computed(() => wizardStep.value !== "source" && wizardStep.value !== "execution" && !running.value);
const canGoNext = computed(() => {
  if (wizardStep.value === "source") return !!selectedSource.value && !!sourceFormat.value;
  if (wizardStep.value === "options") return !!preview.value && !!targetTableName.value;
  if (wizardStep.value === "mapping") return mappingValidation.value.valid;
  return false;
});
const rawProgressPercent = computed(() => tableImportProgressPercent(progress.value));
const progressPercentFloor = ref(0);
const progressPercent = computed(() => Math.max(rawProgressPercent.value, progressPercentFloor.value));
const currentStepIndex = computed(() => wizardSteps.findIndex((step) => step.value === wizardStep.value));
const targetLabel = computed(() => {
  const pieces = [selectedConnection.value?.name, props.prefillDatabase, props.prefillSchema, targetTableName.value].filter(Boolean);
  return pieces.join(" / ");
});
const selectedSourceName = computed(() => {
  const source = selectedSource.value;
  if (!source) return "";
  return typeof source === "string" ? source.split(/[\\/]/).pop() || source : source.name;
});
const createColumnSummaries = computed(() =>
  mappedColumns.value.map((mapping) => ({
    sourceColumn: mapping.sourceColumn,
    targetColumn: mapping.targetColumn,
    targetDataType: mapping.targetDataType || "",
  })),
);
const parseOptions = computed<api.TableImportParseOptions>(() => taskParseOptions(sourceFormat.value, selectedSheet.value));
const terminalStatus = computed(() => !!progress.value?.status && ["done", "error", "cancelled"].includes(progress.value.status));
const displayedElapsedMs = computed(() => resolveTableImportElapsed(liveElapsedMs.value, progress.value?.elapsedMs, terminalStatus.value));
const progressLabelKey = computed(() => {
  if (terminalStatus.value) return `tableImport.status_${progress.value?.status || "idle"}`;
  return `tableImport.phase_${progress.value?.phase || "writing"}`;
});

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
  stopImportElapsedClock();
  importStartedAt = 0;
  liveElapsedMs.value = 0;
  previewRequestId++;
  batchEncodingRequestId++;
  if (previewReloadTimer) {
    clearTimeout(previewReloadTimer);
    previewReloadTimer = null;
  }
  targetColumns.value = [];
  targetMode.value = props.prefillTable ? "existing" : "create";
  newTableName.value = "";
  selectedSource.value = null;
  batchTasks.value = [];
  activeTaskIndex.value = 0;
  sourceFormat.value = "csv";
  delimiter.value = ",";
  textEncoding.value = "auto";
  titleRow.value = 1;
  dataStartRow.value = 2;
  lastDataRow.value = 0;
  trimValues.value = false;
  emptyStringAsNull.value = true;
  selectedSheet.value = "";
  jsonShape.value = "auto";
  previewLimit.value = 50;
  preview.value = null;
  columnMapping.value = {};
  columnDataTypes.value = {};
  importMode.value = "append";
  batchSize.value = 500;
  loadingPreview.value = false;
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
  return typeof source === "string" ? source.split(/[\\/]/).pop() || source : source.name;
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
    textEncoding: textEncoding.value,
    titleRow: titleRow.value,
    dataStartRow: dataStartRow.value,
    lastDataRow: lastDataRow.value,
    trimValues: trimValues.value,
    emptyStringAsNull: emptyStringAsNull.value,
    sheetName,
    jsonShape: jsonShape.value,
  });
}

function importParseOptions(format: api.TableImportSourceFormat, currentPreview: api.TableImportPreview, sheetName = ""): api.TableImportParseOptions {
  const options = taskParseOptions(format, sheetName);
  if (isDelimitedFormat(format) && currentPreview.totalRowsExact !== false && options.encoding === "auto" && currentPreview.effectiveEncoding) {
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
  columnMapping.value = autoMapImportColumns(currentPreview.columns, targetColumnNames.value);
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

async function loadTargetColumns() {
  if (targetMode.value !== "existing" || !props.prefillConnectionId || !props.prefillDatabase || !props.prefillTable) return;
  loadingTarget.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.prefillConnectionId);
    targetColumns.value = await api.getColumns(props.prefillConnectionId, props.prefillDatabase, props.prefillSchema || props.prefillDatabase, props.prefillTable);
    applyAutoMapping();
  } catch (e: any) {
    errorMessage.value = String(e?.message || e);
  } finally {
    loadingTarget.value = false;
  }
}

async function previewSelectedImportFile(fileOrPath: string | File) {
  const reusablePreview = preview.value?.sourceRef ? preview.value : null;
  return api.previewTableImportFile(reusablePreview?.filePath || fileOrPath, {
    sourceRef: reusablePreview?.sourceRef || null,
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
  batchTasks.value = [];
  selectedSource.value = source;
  preview.value = null;
  columnMapping.value = {};
  columnDataTypes.value = {};
  progress.value = null;
  errorMessage.value = "";
  const name = typeof source === "string" ? source : source.name;
  sourceFormat.value = detectFormat(name);
  if (!newTableName.value.trim()) {
    newTableName.value = suggestedTableName(name);
  }
  delimiter.value = sourceFormat.value === "tsv" ? "\\t" : ",";
  selectedSheet.value = "";
  wizardStep.value = "options";
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
  columnDataTypes.value = { ...task.columnDataTypes };
}

function saveActiveBatchTask() {
  if (!isBatchImport.value) return;
  const task = batchTasks.value[activeTaskIndex.value];
  if (!task) return;
  task.tableName = newTableName.value.trim();
  task.columnMapping = { ...columnMapping.value };
  task.columnDataTypes = { ...columnDataTypes.value };
}

async function prepareBatchSources(sources: ImportSource[]) {
  loadingPreview.value = true;
  errorMessage.value = "";
  const tasks: BatchImportTask[] = [];
  const usedNames = new Set<string>();
  try {
    for (const source of sources) {
      const format = detectFormat(sourceName(source));
      const initialPreview = await api.previewTableImportFile(source, {
        sourceFormat: format,
        parseOptions: taskParseOptions(format),
        previewLimit: Math.max(1, Number(previewLimit.value) || 50),
      });
      const sheets = format === "excel" && initialPreview.sheets?.length ? initialPreview.sheets : [""];
      for (const sheetName of sheets) {
        const reusableSource = initialPreview.sourceRef ? initialPreview.filePath : source;
        const effectiveSheetName = sheetName && sheetName === initialPreview.sheets?.[0] ? "" : sheetName;
        const taskPreview = effectiveSheetName
          ? await api.previewTableImportFile(reusableSource, {
              sourceRef: initialPreview.sourceRef || null,
              sourceFormat: format,
              parseOptions: taskParseOptions(format, effectiveSheetName),
              previewLimit: Math.max(1, Number(previewLimit.value) || 50),
            })
          : initialPreview;
        const tableBase = sheetName ? `${suggestedTableName(sourceName(source))}_${sheetName}` : sourceName(source);
        tasks.push({
          id: uuid(),
          source,
          format,
          sheetName: effectiveSheetName,
          tableName: uniqueTableName(tableBase, usedNames),
          preview: taskPreview,
          columnMapping: Object.fromEntries(taskPreview.columns.map((column) => [column, column])),
          columnDataTypes: suggestImportTargetDataTypes(taskPreview.columns, taskPreview.rows, structureDatabaseType.value),
          status: "pending",
          rowsImported: 0,
        });
      }
    }
    batchTasks.value = tasks;
    if (tasks.length) {
      activateBatchTask(0);
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
      { name: "Data files", extensions: ["csv", "tsv", "txt", "json", "xlsx", "xlsm", "xls"] },
      { name: "Text", extensions: ["csv", "tsv", "txt"] },
      { name: "JSON", extensions: ["json"] },
      { name: "Excel", extensions: ["xlsx", "xlsm", "xls"] },
    ],
  });
  if (!selected) return;
  const sources = Array.isArray(selected) ? selected : [selected];
  if (targetMode.value === "create") await prepareBatchSources(sources);
  else assignSelectedSource(sources[0]);
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length || running.value) return;
  if (targetMode.value === "create") await prepareBatchSources(files);
  else assignSelectedSource(files[0]);
}

function updateMapping(sourceColumn: string, value: any) {
  const target = String(value);
  columnMapping.value = {
    ...columnMapping.value,
    [sourceColumn]: target === SKIP_VALUE ? "" : target,
  };
}

function updateColumnDataType(sourceColumn: string, value: any) {
  columnDataTypes.value = {
    ...columnDataTypes.value,
    [sourceColumn]: String(value),
  };
}

function formatCell(value: unknown) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function goBack() {
  wizardStep.value = previousTableImportWizardStep(wizardStep.value);
}

function canOpenStep(step: TableImportWizardStep) {
  if (running.value || step === "execution") return false;
  if (step === "source") return true;
  if (step === "options") return !!selectedSource.value;
  if (step === "mapping") return !!preview.value;
  if (step === "review") return !!preview.value && mappingValidation.value.valid;
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
  if (wizardStep.value === "options" && !preview.value) {
    await loadPreview();
    if (!preview.value) return;
  }
  wizardStep.value = nextTableImportWizardStep(wizardStep.value);
}

async function startImport() {
  saveActiveBatchTask();
  if (isBatchImport.value) {
    await startBatchImport();
    return;
  }
  const currentPreview = preview.value;
  const tableName = targetTableName.value;
  if (!canImport.value || !currentPreview || !props.prefillConnectionId || !tableName) return;
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
        schema: props.prefillSchema || "",
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
        dateTimeFormat: settingsStore.editorSettings.globalDateTimeImportFormat || undefined,
        preparedSource: preparedImportSource(currentPreview),
      },
      (nextProgress) => {
        progress.value = { ...nextProgress, elapsedMs: nextProgress.elapsedMs ?? liveElapsedMs.value };
      },
    );
    progress.value = { importId: summary.importId, status: "done", rowsImported: summary.rowsImported, totalRows: summary.totalRows, elapsedMs: summary.elapsedMs };
    toast(t("tableImport.success", { count: summary.rowsImported }), 2500);
    store.invalidateMetadataCache(props.prefillConnectionId, props.prefillDatabase || "", props.prefillSchema || undefined, tableName);
    if (targetMode.value === "create") {
      store.refreshObjectListTreeNode(props.prefillConnectionId, props.prefillDatabase || "", props.prefillSchema || undefined).catch((error) => {
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
    };
  } finally {
    refreshImportElapsedClock();
    stopImportElapsedClock();
    running.value = false;
    cancelling.value = false;
  }
}

async function startBatchImport() {
  if (!props.prefillConnectionId || !batchTasks.value.length || running.value) return;
  running.value = true;
  progressPercentFloor.value = 0;
  cancelling.value = false;
  errorMessage.value = "";
  wizardStep.value = "execution";
  const totalRowsExact = batchTasks.value.every((task) => task.preview.totalRowsExact !== false);
  const totalRows = totalRowsExact ? batchTasks.value.reduce((sum, task) => sum + task.preview.totalRows, 0) : 0;
  const totalBytes = batchTasks.value.reduce((sum, task) => sum + task.preview.sizeBytes, 0);
  let completedRows = 0;
  let completedBytes = 0;
  importId.value = uuid();
  startImportElapsedClock();
  progress.value = { importId: importId.value, status: "running", phase: "preparing", rowsImported: 0, totalRows, totalRowsExact, bytesRead: 0, totalBytes, elapsedMs: 0 };

  try {
    const tableNames = batchTasks.value.map((task) => task.tableName.trim().toLowerCase());
    if (new Set(tableNames).size !== tableNames.length) throw new Error("Target table names must be unique");
    for (let index = 0; index < batchTasks.value.length; index++) {
      const task = batchTasks.value[index];
      activeTaskIndex.value = index;
      task.status = "running";
      importId.value = uuid();
      const mappings = task.preview.columns
        .map((sourceColumn) => ({
          sourceColumn,
          targetColumn: task.columnMapping[sourceColumn] ?? "",
          targetDataType: String(task.columnDataTypes[sourceColumn] ?? "").trim(),
        }))
        .filter((mapping) => mapping.targetColumn);
      const validation = validateImportMappings(mappings);
      if (!task.tableName.trim() || !validation.valid) {
        throw new Error(validation.errors[0] || "Target table name is required");
      }

      const summary = await api.importTableFile(
        {
          importId: importId.value,
          connectionId: props.prefillConnectionId,
          database: props.prefillDatabase || "",
          schema: props.prefillSchema || "",
          table: task.tableName,
          filePath: task.preview.filePath,
          sourceRef: task.preview.sourceRef || null,
          sourceFormat: task.format,
          parseOptions: importParseOptions(task.format, task.preview, task.sheetName),
          mappings,
          mode: "append",
          createTable: true,
          batchSize: Math.max(1, Number(batchSize.value) || 500),
          dateTimeFormat: settingsStore.editorSettings.globalDateTimeImportFormat || undefined,
          preparedSource: preparedImportSource(task.preview),
          retainSource: true,
        },
        (nextProgress) => {
          task.rowsImported = nextProgress.rowsImported;
          const hasRemainingTasks = index < batchTasks.value.length - 1;
          const aggregateStatus = nextProgress.status === "done" && hasRemainingTasks ? "running" : nextProgress.status;
          const aggregatePhase = nextProgress.status === "done" && hasRemainingTasks ? "preparing" : nextProgress.phase;
          progress.value = {
            ...nextProgress,
            status: aggregateStatus,
            phase: aggregatePhase,
            rowsImported: completedRows + nextProgress.rowsImported,
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
      completedRows += summary.rowsImported;
      completedBytes += task.preview.sizeBytes;
      store.invalidateMetadataCache(props.prefillConnectionId, props.prefillDatabase || "", props.prefillSchema || undefined, task.tableName);
    }
    refreshImportElapsedClock();
    progress.value = { importId: importId.value, status: "done", phase: "done", rowsImported: completedRows, totalRows: completedRows, totalRowsExact: true, bytesRead: totalBytes, totalBytes, elapsedMs: liveElapsedMs.value };
    toast(t("tableImport.success", { count: completedRows }), 2500);
    store.refreshObjectListTreeNode(props.prefillConnectionId, props.prefillDatabase || "", props.prefillSchema || undefined).catch((error) => {
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
    };
  } finally {
    refreshImportElapsedClock();
    stopImportElapsedClock();
    await releaseTableImportSources();
    running.value = false;
    cancelling.value = false;
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
  if (isBatchImport.value || !preview.value || !selectedSource.value || loadingPreview.value || running.value) return;
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
      if (!isDelimitedFormat(task.format)) continue;
      const reusableSource = task.preview.sourceRef ? task.preview.filePath : task.source;
      const nextPreview = await api.previewTableImportFile(reusableSource, {
        sourceRef: task.preview.sourceRef || null,
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
      void loadTargetColumns();
      void loadDataTypeOptions();
    } else if (!running.value) {
      void releaseTableImportSources();
    }
  },
  { immediate: true },
);

watch([sourceFormat, delimiter, titleRow, dataStartRow, lastDataRow, trimValues, emptyStringAsNull, selectedSheet, jsonShape, previewLimit], schedulePreviewReload);
watch(textEncoding, schedulePreviewReloadAfterEncodingChange);
watch([newTableName, columnMapping, columnDataTypes], saveActiveBatchTask, { deep: true });
watch(targetMode, (mode) => {
  if (mode === "existing") {
    columnDataTypes.value = {};
    dynamicDataTypeOptions.value = [];
    void loadTargetColumns();
  } else {
    targetColumns.value = [];
    importMode.value = "append";
    applyAutoMapping();
    applySuggestedColumnDataTypes();
    void loadDataTypeOptions();
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
  <Dialog v-model:open="open">
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 flex-col overflow-hidden sm:max-w-[980px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader class="shrink-0 pr-8">
        <DialogTitle class="flex items-center gap-2 text-base">
          <FileUp class="h-4 w-4" />
          {{ t("tableImport.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <input ref="fileInput" type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xlsm,.xls" :multiple="targetMode === 'create'" class="hidden" @change="handleFileInputChange" />
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
            <span>{{ batchTasks.length }} {{ t("tableImport.file") }}</span>
            <span class="text-muted-foreground">{{ selectedSourceName }}</span>
          </div>
          <div class="flex max-h-32 flex-wrap gap-1.5 overflow-auto p-2">
            <button
              v-for="(task, index) in batchTasks"
              :key="task.id"
              type="button"
              class="flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors"
              :class="index === activeTaskIndex ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted/60'"
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
            </button>
          </div>
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
          <div class="grid grid-cols-5 gap-2">
            <button v-for="format in formatOptions" :key="format.value" type="button" class="min-h-20 rounded-md border px-3 py-2 text-left" :class="sourceFormat === format.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'" @click="sourceFormat = format.value">
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
                  <SelectItem v-for="format in formatOptions" :key="format.value" :value="format.value">
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

          <div class="grid grid-cols-[minmax(0,1fr)_minmax(220px,320px)] gap-3 rounded-md border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.targetMode") }}</Label>
              <div class="grid grid-cols-2 gap-2">
                <button type="button" class="rounded-md border px-3 py-2 text-left text-xs" :class="targetMode === 'existing' ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'" :disabled="!hasExistingTarget" @click="targetMode = 'existing'">
                  <div class="font-medium">{{ t("tableImport.existingTable") }}</div>
                  <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ props.prefillTable || t("tableImport.noExistingTarget") }}</div>
                </button>
                <button type="button" class="rounded-md border px-3 py-2 text-left text-xs" :class="targetMode === 'create' ? 'border-primary bg-primary/5' : 'hover:bg-muted/30'" @click="targetMode = 'create'">
                  <div class="font-medium">{{ t("tableImport.createTable") }}</div>
                  <div class="mt-1 text-[11px] text-muted-foreground">{{ t("tableImport.createTableHint") }}</div>
                </button>
              </div>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.targetTableName") }}</Label>
              <Input v-if="targetMode === 'create'" v-model="newTableName" class="h-8 text-xs font-mono" />
              <div v-else class="flex h-8 items-center rounded-md border px-2 text-xs">
                <span class="truncate">{{ props.prefillTable }}</span>
              </div>
            </div>
          </div>

          <div v-if="sourceFormat === 'csv' || sourceFormat === 'tsv' || sourceFormat === 'delimited'" class="grid grid-cols-5 gap-3 rounded-md border p-3">
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
            <label class="flex items-center gap-2 text-xs">
              <input v-model="emptyStringAsNull" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
              {{ t("tableImport.emptyStringAsNull") }}
            </label>
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
              <Select :model-value="selectedSheet" :disabled="!preview?.sheets?.length" @update:model-value="(value: any) => (selectedSheet = value)">
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

          <div v-if="preview" class="grid gap-3" :class="targetMode === 'create' ? 'grid-cols-[minmax(360px,460px)_1fr]' : 'grid-cols-[minmax(240px,300px)_1fr]'">
            <div class="rounded-md border">
              <div class="border-b px-3 py-2 text-xs font-medium">{{ t("tableImport.mapping") }}</div>
              <div class="max-h-[320px] overflow-auto p-2">
                <div class="grid items-center gap-2 border-b px-1 pb-1 text-[11px] font-medium text-muted-foreground" :class="targetMode === 'create' ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(92px,120px)]' : 'grid-cols-[1fr_1fr]'">
                  <span>{{ t("tableImport.sourceColumn") }}</span>
                  <span>{{ t("tableImport.targetColumn") }}</span>
                  <span v-if="targetMode === 'create'">{{ t("tableImport.targetDataType") }}</span>
                </div>
                <div v-for="sourceColumn in preview.columns" :key="sourceColumn" class="grid items-center gap-2 py-1" :class="targetMode === 'create' ? 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(92px,120px)]' : 'grid-cols-[1fr_1fr]'">
                  <div class="truncate font-mono text-xs" :title="sourceColumn">
                    {{ sourceColumn }}
                  </div>
                  <Input v-if="targetMode === 'create'" :model-value="columnMapping[sourceColumn] ?? sourceColumn" class="h-7 text-xs font-mono" @update:model-value="(value: any) => updateMapping(sourceColumn, value)" />
                  <Select v-else :model-value="columnMapping[sourceColumn] || SKIP_VALUE" @update:model-value="(value: any) => updateMapping(sourceColumn, value)">
                    <SelectTrigger class="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="SKIP_VALUE">{{ t("tableImport.skipColumn") }}</SelectItem>
                      <SelectItem v-for="column in targetColumns" :key="column.name" :value="column.name">
                        {{ column.name }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <SearchableSelect
                    v-if="targetMode === 'create'"
                    :model-value="columnDataTypes[sourceColumn] || ''"
                    :placeholder="t('tableImport.targetDataType')"
                    :search-placeholder="t('tableImport.targetDataType')"
                    :empty-text="t('structureEditor.noMatchingType')"
                    :loading-text="t('common.loading')"
                    :loading="loadingDataTypeOptions"
                    :options="dataTypeOptions"
                    :allow-custom="true"
                    :trigger-class="'h-7 w-full max-w-none rounded-md border bg-background px-2 text-xs font-mono shadow-none hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring/25'"
                    :content-class="'w-56'"
                    :item-class="'font-mono text-xs'"
                    :trigger-icon-class="'h-3 w-3'"
                    @update:model-value="(value: any) => updateColumnDataType(sourceColumn, value)"
                  />
                </div>
              </div>
            </div>

            <div class="min-w-0 rounded-md border">
              <div class="border-b px-3 py-2 text-xs font-medium">{{ t("tableImport.preview") }}</div>
              <div class="max-h-[320px] overflow-auto">
                <table class="min-w-full border-separate border-spacing-0 text-xs">
                  <thead class="sticky top-0 bg-background">
                    <tr>
                      <th v-for="column in preview.columns" :key="column" class="border-b border-r px-2 py-1.5 text-left font-medium">
                        <span class="block max-w-[140px] truncate">{{ column }}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, rowIndex) in preview.rows" :key="rowIndex">
                      <td v-for="(cell, colIndex) in row" :key="colIndex" class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono" :class="{ 'text-muted-foreground': cell === null }">
                        <span class="block truncate">{{ formatCell(cell) }}</span>
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
          <div v-else-if="requiredUnmappedColumns.length" class="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
            <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{{ t("tableImport.requiredUnmapped", { columns: requiredUnmappedColumns.join(", ") }) }}</span>
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
                <div class="mt-1 text-xs text-muted-foreground">
                  <template v-if="progress?.totalRowsExact !== false && (progress?.totalRows ?? 0) > 0">{{ progress?.rowsImported ?? 0 }} / {{ progress?.totalRows ?? 0 }}</template>
                  <template v-else>{{ progress?.rowsImported ?? 0 }} {{ t("tableImport.rowsImported") }}</template>
                  · {{ progressPercent }}% ·
                  {{ t("tableImport.elapsed", { duration: formatTableImportElapsed(displayedElapsedMs) }) }}
                </div>
              </div>
            </div>
            <div class="mt-4 h-2 overflow-hidden rounded bg-muted">
              <div class="h-full bg-primary transition-all" :style="{ width: `${progressPercent}%` }" />
            </div>
          </div>
          <div v-if="errorMessage || progress?.error" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {{ errorMessage || progress?.error }}
          </div>
        </div>

        <div v-if="loadingTarget" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-if="errorMessage && wizardStep !== 'execution'" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ errorMessage }}
        </div>
      </div>

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
</template>
