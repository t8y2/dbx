import { describe, expect, it } from "vitest";
import { createFrontendPluginRegistry } from "./frontendPlugin";
import { pluginShortcutToolbarCount, pluginShortcutToolbarWidth, clampPluginShortcutHeight, pluginShortcutListHeight, collectPluginShortcuts, movePluginShortcut, normalizePluginShortcutSettings, orderPluginShortcuts } from "./pluginShortcuts";
import type { InstalledPlugin } from "@/types/database";

function plugin(id: string, contributions: unknown[], compatible = true): InstalledPlugin {
  return { compatibility: { compatible }, manifest: { id, name: id, version: "1.0.0", drivers: [], contributions } } as InstalledPlugin;
}
const workbench = { type: "workbench", id: "wb", label: "Workbench" };
const command = { type: "command", id: "open", label: "Open", action: { type: "open-workbench", workbench: "wb", presentation: "panel" } };
const placement = { location: "appToolbar", command: "open", group: "navigation", order: 0, default_visible: true };
const provider = { type: "connection-provider", id: "connection", label: "Connection", database_type: "ssh", fields: [], workbench: "wb" };

describe("plugin shortcuts", () => {
  it("reserves room for overflow and caps toolbar preferences", () => {
    expect(normalizePluginShortcutSettings({ position: "toolbar" })).toMatchObject({ position: "toolbar", toolbarCount: 3 });
    expect(normalizePluginShortcutSettings({ toolbarCount: -1 }).toolbarCount).toBe(0);
    expect(normalizePluginShortcutSettings({ toolbarCount: 50 }).toolbarCount).toBe(10);
    expect(normalizePluginShortcutSettings({ toolbarCount: NaN }).toolbarCount).toBe(3);
    expect(pluginShortcutToolbarWidth(0, 3)).toBe(0);
    expect(pluginShortcutToolbarWidth(5, 3)).toBe(124);
    expect(pluginShortcutToolbarCount(5, 3, 124)).toBe(3);
    expect(pluginShortcutToolbarCount(3, 3, 94)).toBe(3);
    expect(pluginShortcutToolbarCount(3, 3, 64)).toBe(1);
    expect(pluginShortcutToolbarCount(5, 3, 34)).toBe(0);
    expect(pluginShortcutToolbarCount(5, 0, 34)).toBe(0);
  });
  it("migrates old positions and sanitizes new visibility and height preferences", () => {
    expect(normalizePluginShortcutSettings({ position: "left" }).position).toBe("left-top");
    expect(normalizePluginShortcutSettings({ position: "right" }).position).toBe("right-top");
    for (const position of ["left-top", "left-bottom", "right-top", "right-bottom", "sidebar-bottom", "toolbar", "plugin-center"]) expect(normalizePluginShortcutSettings({ position }).position).toBe(position);
    expect(normalizePluginShortcutSettings({ hiddenPluginIds: ["a", "a", null, "", "b"], sidebarHeight: NaN })).toMatchObject({ hiddenPluginIds: ["a", "b"], sidebarHeight: null });
    expect(normalizePluginShortcutSettings({ sidebarHeight: -1 }).sidebarHeight).toBeNull();
    expect(normalizePluginShortcutSettings({ sidebarHeight: 156 }).sidebarHeight).toBe(156);
  });
  it("fits one entry per row with a five-row automatic limit", () => {
    expect(pluginShortcutListHeight(0)).toBe(0);
    expect(pluginShortcutListHeight(1)).toBe(36);
    expect(pluginShortcutListHeight(3)).toBe(92);
    expect(pluginShortcutListHeight(5)).toBe(148);
    expect(pluginShortcutListHeight(10)).toBe(148);
    expect(pluginShortcutListHeight(3, 32)).toBe(104);
    expect(clampPluginShortcutHeight(500, 400)).toBe(280);
    expect(clampPluginShortcutHeight(1, 400)).toBe(40);
    expect(clampPluginShortcutHeight(40, 130)).toBe(10);
  });
  it("normalizes old and malformed preferences with independent default arrays", () => {
    expect(normalizePluginShortcutSettings(null)).toEqual({ enabled: true, position: "right-top", order: [], hiddenPluginIds: [], sidebarHeight: null, toolbarCount: 3 });
    expect(normalizePluginShortcutSettings({ enabled: "false", position: "top", order: [null, "a", "", "a", "b"] })).toEqual({ enabled: true, position: "right-top", order: ["a", "b"], hiddenPluginIds: [], sidebarHeight: null, toolbarCount: 3 });
    expect(normalizePluginShortcutSettings({ enabled: false, position: "sidebar-bottom" }).enabled).toBe(false);
  });
  it("includes legacy standalone workbenches and filesystems but not connection-bound surfaces", () => {
    const entries = collectPluginShortcuts(createFrontendPluginRegistry([plugin("legacy", [workbench, { type: "filesystem-provider", id: "files", label: "Files", schemes: ["file"], root_uri: "file:///" }]), plugin("ssh", [provider, workbench]), plugin("bad", [workbench], false)]));
    expect(entries.map((entry) => entry.kind)).toEqual(["workbench", "filesystem"]);
    expect(entries[1].rootUri).toBe("file:///");
  });
  it("keeps SSH global commands, deduplicates placements and never invents a connection workbench", () => {
    const entries = collectPluginShortcuts(createFrontendPluginRegistry([plugin("ssh", [provider, workbench, command, { type: "menus", id: "menus", items: [placement, placement] }])]));
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("command");
  });
  it("uses commands for standalone workbenches and honors explicit toolbar visibility", () => {
    const registry = createFrontendPluginRegistry([
      plugin("fallback", [workbench, command]),
      plugin("hidden", [workbench, command, { type: "menus", id: "menus", items: [{ ...placement, default_visible: false }] }]),
      plugin("conditional", [workbench, command, { type: "menus", id: "menus", items: [{ ...placement, when: { all: [{ key: "connection.state", equals: "connected" }] } }] }]),
      plugin("missing", [command, { type: "menus", id: "menus", items: [placement] }]),
    ]);
    expect(collectPluginShortcuts(registry).map((entry) => entry.pluginId)).toEqual(["fallback"]);
  });
  it("keeps disabled commands disabled and excludes incompatible declared commands", () => {
    const entries = collectPluginShortcuts(createFrontendPluginRegistry([plugin("disabled", [workbench, { ...command, enablement: { all: [{ key: "connection.state", equals: "connected" }] } }]), plugin("bad", [workbench, command, { type: "menus", id: "menus", items: [placement] }], false)]));
    expect(entries).toHaveLength(1);
    expect(entries[0].disabled).toBe(true);
  });
  it("uses collision-safe IDs independent of labels and preserves unavailable positions on reorder", () => {
    const entries = collectPluginShortcuts(createFrontendPluginRegistry([plugin("a", [workbench]), plugin("b", [workbench]), plugin("c", [workbench])]));
    const [a, b, c] = entries.map((entry) => entry.id);
    const saved = movePluginShortcut([a, "uninstalled", b], [a, b, c], c, a, false);
    expect(saved).toEqual([c, "uninstalled", a, b]);
    expect(orderPluginShortcuts(entries, saved).map((entry) => entry.id)).toEqual([c, a, b]);
    expect(movePluginShortcut(saved, [c, a, b], a, a, true)).toBe(saved);
    expect(movePluginShortcut(saved, [c, a, b], "external", a, true)).toBe(saved);
    const renamed = collectPluginShortcuts(createFrontendPluginRegistry([plugin("a", [{ ...workbench, label: "工作台" }])]));
    expect(renamed[0].id).toBe(a);
  });
});
