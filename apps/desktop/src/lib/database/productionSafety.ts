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

const IDENTIFIER_PATTERN = String.raw`(?=[A-Za-z0-9_@$#-]*[A-Za-z_@$#])[A-Za-z0-9_@$#-]+`;
const QUALIFIED_NAME_PATTERN = String.raw`${IDENTIFIER_PATTERN}\s*\.\s*(?:\*|${IDENTIFIER_PATTERN})(?:\s*\.\s*(?:\*|${IDENTIFIER_PATTERN}))?`;
const USE_RE = new RegExp(String.raw`^\s*USE\s+(${IDENTIFIER_PATTERN})`, "i");
const DML_TARGET_RE = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+(${QUALIFIED_NAME_PATTERN})`, "gi");
const DDL_OBJECT_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TRIGGER|EVENT|TYPE|SYNONYM)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED_NAME_PATTERN})`, "gi");
const INDEX_ON_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(${QUALIFIED_NAME_PATTERN})`, "gi");
const DATABASE_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(DATABASE|SCHEMA|CATALOG)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${IDENTIFIER_PATTERN})`, "gi");
const COPY_TARGET_RE = new RegExp(String.raw`^\s*COPY\s+(${QUALIFIED_NAME_PATTERN})\s+FROM\b`, "i");
const ROUTINE_CALL_TARGET_RE = new RegExp(String.raw`\b(?:CALL|EXEC|EXECUTE)\s+(${QUALIFIED_NAME_PATTERN})`, "gi");
const PRIVILEGE_TARGET_RE = new RegExp(String.raw`\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+(?:(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|OBJECT)\s+|OBJECT\s*::\s*)?(${QUALIFIED_NAME_PATTERN})`, "gi");
const PRIVILEGE_DATABASE_TARGET_RE = new RegExp(String.raw`\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+(?:DATABASE|CATALOG)(?:::|\s+)\s*(${IDENTIFIER_PATTERN})`, "gi");
const GLOBAL_PRIVILEGE_TARGET_RE = /\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+\*\s*\.\s*\*/i;
const GLOBAL_DDL_TARGET_RE = /^\s*(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE|LOGIN|SERVER|TABLESPACE|RESOURCE|PROFILE|ACCOUNT)\b/i;
const TARGET_AMBIGUOUS_KEYWORDS = new Set(["call", "exec", "execute", "grant", "revoke", "deny"]);
const UNQUALIFIED_TARGET_KEYWORDS = new Set(["insert", "update", "delete", "merge", "replace", "load", "copy", "truncate", "create", "alter", "drop"]);
const THREE_PART_DATABASE_QUALIFIER_TYPES = new Set<DatabaseType>(["sqlserver", "snowflake", "trino", "prestosql", "databricks", "bigquery"]);
const SCHEMA_FIRST_QUALIFIER_TYPES = new Set<DatabaseType>([
  "postgres",
  "redshift",
  "gaussdb",
  "kwdb",
  "opengauss",
  "kingbase",
  "highgo",
  "vastbase",
  "yashandb",
  "oracle",
  "oceanbase-oracle",
  "dameng",
  "firebird",
  "exasol",
  "teradata",
  "vertica",
  "db2",
  "informix",
  "h2",
  "iris",
  "xugu",
  "oscar",
  "gbase",
  "saphana",
  "sqlserver",
  "snowflake",
  "trino",
  "prestosql",
  "databricks",
  "bigquery",
]);

interface ReferencedDatabaseAssessment {
  databases: string[];
  uncertain: boolean;
}

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
  if (!marked.length) return { active: false, databases: [], isMutation };

  const targets = referencedDatabases(statements, connection.db_type, activeDatabase);
  const matched = targets.databases.filter((database) => marked.includes(normalizeProductionDatabase(database)));
  if (matched.length) return { active: true, reason: "sql_target", databases: matched, isMutation };
  if (targets.uncertain) return { active: true, reason: "sql_target", databases: marked, isMutation };
  return { active: false, databases: [], isMutation };
}

