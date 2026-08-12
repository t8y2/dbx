import type { DatabaseType } from "@/types/database";

export type SidebarObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "SYNONYM" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";

export interface DatabaseObjectCapabilities {
  sidebarObjects: SidebarObjectKind[];
  sourceReadable: SidebarObjectKind[];
  executable: SidebarObjectKind[];
}

const TABLE_VIEW_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW"];
const TABLE_VIEW_MV_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW"];

const ROUTINE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION"];
const MYSQL_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER"];

// PostgreSQL-family databases with a verified pg_type listing path. TYPE only
// covers user-created types (enum/domain/composite/range/multirange/base);
// relation auto-generated row types stay hidden.
const POSTGRES_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "TYPE"];

// KWDB is routed through the PostgreSQL pool but its pg_type catalog
// compatibility is not verified yet, so it stays on the pre-TYPE object set.
const POSTGRES_NO_TYPE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE"];

// Kingbase and Vastbase agents support the same user-defined type listing via
// their own metadata query, but do not expose sequences. Kept separate from
// POSTGRES_OBJECTS and POSTGRES_LIKE_OBJECTS so unverified PG-like databases
// (highgo/uxdb/redshift) never advertise TYPE.
const KINGBASE_VASTBASE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TYPE"];

const POSTGRES_LIKE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION"];
const ORACLE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SYNONYM", "PACKAGE", "PACKAGE_BODY"];
const OCEANBASE_ORACLE_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY"];
const DAMENG_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"];
const XUGU_OBJECTS: SidebarObjectKind[] = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "SYNONYM", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY"];
const PACKAGE_MEMBER_EXPANSION_DATABASES = new Set<DatabaseType>(["oracle", "xugu"]);

const DATABASE_TYPE_OBJECTS = new Map<DatabaseType, SidebarObjectKind[]>([
  // postgres
  ["postgres", POSTGRES_OBJECTS],
  ["gaussdb", POSTGRES_OBJECTS],
  ["kwdb", POSTGRES_NO_TYPE_OBJECTS],
  ["opengauss", POSTGRES_OBJECTS],
  // postgres like
  ["kingbase", KINGBASE_VASTBASE_OBJECTS],
  ["highgo", POSTGRES_LIKE_OBJECTS],
  ["uxdb", POSTGRES_LIKE_OBJECTS],
  ["vastbase", KINGBASE_VASTBASE_OBJECTS],
  ["redshift", POSTGRES_LIKE_OBJECTS],
  // oracle
  ["oracle", ORACLE_OBJECTS],
  ["dameng", DAMENG_OBJECTS],
  ["oceanbase-oracle", OCEANBASE_ORACLE_OBJECTS],
  ["xugu", XUGU_OBJECTS],
  ["mysql", MYSQL_OBJECTS],
  // table and view
  ["sqlite", TABLE_VIEW_OBJECTS],
  ["rqlite", TABLE_VIEW_OBJECTS],
  ["turso", TABLE_VIEW_OBJECTS],
  ["cloudflare-d1", TABLE_VIEW_OBJECTS],
  ["duckdb", TABLE_VIEW_OBJECTS],
  ["clickhouse", TABLE_VIEW_OBJECTS],
  // Doris: backend listing path still uses the generic SHOW TABLES path (see
  // `list_tables_once` for `PoolKind::Mysql` in crates/dbx-core/src/schema.rs)
  // and lacks a MV classifier. Keep Doris on TABLE_VIEW_OBJECTS until a
  // Doris-specific MV listing/classification lands, otherwise the UI advertises
  // MV support that the backend cannot route.
  ["doris", TABLE_VIEW_OBJECTS],
  ["starrocks", TABLE_VIEW_MV_OBJECTS],
  ["hive", TABLE_VIEW_OBJECTS],
  ["spark", TABLE_VIEW_OBJECTS],
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
  ["victoriametrics", ["TABLE"]],
  ["hbase", ["TABLE"]],
  ["questdb", ["TABLE", "VIEW", "MATERIALIZED_VIEW"]],
  ["manticoresearch", ["TABLE", "FUNCTION"]],
  ["databend", ["TABLE", "VIEW", "PROCEDURE"]],
]);
/**
 * Whether a kind is readable as object source for the given connection type.
 * TYPE/TYPE_BODY only have a real source implementation on Xugu; PostgreSQL-
 * family databases list types without a CREATE TYPE getter this cycle.
 */
function isSourceReadableObjectKind(kind: SidebarObjectKind, dbType?: DatabaseType): boolean {
  if (kind === "TABLE") return false;
  if (kind === "TYPE" || kind === "TYPE_BODY") return supportsTypeObjectSource(dbType);
  return true;
}

export function databaseObjectCapabilities(dbType?: DatabaseType): DatabaseObjectCapabilities {
  const sidebarObjects = sidebarObjectKindsForDatabase(dbType);
  return {
    sidebarObjects,
    sourceReadable: sidebarObjects.filter((kind) => isSourceReadableObjectKind(kind, dbType)),
    executable: sidebarObjects.filter((kind) => kind === "PROCEDURE"),
  };
}

export function sidebarObjectKindsForDatabase(dbType?: DatabaseType): SidebarObjectKind[] {
  if (!dbType) return [...TABLE_VIEW_OBJECTS];
  return DATABASE_TYPE_OBJECTS.get(dbType) ?? [...ROUTINE_OBJECTS];
}

/**
 * Whether a connection's TYPE tree nodes may be opened as object source.
 *
 * Xugu has a real TYPE/TYPE_BODY source implementation. PostgreSQL-family
 * databases only list user-defined types this cycle; their CREATE TYPE DDL has
 * no unified catalog getter, so opening source would error. Callers must gate
 * the source action (single/double click, context menu, shortcuts) on this
 * before dispatching getObjectSource.
 */
export function supportsTypeObjectSource(dbType?: DatabaseType): boolean {
  return dbType === "xugu";
}

export type CustomTypeCapabilities = {
  details: boolean;
  members: boolean;
  ddl: boolean;
};

const VERIFIED_CUSTOM_TYPE_DATABASES = new Set<DatabaseType>(["postgres", "opengauss", "gaussdb", "kingbase", "vastbase"]);

/**
 * Whether a connection may open read-only custom type details (phase 2).
 * Kept separate from the listing capability so a future per-kind DDL toggle
 * can be introduced without touching the object-list sets.
 */
export function customTypeCapabilities(dbType?: DatabaseType): CustomTypeCapabilities {
  const supported = !!dbType && VERIFIED_CUSTOM_TYPE_DATABASES.has(dbType);
  return { details: supported, members: supported, ddl: supported };
}

export function supportsPackageMemberExpansion(dbType?: DatabaseType): boolean {
  return !!dbType && PACKAGE_MEMBER_EXPANSION_DATABASES.has(dbType);
}

export function normalizeSidebarObjectKind(type: string): SidebarObjectKind {
  const value = type.toUpperCase();
  const normalized = value.replace(/[\s-]+/g, "_");
  if (normalized.includes("PACKAGE_BODY")) return "PACKAGE_BODY";
  if (normalized.includes("TYPE_BODY")) return "TYPE_BODY";
  if (normalized.includes("PACKAGE")) return "PACKAGE";
  if (normalized.includes("TRIGGER")) return "TRIGGER";
  if (normalized.includes("TYPE")) return "TYPE";
  if (normalized.includes("MATERIALIZED_VIEW")) return "MATERIALIZED_VIEW";
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("SEQ")) return "SEQUENCE";
  if (value.includes("SYNONYM")) return "SYNONYM";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}
