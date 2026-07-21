export type DatabaseType =
  | "mysql"
  | "postgres"
  | "sqlite"
  | "rqlite"
  | "turso"
  | "cloudflare-d1"
  | "redis"
  | "duckdb"
  | "clickhouse"
  | "sqlserver"
  | "mongodb"
  | "oracle"
  | "elasticsearch"
  | "qdrant"
  | "milvus"
  | "weaviate"
  | "chromadb"
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
  | "spark"
  | "db2"
  | "informix"
  | "neo4j"
  | "cassandra"
  | "bigquery"
  | "kylin"
  | "sundb"
  | "oscar"
  | "tdengine"
  | "xugu"
  | "iotdb"
  | "etcd"
  | "zookeeper"
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
  enabled?: boolean;
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
  agent_java_options?: string[];
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string;
  visible_databases?: string[];
  visible_schemas?: Record<string, string[]>;
  attached_databases?: AttachedDatabaseConfig[];
  init_script?: string;
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
  redis_scan_page_size?: number;
  etcd_endpoints?: string;
  gbase_server?: string;
  informix_server?: string;
  external_config?: unknown;
  one_time?: boolean;
  read_only?: boolean;
  /** Explicit production marker for every database reachable through this connection. */
  is_production?: boolean;
  /** Database-level production markers for multi-database connections. */
  production_databases?: string[];
  /** Metadata captured from the latest successful connection test for the saved config. */
  database_info?: DatabaseConnectionInfo;
}

export type IdentifierCase = "lower" | "upper" | "mixed";

export interface DatabaseConnectionInfo {
  productName?: string;
  productVersion?: string;
  currentDatabase?: string;
  serverComment?: string;
  serverCharset?: string;
  serverCollation?: string;
  unquotedIdentifierCase?: IdentifierCase;
  quotedIdentifierCase?: IdentifierCase;
  driverName?: string;
  driverVersion?: string;
  jdbcVersion?: string;
}

export interface ConnectionTestResult {
  message: string;
  databaseInfo?: DatabaseConnectionInfo;
}

export type TransportLayerConfig = ({ type: "ssh" } & SshTunnelConfig) | ({ type: "proxy" } & ProxyTunnelConfig) | ({ type: "http_tunnel" } & HttpTunnelConfig);

/**
 * A shared tunnel configuration managed in Settings > Tunnels. Structurally a
 * `TransportLayerConfig`; its `id` is what connection layers reference via
 * `profile_id`. Edits to a profile apply to every referencing connection the
 * next time it connects.
 */
export type TunnelProfile = TransportLayerConfig;

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
  /**
   * UI-facing choice of login method. Drives which credential inputs the
   * connection dialog shows; the backend still probes "none" then falls
   * back to key > password > agent based on which fields are non-empty,
   * independent of this selector (see `db/ssh_tunnel.rs`).
   *
   * `"agent"` is a legacy value: it's no longer offered as a dropdown
   * choice for new connections, but is preserved and displayed read-only
   * for connections that already have `use_ssh_agent` configured.
   */
  auth_method?: "password" | "key" | "agent" | "none";
  /**
   * When set, this layer references a shared tunnel profile; the profile's
   * configuration replaces this layer's fields at connect time (only `id`
   * and `enabled` are kept).
   */
  profile_id?: string;
}

export interface SshConfigHostEntry {
  alias: string;
  host_name?: string;
  port?: number;
  user?: string;
  identity_file?: string;
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
  /** Optional target host:port for tunnel testing. When empty, self-connect. */
  test_target?: string;
  /** See {@link SshTunnelConfig.profile_id}. */
  profile_id?: string;
}

export interface HttpTunnelConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  url: string;
  token?: string;
  connect_timeout_secs?: number;
  /** See {@link SshTunnelConfig.profile_id}. */
  profile_id?: string;
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

