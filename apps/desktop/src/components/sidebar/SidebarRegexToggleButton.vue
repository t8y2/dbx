<script setup lang="ts">
import { ref } from "vue";

defineProps<{
  label: string;
  pressed: boolean;
  invalid: boolean;
}>();

const emit = defineEmits<{
  toggle: [];
}>();

const animationId = ref(0);

function toggle() {
  animationId.value += 1;
  emit("toggle");
}
</script>

<template>
  <button
    type="button"
    data-sidebar-regex-toggle
    class="sidebar-regex-toggle relative flex h-5 min-w-5 items-center justify-center overflow-hidden rounded-sm px-0.5 font-mono text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
    :class="{ 'sidebar-regex-toggle--pressed text-primary bg-primary/10': pressed, 'text-destructive': invalid }"
    :aria-label="label"
    :aria-pressed="pressed"
    @click="toggle"
  >
    <span :key="animationId" data-sidebar-regex-glyph class="sidebar-regex-glyph relative inline-flex h-3.5 w-4 items-center justify-center leading-none" :class="{ 'sidebar-regex-glyph--pressed': pressed, 'sidebar-regex-glyph--animated': animationId > 0 }" aria-hidden="true">.*</span>
  </button>
</template>

<style scoped>
.sidebar-regex-toggle {
  letter-spacing: 0;
  transition:
    color 160ms ease,
    background-color 160ms ease,
    transform 120ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.sidebar-regex-toggle:active {
  transform: scale(0.9);
}

.sidebar-regex-glyph {
  font-weight: 400;
  transform: scale(1);
  transition:
    font-weight 180ms ease,
    transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
}

.sidebar-regex-glyph--pressed {
  font-weight: 700;
  transform: scale(1.08);
}

.sidebar-regex-glyph--animated.sidebar-regex-glyph--pressed {
  animation: sidebar-regex-enable 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.sidebar-regex-glyph--animated:not(.sidebar-regex-glyph--pressed) {
  animation: sidebar-regex-disable 300ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes sidebar-regex-enable {
  0% {
    font-weight: 400;
    transform: scale(0.92);
  }
  56% {
    font-weight: 700;
    transform: scale(1.3);
  }
  100% {
    font-weight: 700;
    transform: scale(1.08);
  }
}

@keyframes sidebar-regex-disable {
  0% {
    font-weight: 700;
    transform: scale(1.08);
  }
  56% {
    font-weight: 700;
    transform: scale(1.26);
  }
  100% {
    font-weight: 400;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar-regex-toggle,
  .sidebar-regex-glyph {
    animation: none;
    transition: none;
  }
}
</style>
