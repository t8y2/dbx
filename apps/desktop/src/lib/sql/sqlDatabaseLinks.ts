import type { DatabaseType } from "@/types/database";
import { isDamengReservedKeyword, isOracleReservedKeyword } from "@/lib/sql/sqlIdentifier";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

const ORACLE_PARAMETER_PREFIX_KEYWORDS = new Set([
  "begin",
  "case",
  "close",
  "collate",
  "continue",
  "date",
  "elsif",
  "escape",
  "exit",
  "fetch",
  "first",
  "goto",
  "if",
  "interval",
  "join",
  "key",
  "limit",
  "loop",
  "name",
  "next",
  "nocycle",
  "nulls",
  "offset",
  "open",
  "out",
  "passing",
  "raise",
  "range",
  "return",
  "returning",
  "reverse",
  "savepoint",
  "scn",
  "timestamp",
  // DM8 的标识符保留字表不含 THEN，但 CASE/IF 后仍可紧跟变量表达式。
  "then",
  "truncate",
  "using",
  "value",
  "wait",
  "when",
  "while",
  "zone",
]);
const ORACLE_OBJECT_PREFIX_KEYWORDS = new Set(["from", "join", "update", "into", "table", "delete"]);
const ORACLE_TABLE_LIST_BOUNDARIES = new Set(["select", "from", "where", "group", "having", "order", "connect", "start", "union", "intersect", "minus", "for", "returning", "set", "values"]);

function isAdjacentDatabaseLinkMarker(sql: string, index: number): boolean {
  if (index === 0) return false;
  const previous = sql[index - 1];
  return /[\p{L}\p{N}_]/u.test(previous) || previous === "$" || previous === "#" || previous === '"';
}

// 只用于 SQL 解析：达梦共享对象 @ 链接语法，不扩展 Oracle 元数据和 UI 能力。
// 每次扫描统一收集位置，供参数替换和 @set 展开复用，避免按变量重复解析整段 SQL。
export function collectSqlDatabaseLinkStarts(sql: string, databaseType?: DatabaseType): Set<number> {
  const links = new Set<number>();
  if ((databaseType !== "oracle" && databaseType !== "oceanbase-oracle" && databaseType !== "dameng") || !sql.includes("@")) return links;
  const isReservedKeyword = databaseType === "dameng" ? isDamengReservedKeyword : isOracleReservedKeyword;
  const tokens = tokenizeSqlSemantic(sql, "oracle").filter((token) => token.kind !== "comment");
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "word") continue;
    // 紧邻形式可能位于同一个 word token 中（table@link），引号对象则在前一个 token。
    for (let offset = token.text.indexOf("@"); offset !== -1; offset = token.text.indexOf("@", offset + 1)) {
      const start = token.span.start + offset;
      if (isAdjacentDatabaseLinkMarker(sql, start)) links.add(start);
    }
    if (!token.text.startsWith("@") || i === 0) continue;
    const object = tokens[i - 1];
    if (object.kind === "quoted_identifier" && object.quote === '"') {
      links.add(token.span.start);
      continue;
    }
    if (object.kind !== "word" || !/^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(object.text) || isReservedKeyword(object.text)) continue;
    const prefix = tokens[i - 2]?.normalized ?? "";
    // 按方言排除保留字；非保留关键字仍需上下文判断，避免把 FETCH FIRST @count
    // 等真实参数误判为链接，同时允许 FROM first @link 这样的 Oracle 对象名。
    let objectContext = prefix === "." || (ORACLE_OBJECT_PREFIX_KEYWORDS.has(prefix) && !(prefix === "update" && tokens[i - 3]?.normalized === "for"));
    // A comma can separate tables or expressions. Only a FROM list makes the
    // following non-reserved keyword an object name, including after subqueries.
    if (prefix === "," && ORACLE_PARAMETER_PREFIX_KEYWORDS.has(object.normalized)) {
      for (let j = i - 3; j >= 0; j -= 1) {
        const before = tokens[j];
        if (before.depth < token.depth || before.text === ";") break;
        if (before.depth === token.depth && before.kind === "word" && ORACLE_TABLE_LIST_BOUNDARIES.has(before.normalized)) {
          objectContext = before.normalized === "from";
          break;
        }
      }
    }
    if (objectContext || !ORACLE_PARAMETER_PREFIX_KEYWORDS.has(object.normalized)) links.add(token.span.start);
  }
  return links;
}
