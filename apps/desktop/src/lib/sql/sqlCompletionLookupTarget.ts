import type { SqlCompletionContext } from "@/lib/sql/sqlCompletion";

export interface SqlCompletionTableLookupTarget {
  database: string;
  schema?: string;
  filter: string;
  qualifierDatabase?: string;
}

function findExactName(names: readonly string[] | undefined, value: string): string | undefined {
  return names?.find((name) => name.toLowerCase() === value.toLowerCase());
}

export function resolveSqlCompletionTableLookupTarget(options: {
  currentDatabase: string;
  currentSchema?: string;
  supportsDatabaseQualifier: boolean;
  completionContext: Pick<SqlCompletionContext, "qualifier" | "prefix" | "suggestTables" | "insertTable">;
  knownDatabases?: readonly string[];
}): SqlCompletionTableLookupTarget {
  const { completionContext } = options;
  const qualifier = completionContext.qualifier?.trim();
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
