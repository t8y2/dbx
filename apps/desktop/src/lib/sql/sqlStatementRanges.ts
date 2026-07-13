import type { SqlExecutionCandidate } from "@/lib/sql/sqlExecutionTarget";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import type { DatabaseType } from "@/types/database";

/**
 * A contiguous range of SQL text expressed as document offsets plus the
 * extracted (original) substring.
 */
export interface SqlTextRange {
  from: number;
  to: number;
  sql: string;
}

const NON_SQL_EXECUTION_TARGET_TYPES: ReadonlySet<DatabaseType> = new Set(["mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "neo4j"]);

export function supportsExecutionTargetPicker(databaseType?: DatabaseType): boolean {
  return !!databaseType && (databaseType === "redis" || !NON_SQL_EXECUTION_TARGET_TYPES.has(databaseType));
}

export function hasMultipleExecutionTargets(sql: string, databaseType?: DatabaseType): boolean {
  if (databaseType === "redis") {
    return redisExecutableCommandCount(sql) > 1;
  }
  return splitSqlStatementRanges(sql, databaseType).length > 1;
}

interface RawStatement {
  /** Start offset (inclusive) of whitespace that can still target this statement. */
  hitFrom: number;
  /** Start offset (inclusive) of the statement's first non-whitespace char. */
  from: number;
  /** End offset (exclusive) — up to and excluding the terminating semicolon. */
  to: number;
  /** The statement text, sliced from the source document. */
  sql: string;
}

type QuoteState = "none" | "single" | "double" | "backtick" | "bracket" | "dollar";

const COMMON_SOFT_STATEMENT_START_KEYWORDS = [
  "SELECT",
  "WITH",
  "CREATE",
  "ALTER",
  "DROP",
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "REPLACE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "COMMENT",
  "EXPLAIN",
  "SHOW",
  "DESCRIBE",
  "DESC",
  "USE",
  "SET",
  "CALL",
  "EXEC",
  "EXECUTE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "DECLARE",
  "ANALYZE",
  "VACUUM",
  "PRAGMA",
  "REFRESH",
  "COPY",
] as const;

const DATABASE_SOFT_STATEMENT_KEYWORDS: Partial<Record<DatabaseType, readonly string[]>> = {
  mysql: ["HANDLER", "LOAD", "OPTIMIZE", "REPAIR"],
  postgres: ["DO", "LISTEN", "NOTIFY", "UNLISTEN"],
  sqlite: ["ATTACH", "DETACH", "REINDEX"],
  duckdb: ["ATTACH", "DETACH", "EXPORT", "IMPORT", "INSTALL", "LOAD"],
  clickhouse: ["ATTACH", "CHECK", "DETACH", "EXCHANGE", "KILL", "OPTIMIZE", "SYSTEM"],
  sqlserver: ["BACKUP", "DBCC", "DENY", "RESTORE"],
  saphana: ["DO"],
  oracle: ["FLASHBACK", "LOCK", "PURGE"],
  dameng: ["FLASHBACK", "LOCK", "PURGE"],
  gaussdb: ["DO", "LOCK"],
  "oceanbase-oracle": ["FLASHBACK", "LOCK", "PURGE"],
  redis: [],
  mongodb: [],
  elasticsearch: [],
  qdrant: [],
  milvus: [],
  weaviate: [],
  chromadb: [],
  mq: [],
  etcd: [],
  zookeeper: [],
};

const WITH_MAIN_STATEMENT_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
const EXPLAIN_STATEMENT_KEYWORDS = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP"]);
const CREATE_BODY_KEYWORDS = new Set(["SELECT", "WITH", "BEGIN", "DECLARE"]);
const INSERT_BODY_KEYWORDS = new Set(["SELECT", "WITH"]);
const ALTER_BODY_KEYWORDS = new Set(["ADD", "ALTER", "COMMENT", "DROP", "MODIFY", "RENAME", "SET"]);
const SET_OPERATION_KEYWORDS = new Set(["UNION", "INTERSECT", "EXCEPT", "MINUS"]);
const SET_OPERATION_MODIFIER_KEYWORDS = new Set(["ALL", "DISTINCT"]);
const ORACLE_LIKE_PL_SQL_DATABASES: ReadonlySet<DatabaseType> = new Set(["oracle", "dameng", "gaussdb", "yashandb", "oscar", "oceanbase-oracle"]);
const MYSQL_ROUTINE_BLOCK_DATABASES: ReadonlySet<DatabaseType> = new Set(["mysql", "doris", "starrocks", "manticoresearch", "goldendb"]);
const MYSQL_CREATE_TABLE_OPTION_DATABASES: ReadonlySet<DatabaseType> = new Set(["mysql", "doris", "starrocks", "manticoresearch", "goldendb", "gbase"]);
const MYSQL_ROUTINE_OBJECT_TYPES = new Set(["PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);
const MYSQL_NON_ROUTINE_CREATE_TYPES = new Set(["DATABASE", "INDEX", "LOGFILE", "ROLE", "SCHEMA", "SERVER", "SPATIAL", "TABLE", "TEMPORARY", "UNIQUE", "USER", "VIEW"]);
const MYSQL_CONTROL_BLOCK_SUFFIXES = new Set(["IF", "LOOP", "CASE", "REPEAT", "WHILE"]);
const ORACLE_PL_SQL_BLOCK_STARTERS = new Set(["DECLARE", "BEGIN"]);
const ORACLE_PL_SQL_CREATE_OBJECT_TYPES = new Set(["FUNCTION", "PROCEDURE", "TRIGGER", "PACKAGE", "PACKAGE BODY", "TYPE", "TYPE BODY"]);
const ORACLE_PL_SQL_TERMINATORS = new Set(["IF", "LOOP", "CASE"]);
const SAP_HANA_SCRIPT_BLOCK_TERMINATORS = new Set(["IF", "FOR", "WHILE"]);

/**
 * Parse the SQL document into top-level statement ranges delimited by `;`.
 *
 * Delimiters inside string literals, double/backtick/bracket quoted
 * identifiers, dollar-quoted bodies (Postgres), line comments (`--`, `#`) and
 * block comments (`/* *​/`) are ignored, mirroring the backend splitter in
 * `dbx-core/src/sql.rs`. Ranges are returned as `[from, to)` offsets covering
 * only the statement text (the trailing semicolon and inter-statement
 * whitespace are excluded so editor highlights stay tight).
 */
export function splitSqlStatementRanges(sql: string, databaseType?: DatabaseType): RawStatement[] {
  const statements: RawStatement[] = [];
  const len = sql.length;
  const supportsDelimiterCommands = databaseType === "mysql";

  let statementStart = -1;
  let statementEnd = -1;
  let statementHitStart = 0;
  let customDelimiter: string | null = null;
  let state: QuoteState = "none";
  let dollarTag = "";
  let i = 0;

  const isWhitespace = (ch: string) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

  const markContent = (pos: number) => {
    if (statementStart === -1) statementStart = pos;
    statementEnd = pos + 1;
  };

  const flush = (to = statementEnd) => {
    if (statementStart === -1) {
      statementEnd = -1;
      return;
    }
    const trimmedTo = trimRangeEnd(sql, statementStart, to);
    if (trimmedTo > statementStart) {
      statements.push({ hitFrom: statementHitStart, from: statementStart, to: trimmedTo, sql: sql.slice(statementStart, trimmedTo) });
    }
    statementStart = -1;
    statementEnd = -1;
  };

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "dollar") {
      // Inside a Postgres dollar-quoted body; look for the closing $tag$.
      if (ch === "$") {
        const closingTag = `$${dollarTag}$`;
        if (sql.startsWith(closingTag, i)) {
          markContent(i);
          for (let k = 0; k < closingTag.length; k += 1) {
            markContent(i + k);
          }
          i += closingTag.length;
          state = "none";
          dollarTag = "";
          continue;
        }
      }
      markContent(i);
      i += 1;
      continue;
    }

    if (state === "single") {
      markContent(i);
      // Backslash escapes the next char (e.g. PostgreSQL standard_conforming_strings=off style).
      if (ch === "\\" && next) {
        i += 2;
        continue;
      }
      if (ch === "'") {
        // Doubled single quote '' is an escaped quote, not a terminator.
        if (next === "'") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "double") {
      markContent(i);
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "backtick") {
      markContent(i);
      if (ch === "`") {
        if (next === "`") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "bracket") {
      markContent(i);
      if (ch === "]") {
        state = "none";
      }
      i += 1;
      continue;
    }

    // state === "none"
    if (supportsDelimiterCommands && isAtLineStart(sql, i) && startsDelimiterCommand(sql, i)) {
      const lineEnd = findLineEnd(sql, i);
      const delimiter = parseDelimiterCommand(sql.slice(i, lineEnd));
      if (delimiter !== null) {
        flush();
        customDelimiter = delimiter === ";" ? null : delimiter;
        i = nextLineStart(sql, lineEnd);
        statementHitStart = i;
        continue;
      }
    }
    if (isOracleLikeDatabase(databaseType) && isAtLineStart(sql, i) && isSlashLine(sql, i)) {
      const lineEnd = findLineEnd(sql, i);
      flush(i);
      i = nextLineStart(sql, lineEnd);
      statementHitStart = i;
      continue;
    }

    // Line comments consume up to (and including) the newline.
    if (ch === "-" && next === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? len : newline + 1;
      continue;
    }
    if (ch === "#") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? len : newline + 1;
      continue;
    }
    // Block comments consume until the closing */.
    if (ch === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? len : close + 2;
      continue;
    }

    if (supportsSqlServerGoCommands(databaseType) && isAtLineStart(sql, i) && isSqlServerGoLine(sql, i)) {
      const lineEnd = findLineEnd(sql, i);
      flush(i);
      i = nextLineStart(sql, lineEnd);
      statementHitStart = i;
      continue;
    }

    if (ch === "'") {
      markContent(i);
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      markContent(i);
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      markContent(i);
      state = "backtick";
      i += 1;
      continue;
    }
    if (ch === "[") {
      markContent(i);
      state = "bracket";
      i += 1;
      continue;
    }
    // Postgres dollar quoting: $tag$ ... $tag$ (tag may be empty, i.e. $$)
    if (!customDelimiter && ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        markContent(i);
        dollarTag = tagMatch[0].slice(1, -1);
        i += tagMatch[0].length;
        state = "dollar";
        continue;
      }
    }

    if (customDelimiter) {
      if (sql.startsWith(customDelimiter, i)) {
        flush(i);
        i += customDelimiter.length;
        statementHitStart = i;
        continue;
      }
    } else if (ch === ";") {
      const isMysqlRoutineBlock = isMysqlRoutineBlockDatabase(databaseType) && statementStart !== -1 && startsWithMysqlRoutineBlock(sql.slice(statementStart, i));
      if (isMysqlRoutineBlock) {
        if (!mysqlRoutineBlockIsComplete(sql.slice(statementStart, i + 1))) {
          markContent(i);
          i += 1;
          continue;
        }
        // The final semicolon is the client-side statement delimiter.
        // Internal semicolons remain part of the routine body.
        flush();
      } else {
        const statementSoFar = statementStart === -1 ? "" : sql.slice(statementStart, i);
        const isOraclePlSql = isOracleLikeDatabase(databaseType) && statementStart !== -1 && startsWithOraclePlSqlBlock(statementSoFar);
        const isSapHanaScriptBlock = isSapHanaScriptBlockDatabase(databaseType) && statementStart !== -1 && startsWithSapHanaScriptBlock(statementSoFar);
        if (isOraclePlSql || isSapHanaScriptBlock) {
          markContent(i);
          if (isOraclePlSql && !oraclePlSqlBlockIsComplete(sql.slice(statementStart, i + 1))) {
            i += 1;
            continue;
          }
          if (isSapHanaScriptBlock && !sapHanaScriptBlockIsComplete(sql.slice(statementStart, i + 1))) {
            i += 1;
            continue;
          }
          flush(i + 1);
        } else {
          flush();
        }
      }
      statementHitStart = i + 1;
      i += 1;
      continue;
    }

    if (!isWhitespace(ch)) {
      markContent(i);
    }
    i += 1;
  }

  // Flush any trailing statement that lacks a terminating semicolon.
  flush();

  return statements;
}

/**
 * Returns the statement that contains `cursorPos`, or `null` when the cursor
 * sits on a blank line or no statement can be resolved.
 *
 * The returned range covers only the statement's own text (no trailing `;`),
 * which lets the editor highlight a tight preview range.
 */
export function statementRangeAtCursor(sql: string, cursorPos: number, databaseType?: DatabaseType): SqlTextRange | null {
  const pos = clampCursor(sql, cursorPos);
  if (isCursorOnBlankLine(sql, pos)) return null;

  const statements = splitSqlStatementRanges(sql, databaseType);
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const softRanges = splitStatementRangeAtSoftStarts(sql, statement, databaseType);
    // Cursor inside the statement body, including the exact start/end.
    if (pos >= statement.from && pos <= statement.to) {
      return rangeForCursorInSoftRanges(sql, softRanges, pos) ?? rangeFor(statement, sql);
    }
    const next = statements[index + 1];
    // A caret after a statement's semicolon still belongs to that statement
    // until the next statement's text begins.
    if (pos > statement.to && (!next || pos < next.from) && isCursorInSameLineDelimiterGap(sql, statement.to, pos)) {
      return rangeForCursorInSoftRanges(sql, softRanges, pos) ?? rangeFor(statement, sql);
    }

    // Cursor in indentation or inter-statement whitespace immediately before
    // the statement should still target that statement, while the returned
    // execution range remains tight around the SQL text itself.
    if (pos >= statement.hitFrom && pos < statement.from && sql.slice(pos, statement.from).trim() === "") {
      const previous = statements[index - 1];
      if (previous && isCursorInSameLineDelimiterGap(sql, previous.to, pos)) {
        const previousSoftRanges = splitStatementRangeAtSoftStarts(sql, previous, databaseType);
        return rangeForCursorInSoftRanges(sql, previousSoftRanges, pos) ?? rangeFor(previous, sql);
      }
      return rangeForCursorInSoftRanges(sql, softRanges, pos) ?? rangeFor(statement, sql);
    }

    if (pos > statement.to && (!next || pos < next.hitFrom) && isCursorOnStatementLine(sql, pos, statement)) {
      return rangeForCursorInSoftRanges(sql, softRanges, pos) ?? rangeFor(statement, sql);
    }
  }

  return null;
}

export function mongoCommandRangeAtCursor(sql: string, cursorPos: number): SqlTextRange | null {
  const pos = clampCursor(sql, cursorPos);
  if (isCursorOnBlankLine(sql, pos)) return null;

  const commands = splitMongoCommandRanges(sql);
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    const range = { from: command.from, to: command.to, sql: command.text };

    if (pos >= command.from && pos <= command.to) return range;

    const next = commands[index + 1];
    if (pos > command.to && (!next || pos < next.from) && isCursorInSameLineDelimiterGap(sql, command.to, pos)) return range;

    if (pos < command.from && sql.slice(pos, command.from).trim() === "" && isCursorOnStatementLine(sql, pos, command)) return range;
  }

  return null;
}

