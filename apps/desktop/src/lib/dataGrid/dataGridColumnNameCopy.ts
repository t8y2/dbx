import type { DatabaseType } from "@/types/database";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { BACKSLASH_ESCAPE_STRING_DIALECTS } from "@/lib/sql/sqlStatementRanges";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

export type ColumnNameCopySeparator = "tab" | "comma" | "newline" | "comma-newline";

/**
 * `identifier` wraps names in the database's identifier quote; `single` wraps them in
 * single quotes as SQL string literals, which is what an `IN ('a','b')` list needs and
 * works for any database (no identifier-quote support implied).
 */
export type ColumnNameCopyQuoteStyle = "identifier" | "single";

export const COLUMN_NAME_COPY_SEPARATOR_VALUES: Record<ColumnNameCopySeparator, string> = {
  tab: "\t",
  comma: ",",
  newline: "\n",
  "comma-newline": ",\n",
};

export const COLUMN_NAME_COPY_SEPARATOR_OPTIONS = Object.keys(COLUMN_NAME_COPY_SEPARATOR_VALUES) as ColumnNameCopySeparator[];

export const COLUMN_NAME_COPY_SEPARATOR_LABELS: Record<ColumnNameCopySeparator, string> = {
  tab: "\\t",
  comma: ",",
  newline: "\\n",
  "comma-newline": ",\\n",
};

export function isColumnNameCopySeparator(value: unknown): value is ColumnNameCopySeparator {
  return typeof value === "string" && value in COLUMN_NAME_COPY_SEPARATOR_VALUES;
}

// SQL 执行能力是产品能力，不代表数据库支持 SQL 标识符引用。
const NON_SQL_DATABASE_TYPES = new Set<DatabaseType>(["redis", "mongodb", "elasticsearch", "easysearch", "meilisearch", "solr", "couchdb", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "consul", "mq", "nacos", "victoriametrics", "salesforce"]);
// quoteTableIdentifier 对 jdbc/iotdb 原样返回（无引用字符可用）。
const UNQUOTABLE_DATABASE_TYPES = new Set<DatabaseType>(["jdbc", "iotdb"]);

export function supportsColumnNameQuoting(databaseType?: DatabaseType): boolean {
  return !!databaseType && !NON_SQL_DATABASE_TYPES.has(databaseType) && !UNQUOTABLE_DATABASE_TYPES.has(databaseType);
}

export interface ColumnNamesForCopyOptions {
  /** 结果集的全部列名，可能包含网格内部的辅助列。 */
  allColumnNames: readonly string[];
  /**
   * 网格实际展示的列索引（`displayableColumnIndexes`）。
   *
   * 「全部列名」按这份索引取，而不是直接铺开结果集：结果集里可能夹着网格内部
   * 辅助列——可编辑行定位用的 `__DBX_PK_*` 别名（#10464）、Neo4j 元素 id、补充的
   * 行号列——它们不在界面上，也不该出现在用户复制的列名里。用户自己隐藏的列仍在
   * 「全部列名」范围内，只是不出现在「选中/可见列名」里。
   */
  displayableIndexes: readonly number[];
  /** 当前可见（未被用户隐藏）的列名。 */
  visibleColumnNames: readonly string[];
  scope: "all" | "visible";
}

export function columnNamesForCopy(options: ColumnNamesForCopyOptions): string[] {
  if (options.scope === "visible") return [...options.visibleColumnNames];
  return options.displayableIndexes.map((index) => options.allColumnNames[index]).filter((name): name is string => name !== undefined);
}

/**
 * Formats one name as a SQL string literal for the target dialect.
 *
 * `'` is always doubled, which every SQL dialect accepts. Dialects where a backslash
 * escapes the next character (MySQL family, via the same set the statement lexer uses)
 * also need `\` doubled — otherwise a name such as `C:\tmp` turns `\t` into a tab and
 * `a\'b` loses the string boundary (#14495 review).
 */
function sqlStringLiteralForCopy(name: string, databaseType?: DatabaseType): string {
  const escaped = (!!databaseType && BACKSLASH_ESCAPE_STRING_DIALECTS.has(databaseType) ? name.replaceAll("\\", "\\\\") : name).replaceAll("'", "''");
  return `'${escaped}'`;
}

export function formatColumnNamesForCopy(names: readonly string[], options: { separator: ColumnNameCopySeparator; quote?: boolean; quoteStyle?: ColumnNameCopyQuoteStyle; databaseType?: DatabaseType; showByComment?: boolean; commentByColumn?: Map<string, string> }): string {
  const singleQuoted = !!options.quote && options.quoteStyle === "single";
  const quote = singleQuoted || (!!options.quote && supportsColumnNameQuoting(options.databaseType));
  const displayNames = options.showByComment && options.commentByColumn ? names.map((name) => options.commentByColumn!.get(name) || name) : [...names];
  const parts = quote ? displayNames.map((name) => (singleQuoted ? sqlStringLiteralForCopy(name, options.databaseType) : quoteTableIdentifier(options.databaseType, name))) : displayNames;
  return parts.join(COLUMN_NAME_COPY_SEPARATOR_VALUES[options.separator]);
}

const SEPARATOR_STORAGE_KEY = "dbx-copy-column-names-separator";

export function loadColumnNameCopySeparator(): ColumnNameCopySeparator {
  const stored = safeLocalStorageGet(SEPARATOR_STORAGE_KEY);
  return isColumnNameCopySeparator(stored) ? stored : "tab";
}

export function saveColumnNameCopySeparator(separator: ColumnNameCopySeparator) {
  safeLocalStorageSet(SEPARATOR_STORAGE_KEY, separator);
}
