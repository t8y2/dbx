<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Search, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface ColumnOption {
  name: string;
  dataType: string;
  disabled?: boolean;
}

const props = defineProps<{
  selected: string[];
  options: ColumnOption[];
  placeholder: string;
  triggerClass?: string;
}>();
const emit = defineEmits<{ toggle: [name: string] }>();
const { t } = useI18n();
const open = ref(false);
const search = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
const optionInputs = ref<HTMLInputElement[]>([]);
const selectedPositions = computed(() => new Map(props.selected.map((name, position) => [name, position + 1])));
const visibleOptions = computed(() => {
  const query = search.value.trim().toLowerCase();
  return props.options
    .filter((column) => !query || column.name.toLowerCase().includes(query) || column.dataType.toLowerCase().includes(query))
    .sort((left, right) => (selectedPositions.value.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (selectedPositions.value.get(right.name) ?? Number.MAX_SAFE_INTEGER));
});

function onOpenChange(value: boolean) {
  open.value = value;
  if (!value) search.value = "";
}

function focusSearch(event: Event) {
  event.preventDefault();
  void nextTick(() => searchInput.value?.focus());
}

function focusOption(event: KeyboardEvent, direction: 1 | -1) {
  const options = visibleOptions.value.flatMap((column) => {
    const input = optionInputs.value.find((item) => item.dataset.indexColumn === column.name);
    return input && !input.disabled ? [input] : [];
  });
  if (!options.length) return;
  const position = options.indexOf(event.target as HTMLInputElement);
  const target = position < 0 ? (direction === 1 ? options[0] : options[options.length - 1]) : options[(position + direction + options.length) % options.length];
  event.preventDefault();
  target?.focus();
}
</script>

<template>
  <Popover :open="open" @update:open="onOpenChange">
    <PopoverTrigger as-child>
      <Button type="button" variant="outline" :class="[triggerClass, 'w-full min-w-0 justify-between gap-2']" :aria-label="placeholder" :title="selected.join(', ')" data-index-column-trigger>
        <span class="min-w-0 flex-1 truncate text-left">{{ selected.join(", ") || placeholder }}</span>
        <span v-if="selected.length > 1" class="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">{{ selected.length }}</span>
        <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </Button>
    </PopoverTrigger>
    <PopoverContent
      align="start"
      side="bottom"
      :side-offset="6"
      :collision-padding="12"
      class="index-column-picker w-[360px] max-w-[calc(100vw-24px)] gap-0 overflow-hidden rounded-md p-0"
      :aria-label="placeholder"
      data-index-column-picker
      @open-auto-focus="focusSearch"
      @keydown.down="focusOption($event, 1)"
      @keydown.up="focusOption($event, -1)"
    >
      <div class="shrink-0 border-b p-2.5">
        <div class="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/25">
          <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input ref="searchInput" v-model="search" type="text" class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('grid.searchColumns')" :aria-label="t('grid.searchColumns')" data-index-column-search />
          <button
            v-if="search"
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            :aria-label="t('structureEditor.clearColumnSearch')"
            @click="
              search = '';
              searchInput?.focus();
            "
          >
            <X class="h-3 w-3" />
          </button>
        </div>
        <div class="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{{ t("structureEditor.indexSelectedColumns", { count: selected.length }) }}</span>
          <span>{{ t("structureEditor.dataType") }}</span>
        </div>
      </div>
      <div class="index-column-options min-h-0 overflow-y-auto overscroll-contain p-1" :aria-label="placeholder" role="group">
        <label
          v-for="column in visibleOptions"
          :key="column.name"
          class="index-column-option grid min-h-8 grid-cols-[14px_20px_minmax(0,1fr)_auto] items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/50"
          :class="column.disabled ? 'cursor-not-allowed opacity-45' : selectedPositions.has(column.name) ? 'bg-accent/50 hover:bg-accent/80' : 'hover:bg-accent/40'"
          :data-selected="selectedPositions.has(column.name)"
          :title="column.name + (column.dataType ? ' (' + column.dataType + ')' : '')"
        >
          <input ref="optionInputs" type="checkbox" class="h-3.5 w-3.5 shrink-0 cursor-inherit accent-primary" :checked="selectedPositions.has(column.name)" :disabled="column.disabled" :aria-label="column.name" :data-index-column="column.name" @change="emit('toggle', column.name)" />
          <span class="text-center text-[10px] font-medium tabular-nums text-muted-foreground" aria-hidden="true">{{ selectedPositions.get(column.name) ?? "" }}</span>
          <span class="min-w-0 truncate font-mono" :class="{ 'font-medium': selectedPositions.has(column.name) }">{{ column.name }}</span>
          <span class="max-w-28 truncate text-right font-mono text-[10px] text-muted-foreground">
            <slot name="type" :column="column">{{ column.dataType }}</slot>
          </span>
        </label>
        <div v-if="!visibleOptions.length" class="px-3 py-7 text-center text-xs text-muted-foreground">{{ t("structureEditor.noMatchingIndexColumns") }}</div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.index-column-picker {
  max-height: min(400px, var(--reka-popover-content-available-height, 400px));
}

.index-column-options {
  max-height: 300px;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

.index-column-options::-webkit-scrollbar {
  width: 6px;
}

.index-column-options::-webkit-scrollbar-thumb {
  border-radius: 4px;
  background: var(--border);
}
</style>
