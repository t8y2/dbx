import type { DatabaseType } from "@/types/database";
import { SQL_REGION_COMMENT_POLICIES, SQL_REGION_COMMENT_SPECS } from "@/lib/editor/sqlRegionDialectPolicy";
import type { SqlStatementSyntaxDialect } from "./sqlParameters";

function sqlRegionCommentPolicy(databaseType?: DatabaseType, syntaxDialect?: SqlStatementSyntaxDialect) {
  if (databaseType === "jdbc") {
    if ((syntaxDialect ?? "mysql") === "mysql") return "mysql";
    if (syntaxDialect === "clickhouse") return "clickhouse";
    if (syntaxDialect === "soql") return "excluded";
    return "nested";
  }
  if (!databaseType && syntaxDialect) {
    if (syntaxDialect === "mysql") return "mysql";
    if (syntaxDialect === "clickhouse") return "clickhouse";
    if (syntaxDialect === "soql") return "excluded";
    return "nested";
  }
  return databaseType ? SQL_REGION_COMMENT_POLICIES[databaseType] : undefined;
}

/** Explicit nested dialects share the editor policy; unknown/legacy execution keeps its old flat behavior. */
export function sqlSupportsNestedBlockComments(databaseType?: DatabaseType, syntaxDialect?: SqlStatementSyntaxDialect): boolean {
  const policy = sqlRegionCommentPolicy(databaseType, syntaxDialect);
  return policy === "nested" || policy === "spark" || policy === "clickhouse" || policy === "h2";
}

/** Offset of the closing star, or -1 when the complete block remains open. */
export function sqlBlockCommentEnd(sql: string, from: number, databaseType?: DatabaseType, syntaxDialect?: SqlStatementSyntaxDialect): number {
  if (!sqlSupportsNestedBlockComments(databaseType, syntaxDialect)) return sql.indexOf("*/", from + 2);
  let depth = 1;
  for (let i = from + 2; i < sql.length - 1; i++) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i++;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      if (--depth === 0) return i;
      i++;
    }
  }
  return -1;
}

/** Additional SQL line-comment forms, shared by statement and cursor scanning. */
export function sqlStartsSlashLineComment(sql: string, pos: number, databaseType?: DatabaseType, syntaxDialect?: SqlStatementSyntaxDialect): boolean {
  const policy = sqlRegionCommentPolicy(databaseType, syntaxDialect);
  return !!policy && !!SQL_REGION_COMMENT_SPECS[policy].slashComments && sql.startsWith("//", pos);
}
