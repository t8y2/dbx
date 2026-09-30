import { describe, expect, it } from "vitest";

import { parseInsertStatementPaste } from "@/lib/dataGrid/dataGridInsertPaste";

describe("parseInsertStatementPaste", () => {
  it("returns null for non-INSERT text", () => {
    expect(parseInsertStatementPaste("name\tage\nalice\t30")).toBeNull();
    expect(parseInsertStatementPaste("SELECT * FROM users")).toBeNull();
    expect(parseInsertStatementPaste("")).toBeNull();
  });

  it("parses a single statement with an explicit column list", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO users (name, age, bio) VALUES ('Alice', 30, NULL)");
    expect(parsed).not.toBeNull();
    expect(parsed?.columnNames).toEqual(["name", "age", "bio"]);
    expect(parsed?.rows).toEqual([["Alice", "30", null]]);
  });

  it("parses a statement without a column list", () => {
    const parsed = parseInsertStatementPaste("insert into users values (1, 'bob', NULL)");
    expect(parsed?.columnNames).toBeNull();
    expect(parsed?.rows).toEqual([["1", "bob", null]]);
  });

  it("parses multi-row VALUES tuples", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y'), (3, 'z')");
    expect(parsed?.rows).toEqual([
      ["1", "x"],
      ["2", "y"],
      ["3", "z"],
    ]);
  });

  it("unescapes doubled single quotes inside string literals", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a) VALUES ('it''s ok')");
    expect(parsed?.rows).toEqual([["it's ok"]]);
  });

  it("unescapes MySQL backslash escapes inside string literals", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b, c, d) VALUES ('It\\'s', 'line1\\nline2', 'back\\\\slash', 'tab\\there')");
    expect(parsed?.rows).toEqual([["It's", "line1\nline2", "back\\slash", "tab\there"]]);
  });

  it("keeps an escaped quote from merging two values", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b) VALUES ('It\\'s', 'ok')");
    expect(parsed?.rows).toEqual([["It's", "ok"]]);
  });

  it("reads double-quoted strings as string values", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a) VALUES (\"plain 'text'\")");
    expect(parsed?.rows).toEqual([["plain 'text'"]]);
  });

  it("strips typed-literal keywords and national prefixes from quoted values", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b, c) VALUES (TIMESTAMP '2024-01-01 10:00:00', DATE '2024-01-01', N'nebula')");
    expect(parsed?.rows).toEqual([["2024-01-01 10:00:00", "2024-01-01", "nebula"]]);
  });

  it("supports multiple statements separated by semicolons", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a) VALUES (1); INSERT INTO t (a) VALUES (2);");
    expect(parsed?.rows).toEqual([["1"], ["2"]]);
    expect(parsed?.columnNames).toEqual(["a"]);
  });

  it("drops column alignment when statements disagree on column lists", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a) VALUES (1); INSERT INTO t (b) VALUES (2);");
    expect(parsed?.rows).toEqual([["1"], ["2"]]);
    expect(parsed?.columnNames).toBeNull();
  });

  it("keeps embedded commas, parens, and newlines inside string literals", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b) VALUES ('hello, world', 'line1\nline2 (x)')");
    expect(parsed?.rows).toEqual([["hello, world", "line1\nline2 (x)"]]);
  });

  it("keeps function calls and numeric tokens verbatim for cell coercion", () => {
    const parsed = parseInsertStatementPaste("INSERT INTO t (a, b, c) VALUES (NOW(), -12.5, 0xFF)");
    expect(parsed?.rows).toEqual([["NOW()", "-12.5", "0xFF"]]);
  });

  it("skips SQL comments", () => {
    const parsed = parseInsertStatementPaste("-- lead comment\nINSERT INTO t (a) /* block */ VALUES (1) -- trailing");
    expect(parsed?.rows).toEqual([["1"]]);
  });

  it("handles quoted identifiers for table and column names", () => {
    const parsed = parseInsertStatementPaste('INSERT INTO "my table" ("select", `order`) VALUES (1, 2)');
    expect(parsed?.columnNames).toEqual(["select", "order"]);
    expect(parsed?.rows).toEqual([["1", "2"]]);
  });

  it("returns null for INSERT ... SELECT", () => {
    expect(parseInsertStatementPaste("INSERT INTO t (a) SELECT a FROM other")).toBeNull();
  });

  it("returns null when VALUES tuples are missing", () => {
    expect(parseInsertStatementPaste("INSERT INTO t (a) VALUES")).toBeNull();
  });
});