function isCursorInSameLineDelimiterGap(sql: string, previousStatementEnd: number, cursorPos: number): boolean {
  if (cursorPos <= previousStatementEnd) return false;
  const between = sql.slice(previousStatementEnd, cursorPos);
  const delimiterIndex = between.lastIndexOf(";");
  if (delimiterIndex === -1) return false;
  const afterDelimiter = between.slice(delimiterIndex + 1);
  return !afterDelimiter.includes("\n") && between.slice(0, delimiterIndex).trim() === "" && afterDelimiter.trim() === "";
}

function rangeForCursorInSoftRanges(sql: string, ranges: RawStatement[], pos: number): SqlTextRange | null {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index];
    if (pos >= range.from && pos <= range.to) {
      return rangeFor(range, sql);
    }
    if (pos >= range.hitFrom && pos < range.from && sql.slice(pos, range.from).trim() === "") {
      return rangeFor(range, sql);
    }

    const next = ranges[index + 1];
    if (pos > range.to && (!next || pos < next.hitFrom) && isCursorOnStatementLine(sql, pos, range)) {
      return rangeFor(range, sql);
    }
  }

  return null;
}

function splitStatementRangeAtSoftStarts(sql: string, statement: RawStatement, databaseType?: DatabaseType): RawStatement[] {
  if (isOraclePlSqlStatement(statement.sql, databaseType)) return [statement];
  if (isSapHanaScriptBlockStatement(statement.sql, databaseType)) return [statement];
  // Routine bodies contain top-level-looking SET/INSERT/SELECT lines that are not independent statements.
  if (isMysqlRoutineBlockDatabase(databaseType) && startsWithMysqlRoutineBlock(statement.sql)) return [statement];

  const lineStarts = topLevelSoftStatementLineStarts(sql, statement, databaseType);
  if (lineStarts.length <= 1) return [statement];

  const boundaries: Array<{ hitFrom: number; from: number; keyword: string }> = [];
  let currentKeyword = softStatementKeywordAt(sql, statement.from, databaseType);
  let currentExplainTargetKeyword = explainLikeTargetKeywordAt(sql, statement.from);
  let currentBodyKeyword = currentExplainTargetKeyword ?? currentKeyword;
  let consumedWithMainStatement = false;
  let consumedExplainStatement = false;

  boundaries.push({ hitFrom: statement.hitFrom, from: statement.from, keyword: currentKeyword ?? "" });

  for (const lineStart of lineStarts) {
    if (lineStart.from <= statement.from) continue;

    if (currentKeyword === "WITH" && !consumedWithMainStatement && WITH_MAIN_STATEMENT_KEYWORDS.has(lineStart.keyword)) {
      consumedWithMainStatement = true;
      continue;
    }

    if (isSetOperationQueryContinuation(sql, statement.from, lineStart.from, lineStart.keyword)) {
      continue;
    }

    if (!consumedExplainStatement && EXPLAIN_STATEMENT_KEYWORDS.has(lineStart.keyword) && (currentKeyword === "EXPLAIN" || currentExplainTargetKeyword !== null)) {
      consumedExplainStatement = true;
      currentBodyKeyword = lineStart.keyword;
      continue;
    }

    if (currentBodyKeyword === "CREATE" && CREATE_BODY_KEYWORDS.has(lineStart.keyword)) {
      continue;
    }

    if (currentBodyKeyword === "CREATE" && isMysqlCreateTableOptionContinuation(sql, statement.from, lineStart.from, lineStart.keyword, databaseType)) {
      continue;
    }

    if (currentBodyKeyword === "INSERT" && INSERT_BODY_KEYWORDS.has(lineStart.keyword)) {
      continue;
    }

    if (currentBodyKeyword === "UPDATE" && lineStart.keyword === "SET") {
      continue;
    }

    if (currentBodyKeyword === "ALTER" && ALTER_BODY_KEYWORDS.has(lineStart.keyword)) {
      continue;
    }

    boundaries.push(lineStart);
    currentKeyword = lineStart.keyword;
    currentExplainTargetKeyword = explainLikeTargetKeywordAt(sql, lineStart.from);
    currentBodyKeyword = currentExplainTargetKeyword ?? currentKeyword;
    consumedWithMainStatement = false;
    consumedExplainStatement = false;
  }

  if (boundaries.length <= 1) return [statement];

  const ranges: RawStatement[] = [];
  for (let index = 0; index < boundaries.length; index += 1) {
    const boundary = boundaries[index];
    const next = boundaries[index + 1];
    const to = next ? trimRangeEndBeforeNextBoundary(sql, boundary.from, next.from) : trimRangeEnd(sql, boundary.from, statement.to);
    if (to > boundary.from) {
      ranges.push({
        hitFrom: boundary.hitFrom,
        from: boundary.from,
        to,
        sql: sql.slice(boundary.from, to),
      });
    }
  }

  return ranges.length > 0 ? ranges : [statement];
}

