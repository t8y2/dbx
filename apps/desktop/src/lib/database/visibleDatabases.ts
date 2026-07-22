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
  questdb: new Set(["template0", "template1"]),
  kingbase: new Set(["template0", "template1"]),
  highgo: new Set(["template0", "template1"]),
  vastbase: new Set(["template0", "template1"]),
  redshift: new Set(["template0", "template1"]),
  clickhouse: new Set(["information_schema", "system"]),
  tdengine: new Set(["information_schema", "performance_schema"]),
  sqlserver: new Set(["master", "model", "msdb", "tempdb"]),
  mongodb: new Set(["admin", "config", "local"]),
  oracle: new Set([
    "anonymous",
    "appqossys",
    "audsys",
    "ctxsys",
    "dbsnmp",
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
  dameng: new Set(["_sys_statistics", "ctisys", "dba", "sys", "sys_dba", "sys_phm", "sysauditor", "sysdba", "sysdbo", "syssso", "system"]),
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
  return filterDatabaseNamesForVisiblePicker(databaseNames, connection);
}

export function filterDatabaseNamesForVisiblePicker(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined): string[] {
  if (connection?.db_type === "gbase" && connection.driver_profile === "gbase8s") {
    return databaseNames;
  }
  return databaseNames.filter((name) => !isSystemDatabaseName(connection?.db_type, name));
}

export function filterSchemaNamesForVisiblePicker(schemaNames: string[], connection: Partial<Pick<ConnectionConfig, "db_type" | "username">> | undefined): string[] {
  const currentSchema = connection?.username?.trim().toLowerCase();
  return schemaNames.filter((name) => name.toLowerCase() === currentSchema || !isSystemDatabaseName(connection?.db_type, name));
}

export function connectionUsesVisibleSchemaFilter(connection: Pick<ConnectionConfig, "db_type"> | undefined): boolean {
  return connection?.db_type === "oracle" || connection?.db_type === "dameng" || connection?.db_type === "oceanbase-oracle";
}

export function visibleSchemaFilterIsEnabled(visibleSchemas: Record<string, string[]> | undefined, database: string): boolean {
  return Array.isArray(visibleSchemas?.[database]);
}

export function filterSchemaNamesForConnection(schemaNames: string[], connection: (Pick<ConnectionConfig, "db_type" | "visible_schemas" | "visible_databases"> & Partial<Pick<ConnectionConfig, "username">>) | undefined, database: string): string[] {
  const visibleSchemas = connection?.visible_schemas;
  if (!visibleSchemaFilterIsEnabled(visibleSchemas, database)) {
    if (connectionUsesVisibleSchemaFilter(connection) && visibleDatabaseFilterIsEnabled(connection?.visible_databases)) {
      return filterVisibleDatabaseNames(schemaNames, connection?.visible_databases);
    }
    return filterSchemaNamesForVisiblePicker(schemaNames, connection);
  }
  const visible = new Set(visibleSchemas![database]);
  return schemaNames.filter((name) => visible.has(name));
}

export function normalizeVisibleSchemaSelection(selectedNames: string[], schemaNames: string[]): string[] {
  const available = new Set(schemaNames);
  const seen = new Set<string>();
  return selectedNames.filter((name) => {
    if (!available.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

const DRAFT_VISIBLE_SCHEMAS_PREFIX = "__visible_schema_draft_";

export function buildDraftVisibleSchemasConnectionId(seed: string): string {
  return `${DRAFT_VISIBLE_SCHEMAS_PREFIX}${seed}`;
}
