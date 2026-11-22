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
  let trimmed = candidate.trim();
  if (trimmed.length > 1 && ((trimmed.startsWith("`") && trimmed.endsWith("`")) || (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    trimmed = trimmed.slice(1, -1);
  }
  const normalized = trimmed.toLowerCase();
  return columns.find((column) => column.toLowerCase() === normalized) ?? null;
}

/**
 * Unwraps the quoted LIKE literal and classifies the pattern. The backend
 * re-adds wildcards per mode (Contains/StartsWith/EndsWith), so the stored
 * value must be the bare pattern: edge wildcards map to a mode, wildcards in
 * the middle would change semantics and are rejected.
 */
function parseLikeLiteral(value: string): { mode: DataGridContextFilterMode; pattern: string } | null {
  const literal = value.trim();
  if (literal.length < 2 || !literal.startsWith("'") || !literal.endsWith("'")) return null;
  const pattern = literal.slice(1, -1).replaceAll("''", "'");
  if (pattern.includes("'") || !pattern) return null;
  const startsWithWildcard = pattern.startsWith("%");
  const endsWithWildcard = pattern.endsWith("%");
  if (pattern.indexOf("%", 1) !== pattern.length - 1 && startsWithWildcard) return null;
  if (startsWithWildcard && endsWithWildcard) return { mode: "like", pattern: pattern.slice(1, -1) };
  if (endsWithWildcard) return { mode: "begins-with", pattern: pattern.slice(0, -1) };
  if (startsWithWildcard) return { mode: "ends-with", pattern: pattern.slice(1) };
  return null;
}

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
      parsed = { column, mode: negative ? "not-like" : like.mode, value: like.pattern, conjunction: "AND" };
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
