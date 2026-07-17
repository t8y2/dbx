import type { ConnectionConfig } from "@/types/database";
import { connectionIsDorisFamilyCatalogCapable } from "@/lib/database/databaseFeatureSupport";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export function dataTabExecutionDatabase(connection: ConnectionConfig | undefined, tabDatabase: string, catalog?: string): string {
  if (!catalog?.trim()) return tabDatabase;

  const databaseType = effectiveDatabaseTypeForConnection(connection);
  const usesExternalCatalog = connectionIsDorisFamilyCatalogCapable(connection) || databaseType === "doris" || databaseType === "starrocks";
  if (!usesExternalCatalog) return tabDatabase;

  // External catalog namespaces qualify the SQL object name, but they are not
  // valid MySQL-protocol session databases. Keep the configured internal DB.
  return connection?.database ?? "";
}
