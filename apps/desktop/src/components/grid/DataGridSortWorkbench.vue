<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { Copy, Plus, RotateCcw, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import DataGridSortBuilder from "@/components/grid/DataGridSortBuilder.vue";
import type { DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";

const props = defineProps<{
  sqlPreview: string;
  rules: readonly DataGridStructuredSortRule[];
  columns: readonly string[];
  commentByColumn?: ReadonlyMap<string, string>;
  busy?: boolean;
  applyOnlyBusy?: boolean;
}>();

const emit = defineEmits<{
  addRule: [];
  removeRule: [id: string];
  moveRule: [id: string, targetIndex: number];
  updateRule: [id: string, patch: Partial<DataGridStructuredSortRule>];
  applyOnly: [id: string];
  apply: [];
  reset: [];
  clear: [];
  copySql: [];
}>();

const { t } = useI18n();
const rulesScrollerRef = ref<HTMLElement>();
const previewText = computed(() => props.sqlPreview || t("grid.sortSqlPreviewEmpty"));

watch(
  () => props.rules.length,
  async (ruleCount, previousRuleCount) => {
    if (ruleCount <= previousRuleCount) return;
    await nextTick();
    window.requestAnimationFrame(() => {
      const scroller = rulesScrollerRef.value;
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
  },
);
</script>

<template>
  <section data-grid-sort-workbench class="shrink-0 border-b bg-muted/10 text-foreground">
    <div ref="rulesScrollerRef" data-sort-rules-scroll class="sort-rules-scroll min-h-11 overflow-auto px-3 py-2">
      <DataGridSortBuilder
        class="min-w-[460px]"
        :rules="rules"
        :columns="columns"
        :comment-by-column="commentByColumn"
        :busy="busy"
        :apply-only-busy="applyOnlyBusy"
        layout="panel"
        :show-header="false"
        :show-footer="false"
        @add="emit('addRule')"
        @remove="emit('removeRule', $event)"
        @move="(id, targetIndex) => emit('moveRule', id, targetIndex)"
        @update-rule="(id, patch) => emit('updateRule', id, patch)"
        @apply-only="emit('applyOnly', $event)"
        @reset="emit('reset')"
        @clear="emit('clear')"
        @apply="emit('apply')"
      />
    </div>

    <footer class="flex min-w-0 items-center gap-2 border-t bg-background/35 px-2 py-1">
      <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs" :disabled="!columns.length" @click="emit('addRule')"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("grid.sortBuilderAddRule") }}</Button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 border-l pl-2">
        <span class="shrink-0 text-[11px] font-medium text-muted-foreground">{{ t("grid.sortSqlPreview") }}</span>
        <code class="min-w-0 flex-1 truncate rounded bg-muted/35 px-1.5 py-0.5 text-[11px]" :class="sqlPreview ? 'text-foreground' : 'text-muted-foreground'" :title="previewText">{{ previewText }}</code>
        <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="!sqlPreview" :aria-label="t('grid.copySortSql')" @click="emit('copySql')"><Copy class="h-3 w-3" /></Button>
      </div>
      <Button variant="outline" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="emit('reset')"><RotateCcw class="mr-1 h-3.5 w-3.5" />{{ t("grid.sortBuilderReset") }}</Button>
      <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs text-muted-foreground hover:text-destructive" :disabled="busy" @click="emit('clear')"><Trash2 class="mr-1 h-3.5 w-3.5" />{{ t("grid.clearSort") }}</Button>
      <Button size="sm" class="h-7 shrink-0 px-3 text-xs" :disabled="busy" @click="emit('apply')">{{ t("grid.sortBuilderApply") }}</Button>
    </footer>
  </section>
</template>

<style scoped>
.sort-rules-scroll {
  max-height: clamp(104px, 27vh, 160px);
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}
</style>
