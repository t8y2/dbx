<script setup lang="ts">
import { Check, Database, Filter, Loader2, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DataGridLocalFilterOption } from "@/lib/dataGrid/dataGridLocalColumnFilterState";

type LocalFilterMode = "local" | "server";

interface DataGridColumnFilterPopoverProps {
  open: boolean;
  compactHeaderActions: boolean;
  canUseServerFilter: boolean;
  active: boolean;
  serverModeActive: boolean;
  panelTitle: string;
  search: string;
  popoverWidth: number;
  popoverOffsetX: number;
  draftMode?: LocalFilterMode;
  draftValues?: Set<string>;
  options: DataGridLocalFilterOption[];
  allOptionsCount: number;
  canApplyTypedValue: boolean;
  typedValue: string;
  serverLoading: boolean;
  serverError: string;
  serverLimited: boolean;
  serverValueLimit: number;
}

const props = defineProps<DataGridColumnFilterPopoverProps>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:search": [value: string];
  resizeStart: [event: MouseEvent, direction: "left" | "right"];
  toggleAll: [];
  toggleValue: [key: string];
  applyTypedValue: [];
  clear: [];
  close: [];
  apply: [];
  openServerFilter: [];
}>();

const { t } = useI18n();
</script>

<template>
  <Popover :open="props.open" @update:open="emit('update:open', $event)">
    <PopoverAnchor v-if="props.compactHeaderActions" as-child>
      <span class="pointer-events-none absolute right-3 top-1/2 h-px w-px -translate-y-1/2" />
    </PopoverAnchor>
    <PopoverTrigger v-else as-child>
      <button type="button" class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground" :class="props.active ? 'text-primary opacity-100' : 'opacity-80'" :title="t('grid.localFilter')" @click.stop>
        <Filter class="h-3.5 w-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" side="bottom" class="relative max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" :style="{ width: `${props.popoverWidth}px`, marginLeft: `${props.popoverOffsetX}px` }" @click.stop @keydown.stop>
      <div role="separator" aria-orientation="vertical" aria-label="Resize filter panel" class="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="emit('resizeStart', $event, 'left')" />
      <div role="separator" aria-orientation="vertical" aria-label="Resize filter panel" class="absolute right-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="emit('resizeStart', $event, 'right')" />
      <div class="border-b bg-muted/40 px-2 py-1.5 text-center text-xs font-semibold">
        {{ props.panelTitle }}
      </div>
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
      <div class="grid grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground">
        <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded border"
          :class="props.options.length > 0 && props.draftValues && props.options.every((option) => props.draftValues?.has(option.key)) ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'"
          @click="emit('toggleAll')"
        >
          <Check v-if="props.options.length > 0 && props.draftValues && props.options.every((option) => props.draftValues?.has(option.key))" class="h-3 w-3 stroke-[3]" />
        </button>
        <span>{{ t("grid.value") }}</span>
        <span class="text-right">{{ t("grid.count") }}</span>
      </div>
      <div v-if="props.draftMode === 'server' && (props.serverLoading || props.serverError || props.serverLimited)" class="flex items-center gap-1.5 border-b px-2 py-1 text-[11px] text-muted-foreground">
        <Loader2 v-if="props.serverLoading" class="h-3 w-3 animate-spin" />
        <span class="min-w-0 truncate">
          <template v-if="props.serverLoading">{{ t("grid.loadingValues") }}</template>
          <template v-else-if="props.serverError">{{ props.serverError }}</template>
          <template v-else>{{ t("grid.serverValuesLimited", { count: props.serverValueLimit }) }}</template>
        </span>
      </div>
      <div class="max-h-72 overflow-auto py-0.5">
        <button v-for="option in props.options" :key="option.key" type="button" class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)_3.5rem] items-center px-2 py-1 text-left text-xs hover:bg-accent" @click="emit('toggleValue', option.key)">
          <span class="flex h-4 w-4 items-center justify-center rounded border" :class="props.draftValues?.has(option.key) ? 'border-blue-600 bg-blue-600 text-white' : 'border-border bg-background text-foreground/70'">
            <Check v-if="props.draftValues?.has(option.key)" class="h-3 w-3 stroke-[3]" />
          </span>
          <span class="truncate font-mono" :class="{ 'italic text-muted-foreground': option.value === null }">
            {{ option.label }}
          </span>
          <span class="text-right tabular-nums text-muted-foreground text-xs">{{ option.count ?? "" }}</span>
        </button>
        <div v-if="props.draftMode === 'local' && props.allOptionsCount > props.options.length" class="px-2 py-0.5 text-center text-[10px] text-muted-foreground">
          {{ t("grid.moreValues", { count: props.allOptionsCount - props.options.length }) }}
        </div>
        <button v-if="props.canApplyTypedValue" type="button" class="grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs text-primary hover:bg-accent" @click="emit('applyTypedValue')">
          <Search class="h-3.5 w-3.5" />
          <span class="truncate font-mono">{{ t("grid.filterTypedValue", { value: props.typedValue }) }}</span>
        </button>
        <div v-if="props.options.length === 0 && !props.canApplyTypedValue && !props.serverLoading" class="px-2 py-6 text-center text-xs text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
      </div>
      <div class="flex items-center justify-between gap-2 border-t bg-muted/40 px-2 py-1.5">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('clear')">
          {{ t("grid.clearFilter") }}
        </Button>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="emit('close')">
            {{ t("dangerDialog.cancel") }}
          </Button>
          <Button size="sm" class="h-7 px-2 text-xs" @click="emit('apply')">
            {{ t("grid.applyFilter") }}
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
  <button
    v-if="!props.compactHeaderActions && props.canUseServerFilter"
    type="button"
    class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-800 hover:text-foreground"
    :class="props.serverModeActive ? 'text-primary opacity-100' : 'opacity-80'"
    :title="t('grid.databaseValueFilter')"
    @click.stop="emit('openServerFilter')"
  >
    <Database class="h-3.5 w-3.5" />
  </button>
</template>
