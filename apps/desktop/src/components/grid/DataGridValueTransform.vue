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
import { decodeSqlPluginValue, sqlPluginCodecInput, sqlPluginDecodedText, type PluginDecodeRequest } from "@/lib/dataGrid/sqlPluginCodec";
import { useSqlPluginCodecs } from "@/composables/useSqlPluginCodecs";
import * as api from "@/lib/backend/api";
import type { DatabaseType } from "@/types/database";

type TransformKind = CellTransformKind | "plugin";

const props = defineProps<{
  source: string | null;
  identity: string;
  incomplete?: boolean;
  unsafeNumber?: boolean;
  column?: string;
  rowNumber?: number;
  columnType?: string;
  databaseType?: DatabaseType;
  /** Binary cells only offer plugin decoding; built-in kinds work on text. */
  pluginOnly?: boolean;
  /** Set by the cell context menu to open this cell's panel on plugin decoding. */
  pluginDecodeRequest?: PluginDecodeRequest | null;
}>();
const { t } = useI18n();
const { toast } = useToast();
const id = useId();
const open = defineModel<boolean>("open", { default: false });
const kind = ref<TransformKind>(props.pluginOnly ? "plugin" : "timestamp");
const { codecs: pluginCodecs } = useSqlPluginCodecs();
const pluginCodecKey = ref("");
const pluginLoading = ref(false);
const pluginText = ref<string | null>(null);
const pluginError = ref("");
let pluginRevision = 0;
const unit = ref<"auto" | "seconds" | "milliseconds">("auto");
const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
const zones = [...new Set(["UTC", timezone.value, ...getSupportedTimeZoneOptions(Intl as unknown as { supportedValuesOf?: (key: "timeZone") => string[] }, timezone.value)])];
const pattern = ref("YYYY-MM-DD HH:mm:ss");
const fromBase = ref(10);
const toBase = ref(16);
const result = ref<CellTransformResult | null>(null);
const formatOverride = ref("");

const isPluginKind = computed(() => kind.value === "plugin");
const isBinaryKind = computed(() => kind.value !== "plugin" && BINARY_CELL_TRANSFORM_KINDS.includes(kind.value));
const inputLimit = computed(() => (isBinaryKind.value ? CELL_TRANSFORM_MAX_BINARY_INPUT : CELL_TRANSFORM_MAX_INPUT));
const selectedPluginCodec = computed(() => pluginCodecs.value.find((codec) => codec.key === pluginCodecKey.value) ?? null);
// The plugin option only appears once a codec is installed, so nothing changes without one.
const showPluginKind = computed(() => props.pluginOnly || pluginCodecs.value.length > 0);
const pluginInput = computed(() => sqlPluginCodecInput(props.source, { columnType: props.columnType, databaseType: props.databaseType, incomplete: props.incomplete }));

