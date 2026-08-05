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
