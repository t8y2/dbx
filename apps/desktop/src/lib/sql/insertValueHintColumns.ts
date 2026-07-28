import type { DatabaseType, SqlServerColumnMetadata } from "@/types/database";

type InsertValueHintColumn = Pick<SqlServerColumnMetadata, "name"> & Partial<Pick<SqlServerColumnMetadata, "is_identity" | "is_computed" | "is_hidden" | "generated_always_type">>;

export function insertValueHintColumnNames(databaseType: DatabaseType | undefined, columns: readonly InsertValueHintColumn[]): string[] {
  return columns
    .filter((column) => {
      if (databaseType !== "sqlserver") return true;
      // SQL Server reports computed and temporal period columns independently;
      // check every structured flag so positional VALUES only maps writable columns.
      return !column.is_identity && !column.is_computed && !column.is_hidden && (column.generated_always_type ?? 0) === 0;
    })
    .map((column) => column.name);
}
