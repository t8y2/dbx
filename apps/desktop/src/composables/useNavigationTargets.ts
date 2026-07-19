import * as api from "@/lib/backend/api";
import { effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { invalidateTableMetadataCache, loadTableMetadata } from "@/lib/metadata/tableMetadataCache";
import { canApplyDataTabMetadata } from "@/lib/sidebar/dataTabOpenPolicy";
import { isNoSnapshotErrorResult } from "@/lib/query/queryResultError";
import { buildTableSelectSql } from "@/lib/table/tableSelectSql";
import { editableRowIdentifierColumns, usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { uuid } from "@/lib/common/utils";
import { beginDataTabNavigation, endDataTabNavigation, isCurrentDataTabNavigation } from "@/lib/tabs/dataTabNavigationGeneration";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ColumnInfo, TableInfoTab } from "@/types/database";

export type NavigationTarget = {
  connectionId: string;
  database: string;
  catalog?: string;
  schema?: string;
  tableName: string;
  tableType?: string;
  columnName?: string;
  whereInput?: string;
};

async function openTableTarget(target: NavigationTarget, options: { tableInfoTab?: TableInfoTab } = {}) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  const pageLimit = tableOpenPageLimit();

  connectionStore.activeConnectionId = target.connectionId;
  const config = connectionStore.getConfig(target.connectionId);
  const tabTitle = target.catalog ? `${target.catalog}.${target.schema || target.database}.${target.tableName}` : target.schema ? `${target.schema}.${target.tableName}` : target.tableName;
  if (config?.db_type === "qdrant" || config?.db_type === "milvus" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
    await connectionStore.ensureConnected(target.connectionId);
    const tabId = queryStore.createTab(target.connectionId, target.database || "default", tabTitle, "vector");
    queryStore.updateSql(tabId, target.tableName);
    return;
  }
  const tabId = (() => {
    if (settingsStore.editorSettings.reuseDataTab) {
      const existing = queryStore.tabs.find((tab) => tab.mode === "data" && tab.connectionId === target.connectionId && tab.database === target.database && (tab.tableMeta?.catalog || "") === (target.catalog || ""));
      if (existing) {
        existing.title = tabTitle;
        existing.schema = target.schema;
        existing.tableInfoTab = options.tableInfoTab;
        queryStore.switchTab(existing.id);
        return existing.id;
      }
    }
    return queryStore.createTab(target.connectionId, target.database, tabTitle, "data", target.schema);
  })();
  const targetTab = queryStore.tabs.find((tab) => tab.id === tabId);
  if (targetTab) targetTab.tableInfoTab = options.tableInfoTab;
  // Stamp the new table identity synchronously so SQL rebuilds (refresh,
  // filters, row count) never read a stale tableMeta from a reused tab or
  // fall back to parsing the schema-qualified tab title (issue #3613).
  queryStore.setTableMeta(tabId, {
    schema: target.schema,
    catalog: target.catalog,
    database: target.database,
    tableName: target.tableName,
    tableType: target.tableType ?? "TABLE",
    columns: [],
    primaryKeys: [],
  });
  // 占位身份的行标识未知：真实元数据落地（下方 getColumns 成功后的 setTableMeta）
  // 前编辑/保存保持禁用，防止数据查询先返回时整行 WHERE 保存路径短暂可用（#3727）
  if (targetTab) targetTab.tableMetaPending = true;
  // 立即作废旧执行代次：旧导航在途的 executeTabSql 结果按 executionId 比对
  // 落地，仅置 isExecuting 不会替换 executionId，旧结果仍可能写入本 tab。
  // preparationId 同时参与 isCurrentTarget：用户在准备期点击停止会清掉
  // executionId，后续异步返回后不得再启动查询（同 refreshPreparationId 模式）
  const preparationId = uuid();
  queryStore.setExecutingWithId(tabId, preparationId);
  // reuseDataTab 下并发导航会复用同一 tab：每次异步返回后必须校验（1）本次
  // 导航仍是该 tab 的最新代次（区分同表不同 whereInput/连点两次，且侧边栏
  // openData 接管同一 tab 时会作废本代次），（2）tab 未被其他流程改指别的
  // 目标，（3）准备期 executionId 未被停止/接管清除。否则旧请求晚返回会用
  // A 的元数据覆盖新目标 B 的占位并解除 pending，造成结果属于 B、写入目标
  // 却是 A 的错位
  const navigationToken = beginDataTabNavigation(tabId);
  const isCurrentTarget = () =>
    isCurrentDataTabNavigation(tabId, navigationToken) &&
    canApplyDataTabMetadata(
      queryStore.tabs.find((tab) => tab.id === tabId),
      {
        connectionId: target.connectionId,
        database: target.database,
        schema: target.schema,
        catalog: target.catalog,
        tableName: target.tableName,
      },
    );
  // 仅首次 executeTabSql 前有效：executeTabSql 会替换 executionId、完成后清空，
  // 之后的落地点（元数据/fallback）回到 isCurrentTarget 判定。
  // isCancelling 必须同查：停止请求先同步置 isCancelling，等 cancelQuery 返回
  // 才清 executionId——这个窗口内准备流程不得启动查询
  const isPreparationCurrent = () => {
    const currentTab = queryStore.tabs.find((tab) => tab.id === tabId);
    return isCurrentTarget() && currentTab?.executionId === preparationId && !currentTab.isCancelling;
  };
  // 区分外层 catch 的判定：准备期（首次 executeTabSql 前）reject 用
  // isPreparationCurrent——停止/接管后的迟到错误不得写入；首次执行之后
  // preparationId 正常失效，回到 isCurrentTarget，真实错误仍要展示
  let firstExecuteStarted = false;

  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (!isPreparationCurrent()) return;
    if (!config) throw new Error("Connection config not found");
    const effectiveDbType = effectiveDatabaseTypeForConnection(config);
    const identifierQuote = connectionStore.connectionIdentifierQuote?.(target.connectionId);
    const querySchema = metadataSchemaForConnection(config, target.database, target.schema);
    const targetTableType = target.tableType ?? "TABLE";
    if (config.db_type === "neo4j") {
      const columns = await api.getColumns(target.connectionId, target.database, querySchema, target.tableName);
      const primaryKeys = editableRowIdentifierColumns(effectiveDbType, columns, undefined, targetTableType);
      const sql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        identifierQuote,
        schema: target.schema,
        catalog: target.catalog,
        database: target.database,
        tableName: target.tableName,
        tableType: targetTableType,
        columns: columns.map((column) => column.name),
        primaryKeys,
        whereInput: target.whereInput,
        limit: pageLimit,
      });
      if (!isPreparationCurrent()) return;
      queryStore.updateSql(tabId, sql);
      queryStore.setTableMeta(tabId, {
        catalog: target.catalog,
        database: target.database,
        schema: target.schema,
        tableName: target.tableName,
        tableType: targetTableType,
        columns,
        primaryKeys,
      });
      firstExecuteStarted = true;
      await queryStore.executeTabSql(tabId, sql, { pagination: { limit: pageLimit, offset: 0 } });
      return;
    }
    const sql = await buildTableSelectSql({
      databaseType: effectiveDbType,
      identifierQuote,
      schema: target.schema,
      catalog: target.catalog,
      database: target.database,
      tableName: target.tableName,
      tableType: targetTableType,
      whereInput: target.whereInput,
      limit: pageLimit,
    });
    if (!isPreparationCurrent()) return;
    queryStore.updateSql(tabId, sql);
    queryStore.setTableMeta(tabId, {
      schema: target.schema,
      catalog: target.catalog,
      database: target.database,
      tableName: target.tableName,
      tableType: targetTableType,
      columns: [],
      primaryKeys: [],
    });
    firstExecuteStarted = true;
    // 取消计数快照：isCancelling 是瞬态的（取消失败/查询先完成会被清掉），
    // 比对计数才能跨越 executeTabSql 生命周期识别"执行期间用户请求过停止"
    const cancelCountBeforeExecute = queryStore.tabs.find((tab) => tab.id === tabId)?.cancelRequestCount ?? 0;
    await queryStore.executeTabSql(tabId, sql, { pagination: { limit: pageLimit, offset: 0 } });
    if (!isCurrentTarget()) return;
    // 首次查询被停止/失败（executeTabSql 以 Error 结果表达，不抛出）时，
    // 后续不得自动启动第二次查询（synthetic row-id/TDengine 重查）——用户
    // 停止了查询，流程不能替他再跑一次；元数据落地不受影响
    const tabAfterFirstExecute = queryStore.tabs.find((tab) => tab.id === tabId);
    const firstResult = tabAfterFirstExecute?.result;
    const cancelRequestedDuringExecute = (tabAfterFirstExecute?.cancelRequestCount ?? 0) > cancelCountBeforeExecute;
    const firstQueryFailed = cancelRequestedDuringExecute || tabAfterFirstExecute?.isCancelling === true || (firstResult?.columns.length === 1 && firstResult.columns[0] === "Error");
    // executeTabSql surfaces query failures as an "Error" result instead of throwing.
    // A snapshot-less lake table fails the data preview above but its metadata still
    // reads fine — retry with LIMIT 0 so the user sees the table structure (columns +
    // empty grid) rather than a cryptic server error. The flag also skips the
    // synthetic-row-id re-query below, which is another data read that would fail
    // the same way on a snapshot-less table.
    const fellBackToLimitZero = isNoSnapshotErrorResult(queryStore.tabs.find((tab) => tab.id === tabId)?.result);
    if (fellBackToLimitZero) {
      const emptySql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        identifierQuote,
        schema: target.schema,
        catalog: target.catalog,
        database: target.database,
        tableName: target.tableName,
        tableType: targetTableType,
        whereInput: target.whereInput,
        limit: 0,
      });
      if (!isCurrentTarget()) return;
      queryStore.updateSql(tabId, emptySql);
      await queryStore.executeTabSql(tabId, emptySql, { pagination: { limit: pageLimit, offset: 0 } });
      if (!isCurrentTarget()) return;
    }
    try {
      // 复用共享表元数据缓存（30s TTL + in-flight 去重）
      const { metadata } = await loadTableMetadata({
        connectionId: target.connectionId,
        database: target.database,
        schema: querySchema,
        tableName: target.tableName,
        tableType: targetTableType,
        databaseType: effectiveDbType ?? config.db_type,
        driverProfile: config.driver_profile || config.db_type,
        catalog: target.catalog,
      });
      const columns = metadata.columns;
      const primaryKeys = metadata.primaryKeys;
      // 异步窗口内 tab 可能已被复用为其他目标：旧请求的元数据不得落地、
      // 不得解除新目标的 pending
      if (!isCurrentTarget()) return;
      const useRowId = usesSyntheticRowIdKey(effectiveDbType, primaryKeys, targetTableType);
      queryStore.setTableMeta(tabId, {
        schema: target.schema,
        catalog: target.catalog,
        database: target.database,
        tableName: target.tableName,
        tableType: targetTableType,
        columns,
        primaryKeys,
      });
      if (!fellBackToLimitZero && !firstQueryFailed && (useRowId || config.db_type === "tdengine")) {
        const newSql = await buildTableSelectSql({
          databaseType: effectiveDbType,
          identifierQuote,
          schema: target.schema,
          catalog: target.catalog,
          database: target.database,
          tableName: target.tableName,
          tableType: targetTableType,
          whereInput: target.whereInput,
          primaryKeys,
          columns: columns.map((column) => column.name),
          includeRowId: true,
          limit: pageLimit,
        });
        if (!isCurrentTarget()) return;
        queryStore.updateSql(tabId, newSql);
        await queryStore.executeTabSql(tabId, newSql, { pagination: { limit: pageLimit, offset: 0 } });
      }
    } catch (reason) {
      console.error("[DBX] ERROR fetching table metadata:", reason);
    }
  } catch (e: any) {
    if (firstExecuteStarted ? !isCurrentTarget() : !isPreparationCurrent()) return;
    queryStore.setErrorResult(tabId, e);
  } finally {
    endDataTabNavigation(tabId, navigationToken);
  }
}

