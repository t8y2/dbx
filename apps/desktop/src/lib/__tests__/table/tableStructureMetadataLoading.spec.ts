import { describe, expect, it } from "vitest";
import { hasTableStructureRefreshWork, unloadedTableStructureRefreshScope, visibleTableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";

describe("table structure metadata loading", () => {
  it.each([
    ["columns", { columns: true, indexes: false, foreignKeys: false, constraints: false, triggers: false, tableComment: true }],
    ["indexes", { columns: true, indexes: true, foreignKeys: false, constraints: false, triggers: false, tableComment: true }],
    ["foreignKeys", { columns: true, indexes: false, foreignKeys: true, constraints: false, triggers: false, tableComment: true }],
    ["constraints", { columns: false, indexes: false, foreignKeys: false, constraints: true, triggers: false, tableComment: true }],
    ["triggers", { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: true, tableComment: true }],
    ["ddl", { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, tableComment: false }],
  ] as const)("requests only the metadata required by the %s tab", (tab, expected) => {
    expect(visibleTableStructureRefreshScope(tab)).toEqual(expected);
  });

  it("requests only index metadata after columns and comments are already loaded", () => {
    const scope = unloadedTableStructureRefreshScope("indexes", new Set(["columns", "comment"]));

    expect(scope).toEqual({ columns: false, indexes: true, foreignKeys: false, constraints: false, triggers: false, tableComment: false });
    expect(hasTableStructureRefreshWork(scope)).toBe(true);
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("indexes", new Set(["columns", "indexes", "comment"])))).toBe(false);
  });

  it("requests trigger metadata only until that facet is loaded", () => {
    expect(unloadedTableStructureRefreshScope("triggers", new Set(["comment"]))).toEqual({ columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: true, tableComment: false });
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("triggers", new Set(["triggers", "comment"])))).toBe(false);
  });

  it("requests constraint metadata only until that facet is loaded", () => {
    expect(unloadedTableStructureRefreshScope("constraints", new Set(["comment"]))).toEqual({ columns: false, indexes: false, foreignKeys: false, constraints: true, triggers: false, tableComment: false });
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("constraints", new Set(["constraints", "comment"])))).toBe(false);
  });
});
