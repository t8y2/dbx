import { describe, expect, it } from "vitest";
import { buildExecutionCandidates, fullSqlRange, hasMultipleExecutionTargets, splitSqlStatementRanges, statementRangeAtCursor, supportsExecutionTargetPicker } from "../sqlStatementRanges";

function indexOf(sql: string, needle: string, occurrence = 1): number {
  let from = 0;
  let idx = -1;
  for (let i = 0; i < occurrence; i += 1) {
    idx = sql.indexOf(needle, from);
    if (idx === -1) return -1;
    from = idx + needle.length;
  }
  return idx;
}

function rangeSqlTexts(ranges: Array<{ sql: string }>): string[] {
  return ranges.map((range) => range.sql.trim());
}

function candidateKinds(candidates: Array<{ kind: string }>): string[] {
  return candidates.map((candidate) => candidate.kind);
}

function candidateLabels(candidates: Array<{ label: string }>): string[] {
  return candidates.map((candidate) => candidate.label);
}

function candidateSummaries(candidates: Array<{ kind: string; sql: string }>): string[] {
  return candidates.map((candidate) => `${candidate.kind}:${candidate.sql.trim()}`);
}

describe("splitSqlStatementRanges", () => {
  it("splits multiple top-level statements", () => {
    const sql = "SELECT 1;\nSELECT 2;\nSELECT 3;";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("keeps a trailing statement without a semicolon", () => {
    const sql = "SELECT 1;\nSELECT 2";
    const ranges = splitSqlStatementRanges(sql);
    expect(rangeSqlTexts(ranges)).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons inside single-quoted strings", () => {
    const sql = "INSERT INTO t VALUES ('a;b;c');\nSELECT 1";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["INSERT INTO t VALUES ('a;b;c')", "SELECT 1"]);
  });

  it("handles doubled single quotes as escaped quotes", () => {
    const sql = "SELECT 'it''s; ok';\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 'it''s; ok'", "SELECT 2"]);
  });

  it("ignores semicolons inside double-quoted identifiers", () => {
    const sql = 'SELECT "a;b";\nSELECT 2';
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(['SELECT "a;b"', "SELECT 2"]);
  });

  it("ignores semicolons inside backtick identifiers (MySQL)", () => {
    const sql = "SELECT `a;b`;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT `a;b`", "SELECT 2"]);
  });

  it("ignores semicolons inside bracket identifiers (SQL Server)", () => {
    const sql = "SELECT [a;b];\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT [a;b]", "SELECT 2"]);
  });

  it("ignores semicolons in line comments", () => {
    const sql = "SELECT 1 -- a; b\n;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in hash line comments", () => {
    const sql = "SELECT 1 # a; b\n;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("ignores semicolons in block comments", () => {
    const sql = "SELECT /* a; b */ 1;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT /* a; b */ 1", "SELECT 2"]);
  });

  it("handles Postgres dollar quoting", () => {
    const sql = "SELECT $$ a; b $$;\nSELECT 2";
    expect(rangeSqlTexts(splitSqlStatementRanges(sql))).toEqual(["SELECT $$ a; b $$", "SELECT 2"]);
  });
});

