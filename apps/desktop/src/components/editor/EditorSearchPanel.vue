<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { setSearchQuery, openSearchPanel as cmOpenSearchPanel, findNext as cmFindNext, findPrevious as cmFindPrevious, replaceNext as cmReplaceNext, replaceAll as cmReplaceAll } from "@codemirror/search";
import { ChevronUp, ChevronDown, ChevronRight, TextSelect, X } from "@lucide/vue";
import { collectEditorSearchMatches, countEditorSearchMatches, createEditorSearchQuery, replaceEditorSearchMatches, type EditorSearchMatch } from "@/lib/editor/editorSearchQuery";
import { appendSearchMatchSelection, findSearchMatch, isSearchAddSelectionModifier, selectionRangesForSearchMatches, type EditorSearchSelectionDirection } from "@/lib/editor/editorSearchSelection";
import { useSettingsStore } from "@/stores/settingsStore";

const props = defineProps<{
  view: EditorView | null;
  tone?: "app" | "editor";
}>();

const { t } = useI18n();
const settingsStore = useSettingsStore();

const searchVisible = ref(false);
const searchText = ref("");
const replaceText = ref("");
const showReplace = ref(false);
const caseSensitive = ref(false);
const useRegex = ref(false);
const matchCount = ref(0);
const currentMatchIndex = ref(0);
const searchInputRef = ref<HTMLInputElement>();
const replaceInputRef = ref<HTMLInputElement>();
const selectionLimitReached = ref(false);

// Scoped search: restrict find/replace to the original selection range
let searchScopeFrom: number | null = null;
let searchScopeTo: number | null = null;
const inSelectionScope = ref(false);

const SEARCH_UPDATE_DELAY_MS = 120;
// When the panel is opening, push the first match-count pass past the enter
// transition (150ms) so the O(document) count does not contend with the
// animation's first frames and cause dropped frames on large documents.
const SEARCH_OPEN_DELAY_MS = 200;
const DOCUMENT_SEARCH_UPDATE_DELAY_MS = 500;
let searchUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let documentSearchUpdateTimer: ReturnType<typeof setTimeout> | null = null;
let pendingIdleHandle: number | null = null;

// requestIdleCallback lets the match-count pass yield to the animation frame
// budget; fall back to setTimeout where the API is unavailable (older webviews).
const requestIdle = typeof window !== "undefined" && typeof window.requestIdleCallback === "function" ? (cb: () => void) => window.requestIdleCallback(cb, { timeout: 500 }) : (cb: () => void) => window.setTimeout(cb, 0) as unknown as number;
const cancelIdle = typeof window !== "undefined" && typeof window.cancelIdleCallback === "function" ? (handle: number) => window.cancelIdleCallback(handle) : (handle: number) => window.clearTimeout(handle);

function clearPendingIdle() {
  if (pendingIdleHandle == null) return;
  cancelIdle(pendingIdleHandle);
  pendingIdleHandle = null;
}

function searchMatchLimit(): number {
  return settingsStore.editorSettings.regexMaxMatchCount;
}

function clearDocumentSearchUpdate() {
  if (!documentSearchUpdateTimer) return;
  clearTimeout(documentSearchUpdateTimer);
  documentSearchUpdateTimer = null;
}

function dispatchSearchQuery() {
  const v = props.view;
  if (!v) return;
  const q = createEditorSearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    useRegex: useRegex.value,
    replace: replaceText.value,
  });
  v.dispatch({ effects: setSearchQuery.of(q) });
}

function clearSearchQuery() {
  const v = props.view;
  if (!v) return;
  const selection = v.state.selection.main;
  v.dispatch({
    selection: EditorSelection.single(selection.head),
    effects: setSearchQuery.of(
      createEditorSearchQuery({
        search: "",
        caseSensitive: false,
        useRegex: false,
      }),
    ),
  });
  matchCount.value = 0;
  currentMatchIndex.value = 0;
  selectionLimitReached.value = false;
}

/**
 * Get replacement text for a regex match, supporting capture groups.
 */
function computeReplacementForMatch(v: EditorView, matchFrom: number, matchTo: number): string {
  if (!useRegex.value) return replaceText.value;
  const matchedText = v.state.sliceDoc(matchFrom, matchTo);
  try {
    const re = new RegExp(searchText.value, caseSensitive.value ? "" : "i");
    const m = re.exec(matchedText);
    if (!m) return replaceText.value;
    return replaceText.value.replace(/\$(\d+|&)/g, (_, ref) => {
      if (ref === "&") return m[0];
      const idx = parseInt(ref, 10);
      return idx < m.length ? (m[idx] ?? "") : `$${ref}`;
    });
  } catch {
    return replaceText.value;
  }
}

