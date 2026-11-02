<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { Button } from "@/components/ui/button";
import {
  BINARY_CELL_TRANSFORM_KINDS,
  CELL_TRANSFORM_FORMAT_CHOICES,
  CELL_TRANSFORM_KINDS,
  CELL_TRANSFORM_MAX_BINARY_INPUT,
  CELL_TRANSFORM_MAX_INPUT,
  CELL_TRANSFORM_MAX_OUTPUT,
  CELL_TRANSFORM_MAX_RADIX_DIGITS,
  transformCellValue,
  type CellTransformBinaryResult,
  type CellTransformKind,
  type CellTransformResult,
} from "@/lib/dataGrid/cellValueTransform";
import { binaryCellDownloadFileName, downloadBinaryCellPayload, formatBinaryCellByteSize } from "@/lib/dataGrid/binaryCellDownload";
import { DataGridDateTimePatterns, getSupportedTimeZoneOptions } from "@/lib/dataGrid/columnFormatter";
import { buildSafeHtmlPreview } from "@/lib/common/safeHtmlPreview";

const props = defineProps<{
  source: string | null;
  identity: string;
  incomplete?: boolean;
  unsafeNumber?: boolean;
  column?: string;
  rowNumber?: number;
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
const formatOverride = ref("");

const isBinaryKind = computed(() => BINARY_CELL_TRANSFORM_KINDS.includes(kind.value));
const inputLimit = computed(() => (isBinaryKind.value ? CELL_TRANSFORM_MAX_BINARY_INPUT : CELL_TRANSFORM_MAX_INPUT));

const blockedReason = computed(() => {
  if (props.source === null) return "nullSource";
  if (props.incomplete) return "incomplete";
  if (props.unsafeNumber) return "unsafeNumber";
  if (props.source.length > inputLimit.value) return "tooLarge";
  return "";
});

// Locale messages only interpolate the grouped limit digits, so translations keep their wording.
const errorLimits = computed(() => ({
  maxInput: new Intl.NumberFormat("en-US").format(inputLimit.value),
  maxOutput: new Intl.NumberFormat("en-US").format(CELL_TRANSFORM_MAX_OUTPUT),
  maxRadixDigits: new Intl.NumberFormat("en-US").format(CELL_TRANSFORM_MAX_RADIX_DIGITS),
}));

// Keep only options between cells. Results must always belong to the current source.
watch(
  () => props.identity,
  () => {
    open.value = false;
    result.value = null;
    formatOverride.value = "";
  },
  { flush: "sync" },
);
watch(
  [() => props.source, () => props.incomplete, () => props.unsafeNumber, kind, unit, timezone, pattern, fromBase, toBase, open],
  () => {
    result.value = null;
    formatOverride.value = "";
  },
  { flush: "sync" },
);

// Binary kinds decode to bytes, so the UTF-8-text wording of invalidBase64 does not apply.
const resultErrorKey = computed(() => {
  if (!result.value || result.value.ok) return "";
  return result.value.error === "invalidBase64" && isBinaryKind.value ? "invalidBase64Binary" : result.value.error;
});

function convert() {
  if (blockedReason.value || props.source === null) return;
  result.value = transformCellValue(props.source, { kind: kind.value, unit: unit.value, timezone: timezone.value, pattern: pattern.value, fromBase: fromBase.value, toBase: toBase.value });
}

const textResult = computed(() => (result.value?.ok && "text" in result.value ? result.value.text : null));
const binaryResult = computed<CellTransformBinaryResult | null>(() => (result.value?.ok && "binary" in result.value ? result.value.binary : null));

// When auto-detection fails the user picks a format; apply it to preview, label, and save alike.
const effectiveBinary = computed<CellTransformBinaryResult | null>(() => {
  const binary = binaryResult.value;
  if (!binary) return null;
  if (binary.recognized || !formatOverride.value) return binary;
  const choice = CELL_TRANSFORM_FORMAT_CHOICES.find((format) => format.mimeType === formatOverride.value);
  if (!choice) return binary;
  return { ...binary, mimeType: choice.mimeType, extension: choice.extension, isImage: choice.mimeType.startsWith("image/") };
});

const imageUrl = ref<string | null>(null);
function releaseImageUrl() {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
  imageUrl.value = null;
}
watch(
  [effectiveBinary, open],
  ([binary, isOpen]) => {
    releaseImageUrl();
    if (isOpen && binary?.isImage) imageUrl.value = URL.createObjectURL(new Blob([new Uint8Array(binary.bytes)], { type: binary.mimeType }));
  },
  { flush: "sync" },
);
onBeforeUnmount(releaseImageUrl);

const htmlPreviewDocument = computed(() => (kind.value === "html" && textResult.value !== null ? buildSafeHtmlPreview(textResult.value) : ""));
const binarySizeText = computed(() => (binaryResult.value ? formatBinaryCellByteSize(binaryResult.value.bytes.length) : ""));

async function copyResult() {
  if (textResult.value === null) return;
  try {
    await copyToClipboard(textResult.value);
    toast(t("grid.cellValueCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function saveResult() {
  const binary = effectiveBinary.value;
  if (!binary) return;
  const fileName = binaryCellDownloadFileName({ column: props.column ?? "cell", rowNumber: props.rowNumber ?? 0, mode: "binary", extension: binary.extension });
  try {
    const saved = await downloadBinaryCellPayload({ data: binary.bytes, mimeType: binary.mimeType, extension: binary.extension }, fileName);
    if (saved.kind === "saved" && saved.path) toast(t("grid.downloadSaved", { path: saved.path }));
    else if (saved.kind === "browser-download") toast(t("grid.downloadStarted", { fileName: saved.fileName ?? fileName }));
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}
</script>

<template>
  <Button v-if="!open" variant="outline" size="sm" class="h-6 px-2 text-xs" @mousedown.prevent @click="open = true">{{ t("cellTransform.title") }}</Button>
  <section v-else data-native-clipboard class="basis-full min-w-0 space-y-2 rounded border bg-muted/20 p-2 text-xs">
    <div class="flex min-h-5 items-center justify-between gap-2">
      <div class="min-w-0 truncate font-medium">{{ t("cellTransform.title") }}</div>
      <Button variant="ghost" size="icon" class="h-5 w-5 shrink-0" :title="t('cellTransform.exitPreview')" @mousedown.prevent @click="open = false"><X class="h-3 w-3" /></Button>
    </div>
    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <div class="text-muted-foreground">{{ t("cellTransform.sourceValue") }}</div>
        <textarea :value="source ?? ''" :aria-label="t('cellTransform.sourceValue')" readonly class="dbx-data-grid-value-font h-72 min-h-24 w-full resize-y rounded border bg-background p-2" spellcheck="false" />
      </div>
      <div class="flex min-w-0 flex-col gap-2">
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex min-w-0 basis-full flex-col gap-1">
            {{ t("cellTransform.format") }}
            <select v-model="kind" class="h-7 w-full rounded border bg-background px-2">
              <option v-for="item in CELL_TRANSFORM_KINDS" :key="item" :value="item">{{ t(`cellTransform.kinds.${item}`) }}</option>
            </select>
          </label>
          <template v-if="kind === 'timestamp'">
            <label class="flex flex-col gap-1">
              {{ t("cellTransform.unit") }}
              <select v-model="unit" class="h-7 rounded border bg-background px-2">
                <option v-for="item in ['auto', 'seconds', 'milliseconds']" :key="item" :value="item">{{ t(`cellTransform.units.${item}`) }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              {{ t("cellTransform.timezone") }}
              <input v-model="timezone" :list="`${id}-zones`" class="h-7 w-28 rounded border bg-background px-2" />
              <datalist :id="`${id}-zones`"><option v-for="zone in zones" :key="zone" :value="zone" /></datalist>
            </label>
            <label class="flex min-w-0 flex-col gap-1">
              {{ t("cellTransform.pattern") }}
              <select v-model="pattern" class="h-7 max-w-full rounded border bg-background px-2">
                <option v-for="item in DataGridDateTimePatterns" :key="item" :value="item">{{ item }}</option>
              </select>
            </label>
          </template>
          <template v-if="kind === 'radix'">
            <label class="flex flex-col gap-1">
              {{ t("cellTransform.fromBase") }}
              <select v-model="fromBase" class="h-7 rounded border bg-background px-2">
                <option v-for="base in [2, 8, 10, 16]" :key="base" :value="base">{{ base }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1">
              {{ t("cellTransform.toBase") }}
              <select v-model="toBase" class="h-7 rounded border bg-background px-2">
                <option v-for="base in [2, 8, 10, 16]" :key="base" :value="base">{{ base }}</option>
              </select>
            </label>
          </template>
          <Button size="sm" class="h-7" :disabled="!!blockedReason" @click="convert">{{ t("cellTransform.convert") }}</Button>
        </div>
        <p v-if="kind === 'radix'" class="text-xs text-muted-foreground">{{ t("cellTransform.radixHint") }}</p>
        <p v-if="kind === 'urlEncode' || kind === 'urlDecode'" class="text-xs text-muted-foreground">{{ t("cellTransform.urlHint") }}</p>
        <p v-if="kind === 'base64File'" class="text-xs text-muted-foreground">{{ t("cellTransform.fileHint") }}</p>
        <p v-if="blockedReason" role="status" class="text-xs text-muted-foreground">{{ t(`cellTransform.errors.${blockedReason}`, errorLimits) }}</p>
        <p v-else-if="result && !result.ok" role="alert" class="text-xs text-destructive">{{ t(`cellTransform.errors.${resultErrorKey}`, errorLimits) }}</p>
        <template v-if="textResult !== null">
          <div class="flex items-center justify-between gap-2 text-xs">
            <span
              >{{ t("cellTransform.result") }}<template v-if="result?.ok && 'unit' in result && result.unit"> · {{ t(`cellTransform.units.${result.unit}`) }}</template></span
            >
            <Button variant="outline" size="sm" class="h-6 text-xs" @click="copyResult">{{ t("cellTransform.copy") }}</Button>
          </div>
          <iframe v-if="kind === 'html'" :srcdoc="htmlPreviewDocument" sandbox="" :title="t('cellTransform.htmlPreview')" class="h-56 min-h-24 w-full rounded border bg-white" />
          <textarea :value="textResult" :aria-label="t('cellTransform.result')" readonly class="dbx-data-grid-value-font h-56 min-h-24 w-full resize-y rounded border bg-background p-2 text-xs" spellcheck="false" />
        </template>
        <template v-else-if="binaryResult && effectiveBinary">
          <div v-if="!binaryResult.recognized" class="flex flex-col gap-1">
            <p class="text-xs text-muted-foreground">{{ t("cellTransform.unrecognizedHint") }}</p>
            <label class="flex flex-col gap-1">
              {{ t("cellTransform.pickFormat") }}
              <select v-model="formatOverride" class="h-7 w-full rounded border bg-background px-2">
                <option value="">{{ t("cellTransform.pickFormatPlaceholder") }}</option>
                <option v-for="format in CELL_TRANSFORM_FORMAT_CHOICES" :key="format.mimeType" :value="format.mimeType">{{ format.extension.toUpperCase() }} · {{ format.mimeType }}</option>
              </select>
            </label>
          </div>
          <div class="flex items-center justify-between gap-2 text-xs">
            <span class="min-w-0 truncate">{{ effectiveBinary.extension.toUpperCase() }} · {{ binarySizeText }}</span>
            <Button variant="outline" size="sm" class="h-6 shrink-0 text-xs" @click="saveResult">{{ t("cellTransform.save") }}</Button>
          </div>
          <img v-if="imageUrl" :src="imageUrl" :alt="t('grid.imagePreview')" loading="lazy" decoding="async" class="max-h-56 min-h-16 w-full rounded border bg-white object-contain" />
        </template>
      </div>
    </div>
  </section>
</template>