function topLevelSoftStatementLineStarts(sql: string, statement: RawStatement, databaseType?: DatabaseType): Array<{ hitFrom: number; from: number; keyword: string }> {
  const starts: Array<{ hitFrom: number; from: number; keyword: string }> = [];
  const len = statement.to;
  let state: QuoteState | "lineComment" | "blockComment" = "none";
  let dollarTag = "";
  let parenDepth = 0;
  let lineStart = statement.from;
  let firstNonWhitespaceOnLine = -1;
  let i = statement.from;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "none" && firstNonWhitespaceOnLine === -1 && ch !== "\n" && ch !== "\r" && !isSqlWhitespace(ch) && !startsLineComment(sql, i) && !startsBlockComment(sql, i)) {
      firstNonWhitespaceOnLine = i;
      if (parenDepth === 0) {
        const keyword = softStatementKeywordAt(sql, i, databaseType);
        if (keyword) {
          starts.push({ hitFrom: lineStart, from: i, keyword });
        }
      }
    }

    if (ch === "\n") {
      if (state === "lineComment") state = "none";
      lineStart = i + 1;
      firstNonWhitespaceOnLine = -1;
      i += 1;
      continue;
    }

    if (state === "lineComment") {
      i += 1;
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "none";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "dollar") {
      if (ch === "$") {
        const closingTag = `$${dollarTag}$`;
        if (sql.startsWith(closingTag, i)) {
          i += closingTag.length;
          state = "none";
          dollarTag = "";
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (state === "single") {
      if (ch === "\\" && next) {
        i += 2;
        continue;
      }
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "double") {
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "backtick") {
      if (ch === "`") {
        if (next === "`") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "bracket") {
      if (ch === "]") state = "none";
      i += 1;
      continue;
    }

    // state === "none"
    if (ch === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "#") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "backtick";
      i += 1;
      continue;
    }
    if (ch === "[") {
      state = "bracket";
      i += 1;
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0].slice(1, -1);
        i += tagMatch[0].length;
        state = "dollar";
        continue;
      }
    }
    if (ch === "(") {
      parenDepth += 1;
    } else if (ch === ")" && parenDepth > 0) {
      parenDepth -= 1;
    }
    i += 1;
  }

  return starts;
}

