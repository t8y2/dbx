import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFrontendPluginRegistry, evaluatePluginCommandConditions } from "./frontendPlugin";
import { executePluginCommand } from "./pluginCommandRegistry";
import { closePluginDockEntry, usePluginBottomDock } from "./pluginBottomDock";
import type { InstalledPlugin, PluginMenusContribution } from "@/types/database";

// PR-A4 command/menus host side (HOST_PLUGIN_UI_SPEC §4/§5/§8.3/§11): the command
// the command registry derives toolbar entries from installed-plugin declarations; execution opens the workbench with a host-authored context —
// presentation: tab (default) opens a workbench tab, panel opens the global bottom dock; the plugin payload rides under
// context.plugin, while workbenchId/restored/surface are host-injected and never taken from the plugin.
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

function localTerminalCommand(actionOverrides: Record<string, unknown> = {}) {
  return {
    type: "command",
    id: "open-local-terminal",
    label: "Local terminal",
    action: {
      type: "open-workbench",
      workbench: "io.dbx.ssh.workbench",
      reuse: "singleton",
      context: { plugin: { mode: "local-terminal" } },
      ...actionOverrides,
    },
  };
}

function menusContribution(items: PluginMenusContribution["items"]): PluginMenusContribution {
  return { type: "menus", id: "entrypoints", items };
}

