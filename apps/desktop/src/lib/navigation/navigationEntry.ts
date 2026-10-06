import type { ObjectSourceKind } from "@/types/database";

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
  initialEditing?: boolean;
  connectionId?: string;
  database?: string;
  catalog?: string;
  schema?: string;
  tableName?: string;
  tableType?: string;
  objectName?: string;
  objectType?: ObjectSourceKind;
  objectSignature?: string;
}

export function navigationEntryKey(entry: GlobalNavigationEntry): string {
  return JSON.stringify([
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
    entry.initialEditing ?? true,
    entry.tableType ?? "",
  ]);
}
