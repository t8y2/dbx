import { POSTGRES_FUNCTION_SIGNATURES } from "./postgres";

/**
 * DuckDB 内置函数签名：DuckDB 有意兼容 PostgreSQL 语法，因此以 PG 表作为基线，
 * 再叠加 DuckDB 特有的列表/结构体/日期函数（同名函数以本表为准）。
 */
export const DUCKDB_FUNCTION_SIGNATURES = new Map<string, string[]>([
  ...POSTGRES_FUNCTION_SIGNATURES,
  // 日期时间
  ["STRFTIME", ["date", "format"]],
  ["STRPTIME", ["text", "format"]],
  ["DATE_DIFF", ["part", "startdate", "enddate"]],
  ["DATEDIFF", ["part", "startdate", "enddate"]],
  ["DATE_ADD", ["date", "interval"]],
  ["DATE_SUB", ["date", "interval"]],
  ["EPOCH", ["timestamp"]],
  ["EPOCH_MS", ["milliseconds"]],
  ["TODAY", []],
  // 列表 / 结构体 / Map
  ["LIST_VALUE", ["...values"]],
  ["LIST_EXTRACT", ["list", "index"]],
  ["LIST_TRANSFORM", ["list", "lambda"]],
  ["LIST_FILTER", ["list", "lambda"]],
  ["LIST_SORT", ["list"]],
  ["LIST_REVERSE", ["list"]],
  ["LIST_CONTAINS", ["list", "element"]],
  ["LIST_POSITION", ["list", "element"]],
  ["ARRAY_LENGTH", ["list"]],
  ["LEN", ["string"]],
  ["RANGE", ["start", "stop", "step"]],
  ["STRUCT_PACK", ["...name_value_pairs"]],
  ["MAP_KEYS", ["map"]],
  ["MAP_VALUES", ["map"]],
  ["MAP_EXTRACT", ["map", "key"]],
  ["STRING_SPLIT", ["string", "separator"]],
  ["STRING_SPLIT_REGEX", ["string", "regex"]],
  // 字符串
  ["REGEXP_EXTRACT", ["string", "pattern", "group"]],
  ["REGEXP_EXTRACT_ALL", ["string", "pattern", "group"]],
  ["REGEXP_FULL_MATCH", ["string", "pattern", "options"]],
  ["PREFIX", ["string", "search_string"]],
  ["SUFFIX", ["string", "search_string"]],
  ["CONTAINS", ["string", "search_string"]],
  ["LEVENSHTEIN", ["string1", "string2"]],
  ["JACCARD", ["string1", "string2"]],
  // 聚合
  ["ARG_MAX", ["arg", "val"]],
  ["ARG_MIN", ["arg", "val"]],
  ["ARBITRARY", ["expr"]],
  ["FIRST", ["expr"]],
  ["LAST", ["expr"]],
  ["HISTOGRAM", ["expr"]],
  ["MODE", ["expr"]],
  ["MEDIAN", ["expr"]],
  ["QUANTILE_CONT", ["expr", "pos"]],
  ["QUANTILE_DISC", ["expr", "pos"]],
  ["APPROX_COUNT_DISTINCT", ["expr"]],
  // 系统信息
  ["CURRENT_SETTING", ["setting"]],
  ["CURRENT_DATABASE", []],
  ["CURRENT_SCHEMA", []],
]);
