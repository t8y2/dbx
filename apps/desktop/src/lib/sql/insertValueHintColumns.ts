import type { ColumnInfo, DatabaseType } from "@/types/database";

type InsertValueHintColumn = Pick<ColumnInfo, "name" | "extra">;

export function insertValueHintColumnNames(databaseType: DatabaseType | undefined, columns: readonly InsertValueHintColumn[]): string[] {
  return columns.filter((column) => databaseType !== "sqlserver" || !/\bidentity\b/i.test(column.extra ?? "")).map((column) => column.name);
}
