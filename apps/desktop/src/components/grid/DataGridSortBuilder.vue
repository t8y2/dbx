<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, Focus, GripVertical, Plus, Search, Trash2, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import type { DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";
import { resolveDataGridFilterRuleDropPlacement } from "@/lib/dataGrid/dataGridFilterRuleDrag";
import type { DataGridSortDirection } from "@/lib/dataGrid/dataGridSort";
import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";

const RULE_DROP_ZONE_EXTENSION = 36;
const RULE_AUTO_SCROLL_EDGE_SIZE = 40;
const RULE_AUTO_SCROLL_MAX_SPEED = 12;
const IME_COMPOSITION_END_GRACE_MS = 120;

const props = withDefaults(
  defineProps<{
    rules: readonly DataGridStructuredSortRule[];
    columns: readonly string[];
    commentByColumn?: ReadonlyMap<string, string>;
    busy?: boolean;
    applyOnlyBusy?: boolean;
    showHeader?: boolean;
    showFooter?: boolean;
    layout?: "popover" | "panel" | "text";
  }>(),
  { showHeader: true, showFooter: true, layout: "popover" },
);

const emit = defineEmits<{
  add: [];
  remove: [id: string];
  move: [id: string, targetIndex: number];
  updateRule: [id: string, patch: Partial<DataGridStructuredSortRule>];
  applyOnly: [id: string];
  reset: [];
  clear: [];
  apply: [];
}>();

const { t } = useI18n();
const rootRef = ref<HTMLElement>();
const ruleElements = new Map<string, HTMLElement>();
const columnSearchInputs = new Map<string, HTMLInputElement>();
const columnSearches = ref<Record<string, string>>({});
const openColumnSelectIds = ref(new Set<string>());
const activeColumnIndexes = ref<Record<string, number>>({});
const composingSearches = new Set<string>();
const compositionEndedAt = new Map<string, number>();
const draggingRuleId = ref<string>();
const dropRuleId = ref<string>();
const dropPosition = ref<"before" | "after">();
const dropTargetIndex = ref<number>();
let dragPointerId: number | undefined;
let dragPointerY: number | undefined;
let dragHandle: HTMLElement | undefined;
let dragContainer: HTMLElement | undefined;
let autoScrollFrame: number | undefined;
let dragBodyStyleActive = false;
let previousBodyUserSelect = "";
let previousBodyCursor = "";

const hasIncompleteActiveRule = computed(() => props.rules.some((rule) => !rule.disabled && !rule.columnName));

function filteredColumns(rule: DataGridStructuredSortRule): string[] {
  const query = columnSearches.value[rule.id]?.trim() ?? "";
  if (!query) return [...props.columns];
  // Match column comments too, mirroring the filter builder's comment search (#10759).
  const comments = props.commentByColumn;
  return props.columns.filter((column) => matchesIdentifierSearch(column, query) || matchesIdentifierSearch(comments?.get(column) ?? comments?.get(column.toLowerCase()) ?? "", query));
}

function setRuleElement(id: string, element: unknown) {
  if (element instanceof HTMLElement) ruleElements.set(id, element);
  else ruleElements.delete(id);
}

function setColumnSearchInput(id: string, element: unknown) {
  if (!(element instanceof HTMLInputElement)) {
    columnSearchInputs.delete(id);
    return;
  }
  columnSearchInputs.set(id, element);
  if (openColumnSelectIds.value.has(id)) window.requestAnimationFrame(() => element.focus({ preventScroll: true }));
}

function setColumnSelectOpen(id: string, open: boolean) {
  const next = new Set(openColumnSelectIds.value);
  if (open) {
    next.clear();
    next.add(id);
  } else {
    next.delete(id);
    columnSearches.value = { ...columnSearches.value, [id]: "" };
  }
  openColumnSelectIds.value = next;
}

function activeColumnIndex(id: string): number {
  return activeColumnIndexes.value[id] ?? -1;
}

function scrollColumnIntoView(id: string, index: number, block: ScrollLogicalPosition) {
  const listbox = columnSearchInputs.get(id)?.closest('[role="listbox"]');
  listbox?.querySelectorAll<HTMLElement>('[role="option"]')[index]?.scrollIntoView?.({ block });
}

function setActiveColumnIndex(rule: DataGridStructuredSortRule, index: number, scrollBlock: ScrollLogicalPosition = "nearest") {
  const count = filteredColumns(rule).length;
  const nextIndex = count ? ((index % count) + count) % count : -1;
  activeColumnIndexes.value = { ...activeColumnIndexes.value, [rule.id]: nextIndex };
  window.requestAnimationFrame(() => scrollColumnIntoView(rule.id, nextIndex, scrollBlock));
}

async function handleColumnSelectOpen(rule: DataGridStructuredSortRule, open: boolean) {
  setColumnSelectOpen(rule.id, open);
  if (!open) return;
  const selectedIndex = filteredColumns(rule).indexOf(rule.columnName);
  const nextIndex = selectedIndex >= 0 ? selectedIndex : 0;
  setActiveColumnIndex(rule, nextIndex, "start");
  await nextTick();
  window.requestAnimationFrame(() => columnSearchInputs.get(rule.id)?.focus({ preventScroll: true }));
}

function updateColumnSearch(rule: DataGridStructuredSortRule, event: Event) {
  columnSearches.value = { ...columnSearches.value, [rule.id]: (event.target as HTMLInputElement).value };
  setActiveColumnIndex(rule, 0);
}

function selectColumn(rule: DataGridStructuredSortRule, column: unknown) {
  emit("updateRule", rule.id, { columnName: String(column) });
  setColumnSelectOpen(rule.id, false);
}

function startImeComposition(id: string) {
  composingSearches.add(id);
  compositionEndedAt.delete(id);
}

function endImeComposition(id: string) {
  composingSearches.delete(id);
  compositionEndedAt.set(id, Date.now());
}

function isImeCompositionKey(event: KeyboardEvent, id: string): boolean {
  const endedAt = compositionEndedAt.get(id);
  const justEnded = event.key === "Enter" && endedAt !== undefined && Date.now() - endedAt <= IME_COMPOSITION_END_GRACE_MS;
  if (justEnded || (endedAt !== undefined && event.key !== "Process")) compositionEndedAt.delete(id);
  return event.isComposing || event.key === "Process" || event.keyCode === 229 || composingSearches.has(id) || justEnded;
}

function handleColumnSearchKeydown(event: KeyboardEvent, rule: DataGridStructuredSortRule) {
  if (isImeCompositionKey(event, rule.id)) {
    event.stopPropagation();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    setActiveColumnIndex(rule, activeColumnIndex(rule.id) + (event.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (event.key === "Enter") {
    const column = filteredColumns(rule)[activeColumnIndex(rule.id)];
    if (!column) return;
    event.preventDefault();
    event.stopPropagation();
    selectColumn(rule, column);
    return;
  }
  if (!["Escape", "Tab"].includes(event.key)) event.stopPropagation();
}

function removeDragListeners() {
  window.removeEventListener("pointermove", handlePointerMove, true);
  window.removeEventListener("pointerup", handlePointerUp, true);
  window.removeEventListener("pointercancel", handlePointerCancel, true);
  window.removeEventListener("keydown", handleDragKeydown, true);
  window.removeEventListener("blur", clearDragState);
}

function stopAutoScroll() {
  if (autoScrollFrame !== undefined) window.cancelAnimationFrame(autoScrollFrame);
  autoScrollFrame = undefined;
}

function clearDropTarget() {
  dropRuleId.value = undefined;
  dropPosition.value = undefined;
  dropTargetIndex.value = undefined;
}

function clearDragState() {
  stopAutoScroll();
  removeDragListeners();
  if (dragHandle && dragPointerId !== undefined && dragHandle.hasPointerCapture?.(dragPointerId)) dragHandle.releasePointerCapture(dragPointerId);
  if (dragBodyStyleActive) {
    document.body.style.userSelect = previousBodyUserSelect;
    document.body.style.cursor = previousBodyCursor;
  }
  draggingRuleId.value = undefined;
  dragPointerId = undefined;
  dragPointerY = undefined;
  dragHandle = undefined;
  dragContainer = undefined;
  dragBodyStyleActive = false;
  clearDropTarget();
}

function updateDropTarget(clientY: number) {
  if (!draggingRuleId.value) return;
  const placement = resolveDataGridFilterRuleDropPlacement(
    props.rules.map((rule) => rule.id),
    draggingRuleId.value,
    props.rules.flatMap((rule) => {
      const element = ruleElements.get(rule.id);
      if (!element) return [];
      const bounds = element.getBoundingClientRect();
      return [{ id: rule.id, top: bounds.top, bottom: bounds.bottom }];
    }),
    clientY,
  );
  if (!placement) {
    clearDropTarget();
    return;
  }
  dropRuleId.value = placement.ruleId;
  dropPosition.value = placement.position;
  dropTargetIndex.value = placement.targetIndex;
}

function pointerWithinDropZone(event: PointerEvent): boolean {
  const bounds = dragContainer?.getBoundingClientRect();
  return !!bounds && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top - RULE_DROP_ZONE_EXTENSION && event.clientY <= bounds.bottom + RULE_DROP_ZONE_EXTENSION;
}

function autoScrollSpeed(clientY: number, bounds: DOMRect): number {
  if (clientY < bounds.top + RULE_AUTO_SCROLL_EDGE_SIZE) return -Math.max(1, Math.ceil(Math.min(1, (bounds.top + RULE_AUTO_SCROLL_EDGE_SIZE - clientY) / RULE_AUTO_SCROLL_EDGE_SIZE) * RULE_AUTO_SCROLL_MAX_SPEED));
  if (clientY > bounds.bottom - RULE_AUTO_SCROLL_EDGE_SIZE) return Math.max(1, Math.ceil(Math.min(1, (clientY - (bounds.bottom - RULE_AUTO_SCROLL_EDGE_SIZE)) / RULE_AUTO_SCROLL_EDGE_SIZE) * RULE_AUTO_SCROLL_MAX_SPEED));
  return 0;
}

function runAutoScroll() {
  autoScrollFrame = undefined;
  if (!draggingRuleId.value || !dragContainer || dragPointerY === undefined) return;
  const speed = autoScrollSpeed(dragPointerY, dragContainer.getBoundingClientRect());
  if (!speed) return;
  const previousScrollTop = dragContainer.scrollTop;
  dragContainer.scrollTop += speed;
  if (dragContainer.scrollTop === previousScrollTop) return;
  updateDropTarget(dragPointerY);
  autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function scheduleAutoScroll() {
  if (autoScrollFrame === undefined) autoScrollFrame = window.requestAnimationFrame(runAutoScroll);
}

function handlePointerMove(event: PointerEvent) {
  if (!draggingRuleId.value || event.pointerId !== dragPointerId) return;
  if (!pointerWithinDropZone(event)) {
    stopAutoScroll();
    clearDropTarget();
    return;
  }
  event.preventDefault();
  dragPointerY = event.clientY;
  updateDropTarget(event.clientY);
  scheduleAutoScroll();
}

function handlePointerUp(event: PointerEvent) {
  if (!draggingRuleId.value || event.pointerId !== dragPointerId) return;
  if (pointerWithinDropZone(event)) {
    event.preventDefault();
    updateDropTarget(event.clientY);
    if (dropTargetIndex.value !== undefined) emit("move", draggingRuleId.value, dropTargetIndex.value);
  }
  clearDragState();
}

function handlePointerCancel(event: PointerEvent) {
  if (event.pointerId === dragPointerId) clearDragState();
}

function handleDragKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !draggingRuleId.value) return;
  event.preventDefault();
  clearDragState();
}

function startPointerDrag(event: PointerEvent, id: string) {
  if (event.button !== 0 || props.rules.length < 2) return;
  const handle = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  dragContainer = handle?.closest<HTMLElement>("[data-sort-rules-scroll]") ?? rootRef.value;
  if (!dragContainer || !handle) return;
  event.preventDefault();
  event.stopPropagation();
  draggingRuleId.value = id;
  dragPointerId = event.pointerId;
  dragPointerY = event.clientY;
  dragHandle = handle;
  previousBodyUserSelect = document.body.style.userSelect;
  previousBodyCursor = document.body.style.cursor;
  dragBodyStyleActive = true;
  document.body.style.userSelect = "none";
  document.body.style.cursor = "grabbing";
  handle.setPointerCapture?.(event.pointerId);
  updateDropTarget(event.clientY);
  window.addEventListener("pointermove", handlePointerMove, true);
  window.addEventListener("pointerup", handlePointerUp, true);
  window.addEventListener("pointercancel", handlePointerCancel, true);
  window.addEventListener("keydown", handleDragKeydown, true);
  window.addEventListener("blur", clearDragState);
}

function moveRuleByKeyboard(event: KeyboardEvent, id: string, offset: -1 | 1) {
  const sourceIndex = props.rules.findIndex((rule) => rule.id === id);
  const targetIndex = sourceIndex + offset;
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= props.rules.length) return;
  event.preventDefault();
  emit("move", id, targetIndex);
}

onBeforeUnmount(clearDragState);
</script>

<template>
  <div ref="rootRef" class="max-w-full" :class="props.layout === 'text' ? 'w-full space-y-0' : [props.layout === 'panel' ? 'w-full' : 'w-[30rem] max-w-[calc(100vw-16px)]', 'space-y-2']">
    <div v-if="props.showHeader !== false" class="flex items-center justify-between gap-2">
      <div class="text-xs font-medium text-foreground">{{ t("grid.sortBuilderTitle") }}</div>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="busy" @click="emit('clear')"><Trash2 class="mr-1 h-3.5 w-3.5" />{{ t("grid.clearSort") }}</Button>
    </div>

    <div v-if="rules.length" :class="props.layout === 'text' ? 'space-y-0' : 'space-y-1.5'">
      <div
        v-for="rule in rules"
        :key="rule.id"
        :ref="(element) => setRuleElement(rule.id, element)"
        data-sort-rule-item
        class="sort-rule-row relative grid items-center"
        :class="[props.layout === 'text' ? 'min-h-7 grid-cols-[18px_22px_minmax(180px,1fr)_6.5rem_auto] gap-0.5 border-b border-border/45 px-1 hover:bg-muted/25' : 'grid-cols-[18px_minmax(180px,1fr)_6.5rem_auto] gap-1.5', rule.disabled ? 'opacity-60' : '']"
        :data-dragging="draggingRuleId === rule.id ? '' : undefined"
        :data-drop-position="dropRuleId === rule.id ? dropPosition : undefined"
      >
        <button
          type="button"
          data-sort-drag-handle
          class="flex h-6 w-4 touch-none cursor-grab items-center justify-center justify-self-center text-muted-foreground/70 outline-none hover:text-foreground focus-visible:text-primary disabled:cursor-default disabled:opacity-30 active:cursor-grabbing"
          :disabled="rules.length < 2"
          :aria-label="t('grid.sortBuilderReorderRule')"
          :aria-grabbed="draggingRuleId === rule.id"
          @pointerdown="startPointerDrag($event, rule.id)"
          @keydown.up="moveRuleByKeyboard($event, rule.id, -1)"
          @keydown.down="moveRuleByKeyboard($event, rule.id, 1)"
        >
          <GripVertical class="h-3.5 w-3.5" />
        </button>

        <button
          v-if="props.layout === 'text'"
          type="button"
          role="checkbox"
          :aria-checked="!rule.disabled"
          :aria-label="rule.disabled ? t('grid.sortBuilderEnableRule') : t('grid.sortBuilderDisableRule')"
          class="flex h-4 w-4 items-center justify-center justify-self-center border text-primary transition-colors hover:border-primary"
          :class="rule.disabled ? 'border-muted-foreground/40 bg-background' : 'border-primary bg-primary/10'"
          @click="emit('updateRule', rule.id, { disabled: !rule.disabled })"
        >
          <Check v-if="!rule.disabled" class="h-3 w-3" />
        </button>

        <Select :model-value="rule.columnName" :open="openColumnSelectIds.has(rule.id)" :disabled="rule.disabled" @update:model-value="(value: any) => selectColumn(rule, value)" @update:open="(open: boolean) => handleColumnSelectOpen(rule, open)">
          <SelectTrigger size="sm" class="w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate" :class="props.layout === 'text' ? 'h-6 rounded-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0' : 'h-7'">
            <SelectValue v-if="rule.columnName">{{ rule.columnName }}</SelectValue>
            <SelectValue v-else :placeholder="t('grid.sortBuilderSelectColumn')" />
          </SelectTrigger>
          <SelectContent position="popper" class="max-h-72" :hide-scroll-buttons="true">
            <SelectItem v-for="(column, columnIndex) in filteredColumns(rule)" :key="column" :value="column" class="rounded-none" :class="activeColumnIndex(rule.id) === columnIndex ? 'bg-accent text-accent-foreground' : ''" @pointermove="setActiveColumnIndex(rule, columnIndex)">
              {{ column }}
            </SelectItem>
            <div v-if="!filteredColumns(rule).length" class="px-2 py-2 text-xs text-muted-foreground">{{ t("grid.filterBuilderNoMatchingColumns") }}</div>
            <template #header>
              <div data-sort-column-search class="flex items-center gap-1.5 border-b bg-popover px-2 py-1.5">
                <Search class="h-3.5 w-3.5 text-muted-foreground" />
                <input
                  :ref="(element) => setColumnSearchInput(rule.id, element)"
                  :value="columnSearches[rule.id] ?? ''"
                  :aria-label="t('grid.filterBuilderSearchColumns')"
                  class="h-7 min-w-0 flex-1 rounded-sm border border-input bg-background/60 px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary"
                  :placeholder="t('grid.filterBuilderSearchColumns')"
                  @input="updateColumnSearch(rule, $event)"
                  @click.stop
                  @compositionend="endImeComposition(rule.id)"
                  @compositionstart="startImeComposition(rule.id)"
                  @keydown="handleColumnSearchKeydown($event, rule)"
                  @pointerdown.stop
                />
              </div>
            </template>
          </SelectContent>
        </Select>

        <Select :model-value="rule.direction" :disabled="rule.disabled" @update:model-value="(value: any) => emit('updateRule', rule.id, { direction: value as DataGridSortDirection })">
          <SelectTrigger size="sm" class="text-xs" :class="props.layout === 'text' ? 'h-6 rounded-none border-0 bg-transparent px-1 shadow-none focus-visible:ring-0' : 'h-7'"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="asc"
              ><span class="flex items-center gap-1.5"><ArrowUp class="h-3.5 w-3.5" />ASC</span></SelectItem
            >
            <SelectItem value="desc"
              ><span class="flex items-center gap-1.5"><ArrowDown class="h-3.5 w-3.5" />DESC</span></SelectItem
            >
          </SelectContent>
        </Select>

        <div class="flex items-center gap-0.5">
          <LightTooltip :text="t('grid.sortBuilderApplyOnly')" side="top" :side-offset="4">
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="busy || applyOnlyBusy" :aria-label="t('grid.sortBuilderApplyOnly')" @click="emit('applyOnly', rule.id)">
              <Focus class="h-3.5 w-3.5" />
            </Button>
          </LightTooltip>
          <LightTooltip v-if="props.layout !== 'text'" :text="t(rule.disabled ? 'grid.sortBuilderEnableRule' : 'grid.sortBuilderDisableRule')" side="top" :side-offset="4">
            <Button variant="ghost" size="icon" class="h-7 w-7" :aria-label="t(rule.disabled ? 'grid.sortBuilderEnableRule' : 'grid.sortBuilderDisableRule')" @click="emit('updateRule', rule.id, { disabled: !rule.disabled })">
              <EyeOff v-if="rule.disabled" class="h-3.5 w-3.5" /><Eye v-else class="h-3.5 w-3.5" />
            </Button>
          </LightTooltip>
          <template v-if="props.layout === 'text'">
            <Button variant="ghost" size="icon" class="h-6 w-6" :aria-label="t('grid.sortBuilderAddRule')" @click="emit('add')"><Plus class="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" class="h-6 w-6" :aria-label="t('common.remove')" @click="emit('remove', rule.id)"><X class="h-3.5 w-3.5" /></Button>
          </template>
          <LightTooltip v-else :text="t('common.remove')" side="top" :side-offset="4">
            <Button variant="ghost" size="icon" class="h-7 w-7" :aria-label="t('common.remove')" @click="emit('remove', rule.id)"><X class="h-3.5 w-3.5" /></Button>
          </LightTooltip>
        </div>
      </div>
    </div>
    <div v-else class="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">{{ t("grid.sortBuilderEmpty") }}</div>

    <div v-if="props.showFooter !== false" class="flex justify-between gap-2">
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!columns.length" @click="emit('add')"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("grid.sortBuilderAddRule") }}</Button>
      <div class="flex gap-1.5">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('reset')">{{ t("grid.sortBuilderReset") }}</Button>
        <Button size="sm" class="h-7 px-3 text-xs" :disabled="busy || hasIncompleteActiveRule" @click="emit('apply')">{{ t("grid.sortBuilderApply") }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sort-rule-row[data-dragging] {
  opacity: 0.45;
}

.sort-rule-row[data-drop-position]::before {
  position: absolute;
  z-index: 10;
  right: 0;
  left: 0;
  height: 2px;
  background: var(--primary);
  content: "";
  pointer-events: none;
}

.sort-rule-row[data-drop-position="before"]::before {
  top: -1px;
}

.sort-rule-row[data-drop-position="after"]::before {
  bottom: -1px;
}
</style>
