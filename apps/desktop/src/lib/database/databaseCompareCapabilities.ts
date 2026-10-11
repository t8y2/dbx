import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { CONNECTION_PROFILES, type ConnectionProfileDefinition } from "@/types/generated/connectionProfiles";
import { databaseManifestEntry } from "@/lib/database/databaseDriverManifest";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";

export type DatabaseCompareMode = "schema" | "data";

// Comparison loads relational metadata and, for data, generates COUNT/SELECT
// statements. Unknown providers must opt in here rather than pass a blacklist.
const SQL_COMPARE_TYPES = new Set<DatabaseType>([
  "mysql",
  "postgres",
  "sqlite",
  "rqlite",
  "turso",
  "cloudflare-d1",
  "duckdb",
  "clickhouse",
  "sqlserver",
  "oracle",
  "doris",
  "starrocks",
  "manticoresearch",
  "redshift",
  "dameng",
  "kingbase",
  "highgo",
  "uxdb",
  "vastbase",
  "goldendb",
  "databend",
  "gaussdb",
  "kwdb",
  "yashandb",
  "databricks",
  "saphana",
  "teradata",
  "vertica",
  "firebird",
  "exasol",
  "opengauss",
  "questdb",
  "oceanbase-oracle",
  "gbase",
  "access",
  "h2",
  "snowflake",
  "trino",
  "prestosql",
  "hive",
  "argo",
  "transwarp",
  "kyuubi",
  "impala",
  "db2",
  "informix",
  "bigquery",
  "spanner",
  "kylin",
  "ignite",
  "ignite3",
  "sundb",
  "oscar",
  "tdengine",
  "xugu",
  "iotdb",
  "iris",
  "influxdb3",
  "spark",
]);

export function supportsDatabaseCompare(connection: ConnectionConfig | undefined, mode: DatabaseCompareMode): boolean {
  if (!connection) return false;
  const type = effectiveDatabaseTypeForConnection(connection);
  // Keep the two paths explicit: a future driver may support metadata compare
  // without supporting the generated data comparison SQL (or vice versa).
  switch (mode) {
    case "schema":
    case "data":
      return !!type && SQL_COMPARE_TYPES.has(type);
  }
}

const profiles: Readonly<Record<string, ConnectionProfileDefinition>> = CONNECTION_PROFILES;

export function compareConnectionType(connection: ConnectionConfig): { value: string; label: string } {
  const profile = connection.driver_profile;
  const definition = profile ? profiles[profile] : undefined;
  if (profile && definition && definition.type === connection.db_type) {
    return { value: profile, label: definition.label };
  }
  // JDBC remains a distinct connection type, with a product-specific profile
  // when present. Native legacy configs without a profile fall back to db_type.
  if (connection.db_type === "jdbc" && profile) {
    return {
      value: `jdbc:${profile}`,
      label: connection.driver_label || `${databaseManifestEntry(effectiveDatabaseTypeForConnection(connection))?.label || profile} (JDBC)`,
    };
  }
  return { value: connection.db_type, label: databaseManifestEntry(connection.db_type)?.label || connection.driver_label || connection.db_type };
}
