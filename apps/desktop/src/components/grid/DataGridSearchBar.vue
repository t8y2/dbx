<script setup lang="ts">
import { ref } from "vue";
import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Search, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { vNamingStyleSupport } from "@/directives/vNamingStyleSupport";
import type { DataGridReplaceScope } from "@/lib/dataGrid/dataGridReplace";

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    open: boolean;
    suggestions: string[];
    suggestionIndex: number;
    matchCount: number;
    currentMatchIndex: number;
    hasDeferredSearchText: boolean;
    /** 结果里含被截断显示的长值（large_value_cells），搜索只覆盖显示文本。 */
    valuesTruncated?: boolean;
    replaceAvailable?: boolean;
    replaceBusy?: boolean;
    replaceMatchCount?: number;
    canReplaceCurrent?: boolean;
    columns?: string[];
  }>(),
  { replaceAvailable: undefined },
);

const searchText = defineModel<string>("text", { default: "" });
const replaceOpen = defineModel<boolean>("replaceOpen", { default: false });
const replacementText = defineModel<string>("replacementText", { default: "" });
const replaceScope = defineModel<DataGridReplaceScope>("replaceScope", { default: "loaded" });
const caseSensitive = defineModel<boolean>("caseSensitive", { default: false });
const replaceColumn = defineModel<number>("replaceColumn", { default: -1 });
const emit = defineEmits<{
  keydown: [event: KeyboardEvent];
  close: [];
  navigate: [delta: number];
  acceptSuggestion: [index: number];
  hoverSuggestion: [index: number];
  replaceCurrent: [];
  replaceAll: [];
}>();

const searchInput = ref<HTMLInputElement>();

function onSuggestionMouseDown(event: MouseEvent, index: number) {
  event.preventDefault();
  emit("acceptSuggestion", index);
}

function keepSearchInputFocused(event: MouseEvent) {
  // Pointer navigation should not move focus away from the search input; keyboard activation still uses click.
  event.preventDefault();
}

defineExpose({
  focus: (select = false) => {
    searchInput.value?.focus();
    if (select) searchInput.value?.select();
  },
});
</script>

