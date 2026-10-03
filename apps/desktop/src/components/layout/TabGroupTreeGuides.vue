<script setup lang="ts">
import type { TabGroupTreeGuide } from "@/lib/tabs/tabGroupTree";

withDefaults(
  defineProps<{
    guides: TabGroupTreeGuide[];
    expanded?: boolean;
  }>(),
  { expanded: true },
);
</script>

<template>
  <span class="tab-tree-guides" aria-hidden="true">
    <template v-for="guide in guides" :key="guide.depth">
      <span v-if="guide.kind !== 'start' || expanded" class="tab-tree-guide" :class="`tab-tree-guide--${guide.kind}`" :data-depth="guide.depth" :style="{ '--tab-tree-guide-depth': guide.depth }" />
    </template>
  </span>
</template>
