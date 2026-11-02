<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS,
  DATA_GRID_COPY_EXTRACTOR_IDS,
  DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS,
  normalizeVisibleDataGridCopyExtractors,
  normalizeDataGridExtractorOptions,
  validateDataGridExtractorOptions,
  type DataGridCopyExtractorId,
  type DataGridCopyPreference,
  type DataGridExtractorOptions,
  type DataGridExtractPreview,
  type DataGridExtractWarningCode,
  type DataGridValueFormat,
} from "@/lib/dataGrid/dataGridCopyExtractor";

const props = defineProps<{
  open: boolean;
  preference: DataGridCopyPreference;
  sourceTableName?: string;
  visibleCopyExtractors: DataGridCopyExtractorId[];
  options: DataGridExtractorOptions;
  mode?: "configure" | "copy";
  previewSessionKey?: number;
  items: Array<{ value: DataGridCopyPreference; label: string; disabled?: boolean }>;
  visibleItems: Array<{ value: DataGridCopyExtractorId; label: string; disabled?: boolean }>;
  preview: (preference: DataGridCopyPreference, options: DataGridExtractorOptions) => Promise<DataGridExtractPreview>;
  canCopy?: (preference: DataGridCopyPreference, options: DataGridExtractorOptions) => boolean;
  copy?: (preference: DataGridCopyPreference, options: DataGridExtractorOptions) => Promise<boolean>;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  save: [value: { preference: DataGridCopyPreference; options: DataGridExtractorOptions; visibleCopyExtractors: DataGridCopyExtractorId[] }];
}>();

const { t } = useI18n();
const formatRadioGroupName = `grid-copy-format-${useId()}`;
const selectedFormat = ref<DataGridCopyPreference>(props.preference);
const draftDefaultPreference = ref<DataGridCopyPreference>(props.preference);
const draftOptions = ref<DataGridExtractorOptions>(normalizeDataGridExtractorOptions(props.options));
const draftVisibleCopyExtractors = ref<DataGridCopyExtractorId[]>(normalizeVisibleDataGridCopyExtractors(props.visibleCopyExtractors));
const previewText = ref("");
const previewError = ref("");
const copyError = ref("");
const previewWarnings = ref<string[]>([]);
const previewLoading = ref(false);
const previewTruncatedRows = ref(0);
const previewExpanded = ref(false);
const copyRunning = ref(false);
let previewSequence = 0;
let dialogSession = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const draftExtractor = computed<DataGridCopyExtractorId | null>(() => (selectedFormat.value === "smart" ? null : selectedFormat.value));
const extractorCategory = computed(() => (draftExtractor.value ? DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[draftExtractor.value].category : null));
const isDsv = computed(() => extractorCategory.value === "delimited");
const supportsCsvOptions = computed(() => draftExtractor.value === "csv" || draftExtractor.value === "csv-with-headers" || draftExtractor.value === "dsv" || draftExtractor.value === "tsv" || draftExtractor.value === "tsv-with-headers");
const isSql = computed(() => draftExtractor.value === "sql-inserts" || draftExtractor.value === "sql-deletes-inserts" || draftExtractor.value === "sql-updates");
const isJson = computed(() => extractorCategory.value === "json");
const isDbunit = computed(() => draftExtractor.value === "dbunit");
const isPhp = computed(() => draftExtractor.value === "php");
const hasSpecificOptions = computed(() => isDsv.value || isSql.value || isJson.value || isDbunit.value || isPhp.value);
const canCopySelectedFormat = computed(() => props.mode !== "copy" || !!props.canCopy?.(selectedFormat.value, normalizeDataGridExtractorOptions(draftOptions.value)));
const optionsError = computed(() => {
  if (!draftExtractor.value) return "";
  if (draftExtractor.value === "dbunit" && !props.sourceTableName && !draftOptions.value.dbunit.tableName.trim()) return t("grid.copyDbunitTableNameRequired");
  if (draftExtractor.value === "php" && draftOptions.value.php.variableName !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(draftOptions.value.php.variableName)) return t("grid.copyPhpVariableInvalid");
  if (draftExtractor.value === "php" && draftOptions.value.php.rowDelimiter.length > 8) return t("grid.copyExtractorValidation.separator-too-long");
  const code = validateDataGridExtractorOptions(draftExtractor.value, draftOptions.value);
  if (!code) return "";
  return t(`grid.copyExtractorValidation.${code}`);
});

