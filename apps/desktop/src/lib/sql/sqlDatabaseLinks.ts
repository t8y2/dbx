import type { DatabaseType } from "@/types/database";
import { isDamengReservedKeyword, isOracleReservedKeyword } from "@/lib/sql/sqlIdentifier";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

const ORACLE_OBJECT_PREFIX_KEYWORDS = new Set(["from", "join", "update", "into", "table", "delete"]);
const ORACLE_TABLE_LIST_BOUNDARIES = new Set(["select", "from", "where", "group", "having", "order", "connect", "start", "union", "intersect", "minus", "for", "returning", "set", "values"]);
const PLSQL_TEMPLATE_PREFIX_KEYWORDS = new Set(["begin", "if", "elsif", "loop", "while", "return", "then", "else", "case", "when"]);

function collectSqlXmlKeywordPositions(tokens: readonly SqlSemanticToken[]): Set<number> {
  const keywords = new Set<number>();
  const contexts: { openingIndex: number; functionName: string; passingIndex?: number }[] = [];
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    const token = tokens[tokenIndex];
    if (token.text === ";") {
      contexts.length = 0;
      continue;
    }
    if (token.text === "(" || token.text === "（") {
      const enclosingFunction = tokens[tokenIndex - 1];
      contexts.push({ openingIndex: tokenIndex, functionName: enclosingFunction?.kind === "word" && tokens[tokenIndex - 2]?.text !== "." ? enclosingFunction.normalized : "" });
      continue;
    }
    if (token.text === ")" || token.text === "）") {
      contexts.pop();
      continue;
    }
    const context = contexts[contexts.length - 1];
    if (!context || token.kind !== "word" || tokens[tokenIndex - 1]?.text === ".") continue;
    if (context.functionName === "xmlserialize") {
      if (tokenIndex === context.openingIndex + 1 && (token.normalized === "content" || token.normalized === "document")) keywords.add(tokenIndex);
    } else if (context.functionName === "xmlquery" || context.functionName === "xmltable") {
      if (token.normalized === "passing" && context.passingIndex === undefined && tokenIndex > context.openingIndex + 1) {
        context.passingIndex = tokenIndex;
        keywords.add(tokenIndex);
      } else if (context.passingIndex !== undefined && tokenIndex === context.passingIndex + 2 && tokens[tokenIndex - 1]?.normalized === "by" && token.normalized === "value") {
        keywords.add(tokenIndex);
      }
    }
  }
  return keywords;
}

// 仅服务 SQL 解析，不扩展 Oracle 元数据或 UI 能力。每批扫描一次并保留原始位置，
// 参数替换和 @set 展开共同保护对象链接，避免宽松前缀判断吞掉表达式或 DDL 参数。
export function collectSqlDatabaseLinkStarts(sql: string, databaseType?: DatabaseType): Set<number> {
  const links = new Set<number>();
  if ((databaseType !== "oracle" && databaseType !== "oceanbase-oracle" && databaseType !== "dameng") || !sql.includes("@")) return links;
  const isReservedKeyword = databaseType === "dameng" ? isDamengReservedKeyword : isOracleReservedKeyword;
  const tokens = tokenizeSqlSemantic(sql, "oracle")
    .filter((token) => token.kind !== "comment")
    .flatMap((token) => {
      const marker = token.kind === "word" ? token.text.indexOf("@") : -1;
      if (marker <= 0) return [token];
      // 紧邻 object@link 在语义 tokenizer 中是单个 word；拆分后也必须经过
      // 相同的对象上下文判定，不能把 CONTENT@value 等表达式误当链接。
      return [
        { ...token, text: token.text.slice(0, marker), normalized: token.normalized.slice(0, marker), span: { ...token.span, end: token.span.start + marker } },
        { ...token, text: token.text.slice(marker), normalized: token.normalized.slice(marker), span: { ...token.span, start: token.span.start + marker } },
      ];
    });
  const sqlXmlKeywords = collectSqlXmlKeywordPositions(tokens);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind !== "word" || !token.text.startsWith("@")) continue;
    const isObjectIdentifier = (position: number) => {
      const candidate = tokens[position];
      return candidate && ((candidate.kind === "quoted_identifier" && candidate.quote === '"') || (candidate.kind === "word" && /^[\p{L}_][\p{L}\p{N}_$#]*$/u.test(candidate.text) && !isReservedKeyword(candidate.text)));
    };
    if (!isObjectIdentifier(i - 1)) continue;
    let objectStart = i - 1;
    while (tokens[objectStart - 1]?.text === "." && isObjectIdentifier(objectStart - 2)) objectStart -= 2;
    const prefix = tokens[objectStart - 1]?.normalized ?? "";
    // 只识别表对象上下文或远程调用；CONTENT、BODY、LINK 等表达式/DDL
    // 关键字及带引号的普通表达式后仍允许使用真实模板参数。
    const object = tokens[i - 1];
    // SQL 保留字表未涵盖所有 PL/SQL 控制关键字；只排除未限定的裸关键字，
    // 仍允许带引号对象及 HR.then@link(...) 等限定远程调用。
    const proceduralExpression = objectStart === i - 1 && object.kind === "word" && PLSQL_TEMPLATE_PREFIX_KEYWORDS.has(object.normalized);
    const sqlXmlExpression = objectStart === i - 1 && sqlXmlKeywords.has(objectStart);
    const routineCall = !proceduralExpression && !sqlXmlExpression && tokens[i + 1]?.text === "(" && (object.kind === "quoted_identifier" || !isReservedKeyword(object.text));
    let objectContext = (ORACLE_OBJECT_PREFIX_KEYWORDS.has(prefix) && !(prefix === "update" && tokens[objectStart - 2]?.normalized === "for")) || routineCall;
    const sequenceValue = object.kind === "word" && (object.normalized === "nextval" || object.normalized === "currval") && tokens[i - 2]?.text === "." && isObjectIdentifier(i - 3);
    if (sequenceValue) objectContext = true;
    if (prefix === "for" || prefix === "using") {
      const statementWords: string[] = [];
      for (let j = objectStart - 2; j >= 0; j -= 1) {
        if (tokens[j].text === ";" || tokens[j].depth < token.depth) break;
        if (tokens[j].depth === token.depth && tokens[j].kind === "word") statementWords.unshift(tokens[j].normalized);
      }
      if (prefix === "for") objectContext ||= statementWords[0] === "create" && statementWords.includes("synonym");
      else {
        const mergeIndex = statementWords.lastIndexOf("merge");
        objectContext ||= mergeIndex >= 0 && statementWords[mergeIndex + 1] === "into";
      }
    }
    // A comma can separate tables or expressions. Only a FROM list makes the
    // following non-reserved keyword an object name, including after subqueries.
    if (prefix === ",") {
      for (let j = objectStart - 2; j >= 0; j -= 1) {
        const before = tokens[j];
        if (before.depth < token.depth || before.text === ";") break;
        if (before.depth === token.depth && before.kind === "word" && ORACLE_TABLE_LIST_BOUNDARIES.has(before.normalized)) {
          objectContext = before.normalized === "from" || routineCall;
          break;
        }
      }
    }
    if (objectContext) links.add(token.span.start);
  }
  return links;
}
