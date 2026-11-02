// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as dockModule from "@/lib/plugins/pluginBottomDock";

async function loadModule(): Promise<typeof dockModule> {
  vi.resetModules();
  return await import("@/lib/plugins/pluginBottomDock");
}

describe("pluginBottomDock", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("suffixes only on a title collision, taking the lowest free number; distinct titles stay verbatim", async () => {
    const dock = await loadModule();
    // Distinct titles (e.g. named connections) never get a number.
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "connection", commandId: "open-connection", title: "Prod" });
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "connection", commandId: "open-connection", title: "Staging" });
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    const second = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["Prod", "Staging", "Local terminal", "Local terminal 2", "Local terminal 3"]);

    // Close the middle entry, then open another: "Local terminal 2" is the
    // lowest free slot again (numbers belong to no entry once closed); the
    // reopened entry appends at the strip's end.
    dock.closePluginDockEntry(second);
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["Prod", "Staging", "Local terminal", "Local terminal 3", "Local terminal 2"]);

    // Different commands number independently.
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "other.command", title: "Other" });
    const titles = dock.usePluginBottomDock().entries.value.map((entry) => entry.title);
    expect(titles[titles.length - 1]).toBe("Other");
    dock.closePluginDockEntry(first);
  });

  it("finds singleton reuse candidates only inside the same plugin+command+instance-key group (§4.1)", async () => {
    const dock = await loadModule();
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "open-local-terminal", title: "Local terminal", instanceKey: "local-terminal" });
    expect(dock.findReusableDockEntry("io.dbx.ssh", "open-local-terminal", "local-terminal")?.id).toBe(first);
    // a different instance_key is a different singleton group.
    expect(dock.findReusableDockEntry("io.dbx.ssh", "open-local-terminal", "other")).toBeUndefined();
    // an undefined instance_key only matches entries created without one.
    expect(dock.findReusableDockEntry("io.dbx.ssh", "open-local-terminal")).toBeUndefined();
    // connection-target entries (dock "+" menu) are never command reuse candidates.
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "connection", commandId: "open-local-terminal", title: "Prod" });
    expect(dock.findReusableDockEntry("io.dbx.ssh", "open-local-terminal", "local-terminal")?.id).toBe(first);
  });

  it("restores the persisted dock height clamped to the current viewport (chrome only, §8.4)", async () => {
    const dock = await loadModule();
    localStorage.setItem("dbx-plugin-dock-height", "560");
    expect(dock.restoreDockHeight(1000)).toBe(560);
    // an oversized stored height clamps to the shared drag/maximize bound.
    localStorage.setItem("dbx-plugin-dock-height", "5000");
    expect(dock.restoreDockHeight(1000)).toBe(800);
    // a tiny viewport still honors the minimum height.
    localStorage.setItem("dbx-plugin-dock-height", "560");
    expect(dock.restoreDockHeight(100)).toBe(140);
    // nothing persisted, or garbage, falls back to the default height.
    localStorage.removeItem("dbx-plugin-dock-height");
    expect(dock.restoreDockHeight(1000)).toBe(320);
    localStorage.setItem("dbx-plugin-dock-height", "not-a-number");
    expect(dock.restoreDockHeight(1000)).toBe(320);
    localStorage.removeItem("dbx-plugin-dock-height");
  });

  it("keeps entries alive across hide/show and only clears the dock with its last entry", async () => {
    const dock = await loadModule();
    const state = dock.usePluginBottomDock();
    dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(state.visible.value).toBe(true);

    dock.setDockVisible(false);
    expect(state.visible.value).toBe(false);
    expect(state.entries.value).toHaveLength(1);

    dock.setDockVisible(true);
    expect(state.visible.value).toBe(true);
    expect(state.entries.value).toHaveLength(1);

    dock.closePluginDockEntry(state.entries.value[0]!.id);
    expect(state.entries.value).toHaveLength(0);
    expect(state.visible.value).toBe(false);
    expect(state.activeEntryId.value).toBeNull();
  });

  it("activates a neighboring entry after closing the active one", async () => {
    const dock = await loadModule();
    const state = dock.usePluginBottomDock();
    const first = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    const second = dock.addPluginDockEntry({ pluginId: "io.dbx.ssh", workbenchContributionId: "local", kind: "command", commandId: "local.terminal", title: "Local terminal" });
    expect(state.activeEntryId.value).toBe(second);

    dock.closePluginDockEntry(second);
    expect(state.activeEntryId.value).toBe(first);

    dock.closePluginDockEntry(first);
    expect(state.activeEntryId.value).toBeNull();
  });
});

describe("dock tab order and titles", () => {
  it("moves entries by drag target index, clamped", async () => {
    const dock = await loadModule();
    const ids = ["a", "b", "c"].map((title, index) => dock.addPluginDockEntry({ pluginId: "p", workbenchContributionId: "w", kind: "command", commandId: `cmd-${index}`, title }));
    dock.movePluginDockEntry(ids[0]!, 2);
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["b", "c", "a"]);
    dock.movePluginDockEntry(ids[0]!, 99);
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["b", "c", "a"]);
    dock.movePluginDockEntry(ids[0]!, -5);
    expect(dock.usePluginBottomDock().entries.value.map((entry) => entry.title)).toEqual(["a", "b", "c"]);
    dock.movePluginDockEntry("missing", 0);
  });

  it("renames a tab and ignores blank titles", async () => {
    const dock = await loadModule();
    const id = dock.addPluginDockEntry({ pluginId: "p", workbenchContributionId: "w", kind: "command", commandId: "cmd", title: "Local terminal" });
    dock.renamePluginDockEntry(id, "  build shell  ");
    expect(dock.usePluginBottomDock().entries.value[0]!.title).toBe("build shell");
    dock.renamePluginDockEntry(id, "   ");
    expect(dock.usePluginBottomDock().entries.value[0]!.title).toBe("build shell");
    dock.renamePluginDockEntry("missing", "x");
  });
});
