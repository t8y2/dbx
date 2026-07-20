<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch, type CSSProperties } from "vue";
import { ChevronDown, X } from "@lucide/vue";
import { useDataGridConditionEditor, type DataGridConditionColumnOption, type DataGridConditionSuggestionProvider } from "@/composables/useDataGridConditionEditor";
import { getDataGridConditionSuggestionPosition, getDataGridConditionSuggestionPreferredWidth } from "@/lib/dataGrid/dataGridConditionSuggestionPosition";
import type { DataGridConditionHistoryKind, DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";

const props = withDefaults(
  defineProps<{
    kind: DataGridConditionHistoryKind;
    columns?: readonly DataGridConditionColumnOption[];
    historyScope: DataGridConditionHistoryScope;
    placeholder?: string;
    ariaLabel?: string;
    historyEmptyText?: string;
    historyNoMatchesText?: string;
    suggestionProvider?: DataGridConditionSuggestionProvider;
    suggestionDebounceMs?: number;
    disabled?: boolean;
    compact?: boolean;
    apply?: (value: string) => void | boolean | Promise<void | boolean>;
    clear?: () => void | Promise<void>;
  }>(),
  {
    columns: () => [],
    placeholder: "",
    ariaLabel: "",
    historyEmptyText: "No history yet",
    historyNoMatchesText: "No matching history",
    suggestionDebounceMs: 0,
    disabled: false,
  },
);

const modelValue = defineModel<string>({ default: "" });
const emit = defineEmits<{
  apply: [value: string];
  clear: [];
}>();

const inputRef = ref<HTMLTextAreaElement>();
const suggestionListId = `${useId()}-${props.kind}-condition-suggestions`;
const overlayRef = ref<HTMLTextAreaElement>();
const controlRef = ref<HTMLDivElement>();
const dropdownRef = ref<HTMLDivElement>();
const expanded = ref(false);
const composing = ref(false);
const expandedRect = ref({ left: 0, top: 0, width: 0, controlsTop: 0, inputTop: 0, prefix: 0, suffix: 28 });
const expandedHeight = ref(56);
const suggestionPosition = ref({ left: 0, top: 0, width: 180 });
const historyPreview = ref<{ value: string; left: number; top: number; maxWidth: number; arrowTop: number; side: "left" | "right" } | null>(null);
let collapseTimer: ReturnType<typeof setTimeout> | undefined;
let resizeObserver: ResizeObserver | undefined;
let expandAfterComposition = false;

const editor = useDataGridConditionEditor({
  kind: props.kind,
  value: modelValue,
  columns: () => props.columns,
  historyScope: () => props.historyScope,
  suggestionProvider: props.suggestionProvider,
  suggestionDebounceMs: props.suggestionDebounceMs,
});

const activeEditor = computed(() => overlayRef.value ?? inputRef.value);
const hasValue = computed(() => modelValue.value.trim().length > 0);
const emptyHistoryText = computed(() => (modelValue.value.trim() ? props.historyNoMatchesText : props.historyEmptyText));
const activeSuggestionId = computed(() => (editor.highlightedIndex.value >= 0 ? `${suggestionListId}-${editor.highlightedIndex.value}` : undefined));
const suggestionPreferredWidth = computed(() => getDataGridConditionSuggestionPreferredWidth(editor.suggestions.value));
const suggestionStyle = computed<CSSProperties>(() => ({
  left: `${suggestionPosition.value.left}px`,
  top: `${suggestionPosition.value.top}px`,
  width: `${suggestionPosition.value.width}px`,
}));
const overlayStyle = computed<CSSProperties>(() => ({
  "--data-grid-condition-controls-top": `${expandedRect.value.controlsTop}px`,
  "--data-grid-condition-input-top": `${expandedRect.value.inputTop}px`,
  "--data-grid-condition-prefix-indent": `${expandedRect.value.prefix}px`,
  "--data-grid-condition-suffix-width": `${expandedRect.value.suffix}px`,
  left: `${expandedRect.value.left}px`,
  top: `${expandedRect.value.top}px`,
  width: `${expandedRect.value.width}px`,
  height: `${expandedHeight.value}px`,
}));
const previewStyle = computed<CSSProperties>(() => {
  const preview = historyPreview.value;
  return preview ? { left: `${preview.left}px`, top: `${preview.top}px`, maxWidth: `${preview.maxWidth}px` } : {};
});
const previewArrowStyle = computed<CSSProperties>(() => ({ top: `${historyPreview.value?.arrowTop ?? 0}px` }));

function createTextProbe(input: HTMLTextAreaElement, wrap: boolean) {
  const probe = document.createElement(wrap ? "div" : "span");
  const style = window.getComputedStyle(input);
  probe.textContent = input.value || input.placeholder || "";
  probe.style.cssText = `position:fixed;left:-9999px;top:-9999px;visibility:hidden;box-sizing:border-box;${wrap ? `width:${input.clientWidth}px;white-space:pre-wrap;overflow-wrap:anywhere;padding:${style.paddingTop} ${style.paddingRight} ${style.paddingBottom} ${style.paddingLeft};` : "white-space:pre;"}font:${style.font};font-size:${style.fontSize};font-family:${style.fontFamily};font-weight:${style.fontWeight};line-height:${style.lineHeight};letter-spacing:${style.letterSpacing};`;
  document.body.appendChild(probe);
  return probe;
}

function shouldExpand(input: HTMLTextAreaElement) {
  if (!input.value) return false;
  const probe = createTextProbe(input, false);
  const should = probe.getBoundingClientRect().width > input.clientWidth + 1;
  probe.remove();
  return should;
}

function measureExpandedHeight(input: HTMLTextAreaElement) {
  const probe = createTextProbe(input, true);
  const style = window.getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight) || 24;
  const contentHeight = probe.scrollHeight;
  probe.remove();
  const availableHeight = Math.max(56, window.innerHeight - input.getBoundingClientRect().top - 12);
  return Math.min(Math.max(56, lineHeight * 2.5, contentHeight), Math.min(260, availableHeight));
}

