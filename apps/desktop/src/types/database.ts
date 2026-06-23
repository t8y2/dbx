export type DatabaseType =
  | "mysql"
  | "postgres"
  | "sqlite"
  | "rqlite"
  | "turso"
  | "redis"
  | "duckdb"
  | "clickhouse"
  | "sqlserver"
  | "mongodb"
  | "oracle"
  | "elasticsearch"
  | "qdrant"
  | "milvus"
  | "doris"
  | "starrocks"
  | "manticoresearch"
  | "databend"
  | "redshift"
  | "dameng"
  | "gaussdb"
  | "kingbase"
  | "highgo"
  | "vastbase"
  | "goldendb"
  | "kwdb"
  | "yashandb"
  | "databricks"
  | "saphana"
  | "teradata"
  | "vertica"
  | "firebird"
  | "exasol"
  | "opengauss"
  | "oceanbase-oracle"
  | "questdb"
  | "gbase"
  | "access"
  | "h2"
  | "snowflake"
  | "trino"
  | "prestosql"
  | "hive"
  | "db2"
  | "informix"
  | "neo4j"
  | "cassandra"
  | "bigquery"
  | "kylin"
  | "sundb"
  | "tdengine"
  | "xugu"
  | "iotdb"
  | "etcd"
  | "iris"
  | "influxdb"
  | "jdbc"
  | "mq"
  | "nacos";

export interface SqlSnippet {
  id: string;
  label: string;
  prefix: string;
  body: string;
}

export type CompletionAssistantObjectKind = "database" | "schema" | "table" | "view" | "routine" | "procedure" | "function" | "column";

export type CompletionAssistantCandidateKind = "database" | "schema" | "table" | "view" | "procedure" | "function" | "column" | "object";

export type CompletionAssistantMatchMode = "prefix" | "contains";

export interface CompletionAssistantRequest {
  connection_id: string;
  database: string;
  schema?: string | null;
  object_kinds?: CompletionAssistantObjectKind[];
  mask?: string;
  case_sensitive?: boolean;
  global_search?: boolean;
  max_results?: number | null;
  search_in_comments?: boolean;
  search_in_definitions?: boolean;
  parent_schema?: string | null;
  parent_name?: string | null;
  match_mode?: CompletionAssistantMatchMode | null;
}

export interface CompletionAssistantCandidate {
  name: string;
  kind: CompletionAssistantCandidateKind;
  database?: string | null;
  schema?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
  comment?: string | null;
  data_type?: string | null;
}

export interface CompletionAssistantResponse {
  candidates: CompletionAssistantCandidate[];
  incomplete: boolean;
  fallback_used: boolean;
}

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
  transport_layers?: TransportLayerConfig[];
  connect_timeout_secs?: number;
  query_timeout_secs?: number;
  idle_timeout_secs?: number;
  keepalive_interval_secs?: number;
  ssl?: boolean;
  ca_cert_path?: string;
  client_cert_path?: string;
  client_key_path?: string;
  sysdba?: boolean;
  oracle_connection_type?: "service_name" | "sid";
  connection_string?: string;
  jdbc_driver_class?: string;
  jdbc_driver_paths?: string[];
  redis_connection_mode?: "standalone" | "sentinel" | "cluster";
  redis_sentinel_master?: string;
  redis_sentinel_nodes?: string;
  redis_sentinel_username?: string;
  redis_sentinel_password?: string;
  redis_sentinel_tls?: boolean;
  redis_cluster_nodes?: string;
  redis_key_separator?: string;
  etcd_endpoints?: string;
  gbase_server?: string;
  informix_server?: string;
  external_config?: unknown;
  one_time?: boolean;
  read_only?: boolean;
}

export type TransportLayerConfig = ({ type: "ssh" } & SshTunnelConfig) | ({ type: "proxy" } & ProxyTunnelConfig);

