<script setup lang="ts">
import { computed } from "vue";
import { describeWarning, type Translate } from "../docsWarnings";
import type { SnapshotWarning } from "../types";

const props = defineProps<{
  warnings: SnapshotWarning[];
  translate: Translate;
}>();

// Keyed by index: two warnings of the same kind can carry identical text.
const notices = computed(() => props.warnings.map((warning, index) => ({ key: `${warning.kind}-${index}`, ...describeWarning(warning, props.translate) })));
</script>

<template>
  <div v-if="notices.length > 0" class="flex flex-col gap-2">
    <div
      v-for="notice in notices"
      :key="notice.key"
      class="rounded-md border px-3 py-2 text-xs"
      :class="notice.severity === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200' : 'border-border bg-muted/30 text-muted-foreground'"
    >
      <div class="font-medium">{{ notice.title }}</div>
      <div class="mt-0.5 leading-relaxed">{{ notice.detail }}</div>
    </div>
  </div>
</template>
