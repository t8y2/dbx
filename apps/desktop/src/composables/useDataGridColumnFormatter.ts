import { computed, ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { uuid } from "@/lib/common/utils";
import {
  applyColumnFormatter,
  columnFormatterKeys,
  defaultIoTDBTimestampFormatter,
  DataGridDateTimePatterns,
  displayTimeZoneOption,
  getSupportedTimeZoneOptions,
  normalizeColumnFormatter,
  resolveColumnFormatter,
  type ColumnFormatterConfig,
  type DateTimeFormatterUnit,
  type ForeignKeyDisplayFilterConfig,
} from "@/lib/dataGrid/columnFormatter";
import { filterModeNeedsValue, filterModeUsesRange } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { displayCellValue, type CellValue } from "@/lib/dataGrid/cellValue";
import { manualReferenceColumnValidation, manualReferenceKeyColumns, reconcileManualReferenceColumn, type ManualReferenceMetadataStatus } from "@/lib/dataGrid/dataGridForeignKeyDisplay";
import type { ColumnInfo, DatabaseType, ForeignKeyInfo, QueryResultSourceColumnRef, ReferenceKeyInfo } from "@/types/database";
import { useSettingsStore } from "@/stores/settingsStore";

dayjs.extend(utc);
dayjs.extend(timezone);

export const CUSTOM_FORMATTER_NEW = "__new";

type FormatterDraftKind = Exclude<ColumnFormatterConfig["kind"], "custom-ref" | "iotdb-timestamp">;
type SettingsStore = ReturnType<typeof useSettingsStore>;

interface FormatterResult {
  columns: string[];
  column_types?: Array<string | null | undefined>;
  rows: CellValue[][];
}

interface FormatterTableMeta {
  catalog?: string;
  database?: string;
  schema?: string;
  tableName: string;
}

export interface DataGridColumnFormatterProps {
  result: FormatterResult;
  connectionId?: string;
  database?: string;
  executionDatabase?: string;
  schema?: string;
  sourceColumns?: Array<string | undefined>;
  queryDisplaySourceColumns?: Array<QueryResultSourceColumnRef | undefined>;
  tableMeta?: FormatterTableMeta;
}

export interface DataGridColumnFormatterOptions {
  props: DataGridColumnFormatterProps;
  settingsStore: SettingsStore;
  resolvedDatabaseType: ComputedRef<DatabaseType | undefined>;
  resolvedConnectionUrlParams: ComputedRef<string | undefined>;
  tableColumnForGridColumn: (columnIndex: number) => ColumnInfo | undefined;
  foreignKeyForColumn: (columnIndex: number) => ForeignKeyInfo | undefined;
  fetchForeignKeys: () => Promise<void>;
  displayRowRefs: ComputedRef<readonly unknown[]>;
  displayItemAt: (rowIndex: number) => { data: CellValue[] } | undefined;
  shouldIgnoreHeaderPanelClose: (columnIndex: number, openColumn: number | null) => boolean;
  formatForeignKeyCellDisplay: (value: CellValue, columnIndex: number) => string;
  toast?: (message: string, duration?: number) => void;
}

export function useDataGridColumnFormatter(options: DataGridColumnFormatterOptions) {
  const { t } = useI18n();
  const { props, settingsStore } = options;
  const formatterOpenColumn = ref<number | null>(null);
  const formatterKind = ref<FormatterDraftKind>("datetime");
  const formatterDateUnit = ref<DateTimeFormatterUnit>("auto");
  const formatterDatetimePattern = ref("YYYY-MM-DD HH:mm:ss");
  const formatterDateTimezone = ref(dayjs.tz.guess() || "UTC");
  const timezoneOptions = getSupportedTimeZoneOptions(Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }, formatterDateTimezone.value);
  const formatterJsonPath = ref("$.user.name");
  const formatterMaskPrefix = ref(4);
  const formatterMaskSuffix = ref(4);
  const formatterCustomId = ref(CUSTOM_FORMATTER_NEW);
  const formatterCustomCapturedDeleteVersion = ref<number>();
  const formatterCustomName = ref("");
  const formatterCustomTemplate = ref("${value}");
  const formatterCustomDeleteOpen = ref(false);
  const formatterCustomDeleteLoading = ref(false);
  const formatterCustomDeleteId = ref("");
  const formatterCustomDeleteName = ref("");
  const formatterForeignKeyRefSchema = ref("");
  const formatterForeignKeyRefTable = ref("");
  const formatterForeignKeyRefColumn = ref("");
  const formatterForeignKeyDisplayColumn = ref("");
  const formatterForeignKeyManual = ref(false);
  const formatterForeignKeySchemas = ref<string[]>([]);
  const formatterForeignKeyTables = ref<string[]>([]);
  const formatterForeignKeyColumns = ref<ColumnInfo[]>([]);
  const formatterForeignKeyReferenceKeys = ref<ReferenceKeyInfo[]>([]);
  const formatterForeignKeyReferenceMetadataStatus = ref<ManualReferenceMetadataStatus>("loading");
  const formatterForeignKeySchemasLoading = ref(false);
  const formatterForeignKeyTablesLoading = ref(false);
  const formatterForeignKeyColumnsLoading = ref(false);
  const formatterForeignKeyTargetError = ref("");
  const formatterForeignKeyColumnsError = ref("");
  const formatterForeignKeyReferenceMetadataError = ref("");
  const formatterForeignKeyFilterEnabled = ref(false);
  const formatterForeignKeyFilterColumn = ref("");
  const formatterForeignKeyFilterMode = ref<DataGridContextFilterMode>("equals");
  const formatterForeignKeyFilterValue = ref("");
  const formatterForeignKeyFilterEndValue = ref("");
  let formatterForeignKeyColumnsRequest = 0;
  let formatterForeignKeyTargetRequest = 0;

  const formatterForeignKeyReferenceFilter = computed<ForeignKeyDisplayFilterConfig | undefined>(() =>
    formatterForeignKeyFilterEnabled.value
      ? {
          column: formatterForeignKeyFilterColumn.value,
          mode: formatterForeignKeyFilterMode.value,
          value: formatterForeignKeyFilterValue.value,
          endValue: formatterForeignKeyFilterEndValue.value,
        }
      : undefined,
  );
  const formatterForeignKeyReferenceColumns = computed(() => (formatterForeignKeyManual.value ? manualReferenceKeyColumns(formatterForeignKeyColumns.value, formatterForeignKeyReferenceKeys.value, formatterForeignKeyReferenceFilter.value) : formatterForeignKeyColumns.value));
  const formatterForeignKeyReferenceValidation = computed(() => manualReferenceColumnValidation(formatterForeignKeyColumns.value, formatterForeignKeyReferenceKeys.value, formatterForeignKeyRefColumn.value, formatterForeignKeyReferenceMetadataStatus.value, formatterForeignKeyReferenceFilter.value));
  const savedCustomFormatters = computed(() => Object.values(settingsStore.editorSettings.customColumnFormatters).sort((left, right) => left.name.localeCompare(right.name)));

  function formatterKeysForColumn(columnIndex: number): string[] {
    const resultColumn = props.result.columns[columnIndex];
    if (!props.connectionId || !resultColumn) return [];
    return columnFormatterKeys({
      connectionId: props.connectionId,
      database: props.database,
      schema: props.schema,
      databaseType: options.resolvedDatabaseType.value,
      resultColumn,
      sourceColumn: props.sourceColumns?.[columnIndex],
      displaySource: props.queryDisplaySourceColumns?.[columnIndex],
      tableMeta: props.tableMeta,
    });
  }

  function formatterKeyForColumn(columnIndex: number): string | null {
    return formatterKeysForColumn(columnIndex)[0] ?? null;
  }

  function savedColumnFormatterEntry(columnIndex: number): { key: string; formatter: ColumnFormatterConfig } | undefined {
    for (const key of formatterKeysForColumn(columnIndex)) {
      const formatter = settingsStore.editorSettings.columnFormatters[key];
      if (formatter) return { key, formatter };
    }
    return undefined;
  }

  function columnFormatter(columnIndex: number): ColumnFormatterConfig | undefined {
    const columnType = props.result.column_types?.[columnIndex] ?? options.tableColumnForGridColumn(columnIndex)?.data_type;
    const savedFormatter = savedColumnFormatterEntry(columnIndex)?.formatter;
    const configured = resolveColumnFormatter(savedFormatter, settingsStore.editorSettings.customColumnFormatters, {
      pattern: settingsStore.editorSettings.globalDateTimeDisplayFormat,
      columnType,
    });
    if (savedFormatter && configured) return configured;
    return defaultIoTDBTimestampFormatter(options.resolvedDatabaseType.value, columnType, options.resolvedConnectionUrlParams.value) ?? configured;
  }

  function savedColumnFormatter(columnIndex: number): ColumnFormatterConfig | undefined {
    return savedColumnFormatterEntry(columnIndex)?.formatter;
  }

  function columnHasFormatter(columnIndex: number): boolean {
    return !!columnFormatter(columnIndex);
  }

  function currentFormatterDraft(): ColumnFormatterConfig {
    if (formatterKind.value === "json-path") return { kind: "json-path", path: formatterJsonPath.value.trim() || "$" };
    if (formatterKind.value === "mask") {
      return { kind: "mask", prefix: Math.max(0, Math.floor(Number(formatterMaskPrefix.value) || 0)), suffix: Math.max(0, Math.floor(Number(formatterMaskSuffix.value) || 0)) };
    }
    if (formatterKind.value === "custom-template") return { kind: "custom-template", template: formatterCustomTemplate.value.trim() || "${value}" };
    if (formatterKind.value === "foreign-key-display") {
      return {
        kind: "foreign-key-display",
        referenceMode: formatterForeignKeyManual.value ? "manual" : "foreign-key",
        refSchema: formatterForeignKeyRefSchema.value || undefined,
        refTable: formatterForeignKeyRefTable.value,
        refColumn: formatterForeignKeyRefColumn.value,
        displayColumn: formatterForeignKeyDisplayColumn.value,
        filter: formatterForeignKeyFilterEnabled.value
          ? {
              column: formatterForeignKeyFilterColumn.value,
              mode: formatterForeignKeyFilterMode.value,
              value: formatterForeignKeyFilterValue.value,
              endValue: formatterForeignKeyFilterEndValue.value,
            }
          : undefined,
      };
    }
    return { kind: "datetime", unit: formatterDateUnit.value, pattern: formatterDatetimePattern.value, timezone: formatterDateTimezone.value };
  }

  function loadFormatterDraft(formatter: ColumnFormatterConfig | undefined) {
    formatterForeignKeyManual.value = false;
    formatterForeignKeyRefSchema.value = "";
    formatterForeignKeyRefTable.value = "";
    formatterForeignKeyRefColumn.value = "";
    formatterForeignKeyDisplayColumn.value = "";
    formatterForeignKeySchemas.value = [];
    formatterForeignKeyTables.value = [];
    formatterForeignKeyColumns.value = [];
    formatterForeignKeyReferenceKeys.value = [];
    formatterForeignKeyReferenceMetadataStatus.value = "loading";
    formatterForeignKeyTargetError.value = "";
    formatterForeignKeyColumnsError.value = "";
    formatterForeignKeyReferenceMetadataError.value = "";
    formatterForeignKeyFilterEnabled.value = false;
    formatterForeignKeyFilterColumn.value = "";
    formatterForeignKeyFilterMode.value = "equals";
    formatterForeignKeyFilterValue.value = "";
    formatterForeignKeyFilterEndValue.value = "";
    const draft = formatter ?? { kind: "datetime", unit: "auto" as const, pattern: "YYYY-MM-DD HH:mm:ss" as const, timezone: dayjs.tz.guess() };
    formatterKind.value = draft.kind === "custom-ref" ? "custom-template" : draft.kind === "iotdb-timestamp" ? "datetime" : draft.kind;
    if (draft.kind === "datetime") {
      formatterDateUnit.value = draft.unit;
      formatterDatetimePattern.value = draft.pattern;
      formatterDateTimezone.value = draft.timezone || dayjs.tz.guess() || "UTC";
    } else if (draft.kind === "iotdb-timestamp") {
      formatterDateUnit.value = "milliseconds";
      formatterDatetimePattern.value = "YYYY-MM-DDTHH:mm:ss.SSSZ";
      formatterDateTimezone.value = draft.timezone;
    } else if (draft.kind === "json-path") {
      formatterJsonPath.value = draft.path;
    } else if (draft.kind === "mask") {
      formatterMaskPrefix.value = draft.prefix;
      formatterMaskSuffix.value = draft.suffix;
    } else if (draft.kind === "custom-ref") {
      const saved = settingsStore.editorSettings.customColumnFormatters[draft.formatterId];
      formatterCustomId.value = saved ? saved.id : CUSTOM_FORMATTER_NEW;
      formatterCustomCapturedDeleteVersion.value = saved ? settingsStore.customColumnFormatterDeleteVersion(saved.id) : undefined;
      formatterCustomName.value = saved?.name ?? "";
      formatterCustomTemplate.value = saved?.template ?? "${value}";
    } else if (draft.kind === "custom-template") {
      formatterCustomId.value = CUSTOM_FORMATTER_NEW;
      formatterCustomCapturedDeleteVersion.value = undefined;
      formatterCustomName.value = "";
      formatterCustomTemplate.value = draft.template;
    } else if (draft.kind === "foreign-key-display") {
      formatterForeignKeyManual.value = draft.referenceMode === "manual";
      formatterForeignKeyRefSchema.value = draft.refSchema ?? "";
      formatterForeignKeyRefTable.value = draft.refTable;
      formatterForeignKeyRefColumn.value = draft.refColumn;
      formatterForeignKeyDisplayColumn.value = draft.displayColumn;
      formatterForeignKeyFilterEnabled.value = !!draft.filter;
      formatterForeignKeyFilterColumn.value = draft.filter?.column ?? "";
      formatterForeignKeyFilterMode.value = draft.filter?.mode ?? "equals";
      formatterForeignKeyFilterValue.value = draft.filter?.value ?? "";
      formatterForeignKeyFilterEndValue.value = draft.filter?.endValue ?? "";
    }
  }

  function formatterForeignKeyDefaultSchema() {
    return formatterForeignKeyRefSchema.value || props.tableMeta?.schema || props.schema || props.database || "";
  }

  async function loadFormatterForeignKeyColumns(columnIndex: number) {
    const request = ++formatterForeignKeyColumnsRequest;
    formatterForeignKeyColumns.value = [];
    formatterForeignKeyReferenceKeys.value = [];
    formatterForeignKeyReferenceMetadataStatus.value = "loading";
    formatterForeignKeyColumnsError.value = "";
    formatterForeignKeyReferenceMetadataError.value = "";
    if (!props.connectionId || !formatterForeignKeyRefTable.value) return;
    formatterForeignKeyColumnsLoading.value = true;
    try {
      const schema = formatterForeignKeyRefSchema.value || props.tableMeta?.schema || props.schema || props.database || "";
      const manual = formatterForeignKeyManual.value;
      const [columnsResult, referenceKeysResult] = await Promise.allSettled([
        api.getColumns(props.connectionId, props.database || "", schema, formatterForeignKeyRefTable.value, props.tableMeta?.catalog),
        manual ? api.listReferenceKeys(props.connectionId, props.database || "", schema, formatterForeignKeyRefTable.value, props.tableMeta?.catalog) : Promise.resolve([] as ReferenceKeyInfo[]),
      ]);
      if (request !== formatterForeignKeyColumnsRequest || formatterOpenColumn.value !== columnIndex) return;
      if (columnsResult.status === "rejected") throw columnsResult.reason;
      const columns = columnsResult.value;
      formatterForeignKeyColumns.value = columns;
      if (manual && referenceKeysResult.status === "rejected") {
        formatterForeignKeyReferenceMetadataStatus.value = "unavailable";
        formatterForeignKeyReferenceMetadataError.value = String(referenceKeysResult.reason?.message || referenceKeysResult.reason);
      } else {
        formatterForeignKeyReferenceKeys.value = referenceKeysResult.status === "fulfilled" ? referenceKeysResult.value : [];
        formatterForeignKeyReferenceMetadataStatus.value = "available";
      }
      const referenceColumns = manualReferenceKeyColumns(columns, formatterForeignKeyReferenceKeys.value, formatterForeignKeyReferenceFilter.value);
      const foreignKey = options.foreignKeyForColumn(columnIndex);
      if (manual) {
        formatterForeignKeyRefColumn.value = reconcileManualReferenceColumn(formatterForeignKeyRefColumn.value, referenceColumns, formatterForeignKeyReferenceMetadataStatus.value);
      } else if (!formatterForeignKeyRefColumn.value || !columns.some((column) => column.name === formatterForeignKeyRefColumn.value)) {
        formatterForeignKeyRefColumn.value = foreignKey?.ref_column ?? "";
      }
      if (!formatterForeignKeyDisplayColumn.value || !columns.some((column) => column.name === formatterForeignKeyDisplayColumn.value)) {
        formatterForeignKeyDisplayColumn.value = columns.find((column) => column.name !== formatterForeignKeyRefColumn.value)?.name ?? columns[0]?.name ?? "";
      }
      if (formatterForeignKeyFilterEnabled.value && !columns.some((column) => column.name === formatterForeignKeyFilterColumn.value)) formatterForeignKeyFilterColumn.value = "";
    } catch (error: any) {
      if (request === formatterForeignKeyColumnsRequest) formatterForeignKeyColumnsError.value = String(error?.message || error);
    } finally {
      if (request === formatterForeignKeyColumnsRequest) formatterForeignKeyColumnsLoading.value = false;
    }
  }

  async function loadFormatterManualReferenceTables(columnIndex: number, request = ++formatterForeignKeyTargetRequest) {
    formatterForeignKeyTables.value = [];
    formatterForeignKeyTargetError.value = "";
    if (!props.connectionId) return;
    formatterForeignKeyTablesLoading.value = true;
    try {
      const tables = await api.listTables(props.connectionId, props.database || "", formatterForeignKeyRefSchema.value, undefined, undefined, undefined, undefined, props.tableMeta?.catalog);
      if (request !== formatterForeignKeyTargetRequest || formatterOpenColumn.value !== columnIndex) return;
      formatterForeignKeyTables.value = [...new Set(tables.map((table) => table.name))].sort((left, right) => left.localeCompare(right));
      if (formatterForeignKeyRefTable.value && !formatterForeignKeyTables.value.includes(formatterForeignKeyRefTable.value)) formatterForeignKeyTables.value.unshift(formatterForeignKeyRefTable.value);
      if (formatterForeignKeyRefTable.value) await loadFormatterForeignKeyColumns(columnIndex);
    } catch (error: any) {
      if (request === formatterForeignKeyTargetRequest) formatterForeignKeyTargetError.value = String(error?.message || error);
    } finally {
      if (request === formatterForeignKeyTargetRequest) formatterForeignKeyTablesLoading.value = false;
    }
  }

  async function loadFormatterManualReferenceOptions(columnIndex: number) {
    const request = ++formatterForeignKeyTargetRequest;
    formatterForeignKeySchemas.value = [];
    formatterForeignKeySchemasLoading.value = true;
    formatterForeignKeyTargetError.value = "";
    try {
      const schemas = props.connectionId ? await api.listSchemas(props.connectionId, props.database || "") : [];
      if (request !== formatterForeignKeyTargetRequest || formatterOpenColumn.value !== columnIndex) return;
      const selectedSchema = formatterForeignKeyDefaultSchema();
      formatterForeignKeyRefSchema.value = selectedSchema;
      formatterForeignKeySchemas.value = [...new Set([selectedSchema, ...schemas].filter(Boolean))].sort((left, right) => left.localeCompare(right));
    } catch (error: any) {
      if (request !== formatterForeignKeyTargetRequest) return;
      const selectedSchema = formatterForeignKeyDefaultSchema();
      formatterForeignKeyRefSchema.value = selectedSchema;
      formatterForeignKeySchemas.value = selectedSchema ? [selectedSchema] : [];
      formatterForeignKeyTargetError.value = String(error?.message || error);
    } finally {
      if (request === formatterForeignKeyTargetRequest) formatterForeignKeySchemasLoading.value = false;
    }
    if (request === formatterForeignKeyTargetRequest) await loadFormatterManualReferenceTables(columnIndex, request);
  }

  function selectFormatterForeignKeySchema(value: string, columnIndex: number) {
    formatterForeignKeyColumnsRequest += 1;
    formatterForeignKeyRefSchema.value = value;
    formatterForeignKeyRefTable.value = "";
    formatterForeignKeyRefColumn.value = "";
    formatterForeignKeyDisplayColumn.value = "";
    formatterForeignKeyFilterColumn.value = "";
    formatterForeignKeyColumns.value = [];
    formatterForeignKeyReferenceKeys.value = [];
    formatterForeignKeyReferenceMetadataStatus.value = "loading";
    formatterForeignKeyReferenceMetadataError.value = "";
    void loadFormatterManualReferenceTables(columnIndex);
  }

  function selectFormatterForeignKeyTable(value: string, columnIndex: number) {
    formatterForeignKeyTargetRequest += 1;
    formatterForeignKeyRefTable.value = value;
    formatterForeignKeyRefColumn.value = "";
    formatterForeignKeyDisplayColumn.value = "";
    formatterForeignKeyFilterColumn.value = "";
    formatterForeignKeyReferenceKeys.value = [];
    formatterForeignKeyReferenceMetadataStatus.value = "loading";
    formatterForeignKeyReferenceMetadataError.value = "";
    void loadFormatterForeignKeyColumns(columnIndex);
  }

  function selectFormatterForeignKeyFilterMode(value: DataGridContextFilterMode) {
    formatterForeignKeyFilterMode.value = value;
    if (!filterModeNeedsValue(value)) formatterForeignKeyFilterValue.value = formatterForeignKeyFilterEndValue.value = "";
    else if (!filterModeUsesRange(value)) formatterForeignKeyFilterEndValue.value = "";
  }

  async function openColumnFormatter(columnIndex: number) {
    const savedFormatter = savedColumnFormatter(columnIndex);
    loadFormatterDraft(savedFormatter);
    formatterOpenColumn.value = columnIndex;
    await options.fetchForeignKeys();
    const foreignKey = options.foreignKeyForColumn(columnIndex);
    if (savedFormatter?.kind === "foreign-key-display" && savedFormatter.referenceMode === "manual") {
      formatterForeignKeyManual.value = true;
      await loadFormatterManualReferenceOptions(columnIndex);
    } else if (foreignKey) {
      formatterForeignKeyManual.value = false;
      formatterForeignKeyRefSchema.value = foreignKey.ref_schema || props.tableMeta?.schema || props.schema || "";
      formatterForeignKeyRefTable.value = foreignKey.ref_table;
      formatterForeignKeyRefColumn.value = foreignKey.ref_column;
      await loadFormatterForeignKeyColumns(columnIndex);
    }
  }

  function closeColumnFormatter() {
    formatterForeignKeyColumnsRequest += 1;
    formatterForeignKeyTargetRequest += 1;
    formatterOpenColumn.value = null;
  }

  function handleColumnFormatterOpenChange(value: boolean, columnIndex: number) {
    if (value) void openColumnFormatter(columnIndex);
    else if (!options.shouldIgnoreHeaderPanelClose(columnIndex, formatterOpenColumn.value)) closeColumnFormatter();
  }

  async function saveColumnFormatter(columnIndex: number) {
    const key = formatterKeyForColumn(columnIndex);
    if (!key) return;
    try {
      let formatter = currentFormatterDraft();
      if (formatterKind.value === "custom-template" && formatterCustomName.value.trim()) {
        const id = formatterCustomId.value === CUSTOM_FORMATTER_NEW ? `fmt_${uuid()}` : formatterCustomId.value;
        const saved = await settingsStore.upsertCustomColumnFormatter({ id, name: formatterCustomName.value, template: formatterCustomTemplate.value }, formatterCustomCapturedDeleteVersion.value);
        if (!saved) {
          selectCustomFormatter(CUSTOM_FORMATTER_NEW);
          return;
        }
        formatter = { kind: "custom-ref", formatterId: saved.id };
      }
      settingsStore.updateColumnFormatter(key, formatter);
      closeColumnFormatter();
    } catch (error) {
      options.toast?.(t("grid.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
    }
  }

  function clearColumnFormatter(columnIndex: number) {
    const keys = formatterKeysForColumn(columnIndex);
    if (!keys.length) return;
    for (const key of keys) settingsStore.updateColumnFormatter(key, undefined);
    closeColumnFormatter();
  }

  function formatterDraftIsSavable(): boolean {
    const formatter = normalizeColumnFormatter(currentFormatterDraft());
    if (!formatter || formatter.kind !== "foreign-key-display" || formatter.referenceMode !== "manual") return !!formatter;
    return formatterForeignKeyReferenceValidation.value === "valid";
  }

  function selectFormatterKind(value: FormatterDraftKind, columnIndex: number) {
    formatterKind.value = value;
    if (value !== "foreign-key-display") return;
    const foreignKey = options.foreignKeyForColumn(columnIndex);
    formatterForeignKeyManual.value = !foreignKey;
    if (foreignKey) {
      formatterForeignKeyRefSchema.value = foreignKey.ref_schema || props.tableMeta?.schema || props.schema || "";
      formatterForeignKeyRefTable.value = foreignKey.ref_table;
      formatterForeignKeyRefColumn.value = foreignKey.ref_column;
      void loadFormatterForeignKeyColumns(columnIndex);
    } else {
      formatterForeignKeyRefSchema.value = formatterForeignKeyDefaultSchema();
      formatterForeignKeyRefTable.value = "";
      formatterForeignKeyRefColumn.value = "";
      formatterForeignKeyDisplayColumn.value = "";
      formatterForeignKeyFilterEnabled.value = false;
      void loadFormatterManualReferenceOptions(columnIndex);
    }
  }

  function selectCustomFormatter(value: string) {
    formatterCustomId.value = value;
    if (value === CUSTOM_FORMATTER_NEW) {
      formatterCustomCapturedDeleteVersion.value = undefined;
      formatterCustomName.value = "";
      formatterCustomTemplate.value = "${value}";
      return;
    }
    const saved = settingsStore.editorSettings.customColumnFormatters[value];
    if (!saved) return;
    formatterCustomCapturedDeleteVersion.value = settingsStore.customColumnFormatterDeleteVersion(saved.id);
    formatterCustomName.value = saved.name;
    formatterCustomTemplate.value = saved.template;
  }

  function requestDeleteCustomFormatter() {
    if (formatterCustomId.value === CUSTOM_FORMATTER_NEW) return;
    const saved = settingsStore.editorSettings.customColumnFormatters[formatterCustomId.value];
    if (!saved) return;
    formatterCustomDeleteId.value = saved.id;
    formatterCustomDeleteName.value = saved.name;
    formatterCustomDeleteOpen.value = true;
  }

  async function confirmDeleteCustomFormatter() {
    const id = formatterCustomDeleteId.value;
    if (!id || formatterCustomDeleteLoading.value) return;
    formatterCustomDeleteLoading.value = true;
    try {
      await settingsStore.deleteCustomColumnFormatter(id);
      if (formatterCustomId.value === id) selectCustomFormatter(CUSTOM_FORMATTER_NEW);
      formatterCustomDeleteOpen.value = false;
      formatterCustomDeleteId.value = "";
      formatterCustomDeleteName.value = "";
    } catch (error) {
      options.toast?.(t("grid.tableOperationFailed", { message: translateBackendError(t, error) }), 5000);
    } finally {
      formatterCustomDeleteLoading.value = false;
    }
  }

  function formatterPreviewRows(columnIndex: number) {
    const formatter = resolveColumnFormatter(currentFormatterDraft(), settingsStore.editorSettings.customColumnFormatters);
    return options.displayRowRefs.value.slice(0, 5).map((_, index) => {
      const item = options.displayItemAt(index);
      const value = item?.data[columnIndex] ?? null;
      return {
        index: index + 1,
        raw: displayCellValue(value),
        formatted: formatter?.kind === "foreign-key-display" ? options.formatForeignKeyCellDisplay(value, columnIndex) : applyColumnFormatter(value, formatter),
      };
    });
  }

  return {
    CUSTOM_FORMATTER_NEW,
    formatterOpenColumn,
    formatterKind,
    formatterDateUnit,
    formatterDatetimePattern,
    formatterDateTimezone,
    timezoneOptions,
    formatterJsonPath,
    formatterMaskPrefix,
    formatterMaskSuffix,
    formatterCustomId,
    formatterCustomName,
    formatterCustomTemplate,
    formatterCustomDeleteOpen,
    formatterCustomDeleteLoading,
    formatterCustomDeleteName,
    formatterForeignKeyRefSchema,
    formatterForeignKeyRefTable,
    formatterForeignKeyRefColumn,
    formatterForeignKeyDisplayColumn,
    formatterForeignKeyManual,
    formatterForeignKeySchemas,
    formatterForeignKeyTables,
    formatterForeignKeyColumns,
    formatterForeignKeyReferenceKeys,
    formatterForeignKeyReferenceMetadataStatus,
    formatterForeignKeySchemasLoading,
    formatterForeignKeyTablesLoading,
    formatterForeignKeyColumnsLoading,
    formatterForeignKeyTargetError,
    formatterForeignKeyColumnsError,
    formatterForeignKeyReferenceMetadataError,
    formatterForeignKeyFilterEnabled,
    formatterForeignKeyFilterColumn,
    formatterForeignKeyFilterMode,
    formatterForeignKeyFilterValue,
    formatterForeignKeyFilterEndValue,
    formatterForeignKeyReferenceColumns,
    formatterForeignKeyReferenceValidation,
    formatterForeignKeyReferenceFilter,
    savedCustomFormatters,
    DataGridDateTimePatterns,
    displayTimeZoneOption,
    formatterKeysForColumn,
    formatterKeyForColumn,
    savedColumnFormatter,
    columnFormatter,
    columnHasFormatter,
    currentFormatterDraft,
    openColumnFormatter,
    closeColumnFormatter,
    handleColumnFormatterOpenChange,
    saveColumnFormatter,
    clearColumnFormatter,
    formatterDraftIsSavable,
    selectFormatterKind,
    selectFormatterForeignKeySchema,
    selectFormatterForeignKeyTable,
    selectFormatterForeignKeyFilterMode,
    selectCustomFormatter,
    requestDeleteCustomFormatter,
    confirmDeleteCustomFormatter,
    formatterPreviewRows,
  };
}
