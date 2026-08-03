import type { ConnectionConfig } from "@/types/database";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForVisiblePicker, filterSchemaNamesForVisiblePicker, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";

type SidebarVisibleFilterConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "show_system_schemas" | "username" | "visible_databases" | "visible_schemas">;

export type SidebarVisibleFilterSummary = {
  mode: "database" | "schema";
  isExplicit: boolean;
  selected: number | null;
  total: number | null;
};

export function sidebarVisibleFilterSummary(connection: SidebarVisibleFilterConnection, objectNames?: readonly string[]): SidebarVisibleFilterSummary {
  const mode = connectionUsesVisibleSchemaFilter(connection) ? "schema" : "database";
  const configured = mode === "schema" ? connection.visible_schemas?.[connection.database || ""] : connection.visible_databases;
  if (!objectNames) return { mode, isExplicit: Array.isArray(configured), selected: null, total: null };

  const names = [...objectNames];
  const defaultNames = mode === "schema" ? filterSchemaNamesForVisiblePicker(names, connection) : filterDatabaseNamesForVisiblePicker(names, connection);
  if (!Array.isArray(configured)) {
    return { mode, isExplicit: false, selected: defaultNames.length, total: defaultNames.length };
  }

  const selectedNames = normalizeVisibleDatabaseSelection(configured, names);
  const defaultNameSet = new Set(defaultNames);
  const includesSystemObject = selectedNames.some((name) => !defaultNameSet.has(name));
  return {
    mode,
    isExplicit: true,
    selected: selectedNames.length,
    total: includesSystemObject ? names.length : defaultNames.length,
  };
}
