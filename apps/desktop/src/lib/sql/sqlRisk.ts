import type { DatabaseType } from "@/types/database";

export type SqlRiskLevel = "read" | "write" | "ddl" | "transaction" | "unknown";

export interface SqlRiskStatementAssessment {
  risk: SqlRiskLevel;
  firstKeyword?: string;
}

export interface SqlRiskAssessment extends SqlRiskStatementAssessment {
  statements: SqlRiskStatementAssessment[];
}

interface SqlRiskOptions {
  dialect?: DatabaseType | string;
}

interface SqlRiskToken {
  text: string;
  normalized: string;
}

const READ_KEYWORDS = new Set(["select", "show", "describe", "desc", "values", "table"]);
const WRITE_KEYWORDS = new Set(["insert", "update", "delete", "merge", "replace", "upsert", "load", "call", "exec", "execute", "flush"]);
const DDL_KEYWORDS = new Set(["create", "alter", "drop", "truncate", "rename", "grant", "revoke", "deny", "comment", "reindex", "vacuum", "optimize"]);
const TRANSACTION_KEYWORDS = new Set(["begin", "start", "commit", "rollback", "abort", "savepoint", "release"]);
const EXPLAIN_OPTION_KEYWORDS = new Set(["explain", "analyze", "analyse", "verbose", "query", "plan", "format", "type", "costs", "buffers", "timing", "summary", "settings", "wal", "generic_plan"]);
const PRIMARY_STATEMENT_KEYWORDS = new Set([...READ_KEYWORDS, ...WRITE_KEYWORDS, ...DDL_KEYWORDS, ...TRANSACTION_KEYWORDS, "with", "copy", "pragma", "use", "set"]);
const SAFE_READ_PRAGMA_NAMES = new Set(["table_info", "table_xinfo", "index_list", "index_info", "foreign_key_list", "database_list", "compile_options", "data_version"]);

const RISK_ORDER: Record<SqlRiskLevel, number> = {
  read: 0,
  write: 1,
  ddl: 2,
  transaction: 3,
  unknown: 4,
};

