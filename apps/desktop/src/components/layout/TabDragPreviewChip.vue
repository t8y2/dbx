<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="flex items-center gap-2 overflow-hidden rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground shadow-lg">
    <span class="h-3 w-3 shrink-0 rounded-sm bg-emerald-500/90" />
    <span class="min-w-0 flex-1 truncate">{{ title }}</span>
    <span class="shrink-0 text-muted-foreground">×</span>
  </div>
</template>
