import type { DatabaseType } from "@/types/database";

/**
 * 「在数据库中查找」批量路径(批量取列 + 多表探测)支持的方言,
 * 镜像 Rust `database_search_columns_sql` / `database_search_probe_sql`
 * 的家族判定;两处集合必须同步修改(有单测锁形状)。
 */
const BULK_DATABASE_SEARCH_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "dameng", "mysql", "doris", "starrocks", "manticoresearch", "goldendb", "postgres", "kingbase", "highgo", "uxdb", "vastbase", "opengauss", "gaussdb", "kwdb", "yashandb", "oscar", "redshift", "sqlserver"]);

export function supportsBulkDatabaseSearch(dbType?: DatabaseType): boolean {
  return !!dbType && BULK_DATABASE_SEARCH_TYPES.has(dbType);
}

export { BULK_DATABASE_SEARCH_TYPES };
