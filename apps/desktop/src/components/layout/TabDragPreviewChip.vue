<script setup lang="ts">
import TabLabelContent from "./TabLabelContent.vue";
import type { TabDragAppearance } from "@/lib/tabs/tabDragAppearance";

defineProps<{
  appearance: TabDragAppearance;
}>();
</script>

<template>
  <div class="tab-drag-preview pointer-events-none select-none" aria-hidden="true" :style="{ ...appearance.style, position: 'relative', boxSizing: 'border-box', flex: 'none', width: `${appearance.width}px`, height: `${appearance.height}px` }">
    <TabLabelContent :preview="appearance" />
  </div>
</template>