<template>
  <Transition enter-active-class="transition-opacity duration-150" leave-active-class="transition-opacity duration-100" enter-from-class="opacity-0" leave-to-class="opacity-0">
    <div v-if="props.open" data-grid-search-bar class="absolute top-1 right-2 z-20 max-w-[calc(100%-1rem)] px-2 py-1 bg-background border rounded-md shadow-md" @keydown.esc.stop.prevent="emit('close')">
      <div class="flex items-center gap-1 min-w-0">
        <button
          v-if="props.replaceAvailable !== undefined"
          data-grid-replace-toggle
          type="button"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          :disabled="!props.replaceAvailable"
          :title="t(replaceOpen ? 'editor.search.collapseReplace' : 'editor.search.expandReplace')"
          :aria-label="t(replaceOpen ? 'editor.search.collapseReplace' : 'editor.search.expandReplace')"
          :aria-expanded="replaceOpen"
          @click="replaceOpen = !replaceOpen"
        >
          <ChevronDown v-if="replaceOpen" class="w-3.5 h-3.5" />
          <ChevronRight v-else class="w-3.5 h-3.5" />
        </button>
        <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <input
          ref="searchInput"
          v-model="searchText"
          v-naming-style-support
          type="search"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          class="w-48 h-5 min-w-0 flex-1 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
          :placeholder="t('grid.search')"
          @keydown="emit('keydown', $event)"
        />
        <button
          v-if="replaceOpen"
          data-grid-replace-case
          type="button"
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          :class="caseSensitive ? 'bg-accent text-accent-foreground' : ''"
          :title="t('editor.search.caseSensitive')"
          :aria-label="t('editor.search.caseSensitive')"
          :aria-pressed="caseSensitive"
          @click="caseSensitive = !caseSensitive"
        >
          <CaseSensitive class="w-3.5 h-3.5" />
        </button>
        <div v-if="props.suggestions.length > 0" class="absolute top-full right-0 mt-0.5 z-50 min-w-[180px] rounded-md border bg-popover text-popover-foreground shadow-md">
          <div
            v-for="(suggestion, index) in props.suggestions"
            :key="suggestion"
            class="flex items-center px-3 py-1.5 text-xs cursor-pointer"
            :class="index === props.suggestionIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-gray-200 dark:hover:bg-gray-800'"
            @mousedown="onSuggestionMouseDown($event, index)"
            @mouseenter="emit('hoverSuggestion', index)"
          >
            <Search class="w-3 h-3 mr-2 text-muted-foreground shrink-0" />
            <span>{{ suggestion }}</span>
          </div>
        </div>
        <!-- 截断标记：表格预览对长文本/JSON 值做服务端截断，客户端搜索只能覆盖
           显示前缀，匹配数可能少于 SQL 查询（#7279）。 -->
        <span v-if="props.valuesTruncated && (props.matchCount > 0 || props.hasDeferredSearchText)" data-grid-search-truncated-hint class="text-xs text-amber-600 dark:text-amber-400 shrink-0 cursor-help" :title="t('grid.searchTruncatedValuesHint')" :aria-label="t('grid.searchTruncatedValuesHint')"
          >≈</span
        >
        <span v-if="props.matchCount > 0" class="text-xs text-muted-foreground shrink-0">{{ props.currentMatchIndex + 1 }}/{{ props.matchCount }}</span>
        <span v-else-if="props.hasDeferredSearchText" class="text-xs text-muted-foreground shrink-0">0</span>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0"
          :disabled="props.matchCount === 0"
          :title="t('editor.search.prevMatch')"
          :aria-label="t('editor.search.prevMatch')"
          @mousedown="keepSearchInputFocused"
          @click="emit('navigate', -1)"
        >
          <ChevronUp class="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:pointer-events-none shrink-0"
          :disabled="props.matchCount === 0"
          :title="t('editor.search.nextMatch')"
          :aria-label="t('editor.search.nextMatch')"
          @mousedown="keepSearchInputFocused"
          @click="emit('navigate', 1)"
        >
          <ChevronDown class="w-3.5 h-3.5" />
        </button>
        <button type="button" class="text-muted-foreground hover:text-foreground shrink-0" :title="t('editor.search.close')" :aria-label="t('editor.search.close')" @click="emit('close')">
          <X class="w-3.5 h-3.5" />
        </button>
      </div>
      <div v-if="replaceOpen" class="flex flex-wrap items-center gap-1 mt-1 border-t pt-1">
        <input
          v-model="replacementText"
          data-grid-replacement-input
          type="text"
          autocomplete="off"
          spellcheck="false"
          class="h-6 min-w-0 w-48 flex-1 text-xs bg-transparent outline-none border rounded px-1.5"
          :placeholder="t('grid.replaceText')"
          :aria-label="t('grid.replaceText')"
          @keydown.enter.stop.prevent="props.replaceAvailable && !props.replaceBusy && props.canReplaceCurrent && emit('replaceCurrent')"
        />
        <button data-grid-replace-current type="button" class="h-6 border rounded px-2 text-xs disabled:opacity-40" :disabled="!props.replaceAvailable || props.replaceBusy || !props.canReplaceCurrent" :title="t('grid.replaceCurrentCell')" @click="emit('replaceCurrent')">
          {{ t("editor.search.replace") }}
        </button>
        <button data-grid-replace-all type="button" class="h-6 border rounded px-2 text-xs disabled:opacity-40" :disabled="!props.replaceAvailable || props.replaceBusy || !props.replaceMatchCount" @click="emit('replaceAll')">{{ t("editor.search.replaceAll") }}</button>
      </div>
      <div v-if="replaceOpen" class="flex flex-wrap items-center gap-1 mt-1 text-xs">
        <select v-model="replaceScope" data-grid-replace-scope class="min-w-0 h-6 max-w-full rounded border bg-background px-1" :aria-label="t('grid.replaceScope')">
          <option value="loaded">{{ t("grid.replaceLoadedResults") }}</option>
          <option value="column">{{ t("grid.replaceCurrentColumn") }}</option>
          <option value="selection">{{ t("grid.replaceSelectedCells") }}</option>
        </select>
        <select v-if="replaceScope === 'column'" v-model.number="replaceColumn" data-grid-replace-column class="h-6 min-w-0 flex-1 max-w-48 rounded border bg-background px-1" :aria-label="t('grid.replaceCurrentColumn')">
          <option :value="-1" disabled>{{ t("grid.replaceChooseColumn") }}</option>
          <option v-for="(column, index) in props.columns" :key="index" :value="index">{{ column }}</option>
        </select>
        <span class="text-muted-foreground" aria-live="polite">{{ t("grid.replaceMatchedCells", { count: props.replaceMatchCount ?? 0 }) }}</span>
      </div>
    </div>
  </Transition>
</template>
