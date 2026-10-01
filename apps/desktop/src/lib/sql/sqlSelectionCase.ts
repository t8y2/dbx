import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

export type SqlSelectionCaseMode = "upper" | "lower";

type SqlSelectionRange = {
  from: number;
  to: number;
};

function convertCase(text: string, mode: SqlSelectionCaseMode): string {
  return mode === "upper" ? text.toUpperCase() : text.toLowerCase();
}

export function convertSqlSelectionCase(sql: string, range: SqlSelectionRange, mode: SqlSelectionCaseMode, dialectId?: "mysql" | "postgres" | "sqlserver"): string {
  const from = Math.max(0, Math.min(range.from, sql.length));
  const to = Math.max(from, Math.min(range.to, sql.length));
  const protectedTokens = tokenizeSqlSemantic(sql, dialectId).filter((item) => {
    if (item.span.end <= from || item.span.start >= to) return false;
    if (item.kind === "string") return true;
    if (dialectId !== "mysql") return false;
    if (item.kind === "quoted_identifier" && item.quote === '"') return true;
    return item.kind === "comment" && /^\/\*(?:!|M!)/i.test(item.text);
  });
  if (protectedTokens.length === 0) return convertCase(sql.slice(from, to), mode);

  // An explicit selection whose only word-like content sits inside protected
  // tokens — a bare string literal, or a value list like `('D','C','B')` — has
  // no SQL structure that case conversion could damage: everything outside the
  // protected tokens is punctuation and whitespace, which the conversion leaves
  // unchanged anyway. Honor the request fully instead of silently no-oping it
  // (issue #10775: selecting `('D','C','B','B','A')` and converting did
  // nothing). Selections that reach past protected tokens into identifiers or
  // keywords keep the protection below.
  const unprotectedWordCharPattern = /[\p{L}\p{N}_]/u;
  let unprotectedTextHasWord = false;
  let unprotectedScan = from;
  for (const item of protectedTokens) {
    const literalFrom = Math.max(from, item.span.start);
    if (unprotectedWordCharPattern.test(sql.slice(unprotectedScan, literalFrom))) {
      unprotectedTextHasWord = true;
      break;
    }
    unprotectedScan = Math.min(to, Math.max(unprotectedScan, item.span.end));
  }
  if (!unprotectedTextHasWord && unprotectedWordCharPattern.test(sql.slice(unprotectedScan, to))) {
    unprotectedTextHasWord = true;
  }
  if (!unprotectedTextHasWord) return convertCase(sql.slice(from, to), mode);

  let converted = "";
  let cursor = from;
  for (const item of protectedTokens) {
    const literalFrom = Math.max(from, item.span.start);
    const literalTo = Math.min(to, item.span.end);
    converted += convertCase(sql.slice(cursor, literalFrom), mode);
    converted += sql.slice(literalFrom, literalTo);
    cursor = literalTo;
  }
  converted += convertCase(sql.slice(cursor, to), mode);
  return converted;
}
