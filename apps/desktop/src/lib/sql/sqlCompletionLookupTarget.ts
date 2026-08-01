import type { SqlCompletionContext, SqlCompletionItem } from "@/lib/sql/sqlCompletion";
import { currentExecutableStatementRange, executableStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { DatabaseType } from "@/types/database";

export interface SqlCompletionTableLookupTarget {
  database: string;
  schema?: string;
  filter: string;
  qualifierDatabase?: string;
}

export interface SqlCompletionRoutineLookupTarget {
  database: string;
  schema?: string;
  mask: string;
}

export interface SqlCompletionScope {
  database: string;
  schema?: string;
  completionContext: SqlCompletionContext;
}

export interface SqlServerUseDatabaseCompletion {
  from: number;
  prefix: string;
  quoteStyle: "none" | "bracket" | "double";
}

function sqlStatementWithoutLeadingComments(statement: string): string {
  let remaining = statement.trimStart();
  while (remaining) {
    if (remaining.startsWith("--")) {
      const newline = remaining.indexOf("\n");
      remaining = newline < 0 ? "" : remaining.slice(newline + 1).trimStart();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end < 0) return "";
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return remaining;
}

function sqlServerUseDatabase(statement: string): string | undefined {
  const match = /^USE\s+(?:\[((?:[^\]]|\]\])*)\]|"((?:[^"]|"")*)"|([\p{L}_@#][\p{L}\p{N}_@$#]*))\s*;?\s*$/iu.exec(sqlStatementWithoutLeadingComments(statement));
  if (!match) return undefined;
  if (match[1] !== undefined) return match[1].replaceAll("]]", "]");
  if (match[2] !== undefined) return match[2].replaceAll('""', '"');
  return match[3];
}

export function sqlServerUseDatabaseBeforeCursor(sql: string, cursor: number): string | undefined {
  const position = Math.max(0, Math.min(cursor, sql.length));
  let database: string | undefined;
  for (const statement of executableStatementRanges(sql, "sqlserver")) {
    if (statement.from >= position || statement.to >= position) break;
    database = sqlServerUseDatabase(statement.sql) ?? database;
  }
  return database;
}

function unclosedQuotedIdentifierPrefix(value: string, quoteStyle: "bracket" | "double"): string | undefined {
  const closingQuote = quoteStyle === "bracket" ? "]" : '"';
  let prefix = "";
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== closingQuote) {
      prefix += character;
      continue;
    }
    if (value[index + 1] !== closingQuote) return undefined;
    prefix += closingQuote;
    index += 1;
  }
  return prefix;
}

