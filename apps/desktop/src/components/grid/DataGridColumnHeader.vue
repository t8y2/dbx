<script setup lang="ts">
import type { CSSProperties, HTMLAttributes } from "vue";
import { Copy, KeyRound, Hash } from "@lucide/vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { columnIndexColorClass, type ColumnIndexKind } from "@/lib/dataGrid/dataGridColumnIndexIcon";

const props = defineProps<{
  name: string;
  actualColumnIndex: number;
  visibleColumnIndex: number;
  selected?: boolean;
  searchMatch?: boolean;
  dark?: boolean;
  frozen?: boolean;
  frozenSeparator?: boolean;
  tooltipDisabled?: boolean;
  columnType?: string;
  columnComment?: string;
  tooltipColumnType?: string;
  tooltipColumnComment?: string;
  columnNullability?: "nullable" | "required";
  showTypeLine?: boolean;
  showCommentLine?: boolean;
  typeClass?: HTMLAttributes["class"];
  dragClass?: HTMLAttributes["class"];
  columnStyle?: CSSProperties;
  copyColumnNameLabel: string;
  columnNameLabel: string;
  columnTypeLabel: string;
  columnCommentLabel: string;
  nullableLabel?: string;
  yesLabel?: string;
  noLabel?: string;
  columnIndexLabel: string;
  columnPrimaryIndexLabel: string;
  columnUniqueIndexLabel: string;
  columnRegularIndexLabel: string;
  /** 该列的索引类型，undefined 时不显示标识 */
  columnIndexKind?: ColumnIndexKind;
}>();

function columnIndexText(kind: ColumnIndexKind): string {
  if (kind === "primary") return props.columnPrimaryIndexLabel;
  if (kind === "unique") return props.columnUniqueIndexLabel;
  if (kind === "index") return props.columnRegularIndexLabel;
  return "";
}

const emit = defineEmits<{
  pointerdown: [event: PointerEvent];
  clickCapture: [event: MouseEvent];
  click: [event: MouseEvent];
  contextmenu: [event: MouseEvent];
  resizeStart: [event: MouseEvent];
  autoFit: [];
  copyName: [];
}>();
</script>

<template>
  <div
    class="data-grid-header-cell shrink-0 px-2 py-1.5 border-r border-border whitespace-nowrap hover:bg-gray-200 dark:hover:bg-gray-800 select-none relative overflow-hidden"
    :class="[dark && 'data-grid-header-cell--dark', selected && 'data-grid-header-cell--selected', searchMatch && 'bg-amber-500/20 ring-1 ring-inset ring-amber-500/40', frozen && 'data-grid-header-cell--frozen', frozenSeparator && 'data-grid-header-cell--frozen-separator', dragClass]"
    :style="columnStyle"
    :data-grid-column-index="actualColumnIndex"
    :data-visible-col-index="visibleColumnIndex"
    @pointerdown="emit('pointerdown', $event)"
    @click.capture="emit('clickCapture', $event)"
    @click="emit('click', $event)"
    @contextmenu="emit('contextmenu', $event)"
  >
    <span class="flex min-w-0 items-center gap-1 overflow-hidden">
      <!-- 索引标识：显示在列名左侧 -->
      <KeyRound v-if="columnIndexKind === 'primary'" class="h-3 w-3 shrink-0" :class="columnIndexColorClass(columnIndexKind)" :title="columnIndexText(columnIndexKind)" />
      <Hash v-else-if="columnIndexKind && columnIndexKind !== 'none'" class="h-3 w-3 shrink-0" :class="columnIndexColorClass(columnIndexKind)" :title="columnIndexText(columnIndexKind)" />
      <LightTooltip :text="name" side="bottom" :side-offset="4" :disabled="tooltipDisabled">
        <span data-column-tooltip-trigger class="flex min-w-0 flex-1 flex-col overflow-hidden">
          <span class="min-w-0 truncate leading-4">{{ name }}</span>
          <span v-if="showTypeLine" data-grid-header-type-line class="h-3 min-w-0 truncate text-[10px] font-normal leading-3" :class="[typeClass, { invisible: !columnType }]" :title="columnType || undefined" :aria-hidden="columnType ? undefined : true">{{ columnType }}</span>
          <span v-if="showCommentLine" data-grid-header-comment-line class="h-3 min-w-0 truncate text-[10px] font-normal leading-3 text-muted-foreground" :class="{ invisible: !columnComment }" :title="columnComment || undefined" :aria-hidden="columnComment ? undefined : true">{{
            columnComment
          }}</span>
        </span>
        <template #content>
          <div class="grid min-w-56 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 px-3 py-2">
            <span class="text-background/70">{{ columnNameLabel }}</span>
            <span class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-mono">{{ name }}</span>
              <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background/10" :title="copyColumnNameLabel" @click.stop="emit('copyName')">
                <Copy class="h-3 w-3" />
              </button>
            </span>
            <template v-if="tooltipColumnType ?? columnType">
              <span class="text-background/70">{{ columnTypeLabel }}</span>
              <span :class="typeClass">{{ tooltipColumnType ?? columnType }}</span>
            </template>
            <template v-if="tooltipColumnComment ?? columnComment">
              <span class="text-background/70">{{ columnCommentLabel }}</span>
              <span>{{ tooltipColumnComment ?? columnComment }}</span>
            </template>
            <template v-if="columnNullability">
              <span class="text-background/70">{{ nullableLabel }}</span>
              <span>{{ columnNullability === "nullable" ? yesLabel : noLabel }}</span>
            </template>
            <template v-if="columnIndexKind && columnIndexKind !== 'none'">
              <span class="text-background/70">{{ columnIndexLabel }}</span>
              <span class="flex items-center gap-1">
                <KeyRound v-if="columnIndexKind === 'primary'" class="h-3 w-3" :class="columnIndexColorClass(columnIndexKind)" />
                <Hash v-else class="h-3 w-3" :class="columnIndexColorClass(columnIndexKind)" />
                <span :class="columnIndexColorClass(columnIndexKind)">{{ columnIndexText(columnIndexKind) }}</span>
              </span>
            </template>
          </div>
        </template>
      </LightTooltip>
      <span data-column-header-actions class="contents"><slot name="actions" /></span>
    </span>
    <div data-column-resize-handle class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="emit('resizeStart', $event)" @click.stop.prevent @dblclick.stop="emit('autoFit')" />
  </div>
</template>

<style scoped>
.data-grid-header-cell {
  background-color: rgb(239, 239, 239);
}

.data-grid-header-cell--dark {
  background-color: rgb(32, 32, 34) !important;
}

.data-grid-header-cell--dark:hover {
  background-color: rgb(46, 47, 51) !important;
}

.data-grid-header-cell--selected {
  background-color: var(--data-grid-cell-selected-single-bg, rgb(191, 219, 254)) !important;
}

.data-grid-header-cell--dark.data-grid-header-cell--selected {
  background-color: var(--data-grid-cell-selected-single-bg, rgb(30, 64, 96)) !important;
  color: rgb(244, 244, 245) !important;
}

.data-grid-header-cell--frozen {
  background-color: rgb(220, 225, 232) !important;
}

.data-grid-header-cell--frozen-separator {
  border-right: 2px solid rgb(100, 116, 139) !important;
}

.data-grid-header-cell--dark.data-grid-header-cell--frozen {
  background-color: rgb(40, 42, 48) !important;
}

.data-grid-header-cell--dark.data-grid-header-cell--frozen-separator {
  border-right: 2px solid rgb(100, 116, 139) !important;
}
</style>
