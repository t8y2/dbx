<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { ChevronDown, ChevronRight } from "@lucide/vue";
import { buildDataGridJsonPreviewLines, DATA_GRID_JSON_COMMENT_GAP, type DataGridRowDetailPreviewField } from "@/lib/dataGrid/dataGridDetail";

const props = defineProps<{
  fields: readonly DataGridRowDetailPreviewField[];
  previewHint: (count: number) => string;
}>();
const collapsedPaths = shallowRef(new Set<string>());
const previewLines = computed(() => buildDataGridJsonPreviewLines(props.fields, collapsedPaths.value));

function resetCollapsedPaths() {
  collapsedPaths.value = new Set();
}

function togglePath(path: string) {
  const next = new Set(collapsedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedPaths.value = next;
}

watch(() => props.fields, resetCollapsedPaths);
</script>

<template>
  <div class="min-w-0 p-3 font-mono text-[13px] leading-6 text-foreground">
    <div v-for="line in previewLines" :key="line.key" class="flex min-w-0 min-h-6 items-start">
      <span class="w-10 shrink-0 select-none pr-3 text-right text-[11px] leading-6 tabular-nums text-muted-foreground/60">{{ line.lineNumber }}</span>
      <button
        v-if="line.togglePath"
        type="button"
        class="flex h-6 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        :aria-expanded="line.expanded"
        :aria-label="line.toggleLabel"
        :title="line.toggleLabel"
        @click="togglePath(line.togglePath)"
        @keydown.stop
      >
        <ChevronDown v-if="line.expanded" class="h-3.5 w-3.5" aria-hidden="true" />
        <ChevronRight v-else class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <span v-else class="w-5 shrink-0" aria-hidden="true" />
      <div class="min-w-0 whitespace-pre-wrap break-words">
        <span>{{ line.text }}</span
        ><span v-if="line.comment" class="text-muted-foreground/85">{{ DATA_GRID_JSON_COMMENT_GAP }}{{ line.comment }}</span>
        <div v-if="line.previewLength !== undefined" class="pl-2 text-[11px] leading-5 text-muted-foreground">{{ previewHint(line.previewLength) }}</div>
      </div>
    </div>
  </div>
</template>