/**
 * Collect all search matches within the scoped range.
 */
function collectScopedMatches(v: EditorView, limit = Number.POSITIVE_INFINITY) {
  if (searchScopeFrom == null || searchScopeTo == null) return null;
  const q = createEditorSearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    useRegex: useRegex.value,
  });
  if (!q.valid) return null;
  return collectEditorSearchMatches(q, v.state, searchScopeFrom, searchScopeTo, limit);
}

function collectAllMatches(v: EditorView, limit = Number.POSITIVE_INFINITY) {
  if (!searchText.value) return [];
  const query = createEditorSearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    useRegex: useRegex.value,
  });
  if (!query.valid) return [];
  return collectEditorSearchMatches(query, v.state, searchScopeFrom ?? 0, searchScopeTo ?? v.state.doc.length, limit);
}

function* iterateAllMatches(v: EditorView): Generator<EditorSearchMatch> {
  if (!searchText.value) return;
  const query = createEditorSearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    useRegex: useRegex.value,
  });
  if (!query.valid) return;
  const from = searchScopeFrom ?? 0;
  const to = searchScopeTo ?? v.state.doc.length;
  const cursor = query.getCursor(v.state);
  for (let result = cursor.next(); !result.done; result = cursor.next()) {
    if (result.value.from >= from && result.value.to <= to) yield { from: result.value.from, to: result.value.to };
  }
}

/**
 * Find next/previous match within the scoped range.
 * Returns true if a match was found.
 */
function findInScope(direction: "next" | "prev"): boolean {
  const v = props.view;
  if (!v || !searchText.value || searchScopeFrom == null || searchScopeTo == null) return false;
  const selection = v.state.selection.main;
  const cursor = direction === "next" ? selection.head : selection.from;
  const target = findSearchMatch(iterateAllMatches(v), cursor, direction);

  if (target) {
    v.dispatch({
      selection: EditorSelection.range(target.from, target.to),
      scrollIntoView: true,
    });
    return true;
  }
  return false;
}

function updateMatchInfo(autoSelect = false) {
  const v = props.view;
  if (!v || !searchText.value) {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
    return;
  }
  if (selectionLimitReached.value && v.state.selection.ranges.length !== searchMatchLimit()) selectionLimitReached.value = false;
  try {
    // Scoped: use custom find logic
    if (searchScopeFrom != null && searchScopeTo != null) {
      if (autoSelect) findInScope("next");
      const q = createEditorSearchQuery({
        search: searchText.value,
        caseSensitive: caseSensitive.value,
        useRegex: useRegex.value,
      });
      if (!q.valid) return;
      const selFrom = v.state.selection.main.from;
      const selTo = v.state.selection.main.to;
      const { count, currentIndex } = countEditorSearchMatches(q, v.state, searchScopeFrom, searchScopeTo, { from: selFrom, to: selTo });
      matchCount.value = count;
      currentMatchIndex.value = currentIndex || (count > 0 ? 1 : 0);
      return;
    }

    // Full document: use CodeMirror built-in
    const q = createEditorSearchQuery({
      search: searchText.value,
      caseSensitive: caseSensitive.value,
      useRegex: useRegex.value,
    });
    if (!q.valid) {
      matchCount.value = 0;
      currentMatchIndex.value = 0;
      return;
    }
    if (autoSelect) {
      cmFindNext(v);
    }
    const selFrom = v.state.selection.main.from;
    const selTo = v.state.selection.main.to;
    const { count, currentIndex } = countEditorSearchMatches(q, v.state, 0, v.state.doc.length, { from: selFrom, to: selTo });
    matchCount.value = count;
    currentMatchIndex.value = currentIndex || (count > 0 ? 1 : 0);
  } catch {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
  }
}

function scheduleSearchUpdate(autoSelect = false, delay = SEARCH_UPDATE_DELAY_MS) {
  clearDocumentSearchUpdate();
  clearPendingIdle();
  if (searchUpdateTimer) {
    clearTimeout(searchUpdateTimer);
    searchUpdateTimer = null;
  }
  if (!searchText.value) {
    clearSearchQuery();
    return;
  }
  selectionLimitReached.value = false;
  dispatchSearchQuery();
  searchUpdateTimer = setTimeout(() => {
    searchUpdateTimer = null;
    // Run the O(document) match count on an idle tick so it does not block
    // the enter transition's animation frames or typing responsiveness.
    pendingIdleHandle = requestIdle(() => {
      pendingIdleHandle = null;
      updateMatchInfo(autoSelect);
    });
  }, delay);
}

