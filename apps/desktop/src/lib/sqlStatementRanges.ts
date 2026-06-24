import type { SqlExecutionCandidate } from "./sqlExecutionTarget";
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

const NON_SQL_EXECUTION_TARGET_TYPES: ReadonlySet<DatabaseType> = new Set(["mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "etcd", "zookeeper", "mq", "neo4j"]);

export function supportsExecutionTargetPicker(databaseType?: DatabaseType): boolean {
  return !!databaseType && (databaseType === "redis" || !NON_SQL_EXECUTION_TARGET_TYPES.has(databaseType));
}

export function hasMultipleExecutionTargets(sql: string, databaseType?: DatabaseType): boolean {
  if (databaseType === "redis") {
    return redisExecutableCommandCount(sql) > 1;
  }
  return splitSqlStatementRanges(sql).length > 1;
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
  mq: [],
  etcd: [],
  zookeeper: [],
};

const WITH_MAIN_STATEMENT_KEYWORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);
const EXPLAIN_STATEMENT_KEYWORDS = new Set(["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "MERGE", "CREATE", "ALTER", "DROP"]);
const CREATE_BODY_KEYWORDS = new Set(["SELECT", "WITH", "BEGIN", "DECLARE"]);
const INSERT_BODY_KEYWORDS = new Set(["SELECT", "WITH"]);

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
export function splitSqlStatementRanges(sql: string): RawStatement[] {
  const statements: RawStatement[] = [];
  const len = sql.length;

  let statementStart = -1;
  let statementEnd = -1;
  let statementHitStart = 0;
  let state: QuoteState = "none";
  let dollarTag = "";
  let i = 0;

  const isWhitespace = (ch: string) => ch === " " || ch === "\t" || ch === "\r" || ch === "\n";

  const markContent = (pos: number) => {
    if (statementStart === -1) statementStart = pos;
    statementEnd = pos + 1;
  };

  const flush = () => {
    if (statementStart !== -1 && statementEnd !== -1 && statementEnd > statementStart) {
      statements.push({ hitFrom: statementHitStart, from: statementStart, to: statementEnd, sql: sql.slice(statementStart, statementEnd) });
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
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        markContent(i);
        dollarTag = tagMatch[0].slice(1, -1);
        i += tagMatch[0].length;
        state = "dollar";
        continue;
      }
    }

    if (ch === ";") {
      flush();
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

  const statements = splitSqlStatementRanges(sql);
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const softRanges = splitStatementRangeAtSoftStarts(sql, statement, databaseType);
    // Cursor inside the statement body, including the exact start/end.
    if (pos >= statement.from && pos <= statement.to) {
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

    const next = statements[index + 1];
    if (pos > statement.to && (!next || pos < next.hitFrom) && isCursorOnStatementLine(sql, pos, statement)) {
      return rangeForCursorInSoftRanges(sql, softRanges, pos) ?? rangeFor(statement, sql);
    }
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
  const lineStarts = topLevelSoftStatementLineStarts(sql, statement, databaseType);
  if (lineStarts.length <= 1) return [statement];

  const boundaries: Array<{ hitFrom: number; from: number; keyword: string }> = [];
  let currentKeyword = softStatementKeywordAt(sql, statement.from, databaseType);
  let consumedWithMainStatement = false;
  let consumedExplainStatement = false;

  boundaries.push({ hitFrom: statement.hitFrom, from: statement.from, keyword: currentKeyword ?? "" });

  for (const lineStart of lineStarts) {
    if (lineStart.from <= statement.from) continue;

    if (currentKeyword === "WITH" && !consumedWithMainStatement && WITH_MAIN_STATEMENT_KEYWORDS.has(lineStart.keyword)) {
      consumedWithMainStatement = true;
      continue;
    }

    if (currentKeyword === "EXPLAIN" && !consumedExplainStatement && EXPLAIN_STATEMENT_KEYWORDS.has(lineStart.keyword)) {
      consumedExplainStatement = true;
      continue;
    }

    if (currentKeyword === "CREATE" && CREATE_BODY_KEYWORDS.has(lineStart.keyword)) {
      continue;
    }

    if (currentKeyword === "INSERT" && INSERT_BODY_KEYWORDS.has(lineStart.keyword)) {
      continue;
    }

    if (currentKeyword === "UPDATE" && lineStart.keyword === "SET") {
      continue;
    }

    boundaries.push(lineStart);
    currentKeyword = lineStart.keyword;
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
  return softStatementStartKeywords(databaseType).has(keyword) ? keyword : null;
}

function softStatementStartKeywords(databaseType?: DatabaseType): Set<string> {
  return new Set([...COMMON_SOFT_STATEMENT_START_KEYWORDS, ...(databaseType ? (DATABASE_SOFT_STATEMENT_KEYWORDS[databaseType] ?? []) : [])]);
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

function isCursorOnStatementLine(sql: string, pos: number, statement: RawStatement): boolean {
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
export function buildExecutionCandidates(sql: string, cursorPos: number, databaseType?: DatabaseType): SqlExecutionCandidate[] {
  const full = fullSqlRange(sql);
  const cursorStatement = databaseType === "redis" ? redisCommandRangeAtCursor(sql, cursorPos) : statementRangeAtCursor(sql, cursorPos, databaseType);

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
  for (const line of sql.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    count += 1;
    if (count > 1) return count;
  }
  return count;
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
