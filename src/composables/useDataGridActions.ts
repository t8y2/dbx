import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { buildSortedQuerySql } from "@/lib/queryResultSort";
import type { QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const { t } = useI18n();
  const { toast } = useToast();
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
    const fallbackOrderColumns =
      config?.db_type === "sqlserver" && !tab.tableMeta?.primaryKeys?.length
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

  async function onReloadData(sql?: string, whereInput?: string) {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.mode === "data" && tab.tableMeta) {
      queryStore.updateSql(tab.id, buildTableSql(tab, { whereInput }));
      await queryStore.executeCurrentTab();
      return;
    }
    if (tab.resultSortedSql) {
      await queryStore.executeTabSql(tab.id, tab.resultSortedSql, {
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        resultSortedSql: tab.resultSortedSql,
      });
      return;
    }
    if (sql?.trim()) {
      await queryStore.executeTabSql(tab.id, sql, {
        resultBaseSql: sql,
        resultSortedSql: undefined,
      });
      return;
    }
    await queryStore.executeCurrentTab();
  }

  async function onPaginate(offset: number, limit: number, whereInput?: string, orderBy?: string) {
    const tab = activeTab.value;
    if (!tab?.tableMeta) return;
    const sql = buildTableSql(tab, { limit, offset, whereInput, orderBy });
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeCurrentTab();
  }

  async function onSort(column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string) {
    const tab = activeTab.value;
    if (!tab) return;

    if (tab.mode === "data") {
      if (!tab.tableMeta) return;
      const orderBy = direction ? `${quoteIdent(tab, column)} ${direction.toUpperCase()}` : undefined;
      const sql = buildTableSql(tab, { orderBy, whereInput });
      queryStore.updateSql(tab.id, sql);
      await queryStore.executeCurrentTab();
      return;
    }

    const baseSql = tab.resultBaseSql ?? tab.sql;
    if (!baseSql.trim()) return;

    if (!direction) {
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql: baseSql,
        resultSortedSql: undefined,
      });
      return;
    }

    const config = connectionStore.getConfig(tab.connectionId);
    const built = buildSortedQuerySql(
      baseSql,
      config?.db_type,
      tab.result?.columns ?? [],
      columnIndex,
      column,
      direction,
    );
    if (!built.ok) {
      toast(t("grid.sortUnsupported"), 5000);
      return;
    }

    await queryStore.executeTabSql(tab.id, built.sql, {
      resultBaseSql: baseSql,
      resultSortedSql: built.sql,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
