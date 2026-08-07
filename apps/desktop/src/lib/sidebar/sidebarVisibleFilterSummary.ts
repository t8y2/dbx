import type { ConnectionConfig } from "@/types/database";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForVisiblePicker, filterSchemaNamesForVisiblePicker, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";

type SidebarVisibleFilterConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "show_system_schemas" | "username" | "visible_databases" | "visible_schemas">;

export type SidebarVisibleFilterSummary = {
  mode: "database" | "schema";
  isActive: boolean;
  selected: number | null;
  total: number | null;
};

export function connectionHasConfiguredSidebarVisibleFilter(connection: SidebarVisibleFilterConnection): boolean {
  if (connectionUsesVisibleSchemaFilter(connection)) {
    return Array.isArray(connection.visible_schemas?.[connection.database || ""]);
  }
  return Array.isArray(connection.visible_databases);
}

export function sidebarVisibleFilterSummary(connection: SidebarVisibleFilterConnection, objectNames?: readonly string[]): SidebarVisibleFilterSummary {
  const mode = connectionUsesVisibleSchemaFilter(connection) ? "schema" : "database";
  const configured = mode === "schema" ? connection.visible_schemas?.[connection.database || ""] : connection.visible_databases;
  const isExplicit = Array.isArray(configured);
  if (!objectNames) return { mode, isActive: false, selected: null, total: null };

  const names = [...objectNames];
  const defaultNames = mode === "schema" ? filterSchemaNamesForVisiblePicker(names, connection) : filterDatabaseNamesForVisiblePicker(names, connection);
  if (!isExplicit) {
    return { mode, isActive: false, selected: defaultNames.length, total: defaultNames.length };
  }

  const selectedNames = normalizeVisibleDatabaseSelection(configured, names);
  const defaultNameSet = new Set(defaultNames);
  const includesSystemObject = selectedNames.some((name) => !defaultNameSet.has(name));
  const total = includesSystemObject ? names.length : defaultNames.length;
  return {
    mode,
    isActive: selectedNames.length < total,
    selected: selectedNames.length,
    total,
  };
}