describe("statementRangeAtCursor", () => {
  it("returns the first statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the second statement when the cursor is inside it", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const pos = indexOf(sql, "2");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the statement when the cursor is in indentation before it", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const range = statementRangeAtCursor(sql, indentationPos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns the previous statement when the cursor is in same-line whitespace after its semicolon", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const gapPos = sql.indexOf(";") + 2;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the previous statement when the cursor is just after its semicolon before a later statement", () => {
    const sql = "SELECT *\nFROM system_dept;\n\nSELECT *\nFROM sys;";
    const gapPos = sql.indexOf(";") + 1;
    const range = statementRangeAtCursor(sql, gapPos);
    expect(range?.sql.trim()).toBe("SELECT *\nFROM system_dept");
  });

  it("returns the next same-line statement when the cursor is inside it", () => {
    const sql = "SELECT 1;   SELECT 2;";
    const pos = indexOf(sql, "SELECT 2") + 1;
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("returns a statement even without a trailing semicolon", () => {
    const sql = "SELECT 1";
    const pos = indexOf(sql, "1");
    const range = statementRangeAtCursor(sql, pos);
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("stops at the next top-level statement start when the cursor statement has no semicolon", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("returns the later top-level statement when earlier statements are missing semicolons", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("keeps a multi-line select together when continuation lines do not start statements", () => {
    const sql = "SELECT id,\n  name\nFROM users\nWHERE active = 1\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("SELECT id,\n  name\nFROM users\nWHERE active = 1");
  });

  it("keeps a CTE main query with its WITH statement", () => {
    const sql = "WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "active_users", 2));
    expect(range?.sql.trim()).toBe("WITH active_users AS (\n  SELECT * FROM users\n)\nSELECT * FROM active_users");
  });

  it("keeps update assignments with the UPDATE statement", () => {
    const sql = "UPDATE users\nSET name = 'a'\nWHERE id = 1\nSELECT * FROM users;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "name"));
    expect(range?.sql.trim()).toBe("UPDATE users\nSET name = 'a'\nWHERE id = 1");
  });

  it("keeps insert-select with the INSERT statement", () => {
    const sql = "INSERT INTO archived_users (id, name)\nSELECT id, name FROM users\nUPDATE users SET archived = 1;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "archived_users"));
    expect(range?.sql.trim()).toBe("INSERT INTO archived_users (id, name)\nSELECT id, name FROM users");
  });

  it("keeps explain target SQL with the EXPLAIN statement", () => {
    const sql = "EXPLAIN\nSELECT * FROM users\nSELECT * FROM logs;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "EXPLAIN"));
    expect(range?.sql.trim()).toBe("EXPLAIN\nSELECT * FROM users");
  });

  it("does not include comments between soft statement blocks", () => {
    const sql = "SELECT 1\n-- explain the next query\n/* still next query notes */\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.sql.trim()).toBe("SELECT 1");
  });

  it("detects a soft statement start after a leading block comment on the same line", () => {
    const sql = "SELECT 1\n/* next */ SELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "2"));
    expect(range?.sql.trim()).toBe("SELECT 2");
  });

  it("uses database-specific soft statement keywords", () => {
    const sql = "SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$;";
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"))?.sql.trim()).toBe("SELECT 1\nDO $$ BEGIN RAISE NOTICE 'x'; END $$");
    expect(statementRangeAtCursor(sql, indexOf(sql, "1"), "postgres")?.sql.trim()).toBe("SELECT 1");
    expect(statementRangeAtCursor(sql, indexOf(sql, "DO"), "postgres")?.sql.trim()).toBe("DO $$ BEGIN RAISE NOTICE 'x'; END $$");
  });

  it("returns null when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const blankLinePos = sql.indexOf("\n") + 1;
    expect(statementRangeAtCursor(sql, blankLinePos)).toBeNull();
  });

  it("returns null for an empty document", () => {
    expect(statementRangeAtCursor("", 0)).toBeNull();
  });

  it("does not treat comment semicolons as delimiters", () => {
    const sql = "SELECT 1; -- drop; this\nSELECT 2;";
    const pos = indexOf(sql, "2");
    expect(statementRangeAtCursor(sql, pos)?.sql.trim()).toBe("SELECT 2");
  });

  it("exposes offsets aligned to the statement body", () => {
    const sql = "  SELECT 1;\nSELECT 2;";
    const range = statementRangeAtCursor(sql, indexOf(sql, "1"));
    expect(range?.from).toBe(2);
    expect(range?.sql).toBe("SELECT 1");
  });
});

describe("fullSqlRange", () => {
  it("returns the trimmed full document", () => {
    const sql = "  SELECT 1;  \n";
    const range = fullSqlRange(sql);
    expect(range?.sql).toBe("SELECT 1;");
  });

  it("returns null for an empty/whitespace document", () => {
    expect(fullSqlRange("   \n  ")).toBeNull();
  });
});

describe("buildExecutionCandidates", () => {
  it("returns a single candidate when only the cursor statement exists", () => {
    const sql = "SELECT 1";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns current + all in order for multiple statements", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "2"));
    expect(candidateKinds(candidates)).toEqual(["cursor", "all"]);
  });

  it("uses only the cursor SQL for the first candidate when it is missing a semicolon", () => {
    const sql = "SELECT 1\nSELECT 2;\nSELECT 3;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 1", "all:SELECT 1\nSELECT 2;\nSELECT 3;"]);
  });

  it("uses the current command line for Redis cursor candidates", () => {
    const sql = "GET user:1\nDEL user:2\nHGETALL user:3";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "user:2"), "redis");
    expect(candidateSummaries(candidates)).toEqual(["cursor:DEL user:2", "all:GET user:1\nDEL user:2\nHGETALL user:3"]);
    expect(candidateLabels(candidates)).toEqual(["currentCommand", "allCommands"]);
  });

  it("returns only all for Redis when the cursor is on a comment line", () => {
    const sql = "GET user:1\n# comment\nDEL user:2";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "comment"), "redis");
    expect(candidateSummaries(candidates)).toEqual(["all:GET user:1\n# comment\nDEL user:2"]);
  });

  it("returns current + all when the cursor is in indentation before a statement", () => {
    const sql = "SELECT 1;\n    SELECT 2;";
    const indentationPos = sql.indexOf("    SELECT 2") + 2;
    const candidates = buildExecutionCandidates(sql, indentationPos);
    expect(candidateSummaries(candidates)).toEqual(["cursor:SELECT 2", "all:SELECT 1;\n    SELECT 2;"]);
    expect(candidateLabels(candidates)).toEqual(["currentStatement", "allStatements"]);
  });

  it("dedupes when the cursor statement equals the full document", () => {
    const sql = "SELECT 1;";
    const candidates = buildExecutionCandidates(sql, indexOf(sql, "1"));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].kind).toBe("all");
  });

  it("returns only 'all' when the cursor is on a blank line", () => {
    const sql = "SELECT 1;\n\nSELECT 2;";
    const candidates = buildExecutionCandidates(sql, sql.indexOf("\n") + 1);
    expect(candidateKinds(candidates)).toEqual(["all"]);
  });

  it("returns no candidates for an empty document", () => {
    expect(buildExecutionCandidates("", 0)).toEqual([]);
  });

  it("returns only 'all' when the cursor has no statement but the document has SQL", () => {
    // Cursor past the end on a trailing blank line.
    const sql = "SELECT 1;\nSELECT 2;\n";
    const candidates = buildExecutionCandidates(sql, sql.length);
    expect(candidateKinds(candidates)).toEqual(["all"]);
  });
});

