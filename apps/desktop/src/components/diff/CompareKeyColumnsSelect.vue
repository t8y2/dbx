<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { HTMLAttributes } from "vue";
import { CheckSquare, ChevronDown, Search, Square } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { filterDatabaseOptions } from "@/lib/database/databaseOptionSearch";
import { cn } from "@/lib/common/utils";
import type { CompareKeyColumnOption } from "@/lib/dataGrid/dataCompare";

/**
 * Searchable multi-select for database table columns, used to configure the
 * match columns (key columns) of one Data Compare task.
 *
 * It is deliberately read-only over the column metadata it receives: options
 * come from `getColumns`, so a user can only pick columns that really exist on
 * the table. Primary keys are labelled instead of pre-filtered, because a
 * composite unique key is a legitimate explicit choice.
 */
const props = withDefaults(
  defineProps<{
    /** Currently selected column names. */
    modelValue: string[];
    /** All columns of the table, in table order. */
    columns: CompareKeyColumnOption[];
    disabled?: boolean;
    /** Column metadata is still being fetched for this table. */
    loading?: boolean;
    /** Shown on the trigger when nothing is selected. */
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    /** Extra classes for the popover content, mirroring SearchableSelect. */
    contentClass?: HTMLAttributes["class"];
  }>(),
  {
    disabled: false,
    loading: false,
    placeholder: "",
    searchPlaceholder: "",
    emptyText: "",
  },
);

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const { t } = useI18n();
const open = ref(false);
const searchText = ref("");
const searchInput = ref<InstanceType<typeof Input>>();

const selectedSet = computed(() => new Set(props.modelValue.map((column) => column.toLowerCase())));
const columnNames = computed(() => props.columns.map((column) => column.name));
const filteredColumns = computed(() => {
  const allowed = new Set(filterDatabaseOptions(columnNames.value, searchText.value));
  return props.columns.filter((column) => allowed.has(column.name));
});
const selectedLabel = computed(() => props.modelValue.join(", "));
const selectedCountLabel = computed(() => t("dataCompare.keyColumnsSelectedCount", { selected: props.modelValue.length, total: props.columns.length }));

function isSelected(column: CompareKeyColumnOption): boolean {
  return selectedSet.value.has(column.name.toLowerCase());
}

function toggleColumn(column: CompareKeyColumnOption): void {
  if (props.disabled) return;
  const next = isSelected(column)
    ? props.modelValue.filter((name) => name.toLowerCase() !== column.name.toLowerCase())
    : // Append in click order so a composite key keeps the order the user picked.
      [...props.modelValue, column.name];
  emit("update:modelValue", next);
}

watch(open, async (value) => {
  if (!value) {
    searchText.value = "";
    return;
  }
  await nextTick();
  const input = searchInput.value?.$el as HTMLInputElement | undefined;
  input?.focus();
});
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        type="button"
        variant="outline"
        :disabled="disabled"
        :title="selectedLabel || placeholder"
        :class="
          cn(
            'dbx-compare-key-columns-trigger dbx-control-chrome h-8 w-full min-w-0 justify-between gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-xs font-normal shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50',
          )
        "
      >
        <span v-if="loading" class="truncate text-muted-foreground">{{ t("dataCompare.keyColumnsLoading") }}</span>
        <span v-else-if="selectedLabel" class="truncate font-mono">{{ selectedLabel }}</span>
        <span v-else class="truncate text-muted-foreground">{{ placeholder || t("dataCompare.keyColumnsSelectPlaceholder") }}</span>
        <ChevronDown class="h-3.5 w-3.5 shrink-0 opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" :class="cn('w-[var(--reka-popover-trigger-width)] min-w-56 max-w-[min(30rem,calc(100vw-1rem))] border-0 bg-transparent p-0 shadow-none ring-0', contentClass)">
      <div class="rounded-md border bg-popover p-1.5 shadow-md">
        <div class="relative rounded-md border bg-background">
          <Search class="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <span v-if="!searchText" class="pointer-events-none absolute left-[25px] top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {{ searchPlaceholder || t("dataCompare.keyColumnsSearch") }}
          </span>
          <Input ref="searchInput" :model-value="searchText" class="h-6 border-0 pl-6 pr-2 text-xs caret-foreground shadow-none focus-visible:ring-0" @update:model-value="(value) => (searchText = String(value))" @keydown.escape="open = false" />
        </div>
        <div class="dbx-compare-key-columns-list max-h-64 overflow-y-auto py-1">
          <div v-if="loading" class="px-2 py-2 text-xs text-muted-foreground">{{ t("dataCompare.keyColumnsLoading") }}</div>
          <template v-else-if="filteredColumns.length">
            <button
              v-for="column in filteredColumns"
              :key="column.name"
              type="button"
              :data-column-name="column.name"
              :data-primary-key="column.is_primary_key ? 'true' : 'false'"
              :disabled="disabled"
              class="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
              @click="toggleColumn(column)"
            >
              <CheckSquare v-if="isSelected(column)" class="h-3.5 w-3.5 shrink-0 text-primary" />
              <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
              <span class="min-w-0 flex-1 truncate font-mono">{{ column.name }}</span>
              <span v-if="column.is_primary_key" class="shrink-0 rounded bg-amber-500/15 px-1 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                {{ t("dataCompare.keyColumnsPrimaryKeyBadge") }}
              </span>
            </button>
          </template>
          <div v-else class="px-2 py-2 text-xs text-muted-foreground">
            {{ emptyText || t("dataCompare.keyColumnsEmpty") }}
          </div>
        </div>
        <div class="border-t px-2 pt-1.5 text-[11px] text-muted-foreground">{{ selectedCountLabel }}</div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style>
.dbx-compare-key-columns-list {
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklch, var(--foreground) 30%, transparent) transparent;
}

.dbx-compare-key-columns-list::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.dbx-compare-key-columns-list::-webkit-scrollbar-track {
  background: transparent;
}

.dbx-compare-key-columns-list::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  background-clip: padding-box;
}

.dbx-compare-key-columns-list:hover::-webkit-scrollbar-thumb {
  border: 0;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}

.dark .dbx-compare-key-columns-list {
  scrollbar-color: rgb(82, 82, 91) transparent;
}

.dark .dbx-compare-key-columns-list::-webkit-scrollbar-thumb {
  background: rgb(82, 82, 91);
  background-clip: padding-box;
}

.dark .dbx-compare-key-columns-list:hover::-webkit-scrollbar-thumb {
  background: rgb(113, 113, 122);
}
</style>
