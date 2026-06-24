import { describe, it, expect } from "vitest";
import { buildSnippetItemsForTest } from "@/lib/sqlCompletion";
import type { SqlSnippet } from "@/types/database";

const TEST_SNIPPETS: SqlSnippet[] = [
  { id: "1", label: "select all", prefix: "sel", body: "SELECT *\nFROM my_table;" },
  { id: "2", label: "insert row", prefix: "ins", body: "INSERT INTO my_table VALUES (1);" },
];

const BUILTIN_SELECT: SqlSnippet = { id: "builtin-sel", label: "select *", prefix: "sel", body: "SELECT *\nFROM table\nLIMIT 100;" };
const BUILTIN_CREATE_TABLE: SqlSnippet = { id: "builtin-ct", label: "create table", prefix: "ct", body: "CREATE TABLE table (\n  column type\n);" };
const BUILTIN_UPDATE: SqlSnippet = { id: "builtin-upd", label: "update set", prefix: "upd", body: "UPDATE table\nSET column = value\nWHERE condition;" };
const BUILTIN_CTE: SqlSnippet = { id: "builtin-cte", label: "common table expression", prefix: "cte", body: "WITH name AS (\n  SELECT columns\n  FROM table\n)\nSELECT *\nFROM name;" };
const BUILTIN_INSERT: SqlSnippet = { id: "builtin-ins", label: "insert into", prefix: "ins", body: "INSERT INTO table (columns)\nVALUES (values);" };
const BUILTIN_JOIN: SqlSnippet = { id: "builtin-join", label: "join", prefix: "join", body: "JOIN table ON left_column = right_column" };
const BUILTIN_CASE: SqlSnippet = { id: "builtin-case", label: "case when", prefix: "case", body: "CASE\n  WHEN condition THEN value\n  ELSE default\nEND" };
const BUILTIN_CREATE_INDEX: SqlSnippet = { id: "builtin-ci", label: "create index", prefix: "ci", body: "CREATE INDEX idx_name\nON table (column);" };

describe("buildSnippetItems", () => {
  it("returns matching snippet by prefix", () => {
    const items = buildSnippetItemsForTest("sel", TEST_SNIPPETS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
    expect(items[0].detail).toBe("SELECT *\nFROM my_table;");
    expect(items[0].apply).toBe("SELECT *\nFROM my_table;");
  });

  it("uses CodeMirror placeholders for the built-in select snippet", () => {
    const items = buildSnippetItemsForTest("sel", [BUILTIN_SELECT]);

    expect(items[0].detail).toBe("SELECT *\nFROM table\nLIMIT 100;");
    expect(items[0].apply).toBe("SELECT *\nFROM ${table}\nLIMIT 100;");
  });

  it("replaces placeholder words but preserves uppercase SQL keywords", () => {
    const items = buildSnippetItemsForTest("ct", [BUILTIN_CREATE_TABLE]);

    expect(items[0].apply).toBe("CREATE TABLE ${table} (\n  ${column} ${type}\n);");
  });

  it("adds placeholders across built-in update snippets", () => {
    const items = buildSnippetItemsForTest("upd", [BUILTIN_UPDATE]);

    expect(items[0].apply).toBe("UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};");
  });

  it("keeps keyword casing separate from editable placeholders", () => {
    const items = buildSnippetItemsForTest("sel", [BUILTIN_SELECT], "lower");

    expect(items[0].detail).toBe("select *\nfrom table\nlimit 100;");
    expect(items[0].apply).toBe("select *\nfrom ${table}\nlimit 100;");
  });

  it("determines placeholders from original casing even when keywords are lowercased", () => {
    const items = buildSnippetItemsForTest("ct", [BUILTIN_CREATE_TABLE], "lower");

    expect(items[0].detail).toBe("create table table (\n  column type\n);");
    expect(items[0].apply).toBe("create table ${table} (\n  ${column} ${type}\n);");
  });

  it("wraps repeated placeholder words in CTE snippets", () => {
    const items = buildSnippetItemsForTest("cte", [BUILTIN_CTE]);

    expect(items[0].apply).toBe("WITH ${name} AS (\n  SELECT ${columns}\n  FROM ${table}\n)\nSELECT *\nFROM ${name};");
  });

  it.each([
    [BUILTIN_INSERT, "INSERT INTO ${table} (${columns})\nVALUES (${values});"],
    [BUILTIN_JOIN, "JOIN ${table} ON ${left_column} = ${right_column}"],
    [BUILTIN_CASE, "CASE\n  WHEN ${condition} THEN ${value}\n  ELSE ${default}\nEND"],
    [BUILTIN_CREATE_INDEX, "CREATE INDEX ${idx_name}\nON ${table} (${column});"],
  ])("adds placeholders for built-in %s snippet", (snippet, expectedApply) => {
    const items = buildSnippetItemsForTest(snippet.prefix, [snippet]);

    expect(items[0].apply).toBe(expectedApply);
  });

  it("returns matching snippet by label substring", () => {
    const items = buildSnippetItemsForTest("select", TEST_SNIPPETS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
  });

  it("does not keep matching a renamed snippet by its old short label prefix", () => {
    const items = buildSnippetItemsForTest("sel", [{ id: "1", label: "select all", prefix: "fff", body: "SELECT *\nFROM my_table;" }]);
    expect(items).toEqual([]);
  });

  it("still matches a renamed snippet by label when typing a longer descriptive query", () => {
    const items = buildSnippetItemsForTest("select", [{ id: "1", label: "select all", prefix: "fff", body: "SELECT *\nFROM my_table;" }]);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
  });

  it("returns empty for no match", () => {
    const items = buildSnippetItemsForTest("zzz", TEST_SNIPPETS);
    expect(items).toEqual([]);
  });

  it("returns empty for empty prefix", () => {
    const items = buildSnippetItemsForTest("", TEST_SNIPPETS);
    expect(items).toEqual([]);
  });
});
