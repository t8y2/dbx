import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { editablePrimaryKeys, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import * as api from "@/lib/api";
import type { QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const { t } = useI18n();
  const { toast } = useToast();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableIdentifier(config?.db_type, name);
  }

  function buildTableSql(
    tab: QueryTab,
    options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string } = {},
  ): Promise<string> {
    const config = connectionStore.getConfig(tab.connectionId);
    const primaryKeys = tab.tableMeta ? editablePrimaryKeys(config?.db_type, tab.tableMeta.columns) : [];
    if (tab.tableMeta && primaryKeys.join("\0") !== tab.tableMeta.primaryKeys.join("\0")) {
      tab.tableMeta.primaryKeys = primaryKeys;
    }
    const fallbackOrderColumns =
      config?.db_type === "sqlserver" && !primaryKeys.length
        ? tab.tableMeta?.columns.slice(0, 1).map((column) => column.name)
        : undefined;
    const useRowId = usesSyntheticRowIdKey(config?.db_type, primaryKeys);
    return buildTableSelectSql({
      databaseType: config?.db_type,
      schema: tab.tableMeta?.schema,
      tableName: tab.tableMeta?.tableName ?? "",
      columns: tab.tableMeta?.columns.map((column) => column.name),
      primaryKeys,
      fallbackOrderColumns,
      includeRowId: useRowId,
      limit: options.limit ?? settingsStore.editorSettings.pageSize,
      ...options,
    });
  }

  async function onExecuteSql(sql: string) {
    const tab = activeTab.value;
    if (!tab) return;
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql, { preserveResultDuringExecution: true });
  }

  async function onReloadData(
    sql?: string,
    _searchText?: string,
    whereInput?: string,
    orderBy?: string,
    limit?: number,
    offset?: number,
  ) {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.mode === "data" && tab.tableMeta) {
      tab.whereInput = whereInput ?? "";
      const pageLimit = limit ?? settingsStore.editorSettings.pageSize;
      const pageOffset = offset ?? 0;
      const nextSql = await buildTableSql(tab, { whereInput, orderBy, limit: pageLimit, offset: pageOffset });
      queryStore.updateSql(tab.id, nextSql);
      await queryStore.executeTabSql(tab.id, nextSql, {
        pagination: { limit: pageLimit, offset: pageOffset },
        preserveResultDuringExecution: true,
      });
      return;
    }
    if (tab.resultSortedSql) {
      await queryStore.executeTabSql(tab.id, tab.resultSortedSql, {
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        resultSortedSql: tab.resultSortedSql,
        preserveResultDuringExecution: true,
      });
      return;
    }
    if (sql?.trim()) {
      await queryStore.executeTabSql(tab.id, sql, {
        resultBaseSql: sql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
      });
      return;
    }
    await queryStore.executeCurrentTab();
  }

  async function onPaginate(offset: number, limit: number, whereInput?: string, orderBy?: string) {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.mode !== "data") {
      const baseSql = tab.resultSortedSql ?? tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
      if (!baseSql.trim()) return;
      const expectedNextOffset = (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
      const sessionId =
        tab.result?.has_more && tab.result?.session_id && offset === expectedNextOffset && limit === tab.resultPageLimit
          ? tab.result.session_id
          : undefined;
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        resultSortedSql: tab.resultSortedSql,
        pagination: { offset, limit, sessionId },
        preserveResultDuringExecution: true,
      });
      return;
    }

    if (!tab.tableMeta) return;
    tab.whereInput = whereInput ?? "";
    const sql = await buildTableSql(tab, { limit, offset, whereInput, orderBy });
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql, {
      pagination: { offset, limit },
      preserveResultDuringExecution: true,
    });
  }

  async function onSort(column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string) {
    const tab = activeTab.value;
    if (!tab) return;
    tab.resultSortColumn = direction ? column : undefined;
    tab.resultSortColumnIndex = direction ? columnIndex : undefined;
    tab.resultSortDirection = direction ?? undefined;

    if (tab.mode === "data") {
      if (!tab.tableMeta) return;
      tab.whereInput = whereInput ?? "";
      const config = connectionStore.getConfig(tab.connectionId);
      const quotedColumn = quoteIdent(tab, column);
      const orderBy = direction
        ? `${config?.db_type === "neo4j" ? `n.${quotedColumn}` : quotedColumn} ${direction.toUpperCase()}`
        : undefined;
      const sql = await buildTableSql(tab, { orderBy, whereInput });
      queryStore.updateSql(tab.id, sql);
      await queryStore.executeTabSql(tab.id, sql, { preserveResultDuringExecution: true });
      return;
    }

    const baseSql = tab.resultBaseSql ?? tab.sql;
    if (!baseSql.trim()) return;

    if (!direction) {
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql: baseSql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
      });
      return;
    }

    const config = connectionStore.getConfig(tab.connectionId);
    const built = await api.buildSortedQuerySql({
      originalSql: baseSql,
      databaseType: config?.db_type,
      resultColumns: tab.result?.columns ?? [],
      columnIndex,
      column,
      direction,
    });
    if (!built.ok || !built.sql) {
      toast(t("grid.sortUnsupported"), 5000);
      return;
    }

    await queryStore.executeTabSql(tab.id, built.sql, {
      resultBaseSql: baseSql,
      resultSortedSql: built.sql,
      preserveResultDuringExecution: true,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
