import type { ConnectionConfig } from "@/types/database";

export type ConnectionEnvironment = "production" | "non_production" | "unknown";
export type AiSqlExecutionAction = "auto_execute" | "confirm" | "block";
export type AiSqlExecutionCategory = "read" | "low_risk_write" | "write" | "schema_change" | "dangerous" | "unknown";

export interface AiSqlExecutionDecision {
  action: AiSqlExecutionAction;
  environment: ConnectionEnvironment;
  category: AiSqlExecutionCategory;
  reasons: string[];
}

const READ_RE = /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const INSERT_RE = /^INSERT\b/i;
const UPDATE_RE = /^UPDATE\b/i;
const DELETE_RE = /^DELETE\b/i;
const CONFIRM_WRITE_RE = /^(MERGE|REPLACE)\b/i;
const BLOCK_RE = /^(DROP|TRUNCATE|ALTER|RENAME)\b/i;
const SCHEMA_RE = /^(CREATE)\b/i;

const PRODUCTION_RE = /\b(prod|prd|production)\b|生产|正式/i;
const NON_PRODUCTION_RE = /\b(local|localhost|dev|develop|development|test|testing|stage|staging|sandbox|demo)\b|本地|开发|测试|预发/i;
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)$/i;
const NEGATIVE_EXECUTION_RE = /(不要|别|不用|禁止|只生成|仅生成|只写|仅写).{0,12}(执行|运行|跑)|do\s+not\s+execute|don't\s+execute|dont\s+execute|without\s+executing|only\s+(generate|write|return)/i;

export function stripAiSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

function sqlStatements(sql: string): string[] {
  return stripAiSqlComments(sql)
    .split(";")
    .map((stmt) => stmt.trim())
    .filter(Boolean);
}

function classifyStatement(statement: string): AiSqlExecutionCategory {
  if (READ_RE.test(statement)) return "read";
  if (BLOCK_RE.test(statement)) return "dangerous";
  if (SCHEMA_RE.test(statement)) return "schema_change";
  if (INSERT_RE.test(statement)) return "low_risk_write";
  if (UPDATE_RE.test(statement)) return isScopedUpdate(statement) ? "low_risk_write" : "dangerous";
  if (DELETE_RE.test(statement) || CONFIRM_WRITE_RE.test(statement)) return "write";
  return "unknown";
}

function isScopedUpdate(statement: string): boolean {
  const whereMatch = statement.match(/\bWHERE\b([\s\S]*)$/i);
  if (!whereMatch) return false;
  const where = whereMatch[1];
  if (/\b1\s*=\s*1\b|\btrue\b/i.test(where)) return false;
  return /\b[\w"`.[\]]*(?:id|_id|uuid|key)[\w"`.[\]]*\s*=\s*(?:'[^']+'|"[^"]+"|`[^`]+`|[\w.-]+)/i.test(where);
}

export function classifyConnectionEnvironment(connection?: ConnectionConfig): ConnectionEnvironment {
  if (!connection) return "unknown";

  const parts = [connection.name, connection.host, connection.database, connection.connection_string].filter(Boolean);
  const signal = parts.join(" ");
  if (PRODUCTION_RE.test(signal)) return "production";
  if (LOCAL_HOST_RE.test(connection.host) || NON_PRODUCTION_RE.test(signal)) return "non_production";
  return "unknown";
}

export function classifyAiSqlExecution(sql: string, connection?: ConnectionConfig): AiSqlExecutionDecision {
  const environment = classifyConnectionEnvironment(connection);
  const statements = sqlStatements(sql);
  const reasons: string[] = [];

  if (!statements.length) {
    return { action: "block", environment, category: "unknown", reasons: ["empty_sql"] };
  }

  const categories = statements.map(classifyStatement);
  const hasMultipleStatements = statements.length > 1;
  if (hasMultipleStatements) reasons.push("multi_statement");

  if (categories.includes("dangerous")) {
    return { action: "block", environment, category: "dangerous", reasons };
  }

  if (categories.includes("unknown")) {
    return { action: "confirm", environment, category: "unknown", reasons };
  }

  if (categories.every((category) => category === "read")) {
    return { action: "auto_execute", environment, category: "read", reasons };
  }

  if (hasMultipleStatements) {
    return { action: "confirm", environment, category: "write", reasons };
  }

  const [category] = categories;
  if (category === "low_risk_write") {
    return {
      action: environment === "non_production" ? "auto_execute" : "confirm",
      environment,
      category,
      reasons,
    };
  }

  return {
    action: "confirm",
    environment,
    category,
    reasons,
  };
}

export function shouldAttemptAiAutoExecute(instruction: string, action: string): boolean {
  if (action !== "generate") return false;
  const normalized = instruction.trim();
  if (!normalized || NEGATIVE_EXECUTION_RE.test(normalized)) return false;
  return true;
}

export function extractFirstSqlCodeBlock(content: string): string | undefined {
  const match = content.match(/```(?:sql|mysql|postgresql|sqlite|tsql|clickhouse)?\s*\n([\s\S]*?)```/i);
  const sql = match?.[1]?.trim();
  return sql || undefined;
}
