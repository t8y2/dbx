import type { ConnectionConfig, DatabaseType, TreeNodeType } from "@/types/database";

export type DatabaseNamespaceCreationTarget = "database" | "schema" | "attach" | "special";

type ConnectionCreationTarget = Extract<DatabaseNamespaceCreationTarget, "database" | "attach" | "special">;
type DatabaseNodeCreationTarget = Extract<DatabaseNamespaceCreationTarget, "schema">;

export interface DatabaseNamespaceCreationMatrixEntry {
  connection?: ConnectionCreationTarget;
  database?: DatabaseNodeCreationTarget;
  deferred?: string;
}

type CreationConnection = Pick<ConnectionConfig, "db_type" | "driver_profile" | "read_only"> | undefined;

// Keep creation target-specific: many products expose schemas, files, or provider-managed namespaces instead of a top-level database.
export const DATABASE_NAMESPACE_CREATION_MATRIX = {
  mysql: { connection: "database" },
  postgres: { connection: "database", database: "schema" },
  sqlite: { deferred: "file-backed; create a new connection/file instead" },
  rqlite: { deferred: "single SQLite-compatible database per node" },
  turso: { deferred: "remote libSQL database lifecycle is provider-managed" },
  redis: { deferred: "numbered logical databases are server-configured" },
  duckdb: { connection: "attach" },
  clickhouse: { connection: "database" },
  sqlserver: { connection: "database", database: "schema" },
  mongodb: { connection: "special" },
  oracle: { deferred: "Oracle schemas are users; database creation is not a normal connected DDL action" },
  elasticsearch: { deferred: "index creation is not modeled as database creation" },
  qdrant: { deferred: "collection creation is separate from database creation" },
  milvus: { deferred: "collection/database lifecycle needs a dedicated vector workflow" },
  weaviate: { deferred: "collection creation is separate from database creation" },
  chromadb: { deferred: "collection creation is separate from database creation" },
  doris: { connection: "database" },
  starrocks: { connection: "database" },
  manticoresearch: { deferred: "index/table creation is not database creation" },
  databend: { connection: "database" },
  redshift: { connection: "database", database: "schema" },
  dameng: { deferred: "schema/user creation requires a dedicated user workflow" },
  gaussdb: { connection: "database", database: "schema" },
  kingbase: { connection: "database", database: "schema" },
  highgo: { connection: "database", database: "schema" },
  vastbase: { connection: "database", database: "schema" },
  goldendb: { connection: "database" },
  kwdb: { connection: "database", database: "schema" },
  yashandb: { connection: "database", database: "schema" },
  databricks: { database: "schema" },
  saphana: { database: "schema" },
  teradata: { database: "schema" },
  vertica: { database: "schema" },
  firebird: { deferred: "database files are created through connection provisioning" },
  exasol: { database: "schema" },
  opengauss: { connection: "database", database: "schema" },
  "oceanbase-oracle": { deferred: "Oracle-mode schemas are users; use a dedicated user workflow" },
  questdb: { deferred: "single database model in DBX" },
  gbase: { database: "schema" },
  access: { deferred: "file-backed; create a new connection/file instead" },
  h2: { database: "schema" },
  snowflake: { connection: "database", database: "schema" },
  trino: { database: "schema" },
  prestosql: { database: "schema" },
  hive: { deferred: "Hive database creation needs agent metadata validation first" },
  spark: { deferred: "Spark database creation needs agent metadata validation first" },
  db2: { database: "schema" },
  informix: { database: "schema" },
  neo4j: { deferred: "database creation depends on edition/admin privileges" },
  cassandra: { deferred: "keyspace creation requires replication options" },
  bigquery: { deferred: "dataset creation needs project/location options" },
  kylin: { deferred: "project/model lifecycle is not SQL database creation" },
  sundb: { deferred: "creation semantics not verified for first pass" },
  oscar: { database: "schema" },
  tdengine: { connection: "database" },
  xugu: { database: "schema" },
  iotdb: { deferred: "storage group/database semantics need dedicated IoTDB handling" },
  etcd: { deferred: "key-value namespaces are not databases" },
  zookeeper: { deferred: "key-value namespaces are not databases" },
  iris: { database: "schema" },
  influxdb: { connection: "database" },
  jdbc: { deferred: "generic JDBC does not expose a reliable dialect-specific create target" },
  mq: { deferred: "message queue namespaces are handled by MQ admin panels" },
  nacos: { deferred: "Nacos namespace creation already uses the Nacos admin flow" },
} satisfies Record<DatabaseType, DatabaseNamespaceCreationMatrixEntry>;

export function connectionNamespaceCreationTarget(connection: CreationConnection): ConnectionCreationTarget | null {
  if (!connection || connection.read_only) return null;
  if (connection.db_type === "mongodb" && connection.driver_profile === "mongodb-legacy") return null;
  const entry: DatabaseNamespaceCreationMatrixEntry = DATABASE_NAMESPACE_CREATION_MATRIX[connection.db_type];
  return entry.connection ?? null;
}

export function databaseNodeNamespaceCreationTarget(connection: CreationConnection, node: Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">): DatabaseNodeCreationTarget | null {
  if (!connection || connection.read_only || node.type !== "database" || !node.database) return null;
  const entry: DatabaseNamespaceCreationMatrixEntry = DATABASE_NAMESPACE_CREATION_MATRIX[connection.db_type];
  return entry.database ?? null;
}

export function canCreateConnectionNamespace(connection: CreationConnection): boolean {
  return connectionNamespaceCreationTarget(connection) !== null;
}

export function canCreateDatabaseNodeNamespace(connection: CreationConnection, node: Pick<{ type: TreeNodeType; database?: string | null }, "type" | "database">): boolean {
  return databaseNodeNamespaceCreationTarget(connection, node) !== null;
}
