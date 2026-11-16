// Oracle Data Pump（经 oracle-go agent 调 DBMS_DATAPUMP）——前后端共享的
// 请求/进度类型。字段名对齐 Rust 的 `OracleDatapumpTaskRequest` /
// `OracleDatapumpProgress`（serde 驼峰），再往上对齐 Go agent 的
// datapumpStartRequest / 状态快照。

export type OracleDatapumpKind = "export" | "import";
export type OracleDatapumpMode = "schema" | "table";

export interface OracleDatapumpRequest {
  taskId: string;
  connectionId: string;
  /** agent 会话用的 Oracle schema 上下文。 */
  database: string;
  kind: OracleDatapumpKind;
  mode: OracleDatapumpMode;
  /** Oracle DIRECTORY 对象；.dmp 由服务器端写进该对象。 */
  directory: string;
  dumpfile: string;
  logfile?: string | null;
  schemas: string[];
  tables: string[];
  /** 仅导入：REMAP_SCHEMA 源 → 目标。 */
  remapSchemaFrom?: string | null;
  remapSchemaTo?: string | null;
  /** 仅导入：SKIP | REPLACE | TRUNCATE | APPEND。 */
  tableExistsAction?: string | null;
  /** 仅导出：请求 COMPRESSION=ALL。 */
  compression: boolean;
}

export type OracleDatapumpStatus = "Running" | "Done" | "Error" | "Cancelled";

export interface OracleDatapumpProgress {
  taskId: string;
  status: OracleDatapumpStatus;
  /** agent 侧状态机的当前值（running/succeeded/failed/...）。 */
  state: string;
  jobState?: string | null;
  percent?: number | null;
  /** KU$_JOB_STATUS1020 阶段码（1 定义 / 2 执行 / 3 收尾）。 */
  phaseCode?: number | null;
  errorCount?: number | null;
  errorText?: string | null;
  elapsedMs?: number | null;
  /** 带 tag 的终态错误，供本地化；运行中不存在。 */
  error?: string | null;
}

export interface OracleDatapumpDirectory {
  name: string;
  /** DIRECTORY 对象背后的服务器路径（展示提示用）。 */
  path: string;
}
