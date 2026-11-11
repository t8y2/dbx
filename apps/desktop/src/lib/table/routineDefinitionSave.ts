import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";
import type { SqlExecutionOutcome } from "@/lib/sql/sqlExecutionOutcome";
import type { SqlExecutionOverride } from "@/lib/sql/sqlExecutionTarget";
import * as api from "@/lib/backend/api";
import { effectiveDatabaseTypeForConnection, kingbaseSqlDatabaseType } from "@/lib/database/jdbcDialect";
import { databaseObjectCapabilities } from "@/lib/database/databaseObjectCapabilities";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

type RoutineKind = "PROCEDURE" | "FUNCTION";

/** Recognizes the leading definition only; execution uses the backend's complete statement boundary. */
export function routineDefinitionKind(sql: string, databaseType?: DatabaseType): RoutineKind | undefined {
  if (!databaseType || !/\b(?:procedure|proc|function)\b/i.test(sql)) return;
  const capabilities = databaseObjectCapabilities(databaseType).sourceReadable;
  if (!capabilities.includes("PROCEDURE") && !capabilities.includes("FUNCTION") && !capabilities.includes("FUNCTION_INTERNAL")) return;
  const first = splitSqlStatementRanges(sql, databaseType)[0]?.sql;
  if (!first) return;
  const tokens = tokenizeSqlSemantic(first, databaseType).filter((token) => token.kind !== "comment");
  let index = 0;
  const operation = tokens[index++]?.normalized;
  if (operation !== "create" && operation !== "alter" && operation !== "recreate") return;
  if (operation === "create" && tokens[index]?.normalized === "or") {
    index += 1;
    if (!["replace", "alter"].includes(tokens[index++]?.normalized ?? "")) return;
  }
  while (["editionable", "noneditionable", "force"].includes(tokens[index]?.normalized ?? "")) index += 1;
  if (tokens[index]?.normalized === "definer") {
    index += 1;
    if (tokens[index++]?.text !== "=") return;
    if (!tokens[index]) return;
    const account = tokens[index++].normalized;
    if (account === "current_user" && tokens[index]?.text === "(" && tokens[index + 1]?.text === ")") index += 2;
    if (tokens[index]?.text === "@") index += 2;
  }
  const keyword = tokens[index]?.normalized;
  if ((keyword === "procedure" || keyword === "proc") && capabilities.includes("PROCEDURE")) return "PROCEDURE";
  if (keyword === "function" && (capabilities.includes("FUNCTION") || capabilities.includes("FUNCTION_INTERNAL"))) return "FUNCTION";
}

export function canSaveRoutineToDatabase(tab: QueryTab, connection?: ConnectionConfig): boolean {
  if (tab.mode !== "query" || tab.objectSource || tab.sourceLoad || tab.sourceView || !connection || connection.id !== tab.connectionId) return false;
  return !!routineDefinitionKind(tab.sql, kingbaseSqlDatabaseType(connection) ?? effectiveDatabaseTypeForConnection(connection));
}

interface RoutineDefinitionSaveContext {
  connection: ConnectionConfig;
  tabs: QueryTab[];
  execute: (sql: SqlExecutionOverride, options: { tabId: string }) => Promise<SqlExecutionOutcome>;
  isCurrent?: () => boolean;
}

/** Saves only the definition, preserving the ordinary execution guards, errors and metadata refresh. */
export async function saveRoutineDefinitionToDatabase(tab: QueryTab, sql: string, { connection, tabs, execute, isCurrent = () => true }: RoutineDefinitionSaveContext): Promise<SqlExecutionOutcome | undefined> {
  if (!isCurrent() || tab.isExecuting || tab.isCancelling || tab.isExplaining || !canSaveRoutineToDatabase({ ...tab, sql }, connection)) return;
  const databaseType = kingbaseSqlDatabaseType(connection) ?? effectiveDatabaseTypeForConnection(connection);
  const kind = routineDefinitionKind(sql, databaseType);
  const { connectionId, database, schema, catalog } = tab;
  const statement = await api.findStatementAtCursor(sql, 0, databaseType);
  if (!isCurrent() || !tabs.includes(tab) || tab.connectionId !== connectionId || tab.database !== database || tab.schema !== schema || tab.catalog !== catalog || tab.objectSource || tab.sourceLoad || tab.sourceView || tab.isExecuting || tab.isCancelling || tab.isExplaining) return;
  if (!statement.trim() || routineDefinitionKind(statement, databaseType) !== kind) return;
  const from = sql.indexOf(statement);
  const source = from < 0 ? statement : { fullSql: sql, selectedSql: statement, cursorPos: from, selectionFrom: from, selectionTo: from + statement.length };
  return execute(source, { tabId: tab.id });
}