function scheduleDocumentSearchUpdate() {
  if (!searchVisible.value || !searchText.value) return;
  clearDocumentSearchUpdate();
  clearPendingIdle();
  documentSearchUpdateTimer = setTimeout(() => {
    documentSearchUpdateTimer = null;
    pendingIdleHandle = requestIdle(() => {
      pendingIdleHandle = null;
      updateMatchInfo();
    });
  }, DOCUMENT_SEARCH_UPDATE_DELAY_MS);
}

function openSearch(): boolean {
  searchVisible.value = true;
  const v = props.view;
  if (v) {
    cmOpenSearchPanel(v);
    const sel = v.state.selection.main;
    const selText = v.state.sliceDoc(sel.from, sel.to);
    if (selText && !selText.includes("\n")) {
      searchText.value = selText;
    }
    // Set scope when there's a multi-line selection
    if (!sel.empty && selText.includes("\n")) {
      searchScopeFrom = sel.from;
      searchScopeTo = sel.to;
      inSelectionScope.value = true;
    } else {
      searchScopeFrom = null;
      searchScopeTo = null;
      inSelectionScope.value = false;
    }
  }
  nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
  if (searchText.value) scheduleSearchUpdate(true, SEARCH_OPEN_DELAY_MS);
  return true;
}

function openReplace(): boolean {
  openSearch();
  showReplace.value = true;
  nextTick(() => {
    replaceInputRef.value?.focus();
    replaceInputRef.value?.select();
  });
  return true;
}

function closeSearch() {
  const wasVisible = searchVisible.value;
  searchVisible.value = false;
  showReplace.value = false;
  clearDocumentSearchUpdate();
  clearPendingIdle();
  searchScopeFrom = null;
  searchScopeTo = null;
  inSelectionScope.value = false;
  const v = props.view;
  if (v) {
    clearSearchQuery();
    v.focus();
  }
  return wasVisible;
}

function selectAllMatches() {
  const v = props.view;
  if (!v) return false;
  const limit = searchMatchLimit();
  const matches = collectAllMatches(v, limit + 1);
  selectionLimitReached.value = matches.length > limit;
  const ranges = selectionRangesForSearchMatches(matches.slice(0, limit));
  if (ranges.length === 0) return false;
  v.dispatch({ selection: EditorSelection.create(ranges), scrollIntoView: true });
  updateMatchInfo();
  v.focus();
  return true;
}

function appendMatch(direction: EditorSearchSelectionDirection) {
  const v = props.view;
  if (!v) return false;
  const selection = appendSearchMatchSelection(v.state.selection, iterateAllMatches(v), direction);
  if (!selection) return false;
  v.dispatch({ selection, scrollIntoView: true });
  updateMatchInfo();
  v.focus();
  return true;
}

function nextMatch(event?: MouseEvent) {
  if (event && isSearchAddSelectionModifier(event)) {
    event.preventDefault();
    appendMatch("next");
    return;
  }
  const v = props.view;
  if (!v || !searchText.value) return;
  if (searchScopeFrom != null) {
    findInScope("next");
  } else {
    cmFindNext(v);
  }
  updateMatchInfo();
}

function prevMatch(event?: MouseEvent) {
  if (event && isSearchAddSelectionModifier(event)) {
    event.preventDefault();
    appendMatch("prev");
    return;
  }
  const v = props.view;
  if (!v || !searchText.value) return;
  if (searchScopeFrom != null) {
    findInScope("prev");
  } else {
    cmFindPrevious(v);
  }
  updateMatchInfo();
}