export function useNavigationTargets(dialogs: { showFieldLineageDialog: { value: boolean }; showDatabaseSearchDialog: { value: boolean }; showDiagramDialog: { value: boolean } }) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  async function openLineageTarget(target: NavigationTarget) {
    dialogs.showFieldLineageDialog.value = false;
    await openTableTarget(target);
  }

  async function openDatabaseSearchTarget(target: NavigationTarget) {
    dialogs.showDatabaseSearchDialog.value = false;
    await openTableTarget(target);
  }

  async function openDiagramTarget(target: NavigationTarget) {
    dialogs.showDiagramDialog.value = false;
    await openTableTarget(target);
  }

  async function onStructureEditorSaved(reloadData: () => Promise<void>, toast: (msg: string, duration?: number) => void, context: { connectionId: string; database: string; schema?: string; tableName: string }, commentChanged?: boolean) {
    if (!context.tableName) {
      try {
        await connectionStore.refreshObjectListTreeNode(context.connectionId, context.database, context.schema || undefined);
      } catch {}
      return;
    }
    if (commentChanged) {
      try {
        await connectionStore.refreshObjectListTreeNode(context.connectionId, context.database, context.schema || undefined);
      } catch {}
    }
    queryStore.invalidateTableStructure(context.connectionId, context.database, context.schema, context.tableName);
    // 结构已变更：无论是否有打开的 data tab 都必须作废共享元数据缓存，否则
    // 其它 loadTableMetadata 消费者最长 30 秒拿到旧列。不带 schema/catalog
    // 维度（宁可多废，schema 形态在各消费点可能不同）
    invalidateTableMetadataCache({ connectionId: context.connectionId, database: context.database, tableName: context.tableName });
    const matchingDataTabs = queryStore.tabs.filter((tab) => tab.mode === "data" && tab.connectionId === context.connectionId && tab.database === context.database && tab.tableMeta?.tableName === context.tableName && (tab.tableMeta.schema || "") === (context.schema || ""));
    // 同一 catalog 只强制加载一次，结果分发给全部匹配 tab
    const loadedByCatalog = new Map<string, { columns: ColumnInfo[]; primaryKeys: string[] }>();
    for (const tab of matchingDataTabs) {
      try {
        const connection = connectionStore.getConfig(tab.connectionId);
        // 捕获不可变目标身份：await 期间 tab 可能被导航复用改指其他表，
        // 共享缓存结果落地前仍必须复核，不能解除新目标的 pending
        const capturedMeta = tab.tableMeta!;
        const capturedTarget = { connectionId: tab.connectionId, database: tab.database, schema: capturedMeta.schema, catalog: capturedMeta.catalog, tableName: capturedMeta.tableName };
        const metadataSchema = metadataSchemaForConnection(connection, tab.database, capturedMeta.schema);
        // 分组含 tableType：主键计算依赖它，不同 tableType 不能共享加载结果
        const catalogKey = `${capturedMeta.catalog ?? ""}\u0000${capturedMeta.tableType ?? ""}`;
        let metadata = loadedByCatalog.get(catalogKey);
        if (!metadata) {
          metadata = (
            await loadTableMetadata({
              connectionId: tab.connectionId,
              database: tab.database,
              schema: metadataSchema,
              tableName: capturedMeta.tableName,
              tableType: capturedMeta.tableType,
              databaseType: effectiveDatabaseTypeForConnection(connection) ?? connection?.db_type ?? "",
              driverProfile: connection?.driver_profile || connection?.db_type,
              catalog: capturedMeta.catalog,
              force: true,
            })
          ).metadata;
          loadedByCatalog.set(catalogKey, metadata);
        }
        const currentTab = queryStore.tabs.find((item) => item.id === tab.id);
        if (!canApplyDataTabMetadata(currentTab, capturedTarget)) continue;
        queryStore.setTableMeta(tab.id, {
          ...capturedMeta,
          columns: metadata.columns,
          primaryKeys: metadata.primaryKeys,
        });
        if (tab.id === queryStore.activeTabId) await reloadData();
      } catch (e: any) {
        toast(e?.message || String(e), 5000);
      }
    }
  }

  return { openLineageTarget, openDatabaseSearchTarget, openDiagramTarget, onStructureEditorSaved, openTableTarget };
}
