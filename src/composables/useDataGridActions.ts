import { type ComputedRef } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import type { QueryTab } from "@/types/database";

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableIdentifier(config?.db_type, name);
  }

  function buildTableSql(
    tab: QueryTab,
    options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string } = {},
  ): string {
    const config = connectionStore.getConfig(tab.connectionId);
    const fallbackOrderColumns = config?.db_type === "sqlserver" && !tab.tableMeta?.primaryKeys?.length
      ? tab.tableMeta?.columns.slice(0, 1).map((column) => column.name)
      : undefined;
    return buildTableSelectSql({
      databaseType: config?.db_type,
      schema: tab.tableMeta?.schema,
      tableName: tab.tableMeta?.tableName ?? "",
      primaryKeys: tab.tableMeta?.primaryKeys,
      fallbackOrderColumns,
      ...options,
    });
  }

  async function onExecuteSql(sql: string) {
    const tab = activeTab.value;
    if (!tab) return;
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql);
  }

  async function onReloadData() {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.mode === "data" && tab.tableMeta) {
      queryStore.updateSql(tab.id, buildTableSql(tab));
    }
    queryStore.executeCurrentTab();
  }

  async function onPaginate(offset: number, limit: number, whereInput?: string) {
    const tab = activeTab.value;
    if (!tab?.tableMeta) return;
    const sql = buildTableSql(tab, { limit, offset, whereInput });
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeCurrentTab();
  }

  async function onSort(column: string, direction: "asc" | "desc" | null, whereInput?: string) {
    const tab = activeTab.value;
    if (!tab?.tableMeta) return;
    const orderBy = direction ? `${quoteIdent(tab, column)} ${direction.toUpperCase()}` : undefined;
    const sql = buildTableSql(tab, { orderBy, whereInput });
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeCurrentTab();
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
