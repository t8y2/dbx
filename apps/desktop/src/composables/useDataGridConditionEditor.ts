import { computed, getCurrentScope, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import { forgetDataGridConditionHistory, loadDataGridConditionHistory, rememberDataGridConditionHistory, type DataGridConditionHistoryKind, type DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";

export type DataGridConditionSuggestionKind = "column" | "history";

export interface DataGridConditionColumnSuggestion {
  name: string;
  insertText?: string;
  comment?: string | null;
}

export type DataGridConditionColumnOption = string | DataGridConditionColumnSuggestion;

export interface DataGridConditionSuggestion {
  value: string;
  insertText?: string;
  kind: DataGridConditionSuggestionKind;
  comment?: string;
}

export interface DataGridConditionSuggestionContext {
  kind: DataGridConditionHistoryKind;
  value: string;
  token: string;
  signal: AbortSignal;
}

export type DataGridConditionSuggestionProvider = (context: DataGridConditionSuggestionContext) => readonly string[] | Promise<readonly string[]>;

export interface UseDataGridConditionEditorOptions {
  kind: DataGridConditionHistoryKind;
  value: Ref<string>;
  columns?: MaybeRefOrGetter<readonly DataGridConditionColumnOption[] | undefined>;
  historyScope: MaybeRefOrGetter<DataGridConditionHistoryScope>;
  suggestionProvider?: DataGridConditionSuggestionProvider;
  suggestionDebounceMs?: number;
  suggestionLimit?: number;
}

const WHERE_TOKEN_PATTERN = /([^\s,()><=!&|]+)$/;
const ORDER_BY_TOKEN_PATTERN = /([^\s,()]+)$/;

function normalizedColumnComment(column: DataGridConditionColumnOption): string | undefined {
  if (typeof column === "string" || typeof column.comment !== "string") return undefined;
  return column.comment.trim() || undefined;
}

function activeToken(kind: DataGridConditionHistoryKind, value: string): string {
  return (
    value
      .trim()
      .split(kind === "where" ? /[\s,()><=!&|]+/ : /[\s,()]+/)
      .pop() ?? ""
  );
}

function replaceActiveToken(kind: DataGridConditionHistoryKind, value: string, replacement: string): string {
  const match = value.match(kind === "where" ? WHERE_TOKEN_PATTERN : ORDER_BY_TOKEN_PATTERN);
  if (!match) return value;
  return `${value.slice(0, -match[1].length)}${replacement}`;
}

export function useDataGridConditionEditor(options: UseDataGridConditionEditorOptions) {
  const suggestions = ref<DataGridConditionSuggestion[]>([]);
  const highlightedIndex = ref(-1);
  const historyOpen = ref(false);
  const suggestionsLoading = ref(false);
  let suggestionTimer: ReturnType<typeof setTimeout> | undefined;
  let suggestionRequestId = 0;
  let suggestionAbortController: AbortController | undefined;
  let suppressNextValueSuggestion = false;

  const dropdownOpen = computed(() => suggestions.value.length > 0 || historyOpen.value);

  function cancelSuggestionRequest() {
    if (suggestionTimer) clearTimeout(suggestionTimer);
    suggestionTimer = undefined;
    suggestionRequestId += 1;
    suggestionAbortController?.abort();
    suggestionAbortController = undefined;
    suggestionsLoading.value = false;
  }

  function dismiss() {
    cancelSuggestionRequest();
    suggestions.value = [];
    highlightedIndex.value = -1;
    historyOpen.value = false;
  }

  function defaultSuggestions(token: string): DataGridConditionSuggestion[] {
    const normalizedToken = token.toLowerCase();
    if (!normalizedToken) return [];
    const seen = new Set<string>();
    const suggestions: DataGridConditionSuggestion[] = [];
    for (const column of toValue(options.columns) ?? []) {
      const value = typeof column === "string" ? column : column.name;
      const normalizedValue = value.toLowerCase();
      if (!normalizedValue.startsWith(normalizedToken) || normalizedValue === normalizedToken || seen.has(value)) continue;
      seen.add(value);
      const comment = normalizedColumnComment(column);
      const insertText = typeof column === "string" ? value : column.insertText;
      suggestions.push({ value, kind: "column", ...(insertText !== undefined && insertText !== value ? { insertText } : {}), ...(comment ? { comment } : {}) });
    }
    return suggestions;
  }

  async function loadSuggestions(value: string, requestId: number, controller: AbortController) {
    const token = activeToken(options.kind, value);
    if (!token) return;
    suggestionsLoading.value = true;
    try {
      const values = options.suggestionProvider ? await options.suggestionProvider({ kind: options.kind, value, token, signal: controller.signal }) : undefined;
      // A slower request must never replace suggestions for a newer editor value.
      if (controller.signal.aborted || requestId !== suggestionRequestId || options.value.value !== value || historyOpen.value) return;
      const limit = options.suggestionLimit ?? 8;
      suggestions.value = values ? [...new Set(values)].slice(0, limit).map((suggestion) => ({ value: suggestion, kind: "column" })) : defaultSuggestions(token).slice(0, limit);
      highlightedIndex.value = suggestions.value.length > 0 ? 0 : -1;
    } catch (error) {
      if (!controller.signal.aborted && requestId === suggestionRequestId) {
        suggestions.value = [];
        highlightedIndex.value = -1;
        console.warn("[DBX][condition-editor] Failed to load suggestions", error);
      }
    } finally {
      if (requestId === suggestionRequestId) suggestionsLoading.value = false;
    }
  }

  function scheduleSuggestions(value: string) {
    cancelSuggestionRequest();
    suggestions.value = [];
    highlightedIndex.value = -1;
    historyOpen.value = false;
    if (!value.trim()) return;

    const requestId = suggestionRequestId;
    const controller = new AbortController();
    suggestionAbortController = controller;
    suggestionTimer = setTimeout(() => {
      suggestionTimer = undefined;
      void loadSuggestions(value, requestId, controller);
    }, options.suggestionDebounceMs ?? 0);
  }

  function openHistory() {
    cancelSuggestionRequest();
    if (dropdownOpen.value) {
      dismiss();
      return;
    }
    historyOpen.value = true;
    suggestions.value = loadDataGridConditionHistory(options.kind, toValue(options.historyScope), options.value.value).map((value) => ({ value, kind: "history" }));
    highlightedIndex.value = -1;
  }

  function deleteHistory(value: string) {
    const history = forgetDataGridConditionHistory(options.kind, toValue(options.historyScope), value);
    const query = options.value.value.trim().toLowerCase();
    suggestions.value = history.filter((item) => !query || item.toLowerCase().includes(query)).map((item) => ({ value: item, kind: "history" }));
    highlightedIndex.value = suggestions.value.length > 0 ? Math.min(Math.max(highlightedIndex.value, 0), suggestions.value.length - 1) : -1;
    historyOpen.value = true;
  }

  function rememberHistory(value = options.value.value) {
    return rememberDataGridConditionHistory(options.kind, toValue(options.historyScope), value);
  }

  function navigate(delta: number) {
    if (suggestions.value.length === 0) return false;
    if (highlightedIndex.value < 0) {
      highlightedIndex.value = delta > 0 ? 0 : suggestions.value.length - 1;
    } else {
      highlightedIndex.value = Math.min(Math.max(highlightedIndex.value + delta, 0), suggestions.value.length - 1);
    }
    return true;
  }

  function accept(index = highlightedIndex.value) {
    const suggestion = suggestions.value[index];
    if (!suggestion) return false;
    suppressNextValueSuggestion = true;
    // History is already executable SQL; only fresh column suggestions apply dialect quoting.
    options.value.value = suggestion.kind === "history" ? suggestion.value : replaceActiveToken(options.kind, options.value.value, suggestion.insertText ?? suggestion.value);
    dismiss();
    return true;
  }

  function handleKeydown(event: KeyboardEvent): "accept" | "apply" | "dismiss" | "navigate" | undefined {
    if (event.isComposing || event.key === "Process" || event.keyCode === 229) return undefined;
    if (dropdownOpen.value && event.key === "Escape") {
      event.preventDefault();
      dismiss();
      return "dismiss";
    }
    if (suggestions.value.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      navigate(event.key === "ArrowDown" ? 1 : -1);
      return "navigate";
    }
    if (suggestions.value.length > 0 && event.key === "Tab") {
      event.preventDefault();
      accept();
      return "accept";
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (suggestions.value.length > 0 && highlightedIndex.value >= 0) {
        accept();
        return "accept";
      }
      return "apply";
    }
    return undefined;
  }

  watch(options.value, (value) => {
    if (suppressNextValueSuggestion) {
      suppressNextValueSuggestion = false;
      return;
    }
    scheduleSuggestions(value);
  });
  if (getCurrentScope()) onScopeDispose(cancelSuggestionRequest);

  return {
    suggestions,
    highlightedIndex,
    historyOpen,
    suggestionsLoading,
    dropdownOpen,
    scheduleSuggestions,
    openHistory,
    deleteHistory,
    rememberHistory,
    dismiss,
    navigate,
    accept,
    handleKeydown,
  };
}