function doReplace() {
  const v = props.view;
  if (!v || !searchText.value) return;

  if (searchScopeFrom != null && searchScopeTo != null) {
    // Scoped replace: find and replace next match within scope
    const sel = v.state.selection.main;
    const q = createEditorSearchQuery({
      search: searchText.value,
      caseSensitive: caseSensitive.value,
      useRegex: useRegex.value,
    });
    if (!q.valid) return;
    const iter = q.getCursor(v.state);
    let r = iter.next();
    let target: { from: number; to: number } | null = null;
    while (!r.done) {
      if (r.value.from >= searchScopeFrom && r.value.to <= searchScopeTo && r.value.from >= sel.from) {
        target = { from: r.value.from, to: r.value.to };
        break;
      }
      r = iter.next();
    }
    if (target) {
      const insertText = computeReplacementForMatch(v, target.from, target.to);
      const tr = v.state.changeByRange((range) => {
        if (range.from === target!.from && range.to === target!.to) {
          return {
            changes: { from: target!.from, to: target!.to, insert: insertText },
            range: EditorSelection.range(target!.from, target!.from + insertText.length),
          };
        }
        return { range };
      });
      v.dispatch(tr);
      // Map scope through changes
      searchScopeFrom = tr.changes.mapPos(searchScopeFrom);
      searchScopeTo = tr.changes.mapPos(searchScopeTo);
    } else {
      // Wrap around to start of scope
      findInScope("next");
    }
  } else {
    cmReplaceNext(v);
  }
  updateMatchInfo(true);
}

function doReplaceAll() {
  const v = props.view;
  if (!v || !searchText.value) return;

  if (searchScopeFrom != null && searchScopeTo != null) {
    // Scoped replace all: collect matches and replace
    const matches = collectScopedMatches(v, Number.POSITIVE_INFINITY);
    if (!matches || matches.length === 0) return;
    replaceEditorSearchMatches(v, matches, (match) => computeReplacementForMatch(v, match.from, match.to));
  } else {
    cmReplaceAll(v);
  }
  updateMatchInfo();
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearch();
  } else if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    nextMatch();
  } else if (e.key === "Enter" && e.shiftKey) {
    e.preventDefault();
    prevMatch();
  }
}

watch([searchText, caseSensitive, useRegex], () => {
  if (searchVisible.value) scheduleSearchUpdate(true);
});

watch(replaceText, () => {
  if (searchVisible.value) dispatchSearchQuery();
});

onBeforeUnmount(() => {
  clearDocumentSearchUpdate();
  clearPendingIdle();
  if (searchUpdateTimer) {
    clearTimeout(searchUpdateTimer);
    searchUpdateTimer = null;
  }
});

defineExpose({
  openSearch,
  openReplace,
  closeSearch,
  scheduleDocumentSearchUpdate,
});
</script>

