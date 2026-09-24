// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFrontendPluginRegistry } from "./frontendPlugin";
import { pluginCommandPaletteItems, usePluginCommandPalette, type PluginPaletteCommandEntry } from "./pluginCommandPalette";
import type { InstalledPlugin, PluginCommandContribution, PluginMenusContribution, PluginWorkbenchContribution } from "@/types/database";

// commandPalette surface (HOST_PLUGIN_UI_SPEC §5): the registry derives palette commands by order + fully
// fully qualified command id for a stable order; quick-open entries carry provenance and execution goes through
// the host-authoritative executePluginCommand chain; plugin list changes refresh via dbx:plugins-changed.
function installedPlugin(id: string, contributions: InstalledPlugin["manifest"]["contributions"] = []): InstalledPlugin {
  return {
    compatibility: { compatible: true },
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      drivers: [],
      contributions,
    },
  };
}

function sshWorkbench(): PluginWorkbenchContribution {
  return { type: "workbench", id: "io.dbx.test.workbench", label: "Test" };
}

function testCommand(id: string, label: string, description?: string): PluginCommandContribution {
  return { type: "command", id, label, description, action: { type: "open-workbench", workbench: "io.dbx.test.workbench" } };
}

function menusContribution(items: PluginMenusContribution["items"]): PluginMenusContribution {
  return { type: "menus", id: "entrypoints", items };
}

const apiMock = vi.hoisted(() => ({
  listPlugins: vi.fn<() => Promise<InstalledPlugin[]>>(),
}));

vi.mock("@/lib/backend/api", () => apiMock);

const queryStoreMock = vi.hoisted(() => ({
  useQueryStore: vi.fn(),
}));

vi.mock("@/stores/queryStore", () => queryStoreMock);

describe("FrontendPluginRegistry.listPaletteMenuCommands", () => {
  it("collects commandPalette items ordered by order then full command id, ignoring other locations", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.alpha", [
        sshWorkbench(),
        testCommand("open-console", "Alpha console"),
        menusContribution([
          { location: "appToolbar", command: "open-console", group: "navigation", order: 1, default_visible: true },
          { location: "appSidebar", command: "open-console", group: "primary", order: 2 },
          { location: "commandPalette", command: "open-console", group: "primary", order: 200 },
        ]),
      ]),
      installedPlugin("io.dbx.beta", [sshWorkbench(), testCommand("open-probe", "Beta probe"), menusContribution([{ location: "commandPalette", command: "open-probe", group: "primary", order: 100 }])]),
    ]);

    const entries = registry.listPaletteMenuCommands();
    expect(entries.map((entry) => `${entry.plugin.manifest.id}.${entry.command.id}`)).toEqual(["io.dbx.beta.open-probe", "io.dbx.alpha.open-console"]);
    expect(entries.map((entry) => entry.order)).toEqual([100, 200]);
  });

  it("applies no default_visible gate and breaks order ties by full command id", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.test", [
        sshWorkbench(),
        testCommand("zeta", "Zeta"),
        testCommand("alpha", "Alpha"),
        menusContribution([
          // palette items have no default_visible (§5.2 hidden-by-default only constrains toolbar items).
          { location: "commandPalette", command: "zeta", group: "primary", order: 10 },
          { location: "commandPalette", command: "alpha", group: "primary", order: 10 },
        ]),
      ]),
    ]);

    expect(registry.listPaletteMenuCommands().map((entry) => entry.command.id)).toEqual(["alpha", "zeta"]);
  });

  it("skips palette items referencing missing commands", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.test", [menusContribution([{ location: "commandPalette", command: "ghost", group: "primary", order: 1 }])])]);
    expect(registry.listPaletteMenuCommands()).toHaveLength(0);
  });
});