function softStatementKeywordAt(sql: string, pos: number, databaseType?: DatabaseType): string | null {
  const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(pos));
  if (!match) return null;
  const keyword = match[0].toUpperCase();
  if (keyword === "REPLACE" && nextNonWhitespaceChar(sql, pos + match[0].length) === "(") return null;
  // COMMENT is also a common column name. Only COMMENT ON starts a standalone
  // SQL command; otherwise a line-start projection column must stay in SELECT.
  if (keyword === "COMMENT" && nextSqlWord(sql, pos + match[0].length) !== "ON") return null;
  return softStatementStartKeywords(databaseType).has(keyword) ? keyword : null;
}

function softStatementStartKeywords(databaseType?: DatabaseType): Set<string> {
  return new Set([...COMMON_SOFT_STATEMENT_START_KEYWORDS, ...(databaseType ? (DATABASE_SOFT_STATEMENT_KEYWORDS[databaseType] ?? []) : [])]);
}

function isSetOperationQueryContinuation(sql: string, from: number, to: number, keyword: string): boolean {
  if (keyword !== "SELECT" && keyword !== "WITH") return false;
  const words = topLevelWordsBefore(sql, from, to, 3);
  const last = words[words.length - 1];
  if (last && SET_OPERATION_KEYWORDS.has(last)) return true;
  if (last && SET_OPERATION_MODIFIER_KEYWORDS.has(last)) {
    const previous = words[words.length - 2];
    return !!previous && SET_OPERATION_KEYWORDS.has(previous);
  }
  return false;
}

