<script setup lang="ts">
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

function usesExpandedLayout(mode: DataGridContextFilterMode) {
  return filterModeUsesList(mode) || filterModeUsesRange(mode);
}

function updateRuleColumn(id: string, value: unknown) {
  emit("updateRule", id, { columnName: String(value) });
  emit("update:columnSearch", "");
}

function handleColumnSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key === "Process") {
    event.stopPropagation();
    return;
  }
  if (["Escape", "Tab", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || event.key === "Backspace" || event.key === "Delete")) event.stopPropagation();
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
        <div class="grid items-center gap-2" :class="usesExpandedLayout(rule.mode) ? 'grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto]'">
          <Select :model-value="rule.columnName" :disabled="rule.disabled" @update:model-value="(value: any) => updateRuleColumn(rule.id, value)">
            <SelectTrigger class="h-8 min-w-0 text-xs"><SelectValue :placeholder="t('grid.filterBuilderColumn')" /></SelectTrigger>
            <SelectContent position="popper" class="max-h-72" :hide-scroll-buttons="true">
              <SelectItem v-for="column in props.filteredColumns" :key="column" :value="column">{{ column }}</SelectItem>
              <div v-if="!props.filteredColumns.length" class="px-2 py-2 text-xs text-muted-foreground">{{ t("grid.filterBuilderNoMatchingColumns") }}</div>
              <div class="sticky bottom-0 mt-1 flex items-center gap-1.5 border-t bg-popover px-2 py-1.5">
                <Search class="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  :value="props.columnSearch"
                  class="h-7 min-w-0 flex-1 bg-transparent text-xs outline-none"
                  :placeholder="t('grid.filterBuilderSearchColumns')"
                  @input="emit('update:columnSearch', ($event.target as HTMLInputElement).value)"
                  @click.stop
                  @keydown="handleColumnSearchKeydown"
                  @pointerdown.stop
                />
              </div>
            </SelectContent>
          </Select>
          <Select :model-value="rule.mode" :disabled="rule.disabled" @update:model-value="(value: any) => emit('updateRule', rule.id, { mode: value as DataGridContextFilterMode })">
            <SelectTrigger class="h-8 min-w-0 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem v-for="option in props.modeOptions" :key="option.value" :value="option.value">{{ t(option.labelKey) }}</SelectItem></SelectContent
            >
          </Select>
          <div v-if="filterModeUsesRange(rule.mode)" class="col-span-2 flex gap-2">
            <Input :model-value="rule.rawValue" class="h-8 text-xs" :disabled="rule.disabled" :placeholder="t('grid.filterBuilderRangeStart')" @update:model-value="(value) => emit('updateRule', rule.id, { rawValue: String(value ?? '') })" @keydown.enter.prevent="emit('apply')" />
            <Input :model-value="rule.rawEndValue" class="h-8 text-xs" :disabled="rule.disabled" :placeholder="t('grid.filterBuilderRangeEnd')" @update:model-value="(value) => emit('updateRule', rule.id, { rawEndValue: String(value ?? '') })" @keydown.enter.prevent="emit('apply')" />
          </div>
          <textarea
            v-else-if="filterModeUsesList(rule.mode)"
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
            :model-value="rule.rawValue"
            class="h-8 text-xs"
            :disabled="rule.disabled"
            :placeholder="t('grid.filterBuilderValue')"
            @update:model-value="(value) => emit('updateRule', rule.id, { rawValue: String(value ?? '') })"
            @keydown.enter.prevent="emit('apply')"
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