describe("pluginCommandPaletteItems", () => {
  it("derives quick-open entries with plugin source hints and combined search text", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.test", [sshWorkbench(), testCommand("open-console", "Open console", "Do things"), menusContribution([{ location: "commandPalette", command: "open-console", group: "primary", order: 1 }])])]);
    const entries: PluginPaletteCommandEntry[] = registry.listPaletteMenuCommands();
    const items = pluginCommandPaletteItems(entries);

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item?.type).toBe("plugin_command");
    expect(item?.id).toBe("plugin-command-io.dbx.test-open-console");
    expect(item?.label).toBe("Open console");
    expect(item?.description).toBe("Do things");
    expect(item?.pluginId).toBe("io.dbx.test");
    expect(item?.commandId).toBe("open-console");
    expect(item?.pluginName).toBe("io.dbx.test");
    expect(item?.searchText).toBe("Open console Do things io.dbx.test");
  });

  it("falls back the description to the plugin name when the command has none", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.test", [sshWorkbench(), testCommand("open-console", "Open console"), menusContribution([{ location: "commandPalette", command: "open-console", group: "primary", order: 1 }])])]);
    const items = pluginCommandPaletteItems(registry.listPaletteMenuCommands());
    expect(items[0]?.description).toBe("io.dbx.test");
    expect(items[0]?.searchText).toBe("Open console io.dbx.test");
  });
});

describe("usePluginCommandPalette", () => {
  beforeEach(() => {
    apiMock.listPlugins.mockReset();
    queryStoreMock.useQueryStore.mockReset();
  });

  it("derives entries from installed plugins and executes through executePluginCommand", async () => {
    const openPluginWorkbench = vi.fn();
    queryStoreMock.useQueryStore.mockReturnValue({ openPluginWorkbench });
    apiMock.listPlugins.mockResolvedValue([installedPlugin("io.dbx.test", [sshWorkbench(), testCommand("open-console", "Open console"), menusContribution([{ location: "commandPalette", command: "open-console", group: "primary", order: 1 }])])]);

    const palette = usePluginCommandPalette();
    await palette.refresh();

    expect(apiMock.listPlugins).toHaveBeenCalled();
    expect(palette.items.value).toHaveLength(1);
    const item = palette.items.value[0];
    expect(item?.pluginId).toBe("io.dbx.test");

    const result = palette.open(item!);
    expect(result.error).toBeUndefined();
    expect(queryStoreMock.useQueryStore).toHaveBeenCalledTimes(1);
    expect(openPluginWorkbench).toHaveBeenCalledTimes(1);
    const [pluginId, workbenchId] = openPluginWorkbench.mock.calls[0];
    expect(pluginId).toBe("io.dbx.test");
    expect(workbenchId).toBe("io.dbx.test.workbench");
  });

  it("refreshes the command list when the plugin center broadcasts dbx:plugins-changed", async () => {
    apiMock.listPlugins.mockResolvedValue([]);
    const palette = usePluginCommandPalette();
    await palette.refresh();
    expect(palette.items.value).toHaveLength(0);

    apiMock.listPlugins.mockResolvedValue([installedPlugin("io.dbx.test", [sshWorkbench(), testCommand("open-console", "Open console"), menusContribution([{ location: "commandPalette", command: "open-console", group: "primary", order: 1 }])])]);
    window.dispatchEvent(new CustomEvent("dbx:plugins-changed"));
    await vi.waitFor(() => expect(palette.items.value).toHaveLength(1));
  });

  it("clears entries and keeps the registry unusable when listing plugins fails", async () => {
    apiMock.listPlugins.mockResolvedValue([installedPlugin("io.dbx.test", [sshWorkbench(), testCommand("open-console", "Open console"), menusContribution([{ location: "commandPalette", command: "open-console", group: "primary", order: 1 }])])]);
    const palette = usePluginCommandPalette();
    await palette.refresh();
    expect(palette.items.value).toHaveLength(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    apiMock.listPlugins.mockRejectedValue(new Error("backend unavailable"));
    await palette.refresh();
    expect(palette.items.value).toHaveLength(0);
    expect(palette.registry.value).toBeNull();

    const item = { type: "plugin_command", pluginId: "io.dbx.test", commandId: "open-console" } as never;
    expect(palette.open(item).error).toContain("registry");
    warn.mockRestore();
  });

  it("rejects items that are not plugin commands", async () => {
    apiMock.listPlugins.mockResolvedValue([]);
    const palette = usePluginCommandPalette();
    await palette.refresh();
    const item = { type: "connection", connectionId: "conn1" } as never;
    expect(palette.open(item).error).toBeTruthy();
  });
});
