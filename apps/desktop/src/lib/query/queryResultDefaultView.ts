import type { QueryResult } from "@/types/database";
import { queryResultMessages } from "./queryResultMessages";

/**
 * Picks the default output view for a result that has no result set.
 * Message-only results (e.g. PostgreSQL `DO $$ RAISE NOTICE $$`) open the
 * messages view; routine DML like a MySQL INSERT also carries an INFO message
 * ("Records: N ...") but keeps the established summary view.
 */
export function defaultViewForResult(result: Pick<QueryResult, "columns" | "rows" | "affected_rows" | "messages" | "server_message">): "messages" | "summary" {
  if (result.server_message === true && queryResultMessages(result).length > 0) return "messages";
  const messageOnly = result.columns.length === 0 && result.rows.length === 0 && result.affected_rows === 0 && (result.messages?.length ?? 0) > 0;
  return messageOnly ? "messages" : "summary";
}

/**
 * Statements that never render a result grid. While one of them runs the data
 * tab is an empty placeholder, so a single-statement run starts on the summary
 * tab where the in-flight status is shown (issue #12283).
 *
 * `CALL` / `EXEC` are deliberately absent: on MySQL and SQL Server they can
 * return rows, so those keep the data tab.
 */
const RESULT_GRID_FREE_KEYWORDS = new Set([
  "insert",
  "update",
  "delete",
  "merge",
  "upsert",
  "replace",
  "truncate",
  "create",
  "alter",
  "drop",
  "rename",
  "comment",
  "grant",
  "revoke",
  "commit",
  "rollback",
  "begin",
  "start",
  "set",
  "use",
  "savepoint",
  "lock",
  "unlock",
  "analyze",
  "vacuum",
  "reindex",
  "checkpoint",
  "flush",
  "reset",
  "purge",
]);

export function statementRunsWithoutResultGrid(sql: string): boolean {
  const keyword = leadingSqlKeyword(sql);
  return keyword !== null && RESULT_GRID_FREE_KEYWORDS.has(keyword);
}

function leadingSqlKeyword(sql: string): string | null {
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === " " || character === "\t" || character === "\n" || character === "\r" || character === ";") {
      index += 1;
      continue;
    }
    if (character === "-" && sql[index + 1] === "-") {
      const lineEnd = sql.indexOf("\n", index + 2);
      index = lineEnd === -1 ? sql.length : lineEnd + 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const commentEnd = sql.indexOf("*/", index + 2);
      index = commentEnd === -1 ? sql.length : commentEnd + 2;
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_]+/.exec(sql.slice(index));
  return match ? match[0].toLowerCase() : null;
}
