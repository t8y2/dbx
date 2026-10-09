import { computed, getCurrentScope, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import { forgetDataGridConditionHistory, loadDataGridConditionHistory, rememberDataGridConditionHistory, type DataGridConditionHistoryKind, type DataGridConditionHistoryScope } from "@/lib/dataGrid/dataGridConditionHistory";
import { pinyinAwareMatchScore } from "@/lib/common/pinyin";
import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";
import type { DatabaseType } from "@/types/database";

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
  suggestionsEnabled?: MaybeRefOrGetter<boolean>;
  databaseType?: MaybeRefOrGetter<DatabaseType | undefined>;
}

const WHERE_TOKEN_PATTERN = /([^\s,()><=!&|]+)$/;
const ORDER_BY_TOKEN_PATTERN = /([^\s,()]+)$/;
const WHERE_TOKEN_FORWARD_PATTERN = /^([^\s,()><=!&|]+)/;
const ORDER_BY_TOKEN_FORWARD_PATTERN = /^([^\s,()]+)/;
export interface DataGridConditionKeyword {
  value: string;
  comment?: string;
}

export const WHERE_SYNTAX_KEYWORDS: readonly DataGridConditionKeyword[] = [
  { value: "AND" },
  { value: "OR" },
  { value: "BETWEEN", comment: "BETWEEN ... AND ..." },
  { value: "NOT BETWEEN", comment: "NOT BETWEEN ... AND ..." },
  { value: "LIKE" },
  { value: "NOT LIKE" },
  { value: "ILIKE" },
  { value: "NOT ILIKE" },
  { value: "IN" },
  { value: "NOT IN" },
  { value: "IS NULL" },
  { value: "IS NOT NULL" },
  { value: "IS" },
  { value: "NOT" },
  { value: "REGEXP" },
];

export const WHERE_IS_KEYWORDS: readonly DataGridConditionKeyword[] = [{ value: "NULL" }, { value: "NOT NULL" }, { value: "TRUE" }, { value: "FALSE" }];

export const WHERE_IS_NOT_KEYWORDS: readonly DataGridConditionKeyword[] = [{ value: "NULL" }, { value: "TRUE" }, { value: "FALSE" }];

export const WHERE_AFTER_NOT_KEYWORDS: readonly DataGridConditionKeyword[] = [{ value: "BETWEEN", comment: "BETWEEN ... AND ..." }, { value: "IN" }, { value: "LIKE" }, { value: "ILIKE" }];

const ILIKE_SUPPORTED_DATABASES: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["postgres", "redshift", "duckdb", "snowflake", "clickhouse", "databend", "kingbase", "highgo", "uxdb", "vastbase", "gaussdb", "opengauss", "questdb", "vertica", "databricks", "kwdb", "h2"]);

// SQLite parses `x REGEXP y` but needs a driver-registered regexp() function,
// which DBX does not provide, so the SQLite family is excluded; Hive-family
// dialects ship the REGEXP/RLIKE binary operator.
const REGEXP_OPERATOR_SUPPORTED_DATABASES: ReadonlySet<DatabaseType> = new Set<DatabaseType>(["mysql", "doris", "starrocks", "goldendb", "manticoresearch", "gbase", "hive", "spark", "kyuubi", "impala"]);

export function supportsConditionIlike(databaseType?: DatabaseType): boolean {
  return !databaseType || ILIKE_SUPPORTED_DATABASES.has(databaseType);
}

export function supportsConditionRegexp(databaseType?: DatabaseType): boolean {
  return !databaseType || REGEXP_OPERATOR_SUPPORTED_DATABASES.has(databaseType);
}

export function isConditionKeywordSupported(keyword: string, databaseType?: DatabaseType): boolean {
  if (!databaseType) return true;
  if (keyword === "ILIKE" || keyword === "NOT ILIKE") {
    return supportsConditionIlike(databaseType);
  }
  if (keyword === "REGEXP") {
    return supportsConditionRegexp(databaseType);
  }
  return true;
}

