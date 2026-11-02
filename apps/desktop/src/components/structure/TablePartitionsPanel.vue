<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ChevronDown, ChevronRight, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { PARTITION_TREE_INDENT_PX, flattenPgPartitionNodes, pgPartitionBoundText, pgPartitionKindLabelKey, pgPartitionNodeBoundText, pgPartitionRowHint, visiblePgPartitionRows } from "@/lib/table/pgPartitionPresentation";
import { formatBytes } from "@/lib/database/serverMetrics";
import type { PgPartitionKind, PgPartitionNode, PgTablePartitioning } from "@/types/database";

/**
 * Read-only partition summary shared by the DataGrid / ObjectBrowser
 * "table properties" drawers. The full structure editor keeps its own
 * editable partitions pane.
 */
interface TablePartitionsPanelProps {
  partitioning: PgTablePartitioning | null;
  loading: boolean;
  error: string;
  searchQuery?: string;
}

const props = defineProps<TablePartitionsPanelProps>();

const { t } = useI18n();

function partitionStrategyLabel(kind?: PgPartitionKind): string {
  const key = pgPartitionKindLabelKey(kind);
  return key ? t(key) : "";
}

/** Size/count estimates live in the row's hover hint so the row stays two lines. */
function partitionRowHint(node: PgPartitionNode): string | undefined {
  return pgPartitionRowHint(node, t, formatBytes);
}

const allRows = computed(() => flattenPgPartitionNodes(props.partitioning?.partitions ?? []));

// Folded parents, by row key. Reset whenever a different tree is shown.
const collapsedPartitionKeys = ref<Set<string>>(new Set());
watch(
  () => props.partitioning,
  () => {
    collapsedPartitionKeys.value = new Set();
  },
);

function togglePartitionRow(key: string) {
  const next = new Set(collapsedPartitionKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  collapsedPartitionKeys.value = next;
}

const rows = computed(() => {
  const query = props.searchQuery?.trim().toLowerCase();
  // While searching, ignore the fold so a matching sub-partition is never hidden.
  if (query) return allRows.value.filter((row) => row.node.name.toLowerCase().includes(query));
  return visiblePgPartitionRows(allRows.value, collapsedPartitionKeys.value);
});
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.loading" class="h-full flex items-center justify-center">
      <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
    </div>
    <div v-else-if="props.error" class="p-3 text-xs text-destructive">
      {{ props.error }}
    </div>
    <div v-else-if="!props.partitioning || (!props.partitioning.isPartitioned && !props.partitioning.isPartition)" class="p-6 text-center text-xs text-muted-foreground">
      {{ t("structureEditor.partitionsEmpty") }}
    </div>
    <div v-else class="divide-y">
      <div class="p-3 text-xs">
        <div class="flex flex-wrap items-center gap-1.5">
          <span v-if="props.partitioning.isPartitioned" class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ partitionStrategyLabel(props.partitioning.strategy) }}</span>
          <span v-else class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("structureEditor.partitionMemberBadge") }}</span>
          <span v-if="props.partitioning.keyDefinition" class="min-w-0 truncate font-mono text-[11px]">{{ props.partitioning.keyDefinition }}</span>
        </div>
        <div v-if="props.partitioning.parent" class="mt-1 truncate font-mono text-[11px] text-muted-foreground">{{ t("structureEditor.partitionsParent") }}: {{ props.partitioning.parent }}</div>
        <div v-if="props.partitioning.ownBound" class="mt-1 truncate font-mono text-[11px] text-muted-foreground">{{ t("structureEditor.partitionsOwnBound") }}: {{ pgPartitionBoundText(props.partitioning.ownBound) }}</div>
        <div v-if="props.partitioning.defaultPartition" class="mt-1 truncate font-mono text-[11px] text-muted-foreground">{{ t("structureEditor.partitionsDefault") }}: {{ props.partitioning.defaultPartition }}</div>
      </div>
      <div v-if="rows.length === 0" class="p-6 text-center text-xs text-muted-foreground">
        {{ props.searchQuery ? t("grid.tableInfoNoResults") : t("structureEditor.partitionsEmptyChildren") }}
      </div>
      <div v-for="row in rows" :key="row.key" :title="partitionRowHint(row.node)" class="flex items-start gap-1 px-3 py-2 text-xs">
        <span :data-partition-depth="row.depth" :style="{ width: `${row.depth * PARTITION_TREE_INDENT_PX}px` }" class="shrink-0 self-stretch" aria-hidden="true"></span>
        <button
          v-if="row.node.children.length"
          type="button"
          class="mt-0.5 h-4 w-4 shrink-0 self-start text-muted-foreground transition-colors hover:text-foreground"
          :aria-label="collapsedPartitionKeys.has(row.key) ? t('structureEditor.partitionExpand') : t('structureEditor.partitionCollapse')"
          :title="collapsedPartitionKeys.has(row.key) ? t('structureEditor.partitionExpand') : t('structureEditor.partitionCollapse')"
          @click="togglePartitionRow(row.key)"
        >
          <ChevronRight v-if="collapsedPartitionKeys.has(row.key)" class="h-3.5 w-3.5" />
          <ChevronDown v-else class="h-3.5 w-3.5" />
        </button>
        <span v-else class="mt-0.5 h-4 w-4 shrink-0 self-start" aria-hidden="true"></span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="font-medium truncate">{{ row.node.name }}</span>
            <span v-if="row.node.children.length" class="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{{ t("structureEditor.partitionChildCount", { count: row.node.children.length }) }}</span>
            <span v-if="row.depth > 0" class="rounded border border-dashed px-1 py-px text-[10px] text-muted-foreground">{{ t("structureEditor.partitionSubPartitionBadge") }}</span>
            <span v-if="row.node.strategy" class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ partitionStrategyLabel(row.node.strategy) }}</span>
            <span v-if="row.node.bound?.kind === 'default'" class="rounded border px-1 py-px text-[10px] text-muted-foreground">{{ t("structureEditor.partitionBoundDefault") }}</span>
          </div>
          <div v-if="pgPartitionNodeBoundText(row.node)" class="mt-0.5 font-mono text-[11px] text-muted-foreground break-all">
            {{ pgPartitionNodeBoundText(row.node) }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