describe("plugin command registry (PR-A4)", () => {
  beforeEach(() => {
    const { entries, visible } = usePluginBottomDock();
    entries.value.splice(0);
    visible.value = false;
  });

  it("derives visible appToolbar entries ordered by order then command id", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand(),
        menusContribution([
          { location: "commandPalette", command: "open-local-terminal", group: "primary", order: 100 },
          { location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100, default_visible: true },
        ]),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const entries = registry.listToolbarMenuCommands();
    expect(entries).toHaveLength(1);
    expect(entries[0].plugin.manifest.id).toBe("io.dbx.ssh");
    expect(entries[0].command.id).toBe("open-local-terminal");

    // §5.2: toolbar items default to hidden — anything without default_visible: true never renders.
    const hidden = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menusContribution([{ location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100 }])] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(hidden.listToolbarMenuCommands()).toHaveLength(0);
  });

  it("executes a tab command with a host-authored context and singleton reuse", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [{ type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" }, localTerminalCommand()] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const openPluginWorkbench = vi.fn();
    const result = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(result.error).toBeUndefined();
    expect(openPluginWorkbench).toHaveBeenCalledTimes(1);
    const [pluginId, workbenchId, options] = openPluginWorkbench.mock.calls[0];
    expect(pluginId).toBe("io.dbx.ssh");
    expect(workbenchId).toBe("io.dbx.ssh.workbench");
    expect(options.forceNew).toBe(false);
    // plugin payload under context.plugin; reserved fields are host-injected and override forged values.
    expect(options.context.plugin).toEqual({ mode: "local-terminal" });
    expect(typeof options.context.workbenchId).toBe("string");
    expect(options.context.restored).toBe(false);
    expect(options.context.surface).toBe("tab");
    expect(usePluginBottomDock().visible.value).toBe(false);
  });

  it("singleton (default) reuses the dock entry per panel execution; the + menu stays the multi-open affordance", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ presentation: "panel", instance_key: "local-terminal", context: { plugin: { mode: "local-terminal" }, workbenchId: "plugin-forged", surface: "tab" } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const { entries, activeEntryId, visible } = usePluginBottomDock();

    const first = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(first.error).toBeUndefined();
    expect(entries.value).toHaveLength(1);
    expect(visible.value).toBe(true);
    const firstEntry = entries.value[0];
    expect(firstEntry.pluginId).toBe("io.dbx.ssh");
    expect(firstEntry.workbenchContributionId).toBe("io.dbx.ssh.workbench");
    expect(firstEntry.context.plugin).toEqual({ mode: "local-terminal" });
    // plugin-forged reserved fields are overridden by host-authoritative values; workbenchId = entry id and stable.
    expect(firstEntry.context.workbenchId).toBe(firstEntry.id);
    expect(firstEntry.context.workbenchId).not.toBe("plugin-forged");
    expect(firstEntry.context.restored).toBe(false);
    expect(firstEntry.context.surface).toBe("panel");
    expect(activeEntryId.value).toBe(firstEntry.id);
    // §4.1 reuse key = pluginId + commandId + presentation + instance_key.
    expect(firstEntry.instanceKey).toBe("local-terminal");

    // a second singleton execution re-activates the existing instance instead of spawning one;
    // repeated multi-open goes through the dock "+" menu (options_action/connection targets), not here.
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(entries.value).toHaveLength(1);
    expect(activeEntryId.value).toBe(firstEntry.id);
    expect(openPluginWorkbench).not.toHaveBeenCalled();

    // closing an entry removes its tab; the panel hides once all entries are gone.
    closePluginDockEntry(entries.value[0].id);
    expect(visible.value).toBe(false);
  });

  it("reuse:new spawns one dock entry per execution", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ presentation: "panel", reuse: "new", instance_key: "local-terminal", context: { plugin: { mode: "local-terminal" } } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const { entries, activeEntryId } = usePluginBottomDock();
    executePluginCommand(registry, { openPluginWorkbench: vi.fn() } as never, "io.dbx.ssh", "open-local-terminal");
    executePluginCommand(registry, { openPluginWorkbench: vi.fn() } as never, "io.dbx.ssh", "open-local-terminal");
    expect(entries.value).toHaveLength(2);
    expect(activeEntryId.value).toBe(entries.value[1]!.id);
  });

  it("drops plugin-forged reserved fields and honors reuse:new with forceNew", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ssh", [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand({ reuse: "new", context: { plugin: { mode: "local-terminal" }, workbenchId: "plugin-forged", restored: true, surface: "panel" } }),
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const result = executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal");
    expect(result.error).toBeUndefined();
    const [, , options] = openPluginWorkbench.mock.calls[0];
    expect(options.forceNew).toBe(true);
    expect(options.context.workbenchId).not.toBe("plugin-forged");
    expect(options.context.restored).toBe(false);
    expect(options.context.surface).toBe("tab");
  });

  it("reports unknown commands and dangling workbench references instead of opening a tab", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand({ workbench: "io.dbx.ssh.missing" })] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const openPluginWorkbench = vi.fn();
    expect(executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "missing-command").error).toBeTruthy();
    expect(executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ssh", "open-local-terminal").error).toContain("missing workbench");
    expect(openPluginWorkbench).not.toHaveBeenCalled();
  });

  it("evaluates §5.3 conditions (equals/notEquals/oneOf, missing key = false)", () => {
    expect(evaluatePluginCommandConditions([{ key: "surface", operator: "equals", value: "tab" }], { surface: "tab" })).toBe(true);
    expect(evaluatePluginCommandConditions([{ key: "surface", operator: "notEquals", value: "tab" }], { surface: "tab" })).toBe(false);
    expect(evaluatePluginCommandConditions([{ key: "connection.state", operator: "oneOf", value: ["connected", "reconnecting"] }], { "connection.state": "connected" })).toBe(true);
    // empty condition group defaults to true; a missing key is always false (§5.3).
    expect(evaluatePluginCommandConditions([], {})).toBe(true);
    expect(evaluatePluginCommandConditions([{ key: "object.type", operator: "equals", value: "table" }], {})).toBe(false);
    // implicit AND within all.
    expect(
      evaluatePluginCommandConditions(
        [
          { key: "surface", operator: "equals", value: "tab" },
          { key: "readOnly", operator: "equals", value: false },
        ],
        { surface: "tab", readOnly: false },
      ),
    ).toBe(true);
    expect(
      evaluatePluginCommandConditions(
        [
          { key: "surface", operator: "equals", value: "tab" },
          { key: "readOnly", operator: "equals", value: true },
        ],
        { surface: "tab", readOnly: false },
      ),
    ).toBe(false);
  });

  it("gates execution by enablement against the context snapshot", () => {
    const command = (enablement: unknown) =>
      [
        { type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" },
        localTerminalCommand(),
        { type: "command", id: "gated", label: "Gated", enablement, action: { type: "open-workbench", workbench: "io.dbx.ssh.workbench", context: { plugin: { mode: "local-terminal" } } } },
      ] as unknown as InstalledPlugin["manifest"]["contributions"];
    const openPluginWorkbench = vi.fn();

    const pass = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", command({ all: [{ key: "surface", operator: "equals", value: "tab" }] } as unknown as InstalledPlugin["manifest"]["contributions"]))]);
    expect(executePluginCommand(pass, { openPluginWorkbench: vi.fn() } as never, "io.dbx.ssh", "gated").error).toBeUndefined();

    const blocked = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", command({ all: [{ key: "surface", operator: "equals", value: "panel" }] } as unknown as InstalledPlugin["manifest"]["contributions"]))]);
    const result = executePluginCommand(blocked, { openPluginWorkbench } as never, "io.dbx.ssh", "gated");
    expect(result.error).toContain("disabled by enablement");
    expect(openPluginWorkbench).not.toHaveBeenCalled();
  });

  it("listToolbarMenuCommands applies when visibility against the placement surface", () => {
    const menus = (value: string) => menusContribution([{ location: "appToolbar", command: "open-local-terminal", group: "navigation", order: 100, default_visible: true, when: { all: [{ key: "surface", operator: "equals", value }] } }]);
    const show = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menus("appToolbar")] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(show.listToolbarMenuCommands()).toHaveLength(1);
    const hide = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [localTerminalCommand(), menus("panel")] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    expect(hide.listToolbarMenuCommands()).toHaveLength(0);
  });

  it("finds the declared command targeting a workbench for entry routing", () => {
    const registry = createFrontendPluginRegistry([installedPlugin("io.dbx.ssh", [{ type: "workbench", id: "io.dbx.ssh.workbench", label: "SSH" }, localTerminalCommand()] as unknown as InstalledPlugin["manifest"]["contributions"])]);
    const command = registry.findCommandTargetingWorkbench("io.dbx.ssh", "io.dbx.ssh.workbench");
    expect(command?.id).toBe("open-local-terminal");
    expect(registry.findCommandTargetingWorkbench("io.dbx.ssh", "other.workbench")).toBeUndefined();
    expect(registry.findCommandTargetingWorkbench("other.plugin", "io.dbx.ssh.workbench")).toBeUndefined();
  });

  // §4.1 instance_key placeholder scoping: one panel instance per resolved
  // connection, re-activation per key, literal fallback when unresolvable.
  it("scopes panel instances by instance_key placeholders from the execution context", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ldap", [
        { type: "workbench", id: "io.dbx.ldap.logpanel", label: "Logs" },
        { type: "command", id: "open-conn-logs", label: "Connection logs", action: { type: "open-workbench", workbench: "io.dbx.ldap.logpanel", presentation: "panel", reuse: "singleton", instance_key: "logs:{{connectionId}}" } },
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const openPluginWorkbench = vi.fn();
    const { entries, activeEntryId } = usePluginBottomDock();

    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ldap", "open-conn-logs", { connectionId: "conn-a" });
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ldap", "open-conn-logs", { connectionId: "conn-b" });
    expect(entries.value.map((entry) => entry.instanceKey)).toEqual(["logs:conn-a", "logs:conn-b"]);

    // the same connection re-activates its own instance; caller-only extras do not fork it
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ldap", "open-conn-logs", { connectionId: "conn-a", caller: "only" });
    expect(entries.value).toHaveLength(2);
    expect(activeEntryId.value).toBe(entries.value[0]!.id);

    // unresolvable template (no context) falls back to the literal key
    executePluginCommand(registry, { openPluginWorkbench } as never, "io.dbx.ldap", "open-conn-logs");
    expect(entries.value).toHaveLength(3);
    expect(entries.value[2]!.instanceKey).toBe("logs:{{connectionId}}");
    expect(openPluginWorkbench).not.toHaveBeenCalled();
  });

  it("merges caller context over the command context and keeps reserved fields host-owned", () => {
    const registry = createFrontendPluginRegistry([
      installedPlugin("io.dbx.ldap", [
        { type: "workbench", id: "io.dbx.ldap.logpanel", label: "Logs" },
        { type: "command", id: "open-logs", label: "Logs", action: { type: "open-workbench", workbench: "io.dbx.ldap.logpanel", presentation: "panel", context: { plugin: { mode: "logs" }, from: "command" } } },
      ] as unknown as InstalledPlugin["manifest"]["contributions"]),
    ]);
    const { entries } = usePluginBottomDock();
    executePluginCommand(registry, { openPluginWorkbench: vi.fn() } as never, "io.dbx.ldap", "open-logs", { plugin: { mode: "override" }, connectionId: "c1", workbenchId: "plugin-forged", restored: true, surface: "tab" });
    const entry = entries.value[0]!;
    expect(entry.context.plugin).toEqual({ mode: "override" });
    expect(entry.context.from).toBe("command");
    expect(entry.context.connectionId).toBe("c1");
    // §11: reserved identity fields are host-authored — forged values never pass.
    expect(entry.context.workbenchId).toBe(entry.id);
    expect(entry.context.restored).toBe(false);
    expect(entry.context.surface).toBe("panel");
  });
});
