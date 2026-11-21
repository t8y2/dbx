<script setup lang="ts">
import { computed, ref } from "vue";
import { Check, Code2, Copy } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildGeometryRawView, buildYashanRawStruct } from "@/lib/dataGrid/geometryEwkb";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DatabaseType } from "@/types/database";

const props = withDefaults(
  defineProps<{
    value: unknown;
    srid?: number | null;
    databaseType?: DatabaseType;
    size?: "sm" | "xs";
  }>(),
  { srid: null, databaseType: undefined, size: "sm" },
);

const { t } = useI18n();
const open = ref(false);
const copied = ref<"struct" | "ewkt" | "hex" | null>(null);
const view = computed(() => buildGeometryRawView(props.value, props.srid));
const yashanRaw = computed(() => (props.databaseType === "yashandb" ? buildYashanRawStruct(props.value, props.srid) : null));

const MAX_HEX_PREVIEW = 120_000;
const displayedHex = computed(() => {
  const hex = view.value?.hex;
  if (!hex) return "";
  return hex.length > MAX_HEX_PREVIEW ? `${hex.slice(0, MAX_HEX_PREVIEW)}…` : hex;
});
const displayedStruct = computed(() => {
  const text = yashanRaw.value?.text;
  if (!text) return "";
  return text.length > MAX_HEX_PREVIEW ? `${text.slice(0, MAX_HEX_PREVIEW)}…` : text;
});

let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(kind: "struct" | "ewkt" | "hex", text: string | null | undefined) {
  if (!text) return;
  await copyToClipboard(text);
  copied.value = kind;
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => {
    copied.value = null;
  }, 1500);
}
</script>

<template>
  <Popover v-if="view" v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="icon" :class="size === 'xs' ? 'h-5 w-5' : 'h-6 w-6'" :title="t('grid.geometryRaw')">
        <Code2 class="h-3 w-3" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-[30rem] max-w-[calc(100vw-2rem)] p-0">
      <div class="flex items-center justify-between gap-3 border-b px-3 py-2">
        <span class="text-xs font-medium">{{ t("grid.geometryRawTitle") }}</span>
        <span v-if="view.srid" class="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">EPSG:{{ view.srid }}</span>
      </div>
      <div class="max-h-80 space-y-3 overflow-auto p-3">
        <section v-if="yashanRaw">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ t("grid.geometryRawStruct") }}</span>
            <Button variant="ghost" size="icon" class="h-5 w-5" :title="copied === 'struct' ? t('grid.geometryRawCopied') : t('grid.geometryRawCopy')" @click="copy('struct', yashanRaw.text)">
              <Check v-if="copied === 'struct'" class="h-3 w-3 text-emerald-600" />
              <Copy v-else class="h-3 w-3" />
            </Button>
          </div>
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{{ displayedStruct }}</pre>
          <p v-if="displayedStruct !== yashanRaw.text" class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.geometryRawTruncated") }}</p>
        </section>

        <section>
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {{ view.rawOnly ? t("grid.geometryRawHex") : "EWKT" }}
            </span>
            <Button variant="ghost" size="icon" class="h-5 w-5" :title="copied === 'ewkt' ? t('grid.geometryRawCopied') : t('grid.geometryRawCopy')" @click="copy('ewkt', view.ewkt)">
              <Check v-if="copied === 'ewkt'" class="h-3 w-3 text-emerald-600" />
              <Copy v-else class="h-3 w-3" />
            </Button>
          </div>
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{{ view.ewkt }}</pre>
        </section>

        <section v-if="view.hex && !view.rawOnly && !yashanRaw">
          <div class="mb-1 flex items-center justify-between">
            <span class="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{{ t("grid.geometryRawEwkb") }}</span>
            <Button variant="ghost" size="icon" class="h-5 w-5" :title="copied === 'hex' ? t('grid.geometryRawCopied') : t('grid.geometryRawCopy')" @click="copy('hex', view.hex)">
              <Check v-if="copied === 'hex'" class="h-3 w-3 text-emerald-600" />
              <Copy v-else class="h-3 w-3" />
            </Button>
          </div>
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/40 p-2 font-mono text-[11px] leading-relaxed">{{ displayedHex }}</pre>
          <p v-if="displayedHex !== view.hex" class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.geometryRawTruncated") }}</p>
        </section>

        <p v-if="view.tooLarge" class="text-[11px] text-amber-600">{{ t("grid.geometryRawTooLarge") }}</p>
      </div>
    </PopoverContent>
  </Popover>
</template>
