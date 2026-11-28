import type { ConnectionConfig, QueryTab } from "@/types/database";
import type { useQueryStore } from "@/stores/queryStore";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isOracleFamilyTypeSource } from "@/lib/database/databaseObjectCapabilities";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { assertSourceIdentity, beginSourceSave } from "@/lib/table/objectSourceIdentity";
import { buildExecutableObjectSourceStatements, objectSourceSaveSuccessMessage, prepareObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { requestOracleTypeManagement } from "@/lib/table/oracleTypeManagementRequest";
import { OracleRoutineWriteError } from "@/lib/table/oracleRoutineWrite";

interface ObjectSourceTabSaveContext {
  connection?: ConnectionConfig;
  queryStore: Pick<ReturnType<typeof useQueryStore>, "tabs" | "getObjectSourceIdentitySnapshot" | "markTabClean" | "runOracleTriggerSourceAction" | "setObjectSourceSaveStage" | "setObjectSourceCompileErrors">;
  t: (key: string, values?: Record<string, unknown>) => string;
  toast: (message: string, duration?: number) => void;
  /** Quote character reported by the connected server, for types whose quote is not fixed by the
   * database type alone (GaussDB M/B/MYSQL mode reports a backtick). */
  identifierQuote?: string;
}

/** App's source-tab Save/Save-and-close handler, including confirmation and clean timing. */
export async function saveObjectSourceTab(tab: QueryTab, { connection, queryStore, t, toast, identifierQuote }: ObjectSourceTabSaveContext): Promise<boolean> {
  const source = tab.objectSource;
  if (!connection || !source) return false;
  let save: Awaited<ReturnType<typeof prepareObjectSourceSave>> | undefined;

  try {
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
    if (isOracleFamilyTypeSource(databaseType, source.objectType)) {
      if (!tab.typeSourceEditing && (!tab.typeManagementDraft || tab.typeManagementDraft.state === "complete")) return false;
      if (!tab.typeManagementDraft || tab.typeManagementDraft.state === "complete") assertSourceIdentity(queryStore.getObjectSourceIdentitySnapshot(tab)!);
      const { connectionId, database, sql } = tab;
      const owner = source.schema || tab.schema || database;
      const result = await requestOracleTypeManagement({
        target: { connectionId, database, owner, name: source.name, databaseType: databaseType as "oracle" | "oceanbase-oracle" | "dameng" },
        operation: source.objectType === "TYPE_BODY" ? "save-body" : "save-spec",
        source: sql,
        baseSource: tab.originalSql,
        tabId: tab.id,
        isCurrent: () => queryStore.tabs.includes(tab) && tab.objectSource === source && tab.connectionId === connectionId && tab.database === database && (source.schema || tab.schema || database) === owner && tab.sql === sql,
      });
      if (result.complete) toast(t("objects.sourceSaved"), 2000);
      return result.complete;
    }
    const identity = queryStore.getObjectSourceIdentitySnapshot(tab)!;
    assertSourceIdentity(identity);
    const { connectionId, database } = tab;
    const schema = source.schema || tab.schema || database;
    const sql = tab.sql;
    if (source.objectType === "TRIGGER" && ["oracle", "oceanbase-oracle", "dameng"].includes(databaseType)) return await queryStore.runOracleTriggerSourceAction(tab.id);
    // Each of these is a backend round trip; together they can run for seconds, so the
    // tab advertises the current phase instead of leaving the editor looking idle.
    queryStore.setObjectSourceSaveStage(tab.id, "validating");
    // A new attempt supersedes whatever the previous one reported.
    queryStore.setObjectSourceCompileErrors(tab.id, undefined);
    const statements = await buildExecutableObjectSourceStatements({ databaseType, objectType: source.objectType, schema, name: source.name, source: sql, identifierQuote });
    queryStore.setObjectSourceSaveStage(tab.id, "preparing");
    save = await prepareObjectSourceSave(connectionId, database, databaseType, statements, schema, { objectType: source.objectType, name: source.name });
    const preparedSave = save;
    const targetIsCurrent = () => queryStore.tabs.includes(tab) && tab.objectSource === source && tab.connectionId === connectionId && tab.database === database && (source.schema || tab.schema || database) === schema;
    const execute = async () => {
      if (!targetIsCurrent()) return;
      const release = beginSourceSave(identity);
      // The production guard may hold the draft at a confirmation dialog, so the
      // executing phase starts here rather than before it.
      queryStore.setObjectSourceSaveStage(tab.id, "executing");
      try {
        const operation = await preparedSave();
        // The DDL is committed by now; what remains is reading the object back.
        queryStore.setObjectSourceSaveStage(tab.id, "verifying");
        return { operation };
      } finally {
        release();
      }
    };
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    let result;
    if (executableSql.trim()) result = await executeWithProductionSqlGuard({ connection, database, sql: executableSql, source: t("production.sourceObjectSource"), execute });
    else result = await execute();
    if (!result || !targetIsCurrent()) return false;
    if (tab.sql === sql) queryStore.markTabClean(tab);
    toast(objectSourceSaveSuccessMessage(t("objects.sourceSaved"), result.operation), result.operation?.readback?.compilerMessages.length ? 6000 : 2000);
    return true;
  } catch (error: unknown) {
    // Oracle accepts the DDL and then reports compilation errors with line/column
    // numbers. They used to survive only as one line of toast text; keeping them on
    // the tab lets the editor list them, jump to the offending line and hand them to AI.
    if (error instanceof OracleRoutineWriteError && error.operation) {
      const readback = error.operation.readback;
      const messages = [...(readback?.compilerMessages ?? []), ...(readback?.packageCompanion?.compilerMessages ?? [])];
      const current = tab.objectSource;
      if (current) queryStore.setObjectSourceCompileErrors(tab.id, { name: current.name, objectType: current.objectType, messages });
    }
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
    toast(t("objects.sourceSaveFailed", { message: message || String(error) }), 5000);
    return false;
  } finally {
    queryStore.setObjectSourceSaveStage(tab.id, undefined);
    await save?.dispose?.();
  }
}
