<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckSquare, Square } from "@lucide/vue";
import { filterTableNames, isEveryFilteredSelected, toggleSelectFiltered, toggleTableName } from "@/lib/diff/tableMultiSelect";

/**
 * Shared, searchable multi-select for a set of table names. Used by both Data
 * Compare and Schema Diff. It only knows about "a list of table names to
 * multi-select" — no connection/database/diff-engine concepts.
 */
const props = withDefaults(
  defineProps<{
    /** All available table names. */
    tables: string[];
    /** Currently selected table names (v-model). */
    modelValue: string[];
    /** Optional header label; falls back to `tableMultiSelect.tables`. */
    title?: string;
    /** Show the search box (only rendered when there are more than 5 tables). */
    searchable?: boolean;
    /** Text shown when `tables` is empty. */
    emptyText?: string;
    disabled?: boolean;
  }>(),
  {
    title: "",
    searchable: true,
    emptyText: "",
    disabled: false,
  },
);

const emit = defineEmits<{ (e: "update:modelValue", value: string[]): void }>();

const { t } = useI18n();
const search = ref("");

const filteredTables = computed(() => filterTableNames(props.tables, search.value));
const selectedSet = computed(() => new Set(props.modelValue));
const allFilteredSelected = computed(() => isEveryFilteredSelected(props.modelValue, filteredTables.value));
const showSearch = computed(() => props.searchable && props.tables.length > 5);

function toggle(table: string) {
  if (props.disabled) return;
  emit("update:modelValue", toggleTableName(props.modelValue, table));
}

function toggleSelectAll() {
  if (props.disabled) return;
  emit("update:modelValue", toggleSelectFiltered(props.modelValue, filteredTables.value));
}
</script>

<template>
  <div class="space-y-2 rounded-lg border p-2">
    <div class="flex items-center justify-between gap-2">
      <Label class="text-xs font-medium">{{ title || t("tableMultiSelect.tables") }}</Label>
      <div v-if="tables.length" class="text-[11px] text-muted-foreground">
        {{ t("tableMultiSelect.selected", { selected: modelValue.length, total: tables.length }) }}
      </div>
    </div>

    <Input v-if="showSearch" v-model="search" class="h-7 text-xs" :placeholder="t('tableMultiSelect.search')" :disabled="disabled" />

    <div class="flex items-center gap-2">
      <Button v-if="tables.length" variant="outline" size="sm" class="h-7 px-2 text-xs" :disabled="disabled" @click="toggleSelectAll">
        {{ allFilteredSelected ? t("tableMultiSelect.deselectAll") : t("tableMultiSelect.selectAll") }}
      </Button>
    </div>

    <div v-if="tables.length === 0" class="py-3 text-center text-xs text-muted-foreground">
      {{ emptyText || t("tableMultiSelect.noTables") }}
    </div>
    <div v-else class="max-h-40 overflow-auto rounded border">
      <button v-for="table in filteredTables" :key="table" type="button" :disabled="disabled" class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50 disabled:opacity-50" @click="toggle(table)">
        <CheckSquare v-if="selectedSet.has(table)" class="h-3.5 w-3.5 shrink-0 text-primary" />
        <Square v-else class="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
        <span class="truncate">{{ table }}</span>
      </button>
    </div>
  </div>
</template>
