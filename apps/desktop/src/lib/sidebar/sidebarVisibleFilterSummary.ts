import type { ConnectionConfig } from "@/types/database";
import { connectionUsesVisibleSchemaFilter, databaseNameMatchesVisiblePatterns, filterDatabaseNamesForVisiblePicker, filterSchemaNamesForVisiblePicker, normalizeVisibleDatabaseSelection, visibleDatabasePatternsAreEnabled } from "@/lib/database/visibleDatabases";
import { nacosNamespaceIdentity } from "@/lib/nacos/nacosNamespaceVisibility";

type SidebarVisibleFilterConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "show_system_schemas" | "username" | "visible_databases" | "visible_database_patterns" | "visible_schemas">;

export type SidebarVisibleFilterSummary = {
  mode: "database" | "schema" | "namespace";
  isActive: boolean;
  selected: number | null;
  total: number | null;
};

export function connectionHasConfiguredSidebarVisibleFilter(connection: SidebarVisibleFilterConnection): boolean {
  if (connectionUsesVisibleSchemaFilter(connection)) {
    return Array.isArray(connection.visible_schemas?.[connection.database || ""]);
  }
  return Array.isArray(connection.visible_databases) || (connection.db_type !== "nacos" && visibleDatabasePatternsAreEnabled(connection.visible_database_patterns));
}

export function sidebarVisibleFilterSummary(connection: SidebarVisibleFilterConnection, objectNames?: readonly string[]): SidebarVisibleFilterSummary {
  const mode = connectionUsesVisibleSchemaFilter(connection) ? "schema" : "database";
  const configured = mode === "schema" ? connection.visible_schemas?.[connection.database || ""] : connection.visible_databases;
  // 通配符模式只在数据库模式生效；命中的库名与显式勾选取并集（#7164）
  const patterns = mode === "database" ? connection.visible_database_patterns : undefined;
  const isExplicit = Array.isArray(configured) || visibleDatabasePatternsAreEnabled(patterns);
  if (!objectNames) return { mode, isActive: false, selected: null, total: null };

  const names = [...objectNames];
  const defaultNames = mode === "schema" ? filterSchemaNamesForVisiblePicker(names, connection) : filterDatabaseNamesForVisiblePicker(names, connection);
  if (!isExplicit) {
    return { mode, isActive: false, selected: defaultNames.length, total: defaultNames.length };
  }

  const selectedSet = new Set(Array.isArray(configured) ? normalizeVisibleDatabaseSelection(configured, names) : []);
  if (visibleDatabasePatternsAreEnabled(patterns)) {
    for (const name of names) {
      if (databaseNameMatchesVisiblePatterns(name, patterns)) selectedSet.add(name);
    }
  }
  const selectedNames = [...selectedSet];
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

export function nacosVisibleNamespaceSummary(connection: Pick<ConnectionConfig, "visible_databases">, namespaceIds?: readonly string[]): SidebarVisibleFilterSummary {
  if (!namespaceIds) return { mode: "namespace", isActive: false, selected: null, total: null };

  const identities = [...new Set(namespaceIds.map(nacosNamespaceIdentity))];
  const total = identities.length;
  if (!Array.isArray(connection.visible_databases)) {
    return { mode: "namespace", isActive: false, selected: total, total };
  }

  const selected = new Set(connection.visible_databases.map(nacosNamespaceIdentity));
  const selectedCount = identities.filter((identity) => selected.has(identity)).length;
  return { mode: "namespace", isActive: selectedCount < total, selected: selectedCount, total };
}