export function resolveSqlServerUseDatabaseCompletion(options: { sql: string; cursor: number; databaseType?: DatabaseType }): SqlServerUseDatabaseCompletion | undefined {
  if (options.databaseType !== "sqlserver") return undefined;
  const position = Math.max(0, Math.min(options.cursor, options.sql.length));
  const statement = currentExecutableStatementRange(options.sql, position, "sqlserver");
  if (!statement || (statement.to > position && options.sql.slice(position, statement.to).trim())) return undefined;

  const beforeCursor = options.sql.slice(statement.from, position);
  const useMatch = /^USE(?=\s)/iu.exec(beforeCursor);
  if (!useMatch) return undefined;

  let targetOffset = useMatch[0].length;
  while (targetOffset < beforeCursor.length && /\s/u.test(beforeCursor[targetOffset]!)) targetOffset += 1;

  const target = beforeCursor.slice(targetOffset);
  if (!target) {
    return {
      from: statement.from + targetOffset,
      prefix: "",
      quoteStyle: "none",
    };
  }
  if (/^[\p{L}_@#][\p{L}\p{N}_@$#]*$/u.test(target)) {
    return {
      from: statement.from + targetOffset,
      prefix: target,
      quoteStyle: "none",
    };
  }

  const quoteStyle = target[0] === "[" ? "bracket" : target[0] === '"' ? "double" : undefined;
  if (!quoteStyle) return undefined;
  const prefix = unclosedQuotedIdentifierPrefix(target, quoteStyle);
  if (prefix === undefined) return undefined;
  return {
    from: statement.from + targetOffset + 1,
    prefix,
    quoteStyle,
  };
}

export function buildSqlServerUseDatabaseCompletionItems(databaseNames: readonly string[], completion: SqlServerUseDatabaseCompletion): SqlCompletionItem[] {
  return databaseNames.map((database) => {
    const escapedDatabase = completion.quoteStyle === "double" ? database.replaceAll('"', '""') : database.replaceAll("]", "]]");
    const apply = completion.quoteStyle === "bracket" ? `${escapedDatabase}]` : completion.quoteStyle === "double" ? `${escapedDatabase}"` : `[${escapedDatabase}]`;
    return {
      label: database,
      filterText: completion.quoteStyle === "none" ? database : escapedDatabase,
      type: "schema",
      detail: "database",
      apply,
      boost: 1_500,
    };
  });
}

export function sqlServerUseCompletionDatabaseNames(options: { databaseNames: readonly string[]; currentDatabase: string; supportsSessionDatabaseSwitch: boolean }): string[] {
  if (options.supportsSessionDatabaseSwitch) return [...options.databaseNames];
  const currentDatabase = options.currentDatabase.trim();
  return currentDatabase ? [findExactName(options.databaseNames, currentDatabase) ?? currentDatabase] : [];
}

export function resolveSqlCompletionScope(options: {
  sql: string;
  cursor: number;
  databaseType?: DatabaseType;
  currentDatabase: string;
  currentSchema?: string;
  knownDatabases?: readonly string[];
  supportsSessionDatabaseSwitch?: boolean;
  useDatabaseDefaultSchema?: string;
  completionContext: SqlCompletionContext;
}): SqlCompletionScope {
  if (options.databaseType !== "sqlserver") {
    return {
      database: options.currentDatabase,
      schema: options.currentSchema,
      completionContext: options.completionContext,
    };
  }
  const parsedDatabase = sqlServerUseDatabaseBeforeCursor(options.sql, options.cursor);
  const database = parsedDatabase ? findExactName(options.knownDatabases, parsedDatabase) : undefined;
  const targetsCurrentDatabase = database?.toLowerCase() === options.currentDatabase.toLowerCase();
  const schema = options.useDatabaseDefaultSchema?.trim();
  if (!database || !schema || (!targetsCurrentDatabase && options.supportsSessionDatabaseSwitch !== true)) {
    return {
      database: options.currentDatabase,
      schema: options.currentSchema,
      completionContext: options.completionContext,
    };
  }
  return {
    database,
    schema,
    completionContext: {
      ...options.completionContext,
      insertDatabase: options.completionContext.insertTable && !options.completionContext.insertDatabase ? database : options.completionContext.insertDatabase,
      insertSchema: options.completionContext.insertTable && !options.completionContext.insertSchema ? schema : options.completionContext.insertSchema,
      referencedTables: options.completionContext.referencedTables.map((table) =>
        table.database
          ? table
          : {
              ...table,
              database,
              schema: table.schema ?? schema,
            },
      ),
    },
  };
}

function findExactName(names: readonly string[] | undefined, value: string): string | undefined {
  return names?.find((name) => name.toLowerCase() === value.toLowerCase());
}

function findCaseSensitiveName(names: readonly string[] | undefined, value: string): string | undefined {
  return names?.find((name) => name === value);
}

export function mergeSqlCompletionQualifierNames(primary: readonly string[], secondary: readonly string[]): string[] {
  return [...new Set([...primary, ...secondary])];
}

export function resolveSqlCompletionSchemaLookupDatabase(options: {
  supportsDatabaseSchemaQualifier?: boolean;
  completionContext: Pick<SqlCompletionContext, "qualifier" | "qualifierParts" | "suggestTables" | "insertTable">;
  knownDatabases?: readonly string[];
  knownSchemas?: readonly string[];
}): string | undefined {
  const { completionContext } = options;
  if (!options.supportsDatabaseSchemaQualifier || !completionContext.suggestTables || completionContext.insertTable) return undefined;
  const qualifier = completionContext.qualifier?.trim();
  const qualifierParts = completionContext.qualifierParts?.filter(Boolean) ?? qualifier?.split(".").filter(Boolean) ?? [];
  if (qualifierParts.length !== 1) return undefined;
  if (findCaseSensitiveName(options.knownSchemas, qualifierParts[0]!)) return undefined;
  return findCaseSensitiveName(options.knownDatabases, qualifierParts[0]!);
}

export function resolveSqlCompletionTableLookupTarget(options: {
  currentDatabase: string;
  currentSchema?: string;
  supportsDatabaseQualifier: boolean;
  supportsDatabaseSchemaQualifier?: boolean;
  completionContext: Pick<SqlCompletionContext, "qualifier" | "qualifierParts" | "prefix" | "suggestTables" | "insertTable">;
  knownDatabases?: readonly string[];
}): SqlCompletionTableLookupTarget {
  const { completionContext } = options;
  const qualifier = completionContext.qualifier?.trim();
  const qualifierParts = completionContext.qualifierParts?.filter(Boolean) ?? qualifier?.split(".").filter(Boolean) ?? [];
  if (options.supportsDatabaseSchemaQualifier && completionContext.suggestTables && !completionContext.insertTable && qualifierParts.length >= 2) {
    const databaseQualifier = qualifierParts[qualifierParts.length - 2]!;
    const schema = qualifierParts[qualifierParts.length - 1]!;
    const database = findExactName(options.knownDatabases, databaseQualifier) ?? databaseQualifier;
    return {
      database,
      schema,
      filter: completionContext.prefix,
      qualifierDatabase: database,
    };
  }
  const qualifierIsDatabase = options.supportsDatabaseQualifier && !!qualifier && completionContext.suggestTables && !completionContext.insertTable;

  if (qualifierIsDatabase) {
    // MySQL-compatible engines, including OceanBase MySQL mode, use
    // database.table. Do not block table completion on a separate database-list
    // request when the user already typed the database qualifier.
    const database = findExactName(options.knownDatabases, qualifier) ?? qualifier;
    return {
      database,
      filter: completionContext.prefix,
      qualifierDatabase: database,
    };
  }

  return {
    database: options.currentDatabase,
    schema: qualifier && completionContext.suggestTables ? qualifier : options.currentSchema,
    filter: qualifier && completionContext.suggestTables ? completionContext.prefix : qualifier || completionContext.prefix,
  };
}

export function resolveSqlCompletionRoutineLookupTarget(options: { currentDatabase: string; currentSchema?: string; supportsDatabaseSchemaQualifier?: boolean; completionContext: Pick<SqlCompletionContext, "qualifier" | "qualifierParts" | "prefix"> }): SqlCompletionRoutineLookupTarget {
  const qualifier = options.completionContext.qualifier?.trim();
  const qualifierParts = options.completionContext.qualifierParts?.filter(Boolean) ?? qualifier?.split(".").filter(Boolean) ?? [];
  const hasDatabaseQualifier = options.supportsDatabaseSchemaQualifier && qualifierParts.length >= 2;
  const database = hasDatabaseQualifier ? qualifierParts[qualifierParts.length - 2]! : options.currentDatabase;
  const schema = qualifierParts[qualifierParts.length - 1] ?? qualifier ?? options.currentSchema;

  // A qualified routine uses the qualifier as metadata scope; only the final
  // identifier fragment is the function/procedure name mask.
  return {
    database,
    schema: schema || undefined,
    mask: options.completionContext.prefix,
  };
}
