import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

export function compactDdlSql(sql: string, databaseType: DatabaseType | undefined): string {
  if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle") return sql;
  const tokens = tokenizeSqlSemantic(sql, "oracle");
  if (!tokens.length || tokens.some((token) => token.closed === false || (token.kind === "comment" && token.text.startsWith("/*") && !token.text.endsWith("*/")))) return sql;
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    const gap = sql.slice(cursor, token.span.start);
    if (/\r|\n/.test(gap)) {
      const newline = gap.match(/\r\n|\r|\n/)![0];
      result += newline + gap.slice(Math.max(gap.lastIndexOf("\n"), gap.lastIndexOf("\r")) + 1);
    } else {
      result += cursor === 0 ? gap : gap ? " " : "";
    }
    result += token.text;
    cursor = token.span.end;
  }
  return result + sql.slice(cursor);
}