export interface SshTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  host: string;
  port: number;
  user: string;
  password?: string;
  key_path?: string;
  key_passphrase?: string;
  connect_timeout_secs?: number;
  expose_lan?: boolean;
  use_ssh_agent?: boolean;
  ssh_agent_sock_path?: string;
}

export interface ProxyTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  proxy_type?: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
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
  bundle_id?: string | null;
}

export interface JdbcMavenArtifactInfo {
  group_id: string;
  artifact_id: string;
  version: string;
  classifier: string;
  extension: string;
  file_name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface JdbcMavenBundleInfo {
  id: string;
  coordinate: string;
  scope: string;
  repositories: string[];
  installed_at: string;
  path: string;
  artifacts: JdbcMavenArtifactInfo[];
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

export interface LinkedServerInfo {
  name: string;
  product?: string | null;
  provider?: string | null;
  data_source?: string | null;
}

export interface TableInfo {
  name: string;
  table_type: string;
  comment?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
}

export type DatabaseObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY";

export interface ObjectInfo {
  name: string;
  object_type: DatabaseObjectType | string;
  schema?: string | null;
  comment?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
}

export interface ObjectStatistics {
  name: string;
  schema?: string | null;
  estimated_rows?: number | null;
  total_bytes?: number | null;
}

export type ObjectSourceKind = "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY";

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
  ref_schema?: string | null;
  ref_table: string;
  ref_column: string;
  on_update?: string | null;
  on_delete?: string | null;
}

export interface TriggerInfo {
  name: string;
  event: string;
  timing: string;
  statement?: string | null;
}

export interface FunctionInfo {
  name: string;
  function_type: string;
  data_type: string;
  definition: string;
  arguments: string;
}

export interface SequenceInfo {
  name: string;
  data_type: string;
  start_value: string;
  min_value: string;
  max_value: string;
  increment: string;
  cycle: boolean;
  last_value?: string | null;
}

export interface RuleInfo {
  name: string;
  table_name: string;
  definition: string;
}

export interface OwnerInfo {
  object_name: string;
  object_type: string;
  owner: string;
}

export interface QueryResult {
  columns: string[];
  /**
   * Database type name for each column, parallel to `columns`. Optional and may
   * be shorter/empty when a driver cannot supply types (schemaless stores,
   * fallback query paths, older backends). Consumers must tolerate gaps.
   */
  column_types?: string[];
  /**
   * Sortable for each column. Parallel to `columns`. Optional and may
   * be shorter/empty when a driver cannot supply sortable information.
   */
  column_sortables?: boolean[];
  rows: (string | number | boolean | null)[][];
  affected_rows: number;
  execution_time_ms: number;
  truncated?: boolean;
  session_id?: string | null;
  has_more?: boolean;
}

export interface QueryResultRun {
  id: string;
  title: string;
  sequence: number;
  sql: string;
  createdAt: number;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  resultBaseSql?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  orderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultAccessedAt?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  resultEvicted?: boolean;
  queryAnalysis?: QueryTab["queryAnalysis"];
  querySourceColumns?: QueryTab["querySourceColumns"];
  queryEditabilityReason?: QueryTab["queryEditabilityReason"];
  tableMeta?: QueryTab["tableMeta"];
}

export interface SqlTextSpan {
  start_line: number;
  start_column: number;
  end_line: number;
  end_column: number;
}

export interface SqlTableReference {
  name: string;
  schema?: string | null;
  alias?: string | null;
  span: SqlTextSpan;
}

export interface SqlColumnReference {
  name: string;
  qualifier?: string | null;
  span: SqlTextSpan;
}

export interface SqlReferenceAnalysis {
  tables: SqlTableReference[];
  columns: SqlColumnReference[];
}

export type TreeNodeType =
  | "connection"
  | "connection-group"
  | "database"
  | "linked-server-root"
  | "linked-server"
  | "linked-server-catalog"
  | "linked-server-schema"
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "sequence"
  | "package"
  | "package-body"
  | "group-columns"
  | "group-indexes"
  | "group-fkeys"
  | "group-triggers"
  | "group-tables"
  | "group-views"
  | "group-materialized-views"
  | "group-procedures"
  | "group-functions"
  | "group-sequences"
  | "group-packages"
  | "group-partitions"
  | "object-browser"
  | "user-admin"
  | "saved-sql-root"
  | "saved-sql-folder"
  | "saved-sql-file"
  | "load-more"
  | "column"
  | "index"
  | "fkey"
  | "trigger"
  | "redis-db"
  | "mq-tenant"
  | "nacos-namespace"
  | "etcd-root"
  | "mongo-db"
  | "mongo-collection"
  | "vector-collection"
  | "elasticsearch-index";

export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export type SidebarOrderEntry = { type: "group"; id: string; children?: SidebarOrderEntry[]; connectionIds?: string[] } | { type: "connection"; id: string };

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
  linkedServer?: string;
  linkedCatalog?: string;
  linkedSchema?: string;
  mqTenant?: string;
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  schema?: string;
  tableName?: string;
  tableType?: string;
  comment?: string | null;
  objectCount?: number;
  loadedKeyCount?: number;
  totalKeyCount?: number;
  partitionParentSchema?: string;
  partitionParentName?: string;
  hiddenChildren?: TreeNode[];
  savedSqlId?: string;
  savedSqlFolderId?: string;
  meta?: ColumnInfo | IndexInfo | ForeignKeyInfo | TriggerInfo;
  loadMore?: {
    parentId: string;
    offset: number;
    pageSize: number;
  };
}

