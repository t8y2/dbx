import { computed, getCurrentScope, nextTick, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import { dataGridSearchMatchKey } from "@/lib/dataGrid/canvasDataGridRenderer";

export type DataGridSearchMatch = {
  kind: "cell" | "column";
  displayRow: number;
  col: number;
};

export type UseDataGridSearchOptions<Row> = {
  columns: MaybeRefOrGetter<readonly string[]>;
  suggestionColumns?: MaybeRefOrGetter<readonly string[]>;
  rows: MaybeRefOrGetter<readonly Row[]>;
  /** 必须返回小写文本（查询词已小写）。调用方可据此缓存小写副本，
   * 避免每次按键对全部单元格重新分配 toLowerCase 字符串。 */
  getCellSearchText: (row: Row, columnIndex: number) => string;
  debounceMs?: number;
  onNavigate?: (match: DataGridSearchMatch) => void;
};

const SEARCH_TOKEN_SEPARATOR = /[\s,()><=!&|]+/;
const SEARCH_TOKEN_SUFFIX = /([^\s,()><=!&|]+)$/;
const SEARCH_PAIRS: Record<string, string> = { "'": "'", '"': '"', "(": ")" };

export function useDataGridSearch<Row>(options: UseDataGridSearchOptions<Row>) {
  const searchText = ref("");
  const deferredSearchText = ref("");
  const overlayVisible = ref(false);
  const currentMatchIndex = ref(-1);
  const suggestions = ref<string[]>([]);
  const suggestionIndex = ref(-1);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const matches = computed<DataGridSearchMatch[]>(() => {
    const query = deferredSearchText.value;
    if (!query) return [];
    const result: DataGridSearchMatch[] = [];
    const columns = toValue(options.columns);
    columns.forEach((column, col) => {
      if (column.toLowerCase().includes(query)) result.push({ kind: "column", displayRow: -1, col });
    });
    toValue(options.rows).forEach((row, displayRow) => {
      columns.forEach((_, col) => {
        if (options.getCellSearchText(row, col).includes(query)) result.push({ kind: "cell", displayRow, col });
      });
    });
    return result;
  });
  // 数值 key（列头匹配 displayRow=-1），避免每匹配一次字符串拼接
  const matchSet = computed(() => new Set(matches.value.map((match) => dataGridSearchMatchKey(match.displayRow, match.col))));
  const currentMatch = computed(() => matches.value[currentMatchIndex.value] ?? null);

  function clearTimer() {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
  }

  watch(searchText, (value) => {
    clearTimer();
    const query = value.trim().toLowerCase();
    if (!query) deferredSearchText.value = "";
    else searchTimer = setTimeout(() => (deferredSearchText.value = query), options.debounceMs ?? 150);

    const lastToken = value.trim().split(SEARCH_TOKEN_SEPARATOR).pop()?.toLowerCase() ?? "";
    suggestions.value = lastToken
      ? toValue(options.suggestionColumns ?? options.columns)
          .filter((column) => column.toLowerCase().startsWith(lastToken) && column.toLowerCase() !== lastToken)
          .slice(0, 8)
      : [];
    suggestionIndex.value = suggestions.value.length ? 0 : -1;
  });

  watch(matches, (value) => {
    currentMatchIndex.value = value.length ? 0 : -1;
    if (value[0]) nextTick(() => options.onNavigate?.(value[0]));
  });

  function acceptSuggestion(index = suggestionIndex.value) {
    const suggestion = suggestions.value[index];
    if (!suggestion) return false;
    const token = searchText.value.match(SEARCH_TOKEN_SUFFIX)?.[1];
    if (token) searchText.value = searchText.value.slice(0, -token.length) + suggestion;
    suggestions.value = [];
    suggestionIndex.value = -1;
    return true;
  }

  function navigateSuggestion(delta: number) {
    if (!suggestions.value.length) return;
    suggestionIndex.value = Math.min(Math.max(suggestionIndex.value + delta, 0), suggestions.value.length - 1);
  }

  function navigateMatch(delta: number) {
    const matchCount = matches.value.length;
    if (!matchCount) return;
    // Results may change between input and navigation; recover from a stale index in the requested direction.
    const currentIndex = currentMatchIndex.value >= 0 && currentMatchIndex.value < matchCount ? currentMatchIndex.value : delta < 0 ? 0 : -1;
    currentMatchIndex.value = (((currentIndex + delta) % matchCount) + matchCount) % matchCount;
    const match = currentMatch.value;
    if (match) options.onNavigate?.(match);
  }

  function close() {
    clearTimer();
    overlayVisible.value = false;
    searchText.value = "";
    deferredSearchText.value = "";
    suggestions.value = [];
  }

  function onKeydown(event: KeyboardEvent) {
    const pair = SEARCH_PAIRS[event.key];
    const input = event.target as HTMLInputElement;
    if (pair && !event.ctrlKey && !event.metaKey && input?.setSelectionRange) {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      event.preventDefault();
      const selected = searchText.value.slice(start, end);
      searchText.value = `${searchText.value.slice(0, start)}${event.key}${selected}${pair}${searchText.value.slice(end)}`;
      nextTick(() => input.setSelectionRange(start + 1 + selected.length, start + 1 + selected.length));
      return;
    }
    if (suggestions.value.length && event.key === "Tab") {
      event.preventDefault();
      acceptSuggestion();
    } else if (suggestions.value.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      navigateSuggestion(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      navigateMatch(event.shiftKey ? -1 : 1);
    }
  }

  if (getCurrentScope()) onScopeDispose(clearTimer);

  return { searchText, deferredSearchText, overlayVisible, currentMatchIndex, suggestions, suggestionIndex, matches, matchSet, currentMatch, acceptSuggestion, navigateSuggestion, navigateMatch, close, onKeydown };
}
