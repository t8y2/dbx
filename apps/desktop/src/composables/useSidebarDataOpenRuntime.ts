import { nextTick } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import type { TreeNode } from "@/types/database";
import { uuid } from "@/lib/common/utils";
import { appendDebugLog, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { effectiveDatabaseTypeForConnection, connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionTableSqlSchema } from "@/lib/database/jdbcDialect";
import { getCachedTableMetadata, loadTableMetadata, TABLE_METADATA_CACHE_TTL_MS, tableMetadataToDataTabMeta } from "@/lib/metadata/tableMetadataCache";
import { canApplyDataTabMetadata, dataTabMetadataNeedsRefresh, findExistingDataTabCandidate, isDataTabMetadataLifecycleStale, type DataTabOpenMode, type DataTabReuseMode } from "@/lib/sidebar/dataTabOpenPolicy";
import type { SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import { hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { buildTableSelectSql, requiresEagerTableMetadataForDataOpen } from "@/lib/table/tableSelectSql";
import { resolveTableDefaultSort, applyTableDefaultSortResult } from "@/lib/table/tableDefaultSort";
import { physicalTablePrimaryKeys, shouldIncludeSyntheticRowId } from "@/lib/table/tableEditing";
import { markRowIdLocatorUnsupported, rowIdLocatorUnsupported, shouldKeepRowIdLocatorDisabled, shouldRetryWithoutRowIdLocator } from "@/lib/table/tableRowIdSupport";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { tableDataLargeValuePreviewOptions } from "@/lib/dataGrid/dataGridLargeValues";
import { canActivateExistingDataTableTab } from "@/lib/tabs/dataTabActivation";
import { beginDataTabNavigation, endDataTabNavigation, isCurrentDataTabNavigation } from "@/lib/tabs/dataTabNavigationGeneration";
import { dataTabExecutionDatabase } from "@/lib/table/dataTabExecutionDatabase";
import type { NavigationOpenOptions } from "@/composables/useNavigationTargets";

const DATA_TAB_METADATA_TTL_MS = TABLE_METADATA_CACHE_TTL_MS;

function hasNodeDatabaseContext(node: TreeNode): node is TreeNode & { connectionId: string; database: string } {
  return !!node.connectionId && hasTreeNodeDatabaseContext(node);
}

export function useSidebarDataOpenRuntime() {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  const tunnelProfileStore = useTunnelProfileStore();

  async function openData(node: TreeNode, request?: SidebarDataOpenRequest, openMode: DataTabOpenMode = "default", options: NavigationOpenOptions & { reuseMode?: DataTabReuseMode; revealColumn?: string } = {}) {
    if (options.isCurrent?.() === false) return;
    if (!(node.type === "table" || node.type === "view" || node.type === "materialized_view") || !hasNodeDatabaseContext(node)) return;
    const config = connectionStore.getConfig(node.connectionId);
    const reuseMode = options.reuseMode ?? settingsStore.editorSettings.dataTabReuseMode;
    if (config?.db_type === "hbase") {
      await connectionStore.ensureConnected(node.connectionId);
      if (options.isCurrent?.() === false) return;
      const tabId = queryStore.createTab(node.connectionId, node.database, node.label, "hbase", undefined, node.label, undefined, {
        forceNew: openMode === "new-tab" || reuseMode === "always-new",
        insertAfterActive: settingsStore.editorSettings.openDataTabsNextToActive,
      });
      queryStore.updateSql(tabId, node.label);
      options.onOpened?.(tabId);
      return;
    }
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
    // Each data tab executes on its own session-scoped pool
    // (`<connection>:<database>[:catalog:..]:session:<tabId>`), so its first Run
    // pays a fresh database connection. On a remote link that setup costs
    // hundreds of milliseconds of round trips and lands on the critical path of
    // the page fetch the user is waiting for. Start it in the background as soon
    // as the tab exists (and again once the connection is up) so it overlaps the
    // table-metadata load instead of the visible loading spinner.
    const warmTabSessionPool = (targetTabId: string) => {
      if (!config) return;
      connectionStore.warmConnection(node.connectionId, {
        database: dataTabExecutionDatabase(config, node.database, node.catalog),
        catalog: node.catalog,
        clientSessionId: targetTabId,
      });
    };
    openDataLog("info", "start", {
      traceId,
      type: node.type,
      dbType: config?.db_type,
      openMode,
      reuseMode,
    });
    const tableSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
    const tableType = node.type === "view" ? "VIEW" : node.type === "materialized_view" ? "MATERIALIZED_VIEW" : (node.tableType ?? "TABLE");
    const querySchema = config ? connectionObjectTreeQuerySchema(config, node.database, tableSchema) : (tableSchema ?? "");
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const metadataDatabaseType = effectiveDbType || config?.db_type || "";
    // Navicat's PHP tunnel turns every pooled MySQL session into a separate
    // HTTP request. Loading columns and indexes before the first data page
    // therefore creates several competing handshakes and makes the table
    // appear stuck in "loading" even when SELECT itself is already fast.
    // Keep the existing eager metadata behavior for every other transport.
    const isNavicatMysqlTunnel =
      config?.transport_layers?.some((layer) => {
        if (layer.type !== "http_tunnel") return false;
        if (layer.protocol === "navicat_mysql") return true;
        const profile = tunnelProfileStore.profileById(layer.profile_id);
        return profile?.type === "http_tunnel" && profile.protocol === "navicat_mysql";
      }) ?? false;
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
        // 记录启动时的连接元数据代次：加载期间若跨过生命周期边界（disconnect /
        // 关库 / 死池重连），结果已过期，不得写回 tab（PR #6640 review
        // blocker 1 的 tab-local 半边——shared 缓存写回已有 per-scope 失效代
        // 数保护，tab 写回此前没有）。
        const metadataGenerationAtStart = connectionStore.metadataGenerationFor(node.connectionId, node.database);
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
        if (connectionStore.metadataGenerationFor(node.connectionId, node.database) !== metadataGenerationAtStart) {
          openDataLog("info", "metadata:superseded-by-connection-generation", {
            traceId,
            tabId: targetTabId,
            columnCount: loadedMetadata.metadata.columns.length,
            elapsed: elapsed(),
          });
          return;
        }
        if (!canApplyTableMetadata(targetTabId)) {
          openDataLog("info", "metadata:stale", {
            traceId,
            tabId: targetTabId,
            columnCount: loadedMetadata.metadata.columns.length,
            elapsed: elapsed(),
          });
          return;
        }
        const nextTableMeta = tableMetadataToDataTabMeta(loadedMetadata.metadata, { schema: tableSchema });
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
    const existingDataTabCandidate = findExistingDataTabCandidate(queryStore.tabs, dataTabTarget, { openMode, reuseMode, activeTabId: queryStore.activeTabId });
    const existingSameTableTab = existingDataTabCandidate?.match === "same-table" ? existingDataTabCandidate.tab : undefined;
    const resetReusedDataTabState = (tab: (typeof queryStore.tabs)[number]) => {
      tab.title = node.label;
      tab.schema = tableSchema;
      tab.whereInput = undefined;
      tab.orderByInput = undefined;
      tab.structuredOrderByInput = undefined;
      tab.previewSql = undefined;
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultLocalSortOriginalRows = undefined;
      tab.resultLocalSortOriginalLargeValueCells = undefined;
      tab.resultLocalSortOriginalMongoDocuments = undefined;
      tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
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

    if (existingSameTableTab && (existingSameTableTab.isExecuting || canActivateExistingDataTableTab(existingSameTableTab, { activateExecuting: false }))) {
      if (node.comment !== undefined) existingSameTableTab.tableComment = node.comment;
      const previousTableType = existingSameTableTab.tableMeta?.tableType?.trim().toUpperCase();
      const tableTypeChanged = !!existingSameTableTab.tableMeta && previousTableType !== tableType;
      if (tableTypeChanged) {
        queryStore.setTableMeta(existingSameTableTab.id, {
          ...existingSameTableTab.tableMeta!,
          tableType,
        });
      }
      if (options.revealColumn) {
        queryStore.requestGridRevealColumn(existingSameTableTab.id, options.revealColumn);
      }
      queryStore.switchTab(existingSameTableTab.id);
      options.onOpened?.(existingSameTableTab.id);
      logPhase("existing-tab-activated", { table: node.label });
      // 代次失配视同冷缓存（即使位于 30s TTL 窗口内也要重建）：disconnect /
      // 关库 / 死池重连都可能不改变 timestamp 判定而改变连接生命周期
      const connectionGeneration = connectionStore.metadataGenerationFor(node.connectionId, node.database);
      if (tableTypeChanged || isDataTabMetadataLifecycleStale(existingSameTableTab, connectionGeneration) || dataTabMetadataNeedsRefresh(existingSameTableTab, DATA_TAB_METADATA_TTL_MS)) {
        // 真实列缺失时行标识未知：启动刷新的同时必须挂起编辑门控（所有
        // "真实列缺失且启动刷新"的入口统一置 pending）
        if (!existingSameTableTab.tableMeta?.columns.length) existingSameTableTab.tableMetaPending = true;
        void refreshTableMetaInBackground(existingSameTableTab.id, true);
        logPhase("metadata-started", { tabId: existingSameTableTab.id, reason: tableTypeChanged ? "object-type-changed" : "existing-tab-stale" });
      }
      return;
    }

    const tabId = (() => {
      if (existingDataTabCandidate) {
        queryStore.switchTab(existingDataTabCandidate.tab.id);
        resetReusedDataTabState(existingDataTabCandidate.tab);
        existingDataTabCandidate.tab.tableComment = node.comment;
        if (options.revealColumn) {
          queryStore.requestGridRevealColumn(existingDataTabCandidate.tab.id, options.revealColumn);
        }
        return existingDataTabCandidate.tab.id;
      }
      const createdTabId = queryStore.createTab(node.connectionId, node.database, node.label, "data", tableSchema, undefined, node.catalog, {
        forceNew: true,
        insertAfterActive: settingsStore.editorSettings.openDataTabsNextToActive,
      });
      const createdTab = queryStore.tabs.find((tab) => tab.id === createdTabId);
      if (createdTab) {
        createdTab.tableComment = node.comment;
        if (options.revealColumn) {
          queryStore.requestGridRevealColumn(createdTab.id, options.revealColumn);
        }
      }
      return createdTabId;
    })();
    openDataLog("info", "tab-created", { traceId, tabId, elapsed: elapsed() });
    logPhase("tab-created", { tabId });
    warmTabSessionPool(tabId);
    // 接管该 tab：登记本次导航代次，作废在途的 openTableTarget/openData 旧代次
    // ——旧导航即使目标身份相同（同表不同 whereInput）也不得再落地
    const navigationToken = beginDataTabNavigation(tabId);
    const ownsNavigation = () => isCurrentDataTabNavigation(tabId, navigationToken) && (request?.isCurrent() ?? true) && options.isCurrent?.() !== false;

    // Cancel any previous execution on this tab before starting a new one
    const existingTab = queryStore.tabs.find((t) => t.id === tabId);
    if (existingTab?.isExecuting && existingTab.executionId) {
      await queryStore.cancelTabExecution(tabId);
      logPhase("previous-execution-cancelled", { tabId });
      // 取消等待期间可能有更晚的导航（openTableTarget/openData）接管本 tab：
      // 本代次已作废，不得再写占位元数据/executionId 覆盖新导航
      if (!ownsNavigation()) {
        logPhase("superseded-during-cancel", { tabId });
        endDataTabNavigation(tabId, navigationToken);
        return;
      }
    }

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
    const cachedTableMeta = sharedCachedTableMeta?.metadata.columns.length ? tableMetadataToDataTabMeta(sharedCachedTableMeta.metadata, { schema: tableSchema }) : tabCachedTableMeta;
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
    options.onOpened?.(tabId);

    // Yield to Vue's scheduler so the new tab becomes visible in the UI (tab
    // bar activates, content area switches) before the first blocking network
    // call. Without this the entire openData flow runs synchronously before the
    // browser paints, making the UI feel frozen on each table click.
    await nextTick();

    // Helper to check if this openData call is still active (not superseded by a newer click)
    const isActive = () => ownsNavigation() && queryStore.tabs.find((t) => t.id === tabId)?.executionId === openDataId;

    // 执行发布后的结果身份：executeTabSql 启动即把 tab.executionId 换成其内部
    // 执行 id，此后 isActive 不再可用。执行后的错误落地改按"本流程发布的
    // 结果仍在 tab 上"判定，而不是仅靠导航 token——导航 token 识别不了
    // 同页签新手动执行对 executionId 的替换（#13007 复审 P1）。
    let publishedTab: (typeof queryStore.tabs)[number] | undefined;
    let publishedResult: (typeof queryStore.tabs)[number]["result"];
    let publishedResultGeneration: (typeof queryStore.tabs)[number]["resultViewGeneration"];
    let ownsPublishedResult = false;
    const stillOwnsPublishedResult = () => {
      if (!ownsPublishedResult) return false;
      const current = queryStore.tabs.find((item) => item.id === tabId);
      return !!current && ownsNavigation() && current === publishedTab && !current.isExecuting && current.executionId === undefined && current.result === publishedResult && current.resultViewGeneration === publishedResultGeneration;
    };

    try {
      openDataLog("info", "ensure-connected:start", { traceId, elapsed: elapsed() });
      await connectionStore.ensureConnected(node.connectionId);
      if (!isActive()) {
        logPhase("superseded-after-ensure-connected", { tabId });
        return;
      }
      openDataLog("info", "ensure-connected:done", { traceId, elapsed: elapsed() });
      logPhase("ensure-connected", { tabId });
      warmTabSessionPool(tabId);
      if (!config) throw new Error("Connection config not found");

      const limit = tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
      const defaultSortMode = settingsStore.editorSettings.tableOpenSortMode ?? "none";
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
        logPhase("metadata-started", { tabId });
      }

      const metadataRefresh = shouldRefreshTableMeta && !deferTableMetaRefresh && !isNavicatMysqlTunnel ? refreshTableMetaInBackground(tabId) : undefined;
      if (!cachedTableMeta && (requiresEagerTableMetadataForDataOpen(effectiveDbType) || defaultSortMode !== "none")) {
        // No query is in flight yet, so deferred drivers can safely load metadata serially.
        if (deferTableMetaRefresh) await refreshTableMetaInBackground(tabId);
        await metadataRefresh;
      }

      // Check if superseded by a newer openData call
      if (!isActive()) {
        logPhase("superseded-before-build-sql", { tabId });
        return;
      }

      const loadedTableMeta = cachedTableMeta ?? queryStore.tabs.find((item) => item.id === tabId)?.tableMeta;
      const columns = loadedTableMeta?.columns ?? [];
      const primaryKeys = loadedTableMeta?.primaryKeys ?? [];
      const defaultSort = resolveTableDefaultSort(settingsStore.editorSettings, effectiveDbType, loadedTableMeta?.physicalPrimaryKeys ?? physicalTablePrimaryKeys(columns, undefined, effectiveDbType), connectionStore.connectionIdentifierQuote?.(node.connectionId));
      const defaultOrderBy = defaultSort.orderBy;
      // #12647：首开路径同样尊重"该连接的行定位器已被引擎拒绝"的记忆，否则
      // 被降级过的连接每次重新单击表都会再发一次注定失败的定位器查询。
      const includeRowId = shouldIncludeSyntheticRowId(effectiveDbType, primaryKeys, tableType) && !rowIdLocatorUnsupported(node.connectionId);
      const buildOpenSql = (withRowId: boolean) =>
        buildTableSelectSql({
          databaseType: effectiveDbType,
          driverProfile: config?.driver_profile || (config?.db_type === "gbase8s" ? "gbase8s" : undefined),
          serverVersion: connectionStore.getConfig(node.connectionId)?.database_info?.productVersion,
          identifierQuote: connectionStore.connectionIdentifierQuote?.(node.connectionId),
          schema: connectionTableSqlSchema(config, tableSchema),
          database: node.database,
          tableName: node.label,
          tableType,
          catalog: node.catalog,
          columns: columns.map((column) => column.name),
          primaryKeys,
          ...tableDataLargeValuePreviewOptions(effectiveDbType, columns, primaryKeys, limit, config?.db_type === "jdbc"),
          includeDatabaseName: settingsStore.editorSettings.generateSqlIncludeDatabaseName,
          limit,
          includeRowId: withRowId,
          injectDefaultTimeSeriesWhere: true,
          orderBy: defaultOrderBy,
        });
      const sql = await buildOpenSql(includeRowId);
      let finalExecutedSql = sql;
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
      const openedTab = queryStore.tabs.find((item) => item.id === tabId);
      if (openedTab && defaultOrderBy) openedTab.orderByInput = defaultOrderBy;
      logPhase("sql-updated", { tabId });

      openDataLog("info", "execute:start", { traceId, tabId, elapsed: elapsed() });
      const executeOptions = { sourceTraceId: traceId, skipEnsureConnected: true, pagination: { limit, offset: 0 } };
      let openExecuteError: unknown = undefined;
      let openExecutePublished: boolean | undefined;
      let landedOpenExecuteError = false;
      try {
        openExecutePublished = await queryStore.executeTabSql(tabId, sql, executeOptions);
      } catch (error) {
        openExecuteError = error;
      }
      // 行定位器被引擎拒绝时的降级（#12647）：首开路径与 reload 路径保持同一
      // 降级语义——去掉定位器重试一次，成功后才记住该连接；失败不更新能力
      // 标记，让真实的服务端错误可见。执行失败既可能以异常上抛，也可能落成带
      // execution_error 的结果，两种形态都归一到结果上再判定。
      if (openExecuteError !== undefined) {
        const failedTab = queryStore.tabs.find((item) => item.id === tabId);
        if (ownsNavigation() && failedTab && openedTab && failedTab === openedTab && !failedTab.isExecuting && !failedTab.result) {
          queryStore.setErrorResult(tabId, openExecuteError);
          landedOpenExecuteError = true;
        }
      }
      const failedTab = queryStore.tabs.find((item) => item.id === tabId);
      if (openExecutePublished === false || !ownsNavigation() || !failedTab || !openedTab || failedTab !== openedTab || failedTab.isExecuting) return;
      // 只有能证明当前结果是本流程发布/归一的，才把它登记为本流程的结果身
      // 份：执行以异常收场且上方的 setErrorResult 没有落地（结果已被占用，
      // 可能属于已完成的同页签新执行）时，本流程不得再基于当前结果降级或
      // 落地错误。执行成功发布（true）或结果为空时当前结果即本流程的。
      if (openExecuteError !== undefined && !landedOpenExecuteError) return;
      publishedTab = failedTab;
      publishedResult = failedTab.result;
      publishedResultGeneration = failedTab.resultViewGeneration;
      ownsPublishedResult = true;
      if (shouldRetryWithoutRowIdLocator(sql, publishedResult)) {
        try {
          const fallbackSql = await buildOpenSql(false);
          if (!stillOwnsPublishedResult()) return;
          queryStore.updateSql(tabId, fallbackSql);
          const fallbackPublished = await queryStore.executeTabSql(tabId, fallbackSql, executeOptions);
          const retryTab = queryStore.tabs.find((item) => item.id === tabId);
          if (fallbackPublished === false || !ownsNavigation() || !retryTab || retryTab !== openedTab || retryTab.isExecuting) {
            return;
          }
          finalExecutedSql = fallbackSql;
          if (shouldKeepRowIdLocatorDisabled(retryTab.result)) markRowIdLocatorUnsupported(node.connectionId);
        } catch {
          // Fallback execution keeps its own error result visible and must not
          // change the connection capability memory.
        }
      } else if (openExecuteError !== undefined) {
        throw openExecuteError;
      }
      openDataLog("info", "execute:done", { traceId, tabId, elapsed: elapsed() });
      const sortedTab = queryStore.tabs.find((item) => item.id === tabId);
      if ((request?.isCurrent() ?? true) && sortedTab && sortedTab === openedTab && sortedTab.sql === finalExecutedSql) {
        applyTableDefaultSortResult(sortedTab, defaultSort, queryStore.sortTabResultLocally);
      }
      logPhase("execute-tab-sql", { tabId });
      if (shouldRefreshTableMeta && (deferTableMetaRefresh || isNavicatMysqlTunnel) && canApplyTableMetadata(tabId)) {
        void refreshTableMetaInBackground(tabId);
        logPhase("metadata-started", { tabId, deferredForTransport: isNavicatMysqlTunnel ? "navicat_mysql" : "driver" });
      }
    } catch (e: any) {
      // 准备阶段（连接/元数据/SQL 构建）的失败仍按执行身份判定所有权：同页签
      // 的新手动执行会替换 executionId，导航 token 看不见这次替换，旧流程不得
      // 用 setErrorResult 覆盖新执行的执行状态。执行已发布后的失败（上面的
      // openExecuteError 重抛、结果后处理）改按结果身份判定。
      const ownsErrorLanding = ownsPublishedResult ? stillOwnsPublishedResult() : isActive();
      if (!ownsErrorLanding) {
        logPhase("superseded-after-error", { tabId });
        return;
      }
      openDataLog("error", "error", { traceId, elapsed: elapsed(), error: e });
      logPhase("error", { tabId });
      queryStore.setErrorResult(tabId, e);
    } finally {
      endDataTabNavigation(tabId, navigationToken);
    }
  }

  return { openData };
}