export function splitSqlStatementsForSafety(sql: string): string[] {
  return sqlSafetyText(sql)
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function classifySqlRisk(sql: string, options: SqlRiskOptions = {}): SqlRiskAssessment {
  const statements = splitSqlStatementsForSafety(sql).map((statement) => classifySqlStatementRisk(statement, options));
  if (!statements.length) return { risk: "unknown", statements: [] };
  const highest = statements.reduce<SqlRiskStatementAssessment>((current, statement) => (RISK_ORDER[statement.risk] > RISK_ORDER[current.risk] ? statement : current), { risk: "read" });
  return { ...highest, statements };
}

export function classifySqlStatementRisk(sql: string, _options: SqlRiskOptions = {}): SqlRiskStatementAssessment {
  return classifyTokens(tokenizeSqlForRisk(sql));
}

export function isSqlRiskMutation(risk: SqlRiskLevel): boolean {
  return risk !== "read";
}

export function sqlSafetyText(sql: string): string {
  let output = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (char === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      output += " ";
      continue;
    }

    if (char === "#") {
      index += 1;
      while (index < sql.length && sql[index] !== "\n" && sql[index] !== "\r") index += 1;
      output += " ";
      continue;
    }

    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      if (close < 0) return output;
      const executablePrefixLength = mysqlExecutableCommentPrefixLength(sql, index);
      if (executablePrefixLength > 0) {
        const bodyStart = skipExecutableCommentVersion(sql, index + executablePrefixLength);
        output += ` ${sqlSafetyText(sql.slice(bodyStart, close))} `;
      } else {
        output += " ";
      }
      index = close + 2;
      continue;
    }

    const dollarQuote = dollarQuoteTagAt(sql, index);
    if (dollarQuote) {
      const close = sql.indexOf(dollarQuote, index + dollarQuote.length);
      index = close < 0 ? sql.length : close + dollarQuote.length;
      output += " ";
      continue;
    }

    if (char === "'") {
      index = readQuotedEnd(sql, index, "'", "'");
      output += " ";
      continue;
    }

    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      const end = readQuotedEnd(sql, index, char, close);
      output += ` ${unquoteIdentifier(sql.slice(index, end), char, close).replace(/[;]/g, " ")} `;
      index = end;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

function tokenizeSqlForRisk(sql: string): SqlRiskToken[] {
  const tokens: SqlRiskToken[] = [];
  const re = /[A-Za-z_@$#][A-Za-z0-9_@$#-]*|[0-9]+|[(),.;*]|\S/g;
  for (const match of sql.matchAll(re)) {
    const text = match[0];
    tokens.push({ text, normalized: /^[A-Za-z_@$#]/.test(text) ? text.toLowerCase() : text });
  }
  return tokens;
}

function classifyTokens(tokens: SqlRiskToken[]): SqlRiskStatementAssessment {
  const useful = trimWrappingParentheses(tokens);
  const firstKeyword = useful.find((token) => /^[a-z_]/i.test(token.text))?.normalized;
  if (!firstKeyword) return { risk: "unknown" };

  if (READ_KEYWORDS.has(firstKeyword)) {
    return { risk: firstKeyword === "select" && hasTopLevelSelectInto(useful) ? "write" : "read", firstKeyword };
  }

  if (firstKeyword === "with") {
    return { risk: highestRiskInTokens(useful) ?? "read", firstKeyword };
  }

  if (firstKeyword === "explain") {
    return classifyExplainTokens(useful);
  }

  if (firstKeyword === "copy") {
    return { risk: classifyCopyTokens(useful), firstKeyword };
  }

  if (firstKeyword === "pragma") {
    return { risk: classifyPragmaTokens(useful), firstKeyword };
  }

  if (firstKeyword === "use") return { risk: "read", firstKeyword };
  if (WRITE_KEYWORDS.has(firstKeyword)) return { risk: "write", firstKeyword };
  if (DDL_KEYWORDS.has(firstKeyword)) return { risk: "ddl", firstKeyword };
  if (TRANSACTION_KEYWORDS.has(firstKeyword)) return { risk: "transaction", firstKeyword };

  // Unknown statements are treated as unsafe until a dialect-aware parser can
  // prove they are read-only.
  return { risk: "unknown", firstKeyword };
}

function classifyExplainTokens(tokens: SqlRiskToken[]): SqlRiskStatementAssessment {
  const analyze = tokens.some((token) => token.normalized === "analyze" || token.normalized === "analyse");
  const innerIndex = tokens.findIndex((token, index) => index > 0 && PRIMARY_STATEMENT_KEYWORDS.has(token.normalized) && !EXPLAIN_OPTION_KEYWORDS.has(token.normalized));
  if (innerIndex < 0) return { risk: "read", firstKeyword: "explain" };
  const inner = classifyTokens(tokens.slice(innerIndex));
  if (!analyze) return { risk: inner.risk === "unknown" ? "unknown" : "read", firstKeyword: "explain" };
  return { risk: inner.risk, firstKeyword: inner.firstKeyword ?? "explain" };
}

function classifyCopyTokens(tokens: SqlRiskToken[]): SqlRiskLevel {
  if (tokens.some((token) => token.normalized === "from")) return "write";
  if (tokens.some((token) => token.normalized === "to")) return "read";
  return "unknown";
}

function classifyPragmaTokens(tokens: SqlRiskToken[]): SqlRiskLevel {
  const name = tokens.find((token, index) => index > 0 && /^[a-z_]/i.test(token.text))?.normalized;
  if (name && SAFE_READ_PRAGMA_NAMES.has(name) && !tokens.some((token) => token.text === "=")) return "read";
  return "write";
}

function highestRiskInTokens(tokens: SqlRiskToken[]): SqlRiskLevel | undefined {
  let result: SqlRiskLevel | undefined;
  for (const token of tokens) {
    const risk = WRITE_KEYWORDS.has(token.normalized) ? "write" : DDL_KEYWORDS.has(token.normalized) ? "ddl" : TRANSACTION_KEYWORDS.has(token.normalized) ? "transaction" : undefined;
    if (risk && (!result || RISK_ORDER[risk] > RISK_ORDER[result])) result = risk;
  }
  return result;
}

function hasTopLevelSelectInto(tokens: SqlRiskToken[]): boolean {
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "(") depth += 1;
    if (token.text === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    if (token.normalized === "into") return true;
  }
  return false;
}

function trimWrappingParentheses(tokens: SqlRiskToken[]): SqlRiskToken[] {
  let start = 0;
  let end = tokens.length;
  while (tokens[start]?.text === "(" && matchingParenIndex(tokens, start) === end - 1) {
    start += 1;
    end -= 1;
  }
  return tokens.slice(start, end);
}

function matchingParenIndex(tokens: readonly SqlRiskToken[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.text === "(") depth += 1;
    if (tokens[index]?.text === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function mysqlExecutableCommentPrefixLength(sql: string, index: number): number {
  if (sql[index] !== "/" || sql[index + 1] !== "*") return 0;
  if (sql[index + 2] === "!") return 3;
  if (sql[index + 2] === "M" && sql[index + 3] === "!") return 4;
  return 0;
}

function skipExecutableCommentVersion(sql: string, index: number): number {
  let cursor = index;
  while (cursor < sql.length && /[0-9\s]/.test(sql[cursor] ?? "")) cursor += 1;
  return cursor;
}

function dollarQuoteTagAt(sql: string, index: number): string | undefined {
  const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
  return match?.[0];
}

function readQuotedEnd(sql: string, start: number, open: string, close: string): number {
  let index = start + open.length;
  while (index < sql.length) {
    if (sql[index] === "\\" && (open === "'" || open === '"')) {
      index += 2;
      continue;
    }
    if (sql.startsWith(close, index)) {
      if (sql.startsWith(close + close, index)) {
        index += close.length * 2;
        continue;
      }
      return index + close.length;
    }
    index += 1;
  }
  return sql.length;
}

function unquoteIdentifier(value: string, open: string, close: string): string {
  if (!value.startsWith(open) || !value.endsWith(close)) return value;
  return value.slice(open.length, value.length - close.length).replaceAll(close + close, close);
}
