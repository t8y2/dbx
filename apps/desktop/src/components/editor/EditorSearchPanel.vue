<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { EditorView } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { SearchQuery, setSearchQuery, openSearchPanel as cmOpenSearchPanel, findNext as cmFindNext, findPrevious as cmFindPrevious, replaceNext as cmReplaceNext, replaceAll as cmReplaceAll } from "@codemirror/search";
import { ChevronUp, ChevronDown, ChevronRight, X } from "@lucide/vue";

const props = defineProps<{
  view: EditorView | null;
}>();

const { t } = useI18n();

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
const matchCountLimited = ref(false);

const SEARCH_UPDATE_DELAY_MS = 120;
const MATCH_COUNT_LIMIT = 1000;

let searchUpdateTimer: ReturnType<typeof setTimeout> | null = null;

function dispatchSearchQuery() {
  const v = props.view;
  if (!v) return;
  const q = new SearchQuery({
    search: searchText.value,
    caseSensitive: caseSensitive.value,
    regexp: useRegex.value,
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
    effects: setSearchQuery.of(new SearchQuery({ search: "" })),
  });
  matchCount.value = 0;
  currentMatchIndex.value = 0;
  matchCountLimited.value = false;
}

function updateMatchInfo(autoSelect = false) {
  const v = props.view;
  if (!v || !searchText.value) {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
    matchCountLimited.value = false;
    return;
  }
  try {
    const q = new SearchQuery({
      search: searchText.value,
      caseSensitive: caseSensitive.value,
      regexp: useRegex.value,
    });
    if (!q.valid) {
      matchCount.value = 0;
      currentMatchIndex.value = 0;
      matchCountLimited.value = false;
      return;
    }
    if (autoSelect) {
      cmFindNext(v);
    }
    const iter = q.getCursor(v.state);
    let count = 0;
    let curIdx = 0;
    const selFrom = v.state.selection.main.from;
    const selTo = v.state.selection.main.to;
    let r = iter.next();
    while (!r.done) {
      count++;
      if (r.value.from === selFrom && r.value.to === selTo) curIdx = count;
      if (count >= MATCH_COUNT_LIMIT) break;
      r = iter.next();
    }
    matchCount.value = count;
    matchCountLimited.value = count >= MATCH_COUNT_LIMIT && !r.done;
    currentMatchIndex.value = curIdx || (count > 0 ? 1 : 0);
  } catch {
    matchCount.value = 0;
    currentMatchIndex.value = 0;
    matchCountLimited.value = false;
  }
}

function scheduleSearchUpdate(autoSelect = false) {
  if (searchUpdateTimer) {
    clearTimeout(searchUpdateTimer);
    searchUpdateTimer = null;
  }
  if (!searchText.value) {
    clearSearchQuery();
    return;
  }
  dispatchSearchQuery();
  searchUpdateTimer = setTimeout(() => {
    searchUpdateTimer = null;
    updateMatchInfo(autoSelect);
  }, SEARCH_UPDATE_DELAY_MS);
}

function openSearch(): boolean {
  searchVisible.value = true;
  const v = props.view;
  if (v) {
    cmOpenSearchPanel(v);
    const sel = v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);
    if (sel && !sel.includes("\n")) searchText.value = sel;
  }
  nextTick(() => {
    searchInputRef.value?.focus();
    searchInputRef.value?.select();
  });
  if (searchText.value) scheduleSearchUpdate(true);
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
  const v = props.view;
  if (v) {
    clearSearchQuery();
    v.focus();
  }
  return wasVisible;
}

function nextMatch() {
  const v = props.view;
  if (!v || !searchText.value) return;
  cmFindNext(v);
  updateMatchInfo();
}

function prevMatch() {
  const v = props.view;
  if (!v || !searchText.value) return;
  cmFindPrevious(v);
  updateMatchInfo();
}

function doReplace() {
  const v = props.view;
  if (!v || !searchText.value) return;
  cmReplaceNext(v);
  updateMatchInfo();
}

function doReplaceAll() {
  const v = props.view;
  if (!v || !searchText.value) return;
  cmReplaceAll(v);
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
  if (searchUpdateTimer) {
    clearTimeout(searchUpdateTimer);
    searchUpdateTimer = null;
  }
});

defineExpose({ openSearch, openReplace, closeSearch });
</script>

<template>
  <Transition enter-active-class="transition-[transform,opacity] duration-150" leave-active-class="transition-[transform,opacity] duration-100" enter-from-class="opacity-0 -translate-y-1" leave-to-class="opacity-0 -translate-y-1">
    <div v-if="searchVisible" class="absolute top-1 right-4 z-[9999] isolate flex flex-col gap-1 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg">
      <div class="flex items-center gap-0.5">
        <button class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" :title="showReplace ? t('editor.search.collapseReplace') : t('editor.search.expandReplace')" @click="showReplace = !showReplace">
          <ChevronRight class="w-3 h-3 transition-transform" :class="showReplace && 'rotate-90'" />
        </button>
        <input
          ref="searchInputRef"
          v-model="searchText"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          :placeholder="t('editor.search.find')"
          @keydown="onSearchKeydown"
        />
        <button class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent" :class="caseSensitive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'" :title="t('editor.search.caseSensitive')" @click="caseSensitive = !caseSensitive">Aa</button>
        <button class="w-6 h-6 flex items-center justify-center rounded text-xs font-mono hover:bg-accent" :class="useRegex ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'" :title="t('editor.search.regex')" @click="useRegex = !useRegex">.*</button>
        <span class="text-xs text-muted-foreground min-w-[3rem] text-center shrink-0">
          {{ searchText && matchCount > 0 ? `${currentMatchIndex}/${matchCount}${matchCountLimited ? "+" : ""}` : t("editor.search.noResults") }}
        </span>
        <button class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('editor.search.prevMatch')" @click="prevMatch">
          <ChevronUp class="w-3.5 h-3.5" />
        </button>
        <button class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('editor.search.nextMatch')" @click="nextMatch">
          <ChevronDown class="w-3.5 h-3.5" />
        </button>
        <button class="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('editor.search.close')" @click="closeSearch">
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
      <div v-if="showReplace" class="flex items-center gap-0.5">
        <div class="w-5 h-5 shrink-0" />
        <input
          ref="replaceInputRef"
          v-model="replaceText"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          class="w-48 h-6 text-xs bg-input border rounded px-2 outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground"
          :placeholder="t('editor.search.replace')"
          @keydown.enter.prevent="doReplace"
          @keydown.escape.prevent="closeSearch"
        />
        <button class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border" :title="t('editor.search.replace')" @click="doReplace">
          {{ t("editor.search.replace") }}
        </button>
        <button class="h-6 px-1.5 flex items-center justify-center rounded text-xs text-muted-foreground hover:bg-accent hover:text-foreground border" :title="t('editor.search.replaceAll')" @click="doReplaceAll">
          {{ t("editor.search.replaceAll") }}
        </button>
      </div>
    </div>
  </Transition>
</template>
