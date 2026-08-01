import { describe, expect, it } from "vitest";
import { shouldLoadTableStructureTriggers, visibleTableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";

describe("table structure metadata loading", () => {
  it.each([
    ["columns", { columns: true, indexes: false, foreignKeys: false, triggers: false, tableComment: true }],
    ["indexes", { columns: true, indexes: true, foreignKeys: false, triggers: false, tableComment: true }],
    ["foreignKeys", { columns: true, indexes: false, foreignKeys: true, triggers: false, tableComment: true }],
    ["triggers", { columns: false, indexes: false, foreignKeys: false, triggers: true, tableComment: true }],
    ["ddl", { columns: false, indexes: false, foreignKeys: false, triggers: false, tableComment: false }],
  ] as const)("requests only the metadata required by the %s tab", (tab, expected) => {
    expect(visibleTableStructureRefreshScope(tab)).toEqual(expected);
  });

  it("loads trigger metadata once when the trigger tab becomes visible", () => {
    const base = {
      activeTab: "triggers" as const,
      isCreateMode: false,
      supported: true,
      loading: false,
      structureLoading: false,
    };

    expect(shouldLoadTableStructureTriggers({ ...base, loaded: false })).toBe(true);
    expect(shouldLoadTableStructureTriggers({ ...base, loaded: true })).toBe(false);
  });

  it("waits for the initial structure load and skips create mode", () => {
    const base = {
      activeTab: "triggers" as const,
      supported: true,
      loaded: false,
      loading: false,
    };

    expect(shouldLoadTableStructureTriggers({ ...base, isCreateMode: false, structureLoading: true })).toBe(false);
    expect(shouldLoadTableStructureTriggers({ ...base, isCreateMode: true, structureLoading: false })).toBe(false);
  });
});
