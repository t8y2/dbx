<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { Check, ChevronDown, ChevronRight, Folder, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ConnectionIcon from "@/components/icons/ConnectionIcon.vue";
import { buildConnectionPickerRows, connectionPickerDefaultCollapsedGroupIds, connectionPickerSelectableRows } from "@/lib/connection/connectionPickerTree";
import { cn } from "@/lib/common/utils";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

defineOptions({ inheritAttrs: false });

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
    hideTitle?: boolean;
    multiple?: boolean;
    selectedConnectionIds?: string[];
    extraOptions?: Array<{ id: string; label: string }>;
    searchInputAttrs?: HTMLAttributes & Record<string, unknown>;
  }>(),
  {
    disabled: false,
    hideTitle: false,
    multiple: false,
    selectedConnectionIds: () => [],
    extraOptions: () => [],
    triggerIconClass: "size-4 text-muted-foreground",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  toggleConnection: [connectionId: string];
  "update:open": [value: boolean];
}>();

defineSlots<{
  "trigger-label"?(props: { value: string; label: string }): any;
}>();

const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();
const listContainer = ref<HTMLDivElement>();
const highlightIndex = ref(-1);
let focusRestoreElement: HTMLElement | null = null;

const connectionById = computed(() => new Map(props.connections.map((connection) => [connection.id, connection])));

const selectedConnectionIdSet = computed(() => {
  const ids = props.multiple ? props.selectedConnectionIds : props.modelValue ? [props.modelValue] : [];
  return new Set(ids.filter((id) => connectionById.value.has(id)));
});

const collapsedGroupIds = ref<Set<string>>(connectionPickerDefaultCollapsedGroupIds(props.layout, selectedConnectionIdSet.value));

const selectedLabel = computed(() => {
  if (!props.modelValue) return props.placeholder;
  const extraOption = props.extraOptions.find((option) => option.id === props.modelValue);
  if (extraOption) return extraOption.label;
  return connectionById.value.get(props.modelValue)?.name || props.modelValue;
});

const rows = computed(() => buildConnectionPickerRows(props.layout, props.connections, collapsedGroupIds.value, searchText.value));
const selectableOptions = computed(() => [...props.extraOptions.map((option) => ({ id: option.id, kind: "extra" as const })), ...connectionPickerSelectableRows(rows.value).map((row) => ({ id: row.id, kind: "connection" as const }))]);
const isSearchActive = computed(() => Boolean(searchText.value.trim()));

function toggleGroup(groupId: string) {
  if (isSearchActive.value) return;
  const next = new Set(collapsedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  collapsedGroupIds.value = next;
}

function isConnectionSelected(connectionId: string) {
  return props.multiple ? props.selectedConnectionIds.includes(connectionId) : props.modelValue === connectionId;
}

function selectConnection(connectionId: string) {
  if (props.multiple) {
    emit("toggleConnection", connectionId);
    return;
  }
  emit("update:modelValue", connectionId);
  open.value = false;
}

function selectExtraOption(optionId: string) {
  emit("update:modelValue", optionId);
  open.value = false;
}

function selectOption(option: { id: string; kind: "connection" | "extra" }) {
  if (option.kind === "extra") selectExtraOption(option.id);
  else selectConnection(option.id);
}

function highlightSelectedConnection() {
  const selectedIndex = selectableOptions.value.findIndex((option) => option.id === props.modelValue);
  highlightIndex.value = selectedIndex >= 0 ? selectedIndex : 0;
}

async function scrollHighlightedRowIntoView() {
  await nextTick();
  const container = listContainer.value;
  if (!container || highlightIndex.value < 0) return;
  const target = container.querySelectorAll("[data-picker-option]")[highlightIndex.value];
  target?.scrollIntoView({ block: "nearest" });
}

watch(open, async (value) => {
  emit("update:open", value);
  if (!value) {
    searchText.value = "";
    highlightIndex.value = -1;
    const restoreTarget = focusRestoreElement;
    focusRestoreElement = null;
    if (restoreTarget) {
      // Reka's modal popover refocuses the trigger synchronously on close, so
      // the restore must land on the next tick to win for shortcut-opened
      // dropdowns.
      await nextTick();
      if (restoreTarget.isConnected) restoreTarget.focus();
    }
    return;
  }
  collapsedGroupIds.value = connectionPickerDefaultCollapsedGroupIds(props.layout, selectedConnectionIdSet.value);
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  highlightSelectedConnection();
  void scrollHighlightedRowIntoView();
});

watch(searchText, () => {
  highlightIndex.value = selectableOptions.value.length ? 0 : -1;
  void scrollHighlightedRowIntoView();
});

watch(selectableOptions, () => {
  if (!open.value || searchText.value) return;
  highlightSelectedConnection();
});

function rowIndent(depth: number) {
  return { paddingLeft: `${8 + depth * 14}px` };
}

function handleKeydown(event: KeyboardEvent) {
  const total = selectableOptions.value.length;
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
    selectOption(selectableOptions.value[highlightIndex.value]!);
  } else if (event.key === "Escape") {
    open.value = false;
  }
}

defineExpose({
  openDropdown: () => {
    if (props.disabled) return false;
    focusRestoreElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    open.value = true;
    return true;
  },
});
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        v-bind="$attrs"
        type="button"
        variant="ghost"
        :disabled="disabled"
        :title="hideTitle ? undefined : selectedLabel"
        :class="cn('h-6 w-auto max-w-56 min-w-0 justify-between gap-1 border-0 bg-transparent px-1 text-xs font-normal shadow-none hover:bg-muted/50 focus-visible:ring-0', triggerClass)"
      >
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
          <Input ref="searchInput" v-bind="searchInputAttrs" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-sm caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown="handleKeydown" />
        </div>
        <div ref="listContainer" class="dbx-connection-tree-select-list max-h-64 overflow-y-auto py-1">
          <button
            v-for="option in extraOptions"
            :key="`extra:${option.id}`"
            type="button"
            data-picker-option
            :data-picker-extra="option.id"
            :class="
              cn(
                'flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                selectableOptions[highlightIndex]?.id === option.id && 'bg-accent text-accent-foreground',
              )
            "
            @click="selectExtraOption(option.id)"
          >
            <Check :class="cn('h-3.5 w-3.5 shrink-0', option.id === modelValue ? 'opacity-100' : 'opacity-0')" />
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          </button>
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
                :role="multiple ? 'checkbox' : undefined"
                :aria-checked="multiple ? isConnectionSelected(row.id) : undefined"
                data-picker-option
                :data-picker-connection="row.id"
                :class="
                  cn(
                    'flex h-8 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none',
                    selectableOptions[highlightIndex]?.id === row.id && 'bg-accent text-accent-foreground',
                  )
                "
                @click="selectConnection(row.id)"
              >
                <Check :class="cn('h-3.5 w-3.5 shrink-0', isConnectionSelected(row.id) ? 'opacity-100' : 'opacity-0')" />
                <ConnectionIcon :connection="connectionById.get(row.id)" class="h-3.5 w-3.5 shrink-0" />
                <span class="min-w-0 flex-1 truncate">{{ row.label }}</span>
              </button>
            </template>
          </template>
          <div v-if="!rows.length && !extraOptions.length" class="px-2 py-2 text-sm text-muted-foreground">
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
