import { uuid } from "@/lib/common/utils";
import type { DataGridStructuredFilterRule } from "@/composables/useDataGridFilterBuilder";
import type { DataGridContextFilterMode } from "@/lib/dataGrid/dataGridSql";

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

function parseFragment(fragment: string, columns: readonly string[]): ParsedFragment | null {
  const text = fragment.trim();
  if (!text) return null;

  const nullMatch = /^(\S+)\s+IS(?:\s+NOT)?\s+NULL$/i.exec(text);
  if (nullMatch) {
    const column = sameColumn(nullMatch[1]!, columns);
    if (!column) return null;
    return { column, mode: /NOT/i.test(nullMatch[0]!) ? "is-not-null" : "is-null", value: "", conjunction: "AND" };
  }

  // IN / NOT IN with a literal list — the only allowed parentheses.
  const inMatch = /^(\S+)\s+(NOT\s+)?IN\s*\((.*)\)$/i.exec(text);
  if (inMatch) {
    const column = sameColumn(inMatch[1]!, columns);
    if (!column) return null;
    const rawValue = inMatch[3]!.trim();
    if (!rawValue) return null;
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
  return { column, mode, value, conjunction: "AND" };
}

export function parseDataGridWhereCondition(where: string, columns: readonly string[], createId: () => string = uuid): DataGridStructuredFilterRule[] | null {
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
