export type SidebarVisibleFilterMenuEntry = {
  label: "objects" | "schemas";
  target: "visible-databases" | "visible-schemas";
};

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
