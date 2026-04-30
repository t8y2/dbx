export type DatabaseType = "mysql" | "postgres" | "sqlite" | "redis" | "duckdb" | "clickhouse" | "sqlserver" | "mongodb" | "oracle" | "elasticsearch";

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
  ssl?: boolean;
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
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
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
  | "connection" | "database" | "schema" | "table" | "view"
  | "group-columns" | "group-indexes" | "group-fkeys" | "group-triggers"
  | "column" | "index" | "fkey" | "trigger"
  | "redis-db"
  | "mongo-db" | "mongo-collection";

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
  sql: string;
  lastExecutedSql?: string;
  pinned?: boolean;
  result?: QueryResult;
  isExecuting: boolean;
  mode: "data" | "query" | "redis" | "mongo";
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
}
