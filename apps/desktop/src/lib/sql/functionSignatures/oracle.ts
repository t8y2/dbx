/**
 * Oracle 内置 SQL 函数签名（含 OceanBase Oracle 模式、达梦、崖山、神通、虚谷等 Oracle 兼容库）。
 *
 * 说明：
 * - 只收录「高频且语法稳定」的 SQL 内置函数，参数名按 Oracle 官方文档口径，仅作为补全提示与签名提示，
 *   不做语法校验；PL/SQL 过程化内置包（DBMS_*、UTL_*）不在补全范围内。
 * - 与 `COMMON_SQL_FUNCTION_NAMES` 重复的函数（COUNT/SUM/SUBSTR/COALESCE 等）在本表中可以覆盖写法，
 *   命中时以本表为准（`activeFunctionSignatures` 中方言表后合并）。
 * - 窗口函数（ROW_NUMBER/RANK/LAG 等）由 `WINDOW_FUNCTIONS` 单独提供，此处不重复。
 */
export const ORACLE_FUNCTION_SIGNATURES = new Map<string, string[]>([
  // 空值 / 条件
  ["NVL", ["expr1", "expr2"]],
  ["NVL2", ["expr1", "expr2", "expr3"]],
  ["DECODE", ["expr", "search", "result", "...default"]],
  ["LNNVL", ["condition"]],
  ["NANVL", ["value", "replacement"]],
  ["GREATEST", ["...values"]],
  ["LEAST", ["...values"]],
  ["NULLIF", ["expr1", "expr2"]],
  ["COALESCE", ["expr", "...exprs"]],
  // 类型转换
  ["TO_CHAR", ["value", "format"]],
  ["TO_DATE", ["char", "format"]],
  ["TO_NUMBER", ["expr", "format"]],
  ["TO_TIMESTAMP", ["char", "format"]],
  ["TO_TIMESTAMP_TZ", ["char", "format"]],
  ["TO_NCHAR", ["expr"]],
  ["TO_CLOB", ["char"]],
  ["TO_BLOB", ["raw"]],
  ["TO_DSINTERVAL", ["char"]],
  ["TO_YMINTERVAL", ["char"]],
  ["TO_MULTI_BYTE", ["char"]],
  ["TO_SINGLE_BYTE", ["char"]],
  ["TREAT", ["expr AS type"]],
  ["CAST", ["expr AS type"]],
  ["RAWTOHEX", ["raw"]],
  ["HEXTORAW", ["char"]],
  ["SYS_GUID", []],
  ["EMPTY_CLOB", []],
  ["EMPTY_BLOB", []],
  // 字符
  ["SUBSTR", ["string", "position", "length"]],
  ["SUBSTRB", ["string", "position", "length"]],
  ["INSTR", ["string", "substring", "position", "occurrence"]],
  ["INSTRB", ["string", "substring", "position", "occurrence"]],
  ["LENGTH", ["string"]],
  ["LENGTHB", ["string"]],
  ["LPAD", ["expr", "length", "pad"]],
  ["RPAD", ["expr", "length", "pad"]],
  ["TRIM", ["trim_source"]],
  ["LTRIM", ["string", "set"]],
  ["RTRIM", ["string", "set"]],
  ["REPLACE", ["string", "search", "replacement"]],
  ["TRANSLATE", ["expr", "from", "to"]],
  ["UPPER", ["string"]],
  ["LOWER", ["string"]],
  ["INITCAP", ["string"]],
  ["CONCAT", ["string1", "string2"]],
  ["ASCII", ["char"]],
  ["CHR", ["number"]],
  ["SOUNDEX", ["char"]],
  ["NLSSORT", ["char", "nlsparam"]],
  ["UNISTR", ["string"]],
  ["COMPOSE", ["string"]],
  ["DECOMPOSE", ["string"]],
  // 正则
  ["REGEXP_LIKE", ["source", "pattern", "match_param"]],
  ["REGEXP_REPLACE", ["source", "pattern", "replacement", "position", "occurrence", "match_param"]],
  ["REGEXP_SUBSTR", ["source", "pattern", "position", "occurrence", "match_param"]],
  ["REGEXP_INSTR", ["source", "pattern", "position", "occurrence", "return_option", "match_param"]],
  ["REGEXP_COUNT", ["source", "pattern", "position", "match_param"]],
  // 数字
  ["ABS", ["number"]],
  ["CEIL", ["number"]],
  ["FLOOR", ["number"]],
  ["ROUND", ["number", "decimals"]],
  ["TRUNC", ["number", "decimals"]],
  ["MOD", ["dividend", "divisor"]],
  ["REMAINDER", ["n1", "n2"]],
  ["POWER", ["base", "exponent"]],
  ["SQRT", ["number"]],
  ["EXP", ["number"]],
  ["LN", ["number"]],
  ["LOG", ["base", "number"]],
  ["SIGN", ["number"]],
  ["BITAND", ["expr1", "expr2"]],
  ["WIDTH_BUCKET", ["expr", "min_value", "max_value", "num_buckets"]],
  // 日期时间（SYSDATE / SYSTIMESTAMP / CURRENT_DATE / CURRENT_TIMESTAMP / LOCALTIMESTAMP /
  // SESSIONTIMEZONE / DBTIMEZONE / USER / UID 由 `buildOracleSystemValueItems` 提供，插入时不带括号，这里不重复）
  ["ADD_MONTHS", ["date", "months"]],
  ["MONTHS_BETWEEN", ["date1", "date2"]],
  ["LAST_DAY", ["date"]],
  ["NEXT_DAY", ["date", "day"]],
  ["NEW_TIME", ["date", "zone1", "zone2"]],
  ["NUMTODSINTERVAL", ["n", "unit"]],
  ["NUMTOYMINTERVAL", ["n", "unit"]],
  ["SYS_EXTRACT_UTC", ["datetime"]],
  ["TZ_OFFSET", ["time_zone"]],
  ["FROM_TZ", ["timestamp", "time_zone"]],
  // 语法特殊：参数不是普通逗号列表，apply 里用模板生成（见 ORACLE_FUNCTION_APPLY_TEMPLATES）
  ["EXTRACT", ["unit FROM datetime"]],
  ["POSITION", ["substring IN string"]],
  // 聚合 / 分析（窗口函数见 WINDOW_FUNCTIONS）
  ["LISTAGG", ["expr", "delimiter"]],
  ["MEDIAN", ["expr"]],
  ["STATS_MODE", ["expr"]],
  ["RATIO_TO_REPORT", ["expr"]],
  ["STDDEV", ["expr"]],
  ["VARIANCE", ["expr"]],
  ["CORR", ["expr1", "expr2"]],
  ["COVAR_POP", ["expr1", "expr2"]],
  ["COVAR_SAMP", ["expr1", "expr2"]],
  ["GROUPING", ["expr"]],
  ["GROUPING_ID", ["...exprs"]],
  ["APPROX_COUNT_DISTINCT", ["expr"]],
  // JSON（12c+）
  ["JSON_VALUE", ["json", "path"]],
  ["JSON_QUERY", ["json", "path"]],
  ["JSON_EXISTS", ["json", "path"]],
  ["JSON_OBJECT", ["key", "value", "...pairs"]],
  ["JSON_ARRAY", ["...values"]],
  ["JSON_MERGEPATCH", ["target", "patch"]],
  ["JSON_EQUAL", ["expr1", "expr2"]],
  // XML
  ["XMLAGG", ["xml"]],
  ["EXTRACTVALUE", ["xml", "xpath"]],
  ["XMLELEMENT", ["name", "...content"]],
  ["XMLFOREST", ["...values"]],
  // 系统信息 / 杂项（USER / UID 由 Oracle 系统值项提供，此处不重复）
  ["SYS_CONTEXT", ["namespace", "parameter"]],
  ["USERENV", ["parameter"]],
  ["ORA_HASH", ["expr", "max_bucket", "seed"]],
  ["STANDARD_HASH", ["expr", "hash_method"]],
  ["DUMP", ["expr"]],
  ["VSIZE", ["expr"]],
]);

/**
 * Oracle 兼容族中语法与通用写法（逗号分隔参数）不同的函数，
 * 这些函数在补全时会按模板插入，例如 EXTRACT 必须写成 `EXTRACT(YEAR FROM hiredate)`。
 */
export const ORACLE_FUNCTION_APPLY_TEMPLATES = new Map<string, string>([
  ["EXTRACT", "EXTRACT(${unit} FROM ${datetime})"],
  ["POSITION", "POSITION(${substring} IN ${string})"],
  ["LISTAGG", "LISTAGG(${expr}, ${delimiter}) WITHIN GROUP (ORDER BY ${order_by})"],
]);
