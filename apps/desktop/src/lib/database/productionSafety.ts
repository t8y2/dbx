import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { classifySqlRisk, isSqlRiskMutation, splitSqlStatementsForSafety } from "@/lib/sql/sqlRisk";

export type ProductionContextReason = "connection" | "database" | "sql_target";

export interface ProductionContext {
  active: boolean;
  reason?: ProductionContextReason;
  databases: string[];
}

export interface ProductionSqlAssessment extends ProductionContext {
  isMutation: boolean;
}

const USE_RE = /^\s*USE\s+([`"[]?[^\s;`"\]]+[`"\]]?)/i;
const QUALIFIED_IDENTIFIER_RE = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))/gi;
const DATABASE_TARGET_RE = /\b(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"[]?[^\s;`"\]]+[`"\]]?)/gi;
const COPY_TARGET_RE = /^\s*COPY\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))\s+FROM\b/i;

/**
 * Normalize database identifiers for safety matching while retaining the
 * original display value separately. Safety comparisons intentionally ignore
 * identifier quoting and case so a quoted MySQL production database cannot
 * bypass its marker.
 */
export function normalizeProductionDatabase(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .replace(/^[`"[]|[`"\]]$/g, "")
    .toLowerCase();
}

export function productionDatabases(connection: ConnectionConfig | undefined): string[] {
  if (!connection?.production_databases?.length) return [];
  return [...new Set(connection.production_databases.map(normalizeProductionDatabase).filter(Boolean))];
}

export function productionContextForDatabase(connection: ConnectionConfig | undefined, database: string | undefined | null): ProductionContext {
  if (!connection) return { active: false, databases: [] };
  if (connection.is_production) return { active: true, reason: "connection", databases: [] };

  const normalizedDatabase = normalizeProductionDatabase(database);
  const marked = productionDatabases(connection);
  if (normalizedDatabase && marked.includes(normalizedDatabase)) {
    return { active: true, reason: "database", databases: [String(database)] };
  }
  return { active: false, databases: [] };
}

export function isProductionMutation(sql: string): boolean {
  return isSqlRiskMutation(classifySqlRisk(sql).risk);
}

/**
 * Resolves production scope for the SQL about to run. The active database is
 * authoritative for ordinary statements; MySQL-style USE and qualified names
 * additionally protect production databases referenced from another context.
 */
export function assessProductionSql(sql: string, connection: ConnectionConfig | undefined, activeDatabase: string | undefined | null): ProductionSqlAssessment {
  const activeContext = productionContextForDatabase(connection, activeDatabase);
  const statements = splitSqlStatementsForSafety(sql);
  const risk = classifySqlRisk(sql, { dialect: connection?.db_type });
  const isMutation = isSqlRiskMutation(risk.risk);
  if (!isMutation || !connection) return { ...activeContext, isMutation };
  if (connection.is_production) return { active: true, reason: "connection", databases: [], isMutation };
  if (activeContext.active) return { ...activeContext, isMutation };

  const marked = productionDatabases(connection);
  if (!marked.length || !supportsQualifiedDatabaseNames(connection.db_type)) return { active: false, databases: [], isMutation };

  const targets = referencedDatabases(statements);
  const matched = targets.filter((database) => marked.includes(normalizeProductionDatabase(database)));
  return matched.length ? { active: true, reason: "sql_target", databases: matched, isMutation } : { active: false, databases: [], isMutation };
}

function referencedDatabases(statements: string[]): string[] {
  const databases = new Set<string>();
  let useDatabase = "";

  for (const statement of statements) {
    const useMatch = statement.match(USE_RE);
    if (useMatch?.[1]) {
      useDatabase = normalizeProductionDatabase(useMatch[1]);
      continue;
    }
    if (isSqlRiskMutation(classifySqlRisk(statement).risk) && useDatabase) databases.add(useDatabase);

    QUALIFIED_IDENTIFIER_RE.lastIndex = 0;
    for (const match of statement.matchAll(QUALIFIED_IDENTIFIER_RE)) {
      const database = normalizeProductionDatabase(match[1]?.split(".")[0]);
      if (database) databases.add(database);
    }
    for (const match of statement.matchAll(DATABASE_TARGET_RE)) {
      const database = normalizeProductionDatabase(match[1]);
      if (database) databases.add(database);
    }
    const copyTarget = statement.match(COPY_TARGET_RE);
    if (copyTarget?.[1]) {
      const database = normalizeProductionDatabase(copyTarget[1].split(".")[0]);
      if (database) databases.add(database);
    }
  }
  return [...databases];
}

function supportsQualifiedDatabaseNames(dbType: DatabaseType): boolean {
  return ["mysql", "goldendb", "doris", "starrocks", "clickhouse", "sqlserver"].includes(dbType);
}
