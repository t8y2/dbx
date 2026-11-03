import { compactDdlSql } from "@/lib/sql/ddlCompact";
import { applyDdlStoragePreference } from "@/lib/sql/ddlStorage";
import type { DatabaseType } from "@/types/database";

export function applyDdlTextPreferences(sql: string, databaseType: DatabaseType | undefined, options: { includeDdlStorage: boolean; compactDdlSql: boolean }): string {
  const filtered = applyDdlStoragePreference(sql, databaseType, !options.includeDdlStorage);
  return options.compactDdlSql ? compactDdlSql(filtered, databaseType) : filtered;
}