function visibleSeparator(value: string): string {
  return value.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function separatorValue(value: string): string {
  return value.replace(/\\t/g, "\t").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
}

function updateDsv<K extends keyof DataGridExtractorOptions["dsv"]>(key: K, value: DataGridExtractorOptions["dsv"][K]) {
  draftOptions.value = { ...draftOptions.value, dsv: { ...draftOptions.value.dsv, [key]: value } };
}

function updateSql<K extends keyof DataGridExtractorOptions["sql"]>(key: K, value: DataGridExtractorOptions["sql"][K]) {
  draftOptions.value = { ...draftOptions.value, sql: { ...draftOptions.value.sql, [key]: value } };
}

function updateJson<K extends keyof DataGridExtractorOptions["json"]>(key: K, value: DataGridExtractorOptions["json"][K]) {
  draftOptions.value = { ...draftOptions.value, json: { ...draftOptions.value.json, [key]: value } };
}

function updateDbunit<K extends keyof DataGridExtractorOptions["dbunit"]>(key: K, value: DataGridExtractorOptions["dbunit"][K]) {
  draftOptions.value = { ...draftOptions.value, dbunit: { ...draftOptions.value.dbunit, [key]: value } };
}

function updatePhp<K extends keyof DataGridExtractorOptions["php"]>(key: K, value: DataGridExtractorOptions["php"][K]) {
  draftOptions.value = { ...draftOptions.value, php: { ...draftOptions.value.php, [key]: value } };
}

function toggleVisibleCopyExtractor(extractor: DataGridCopyExtractorId, visible: boolean) {
  const current = new Set(draftVisibleCopyExtractors.value);
  if (visible) current.add(extractor);
  else current.delete(extractor);
  draftVisibleCopyExtractors.value = DATA_GRID_COPY_EXTRACTOR_IDS.filter((item) => current.has(item));
}

async function refreshPreview() {
  if (!props.open || !previewExpanded.value) return;
  const sequence = ++previewSequence;
  previewLoading.value = true;
  previewError.value = "";
  previewWarnings.value = [];
  previewTruncatedRows.value = 0;
  if (optionsError.value) {
    previewError.value = optionsError.value;
    previewLoading.value = false;
    return;
  }
  try {
    const result = await props.preview(selectedFormat.value, normalizeDataGridExtractorOptions(draftOptions.value));
    if (sequence === previewSequence) {
      previewText.value = result.text;
      previewWarnings.value = (result.warnings ?? []).map((warning) => warningText(warning.code, result.omittedColumns));
      previewTruncatedRows.value = result.truncated ? result.sourceRowCount : 0;
    }
  } catch (error: unknown) {
    if (sequence === previewSequence) {
      previewText.value = "";
      previewError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (sequence === previewSequence) previewLoading.value = false;
  }
}

function warningText(code: DataGridExtractWarningCode, omittedColumns: string[] | undefined): string {
  if (code === "omitted-columns") return t("grid.copyExtractorWarningOmittedColumns", { columns: omittedColumns?.join(", ") || "-" });
  if (code === "php-date-not-iso") return t("grid.copyExtractorWarningPhpDateNotIso");
  return t("grid.copyExtractorWarningDuplicateJsonColumns");
}

function schedulePreview() {
  if (!props.open || !previewExpanded.value) return;
  previewSequence += 1;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 180);
}

watch(
  () => [props.open, props.mode] as const,
  ([open]) => {
    if (!open) {
      dialogSession += 1;
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = undefined;
      previewSequence += 1;
      previewLoading.value = false;
      return;
    }
    dialogSession += 1;
    selectedFormat.value = props.preference;
    draftDefaultPreference.value = props.preference;
    draftOptions.value = normalizeDataGridExtractorOptions(props.options);
    draftVisibleCopyExtractors.value = normalizeVisibleDataGridCopyExtractors(props.visibleCopyExtractors);
    previewExpanded.value = false;
    copyRunning.value = false;
    previewText.value = "";
    previewError.value = "";
    copyError.value = "";
  },
  { immediate: true },
);

watch(
  [selectedFormat, draftOptions],
  () => {
    copyError.value = "";
    if (props.open && previewExpanded.value) schedulePreview();
  },
  { deep: true },
);

watch(previewExpanded, (expanded) => {
  if (expanded) {
    schedulePreview();
    return;
  }
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  previewSequence += 1;
  previewLoading.value = false;
  previewText.value = "";
  previewError.value = "";
  previewWarnings.value = [];
  previewTruncatedRows.value = 0;
});

watch(
  () => props.previewSessionKey,
  () => {
    if (props.mode !== "copy" || !props.open) return;
    previewSequence += 1;
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
    previewLoading.value = false;
    previewText.value = "";
    previewWarnings.value = [];
    previewError.value = t("grid.copyExtractorSelectionChanged");
  },
);

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  previewSequence += 1;
});

