import type { DatabaseType } from "@/types/database";
import { connectionCanChooseVisibleDatabases } from "@/lib/connection/connectionVisibleDatabases";

const CATALOG_SCOPED_VISIBLE_DATABASE_TYPES = new Set<DatabaseType>(["doris", "starrocks"]);

export type SidebarVisibleFilterMenuEntry = {
  label: "objects" | "schemas";
  target: "visible-databases" | "visible-schemas";
};

export function connectionCanConfigureSidebarVisibleDatabases(databaseType: DatabaseType | undefined): boolean {
  // Doris and StarRocks can expose the same database name in multiple catalogs,
  // while `visible_databases` is still a flat name list. Keep the sidebar entry
  // unavailable until the persisted selection can preserve catalog identity.
  if (databaseType && CATALOG_SCOPED_VISIBLE_DATABASE_TYPES.has(databaseType)) return false;
  return connectionCanChooseVisibleDatabases(databaseType ? { db_type: databaseType } : undefined);
}

export function sidebarConnectionVisibleFilterMenu(options: { canConfigureVisibleDatabases: boolean; canConfigureVisibleSchemas: boolean; databaseFilterUsesSchemas: boolean }): SidebarVisibleFilterMenuEntry[] {
  if (!options.canConfigureVisibleDatabases) {
    return options.canConfigureVisibleSchemas ? [{ label: "schemas", target: "visible-schemas" }] : [];
  }

  if (options.databaseFilterUsesSchemas) {
    return [{ label: "schemas", target: "visible-databases" }];
  }

  const entries: SidebarVisibleFilterMenuEntry[] = [{ label: "objects", target: "visible-databases" }];
  if (options.canConfigureVisibleSchemas) entries.push({ label: "schemas", target: "visible-schemas" });
  return entries;
}
