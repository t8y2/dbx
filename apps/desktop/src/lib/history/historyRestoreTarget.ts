import type { HistoryEntry } from "@/lib/backend/api";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { normalizeSqliteNamespace } from "@/lib/database/sqliteNamespace";
import type { ConnectionConfig, QueryTab } from "@/types/database";

export interface HistorySqlRestoreTarget {
  connectionId: string;
  database: string;
  schema?: string;
}

export function resolveHistorySqlRestoreTarget(options: { entry: HistoryEntry; activeTab?: QueryTab; firstConnectionId?: string; connections?: ConnectionConfig[]; getConfig: (connectionId: string) => ConnectionConfig | undefined }): HistorySqlRestoreTarget | null {
  const { entry, activeTab, firstConnectionId, connections, getConfig } = options;
  let connectionId: string | undefined;
  if (entry.connection_id && getConfig(entry.connection_id)) {
    connectionId = entry.connection_id;
  } else if (entry.connection_name && connections) {
    const matches = connections.filter((connection) => connection.name === entry.connection_name);
    if (matches.length > 1) return null;
    connectionId = matches[0]?.id;
  }
  if (!connectionId && entry.connection_id) {
    connectionId = entry.connection_id;
  }
  connectionId = connectionId || activeTab?.connectionId || firstConnectionId;
  if (!connectionId) return null;

  const config = getConfig(connectionId);
  const storedDatabase = entry.database || (activeTab?.connectionId === connectionId ? activeTab.database : "") || (config ? resolveDefaultDatabase(config, []) : "");
  const database = config?.db_type === "sqlite" ? normalizeSqliteNamespace(storedDatabase, config) : storedDatabase;

  let schema: string | undefined;
  if (entry.details_json) {
    try {
      const details = JSON.parse(entry.details_json);
      if (typeof details?.schema === "string" && details.schema) {
        schema = details.schema;
      }
    } catch {}
  }
  if (!schema && activeTab?.connectionId === connectionId && activeTab.database === database) {
    schema = activeTab.schema;
  }
  if (!schema && config?.default_schema) {
    schema = config.default_schema;
  }

  return { connectionId, database: database || "", schema };
}

/**
 * Determines whether an existing active tab can be safely reused for restoring history SQL.
 * To avoid clearing or overwriting user's active work, a tab is only reusable if:
 * 1. It is a query tab (not a data grid, structure editor, etc.)
 * 2. It has no user-typed or existing SQL (empty / whitespace-only)
 * 3. It is not an external file, saved SQL document, or object source view
 * 4. It is not currently executing and has no active results
 * 5. Its connection, database, and schema match the restore target
 */
export function canReuseTabForHistoryRestore(tab: QueryTab | undefined, target: HistorySqlRestoreTarget): boolean {
  if (!tab || tab.mode !== "query") return false;
  if (tab.sql.trim().length > 0) return false;
  if (tab.savedSqlId || tab.externalSqlPath || tab.objectSource) return false;
  if (tab.isExecuting || tab.result || (tab.results && tab.results.length > 0)) return false;
  if (tab.connectionId !== target.connectionId) return false;
  if ((tab.database || "") !== (target.database || "")) return false;
  if ((tab.schema || "") !== (target.schema || "")) return false;
  return true;
}
