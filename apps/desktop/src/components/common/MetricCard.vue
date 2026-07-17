<script setup lang="ts">
import type { Component } from "vue";

defineProps<{
  label: string;
  value: string;
  sub?: string;
  icon?: Component;
}>();
</script>

<template>
  <div class="flex flex-col gap-1 rounded-lg border bg-card p-3 text-card-foreground">
    <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <component :is="icon" v-if="icon" class="h-3.5 w-3.5" />
      <span class="truncate">{{ label }}</span>
    </div>
    <div class="text-xl font-semibold tabular-nums">{{ value }}</div>
    <div v-if="sub" class="truncate text-[11px] text-muted-foreground">{{ sub }}</div>
  </div>
</template>
