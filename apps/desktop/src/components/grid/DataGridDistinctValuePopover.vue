<script setup lang="ts">
import { computed } from "vue";
import { Check, Database, Loader2, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";

const props = defineProps<{
  open: boolean;
  search: string;
  options: DataGridLocalFilterOption[];
  loading: boolean;
  error: string;
  limited: boolean;
  limit: number;
  multiple?: boolean;
  selectedKeys?: Set<string>;
  disabled?: boolean;
  compact?: boolean;
}>();

const emit = defineEmits<{
  "update:open": [open: boolean];
  "update:search": [search: string];
  select: [option: DataGridLocalFilterOption];
  toggle: [option: DataGridLocalFilterOption];
  toggleAll: [];
  apply: [];
}>();

const { t } = useI18n();
const allOptionsSelected = computed(() => props.options.length > 0 && props.options.every((option) => props.selectedKeys?.has(option.key)));
</script>

<template>
  <Popover :open="props.open" @update:open="emit('update:open', $event)">
    <PopoverTrigger as-child>
      <Button variant="outline" size="icon" class="shrink-0" :class="props.compact ? 'h-6 w-6 rounded-none border-0 bg-transparent shadow-none' : 'h-7 w-7'" :disabled="props.disabled" :title="t('grid.databaseValueFilter')" :aria-label="t('grid.databaseValueFilter')">
        <Database class="h-3.5 w-3.5" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" side="bottom" class="w-80 gap-0 overflow-hidden p-0" @keydown.stop>
      <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          :value="props.search"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          :placeholder="t('grid.searchValues')"
          @input="emit('update:search', ($event.target as HTMLInputElement).value)"
        />
      </div>
      <div class="grid border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground" :class="props.multiple ? 'grid-cols-[1.75rem_minmax(0,1fr)_3.5rem]' : 'grid-cols-[minmax(0,1fr)_3.5rem]'">
        <button
          v-if="props.multiple"
          type="button"
          data-distinct-value-select-all
          role="checkbox"
          class="flex h-4 w-4 items-center justify-center rounded border"
          :class="allOptionsSelected ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'"
          :disabled="!props.options.length"
          :aria-checked="allOptionsSelected"
          @click="emit('toggleAll')"
        >
          <Check v-if="allOptionsSelected" class="h-3 w-3 stroke-[3]" />
        </button>
        <span>{{ t("grid.value") }}</span>
        <span class="text-right">{{ t("grid.count") }}</span>
      </div>
      <div v-if="props.loading || props.error || props.limited" class="flex items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
        <Loader2 v-if="props.loading" class="h-3 w-3 animate-spin" />
        <span class="min-w-0 truncate">
          <template v-if="props.loading">{{ t("grid.loadingValues") }}</template>
          <template v-else-if="props.error">{{ props.error }}</template>
          <template v-else>{{ t("grid.serverValuesLimited", { count: props.limit }) }}</template>
        </span>
      </div>
      <div class="max-h-72 overflow-auto py-0.5">
        <button
          v-for="option in props.options"
          :key="option.key"
          type="button"
          class="grid w-full items-center px-2 py-1 text-left text-xs hover:bg-accent"
          :class="props.multiple ? 'grid-cols-[1.75rem_minmax(0,1fr)_3.5rem]' : 'grid-cols-[minmax(0,1fr)_3.5rem]'"
          @click="props.multiple ? emit('toggle', option) : emit('select', option)"
        >
          <span v-if="props.multiple" class="flex h-4 w-4 items-center justify-center rounded border" :class="props.selectedKeys?.has(option.key) ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'">
            <Check v-if="props.selectedKeys?.has(option.key)" class="h-3 w-3 stroke-[3]" />
          </span>
          <span class="truncate font-mono">{{ option.label }}</span>
          <span class="text-right text-xs tabular-nums text-muted-foreground">{{ option.count ?? "" }}</span>
        </button>
        <div v-if="!props.options.length && !props.loading && !props.error" class="px-2 py-6 text-center text-xs text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
      </div>
      <div v-if="props.multiple" class="flex justify-end gap-2 border-t bg-muted/40 px-2 py-1.5">
        <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="emit('update:open', false)">
          {{ t("dangerDialog.cancel") }}
        </Button>
        <Button size="sm" class="h-7 px-2 text-xs" @click="emit('apply')">{{ t("grid.applyFilter") }}</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>
