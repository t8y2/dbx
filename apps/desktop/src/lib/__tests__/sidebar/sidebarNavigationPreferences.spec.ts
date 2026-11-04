import { describe, expect, it } from "vitest";
import { sidebarNavigationSettings } from "../../sidebar/sidebarNavigationPreferences";
import * as menuMessages from "@/i18n/locales/sidebarMenuMessages";

describe("global navigation preferences", () => {
  it("defines both scope tabs and independent reset labels in every supported menu language", () => {
    expect(Object.keys(menuMessages)).toHaveLength(14);
    for (const messages of Object.values(menuMessages)) {
      const labels = messages.navigation;
      for (const key of ["globalSettings", "currentConnection", "globalScope", "connectionScope", "resetVisibility", "saveFailed"] as const) expect(labels[key].trim()).not.toBe("");
      expect(labels.connectionScope).toContain("{name}");
      expect(labels.saveFailed).toContain("{message}");
      expect(labels.title).not.toContain("{name}");
      expect(labels.resetDisplay).not.toBe(labels.resetVisibility);
      expect(labels).not.toHaveProperty("follow");
      expect(labels).not.toHaveProperty("inherit");
    }
  });
  it("uses the same display preferences for every connection and ignores old candidate overrides", () => {
    const global = { sidebarObjectDisplay: "simple" as const, sidebarObjectInfoMode: "hidden" as const, sidebarHiddenTablePrefixes: ["APP_"], sidebarNavigationOverrides: { a: { sidebarObjectDisplay: "grouped", sidebarHiddenTablePrefixes: [] } } };
    const expected = { sidebarObjectDisplay: "simple", sidebarObjectInfoMode: "hidden", sidebarHiddenTablePrefixes: ["APP_"] };
    expect(sidebarNavigationSettings(global, "a")).toEqual(expected);
    expect(sidebarNavigationSettings(global, "b")).toEqual(expected);
  });
});
