<script setup lang="ts">
import { Cloud, CloudDownload } from "@lucide/vue";

defineProps<{
  loading: boolean;
}>();
</script>

<template>
  <span data-toolbar-update-icon class="relative block h-4 w-4" :class="{ 'toolbar-update-icon--loading': loading }" aria-hidden="true">
    <CloudDownload v-if="!loading" data-toolbar-update-idle class="toolbar-update-idle h-4 w-4" />
    <template v-else>
      <Cloud data-toolbar-update-cloud class="toolbar-update-cloud absolute inset-0 h-4 w-4" />
      <Cloud data-toolbar-update-scan class="toolbar-update-scan absolute inset-0 h-4 w-4" />
    </template>
  </span>
</template>

<style scoped>
.toolbar-update-cloud {
  opacity: 0.38;
}

.toolbar-update-scan {
  color: #000;
  stroke-dasharray: 7 36;
  stroke-dashoffset: 0;
  animation: toolbar-update-outline-scan 1100ms linear infinite;
}

:global(.dark) .toolbar-update-scan {
  color: #fff;
}

@keyframes toolbar-update-outline-scan {
  to {
    stroke-dashoffset: -43;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toolbar-update-scan {
    animation: none;
    stroke-dasharray: none;
  }
}
</style>
