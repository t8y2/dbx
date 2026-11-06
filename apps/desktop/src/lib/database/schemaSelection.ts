import * as api from "@/lib/backend/api";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { filterSchemaNamesForConnection, isSystemSchemaName } from "@/lib/database/visibleDatabases";
import type { ConnectionConfig } from "@/types/database";

export async function loadSchemaSelection(connectionId: string, database: string, connection: Partial<ConnectionConfig>) {
  const names = await api.listSchemas(connectionId, database, false, true);
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  let oracleMaintainedSchemas: ReadonlySet<string> | undefined;
  if (databaseType === "oracle") {
    try {
      const result = await api.executeQuery(connectionId, database, "SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y'", undefined, undefined, { maxRows: 10000 });
      if (!result.has_more && result.rows.length < 10000 && result.columns[0]?.toUpperCase() === "USERNAME") {
        oracleMaintainedSchemas = new Set(result.rows.flatMap((row) => (typeof row[0] === "string" ? [row[0]] : [])));
      }
    } catch {
      // Oracle 11g and restricted catalogs retain the existing known-name fallback.
    }
  }
  const systemNames = new Set(names.filter((name) => (oracleMaintainedSchemas ? oracleMaintainedSchemas.has(name) : isSystemSchemaName(databaseType, name))));
  const configured = connection.visible_schemas?.[database === "_" ? "" : database];
  const selected = Array.isArray(configured) ? [...new Set(configured)] : filterSchemaNamesForConnection(names, connection, database, { oracleMaintainedSchemas });
  return { names, systemNames, selected };
}