function measureExpandedRect(input: HTMLTextAreaElement) {
  const inputRect = input.getBoundingClientRect();
  const control = controlRef.value;
  const controlRect = control?.getBoundingClientRect() ?? inputRect;
  const controlsRect = control?.firstElementChild?.getBoundingClientRect() ?? controlRect;
  const horizontalInset = 8;
  return {
    left: controlRect.left - horizontalInset,
    top: controlRect.top,
    width: controlRect.width + horizontalInset * 2,
    controlsTop: Math.max(0, controlsRect.top - controlRect.top),
    inputTop: Math.max(0, inputRect.top - controlRect.top),
    prefix: Math.max(0, inputRect.left - controlRect.left),
    suffix: Math.max(28, controlRect.right - inputRect.right),
  };
}

function updateSuggestionPosition() {
  void nextTick(() => {
    const target = activeEditor.value;
    if (!target) return;
    suggestionPosition.value = getDataGridConditionSuggestionPosition(target.getBoundingClientRect(), {
      viewportWidth: window.innerWidth,
      preferredWidth: suggestionPreferredWidth.value,
      maxWidth: suggestionPreferredWidth.value === undefined ? undefined : 520,
    });
  });
}

function resizeEditor(forceExpand = false) {
  void nextTick(() => {
    const input = inputRef.value;
    if (!input) return;
    // Expanding swaps focus to a teleported overlay textarea; doing that mid-IME
    // composition truncates unfinished pinyin. Defer until composition ends.
    if (composing.value && !expanded.value) {
      expandAfterComposition = true;
      return;
    }
    const focused = document.activeElement === input || document.activeElement === overlayRef.value;
    const nextExpanded = focused && shouldExpand(input) && (forceExpand || expanded.value);
    if (nextExpanded) {
      expandedRect.value = measureExpandedRect(input);
      expandedHeight.value = measureExpandedHeight(input);
    }
    expanded.value = nextExpanded;
    updateSuggestionPosition();
    if (nextExpanded && document.activeElement === input && !composing.value) {
      void nextTick(() => {
        const overlay = overlayRef.value;
        if (!overlay || composing.value) return;
        const start = input.selectionStart;
        overlay.focus();
        overlay.setSelectionRange(start, start);
      });
    }
  });
}