describe("hasMultipleExecutionTargets", () => {
  it("returns false for a single SQL statement", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;")).toBe(false);
  });

  it("returns true for multiple SQL statements", () => {
    expect(hasMultipleExecutionTargets("SELECT 1;\nSELECT 2;")).toBe(true);
  });

  it("ignores comments when counting SQL statements", () => {
    expect(hasMultipleExecutionTargets("-- check one thing\nSELECT 1;")).toBe(false);
  });

  it("counts executable Redis command lines", () => {
    expect(hasMultipleExecutionTargets("GET user:1", "redis")).toBe(false);
    expect(hasMultipleExecutionTargets("GET user:1\n# comment\nDEL user:2", "redis")).toBe(true);
  });
});

describe("supportsExecutionTargetPicker", () => {
  it("enables the picker for SQL database connections and Redis", () => {
    expect(supportsExecutionTargetPicker("mysql")).toBe(true);
    expect(supportsExecutionTargetPicker("postgres")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlserver")).toBe(true);
    expect(supportsExecutionTargetPicker("sqlite")).toBe(true);
    expect(supportsExecutionTargetPicker("jdbc")).toBe(true);
    expect(supportsExecutionTargetPicker("redis")).toBe(true);
    expect(supportsExecutionTargetPicker("mongodb")).toBe(false);
    expect(supportsExecutionTargetPicker("elasticsearch")).toBe(false);
    expect(supportsExecutionTargetPicker("qdrant")).toBe(false);
    expect(supportsExecutionTargetPicker("milvus")).toBe(false);
    expect(supportsExecutionTargetPicker("weaviate")).toBe(false);
    expect(supportsExecutionTargetPicker("etcd")).toBe(false);
    expect(supportsExecutionTargetPicker("zookeeper")).toBe(false);
    expect(supportsExecutionTargetPicker("mq")).toBe(false);
    expect(supportsExecutionTargetPicker("neo4j")).toBe(false);
    expect(supportsExecutionTargetPicker(undefined)).toBe(false);
  });
});
