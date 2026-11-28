<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import ConnectionWatermark from "@/components/common/ConnectionWatermark.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CONNECTION_WATERMARK_MAX_FONT_SIZE, CONNECTION_WATERMARK_MAX_TEXT_LENGTH, CONNECTION_WATERMARK_MIN_FONT_SIZE, resolveConnectionWatermark } from "@/lib/connection/connectionWatermark";
import type { ConnectionWatermarkConfig, ConnectionWatermarkMode } from "@/types/database";

const props = defineProps<{ connectionName: string }>();
const watermark = defineModel<ConnectionWatermarkConfig>();
const { t } = useI18n();
const id = useId();
const mode = computed(() => watermark.value?.mode ?? "auto");
const preview = computed(() => resolveConnectionWatermark({ name: props.connectionName, watermark: watermark.value }, false));

function updateMode(mode: ConnectionWatermarkMode) {
  watermark.value = { ...watermark.value, mode };
}

function updateCustom(patch: Partial<Omit<ConnectionWatermarkConfig, "mode">>) {
  watermark.value = { ...watermark.value, ...patch, mode: "custom" };
}
</script>

<template>
  <section class="connection-advanced-section grid content-start gap-3 rounded-lg border p-4" :aria-labelledby="`${id}-title`">
    <h3 :id="`${id}-title`" class="text-base font-bold">{{ t("connection.watermark") }}</h3>
    <div class="grid grid-cols-4 items-center gap-x-4 gap-y-1.5">
      <Label :for="`${id}-mode`" class="justify-self-end text-right">{{ t("connection.watermarkMode") }}</Label>
      <Select :model-value="mode" @update:model-value="updateMode($event as ConnectionWatermarkMode)">
        <SelectTrigger :id="`${id}-mode`" class="col-span-3 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{{ t("connection.watermarkAuto") }}</SelectItem>
          <SelectItem value="custom">{{ t("connection.watermarkCustom") }}</SelectItem>
          <SelectItem value="off">{{ t("connection.watermarkOff") }}</SelectItem>
        </SelectContent>
      </Select>
      <p v-if="mode === 'auto'" class="col-span-3 col-start-2 text-xs leading-5 text-muted-foreground">{{ t("connection.watermarkAutoHint") }}</p>
    </div>
    <template v-if="mode === 'custom' && preview">
      <div class="grid grid-cols-4 items-center gap-x-4 gap-y-3">
        <Label :for="`${id}-text`" class="justify-self-end text-right">{{ t("connection.watermarkText") }}</Label>
        <Input :id="`${id}-text`" class="col-span-3" :maxlength="CONNECTION_WATERMARK_MAX_TEXT_LENGTH" :model-value="watermark?.text ?? ''" :placeholder="connectionName.trim() || t('connection.name')" @update:model-value="updateCustom({ text: String($event) })" />
        <Label :for="`${id}-size`" class="justify-self-end text-right">{{ t("connection.watermarkFontSize") }}</Label>
        <div class="col-span-3 flex items-center gap-3">
          <input :id="`${id}-size`" type="range" class="min-w-0 flex-1 accent-primary" :min="CONNECTION_WATERMARK_MIN_FONT_SIZE" :max="CONNECTION_WATERMARK_MAX_FONT_SIZE" :value="preview.fontSize" @input="updateCustom({ font_size: ($event.target as HTMLInputElement).valueAsNumber })" />
          <span class="w-12 text-right text-sm tabular-nums text-muted-foreground">{{ preview.fontSize }} px</span>
        </div>
        <Label :for="`${id}-color`" class="justify-self-end text-right">{{ t("connection.color") }}</Label>
        <div class="col-span-3 flex items-center gap-3">
          <Input :id="`${id}-color`" type="color" class="w-14 cursor-pointer px-1 py-0.5" :model-value="preview.color" @update:model-value="updateCustom({ color: String($event) })" />
          <span class="font-mono text-sm text-muted-foreground">{{ preview.color }}</span>
        </div>
      </div>
      <figure v-if="preview.text" class="grid gap-1.5">
        <figcaption class="text-xs text-muted-foreground">{{ t("connection.watermarkPreview") }}</figcaption>
        <div class="relative h-44 overflow-hidden rounded-md border bg-background">
          <ConnectionWatermark v-bind="preview" />
        </div>
      </figure>
    </template>
  </section>
</template>
