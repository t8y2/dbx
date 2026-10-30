import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridStructuredSortRule } from "@/composables/useDataGridSortBuilder";
import { formatFilterRawValue } from "@/lib/dataGrid/dataGridColumnFilter";
import { isNumericColumnType } from "@/lib/dataGrid/dataGridColumnType";
import { tokenIsIdentifier, tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

type FilterRule = Omit<DataGridStructuredFilterRule, "id">;
type SortRule = Omit<DataGridStructuredSortRule, "id">;

function columnName(token: SqlSemanticToken | undefined, columns: readonly string[]): string | undefined {
  if (!tokenIsIdentifier(token) || token.closed === false) return undefined;
  const name = unquoteSqlSemanticIdentifier(token);
  if (columns.includes(name)) return name;
  if (token.kind === "quoted_identifier") return undefined;
  return columns.find((column) => column.toLowerCase() === name.toLowerCase());
}

function stripParentheses(tokens: SqlSemanticToken[]): SqlSemanticToken[] {
  while (tokens[0]?.text === "(" && tokens[tokens.length - 1]?.text === ")" && !tokens.slice(1, -1).some((token) => token.depth === tokens[0]!.depth)) {
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function literal(tokens: SqlSemanticToken[]): string | undefined {
  const token = tokens[0];
  if (tokens.length === 1 && token?.kind === "string" && token.closed !== false && token.quote === "'") {
    const value = token.text.slice(1, -1).replaceAll("''", "'");
    return value === "" ? "''" : formatFilterRawValue(value);
  }
  const text = tokens.map((item) => item.text).join("");
  if (tokens.some((item, index) => index > 0 && item.span.start !== tokens[index - 1]!.span.end && !(index === 1 && ["-", "+"].includes(tokens[0]!.text)))) return undefined;
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(text) || /^(true|false)$/i.test(text) ? text : undefined;
}

function filterAtom(tokens: SqlSemanticToken[], columns: readonly string[], dialect: string, columnTypes?: ReadonlyMap<string, string>): FilterRule | undefined {
  if (dialect === "neo4j" && tokens[0]?.text === "n" && tokens[1]?.text === ".") tokens = tokens.slice(2);
  const column = columnName(tokens[0], columns);
  if (!column) return undefined;
  const rest = tokens.slice(1);
  let operator = rest[0]?.text.toUpperCase();
  let operatorLength = 1;
  const pair = operator + (rest[1]?.text ?? "");
  if (["<=", ">=", "!=", "<>"].includes(pair) && rest[0]?.span.end === rest[1]?.span.start) {
    operator = pair;
    operatorLength = 2;
  }
  const rule: FilterRule = { columnName: column, mode: "equals", rawValue: "", rawEndValue: "", conjunction: "AND" };
  if (operator === "IS") {
    const expression = rest.map((token) => token.text.toUpperCase()).join(" ");
    if (expression === "IS NULL") return { ...rule, mode: "is-null" };
    if (expression === "IS NOT NULL") return { ...rule, mode: "is-not-null" };
    return undefined;
  }
  const modes: Record<string, FilterRule["mode"]> = { "=": "equals", "!=": "not-equals", "<>": "not-equals", ">": "greater-than", ">=": "greater-than-or-equal", "<": "less-than", "<=": "less-than-or-equal" };
  const mode = modes[operator ?? ""];
  const valueTokens = rest.slice(operatorLength);
  const rawValue = literal(valueTokens);
  const type = columnTypes?.get(column);
  if (rawValue !== undefined && type) {
    const base = type
      .trim()
      .toLowerCase()
      .split(/[\s([]/, 1)[0];
    const boolean = base === "bool" || base === "boolean" || (base === "bit" && dialect !== "postgres");
    const numeric = isNumericColumnType(type);
    const quoted = valueTokens[0]?.kind === "string";
    // The builder coerces values using column metadata. Leave explicit SQL
    // comparisons between different types intact instead of changing casts.
    if (quoted ? numeric || boolean : /^(true|false)$/i.test(rawValue) ? !boolean : !numeric) return undefined;
  }
  return mode && rawValue !== undefined ? { ...rule, mode, rawValue } : undefined;
}

/** Only import conditions the builder can represent without changing grouping.
 * Expressions outside this subset remain intact in the text editor. */
export function parseDataGridFilterInput(input: string, columns: readonly string[], dialect = "mysql", columnTypes?: ReadonlyMap<string, string>): FilterRule[] | undefined {
  if (!input.trim()) return [];
  const tokens = tokenizeSqlSemantic(input, dialect);
  if (tokens.some((token) => token.kind === "comment" || token.closed === false)) return undefined;
  let conjunction: "AND" | "OR" | undefined;
  function parse(source: SqlSemanticToken[]): FilterRule[] | undefined {
    const items = stripParentheses(source);
    if (!items.length) return undefined;
    const depth = items[0]!.depth;
    const separators = items.flatMap((token, index) => (token.depth === depth && /^(AND|OR)$/i.test(token.text) ? [index] : []));
    if (!separators.length) {
      const rule = filterAtom(items, columns, dialect, columnTypes);
      return rule ? [rule] : undefined;
    }
    const rules: FilterRule[] = [];
    let start = 0;
    for (const index of [...separators, items.length]) {
      const parsed = parse(items.slice(start, index));
      if (!parsed) return undefined;
      rules.push(...parsed);
      if (index < items.length) {
        const next = items[index]!.text.toUpperCase() as "AND" | "OR";
        if (conjunction && conjunction !== next) return undefined;
        conjunction = next;
      }
      start = index + 1;
    }
    return rules;
  }
  return parse(tokens)?.map((rule) => ({ ...rule, conjunction: conjunction ?? "AND" }));
}

export function parseDataGridOrderByInput(input: string, columns: readonly string[], dialect = "mysql"): SortRule[] | undefined {
  if (!input.trim()) return [];
  const tokens = tokenizeSqlSemantic(input, dialect);
  if (tokens.some((token) => token.kind === "comment" || token.closed === false)) return undefined;
  const rules: SortRule[] = [];
  let start = 0;
  for (const index of [...tokens.flatMap((token, index) => (token.text === "," && token.depth === 0 ? [index] : [])), tokens.length]) {
    let term = tokens.slice(start, index);
    if (dialect === "neo4j" && term[0]?.text === "n" && term[1]?.text === ".") term = term.slice(2);
    const column = columnName(term[0], columns);
    const direction = term[1]?.text.toLowerCase() ?? "asc";
    if (!column || term.length > 2 || !["asc", "desc"].includes(direction)) return undefined;
    rules.push({ columnName: column, direction: direction as "asc" | "desc" });
    start = index + 1;
  }
  return rules;
}
