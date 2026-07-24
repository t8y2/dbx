import { describe, expect, it } from "vitest";
import { shouldLoadTableStructureTriggers, visibleTableStructureRefreshScope } from "@/lib/table/tableStructureMetadataLoading";

describe("table structure metadata loading", () => {
  it("does not request triggers while opening the default columns tab", () => {
    expect(visibleTableStructureRefreshScope("columns").triggers).toBe(false);
  });

  it("requests triggers when the structure editor opens on the trigger tab", () => {
    expect(visibleTableStructureRefreshScope("triggers").triggers).toBe(true);
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
