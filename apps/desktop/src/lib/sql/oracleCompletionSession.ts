import type { DatabaseType } from "@/types/database";

/** Native Oracle and OceanBase Oracle share multi-schema completion semantics. */
export function isOracleCompletionDatabase(databaseType?: DatabaseType): boolean {
  return databaseType === "oracle" || databaseType === "oceanbase-oracle";
}

export function usesOracleCurrentSchemaCompletion(databaseType?: DatabaseType, schema?: string | null): boolean {
  return isOracleCompletionDatabase(databaseType) && !schema;
}

export function usesOracleSessionCompletionColumns(options: { databaseType?: DatabaseType; selectedSchema?: string; referenceSchema?: string | null; clientSessionId?: string }): boolean {
  const schema = options.databaseType === "oceanbase-oracle" ? options.referenceSchema : options.referenceSchema || options.selectedSchema;
  return usesOracleCurrentSchemaCompletion(options.databaseType, schema) && !!options.clientSessionId;
}