function isMysqlCreateTableOptionContinuation(sql: string, statementFrom: number, lineStartFrom: number, keyword: string, databaseType?: DatabaseType): boolean {
  if (databaseType && !MYSQL_CREATE_TABLE_OPTION_DATABASES.has(databaseType)) return false;
  if (keyword !== "COMMENT") return false;
  if (!startsWithMysqlCreateTable(sql, statementFrom)) return false;

  const next = nextNonWhitespaceChar(sql, lineStartFrom + keyword.length);
  return next === "=" || next === "'" || next === '"';
}

function startsWithMysqlCreateTable(sql: string, statementFrom: number): boolean {
  const text = sql.slice(statementFrom, statementFrom + 256);
  return /^CREATE\s+(?:TEMPORARY\s+)?TABLE\b/i.test(text);
}

function topLevelWordsBefore(sql: string, from: number, to: number, limit: number): string[] {
  const words: string[] = [];
  let state: QuoteState | "lineComment" | "blockComment" = "none";
  let dollarTag = "";
  let parenDepth = 0;
  let i = from;

  while (i < to) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "lineComment") {
      if (ch === "\n") state = "none";
      i += 1;
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "none";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "dollar") {
      if (ch === "$") {
        const closingTag = `$${dollarTag}$`;
        if (sql.startsWith(closingTag, i)) {
          i += closingTag.length;
          state = "none";
          dollarTag = "";
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (state === "single") {
      if (ch === "\\" && next) {
        i += 2;
        continue;
      }
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "double") {
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "backtick") {
      if (ch === "`") {
        if (next === "`") {
          i += 2;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "bracket") {
      if (ch === "]") state = "none";
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "#") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "backtick";
      i += 1;
      continue;
    }
    if (ch === "[") {
      state = "bracket";
      i += 1;
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        dollarTag = tagMatch[0].slice(1, -1);
        i += tagMatch[0].length;
        state = "dollar";
        continue;
      }
    }
    if (ch === "(") {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (parenDepth > 0) parenDepth -= 1;
      i += 1;
      continue;
    }
    if (parenDepth === 0) {
      const match = /^[A-Za-z_][\w$]*/.exec(sql.slice(i));
      if (match) {
        words.push(match[0].toUpperCase());
        if (words.length > limit) words.shift();
        i += match[0].length;
        continue;
      }
    }
    i += 1;
  }

  return words;
}

function nextNonWhitespaceChar(sql: string, pos: number): string | null {
  let i = pos;
  while (i < sql.length && isSqlWhitespace(sql[i])) i += 1;
  return i < sql.length ? sql[i] : null;
}

function nextSqlWord(sql: string, pos: number): string | null {
  let i = pos;
  while (i < sql.length && isSqlWhitespace(sql[i])) i += 1;
  return /^[A-Za-z_][\w$]*/.exec(sql.slice(i))?.[0]?.toUpperCase() ?? null;
}

function isExplainLikeKeyword(keyword: string | null): boolean {
  return keyword === "EXPLAIN" || keyword === "DESCRIBE" || keyword === "DESC";
}

function explainLikeTargetKeywordAt(sql: string, pos: number): string | null {
  const prefixMatch = /^[A-Za-z_][\w$]*/.exec(sql.slice(pos));
  const prefix = prefixMatch?.[0]?.toUpperCase();
  if (!isExplainLikeKeyword(prefix ?? null)) return null;

  let i = pos + (prefixMatch?.[0].length ?? 0);
  while (i < sql.length && isSqlWhitespace(sql[i])) i += 1;
  const targetMatch = /^[A-Za-z_][\w$]*/.exec(sql.slice(i));
  const targetKeyword = targetMatch?.[0]?.toUpperCase();
  return targetKeyword && EXPLAIN_STATEMENT_KEYWORDS.has(targetKeyword) ? targetKeyword : null;
}

function startsLineComment(sql: string, pos: number): boolean {
  return (sql[pos] === "-" && sql[pos + 1] === "-") || sql[pos] === "#";
}

function startsBlockComment(sql: string, pos: number): boolean {
  return sql[pos] === "/" && sql[pos + 1] === "*";
}

function trimRangeEnd(sql: string, from: number, to: number): number {
  let end = to;
  while (end > from && isSqlWhitespace(sql[end - 1])) {
    end -= 1;
  }
  return end;
}

function trimRangeEndBeforeNextBoundary(sql: string, from: number, nextBoundaryFrom: number): number {
  let state: QuoteState | "lineComment" | "blockComment" = "none";
  let dollarTag = "";
  let lastContentEnd = from;
  let i = from;

  while (i < nextBoundaryFrom) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "lineComment") {
      if (ch === "\n") state = "none";
      i += 1;
      continue;
    }

    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "none";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (state === "dollar") {
      lastContentEnd = i + 1;
      if (ch === "$") {
        const closingTag = `$${dollarTag}$`;
        if (sql.startsWith(closingTag, i)) {
          i += closingTag.length;
          lastContentEnd = i;
          state = "none";
          dollarTag = "";
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (state === "single") {
      lastContentEnd = i + 1;
      if (ch === "\\" && next) {
        i += 2;
        lastContentEnd = i;
        continue;
      }
      if (ch === "'") {
        if (next === "'") {
          i += 2;
          lastContentEnd = i;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "double") {
      lastContentEnd = i + 1;
      if (ch === '"') {
        if (next === '"') {
          i += 2;
          lastContentEnd = i;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "backtick") {
      lastContentEnd = i + 1;
      if (ch === "`") {
        if (next === "`") {
          i += 2;
          lastContentEnd = i;
          continue;
        }
        state = "none";
      }
      i += 1;
      continue;
    }

    if (state === "bracket") {
      lastContentEnd = i + 1;
      if (ch === "]") state = "none";
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "#") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      lastContentEnd = i + 1;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      lastContentEnd = i + 1;
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "backtick";
      lastContentEnd = i + 1;
      i += 1;
      continue;
    }
    if (ch === "[") {
      state = "bracket";
      lastContentEnd = i + 1;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        state = "dollar";
        dollarTag = tagMatch[0].slice(1, -1);
        i += tagMatch[0].length;
        lastContentEnd = i;
        continue;
      }
    }

    if (!isSqlWhitespace(ch)) {
      lastContentEnd = i + 1;
    }
    i += 1;
  }

  return trimRangeEnd(sql, from, lastContentEnd);
}

function isSqlWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

export function isOracleLikeDatabase(databaseType?: DatabaseType): boolean {
  return !!databaseType && ORACLE_LIKE_PL_SQL_DATABASES.has(databaseType);
}

export function isOraclePlSqlStatement(sql: string, databaseType?: DatabaseType): boolean {
  return isOracleLikeDatabase(databaseType) && startsWithOraclePlSqlBlock(sql);
}

function isSapHanaScriptBlockDatabase(databaseType?: DatabaseType): boolean {
  return databaseType === "saphana";
}

function isSapHanaScriptBlockStatement(sql: string, databaseType?: DatabaseType): boolean {
  return isSapHanaScriptBlockDatabase(databaseType) && startsWithSapHanaScriptBlock(sql);
}

function isMysqlRoutineBlockDatabase(databaseType?: DatabaseType): boolean {
  return !!databaseType && MYSQL_ROUTINE_BLOCK_DATABASES.has(databaseType);
}

function startsWithMysqlRoutineBlock(sql: string): boolean {
  return isMysqlRoutineDdlStart(sql) && mysqlRoutineTokens(sql).some((token) => token.kind === "word" && token.value === "BEGIN");
}

function isMysqlRoutineDdlStart(sql: string): boolean {
  const words = mysqlRoutineWords(sql).slice(0, 16);
  if (words[0] !== "CREATE") return false;

  for (const word of words.slice(1)) {
    if (MYSQL_ROUTINE_OBJECT_TYPES.has(word)) return true;
    if (MYSQL_NON_ROUTINE_CREATE_TYPES.has(word)) return false;
  }
  return false;
}

function mysqlRoutineBlockIsComplete(sql: string): boolean {
  if (!startsWithMysqlRoutineBlock(sql)) return false;

  const tokens = mysqlRoutineTokens(sql);
  let beginDepth = 0;
  let sawBegin = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;
    if (token.value === "BEGIN") {
      if (previousWordToken(tokens, index) === "END") continue;
      sawBegin = true;
      beginDepth += 1;
      continue;
    }
    if (token.value === "END" && sawBegin) {
      if (MYSQL_CONTROL_BLOCK_SUFFIXES.has(nextWordToken(tokens, index) ?? "")) continue;
      beginDepth = Math.max(0, beginDepth - 1);
    }
  }

  return sawBegin && beginDepth === 0 && tokens[tokens.length - 1]?.kind === "semicolon";
}

function mysqlRoutineWords(sql: string): string[] {
  return mysqlRoutineTokens(sql)
    .filter((token): token is { kind: "word"; value: string } => token.kind === "word")
    .map((token) => token.value);
}

function mysqlRoutineTokens(sql: string): Array<{ kind: "word" | "semicolon"; value: string }> {
  const tokens: Array<{ kind: "word" | "semicolon"; value: string }> = [];
  let state: QuoteState | "lineComment" | "blockComment" = "none";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "lineComment") {
      if (ch === "\n") state = "none";
      i += 1;
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "none";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "single") {
      if (ch === "\\" && next) {
        i += 2;
        continue;
      }
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") state = "none";
      i += 1;
      continue;
    }
    if (state === "double") {
      if (ch === "\\" && next) {
        i += 2;
        continue;
      }
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') state = "none";
      i += 1;
      continue;
    }
    if (state === "backtick") {
      if (ch === "`" && next === "`") {
        i += 2;
        continue;
      }
      if (ch === "`") state = "none";
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "#") {
      state = "lineComment";
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === "`") {
      state = "backtick";
      i += 1;
      continue;
    }
    if (ch === ";") {
      tokens.push({ kind: "semicolon", value: ";" });
      i += 1;
      continue;
    }

    const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word.toUpperCase() });
      i += word.length;
      continue;
    }
    i += 1;
  }

  return tokens;
}

