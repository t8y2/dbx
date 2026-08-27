<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertCircle, FileDiff } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SideBySideTextDiff, { type TextDiffSide } from "@/components/common/SideBySideTextDiff.vue";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { detectDoltCellFormat, doltCellCopyText, doltCellDisplayValue, formatDoltCellText, type DoltCellFormat, type DoltCellFormatMode, type DoltDiffCellTarget } from "@/lib/dolt/doltCellDiff";

const props = defineProps<{
  target: DoltDiffCellTarget | null;
  tableName: string;
  fromRevision: string;
  toRevision: string;
}>();

const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const { toast } = useToast();
const formatMode = ref<DoltCellFormatMode>("auto");

const displayLabels = computed(() => ({
  nullValue: t("doltVersionControl.cellNullValue"),
  rowMissing: t("doltVersionControl.cellRowMissing"),
  columnMissing: t("doltVersionControl.cellColumnMissing"),
}));
const beforeDisplay = computed(() => (props.target ? doltCellDisplayValue(props.target, "before", displayLabels.value) : null));
const afterDisplay = computed(() => (props.target ? doltCellDisplayValue(props.target, "after", displayLabels.value) : null));
const detectedFormat = computed<DoltCellFormat>(() => detectDoltCellFormat([beforeDisplay.value, afterDisplay.value].filter((value): value is NonNullable<typeof value> => !!value)));
const effectiveFormat = computed<DoltCellFormat>(() => (formatMode.value === "auto" ? detectedFormat.value : formatMode.value));
const beforeFormatted = computed(() => (beforeDisplay.value ? formatDoltCellText(beforeDisplay.value, effectiveFormat.value) : { text: "", error: null }));
const afterFormatted = computed(() => (afterDisplay.value ? formatDoltCellText(afterDisplay.value, effectiveFormat.value) : { text: "", error: null }));
const formatOptions = computed<Array<{ value: DoltCellFormatMode; label: string }>>(() => [
  { value: "auto", label: t("doltVersionControl.cellDiffFormatAuto") },
  { value: "raw", label: t("doltVersionControl.cellDiffFormatRaw") },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
]);

async function copyValue(side: TextDiffSide) {
  if (!props.target) return;
  const value = doltCellCopyText(props.target, side);
  if (value === null) return;
  try {
    await copyToClipboard(value);
    toast(t("doltVersionControl.cellValueCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

watch(
  () => [open.value, props.target?.rowIndex, props.target?.columnIndex, props.target?.side],
  ([isOpen]) => {
    if (!isOpen) return;
    formatMode.value = "auto";
  },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="target" class="flex h-[min(82vh,760px)] min-w-0 max-w-[min(1180px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-32px))]">
      <DialogHeader class="shrink-0 border-b px-4 py-3 pr-11">
        <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
          <FileDiff class="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span class="min-w-0 truncate">{{ t("doltVersionControl.cellDiffTitle", { table: tableName, column: target.columnName }) }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <div class="inline-flex h-7 items-center rounded border bg-muted/20 p-0.5" role="group" :aria-label="t('doltVersionControl.cellDiffFormat')">
          <Button v-for="option in formatOptions" :key="option.value" type="button" size="sm" :variant="formatMode === option.value ? 'secondary' : 'ghost'" class="h-6 rounded-sm px-2 text-[11px] shadow-none" @click="formatMode = option.value">
            {{ option.label }}
          </Button>
        </div>
        <span v-if="formatMode === 'auto'" class="truncate text-[11px] text-muted-foreground">{{ t("doltVersionControl.cellDiffDetectedFormat", { format: effectiveFormat.toUpperCase() }) }}</span>
      </div>

      <div v-if="beforeFormatted.error || afterFormatted.error" class="grid shrink-0 grid-cols-2 border-b bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
        <div class="flex min-w-0 items-start gap-1.5 border-r px-2 py-1">
          <template v-if="beforeFormatted.error"
            ><AlertCircle class="mt-0.5 h-3 w-3 shrink-0" /><span class="min-w-0 break-words">{{ t("doltVersionControl.cellDiffFormatFailed", { message: beforeFormatted.error }) }}</span></template
          >
        </div>
        <div class="flex min-w-0 items-start gap-1.5 px-2 py-1">
          <template v-if="afterFormatted.error"
            ><AlertCircle class="mt-0.5 h-3 w-3 shrink-0" /><span class="min-w-0 break-words">{{ t("doltVersionControl.cellDiffFormatFailed", { message: afterFormatted.error }) }}</span></template
          >
        </div>
      </div>

      <SideBySideTextDiff
        :before-text="beforeFormatted.text"
        :after-text="afterFormatted.text"
        :before-label="fromRevision"
        :after-label="toRevision"
        :copy-before-title="t('doltVersionControl.copyBeforeValue')"
        :copy-after-title="t('doltVersionControl.copyAfterValue')"
        :before-available="beforeDisplay?.state === 'value'"
        :after-available="afterDisplay?.state === 'value'"
        @copy="copyValue"
      />
    </DialogContent>
  </Dialog>
</template>
