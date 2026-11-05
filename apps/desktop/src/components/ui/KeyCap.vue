<script setup lang="ts">
/**
 * A single key printed as a quiet keycap. Colors come from `currentColor`, so
 * one component works on light popovers and on the hard-coded dark Redis
 * terminal instead of carrying per-surface color props. The label is painted
 * from CSS content so the hint stays out of the option's text content.
 */
defineProps<{ label: string }>();
</script>

<template>
  <kbd aria-hidden="true" :data-key="label" class="dbx-key-cap shrink-0 rounded-[3px] border border-current/25 bg-current/8 px-1 py-px font-mono text-[10px] leading-none font-medium opacity-70" />
</template>

<style scoped>
.dbx-key-cap::after {
  content: attr(data-key);
}
</style>
