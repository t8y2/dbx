import { uuid } from "@/lib/common/utils";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";
import type { DatabaseType } from "@/types/database";

export interface ParseDataGridWhereConditionOptions {
  createId?: () => string;
  /** Dialect of the grid being filtered — kept for shape decisions that are
   * dialect-specific; LIKE templates are same-dialect by construction, so no
   * dialect currently rejects a shape on its own. */
  databaseType?: DatabaseType;
  /** Declared types for `columns`, same order (drivers report them as
   * `ResultSet.column_types`). LIKE needs a text-family column: on other or
   * unknown types the handwritten LIKE relies on dialect implicit casts and
   * the rebuilt rule would not round-trip (#15448 review). */
  columnTypes?: readonly (string | undefined)[];
}

/** Text-family declared types whose LIKE behaves as plain string matching. */
function isTextLikeColumnType(type: string | undefined): boolean {
  if (!type) return false;
  const normalized = type.toLowerCase().trim();
  return /^(?:var)?char(?:2)?\b/.test(normalized) || /^n(?:var)?char(?:2)?\b/.test(normalized) || /\b(?:text|clob|string|citext|bpchar)\b/.test(normalized) || /^character\b/.test(normalized) || /^enum\b/.test(normalized);
}

function columnUsesTextFamily(column: string, columns: readonly string[], columnTypes?: ParseDataGridWhereConditionOptions["columnTypes"]): boolean {
  if (!columnTypes) return true;
  const index = columns.indexOf(column);
  return index !== -1 && isTextLikeColumnType(columnTypes[index]);
}

/**
 * Conservative WHERE → structured-rules importer for the filter builder
 * popover (#15320). Accepts only `column op value` chains joined by a single
 * kind of AND/OR; anything else (parens, arithmetic, function calls, mixed
 * conjunctions, unknown columns) returns null so the builder keeps its
 * previous behavior instead of silently misreading hand-written SQL.
 */

type ParsedFragment = {
  column: string;
  mode: DataGridContextFilterMode;
  value: string;
  endValue?: string;
  conjunction: "AND" | "OR";
};

const COMPARISON_MODES: Record<string, DataGridContextFilterMode> = {
  "=": "equals",
  "!=": "not-equals",
  "<>": "not-equals",
  ">": "greater-than",
  ">=": "greater-than-or-equal",
  "<": "less-than",
  "<=": "less-than-or-equal",
};