function startsWithOraclePlSqlBlock(sql: string): boolean {
  const words = oraclePlSqlWords(sql);
  const first = words[0];
  if (!first) return false;
  if (ORACLE_PL_SQL_BLOCK_STARTERS.has(first)) return first !== "BEGIN" || words[1] !== "TRANSACTION";
  if (first !== "CREATE") return false;

  let index = 1;
  while (["OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE"].includes(words[index] ?? "")) {
    index += 1;
  }
  if (words[index] === "PACKAGE" && words[index + 1] === "BODY") return true;
  if (words[index] === "TYPE" && words[index + 1] === "BODY") return true;
  return ORACLE_PL_SQL_CREATE_OBJECT_TYPES.has(words[index] ?? "");
}

function startsWithSapHanaScriptBlock(sql: string): boolean {
  return oraclePlSqlWords(sql)[0] === "DO";
}

function sapHanaScriptBlockIsComplete(sql: string): boolean {
  if (!startsWithSapHanaScriptBlock(sql)) return false;

  const tokens = oraclePlSqlTokens(sql);
  const stack: string[] = [];
  let sawBegin = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;

    if (token.value === "BEGIN") {
      if (previousWordToken(tokens, index) === "END") continue;
      stack.push("BLOCK");
      sawBegin = true;
      continue;
    }
    if (token.value === "IF" || token.value === "FOR" || token.value === "WHILE" || token.value === "CASE") {
      if (previousWordToken(tokens, index) !== "END") stack.push(token.value);
      continue;
    }
    if (token.value === "END") {
      const next = nextWordToken(tokens, index);
      const top = stack[stack.length - 1];
      const target = SAP_HANA_SCRIPT_BLOCK_TERMINATORS.has(next ?? "") ? next : top === "CASE" ? "CASE" : "BLOCK";
      if (top === target) stack.pop();
    }
  }

  return sawBegin && stack.length === 0 && tokens[tokens.length - 1]?.kind === "semicolon";
}

