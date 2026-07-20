import { nextTick } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TreeNode } from "@/types/database";
import { uuid } from "@/lib/common/utils";
import { appendDebugLog, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { effectiveDatabaseTypeForConnection, connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema } from "@/lib/database/jdbcDialect";
import { getCachedTableMetadata, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS, tableMetadataToDataTabMeta } from "@/lib/metadata/tableMetadataCache";
import { canApplyDataTabMetadata, dataTabMetadataNeedsRefresh, findExistingDataTabCandidate, type DataTabOpenMode } from "@/lib/sidebar/dataTabOpenPolicy";
import type { SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import { hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { canActivateExistingDataTableTab } from "@/lib/tabs/dataTabActivation";
import { beginDataTabNavigation, endDataTabNavigation, isCurrentDataTabNavigation } from "@/lib/tabs/dataTabNavigationGeneration";

const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;

function hasNodeDatabaseContext(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return !!node.connectionId && hasTreeNodeDatabaseContext(node);
}

export function useSidebarDataOpenRuntime() {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();

  async function openData(node: TreeNode, request?: SidebarDataOpenRequest, openMode: DataTabOpenMode = "default") {
    if (!(node.type === "table" || node.type === "view" || node.type === "materialized_view") || !hasNodeDatabaseContext(node)) return;
    const config = connectionStore.getConfig(node.connectionId);
    const traceId = uuid().slice(0, 8);
    const startedAt = performance.now();
    let lastPhaseAt = startedAt;
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    const openDataLog = (level: "info" | "warn" | "error" | "debug", event: string, details: Record<string, unknown>) => {
      appendDebugLog(level, `[DBX][openData:${event}]`, details);
    };
    const logPhase = (phase: string, extra: Record<string, unknown> = {}) => {
      const now = performance.now();
      openDataLog("info", "phase", {
        traceId,
        phase,
        deltaMs: Math.round(now - lastPhaseAt),
        totalMs: Math.round(now - startedAt),
        ...extra,
      });
      lastPhaseAt = now;
    };
    openDataLog("info", "start", {
      traceId,
      type: node.type,
      dbType: config?.db_type,
      openMode,
    });
    const tableSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
    const tableType = node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : (node.tableType ?? "TABLE");
    const querySchema = config ? connectionObjectTreeQuerySchema(config, node.database, tableSchema) : (tableSchema ?? "");
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const metadataDatabaseType = effectiveDbType || config?.db_type || "";
    const dataTabTarget = {
      connectionId: node.connectionId,
      database: node.database,
      schema: tableSchema,
      catalog: node.catalog,
      tableName: node.label,
    };
    const canApplyTableMetadata = (targetTabId: string) =>
      canApplyDataTabMetadata(
        queryStore.tabs.find((tab) => tab.id === targetTabId),
        dataTabTarget,
        request?.signal,
      );
    const refreshTableMetaInBackground = async (targetTabId: string, ensureConnected = false) => {
      if (!config) return;
      const metadataStartedAt = performance.now();
      openDataLog("info", "metadata:start", {
        traceId,
        elapsed: elapsed(),
      });
      try {
        if (ensureConnected) await connectionStore.ensureConnected(node.connectionId);
        const loadedMetadata = await loadTableMetadata({
          connectionId: node.connectionId,
          database: node.database,
          schema: querySchema,
          tableName: node.label,
          tableType,
          databaseType: metadataDatabaseType,
          driverProfile: config.driver_profile || config.db_type,
          catalog: node.catalog,
          traceLogger: isDebugLoggingEnabled() ? (event) => openDataLog("debug", "metadata:trace", { sourceTraceId: traceId, ...event }) : undefined,
        });
        if (!canApplyTableMetadata(targetTabId)) {
          openDataLog("info", "metadata:stale", {
            traceId,
            tabId: targetTabId,
            columnCount: loadedMetadata.metadata.columns.length,
            elapsed: elapsed(),
          });
          return;
        }
        const nextTableMeta = tableMetadataToDataTabMeta(loadedMetadata.metadata, tableSchema);
        queryStore.setTableMeta(targetTabId, nextTableMeta);
        openDataLog("info", "metadata:done", {
          traceId,
          tabId: targetTabId,
          columnCount: nextTableMeta.columns.length,
          primaryKeyCount: nextTableMeta.primaryKeys.length,
          cacheStatus: loadedMetadata.cacheStatus,
          ageMs: Math.round(loadedMetadata.ageMs),
          elapsed: elapsed(),
          metadataMs: Math.round(performance.now() - metadataStartedAt),
        });
      } catch (error) {
        // 元数据加载失败：行标识仍然未知，保持只读（tableMetaPending 不清除），
        // 不回退到整行 WHERE 写入；刷新或重开表会重试加载并恢复
        openDataLog("warn", "metadata:error", { traceId, tabId: targetTabId, elapsed: elapsed(), error });
      }
    };
    const existingDataTabCandidate = findExistingDataTabCandidate(queryStore.tabs, dataTabTarget, { openMode, reuseDataTab: settingsStore.editorSettings.reuseDataTab });
    const existingSameTableTab = existingDataTabCandidate?.match === "same-table" ? existingDataTabCandidate.tab : undefined;
    const resetReusedDataTabState = (tab: (typeof queryStore.tabs)[number]) => {
      tab.title = node.label;
      tab.schema = tableSchema;
      tab.whereInput = undefined;
      tab.orderByInput = undefined;
      tab.previewSql = undefined;
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultLocalSortOriginalRows = undefined;
      tab.resultLocalSortOriginalMongoDocuments = undefined;
      tab.resultSortedSql = undefined;
      tab.resultPageSql = undefined;
      tab.resultPageLimit = undefined;
      tab.resultPageOffset = undefined;
      tab.resultTotalRowCount = undefined;
      tab.resultTotalRowCountLoading = undefined;
      tab.queryAnalysis = undefined;
      tab.querySourceColumns = undefined;
      tab.queryEditabilityReason = undefined;
    };

    if (existingSameTableTab && canActivateExistingDataTableTab(existingSameTableTab, { activateExecuting: false })) {
      queryStore.switchTab(existingSameTableTab.id);
      logPhase("existing-tab-activated", { table: node.label });
      if (dataTabMetadataNeedsRefresh(existingSameTableTab, DATA_TAB_METADATA_TTL_MS)) {
        // 真实列缺失时行标识未知：启动刷新的同时必须挂起编辑门控（所有
        // "真实列缺失且启动刷新"的入口统一置 pending）
        if (!existingSameTableTab.tableMeta?.columns.length) existingSameTableTab.tableMetaPending = true;
        void refreshTableMetaInBackground(existingSameTableTab.id, true);
        logPhase("metadata-started", { tabId: existingSameTableTab.id, reason: "existing-tab-stale" });
      }
      return;
    }

    const tabId = (() => {
      if (existingDataTabCandidate) {
        queryStore.switchTab(existingDataTabCandidate.tab.id);
        resetReusedDataTabState(existingDataTabCandidate.tab);
        return existingDataTabCandidate.tab.id;
      }
      return queryStore.createTab(node.connectionId, node.database, node.label, "data", tableSchema);
    })();
    openDataLog("info", "tab-created", { traceId, tabId, elapsed: elapsed() });
    logPhase("tab-created", { tabId });
    // 接管该 tab：登记本次导航代次，作废在途的 openTableTarget/openData 旧代次
    // ——旧导航即使目标身份相同（同表不同 whereInput）也不得再落地
    const navigationToken = beginDataTabNavigation(tabId);

    // Cancel any previous execution on this tab before starting a new one
    const existingTab = queryStore.tabs.find((t) => t.id === tabId);
    if (existingTab?.isExecuting && existingTab.executionId) {
      await queryStore.cancelTabExecution(tabId);
      logPhase("previous-execution-cancelled", { tabId });
      // 取消等待期间可能有更晚的导航（openTableTarget/openData）接管本 tab：
      // 本代次已作废，不得再写占位元数据/executionId 覆盖新导航
      if (!isCurrentDataTabNavigation(tabId, navigationToken)) {
        logPhase("superseded-during-cancel", { tabId });
        return;
      }
    }
    // 取消窗口之后由 executionId 比对（isActive）保护，代次使命完成即注销；
    // 已作废的旧 token 不因删除而复活（比对按 token 同一性）
    endDataTabNavigation(tabId, navigationToken);

    const openDataId = uuid();
    // Clear previous result so DataGrid doesn't show its internal loading overlay (without stop button)
    const tab = queryStore.tabs.find((t) => t.id === tabId);
    if (tab) {
      tab.result = undefined;
      tab.results = undefined;
    }
    const existingTableMeta = tab?.tableMeta;
    const existingTableMetaAgeMs = tab?.tableMetaUpdatedAt ? Date.now() - tab.tableMetaUpdatedAt : Number.POSITIVE_INFINITY;
    const sharedCachedTableMeta = config
      ? getCachedTableMetadata({
          connectionId: node.connectionId,
          database: node.database,
          schema: querySchema,
          tableName: node.label,
          tableType,
          databaseType: metadataDatabaseType,
          driverProfile: config.driver_profile || config.db_type,
          catalog: node.catalog,
        })
      : undefined;
    const tabCachedTableMeta =
      existingTableMeta?.tableName === node.label && (existingTableMeta.catalog || "") === (node.catalog || "") && existingTableMeta.schema === tableSchema && existingTableMeta.tableType === tableType && existingTableMeta.columns.length > 0 && existingTableMetaAgeMs < DATA_TAB_METADATA_TTL_MS
        ? existingTableMeta
        : undefined;
    // 空列的共享缓存条目不算暖缓存：columns=[] 无法区分"表确实无列"与
    // 占位/异常态，按暖缓存跳过 pending 与刷新会让整行 WHERE 保存路径
    // 在行标识未知时重新可用（#3727 审查意见）
    const cachedTableMeta = sharedCachedTableMeta?.metadata.columns.length ? tableMetadataToDataTabMeta(sharedCachedTableMeta.metadata, tableSchema) : tabCachedTableMeta;
    const cachedTableMetaAgeMs = sharedCachedTableMeta?.metadata.columns.length ? sharedCachedTableMeta.ageMs : existingTableMetaAgeMs;
    const cachedTableMetaSource = sharedCachedTableMeta?.metadata.columns.length ? "shared" : tabCachedTableMeta ? "tab" : undefined;
    queryStore.setTableMeta(
      tabId,
      cachedTableMeta ?? {
        catalog: node.catalog,
        database: node.database,
        schema: tableSchema,
        tableName: node.label,
        tableType,
        columns: [],
        primaryKeys: [],
      },
    );
    if (!cachedTableMeta) {
      // 冷缓存：占位元数据的 primaryKeys 为空但真实主键未知。挂起行标识
      // 等待，元数据落地（setTableMeta）或加载失败前编辑/保存保持禁用，
      // 防止数据查询先返回时整行 WHERE 保存路径短暂可用（#3727）
      const pendingTab = queryStore.tabs.find((item) => item.id === tabId);
      if (pendingTab) pendingTab.tableMetaPending = true;
    }
    queryStore.setExecutingWithId(tabId, openDataId);
    request?.registerCancel(async () => {
      const current = queryStore.tabs.find((item) => item.id === tabId);
      if (current?.isExecuting && current.executionId === openDataId) {
        await queryStore.cancelTabExecution(tabId);
      }
    });
    logPhase("state-prepared", { tabId });

    // Yield to Vue's scheduler so the new tab becomes visible in the UI (tab
    // bar activates, content area switches) before the first blocking network
    // call. Without this the entire openData flow runs synchronously before the
    // browser paints, making the UI feel frozen on each table click.
    await nextTick();

    // Helper to check if this openData call is still active (not superseded by a newer click)
    const isActive = () => (request?.isCurrent() ?? true) && queryStore.tabs.find((t) => t.id === tabId)?.executionId === openDataId;

    try {
      openDataLog("info", "ensure-connected:start", { traceId, elapsed: elapsed() });
      await connectionStore.ensureConnected(node.connectionId);
      if (!isActive()) {
        logPhase("superseded-after-ensure-connected", { tabId });
        return;
      }
      openDataLog("info", "ensure-connected:done", { traceId, elapsed: elapsed() });
      logPhase("ensure-connected", { tabId });
      if (!config) throw new Error("Connection config not found");

      const limit = tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
      const shouldRefreshTableMeta = !cachedTableMeta;
      // Dameng metadata calls must remain serialized behind the table query.
      const deferTableMetaRefresh = effectiveDbType === "dameng";
      if (cachedTableMeta) {
        openDataLog("info", "metadata:cache-hit", {
          traceId,
          tabId,
          columnCount: cachedTableMeta.columns.length,
          primaryKeyCount: cachedTableMeta.primaryKeys.length,
          source: cachedTableMetaSource,
          ageMs: Math.round(cachedTableMetaAgeMs),
          elapsed: elapsed(),
        });
      } else if (deferTableMetaRefresh) {
        logPhase("metadata-deferred", { tabId });
      } else {
        void refreshTableMetaInBackground(tabId);
        logPhase("metadata-started", { tabId });
      }

      // Check if superseded by a newer openData call
      if (!isActive()) {
        logPhase("superseded-before-build-sql", { tabId });
        return;
      }

      const columns = cachedTableMeta?.columns ?? [];
      const primaryKeys = cachedTableMeta?.primaryKeys ?? [];
      const includeRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys, tableType);
      const sql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        identifierQuote: connectionStore.connectionIdentifierQuote?.(node.connectionId),
        schema: tableSchema,
        database: node.database,
        tableName: node.label,
        tableType,
        catalog: node.catalog,
        columns: columns.map((column) => column.name),
        primaryKeys,
        limit,
        includeRowId,
      });
      // SQL 构建是异步后端调用：期间更晚的导航（openData/openTableTarget）
      // 接管会替换 executionId，旧流程不得再覆盖 SQL/启动查询
      if (!isActive()) {
        logPhase("superseded-after-build-sql", { tabId });
        return;
      }
      openDataLog("info", "sql-built", {
        traceId,
        primaryKeyCount: primaryKeys.length,
        includeRowId,
        sqlLength: sql.length,
        elapsed: elapsed(),
      });
      logPhase("sql-built", { tabId, columnCount: columns.length, primaryKeyCount: primaryKeys.length });
      queryStore.updateSql(tabId, sql);
      logPhase("sql-updated", { tabId });

      openDataLog("info", "execute:start", { traceId, tabId, elapsed: elapsed() });
      await queryStore.executeTabSql(tabId, sql, {
        sourceTraceId: traceId,
        skipEnsureConnected: true,
        pagination: { limit, offset: 0 },
      });
      openDataLog("info", "execute:done", { traceId, tabId, elapsed: elapsed() });
      logPhase("execute-tab-sql", { tabId });
      if (shouldRefreshTableMeta && deferTableMetaRefresh && canApplyTableMetadata(tabId)) {
        void refreshTableMetaInBackground(tabId);
        logPhase("metadata-started", { tabId });
      }
    } catch (e: any) {
      if (!isActive()) {
        logPhase("superseded-after-error", { tabId });
        return;
      }
      openDataLog("error", "error", { traceId, elapsed: elapsed(), error: e });
      logPhase("error", { tabId });
      queryStore.setErrorResult(tabId, e);
    }
  }

  return { openData };
}
