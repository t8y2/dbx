import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import * as api from "@/lib/backend/api";
import type { QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS } from "@/lib/metadata/tableMetadataCache";
import { applyMongoFindSort } from "@/lib/mongo/mongoShellCommand";
import { uuid } from "@/lib/common/utils";
import type { DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import type { DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import { queryResultBaseSql, queryResultExecutionSql } from "@/lib/tabs/tabPresentation";

const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;

function visibleQuerySortColumns(columns: string[], hiddenColumnIndexes: number[] | undefined, columnIndex: number): { resultColumns: string[]; columnIndex: number } | undefined {
  const hiddenIndexes = new Set(hiddenColumnIndexes ?? []);
  const resultColumns: string[] = [];
  let visibleColumnIndex: number | undefined;
  for (const [index, resultColumn] of columns.entries()) {
    if (hiddenIndexes.has(index)) continue;
    if (index === columnIndex) visibleColumnIndex = resultColumns.length;
    resultColumns.push(resultColumn);
  }
  if (visibleColumnIndex === undefined) return undefined;
  return { resultColumns, columnIndex: visibleColumnIndex };
}

export function useDataGridActions(activeTab: ComputedRef<QueryTab | undefined>) {
  const { t } = useI18n();
  const { toast } = useToast();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableDataIdentifier(effectiveDatabaseTypeForConnection(config), name, connectionStore.connectionIdentifierQuote?.(tab.connectionId));
  }

  function buildTableSql(tab: QueryTab, options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string } = {}): Promise<string> {
    const config = connectionStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const tableMeta = tableMetaForDataTab(tab);
    const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : (tableMeta?.primaryKeys ?? []);
    const useRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys, tableMeta?.tableType);
    // 列投影只信任真实元数据列：tableMetaForDataTab 的 fallback 列来自查询
    // 结果（可能是失败结果的 ["Error"]），进入 SQL 会生成非法投影；
    // 真实列缺失时省略 columns 让 builder 生成 SELECT *
    const realColumns = tab.tableMeta?.columns.length ? tab.tableMeta.columns : undefined;
    return buildTableSelectSql({
      databaseType: effectiveDbType,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(tab.connectionId),
      database: tableMeta?.database,
      schema: tableMeta?.schema,
      tableName: tableMeta?.tableName ?? "",
      tableType: tableMeta?.tableType,
      catalog: tableMeta?.catalog,
      columns: realColumns?.map((column) => column.name),
      primaryKeys,
      includeRowId: useRowId,
      limit: options.limit ?? tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize),
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
      catalog: tableMeta.catalog,
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
    // 复用共享表元数据缓存（30s TTL + in-flight 去重），多个入口对同一张表
    // 不再各自往返 getColumns/listIndexes
    const { metadata } = await loadTableMetadata({
      connectionId: target.connectionId,
      database: target.database,
      schema: querySchema,
      tableName: target.tableName,
      tableType: target.tableType,
      databaseType: effectiveDatabaseTypeForConnection(config) ?? config?.db_type ?? "",
      driverProfile: config?.driver_profile || config?.db_type,
      catalog: target.catalog,
    });
    const columns = metadata.columns;
    console.info("[DBX][reloadData:metadata:get-columns:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), columnCount: columns.length });
    const current = queryStore.tabs.find((item) => item.id === target.tabId);
    const currentMeta = current ? tableMetaForDataTab(current) : undefined;
    if (!current || current.mode !== "data" || current.connectionId !== target.connectionId || current.database !== target.database || currentMeta?.tableName !== target.tableName || (currentMeta.schema ?? "") !== (target.schema ?? "") || (currentMeta.catalog ?? "") !== (target.catalog ?? "")) {
      console.info("[DBX][reloadData:metadata:stale-tab]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return;
    }
    const primaryKeys = metadata.primaryKeys;
    queryStore.setTableMeta(target.tabId, {
      catalog: target.catalog,
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

  async function onReloadData(sql?: string, _searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) {
    const tab = activeTab.value;
    if (!tab) return;
    const traceId = uuid().slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    if (tab.mode === "data" && tableMetaForDataTab(tab)) {
      tab.whereInput = whereInput ?? "";
      const pageLimit = limit ?? tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
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
      const metadataAgeMs = tab.tableMetaUpdatedAt ? Date.now() - tab.tableMetaUpdatedAt : Number.POSITIVE_INFINITY;
      // 判断元数据是否真实存在必须用原始 tab.tableMeta：tableMetaForDataTab 会在
      // 真实列缺失时用查询结果列合成 columns（包括失败结果的 ["Error"] 列），
      // 不能据此跳过刷新，否则恢复/失败后的重试会被 TTL 卡住
      const hasRealTableMetaColumns = !!tab.tableMeta?.columns.length;
      const shouldRefreshMetadata = !hasRealTableMetaColumns || metadataAgeMs > DATA_TAB_METADATA_TTL_MS;
      // Dameng 元数据必须与数据查询串行（同 useSidebarDataOpenRuntime），
      // 延后到查询完成后再启动
      const deferMetadataRefresh = effectiveDatabaseTypeForConnection(connectionStore.getConfig(tab.connectionId)) === "dameng";
      const startMetadataRefresh = () => {
        console.info("[DBX][reloadData:metadata:background:start]", { traceId, elapsed: elapsed(), reason: hasRealTableMetaColumns ? "stale" : "missing", metadataAgeMs });
        void refreshDataTabTableMeta(tab, { traceId, elapsed })
          .then(() => {
            console.info("[DBX][reloadData:metadata:background:done]", { traceId, elapsed: elapsed() });
          })
          .catch((e: any) => {
            console.warn("[DBX][reloadData:metadata:background:error]", { traceId, elapsed: elapsed(), error: e });
            toast(e?.message || String(e), 5000);
          });
      };
      if (shouldRefreshMetadata) {
        // 元数据缺失（如重启恢复的标签页只持久化了占位身份）时行标识未知：
        // 挂起等待，防止数据查询先返回后编辑/保存以空 primaryKeys 短暂可用，
        // 走整行 WHERE 保存路径（#3727）。真实元数据经 setTableMeta 落地后解除
        if (!hasRealTableMetaColumns) tab.tableMetaPending = true;
        if (!deferMetadataRefresh) startMetadataRefresh();
      } else {
        console.info("[DBX][reloadData:metadata:skip]", { traceId, elapsed: elapsed(), columnCount: tab.tableMeta!.columns.length, metadataAgeMs });
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
        if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
        throw e;
      }
      if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
      return;
    }
    if (intent === "refresh" && tab.mode === "query" && (tab.results?.length ?? 0) > 1) {
      const resultGroupSql = tab.resultBaseSql || tab.lastExecutedSql || tab.sql;
      if (!resultGroupSql.trim()) return;
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultSortedSql = undefined;
      await queryStore.executeTabSql(tab.id, resultGroupSql, {
        resultBaseSql: resultGroupSql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        preserveActiveResultIndex: true,
      });
      return;
    }
    if (tab.resultSortedSql) {
      const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, tab.resultSortColumnIndex ?? -1);
      const rebuildHiddenKeySort = !!tab.result?.hidden_column_indexes?.length && tab.resultSortMode === "database" && !!tab.resultSortDirection && !!tab.resultSortColumn && !!sortColumns;
      await queryStore.executeTabSql(tab.id, rebuildHiddenKeySort ? (tab.resultBaseSql ?? tab.sql) : tab.resultSortedSql, {
        resultBaseSql: tab.resultBaseSql ?? tab.sql,
        ...(rebuildHiddenKeySort
          ? {
              querySort: {
                resultColumns: sortColumns.resultColumns,
                columnIndex: sortColumns.columnIndex,
                column: tab.resultSortColumn!,
                direction: tab.resultSortDirection!,
              },
            }
          : { resultSortedSql: tab.resultSortedSql }),
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
      const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, tab.resultSortColumnIndex ?? -1);
      const hasDatabaseSort = !!tab.result?.hidden_column_indexes?.length && tab.resultSortMode === "database" && !!tab.resultSortDirection && !!tab.resultSortColumn && !!sortColumns;
      const baseSql = hasDatabaseSort ? queryResultBaseSql(tab) : queryResultExecutionSql(tab);
      if (!baseSql.trim()) return;
      const expectedNextOffset = (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
      const sessionId = tab.result?.has_more && tab.result?.session_id && offset === expectedNextOffset && limit === tab.resultPageLimit ? tab.result.session_id : undefined;
      const resultBaseSql = queryResultBaseSql(tab);
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql,
        resultSortedSql: tab.resultSortedSql,
        ...(hasDatabaseSort
          ? {
              querySort: {
                resultColumns: sortColumns.resultColumns,
                columnIndex: sortColumns.columnIndex,
                column: tab.resultSortColumn!,
                direction: tab.resultSortDirection!,
              },
            }
          : {}),
        pagination: { offset, limit, sessionId },
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
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
      preserveTotalRowCountDuringExecution: true,
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

    const baseSql = queryResultBaseSql(tab);
    if (!baseSql.trim()) return;

    if (!direction) {
      await queryStore.executeTabSql(tab.id, baseSql, {
        resultBaseSql: baseSql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }

    const config = connectionStore.getConfig(tab.connectionId);
    if (effectiveDatabaseTypeForConnection(config) === "mongodb") {
      const sortedSql = applyMongoFindSort(baseSql, column, direction);
      if (!sortedSql) {
        toast(t("grid.sortUnsupported"), 5000);
        return;
      }
      queryStore.updateSql(tab.id, sortedSql);
      await queryStore.executeTabSql(tab.id, sortedSql, {
        resultBaseSql: baseSql,
        resultSortedSql: sortedSql,
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }

    const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, columnIndex);
    if (!sortColumns) {
      toast(t("grid.sortUnsupported"), 5000);
      return;
    }
    if (!tab.result?.hidden_column_indexes?.length) {
      const built = await api.buildSortedQuerySql({
        originalSql: baseSql,
        databaseType: effectiveDatabaseTypeForConnection(config),
        resultColumns: sortColumns.resultColumns,
        columnIndex: sortColumns.columnIndex,
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
        replaceActiveResultInGroup: true,
      });
      return;
    }
    await queryStore.executeTabSql(tab.id, baseSql, {
      resultBaseSql: baseSql,
      querySort: {
        resultColumns: sortColumns.resultColumns,
        columnIndex: sortColumns.columnIndex,
        column,
        direction,
      },
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