const blockedReason = computed(() => {
  if (isPluginKind.value) {
    if (pluginInput.value.ok) return selectedPluginCodec.value ? "" : "pluginNoCodec";
    return { nullValue: "nullSource", incomplete: "incomplete", tooLarge: "pluginTooLarge", undecodableBinary: "pluginUndecodableBinary" }[pluginInput.value.reason];
  }
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

function clearPluginResult() {
  pluginRevision++;
  pluginLoading.value = false;
  pluginText.value = null;
  pluginError.value = "";
}

// Keep only options between cells. Results must always belong to the current source.
watch(
  () => props.identity,
  () => {
    open.value = false;
    result.value = null;
    formatOverride.value = "";
    clearPluginResult();
  },
  { flush: "sync" },
);
watch(
  [() => props.source, () => props.incomplete, () => props.unsafeNumber, () => props.columnType, kind, unit, timezone, pattern, fromBase, toBase, pluginCodecKey, open],
  () => {
    result.value = null;
    formatOverride.value = "";
    clearPluginResult();
  },
  { flush: "sync" },
);
// Immediate: the context menu opens the dialog and this panel in the same tick.
watch(
  () => props.pluginDecodeRequest,
  (request) => {
    if (!request || request.identity !== props.identity) return;
    kind.value = "plugin";
    open.value = true;
  },
  { immediate: true },
);
// Preselect the only codec; with several the user must choose, so no value is sent by default.
watch(
  pluginCodecs,
  (codecs) => {
    if (!codecs.some((codec) => codec.key === pluginCodecKey.value)) pluginCodecKey.value = codecs.length === 1 ? codecs[0].key : "";
  },
  { immediate: true },
);

// Binary kinds decode to bytes, so the UTF-8-text wording of invalidBase64 does not apply.
const resultErrorKey = computed(() => {
  if (!result.value || result.value.ok) return "";
  return result.value.error === "invalidBase64" && isBinaryKind.value ? "invalidBase64Binary" : result.value.error;
});

// Only the current cell's bytes and column facts cross the plugin boundary, and only on this explicit click.
async function decodeWithPlugin() {
  const codec = selectedPluginCodec.value;
  const input = pluginInput.value;
  if (!codec || !input.ok) return;
  clearPluginResult();
  const revision = pluginRevision;
  pluginLoading.value = true;
  try {
    const decoded = await decodeSqlPluginValue(api.invokePlugin, codec, input.rawBase64, { dbType: props.databaseType, columnName: props.column, columnType: props.columnType });
    if (revision === pluginRevision) pluginText.value = sqlPluginDecodedText(decoded);
  } catch (error) {
    if (revision === pluginRevision) pluginError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (revision === pluginRevision) pluginLoading.value = false;
  }
}

function convert() {
  if (blockedReason.value || props.source === null) return;
  if (kind.value === "plugin") {
    void decodeWithPlugin();
    return;
  }
  result.value = transformCellValue(props.source, { kind: kind.value, unit: unit.value, timezone: timezone.value, pattern: pattern.value, fromBase: fromBase.value, toBase: toBase.value });
}

const textResult = computed(() => {
  if (isPluginKind.value) return pluginText.value;
  return result.value?.ok && "text" in result.value ? result.value.text : null;
});
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
  <template v-if="!pluginOnly || pluginCodecs.length > 0">
    <Button v-if="!open" variant="outline" size="sm" class="h-6 px-2 text-xs" @mousedown.prevent @click="open = true">{{ pluginOnly ? t("cellTransform.kinds.plugin") : t("cellTransform.title") }}</Button>
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
              <select v-model="kind" class="h-7 w-full rounded border bg-background px-2" data-cell-transform-kind>
                <template v-if="!pluginOnly">
                  <option v-for="item in CELL_TRANSFORM_KINDS" :key="item" :value="item">{{ t(`cellTransform.kinds.${item}`) }}</option>
                </template>
                <option v-if="showPluginKind" value="plugin">{{ t("cellTransform.kinds.plugin") }}</option>
              </select>
            </label>
            <!-- A single installed codec is used directly; the choice only appears once there are several. -->
            <label v-if="kind === 'plugin' && pluginCodecs.length > 1" class="flex min-w-0 basis-full flex-col gap-1">
              {{ t("cellTransform.pluginCodec") }}
              <select v-model="pluginCodecKey" class="h-7 w-full rounded border bg-background px-2" data-cell-transform-plugin-codec>
                <option value="">{{ t("cellTransform.pluginCodecPlaceholder") }}</option>
                <option v-for="codec in pluginCodecs" :key="codec.key" :value="codec.key">{{ codec.label }}</option>
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
            <Button size="sm" class="h-7" :disabled="!!blockedReason || pluginLoading" @click="convert">{{ t("cellTransform.convert") }}</Button>
          </div>
          <p v-if="kind === 'plugin'" class="text-xs text-muted-foreground">{{ t("cellTransform.pluginHint") }}</p>
          <p v-if="kind === 'radix'" class="text-xs text-muted-foreground">{{ t("cellTransform.radixHint") }}</p>
          <p v-if="kind === 'urlEncode' || kind === 'urlDecode'" class="text-xs text-muted-foreground">{{ t("cellTransform.urlHint") }}</p>
          <p v-if="kind === 'base64File'" class="text-xs text-muted-foreground">{{ t("cellTransform.fileHint") }}</p>
          <p v-if="blockedReason" role="status" class="text-xs text-muted-foreground">{{ t(`cellTransform.errors.${blockedReason}`, errorLimits) }}</p>
          <p v-else-if="isPluginKind && pluginLoading" role="status" class="text-xs text-muted-foreground">{{ t("cellTransform.pluginDecoding") }}</p>
          <p v-else-if="isPluginKind && pluginError" role="alert" class="whitespace-pre-wrap break-words text-xs text-destructive">{{ t("cellTransform.errors.pluginFailed", { message: pluginError }) }}</p>
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
</template>
