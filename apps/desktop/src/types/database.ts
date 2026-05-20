export type DatabaseType =
  | "mysql"
  | "postgres"
  | "sqlite"
  | "redis"
  | "duckdb"
  | "clickhouse"
  | "sqlserver"
  | "mongodb"
  | "oracle"
  | "elasticsearch"
  | "doris"
  | "starrocks"
  | "redshift"
  | "dameng"
  | "gaussdb"
  | "kingbase"
  | "highgo"
  | "vastbase"
  | "goldendb"
  | "yashandb"
  | "databricks"
  | "saphana"
  | "teradata"
  | "vertica"
  | "firebird"
  | "exasol"
  | "opengauss"
  | "oceanbase-oracle"
  | "gbase"
  | "access"
  | "h2"
  | "snowflake"
  | "trino"
  | "hive"
  | "db2"
  | "informix"
  | "neo4j"
  | "cassandra"
  | "bigquery"
  | "kylin"
  | "sundb"
  | "tdengine"
  | "jdbc";

export interface ConnectionConfig {
  id: string;
  name: string;
  db_type: DatabaseType;
  driver_profile?: string;
  driver_label?: string;
  url_params?: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  visible_databases?: string[];
  attached_databases?: AttachedDatabaseConfig[];
  color?: string;
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key_path?: string;
  ssh_key_passphrase?: string;
  ssh_expose_lan?: boolean;
  ssh_connect_timeout_secs?: number;
  proxy_enabled?: boolean;
  proxy_type?: "socks5" | "http";
  proxy_host?: string;
  proxy_port?: number;
  proxy_username?: string;
  proxy_password?: string;
  ssl?: boolean;
  sysdba?: boolean;
  oracle_connection_type?: "service_name" | "sid";
  connection_string?: string;
  jdbc_driver_class?: string;
  jdbc_driver_paths?: string[];
  one_time?: boolean;
}

export interface AttachedDatabaseConfig {
  name: string;
  path: string;
}

export interface PluginDriverManifest {
  id: string;
  label: string;
  kind: string;
  database_type?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  protocol_version?: number;
  description?: string;
  executable?: string;
  drivers: PluginDriverManifest[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  path: string;
}

export interface JdbcDriverInfo {
  name: string;
  path: string;
  size: number;
}

export interface JdbcPluginStatus {
  installed: boolean;
  version?: string | null;
  protocol_version?: number | null;
  compatible: boolean;
  latest_version?: string | null;
  latest_protocol_version?: number | null;
  update_available: boolean;
  path: string;
}

export interface DatabaseInfo {
  name: string;
}

export interface TableInfo {
  name: string;
  table_type: string;
  comment?: string | null;
}

export type DatabaseObjectType = "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION";

export interface ObjectInfo {
  name: string;
  object_type: DatabaseObjectType | string;
  schema?: string | null;
  comment?: string | null;
}

export type ObjectSourceKind = "VIEW" | "PROCEDURE" | "FUNCTION";

export interface ObjectSource {
  name: string;
  object_type: ObjectSourceKind;
  schema?: string | null;
  source: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  column_default: string | null;
  is_primary_key: boolean;
  extra: string | null;
  comment?: string | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  character_maximum_length?: number | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  filter?: string | null;
  index_type?: string | null;
  included_columns?: string[] | null;
  comment?: string | null;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  ref_table: string;
  ref_column: string;
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
}

export interface QueryResult {
  columns: string[];
  rows: (string | number | boolean | null)[][];
  affected_rows: number;
  execution_time_ms: number;
  truncated?: boolean;
  session_id?: string | null;
  has_more?: boolean;
}

export type TreeNodeType =
  | "connection"
  | "connection-group"
  | "database"
  | "schema"
  | "table"
  | "view"
  | "procedure"
  | "function"
  | "group-columns"
  | "group-indexes"
  | "group-fkeys"
  | "group-triggers"
  | "group-tables"
  | "group-views"
  | "group-procedures"
  | "group-functions"
  | "object-browser"
  | "saved-sql-root"
  | "saved-sql-folder"
  | "saved-sql-file"
  | "column"
  | "index"
  | "fkey"
  | "trigger"
  | "redis-db"
  | "mongo-db"
  | "mongo-collection";

export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export type SidebarOrderEntry =
  | { type: "group"; id: string; connectionIds: string[] }
  | { type: "connection"; id: string };

export interface SidebarLayout {
  groups: ConnectionGroup[];
  order: SidebarOrderEntry[];
}

export interface TreeNode {
  id: string;
  label: string;
  type: TreeNodeType;
  children?: TreeNode[];
  isLoading?: boolean;
  isExpanded?: boolean;
  pinned?: boolean;
  connectionId?: string;
  database?: string;
  schema?: string;
  tableName?: string;
  objectCount?: number;
  loadedKeyCount?: number;
  totalKeyCount?: number;
  hiddenChildren?: TreeNode[];
  savedSqlId?: string;
  savedSqlFolderId?: string;
  meta?: ColumnInfo | IndexInfo | ForeignKeyInfo | TriggerInfo;
}

export interface QueryTab {
  id: string;
  title: string;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  savedSqlId?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultSessionId?: string;
  pinned?: boolean;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  explainPlan?: import("@/lib/explainPlan").ParsedExplainPlan;
  explainError?: string;
  explainSql?: string;
  lastExplainedSql?: string;
  isExecuting: boolean;
  isCancelling?: boolean;
  executionId?: string;
  isExplaining?: boolean;
  explainExecutionId?: string;
  mode: "data" | "query" | "redis" | "mongo" | "objects";
  objectBrowser?: {
    schema?: string;
    objectType?: "tables";
  };
  objectSource?: {
    schema?: string;
    name: string;
    objectType: ObjectSourceKind;
  };
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  queryAnalysis?: {
    schema?: string;
    tableName: string;
    tableAlias?: string;
    selectStar: boolean;
    columns: {
      sourceName?: string;
      resultName: string;
      expression: string;
    }[];
  };
  querySourceColumns?: Array<string | undefined>;
  queryEditabilityReason?:
    | "not-select"
    | "cte"
    | "set-operation"
    | "aggregation"
    | "complex-source"
    | "computed-columns"
    | "no-table"
    | "no-primary-key"
    | "primary-key-not-returned"
    | "aliased-columns"
    | "metadata-unavailable";
  whereInput?: string;
}

export interface SavedSqlFolder {
  id: string;
  connectionId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSqlFile {
  id: string;
  connectionId: string;
  folderId?: string;
  name: string;
  database: string;
  schema?: string;
  sql: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSqlLibrary {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}
