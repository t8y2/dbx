<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { AlertCircle, Copy, FileDiff } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DoltScrollArea from "@/components/dolt/DoltScrollArea.vue";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { buildDoltTextDiff, detectDoltCellFormat, doltCellCopyText, doltCellDisplayValue, formatDoltCellText, type DoltCellFormat, type DoltCellFormatMode, type DoltCellSide, type DoltDiffCellTarget, type DoltTextDiffKind } from "@/lib/dolt/doltCellDiff";

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
const beforeScrollArea = ref<InstanceType<typeof DoltScrollArea> | null>(null);
const afterScrollArea = ref<InstanceType<typeof DoltScrollArea> | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
let scrollSyncing = false;
let scrollSyncFrame = 0;

const ROW_HEIGHT = 22;
const ROW_BUFFER = 12;

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
const diffRows = computed(() => {
  const rows = buildDoltTextDiff(beforeFormatted.value.text, afterFormatted.value.text);
  if (beforeDisplay.value?.state !== "value" && afterDisplay.value?.state === "value") return rows.map((row) => ({ ...row, kind: "added" as const }));
  if (afterDisplay.value?.state !== "value" && beforeDisplay.value?.state === "value") return rows.map((row) => ({ ...row, kind: "removed" as const }));
  return rows;
});
const visibleStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - ROW_BUFFER));
const visibleEnd = computed(() => Math.min(diffRows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + ROW_BUFFER));
const visibleRows = computed(() => diffRows.value.slice(visibleStart.value, visibleEnd.value).map((row, offset) => ({ row, index: visibleStart.value + offset })));
const longestLineLength = computed(() => {
  let maximum = 0;
  for (const row of diffRows.value) maximum = Math.max(maximum, row.beforeText.length, row.afterText.length);
  return Math.min(20_000, maximum);
});
const textContentStyle = computed<CSSProperties>(() => ({
  height: `${Math.max(1, diffRows.value.length * ROW_HEIGHT)}px`,
  width: `max(100%, ${Math.max(40, longestLineLength.value + 8)}ch)`,
}));
const formatOptions = computed<Array<{ value: DoltCellFormatMode; label: string }>>(() => [
  { value: "auto", label: t("doltVersionControl.cellDiffFormatAuto") },
  { value: "raw", label: t("doltVersionControl.cellDiffFormatRaw") },
  { value: "json", label: "JSON" },
  { value: "xml", label: "XML" },
]);

function rowClass(kind: DoltTextDiffKind, side: DoltCellSide): string {
  if (kind === "modified") return "dolt-cell-text-row-modified";
  if (kind === "added" && side === "after") return "dolt-cell-text-row-added";
  if (kind === "removed" && side === "before") return "dolt-cell-text-row-removed";
  return "";
}

function updateViewport(element: HTMLElement) {
  scrollTop.value = element.scrollTop;
  viewportHeight.value = element.clientHeight;
}

function syncScroll(side: DoltCellSide, source: HTMLElement) {
  updateViewport(source);
  if (scrollSyncing) return;
  const target = side === "before" ? afterScrollArea.value?.scrollerElement() : beforeScrollArea.value?.scrollerElement();
  if (!target) return;
  scrollSyncing = true;
  target.scrollTop = source.scrollTop;
  target.scrollLeft = source.scrollLeft;
  if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
  scrollSyncFrame = requestAnimationFrame(() => {
    scrollSyncFrame = 0;
    scrollSyncing = false;
  });
}

function onResize(element: HTMLElement) {
  viewportHeight.value = Math.max(viewportHeight.value, element.clientHeight);
}

async function copyValue(side: DoltCellSide) {
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
  async ([isOpen]) => {
    if (!isOpen) return;
    formatMode.value = "auto";
    scrollTop.value = 0;
    await nextTick();
    const before = beforeScrollArea.value?.scrollerElement();
    const after = afterScrollArea.value?.scrollerElement();
    if (before) before.scrollTo({ top: 0, left: 0 });
    if (after) after.scrollTo({ top: 0, left: 0 });
  },
);

