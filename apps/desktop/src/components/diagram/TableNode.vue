<script setup lang="ts">
import { computed } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { Table2, KeyRound, Link2 } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import type { DiagramTable, DiagramRelationship } from "@/lib/diagram/erDiagram";
import { isDraftTable, isDroppedColumn } from "@/lib/diagram/erDiagram";
import type { InferredRelationship } from "@/types/diagram";
import { useLayerStore } from "@/lib/diagram/layer-store";
import { CARD_WIDTH, COLUMN_TYPE_WIDTH, COLUMN_NAME_MAX_CHARS, COLUMN_TYPE_MAX_CHARS, TABLE_NAME_MAX_CHARS, EDGE_HANDLE_OUTSET } from "@/lib/diagram/diagram-constants";

const layerStore = useLayerStore();

const props = defineProps<{
  data: {
    table: DiagramTable;
    relationships?: (DiagramRelationship | InferredRelationship)[];
  };
  selected?: boolean;
}>();
const emit = defineEmits<{
  (e: "dblclick", event: MouseEvent): void;
}>();

const isDraft = computed(() => isDraftTable(props.data.table));

function visibleColumns(table: DiagramTable) {
  return table.columns.filter((column) => !isDroppedColumn(table, column.name));
}

function isForeignKeyColumn(table: DiagramTable, columnName: string): boolean {
  return table.foreignKeys.some((fk) => fk.column === columnName);
}

function isRelationshipColumn(table: DiagramTable, columnName: string): boolean {
  if (!props.data.relationships) return false;
  return props.data.relationships.some((relationship) => (relationship.sourceTable === table.name && relationship.sourceColumn === columnName) || (relationship.targetTable === table.name && relationship.targetColumn === columnName));
}

function truncateLabel(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

const layerColor = computed(() => layerStore.getLayerColor(props.data.table.name));

const handleOffsetStyle = computed(() =>
  EDGE_HANDLE_OUTSET > 0
    ? {
        left: { left: `-${EDGE_HANDLE_OUTSET}px` },
        right: { right: `-${EDGE_HANDLE_OUTSET}px` },
        top: { top: `-${EDGE_HANDLE_OUTSET}px` },
        bottom: { bottom: `-${EDGE_HANDLE_OUTSET}px` },
      }
    : { left: undefined, right: undefined, top: undefined, bottom: undefined },
);
</script>

<template>
  <div class="relative rounded-md border bg-background shadow-sm" :class="selected ? 'border-primary ring-1 ring-primary/30' : 'border-border'" :style="{ width: `${CARD_WIDTH}px`, borderLeft: `3px solid ${layerColor}` }" @dblclick.stop="emit('dblclick', $event)">
    <Handle id="left" type="source" :position="Position.Left" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.left" />
    <Handle id="left-target" type="target" :position="Position.Left" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.left" />
    <Handle id="right" type="source" :position="Position.Right" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.right" />
    <Handle id="right-target" type="target" :position="Position.Right" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.right" />
    <Handle id="top" type="source" :position="Position.Top" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.top" />
    <Handle id="top-target" type="target" :position="Position.Top" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.top" />
    <Handle id="bottom" type="source" :position="Position.Bottom" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.bottom" />
    <Handle id="bottom-target" type="target" :position="Position.Bottom" class="!h-2 !w-2 !min-h-0 !min-w-0 !border-0 !bg-transparent !opacity-0" :style="handleOffsetStyle.bottom" />
    <div class="overflow-hidden rounded-[inherit]">
      <div class="flex h-11 cursor-grab items-center gap-2 border-b bg-muted/40 px-3 active:cursor-grabbing">
        <Table2 class="h-4 w-4 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate text-sm font-medium" :title="data.table.name">
          {{ truncateLabel(data.table.name, TABLE_NAME_MAX_CHARS) }}
        </span>
        <Badge v-if="isDraft" variant="outline" class="h-5 shrink-0 px-1.5 text-[10px] border-amber-500/50 text-amber-700 dark:text-amber-400">Draft</Badge>
        <Badge variant="outline" class="h-5 px-1.5 text-[10px]">{{ visibleColumns(data.table).length }}</Badge>
      </div>
      <div>
        <div v-for="column in visibleColumns(data.table)" :key="column.name" class="flex h-6 min-w-0 items-center gap-1.5 border-b border-border/40 px-3 text-xs last:border-b-0">
          <KeyRound v-if="column.is_primary_key" class="h-3 w-3 shrink-0 text-amber-500" />
          <Link2 v-else-if="isForeignKeyColumn(data.table, column.name)" class="h-3 w-3 shrink-0 text-primary" />
          <Link2 v-else-if="isRelationshipColumn(data.table, column.name)" class="h-3 w-3 shrink-0 text-muted-foreground" />
          <span v-else class="h-3 w-3 shrink-0" />
          <span class="min-w-0 flex-1 truncate font-mono" :title="column.name">
            {{ truncateLabel(column.name, COLUMN_NAME_MAX_CHARS) }}
          </span>
          <span class="shrink-0 truncate text-right text-[10px] text-muted-foreground" :style="{ width: `${COLUMN_TYPE_WIDTH}px` }" :title="column.data_type">
            {{ truncateLabel(column.data_type, COLUMN_TYPE_MAX_CHARS) }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
