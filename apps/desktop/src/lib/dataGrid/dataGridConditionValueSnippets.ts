import type { DatabaseType } from "@/types/database";

/**
 * Value-position suggestions for the hand-written WHERE input. The caret sits
 * right after a comparison operator, so the only useful hints are complete,
 * dialect-correct expressions for the column type in front of it.
 *
 * 手写 WHERE 时最常忘的是日期函数的写法（Oracle 甚至不接受裸 ISO 字符串，
 * 会报 ORA-01843）。这里只给「插进去就能跑」的完整表达式，不再套一层面板。
 */
const TEMPORAL_TYPE_PATTERN = /(?:^|[^a-z])(?:date|datetime|datetime2|datetimeoffset|smalldatetime|time|timestamp|timestamptz|timetz|year)(?:$|[^a-z])/;

export function isDataGridConditionTemporalType(dataType?: string): boolean {
  return dataType ? TEMPORAL_TYPE_PATTERN.test(dataType.toLowerCase()) : false;
}

export function isDataGridConditionBooleanType(dataType?: string, databaseType?: DatabaseType): boolean {
  if (!dataType) return false;
  // Mirrors the filter builder's rule: PostgreSQL "bit" is a bit string, not a boolean.
  return dataType
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => part === "bool" || part === "boolean" || (part === "bit" && databaseType !== "postgres"));
}

function temporalValueSnippets(databaseType?: DatabaseType): string[] {
  switch (databaseType) {
    case "oracle":
    case "oceanbase-oracle":
      return ["SYSTIMESTAMP", "TRUNC(SYSDATE)", "TRUNC(SYSDATE) - 1", "SYSTIMESTAMP - INTERVAL '7' DAY", "SYSTIMESTAMP - INTERVAL '30' DAY"];
    case "mysql":
    case "doris":
    case "starrocks":
    case "goldendb":
    case "databend":
      return ["NOW()", "CURDATE()", "CURDATE() - INTERVAL 1 DAY", "NOW() - INTERVAL 7 DAY", "NOW() - INTERVAL 30 DAY"];
    case "postgres":
    case "redshift":
    case "kingbase":
    case "highgo":
    case "uxdb":
    case "vastbase":
    case "gaussdb":
    case "opengauss":
    case "gbase8c":
    case "questdb":
    case "vertica":
      return ["now()", "CURRENT_DATE", "CURRENT_DATE - 1", "now() - interval '7 days'", "now() - interval '30 days'"];
    case "sqlite":
    case "rqlite":
    case "turso":
    case "cloudflare-d1":
      return ["datetime('now')", "date('now')", "date('now','-1 day')", "datetime('now','-7 days')", "datetime('now','-30 days')"];
    case "sqlserver":
      return ["GETDATE()", "CAST(GETDATE() AS DATE)", "CAST(DATEADD(day,-1,GETDATE()) AS DATE)", "DATEADD(day,-7,GETDATE())", "DATEADD(day,-30,GETDATE())"];
    default:
      // Portable fallback; relative offsets are skipped rather than guessed.
      return ["CURRENT_TIMESTAMP", "CURRENT_DATE"];
  }
}

export function dataGridConditionValueSnippets(dataType: string | undefined, databaseType?: DatabaseType): string[] {
  if (isDataGridConditionBooleanType(dataType, databaseType)) return databaseType === "sqlserver" ? ["1", "0"] : ["TRUE", "FALSE"];
  if (!isDataGridConditionTemporalType(dataType)) return [];
  return temporalValueSnippets(databaseType);
}