function onCompositionStart() {
  composing.value = true;
}

function onCompositionEnd() {
  composing.value = false;
  if (!expandAfterComposition) return;
  expandAfterComposition = false;
  resizeEditor(true);
}

function focus(select = false) {
  const target = activeEditor.value ?? inputRef.value;
  target?.focus();
  if (select) target?.select();
  resizeEditor(true);
}

function scheduleCollapse() {
  if (collapseTimer) clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    const active = document.activeElement;
    if (active === inputRef.value || active === overlayRef.value) return;
    expanded.value = false;
  }, 0);
}

function onInput() {
  resizeEditor(true);
  updateSuggestionPosition();
}

async function applyCondition() {
  editor.dismiss();
  const applied = props.apply ? await props.apply(modelValue.value) : emit("apply", modelValue.value);
  if (applied !== false && modelValue.value.trim()) editor.rememberHistory();
}

async function clearCondition() {
  modelValue.value = "";
  editor.dismiss();
  expanded.value = false;
  if (props.clear) await props.clear();
  else emit("clear");
}

function onKeydown(event: KeyboardEvent) {
  const action = editor.handleKeydown(event);
  if (action === "apply") void applyCondition();
  if (action === "accept") void nextTick(() => focus());
}

function openHistory() {
  editor.openHistory();
  updateSuggestionPosition();
  focus();
}

function acceptSuggestion(index: number) {
  editor.accept(index);
  void nextTick(() => focus());
}

function eventInside(event: Event, element?: HTMLElement) {
  if (!element) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.includes(element) || (event.target instanceof Node && element.contains(event.target));
}

function onDocumentPointerDown(event: PointerEvent) {
  if (eventInside(event, controlRef.value) || eventInside(event, overlayRef.value?.parentElement ?? undefined) || eventInside(event, dropdownRef.value)) return;
  editor.dismiss();
}

function onViewportResize() {
  resizeEditor();
}

function showHistoryPreview(value: string, event: MouseEvent) {
  const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const text = target?.querySelector<HTMLElement>("[data-condition-history-text]");
  if (!target || !text || text.scrollWidth <= text.clientWidth + 1) return hideHistoryPreview();
  const rect = target.getBoundingClientRect();
  const gap = 10;
  const availableRight = window.innerWidth - rect.right - gap - 8;
  const availableLeft = rect.left - gap - 8;
  const placeRight = availableRight >= 280 || availableRight >= availableLeft;
  const maxWidth = Math.max(280, Math.min(560, placeRight ? availableRight : availableLeft));
  const estimatedHeight = Math.min(260, Math.max(56, Math.ceil(value.length / 58) * 18 + 24));
  const top = Math.min(Math.max(8, rect.top), Math.max(8, window.innerHeight - estimatedHeight - 8));
  historyPreview.value = {
    value,
    left: placeRight ? rect.right + gap : Math.max(8, rect.left - gap - maxWidth),
    top,
    maxWidth,
    arrowTop: Math.min(Math.max(14, rect.top + rect.height / 2 - top), estimatedHeight - 14),
    side: placeRight ? "left" : "right",
  };
}

function hideHistoryPreview() {
  historyPreview.value = null;
}

watch(modelValue, () => resizeEditor());
watch(suggestionPreferredWidth, () => {
  if (editor.dropdownOpen.value) updateSuggestionPosition();
});
watch(
  () => editor.dropdownOpen.value,
  (open) => {
    if (open) updateSuggestionPosition();
    else hideHistoryPreview();
  },
);

