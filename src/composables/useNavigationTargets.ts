import * as api from "@/lib/api";
import { buildTableSelectSql } from "@/lib/tableSelectSql";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";

export type NavigationTarget = {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  columnName?: string;
  whereInput?: string;
};

async function openTableTarget(target: NavigationTarget) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  connectionStore.activeConnectionId = target.connectionId;
  const config = connectionStore.getConfig(target.connectionId);
  const tabTitle = target.schema ? `${target.schema}.${target.tableName}` : target.tableName;
  const tabId = queryStore.createTab(target.connectionId, target.database, tabTitle, "data");
  queryStore.setExecuting(tabId, true);

  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (!config) throw new Error("Connection config not found");
    const querySchema = target.schema || target.database;
    const columns = await api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
    const primaryKeys = columns.filter((c) => c.is_primary_key).map((c) => c.name);
    const sql = buildTableSelectSql({
      databaseType: config.db_type,
      schema: target.schema,
      tableName: target.tableName,
      primaryKeys,
      whereInput: target.whereInput,
    });
    queryStore.updateSql(tabId, sql);
    queryStore.setTableMeta(tabId, { schema: target.schema, tableName: target.tableName, columns, primaryKeys });
    await queryStore.executeTabSql(tabId, sql);
  } catch (e: any) {
    queryStore.setErrorResult(tabId, e);
  }
}

export function useNavigationTargets(dialogs: {
  showFieldLineageDialog: { value: boolean };
  showDatabaseSearchDialog: { value: boolean };
  structurePrefillTable: { value: string };
}) {
  const queryStore = useQueryStore();

  async function openLineageTarget(target: NavigationTarget) {
    dialogs.showFieldLineageDialog.value = false;
    await openTableTarget(target);
  }

  async function openDatabaseSearchTarget(target: NavigationTarget) {
    dialogs.showDatabaseSearchDialog.value = false;
    await openTableTarget(target);
  }

  async function onStructureEditorSaved(reloadData: () => Promise<void>, toast: (msg: string, duration?: number) => void) {
    const activeTab = queryStore.tabs.find((t) => t.id === queryStore.activeTabId);
    if (activeTab?.mode === "data" && activeTab.tableMeta?.tableName === dialogs.structurePrefillTable.value) {
      try {
        const columns = await api.getColumns(
          activeTab.connectionId, activeTab.database,
          activeTab.tableMeta.schema || activeTab.database, activeTab.tableMeta.tableName,
        );
        queryStore.setTableMeta(activeTab.id, {
          ...activeTab.tableMeta,
          columns,
          primaryKeys: columns.filter((c) => c.is_primary_key).map((c) => c.name),
        });
        await reloadData();
      } catch (e: any) {
        toast(e?.message || String(e), 5000);
      }
    }
  }

  return { openLineageTarget, openDatabaseSearchTarget, onStructureEditorSaved, openTableTarget };
}
