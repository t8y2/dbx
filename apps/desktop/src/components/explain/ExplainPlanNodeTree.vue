<script setup lang="ts">
import { ref } from "vue";
import { ChevronRight, ChevronDown } from "@lucide/vue";
import type { ExplainPlanNode } from "@/lib/explainPlan";

const props = defineProps<{
  node: ExplainPlanNode;
  depth?: number;
}>();

const collapsed = ref(false);

function toggle() {
  if (props.node.children.length > 0) {
    collapsed.value = !collapsed.value;
  }
}

function actualRowsFromDetails(): string | undefined {
  for (const d of props.node.details) {
    const m = d.match(/Actual Rows:\s*(\S+)/);
    if (m) return m[1];
  }
  return undefined;
}

const actualRows = actualRowsFromDetails();
const hasActualStats = !!actualRows;
const rowDiffers = hasActualStats && actualRows !== props.node.rows;
</script>

<template>
  <div>
    <!-- Single line: collapse icon + title + badges all in one row -->
    <div class="flex cursor-pointer items-center gap-1 rounded border bg-background px-2 py-1 text-xs hover:bg-muted/30" :class="{ 'border-green-300 dark:border-green-700': hasActualStats }" @click="toggle">
      <ChevronRight v-if="node.children.length > 0 && collapsed" class="h-3 w-3 shrink-0 text-muted-foreground" />
      <ChevronDown v-else-if="node.children.length > 0" class="h-3 w-3 shrink-0 text-muted-foreground" />

      <span class="shrink-0 rounded bg-muted px-1 py-0.5 font-medium">{{ node.nodeType }}</span>
      <span v-if="node.relation" class="shrink-0 truncate max-w-[120px] text-blue-600 dark:text-blue-400">{{ node.relation }}</span>
      <span v-if="node.index" class="shrink-0 text-emerald-600 dark:text-emerald-400">[{{ node.index }}]</span>
      <span v-if="node.cost" class="shrink-0 tabular-nums text-muted-foreground">c:{{ node.cost }}</span>
      <span v-if="node.rows" class="shrink-0 tabular-nums text-amber-600 dark:text-amber-400">e:{{ node.rows }}</span>
      <span v-if="hasActualStats" class="shrink-0 tabular-nums font-semibold" :class="rowDiffers ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'"
        >a:{{ actualRows }}<span v-if="rowDiffers">({{ Math.round((Number(actualRows) / Number(node.rows)) * 100) }}%)</span></span
      >

      <!-- Details collapsed into tooltip on hover -->
      <span v-if="node.details.length" class="ml-auto shrink-0 overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground/40" :title="node.details.join('\n')">{{ node.details.join(" ") }}</span>
    </div>

    <!-- Children (collapsible) -->
    <div v-if="node.children.length && !collapsed" class="ml-3 mt-px space-y-px border-l pl-2">
      <ExplainPlanNodeTree v-for="child in node.children" :key="child.id" :node="child" :depth="(depth || 0) + 1" />
    </div>
  </div>
</template>