function oraclePlSqlBlockIsComplete(sql: string): boolean {
  const tokens = oraclePlSqlTokens(sql);
  if (!startsWithOraclePlSqlBlock(sql)) return false;

  const stack: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word") continue;

    if (token.value === "DECLARE") {
      stack.push("BLOCK");
      continue;
    }
    if (token.value === "BEGIN") {
      if (tokens[index - 1]?.kind === "word" && tokens[index - 1]?.value === "TRANSACTION") continue;
      const previous = previousWordToken(tokens, index);
      if (previous === "END") continue;
      if (stack[stack.length - 1] !== "BLOCK") stack.push("BLOCK");
      continue;
    }
    if (token.value === "IF") {
      const previous = previousWordToken(tokens, index);
      if (previous !== "END" && previous !== "ELSIF") stack.push("IF");
      continue;
    }
    if (token.value === "LOOP") {
      if (previousWordToken(tokens, index) !== "END") stack.push("LOOP");
      continue;
    }
    if (token.value === "CASE") {
      if (previousWordToken(tokens, index) !== "END") stack.push("CASE");
      continue;
    }
    if (token.value === "END") {
      const next = nextWordToken(tokens, index);
      const target = ORACLE_PL_SQL_TERMINATORS.has(next ?? "") ? next : "BLOCK";
      const top = stack[stack.length - 1];
      if (top === target || (target === "BLOCK" && top === "BLOCK")) stack.pop();
      continue;
    }
  }

  return stack.length === 0 && tokens[tokens.length - 1]?.kind === "semicolon";
}

function oraclePlSqlWords(sql: string): string[] {
  return oraclePlSqlTokens(sql)
    .filter((token): token is { kind: "word"; value: string } => token.kind === "word")
    .map((token) => token.value);
}

function oraclePlSqlTokens(sql: string): Array<{ kind: "word" | "semicolon"; value: string }> {
  const tokens: Array<{ kind: "word" | "semicolon"; value: string }> = [];
  let state: QuoteState | "lineComment" | "blockComment" = "none";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (state === "lineComment") {
      if (ch === "\n") state = "none";
      i += 1;
      continue;
    }
    if (state === "blockComment") {
      if (ch === "*" && next === "/") {
        state = "none";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === "single") {
      if (ch === "'" && next === "'") {
        i += 2;
        continue;
      }
      if (ch === "'") state = "none";
      i += 1;
      continue;
    }
    if (state === "double") {
      if (ch === '"' && next === '"') {
        i += 2;
        continue;
      }
      if (ch === '"') state = "none";
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      state = "lineComment";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "blockComment";
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = "single";
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      i += 1;
      continue;
    }
    if (ch === ";") {
      tokens.push({ kind: "semicolon", value: ";" });
      i += 1;
      continue;
    }

    const word = /^[A-Za-z_][\w$]*/.exec(sql.slice(i))?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word.toUpperCase() });
      i += word.length;
      continue;
    }
    i += 1;
  }

  return tokens;
}

function previousWordToken(tokens: Array<{ kind: "word" | "semicolon"; value: string }>, index: number): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (tokens[i].kind === "word") return tokens[i].value;
  }
  return null;
}

function nextWordToken(tokens: Array<{ kind: "word" | "semicolon"; value: string }>, index: number): string | null {
  for (let i = index + 1; i < tokens.length; i += 1) {
    if (tokens[i].kind === "word") return tokens[i].value;
  }
  return null;
}

