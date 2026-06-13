import type { ConnectionConfig, DatabaseType } from "@/types/database";

const SYSTEM_DATABASE_RULES: Partial<Record<DatabaseType, ReadonlySet<string>>> = {
  mysql: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  doris: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  starrocks: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  manticoresearch: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  goldendb: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  gbase: new Set(["information_schema", "mysql", "performance_schema", "sys"]),
  postgres: new Set(["template0", "template1"]),
  gaussdb: new Set(["template0", "template1"]),
  kwdb: new Set(["template0", "template1"]),
  opengauss: new Set(["template0", "template1"]),
  kingbase: new Set(["template0", "template1"]),
  highgo: new Set(["template0", "template1"]),
  vastbase: new Set(["template0", "template1"]),
  redshift: new Set(["template0", "template1"]),
  clickhouse: new Set(["information_schema", "system"]),
  sqlserver: new Set(["master", "model", "msdb", "tempdb"]),
  mongodb: new Set(["admin", "config", "local"]),
  oracle: new Set([
    "anonymous",
    "appqossys",
    "audsys",
    "ctxsys",
    "dbsnmp",
    "dip",
    "dvf",
    "dvsys",
    "exfsys",
    "flows_files",
    "gsmadmin_internal",
    "mddata",
    "mdsys",
    "mgmt_view",
    "olapsys",
    "orddata",
    "ordplugins",
    "ordsys",
    "outln",
    "owbsys",
    "remote_scheduler_agent",
    "si_informtn_schema",
    "sys",
    "sysback",
    "sysdg",
    "syskm",
    "system",
    "wmsys",
    "xdb",
    "xs$null",
  ]),
  dameng: new Set(["ctisys", "dba", "sys", "sysauditor", "sysdba", "syssso", "system"]),
  saphana: new Set(["_sys_afl", "_sys_bi", "_sys_bic", "_sys_repo", "_sys_statistics", "sys"]),
  cassandra: new Set(["system", "system_auth", "system_distributed", "system_schema", "system_traces", "system_views", "system_virtual_schema"]),
  neo4j: new Set(["system"]),
  snowflake: new Set(["snowflake", "snowflake_sample_data"]),
};

export function visibleDatabaseFilterIsEnabled(visibleDatabases: string[] | undefined): boolean {
  return Array.isArray(visibleDatabases);
}

export function canSaveVisibleDatabaseSelection(selectedNames: string[]): boolean {
  return selectedNames.length > 0;
}

export function filterVisibleDatabaseNames(databaseNames: string[], visibleDatabases: string[] | undefined): string[] {
  if (!visibleDatabaseFilterIsEnabled(visibleDatabases)) return databaseNames;
  const visible = new Set(visibleDatabases);
  return databaseNames.filter((name) => visible.has(name));
}

export function normalizeVisibleDatabaseSelection(selectedNames: string[], databaseNames: string[]): string[] {
  const available = new Set(databaseNames);
  const seen = new Set<string>();
  return selectedNames.filter((name) => {
    if (!available.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export function isSystemDatabaseName(databaseType: DatabaseType | undefined, databaseName: string): boolean {
  if (!databaseType) return false;
  return SYSTEM_DATABASE_RULES[databaseType]?.has(databaseName.toLowerCase()) ?? false;
}

export function filterDatabaseNamesForConnection(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile" | "visible_databases"> | undefined): string[] {
  const visibleDatabases = connection?.visible_databases;
  if (visibleDatabaseFilterIsEnabled(visibleDatabases)) {
    return filterVisibleDatabaseNames(databaseNames, visibleDatabases);
  }
  if (connection?.db_type === "gbase" && connection.driver_profile === "gbase8s") {
    return databaseNames;
  }
  return databaseNames.filter((name) => !isSystemDatabaseName(connection?.db_type, name));
}
