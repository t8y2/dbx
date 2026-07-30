import type { HistoryEntry } from "@/lib/backend/api";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { normalizeSqliteNamespace } from "@/lib/database/sqliteNamespace";
import type { ConnectionConfig, QueryTab } from "@/types/database";

export interface HistorySqlRestoreTarget {
  connectionId: string;
  database: string;
  schema?: string;
}

export function resolveHistorySqlRestoreTarget(options: { entry: HistoryEntry; activeTab?: QueryTab; firstConnectionId?: string; getConfig: (connectionId: string) => ConnectionConfig | undefined }): HistorySqlRestoreTarget | null {
  const { entry, activeTab, firstConnectionId, getConfig } = options;
  const connectionId = entry.connection_id || activeTab?.connectionId || firstConnectionId;
  if (!connectionId) return null;
  const config = getConfig(connectionId);
  const storedDatabase = entry.database || activeTab?.database || (config ? resolveDefaultDatabase(config, []) : "");
  const database = config?.db_type === "sqlite" ? normalizeSqliteNamespace(storedDatabase, config) : storedDatabase;
  const schema = activeTab?.connectionId === connectionId && activeTab.database === database ? activeTab.schema : undefined;
  return { connectionId, database: database || "", schema };
}
