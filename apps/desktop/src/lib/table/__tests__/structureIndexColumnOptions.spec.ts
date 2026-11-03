import { describe, expect, it } from "vitest";
import { canIndexTypeHaveSpecialIssue, sortStructureIndexColumnOptions } from "../tableStructureEditorState";

describe("sortStructureIndexColumnOptions", () => {
  const options = [{ name: "order_total" }, { name: "ID" }, { name: "amount2" }, { name: "amount10" }, { name: "customer" }];

  it("sorts unpicked columns alphabetically, case-insensitive and numeric-aware", () => {
    expect(sortStructureIndexColumnOptions(options, new Map()).map((option) => option.name)).toEqual(["amount2", "amount10", "customer", "ID", "order_total"]);
  });

  it("keeps picked columns first in their index order before the alphabetical tail", () => {
    const picked = new Map([
      ["customer", 2],
      ["ID", 1],
    ]);
    expect(sortStructureIndexColumnOptions(options, picked).map((option) => option.name)).toEqual(["ID", "customer", "amount2", "amount10", "order_total"]);
  });

  it("keeps the option payloads intact", () => {
    const picked = new Map([["ID", 1]]);
    const [first] = sortStructureIndexColumnOptions(options, picked);
    expect(first).toEqual({ name: "ID" });
  });

  it("returns a copy intact for empty or single element lists", () => {
    expect(sortStructureIndexColumnOptions([], new Map())).toEqual([]);
    const single = [{ name: "col_a" }];
    expect(sortStructureIndexColumnOptions(single, new Map([["col_a", 1]]))).toEqual([{ name: "col_a" }]);
  });
});

describe("canIndexTypeHaveSpecialIssue", () => {
  it("returns true only for MySQL FULLTEXT/SPATIAL and SQL Server SPATIAL", () => {
    expect(canIndexTypeHaveSpecialIssue("mysql", "FULLTEXT")).toBe(true);
    expect(canIndexTypeHaveSpecialIssue("mysql", "SPATIAL")).toBe(true);
    expect(canIndexTypeHaveSpecialIssue("mysql", "BTREE")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("mysql", "HASH")).toBe(false);

    expect(canIndexTypeHaveSpecialIssue("sqlserver", "SPATIAL")).toBe(true);
    expect(canIndexTypeHaveSpecialIssue("sqlserver", "CLUSTERED")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("sqlserver", "NONCLUSTERED")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("sqlserver", "COLUMNSTORE")).toBe(false);

    expect(canIndexTypeHaveSpecialIssue("postgres", "BTREE")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("postgres", "GIN")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("postgres", "GIST")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("oracle", "NORMAL")).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("sqlite", "BTREE")).toBe(false);

    expect(canIndexTypeHaveSpecialIssue("sqlserver", null)).toBe(false);
    expect(canIndexTypeHaveSpecialIssue("sqlserver", "")).toBe(false);
  });
});
