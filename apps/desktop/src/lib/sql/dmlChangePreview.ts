/** 「预览变更」请求/响应的前端类型（对应后端 dml_preview_sql）。 */

export interface DmlChangePreviewSqlOptions {
  /** 用户写的一条 DML 语句（通常是当前语句）。 */
  sql: string;
  /** 连接类型（决定解析方言 / 默认标识符引号）。 */
  databaseType?: string;
  /** 连接的标识符引号字符（如 `"`、`` ` ``、`[`）。 */
  identifierQuote?: string;
  /** 目标表的列（ordinal）。提供且为单表 UPDATE 时，新值列紧跟其原值列。 */
  columns?: string[];
}

export interface DmlChangePreviewTableRef {
  catalog?: string;
  database?: string;
  schema?: string;
  table?: string;
}

export interface DmlChangePreviewSqlResult {
  /** 生成的只读 SELECT：在结果网格展示受影响行 + 「新值」列。 */
  sql: string;
  /** 语句类型：update / insert / delete。 */
  operation: string;
  /** 是否有「新值」列（仅 UPDATE 有）。 */
  hasNewValueColumns: boolean;
  /** 语句目标表引用（供前端拉取列元数据以交错展示新值列）。 */
  tables: DmlChangePreviewTableRef[];
}

/** 从 SQL 文本粗略识别是否为可预览的 DML（用于「预览变更」入口显隐）。 */
const DML_PREVIEW_RE = /^\s*(update|insert|delete)\b/i;

export function looksLikeDmlStatement(sql: string): boolean {
  return DML_PREVIEW_RE.test(sql);
}
