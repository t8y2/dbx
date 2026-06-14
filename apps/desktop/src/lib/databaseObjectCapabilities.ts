import type { DatabaseType } from "@/types/database";

export type SidebarObjectKind = "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY";

export interface DatabaseObjectCapabilities {
  sidebarObjects: SidebarObjectKind[];
  sourceReadable: SidebarObjectKind[];
  executable: SidebarObjectKind[];
}

const TABLE_VIEW_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW"];
const TABLE_FUNCTION_OBJECTS: SidebarObjectKind[] = ["TABLE", "FUNCTION"];
const ROUTINE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"];
const POSTGRES_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"];
const ORACLE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"];

const TABLE_FUNCTION_TYPES = new Set<DatabaseType>(["manticoresearch"]);
const TABLE_VIEW_ONLY_TYPES = new Set<DatabaseType>(["sqlite", "rqlite", "turso", "duckdb", "clickhouse", "doris", "starrocks", "databend", "hive", "trino", "cassandra", "bigquery", "kylin", "tdengine", "iotdb", "neo4j"]);

const ORACLE_PACKAGE_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle"]);
const POSTGRES_SEQUENCE_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "kwdb", "opengauss"]);

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
  if (ORACLE_PACKAGE_TYPES.has(dbType)) return [...ORACLE_OBJECTS];
  if (TABLE_FUNCTION_TYPES.has(dbType)) return [...TABLE_FUNCTION_OBJECTS];
  if (TABLE_VIEW_ONLY_TYPES.has(dbType)) return [...TABLE_VIEW_OBJECTS];
  if (POSTGRES_SEQUENCE_TYPES.has(dbType)) return [...POSTGRES_OBJECTS];
  return [...ROUTINE_OBJECTS];
}

export function normalizeSidebarObjectKind(type: string): SidebarObjectKind {
  const value = type.toUpperCase();
  if (value.includes("PACKAGE BODY") || value.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (value.includes("PACKAGE")) return "PACKAGE";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}