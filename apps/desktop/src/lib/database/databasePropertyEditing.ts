import type { ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";
import { supportsCreateDatabaseCharset } from "@/lib/database/createDatabaseSql";

export type DatabasePropertyEditGroup = "charsetCollation" | "databaseComment" | "schemaComment";

export interface DatabasePropertyEditingEntry {
  database?: DatabasePropertyEditGroup[];
  schema?: DatabasePropertyEditGroup[];
  deferred?: string;
}

type PropertyEditConnection = Pick<ConnectionConfig, "db_type" | "driver_profile" | "read_only"> | undefined;
type DatabaseNode = Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">;
type SchemaNode = Pick<{ type: TreeNodeType; database?: string | null; schema?: string | null }, "type" | "database" | "schema">;

const POSTGRES_COMMENT_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "kwdb", "kingbase", "highgo", "vastbase", "opengauss", "yashandb"]);

export const DATABASE_PROPERTY_EDITING_MATRIX = {
  mysql: { database: ["charsetCollation"] },
  postgres: { database: ["databaseComment"], schema: ["schemaComment"] },
  sqlite: { deferred: "file-backed database properties are not edited in-place" },
  rqlite: { deferred: "single SQLite-compatible database per node" },
  turso: { deferred: "remote libSQL database lifecycle is provider-managed" },
  redis: { deferred: "numbered logical databases are server-configured" },
  duckdb: { deferred: "attached database file properties need a dedicated DuckDB workflow" },
  clickhouse: { deferred: "database property editing not verified for first pass" },
  sqlserver: { deferred: "database options are broad administrative settings and need a dedicated editor" },
  mongodb: { deferred: "database options are not modeled as SQL database properties" },
  oracle: { deferred: "Oracle database properties are instance/user/tablespace administration" },
  elasticsearch: { deferred: "index settings are not database properties" },
  qdrant: { deferred: "collection settings are not database properties" },
  milvus: { deferred: "collection/database settings need a dedicated vector workflow" },
  weaviate: { deferred: "collection settings are not database properties" },
  chromadb: { deferred: "collection settings are not database properties" },
  doris: { deferred: "database collation metadata is MySQL-compatible only and not an editable database default" },
  starrocks: { deferred: "ALTER DATABASE edits quota/rename/storage volume, not charset/collation defaults" },
  manticoresearch: { deferred: "index/table settings are not database properties" },
  databend: { deferred: "database property editing not verified for first pass" },
  redshift: { deferred: "comment catalog compatibility not verified for first pass" },
  dameng: { deferred: "schema/user settings need a dedicated workflow" },
  gaussdb: { database: ["databaseComment"], schema: ["schemaComment"] },
  kingbase: { database: ["databaseComment"], schema: ["schemaComment"] },
  highgo: { database: ["databaseComment"], schema: ["schemaComment"] },
  vastbase: { database: ["databaseComment"], schema: ["schemaComment"] },
  goldendb: { database: ["charsetCollation"] },
  kwdb: { database: ["databaseComment"], schema: ["schemaComment"] },
  yashandb: { database: ["databaseComment"], schema: ["schemaComment"] },
  databricks: { deferred: "catalog/schema properties need warehouse-specific handling" },
  saphana: { deferred: "schema properties need product-specific handling" },
  teradata: { deferred: "database properties need product-specific handling" },
  vertica: { deferred: "schema properties need product-specific handling" },
  firebird: { deferred: "database files are managed through connection provisioning" },
  exasol: { deferred: "schema properties need product-specific handling" },
  opengauss: { database: ["databaseComment"], schema: ["schemaComment"] },
  "oceanbase-oracle": { deferred: "Oracle-mode schemas are users; use a dedicated user workflow" },
  questdb: { deferred: "single database model in DBX" },
  gbase: { deferred: "schema properties need product-specific handling" },
  access: { deferred: "file-backed database properties are not edited in-place" },
  h2: { deferred: "schema properties need product-specific handling" },
  snowflake: { deferred: "database/schema properties need Snowflake-specific options" },
  trino: { deferred: "catalog properties are connector-managed" },
  prestosql: { deferred: "catalog properties are connector-managed" },
  hive: { deferred: "database properties need agent metadata validation first" },
  spark: { deferred: "database properties need agent metadata validation first" },
  db2: { deferred: "schema properties need product-specific handling" },
  informix: { deferred: "schema properties need product-specific handling" },
  neo4j: { deferred: "database properties depend on edition/admin privileges" },
  cassandra: { deferred: "keyspace properties require replication option handling" },
  bigquery: { deferred: "dataset properties need project/location-specific handling" },
  kylin: { deferred: "project/model lifecycle is not SQL database property editing" },
  sundb: { deferred: "property semantics not verified for first pass" },
  oscar: { deferred: "schema properties need product-specific handling" },
  tdengine: { deferred: "database property editing not verified for first pass" },
  xugu: { deferred: "schema properties need product-specific handling" },
  iotdb: { deferred: "storage group/database semantics need dedicated IoTDB handling" },
  etcd: { deferred: "key-value namespaces are not databases" },
  zookeeper: { deferred: "key-value namespaces are not databases" },
  iris: { deferred: "schema properties need product-specific handling" },
  influxdb: { deferred: "database retention policies need a dedicated workflow" },
  jdbc: { deferred: "generic JDBC does not expose reliable dialect-specific properties" },
  mq: { deferred: "message queue namespaces are handled by MQ admin panels" },
  nacos: { deferred: "Nacos namespace editing already uses the Nacos admin flow" },
} satisfies Record<DatabaseType, DatabasePropertyEditingEntry>;

function entryFor(connection: PropertyEditConnection): DatabasePropertyEditingEntry | null {
  if (!connection || connection.read_only) return null;
  return DATABASE_PROPERTY_EDITING_MATRIX[connection.db_type] ?? null;
}

export function editableDatabasePropertyGroups(connection: PropertyEditConnection, node: DatabaseNode): DatabasePropertyEditGroup[] {
  if (node.type !== "database" || !node.database) return [];
  const groups = entryFor(connection)?.database ?? [];
  return groups.filter((group) => group !== "charsetCollation" || supportsCreateDatabaseCharset(connection?.db_type, connection?.driver_profile));
}

export function editableSchemaPropertyGroups(connection: PropertyEditConnection, node: SchemaNode): DatabasePropertyEditGroup[] {
  if (node.type !== "schema" || !node.database) return [];
  return entryFor(connection)?.schema ?? [];
}

export function canEditDatabaseProperties(connection: PropertyEditConnection, node: DatabaseNode): boolean {
  return editableDatabasePropertyGroups(connection, node).length > 0;
}

export function canEditSchemaProperties(connection: PropertyEditConnection, node: SchemaNode): boolean {
  return editableSchemaPropertyGroups(connection, node).length > 0;
}

export function supportsPostgresStyleComments(databaseType?: DatabaseType): boolean {
  return !!databaseType && POSTGRES_COMMENT_TYPES.has(databaseType);
}
