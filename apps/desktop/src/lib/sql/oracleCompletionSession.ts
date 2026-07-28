import type { DatabaseType } from "@/types/database";

export function usesOracleSessionCompletionColumns(options: { databaseType?: DatabaseType; selectedSchema?: string; referenceSchema?: string | null; clientSessionId?: string }): boolean {
  return options.databaseType === "oracle" && !options.selectedSchema && !options.referenceSchema && !!options.clientSessionId;
}
