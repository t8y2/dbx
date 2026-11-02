import { BACKSLASH_ESCAPE_STRING_DIALECTS } from "@/lib/sql/sqlStatementRanges";
import { resolveSqlDialectId } from "@/lib/sql/semantic/dialect";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { DatabaseType } from "@/types/database";

function keepSqlComment(text: string): boolean {
  // Optimizer hints and MySQL executable comments are sent to the engine.
  return text.startsWith("/*+") || text.startsWith("/*!");
}

function collapseBlankLines(whitespace: string): string {
  return whitespace.replace(/[ \t]+(?=\r?\n)/g, "").replace(/(\r?\n)(?:\r?\n)+/g, "$1");
}

export function sqlWithoutCommentsForCopy(sql: string, databaseType?: DatabaseType): string {
  if (!sql) return "";
  const dialectId = resolveSqlDialectId({ databaseType });
  const mysqlLike = dialectId === "mysql" || dialectId === "doris";
  const tokens = tokenizeSqlSemantic(sql, dialectId, {
    mysqlDashCommentRequiresWhitespace: mysqlLike,
    mysqlBackslashEscape: !!databaseType && BACKSLASH_ESCAPE_STRING_DIALECTS.has(databaseType),
  });

  let output = "";
  let cursor = 0;
  let whitespace = "";
  for (const token of tokens) {
    whitespace += sql.slice(cursor, token.span.start);
    cursor = token.span.end;
    if (token.kind === "comment" && !keepSqlComment(token.text)) {
      whitespace += token.text.replace(/[^\r\n]/g, "") || " ";
      continue;
    }
    output += (output ? collapseBlankLines(whitespace) : "") + token.text;
    whitespace = "";
  }
  return output;
}
