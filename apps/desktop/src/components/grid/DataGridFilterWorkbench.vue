<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { Check, Code2, Copy, Filter, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import DataGridConditionEditor from "@/components/grid/DataGridConditionEditor.vue";
import DataGridFilterBuilder from "@/components/grid/DataGridFilterBuilder.vue";
import type { DataGridConditionColumnOption } from "@/composables/useDataGridConditionEditor";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import type { DataGridFilterEditorView } from "@/lib/dataGrid/dataGridFilterBuilderPersistence";

const props = defineProps<{
  whereInput: string;
  sqlPreview: string;
  rules: DataGridStructuredFilterRule[];
  columns: string[];
  filteredColumns: string[];
  modeOptions: Array<{ value: DataGridContextFilterMode; labelKey: string }>;
  columnSearch: string;
  conditionColumns: readonly DataGridConditionColumnOption[];
  identifierQuote?: string;
  historyScope: DataGridConditionHistoryScope;
  activeRuleCount: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:whereInput": [value: string];
  "update:columnSearch": [value: string];
  "update:view": [view: DataGridFilterEditorView];
  ensureRule: [];
  addRule: [];
  apply: [];
  reset: [];
  clear: [];
  copySql: [];
  removeRule: [id: string];
  updateRule: [id: string, patch: Partial<DataGridStructuredFilterRule>];
}>();

const { t } = useI18n();
const filterBuilderRef = ref<InstanceType<typeof DataGridFilterBuilder>>();
const previewText = computed(() => props.sqlPreview || t("grid.filterSqlPreviewEmpty"));

async function focusFirstRule() {
  emit("ensureRule");
  await nextTick();
  await filterBuilderRef.value?.openFirstEmptyRuleColumnSearch();
}

async function applyManualWhere(value?: string) {
  if (value !== undefined) emit("update:whereInput", value);
  await nextTick();
  emit("apply");
  return true;
}

onMounted(() => void focusFirstRule());
</script>

<template>
  <section data-grid-filter-workbench class="shrink-0 border-b bg-muted/10 text-foreground">
    <header class="flex h-8 min-w-0 items-center gap-2 border-b px-2">
      <Filter class="h-3.5 w-3.5 shrink-0 text-primary" />
      <span class="shrink-0 text-xs font-medium">{{ t("grid.filterConditionPanel") }}</span>
      <span v-if="activeRuleCount" class="rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary">{{ t("grid.filterBuilderSummary", { count: activeRuleCount }) }}</span>
      <span class="flex-1" />
      <div class="flex h-6 items-center border bg-background p-0.5" role="group" :aria-label="t('grid.filterView')">
        <button type="button" class="flex h-5 items-center gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground" @click="emit('update:view', 'quick')"><Code2 class="h-3 w-3" />{{ t("grid.filterQuickView") }}</button>
        <button type="button" class="flex h-5 items-center gap-1 bg-accent px-2 text-[11px] font-medium text-accent-foreground" aria-pressed="true"><Filter class="h-3 w-3" />{{ t("grid.filterConditionView") }}</button>
      </div>
      <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" :aria-label="t('grid.clearFilter')" @click="emit('clear')">
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
    </header>

    <div class="filter-workbench-body grid max-h-[300px] min-h-[132px] grid-cols-[minmax(520px,2fr)_minmax(280px,1fr)] overflow-auto">
      <div class="min-w-0 px-3 py-2">
        <DataGridFilterBuilder
          ref="filterBuilderRef"
          :rules="rules"
          :columns="columns"
          :filtered-columns="filteredColumns"
          :mode-options="modeOptions"
          :column-search="columnSearch"
          :disabled="disabled"
          layout="panel"
          :show-header="false"
          @add="emit('addRule')"
          @apply="emit('apply')"
          @reset="emit('reset')"
          @clear="emit('clear')"
          @remove="emit('removeRule', $event)"
          @update-rule="(id, patch) => emit('updateRule', id, patch)"
          @update:column-search="emit('update:columnSearch', $event)"
        />
      </div>

      <aside class="min-w-[280px] border-l bg-background/45 px-3 py-2">
        <div class="mb-1 text-[11px] font-medium text-muted-foreground">{{ t("grid.filterManualWhere") }}</div>
        <div class="mb-2 min-h-7 rounded border bg-background px-1.5 py-0.5">
          <DataGridConditionEditor
            :model-value="whereInput"
            kind="where"
            :columns="conditionColumns"
            :identifier-quote="identifierQuote"
            :history-scope="historyScope"
            placeholder="WHERE"
            :history-empty-text="t('grid.conditionHistoryEmpty')"
            :history-no-matches-text="t('grid.conditionHistoryNoMatches')"
            :disabled="disabled"
            compact
            :apply="applyManualWhere"
            :clear="() => emit('update:whereInput', '')"
            @update:model-value="emit('update:whereInput', $event)"
          />
        </div>
        <div class="mb-1 flex items-center justify-between gap-2">
          <span class="text-[11px] font-medium text-muted-foreground">{{ t("grid.filterSqlPreview") }}</span>
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!sqlPreview" :aria-label="t('grid.copyFilterSql')" @click="emit('copySql')"><Copy class="h-3 w-3" /></Button>
        </div>
        <pre class="max-h-16 min-h-10 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/35 px-2 py-1.5 font-mono text-[11px] leading-4" :class="sqlPreview ? 'text-foreground' : 'text-muted-foreground'">{{ previewText }}</pre>
        <div v-if="sqlPreview" class="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground"><Check class="h-3 w-3 text-primary" />{{ t("grid.filterSqlPreviewReady") }}</div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
section {
  container-type: inline-size;
}

@container (max-width: 840px) {
  .filter-workbench-body {
    grid-template-columns: minmax(520px, 1fr);
  }

  .filter-workbench-body > aside {
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}
</style>
