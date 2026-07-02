import { splitSqlStatementRanges } from "@/lib/sqlStatementRanges";
import { supportsCreateDatabaseCharset } from "@/lib/createDatabaseSql";
import type { ConnectionConfig, DatabaseType } from "@/types/database";

const MYSQL_BOOTSTRAP_EXTRA_PROFILES = new Set(["selectdb", "goldendb"]);

type BootstrapConnection = Pick<ConnectionConfig, "db_type" | "driver_profile">;
type ParsedIdentifier = { identifier: string; rest: string };

function splitBootstrapStatements(sql: string, dbType?: DatabaseType): string[] {
  return splitSqlStatementRanges(sql, dbType)
    .map((statement) => statement.sql.trim())
    .filter(Boolean);
}

function parseMysqlIdentifier(input: string): ParsedIdentifier | null {
  const first = input[0];
  if (!first) return null;

  if (first === "`" || first === '"') {
    return parseDoubledDelimitedIdentifier(input, first);
  }
  if (first === "[") {
    return parseBracketIdentifier(input);
  }

  const end = input.search(/[\s;]/);
  const identifier = (end === -1 ? input : input.slice(0, end)).trim();
  if (!identifier) return null;
  return { identifier, rest: end === -1 ? "" : input.slice(end) };
}

function parseDoubledDelimitedIdentifier(input: string, quote: "`" | '"'): ParsedIdentifier | null {
  let index = 1;
  let segmentStart = 1;
  let identifier = "";

  while (index < input.length) {
    if (input[index] === quote) {
      identifier += input.slice(segmentStart, index);
      if (input[index + 1] === quote) {
        identifier += quote;
        index += 2;
        segmentStart = index;
        continue;
      }
      return { identifier, rest: input.slice(index + 1) };
    }
    index += 1;
  }

  return null;
}

function parseBracketIdentifier(input: string): ParsedIdentifier | null {
  let index = 1;
  let segmentStart = 1;
  let identifier = "";

  while (index < input.length) {
    if (input[index] === "]") {
      identifier += input.slice(segmentStart, index);
      if (input[index + 1] === "]") {
        identifier += "]";
        index += 2;
        segmentStart = index;
        continue;
      }
      return { identifier, rest: input.slice(index + 1) };
    }
    index += 1;
  }

  return null;
}

function stripLeadingSqlComments(sql: string): string {
  let rest = sql;

  for (;;) {
    rest = rest.trimStart();
    if (!rest) return rest;

    if (rest.startsWith("--")) {
      const index = rest.indexOf("\n");
      if (index === -1) return "";
      rest = rest.slice(index + 1);
      continue;
    }

    if (rest.startsWith("#")) {
      const index = rest.indexOf("\n");
      if (index === -1) return "";
      rest = rest.slice(index + 1);
      continue;
    }

    if (rest.startsWith("/*")) {
      const index = rest.indexOf("*/");
      if (index === -1) return "";
      rest = rest.slice(index + 2);
      continue;
    }

    return rest;
  }
}

function leadingSqlKeyword(statement: string): [keyword: string, rest: string] | null {
  const trimmed = statement.trimStart();
  const match = trimmed.match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) return null;
  return [match[0], trimmed.slice(match[0].length)];
}

function sqlRemainderIsCommentOnly(remainder: string): boolean {
  let rest = remainder;

  for (;;) {
    rest = rest.trimStart();
    if (!rest) return true;

    if (rest.startsWith(";")) {
      rest = rest.slice(1);
      continue;
    }

    if (rest.startsWith("--") || rest.startsWith("#")) {
      return true;
    }

    if (rest.startsWith("/*")) {
      const index = rest.indexOf("*/");
      if (index === -1) return false;
      rest = rest.slice(index + 2);
      continue;
    }

    return false;
  }
}

function parseMysqlUseDatabaseTarget(statement: string): string | null {
  const stripped = stripLeadingSqlComments(statement);
  const match = stripped.match(/^USE\b/i);
  if (!match) return null;

  const parsed = parseMysqlIdentifier(stripped.slice(match[0].length).trimStart());
  if (!parsed) return null;

  return sqlRemainderIsCommentOnly(parsed.rest) ? parsed.identifier : null;
}

function isDatabaseKeyword(keyword: string): boolean {
  const normalized = keyword.toUpperCase();
  return normalized === "DATABASE" || normalized === "SCHEMA";
}

function isAllowedBootstrapPrelude(statement: string): boolean {
  const stripped = stripLeadingSqlComments(statement);
  const leading = leadingSqlKeyword(stripped);
  if (!leading) return false;

  const [keyword, rest] = leading;
  const normalized = keyword.toUpperCase();
  if (normalized === "SET") {
    return true;
  }

  if (normalized !== "CREATE" && normalized !== "DROP") {
    return false;
  }

  const next = leadingSqlKeyword(rest);
  return !!next && isDatabaseKeyword(next[0]);
}

export function supportsConnectionLevelDatabaseBootstrap(connection: BootstrapConnection | undefined): boolean {
  if (!connection) return false;
  if (supportsCreateDatabaseCharset(connection.db_type, connection.driver_profile)) return true;
  return !!connection.driver_profile && MYSQL_BOOTSTRAP_EXTRA_PROFILES.has(connection.driver_profile.toLowerCase());
}

export function canExecuteWithoutSelectedDatabase(connection: BootstrapConnection | undefined, sql: string): boolean {
  if (!supportsConnectionLevelDatabaseBootstrap(connection)) return false;

  const statements = splitBootstrapStatements(sql, connection?.db_type);
  if (statements.length === 0) return false;

  let sawStatement = false;
  let hasDatabaseContext = false;

  for (const statement of statements) {
    const stripped = stripLeadingSqlComments(statement);
    if (!stripped) continue;

    sawStatement = true;

    if (isAllowedBootstrapPrelude(stripped)) {
      continue;
    }
    if (parseMysqlUseDatabaseTarget(stripped)) {
      hasDatabaseContext = true;
      continue;
    }
    if (!hasDatabaseContext) {
      return false;
    }
  }

  return sawStatement;
}

export function requiresSqlFileTargetDatabaseSelection(connection: BootstrapConnection | undefined, sqlCanExecuteWithoutSelectedDatabase = false): boolean {
  if (!supportsConnectionLevelDatabaseBootstrap(connection)) return true;
  return !sqlCanExecuteWithoutSelectedDatabase;
}
