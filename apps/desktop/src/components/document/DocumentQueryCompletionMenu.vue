<script setup lang="ts">
import type { CSSProperties } from "vue";
import { computed } from "vue";
import type { DataGridConditionSuggestionPosition } from "@/lib/dataGrid/dataGridConditionSuggestionPosition";
import type { MongoCompletionItem } from "@/lib/mongo/mongoCompletion";

defineOptions({ name: "DocumentQueryCompletionMenu" });

const props = defineProps<{
  items: MongoCompletionItem[];
  selectedIndex: number;
  listboxId: string;
  label: string;
  /** Viewport coordinates of the input this menu hangs under. */
  position: DataGridConditionSuggestionPosition;
}>();

const emit = defineEmits<{
  (e: "select", index: number): void;
  (e: "accept", index: number): void;
}>();

/** Mirrors the query editor's completion icons: fields read as columns, operators as keywords. */
const TYPE_GLYPH: Record<MongoCompletionItem["type"], string> = {
  column: "#",
  function: "ƒ",
  keyword: "$",
  snippet: "{}",
  table: "▤",
};

const style = computed<CSSProperties>(() => ({
  left: `${props.position.left}px`,
  top: `${props.position.top}px`,
  width: `${props.position.width}px`,
}));

function glyph(item: MongoCompletionItem): string {
  return TYPE_GLYPH[item.type] ?? "#";
}

function isSelected(index: number): boolean {
  return props.selectedIndex === index;
}
</script>

<template>
  <!--
    The grid's toolbar clips both axes and is only 32px tall, so a dropdown
    positioned inside it would never be visible. Teleporting to fixed viewport
    coordinates is what the grid's own condition suggestions do.
  -->
  <Teleport to="body">
    <!--
      The container takes the same `mousedown.prevent` as its options: the list
      scrolls, and a press on its scrollbar or padding would otherwise blur the
      input and unmount the menu mid-drag, leaving everything below the fold
      reachable by keyboard only.
    -->
    <div :id="listboxId" role="listbox" :aria-label="label" class="fixed z-[90] max-h-64 overflow-y-auto overflow-x-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md" :style="style" @mousedown.prevent>
      <button
        v-for="(item, index) in items"
        :id="`${listboxId}-option-${index}`"
        :key="`${item.type}:${item.label}:${index}`"
        type="button"
        role="option"
        :aria-selected="isSelected(index)"
        :aria-description="item.info"
        class="flex w-full items-center gap-2 px-2 py-1 text-left text-xs"
        :class="isSelected(index) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'"
        @pointerenter="emit('select', index)"
        @mousedown.prevent
        @click.stop="emit('accept', index)"
      >
        <span class="w-3 shrink-0 text-center font-mono text-[10px] text-muted-foreground">{{ glyph(item) }}</span>
        <span class="min-w-0 flex-1 truncate font-mono">{{ item.label }}</span>
        <span v-if="item.detail" class="max-w-[55%] shrink-0 truncate text-[11px] text-muted-foreground">{{ item.detail }}</span>
      </button>
    </div>
  </Teleport>
</template>
