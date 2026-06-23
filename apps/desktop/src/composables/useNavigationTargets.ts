import * as api from "@/lib/api";
import { connectionObjectTreeQuerySchema, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { buildTableSelectSql } from "@/lib/tableSelectSql";
import { editableRowIdentifierColumns, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TableInfoTab } from "@/types/database";

export type NavigationTarget = {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  columnName?: string;
  whereInput?: string;
};

async function openTableTarget(target: NavigationTarget, options: { tableInfoTab?: TableInfoTab } = {}) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  const pageLimit = settingsStore.editorSettings.pageSize;

  connectionStore.activeConnectionId = target.connectionId;
  const config = connectionStore.getConfig(target.connectionId);
  const tabTitle = target.schema ? `${target.schema}.${target.tableName}` : target.tableName;
  if (config?.db_type === "qdrant" || config?.db_type === "milvus") {
    await connectionStore.ensureConnected(target.connectionId);
    const tabId = queryStore.createTab(target.connectionId, target.database || "default", tabTitle, "vector");
    queryStore.updateSql(tabId, target.tableName);
    return;
  }
  const tabId = (() => {
    if (settingsStore.editorSettings.reuseDataTab) {
      const existing = queryStore.tabs.find((tab) => tab.mode === "data" && tab.connectionId === target.connectionId && tab.database === target.database);
      if (existing) {
        existing.title = tabTitle;
        existing.schema = target.schema;
        existing.tableInfoTab = options.tableInfoTab;
        queryStore.activeTabId = existing.id;
        return existing.id;
      }
    }
    return queryStore.createTab(target.connectionId, target.database, tabTitle, "data", target.schema);
  })();
  const targetTab = queryStore.tabs.find((tab) => tab.id === tabId);
  if (targetTab) targetTab.tableInfoTab = options.tableInfoTab;
  queryStore.setExecuting(tabId, true);

  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (!config) throw new Error("Connection config not found");
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const querySchema = connectionObjectTreeQuerySchema(config, target.database, target.schema);
    if (config.db_type === "neo4j") {
      const columns = await api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
      const primaryKeys = editableRowIdentifierColumns(effectiveDbType, columns);
      const sql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        schema: target.schema,
        tableName: target.tableName,
        columns: columns.map((column) => column.name),
        primaryKeys,
        whereInput: target.whereInput,
        limit: pageLimit,
      });
      queryStore.updateSql(tabId, sql);
      queryStore.setTableMeta(tabId, {
        schema: target.schema,
        tableName: target.tableName,
        tableType: "TABLE",
        columns,
        primaryKeys,
      });
      await queryStore.executeTabSql(tabId, sql);
      return;
    }
    const sql = await buildTableSelectSql({
      databaseType: effectiveDbType,
      schema: target.schema,
      tableName: target.tableName,
      whereInput: target.whereInput,
      limit: pageLimit,
    });
    queryStore.updateSql(tabId, sql);
    queryStore.setTableMeta(tabId, {
      schema: target.schema,
      tableName: target.tableName,
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
    const columnsPromise = api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
    const dataPromise = queryStore.executeTabSql(tabId, sql);
    const [columnsResult, dataResult] = await Promise.allSettled([columnsPromise, dataPromise]);
    if (columnsResult.status === "fulfilled") {
      const columns = columnsResult.value;
      const indexes = await api.listIndexes(target.connectionId, target.database, querySchema, target.tableName).catch(() => []);
      const primaryKeys = editableRowIdentifierColumns(effectiveDbType, columns, indexes);
      const useRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys);
      queryStore.setTableMeta(tabId, {
        schema: target.schema,
        tableName: target.tableName,
        tableType: "TABLE",
        columns,
        primaryKeys,
      });
      if (useRowId || config.db_type === "tdengine") {
        const newSql = await buildTableSelectSql({
          databaseType: effectiveDbType,
          schema: target.schema,
          tableName: target.tableName,
          whereInput: target.whereInput,
          primaryKeys,
          columns: columns.map((column) => column.name),
          includeRowId: true,
          limit: pageLimit,
        });
        queryStore.updateSql(tabId, newSql);
        await queryStore.executeTabSql(tabId, newSql);
      }
    }
    if (dataResult.status === "rejected") throw dataResult.reason;
    if (columnsResult.status === "rejected") console.error("[DBX] ERROR fetching table metadata:", columnsResult.reason);
  } catch (e: any) {
    queryStore.setErrorResult(tabId, e);
  }
}

export function useNavigationTargets(dialogs: { showFieldLineageDialog: { value: boolean }; showDatabaseSearchDialog: { value: boolean } }) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  async function openLineageTarget(target: NavigationTarget) {
    dialogs.showFieldLineageDialog.value = false;
    await openTableTarget(target);
  }

  async function openDatabaseSearchTarget(target: NavigationTarget) {
    dialogs.showDatabaseSearchDialog.value = false;
    await openTableTarget(target);
  }

  async function onStructureEditorSaved(reloadData: () => Promise<void>, toast: (msg: string, duration?: number) => void, context: { connectionId: string; database: string; schema?: string; tableName: string }, commentChanged?: boolean) {
    if (!context.tableName) {
      try {
        await connectionStore.refreshObjectListTreeNode(context.connectionId, context.database, context.schema || undefined);
      } catch {}
      return;
    }
    if (commentChanged) {
      try {
        await connectionStore.refreshObjectListTreeNode(context.connectionId, context.database, context.schema || undefined);
      } catch {}
    }
    queryStore.invalidateTableStructure(context.connectionId, context.database, context.schema, context.tableName);
    const matchingDataTabs = queryStore.tabs.filter((tab) => tab.mode === "data" && tab.connectionId === context.connectionId && tab.database === context.database && tab.tableMeta?.tableName === context.tableName && (tab.tableMeta.schema || "") === (context.schema || ""));
    for (const tab of matchingDataTabs) {
      try {
        const connection = connectionStore.getConfig(tab.connectionId);
        const metadataSchema = connectionObjectTreeQuerySchema(connection, tab.database, tab.tableMeta?.schema);
        const columns = await api.getColumns(tab.connectionId, tab.database, metadataSchema, tab.tableMeta!.tableName);
        const indexes = await api.listIndexes(tab.connectionId, tab.database, metadataSchema, tab.tableMeta!.tableName).catch(() => []);
        queryStore.setTableMeta(tab.id, {
          ...tab.tableMeta!,
          columns,
          primaryKeys: editableRowIdentifierColumns(effectiveDatabaseTypeForConnection(connection), columns, indexes, tab.tableMeta!.tableType),
        });
        if (tab.id === queryStore.activeTabId) await reloadData();
      } catch (e: any) {
        toast(e?.message || String(e), 5000);
      }
    }
  }

  return { openLineageTarget, openDatabaseSearchTarget, onStructureEditorSaved, openTableTarget };
}
