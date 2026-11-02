import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { buildTableSelectSql, quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { tableDataLargeValuePreviewOptions, tableDataPreviewRowBudget } from "@/lib/dataGrid/dataGridLargeValues";
import { elasticsearchCursorPageJumpRequestCount } from "@/lib/dataGrid/dataGridPagination";
import { editablePrimaryKeys, shouldIncludeSyntheticRowId } from "@/lib/table/tableEditing";
import { markRowIdLocatorUnsupported, rowIdLocatorUnsupported, shouldKeepRowIdLocatorDisabled, shouldRetryWithoutRowIdLocator } from "@/lib/table/tableRowIdSupport";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import { loadVirtualRowIdentifier } from "@/lib/table/virtualRowIdentifier";
import * as api from "@/lib/backend/api";
import type { ColumnInfo, QueryTab } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { invalidateTableMetadataCache, loadTableColumns, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS } from "@/lib/metadata/tableMetadataCache";
import { isDataTabMetadataLifecycleStale } from "@/lib/sidebar/dataTabOpenPolicy";
import { applyMongoFindSort } from "@/lib/mongo/mongoShellCommand";
import { uuid } from "@/lib/common/utils";
import { primaryKeyTieBreakerIndexes, simpleDataGridOrderByReferencesMissingColumn, type DataGridSortMode } from "@/lib/dataGrid/dataGridSort";
import type { DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import { continuousQueryResultMaxRows, MAX_QUERY_RESULT_MAX_ROWS } from "@/lib/dataGrid/queryResultRowLimit";
import { queryResultBaseSql, queryResultExecutionSql } from "@/lib/tabs/tabPresentation";
import { sqlExecutionTargetCapabilities } from "@/lib/database/sqlExecutionTargetCapabilities";
import { usesAgentCursorForTableData } from "@/lib/database/databaseDriverManifest";

const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;

type TableMetadataColumns = ColumnInfo[];

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
  const pendingDataReloads = new Set<QueryTab>();
  const metadataRequests = new WeakMap<QueryTab, object>();

  // A data-grid action names the tab that emitted the event, so a queued
  // or late-routed event cannot fall back to whichever tab is active now.
  function resolveActionTab(tabId: string | undefined): QueryTab | undefined {
    if (!tabId) {
      return activeTab.value;
    }
    const fromStore = queryStore.tabs.find((candidate) => candidate.id === tabId);
    if (fromStore) {
      return fromStore;
    }
    // Hosts may hold the acting tab outside the store array; identity comes
    // from the captured id either way.
    return activeTab.value?.id === tabId ? activeTab.value : undefined;
  }

  function refreshActiveResultRunOptions(tab: QueryTab): { refreshActiveResultRun?: boolean } {
    // Reloads/pagination/sorting re-run the displayed SQL; they are result-view
    // operations and must not capture another result run when auto-keep is on.
    return tab.mode === "query" ? { refreshActiveResultRun: true } : {};
  }

  function activeQueryTargetOptions(tab: QueryTab) {
    const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
    if (!executionTarget) return {};
    const connection = connectionStore.getConfig(executionTarget.connectionId);
    const capabilities = sqlExecutionTargetCapabilities(connection);
    return capabilities ? { executionTarget, targetContext: capabilities.provider.toExecutionContext(executionTarget, connection!) } : { executionTarget };
  }

  function quoteIdent(tab: QueryTab, name: string): string {
    const config = connectionStore.getConfig(tab.connectionId);
    return quoteTableDataIdentifier(effectiveDatabaseTypeForConnection(config), name, connectionStore.connectionIdentifierQuote?.(tab.connectionId));
  }

  function tableDataPageLimit(tab: QueryTab): number {
    return tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
  }

  function reconcileOracleTableType(tab: QueryTab): void {
    const config = connectionStore.getConfig(tab.connectionId);
    const databaseType = effectiveDatabaseTypeForConnection(config);
    if (databaseType !== "oracle" && databaseType !== "oceanbase-oracle") return;
    const tableMeta = tab.tableMeta;
    if (!tableMeta?.tableName) return;

    const normalize = (value: string | undefined) => value?.trim().toLowerCase() ?? "";
    const resolvedSchema = tableMeta.schema?.trim() || config?.default_schema?.trim();
    const matches = connectionStore
      .lookupLocalCompletionTables(tab.connectionId, tableMeta.database ?? tab.database, tableMeta.tableName, 20, resolvedSchema, tableMeta.catalog)
      .filter((candidate) => normalize(candidate.name) === normalize(tableMeta.tableName) && normalize(candidate.schema) === normalize(resolvedSchema) && normalize(candidate.catalog) === normalize(tableMeta.catalog));
    if (matches.length !== 1) return;

    const objectType = matches[0]?.type;
    const resolvedTableType = objectType === "view" ? "VIEW" : objectType === "materialized_view" ? "MATERIALIZED_VIEW" : objectType === "table" ? "TABLE" : undefined;
    if (!resolvedTableType || tableMeta.tableType?.trim().toUpperCase() === resolvedTableType) return;
    queryStore.setTableMeta(tab.id, { ...tableMeta, tableType: resolvedTableType });
  }

  function resultSortPagination(tab: QueryTab): { limit: number; offset: number } | undefined {
    const limit = tab.resultPageLimit;
    return typeof limit === "number" && limit > 0 ? { limit, offset: 0 } : undefined;
  }

  function buildTableSql(tab: QueryTab, options: { orderBy?: string; limit?: number; offset?: number; whereInput?: string; previewPageSize?: number; includeRowId?: boolean } = {}): Promise<string> {
    const { previewPageSize, includeRowId, ...sqlOptions } = options;
    const config = connectionStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const tableMeta = tableMetaForDataTab(tab);
    const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : (tableMeta?.primaryKeys ?? []);
    // 已确认该连接拒绝合成行定位器（如 Hologres 拒绝 tableoid，#12647）时不再注入，
    // 避免无主键表每次打开都报错。
    const useRowId = includeRowId ?? (shouldIncludeSyntheticRowId(effectiveDbType, primaryKeys, tableMeta?.tableType) && !rowIdLocatorUnsupported(tab.connectionId));
    // 列投影只信任真实元数据列：tableMetaForDataTab 的 fallback 列来自查询
    // 结果（可能是失败结果的 ["Error"]），进入 SQL 会生成非法投影；
    // 真实列缺失时省略 columns 让 builder 生成 SELECT *
    const realColumns = tab.tableMeta?.columns.length ? tab.tableMeta.columns : undefined;
    const limit = sqlOptions.limit ?? tableDataPageLimit(tab);
    // The preview budget is a per-fetch byte budget, so it has to be spread over
    // the rows this fetch returns rather than over the rows it asks for.
    return buildTableSelectSql({
      databaseType: effectiveDbType,
      driverProfile: config?.driver_profile,
      serverVersion: config?.database_info?.productVersion,
      identifierQuote: connectionStore.connectionIdentifierQuote?.(tab.connectionId),
      database: tableMeta?.database,
      schema: tableMeta?.schema,
      tableName: tableMeta?.tableName ?? "",
      tableType: tableMeta?.tableType,
      catalog: tableMeta?.catalog,
      columns: realColumns?.map((column) => column.name),
      primaryKeys,
      ...tableDataLargeValuePreviewOptions(effectiveDbType, realColumns ?? [], primaryKeys, previewPageSize ?? limit, config?.db_type === "jdbc"),
      includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
      includeRowId: useRowId,
      limit,
      injectDefaultTimeSeriesWhere: true,
      ...sqlOptions,
    });
  }

  // 行定位器被服务端拒绝时的降级执行（#12647）：首次带定位器的加载失败后，
  // 去掉定位器重试一次；重试成功才记住该连接，之后由 buildTableSql 直接跳过
  // 定位器。重试失败不改共享能力状态，让真实的服务端错误可见。
  async function executeTableDataSqlWithRowIdFallback(tab: QueryTab, sql: string, executeOptions: Parameters<typeof queryStore.executeTabSql>[2], rebuildSql: () => Promise<string>): Promise<void> {
    await queryStore.executeTabSql(tab.id, sql, executeOptions);
    if (!shouldRetryWithoutRowIdLocator(sql, tabResultFor(tab))) return;
    try {
      const fallbackSql = await rebuildSql();
      queryStore.updateSql(tab.id, fallbackSql);
      await queryStore.executeTabSql(tab.id, fallbackSql, executeOptions);
      if (shouldKeepRowIdLocatorDisabled(tabResultFor(tab))) markRowIdLocatorUnsupported(tab.connectionId);
    } catch {
      // Keep the fallback/build error visible without changing shared capability memory.
    }
  }

  function tabResultFor(tab: QueryTab) {
    return queryStore.tabs.find((entry) => entry.id === tab.id)?.result;
  }

  async function refreshDataTabTableMeta(tab: QueryTab, options: { force?: boolean; columnsOnly?: boolean; trace?: { traceId: string; elapsed: () => string } } = {}): Promise<boolean> {
    if (tab.mode !== "data" || !tab.connectionId || !tab.database) return false;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta?.tableName) return false;
    const target = {
      tabId: tab.id,
      connectionId: tab.connectionId,
      database: tableMeta.database ?? tab.database,
      catalog: tableMeta.catalog,
      schema: tableMeta.schema,
      tableName: tableMeta.tableName,
      tableType: tableMeta.tableType,
    };
    // Cache invalidation prevents stale cache writes, but an older caller can
    // still receive its result. Only the latest request may update this tab.
    const requestToken = {};
    metadataRequests.set(tab, requestToken);
    const metadataGenerationAtStart = connectionStore.metadataGenerationFor(target.connectionId, target.database);
    const trace = options.trace;

    console.info("[DBX][reloadData:metadata:ensure-connected:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    await connectionStore.ensureConnected(target.connectionId, { skipIfClosedByUser: true });
    console.info("[DBX][reloadData:metadata:ensure-connected:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed() });
    if (metadataRequests.get(tab) !== requestToken || connectionStore.metadataGenerationFor(target.connectionId, target.database) !== metadataGenerationAtStart) {
      console.info("[DBX][reloadData:metadata:superseded-by-connection-generation]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const config = connectionStore.getConfig(target.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const querySchema = metadataSchemaForConnection(config, target.database, target.schema);
    // MySQL owns its row identity across a refresh (see below). Every other
    // database keeps the existing behavior: the edit gate is closed while the
    // fresh metadata load runs.
    if (effectiveDbType !== "mysql") tab.tableMetaPending = true;
    // MySQL columns do not always report the key that the table loader found
    // through index discovery (for example unique-key identities). A manual
    // refresh must not replace that known row identity with an empty set while
    // the background index load is still running, otherwise `tableMetaPending`
    // turns the data grid read-only and hides all edit controls (#13503).
    const preserveMysqlRowIdentity = effectiveDbType === "mysql" && tableMeta.columns.length > 0;
    console.info("[DBX][reloadData:metadata:get-columns:start]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), schema: querySchema, table: target.tableName, columnsOnly: options.columnsOnly === true });
    // 复用共享表元数据缓存（30s TTL + in-flight 去重），多个入口对同一张表
    // 不再各自往返 getColumns/listIndexes。跨连接生命周期的强制重建走 force，
    // 避免同一共享缓存把断链前的旧列再次交回本次 reload。
    const loaded: { columns: TableMetadataColumns; primaryKeys: string[]; virtualPrimaryKeys?: string[]; rowIdentityResolved: boolean } = options.columnsOnly
      ? await (async () => {
          const { columns } = await loadTableColumns({
            connectionId: target.connectionId,
            database: target.database,
            schema: querySchema,
            tableName: target.tableName,
            tableType: target.tableType,
            databaseType: effectiveDatabaseTypeForConnection(config) ?? config?.db_type ?? "",
            driverProfile: config?.driver_profile || config?.db_type,
            catalog: target.catalog,
            force: options.force === true,
          });
          const declaredPrimaryKeys = editablePrimaryKeys(effectiveDatabaseTypeForConnection(config), columns, target.tableType);
          const virtualPrimaryKeys = declaredPrimaryKeys.length > 0 ? [] : loadVirtualRowIdentifier({ connectionId: target.connectionId, database: target.database, catalog: target.catalog, schema: querySchema, tableName: target.tableName }, columns);
          const primaryKeys = declaredPrimaryKeys.length > 0 ? declaredPrimaryKeys : virtualPrimaryKeys.length > 0 ? virtualPrimaryKeys : preserveMysqlRowIdentity ? tableMeta.primaryKeys : [];
          return {
            columns,
            primaryKeys,
            ...(virtualPrimaryKeys.length ? { virtualPrimaryKeys } : {}),
            rowIdentityResolved: primaryKeys.length > 0 || virtualPrimaryKeys.length > 0 || (preserveMysqlRowIdentity && columns.length > 0),
          };
        })()
      : await (async () => {
          const { metadata } = await loadTableMetadata({
            connectionId: target.connectionId,
            database: target.database,
            schema: querySchema,
            tableName: target.tableName,
            tableType: target.tableType,
            databaseType: effectiveDatabaseTypeForConnection(config) ?? config?.db_type ?? "",
            driverProfile: config?.driver_profile || config?.db_type,
            catalog: target.catalog,
            force: options.force === true,
          });
          // If index discovery failed, columns alone cannot recover a MySQL
          // key that was already known; keep the previous identity instead of
          // leaving the tab read-only (#13473, #13503). A successful discovery
          // that reports no keys still clears it.
          const preservedMysqlPrimaryKeys = preserveMysqlRowIdentity && metadata.rowIdentityResolved === false && metadata.primaryKeys.length === 0 ? tableMeta.primaryKeys : [];
          const primaryKeys = metadata.primaryKeys.length > 0 ? metadata.primaryKeys : preservedMysqlPrimaryKeys;
          return {
            columns: metadata.columns,
            primaryKeys,
            ...(metadata.virtualPrimaryKeys?.length ? { virtualPrimaryKeys: metadata.virtualPrimaryKeys } : {}),
            // A failed index load leaves rowIdentityResolved false (and uncached), but keys the
            // columns already declare still identify rows. Preserved MySQL keys or a table that
            // was already resolved as keyless need no unique-index fallback to keep editing.
            rowIdentityResolved: metadata.rowIdentityResolved !== false || primaryKeys.length > 0 || (preserveMysqlRowIdentity && metadata.columns.length > 0),
          };
        })();
    const columns = loaded.columns;
    console.info("[DBX][reloadData:metadata:get-columns:done]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), columnCount: columns.length });
    if (metadataRequests.get(tab) !== requestToken || connectionStore.metadataGenerationFor(target.connectionId, target.database) !== metadataGenerationAtStart) {
      console.info("[DBX][reloadData:metadata:superseded-by-connection-generation]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const current = queryStore.tabs.find((item) => item.id === target.tabId);
    const currentMeta = current ? tableMetaForDataTab(current) : undefined;
    const currentSourceDatabase = currentMeta?.database ?? current?.database;
    if (
      !current ||
      current !== tab ||
      current.mode !== "data" ||
      current.connectionId !== target.connectionId ||
      currentSourceDatabase !== target.database ||
      currentMeta?.tableName !== target.tableName ||
      (currentMeta.schema ?? "") !== (target.schema ?? "") ||
      (currentMeta.catalog ?? "") !== (target.catalog ?? "")
    ) {
      console.info("[DBX][reloadData:metadata:stale-tab]", { traceId: trace?.traceId, elapsed: trace?.elapsed(), table: target.tableName });
      return false;
    }
    const primaryKeys = loaded.primaryKeys;
    const refreshedMeta = {
      catalog: target.catalog,
      database: target.database,
      schema: target.schema,
      tableName: target.tableName,
      tableType: target.tableType,
      columns,
      primaryKeys,
      ...(loaded.virtualPrimaryKeys?.length ? { virtualPrimaryKeys: loaded.virtualPrimaryKeys } : {}),
    };
    if (loaded.rowIdentityResolved) {
      queryStore.setTableMeta(target.tabId, refreshedMeta);
    } else {
      queryStore.setTableMeta(target.tabId, refreshedMeta, { rowIdentityPending: true });
    }
    return true;
  }

  async function onExecuteSql(tabId: string, sql: string) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    queryStore.updateSql(tab.id, sql);
    await queryStore.executeTabSql(tab.id, sql, { preserveResultDuringExecution: true });
  }

  async function onReloadData(tabId: string | undefined, sql?: string, _searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    const traceId = uuid().slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    if (tab.mode === "data" && tableMetaForDataTab(tab)) {
      if (pendingDataReloads.has(tab)) return;
      pendingDataReloads.add(tab);
      const registered = queryStore.tabs.includes(tab);
      const currentTab = () => (registered ? queryStore.tabs.find((item) => item.id === tab.id) : resolveActionTab(tab.id));
      const source = tableMetaForDataTab(tab)!;
      const target = { connectionId: tab.connectionId, database: tab.database, sourceDatabase: source.database ?? tab.database, tableName: source.tableName, schema: source.schema, catalog: source.catalog };
      const stillCurrent = () => {
        const meta = tableMetaForDataTab(tab);
        return (
          currentTab() === tab &&
          tab.mode === "data" &&
          tab.connectionId === target.connectionId &&
          tab.database === target.database &&
          (meta?.database ?? tab.database) === target.sourceDatabase &&
          meta?.tableName === target.tableName &&
          meta?.schema === target.schema &&
          meta?.catalog === target.catalog
        );
      };
      const stopPreparing = () => {
        // A late request must not reset a replacement tab's execution state.
        if (currentTab() === tab) queryStore.setExecuting(tab.id, false);
      };
      try {
        reconcileOracleTableType(tab);
        tab.whereInput = whereInput ?? "";
        queryStore.clearInvalidDataTabSort(tab.id);
        const realColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
        let incomingSortMissing = realColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, realColumnNames);
        if (incomingSortMissing) tab.orderByInput = undefined;
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
        if (hasRealTableMetaColumns) {
          try {
            console.info("[DBX][reloadData:ensure-connected:start]", { traceId, elapsed: elapsed() });
            await connectionStore.ensureConnected(tab.connectionId);
            console.info("[DBX][reloadData:ensure-connected:done]", { traceId, elapsed: elapsed() });
          } catch (e: any) {
            console.warn("[DBX][reloadData:ensure-connected:error]", { traceId, elapsed: elapsed(), error: e });
            stopPreparing();
            toast(e?.message || String(e), 5000);
            throw e;
          }
        }
        if (!stillCurrent()) {
          stopPreparing();
          return;
        }
        const connectionGeneration = connectionStore.metadataGenerationFor(tab.connectionId, tab.database);
        const lifecycleStale = isDataTabMetadataLifecycleStale(tab, connectionGeneration);
        const shouldRefreshMetadata = lifecycleStale || tab.tableMetaPending || !hasRealTableMetaColumns || metadataAgeMs > DATA_TAB_METADATA_TTL_MS;
        const effectiveDbType = effectiveDatabaseTypeForConnection(connectionStore.getConfig(tab.connectionId));
        // Dameng 元数据必须与数据查询串行（同 useSidebarDataOpenRuntime），
        // 延后到查询完成后再启动。主动刷新和跨生命周期重建除外：必须先拿到新列再
        // 构建 SQL，否则第一次 toolbar reload 仍会沿用断链前的显式列列表。
        const deferMetadataRefresh = intent !== "refresh" && !lifecycleStale && effectiveDbType === "dameng";
        const startMetadataRefresh = () => {
          console.info("[DBX][reloadData:metadata:background:start]", { traceId, elapsed: elapsed(), reason: hasRealTableMetaColumns ? "stale" : "missing", metadataAgeMs });
          void refreshDataTabTableMeta(tab, { force: lifecycleStale, trace: { traceId, elapsed } })
            .then(() => {
              console.info("[DBX][reloadData:metadata:background:done]", { traceId, elapsed: elapsed() });
            })
            .catch((e: any) => {
              console.warn("[DBX][reloadData:metadata:background:error]", { traceId, elapsed: elapsed(), error: e });
              toast(e?.message || String(e), 5000);
            });
        };
        if (lifecycleStale || intent === "refresh" || intent === "row-identifier-change") {
          tab.tableMetaPending = true;
          console.info("[DBX][reloadData:metadata:await:start]", { traceId, elapsed: elapsed(), reason: intent === "refresh" ? "manual-refresh" : "lifecycle-stale", metadataAgeMs });
          try {
            if (intent === "refresh") {
              const meta = tableMetaForDataTab(tab)!;
              const config = connectionStore.getConfig(tab.connectionId);
              const match = {
                connectionId: tab.connectionId,
                database: meta.database ?? tab.database,
                schema: metadataSchemaForConnection(config, meta.database ?? tab.database, meta.schema),
                tableName: meta.tableName,
              };
              invalidateTableMetadataCache(match);
              // 持久缓存（object-meta L2）删除只服务后续结构面板/DDL 读取的
              // 新鲜度，不参与本次查询构建：移出关键路径 fire-and-forget，
              // 失败不再中断刷新（网格侧已由上面的内存失效保证列新鲜）。
              console.info("[DBX][reloadData:object-cache-invalidate:start]", { traceId, elapsed: elapsed() });
              invalidateObjectMetadataCache(match).catch((e: unknown) => {
                console.warn("[DBX][reloadData:object-cache-invalidate:error]", { traceId, elapsed: elapsed(), error: e });
              });
              if (!stillCurrent() || connectionStore.metadataGenerationFor(tab.connectionId, tab.database) !== connectionGeneration) {
                stopPreparing();
                return;
              }
            }
            // 手动刷新等待段只拉列（getColumns），不等 listIndexes：列投影决定
            // 本次 SELECT 的正确性；主键/索引用旧值与新列求交，PK 名不进 SQL
            // 文本（仅作大值预览保护集合），查询本身不受索引元数据延迟影响。
            const rebuilt = await refreshDataTabTableMeta(tab, { force: intent === "refresh" || lifecycleStale, columnsOnly: intent === "refresh" && !lifecycleStale && hasRealTableMetaColumns, trace: { traceId, elapsed } });
            console.info("[DBX][reloadData:metadata:await:done]", { traceId, elapsed: elapsed(), rebuilt });
            if (!rebuilt) {
              stopPreparing();
              return;
            }
          } catch (e: any) {
            console.warn("[DBX][reloadData:metadata:await:error]", { traceId, elapsed: elapsed(), error: e });
            stopPreparing();
            toast(e?.message || String(e), 5000);
            throw e;
          }
          queryStore.clearInvalidDataTabSort(tab.id);
          const rebuiltColumnNames = tab.tableMeta?.columns.map((column) => column.name) ?? [];
          incomingSortMissing = rebuiltColumnNames.length > 0 && simpleDataGridOrderByReferencesMissingColumn(orderBy, rebuiltColumnNames);
          if (incomingSortMissing) {
            // 移除 ORDER BY 时必须同步熄灭列头排序图标（issue #13350）：这里的
            // 清理发生在元数据重建之后，clearInvalidDataTabSort 早已用旧列清单
            // 判定过一次；若排序状态仍指向存活的列，它不会被前者清掉，只清
            // orderByInput 会留下「图标亮、数据无序」的错位。字段集合与
            // queryStore.clearInvalidDataTabSortState 的失效排序清理保持一致。
            tab.orderByInput = undefined;
            tab.resultSortColumn = undefined;
            tab.resultSortColumnIndex = undefined;
            tab.resultSortDirection = undefined;
            tab.resultSortMode = undefined;
            tab.resultSortedSql = undefined;
            tab.resultLocalSortOriginalRows = undefined;
            tab.resultLocalSortOriginalLargeValueCells = undefined;
            tab.resultLocalSortOriginalMongoDocuments = undefined;
            tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
          }
          if (intent === "refresh" && !lifecycleStale) {
            void refreshDataTabTableMeta(tab, { force: false, trace: { traceId, elapsed } })
              .then(() => {
                console.info("[DBX][reloadData:metadata:background-indexes:done]", { traceId, elapsed: elapsed() });
              })
              .catch((e: any) => {
                console.warn("[DBX][reloadData:metadata:background-indexes:error]", { traceId, elapsed: elapsed(), error: e });
              });
          }
        } else if (shouldRefreshMetadata) {
          // 元数据缺失（如重启恢复的标签页只持久化了占位身份）时行标识未知：
          // 挂起等待，防止数据查询先返回后编辑/保存以空 primaryKeys 短暂可用，
          // 走整行 WHERE 保存路径（#3727）。真实元数据经 setTableMeta 落地后解除
          if (!hasRealTableMetaColumns) tab.tableMetaPending = true;
          // Oracle 的 LOB 预览投影依赖列清单：缺失时先等元数据落地再构建 SQL，
          // 否则恢复 tab 的翻页会退回无截断的 SELECT *。MySQL/PostgreSQL 维持
          // 既有语义——reload 先执行、元数据后台补（app-test
          // "data reload executes before slow metadata refresh completes"）。
          if (!hasRealTableMetaColumns && effectiveDbType === "oracle") {
            console.info("[DBX][reloadData:metadata:await:missing]", { traceId, elapsed: elapsed() });
            try {
              const rebuilt = await refreshDataTabTableMeta(tab, { force: false, trace: { traceId, elapsed } });
              console.info("[DBX][reloadData:metadata:await:done]", { traceId, elapsed: elapsed(), rebuilt });
              if (!rebuilt) {
                stopPreparing();
                return;
              }
            } catch (e: any) {
              console.warn("[DBX][reloadData:metadata:await:error]", { traceId, elapsed: elapsed(), error: e });
              stopPreparing();
              toast(e?.message || String(e), 5000);
              throw e;
            }
          } else if (!deferMetadataRefresh) {
            startMetadataRefresh();
          }
        } else {
          console.info("[DBX][reloadData:metadata:skip]", { traceId, elapsed: elapsed(), columnCount: tab.tableMeta!.columns.length, metadataAgeMs });
        }
        try {
          console.info("[DBX][reloadData:build-sql:start]", { traceId, elapsed: elapsed() });
          const nextSql = await buildTableSql(tab, { whereInput, orderBy: incomingSortMissing ? undefined : orderBy, limit: pageLimit, offset: pageOffset });
          console.info("[DBX][reloadData:build-sql:done]", { traceId, elapsed: elapsed() });
          if (!stillCurrent() || connectionStore.metadataGenerationFor(tab.connectionId, tab.database) !== connectionGeneration) {
            stopPreparing();
            return;
          }
          queryStore.updateSql(tab.id, nextSql);
          console.info("[DBX][reloadData:execute:start]", { traceId, elapsed: elapsed() });
          // 不带定位器的加载保持原执行路径；只有定位器加载才走降级包装（#12647）。
          if (nextSql.includes("__DBX_ROWID")) {
            await executeTableDataSqlWithRowIdFallback(
              tab,
              nextSql,
              {
                pagination: { limit: pageLimit, offset: pageOffset },
                preserveResultDuringExecution: true,
              },
              () => buildTableSql(tab, { whereInput, orderBy: incomingSortMissing ? undefined : orderBy, limit: pageLimit, offset: pageOffset, includeRowId: false }),
            );
          } else {
            await queryStore.executeTabSql(tab.id, nextSql, {
              pagination: { limit: pageLimit, offset: pageOffset },
              preserveResultDuringExecution: true,
            });
          }
          console.info("[DBX][reloadData:execute:done]", { traceId, elapsed: elapsed() });
        } catch (e) {
          console.error("[DBX][reloadData:error]", { traceId, elapsed: elapsed(), error: e });
          stopPreparing();
          if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
          throw e;
        }
        if (shouldRefreshMetadata && deferMetadataRefresh) startMetadataRefresh();
        return;
      } finally {
        pendingDataReloads.delete(tab);
      }
    }
    if ((intent === "refresh" || intent === "auto-refresh" || intent === "row-identifier-change") && tab.mode === "query" && (tab.results?.length ?? 0) > 1) {
      const resultGroupSql = tab.resultBaseSql || tab.lastExecutedSql || tab.sql;
      if (!resultGroupSql.trim()) return;
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultSortedSql = undefined;
      await queryStore.executeTabSql(tab.id, resultGroupSql, {
        ...activeQueryTargetOptions(tab),
        ...refreshActiveResultRunOptions(tab),
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
        ...activeQueryTargetOptions(tab),
        ...refreshActiveResultRunOptions(tab),
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
      const hasMultiResults = tab.mode === "query" && (tab.results?.length ?? 0) > 1;
      await queryStore.executeTabSql(tab.id, sql, {
        ...(tab.mode === "query" ? activeQueryTargetOptions(tab) : {}),
        ...refreshActiveResultRunOptions(tab),
        resultBaseSql: sql,
        resultSortedSql: undefined,
        preserveResultDuringExecution: true,
        ...(hasMultiResults ? { replaceActiveResultInGroup: true, preserveActiveResultIndex: true } : {}),
      });
      return;
    }
    await queryStore.executeCurrentTab();
  }

  async function onPaginate(tabId: string | undefined, offset: number, limit: number, whereInput?: string, orderBy?: string, appendRequested = false) {
    const tab = resolveActionTab(tabId);
    if (!tab) return;
    const appendResult = (appendRequested || settingsStore.editorSettings.infiniteScroll) && offset > 0 && offset === tab.result?.rows.length;
    const appendOptions = appendResult
      ? {
          appendResult: {
            maxRows: appendRequested ? MAX_QUERY_RESULT_MAX_ROWS : continuousQueryResultMaxRows(settingsStore.editorSettings.queryResultMaxRowsEnabled, settingsStore.editorSettings.queryResultMaxRows),
          },
        }
      : {};
    if (tab.mode !== "data") {
      const sortColumns = visibleQuerySortColumns(tab.result?.columns ?? [], tab.result?.hidden_column_indexes, tab.resultSortColumnIndex ?? -1);
      const hasDatabaseSort = !!tab.result?.hidden_column_indexes?.length && tab.resultSortMode === "database" && !!tab.resultSortDirection && !!tab.resultSortColumn && !!sortColumns;
      const baseSql = hasDatabaseSort ? queryResultBaseSql(tab) : queryResultExecutionSql(tab);
      if (!baseSql.trim()) return;
      const expectedNextOffset = appendResult ? tab.result?.rows.length : (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
      const continuesResultSession = appendResult ? offset === expectedNextOffset : offset === expectedNextOffset && limit === tab.resultPageLimit;
      const sessionId = tab.result?.has_more && tab.result?.session_id && continuesResultSession ? tab.result.session_id : undefined;
      const resultBaseSql = queryResultBaseSql(tab);
      const executePage = (pageOffset: number, pageSessionId?: string, retainDisplayedResult = false) =>
        queryStore.executeTabSql(tab.id, baseSql, {
          ...activeQueryTargetOptions(tab),
          ...refreshActiveResultRunOptions(tab),
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
          pagination: { offset: pageOffset, limit, sessionId: pageSessionId, clientSessionId: pageSessionId ? tab.resultClientSessionId : undefined },
          ...appendOptions,
          preserveResultDuringExecution: true,
          preserveTotalRowCountDuringExecution: true,
          replaceActiveResultInGroup: true,
          ...(retainDisplayedResult ? { retainDisplayedResult: true } : {}),
        });
      const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
      const executionConnection = connectionStore.getConfig(executionTarget?.connectionId ?? tab.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(executionConnection);
      const usesElasticsearchCursor = effectiveDbType === "elasticsearch" || effectiveDbType === "easysearch";

      // Elasticsearch search_after has no random page access, so every missing
      // cursor must be fetched in order. This workaround still sends one ES
      // request per skipped page (page 1 -> 101 sends 100 requests);
      // retainDisplayedResult only hides those intermediate pages from the UI.
      const currentResultSessionId = tab.resultSessionId ?? tab.result?.session_id;
      if (usesElasticsearchCursor && tab.result?.has_more === true && !appendResult && typeof expectedNextOffset === "number" && limit === tab.resultPageLimit && currentResultSessionId) {
        let nextOffset = expectedNextOffset;
        let nextSessionId: string | undefined = currentResultSessionId;
        const currentPage = Math.floor(nextOffset / limit);
        const targetPage = Math.floor(offset / limit) + 1;
        const totalRequests = elasticsearchCursorPageJumpRequestCount(currentPage, targetPage);
        const jumpProgress =
          totalRequests > 1
            ? {
                completedRequests: 0,
                totalRequests,
                targetPage,
              }
            : undefined;
        if (jumpProgress) {
          tab.resultPageJumpProgress = jumpProgress;
        }
        const activeJumpProgress = tab.resultPageJumpProgress;
        const executeCursorPage = async (pageOffset: number, pageSessionId?: string, retainDisplayedResult = false) => {
          await executePage(pageOffset, pageSessionId, retainDisplayedResult);
          if (activeJumpProgress) {
            activeJumpProgress.completedRequests += 1;
          }
        };

        try {
          if (offset < nextOffset) {
            await executeCursorPage(0, undefined, offset !== 0);
            if (offset === 0) {
              return;
            }
            const restartedTab = activeTab.value;
            if (restartedTab?.id !== tab.id) {
              return;
            }
            nextOffset = limit;
            nextSessionId = restartedTab.resultSessionId;
          }
          while (nextOffset < offset) {
            if (!nextSessionId) {
              return;
            }
            await executeCursorPage(nextOffset, nextSessionId, true);
            const advancedTab = activeTab.value;
            if (advancedTab?.id !== tab.id) {
              return;
            }
            nextOffset += limit;
            nextSessionId = advancedTab.resultSessionId;
          }
          if (nextOffset === offset && nextSessionId) {
            await executeCursorPage(offset, nextSessionId);
            return;
          }
        } finally {
          if (tab.resultPageJumpProgress === activeJumpProgress) {
            tab.resultPageJumpProgress = undefined;
          }
        }
      }

      await executePage(offset, sessionId);
      return;
    }

    if (!tableMetaForDataTab(tab)) return;
    tab.whereInput = whereInput ?? "";
    const sql = await buildTableSql(tab, {
      limit,
      offset,
      whereInput,
      orderBy: orderBy ?? tab.orderByInput,
      previewPageSize: tableDataPreviewRowBudget({
        limit,
        offset,
        expectedTotalRows: tab.resultTotalRowCount,
        loadedRowCount: tab.result?.rows.length ?? 0,
      }),
    });
    queryStore.updateSql(tab.id, sql);
    const expectedNextOffset = appendResult ? tab.result?.rows.length : (tab.resultPageOffset ?? 0) + (tab.resultPageLimit ?? limit);
    const continuesResultSession = offset === expectedNextOffset && limit === tab.resultPageLimit;
    const connection = useConnectionStore().getConfig(tab.connectionId);
    const sessionId = usesAgentCursorForTableData(connection?.db_type, connection?.driver_profile) && tab.result?.has_more && tab.result.session_id && continuesResultSession ? tab.result.session_id : undefined;
    const reloadOptions = {
      pagination: { offset, limit, sessionId, clientSessionId: sessionId ? tab.resultClientSessionId : undefined },
      ...appendOptions,
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
    };
    // 不带定位器的加载保持原执行路径；只有定位器加载才走降级包装（#12647）。
    if (sql.includes("__DBX_ROWID")) {
      await executeTableDataSqlWithRowIdFallback(tab, sql, reloadOptions, () =>
        buildTableSql(tab, {
          limit,
          offset,
          whereInput,
          orderBy: orderBy ?? tab.orderByInput,
          includeRowId: false,
          previewPageSize: tableDataPreviewRowBudget({
            limit,
            offset,
            expectedTotalRows: tab.resultTotalRowCount,
            loadedRowCount: tab.result?.rows.length ?? 0,
          }),
        }),
      );
    } else {
      await queryStore.executeTabSql(tab.id, sql, reloadOptions);
    }
  }

  async function onSort(tabId: string | undefined, column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string, mode: DataGridSortMode = "database", effectiveOrderBy?: string) {
    const tab = resolveActionTab(tabId);
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
      const headerOrderBy = direction ? `${config?.db_type === "neo4j" ? `n.${quotedColumn}` : quotedColumn} ${direction.toUpperCase()}` : undefined;
      const orderBy = effectiveOrderBy === undefined ? headerOrderBy : effectiveOrderBy.trim() || undefined;
      const limit = tableDataPageLimit(tab);
      const pagination = { limit, offset: 0 };
      tab.orderByInput = headerOrderBy;
      const sql = await buildTableSql(tab, { orderBy, whereInput, limit, offset: pagination.offset });
      queryStore.updateSql(tab.id, sql);
      await queryStore.executeTabSql(tab.id, sql, {
        pagination,
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
      });
      return;
    }

    const baseSql = queryResultBaseSql(tab);
    if (!baseSql.trim()) return;
    const pagination = resultSortPagination(tab);

    if (!direction) {
      await queryStore.executeTabSql(tab.id, baseSql, {
        ...activeQueryTargetOptions(tab),
        ...refreshActiveResultRunOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: undefined,
        ...(pagination ? { pagination } : {}),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }

    const executionTarget = queryStore.activeResultExecutionTarget(tab.id);
    const config = connectionStore.getConfig(executionTarget?.connectionId ?? tab.connectionId);
    if (effectiveDatabaseTypeForConnection(config) === "mongodb") {
      const sortedSql = applyMongoFindSort(baseSql, column, direction);
      if (!sortedSql) {
        toast(t("grid.sortUnsupported"), 5000);
        return;
      }
      queryStore.updateSql(tab.id, sortedSql);
      await queryStore.executeTabSql(tab.id, sortedSql, {
        ...activeQueryTargetOptions(tab),
        ...refreshActiveResultRunOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: sortedSql,
        ...(pagination ? { pagination } : {}),
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
        tieBreakerColumnIndexes: primaryKeyTieBreakerIndexes(tab.querySourceColumns?.length === sortColumns.resultColumns.length ? tab.querySourceColumns : sortColumns.resultColumns, tab.tableMeta?.primaryKeys),
      });
      if (!built.ok || !built.sql) {
        toast(t("grid.sortUnsupported"), 5000);
        return;
      }
      await queryStore.executeTabSql(tab.id, built.sql, {
        ...activeQueryTargetOptions(tab),
        ...refreshActiveResultRunOptions(tab),
        resultBaseSql: baseSql,
        resultSortedSql: built.sql,
        ...(pagination ? { pagination } : {}),
        preserveResultDuringExecution: true,
        preserveTotalRowCountDuringExecution: true,
        replaceActiveResultInGroup: true,
      });
      return;
    }
    await queryStore.executeTabSql(tab.id, baseSql, {
      ...activeQueryTargetOptions(tab),
      ...refreshActiveResultRunOptions(tab),
      resultBaseSql: baseSql,
      querySort: {
        resultColumns: sortColumns.resultColumns,
        columnIndex: sortColumns.columnIndex,
        column,
        direction,
      },
      ...(pagination ? { pagination } : {}),
      preserveResultDuringExecution: true,
      preserveTotalRowCountDuringExecution: true,
      replaceActiveResultInGroup: true,
    });
  }

  return { onExecuteSql, onReloadData, onPaginate, onSort };
}
