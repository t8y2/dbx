import type { QueryTab, ColumnInfo } from "@/types/database";

export type DataTabTableMeta = NonNullable<QueryTab["tableMeta"]>;

function fallbackColumnInfo(name: string): ColumnInfo {
  return {
    name,
    data_type: "",
    is_nullable: true,
    column_default: null,
    is_primary_key: false,
    extra: null,
  };
}

export function tableMetaForDataTab(tab: QueryTab | undefined): DataTabTableMeta | undefined {
  if (!tab || tab.mode !== "data") return undefined;
  if (tab.tableMeta?.columns.length) return tab.tableMeta;
  const tableName = tab.title.trim();
  if (!tableName) return undefined;

  // Keep filters usable when the table identity loaded but its column metadata did not.
  return {
    ...tab.tableMeta,
    schema: tab.schema,
    tableName,
    columns: (tab.result?.columns ?? []).map(fallbackColumnInfo),
    primaryKeys: tab.tableMeta?.primaryKeys ?? [],
  };
}
