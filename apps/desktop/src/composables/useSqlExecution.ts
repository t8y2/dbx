import { ref, watch, type Ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { supportsConnectionScopedQueryExecution } from "@/lib/database/databaseFeatureSupport";
import { supportsTransaction } from "@/lib/database/databaseFeatureSupport";
import * as api from "@/lib/backend/api";
import { agentProtocolQueryResultMaxRows, effectiveQueryResultMaxRows } from "@/lib/dataGrid/queryResultRowLimit";
import { supportsConnectionLevelSqlExecution } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { classifySqlActivityKind } from "@/lib/history/historyActivityKind";
import { sqlMetadataRefreshTarget } from "@/lib/sql/sqlMetadataRefresh";
import { invalidateObjectMetadataCache } from "@/lib/metadata/objectMetadataCache";
import { defaultViewForResult, statementRunsWithoutResultGrid } from "@/lib/query/queryResultDefaultView";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";
import { isRedisCommentLine } from "@/lib/redis/redisCommandTokenizer";
import { isDangerousSolrRequest } from "@/lib/solr/solrRequestRisk";
import { isDangerousCouchDbRequest } from "@/lib/couchdb/couchdbRequestRisk";
import { isSqlExecutionSnapshot, resolveExecutableSql, type SqlExecutionOverride, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { isElasticsearchRestRequestText, parseElasticsearchRestRequestTarget, splitSqlStatementRanges, sqlStatementParameterOptionsForCompatibility } from "@/lib/sql/sqlStatementRanges";
import { extractSqlParameterDescriptors, type SqlParameterDescriptor, type SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import { mysqlDataCharsetEnabled } from "@/lib/connection/mysqlDataCharset";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { SqlExecutionDangerRequest } from "@/stores/sqlExecutionDangerStore";
import type { ConnectionConfig, DatabaseType, QueryResult, QueryTab } from "@/types/database";
import type { MultiDbExecutionTarget, MultiDbResultRunExecution, MultiDbTargetExecutionResult, MultiDbManualTransaction } from "@/types/sqlExecution";
import { effectiveDatabaseTypeForConnection, kingbaseSqlDatabaseType } from "@/lib/database/jdbcDialect";
import { oracleTriggerReadOptions } from "@/lib/database/oracleTriggerIdentity";
import type { SqlExecutionTargetContext } from "@/lib/database/sqlExecutionTargetRegistry";
import { MULTI_SOURCE_MAX_ROWS_PER_SOURCE } from "@/lib/query/multiSourceResult";
import { translateBackendError } from "@/i18n/backend-errors";
import type { SqlExecutionDeferredReason, SqlExecutionNotStartedReason, SqlExecutionOutcome } from "@/lib/sql/sqlExecutionOutcome";
import { isObjectDependencySection } from "@/lib/database/objectDependencyDetails";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

interface SqlExecutionOptions {
  openInNewResultTab?: boolean;
  editorViewportRequestId?: number;
  /** Tab that owns this execution request; resolved once, never re-read from the global active tab. */
  tabId?: string;
}

/**
 * Targeting context captured synchronously when an execution request starts.
 * Async resume points (danger / parameter dialogs, awaits) must keep using it
 * instead of re-reading the global active tab or active connection.
 */
interface SqlExecutionContext {
  tabId: string;
  connection: ConnectionConfig | undefined;
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
  /** Labels of every target in the batch, shown in the confirmation prompt. */
  batchTargetLabels?: string[];
  scopeId?: string;
  isCancellationRequested?: () => boolean;
  targetContext?: SqlExecutionTargetContext;
  manualTransaction?: boolean;
}

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

/**
 * Detached copy of a result for the merged multi-source view.
 *
 * The store releases a result payload by clearing its columns/rows *in place*
 * (see `releaseResultObjectPayload`) as soon as the run loses focus, and a
 * multi-db worker's tab is removed right after it finishes. Holding the live
 * result would therefore let the merged view lose earlier sources, so the
 * arrays it reads are detached here (cells themselves are never mutated).
 */
export function snapshotResultForMerge(result: QueryResult | undefined): QueryResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    columns: [...result.columns],
    rows: result.rows.slice(),
    column_types: result.column_types ? [...result.column_types] : undefined,
    local_column_filters: undefined,
    local_hidden_column_keys: undefined,
  };
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
  if (databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch" || databaseType === "solr" || databaseType === "couchdb") {
    const requests = splitSqlStatementRanges(sql, databaseType)
      .map((statement) => parseElasticsearchRestRequestTarget(statement.sql))
      .filter((request): request is NonNullable<typeof request> => request !== null);
    if (requests.length > 0) {
      return requests.some((request) =>
        databaseType === "meilisearch"
          ? isDangerousMeilisearchRequest(request.method, request.path)
          : databaseType === "solr"
            ? isDangerousSolrRequest(request.method, request.path)
            : databaseType === "couchdb"
              ? isDangerousCouchDbRequest(request.method, request.path)
              : isDangerousElasticsearchRequest(request.method, request.path),
      );
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
  resolveExecutableSql?: (snapshot?: SqlExecutionSnapshot, tab?: QueryTab) => Promise<string>;
  activeOutputView: Ref<"result" | "graph" | "summary" | "explain" | "chart" | "messages" | "profile">;
  blockDangerousRedisCommands?: Ref<boolean>;
  onMissingConnection?: (tabId?: string) => void;
  onMissingDatabase?: (tabId?: string) => void;
  requestDangerConfirmation?: (request: SqlExecutionDangerRequest) => Promise<boolean>;
  onExecutionStarted?: (editorViewportRequestId: number) => void;
  onExecutionCancelled?: (editorViewportRequestId: number) => void;
  /**
   * Terminal outcome of an execution a dialog parked (#11962). Such a request
   * leaves `tryExecute` as `{ status: "deferred" }` when the dialog opens, so this
   * is the only place its real result arrives: accepted → the execution outcome,
   * dismissed → `not-started`. Hosts that do not track the request ignore it.
   */
  onDeferredExecutionSettled?: (outcome: SqlExecutionOutcome) => void;
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
  const pendingSqlParameterEditorViewportRequestId = ref<number | undefined>();
  const pendingDangerEditorViewportRequestId = ref<number | undefined>();
  const pendingDangerTabId = ref<string | undefined>();
  const pendingSqlParameterTabId = ref<string | undefined>();
  let pendingSqlParameterContinuation: ((sql: string, sourceOffset?: number) => Promise<void> | void) | undefined;

  function cancelEditorViewportRequest(editorViewportRequestId?: number) {
    if (editorViewportRequestId !== undefined) deps.onExecutionCancelled?.(editorViewportRequestId);
  }

  function resolveExecutionTab(tabId: string | undefined): QueryTab | undefined {
    if (!tabId) {
      return deps.activeTab.value;
    }
    const fromStore = queryStore.tabs.find((tab) => tab.id === tabId);
    if (fromStore) {
      return fromStore;
    }
    // The host may hold the acting tab outside the store array (multi-db
    // workers, hosts under test); identity still comes from the captured id.
    return deps.activeTab.value?.id === tabId ? deps.activeTab.value : undefined;
  }

  function updateExecutionTabUiState(tab: QueryTab, patch: Partial<NonNullable<QueryTab["uiState"]>>) {
    queryStore.updateTabUiState(tab.id, patch);
    if (!queryStore.tabs.some((candidate) => candidate.id === tab.id)) {
      tab.uiState = { ...tab.uiState, ...patch };
    }
  }

  function resolveExecutionConnection(tabId: string | undefined): ConnectionConfig | undefined {
    const tab = resolveExecutionTab(tabId);
    if (tab) {
      if (!tab.connectionId) return undefined;
      return connectionStore.getConfig(tab.connectionId) ?? (tab.connectionId === deps.activeConnection.value?.id ? deps.activeConnection.value : undefined);
    }
    return deps.activeConnection.value;
  }

  function captureExecutionContext(tabId?: string): SqlExecutionContext | undefined {
    const tab = resolveExecutionTab(tabId);
    if (!tab) {
      return undefined;
    }
    return { tabId: tab.id, connection: resolveExecutionConnection(tabId) };
  }

  async function resolvedExecutableSql(source: SqlExecutionOverride | undefined, context: SqlExecutionContext): Promise<{ sql: string; sourceOffset?: number; editorViewportRequestId?: number }> {
    const atSetEnabled = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, context.connection?.db_type, settingsStore.editorSettings.sqlVariableSubstitutionEnabled).atSet;
    const databaseType = kingbaseSqlDatabaseType(context.connection) ?? effectiveDatabaseTypeForConnection(context.connection) ?? context.connection?.db_type;
    const expand = (sql: string, declarationSql?: string) => (atSetEnabled ? expandSqlVariables(sql, { declarationSql, databaseType }).sql : sql);
    if (typeof source === "string") return { sql: expand(source) };

    const resolved = deps.resolveExecutableSql ? await deps.resolveExecutableSql(source, resolveExecutionTab(context.tabId)) : isSqlExecutionSnapshot(source) ? resolveExecutableSql(source.fullSql, source.selectedSql, { cursorPos: source.cursorPos }) : deps.executableSql.value;
    const declarationSql = isSqlExecutionSnapshot(source) ? source.fullSql.slice(0, source.selectionTo) : resolved;
    const sql = expand(resolved, declarationSql);
    const editorViewportRequestId = isSqlExecutionSnapshot(source) ? source.editorViewportRequestId : undefined;
    if (!isSqlExecutionSnapshot(source) || !source.selectedSql.trim() || sql !== resolved) return { sql, editorViewportRequestId };

    const leadingWhitespace = source.selectedSql.length - source.selectedSql.trimStart().length;
    return { sql, sourceOffset: source.selectionFrom + leadingWhitespace, editorViewportRequestId };
  }

  /**
   * Every early return reports *why* it stopped (#11962). The editor path
   * ignores this value, but the AI panel needs it: the target tab may not be on
   * screen, so a silent return there leaves the user with no feedback at all.
   */
  function notStarted(reason: SqlExecutionNotStartedReason, tabId?: string): SqlExecutionOutcome {
    return { status: "not-started", reason, ...(tabId ? { tabId } : {}) };
  }

  function deferred(reason: SqlExecutionDeferredReason, tabId: string): SqlExecutionOutcome {
    return { status: "deferred", reason, tabId };
  }

  /**
   * Report for the execution a dialog parked (#11962). `tryExecute` returned
   * `deferred` when it opened the dialog, so the caller that needs the real
   * outcome — the AI panel — is told here instead: once the user answers, and with
   * whatever the resumed execution produced. Editor-initiated executions reach this
   * too; they simply have no listener registered for them.
   */
  function reportDeferredExecution(outcome: SqlExecutionOutcome) {
    deps.onDeferredExecutionSettled?.(outcome);
  }

  /** A resumed confirmation must settle its AI request even when execution throws. */
  function reportDeferredExecutionFailure(error: unknown, tabId: string) {
    reportDeferredExecution({ status: "started", ok: false, errorMessage: translateBackendError(t, error), tabId });
  }

  async function tryExecute(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {}): Promise<SqlExecutionOutcome> {
    const sourceTab = resolveExecutionTab(options.tabId);
    if (sourceTab && isObjectDependencySection(sourceTab)) {
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("blocked", sourceTab.id);
    }
    const context = captureExecutionContext(options.tabId);
    if (!context) {
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("no-tab", options.tabId);
    }
    const { sql, sourceOffset, editorViewportRequestId: snapshotRequestId } = await resolvedExecutableSql(sqlOverride, context);
    const editorViewportRequestId = snapshotRequestId ?? options.editorViewportRequestId;
    const executionOptions = { ...options, editorViewportRequestId, tabId: context.tabId };
    if (!sql.trim()) {
      cancelEditorViewportRequest(editorViewportRequestId);
      return notStarted("empty-sql", context.tabId);
    }
    const tab = resolveExecutionTab(context.tabId);
    if (!tab) {
      cancelEditorViewportRequest(editorViewportRequestId);
      return notStarted("no-tab", context.tabId);
    }
    if (tab.isExecuting) {
      cancelEditorViewportRequest(editorViewportRequestId);
      return notStarted("busy", context.tabId);
    }
    if (requiresConnectionSelection(tab, context.connection)) {
      deps.onMissingConnection?.(context.tabId);
      cancelEditorViewportRequest(editorViewportRequestId);
      return notStarted("no-connection", context.tabId);
    }
    if (requiresDatabaseSelection(tab, context.connection, sql)) {
      deps.onMissingDatabase?.(context.tabId);
      cancelEditorViewportRequest(editorViewportRequestId);
      return notStarted("missing-database", context.tabId);
    }
    if (tab.objectSource?.objectType === "TRIGGER" && oracleTriggerReadOptions(effectiveDatabaseTypeForConnection(context.connection))) {
      const previousResult = queryStore.oracleTriggerSourceState(tab.id)?.result;
      const ok = await queryStore.runOracleTriggerSourceAction(tab.id, "replace", sql);
      cancelEditorViewportRequest(editorViewportRequestId);
      const state = queryStore.oracleTriggerSourceState(tab.id);
      return ok || (state?.result !== previousResult && state?.result?.steps.some((step) => step.receipt !== undefined)) ? { status: "started", ok, tabId: tab.id, errorMessage: state?.error } : notStarted("blocked", tab.id);
    }
    if (supportsSqlTemplateParameters(context.connection, sql) && prepareSqlParameterDialog(sql, sourceOffset, executionOptions)) {
      return deferred("parameters", context.tabId);
    }
    return continueExecute(context, sql, sourceOffset, executionOptions);
  }

  function tryExecuteInNewResultTab(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {}) {
    return tryExecute(sqlOverride, { ...options, openInNewResultTab: true });
  }

  async function continueExecute(context: SqlExecutionContext, sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}): Promise<SqlExecutionOutcome> {
    const tab = resolveExecutionTab(context.tabId);
    if (!tab) {
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("no-tab", context.tabId);
    }
    if (!(await ensureReadOnlyWriteAccess({ connection: context.connection, sql, source: t("production.sourceSqlEditor") }))) {
      // Compatibility denial is a policy block; ordinary unlock dismissal
      // remains cancellation. The shared guard owns the denial notification.
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted(mysqlDataCharsetEnabled(context.connection) ? "blocked" : "cancelled", context.tabId);
    }
    // Redis: block dangerous commands when toggle is on (scan entire batch for highest safety level)
    if (context.connection?.db_type === "redis" && deps.blockDangerousRedisCommands?.value !== false) {
      const commands = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isRedisCommentLine(line));
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
        cancelEditorViewportRequest(options.editorViewportRequestId);
        return notStarted("blocked", context.tabId);
      }
      if (highestSafety === "confirm") {
        dangerSql.value = sql;
        pendingDangerSql.value = sql;
        pendingDangerKind.value = "redis";
        pendingDangerSourceOffset.value = sourceOffset;
        pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
        pendingDangerEditorViewportRequestId.value = options.editorViewportRequestId;
        pendingDangerTabId.value = context.tabId;
        suppressDangerConfirm.value = false;
        showDangerDialog.value = true;
        // Parked on the Redis confirmation, not finished: `onDangerConfirm` reports
        // the real outcome.
        return deferred("redis-confirm", context.tabId);
      }
    }
    const productionAssessment = assessProductionSql(sql, context.connection, tab.database);
    if (productionAssessment.active && productionAssessment.isMutation) {
      // Production writes always need a new explicit decision; editor preferences cannot suppress this gate.
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql,
        connectionName: context.connection?.name,
        database: tab.database,
        productionDatabases: productionAssessment.databases,
        source: t("production.sourceSqlEditor"),
      });
      if (confirmed) {
        return doExecute(sql, sourceOffset, options);
      }
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("cancelled", context.tabId);
    }
    if (isDangerousSql(sql, context.connection?.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      dangerSql.value = sql;
      pendingDangerSql.value = sql;
      pendingDangerKind.value = "sql";
      pendingDangerSourceOffset.value = sourceOffset;
      pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
      pendingDangerEditorViewportRequestId.value = options.editorViewportRequestId;
      pendingDangerTabId.value = context.tabId;
      suppressDangerConfirm.value = false;
      showDangerDialog.value = true;
      // Parked on the danger confirmation; `onDangerConfirm` reports the outcome.
      return deferred("danger", context.tabId);
    }
    return doExecute(sql, sourceOffset, options);
  }

  function prepareSqlParameterDialog(sql: string, sourceOffset?: number, options: SqlExecutionOptions = {}, continuation?: (sql: string, sourceOffset?: number) => Promise<void> | void): boolean {
    const connection = resolveExecutionConnection(options.tabId);
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection?.db_type;
    const tab = resolveExecutionTab(options.tabId);
    const compatibilityMode = databaseType === "opengauss" ? (tab ? connectionStore.databaseCompatibilityMode(tab.connectionId, tab.database) : undefined) : databaseType === "kingbase" ? connection?.database_info?.compatibilityMode : undefined;
    const toggles = resolveSqlVariableSyntaxToggles(settingsStore.editorSettings.sqlVariableSyntaxOverrides, databaseType, settingsStore.editorSettings.sqlVariableSubstitutionEnabled, compatibilityMode);
    const enabledSyntaxes = enabledSqlParameterSyntaxes(toggles);
    const parameterDatabaseType = kingbaseSqlDatabaseType(connection) ?? databaseType;
    const parameters = extractSqlParameterDescriptors(sql, { databaseType: parameterDatabaseType, compatibilityMode, enabledSyntaxes });
    if (!parameters.length) {
      return false;
    }
    sqlParameterSourceSql.value = sql;
    sqlParameterNames.value = parameters;
    sqlParameterDatabaseType.value = parameterDatabaseType;
    sqlParameterEnabledSyntaxes.value = enabledSyntaxes;
    pendingSourceOffset.value = sourceOffset;
    pendingOpenInNewResultTab.value = options.openInNewResultTab === true;
    pendingSqlParameterEditorViewportRequestId.value = options.editorViewportRequestId;
    pendingSqlParameterTabId.value = options.tabId;
    pendingSqlParameterContinuation = continuation;
    showSqlParameterDialog.value = true;
    return true;
  }

  async function prepareMultiExecute(onReady: (sql: string, sourceOffset?: number) => Promise<void> | void): Promise<boolean> {
    const context = captureExecutionContext();
    if (!context) {
      return false;
    }
    const { sql, sourceOffset } = await resolvedExecutableSql(undefined, context);
    if (!sql.trim()) return false;
    if (supportsSqlTemplateParameters(context.connection, sql) && prepareSqlParameterDialog(sql, sourceOffset, { tabId: context.tabId }, onReady)) {
      return true;
    }
    await onReady(sql, sourceOffset);
    return false;
  }

  // SQL Server batches that end in PRINT/DBCC-style messages with no rows of their own get
  // synthesized into a "Message" pseudo-result (server_message: true). The store's generic
  // "first result with columns" pick can land on that pseudo-result instead of real data, so
  // whenever it does, redirect focus to the first real data result (falling back to the
  // message itself only if there is no data result to show). Shared by every SQL execution
  // entry point so none of them can regress independently (see #6189).
  function focusSqlServerDataResult(executionTabId: string, executionDatabaseType: DatabaseType | undefined, tab: Pick<QueryTab, "results" | "result" | "activeResultIndex">) {
    if (executionDatabaseType !== "sqlserver") return;
    const sqlServerMessageResultIndex = tab.results?.findIndex((result) => result.server_message === true);
    if (sqlServerMessageResultIndex === undefined || sqlServerMessageResultIndex < 0) return;
    const activeSqlServerResult = tab.results && tab.activeResultIndex !== undefined ? tab.results[tab.activeResultIndex] : tab.result;
    if (activeSqlServerResult?.server_message !== true) return;
    const sqlServerDataResultIndex = tab.results?.findIndex((result) => result.server_message !== true && !isQueryExecutionErrorResult(result) && result.columns.length > 0);
    queryStore.setActiveResultIndex(executionTabId, sqlServerDataResultIndex !== undefined && sqlServerDataResultIndex >= 0 ? sqlServerDataResultIndex : sqlServerMessageResultIndex);
  }

  async function doExecute(sql?: string, sourceOffset?: number, options: SqlExecutionOptions = {}): Promise<SqlExecutionOutcome> {
    if (sql === undefined) {
      const context = captureExecutionContext(options.tabId);
      if (!context) {
        cancelEditorViewportRequest(options.editorViewportRequestId);
        return notStarted("no-tab", options.tabId);
      }
      ({ sql, sourceOffset } = await resolvedExecutableSql(undefined, context));
    }
    const executionTabId = options.tabId ?? deps.activeTab.value?.id;
    if (!executionTabId || !sql || !sql.trim()) {
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("empty-sql", executionTabId);
    }
    const tab = resolveExecutionTab(executionTabId);
    if (!tab) {
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("no-tab", executionTabId);
    }
    const executionConnection = tab.connectionId ? (connectionStore.getConfig(tab.connectionId) ?? (tab.connectionId === deps.activeConnection.value?.id ? deps.activeConnection.value : undefined)) : undefined;
    const executionDatabaseType = executionConnection?.db_type;
    if (requiresConnectionSelection(tab, executionConnection)) {
      deps.onMissingConnection?.(executionTabId);
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("no-connection", executionTabId);
    }
    if (requiresDatabaseSelection(tab, executionConnection, sql)) {
      deps.onMissingDatabase?.(executionTabId);
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("missing-database", executionTabId);
    }
    const statementCount = splitSqlStatementRanges(
      sql,
      executionDatabaseType,
      sqlStatementParameterOptionsForCompatibility(executionDatabaseType, executionDatabaseType === "opengauss" ? connectionStore.databaseCompatibilityMode(tab.connectionId, tab.database) : executionDatabaseType === "kingbase" ? executionConnection?.database_info?.compatibilityMode : undefined),
    ).length;
    const redisConsoleSelected = executionDatabaseType === "redis" && tab.uiState?.redisResultViewMode === "console";
    // A single write/DDL statement has no result grid to show while it runs, so
    // it starts on the summary tab where the in-flight status is rendered
    // instead of leaving an empty data grid up (issue #12283).
    const autoSummaryWhileRunning = statementCount === 1 && !redisConsoleSelected && executionDatabaseType !== "redis" && statementRunsWithoutResultGrid(sql);
    // Output-view switching belongs to the tab the user is looking at — both
    // when the query starts and when it finishes.
    if (deps.activeTab.value?.id === executionTabId) {
      deps.activeOutputView.value = redisConsoleSelected ? "result" : statementCount > 1 ? settingsStore.editorSettings.multiStatementDefaultView : autoSummaryWhileRunning ? "summary" : "result";
    }
    updateExecutionTabUiState(tab, { autoSwitchedToMessagesDuringExecution: false });
    const connName = executionConnection?.name || "";
    const start = Date.now();
    const isRedis = executionDatabaseType === "redis";
    const producedResult = await queryStore.executeCurrentSql(sql, {
      tabId: executionTabId,
      ...(isRedis ? { skipRedisSafetyCheck: deps.blockDangerousRedisCommands?.value === false } : {}),
      ...(sourceOffset !== undefined ? { sourceOffset } : {}),
      ...(options.openInNewResultTab ? { openInNewResultTab: true } : {}),
      ...(options.editorViewportRequestId !== undefined ? { onExecutionStarted: () => deps.onExecutionStarted?.(options.editorViewportRequestId!) } : {}),
    });
    if (producedResult === false) {
      // `executeCurrentSql` reports `false` while another request is already
      // preparing a result run for this tab (queryStore's pending-preparation
      // guard), i.e. the tab is busy — never a silent no-op.
      cancelEditorViewportRequest(options.editorViewportRequestId);
      return notStarted("busy", executionTabId);
    }
    const currentTab = resolveExecutionTab(executionTabId) ?? tab;
    const executionTabStillActive = deps.activeTab.value?.id === executionTabId;
    const sqlServerMessageResultIndex = executionDatabaseType === "sqlserver" ? currentTab.results?.findIndex((result) => result.server_message === true) : undefined;
    if (sqlServerMessageResultIndex !== undefined && sqlServerMessageResultIndex >= 0) {
      focusSqlServerDataResult(currentTab.id, executionDatabaseType, currentTab);
      if (executionTabStillActive) {
        deps.activeOutputView.value = currentTab.result?.server_message === true ? "messages" : "result";
      }
    } else if (executionDatabaseType === "sqlserver" && currentTab.result?.server_message === true) {
      if (executionTabStillActive) {
        deps.activeOutputView.value = "messages";
      }
    } else if (currentTab.result && !currentTab.result.columns.length && !currentTab.results?.some((result) => result.columns.length > 0)) {
      if (executionTabStillActive && deps.activeOutputView.value !== "messages") {
        deps.activeOutputView.value = statementCount === 1 ? defaultViewForResult(currentTab.result) : "summary";
      }
    } else if (currentTab.uiState?.autoSwitchedToMessagesDuringExecution) {
      const hasTabularData =
        !firstQueryExecutionError(currentTab) &&
        !!((currentTab.result?.columns.length && currentTab.result.server_message !== true && !isQueryExecutionErrorResult(currentTab.result)) || currentTab.results?.some((result) => result.columns.length > 0 && result.server_message !== true && !isQueryExecutionErrorResult(result)));
      if (hasTabularData) {
        const targetView = statementCount > 1 && settingsStore.editorSettings.multiStatementDefaultView === "summary" ? "summary" : "result";
        updateExecutionTabUiState(currentTab, {
          activeOutputView: targetView,
          autoSwitchedToMessagesDuringExecution: false,
        });
        if (executionTabStillActive) {
          deps.activeOutputView.value = targetView;
        }
      }
    } else if (executionTabStillActive && autoSummaryWhileRunning && deps.activeOutputView.value === "summary" && ((currentTab.result?.columns.length ?? 0) > 0 || currentTab.results?.some((result) => result.columns.length > 0))) {
      // `INSERT ... RETURNING` and siblings do return a grid even though their
      // leading keyword normally means "no result set"; show it once it lands.
      deps.activeOutputView.value = "result";
    }
    updateExecutionTabUiState(currentTab, { autoSwitchedToMessagesDuringExecution: false });
    const elapsed = Date.now() - start;
    const failure = firstQueryExecutionError(currentTab);
    const success = !failure;
    historyStore.add({
      connection_id: currentTab.connectionId,
      connection_name: connName,
      database: currentTab.database,
      sql,
      execution_time_ms: elapsed,
      success,
      error: failure ? (failure.error ? translateBackendError(t, failure.error, failure.rows?.[0]?.[0]) : String(failure.rows?.[0]?.[0] ?? "")) : undefined,
      activity_kind: classifySqlActivityKind(sql),
      operation: primarySqlOperation(sql),
      affected_rows: success ? currentTab.result?.affected_rows : undefined,
    });
    if (success) {
      const refreshTarget = sqlMetadataRefreshTarget(sql, currentTab.schema);
      if (refreshTarget.scope === "connection") {
        connectionStore.invalidateMetadataCache(currentTab.connectionId);
        await invalidateObjectMetadataCache({ connectionId: currentTab.connectionId });
        await connectionStore.loadDatabases(currentTab.connectionId, { force: true });
      } else if (refreshTarget.scope === "database") {
        await invalidateObjectMetadataCache({ connectionId: currentTab.connectionId, database: currentTab.database, schema: refreshTarget.schema });
        await connectionStore.refreshObjectListTreeNode(currentTab.connectionId, currentTab.database, refreshTarget.schema);
      }
    }
    return {
      status: "started",
      ok: success,
      tabId: tab.id,
      // Same text the history entry records, so the panel shows the database's
      // own words rather than a second, drifting translation of them.
      ...(failure ? { errorMessage: failure.error ? translateBackendError(t, failure.error, failure.rows?.[0]?.[0]) : String(failure.rows?.[0]?.[0] ?? "") } : {}),
    };
  }

  async function executeTargetSql(input: TargetSqlExecutionInput): Promise<MultiDbTargetExecutionResult> {
    const { tab, connection, sql, sourceOffset, targetLabel } = input;
    const startedAt = Date.now();
    let confirmationWaitMs = 0;
    /**
     * A danger or production prompt parks the target until the operator answers.
     * Reading and typing that answer is not execution time, so it is excluded
     * from the duration this target reports.
     */
    const waitForConfirmation = async <T>(prompt: () => Promise<T> | undefined): Promise<T | undefined> => {
      const waitStartedAt = Date.now();
      try {
        return await prompt();
      } finally {
        confirmationWaitMs += Date.now() - waitStartedAt;
      }
    };
    const elapsedMs = () => Math.max(0, Date.now() - startedAt - confirmationWaitMs);
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
      durationMs: elapsedMs(),
    });
    const cancelRequested = () => input.isCancellationRequested?.() === true;
    const tabCancelRequested = (count: number) => (tab.cancelRequestCount ?? 0) !== count;
    if (cancelRequested()) return finish({ status: "cancelled" });
    if (!sql.trim()) return finish({ status: "failed", errorMessage: t("explain.emptySql") });
    if (!(await ensureReadOnlyWriteAccess({ connection, sql, source: t("production.sourceMultiDbSql") }))) {
      return finish({ status: "skipped", errorMessage: t(mysqlDataCharsetEnabled(connection) ? "connection.mysqlDataCharsetWriteBlocked" : "dangerDialog.cancel") });
    }
    if (requiresConnectionSelection(executionTab, connection)) {
      deps.onMissingConnection?.(executionTab.id);
      return finish({ status: "failed", errorMessage: t("editor.selectConnectionRequired") });
    }
    if (requiresDatabaseSelection(executionTab, connection, sql)) {
      return finish({ status: "failed", errorMessage: t("editor.selectDatabaseRequired") });
    }

    const blockRedisCommands = input.blockDangerousRedisCommands !== false;
    if (connection.db_type === "redis" && blockRedisCommands) {
      const commands = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !isRedisCommentLine(line));
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
        const confirmed = await waitForConfirmation(() =>
          deps.requestDangerConfirmation?.({
            sql,
            kind: "redis",
            connectionName: connection.name,
            database: executionTab.database,
            targetLabel,
            targets: input.batchTargetLabels,
            databaseType: connection.db_type,
            scopeId: input.scopeId,
          }),
        );
        if (cancelRequested()) return finish({ status: "cancelled" });
        if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
      }
    }

    const productionAssessment = assessProductionSql(sql, connection, executionTab.database);
    if (productionAssessment.active && productionAssessment.isMutation) {
      const confirmed = await waitForConfirmation(() =>
        productionSafetyStore.requestConfirmation({
          sql,
          connectionName: connection.name,
          database: executionTab.database,
          productionDatabases: productionAssessment.databases,
          source: t("production.sourceMultiDbSql"),
          scopeId: input.scopeId,
        }),
      );
      if (cancelRequested()) return finish({ status: "cancelled" });
      if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
    }

    if (isDangerousSql(sql, connection.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      const confirmed = await waitForConfirmation(() =>
        deps.requestDangerConfirmation?.({
          sql,
          kind: "sql",
          connectionName: connection.name,
          database: executionTab.database,
          targetLabel,
          targets: input.batchTargetLabels,
          databaseType: connection.db_type,
          scopeId: input.scopeId,
        }),
      );
      if (cancelRequested()) return finish({ status: "cancelled" });
      if (!confirmed) return finish({ status: "skipped", errorMessage: t("dangerDialog.cancel") });
    }

    if (cancelRequested()) return finish({ status: "cancelled" });
    const cancelRequestCount = tab.cancelRequestCount ?? 0;
    if (input.manualTransaction && (!input.executionTarget || !supportsTransaction(effectiveDatabaseTypeForConnection(connection)))) {
      return finish({ status: "failed", errorMessage: t("multiDbExecute.manualUnsupported") });
    }
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
        durationMs: elapsedMs(),
        errorMessage,
      });
    };
    let manualSessionId: string | undefined;
    let retainedWorker = false;
    let commitUncertain = false;
    let recordedRunId: string | undefined;
    let recordCommittedOutcome: (() => Promise<void>) | undefined;
    const rollbackManualSession = async (sessionId: string) => {
      try {
        await api.rollbackManualTransaction(sessionId);
        return true;
      } catch (error) {
        // Core already removes sessions on statement errors and idle expiry.
        if (!/transaction session not found/i.test(String(error))) throw error;
        return false;
      }
    };
    const transaction: MultiDbManualTransaction = {
      canCommit: false,
      async finish(action) {
        if (!manualSessionId) return;
        if (action === "commit" && !transaction.canCommit) throw new Error(t("multiDbExecute.manualCommitUnavailable"));
        let warning: string | undefined;
        if (action === "commit") {
          transaction.canCommit = false;
          try {
            await api.commitManualTransaction(manualSessionId);
          } catch (error) {
            commitUncertain = true;
            throw error;
          }
        } else if (!(await rollbackManualSession(manualSessionId)) && commitUncertain) {
          warning = t("toolbar.commitOutcomeUnknown");
        }
        // A later history/metadata/worker cleanup failure must never retry a commit.
        manualSessionId = undefined;
        transaction.canCommit = false;
        const run = queryStore.tabs.find((candidate) => candidate.id === tab.id)?.resultRuns?.find((candidate) => candidate.id === recordedRunId);
        if (run?.multiDbExecution) {
          run.multiDbExecution.status = warning ? "failed" : action === "commit" ? "success" : "rolled_back";
          run.multiDbExecution.errorMessage = warning;
        }
        try {
          if (action === "commit") await recordCommittedOutcome?.();
        } catch (error) {
          toast(String(error), 5000);
        } finally {
          if (workerId) await queryStore.removeMultiDbExecutionWorker(workerId, input.scopeId).catch((error) => toast(String(error), 5000));
        }
        return warning;
      },
    };
    const failedManualResult = async (status: "failed" | "cancelled", errorMessage?: string): Promise<MultiDbTargetExecutionResult> => {
      transaction.canCommit = false;
      if (manualSessionId) {
        try {
          await rollbackManualSession(manualSessionId);
          manualSessionId = undefined;
        } catch (error) {
          retainedWorker = true;
          return finish({ status, errorMessage: [errorMessage, String(error)].filter(Boolean).join("\n"), transaction });
        }
      }
      return finish({ status, errorMessage });
    };
    try {
      if (input.manualTransaction) {
        manualSessionId = await api.beginManualTransaction(executionTab.connectionId, executionTab.database, executionTab.schema, executionTab.catalog);
        if (cancelRequested()) return await failedManualResult("cancelled");
        const worker = queryStore.getExecutionTab(executionTabId);
        if (!worker) throw new Error(t("multiDbExecute.targetMissingConnection"));
        // Submit once on the dedicated session. No ordinary-connection fallback,
        // expired-session replay, or per-statement retry is allowed for this batch.
        const maxRows = agentProtocolQueryResultMaxRows(effectiveQueryResultMaxRows(settingsStore.editorSettings.queryResultMaxRowsEnabled, settingsStore.editorSettings.queryResultMaxRows));
        const databaseType = effectiveDatabaseTypeForConnection(connection);
        const compatibility = databaseType === "opengauss" ? connectionStore.databaseCompatibilityMode(executionTab.connectionId, executionTab.database) : databaseType === "kingbase" ? connection?.database_info?.compatibilityMode : undefined;
        const statements = splitSqlStatementRanges(sql, databaseType, sqlStatementParameterOptionsForCompatibility(databaseType, compatibility));
        const results: NonNullable<QueryTab["results"]> = [];
        for (const [statementIndex, statement] of (statements.length ? statements : [{ sql, from: 0, to: sql.length }]).entries()) {
          if (cancelRequested()) return await failedManualResult("cancelled");
          const statementResults = await api.executeInManualTransaction(manualSessionId, statement.sql, executionTab.database, executionTab.schema, maxRows);
          results.push(
            ...statementResults.map((result) => ({
              ...result,
              statement_index: statementIndex,
              sourceStatement: statement.sql,
              ...(sourceOffset === undefined ? {} : { sourceFrom: sourceOffset + statement.from, sourceTo: sourceOffset + statement.to }),
            })),
          );
          if (statementResults.some(isQueryExecutionErrorResult)) break;
        }
        worker.results = results;
        worker.activeResultIndex = 0;
        worker.result = results[0];
        worker.resultBaseSql = sql;
        worker.lastExecutedSql = sql;
      } else
        await queryStore.executeTabSql(executionTabId, sql, {
          resultBaseSql: sql,
          // A multi-database run is read to be inspected and exported as one
          // merged table, so every source fetches a real body of rows instead of
          // the editor's first page. The user's own result-row limit still wins.
          pagination: { limit: MULTI_SOURCE_MAX_ROWS_PER_SOURCE, offset: 0 },
          ...(input.targetContext ? { targetContext: input.targetContext } : {}),
          ...(sourceOffset !== undefined ? { sourceOffset } : {}),
          ...(connection.db_type === "redis" ? { skipRedisSafetyCheck: !blockRedisCommands } : {}),
        });
      const latest = queryStore.getExecutionTab(executionTabId) ?? tab;
      if (cancelRequested() || tabCancelRequested(cancelRequestCount)) {
        return await failedManualResult("cancelled");
      }
      focusSqlServerDataResult(executionTabId, connection.db_type, latest);
      const failure = firstQueryExecutionError(latest);
      const errorMessage = failure ? (failure.error ? translateBackendError(t, failure.error, failure.rows?.[0]?.[0]) : String(failure.rows?.[0]?.[0] ?? t("common.failed"))) : undefined;
      const success = !failure;
      // The produced result travels back with the target status so the dialog can
      // union every target's rows into the merged multi-source view. Snapshot it
      // before recording the run: later cleanup releases the worker payload.
      const mergeResult = snapshotResultForMerge(latest.result);
      const resultStatus = success ? (input.manualTransaction ? "pending_commit" : "success") : "failed";
      recordedRunId = captureWorkerResult(resultStatus, errorMessage);
      const executionDuration = elapsedMs();
      const recordOutcome = async () => {
        await historyStore.add({
          connection_id: executionTab.connectionId,
          connection_name: connection.name || "",
          database: executionTab.database,
          sql,
          execution_time_ms: executionDuration,
          success,
          error: errorMessage,
          activity_kind: classifySqlActivityKind(sql),
          operation: primarySqlOperation(sql),
          affected_rows: success ? latest.result?.affected_rows : undefined,
        });
        if (success) {
          const refreshTarget = sqlMetadataRefreshTarget(sql, executionTab.schema);
          if (refreshTarget.scope === "connection") {
            connectionStore.invalidateMetadataCache(executionTab.connectionId);
            await invalidateObjectMetadataCache({ connectionId: executionTab.connectionId });
            await connectionStore.loadDatabases(executionTab.connectionId, { force: true });
          } else if (refreshTarget.scope === "database") {
            await invalidateObjectMetadataCache({ connectionId: executionTab.connectionId, database: executionTab.database, schema: refreshTarget.schema });
            await connectionStore.refreshObjectListTreeNode(executionTab.connectionId, executionTab.database, refreshTarget.schema);
          }
        }
      };
      if (input.manualTransaction && success) {
        transaction.canCommit = true;
        retainedWorker = true;
        recordCommittedOutcome = recordOutcome;
        return finish({ status: "pending_commit", transaction, result: mergeResult });
      }
      await recordOutcome();
      if (input.manualTransaction) return await failedManualResult("failed", errorMessage);
      // 多库 worker 路径（workerId 存在）下不切主编辑器输出视图：并行 Promise.all
      // 会让多个 worker 几乎同时改这个共享 ref，导致主视图在 result/summary 间反复
      // 跳动（闪烁/竞态）。worker 结果已由 captureMultiDbExecutionWorkerResult 记录
      // 到 source tab 的 result run 并通过 projectResultRun 投影显示，无需再切主视图。
      if (!workerId && deps.activeTab.value?.id === tab.id) {
        deps.activeOutputView.value = success && latest.result?.server_message === true ? "messages" : success && (latest.result?.columns.length || latest.results?.some((result) => result.columns.length)) ? "result" : "summary";
      }
      // A target that ran inside a manual transaction keeps its own worker and
      // session alive, and reports the transaction the merged view settles.
      return finish(success ? { status: "success", errorMessage, result: mergeResult } : { status: "failed", errorMessage, result: mergeResult });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      captureWorkerResult("failed", errorMessage);
      return await failedManualResult("failed", errorMessage);
    } finally {
      if (workerId && !retainedWorker) await queryStore.removeMultiDbExecutionWorker(workerId, input.scopeId);
    }
  }

  /**
   * Opens the danger dialog for an App-level flow (AI auto-execution) that has
   * already made its own gating decision. The acting tab id is captured here so
   * the confirmation resumes against the requesting tab, not whichever tab is
   * active when the user confirms.
   */
  function requestDangerConfirmation(sql: string, tabId?: string) {
    dangerSql.value = sql;
    pendingDangerSql.value = sql;
    pendingDangerKind.value = "sql";
    pendingOpenInNewResultTab.value = false;
    pendingDangerTabId.value = tabId;
    suppressDangerConfirm.value = false;
    showDangerDialog.value = true;
  }

  function cancelActiveExecution(tabId?: string) {
    const tab = resolveExecutionTab(tabId);
    if (!tab) {
      return;
    }
    if (tab.isExecuting) {
      void queryStore.cancelTabExecution(tab.id);
    } else if (tab.isExplaining) {
      void queryStore.cancelTabExplain(tab.id);
    }
  }

  function explainReasonMessage(reason: string): string {
    if (reason === "unsupported") {
      return t("explain.unsupported");
    }
    if (reason === "unsafe") {
      return t("explain.unsafe");
    }
    return t("explain.emptySql");
  }

  async function runExplain(sql: string, context: SqlExecutionContext) {
    const tab = resolveExecutionTab(context.tabId);
    if (!tab || !sql.trim()) {
      toast(t("explain.emptySql"));
      return;
    }

    if (deps.activeTab.value?.id === tab.id) {
      deps.activeOutputView.value = "explain";
    }
    const databaseType = effectiveDatabaseTypeForConnection(context.connection) ?? context.connection?.db_type;
    const result = await queryStore.explainTabSql(tab.id, sql, databaseType, explainMode.value);
    if (!result.ok) {
      toast(explainReasonMessage(result.reason), 5000);
      return;
    }

    const current = resolveExecutionTab(context.tabId);
    if (current?.explainError) {
      toast(current.explainError, 5000);
    }
  }

  async function tryExplain(sqlOverride?: SqlExecutionOverride, options: SqlExecutionOptions = {}) {
    const sourceTab = resolveExecutionTab(options.tabId);
    if (sourceTab && isObjectDependencySection(sourceTab)) return;
    const context = captureExecutionContext(options.tabId);
    if (!context) {
      return;
    }
    const { sql, sourceOffset } = await resolvedExecutableSql(sqlOverride, context);
    const tab = resolveExecutionTab(context.tabId);
    if (!tab) {
      return;
    }
    if (requiresConnectionSelection(tab, context.connection)) {
      deps.onMissingConnection?.(context.tabId);
      return;
    }
    if (!sql.trim()) {
      toast(t("explain.emptySql"));
      return;
    }
    // Resolve SQL template variables exactly like tryExecute so EXPLAIN never runs the raw
    // placeholders (e.g. `EXPLAIN (FORMAT JSON) SELECT :var;` fails on PostgreSQL).
    if (supportsSqlTemplateParameters(context.connection, sql) && prepareSqlParameterDialog(sql, sourceOffset, { tabId: context.tabId }, (resolvedSql) => runExplain(resolvedSql, context))) {
      return;
    }
    await runExplain(sql, context);
  }

  async function onDangerConfirm() {
    const sql = pendingDangerSql.value;
    const sourceOffset = pendingDangerSourceOffset.value;
    const kind = pendingDangerKind.value;
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    const editorViewportRequestId = pendingDangerEditorViewportRequestId.value;
    const tabId = pendingDangerTabId.value;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    pendingOpenInNewResultTab.value = false;
    pendingDangerEditorViewportRequestId.value = undefined;
    pendingDangerTabId.value = undefined;
    if (suppressDangerConfirm.value && kind === "sql") {
      settingsStore.updateEditorSettings({ confirmDangerousSqlExecution: false });
    }
    suppressDangerConfirm.value = false;
    const tab = resolveExecutionTab(tabId);
    if (!tab) {
      reportDeferredExecution(notStarted("no-tab", tabId));
      return;
    }
    const connection = connectionStore.getConfig(tab.connectionId);
    if (!(await ensureReadOnlyWriteAccess({ connection, sql, source: t("production.sourceSqlEditor") }))) {
      cancelEditorViewportRequest(editorViewportRequestId);
      reportDeferredExecution(notStarted(mysqlDataCharsetEnabled(connection) ? "blocked" : "cancelled", tab.id));
      return;
    }
    try {
      reportDeferredExecution(await doExecute(sql, sourceOffset, { openInNewResultTab, editorViewportRequestId, tabId: tab.id }));
    } catch (error) {
      reportDeferredExecutionFailure(error, tab.id);
    }
  }

  async function onSqlParametersConfirm(sql: string) {
    const openInNewResultTab = pendingOpenInNewResultTab.value;
    const editorViewportRequestId = pendingSqlParameterEditorViewportRequestId.value;
    const tabId = pendingSqlParameterTabId.value;
    showSqlParameterDialog.value = false;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    const sourceOffset = pendingSourceOffset.value;
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    pendingSqlParameterEditorViewportRequestId.value = undefined;
    pendingSqlParameterTabId.value = undefined;
    const continuation = pendingSqlParameterContinuation;
    pendingSqlParameterContinuation = undefined;
    if (continuation) {
      await continuation(sql, sourceOffset);
      return;
    }
    const context = captureExecutionContext(tabId);
    if (!context) {
      reportDeferredExecution(notStarted("no-tab", tabId));
      return;
    }
    try {
      reportDeferredExecution(await continueExecute(context, sql, sourceOffset, { openInNewResultTab, editorViewportRequestId, tabId: context.tabId }));
    } catch (error) {
      reportDeferredExecutionFailure(error, context.tabId);
    }
  }

  watch(showSqlParameterDialog, (open) => {
    if (open) return;
    const editorViewportRequestId = pendingSqlParameterEditorViewportRequestId.value;
    // Still set means the dialog was dismissed rather than accepted:
    // `onSqlParametersConfirm` clears it up front, before it resumes the execution
    // and reports that outcome itself. Without this the caller parked on the dialog
    // would wait forever (#11962).
    const abandonedTabId = pendingSqlParameterTabId.value;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    pendingSourceOffset.value = undefined;
    pendingOpenInNewResultTab.value = false;
    pendingSqlParameterEditorViewportRequestId.value = undefined;
    pendingSqlParameterTabId.value = undefined;
    pendingSqlParameterContinuation = undefined;
    cancelEditorViewportRequest(editorViewportRequestId);
    if (abandonedTabId) reportDeferredExecution(notStarted("cancelled", abandonedTabId));
  });

  watch(showDangerDialog, (open) => {
    if (open) return;
    const editorViewportRequestId = pendingDangerEditorViewportRequestId.value;
    // Same dismissal contract as the parameter dialog: a tab id still pending here
    // means the user closed the dialog instead of confirming it.
    const abandonedTabId = pendingDangerTabId.value;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    pendingOpenInNewResultTab.value = false;
    pendingDangerEditorViewportRequestId.value = undefined;
    pendingDangerTabId.value = undefined;
    suppressDangerConfirm.value = false;
    cancelEditorViewportRequest(editorViewportRequestId);
    if (abandonedTabId) reportDeferredExecution(notStarted("cancelled", abandonedTabId));
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
    requestDangerConfirmation,
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
  if (connection.db_type === "meilisearch" || connection.db_type === "solr" || connection.db_type === "couchdb") return false;
  if (connection.db_type === "elasticsearch" || connection.db_type === "easysearch") return !isElasticsearchRestRequestText(sql);
  return connection.db_type !== "redis" && connection.db_type !== "mongodb" && connection.db_type !== "victoriametrics" && connection.db_type !== "salesforce";
}

export function requiresConnectionSelection(tab: QueryTab, connection: ConnectionConfig | undefined): boolean {
  if (tab.mode !== "query") return false;
  return !connection;
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
