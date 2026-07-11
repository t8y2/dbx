import type { ConnectionConfig } from "./connections.js";
import { classifySqlRisk, isSqlRiskMutation } from "./sql-risk.js";

export interface ProductionSqlAssessment {
  active: boolean;
  isMutation: boolean;
  databases: string[];
}

const IDENTIFIER_PATTERN = String.raw`[A-Za-z0-9_@$#-]*[A-Za-z_@$#][A-Za-z0-9_@$#-]*`;
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
const THREE_PART_DATABASE_QUALIFIER_TYPES = new Set(["sqlserver", "snowflake", "trino", "prestosql", "databricks", "bigquery"]);
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
    const beforeSize = databases.size;
    const statementAssessment = classifySqlRisk(statement);
    const statementIsMutation = isSqlRiskMutation(statementAssessment.risk);
    const useMatch = statement.match(USE_RE);
    if (useMatch?.[1]) {
      useDatabase = normalizeTargetDatabase(useMatch[1], quotedIdentifiers);
      continue;
    }
    if (!statementIsMutation) continue;
    if (useDatabase) databases.add(useDatabase);

    collectQualifiedTargetDatabases(statement, dbType, quotedIdentifiers, databases, DML_TARGET_RE, DDL_OBJECT_TARGET_RE, INDEX_ON_TARGET_RE, ROUTINE_CALL_TARGET_RE, PRIVILEGE_TARGET_RE);
    for (const match of statement.matchAll(DATABASE_TARGET_RE)) {
      const database = databaseTargetKindMeansDatabase(match[1], dbType) ? normalizeTargetDatabase(match[2], quotedIdentifiers) : "";
      if (database) databases.add(database);
    }
    for (const match of statement.matchAll(PRIVILEGE_DATABASE_TARGET_RE)) {
      const database = normalizeTargetDatabase(match[1], quotedIdentifiers);
      if (database) databases.add(database);
    }
    const copyTarget = statement.match(COPY_TARGET_RE);
    if (copyTarget?.[1]) {
      const database = databaseFromQualifiedName(copyTarget[1], dbType, quotedIdentifiers);
      if (database) databases.add(database);
    }
    uncertain = uncertain || GLOBAL_PRIVILEGE_TARGET_RE.test(statement) || isAmbiguousProductionTargetStatement(statement, statementAssessment, databases.size > beforeSize, !!(useDatabase || normalizedActiveDatabase));
  }
  return { databases: [...databases], uncertain };
}

function collectQualifiedTargetDatabases(statement: string, dbType: string, quotedIdentifiers: Map<string, string>, databases: Set<string>, ...patterns: RegExp[]): void {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of statement.matchAll(pattern)) {
      const database = databaseFromQualifiedName(match[1], dbType, quotedIdentifiers);
      if (database) databases.add(database);
    }
  }
}

function databaseFromQualifiedName(qualifiedName: string | undefined, dbType: string, quotedIdentifiers: Map<string, string>): string {
  const parts = String(qualifiedName ?? "")
    .split(".")
    .map((part) => normalizeTargetDatabase(part, quotedIdentifiers))
    .filter(Boolean);
  if (parts.length < 2) return "";
  if (qualifiedFirstPartIsDatabase(dbType, parts.length)) return parts[0] ?? "";
  return "";
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

function isAmbiguousProductionTargetStatement(statement: string, assessment: ReturnType<typeof classifySqlRisk>, hasResolvedTarget: boolean, hasCurrentDatabase: boolean): boolean {
  if (!isSqlRiskMutation(assessment.risk)) return false;
  if (assessment.risk === "unknown") return true;
  const firstKeyword = assessment.firstKeyword;
  if (firstKeyword && TARGET_AMBIGUOUS_KEYWORDS.has(firstKeyword) && !hasResolvedTarget) return true;
  if (firstKeyword && UNQUALIFIED_TARGET_KEYWORDS.has(firstKeyword) && !hasResolvedTarget && !hasCurrentDatabase) return true;
  return GLOBAL_DDL_TARGET_RE.test(statement);
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
