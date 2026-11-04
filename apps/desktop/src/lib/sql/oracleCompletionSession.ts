import type { DatabaseType } from "@/types/database";
import type { SqlCompletionTable } from "@/lib/sql/sqlCompletion";

export interface OracleCompletionTableScope {
  schema?: string;
  includePublicSynonyms: boolean;
}

export function oracleCompletionTablesForScope(tables: SqlCompletionTable[], scope: OracleCompletionTableScope): SqlCompletionTable[] {
  const synonym = (table: SqlCompletionTable) => table.type === "synonym" || table.tableType === "SYNONYM";
  const visible = tables.filter((table) => (scope.schema !== undefined && table.schema === scope.schema) || (scope.includePublicSynonyms && table.schema === "PUBLIC" && synonym(table)));
  visible.sort((a, b) => Number(a.schema === "PUBLIC") - Number(b.schema === "PUBLIC") || Number(synonym(a)) - Number(synonym(b)));
  const names = new Set<string>();
  return visible
    .filter((table) => {
      if (names.has(table.name)) return false;
      names.add(table.name);
      return true;
    })
    .map((table) => ({ ...table, applyName: undefined, boost: table.schema === "PUBLIC" ? 1200 : 2400 }));
}

/** Native Oracle and OceanBase Oracle share multi-schema completion semantics. */
export function isOracleCompletionDatabase(databaseType?: DatabaseType): boolean {
  return databaseType === "oracle" || databaseType === "oceanbase-oracle";
}

/** Engines whose sequences are addressed like Oracle's (SEQ.NEXTVAL / SEQ.CURRVAL). */
export function isSequenceCompletionDatabase(databaseType?: DatabaseType): boolean {
  return isOracleCompletionDatabase(databaseType) || databaseType === "dameng";
}

export function usesOracleCurrentSchemaCompletion(databaseType?: DatabaseType, schema?: string | null): boolean {
  return isOracleCompletionDatabase(databaseType) && !schema;
}

export function usesOracleSessionCompletionColumns(options: { databaseType?: DatabaseType; selectedSchema?: string; referenceSchema?: string | null; clientSessionId?: string }): boolean {
  const schema = options.databaseType === "oceanbase-oracle" ? options.referenceSchema : options.referenceSchema || options.selectedSchema;
  return usesOracleCurrentSchemaCompletion(options.databaseType, schema) && !!options.clientSessionId;
}