function splitTopLevelConjunctions(where: string): Array<{ joiner: "AND" | "OR"; text: string }> {
  const fragments: Array<{ joiner: "AND" | "OR"; text: string }> = [];
  let current = "";
  let joiner: "AND" | "OR" | null = null;
  let quote: string | null = null;
  const chars = [...where];
  for (let index = 0; index < chars.length; index += 1) {
    const ch = chars[index]!;
    if (quote) {
      current += ch;
      if (ch === quote) {
        // '' inside a quoted string is an escaped quote, not the terminator.
        if (chars[index + 1] === quote) {
          current += chars[index + 1]!;
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    const rest = chars.slice(index).join("");
    const conjunction = /^(AND|OR)\b/i.exec(rest);
    if (conjunction) {
      const nextJoiner = conjunction[1]!.toUpperCase() as "AND" | "OR";
      // A conjunction with no preceding condition text means the input starts
      // with AND/OR or has a doubled AND AND — not a condition list.
      if (!current.trim() || (joiner && joiner !== nextJoiner)) return [];
      fragments.push({ joiner: joiner ?? "AND", text: current.trim() });
      current = "";
      joiner = nextJoiner;
      index += conjunction[1]!.length - 1;
      continue;
    }
    current += ch;
  }
  if (quote) return [];
  fragments.push({ joiner: joiner ?? "AND", text: current.trim() });
  return fragments;
}

function sameColumn(candidate: string, columns: readonly string[]): string | null {
  const trimmed = candidate.trim();
  // Quoted identifiers are case-sensitive in every dialect we quote for
  // (PG `"Name"`, MySQL `` `Name` ``, SQL Server `[Name]`): require an exact
  // column match and never fold to a differently-cased sibling (#15448 review).
  if (trimmed.length > 1 && ((trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    const exact = trimmed.slice(1, -1);
    return columns.some((column) => column === exact) ? exact : null;
  }
  const normalized = trimmed.toLowerCase();
  const matches = columns.filter((column) => column.toLowerCase() === normalized);
  // An unquoted identifier folded case-insensitively is ambiguous when the
  // table carries both `Name` and `name` — importing could switch columns.
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Unwraps the quoted LIKE literal and classifies the pattern. The backend
 * re-adds wildcards per mode (Contains/StartsWith/EndsWith) and escapes LIKE
 * metacharacters in the stored value, so an exact round-trip requires the
 * pattern to use only edge `%` wildcards with no `_` and no interior `%`
 * anything else would change semantics and is rejected (#15448 review).
 */
function parseLikeLiteral(value: string): { mode: DataGridContextFilterMode; pattern: string } | null {
  const literal = value.trim();
  if (literal.length < 2 || !literal.startsWith("'") || !literal.endsWith("'")) return null;
  const pattern = literal.slice(1, -1).replaceAll("''", "'");
  if (pattern.includes("'") || !pattern) return null;
  if (pattern.includes("_")) return null;
  const startsWithWildcard = pattern.startsWith("%");
  const endsWithWildcard = pattern.endsWith("%");
  // A second `%` is only allowed as the trailing wildcard (`%x%`); an interior
  // one changes what the pattern matches and is rejected.
  const interiorWildcard = pattern.indexOf("%", 1);
  if (interiorWildcard !== -1 && interiorWildcard !== pattern.length - 1) return null;
  if (startsWithWildcard && endsWithWildcard) return { mode: "like", pattern: pattern.slice(1, -1) };
  if (endsWithWildcard) return { mode: "begins-with", pattern: pattern.slice(0, -1) };
  if (startsWithWildcard) return { mode: "ends-with", pattern: pattern.slice(1) };
  return null;
}

/** The structured modes whose SQL template negates the matching LIKE shape. */
const NEGATED_LIKE_MODES: Record<string, DataGridContextFilterMode> = {
  like: "not-like",
  "begins-with": "not-begins-with",
  "ends-with": "not-ends-with",
};

/**
 * Values the rule builder can reproduce byte-for-byte. The rebuilt condition
 * quotes the value as a string literal (`parseFilterValue` unwraps the user's
 * quotes and re-emits one), so only an already-quoted string or a numeric
 * literal round-trips. A bare identifier (`a = b`) compares two columns in
 * the hand-written SQL but becomes the constant `'b'` after the rebuild — a
 * different result set, so it must not be imported (#15448 review).
 */
function isLosslessComparisonValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return true;
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed);
}

/** Splits an IN list on top-level commas (commas inside quotes stay put). */
function splitInListItems(raw: string): string[] | null {
  const items: string[] = [];
  let current = "";
  let inQuote = false;
  for (const ch of raw) {
    if (inQuote) {
      current += ch;
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (inQuote) return null;
  items.push(current.trim());
  return items.filter((item) => item.length > 0);
}

function parseFragment(fragment: string, columns: readonly string[]): ParsedFragment | null {
  const text = fragment.trim();
  if (!text) return null;

  // The NOT must be its own keyword between IS and NULL: matching it anywhere
  // in the fragment turned `notice IS NULL` into IS NOT NULL (#15448 review).
  const nullMatch = /^(\S+)\s+IS(\s+NOT)?\s+NULL$/i.exec(text);
  if (nullMatch) {
    const column = sameColumn(nullMatch[1]!, columns);
    if (!column) return null;
    return { column, mode: nullMatch[2] ? "is-not-null" : "is-null", value: "", conjunction: "AND" };
  }

  // IN / NOT IN with a literal list — the only allowed parentheses.
  const inMatch = /^(\S+)\s+(NOT\s+)?IN\s*\((.*)\)$/i.exec(text);
  if (inMatch) {
    const column = sameColumn(inMatch[1]!, columns);
    if (!column) return null;
    const rawValue = inMatch[3]!.trim();
    if (!rawValue) return null;
    const items = splitInListItems(rawValue);
    if (!items?.length || !items.every((item) => isLosslessComparisonValue(item))) return null;
    return { column, mode: inMatch[2] ? "not-in" : "in", value: rawValue, conjunction: "AND" };
  }

  // Comparison: identifier op value, with the value kept raw (quoted strings,
  // numbers, bare identifiers) exactly as typed so the rule builder's own
  // value handling applies unchanged.
  const comparison = /^(\S+)\s*(=|!=|<>|>=|<=|>|<)\s*(.+)$/i.exec(text);
  if (!comparison) return null;
  const column = sameColumn(comparison[1]!, columns);
  if (!column) return null;
  const mode = COMPARISON_MODES[comparison[2]!.toUpperCase()];
  if (!mode) return null;
  const value = comparison[3]!.trim();
  if (!value || /^(AND|OR)$/i.test(value)) return null;
  // `= NULL` in SQL is never true; the meaningful form is IS NULL. Conservative
  // import rejects the literal so it is not silently turned into `= 'NULL'`.
  if (/^null$/i.test(value) && !value.startsWith("'")) return null;
  // Only quoted strings and numeric literals survive the rebuild unchanged; a
  // bare identifier would turn a column-to-column comparison into a constant
  // comparison and change the result set (#15448 review).
  if (!isLosslessComparisonValue(value)) return null;
  return { column, mode, value, conjunction: "AND" };
}

/** 把「选中列名」映射到驱动上报的逐列声明类型（按结果列索引对齐），
 *  供 LIKE 文本族门控使用（#15448 复审）。 */
export function structuredImportColumnTypesFor(selectedColumns: readonly string[], resultColumns: readonly string[], resultColumnTypes: readonly (string | undefined)[] | undefined): Array<string | undefined> {
  return selectedColumns.map((name) => {
    const index = resultColumns.indexOf(name);
    return index === -1 ? undefined : resultColumnTypes?.[index];
  });
}

export function parseDataGridWhereCondition(where: string, columns: readonly string[], createIdOrOptions?: (() => string) | ParseDataGridWhereConditionOptions): DataGridStructuredFilterRule[] | null {
  const options: ParseDataGridWhereConditionOptions = typeof createIdOrOptions === "function" ? { createId: createIdOrOptions } : (createIdOrOptions ?? {});
  const createId = options.createId ?? uuid;
  const trimmed = where.trim().replace(/;+$/, "").trim();
  if (!trimmed || !columns.length) return null;

  const fragments = splitTopLevelConjunctions(trimmed);
  if (!fragments.length) return null;

  const rules: DataGridStructuredFilterRule[] = [];
  for (let index = 0; index < fragments.length; index += 1) {
    const { joiner, text } = fragments[index]!;
    const likeMatch = /^(.+?)\s+(NOT\s+LIKE|LIKE)\s+(.+)$/i.exec(text);
    let parsed: ParsedFragment | null = null;
    if (likeMatch) {
      const column = sameColumn(likeMatch[1]!, columns);
      const literal = likeMatch[3]!.trim();
      const negative = /NOT/i.test(likeMatch[2]!);
      if (!column || !literal) return null;
      // LIKE only round-trips where the column's declared type is textual:
      // other types go through dialect implicit casts that the rebuilt rule
      // reproduces only by accident (#15448 review). No type information at
      // all keeps the previous behaviour.
      if (!columnUsesTextFamily(column, columns, options.columnTypes)) return null;
      const like = parseLikeLiteral(literal);
      if (!like) return null;
      // Negation must keep the pattern's shape: `NOT LIKE 'abc%'` is
      // not-begins-with, not the contains-shaped `not-like` — collapsing them
      // silently widened what rows get excluded (#15448 review). A pattern
      // with no edge wildcard never maps losslessly and is rejected upstream.
      const mode = negative ? NEGATED_LIKE_MODES[like.mode] : like.mode;
      if (!mode) return null;
      parsed = { column, mode, value: like.pattern, conjunction: "AND" };
    }
    if (!parsed) parsed = parseFragment(text, columns);
    if (!parsed) return null;
    rules.push({
      id: createId(),
      columnName: parsed.column,
      mode: parsed.mode,
      rawValue: parsed.value,
      rawEndValue: parsed.endValue ?? "",
      conjunction: index === 0 ? "AND" : joiner,
    });
  }
  return rules.every((rule) => rule.columnName && (rule.mode === "is-null" || rule.mode === "is-not-null" || rule.rawValue.trim())) ? rules : null;
}
