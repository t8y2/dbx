import { queryResultSourceNameParts } from "@/lib/sql/queryResultSource";
import type { QueryTab, ColumnInfo, DatabaseType } from "@/types/database";

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

/**
 * Repair the one legacy identity shape known to lose its schema during tab
 * restoration. PostgreSQL permits dots inside quoted identifiers, so the tab
 * title alone is deliberately not split. The persisted SELECT must independently
 * parse to the same schema-qualified source before the identity is migrated.
 */
export function repairRestoredDataTabTableIdentity(tab: QueryTab, databaseType: DatabaseType | undefined): boolean {
  if (databaseType !== "postgres" || tab.mode !== "data" || tab.schema?.trim() || tab.tableMeta?.schema?.trim() || tab.tableMeta?.columns.length) return false;

  const sourceSql = tab.resultBaseSql?.trim() || tab.lastExecutedSql?.trim() || tab.sql.trim();
  const source = queryResultSourceNameParts(sourceSql, { databaseType });
  const title = tab.title.trim();
  if (!source?.qualifier || title !== `${source.qualifier}.${source.name}`) return false;

  const persistedTableName = tab.tableMeta?.tableName.trim();
  if (persistedTableName && persistedTableName !== title && persistedTableName !== source.name) return false;

  tab.schema = source.qualifier;
  tab.tableMeta = {
    ...tab.tableMeta,
    schema: source.qualifier,
    tableName: source.name,
    columns: tab.tableMeta?.columns ?? [],
    primaryKeys: tab.tableMeta?.primaryKeys ?? [],
  };
  return true;
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
    schema: tab.tableMeta?.schema ?? tab.schema,
    tableName,
    columns: (tab.result?.columns ?? []).map(fallbackColumnInfo),
    primaryKeys: tab.tableMeta?.primaryKeys ?? [],
  };
}
