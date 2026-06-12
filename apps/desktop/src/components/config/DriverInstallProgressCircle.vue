<script setup lang="ts">
const props = defineProps<{
  percent: number | null;
  title: string;
}>();
</script>

<template>
  <span class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full" role="status" :aria-label="title" :title="title">
    <svg class="absolute inset-0 h-8 w-8 -rotate-90" viewBox="0 0 32 32" aria-hidden="true">
      <circle class="text-green-600/20" cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="3" />
      <circle class="text-green-600 transition-[stroke-dashoffset] duration-200" cx="16" cy="16" r="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" pathLength="100" stroke-dasharray="100" :stroke-dashoffset="100 - (props.percent ?? 0)" />
    </svg>
    <span class="relative z-10 font-mono text-[10px] font-semibold leading-none text-green-700 tabular-nums">
      {{ props.percent ?? 0 }}
    </span>
  </span>
</template>