function isAtLineStart(sql: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i -= 1) {
    const ch = sql[i];
    if (ch === "\n" || ch === "\r") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

function isSlashLine(sql: string, pos: number): boolean {
  const lineEnd = findLineEnd(sql, pos);
  return sql.slice(pos, lineEnd).trim() === "/";
}

function supportsSqlServerGoCommands(databaseType?: DatabaseType): boolean {
  return databaseType === "sqlserver";
}

function isSqlServerGoLine(sql: string, pos: number): boolean {
  const lineEnd = findLineEnd(sql, pos);
  return /^go(?:\s+\d+)?$/i.test(sql.slice(pos, lineEnd).trim());
}

function startsDelimiterCommand(sql: string, pos: number): boolean {
  const prefix = sql.slice(pos, pos + 9);
  return prefix.toLowerCase() === "delimiter" && (sql[pos + 9] === " " || sql[pos + 9] === "\t");
}

function parseDelimiterCommand(line: string): string | null {
  const match = /^delimiter[ \t]+(.+)$/i.exec(line.trim());
  const delimiter = match?.[1]?.trim();
  return delimiter ? delimiter : null;
}

function findLineEnd(sql: string, pos: number): number {
  const newline = sql.indexOf("\n", pos);
  const carriageReturn = sql.indexOf("\r", pos);
  if (newline === -1) return carriageReturn === -1 ? sql.length : carriageReturn;
  if (carriageReturn === -1) return newline;
  return Math.min(newline, carriageReturn);
}

function nextLineStart(sql: string, lineEnd: number): number {
  if (sql[lineEnd] === "\r" && sql[lineEnd + 1] === "\n") return lineEnd + 2;
  if (sql[lineEnd] === "\n" || sql[lineEnd] === "\r") return lineEnd + 1;
  return lineEnd;
}

function rangeFor(statement: RawStatement, sql: string): SqlTextRange {
  return {
    from: statement.from,
    to: statement.to,
    sql: sql.slice(statement.from, statement.to),
  };
}

function clampCursor(sql: string, cursorPos: number): number {
  if (!Number.isFinite(cursorPos)) return 0;
  if (cursorPos < 0) return 0;
  if (cursorPos > sql.length) return sql.length;
  return cursorPos;
}

function isCursorOnBlankLine(sql: string, pos: number): boolean {
  const lineStart = sql.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = sql.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = sql.length;
  return sql.slice(lineStart, lineEnd).trim() === "";
}

function isCursorOnStatementLine(sql: string, pos: number, statement: Pick<RawStatement, "from">): boolean {
  const lineStart = sql.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = sql.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = sql.length;
  return statement.from >= lineStart && statement.from <= lineEnd;
}

/**
 * Returns the full document as a range, or `null` when it is empty/whitespace.
 */
export function fullSqlRange(sql: string): SqlTextRange | null {
  const trimmed = sql.trim();
  if (!trimmed) return null;
  const from = sql.length - sql.trimStart().length;
  const to = from + trimmed.length;
  return { from, to, sql: sql.slice(from, to) };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

/**
 * Build the ordered list of execution candidates to show in the picker.
 *
 * Order is always `[cursor, all]` when both are available, except when the
 * cursor statement and the full document are effectively the same SQL — in
 * that case only a single candidate is returned to avoid duplicates.
 */
export function executableStatementRanges(sql: string, databaseType?: DatabaseType): SqlTextRange[] {
  if (databaseType === "redis") return redisExecutableCommandRanges(sql);
  if (databaseType === "mongodb") return splitMongoCommandRanges(sql).map(({ from, to, text }) => ({ from, to, sql: text }));
  return splitSqlStatementRanges(sql, databaseType).flatMap((statement) => splitStatementRangeAtSoftStarts(sql, statement, databaseType).map((range) => rangeFor(range, sql)));
}

export function currentExecutableStatementRange(sql: string, cursorPos: number, databaseType?: DatabaseType): SqlTextRange | null {
  if (databaseType === "redis") return redisCommandRangeAtCursor(sql, cursorPos);
  if (databaseType === "mongodb") return null;
  return statementRangeAtCursor(sql, cursorPos, databaseType);
}

export function buildExecutionCandidates(sql: string, cursorPos: number, databaseType?: DatabaseType): SqlExecutionCandidate[] {
  const full = fullSqlRange(sql);
  const cursorStatement = currentExecutableStatementRange(sql, cursorPos, databaseType);

  if (!full && !cursorStatement) return [];
  if (!full) {
    return cursorStatement ? [candidateFromRange(cursorStatement, "cursor", databaseType)] : [];
  }
  if (!cursorStatement) {
    return [candidateFromRange(full, "all", databaseType)];
  }

  const sameContent = normalizeSql(cursorStatement.sql) === normalizeSql(full.sql);
  if (sameContent) {
    return [candidateFromRange(full, "all", databaseType)];
  }

  return [candidateFromRange(cursorStatement, "cursor", databaseType), candidateFromRange(full, "all", databaseType)];
}

function candidateFromRange(range: SqlTextRange, kind: SqlExecutionCandidate["kind"], databaseType?: DatabaseType): SqlExecutionCandidate {
  const isRedis = databaseType === "redis";
  return {
    kind,
    label: kind === "cursor" ? (isRedis ? "currentCommand" : "currentStatement") : isRedis ? "allCommands" : "allStatements",
    sql: range.sql,
    from: range.from,
    to: range.to,
  };
}

function redisExecutableCommandCount(sql: string): number {
  let count = 0;
  for (const range of redisExecutableCommandRanges(sql)) {
    if (!range.sql.trim()) continue;
    count += 1;
    if (count > 1) return count;
  }
  return count;
}

function redisExecutableCommandRanges(sql: string): SqlTextRange[] {
  const ranges: SqlTextRange[] = [];
  let lineStart = 0;
  while (lineStart <= sql.length) {
    let lineEnd = sql.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = sql.length;
    const rawLine = sql.slice(lineStart, lineEnd);
    const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
    const trailingWhitespace = rawLine.length - rawLine.trimEnd().length;
    const trimmedLine = rawLine.trim();
    if (trimmedLine && !trimmedLine.startsWith("#")) {
      const from = lineStart + leadingWhitespace;
      const to = lineStart + rawLine.length - trailingWhitespace;
      ranges.push({ from, to, sql: sql.slice(from, to) });
    }
    if (lineEnd >= sql.length) break;
    lineStart = lineEnd + 1;
  }
  return ranges;
}

function redisCommandRangeAtCursor(sql: string, cursorPos: number): SqlTextRange | null {
  const pos = clampCursor(sql, cursorPos);
  if (isCursorOnBlankLine(sql, pos)) return null;

  const lineStart = sql.lastIndexOf("\n", pos - 1) + 1;
  let lineEnd = sql.indexOf("\n", pos);
  if (lineEnd === -1) lineEnd = sql.length;

  const rawLine = sql.slice(lineStart, lineEnd);
  const leadingWhitespace = rawLine.length - rawLine.trimStart().length;
  const trimmedLine = rawLine.trim();
  if (!trimmedLine || trimmedLine.startsWith("#")) return null;

  const from = lineStart + leadingWhitespace;
  const to = lineStart + rawLine.length - (rawLine.length - rawLine.trimEnd().length);
  return {
    from,
    to,
    sql: sql.slice(from, to),
  };
}
