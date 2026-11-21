<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    enabled?: boolean;
    intervalSeconds?: number;
    sweepKey?: number;
  }>(),
  { enabled: false, intervalSeconds: 10, sweepKey: 0 },
);

// One sweep == one refresh interval, so the hand reads as real progress toward
// the next tick without printing a digit that keeps changing under the user.
const sweepDuration = computed(() => `${Number.isFinite(props.intervalSeconds) && props.intervalSeconds > 0 ? props.intervalSeconds : 10}s`);
</script>

<template>
  <svg class="data-grid-auto-refresh-clock data-grid-topbar-action-icon h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <line x1="10" x2="14" y1="2" y2="2" />
    <circle cx="12" cy="14" r="8" />
    <line :key="enabled ? sweepKey : 'idle'" class="data-grid-auto-refresh-hand" :class="{ 'data-grid-auto-refresh-hand--sweeping': enabled }" data-auto-refresh-hand x1="12" x2="12" y1="14" y2="8" :style="{ '--dbx-auto-refresh-sweep-duration': sweepDuration }" />
  </svg>
</template>

<style scoped>
.data-grid-auto-refresh-hand {
  transform-box: view-box;
  transform-origin: 12px 14px;
}

.data-grid-auto-refresh-hand--sweeping {
  animation: data-grid-auto-refresh-sweep var(--dbx-auto-refresh-sweep-duration, 10s) linear;
}

@keyframes data-grid-auto-refresh-sweep {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .data-grid-auto-refresh-hand--sweeping {
    animation: none;
  }
}
</style>
