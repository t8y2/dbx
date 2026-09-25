import { describe, expect, it } from "vitest";
import { hasTableStructureRefreshWork, unloadedTableStructureRefreshScope, visibleTableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";

describe("table structure metadata loading", () => {
  it.each([
    ["columns", { columns: true, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true }],
    ["indexes", { columns: true, indexes: true, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true }],
    ["foreignKeys", { columns: true, indexes: false, foreignKeys: true, constraints: false, triggers: false, partitions: false, tableComment: true }],
    ["constraints", { columns: false, indexes: false, foreignKeys: false, constraints: true, triggers: false, partitions: false, tableComment: true }],
    ["triggers", { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: true, partitions: false, tableComment: true }],
    ["partitions", { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: true, tableComment: false }],
    ["ddl", { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true }],
  ] as const)("requests only the metadata required by the %s tab", (tab, expected) => {
    expect(visibleTableStructureRefreshScope(tab)).toEqual(expected);
  });

  it("requests only index metadata after columns and comments are already loaded", () => {
    const scope = unloadedTableStructureRefreshScope("indexes", new Set(["columns", "comment"]));

    expect(scope).toEqual({ columns: false, indexes: true, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: false });
    expect(hasTableStructureRefreshWork(scope)).toBe(true);
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("indexes", new Set(["columns", "indexes", "comment"])))).toBe(false);
  });

  it("requests trigger metadata only until that facet is loaded", () => {
    expect(unloadedTableStructureRefreshScope("triggers", new Set(["comment"]))).toEqual({ columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: true, partitions: false, tableComment: false });
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("triggers", new Set(["triggers", "comment"])))).toBe(false);
  });

  it("requests constraint metadata only until that facet is loaded", () => {
    expect(unloadedTableStructureRefreshScope("constraints", new Set(["comment"]))).toEqual({ columns: false, indexes: false, foreignKeys: false, constraints: true, triggers: false, partitions: false, tableComment: false });
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("constraints", new Set(["constraints", "comment"])))).toBe(false);
  });

  it("tracks the partitions facet through the loaded set so re-activating the tab does not refetch", () => {
    expect(unloadedTableStructureRefreshScope("partitions", new Set())).toEqual({ columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: true, tableComment: false });
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("partitions", new Set()))).toBe(true);
    expect(hasTableStructureRefreshWork(unloadedTableStructureRefreshScope("partitions", new Set(["partitions"])))).toBe(false);
  });
});
