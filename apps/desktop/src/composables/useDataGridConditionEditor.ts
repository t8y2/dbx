import { computed, getCurrentScope, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import { forgetDataGridConditionHistory, loadDataGridConditionHistory, rememberDataGridConditionHistory, type DataGridConditionHistoryKind, type DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";

export type DataGridConditionSuggestionKind = "column" | "keyword" | "history";

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
  valueBeforeCursor: string;
  token: string;
  from: number;
  to: number;
  selectionStart: number;
  selectionEnd: number;
  signal: AbortSignal;
}

export type DataGridConditionSuggestionProvider = (context: DataGridConditionSuggestionContext) => readonly string[] | Promise<readonly string[]>;

export interface UseDataGridConditionEditorOptions {
  kind: DataGridConditionHistoryKind;
  value: Ref<string>;
  selectionStart?: Ref<number>;
  selectionEnd?: Ref<number>;
  identifierQuote?: MaybeRefOrGetter<string | undefined>;
  columns?: MaybeRefOrGetter<readonly DataGridConditionColumnOption[] | undefined>;
  historyScope: MaybeRefOrGetter<DataGridConditionHistoryScope>;
  suggestionProvider?: DataGridConditionSuggestionProvider;
  suggestionDebounceMs?: number;
  suggestionLimit?: number;
}

const WHERE_TOKEN_PATTERN = /([^\s,()><=!&|]+)$/;
const ORDER_BY_TOKEN_PATTERN = /([^\s,()]+)$/;
const WHERE_TOKEN_FORWARD_PATTERN = /^([^\s,()><=!&|]+)/;
const ORDER_BY_TOKEN_FORWARD_PATTERN = /^([^\s,()]+)/;
const WHERE_CONNECTOR_KEYWORDS = ["AND", "OR"] as const;
const WHERE_VALUE_OPERATOR_PATTERN = /(?:^|[\s(])(?:IS(?:\s+NOT)?|(?:NOT\s+)?(?:LIKE|ILIKE|IN|BETWEEN)|SIMILAR\s+TO|REGEXP|RLIKE|GLOB|MATCH)\s*$/i;

interface DataGridConditionCompletionTarget {
  value: string;
  valueBeforeCursor: string;
  token: string;
  from: number;
  to: number;
  selectionStart: number;
  selectionEnd: number;
  quotedIdentifier: boolean;
  insideString: boolean;
}

interface ActiveQuote {
  kind: "identifier" | "string";
  close: string;
  contentStart: number;
}

function normalizedColumnComment(column: DataGridConditionColumnOption): string | undefined {
  if (typeof column === "string" || typeof column.comment !== "string") return undefined;
  return column.comment.trim() || undefined;
}

function normalizedIdentifierQuote(identifierQuote: string | undefined): string | undefined {
  const quote = identifierQuote?.trim();
  return quote && quote !== "'" ? quote : undefined;
}

function identifierCloseQuote(open: string): string {
  return open === "[" ? "]" : open;
}

function activeQuoteAt(value: string, cursor: number, identifierQuote: string | undefined): ActiveQuote | undefined {
  const identifierOpen = normalizedIdentifierQuote(identifierQuote);
  const identifierClose = identifierOpen ? identifierCloseQuote(identifierOpen) : undefined;
  let active: ActiveQuote | undefined;
  for (let index = 0; index < cursor; index += 1) {
    const character = value[index];
    if (!active) {
      if (identifierOpen && value.startsWith(identifierOpen, index)) {
        active = { kind: "identifier", close: identifierClose!, contentStart: index + identifierOpen.length };
        index += identifierOpen.length - 1;
      } else if (character === "'" || (character === '"' && identifierOpen !== '"')) {
        active = { kind: "string", close: character, contentStart: index + 1 };
      }
      continue;
    }
    if (active.kind === "string" && character === "\\") {
      index += 1;
      continue;
    }
    if (!value.startsWith(active.close, index)) continue;
    if (value.startsWith(active.close + active.close, index) && index + active.close.length * 2 <= cursor) {
      index += active.close.length * 2 - 1;
      continue;
    }
    index += active.close.length - 1;
    active = undefined;
  }
  return active;
}

function clampedSelection(value: string, selectionStart: number | undefined, selectionEnd: number | undefined): { start: number; end: number } {
  const start = Math.min(Math.max(selectionStart ?? value.length, 0), value.length);
  const end = Math.min(Math.max(selectionEnd ?? start, start), value.length);
  return { start, end };
}

function conditionCompletionTarget(kind: DataGridConditionHistoryKind, value: string, selectionStart: number | undefined, selectionEnd: number | undefined, identifierQuote: string | undefined): DataGridConditionCompletionTarget {
  const selection = clampedSelection(value, selectionStart, selectionEnd);
  const valueBeforeCursor = value.slice(0, selection.start);
  const quote = kind === "where" ? activeQuoteAt(value, selection.start, identifierQuote) : undefined;
  if (quote?.kind === "string") {
    return { value, valueBeforeCursor, token: "", from: selection.start, to: selection.end, selectionStart: selection.start, selectionEnd: selection.end, quotedIdentifier: false, insideString: true };
  }
  if (quote?.kind === "identifier") {
    const closeIndex = selection.start === selection.end ? value.indexOf(quote.close, selection.start) : -1;
    return {
      value,
      valueBeforeCursor,
      token: selection.start === selection.end ? value.slice(quote.contentStart, selection.start) : value.slice(selection.start, selection.end),
      from: selection.start === selection.end ? quote.contentStart : selection.start,
      to: selection.start === selection.end && closeIndex >= 0 ? closeIndex : selection.end,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      quotedIdentifier: true,
      insideString: false,
    };
  }
  if (selection.start !== selection.end) {
    return {
      value,
      valueBeforeCursor,
      token: value.slice(selection.start, selection.end),
      from: selection.start,
      to: selection.end,
      selectionStart: selection.start,
      selectionEnd: selection.end,
      quotedIdentifier: false,
      insideString: false,
    };
  }
  const beforeMatch = valueBeforeCursor.match(kind === "where" ? WHERE_TOKEN_PATTERN : ORDER_BY_TOKEN_PATTERN);
  const token = beforeMatch?.[1] ?? "";
  const afterMatch = value.slice(selection.start).match(kind === "where" ? WHERE_TOKEN_FORWARD_PATTERN : ORDER_BY_TOKEN_FORWARD_PATTERN);
  return {
    value,
    valueBeforeCursor,
    token,
    from: selection.start - token.length,
    to: selection.start + (afterMatch?.[1].length ?? 0),
    selectionStart: selection.start,
    selectionEnd: selection.end,
    quotedIdentifier: false,
    insideString: false,
  };
}

function whereSuggestionRole(target: DataGridConditionCompletionTarget): "field" | "connector" | "none" {
  if (target.insideString) return "none";
  if (target.quotedIdentifier) return "field";
  const prefix = target.value.slice(0, target.from).trimEnd();
  if (WHERE_VALUE_OPERATOR_PATTERN.test(prefix)) return "none";
  if (!prefix || /(?:^|\s)(?:AND|OR|NOT)$/i.test(prefix) || /[,(<>=!~+\-*/]$/.test(prefix)) return "field";
  return "connector";
}

export interface DataGridConditionQuoteCompletion {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export function completeDataGridConditionQuote(value: string, selectionStart: number, selectionEnd: number, quote: "'" | '"'): DataGridConditionQuoteCompletion {
  if (selectionStart === selectionEnd && value[selectionStart] === quote) {
    return { value, selectionStart: selectionStart + 1, selectionEnd: selectionStart + 1 };
  }
  const selected = value.slice(selectionStart, selectionEnd);
  const nextValue = `${value.slice(0, selectionStart)}${quote}${selected}${quote}${value.slice(selectionEnd)}`;
  if (selected) return { value: nextValue, selectionStart: selectionStart + 1, selectionEnd: selectionEnd + 1 };
  return { value: nextValue, selectionStart: selectionStart + 1, selectionEnd: selectionStart + 1 };
}

export function useDataGridConditionEditor(options: UseDataGridConditionEditorOptions) {
  const suggestions = ref<DataGridConditionSuggestion[]>([]);
  const highlightedIndex = ref(-1);
  const historyOpen = ref(false);
  const suggestionsLoading = ref(false);
  const replacementRange = ref<{ from: number; to: number }>();
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
    replacementRange.value = undefined;
  }

  function defaultSuggestions(target: DataGridConditionCompletionTarget): DataGridConditionSuggestion[] {
    const role = options.kind === "where" ? whereSuggestionRole(target) : "field";
    if (role === "none") return [];
    const normalizedToken = target.token.toLowerCase();
    const seen = new Set<string>();
    const suggestions: DataGridConditionSuggestion[] = [];
    if (role === "field") {
      for (const column of toValue(options.columns) ?? []) {
        const columnValue = typeof column === "string" ? column : column.name;
        const normalizedValue = columnValue.toLowerCase();
        if ((normalizedToken && (!normalizedValue.startsWith(normalizedToken) || normalizedValue === normalizedToken)) || seen.has(columnValue)) continue;
        seen.add(columnValue);
        const comment = normalizedColumnComment(column);
        const insertText = target.quotedIdentifier ? columnValue : typeof column === "string" ? columnValue : column.insertText;
        suggestions.push({ value: columnValue, kind: "column", ...(insertText !== undefined && insertText !== columnValue ? { insertText } : {}), ...(comment ? { comment } : {}) });
      }
    } else {
      for (const keyword of WHERE_CONNECTOR_KEYWORDS) {
        if (!keyword.toLowerCase().startsWith(normalizedToken) || keyword.toLowerCase() === normalizedToken) continue;
        suggestions.push({ value: keyword, kind: "keyword" });
      }
    }
    return suggestions;
  }

  async function loadSuggestions(target: DataGridConditionCompletionTarget, requestId: number, controller: AbortController) {
    if (!target.token && (options.kind !== "where" || !target.value.trim())) return;
    suggestionsLoading.value = true;
    try {
      const role = options.kind === "where" ? whereSuggestionRole(target) : "field";
      const values =
        options.suggestionProvider && target.token && role === "field"
          ? await options.suggestionProvider({ kind: options.kind, value: target.value, valueBeforeCursor: target.valueBeforeCursor, token: target.token, from: target.from, to: target.to, selectionStart: target.selectionStart, selectionEnd: target.selectionEnd, signal: controller.signal })
          : undefined;
      // A slower request must never replace suggestions for a newer editor value.
      if (controller.signal.aborted || requestId !== suggestionRequestId || options.value.value !== target.value || historyOpen.value) return;
      const limit = options.suggestionLimit ?? 8;
      suggestions.value = values ? [...new Set(values)].slice(0, limit).map((suggestion) => ({ value: suggestion, kind: "column" })) : defaultSuggestions(target).slice(0, limit);
      replacementRange.value = { from: target.from, to: target.to };
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

  function scheduleSuggestions(value: string, selectionStart = options.selectionStart?.value, selectionEnd = options.selectionEnd?.value) {
    cancelSuggestionRequest();
    suggestions.value = [];
    highlightedIndex.value = -1;
    historyOpen.value = false;
    if (!value.trim()) return;

    const target = conditionCompletionTarget(options.kind, value, selectionStart, selectionEnd, toValue(options.identifierQuote));

    const requestId = suggestionRequestId;
    const controller = new AbortController();
    suggestionAbortController = controller;
    suggestionTimer = setTimeout(() => {
      suggestionTimer = undefined;
      void loadSuggestions(target, requestId, controller);
    }, options.suggestionDebounceMs ?? 0);
  }

  function openHistory() {
    cancelSuggestionRequest();
    if (dropdownOpen.value) {
      dismiss();
      return;
    }
    historyOpen.value = true;
    replacementRange.value = undefined;
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
    let caret: number;
    if (suggestion.kind === "history") {
      suppressNextValueSuggestion = true;
      options.value.value = suggestion.value;
      caret = suggestion.value.length;
    } else {
      const range = replacementRange.value;
      const currentTarget = conditionCompletionTarget(options.kind, options.value.value, options.selectionStart?.value, options.selectionEnd?.value, toValue(options.identifierQuote));
      if (!range || currentTarget.from !== range.from || currentTarget.to !== range.to) return false;
      const replacement = suggestion.insertText ?? suggestion.value;
      suppressNextValueSuggestion = true;
      options.value.value = `${options.value.value.slice(0, range.from)}${replacement}${options.value.value.slice(range.to)}`;
      caret = range.from + replacement.length;
    }
    if (options.selectionStart) options.selectionStart.value = caret;
    if (options.selectionEnd) options.selectionEnd.value = caret;
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
      if (!accept()) return undefined;
      event.preventDefault();
      return "accept";
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (suggestions.value.length > 0 && highlightedIndex.value >= 0) {
        if (accept()) return "accept";
      }
      return "apply";
    }
    return undefined;
  }

  watch(
    () => [options.value.value, options.selectionStart?.value, options.selectionEnd?.value] as const,
    ([value, selectionStart, selectionEnd]) => {
      if (suppressNextValueSuggestion) {
        suppressNextValueSuggestion = false;
        return;
      }
      scheduleSuggestions(value, selectionStart, selectionEnd);
    },
  );
  if (getCurrentScope()) onScopeDispose(cancelSuggestionRequest);

  return {
    suggestions,
    highlightedIndex,
    historyOpen,
    suggestionsLoading,
    replacementRange,
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
