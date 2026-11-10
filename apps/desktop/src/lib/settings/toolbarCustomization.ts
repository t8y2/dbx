export const TOOLBAR_ITEM_GROUPS = {
  primary: ["newConnection", "newQuery", "dataTransfer", "driverManager", "pluginCenter"],
  menu: ["openSql", "sqlFile", "schemaDiff", "dataCompare", "databaseBackups", "mcpSettings"],
  right: ["checkUpdates", "immediateSync", "alwaysOnTop", "exportProgress", "sqlLibrary", "sqlFileTree", "history", "ai", "theme", "github"],
  controls: ["settings", "logout"],
} as const;

export type ToolbarItemGroup = keyof typeof TOOLBAR_ITEM_GROUPS;
export type ToolbarItemKey = (typeof TOOLBAR_ITEM_GROUPS)[ToolbarItemGroup][number];
export const DEFAULT_TOOLBAR_ITEM_ORDER: readonly ToolbarItemKey[] = Object.values(TOOLBAR_ITEM_GROUPS).flat();

export function normalizeToolbarItemOrder(value: unknown): ToolbarItemKey[] {
  const known = new Set<string>(DEFAULT_TOOLBAR_ITEM_ORDER);
  const saved = Array.isArray(value) ? value.filter((key): key is ToolbarItemKey => typeof key === "string" && known.has(key)) : [];
  return [...new Set([...saved, ...DEFAULT_TOOLBAR_ITEM_ORDER])];
}

export function toolbarGroupOrder(value: unknown, group: ToolbarItemGroup): ToolbarItemKey[] {
  const keys = new Set<ToolbarItemKey>(TOOLBAR_ITEM_GROUPS[group]);
  return normalizeToolbarItemOrder(value).filter((key) => keys.has(key));
}

// Replace only the displayed keys: a Web edit must retain desktop-only entries.
export function replaceToolbarItemOrder(value: unknown, reorderedKeys: ToolbarItemKey[]): ToolbarItemKey[] {
  const order = normalizeToolbarItemOrder(value);
  const keys = new Set(reorderedKeys);
  if (keys.size !== reorderedKeys.length || !Object.values(TOOLBAR_ITEM_GROUPS).some((group) => reorderedKeys.every((key) => (group as readonly string[]).includes(key)))) return order;
  let index = 0;
  return order.map((key) => (keys.has(key) ? reorderedKeys[index++]! : key));
}

// Reorder managed slots without moving overflow/fallback entries from other zones.
export function orderToolbarItems<T>(items: T[], order: readonly ToolbarItemKey[], keyFor: (item: T) => string): T[] {
  const ranks = new Map<string, number>(order.map((key, index) => [key, index]));
  const sorted = items.filter((item) => ranks.has(keyFor(item))).sort((a, b) => ranks.get(keyFor(a))! - ranks.get(keyFor(b))!);
  let index = 0;
  return items.map((item) => (ranks.has(keyFor(item)) ? sorted[index++]! : item));
}
