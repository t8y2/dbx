<script setup lang="ts">
import { ref } from "vue";
import { LocateFixed } from "@lucide/vue";

defineProps<{
  label: string;
}>();

const emit = defineEmits<{
  locate: [];
}>();

const animationId = ref(0);

function locate() {
  animationId.value += 1;
  emit("locate");
}
</script>

<template>
  <button type="button" data-sidebar-locate-button class="sidebar-locate-button relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="label" @click="locate">
    <LocateFixed :key="`locate-icon-${animationId}`" class="h-3.5 w-3.5" :class="{ 'sidebar-locate-icon--active': animationId > 0 }" />
    <span v-if="animationId > 0" :key="`locate-pulse-${animationId}`" data-sidebar-locate-pulse class="sidebar-locate-pulse pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full border border-primary" aria-hidden="true" />
  </button>
</template>

<style scoped>
.sidebar-locate-button:active {
  transform: scale(0.94);
}

.sidebar-locate-icon--active {
  animation: sidebar-locate-settle 420ms cubic-bezier(0.2, 0.85, 0.25, 1);
}

.sidebar-locate-pulse {
  animation: sidebar-locate-pulse 440ms ease-out both;
}

@keyframes sidebar-locate-settle {
  0% {
    transform: rotate(-18deg) scale(0.78);
  }
  58% {
    transform: rotate(5deg) scale(1.12);
    color: var(--primary);
  }
  100% {
    transform: rotate(0) scale(1);
  }
}

@keyframes sidebar-locate-pulse {
  0% {
    opacity: 0.75;
    transform: translate(-50%, -50%) scale(0.4);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(3.2);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-locate-button,
  .sidebar-locate-icon--active,
  .sidebar-locate-pulse {
    animation: none;
    transition: none;
    transform: none;
  }

  .sidebar-locate-pulse {
    display: none;
  }
}
</style>