function referencedDatabases(statements: string[], dbType: DatabaseType, activeDatabase: string | undefined | null): ReferencedDatabaseAssessment {
  const databases = new Set<string>();
  let uncertain = false;
  let useDatabase = "";
  const normalizedActiveDatabase = normalizeProductionDatabase(activeDatabase);

  for (const statement of statements) {
    const beforeSize = databases.size;
    const statementAssessment = classifySqlRisk(statement, { dialect: dbType });
    const statementIsMutation = isSqlRiskMutation(statementAssessment.risk);
    const useMatch = statement.match(USE_RE);
    if (useMatch?.[1]) {
      useDatabase = normalizeProductionDatabase(useMatch[1]);
      continue;
    }
    if (!statementIsMutation) continue;
    if (useDatabase) databases.add(useDatabase);

    collectQualifiedTargetDatabases(statement, dbType, databases, DML_TARGET_RE, DDL_OBJECT_TARGET_RE, INDEX_ON_TARGET_RE, ROUTINE_CALL_TARGET_RE, PRIVILEGE_TARGET_RE);
    for (const match of statement.matchAll(DATABASE_TARGET_RE)) {
      const database = databaseTargetKindMeansDatabase(match[1], dbType) ? normalizeProductionDatabase(match[2]) : "";
      if (database) databases.add(database);
    }
    for (const match of statement.matchAll(PRIVILEGE_DATABASE_TARGET_RE)) {
      const database = normalizeProductionDatabase(match[1]);
      if (database) databases.add(database);
    }
    const copyTarget = statement.match(COPY_TARGET_RE);
    if (copyTarget?.[1]) {
      const database = databaseFromQualifiedName(copyTarget[1], dbType);
      if (database) databases.add(database);
    }
    uncertain = uncertain || GLOBAL_PRIVILEGE_TARGET_RE.test(statement) || isAmbiguousProductionTargetStatement(statement, statementAssessment, databases.size > beforeSize, !!(useDatabase || normalizedActiveDatabase));
  }
  return { databases: [...databases], uncertain };
}

function collectQualifiedTargetDatabases(statement: string, dbType: DatabaseType, databases: Set<string>, ...patterns: RegExp[]): void {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of statement.matchAll(pattern)) {
      const database = databaseFromQualifiedName(match[1], dbType);
      if (database) databases.add(database);
    }
  }
}

function databaseFromQualifiedName(qualifiedName: string | undefined, dbType: DatabaseType): string {
  const parts = String(qualifiedName ?? "")
    .split(".")
    .map(normalizeProductionDatabase)
    .filter(Boolean);
  if (parts.length < 2) return "";
  if (qualifiedFirstPartIsDatabase(dbType, parts.length)) return parts[0] ?? "";
  return "";
}

function qualifiedFirstPartIsDatabase(dbType: DatabaseType, partCount: number): boolean {
  if (partCount >= 3 && THREE_PART_DATABASE_QUALIFIER_TYPES.has(dbType)) return true;
  if (SCHEMA_FIRST_QUALIFIER_TYPES.has(dbType)) return false;
  return partCount >= 2;
}

function databaseTargetKindMeansDatabase(kind: string | undefined, dbType: DatabaseType): boolean {
  const normalizedKind = String(kind ?? "").toLowerCase();
  if (normalizedKind === "database" || normalizedKind === "catalog") return true;
  if (normalizedKind !== "schema") return false;
  return !SCHEMA_FIRST_QUALIFIER_TYPES.has(dbType);
}

function isAmbiguousProductionTargetStatement(statement: string, assessment: ReturnType<typeof classifySqlRisk>, hasResolvedTarget: boolean, hasCurrentDatabase: boolean): boolean {
  if (!isSqlRiskMutation(assessment.risk)) return false;
  if (assessment.risk === "unknown") return true;
  const firstKeyword = assessment.firstKeyword;
  if (firstKeyword && TARGET_AMBIGUOUS_KEYWORDS.has(firstKeyword) && !hasResolvedTarget) return true;
  if (firstKeyword && UNQUALIFIED_TARGET_KEYWORDS.has(firstKeyword) && !hasResolvedTarget && !hasCurrentDatabase) return true;
  return GLOBAL_DDL_TARGET_RE.test(statement);
}
