<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { Eye, EyeOff, Plus, Search, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { filterModeNeedsValue, filterModeUsesList, filterModeUsesRange } from "@/lib/dataGrid/dataGridColumnFilter";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";

const { t } = useI18n();
const props = withDefaults(
  defineProps<{
    rules: DataGridStructuredFilterRule[];
    columns: string[];
    filteredColumns: string[];
    modeOptions: Array<{ value: DataGridContextFilterMode; labelKey: string }>;
    columnSearch: string;
    disabled?: boolean;
    showHeader?: boolean;
    showFooter?: boolean;
  }>(),
  { showHeader: true, showFooter: true },
);
const emit = defineEmits<{
  add: [];
  apply: [];
  reset: [];
  clear: [];
  remove: [id: string];
  updateRule: [id: string, patch: Partial<DataGridStructuredFilterRule>];
  "update:columnSearch": [value: string];
}>();
const columnSearchInputs = new Map<string, HTMLInputElement>();
const filterRuleElements = new Map<string, HTMLElement>();
const pendingValueFocus = new Set<string>();
const pendingKeyboardAddFocus = new Set<string>();
const openColumnSelectIds = ref(new Set<string>());
const activeColumnIndexes = ref<Record<string, number>>({});
let ruleIdsBeforeKeyboardAdd: Set<string> | undefined;

function usesExpandedLayout(mode: DataGridContextFilterMode) {
  return filterModeUsesList(mode) || filterModeUsesRange(mode);
}

function updateRuleColumn(rule: DataGridStructuredFilterRule, value: unknown, focusValue = true) {
  if (focusValue && filterModeNeedsValue(rule.mode)) pendingValueFocus.add(rule.id);
  emit("updateRule", rule.id, { columnName: String(value) });
  emit("update:columnSearch", "");
}

function setColumnSearchInput(id: string, element: unknown) {
  if (!(element instanceof HTMLInputElement)) {
    columnSearchInputs.delete(id);
    return;
  }
  columnSearchInputs.set(id, element);
  if (openColumnSelectIds.value.has(id)) window.requestAnimationFrame(() => element.focus());
}

function setFilterRuleElement(id: string, element: unknown) {
  if (element instanceof HTMLElement) filterRuleElements.set(id, element);
  else filterRuleElements.delete(id);
}

function activeColumnIndex(id: string): number {
  return activeColumnIndexes.value[id] ?? -1;
}

function setActiveColumnIndex(id: string, index: number) {
  const count = props.filteredColumns.length;
  const nextIndex = count ? ((index % count) + count) % count : -1;
  activeColumnIndexes.value = { ...activeColumnIndexes.value, [id]: nextIndex };
  window.requestAnimationFrame(() => {
    const listbox = columnSearchInputs.get(id)?.closest('[role="listbox"]');
    listbox?.querySelectorAll<HTMLElement>('[role="option"]')[nextIndex]?.scrollIntoView?.({ block: "nearest" });
  });
}

function setColumnSelectOpen(id: string, open: boolean) {
  const next = new Set(openColumnSelectIds.value);
  if (open) {
    next.clear();
    next.add(id);
  } else {
    next.delete(id);
  }
  openColumnSelectIds.value = next;
}

async function handleColumnSelectOpen(rule: DataGridStructuredFilterRule, open: boolean) {
  setColumnSelectOpen(rule.id, open);
  if (!open) return;
  const selectedIndex = props.filteredColumns.indexOf(rule.columnName);
  setActiveColumnIndex(rule.id, selectedIndex >= 0 ? selectedIndex : 0);
  await nextTick();
  window.requestAnimationFrame(() => columnSearchInputs.get(rule.id)?.focus());
}

function handleColumnCloseAutoFocus(id: string, event: Event) {
  if (pendingKeyboardAddFocus.delete(id)) {
    event.preventDefault();
    return;
  }
  if (!pendingValueFocus.delete(id)) return;
  event.preventDefault();
  void focusFilterRuleValue(id);
}

async function focusFilterRuleValue(id: string) {
  await nextTick();
  window.requestAnimationFrame(() => filterRuleElements.get(id)?.querySelector<HTMLElement>("[data-filter-value-editor]")?.focus());
}

function updateColumnSearch(id: string, event: Event) {
  emit("update:columnSearch", (event.target as HTMLInputElement).value);
  setActiveColumnIndex(id, 0);
}

function addRuleAndOpenColumnSelect() {
  ruleIdsBeforeKeyboardAdd = new Set(props.rules.map((item) => item.id));
  emit("add");
}

function selectActiveColumn(rule: DataGridStructuredFilterRule, addAnother: boolean) {
  const column = props.filteredColumns[activeColumnIndex(rule.id)];
  if (!column) return;
  updateRuleColumn(rule, column, !addAnother);
  if (addAnother) pendingKeyboardAddFocus.add(rule.id);
  setColumnSelectOpen(rule.id, false);
  if (!addAnother) return;
  addRuleAndOpenColumnSelect();
}

function moveColumnSearchCaret(event: KeyboardEvent) {
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  const input = event.currentTarget as HTMLInputElement;
  if (typeof input.setSelectionRange !== "function") return;
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  const nextPosition = event.key === "ArrowLeft" ? (start === end ? Math.max(0, start - 1) : start) : start === end ? Math.min(input.value.length, end + 1) : end;
  event.preventDefault();
  event.stopPropagation();
  input.setSelectionRange(nextPosition, nextPosition);
}

watch(
  () => props.rules,
  (rules) => {
    if (!ruleIdsBeforeKeyboardAdd) return;
    const addedRule = rules.find((item) => !ruleIdsBeforeKeyboardAdd?.has(item.id));
    ruleIdsBeforeKeyboardAdd = undefined;
    if (addedRule) void handleColumnSelectOpen(addedRule, true);
  },
);

function handleColumnSearchKeydown(event: KeyboardEvent, rule: DataGridStructuredFilterRule) {
  if (event.isComposing || event.key === "Process") {
    event.stopPropagation();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    setActiveColumnIndex(rule.id, activeColumnIndex(rule.id) + (event.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    selectActiveColumn(rule, event.shiftKey);
    return;
  }
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    moveColumnSearchCaret(event);
    return;
  }
  if (["Escape", "Tab"].includes(event.key)) return;
  if (["Home", "End", "PageUp", "PageDown"].includes(event.key)) {
    event.stopPropagation();
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) event.stopPropagation();
}

function handleValueEditorKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  if (!event.shiftKey) {
    emit("apply");
    return;
  }
  event.stopPropagation();
  if (!event.repeat) addRuleAndOpenColumnSelect();
}
</script>

<template>
  <div class="space-y-3">
    <div v-if="props.showHeader !== false" class="flex items-center justify-between gap-3">
      <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="props.disabled || !props.columns.length" @click="emit('add')"> <Plus class="mr-1 h-3.5 w-3.5" />{{ t("grid.filterBuilderAddRule") }} </Button>
    </div>

    <div v-if="props.rules.length" class="space-y-2">
      <template v-for="(rule, index) in props.rules" :key="rule.id">
        <div v-if="index > 0" class="flex justify-center">
          <Button variant="ghost" size="sm" class="h-6 px-2 text-[11px]" @click="emit('updateRule', rule.id, { conjunction: rule.conjunction === 'AND' ? 'OR' : 'AND' })">{{ rule.conjunction }}</Button>
        </div>
        <div :ref="(element) => setFilterRuleElement(rule.id, element)" class="grid items-center gap-2" :class="usesExpandedLayout(rule.mode) ? 'grid-cols-[minmax(0,1fr)_80px_auto]' : 'grid-cols-[minmax(0,1fr)_80px_minmax(0,1fr)_auto]'">
          <Select :model-value="rule.columnName" :open="openColumnSelectIds.has(rule.id)" :disabled="rule.disabled" @update:model-value="(value: any) => updateRuleColumn(rule, value)" @update:open="(open: boolean) => handleColumnSelectOpen(rule, open)">
            <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
              <SelectValue v-if="rule.columnName">{{ rule.columnName }}</SelectValue>
              <SelectValue v-else :placeholder="t('grid.filterBuilderColumn')" />
            </SelectTrigger>
            <SelectContent position="popper" class="max-h-72" :hide-scroll-buttons="true" @close-auto-focus="(event: Event) => handleColumnCloseAutoFocus(rule.id, event)">
              <SelectItem
                v-for="(column, columnIndex) in props.filteredColumns"
                :key="column"
                :value="column"
                class="rounded-none"
                :class="activeColumnIndex(rule.id) === columnIndex ? 'bg-accent text-accent-foreground' : ''"
                :data-filter-active="activeColumnIndex(rule.id) === columnIndex ? '' : undefined"
                @pointermove="setActiveColumnIndex(rule.id, columnIndex)"
              >
                {{ column }}
              </SelectItem>
              <div v-if="!props.filteredColumns.length" class="px-2 py-2 text-xs text-muted-foreground">{{ t("grid.filterBuilderNoMatchingColumns") }}</div>
              <div class="sticky bottom-0 mt-1 flex items-center gap-1.5 border-t bg-popover px-2 py-1.5">
                <Search class="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  :ref="(element) => setColumnSearchInput(rule.id, element)"
                  :value="props.columnSearch"
                  class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
                  :placeholder="t('grid.filterBuilderSearchColumns')"
                  @input="updateColumnSearch(rule.id, $event)"
                  @click.stop
                  @keydown="handleColumnSearchKeydown($event, rule)"
                  @pointerdown.stop
                />
              </div>
            </SelectContent>
          </Select>
          <Select :model-value="rule.mode" :disabled="rule.disabled" @update:model-value="(value: any) => emit('updateRule', rule.id, { mode: value as DataGridContextFilterMode })">
            <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate"><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem v-for="option in props.modeOptions" :key="option.value" :value="option.value" class="rounded-none">{{ t(option.labelKey) }}</SelectItem></SelectContent
            >
          </Select>
          <div v-if="filterModeUsesRange(rule.mode)" class="col-span-2 flex gap-2">
            <Input
              data-filter-value-editor
              :model-value="rule.rawValue"
              class="h-8 text-xs"
              :disabled="rule.disabled"
              :placeholder="t('grid.filterBuilderRangeStart')"
              @update:model-value="(value) => emit('updateRule', rule.id, { rawValue: String(value ?? '') })"
              @keydown="handleValueEditorKeydown"
            />
            <Input :model-value="rule.rawEndValue" class="h-8 text-xs" :disabled="rule.disabled" :placeholder="t('grid.filterBuilderRangeEnd')" @update:model-value="(value) => emit('updateRule', rule.id, { rawEndValue: String(value ?? '') })" @keydown="handleValueEditorKeydown" />
          </div>
          <textarea
            v-else-if="filterModeUsesList(rule.mode)"
            data-filter-value-editor
            :value="rule.rawValue"
            rows="2"
            class="col-span-2 min-h-14 resize-y rounded-md border bg-transparent px-2.5 py-1 text-xs outline-none"
            :disabled="rule.disabled"
            :placeholder="t('grid.filterBuilderValues')"
            @input="emit('updateRule', rule.id, { rawValue: ($event.target as HTMLTextAreaElement).value })"
            @keydown.ctrl.enter.prevent="emit('apply')"
            @keydown.meta.enter.prevent="emit('apply')"
          />
          <Input
            v-else-if="filterModeNeedsValue(rule.mode)"
            data-filter-value-editor
            :model-value="rule.rawValue"
            class="h-8 text-xs"
            :disabled="rule.disabled"
            :placeholder="t('grid.filterBuilderValue')"
            @update:model-value="(value) => emit('updateRule', rule.id, { rawValue: String(value ?? '') })"
            @keydown="handleValueEditorKeydown"
          />
          <div v-else class="flex h-8 items-center rounded-md border border-dashed px-2 text-xs text-muted-foreground">{{ t("grid.filterBuilderNoValue") }}</div>
          <div class="flex items-center gap-1" :class="usesExpandedLayout(rule.mode) ? 'col-start-3 row-start-1 row-span-2' : ''">
            <Button variant="ghost" size="icon" class="h-8 w-8" @click="emit('updateRule', rule.id, { disabled: !rule.disabled })"><EyeOff v-if="rule.disabled" class="h-3.5 w-3.5" /><Eye v-else class="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" class="h-8 w-8" :disabled="props.rules.length === 1" @click="emit('remove', rule.id)"><Trash2 class="h-3.5 w-3.5" /></Button>
          </div>
        </div>
      </template>
    </div>
    <div v-else class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">{{ t("grid.filterBuilderEmpty") }}</div>
    <div v-if="props.showFooter !== false" class="flex justify-between gap-2 pt-1">
      <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="emit('clear')">{{ t("grid.clearFilter") }}</Button>
      <div class="flex gap-2">
        <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="emit('reset')">{{ t("grid.resetFilterBuilder") }}</Button
        ><Button size="sm" class="h-8 px-3 text-xs" :disabled="props.disabled" @click="emit('apply')">{{ t("grid.applyFilter") }}</Button>
      </div>
    </div>
  </div>
</template>
