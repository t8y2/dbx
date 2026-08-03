/**
 * Thin column factories for the ER diagram.
 *
 * Dialect capability / SQL truth lives in the shared table-structure stack:
 * - `tableStructureCapabilities` (UI gates)
 * - `tableStructureEditorState` (type options / defaults)
 * - Rust `table_structure_sql` via `buildCreateTableSql` / `buildTableStructureChangeSql`
 *
 * Do not add ER-specific dialect matrices or SQL generation here.
 * Adding a dialect: update that shared stack (same checklist as TableStructureEditor).
 */
import type { ColumnInfo, DatabaseType } from "@/types/database";
import { getTableStructureCapabilities, type TableStructureDialect } from "@/lib/table/tableStructureCapabilities";
import { defaultNewColumnDataType, getDataTypeOptions } from "@/lib/table/tableStructureEditorState";

export interface DiagramDialectAdapter {
  databaseType: DatabaseType | undefined;
  createDefaultIdColumn(): ColumnInfo;
  createEmptyColumn(name?: string): ColumnInfo;
}

const DEFAULT_ID_TYPE_BY_DIALECT: Partial<Record<TableStructureDialect, string>> = {
  mysql: "bigint",
  postgres: "bigint",
  sqlserver: "bigint",
  h2: "bigint",
  informix: "bigint",
  oracle: "NUMBER",
  sqlite: "INTEGER",
  duckdb: "INTEGER",
  clickhouse: "UInt64",
};

function resolveDefaultIdType(dialect: TableStructureDialect, dataTypeOptions: readonly string[]): string {
  const preferred = DEFAULT_ID_TYPE_BY_DIALECT[dialect];
  if (preferred) {
    if (dataTypeOptions.length === 0) return preferred;
    const matched = dataTypeOptions.find((type) => type.trim().toLowerCase() === preferred.toLowerCase());
    if (matched) return matched;
  }
  const integerLike = dataTypeOptions.find((type) => /^(bigint|int|integer|number|uint64|int64)/i.test(type.trim()));
  if (integerLike) return integerLike;
  return preferred ?? dataTypeOptions[0] ?? "bigint";
}

export function resolveDiagramDialectAdapter(databaseType?: DatabaseType): DiagramDialectAdapter {
  const caps = getTableStructureCapabilities(databaseType);
  const dataTypeOptions = getDataTypeOptions(databaseType);

  return {
    databaseType,
    createDefaultIdColumn() {
      return {
        name: "id",
        data_type: resolveDefaultIdType(caps.dialect, dataTypeOptions),
        is_nullable: false,
        column_default: null,
        is_primary_key: true,
        comment: null,
        extra: null,
      };
    },
    createEmptyColumn(name = "column_1") {
      return {
        name,
        data_type: defaultNewColumnDataType(databaseType, dataTypeOptions),
        is_nullable: true,
        column_default: null,
        is_primary_key: false,
        comment: null,
        extra: null,
      };
    },
  };
}
