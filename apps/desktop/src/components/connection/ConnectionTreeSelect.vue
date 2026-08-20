<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { Check, ChevronDown, ChevronRight, Folder, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { buildConnectionPickerRows, connectionPickerSelectableRows } from "@/lib/connection/connectionPickerTree";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import { cn } from "@/lib/common/utils";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    connections: ConnectionConfig[];
    layout: SidebarLayout;
    placeholder: string;
    searchPlaceholder: string;
    emptyText: string;
    disabled?: boolean;
    triggerClass?: HTMLAttributes["class"];
    triggerIconClass?: HTMLAttributes["class"];
    listClass?: HTMLAttributes["class"];
  }>(),
  {
    disabled: false,
    triggerIconClass: "size-4 text-muted-foreground",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "update:open": [value: boolean];
}>();

defineSlots<{
  "trigger-label"?(props: { value: string; label: string }): any;
}>();

const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();
const listContainer = ref<HTMLDivElement>();
const collapsedGroupIds = ref<Set<string>>(new Set());
const highlightIndex = ref(-1);

const connectionById = computed(() => new Map(props.connections.map((connection) => [connection.id, connection])));

const selectedLabel = computed(() => {
  if (!props.modelValue) return props.placeholder;
  return connectionById.value.get(props.modelValue)?.name || props.modelValue;
});

const rows = computed(() => buildConnectionPickerRows(props.layout, props.connections, collapsedGroupIds.value, searchText.value));
const selectableRows = computed(() => connectionPickerSelectableRows(rows.value));
const isSearchActive = computed(() => Boolean(searchText.value.trim()));

function toggleGroup(groupId: string) {
  if (isSearchActive.value) return;
  const next = new Set(collapsedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  collapsedGroupIds.value = next;
}

function selectConnection(connectionId: string) {
  emit("update:modelValue", connectionId);
  open.value = false;
}

function highlightSelectedConnection() {
  const selectedIndex = selectableRows.value.findIndex((row) => row.id === props.modelValue);
  highlightIndex.value = selectedIndex >= 0 ? selectedIndex : 0;
}

async function scrollHighlightedRowIntoView() {
  await nextTick();
  const container = listContainer.value;
  if (!container || highlightIndex.value < 0) return;
  const target = container.querySelectorAll("[data-picker-connection]")[highlightIndex.value];
  target?.scrollIntoView({ block: "nearest" });
}

watch(open, async (value) => {
  emit("update:open", value);
  if (!value) {
    searchText.value = "";
    highlightIndex.value = -1;
    return;
  }
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  highlightSelectedConnection();
  void scrollHighlightedRowIntoView();
});

watch(searchText, () => {
  highlightIndex.value = selectableRows.value.length ? 0 : -1;
  void scrollHighlightedRowIntoView();
});

watch(selectableRows, () => {
  if (!open.value || searchText.value) return;
  highlightSelectedConnection();
});

function rowIndent(depth: number) {
  return { paddingLeft: `${8 + depth * 14}px` };
}

function handleKeydown(event: KeyboardEvent) {
  const total = selectableRows.value.length;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    if (!total) return;
    highlightIndex.value = highlightIndex.value < total - 1 ? highlightIndex.value + 1 : 0;
    void scrollHighlightedRowIntoView();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    if (!total) return;
    highlightIndex.value = highlightIndex.value > 0 ? highlightIndex.value - 1 : total - 1;
    void scrollHighlightedRowIntoView();
  } else if (event.key === "Enter") {
    if (highlightIndex.value < 0 || highlightIndex.value >= total) return;
    event.preventDefault();
    selectConnection(selectableRows.value[highlightIndex.value]!.id);
  } else if (event.key === "Escape") {
    open.value = false;
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button type="button" variant="ghost" :disabled="disabled" :title="selectedLabel" :class="cn('h-6 w-auto max-w-56 min-w-0 justify-between gap-1 border-0 bg-transparent px-1 text-xs font-normal shadow-none hover:bg-muted/50 focus-visible:ring-0', triggerClass)">
        <slot name="trigger-label" :value="modelValue" :label="selectedLabel">
          <span class="truncate">{{ selectedLabel }}</span>
        </slot>
        <ChevronDown :class="cn('shrink-0 opacity-60', triggerIconClass)" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :class="cn('w-auto max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none ring-0')">
      <div :class="cn('shrink-0 rounded-md border bg-popover p-1.5 shadow-md', listClass)">
        <div class="relative rounded-md border bg-background">
          <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <span v-if="!searchText" class="pointer-events-none absolute left-[25px] top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{{ searchPlaceholder }}</span>
          <Input ref="searchInput" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-sm caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown="handleKeydown" />
        </div>
        <div ref="listContainer" class="dbx-connection-tree-select-list max-h-64 overflow-y-auto py-1">
          <template v-if="rows.length">
            <template v-for="row in rows" :key="row.key">
              <button
                v-if="row.kind === 'group'"
                type="button"
                :title="row.label"
                :style="rowIndent(row.depth)"
                :data-picker-group="row.id"
                :aria-expanded="!row.collapsed"
                :disabled="isSearchActive"
                class="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                @click="toggleGroup(row.id)"
              >
                <ChevronDown v-if="!row.collapsed" class="h-3 w-3 shrink-0" />
                <ChevronRight v-else class="h-3 w-3 shrink-0" />
                <Folder class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ row.label }}</span>
              </button>
              <button
                v-else
                type="button"
                :title="row.label"
                :style="rowIndent(row.depth)"
                :data-picker-connection="row.id"
                :class="
                  cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                    selectableRows[highlightIndex]?.id === row.id && 'bg-accent text-accent-foreground',
                  )
                "
                @click="selectConnection(row.id)"
              >
                <Check :class="cn('h-3.5 w-3.5 shrink-0', row.id === modelValue ? 'opacity-100' : 'opacity-0')" />
                <DatabaseIcon :db-type="connectionIconType(connectionById.get(row.id))" class="h-3.5 w-3.5 shrink-0" />
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
              </button>
            </template>
          </template>
          <div v-else class="px-2 py-2 text-sm text-muted-foreground">
            {{ emptyText }}
          </div>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style>
.dbx-connection-tree-select-list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--foreground) 30%, transparent) transparent;
}

.dbx-connection-tree-select-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.dbx-connection-tree-select-list::-webkit-scrollbar-track {
  background: transparent;
}

.dbx-connection-tree-select-list::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  background-clip: padding-box;
}

.dbx-connection-tree-select-list:hover::-webkit-scrollbar-thumb {
  border: 0;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}

.dark .dbx-connection-tree-select-list {
  scrollbar-color: rgb(82, 82, 91) transparent;
}

.dark .dbx-connection-tree-select-list::-webkit-scrollbar-thumb {
  background: rgb(82, 82, 91);
}

.dark .dbx-connection-tree-select-list:hover::-webkit-scrollbar-thumb {
  background: rgb(113, 113, 122);
}
</style>
