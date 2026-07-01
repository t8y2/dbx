import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableIdentifier } from "@/lib/tableSelectSql";
import { editableRowIdentifierColumns, usesSyntheticRowIdKey } from "@/lib/tableEditing";
import { tableMetaForDataTab } from "@/lib/tableDataTabMeta";
import * as api from "@/lib/api";
import type { QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/jdbcDialect";
import { uuid } from "@/lib/utils";
import type { DataGridSortMode } from "@/lib/dataGridSort";

const DATA_TAB_METADATA_TTL_MS = 30_000;

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
    const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : (tableMeta?.primaryKeys ?? []);
    const useRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys);
    return buildTableSelectSql({
      databaseType: effectiveDbType,
      schema: tableMeta?.schema,
      tableName: tableMeta?.tableName ?? "",
      tableType: tableMeta?.tableType,
      columns: tableMeta?.columns.map((column) => column.name),
      primaryKeys,
      includeRowId: useRowId,
      limit: options.limit ?? settingsStore.editorSettings.pageSize,
      ...options,
    });
  }

  async function refreshDataTabTableMeta(tab: QueryTab, trace?: { traceId: string; elapsed: () => string }): Promise<void> {
    if (tab.mode !== "data" || !tab.connectionId || !tab.database) return;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta?.tableName) return;
    const target = {
      tabId: tab.id,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
    };

    console.info("[DBX][reloadData:metadata:ensure-connected:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    await connectionStore.ensureConnected(target.connectionId);
    console.info("[DBX][reloadData:metadata:ensure-connected:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    const config = connectionStore.getConfig(target.connectionId);
    const querySchema = metadataSchemaForConnection(config, target.database, target.schema);
    console.info("[DBX][reloadData:metadata:get-columns:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), schema: querySchema, table: target.tableName });
    const columns = await api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
    const indexes = await api.listIndexes(target.connectionId, target.database, querySchema, target.tableName).catch(() => []);
    console.info("[DBX][reloadData:metadata:get-columns:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), columnCount: columns.length });
    const current = queryStore.tabs.find((item) => item.id === target.tabId);
    const currentMeta = current ? tableMetaForDataTab(current) : undefined;
    if (!current || current.mode !== "data" || current.connectionId !== target.connectionId || current.database !== target.database || currentMeta?.tableName !== target.tableName || (currentMeta.schema ?? "") !== (target.schema ?? "")) {
      console.info("[DBX][reloadData:metadata:stale-tab]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return;
    }
    const primaryKeys = editableRowIdentifierColumns(effectiveDatabaseTypeForConnection(config), columns, indexes, target.tableType);
    queryStore.setTableMeta(target.tabId, {
      schema: target.schema,
      tableName: target.tableName,
      tableType: target.tableType,
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
    const traceId = uuid().slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    if (tab.mode === "data" && tableMetaForDataTab(tab)) {
      tab.whereInput = whereInput ?? "";
      const pageLimit = limit ?? settingsStore.editorSettings.pageSize;
      const pageOffset = offset ?? 0;
      console.info("[DBX][reloadData:start]", {
        traceId,
        tabId: tab.id,
        connectionId: tab.connectionId,
        database: tab.database,
        table: tableMetaForDataTab(tab)?.tableName,
        elapsed: elapsed(),
      });
      queryStore.setExecuting(tab.id, true);
      const tableMeta = tableMetaForDataTab(tab);
      const metadataAgeMs = tab.tableMetaUpdatedAt ? Date.now() - tab.tableMetaUpdatedAt : Number.POSITIVE_INFINITY;
      const shouldRefreshMetadata = !tab.tableMeta || !tableMeta?.columns.length || metadataAgeMs > DATA_TAB_METADATA_TTL_MS;
      if (shouldRefreshMetadata) {
        console.info("[DBX][reloadData:metadata:background:start]", { traceId, elapsed: elapsed(), reason: tableMeta?.columns.length ? "stale" : "missing", metadataAgeMs });
        void refreshDataTabTableMeta(tab, { traceId, elapsed })
          .then(() => {
            console.info("[DBX][reloadData:metadata:background:done]", { traceId, elapsed: elapsed() });
          })
          .catch((e: any) => {
            console.warn("[DBX][reloadData:metadata:background:error]", { traceId, elapsed: elapsed(), error: e });
            toast(e?.message || String(e), 5000);
          });
      } else {
        console.info("[DBX][reloadData:metadata:skip]", { traceId, elapsed: elapsed(), columnCount: tableMeta.columns.length, metadataAgeMs });
      }
      try {
        console.info("[DBX][reloadData:build-sql:start]", { traceId, elapsed: elapsed() });
        const nextSql = await buildTableSql(tab, { whereInput, orderBy, limit: pageLimit, offset: pageOffset });
        console.info("[DBX][reloadData:build-sql:done]", { traceId, elapsed: elapsed() });
        queryStore.updateSql(tab.id, nextSql);
        console.info("[DBX][reloadData:execute:start]", { traceId, elapsed: elapsed() });
        await queryStore.executeTabSql(tab.id, nextSql, {
          pagination: { limit: pageLimit, offset: pageOffset },
          preserveResultDuringExecution: true,
        });
        console.info("[DBX][reloadData:execute:done]", { traceId, elapsed: elapsed() });
      } catch (e) {
        console.error("[DBX][reloadData:error]", { traceId, elapsed: elapsed(), error: e });
        queryStore.setExecuting(tab.id, false);
        throw e;
      }
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

  async function onSort(column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode: DataGridSortMode = "database") {
    const tab = activeTab.value;
    if (!tab) return;
    tab.resultSortColumn = direction ? column : undefined;
    tab.resultSortColumnIndex = direction ? columnIndex : undefined;
    tab.resultSortDirection = direction ?? undefined;
    tab.resultSortMode = direction ? mode : undefined;

    if (mode === "local") {
      if (tab.mode === "data") {
        tab.whereInput = whereInput ?? "";
        tab.orderByInput = undefined;
      }
      queryStore.sortTabResultLocally(tab.id, column, columnIndex, direction);
      return;
    }

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