watch(effectiveFormat, async () => {
  scrollTop.value = 0;
  await nextTick();
  beforeScrollArea.value?.scrollerElement()?.scrollTo({ top: 0, left: 0 });
  afterScrollArea.value?.scrollerElement()?.scrollTo({ top: 0, left: 0 });
});

onUnmounted(() => {
  if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
});
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

      <div class="grid min-h-0 flex-1 grid-cols-2 overflow-hidden">
        <section class="flex min-w-0 min-h-0 flex-col border-r">
          <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-2 text-[11px]">
            <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" :title="fromRevision">{{ fromRevision }}</span>
            <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="doltCellCopyText(target, 'before') === null" :title="t('doltVersionControl.copyBeforeValue')" @click="copyValue('before')"><Copy class="h-3 w-3" /></Button>
          </div>
          <DoltScrollArea ref="beforeScrollArea" class="min-h-0 flex-1" scroller-class="dolt-cell-diff-before-scroller" @scroll="syncScroll('before', $event)" @resize="onResize">
            <div class="dolt-cell-text-content" :style="textContentStyle">
              <div v-for="visible in visibleRows" :key="`before-${visible.index}`" class="dolt-cell-text-row" :class="rowClass(visible.row.kind, 'before')" :style="{ top: `${visible.index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }">
                <span class="dolt-cell-text-line-number">{{ visible.row.beforeLineNumber ?? "" }}</span>
                <code class="dolt-cell-text-code"
                  ><template v-for="(segment, index) in visible.row.beforeSegments" :key="index"
                    ><span :class="{ 'dolt-cell-text-segment-changed': segment.changed }">{{ segment.text }}</span></template
                  >&nbsp;</code
                >
              </div>
            </div>
          </DoltScrollArea>
        </section>

        <section class="flex min-w-0 min-h-0 flex-col">
          <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-2 text-[11px]">
            <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground" :title="toRevision">{{ toRevision }}</span>
            <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="doltCellCopyText(target, 'after') === null" :title="t('doltVersionControl.copyAfterValue')" @click="copyValue('after')"><Copy class="h-3 w-3" /></Button>
          </div>
          <DoltScrollArea ref="afterScrollArea" class="min-h-0 flex-1" scroller-class="dolt-cell-diff-after-scroller" @scroll="syncScroll('after', $event)" @resize="onResize">
            <div class="dolt-cell-text-content" :style="textContentStyle">
              <div v-for="visible in visibleRows" :key="`after-${visible.index}`" class="dolt-cell-text-row" :class="rowClass(visible.row.kind, 'after')" :style="{ top: `${visible.index * ROW_HEIGHT}px`, height: `${ROW_HEIGHT}px` }">
                <span class="dolt-cell-text-line-number">{{ visible.row.afterLineNumber ?? "" }}</span>
                <code class="dolt-cell-text-code"
                  ><template v-for="(segment, index) in visible.row.afterSegments" :key="index"
                    ><span :class="{ 'dolt-cell-text-segment-changed': segment.changed }">{{ segment.text }}</span></template
                  >&nbsp;</code
                >
              </div>
            </div>
          </DoltScrollArea>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.dolt-cell-text-content {
  position: relative;
  min-width: 100%;
  font-family: var(--font-mono);
  font-size: 12px;
}

.dolt-cell-text-row {
  position: absolute;
  left: 0;
  display: flex;
  width: 100%;
  min-width: 100%;
  align-items: center;
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  line-height: 21px;
}

.dolt-cell-text-line-number {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 48px;
  height: 100%;
  flex: 0 0 48px;
  border-right: 1px solid var(--border);
  background: var(--background);
  padding-right: 8px;
  text-align: right;
  color: var(--muted-foreground);
  user-select: none;
}

.dolt-cell-text-code {
  display: block;
  min-width: 0;
  padding: 0 8px;
  white-space: pre;
  font-family: inherit;
}

.dolt-cell-text-row-modified {
  background: rgb(217 119 6 / 0.11);
}

.dolt-cell-text-row-added {
  background: rgb(22 163 74 / 0.11);
}

.dolt-cell-text-row-removed {
  background: rgb(220 38 38 / 0.1);
}

.dolt-cell-text-row-modified .dolt-cell-text-segment-changed {
  background: rgb(217 119 6 / 0.32);
}
</style>