function save() {
  if (optionsError.value) return;
  emit("save", { preference: draftDefaultPreference.value, options: normalizeDataGridExtractorOptions(draftOptions.value), visibleCopyExtractors: [...draftVisibleCopyExtractors.value] });
  emit("update:open", false);
}

async function performCopy() {
  if (copyRunning.value || optionsError.value || !canCopySelectedFormat.value || !props.copy) return;
  const session = dialogSession;
  copyRunning.value = true;
  copyError.value = "";
  try {
    const copied = await props.copy(selectedFormat.value, normalizeDataGridExtractorOptions(draftOptions.value));
    if (session !== dialogSession || !props.open) return;
    if (copied) emit("update:open", false);
    else copyError.value = t("grid.copyExtractorCopyFailed");
  } catch (error: unknown) {
    if (session === dialogSession && props.open) copyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (session === dialogSession) copyRunning.value = false;
  }
}

function togglePreview() {
  previewExpanded.value = !previewExpanded.value;
}

function handleFormatKeydown(event: KeyboardEvent, itemIndex: number) {
  const keyOffsets: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  const enabledItems = props.items.map((item, index) => ({ item, index })).filter(({ item }) => !item.disabled);
  const currentEnabledIndex = enabledItems.findIndex(({ index }) => index === itemIndex);
  let targetEnabledIndex: number;
  if (event.key === "Home") targetEnabledIndex = 0;
  else if (event.key === "End") targetEnabledIndex = enabledItems.length - 1;
  else if (event.key in keyOffsets) targetEnabledIndex = (currentEnabledIndex + keyOffsets[event.key]! + enabledItems.length) % enabledItems.length;
  else return;
  const target = enabledItems[targetEnabledIndex];
  if (!target) return;
  event.preventDefault();
  selectedFormat.value = target.item.value;
  void nextTick(() => document.getElementById(`${formatRadioGroupName}-${target.item.value}`)?.focus());
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[90dvh] flex-col sm:max-w-[1040px]">
      <DialogHeader>
        <DialogTitle>{{ t(mode === "copy" ? "grid.copyExtractorAdvancedCopy" : "grid.copyExtractorConfigure") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">{{ t(mode === "copy" ? "grid.copyExtractorAdvancedCopyHint" : "grid.copyExtractorConfigureHint") }}</p>
      </DialogHeader>

      <div class="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-4 overflow-hidden md:grid-cols-[210px_minmax(0,1fr)] md:grid-rows-1">
        <aside class="flex min-h-0 flex-col gap-3">
          <div v-if="mode !== 'copy'" class="space-y-1.5">
            <Label>{{ t("grid.copyExtractorDefaultFormat") }}</Label>
            <Select v-model="draftDefaultPreference">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="item in items" :key="item.value" :value="item.value" :disabled="item.disabled">{{ item.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto pr-1">
            <Label class="mb-1.5 block">{{ t("grid.copyExtractorFormatList") }}</Label>
            <div role="radiogroup" :aria-label="t('grid.copyExtractorFormatList')" class="space-y-1">
              <label v-for="(item, index) in items" :key="item.value" class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
                <input
                  :id="`${formatRadioGroupName}-${item.value}`"
                  v-model="selectedFormat"
                  type="radio"
                  :name="formatRadioGroupName"
                  :value="item.value"
                  :disabled="item.disabled"
                  class="accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  @keydown="handleFormatKeydown($event, index)"
                />
                <span>{{ item.label }}</span>
              </label>
            </div>
          </div>

          <details v-if="mode !== 'copy'" class="max-h-[28vh] shrink-0 overflow-y-auto border-t pt-2">
            <summary class="cursor-pointer text-sm font-medium">{{ t("grid.copyExtractorVisibleFormats") }}</summary>
            <div class="flex items-center justify-between gap-2 py-2">
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="draftVisibleCopyExtractors = [...DATA_GRID_DEFAULT_VISIBLE_COPY_EXTRACTORS]">{{ t("grid.copyExtractorRestoreVisibleFormats") }}</Button>
            </div>
            <label v-for="item in visibleItems" :key="item.value" class="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" :checked="draftVisibleCopyExtractors.includes(item.value)" @change="toggleVisibleCopyExtractor(item.value, ($event.target as HTMLInputElement).checked)" />{{ item.label }}
            </label>
          </details>
        </aside>

        <section class="flex min-h-0 min-w-0 flex-col gap-3">
          <div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            <p v-if="selectedFormat === 'smart'" class="text-sm text-muted-foreground">{{ t("grid.copyExtractorSmart") }}</p>
            <p v-else-if="draftExtractor === 'raw'" class="text-sm text-muted-foreground">{{ t("grid.copyExtractorRawHint") }}</p>

            <div v-if="draftExtractor && draftExtractor !== 'raw' && !isSql" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorValueFormat") }}</Label>
              <Select :model-value="draftOptions.valueFormat" @update:model-value="draftOptions = { ...draftOptions, valueFormat: $event as DataGridValueFormat }">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent
                  ><SelectItem value="default">{{ t("grid.copyExtractorValueFormatDefault") }}</SelectItem
                  ><SelectItem value="legacy">{{ t("grid.copyExtractorValueFormatLegacy") }}</SelectItem
                  ><SelectItem value="display">{{ t("grid.copyExtractorValueFormatDisplay") }}</SelectItem
                  ><SelectItem value="edit">{{ t("grid.copyExtractorValueFormatEdit") }}</SelectItem
                  ><SelectItem value="native">{{ t("grid.copyExtractorValueFormatNative") }}</SelectItem></SelectContent
                >
              </Select>
            </div>

            <p v-if="hasSpecificOptions" class="text-sm font-medium">{{ t("grid.copyExtractorFormatOptions") }}</p>

            <template v-if="isDsv">
              <div v-if="draftExtractor === 'dsv'" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorColumnSeparator") }}</Label>
                <Input :model-value="visibleSeparator(draftOptions.dsv.columnSeparator)" @update:model-value="updateDsv('columnSeparator', separatorValue(String($event)))" />
              </div>
              <div v-if="draftExtractor !== 'one-row'" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorRowSeparator") }}</Label>
                <Input :model-value="visibleSeparator(draftOptions.dsv.rowSeparator)" @update:model-value="updateDsv('rowSeparator', separatorValue(String($event)))" />
              </div>
              <div v-if="supportsCsvOptions" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorNullText") }}</Label>
                <Input :model-value="draftOptions.dsv.nullText" @update:model-value="updateDsv('nullText', String($event))" />
              </div>
              <div class="grid grid-cols-2 gap-2">
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorQuote") }}</Label>
                  <Input maxlength="1" :model-value="draftOptions.dsv.quote" @update:model-value="updateDsv('quote', String($event))" />
                </div>
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorQuotePolicy") }}</Label>
                  <Select :model-value="draftOptions.dsv.quotePolicy" @update:model-value="updateDsv('quotePolicy', $event as DataGridExtractorOptions['dsv']['quotePolicy'])">
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minimal">{{ t("grid.copyExtractorQuoteMinimal") }}</SelectItem>
                      <SelectItem value="always">{{ t("grid.copyExtractorQuoteAlways") }}</SelectItem>
                      <SelectItem value="never">{{ t("grid.copyExtractorQuoteNever") }}</SelectItem>
                      <SelectItem value="strings">{{ t("grid.copyExtractorQuoteStrings") }}</SelectItem>
                      <SelectItem value="all-but-numbers">{{ t("grid.copyExtractorQuoteAllButNumbers") }}</SelectItem>
                      <SelectItem value="all-including-nulls">{{ t("grid.copyExtractorQuoteAllIncludingNulls") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div v-if="supportsCsvOptions" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorHeaderPosition") }}</Label>
                <Select :model-value="draftOptions.dsv.headerPosition" @update:model-value="updateDsv('headerPosition', $event as DataGridExtractorOptions['dsv']['headerPosition'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent
                    ><SelectItem value="legacy">{{ t("grid.copyExtractorHeaderLegacy") }}</SelectItem
                    ><SelectItem value="none">{{ t("grid.copyExtractorHeaderNone") }}</SelectItem
                    ><SelectItem value="top">{{ t("grid.copyExtractorHeaderTop") }}</SelectItem
                    ><SelectItem value="bottom">{{ t("grid.copyExtractorHeaderBottom") }}</SelectItem></SelectContent
                  >
                </Select>
              </div>
              <div v-if="supportsCsvOptions && draftOptions.dsv.headerPosition !== 'none'" class="grid grid-cols-2 gap-2">
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorHeaderFormat") }}</Label
                  ><Select :model-value="draftOptions.dsv.headerFormat" @update:model-value="updateDsv('headerFormat', $event as DataGridExtractorOptions['dsv']['headerFormat'])"
                    ><SelectTrigger><SelectValue /></SelectTrigger
                    ><SelectContent
                      ><SelectItem value="name">{{ t("grid.copyExtractorHeaderName") }}</SelectItem
                      ><SelectItem value="description">{{ t("grid.copyExtractorHeaderDescription") }}</SelectItem
                      ><SelectItem value="both">{{ t("grid.copyExtractorHeaderBoth") }}</SelectItem
                      ><SelectItem value="name-and-description-two-rows">{{ t("grid.copyExtractorHeaderTwoRows") }}</SelectItem></SelectContent
                    ></Select
                  >
                </div>
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorHeaderCase") }}</Label
                  ><Select :model-value="draftOptions.dsv.headerCase" @update:model-value="updateDsv('headerCase', $event as DataGridExtractorOptions['dsv']['headerCase'])"
                    ><SelectTrigger><SelectValue /></SelectTrigger
                    ><SelectContent
                      ><SelectItem value="preserve">{{ t("grid.copyExtractorHeaderPreserve") }}</SelectItem
                      ><SelectItem value="upper">{{ t("grid.copyExtractorHeaderUpper") }}</SelectItem
                      ><SelectItem value="lower">{{ t("grid.copyExtractorHeaderLower") }}</SelectItem></SelectContent
                    ></Select
                  >
                </div>
              </div>
              <details v-if="supportsCsvOptions" class="space-y-2 rounded-md border p-3">
                <summary class="cursor-pointer text-sm font-medium">{{ t("grid.copyExtractorAdvancedOptions") }}</summary>
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dsv.quoteNumericStrings" @change="updateDsv('quoteNumericStrings', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorQuoteNumericStrings") }}</label>
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dsv.escapeFormulas" @change="updateDsv('escapeFormulas', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorEscapeFormulas") }}</label>
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorLineFeedEscape") }}</Label
                  ><Input :model-value="visibleSeparator(draftOptions.dsv.lineFeedEscapeString)" @update:model-value="updateDsv('lineFeedEscapeString', separatorValue(String($event)))" />
                </div>
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorArrayFormat") }}</Label
                  ><Select :model-value="draftOptions.dsv.arrayFormat" @update:model-value="updateDsv('arrayFormat', $event as DataGridExtractorOptions['dsv']['arrayFormat'])"
                    ><SelectTrigger><SelectValue /></SelectTrigger
                    ><SelectContent
                      ><SelectItem value="preserve">{{ t("grid.copyExtractorArrayPreserve") }}</SelectItem
                      ><SelectItem value="braces">{ }</SelectItem><SelectItem value="brackets">[ ]</SelectItem><SelectItem value="parentheses">( )</SelectItem></SelectContent
                    ></Select
                  >
                </div>
                <div class="space-y-1.5">
                  <Label>{{ t("grid.copyExtractorFormatNumbers") }}</Label
                  ><Select :model-value="draftOptions.dsv.formatNumbers" @update:model-value="updateDsv('formatNumbers', $event as DataGridExtractorOptions['dsv']['formatNumbers'])"
                    ><SelectTrigger><SelectValue /></SelectTrigger
                    ><SelectContent
                      ><SelectItem value="inherit">{{ t("grid.copyExtractorFormatNumbersInherit") }}</SelectItem
                      ><SelectItem value="native">{{ t("grid.copyExtractorFormatNumbersNative") }}</SelectItem
                      ><SelectItem value="display">{{ t("grid.copyExtractorFormatNumbersDisplay") }}</SelectItem></SelectContent
                    ></Select
                  >
                </div>
              </details>
            </template>

            <label v-if="isDsv && draftExtractor !== 'one-row'" class="flex items-center gap-2 text-sm"
              ><input type="checkbox" :checked="draftOptions.dsv.includeRowHeader" @change="updateDsv('includeRowHeader', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeRowHeader") }}</label
            >

            <template v-if="isSql">
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipComputedColumns" @change="updateSql('skipComputedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipComputed") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipGeneratedColumns" @change="updateSql('skipGeneratedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipGenerated") }}</label>
              <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorExcludePrimaryKeys") }}</Label>
                <Select :model-value="draftOptions.sql.primaryKeyMode" @update:model-value="updateSql('primaryKeyMode', $event as DataGridExtractorOptions['sql']['primaryKeyMode'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="include">{{ t("grid.copyExtractorSqlInsertsWithPrimaryKeys") }}</SelectItem>
                    <SelectItem value="exclude-generated">{{ t("grid.copyExtractorSqlInsertsWithoutPrimaryKeys") }}</SelectItem>
                    <SelectItem value="exclude-all">{{ t("grid.copyExtractorSqlInsertsWithoutAllPrimaryKeys") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.includeDatabaseName" @change="updateSql('includeDatabaseName', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeDatabaseName") }}</label>
              <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
                <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.quoteIdentifiers" @change="updateSql('quoteIdentifiers', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorQuoteIdentifiers") }}</label>
                <Label>{{ t("grid.copyExtractorTemporalFormat") }}</Label>
                <Select :model-value="draftOptions.sql.temporalFormat" @update:model-value="updateSql('temporalFormat', $event as DataGridExtractorOptions['sql']['temporalFormat'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="native">{{ t("grid.copyExtractorTemporalNative") }}</SelectItem>
                    <SelectItem value="string">{{ t("grid.copyExtractorTemporalString") }}</SelectItem>
                  </SelectContent>
                </Select>
                <p v-if="draftOptions.sql.temporalFormat === 'string'" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorTemporalStringHint") }}</p>
              </div>
              <div v-if="draftExtractor === 'sql-inserts' || draftExtractor === 'sql-deletes-inserts'" class="space-y-1.5">
                <Label>{{ t("grid.copyExtractorInsertMode") }}</Label>
                <Select :model-value="draftOptions.sql.insertMode" @update:model-value="updateSql('insertMode', $event as DataGridExtractorOptions['sql']['insertMode'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="merged">{{ t("grid.copyExtractorInsertMerged") }}</SelectItem>
                    <SelectItem value="row-by-row">{{ t("grid.copyExtractorInsertRowByRow") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </template>

            <template v-if="isJson">
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.pretty" @change="updateJson('pretty', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorPrettyJson") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.camelCaseFieldNames" @change="updateJson('camelCaseFieldNames', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorCamelCaseJsonFields") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.valuesOnly" @change="updateJson('valuesOnly', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorValuesOnlyJsonArray") }}</label>
              <p v-if="draftOptions.json.valuesOnly" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorValuesOnlyJsonArrayHint") }}</p>
            </template>

            <template v-if="isDbunit">
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyDbunitTableName") }}</Label>
                <Input v-if="!sourceTableName" :model-value="draftOptions.dbunit.tableName" @update:model-value="updateDbunit('tableName', String($event))" />
                <p v-else class="rounded-md border bg-muted/30 px-2 py-1.5 text-sm">{{ sourceTableName }}</p>
                <p class="text-xs text-muted-foreground">{{ t("grid.copyDbunitTableNameHint") }}</p>
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyDbunitNullValue") }}</Label>
                <Input :model-value="draftOptions.dbunit.nullValueString" @update:model-value="updateDbunit('nullValueString', String($event))" />
              </div>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.upperCaseTableName" @change="updateDbunit('upperCaseTableName', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitUppercaseTable") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.upperCaseColumnNames" @change="updateDbunit('upperCaseColumnNames', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitUppercaseColumns") }}</label>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.dbunit.includeNullValues" @change="updateDbunit('includeNullValues', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyDbunitIncludeNulls") }}</label>
            </template>

            <template v-if="isPhp">
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyPhpVariable") }}</Label>
                <Input :model-value="draftOptions.php.variableName || (sourceTableName && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sourceTableName) ? sourceTableName : 'data')" @update:model-value="updatePhp('variableName', String($event))" />
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyPhpArraySyntax") }}</Label>
                <Select :model-value="draftOptions.php.arraySyntax" @update:model-value="updatePhp('arraySyntax', $event as DataGridExtractorOptions['php']['arraySyntax'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="legacy">array()</SelectItem><SelectItem value="short">[]</SelectItem></SelectContent>
                </Select>
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyPhpQuote") }}</Label>
                <Select :model-value="draftOptions.php.quoteChar" @update:model-value="updatePhp('quoteChar', $event as DataGridExtractorOptions['php']['quoteChar'])">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="'">'…'</SelectItem><SelectItem value='"'>"…"</SelectItem></SelectContent>
                </Select>
              </div>
              <div class="space-y-1.5">
                <Label>{{ t("grid.copyPhpRowDelimiter") }}</Label>
                <Input :model-value="visibleSeparator(draftOptions.php.rowDelimiter)" @update:model-value="updatePhp('rowDelimiter', separatorValue(String($event)))" />
              </div>
              <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.php.formatDateIso" @change="updatePhp('formatDateIso', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyPhpIsoDates") }}</label>
            </template>
          </div>

          <div class="shrink-0 border-t pt-2">
            <Button type="button" variant="ghost" class="w-full justify-between" :aria-expanded="previewExpanded" @click="togglePreview">
              <span>{{ t("grid.copyExtractorPreview") }}</span
              ><span class="text-xs text-muted-foreground">{{ previewExpanded ? t("grid.copyExtractorCollapsePreview") : t("grid.copyExtractorPreviewOnDemand") }}</span>
            </Button>
            <div v-if="previewExpanded" class="relative mt-2 min-h-24 rounded-md border bg-muted/30">
              <pre v-if="previewError" class="max-h-[32vh] overflow-y-auto whitespace-pre-wrap break-words p-3 text-sm">{{ previewError }}</pre>
              <pre v-else-if="previewText" class="max-h-[32vh] overflow-auto whitespace-pre p-3 font-mono text-xs">{{ previewText }}</pre>
              <p v-else class="p-3 text-sm text-muted-foreground">{{ previewLoading ? t("common.loading") : t("grid.copyExtractorPreviewOnDemand") }}</p>
              <span v-if="previewLoading && previewText" class="absolute right-2 top-2 text-xs text-muted-foreground">{{ t("common.loading") }}</span>
            </div>
            <p v-if="previewTruncatedRows" class="mt-1 text-xs text-muted-foreground">{{ t("grid.copyExtractorPreviewTruncated", { count: previewTruncatedRows }) }}</p>
            <p v-for="warning in previewWarnings" :key="warning" class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ warning }}</p>
            <p v-if="copyError" role="alert" class="mt-1 text-sm text-destructive">{{ copyError }}</p>
          </div>
        </section>
      </div>

      <DialogFooter class="shrink-0">
        <Button variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button v-if="mode !== 'copy'" :disabled="!!optionsError" @click="save">{{ t("common.save") }}</Button>
        <Button v-else :disabled="!!optionsError || !canCopySelectedFormat || copyRunning" @click="performCopy">{{ t(copyRunning ? "grid.copyExtractorCopyRunning" : "grid.copy") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
