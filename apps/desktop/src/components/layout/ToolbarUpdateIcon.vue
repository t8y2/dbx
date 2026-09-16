<script setup lang="ts">
import { CloudDownload } from "@lucide/vue";
// Background checking/downloading deliberately never animates the toolbar.
defineProps<{ loading?: boolean; downloading?: boolean; progress?: number | null }>();
</script>

<template>
  <span data-toolbar-update-icon class="relative block h-4 w-4" aria-hidden="true">
    <CloudDownload data-toolbar-update-idle class="h-4 w-4" />
  </span>
</template>
