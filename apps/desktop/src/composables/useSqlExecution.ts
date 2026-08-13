import { ref, watch, type Ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { supportsConnectionScopedQueryExecution } from "@/lib/database/databaseFeatureSupport";
import { supportsConnectionLevelSqlExecution } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { classifySqlActivityKind } from "@/lib/history/historyActivityKind";
import { sqlMetadataRefreshTarget } from "@/lib/sql/sqlMetadataRefresh";
import { defaultViewForResult } from "@/lib/query/queryResultDefaultView";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";
import { isSqlExecutionSnapshot, resolveExecutableSql, type SqlExecutionOverride, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { isElasticsearchRestRequestText, parseElasticsearchRestRequestTarget, splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { extractSqlParameterDescriptors, type SqlParameterDescriptor, type SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { SqlExecutionDangerRequest } from "@/stores/sqlExecutionDangerStore";
import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";
import type { MultiDbExecutionTarget, MultiDbResultRunExecution, MultiDbTargetExecutionResult } from "@/types/sqlExecution";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { SqlExecutionTargetContext } from "@/lib/database/sqlExecutionTargetRegistry";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

interface SqlExecutionOptions {
  openInNewResultTab?: boolean;
}

interface TargetSqlExecutionInput {
  tab: QueryTab;
  connection: ConnectionConfig;
  sql: string;
  executionTarget?: MultiDbExecutionTarget;
  resultRun?: {
    batchId: string;
    title: string;
    target: MultiDbExecutionTarget;
  };
  sourceOffset?: number;
  blockDangerousRedisCommands?: boolean;
  targetLabel?: string;
  scopeId?: string;
  isCancellationRequested?: () => boolean;
  targetContext?: SqlExecutionTargetContext;
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

const ELASTICSEARCH_TRANSIENT_DELETE_PATHS = [/^\/_search\/scroll\/?$/i, /^\/_pit\/?$/i, /^\/_async_search\/[^/?]+\/?$/i];
const ELASTICSEARCH_DESTRUCTIVE_POST_PATHS = [/(?:^|\/)_(?:delete_by_query|update_by_query|bulk)(?:\/|$)/i, /^\/_reindex(?:\/|$)/i, /^\/_aliases(?:\/|$)/i, /\/_restore(?:\/|$)/i];

function isDangerousElasticsearchRequest(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD", path: string): boolean {
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (method === "DELETE") return !ELASTICSEARCH_TRANSIENT_DELETE_PATHS.some((pattern) => pattern.test(pathname));
  if (method === "PUT" || method === "PATCH") return true;
  return method === "POST" && ELASTICSEARCH_DESTRUCTIVE_POST_PATHS.some((pattern) => pattern.test(pathname));
}

function isDangerousMeilisearchRequest(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD", path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (method === "DELETE" || method === "PUT" || method === "PATCH") return true;
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  return !(pathname === "/multi-search" || /\/search$/i.test(pathname) || /\/facet-search$/i.test(pathname) || /\/similar$/i.test(pathname) || /\/documents\/fetch$/i.test(pathname));
}

export function isDangerousSql(sql: string, databaseType?: DatabaseType): boolean {
  if (databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch") {
    const requests = splitSqlStatementRanges(sql, databaseType)
      .map((statement) => parseElasticsearchRestRequestTarget(statement.sql))
      .filter((request): request is NonNullable<typeof request> => request !== null);
    if (requests.length > 0) {
      return requests.some((request) => (databaseType === "meilisearch" ? isDangerousMeilisearchRequest(request.method, request.path) : isDangerousElasticsearchRequest(request.method, request.path)));
    }
  }
  const cleaned = stripSqlComments(sql);
  return cleaned.split(";").some((stmt) => DANGER_RE.test(stmt));
}

function primarySqlOperation(sql: string): string {
  const cleaned = stripSqlComments(sql);
  const statement = cleaned
    .split(";")
    .map((part) => part.trim())
    .find(Boolean);
  return statement?.match(/^([a-z]+)/i)?.[1]?.toUpperCase() || "SQL";
}

function firstQueryExecutionError(tab: Pick<QueryTab, "result" | "results">) {
  const activeResult = tab.result;
  if (activeResult && isQueryExecutionErrorResult(activeResult)) return activeResult;

  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  return results.find((result) => isQueryExecutionErrorResult(result));
}

export function useSqlExecution(deps: {
  activeTab: ComputedRef<QueryTab | undefined>;
  activeConnection: ComputedRef<ConnectionConfig | undefined>;
  executableSql: ComputedRef<string>;
  resolveExecutableSql?: (snapshot?: SqlExecutionSnapshot) => Promise<string>;
  activeOutputView: Ref<"result" | "summary" | "explain" | "chart" | "messages">;
  blockDangerousRedisCommands?: Ref<boolean>;
  onMissingDatabase?: () => void;
  requestDangerConfirmation?: (request: SqlExecutionDangerRequest) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const queryStore = useQueryStore();
  const historyStore = useHistoryStore();
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  const productionSafetyStore = useProductionSafetyStore();
  const { toast } = useToast();

  const dangerSql = ref("");
  const pendingDangerSql = ref("");
  const showDangerDialog = ref(false);
  const suppressDangerConfirm = ref(false);
  const explainMode = ref<"explain" | "autotrace">("explain");
  const showSqlParameterDialog = ref(false);
  const sqlParameterSourceSql = ref("");
  const sqlParameterNames = ref<SqlParameterDescriptor[]>([]);
  const sqlParameterDatabaseType = ref<DatabaseType | undefined>();
  const sqlParameterEnabledSyntaxes = ref<SqlParameterSyntax[]>([]);
  const pendingSourceOffset = ref<number | undefined>();
  const pendingDangerKind = ref<"sql" | "redis">("sql");
  const pendingDangerSourceOffset = ref<number | undefined>();
  const pendingOpenInNewResultTab = ref(false);
  let pendingSqlParameterContinuation: ((sql: string, sourceOffset?: number) => Promise<void> | void) | undefined;

  async function resolvedExecutableSql(source?: SqlExecutionOverride): Promise<{ sql: string; sourceOffset?: number }> {
    const atSetEnabled = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, deps.activeConnection.value?.db_type).atSet;
    const expand = (sql: string) => (atSetEnabled ? expandSqlVariables(sql).sql : sql);
    if (typeof source === "string") return { sql: expand(source) };

    const resolved = deps.resolveExecutableSql ? await deps.resolveExecutableSql(source) : isSqlExecutionSnapshot(source) ? resolveExecutableSql(source.fullSql, source.selectedSql, { cursorPos: source.cursorPos }) : deps.executableSql.value;
    const sql = expand(resolved);
    if (!isSqlExecutionSnapshot(source) || !source.selectedSql.trim() || sql !== resolved) return { sql };

    const leadingWhitespace = source.selectedSql.length - source.selectedSql.trimStart().length;
    return { sql, sourceOffset: source.selectionFrom + leadingWhitespace };
  }

  async function tryExecute(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {}) {
    const tab = deps.activeTab.value;
    const { sql, sourceOffset } = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) return;
    if (requiresDatabaseSelection(tab, deps.activeConnection.value, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    if (supportsSqlTemplateParameters(deps.activeConnection.value, sql) && prepareSqlParameterDialog(sql, sourceOffset, options)) return;
    await continueExecute(sql, sourceOffset, options);
  }

  function tryExecuteInNewResultTab(sqlOverride?: SqlExecutionOverride) {
    return tryExecute(sqlOverride, { openInNewResultTab: true });
  }

  async function continueExecute(sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}) {
    // Redis: block dangerous commands when toggle is on (scan entire batch for highest safety level)
    if (deps.activeConnection.value?.db_type === "redis" && deps.blockDangerousRedisCommands?.value !== false) {
      const commands = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      let highestSafety: "allowed" | "write" | "confirm" | "blocked" = "allowed";
      for (const cmd of commands) {
        const safety = classifyRedisCommandSafety(cmd);
        if (safety === "blocked") {
          highestSafety = "blocked";
          break;
        }
        if (safety === "confirm") {
          highestSafety = "confirm";
        }
      }
      if (highestSafety === "blocked") {
        toast(t("redis.blockedCommand", { command: "Redis" }), 5000);
        return;
      }
      if (highestSafety === "confirm") {
        dangerSql.value = sql;
        pendingDangerSql.value = sql;
        pendingDangerKind.value = "redis";
        pendingDangerSourceOffset.value = sourceOffset;
        pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
        suppressDangerConfirm.value = false;
        showDangerDialog.value = true;
        return;
      }
    }
    const productionAssessment = assessProductionSql(sql, deps.activeConnection.value, deps.activeTab.value?.database);
    if (productionAssessment.active && productionAssessment.isMutation) {
      // Production writes always need a new explicit decision; editor preferences cannot suppress this gate.
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql,
        connectionName: deps.activeConnection.value?.name,
        database: deps.activeTab.value?.database,
        productionDatabases: productionAssessment.databases,
        source: t("production.sourceSqlEditor"),
      });
      if (confirmed) await doExecute(sql, sourceOffset, options);
      return;
    }
    if (isDangerousSql(sql, deps.activeConnection.value?.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      dangerSql.value = sql;
      pendingDangerSql.value = sql;
      pendingDangerKind.value = "sql";
      pendingDangerSourceOffset.value = sourceOffset;
      pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
      suppressDangerConfirm.value = false;
      showDangerDialog.value = true;
    } else {
      await doExecute(sql, sourceOffset, options);
    }
  }

  function prepareSqlParameterDialog(sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}, continuation?: (sql: string, sourceOffset?: number) => Promise<void> | void): boolean {
    const databaseType = deps.activeConnection.value?.db_type;
    const toggles = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, databaseType);
    const enabledSyntaxes = enabledSqlParameterSyntaxes(toggles);
    const parameters = extractSqlParameterDescriptors(sql, { databaseType, enabledSyntaxes });
    if (!parameters.length) return false;
    sqlParameterSourceSql.value = sql;
    sqlParameterNames.value = parameters;
    sqlParameterDatabaseType.value = databaseType;
    sqlParameterEnabledSyntaxes.value = enabledSyntaxes;
    pendingSourceOffset.value = sourceOffset;
    pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
    pendingSqlParameterContinuation = continuation;
    showSqlParameterDialog.value = true;
    return true;
  }

  async function prepareMultiExecute(onReady: (sql: string, sourceOffset?: number) => Promise<void> | void): Promise<boolean> {
    const tab = deps.activeTab.value;
    const { sql, sourceOffset } = await resolvedExecutableSql();
    if (!tab || !sql.trim()) return false;
    if (supportsSqlTemplateParameters(deps.activeConnection.value, sql) && prepareSqlParameterDialog(sql, sourceOffset, {}, onReady)) return true;
    await onReady(sql, sourceOffset);
    return false;
  }

  async function doExecute(sql?: string, sourceOffset?: number, options: SqlExecutionOptions = {}) {
    if (sql === undefined) ({ sql, sourceOffset } = await resolvedExecutableSql());
    const tab = deps.activeTab.value;
    if (!tab || !sql.trim()) return;
    const executionConnection = connectionStore.getConfig(tab.connectionId) ?? deps.activeConnection.value;
    const executionDatabaseType = executionConnection?.db_type;
    if (requiresDatabaseSelection(tab, executionConnection, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    const statementCount = splitSqlStatementRanges(sql, executionDatabaseType).length;
    deps.activeOutputView.value = statementCount > 1 ? "summary" : "result";
    const connName = executionConnection?.name || "";
    const start = Date.now();
    const isRedis = executionDatabaseType === "redis";
    const producedResult = await queryStore.executeCurrentSql(sql, {
      ...(isRedis ? { skipRedisSafetyCheck: deps.blockDangerousRedisCommands?.value === false } : {}),
      ...(sourceOffset !== undefined ? { sourceOffset } : {}),
      ...(options.openInNewResultTab ? { openInNewResultTab: true } : {}),
    });
    if (producedResult === false) return;
    const sqlServerMessageResultIndex = executionDatabaseType === "sqlserver" ? tab.results?.findIndex((result) => result.server_message === true) : undefined;
    const activeSqlServerResult = tab.results && tab.activeResultIndex !== undefined ? tab.results[tab.activeResultIndex] : tab.result;
    if (sqlServerMessageResultIndex !== undefined && sqlServerMessageResultIndex >= 0) {
      if (activeSqlServerResult?.server_message === true) {
        const sqlServerDataResultIndex = tab.results?.findIndex((result) => result.server_message !== true && !isQueryExecutionErrorResult(result) && result.columns.length > 0);
        if (sqlServerDataResultIndex !== undefined && sqlServerDataResultIndex >= 0) queryStore.setActiveResultIndex(tab.id, sqlServerDataResultIndex);
        else queryStore.setActiveResultIndex(tab.id, sqlServerMessageResultIndex);
      }
      deps.activeOutputView.value = "result";
    } else if (executionDatabaseType === "sqlserver" && tab.result?.server_message === true) {
      deps.activeOutputView.value = "result";
    } else if (tab.result && !tab.result.columns.length && !tab.results?.some((result) => result.columns.length > 0)) {
      deps.activeOutputView.value = statementCount === 1 ? defaultViewForResult(tab.result) : "summary";
    }
    const elapsed = Date.now() - start;
    const failure = firstQueryExecutionError(tab);
    const success = !failure;
    historyStore.add({
      connection_id: tab.connectionId,
      connection_name: connName,
      database: tab.database,
      sql,
      execution_time_ms: elapsed,
      success,
      error: failure ? String(failure.rows?.[0]?.[0] ?? "") : undefined,
      activity_kind: classifySqlActivityKind(sql),
      operation: primarySqlOperation(sql),
      affected_rows: success ? tab.result?.affected_rows : undefined,
    });
    if (success) {
      const refreshTarget = sqlMetadataRefreshTarget(sql, tab.schema);
      if (refreshTarget.scope === "connection") {
        await connectionStore.loadDatabases(tab.connectionId, { force: true });
      } else if (refreshTarget.scope === "database") {
        await connectionStore.refreshObjectListTreeNode(tab.connectionId, tab.database, refreshTarget.schema);
      }
    }
  }

  async function executeTargetSql(input: TargetSqlExecutionInput): Promise<MultiDbTargetExecutionResult> {
    const { tab, connection, sql, sourceOffset, targetLabel } = input;
    const startedAt = Date.now();
    const executionTab = input.executionTarget
      ? {
          ...tab,
          connectionId: input.executionTarget.connectionId,
          catalog: input.executionTarget.catalog,
          database: input.executionTarget.database,
          schema: input.executionTarget.schema,
        }
      : tab;
    const finish = (result: MultiDbTargetExecutionResult): MultiDbTargetExecutionResult => ({
      ...result,
      durationMs: Date.now() - startedAt,
    });
    const cancelRequested = () => input.isCancellationRequested?.() === true;
    const tabCancelRequested = (count: number) => (tab.cancelRequestCount ?? 0) !== count;
    if (cancelRequested()) return finish({ status: "cancelled" });
    if (!sql.trim()) return finish({ status: "failed", errorMessage: t("explain.emptySql") });
    if (requiresDatabaseSelection(executionTab, connection, sql)) {
      return finish({ status: "failed", errorMessage: t("editor.selectDatabaseRequired") });
    }

    const blockRedisCommands = input.blockDangerousRedisCommands !== false;
    if (connection.db_type === "redis" && blockRedisCommands) {
      const commands = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      let highestSafety: "allowed" | "confirm" | "blocked" = "allowed";
      for (const command of commands) {
        const safety = classifyRedisCommandSafety(command);
        if (safety === "blocked") {
          highestSafety = "blocked";
          break;
        }
        if (safety === "confirm") highestSafety = "confirm";
      }
      if (highestSafety === "blocked") {
        return finish({ status: "skipped", errorMessage: t("redis.blockedCommand", { command: "Redis" }) });
      }
      if (highestSafety === "confirm") {
        const confirmed = await deps.requestDangerConfirmation?.({
          sql,
          kind: "redis",
          connectionName: connection.name,
          database: executionTab.database,
          targetLabel,
          databaseType: connection.db_type,
          scopeId: input.scopeId,
        });
        if (cancelRequested()) return finish({ status: "cancelled" });
        if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
      }
    }

    const productionAssessment = assessProductionSql(sql, connection, executionTab.database);
    if (productionAssessment.active && productionAssessment.isMutation) {
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql,
        connectionName: connection.name,
        database: executionTab.database,
        productionDatabases: productionAssessment.databases,
        source: t("production.sourceMultiDbSql"),
        scopeId: input.scopeId,
      });
      if (cancelRequested()) return finish({ status: "cancelled" });
      if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
    }

    if (isDangerousSql(sql, connection.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      const confirmed = await deps.requestDangerConfirmation?.({
        sql,
        kind: "sql",
        connectionName: connection.name,
        database: executionTab.database,
        targetLabel,
        databaseType: connection.db_type,
        scopeId: input.scopeId,
      });
      if (cancelRequested()) return finish({ status: "cancelled" });
      if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
    }

    if (cancelRequested()) return finish({ status: "cancelled" });
    const cancelRequestCount = tab.cancelRequestCount ?? 0;
    const workerId = input.executionTarget ? queryStore.createMultiDbExecutionWorker(tab.id, input.executionTarget, input.scopeId ?? "") : undefined;
    if (input.executionTarget && !workerId) return finish({ status: "failed", errorMessage: t("multiDbExecute.targetMissingConnection") });
    const executionTabId = workerId ?? tab.id;
    const captureWorkerResult = (status: MultiDbResultRunExecution["status"], errorMessage?: string): string | undefined => {
      if (!workerId || !input.resultRun) return undefined;
      return queryStore.captureMultiDbExecutionWorkerResult(tab.id, workerId, sql, {
        kind: "multi-db",
        batchId: input.resultRun.batchId,
        target: input.resultRun.target,
        title: input.resultRun.title,
        status,
        durationMs: Date.now() - startedAt,
        errorMessage,
      });
    };
    try {
      await queryStore.executeTabSql(executionTabId, sql, {
        resultBaseSql: sql,
        ...(input.targetContext ? { targetContext: input.targetContext } : {}),
        ...(sourceOffset !== undefined ? { sourceOffset } : {}),
        ...(connection.db_type === "redis" ? { skipRedisSafetyCheck: !blockRedisCommands } : {}),
      });
      const latest = queryStore.getExecutionTab(executionTabId) ?? tab;
      if (cancelRequested() || tabCancelRequested(cancelRequestCount)) {
        return finish({ status: "cancelled" });
      }
      const failure = firstQueryExecutionError(latest);
      const errorMessage = failure ? String(failure.rows?.[0]?.[0] ?? t("common.failed")) : undefined;
      const success = !failure;
      const resultStatus = success ? "success" : "failed";
      captureWorkerResult(resultStatus, errorMessage);
      historyStore.add({
        connection_id: executionTab.connectionId,
        connection_name: connection.name || "",
        database: executionTab.database,
        sql,
        execution_time_ms: Date.now() - startedAt,
        success,
        error: errorMessage,
        activity_kind: classifySqlActivityKind(sql),
        operation: primarySqlOperation(sql),
        affected_rows: success ? latest.result?.affected_rows : undefined,
      });
      if (success) {
        const refreshTarget = sqlMetadataRefreshTarget(sql, executionTab.schema);
        if (refreshTarget.scope === "connection") {
          await connectionStore.loadDatabases(executionTab.connectionId, { force: true });
        } else if (refreshTarget.scope === "database") {
          await connectionStore.refreshObjectListTreeNode(executionTab.connectionId, executionTab.database, refreshTarget.schema);
        }
      }
      // 多库 worker 路径（workerId 存在）下不切主编辑器输出视图：并行 Promise.all
      // 会让多个 worker 几乎同时改这个共享 ref，导致主视图在 result/summary 间反复
      // 跳动（闪烁/竞态）。worker 结果已由 captureMultiDbExecutionWorkerResult 记录
      // 到 source tab 的 result run 并通过 projectResultRun 投影显示，无需再切主视图。
      if (!workerId) {
        deps.activeOutputView.value = success && (latest.result?.columns.length || latest.results?.some((result) => result.columns.length)) ? "result" : "summary";
      }
      return finish(success ? { status: "success", errorMessage } : { status: "failed", errorMessage });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      captureWorkerResult("failed", errorMessage);
      return finish({ status: "failed", errorMessage });
    } finally {
      if (workerId) await queryStore.removeMultiDbExecutionWorker(workerId, input.scopeId);
    }
  }

  function cancelActiveExecution() {
    const tab = deps.activeTab.value;
    if (!tab) return;
    if (tab.isExecuting) void queryStore.cancelTabExecution(tab.id);
    else if (tab.isExplaining) void queryStore.cancelTabExplain(tab.id);
  }

  function explainReasonMessage(reason: string): string {
    if (reason === "unsupported") return t("explain.unsupported");
    if (reason === "unsafe") return t("explain.unsafe");
    return t("explain.emptySql");
  }

  async function tryExplain(sqlOverride?: SqlExecutionOverride) {
    const tab = deps.activeTab.value;
    const { sql } = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) {
      toast(t("explain.emptySql"));
      return;
    }

    deps.activeOutputView.value = "explain";
    const connection = deps.activeConnection.value;
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection?.db_type;
    const result = await queryStore.explainTabSql(tab.id, sql, databaseType, explainMode.value);
    if (!result.ok) {
      toast(explainReasonMessage(result.reason), 5000);
      return;
    }

    const current = deps.activeTab.value;
    if (current?.explainError) toast(current.explainError, 5000);
  }

  async function onDangerConfirm() {
    const sql = pendingDangerSql.value;
    const sourceOffset = pendingDangerSourceOffset.value;
    const kind = pendingDangerKind.value;
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    pendingOpenInNewResultTab.value = false;
    if (suppressDangerConfirm.value && kind === "sql") {
      settingsStore.updateEditorSettings({ confirmDangerousSqlExecution: false });
    }
    suppressDangerConfirm.value = false;
    await doExecute(sql, sourceOffset, { openInNewResultTab });
  }

  async function onSqlParametersConfirm(sql: string) {
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    showSqlParameterDialog.value = false;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    const sourceOffset = pendingSourceOffset.value;
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    const continuation = pendingSqlParameterContinuation;
    pendingSqlParameterContinuation = undefined;
    if (continuation) await continuation(sql, sourceOffset);
    else await continueExecute(sql, sourceOffset, { openInNewResultTab });
  }

  watch(showSqlParameterDialog, (open) => {
    if (open) return;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    pendingSqlParameterContinuation = undefined;
  });

  watch(showDangerDialog, (open) => {
    if (open) return;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    pendingOpenInNewResultTab.value = false;
    suppressDangerConfirm.value = false;
  });

  return {
    dangerSql,
    pendingDangerSql,
    showDangerDialog,
    suppressDangerConfirm,
    tryExecute,
    tryExecuteInNewResultTab,
    doExecute,
    cancelActiveExecution,
    tryExplain,
    onDangerConfirm,
    showSqlParameterDialog,
    sqlParameterSourceSql,
    sqlParameterNames,
    sqlParameterDatabaseType,
    sqlParameterEnabledSyntaxes,
    onSqlParametersConfirm,
    prepareMultiExecute,
    executeTargetSql,
    explainMode,
  };
}

export function supportsSqlTemplateParameters(connection: Pick<ConnectionConfig, "db_type"> | undefined, sql = ""): boolean {
  if (!connection) return false;
  if (connection.db_type === "meilisearch") return false;
  if (connection.db_type === "elasticsearch" || connection.db_type === "easysearch") return !isElasticsearchRestRequestText(sql);
  return connection.db_type !== "redis" && connection.db_type !== "mongodb" && connection.db_type !== "victoriametrics";
}

export function requiresDatabaseSelection(tab: QueryTab, connection: ConnectionConfig | undefined, _sql = ""): boolean {
  if (tab.mode !== "query") return false;
  if (!connection) return false;
  const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
  if (tab.database) return false;
  if (tab.database === "" && usesTreeSchemaMode(databaseType)) return false;
  if (isSingleDatabase(databaseType)) return false;
  // MySQL-compatible servers decide per statement whether a default database is required.
  // Keep interactive execution connection-scoped instead of rejecting valid qualified or constant queries.
  if (supportsConnectionLevelSqlExecution(connection)) return false;
  return !supportsConnectionScopedQueryExecution(databaseType);
}
