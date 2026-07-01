import * as api from "@/lib/api";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/jdbcDialect";
import { isNoSnapshotErrorResult } from "@/lib/queryResultError";
import { buildTableSelectSql } from "@/lib/tableSelectSql";
import { editableRowIdentifierColumns, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import { tableOpenPageLimit } from "@/lib/tableOpenPageLimit";
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
  const pageLimit = tableOpenPageLimit();

  connectionStore.activeConnectionId = target.connectionId;
  const config = connectionStore.getConfig(target.connectionId);
  const tabTitle = target.schema ? `${target.schema}.${target.tableName}` : target.tableName;
  if (config?.db_type === "qdrant" || config?.db_type === "milvus" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
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
    const querySchema = metadataSchemaForConnection(config, target.database, target.schema);
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
      await queryStore.executeTabSql(tabId, sql, { pagination: { limit: pageLimit, offset: 0 } });
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
    await queryStore.executeTabSql(tabId, sql, { pagination: { limit: pageLimit, offset: 0 } });
    // executeTabSql surfaces query failures as an "Error" result instead of throwing.
    // A snapshot-less lake table fails the data preview above but its metadata still
    // reads fine — retry with LIMIT 0 so the user sees the table structure (columns +
    // empty grid) rather than a cryptic server error. The flag also skips the
    // synthetic-row-id re-query below, which is another data read that would fail
    // the same way on a snapshot-less table.
    const fellBackToLimitZero = isNoSnapshotErrorResult(queryStore.tabs.find((tab) => tab.id === tabId)?.result);
    if (fellBackToLimitZero) {
      const emptySql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        schema: target.schema,
        tableName: target.tableName,
        whereInput: target.whereInput,
        limit: 0,
      });
      queryStore.updateSql(tabId, emptySql);
      await queryStore.executeTabSql(tabId, emptySql, { pagination: { limit: pageLimit, offset: 0 } });
    }
    try {
      const columns = await api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
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
      if (!fellBackToLimitZero && (useRowId || config.db_type === "tdengine")) {
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
        await queryStore.executeTabSql(tabId, newSql, { pagination: { limit: pageLimit, offset: 0 } });
      }
    } catch (reason) {
      console.error("[DBX] ERROR fetching table metadata:", reason);
    }
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
        const metadataSchema = metadataSchemaForConnection(connection, tab.database, tab.tableMeta?.schema);
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
