export type GlobalNavigationSurface = "query" | "settings" | "driverStore" | "pluginCenter";
export type GlobalNavigationKind = "query" | "data" | "ddl" | "structure" | "objectSource" | "special";

export interface GlobalNavigationEntry {
  id: string;
  surface: GlobalNavigationSurface;
  kind?: GlobalNavigationKind;
  tabId?: string;
  title?: string;
  mode?: string;
  tableInfoTab?: string;
  sourceView?: boolean;
  connectionId?: string;
  database?: string;
  catalog?: string;
  schema?: string;
  tableName?: string;
  objectName?: string;
  objectType?: string;
  objectSignature?: string;
}

export function navigationEntryKey(entry: GlobalNavigationEntry): string {
  return [
    entry.surface,
    entry.kind ?? "",
    entry.tabId ?? "",
    entry.connectionId ?? "",
    entry.database ?? "",
    entry.catalog ?? "",
    entry.schema ?? "",
    entry.tableName ?? "",
    entry.objectName ?? "",
    entry.objectType ?? "",
    entry.objectSignature ?? "",
    entry.mode ?? "",
    entry.tableInfoTab ?? "",
    entry.sourceView ? "source" : "",
  ].join("|");
}