export interface JdbcLocalArtifactInfo {
  file_name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface JdbcLocalBundleInfo {
  id: string;
  name: string;
  installed_at: string;
  path: string;
  artifacts: JdbcLocalArtifactInfo[];
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

export interface SchemaInfo {
  name: string;
  comment?: string | null;
}

export interface LinkedServerInfo {
  name: string;
  product?: string | null;
  provider?: string | null;
  data_source?: string | null;
}

/** A catalog exposed by a multi-catalog engine (Doris / StarRocks). */
export interface CatalogInfo {
  name: string;
  catalog_type: string;
  is_current: boolean;
  comment?: string | null;
}

export interface TableInfo {
  name: string;
  table_type: string;
  comment?: string | null;
  parent_schema?: string | null;
  parent_name?: string | null;
}

export type DatabaseObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";

export interface ObjectInfo {
  name: string;
  object_type: DatabaseObjectType | string;
  schema?: string | null;
  valid?: boolean | null;
  signature?: string | null;
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

export type ObjectSourceKind = "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "PACKAGE" | "PACKAGE_BODY" | "TYPE" | "TYPE_BODY";

export interface ObjectSource {
  name: string;
  object_type: ObjectSourceKind;
  schema?: string | null;
  source: string;
  editable?: boolean;
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
  enum_values?: string[] | null;
  character_set?: string | null;
  collation?: string | null;
}

export interface SqlServerColumnMetadata extends ColumnInfo {
  is_identity: boolean;
  is_computed: boolean;
  is_hidden: boolean;
  generated_always_type: number;
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

export interface ExtensionInfo {
  name: string;
  version: string;
  comment?: string | null;
  schema?: string | null;
}

export interface OwnerInfo {
  object_name: string;
  object_type: string;
  owner: string;
}

export interface QueryResult {
  columns: string[];
  /** Internal marker for a result built by appending a page to existing rows. */
  appended_from_row_count?: number;
  /** Set for synthesized query execution failures. */
  execution_error?: true;
  /** Zero-based index of the submitted statement that produced this result. */
  statement_index?: number;
  /** Internal row identifiers appended to editable query results. */
  hidden_column_indexes?: number[];
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
  /**
   * Original MongoDB documents, kept in lockstep with `rows` for document
   * preview. This is populated only for MongoDB document query results.
   */
  mongo_documents?: unknown[];
  /** Type-preserving Extended JSON documents used when copying MongoDB values. */
  mongo_copy_documents?: unknown[];
  affected_rows: number;
  execution_time_ms: number;
  truncated?: boolean;
  session_id?: string | null;
  has_more?: boolean;
  sourceLabel?: string;
  sourceStatement?: string;
  /** Absolute offsets in the editor document at execution time. */
  sourceFrom?: number;
  sourceTo?: number;
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
  /** Fingerprint of the complete editor document when this result run started. */
  resultEditorFingerprint?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  resultSortMode?: "database" | "local";
  resultLocalSortOriginalRows?: QueryResult["rows"];
  resultLocalSortOriginalMongoDocuments?: QueryResult["mongo_documents"];
  orderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultAccessedAt?: number;
  resultEstimatedBytes?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  resultEvicted?: boolean;
  queryAnalysis?: QueryTab["queryAnalysis"];
  querySourceColumns?: QueryTab["querySourceColumns"];
  queryEditabilityReason?: QueryTab["queryEditabilityReason"];
  mongoEditTarget?: QueryTab["mongoEditTarget"];
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
  scope_id?: number;
}

export interface SqlColumnReference {
  name: string;
  qualifier?: string | null;
  span: SqlTextSpan;
  scope_id?: number;
}

export interface SqlReferenceScope {
  id: number;
  parent_id?: number | null;
}

export interface SqlReferenceAnalysis {
  tables: SqlTableReference[];
  columns: SqlColumnReference[];
  scopes?: SqlReferenceScope[];
}

export type TreeNodeType =
  | "connection"
  | "connection-group"
  | "database"
  | "doris-catalog"
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
  | "type"
  | "type-body"
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
  | "group-types"
  | "group-sequences"
  | "group-packages"
  | "group-partitions"
  | "group-extensions"
  | "extension"
  | "object-browser"
  | "user-admin"
  | "dameng-job-admin"
  | "saved-sql-root"
  | "saved-sql-folder"
  | "saved-sql-file"
  | "table-search-control"
  | "load-more"
  | "column"
  | "index"
  | "fkey"
  | "trigger"
  | "redis-db"
  | "mq-tenant"
  | "nacos-namespace"
  | "etcd-root"
  | "zookeeper-root"
  | "mongo-db"
  | "mongo-gridfs"
  | "mongo-buckets"
  | "mongo-bucket"
  | "mongo-collection"
  | "vector-database"
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
  catalog?: string;
  catalogType?: string;
  linkedServer?: string;
  linkedCatalog?: string;
  linkedSchema?: string;
  mqTenant?: string;
  mqInitialTab?: "topics";
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  schema?: string;
  tableName?: string;
  objectName?: string;
  signature?: string;
  tableType?: string;
  comment?: string | null;
  valid?: boolean | null;
  objectCount?: number;
  loadedKeyCount?: number;
  totalKeyCount?: number;
  partitionParentSchema?: string;
  partitionParentName?: string;
  hiddenChildren?: TreeNode[];
  tableSearchParentId?: string;
  savedSqlId?: string;
  savedSqlFolderId?: string;
  meta?: ColumnInfo | IndexInfo | ForeignKeyInfo | TriggerInfo | ExtensionInfo | VectorCollectionMeta | MongoCollectionMeta;
  loadMore?: {
    parentId: string;
    offset: number;
    pageSize: number;
  };
}

export type TableInfoTab = "columns" | "indexes" | "foreignKeys" | "triggers" | "ddl";

export interface TableStructureEditorTarget {
  kind: "column" | "index";
  name: string;
}

export interface TableStructureEditorDraft {
  dirty?: boolean;
  activeTab: TableInfoTab;
  newTableName: string;
  tableComment: string;
  originalTableComment: string;
  columns: import("@/lib/table/tableStructureEditorSql").EditableStructureColumn[];
  indexes: import("@/lib/table/tableStructureEditorSql").EditableStructureIndex[];
  foreignKeys: import("@/lib/table/tableStructureEditorSql").EditableStructureForeignKey[];
  triggers: import("@/lib/table/tableStructureEditorSql").EditableStructureTrigger[];
  scrollPositions?: Partial<Record<TableInfoTab, TableStructureEditorViewport>>;
  initialized: boolean;
}

export interface TableStructureEditorViewport {
  scrollTop: number;
  scrollLeft: number;
}

export type ObjectBrowserViewMode = "list" | "grid";

export interface ObjectBrowserViewport {
  scrollTop: number;
  viewMode: ObjectBrowserViewMode;
}

export interface QueryTab {
  id: string;
  title: string;
  customTitle?: boolean;
  connectionId: string;
  database: string;
  schema?: string;
  /** Doris / StarRocks multi-catalog: the external catalog this tab's
   * database belongs to (undefined for internal/default catalog). */
  catalog?: string;
  sql: string;
  savedSqlId?: string;
  externalSqlPath?: string;
  originalSql?: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  /** Fingerprint of the complete editor document when the displayed result started. */
  resultEditorFingerprint?: string;
  resultSortedSql?: string;
  resultSortColumn?: string;
  resultSortColumnIndex?: number;
  resultSortDirection?: "asc" | "desc";
  resultSortMode?: "database" | "local";
  resultLocalSortOriginalRows?: QueryResult["rows"];
  resultLocalSortOriginalMongoDocuments?: QueryResult["mongo_documents"];
  orderByInput?: string;
  resultPageSql?: string;
  resultPageLimit?: number;
  resultPageOffset?: number;
  resultCountSql?: string;
  resultTotalRowCount?: number;
  resultTotalRowCountLoading?: boolean;
  resultSessionId?: string;
  resultAccessedAt?: number;
  resultEstimatedBytes?: number;
  resultCacheKey?: string;
  resultCacheState?: "memory" | "disk" | "missing";
  pinned?: boolean;
  result?: QueryResult;
  results?: QueryResult[];
  activeResultIndex?: number;
  resultRuns?: QueryResultRun[];
  activeResultRunId?: string;
  resultAutoSave?: boolean;
  explainPlan?: import("@/lib/diagram/explainPlan").ParsedExplainPlan;
  /** MySQL's regular EXPLAIN result, kept alongside its JSON visual plan. */
  explainTableResult?: QueryResult;
  explainError?: string;
  explainTableError?: string;
  explainSql?: string;
  explainTableSql?: string;
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
  /** Per-run connection session for explain flows that require session state. */
  explainClientSessionId?: string;
  /** Invalidates tab-scoped completion metadata after session context changes. */
  completionContextVersion?: number;
  mode: "data" | "query" | "redis" | "redis-dashboard" | "mongo" | "mongo-gridfs" | "mongo-bucket" | "vector" | "etcd" | "zookeeper" | "mq" | "nacos" | "objects" | "structure" | "users" | "dameng-jobs" | "processlist" | "mysql-dashboard" | "postgres-dashboard";
  mqTenant?: string;
  mqInitialTab?: "topics";
  nacosNamespace?: string;
  nacosNamespaceName?: string;
  structureTableName?: string;
  structureInitialTab?: TableInfoTab;
  structureInitialTabRequestId?: number;
  structureInitialTarget?: TableStructureEditorTarget;
  structureDraft?: TableStructureEditorDraft;
  objectBrowser?: {
    catalog?: string;
    schema?: string;
    objectType?: "tables";
    viewport?: ObjectBrowserViewport;
  };
  objectSource?: {
    schema?: string;
    name: string;
    objectType: ObjectSourceKind;
    signature?: string;
  };
  tableMeta?: {
    schema?: string;
    tableName: string;
    tableType?: string;
    catalog?: string;
    database?: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  tableMetaUpdatedAt?: number;
  /** 冷缓存打开表数据时元数据仍在途：行标识未知，编辑/保存必须等待其落地 */
  tableMetaPending?: boolean;
  /** 取消请求单调计数：isCancelling 是瞬态的（取消失败/查询先完成会被清），
   * 需要跨越 executeTabSql 生命周期判断"执行期间用户是否请求过停止"时比对它 */
  cancelRequestCount?: number;
  tableInfoTab?: TableInfoTab;
  queryAnalysis?: {
    catalog?: string;
    catalogQuoted?: boolean;
    schema?: string;
    schemaQuoted?: boolean;
    tableName: string;
    tableNameQuoted?: boolean;
    tableAlias?: string;
    selectStar: boolean;
    editableSourceKey?: string;
    multiSource?: boolean;
    allowInsert?: boolean;
    allowInsertDelete?: boolean;
    sources?: {
      key: string;
      catalog?: string;
      catalogQuoted?: boolean;
      schema?: string;
      schemaQuoted?: boolean;
      tableName: string;
      tableNameQuoted?: boolean;
      alias?: string;
    }[];
    columns: {
      sourceName?: string;
      sourceNameQuoted?: boolean;
      sourceQualifier?: string;
      sourceKey?: string;
      star?: boolean;
      resultName: string;
      expression: string;
    }[];
  };
  querySourceColumns?: Array<string | undefined>;
  queryEditabilityReason?: "not-select" | "cte" | "set-operation" | "aggregation" | "external-source" | "complex-source" | "computed-columns" | "no-table" | "no-primary-key" | "primary-key-not-returned" | "aliased-columns" | "metadata-unavailable";
  mongoEditTarget?: {
    collection: string;
    idColumn: "_id";
  };
  mongoBucket?: {
    bucketName: string;
  };
  resultEvicted?: boolean;
  whereInput?: string;
  previewSql?: string;
  /** Whether to use auto-commit mode (default true). When false, multiple statements are
   *  wrapped in a single transaction. */
  autoCommit?: boolean;
  /** Session ID for an active manual transaction, set after beginManualTransaction */
  txnSessionId?: string;
  /** Set to true when a manual transaction was auto-rolled back due to inactivity */
  txnAutoRolledBack?: boolean;
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
  sqlLoaded?: boolean;
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

export interface VectorCollectionMeta {
  dimension?: number;
  collectionId?: string;
}

/** Mongo collection node metadata (not SQL tableType). */
export type MongoCollectionKind = "collection" | "view" | "timeseries";

export interface MongoCollectionMeta {
  collectionKind: MongoCollectionKind;
}

export interface CollectionInfo {
  name: string;
  id: string;
  dimension?: number;
  kind?: MongoCollectionKind | "bucket";
  bucketName?: string;
}
