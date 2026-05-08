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
  | "gaussdb";

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
  color?: string;
  ssh_enabled?: boolean;
  ssh_host?: string;
  ssh_port?: number;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key_path?: string;
  ssh_key_passphrase?: string;
  ssh_expose_lan?: boolean;
  ssl?: boolean;
  sysdba?: boolean;
  connection_string?: string;
}

export interface DatabaseInfo {
  name: string;
}

export interface TableInfo {
  name: string;
  table_type: string;
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
}

export type TreeNodeType =
  | "connection"
  | "connection-group"
  | "database"
  | "schema"
  | "table"
  | "view"
  | "group-columns"
  | "group-indexes"
  | "group-fkeys"
  | "group-triggers"
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
  meta?: ColumnInfo | IndexInfo | ForeignKeyInfo | TriggerInfo;
}

export interface QueryTab {
  id: string;
  title: string;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
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
  mode: "data" | "query" | "redis" | "mongo";
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  queryAnalysis?: {
    schema?: string;
    tableName: string;
    selectStar: boolean;
    columns: string[];
  };
}
