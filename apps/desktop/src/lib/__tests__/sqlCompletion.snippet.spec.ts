import { describe, it, expect } from "vitest";
import { buildSnippetItemsForTest } from "@/lib/sqlCompletion";
import type { SqlSnippet } from "@/types/database";

const TEST_SNIPPETS: SqlSnippet[] = [
  { id: "1", label: "select all", prefix: "sel", body: "SELECT *\nFROM my_table;" },
  { id: "2", label: "insert row", prefix: "ins", body: "INSERT INTO my_table VALUES (1);" },
];

describe("buildSnippetItems", () => {
  it("returns matching snippet by prefix", () => {
    const items = buildSnippetItemsForTest("sel", TEST_SNIPPETS);
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("select all");
    expect(items[0].apply).toBe("SELECT *\nFROM my_table;");
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
