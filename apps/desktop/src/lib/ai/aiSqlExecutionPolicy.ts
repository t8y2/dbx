import type { ConnectionConfig } from "@/types/database";
import { assessProductionSql, productionContextForDatabase } from "@/lib/database/productionSafety";
import { classifySqlStatementRisk, splitSqlStatementsForSafety, sqlSafetyText } from "@/lib/sql/sqlRisk";

export type ConnectionEnvironment = "production" | "non_production" | "unknown";
export type AiSqlExecutionAction = "auto_execute" | "confirm" | "block";
export type AiSqlExecutionCategory = "read" | "low_risk_write" | "write" | "schema_change" | "dangerous" | "unknown";

export interface AiSqlExecutionDecision {
  action: AiSqlExecutionAction;
  environment: ConnectionEnvironment;
  category: AiSqlExecutionCategory;
  reasons: string[];
}

const PRODUCTION_RE = /\b(prod|prd|production)\b|生产|正式/i;
const NON_PRODUCTION_RE = /\b(local|localhost|dev|develop|development|test|testing|stage|staging|sandbox|demo)\b|本地|开发|测试|预发/i;
const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1)$/i;
const NEGATIVE_EXECUTION_RE = /(不要|别|不用|禁止|只生成|仅生成|只写|仅写).{0,12}(执行|运行|跑)|do\s+not\s+execute|don't\s+execute|dont\s+execute|without\s+executing|only\s+(generate|write|return)/i;

export function stripAiSqlComments(sql: string): string {
  return sqlSafetyText(sql);
}

function sqlStatements(sql: string): string[] {
  return splitSqlStatementsForSafety(sql);
}

function classifyStatement(statement: string, connection?: ConnectionConfig): AiSqlExecutionCategory {
  const risk = classifySqlStatementRisk(statement, { dialect: connection?.db_type });
  if (risk.risk === "read") return "read";
  if (risk.risk === "unknown") return "unknown";
  if (risk.risk === "transaction" || risk.risk === "ddl") {
    return risk.firstKeyword === "create" ? "schema_change" : "dangerous";
  }
  if (risk.firstKeyword === "insert") return "low_risk_write";
  if (risk.firstKeyword === "update") return isScopedUpdate(statement) ? "low_risk_write" : "dangerous";
  if (risk.firstKeyword === "delete" || risk.firstKeyword === "merge" || risk.firstKeyword === "replace") return "write";
  return "unknown";
}

function isScopedUpdate(statement: string): boolean {
  const whereMatch = statement.match(/\bWHERE\b([\s\S]*)$/i);
  if (!whereMatch) return false;
  const where = whereMatch[1];
  if (/\b1\s*=\s*1\b|\btrue\b/i.test(where)) return false;
  return /\b[\w"`.[\]]*(?:id|_id|uuid|key)[\w"`.[\]]*\s*=\s*(?:'[^']+'|"[^"]+"|`[^`]+`|[\w.-]+)/i.test(where);
}

export function classifyConnectionEnvironment(connection?: ConnectionConfig, database?: string): ConnectionEnvironment {
  if (!connection) return "unknown";
  if (productionContextForDatabase(connection, database).active) return "production";

  const parts = [connection.name, connection.host, connection.database, connection.connection_string].filter(Boolean);
  const signal = parts.join(" ");
  if (PRODUCTION_RE.test(signal)) return "production";
  if (LOCAL_HOST_RE.test(connection.host) || NON_PRODUCTION_RE.test(signal)) return "non_production";
  return "unknown";
}

export function classifyAiSqlExecution(sql: string, connection?: ConnectionConfig, database?: string): AiSqlExecutionDecision {
  const environment = classifyConnectionEnvironment(connection, database);
  const statements = sqlStatements(sql);
  const reasons: string[] = [];

  if (!statements.length) {
    return { action: "block", environment, category: "unknown", reasons: ["empty_sql"] };
  }

  const categories = statements.map((statement) => classifyStatement(statement, connection));
  const hasMultipleStatements = statements.length > 1;
  if (hasMultipleStatements) reasons.push("multi_statement");
  const productionAssessment = assessProductionSql(sql, connection, database);

  if (categories.includes("dangerous")) {
    return { action: "block", environment, category: "dangerous", reasons };
  }

  if (categories.includes("unknown")) {
    return { action: "confirm", environment, category: "unknown", reasons };
  }

  if (categories.every((category) => category === "read")) {
    return { action: "auto_execute", environment, category: "read", reasons };
  }

  if (productionAssessment.active && productionAssessment.isMutation) {
    reasons.push("production_write");
    return { action: "confirm", environment: "production", category: categories[0] ?? "unknown", reasons };
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
