import { evaluatePluginCommandConditions, type FrontendPluginRegistry } from "./frontendPlugin";
import type { PluginCommandContribution } from "@/types/database";

export type PluginShortcutPosition = "left-top" | "left-bottom" | "right-top" | "right-bottom" | "sidebar-bottom" | "toolbar" | "plugin-center";
export interface PluginShortcutSettings {
  enabled: boolean;
  position: PluginShortcutPosition;
  order: string[];
  hiddenPluginIds: string[];
  sidebarHeight: number | null;
  toolbarCount: number;
}

export function normalizePluginShortcutSettings(value: unknown): PluginShortcutSettings {
  const input = (value && typeof value === "object" ? value : {}) as Partial<Omit<PluginShortcutSettings, "position">> & { position?: unknown };
  const position = input.position;
  const strings = (values: unknown): string[] => (Array.isArray(values) ? [...new Set(values.filter((id): id is string => typeof id === "string" && id.length > 0))] : []);
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    position: position === "left" ? "left-top" : position === "left-top" || position === "left-bottom" || position === "right-bottom" || position === "sidebar-bottom" || position === "toolbar" || position === "plugin-center" ? position : "right-top",
    order: strings(input.order),
    hiddenPluginIds: strings(input.hiddenPluginIds),
    sidebarHeight: typeof input.sidebarHeight === "number" && Number.isFinite(input.sidebarHeight) && input.sidebarHeight > 0 ? input.sidebarHeight : null,
    toolbarCount: typeof input.toolbarCount === "number" && Number.isFinite(input.toolbarCount) ? Math.max(0, Math.min(10, Math.floor(input.toolbarCount))) : 3,
  };
}

/** 28px buttons, 2px gaps, 2px padding and a 1px border on either side. */
export function pluginShortcutToolbarWidth(count: number, requested: number): number {
  return count ? 4 + 30 * (Math.min(count, requested) + (count > requested ? 1 : 0)) : 0;
}

export function pluginShortcutToolbarCount(count: number, requested: number, width: number): number {
  const slots = Math.max(1, Math.floor((width - 4) / 30));
  return count <= requested && count <= slots ? count : Math.min(requested, slots - 1);
}

/** All sizes are CSS pixels; the caller measures its actual scroll viewport. */
export function pluginShortcutListHeight(count: number, itemSize = 28, gap = 0, padding = 8): number {
  const rows = Math.min(5, count);
  return rows ? padding + rows * itemSize + (rows - 1) * gap : 0;
}

export function clampPluginShortcutHeight(requested: number, availableHeight: number, minimum = 40): number {
  const maximum = Math.max(0, availableHeight - 120);
  return Math.min(maximum, Math.max(minimum, requested));
}

export interface PluginShortcutEntry {
  id: string;
  pluginId: string;
  pluginName: string;
  kind: "command" | "workbench" | "filesystem";
  targetId: string;
  label: string;
  icon?: string;
  rootUri?: string;
  command?: PluginCommandContribution;
  disabled: boolean;
}

export function collectPluginShortcuts(registry: FrontendPluginRegistry): PluginShortcutEntry[] {
  const result = new Map<string, PluginShortcutEntry>();
  const add = (pluginId: string, kind: PluginShortcutEntry["kind"], targetId: string, label: string, icon?: string, command?: PluginCommandContribution, rootUri?: string) => {
    const plugin = registry.findPlugin(pluginId)?.plugin;
    if (!plugin?.compatibility.compatible) return;
    if (command && !registry.findWorkbench(pluginId, command.action.workbench)) return;
    const id = JSON.stringify([pluginId, kind, targetId]);
    result.set(id, {
      id,
      pluginId,
      pluginName: plugin.manifest.name,
      kind,
      targetId,
      label,
      icon: icon || plugin.manifest.icon,
      command,
      rootUri,
      disabled: command
        ? !evaluatePluginCommandConditions(command.enablement?.all, {
            surface: command.action.presentation === "panel" ? "panel" : "tab",
            "connection.state": "none",
            readOnly: false,
          })
        : false,
    });
  };
  const declared = registry.listToolbarMenuCommands().sort((a, b) => a.order - b.order || `${a.plugin.manifest.id}:${a.command.id}`.localeCompare(`${b.plugin.manifest.id}:${b.command.id}`));
  for (const { plugin, command } of declared) add(plugin.manifest.id, "command", command.id, command.label, command.icon, command);
  const connected = new Set(registry.listConnectionProviders().map(({ plugin }) => plugin.manifest.id));
  for (const { plugin, contribution } of registry.listWorkbenches()) {
    const pluginId = plugin.manifest.id;
    if (connected.has(pluginId)) continue;
    const command = registry.findCommandTargetingWorkbench(pluginId, contribution.id);
    if (command) {
      // A declared toolbar visibility rule must not be bypassed by the legacy fallback.
      const hasPlacement = registry.findPlugin(pluginId)?.contributions.some((item) => item.type === "menus" && item.items.some((placement) => placement.location === "appToolbar" && placement.command === command.id));
      if (!hasPlacement) add(pluginId, "command", command.id, command.label, command.icon, command);
    } else add(pluginId, "workbench", contribution.id, contribution.label, contribution.icon);
  }
  const commands = new Set(registry.listCommands().map(({ plugin }) => plugin.manifest.id));
  for (const { plugin, contribution } of registry.listFilesystemProviders()) {
    if (!connected.has(plugin.manifest.id) && !commands.has(plugin.manifest.id)) {
      add(plugin.manifest.id, "filesystem", contribution.id, contribution.label, contribution.icon, undefined, contribution.root_uri);
    }
  }
  return [...result.values()];
}

export function orderPluginShortcuts(entries: PluginShortcutEntry[], order: string[]): PluginShortcutEntry[] {
  const indices = new Map(order.map((id, index) => [id, index]));
  return [...entries].sort((a, b) => (indices.get(a.id) ?? order.length) - (indices.get(b.id) ?? order.length));
}

/** Reorder visible slots while retaining unavailable plugins at their saved positions. */
export function movePluginShortcut(order: string[], visibleIds: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !visibleIds.includes(source) || !visibleIds.includes(target)) return order;
  const moved = visibleIds.filter((id) => id !== source);
  moved.splice(moved.indexOf(target) + (after ? 1 : 0), 0, source);
  const complete = [...new Set([...order, ...visibleIds])];
  const visible = new Set(visibleIds);
  let index = 0;
  return complete.map((id) => (visible.has(id) ? moved[index++] : id));
}
