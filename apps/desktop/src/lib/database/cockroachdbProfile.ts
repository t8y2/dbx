import type { DriverProfileExtensionDefinition, DriverProfileKeywordContext } from "@/lib/database/driverProfileExtensions";

export const COCKROACHDB_DRIVER_PROFILE = "cockroachdb";

/**
 * CockroachDB 在 DBX 里是 `postgres` + `driver_profile="cockroachdb"`，不是独立的
 * `DatabaseType`，所以 PostgreSQL 方言的关键字和函数表本来就已经生效。这里只补
 * CRDB 专有部分，由 `driverProfileExtensions` 叠加到 PG 方言之上。
 *
 * 关键字来源：CRDB SQL Grammar（`pkg/sql/parser/sql.y`）的 reserved /
 * type_func_name / col_name / cockroachdb_extra_reserved 四类，去掉与
 * `COMMON_SQL_KEYWORDS`、`POSTGRES_SQL_KEYWORDS` 重复的项，并按日常 SQL 写作场景
 * 筛掉了纯管理员语法（例如 `NOVIEWACTIVITY`、`SKIP_MISSING_UDFS`），避免补全列表
 * 被低频关键字淹没。多词关键字与现有表保持一致，用空格分隔。
 */
export const COCKROACHDB_SQL_KEYWORDS = [
  // 类型：STRING / BYTES 是 CRDB 对 TEXT / BYTEA 的别名，VECTOR 是向量列类型
  "STRING",
  "BYTES",
  "VECTOR",
  "BOX2D",
  "GEOGRAPHY",
  "GEOMETRY",
  // 时间旅行
  "AS OF SYSTEM TIME",
  // 多区域 / 地域
  "LOCALITY",
  "REGIONAL",
  "REGIONAL BY ROW",
  "REGIONAL BY TABLE",
  "REGIONAL IN",
  "REGION",
  "REGIONS",
  "SURVIVE",
  "FAILURE",
  "GLOBAL",
  // 列族、索引、生成列
  "FAMILY",
  "INVERTED",
  "INVERTED INDEX",
  "STORED",
  "STORING",
  "VIRTUAL",
  "VISIBLE",
  "INVISIBLE",
  "HASH",
  "ON UPDATE",
  "WITH ORDINALITY",
  // 表与数据管理
  "SPLIT",
  "SPLIT AT",
  "UNSPLIT",
  "UNSPLIT AT",
  "EXPERIMENTAL_AUDIT",
  "UPSERT",
  // 备份、流、运维
  "BACKUP",
  "RESTORE",
  "CHANGEFEED",
  "SCHEDULE",
  "CANCELQUERY",
  "COMPACT",
  "SCRUB",
  "ANALYZE",
  "JOB",
  "JOBS",
  "TENANT",
  "CLUSTER",
  "NODE",
  "RANGE",
  "ZONE",
  "CONFIGURE",
  "CONFIGURE ZONE",
  "RELOCATE",
  "SCATTER",
  "PAUSE",
  "RESUME",
  // 表达式
  "IFERROR",
  "ISERROR",
  "ANNOTATE_TYPE",
  "EXTRACT_DURATION",
  "TREAT",
  "EXPERIMENTAL",
];

/**
 * CRDB 专有内置函数，取自 docs.cockroachlabs.com 的 functions-and-operators。
 * 参数名只用于补全提示与签名提示，不做语法校验；PG 已有的函数由 PG 表提供，
 * 这里不重复登记。
 */
export const COCKROACHDB_FUNCTION_SIGNATURES = new Map<string, string[]>([
  // 时间与时间旅行
  ["CLUSTER_LOGICAL_TIMESTAMP", []],
  ["TIMEOFDAY", []],
  ["FOLLOWER_READ_TIMESTAMP", []],
  ["EXPERIMENTAL_FOLLOWER_READ_TIMESTAMP", []],
  ["WITH_MIN_TIMESTAMP", ["min_timestamp", "nearest_only"]],
  ["WITH_MAX_STALENESS", ["max_staleness", "nearest_only"]],
  ["HLC_TO_TIMESTAMP", ["hlc"]],
  ["EXPERIMENTAL_STRFTIME", ["timestamp", "format"]],
  ["EXPERIMENTAL_STRPTIME", ["string", "format"]],
  // 拓扑与租户
  ["GATEWAY_REGION", []],
  ["DEFAULT_TO_DATABASE_PRIMARY_REGION", ["region"]],
  // 主键与行标识
  ["UNIQUE_ROWID", []],
  ["UNORDERED_UNIQUE_ROWID", []],
  ["UUID_V4", []],
  ["EXPERIMENTAL_UUID_V4", []],
  ["ULID_TO_UUID", ["val"]],
  ["UUID_TO_ULID", ["val"]],
  ["REHOME_ROW", []],
  // 标识符与哈希
  ["GEN_RANDOM_ULID", []],
  ["GEN_RANDOM_BYTES", ["count"]],
  ["CRC32C", ["string"]],
  ["CRC32IEEE", ["string"]],
  ["FNV32", ["string"]],
  ["FNV32A", ["string"]],
  ["FNV64", ["string"]],
  ["FNV64A", ["string"]],
  ["SHA1", ["string"]],
  ["SHA256", ["string"]],
  ["SHA512", ["string"]],
  ["DIGEST", ["data", "algorithm"]],
  ["FROM_IP", ["string"]],
  ["FROM_UUID", ["uuid"]],
  ["TO_UUID", ["bytes"]],
  // JSON
  ["JSON_VALID", ["json"]],
  ["JSON_REMOVE_PATH", ["json", "path"]],
  ["JSON_SET", ["json", "path", "value"]],
  ["JSONB_ARRAY_TO_STRING_ARRAY", ["jsonb"]],
  // 解析
  ["PARSE_DATE", ["string"]],
  ["PARSE_TIME", ["string"]],
  ["PARSE_TIMETZ", ["string"]],
  ["PARSE_TIMESTAMP", ["string"]],
  ["PARSE_INTERVAL", ["string"]],
  ["PARSE_IDENT", ["string"]],
  // 向量距离（CRDB v25.2+）
  ["L1_DISTANCE", ["vector1", "vector2"]],
  ["L2_DISTANCE", ["vector1", "vector2"]],
  ["COSINE_DISTANCE", ["vector1", "vector2"]],
  ["INNER_PRODUCT", ["vector1", "vector2"]],
  ["VECTOR_DIMS", ["vector"]],
  ["VECTOR_NORM", ["vector"]],
  // 网络与分布式
  ["TO_IP", ["val"]],
  ["BROADCAST", ["val"]],
  // 格式化与元数据
  ["PRETTIFY_STATEMENT", ["statement", "line_width", "align_mode", "case_mode"]],
  ["STRFTIME", ["input", "extract_format"]],
  ["STRPTIME", ["input", "format"]],
  ["PG_GET_KEYWORDS", []],
  ["PG_GET_SEQUENCE_DATA", ["sequence_oid"]],
  // 聚合
  ["COUNT_ROWS", []],
  ["SUM_INT", ["arg1"]],
  ["XOR_AGG", ["arg1"]],
  ["ARRAY_CAT_AGG", ["array"]],
  ["CONCAT_AGG", ["expression"]],
  ["BITMASK_AND", ["bit"]],
  ["BITMASK_OR", ["bit"]],
  ["BITMASK_XOR", ["bit"]],
]);

