import type { QueryTab, ColumnInfo } from "@/types/database";

export type DataTabTableMeta = NonNullable<QueryTab["tableMeta"]>;

// Data tabs opened from the object browser are titled "<schema>.<table>".
// When the tab has no usable tableMeta yet, strip the schema prefix so SQL
// rebuilt from this fallback does not qualify the table twice
// (e.g. [dbo].[dbo.users] on SQL Server — see issue #3613).
function titleTableName(tab: QueryTab): string {
  const title = tab.title.trim();
  const schema = tab.schema?.trim();
  if (schema && title.length > schema.length + 1 && title.startsWith(`${schema}.`)) {
    return title.slice(schema.length + 1);
  }
  return title;
}

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
  const tableName = tab.tableMeta?.tableName.trim() || titleTableName(tab);
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
