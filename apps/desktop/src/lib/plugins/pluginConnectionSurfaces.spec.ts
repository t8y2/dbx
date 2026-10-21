import { describe, expect, it } from "vitest";
import { anySurfaceReferencesPluginConnection, dockEntryReferencesPluginConnection, pluginWorkbenchTitlesForConnection, tabReferencesPluginConnection, type PluginConnectionSurfaceDockEntry, type PluginConnectionSurfaceTab } from "./pluginConnectionSurfaces";

const workbenchTab = (overrides: Partial<PluginConnectionSurfaceTab> = {}): PluginConnectionSurfaceTab => ({
  mode: "plugin-workbench",
  title: "tab",
  ...overrides,
});

const dockEntry = (overrides: Partial<PluginConnectionSurfaceDockEntry> = {}): PluginConnectionSurfaceDockEntry => ({
  title: "dock",
  context: { connectionId: "conn-1" },
  ...overrides,
});

describe("tabReferencesPluginConnection", () => {
  it("prefers the top-level connectionId", () => {
    expect(tabReferencesPluginConnection(workbenchTab({ connectionId: "conn-1" }), "conn-1")).toBe(true);
    expect(tabReferencesPluginConnection(workbenchTab({ connectionId: "conn-1" }), "conn-2")).toBe(false);
  });

  it("falls back to the workbench context connectionId", () => {
    const tab = workbenchTab({ pluginWorkbench: { context: { connectionId: "conn-1" } } });
    expect(tabReferencesPluginConnection(tab, "conn-1")).toBe(true);
    expect(tabReferencesPluginConnection(workbenchTab({ pluginWorkbench: { context: {} } }), "conn-1")).toBe(false);
    expect(tabReferencesPluginConnection(workbenchTab({ pluginWorkbench: { context: { connectionId: 42 } } }), "conn-1")).toBe(false);
  });
});

describe("dockEntryReferencesPluginConnection", () => {
  it("matches string context connectionId and rejects other shapes", () => {
    expect(dockEntryReferencesPluginConnection(dockEntry(), "conn-1")).toBe(true);
    expect(dockEntryReferencesPluginConnection(dockEntry({ context: {} }), "conn-1")).toBe(false);
    expect(dockEntryReferencesPluginConnection(dockEntry({ context: { connectionId: null } }), "conn-1")).toBe(false);
    // Local-shell dock entries carry no connectionId at all.
    expect(dockEntryReferencesPluginConnection(dockEntry({ context: { workbenchId: "w1" } }), "conn-1")).toBe(false);
  });
});

describe("anySurfaceReferencesPluginConnection (#193a regression lock)", () => {
  it("keeps the connection alive while a dock terminal still references it", () => {
    // The exact #193 shape: last tab closed, dock entry survives.
    expect(anySurfaceReferencesPluginConnection([], [dockEntry()], "conn-1")).toBe(true);
  });

  it("counts plugin tabs on either surface mode", () => {
    const tabs = [workbenchTab({ connectionId: "conn-1" }), workbenchTab({ mode: "plugin-filesystem", connectionId: "conn-1" })];
    expect(anySurfaceReferencesPluginConnection(tabs, [], "conn-1")).toBe(true);
  });

  it("ignores non-plugin tabs and unreferenced surfaces", () => {
    const tabs = [workbenchTab({ mode: "database", connectionId: "conn-1" })];
    expect(anySurfaceReferencesPluginConnection(tabs, [dockEntry({ context: { connectionId: "conn-2" } })], "conn-1")).toBe(false);
  });
});

describe("pluginWorkbenchTitlesForConnection (#193b)", () => {
  it("puts dock entry titles first, then tabs, deduplicated in order", () => {
    const tabs = [workbenchTab({ title: "prod", connectionId: "conn-1" }), workbenchTab({ title: "other", connectionId: "conn-2" })];
    const entries = [dockEntry({ title: "prod-db" }), dockEntry({ title: "prod" })];
    expect(pluginWorkbenchTitlesForConnection(tabs, entries, "conn-1")).toEqual(["prod-db", "prod"]);
  });

  it("skips titles of surfaces bound to other connections and empty titles", () => {
    const tabs = [workbenchTab({ title: "", connectionId: "conn-1" })];
    const entries = [dockEntry({ title: "elsewhere", context: { connectionId: "conn-2" } })];
    expect(pluginWorkbenchTitlesForConnection(tabs, entries, "conn-1")).toEqual([]);
  });
});
