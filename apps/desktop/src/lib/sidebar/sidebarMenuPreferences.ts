export const SIDEBAR_MENU_SCOPES = ["connection", "database", "schema", "table", "view", "sql-editor"] as const;
export type SidebarMenuScope = (typeof SIDEBAR_MENU_SCOPES)[number];
export type SidebarMenuLayout = "grouped" | "full";
export type SidebarMenuPinnedActions = Partial<Record<SidebarMenuScope, string[]>>;
export type SidebarMenuOrder = Partial<Record<SidebarMenuScope, string[]>>;

/** Normalize persisted preferences without importing menu rendering or icons. */
export function normalizeSidebarMenuPinnedActions(value: unknown): SidebarMenuPinnedActions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SidebarMenuPinnedActions = {};
  for (const scope of SIDEBAR_MENU_SCOPES) {
    const ids = (value as Record<string, unknown>)[scope];
    if (Array.isArray(ids)) result[scope] = [...new Set(ids.filter((id): id is string => typeof id === "string" && /^[a-zA-Z][\w.-]{0,159}$/.test(id)))];
  }
  return result;
}

export function normalizeSidebarMenuOrder(value: unknown): SidebarMenuOrder {
  return normalizeSidebarMenuPinnedActions(value);
}
