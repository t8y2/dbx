<script setup lang="ts">
import type { ConnectionDetailRow } from "@/lib/connection/connectionDetailRows";

defineProps<{ rows: ConnectionDetailRow[] }>();
</script>

<template>
  <div class="w-max min-w-40 max-w-[min(28rem,calc(100vw-24px))] rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg">
    <div class="space-y-1">
      <div v-for="row in rows" :key="row.label" class="grid grid-cols-[max-content_minmax(0,1fr)] gap-2 text-xs leading-5">
        <span class="shrink-0 text-muted-foreground">{{ row.label }}</span>
        <template v-if="row.values">
          <div class="flex flex-col gap-0.5 font-mono text-foreground/90">
            <span v-for="(value, index) in row.values" :key="index" class="break-all">{{ value }}</span>
          </div>
        </template>
        <button
          v-else-if="row.action"
          type="button"
          class="w-fit rounded bg-primary/10 px-1 font-mono text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="row.actionLabel"
          :title="row.actionLabel"
          @click.stop="row.action()"
        >
          {{ row.value }}
        </button>
        <span v-else-if="row.multiline" class="max-h-20 overflow-hidden whitespace-pre-wrap break-words text-foreground/90">{{ row.value }}</span>
        <span v-else class="truncate font-mono text-foreground/90" :title="row.value">{{ row.value }}</span>
      </div>
    </div>
  </div>
</template>