onMounted(() => {
  window.addEventListener("resize", onViewportResize);
  window.visualViewport?.addEventListener("resize", onViewportResize);
  window.addEventListener("dbx:ui-scale-applied", onViewportResize);
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  if (typeof ResizeObserver !== "undefined" && controlRef.value) {
    resizeObserver = new ResizeObserver(() => resizeEditor());
    resizeObserver.observe(controlRef.value);
  }
});

onUnmounted(() => {
  if (collapseTimer) clearTimeout(collapseTimer);
  expandAfterComposition = false;
  resizeObserver?.disconnect();
  window.removeEventListener("resize", onViewportResize);
  window.visualViewport?.removeEventListener("resize", onViewportResize);
  window.removeEventListener("dbx:ui-scale-applied", onViewportResize);
  document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

defineExpose({ focus, dismiss: editor.dismiss, rememberHistory: editor.rememberHistory });
</script>

<template>
  <div ref="controlRef" class="relative flex min-w-0 flex-1 items-stretch">
    <div class="flex min-w-0 flex-1 items-center gap-1">
      <span class="data-grid-topbar-condition-label" :class="[props.kind === 'where' ? 'data-grid-topbar-condition-label--where' : 'data-grid-topbar-condition-label--order', { 'data-grid-topbar-condition-label--compact': props.compact }]">
        {{ props.kind === "where" ? "WHERE" : "ORDER BY" }}
      </span>
      <div class="relative h-6 min-w-0 flex-1 overflow-hidden">
        <textarea
          ref="inputRef"
          v-model="modelValue"
          wrap="off"
          rows="1"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          :disabled="props.disabled"
          :placeholder="props.placeholder"
          :aria-label="props.ariaLabel || props.placeholder"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="editor.dropdownOpen.value"
          :aria-controls="suggestionListId"
          :aria-activedescendant="activeSuggestionId"
          class="data-grid-topbar-condition-input absolute inset-x-0 top-0 h-6 min-w-0 resize-none bg-transparent outline-none"
          :class="[props.kind === 'where' ? 'data-grid-topbar-condition-input--where' : 'data-grid-topbar-condition-input--order', { 'data-grid-topbar-condition-input--compact': props.compact }]"
          style="height: 24px"
          @focus="resizeEditor(true)"
          @blur="scheduleCollapse"
          @click="resizeEditor(true)"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @input="onInput"
          @keydown="onKeydown"
        />
      </div>
      <button type="button" class="shrink-0 text-muted-foreground hover:text-foreground" :disabled="props.disabled" @mousedown.prevent @click="openHistory">
        <ChevronDown class="h-3 w-3" />
      </button>
      <button v-if="hasValue" type="button" class="shrink-0 text-muted-foreground hover:text-foreground" :disabled="props.disabled" @mousedown.prevent @click="clearCondition">
        <X class="h-3 w-3" />
      </button>
    </div>

    <Teleport to="body">
      <div v-if="expanded" class="data-grid-topbar-condition-pane--expanded fixed z-[80] flex min-w-0 items-start gap-1" :style="overlayStyle">
        <textarea
          ref="overlayRef"
          v-model="modelValue"
          :disabled="props.disabled"
          :placeholder="props.placeholder"
          :aria-label="props.ariaLabel || props.placeholder"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="editor.dropdownOpen.value"
          :aria-controls="suggestionListId"
          :aria-activedescendant="activeSuggestionId"
          class="data-grid-topbar-condition-input data-grid-topbar-condition-input--expanded absolute resize-none outline-none"
          :class="[props.kind === 'where' ? 'data-grid-topbar-condition-input--where' : 'data-grid-topbar-condition-input--order', { 'data-grid-topbar-condition-input--compact': props.compact }]"
          @blur="scheduleCollapse"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @input="onInput"
          @keydown="onKeydown"
        />
        <div class="data-grid-topbar-condition-floating-controls pointer-events-none absolute inset-x-2 z-[1] flex h-6 min-w-0 items-center gap-1">
          <span class="data-grid-topbar-condition-label" :class="[props.kind === 'where' ? 'data-grid-topbar-condition-label--where' : 'data-grid-topbar-condition-label--order', { 'data-grid-topbar-condition-label--compact': props.compact }]">
            {{ props.kind === "where" ? "WHERE" : "ORDER BY" }}
          </span>
          <div class="min-w-0 flex-1" />
          <button type="button" class="data-grid-topbar-condition-icon-control pointer-events-auto shrink-0 text-muted-foreground hover:text-foreground" :disabled="props.disabled" @mousedown.prevent @click="openHistory">
            <ChevronDown class="h-3 w-3" />
          </button>
          <button v-if="hasValue" type="button" class="data-grid-topbar-condition-icon-control pointer-events-auto shrink-0 text-muted-foreground hover:text-foreground" :disabled="props.disabled" @mousedown.prevent @click="clearCondition">
            <X class="h-3 w-3" />
          </button>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="editor.dropdownOpen.value" :id="suggestionListId" ref="dropdownRef" role="listbox" class="fixed z-[90] min-w-[180px] overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md" :style="suggestionStyle">
        <div
          v-for="(suggestion, index) in editor.suggestions.value"
          :key="`${suggestion.kind}:${suggestion.value}`"
          :id="`${suggestionListId}-${index}`"
          role="option"
          :aria-selected="index === editor.highlightedIndex.value"
          class="flex cursor-pointer items-center px-3 py-1.5 text-xs"
          :class="index === editor.highlightedIndex.value ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
          @mousedown.prevent="acceptSuggestion(index)"
          @mouseenter="
            editor.highlightedIndex.value = index;
            suggestion.kind === 'history' && showHistoryPreview(suggestion.value, $event);
          "
          @mouseleave="hideHistoryPreview"
        >
          <span data-condition-history-text class="data-grid-condition-suggestion-field min-w-0 truncate" :class="suggestion.comment ? 'max-w-[75%] shrink-0' : 'flex-1'" :title="suggestion.value">
            {{ suggestion.value }}
          </span>
          <span v-if="suggestion.comment" class="ml-3 min-w-0 flex-1 truncate text-right text-muted-foreground" :title="suggestion.comment">{{ suggestion.comment }}</span>
          <button v-if="suggestion.kind === 'history'" type="button" class="ml-2 shrink-0 text-muted-foreground hover:text-foreground" @mousedown.stop.prevent="editor.deleteHistory(suggestion.value)">
            <X class="h-3 w-3" />
          </button>
        </div>
        <div v-if="editor.suggestions.value.length === 0" class="px-3 py-2 text-xs text-muted-foreground">{{ emptyHistoryText }}</div>
      </div>
    </Teleport>

    <Teleport to="body">
      <div v-if="historyPreview" class="pointer-events-none fixed z-[140] rounded-md bg-foreground shadow-xl" :style="previewStyle">
        <span class="absolute h-3 w-3 rotate-45 bg-foreground" :class="historyPreview.side === 'left' ? '-left-1.5' : '-right-1.5'" :style="previewArrowStyle" />
        <div class="max-h-[min(320px,calc(100vh-16px))] overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-background">{{ historyPreview.value }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.data-grid-topbar-condition-label {
  display: inline-flex;
  flex-shrink: 0;
  max-width: 5rem;
  overflow: hidden;
  white-space: nowrap;
  font-family: var(--data-grid-condition-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5rem;
  user-select: none;
  opacity: 1;
  transform: translateX(0);
  transition:
    max-width var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity 240ms ease 60ms,
    transform var(--data-grid-topbar-transition-duration, 340ms) var(--data-grid-topbar-transition-easing, cubic-bezier(0.22, 1, 0.36, 1)),
    color 240ms ease;
}

.data-grid-topbar-condition-label--where {
  color: rgb(37 99 235);
}

.data-grid-topbar-condition-label--order {
  color: rgb(234 88 12);
}

:global(.dark) .data-grid-topbar-condition-label--where {
  color: rgb(96 165 250);
}

:global(.dark) .data-grid-topbar-condition-label--order {
  color: rgb(251 146 60);
}

.data-grid-topbar-condition-label--compact {
  max-width: 0;
  opacity: 0;
  transform: translateX(-4px);
}

.data-grid-topbar-condition-input,
.data-grid-condition-suggestion-field {
  font-family: var(--data-grid-condition-font-family, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);
  font-size: 0.875rem;
  font-variant-ligatures: none;
  font-feature-settings:
    "liga" 0,
    "calt" 0;
}

.data-grid-topbar-condition-input {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 0 0.125rem;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: pre;
  border: 0;
  border-radius: 0;
  appearance: none;
  scrollbar-width: none;
  line-height: 1.5rem;
}

:global(.dark) .data-grid-topbar-condition-input {
  color: rgb(244, 244, 245);
  background-color: transparent !important;
}

.data-grid-topbar-condition-input::-webkit-scrollbar {
  display: none;
}

.data-grid-topbar-condition-icon-control {
  align-self: center;
  margin-top: 0;
}

.data-grid-topbar-condition-floating-controls {
  top: var(--data-grid-condition-controls-top);
  will-change: transform;
}

.data-grid-topbar-condition-pane--expanded {
  --data-grid-condition-font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  position: fixed;
  z-index: 80;
  right: auto;
  bottom: auto;
  box-sizing: border-box;
  padding: 0.1875rem 0.5rem;
  overflow: hidden;
  background: color-mix(in oklab, var(--background) 96%, var(--muted) 4%);
  box-shadow:
    inset 0 -1px 0 var(--border),
    0 8px 16px rgb(15 23 42 / 8%);
  transition:
    height 150ms ease,
    box-shadow 150ms ease;
  --data-grid-expanded-scrollbar-offset: 8px;
  --data-grid-condition-controls-top: 0.125rem;
  --data-grid-condition-input-top: 0.125rem;
  --data-grid-condition-prefix-indent: 0px;
  --data-grid-condition-suffix-width: 0px;
}

:global(.dark) .data-grid-topbar-condition-pane--expanded {
  background: rgb(24, 24, 27) !important;
  color: rgb(244, 244, 245);
  box-shadow:
    inset 0 -1px 0 rgb(63, 63, 70),
    0 8px 16px rgb(0 0 0 / 32%);
}

.data-grid-topbar-condition-input--expanded {
  top: var(--data-grid-condition-input-top);
  right: 0.5rem;
  bottom: 0.125rem;
  left: 0.5rem;
  height: auto;
  line-height: 1.5rem;
  margin-left: 0;
  width: calc(100% - 1rem + var(--data-grid-expanded-scrollbar-offset));
  max-width: none;
  margin-right: calc(-1 * var(--data-grid-expanded-scrollbar-offset));
  padding: 0 calc(var(--data-grid-condition-suffix-width) + 0.5rem) 0.0625rem 0.125rem;
  text-indent: var(--data-grid-condition-prefix-indent);
  overflow-x: hidden;
  overflow-y: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border: 0;
  border-radius: 0;
  background: transparent;
  scrollbar-width: thin;
}

.data-grid-topbar-condition-input--expanded::-webkit-scrollbar {
  display: initial;
  width: 8px;
}

.data-grid-topbar-condition-input::placeholder {
  color: transparent;
  transition: color 240ms ease;
}

.data-grid-topbar-condition-input--where.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(59 130 246 / 70%);
}

.data-grid-topbar-condition-input--order.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(249 115 22 / 70%);
}

:global(.dark) .data-grid-topbar-condition-input--where.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(147 197 253 / 70%);
}

:global(.dark) .data-grid-topbar-condition-input--order.data-grid-topbar-condition-input--compact::placeholder {
  color: rgb(253 186 116 / 70%);
}
</style>