<template>
  <Transition enter-active-class="transition-[transform,opacity] duration-150 will-change-[transform,opacity]" leave-active-class="transition-[transform,opacity] duration-100 will-change-[transform,opacity]" enter-from-class="opacity-0 -translate-y-1" leave-to-class="opacity-0 -translate-y-1">
    <div v-if="searchVisible" class="editor-search-panel absolute right-4 top-3 z-[9999] isolate flex flex-col gap-1 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-xl ring-1 ring-border/60" :class="{ 'editor-search-panel--editor': tone === 'editor' }">
      <div class="flex items-center gap-1">
        <button class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="showReplace ? t('editor.search.collapseReplace') : t('editor.search.expandReplace')" @click="showReplace = !showReplace">
          <ChevronRight class="h-4 w-4 transition-transform" :class="showReplace && 'rotate-90'" />
        </button>
        <div class="flex h-8 w-64 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <input
            ref="searchInputRef"
            v-model="searchText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            :placeholder="t('editor.search.find')"
            @keydown="onSearchKeydown"
          />
          <button
            class="flex h-6 min-w-7 items-center justify-center rounded px-1.5 text-xs font-medium transition-colors hover:bg-accent hover:text-foreground"
            :class="caseSensitive ? 'bg-accent text-foreground' : 'text-muted-foreground'"
            :title="t('editor.search.caseSensitive')"
            @click="caseSensitive = !caseSensitive"
          >
            Aa
          </button>
          <button
            class="mr-1 flex h-6 min-w-7 items-center justify-center rounded px-1.5 font-mono text-xs transition-colors hover:bg-accent hover:text-foreground"
            :class="useRegex ? 'bg-accent text-foreground' : 'text-muted-foreground'"
            :title="t('editor.search.regex')"
            @click="useRegex = !useRegex"
          >
            .*
          </button>
        </div>
        <span class="min-w-[3.4rem] shrink-0 text-center text-xs" :class="searchText && matchCount === 0 ? 'text-destructive' : 'text-muted-foreground'" aria-live="polite">
          {{ selectionLimitReached ? t("editor.search.selectionLimitSummary", { limit: searchMatchLimit(), total: matchCount }) : searchText && matchCount > 0 ? `${currentMatchIndex}/${matchCount}` : t("editor.search.noResults") }}
        </span>
        <button
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          :disabled="!searchText || matchCount === 0"
          :title="selectionLimitReached ? t('editor.search.selectionTruncated', { limit: searchMatchLimit(), total: matchCount }) : t('editor.search.selectAllLimit', { limit: searchMatchLimit() })"
          :aria-label="selectionLimitReached ? t('editor.search.selectionTruncated', { limit: searchMatchLimit(), total: matchCount }) : t('editor.search.selectAllLimit', { limit: searchMatchLimit() })"
          @click="selectAllMatches"
        >
          <TextSelect class="h-4 w-4" />
        </button>
        <span v-if="inSelectionScope" class="shrink-0 rounded bg-accent px-1 py-0.5 text-[10px] font-medium text-muted-foreground" :title="t('editor.search.inSelection')">
          {{ t("editor.search.inSelection") }}
        </span>
        <button class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.prevMatch')" @click="prevMatch">
          <ChevronUp class="h-4 w-4" />
        </button>
        <button class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.nextMatch')" @click="nextMatch">
          <ChevronDown class="h-4 w-4" />
        </button>
        <button class="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.close')" @click="closeSearch">
          <X class="h-4 w-4" />
        </button>
      </div>
      <div v-if="showReplace" class="flex items-center gap-1">
        <div class="h-7 w-7 shrink-0" />
        <div class="flex h-8 w-64 items-center rounded-md border border-input bg-background focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
          <input
            ref="replaceInputRef"
            v-model="replaceText"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="h-full min-w-0 flex-1 bg-transparent px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            :placeholder="t('editor.search.replace')"
            @keydown.enter.prevent="doReplace"
            @keydown.escape.prevent="closeSearch"
          />
        </div>
        <button class="flex h-7 items-center justify-center rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.replace')" @click="doReplace">
          {{ t("editor.search.replace") }}
        </button>
        <button class="flex h-7 items-center justify-center rounded-md border border-border px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" :title="t('editor.search.replaceAll')" @click="doReplaceAll">
          {{ t("editor.search.replaceAll") }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.editor-search-panel {
  max-width: min(calc(100vw - 2rem), 620px);
}

.editor-search-panel--editor {
  background: var(--popover);
  border-color: var(--border);
  border-radius: var(--dbx-radius-fixed-6);
  box-shadow:
    0 8px 22px color-mix(in srgb, var(--foreground) 14%, transparent),
    0 1px 0 color-mix(in srgb, var(--background) 78%, transparent) inset;
  color: var(--foreground);
  gap: 3px;
  max-width: min(calc(100vw - 2rem), 500px);
  padding: 4px 6px;
  right: 0.75rem;
  top: 0.75rem;
}

.editor-search-panel--editor :deep(.h-8) {
  height: 27px;
}

.editor-search-panel--editor :deep(.h-7) {
  height: 27px;
}

.editor-search-panel--editor :deep(.w-7) {
  width: 27px;
}

.editor-search-panel--editor :deep(.w-64) {
  width: 230px;
}

.editor-search-panel--editor :deep(button) {
  font-size: 12px;
}

.editor-search-panel--editor :deep(button.px-2) {
  padding-left: 7px;
  padding-right: 7px;
}

.editor-search-panel--editor :deep(.min-w-\[3\.4rem\]) {
  min-width: 3.25rem;
}

.editor-search-panel--editor :deep(.border-input) {
  background: var(--background);
  border-color: var(--input);
  border-radius: var(--dbx-radius-fixed-5);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--foreground) 3%, transparent) inset;
}

.editor-search-panel--editor :deep(.focus-within\:border-ring:focus-within) {
  border-color: var(--ring);
  box-shadow: 0 0 0 1px var(--ring);
}

.editor-search-panel--editor :deep(input) {
  color: var(--foreground);
  font-size: 12px;
}

.editor-search-panel--editor :deep(input::placeholder) {
  color: var(--muted-foreground);
}

.editor-search-panel--editor :deep(.text-muted-foreground) {
  color: var(--muted-foreground);
}

.editor-search-panel--editor :deep(.text-destructive) {
  color: var(--destructive);
}

.editor-search-panel--editor :deep(.hover\:bg-accent:hover),
.editor-search-panel--editor :deep(.bg-accent) {
  background: var(--accent);
}

.editor-search-panel--editor :deep(.hover\:text-foreground:hover),
.editor-search-panel--editor :deep(.text-foreground) {
  color: var(--foreground);
}

.editor-search-panel--editor :deep(button.border-border) {
  border-color: var(--border);
}

@media (max-width: 720px) {
  .editor-search-panel {
    left: 0.75rem;
    right: 0.75rem;
  }
}
</style>
