import type { ConnectionConfig } from "./connections.js";
import { classifySqlRisk, isSqlRiskMutation } from "./sql-risk.js";

export interface ProductionSqlAssessment {
  active: boolean;
  isMutation: boolean;
  databases: string[];
}

const IDENTIFIER_PATTERN = String.raw`[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*`;
const TARGET_NAME_PATTERN = String.raw`${IDENTIFIER_PATTERN}(?:\s*\.\s*(?:\*|${IDENTIFIER_PATTERN})){0,2}`;
const QUALIFIED_NAME_PATTERN = String.raw`${IDENTIFIER_PATTERN}\s*\.\s*(?:\*|${IDENTIFIER_PATTERN})(?:\s*\.\s*(?:\*|${IDENTIFIER_PATTERN}))?`;
const USE_RE = new RegExp(String.raw`^\s*USE\s+(${IDENTIFIER_PATTERN})`, "i");
const DML_TARGET_RE = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INTO|REFERENCES)\s+(${TARGET_NAME_PATTERN})`, "gi");
const DDL_OBJECT_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|INDEX|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|TRIGGER|EVENT|TYPE|SYNONYM)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(?:ONLY\s+)?(${TARGET_NAME_PATTERN})`, "gi");
const INDEX_ON_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*?\bON\s+(${TARGET_NAME_PATTERN})`, "gi");
const DATABASE_TARGET_RE = new RegExp(String.raw`\b(?:CREATE|ALTER|DROP)\s+(DATABASE|SCHEMA|CATALOG)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(${IDENTIFIER_PATTERN})`, "gi");
const COPY_TARGET_RE = new RegExp(String.raw`^\s*COPY\s+(${TARGET_NAME_PATTERN})\s+FROM\b`, "i");
const TRUNCATE_TARGET_RE = new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(${TARGET_NAME_PATTERN})`, "gi");
const RENAME_TABLE_TARGET_RE = new RegExp(String.raw`\bRENAME\s+TABLE\s+(${TARGET_NAME_PATTERN})\s+TO\s+(${TARGET_NAME_PATTERN})`, "gi");
const MAINTENANCE_TABLE_TARGET_RE = new RegExp(String.raw`\b(?:ANALYZE|OPTIMIZE|REPAIR|CHECK)\s+(?:NO_WRITE_TO_BINLOG\s+|LOCAL\s+)?TABLE\s+(${TARGET_NAME_PATTERN})`, "gi");
const COMMENT_TARGET_RE = new RegExp(String.raw`\bCOMMENT\s+ON\s+(?:TABLE|VIEW|COLUMN|INDEX|SEQUENCE|FUNCTION|PROCEDURE|TYPE)\s+(${TARGET_NAME_PATTERN})`, "gi");
const ROUTINE_CALL_TARGET_RE = new RegExp(String.raw`\b(?:CALL|EXEC|EXECUTE)\s+(${QUALIFIED_NAME_PATTERN})`, "gi");
const PRIVILEGE_TARGET_RE = new RegExp(String.raw`\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+(?:(?:TABLE|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|OBJECT)\s+|OBJECT\s*::\s*)?(${QUALIFIED_NAME_PATTERN})`, "gi");
const PRIVILEGE_DATABASE_TARGET_RE = new RegExp(String.raw`\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+(?:DATABASE|CATALOG)(?:::|\s+)\s*(${IDENTIFIER_PATTERN})`, "gi");
const GLOBAL_PRIVILEGE_TARGET_RE = /\b(?:GRANT|REVOKE|DENY)\b[\s\S]*?\bON\s+\*\s*\.\s*\*/i;
const GLOBAL_DDL_TARGET_RE = /^\s*(?:CREATE|ALTER|DROP)\s+(?:USER|ROLE|LOGIN|SERVER|TABLESPACE|RESOURCE|PROFILE|ACCOUNT)\b/i;
const MULTI_TARGET_MUTATION_RE = /^\s*(?:DROP\s+(?:TEMPORARY\s+)?TABLE\b[\s\S]*,|RENAME\s+TABLE\b[\s\S]*,)/i;
const THREE_PART_DATABASE_QUALIFIER_TYPES = new Set(["sqlserver", "snowflake", "trino", "prestosql", "databricks", "bigquery"]);
const TRANSACTION_KEYWORDS = new Set(["begin", "start", "commit", "rollback", "abort", "savepoint", "release"]);
const SCHEMA_FIRST_QUALIFIER_TYPES = new Set([
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

interface SqlTargetSafetyText {
  text: string;
  quotedIdentifiers: Map<string, string>;
}

/** Normalizes quoted database names before production scope comparison. */
export function normalizeProductionDatabase(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .replace(/^[`"[]|[`"\]]$/g, "")
    .toLowerCase();
}

export function isProductionDatabase(config: ConnectionConfig | undefined, database?: string): boolean {
  if (!config) return false;
  if (config.is_production) return true;
  const selected = normalizeProductionDatabase(database);
  return !!selected && (config.production_databases ?? []).some((name) => normalizeProductionDatabase(name) === selected);
}

/**
 * Finds writes that target a marked production database, including a MySQL
 * USE switch or a qualified database.table reference in a statement batch.
 */
export function assessProductionSql(sql: string, config: ConnectionConfig | undefined, activeDatabase?: string): ProductionSqlAssessment {
  const targetText = sqlTargetSafetyText(sql);
  const statements = splitTargetStatements(targetText.text);
  const isMutation = isSqlRiskMutation(classifySqlRisk(sql).risk);
  if (!isMutation || !config) return { active: isProductionDatabase(config, activeDatabase), isMutation, databases: [] };
  if (config.is_production) return { active: true, isMutation, databases: [] };
  if (isProductionDatabase(config, activeDatabase)) return { active: true, isMutation, databases: activeDatabase ? [activeDatabase] : [] };

  const marked = new Set((config.production_databases ?? []).map(normalizeProductionDatabase).filter(Boolean));
  if (!marked.size) return { active: false, isMutation, databases: [] };

  const targets = referencedDatabases(statements, config.db_type, activeDatabase, targetText.quotedIdentifiers);
  const databases = targets.databases.filter((database) => marked.has(normalizeProductionDatabase(database)));
  return { active: databases.length > 0 || targets.uncertain, isMutation, databases: databases.length > 0 ? databases : targets.uncertain ? [...marked] : [] };
}

function referencedDatabases(statements: string[], dbType: string, activeDatabase: string | undefined, quotedIdentifiers: Map<string, string>): ReferencedDatabaseAssessment {
  const databases = new Set<string>();
  let uncertain = false;
  let useDatabase = "";
  const normalizedActiveDatabase = normalizeProductionDatabase(activeDatabase);

  for (const statement of statements) {
    const statementDatabases = new Set<string>();
    const statementAssessment = classifySqlRisk(statement);
    const statementIsMutation = isSqlRiskMutation(statementAssessment.risk);
    const useMatch = statement.match(USE_RE);
    if (useMatch?.[1]) {
      useDatabase = normalizeTargetDatabase(useMatch[1], quotedIdentifiers);
      continue;
    }
    if (!statementIsMutation) continue;
    const currentDatabase = useDatabase || normalizedActiveDatabase;

    collectQualifiedTargetDatabases(statement, dbType, quotedIdentifiers, currentDatabase, statementDatabases, DML_TARGET_RE, DDL_OBJECT_TARGET_RE, INDEX_ON_TARGET_RE, TRUNCATE_TARGET_RE, MAINTENANCE_TABLE_TARGET_RE, COMMENT_TARGET_RE, ROUTINE_CALL_TARGET_RE, PRIVILEGE_TARGET_RE);
    collectQualifiedTargetDatabaseGroups(statement, dbType, quotedIdentifiers, currentDatabase, statementDatabases, RENAME_TABLE_TARGET_RE, [1, 2]);
    for (const match of statement.matchAll(DATABASE_TARGET_RE)) {
      const database = databaseTargetKindMeansDatabase(match[1], dbType) ? normalizeTargetDatabase(match[2], quotedIdentifiers) : "";
      if (database) statementDatabases.add(database);
    }
    for (const match of statement.matchAll(PRIVILEGE_DATABASE_TARGET_RE)) {
      const database = normalizeTargetDatabase(match[1], quotedIdentifiers);
      if (database) statementDatabases.add(database);
    }
    const copyTarget = statement.match(COPY_TARGET_RE);
    if (copyTarget?.[1]) {
      const database = databaseFromQualifiedName(copyTarget[1], dbType, quotedIdentifiers, currentDatabase);
      if (database) statementDatabases.add(database);
    }
    for (const database of statementDatabases) databases.add(database);
    // The target regexes intentionally extract one object at a time. Until all
    // list forms are parsed, never let a resolved first target disable fallback.
    uncertain = uncertain || GLOBAL_PRIVILEGE_TARGET_RE.test(statement) || MULTI_TARGET_MUTATION_RE.test(statement) || isAmbiguousProductionTargetStatement(statement, statementAssessment, statementDatabases.size > 0);
  }
  return { databases: [...databases], uncertain };
}

function collectQualifiedTargetDatabases(statement: string, dbType: string, quotedIdentifiers: Map<string, string>, currentDatabase: string, databases: Set<string>, ...patterns: RegExp[]): void {
  for (const pattern of patterns) {
    collectQualifiedTargetDatabaseGroups(statement, dbType, quotedIdentifiers, currentDatabase, databases, pattern, [1]);
  }
}

function collectQualifiedTargetDatabaseGroups(statement: string, dbType: string, quotedIdentifiers: Map<string, string>, currentDatabase: string, databases: Set<string>, pattern: RegExp, captureIndexes: number[]): void {
  pattern.lastIndex = 0;
  for (const match of statement.matchAll(pattern)) {
    for (const captureIndex of captureIndexes) {
      const database = databaseFromQualifiedName(match[captureIndex], dbType, quotedIdentifiers, currentDatabase);
      if (database) databases.add(database);
    }
  }
}

function databaseFromQualifiedName(qualifiedName: string | undefined, dbType: string, quotedIdentifiers: Map<string, string>, currentDatabase: string): string {
  const parts = String(qualifiedName ?? "")
    .split(".")
    .map((part) => normalizeTargetDatabase(part, quotedIdentifiers))
    .filter(Boolean);
  if (parts.length < 2) return currentDatabase;
  if (qualifiedFirstPartIsDatabase(dbType, parts.length)) return parts[0] ?? "";
  return currentDatabase;
}

function normalizeTargetDatabase(value: string | undefined, quotedIdentifiers: Map<string, string>): string {
  const normalized = normalizeProductionDatabase(value);
  const quoted = quotedIdentifiers.get(normalized);
  return quoted === undefined ? normalized : normalizeProductionDatabase(quoted);
}

function qualifiedFirstPartIsDatabase(dbType: string, partCount: number): boolean {
  const normalizedType = dbType.toLowerCase();
  if (partCount >= 3 && THREE_PART_DATABASE_QUALIFIER_TYPES.has(normalizedType)) return true;
  if (SCHEMA_FIRST_QUALIFIER_TYPES.has(normalizedType)) return false;
  return partCount >= 2;
}

function databaseTargetKindMeansDatabase(kind: string | undefined, dbType: string): boolean {
  const normalizedKind = String(kind ?? "").toLowerCase();
  if (normalizedKind === "database" || normalizedKind === "catalog") return true;
  if (normalizedKind !== "schema") return false;
  return !SCHEMA_FIRST_QUALIFIER_TYPES.has(dbType.toLowerCase());
}

function isAmbiguousProductionTargetStatement(statement: string, assessment: ReturnType<typeof classifySqlRisk>, hasResolvedTarget: boolean): boolean {
  if (!isSqlRiskMutation(assessment.risk)) return false;
  if (assessment.risk === "transaction") return false;
  const firstKeyword = assessment.firstKeyword;
  if (firstKeyword && TRANSACTION_KEYWORDS.has(firstKeyword)) return false;
  return GLOBAL_DDL_TARGET_RE.test(statement) || !hasResolvedTarget;
}

function splitTargetStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function sqlTargetSafetyText(sql: string, quotedIdentifiers = new Map<string, string>()): SqlTargetSafetyText {
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
      if (close < 0) return { text: output, quotedIdentifiers };
      const executablePrefixLength = mysqlExecutableCommentPrefixLength(sql, index);
      if (executablePrefixLength > 0) {
        const bodyStart = skipExecutableCommentVersion(sql, index + executablePrefixLength);
        output += ` ${sqlTargetSafetyText(sql.slice(bodyStart, close), quotedIdentifiers).text} `;
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
      const identifier = unquoteIdentifier(sql.slice(index, end), char, close).replace(/[;]/g, " ");
      const token = `__dbxq${quotedIdentifiers.size}__`;
      quotedIdentifiers.set(token.toLowerCase(), identifier);
      output += ` ${token} `;
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return { text: output, quotedIdentifiers };
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
  return sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
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

/** MCP receives Mongo shell text rather than SQL, so use a conservative write detector. */
export function isLikelyMongoMutation(command: string): boolean {
  return /\.(?:insert(?:One|Many)?|update(?:One|Many)?|replaceOne|delete(?:One|Many)?|findOneAnd(?:Update|Replace|Delete)|drop(?:Index|Indexes)?|renameCollection|createIndex)\s*\(|\bdb\.createCollection\s*\(/i.test(command);
}
