<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Lock, Unlock } from "@lucide/vue";
import type { DiagramLayer } from "@/types/diagram";

defineProps<{
  data: {
    layer: DiagramLayer;
  };
}>();

const { t } = useI18n();

function isLocked(layer: DiagramLayer): boolean {
  return (layer.layoutMode ?? "auto") === "free";
}
</script>

<template>
  <div
    class="relative rounded-lg border-2 bg-background/40 box-border pointer-events-none overflow-hidden"
    :style="{
      borderColor: data.layer.color,
      width: '100%',
      height: '100%',
    }"
  >
    <div class="layer-drag-handle absolute top-0 left-0 right-0 h-10 flex items-center gap-2 px-4 rounded-t-lg cursor-grab active:cursor-grabbing pointer-events-auto" :style="{ backgroundColor: data.layer.color + '33' }">
      <span class="text-sm font-semibold truncate" :style="{ color: data.layer.color }">
        {{ data.layer.name }}
      </span>
      <span class="ml-auto shrink-0 flex items-center gap-1 text-[10px] font-normal opacity-70" :title="isLocked(data.layer) ? t('diagram.layerLocked') : t('diagram.layerUnlocked')">
        <Lock v-if="isLocked(data.layer)" class="h-3 w-3" :style="{ color: data.layer.color }" />
        <Unlock v-else class="h-3 w-3" :style="{ color: data.layer.color }" />
      </span>
    </div>
  </div>
</template>
