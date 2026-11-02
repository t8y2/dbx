import type { ConnectionConfig, QueryTab } from "@/types/database";
import type { useQueryStore } from "@/stores/queryStore";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isOracleFamilyTypeSource } from "@/lib/database/databaseObjectCapabilities";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { assertSourceIdentity, beginSourceSave } from "@/lib/table/objectSourceIdentity";
import { buildExecutableObjectSourceStatements, objectSourceSaveSuccessMessage, prepareObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { requestOracleTypeManagement } from "@/lib/table/oracleTypeManagementRequest";

interface ObjectSourceTabSaveContext {
  connection?: ConnectionConfig;
  queryStore: Pick<ReturnType<typeof useQueryStore>, "tabs" | "getObjectSourceIdentitySnapshot" | "markTabClean" | "runOracleTriggerSourceAction">;
  t: (key: string, values?: Record<string, unknown>) => string;
  toast: (message: string, duration?: number) => void;
}

/** App's source-tab Save/Save-and-close handler, including confirmation and clean timing. */
export async function saveObjectSourceTab(tab: QueryTab, { connection, queryStore, t, toast }: ObjectSourceTabSaveContext): Promise<boolean> {
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
    const statements = await buildExecutableObjectSourceStatements({ databaseType, objectType: source.objectType, schema, name: source.name, source: sql });
    save = await prepareObjectSourceSave(connectionId, database, databaseType, statements, schema, { objectType: source.objectType, name: source.name });
    const preparedSave = save;
    const targetIsCurrent = () => queryStore.tabs.includes(tab) && tab.objectSource === source && tab.connectionId === connectionId && tab.database === database && (source.schema || tab.schema || database) === schema;
    const execute = async () => {
      if (!targetIsCurrent()) return;
      const release = beginSourceSave(identity);
      try {
        return { operation: await preparedSave() };
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
    const message = error && typeof error === "object" && "message" in error ? error.message : undefined;
    toast(t("objects.sourceSaveFailed", { message: message || String(error) }), 5000);
    return false;
  } finally {
    await save?.dispose?.();
  }
}
