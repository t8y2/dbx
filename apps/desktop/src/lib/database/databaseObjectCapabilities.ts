import type { DatabaseType } from "@/types/database";

export type SidebarObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY";

export interface DatabaseObjectCapabilities {
  sidebarObjects: SidebarObjectKind[];
  sourceReadable: SidebarObjectKind[];
  executable: SidebarObjectKind[];
}

const TABLE_VIEW_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW"];

const ROUTINE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"];

const POSTGRES_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"];
const POSTGRES_LIKE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION"];
const ORACLE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"];

const DATABASE_TYPE_OBJECTS = new Map<DatabaseType, SidebarObjectKind[]>([
  // postgres
  ["postgres", POSTGRES_OBJECTS],
  ["gaussdb", POSTGRES_OBJECTS],
  ["kwdb", POSTGRES_OBJECTS],
  ["opengauss", POSTGRES_OBJECTS],
  // postgres like
  ["kingbase", POSTGRES_LIKE_OBJECTS],
  ["highgo", POSTGRES_LIKE_OBJECTS],
  ["vastbase", POSTGRES_LIKE_OBJECTS],
  ["redshift", POSTGRES_LIKE_OBJECTS],
  // oracle
  ["oracle", ORACLE_OBJECTS],
  ["dameng", ORACLE_OBJECTS],
  ["oceanbase-oracle", ORACLE_OBJECTS],
  // table and view
  ["sqlite", TABLE_VIEW_OBJECTS],
  ["rqlite", TABLE_VIEW_OBJECTS],
  ["turso", TABLE_VIEW_OBJECTS],
  ["duckdb", TABLE_VIEW_OBJECTS],
  ["clickhouse", TABLE_VIEW_OBJECTS],
  ["doris", TABLE_VIEW_OBJECTS],
  ["starrocks", TABLE_VIEW_OBJECTS],
  ["hive", TABLE_VIEW_OBJECTS],
  ["trino", TABLE_VIEW_OBJECTS],
  ["prestosql", TABLE_VIEW_OBJECTS],
  ["cassandra", TABLE_VIEW_OBJECTS],
  ["bigquery", TABLE_VIEW_OBJECTS],
  ["kylin", TABLE_VIEW_OBJECTS],
  ["tdengine", TABLE_VIEW_OBJECTS],
  ["iotdb", TABLE_VIEW_OBJECTS],
  ["neo4j", TABLE_VIEW_OBJECTS],
  // others
  ["influxdb", ["TABLE"]],
  ["questdb", ["TABLE", "VIEW", "MATERIALIZED_VIEW"]],
  ["manticoresearch", ["TABLE", "FUNCTION"]],
  ["databend", ["TABLE", "VIEW", "PROCEDURE"]],
]);
export function databaseObjectCapabilities(dbType?: DatabaseType): DatabaseObjectCapabilities {
  const sidebarObjects = sidebarObjectKindsForDatabase(dbType);
  return {
    sidebarObjects,
    sourceReadable: sidebarObjects.filter((kind) => kind !== "TABLE"),
    executable: sidebarObjects.filter((kind) => kind === "PROCEDURE"),
  };
}

export function sidebarObjectKindsForDatabase(dbType?: DatabaseType): SidebarObjectKind[] {
  if (!dbType) return [...TABLE_VIEW_OBJECTS];
  return DATABASE_TYPE_OBJECTS.get(dbType) ?? [...ROUTINE_OBJECTS];
}

export function normalizeSidebarObjectKind(type: string): SidebarObjectKind {
  const value = type.toUpperCase();
  const normalized = value.replace(/[\s-]+/g, "_");
  if (normalized.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (normalized.includes("PACKAGE")) return "PACKAGE";
  if (normalized.includes("MATERIALIZED_VIEW")) return "MATERIALIZED_VIEW";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}
