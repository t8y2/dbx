import type { SqlCompletionContext } from "@/lib/sql/sqlCompletion";

export interface SqlCompletionTableLookupTarget {
  database: string;
  schema?: string;
  filter: string;
  qualifierDatabase?: string;
}

export interface SqlCompletionRoutineLookupTarget {
  schema?: string;
  mask: string;
}

function findExactName(names: readonly string[] | undefined, value: string): string | undefined {
  return names?.find((name) => name.toLowerCase() === value.toLowerCase());
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

export function resolveSqlCompletionRoutineLookupTarget(options: { currentSchema?: string; completionContext: Pick<SqlCompletionContext, "qualifier" | "qualifierParts" | "prefix"> }): SqlCompletionRoutineLookupTarget {
  const qualifierParts = options.completionContext.qualifierParts?.filter(Boolean);
  const schema = qualifierParts?.[qualifierParts.length - 1] ?? options.completionContext.qualifier?.trim() ?? options.currentSchema;

  // A qualified routine uses the qualifier as metadata scope; only the final
  // identifier fragment is the function/procedure name mask.
  return {
    schema: schema || undefined,
    mask: options.completionContext.prefix,
  };
}
