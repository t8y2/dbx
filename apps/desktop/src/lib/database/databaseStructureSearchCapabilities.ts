import type { DatabaseType } from "@/types/database";

/** Engines with a catalog / metadata one-shot structure search path (issue #10413). */
const SQL_STRUCTURE_SEARCH_TYPES = new Set<DatabaseType>([
  "mysql",
  "doris",
  "starrocks",
  "manticoresearch",
  "goldendb",
  "gbase",
  "postgres",
  "kingbase",
  "highgo",
  "uxdb",
  "vastbase",
  "opengauss",
  "gaussdb",
  "kwdb",
  "yashandb",
  "oscar",
  "redshift",
  "sqlite",
  "turso",
  "cloudflare-d1",
  "rqlite",
  "clickhouse",
  "oracle",
  "oceanbase-oracle",
  "dameng",
  "sqlserver",
  "tdengine",
  "snowflake",
  "jdbc",
]);

/** Document / mapping engines searched via dedicated metadata APIs (no SQL catalog). */
const DOCUMENT_STRUCTURE_SEARCH_TYPES = new Set<DatabaseType>(["mongodb", "elasticsearch", "easysearch", "neo4j", "influxdb", "milvus"]);

const JDBC_STRUCTURE_PROFILE_MARKERS = ["mysql", "mariadb", "postgres", "kingbase", "oracle", "dameng", "dm", "doris", "selectdb", "starrocks", "gbase8a"];

export function supportsDatabaseStructureSearch(dbType?: DatabaseType, driverProfile?: string | null): boolean {
  if (!dbType) return false;
  if (SQL_STRUCTURE_SEARCH_TYPES.has(dbType) || DOCUMENT_STRUCTURE_SEARCH_TYPES.has(dbType)) {
    if (dbType !== "jdbc") return true;
    const profile = (driverProfile ?? "").trim().toLowerCase();
    return JDBC_STRUCTURE_PROFILE_MARKERS.some((marker) => profile.includes(marker));
  }
  return false;
}

export function usesSqlCatalogStructureSearch(dbType?: DatabaseType): boolean {
  return !!dbType && SQL_STRUCTURE_SEARCH_TYPES.has(dbType);
}

export function usesDocumentStructureSearch(dbType?: DatabaseType): boolean {
  return !!dbType && DOCUMENT_STRUCTURE_SEARCH_TYPES.has(dbType);
}