export type TableInfoTab = "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl";

export interface QueryTab {
  id: string;
  title: string;
  customTitle?: boolean;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  savedSqlId?: string;
  originalSql?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  orderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultAccessedAt?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  pinned?: boolean;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  resultRuns?: QueryResultRun[];
  activeResultRunId?: string;
  resultAutoSave?: boolean;
  explainPlan?: import("@/lib/explainPlan").ParsedExplainPlan;
  explainError?: string;
  explainSql?: string;
  lastExplainedSql?: string;
  isExecuting: boolean;
  isCancelling?: boolean;
  queryExecutionStartedAt?: number;
  editorViewport?: {
    scrollTop: number;
    scrollLeft: number;
  };
  editorSelection?: {
    anchor: number;
    head: number;
  };
  executionId?: string;
  isExplaining?: boolean;
  explainExecutionId?: string;
  mode: "data" | "query" | "redis" | "mongo" | "vector" | "etcd" | "mq" | "nacos" | "objects" | "structure" | "users";
  mqTenant?: string;
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  structureTableName?: string;
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
    tableType?: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  tableMetaUpdatedAt?: number;
  tableInfoTab?: TableInfoTab;
  queryAnalysis?: {
    schema?: string;
    schemaQuoted?: boolean;
    tableName: string;
    tableNameQuoted?: boolean;
    tableAlias?: string;
    selectStar: boolean;
    columns: {
      sourceName?: string;
      sourceNameQuoted?: boolean;
      resultName: string;
      expression: string;
    }[];
  };
  querySourceColumns?: Array<string | undefined>;
  queryEditabilityReason?: "not-select" | "cte" | "set-operation" | "aggregation" | "external-source" | "complex-source" | "computed-columns" | "no-table" | "no-primary-key" | "primary-key-not-returned" | "aliased-columns" | "metadata-unavailable";
  resultEvicted?: boolean;
  whereInput?: string;
  previewSql?: string;
}

export interface SavedSqlFolder {
  id: string;
  connectionId: string;
  parentFolderId?: string;
  name: string;
  orderIndex?: number;
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
  orderIndex?: number;
  openCount?: number;
  openedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SavedSqlLibrary {
  folders: SavedSqlFolder[];
  files: SavedSqlFile[];
}
