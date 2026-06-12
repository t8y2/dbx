import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { editablePrimaryKeys, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import { tableMetaForDataTab } from "@/lib/tableDataTabMeta";
import * as api from "@/lib/api";
import type { QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { connectionObjectTreeQuerySchema, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const { t } = useI18n();
  const { toast } = useToast();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableIdentifier(effectiveDatabaseTypeForConnection(config), name);
  }

  function buildTableSql(tab: QueryTab, options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string } = {}): Promise<string> {
    const config = connectionStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const tableMeta = tableMetaForDataTab(tab);
    const primaryKeys = tab.tableMeta ? editablePrimaryKeys(effectiveDbType, tab.tableMeta.columns) : (tableMeta?.primaryKeys ?? []);
    if (tab.tableMeta && primaryKeys.join("\0") !== tab.tableMeta.primaryKeys.join("\0")) {
      tab.tableMeta.primaryKeys = primaryKeys;
    }
    const fallbackOrderColumns = effectiveDbType === "sqlserver" && !primaryKeys.length ? tableMeta?.columns.slice(0, 1).map((column) => column.name) : undefined;
    const useRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys);
    return buildTableSelectSql({
      databaseType: effectiveDbType,
      schema: tableMeta?.schema,
      tableName: tableMeta?.tableName ?? "",
      columns: tableMeta?.columns.map((column) => column.name),
      primaryKeys,
      fallbackOrderColumns,
      includeRowId: useRowId,
      limit: options.limit ?? settingsStore.editorSettings.pageSize,
      ...options,
    });
  }

  async function refreshDataTabTableMeta(tab: QueryTab): Promise<void> {
    if (tab.mode !== "data" || !tab.connectionId || !tab.database) return;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta?.tableName) return;

    await connectionStore.ensureConnected(tab.connectionId);
    const config = connectionStore.getConfig(tab.connectionId);
    const querySchema = connectionObjectTreeQuerySchema(config, tab.database, tableMeta.schema);
    const columns = await api.getColumns(tab.connectionId, tab.database, querySchema, tableMeta.tableName);
    const primaryKeys = editablePrimaryKeys(effectiveDatabaseTypeForConnection(config), columns);
    queryStore.setTableMeta(tab.id, {
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      columns,
      primaryKeys,
    });
  }

  async function onExecuteSql(sql: string) {
    const tab = activeTab.value;
    if (!tab) return;
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql, { preserveResultDuringExecution: true });
  }

  async function onReloadData(sql?: string, _searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number) {
    const tab = activeTab.value;
    if (!tab) return;
    if (tab.mode === "data" && tableMetaForDataTab(tab)) {
      tab.whereInput = whereInput ?? "";
      const pageLimit = limit ?? settingsStore.editorSettings.pageSize;
      const pageOffset = offset ?? 0;
      try {
        await refreshDataTabTableMeta(tab);
      } catch (e: any) {
        toast(e?.message || String(e), 5000);
      }
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
        preserveTotalRowCountDuringExecution: true,
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
      const sessionId = tab.result?.has_more && tab.result?.session_id && offset === expectedNextOffset && limit === tab.resultPageLimit ? tab.result.session_id : undefined;
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        resultSortedSql: tab.resultSortedSql,
        pagination: { offset, limit, sessionId },
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
      });
      return;
    }

    if (!tableMetaForDataTab(tab)) return;
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
      if (!tableMetaForDataTab(tab)) return;
      tab.whereInput = whereInput ?? "";
      const config = connectionStore.getConfig(tab.connectionId);
      const quotedColumn = quoteIdent(tab, column);
      const orderBy = direction ? `${config?.db_type === "neo4j" ? `n.${quotedColumn}` : quotedColumn} ${direction.toUpperCase()}` : undefined;
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
        preserveTotalRowCountDuringExecution: true,
      });
      return;
    }

    const config = connectionStore.getConfig(tab.connectionId);
    const built = await api.buildSortedQuerySql({
      originalSql: baseSql,
      databaseType: effectiveDatabaseTypeForConnection(config),
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
      preserveTotalRowCountDuringExecution: true,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
