<script setup lang="ts">
import { computed } from "vue";
import { Cloud, CloudDownload } from "@lucide/vue";

const props = defineProps<{
  loading: boolean;
  /** Whether an update is downloading; takes precedence over `loading`. */
  downloading?: boolean;
  /** Download completion in 0..1, or null when the backend reports no total. */
  progress?: number | null;
}>();

const progressRingStyle = computed(() => {
  // Without a known total the ring cannot grow, so render a rotating partial arc
  // instead of an invisible 0% one.
  const percent = props.progress == null ? 25 : Math.round(Math.min(1, Math.max(0, props.progress)) * 100);
  return {
    background: `conic-gradient(var(--primary) ${percent}%, transparent ${percent}%)`,
  };
});
</script>

<template>
  <span data-toolbar-update-icon class="relative block h-4 w-4" :class="{ 'toolbar-update-icon--loading': loading }" aria-hidden="true">
    <span v-if="downloading" data-toolbar-update-progress class="toolbar-update-progress absolute inset-0 rounded-full" :class="{ 'toolbar-update-progress--indeterminate': progress == null }" :style="progressRingStyle" />
    <CloudDownload v-else-if="!loading" data-toolbar-update-idle class="toolbar-update-idle h-4 w-4" />
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

.toolbar-update-progress {
  /* Same 1.75px ring the toolbar previously drew inline for background downloads. */
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.75px), #000 calc(100% - 1.75px));
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.75px), #000 calc(100% - 1.75px));
}

.toolbar-update-progress--indeterminate {
  animation: toolbar-update-progress-spin 1100ms linear infinite;
}

@keyframes toolbar-update-outline-scan {
  to {
    stroke-dashoffset: -43;
  }
}

@keyframes toolbar-update-progress-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .toolbar-update-scan {
    animation: none;
    stroke-dasharray: none;
  }

  .toolbar-update-progress--indeterminate {
    animation: none;
  }
}
</style>
