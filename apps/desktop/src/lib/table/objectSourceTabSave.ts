import type { ConnectionConfig, QueryTab } from "@/types/database";
import type { useQueryStore } from "@/stores/queryStore";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { assertSourceIdentity, beginSourceSave } from "@/lib/table/objectSourceIdentity";
import { buildExecutableObjectSourceStatements, objectSourceSaveSuccessMessage, prepareObjectSourceSave } from "@/lib/table/objectSourceEditor";

interface ObjectSourceTabSaveContext {
  connection?: ConnectionConfig;
  queryStore: Pick<ReturnType<typeof useQueryStore>, "tabs" | "getObjectSourceIdentitySnapshot" | "markTabClean">;
  t: (key: string, values?: Record<string, unknown>) => string;
  toast: (message: string, duration?: number) => void;
}

/** App's source-tab Save/Save-and-close handler, including confirmation and clean timing. */
export async function saveObjectSourceTab(tab: QueryTab, { connection, queryStore, t, toast }: ObjectSourceTabSaveContext): Promise<boolean> {
  const source = tab.objectSource;
  if (!connection || !source) return false;
  let save: Awaited<ReturnType<typeof prepareObjectSourceSave>> | undefined;

  try {
    const identity = queryStore.getObjectSourceIdentitySnapshot(tab)!;
    assertSourceIdentity(identity);
    const { connectionId, database } = tab;
    const schema = source.schema || tab.schema || database;
    const sql = tab.sql;
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
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
