// Navicat-style 命令列界面 (command-line console) pure logic: per-dialect
// prompts, statement-completeness evaluation (Enter vs `->` continuation),
// and QueryResult → terminal text rendering. No Vue/store imports here so the
// rules are unit-testable in isolation.
import type { DatabaseType, QueryResult } from "@/types/database";
import { isConsoleCommandLine, isOracleLikeDatabase, isSqlInputComplete, splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
export { isConsoleCommandLine } from "@/lib/sql/sqlStatementRanges";

/** The console is a SQL surface; document/search/key-value editors have their
 *  own workbenches and must not offer it. */
const NON_SQL_CONSOLE_TYPES: ReadonlySet<DatabaseType> = new Set(["mongodb", "redis", "elasticsearch", "easysearch", "solr", "couchdb", "meilisearch", "milvus", "qdrant", "weaviate", "chromadb", "neo4j", "nebula", "dynamodb", "hbase", "salesforce"]);

export function supportsSqlConsole(dbType?: DatabaseType): boolean {
  return !!dbType && !NON_SQL_CONSOLE_TYPES.has(dbType);
}

/// The prompt shown before the first line of a statement.
export function consolePrompt(dbType?: DatabaseType): string {
  switch (dbType) {
    case "mysql":
    case "doris":
    case "starrocks":
    case "manticoresearch":
    case "goldendb":
    case "gbase":
      return "mysql> ";
    case "postgres":
    case "opengauss":
    case "gaussdb":
    case "redshift":
    case "kwdb":
    case "kingbase":
    case "vastbase":
    case "highgo":
    case "uxdb":
      return "pgsql> ";
    case "oracle":
    case "yashandb":
    case "dameng":
    case "oceanbase-oracle":
    case "oscar":
      return "SQL> ";
    case "sqlserver":
      return "sql> ";
    default:
      return "SQL> ";
  }
}

/// Prompt shown before continuation lines of an unterminated statement.
export const CONSOLE_CONTINUATION_PROMPT = "    -> ";

/**
 * Whether `buffer` (all lines typed so far, joined with `\n`) should execute
 * on Enter, or keep accumulating (`->` continuation).
 *
 * Rules per family, mirroring the native clients:
 * - a single-line console command (DESC/EXEC/SET/EXIT/…, `\d`/`\dt`) always
 *   executes immediately — the backend splitter line-terminates those;
 * - MySQL-family / SQL Server: SQL runs only when the buffer ends with `;`
 *   (SQL Server also accepts a lone `GO` line);
 * - Oracle-family PL/SQL blocks finish on a lone `/` line;
 * - everything else runs when the buffer ends with `;`.
 */
export function consoleStatementComplete(buffer: string, dbType?: DatabaseType, parameterOptions?: SqlParameterOptions): boolean {
  const text = buffer.trim();
  if (!text) return false;
  if (/^(?:EXIT|QUIT)\s*;?$/i.test(text)) return true;
  if (text === "/" && isOracleLikeDatabase(dbType, parameterOptions)) return true;
  return isSqlInputComplete(text, dbType, parameterOptions);
}

/** Separate line commands before classification: a DESC/PROMPT must not hide a later write. */
export function consoleSqlForSafety(sql: string, dbType?: DatabaseType, parameterOptions?: SqlParameterOptions): string {
  const ranges = splitSqlStatementRanges(sql, dbType, parameterOptions);
  // Keep ordinary SQL verbatim, including MySQL executable comments the editor ranges may omit.
  if (!ranges.some(({ sql }) => isConsoleCommandLine(sql, dbType))) return sql;
  const statements = ranges.filter(({ sql }) => !isConsoleCommandLine(sql, dbType) || /^(?:EXEC(?:UTE)?|RUN)\b/i.test(sql.trimStart())).map(({ sql }) => sql);
  // An entirely client-only/read-metadata request is read-only; this token is never executed.
  return statements.length ? statements.join(";\n") : "SELECT 1";
}

/// One echoed console entry.
export interface ConsoleEntry {
  kind: "command" | "output" | "error" | "notice";
  text: string;
}

/// Echo text: first line after the main prompt, following lines after `->`.
export function echoCommandText(statement: string, dbType?: DatabaseType): string {
  const prompt = consolePrompt(dbType);
  const lines = statement.split("\n");
  return [`${prompt}${lines[0]}`, ...lines.slice(1).map((line) => `${CONSOLE_CONTINUATION_PROMPT}${line}`)].join("\n");
}

const PROMPT_RESULT_MAX_ROWS = 200;
const PROMPT_RESULT_MAX_CELL = 120;

/// Render one QueryResult the way the native clients print: ASCII box tables
/// for row sets, plain lines for message grids, status line with timing.
export function queryResultToConsoleText(result: QueryResult): string {
  const parts: string[] = [];
  const isMessageGrid = result.columns.length === 1 && ["Message", "Error"].includes(result.columns[0]);
  if (result.execution_error) {
    const message = String(result.rows[0]?.[0] ?? "");
    for (const line of message.split("\n")) parts.push(line);
    return parts.join("\n");
  }
  if (result.columns.length === 0 && result.rows.length === 0) {
    // DDL / statement with no client-visible output (SET, DDL success).
    if (result.affected_rows > 0) parts.push(`Query OK, ${result.affected_rows} row(s) affected (${formatSeconds(result.execution_time_ms)} sec)`);
    else parts.push(`Query OK (${formatSeconds(result.execution_time_ms)} sec)`);
    return parts.join("\n");
  }
  if (isMessageGrid) {
    for (const row of result.rows) parts.push(String(row[0] ?? ""));
    return parts.join("\n");
  }
  // ASCII box table.
  const rows = result.rows.slice(0, PROMPT_RESULT_MAX_ROWS).map((row) => row.map((cell) => stringifyCell(cell)));
  const widths = result.columns.map((column, index) => Math.min(PROMPT_RESULT_MAX_CELL, Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length))));
  const border = `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
  parts.push(border);
  parts.push(`|${result.columns.map((column, index) => ` ${pad(column, widths[index])} `).join("|")}|`);
  parts.push(border);
  for (const row of rows) {
    parts.push(`|${row.map((cell, index) => ` ${pad(truncateCell(cell), widths[index])} `).join("|")}|`);
  }
  parts.push(border);
  const rowCount = result.rows.length;
  const truncatedNote = result.rows.length > PROMPT_RESULT_MAX_ROWS ? ` (showing first ${PROMPT_RESULT_MAX_ROWS})` : "";
  parts.push(`${rowCount} row(s) in set${truncatedNote} (${formatSeconds(result.execution_time_ms)} sec)`);
  return parts.join("\n");
}

/// Render one statement's result in terminal scrollback.
export function consoleEntriesForResult(result: QueryResult): ConsoleEntry[] {
  if (result.execution_error) {
    return [{ kind: "error", text: queryResultToConsoleText(result) }];
  }
  const text = queryResultToConsoleText(result);
  if (!text) return [];
  return [{ kind: "output", text }];
}

function stringifyCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "NULL";
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

function truncateCell(cell: string): string {
  return cell.length > PROMPT_RESULT_MAX_CELL ? `${cell.slice(0, PROMPT_RESULT_MAX_CELL - 3)}...` : cell;
}

function pad(text: string, width: number): string {
  const bounded = text.length > PROMPT_RESULT_MAX_CELL ? truncateCell(text) : text;
  return bounded + " ".repeat(Math.max(0, width - bounded.length));
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(2);
}
