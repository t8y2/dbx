<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CELL_TRANSFORM_KINDS, CELL_TRANSFORM_MAX_INPUT, CELL_TRANSFORM_MAX_OUTPUT, CELL_TRANSFORM_MAX_RADIX_DIGITS, transformCellValue, type CellTransformKind, type CellTransformResult } from "@/lib/dataGrid/cellValueTransform";
import { DataGridDateTimePatterns, getSupportedTimeZoneOptions } from "@/lib/dataGrid/columnFormatter";

const props = defineProps<{
  source: string | null;
  identity: string;
  incomplete?: boolean;
  unsafeNumber?: boolean;
}>();
const { t } = useI18n();
const { toast } = useToast();
const id = useId();
const open = defineModel<boolean>("open", { default: false });
const kind = ref<CellTransformKind>("timestamp");
const unit = ref<"auto" | "seconds" | "milliseconds">("auto");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const zones = [...new Set(["UTC", timezone.value, ...getSupportedTimeZoneOptions(Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }, timezone.value)])];
const pattern = ref("YYYY-MM-DD HH:mm:ss");
const fromBase = ref(10);
const toBase = ref(16);
const result = ref<CellTransformResult | null>(null);
let previousEditorFocus: HTMLElement | null = null;
let previousEditorIdentity = "";

function rememberEditorFocus() {
  const active = document.activeElement;
  previousEditorFocus = active instanceof HTMLElement && active.closest("[data-cell-detail-editor-root]") ? active : null;
  previousEditorIdentity = props.identity;
}

function restoreEditorFocus(event: Event) {
  const target = previousEditorFocus;
  previousEditorFocus = null;
  if (!target?.isConnected || previousEditorIdentity !== props.identity) return;
  // Opening the preview skips the editor's blur commit. Restore its focus so
  // the next deliberate departure still commits the untouched editing draft.
  event.preventDefault();
  target.focus({ preventScroll: true });
}

const blockedReason = computed(() => {
  if (props.source === null) return "nullSource";
  if (props.incomplete) return "incomplete";
  if (props.unsafeNumber) return "unsafeNumber";
  if (props.source.length > CELL_TRANSFORM_MAX_INPUT) return "tooLarge";
  return "";
});

// Locale messages only interpolate the grouped limit digits, so translations keep their wording.
const errorLimits = {
  maxInput: new Intl.NumberFormat("en-US").format(CELL_TRANSFORM_MAX_INPUT),
  maxOutput: new Intl.NumberFormat("en-US").format(CELL_TRANSFORM_MAX_OUTPUT),
  maxRadixDigits: new Intl.NumberFormat("en-US").format(CELL_TRANSFORM_MAX_RADIX_DIGITS),
};

// Keep only options between cells. Results must always belong to the current source.
watch(
  () => props.identity,
  () => {
    open.value = false;
    result.value = null;
  },
  { flush: "sync" },
);
watch(
  [() => props.source, () => props.incomplete, () => props.unsafeNumber, kind, unit, timezone, pattern, fromBase, toBase, open],
  () => {
    result.value = null;
  },
  { flush: "sync" },
);

function convert() {
  if (blockedReason.value || props.source === null) return;
  result.value = transformCellValue(props.source, { kind: kind.value, unit: unit.value, timezone: timezone.value, pattern: pattern.value, fromBase: fromBase.value, toBase: toBase.value });
}
async function copyResult() {
  if (!result.value?.ok) return;
  try {
    await copyToClipboard(result.value.text);
    toast(t("grid.cellValueCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogTrigger as-child>
      <Button variant="outline" size="sm" class="h-6 px-2 text-xs" @mousedown.prevent>{{ t("cellTransform.title") }}</Button>
    </DialogTrigger>
    <DialogContent class="flex max-h-[85vh] flex-col overflow-y-auto sm:max-w-2xl" data-native-clipboard @open-auto-focus="rememberEditorFocus" @close-auto-focus="restoreEditorFocus">
      <DialogHeader>
        <DialogTitle>{{ t("cellTransform.title") }}</DialogTitle>
        <DialogDescription>{{ t("cellTransform.description") }}</DialogDescription>
      </DialogHeader>
      <div class="flex flex-wrap items-end gap-3 text-xs">
        <label class="flex flex-col gap-1">
          {{ t("cellTransform.format") }}
          <select v-model="kind" class="h-8 rounded border bg-background px-2">
            <option v-for="item in CELL_TRANSFORM_KINDS" :key="item" :value="item">{{ t(`cellTransform.kinds.${item}`) }}</option>
          </select>
        </label>
        <template v-if="kind === 'timestamp'">
          <label class="flex flex-col gap-1">
            {{ t("cellTransform.unit") }}
            <select v-model="unit" class="h-8 rounded border bg-background px-2">
              <option v-for="item in ['auto', 'seconds', 'milliseconds']" :key="item" :value="item">{{ t(`cellTransform.units.${item}`) }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            {{ t("cellTransform.timezone") }}
            <input v-model="timezone" :list="`${id}-zones`" class="h-8 rounded border bg-background px-2" />
            <datalist :id="`${id}-zones`"><option v-for="zone in zones" :key="zone" :value="zone" /></datalist>
          </label>
          <label class="flex min-w-0 flex-col gap-1">
            {{ t("cellTransform.pattern") }}
            <select v-model="pattern" class="h-8 max-w-full rounded border bg-background px-2">
              <option v-for="item in DataGridDateTimePatterns" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
        </template>
        <template v-if="kind === 'radix'">
          <label class="flex flex-col gap-1">
            {{ t("cellTransform.fromBase") }}
            <select v-model="fromBase" class="h-8 rounded border bg-background px-2">
              <option v-for="base in [2, 8, 10, 16]" :key="base" :value="base">{{ base }}</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            {{ t("cellTransform.toBase") }}
            <select v-model="toBase" class="h-8 rounded border bg-background px-2">
              <option v-for="base in [2, 8, 10, 16]" :key="base" :value="base">{{ base }}</option>
            </select>
          </label>
        </template>
        <Button size="sm" class="h-8" :disabled="!!blockedReason" @click="convert">{{ t("cellTransform.convert") }}</Button>
      </div>
      <p v-if="kind === 'radix'" class="text-xs text-muted-foreground">{{ t("cellTransform.radixHint") }}</p>
      <p v-if="kind === 'urlEncode' || kind === 'urlDecode'" class="text-xs text-muted-foreground">{{ t("cellTransform.urlHint") }}</p>
      <p v-if="blockedReason" role="status" class="text-xs text-muted-foreground">{{ t(`cellTransform.errors.${blockedReason}`, errorLimits) }}</p>
      <p v-else-if="result && !result.ok" role="alert" class="text-xs text-destructive">{{ t(`cellTransform.errors.${result.error}`, errorLimits) }}</p>
      <template v-if="result?.ok">
        <div class="flex items-center justify-between gap-2 text-xs">
          <span
            >{{ t("cellTransform.result") }}<template v-if="result.unit"> · {{ t(`cellTransform.units.${result.unit}`) }}</template></span
          >
          <Button variant="outline" size="sm" class="h-6 text-xs" @click="copyResult">{{ t("cellTransform.copy") }}</Button>
        </div>
        <textarea :value="result.text" :aria-label="t('cellTransform.result')" readonly class="dbx-data-grid-value-font h-64 min-h-24 w-full resize-y rounded border bg-muted/20 p-3 text-xs" spellcheck="false" />
      </template>
    </DialogContent>
  </Dialog>
</template>
