<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS, normalizeDataGridExtractorOptions, validateDataGridExtractorOptions, type DataGridCopyExtractorId, type DataGridExtractorOptions, type DataGridExtractPreview, type DataGridExtractWarningCode } from "@/lib/dataGrid/dataGridCopyExtractor";

const props = defineProps<{
  open: boolean;
  extractor: DataGridCopyExtractorId;
  options: DataGridExtractorOptions;
  items: Array<{ value: DataGridCopyExtractorId; label: string; disabled?: boolean }>;
  preview: (extractor: DataGridCopyExtractorId, options: DataGridExtractorOptions) => Promise<DataGridExtractPreview>;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  save: [value: { extractor: DataGridCopyExtractorId; options: DataGridExtractorOptions }];
}>();

const { t } = useI18n();
const draftExtractor = ref<DataGridCopyExtractorId>(props.extractor);
const draftOptions = ref<DataGridExtractorOptions>(normalizeDataGridExtractorOptions(props.options));
const previewText = ref("");
const previewError = ref("");
const previewWarnings = ref<string[]>([]);
const previewLoading = ref(false);
const previewTruncatedRows = ref(0);
let previewSequence = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const extractorCategory = computed(() => DATA_GRID_COPY_EXTRACTOR_DESCRIPTORS[draftExtractor.value].category);
const isDsv = computed(() => extractorCategory.value === "delimited");
const isSql = computed(() => draftExtractor.value === "sql-inserts" || draftExtractor.value === "sql-updates");
const isJson = computed(() => extractorCategory.value === "json");
const optionsError = computed(() => {
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

async function refreshPreview() {
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
    const result = await props.preview(draftExtractor.value, normalizeDataGridExtractorOptions(draftOptions.value));
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
  return code === "omitted-columns" ? t("grid.copyExtractorWarningOmittedColumns", { columns: omittedColumns?.join(", ") || "-" }) : t("grid.copyExtractorWarningDuplicateJsonColumns");
}

function schedulePreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = setTimeout(() => void refreshPreview(), 180);
}

watch(
  () => props.open,
  (open) => {
    if (!open) {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = undefined;
      previewSequence += 1;
      previewLoading.value = false;
      return;
    }
    draftExtractor.value = props.extractor;
    draftOptions.value = normalizeDataGridExtractorOptions(props.options);
    schedulePreview();
  },
);

watch(
  [draftExtractor, draftOptions],
  () => {
    if (props.open) schedulePreview();
  },
  { deep: true },
);

onBeforeUnmount(() => {
  if (previewTimer) clearTimeout(previewTimer);
  previewSequence += 1;
});

function save() {
  if (optionsError.value) return;
  emit("save", { extractor: draftExtractor.value, options: normalizeDataGridExtractorOptions(draftOptions.value) });
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-[760px]">
      <DialogHeader
        ><DialogTitle>{{ t("grid.copyExtractorConfigure") }}</DialogTitle></DialogHeader
      >

      <div class="grid gap-4 md:grid-cols-[260px_minmax(0,1fr)]">
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>{{ t("grid.copyExtractorFormat") }}</Label>
            <Select v-model="draftExtractor">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="item in items" :key="item.value" :value="item.value" :disabled="item.disabled">{{ item.label }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <template v-if="isDsv">
            <div v-if="draftExtractor === 'dsv'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorColumnSeparator") }}</Label>
              <Input :model-value="visibleSeparator(draftOptions.dsv.columnSeparator)" @update:model-value="updateDsv('columnSeparator', separatorValue(String($event)))" />
            </div>
            <div v-if="draftExtractor !== 'one-row'" class="space-y-1.5">
              <Label>{{ t("grid.copyExtractorRowSeparator") }}</Label>
              <Input :model-value="visibleSeparator(draftOptions.dsv.rowSeparator)" @update:model-value="updateDsv('rowSeparator', separatorValue(String($event)))" />
            </div>
            <div class="space-y-1.5">
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
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label v-if="draftExtractor === 'dsv'" class="flex items-center gap-2 text-sm"
              ><input type="checkbox" :checked="draftOptions.dsv.includeColumnHeader" @change="updateDsv('includeColumnHeader', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeHeader") }}</label
            >
            <label v-if="draftExtractor !== 'one-row'" class="flex items-center gap-2 text-sm"
              ><input type="checkbox" :checked="draftOptions.dsv.includeRowHeader" @change="updateDsv('includeRowHeader', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorIncludeRowHeader") }}</label
            >
          </template>

          <template v-if="isSql">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipComputedColumns" @change="updateSql('skipComputedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipComputed") }}</label>
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.sql.skipGeneratedColumns" @change="updateSql('skipGeneratedColumns', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorSkipGenerated") }}</label>
            <label v-if="draftExtractor === 'sql-inserts'" class="flex items-center gap-2 text-sm"
              ><input type="checkbox" :checked="draftOptions.sql.excludePrimaryKeysFromInsert" @change="updateSql('excludePrimaryKeysFromInsert', ($event.target as HTMLInputElement).checked)" />{{ t("grid.copyExtractorExcludePrimaryKeys") }}</label
            >
            <div v-if="draftExtractor === 'sql-inserts'" class="space-y-1.5">
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

          <label v-if="isJson" class="flex items-center gap-2 text-sm"><input type="checkbox" :checked="draftOptions.json.pretty" @change="draftOptions = { ...draftOptions, json: { pretty: ($event.target as HTMLInputElement).checked } }" />{{ t("grid.copyExtractorPrettyJson") }}</label>
        </div>

        <div class="min-w-0 space-y-1.5">
          <Label>{{ t("grid.copyExtractorPreview") }}</Label>
          <div class="relative min-h-72 rounded-md border bg-muted/30">
            <pre class="max-h-[55vh] overflow-auto whitespace-pre p-3 font-mono text-xs">{{ previewError || previewText }}</pre>
            <span v-if="previewLoading" class="absolute right-2 top-2 text-xs text-muted-foreground">{{ t("common.loading") }}</span>
          </div>
          <p v-if="previewTruncatedRows" class="text-xs text-muted-foreground">{{ t("grid.copyExtractorPreviewTruncated", { count: previewTruncatedRows }) }}</p>
          <p v-for="warning in previewWarnings" :key="warning" class="text-xs text-amber-700 dark:text-amber-300">{{ warning }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t("common.cancel") }}</Button>
        <Button :disabled="!!optionsError" @click="save">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
