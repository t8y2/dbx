import type { DatabaseType } from "@/types/database";

export function usesOracleCurrentSchemaCompletion(databaseType?: DatabaseType, schema?: string | null): boolean {
  return (databaseType === "oracle" || databaseType === "oceanbase-oracle") && !schema;
}

export function usesOracleSessionCompletionColumns(options: { databaseType?: DatabaseType; selectedSchema?: string; referenceSchema?: string | null; clientSessionId?: string }): boolean {
  return usesOracleCurrentSchemaCompletion(options.databaseType, options.referenceSchema || options.selectedSchema) && !!options.clientSessionId;
}