function filterKeywordSuggestions(keywords: readonly (DataGridConditionKeyword | string)[], normalizedToken: string, predicate?: (value: string) => boolean): DataGridConditionSuggestion[] {
  const result: DataGridConditionSuggestion[] = [];
  for (const keyword of keywords) {
    const value = typeof keyword === "string" ? keyword : keyword.value;
    const comment = typeof keyword === "string" ? undefined : keyword.comment;
    if (predicate && !predicate(value)) continue;
    const lower = value.toLowerCase();
    if (normalizedToken && (!lower.startsWith(normalizedToken) || lower === normalizedToken)) continue;
    result.push({ value, kind: "keyword", ...(comment ? { comment } : {}) });
  }
  return result;
}

const WHERE_CONNECTOR_KEYWORDS = ["AND", "OR"] as const;
const WHERE_IS_NOT_OPERATOR_PATTERN = /(?:^|[\s(])IS\s+NOT$/i;
const WHERE_IS_OPERATOR_PATTERN = /(?:^|[\s(])IS$/i;
const WHERE_VALUE_OPERATOR_PATTERN = /(?:^|[\s(])(?:(?:NOT\s+)?(?:LIKE|ILIKE|IN|BETWEEN)|SIMILAR\s+TO|REGEXP|RLIKE|GLOB|MATCH)\s*$/i;
/**
 * 比较类符号运算符。它们后面同样是「值」位置，不应再提示列名，
 * 否则用户输入值时会看到列名补全、回车/接受后输入被改写（issue #10595）。
 */
const WHERE_SYMBOLIC_COMPARISON_PATTERN = /(?:<>|!=|<=|>=|=|<|>)$/;
/** ORDER BY 中排序列之后的位置只应提示排序方向。 */
const ORDER_BY_DIRECTION_KEYWORDS = ["ASC", "DESC"] as const;

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

/**
 * 判断光标是否位于 `IN (...)` 的值列表里（括号由 IN / NOT IN 打开且尚未闭合）。
 *
 * `IN (` 之后要输入的是值列表而不是列名；但裸括号（`WHERE (v`）和函数参数里的逗号
 * 仍然属于"表达式/字段"位置，所以必须区分括号是谁打开的（issue #10595）。
 */
function insideInValueList(value: string, cursor: number, identifierQuote: string | undefined): boolean {
  const identifierOpen = normalizedIdentifierQuote(identifierQuote);
  const identifierClose = identifierOpen ? identifierCloseQuote(identifierOpen) : undefined;
  let stringQuote: string | undefined;
  const openParens: number[] = [];
  for (let index = 0; index < cursor; index += 1) {
    const character = value[index];
    if (stringQuote) {
      if (character === "\\") {
        index += 1;
      } else if (value.startsWith(stringQuote + stringQuote, index)) {
        index += 1;
      } else if (character === stringQuote) {
        stringQuote = undefined;
      }
      continue;
    }
    if (identifierOpen && value.startsWith(identifierOpen, index)) {
      index += identifierClose!.length - 1;
      continue;
    }
    if (character === "'" || character === '"') {
      stringQuote = character;
    } else if (character === "(") {
      openParens.push(index);
    } else if (character === ")") {
      openParens.pop();
    }
  }

  const openIndex = openParens[openParens.length - 1];
  if (openIndex === undefined) return false;
  const before = value.slice(0, openIndex).trimEnd();
  return /(?:^|[\s(])IN$/i.test(before) || /(?:^|[\s(])NOT\s+IN$/i.test(before);
}

function whereSuggestionRole(target: DataGridConditionCompletionTarget, identifierQuote: string | undefined): "field" | "connector" | "is_value" | "is_not_value" | "after_not" | "none" {
  if (target.insideString) return "none";
  if (target.quotedIdentifier) return "field";
  const prefix = target.value.slice(0, target.from).trimEnd();
  if (WHERE_IS_NOT_OPERATOR_PATTERN.test(prefix)) return "is_not_value";
  if (WHERE_IS_OPERATOR_PATTERN.test(prefix)) return "is_value";
  if (WHERE_VALUE_OPERATOR_PATTERN.test(prefix)) return "none";
  // 符号比较运算符之后是值位置：`v_id = v` 时不提示列名，只在 AND/OR 等字段位置提示
  if (WHERE_SYMBOLIC_COMPARISON_PATTERN.test(prefix)) return "none";
  // `mi_id IN (v` / `mi_id IN ('a', v` 同样是值列表，不能提示列名
  if (insideInValueList(target.value, target.from, identifierQuote)) return "none";
  if (!prefix || /(?:^|\s)(?:AND|OR)$/i.test(prefix) || /[,(+\-*/~]$/.test(prefix)) return "field";
  if (/(?:^|\s)NOT$/i.test(prefix)) return "after_not";
  return "connector";
}

/**
 * ORDER BY 的角色判定：开头或逗号之后是排序列位置（提示列名），
 * 已经写出排序列之后是排序方向位置（提示 ASC/DESC）。
 * 否则在输入 `asc` 时按 Tab 会把列名插进输入框（issue #10595）。
 */
function orderBySuggestionRole(target: DataGridConditionCompletionTarget): "field" | "direction" {
  const prefix = target.value.slice(0, target.from).trimEnd();
  return !prefix || prefix.endsWith(",") ? "field" : "direction";
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
  let suppressedSuggestionValue: string | undefined;

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

  function dismissUntilValueChanges() {
    suppressedSuggestionValue = options.value.value;
    dismiss();
  }

  function columnSuggestions(columns: readonly DataGridConditionColumnOption[], normalizedToken: string, target: DataGridConditionCompletionTarget, seen: Set<string>): DataGridConditionSuggestion[] {
    if (normalizedToken && columns.some((column) => (typeof column === "string" ? column : column.name).toLowerCase() === normalizedToken)) return [];
    const scored: Array<{ suggestion: DataGridConditionSuggestion; score: number; index: number }> = [];
    let index = 0;
    for (const column of columns) {
      const columnValue = typeof column === "string" ? column : column.name;
      if (seen.has(columnValue)) continue;
      seen.add(columnValue);
      // Keep the existing prefix/pinyin/substring ranking stable, then append
      // new camel-initial and ordered-fuzzy matches behind those tiers.
      const existingScore = normalizedToken ? pinyinAwareMatchScore(columnValue, normalizedToken) : 0;
      if (existingScore < 0 && !matchesIdentifierSearch(columnValue, normalizedToken)) continue;
      const score = existingScore < 0 ? 50 : existingScore;
      const comment = normalizedColumnComment(column);
      const insertText = target.quotedIdentifier ? columnValue : typeof column === "string" ? columnValue : column.insertText;
      scored.push({ suggestion: { value: columnValue, kind: "column", ...(insertText !== undefined && insertText !== columnValue ? { insertText } : {}), ...(comment ? { comment } : {}) }, score, index: index++ });
    }
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((entry) => entry.suggestion);
  }

  function defaultSuggestions(target: DataGridConditionCompletionTarget): DataGridConditionSuggestion[] {
    const role = options.kind === "where" ? whereSuggestionRole(target, toValue(options.identifierQuote)) : orderBySuggestionRole(target);
    if (role === "none") return [];
    const normalizedToken = target.token.toLowerCase();
    const seen = new Set<string>();
    const isKeywordSupported = (keyword: string) => isConditionKeywordSupported(keyword, toValue(options.databaseType));
    if (role === "field") {
      const columns = toValue(options.columns) ?? [];
      return columnSuggestions(columns, normalizedToken, target, seen);
    }
    if (role === "after_not") {
      const columns = toValue(options.columns) ?? [];
      const suggestions = columnSuggestions(columns, normalizedToken, target, seen);
      if (normalizedToken) {
        suggestions.push(...filterKeywordSuggestions(WHERE_AFTER_NOT_KEYWORDS, normalizedToken, isKeywordSupported));
      }
      return suggestions;
    }
    if (role === "is_value") {
      return normalizedToken ? filterKeywordSuggestions(WHERE_IS_KEYWORDS, normalizedToken) : [];
    }
    if (role === "is_not_value") {
      return normalizedToken ? filterKeywordSuggestions(WHERE_IS_NOT_KEYWORDS, normalizedToken) : [];
    }
    if (options.kind === "where") {
      // WHERE 已写完一个表达式时提示连接符；在列或操作符位置提示 SQL 语法及连接符
      const keywords = normalizedToken ? WHERE_SYNTAX_KEYWORDS : WHERE_CONNECTOR_KEYWORDS;
      return filterKeywordSuggestions(keywords, normalizedToken, isKeywordSupported);
    }
    // ORDER BY 已写出排序列时提示排序方向。
    return filterKeywordSuggestions(ORDER_BY_DIRECTION_KEYWORDS, normalizedToken);
  }

  async function loadSuggestions(target: DataGridConditionCompletionTarget, requestId: number, controller: AbortController) {
    if (!target.token && (options.kind !== "where" || !target.value.trim())) return;
    suggestionsLoading.value = true;
    try {
      const role = options.kind === "where" ? whereSuggestionRole(target, toValue(options.identifierQuote)) : orderBySuggestionRole(target);
      const values =
        options.suggestionProvider && target.token && (role === "field" || role === "after_not")
          ? await options.suggestionProvider({ kind: options.kind, value: target.value, valueBeforeCursor: target.valueBeforeCursor, token: target.token, from: target.from, to: target.to, selectionStart: target.selectionStart, selectionEnd: target.selectionEnd, signal: controller.signal })
          : undefined;
      // A slower request must never replace suggestions for a newer editor value.
      if (controller.signal.aborted || requestId !== suggestionRequestId || options.value.value !== target.value || historyOpen.value) return;
      const limit = options.suggestionLimit ?? 8;
      const providerValues = values ? [...new Set(values)] : undefined;
      suggestions.value = providerValues ? (providerValues.some((value) => value.toLowerCase() === target.token.toLowerCase()) ? [] : providerValues.slice(0, limit).map((suggestion) => ({ value: suggestion, kind: "column" }))) : defaultSuggestions(target).slice(0, limit);
      replacementRange.value = { from: target.from, to: target.to };
      // 不再默认高亮第一条建议：否则用户按回车«应用筛选»时会先把高亮项写进输入框（issue #10595）。
      // 接受补全需要显式操作（↓/↑ 后回车、Tab 或点击）。
      highlightedIndex.value = -1;
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
    if (options.suggestionsEnabled !== undefined && !toValue(options.suggestionsEnabled)) return;
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
    highlightedIndex.value = suggestions.value.length > 0 && highlightedIndex.value >= 0 ? Math.min(highlightedIndex.value, suggestions.value.length - 1) : -1;
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

  function accept(index = highlightedIndex.value >= 0 ? highlightedIndex.value : 0) {
    const suggestion = suggestions.value[index];
    if (!suggestion) return false;
    let caret: number;
    if (suggestion.kind === "history") {
      options.value.value = suggestion.value;
      caret = suggestion.value.length;
    } else {
      const range = replacementRange.value;
      const currentTarget = conditionCompletionTarget(options.kind, options.value.value, options.selectionStart?.value, options.selectionEnd?.value, toValue(options.identifierQuote));
      if (!range || currentTarget.from !== range.from || currentTarget.to !== range.to) return false;
      const replacement = suggestion.insertText ?? suggestion.value;
      options.value.value = `${options.value.value.slice(0, range.from)}${replacement}${options.value.value.slice(range.to)}`;
      caret = range.from + replacement.length;
    }
    suppressedSuggestionValue = options.value.value;
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
      dismissUntilValueChanges();
      return "apply";
    }
    return undefined;
  }

  watch(
    () => [options.value.value, options.selectionStart?.value, options.selectionEnd?.value] as const,
    ([value, selectionStart, selectionEnd]) => {
      if (suppressedSuggestionValue !== undefined) {
        if (value === suppressedSuggestionValue) return;
        suppressedSuggestionValue = undefined;
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
