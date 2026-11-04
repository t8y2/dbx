import { describe, expect, it } from "vitest";
import { sidebarNavigationSettings } from "../../sidebar/sidebarNavigationPreferences";

describe("global navigation preferences", () => {
  it("uses the same display preferences for every connection and ignores old candidate overrides", () => {
    const global = { sidebarObjectDisplay: "simple" as const, sidebarObjectInfoMode: "hidden" as const, sidebarHiddenTablePrefixes: ["APP_"], sidebarNavigationOverrides: { a: { sidebarObjectDisplay: "grouped", sidebarHiddenTablePrefixes: [] } } };
    const expected = { sidebarObjectDisplay: "simple", sidebarObjectInfoMode: "hidden", sidebarHiddenTablePrefixes: ["APP_"] };
    expect(sidebarNavigationSettings(global, "a")).toEqual(expected);
    expect(sidebarNavigationSettings(global, "b")).toEqual(expected);
  });
});