export function isCockroachDbDriverProfile(driverProfile?: string): boolean {
  return driverProfile?.trim().toLowerCase() === COCKROACHDB_DRIVER_PROFILE;
}

/**
 * `SHOW` 后的常用子句。CRDB 的 SHOW 语句覆盖面比 PostgreSQL 大得多，
 * 这些子句只在 `SHOW ` 之后作为高优先候选出现，不放进通用关键字表。
 */
export const COCKROACHDB_SHOW_CLAUSES = [
  "ALL",
  "CHANGEFEED JOBS",
  "CLUSTER SETTING",
  "COLUMNS",
  "CONSTRAINTS",
  "CREATE",
  "DATABASES",
  "FUNCTIONS",
  "GRANTS",
  "INDEXES",
  "JOBS",
  "LOCKS",
  "PARTITIONS",
  "PROCEDURES",
  "QUERIES",
  "RANGES",
  "REGIONS",
  "ROLES",
  "SCHEDULES",
  "SCHEMAS",
  "SEQUENCES",
  "SESSIONS",
  "STATISTICS",
  "TABLES",
  "TENANTS",
  "TRIGGERS",
  "TYPES",
  "USERS",
  "ZONE CONFIGURATIONS",
];

/**
 * `SHOW CREATE` 之后的对象类型。CRDB 支持比 PostgreSQL 更多的对象类型，
 * 这些词本身在关键字池里也有，这里只用于在 `SHOW CREATE ` 后提高排序。
 */
export const COCKROACHDB_SHOW_CREATE_OBJECTS = ["TABLE", "VIEW", "DATABASE", "INDEX", "SCHEMA", "SEQUENCE", "FUNCTION", "TYPE"];

/** CRDB 专有数据类型，只在 CRDB 连接的 DDL 列类型位置标为 "data type" 并提升排序。 */
export const COCKROACHDB_DATA_TYPES = ["STRING", "BYTES", "VECTOR", "BOX2D"];

function cockroachDbContextKeywords(context: DriverProfileKeywordContext): string[] {
  const trimmedBeforeToken = context.beforeToken.trimEnd();
  const keywords: string[] = [];
  // `AS OF SYSTEM TIME` 只能跟在 FROM 之后；用户输入 `AS O` 时只替换 `O`，
  // 因此补全 `OF SYSTEM TIME`，避免重复插入 `AS`。
  if (/\bas$/i.test(trimmedBeforeToken) && /\bfrom\b/i.test(context.beforeToken)) keywords.push("OF SYSTEM TIME");
  // CRDB 的 SHOW 子句远多于 PostgreSQL，在 `SHOW ` 之后给出上下文相关的子句。
  if (/\bshow$/i.test(trimmedBeforeToken)) keywords.push(...COCKROACHDB_SHOW_CLAUSES);
  // `SHOW CREATE ` 后优先给出对象类型，而不是 create table 这类语句片段。
  if (/\bshow\s+create$/i.test(trimmedBeforeToken)) keywords.push(...COCKROACHDB_SHOW_CREATE_OBJECTS);
  // `SHOW TABLES/COLUMNS/INDEXES/CONSTRAINTS` 之后只允许 FROM，这里把它提前。
  if (/\bshow\s+(?:tables|columns|indexes|constraints)$/i.test(trimmedBeforeToken)) keywords.push("FROM");
  return keywords;
}

export const COCKROACHDB_DRIVER_PROFILE_EXTENSION: DriverProfileExtensionDefinition = {
  id: COCKROACHDB_DRIVER_PROFILE,
  sqlKeywords: () => COCKROACHDB_SQL_KEYWORDS,
  functionSignatures: () => COCKROACHDB_FUNCTION_SIGNATURES,
  completionContextKeywords: cockroachDbContextKeywords,
  completionDataTypes: () => COCKROACHDB_DATA_TYPES,
  sqlBuiltinTerms: () => Array.from(COCKROACHDB_FUNCTION_SIGNATURES.keys(), (name) => name.toLowerCase()).join(" "),
};
