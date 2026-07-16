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

    // Cancel any previous execution on this tab before starting a new one
    const existingTab = queryStore.tabs.find((t) => t.id === tabId);
    if (existingTab?.isExecuting && existingTab.executionId) {
      await queryStore.cancelTabExecution(tabId);
      logPhase("previous-execution-cancelled", { tabId });
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
    const cachedTableMeta = sharedCachedTableMeta ? tableMetadataToDataTabMeta(sharedCachedTableMeta.metadata, tableSchema) : tabCachedTableMeta;
    const cachedTableMetaAgeMs = sharedCachedTableMeta?.ageMs ?? existingTableMetaAgeMs;
    const cachedTableMetaSource = sharedCachedTableMeta ? "shared" : tabCachedTableMeta ? "tab" : undefined;
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

      const limit = tableOpenPageLimit();
      const shouldRefreshTableMeta = !cachedTableMeta;
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
      } else {
        logPhase("metadata-deferred", { tabId });
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
      if (shouldRefreshTableMeta && canApplyTableMetadata(tabId)) {
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
