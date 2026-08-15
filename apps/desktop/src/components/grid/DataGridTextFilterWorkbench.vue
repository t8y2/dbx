<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Copy, Plus, RotateCcw, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import DataGridFilterBuilder from "@/components/grid/DataGridFilterBuilder.vue";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import { DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MAX, DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MIN } from "@/lib/dataGrid/dataGridTextFilterPanel";

const props = defineProps<{
  height: number;
  sqlPreview: string;
  rules: DataGridStructuredFilterRule[];
  columns: string[];
  filteredColumns: string[];
  modeOptions: Array<{ value: DataGridContextFilterMode; labelKey: string }>;
  columnSearch: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:height": [height: number];
  "update:columnSearch": [value: string];
  ensureRule: [];
  addRule: [];
  apply: [];
  reset: [];
  clear: [];
  copySql: [];
  removeRule: [id: string];
  moveRule: [id: string, targetIndex: number];
  updateRule: [id: string, patch: Partial<DataGridStructuredFilterRule>];
}>();

const { t } = useI18n();
const rulesScrollerRef = ref<HTMLElement>();
const panelHeight = ref(clampHeight(props.height));
const previewText = computed(() => props.sqlPreview || t("grid.filterSqlPreviewEmpty"));
const panelStyle = computed(() => ({ height: `${panelHeight.value}px`, maxHeight: "55vh" }));
let resizeStart: { y: number; height: number } | undefined;

function clampHeight(height: number) {
  return Math.min(DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MAX, Math.max(DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MIN, Math.round(height)));
}

function restoreDocumentInteraction() {
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function stopResizeListeners() {
  window.removeEventListener("pointermove", resizePanel);
  window.removeEventListener("pointerup", finishResize);
  window.removeEventListener("pointercancel", finishResize);
}

function startResize(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeStart = { y: event.clientY, height: panelHeight.value };
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", resizePanel);
  window.addEventListener("pointerup", finishResize);
  window.addEventListener("pointercancel", finishResize);
}

function resizePanel(event: PointerEvent) {
  if (!resizeStart) return;
  panelHeight.value = clampHeight(resizeStart.height + event.clientY - resizeStart.y);
}

function finishResize() {
  if (!resizeStart) return;
  resizeStart = undefined;
  stopResizeListeners();
  restoreDocumentInteraction();
  emit("update:height", panelHeight.value);
}

function resizePanelByKeyboard(event: KeyboardEvent) {
  const step = event.shiftKey ? 24 : 8;
  let nextHeight = panelHeight.value;
  if (event.key === "ArrowUp") nextHeight -= step;
  else if (event.key === "ArrowDown") nextHeight += step;
  else if (event.key === "Home") nextHeight = DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MIN;
  else if (event.key === "End") nextHeight = DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MAX;
  else return;
  event.preventDefault();
  panelHeight.value = clampHeight(nextHeight);
  emit("update:height", panelHeight.value);
}

function focusRulesArea(event: PointerEvent) {
  (event.currentTarget as HTMLElement).focus({ preventScroll: true });
}

function addRuleFromBlankArea(event: KeyboardEvent) {
  if (event.target !== event.currentTarget || event.key !== "Enter" || !event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  event.stopPropagation();
  if (!props.disabled && props.columns.length) emit("addRule");
}

onMounted(() => emit("ensureRule"));
onBeforeUnmount(() => {
  stopResizeListeners();
  restoreDocumentInteraction();
});

watch(
  () => props.height,
  (height) => {
    if (!resizeStart) panelHeight.value = clampHeight(height);
  },
);

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
  <section data-grid-text-filter-workbench class="relative flex shrink-0 flex-col border-b bg-muted/10 text-foreground" :style="panelStyle">
    <div
      ref="rulesScrollerRef"
      data-filter-rules-scroll
      tabindex="0"
      :aria-label="t('grid.filterTextView')"
      class="min-h-0 flex-1 overflow-auto px-2 py-1 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/40"
      @keydown="addRuleFromBlankArea"
      @pointerdown.self="focusRulesArea"
    >
      <DataGridFilterBuilder
        class="min-w-[520px]"
        :rules="rules"
        :columns="columns"
        :filtered-columns="filteredColumns"
        :mode-options="modeOptions"
        :column-search="columnSearch"
        :disabled="disabled"
        layout="text"
        :show-header="false"
        :show-footer="false"
        @add="emit('addRule')"
        @apply="emit('apply')"
        @reset="emit('reset')"
        @clear="emit('clear')"
        @remove="emit('removeRule', $event)"
        @move="(id, targetIndex) => emit('moveRule', id, targetIndex)"
        @update-rule="(id, patch) => emit('updateRule', id, patch)"
        @update:column-search="emit('update:columnSearch', $event)"
      />
    </div>

    <footer class="flex h-8 min-w-0 shrink-0 items-center gap-1.5 border-t bg-background/45 px-2">
      <Tooltip :delay-duration="800">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="sm" class="h-6 shrink-0 px-1.5 text-xs" :disabled="disabled || !columns.length" @click="emit('addRule')"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("grid.filterBuilderAddRule") }}</Button>
        </TooltipTrigger>
        <TooltipContent side="top">Shift+Enter</TooltipContent>
      </Tooltip>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 border-l pl-2">
        <span class="shrink-0 text-[11px] text-muted-foreground">{{ t("grid.filterSqlPreview") }}</span>
        <code class="min-w-0 flex-1 truncate px-1 text-[11px]" :class="sqlPreview ? 'text-foreground' : 'text-muted-foreground'" :title="previewText">{{ previewText }}</code>
        <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="!sqlPreview" :aria-label="t('grid.copyFilterSql')" @click="emit('copySql')"><Copy class="h-3 w-3" /></Button>
      </div>
      <Button variant="outline" size="sm" class="h-6 shrink-0 px-1.5 text-xs" @click="emit('reset')"><RotateCcw class="mr-1 h-3 w-3" />{{ t("grid.resetFilterBuilder") }}</Button>
      <Button variant="ghost" size="sm" class="h-6 shrink-0 px-1.5 text-xs text-muted-foreground hover:text-destructive" @click="emit('clear')"><Trash2 class="mr-1 h-3 w-3" />{{ t("grid.clearFilter") }}</Button>
      <Button size="sm" class="h-6 shrink-0 px-2.5 text-xs" :disabled="disabled" @click="emit('apply')">{{ t("grid.applyFilter") }}</Button>
    </footer>

    <div
      role="separator"
      tabindex="0"
      aria-orientation="horizontal"
      :aria-label="t('grid.resizeFilterPanel')"
      :aria-valuemin="DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MIN"
      :aria-valuemax="DATA_GRID_TEXT_FILTER_PANEL_HEIGHT_MAX"
      :aria-valuenow="panelHeight"
      class="group absolute inset-x-0 -bottom-0.5 z-10 flex h-1.5 cursor-row-resize items-center justify-center outline-none"
      @keydown="resizePanelByKeyboard"
      @pointerdown="startResize"
    >
      <span class="h-px w-10 bg-border transition-colors group-hover:bg-primary group-focus:bg-primary" />
    </div>
  </section>
</template>
