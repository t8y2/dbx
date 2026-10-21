import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

/** Remove only the trailing page clause generated for a MySQL data tab. */
export function mysqlTablePageBaseSql(sql: string, limit: number, offset: number): string | undefined {
  const tokens = tokenizeSqlSemantic(sql, "mysql", {
    mysqlDashCommentRequiresWhitespace: true,
    mysqlBackslashEscape: true,
    mysqlDoubleQuoteIsString: true,
  });
  const pageClause = tokens.find((token) => token.depth === 0 && token.kind === "word" && token.normalized === "limit");
  if (!pageClause) return undefined;
  // Match the builder's literal page bounds, not LIMIT text inside a string,
  // identifier, comment or subquery. Unknown suffixes keep the original path.
  const match = /^LIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?\s*;?\s*$/i.exec(sql.slice(pageClause.span.start));
  if (!match || Number(match[1]) !== limit || Number(match[2] ?? 0) !== offset) return undefined;
  return sql.slice(0, pageClause.span.start).trimEnd();
}
