<script setup lang="ts">
import { ListFilter, SlidersHorizontal } from "@lucide/vue";

defineProps<{
  filtered: boolean;
  open: boolean;
}>();
</script>

<template>
  <span data-sidebar-list-options-icon class="sidebar-list-options-icon relative block h-3.5 w-3.5" :class="{ 'sidebar-list-options-icon--filtered': filtered, 'sidebar-list-options-icon--open': open }" aria-hidden="true">
    <Transition name="sidebar-filter-symbol">
      <ListFilter v-if="filtered" key="filtered" data-sidebar-filtered-icon class="sidebar-filter-symbol absolute inset-0 h-3.5 w-3.5" />
      <SlidersHorizontal v-else key="unfiltered" data-sidebar-unfiltered-icon class="sidebar-filter-symbol absolute inset-0 h-3.5 w-3.5" />
    </Transition>
    <span v-if="filtered" class="sidebar-filter-status-dot absolute -right-0.5 -top-0.5 h-1 w-1 rounded-full bg-primary" />
  </span>
</template>

<style scoped>
.sidebar-list-options-icon {
  transform: scale(1);
}

.sidebar-list-options-icon--open {
  animation: sidebar-list-options-press 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sidebar-list-options-icon--filtered {
  color: var(--primary);
}

.sidebar-filter-symbol-enter-active,
.sidebar-filter-symbol-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sidebar-filter-symbol-enter-from {
  opacity: 0;
  transform: translateY(2px) scale(0.72);
}

.sidebar-filter-symbol-leave-to {
  opacity: 0;
  transform: translateY(-2px) scale(0.82);
}

.sidebar-filter-status-dot {
  animation: sidebar-filter-dot-in 260ms cubic-bezier(0.2, 0.9, 0.25, 1.3) both;
  box-shadow: 0 0 0 1px var(--background);
}

@keyframes sidebar-filter-dot-in {
  0% {
    opacity: 0;
    transform: scale(0);
  }
  70% {
    transform: scale(1.35);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes sidebar-list-options-press {
  0% {
    transform: scale(1);
  }
  48% {
    transform: scale(0.8);
  }
  100% {
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-list-options-icon,
  .sidebar-filter-symbol-enter-active,
  .sidebar-filter-symbol-leave-active,
  .sidebar-filter-status-dot {
    animation: none;
    transition: none;
    transform: none;
  }
}
</style>
