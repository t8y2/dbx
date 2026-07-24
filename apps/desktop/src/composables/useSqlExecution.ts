import { ref, watch, type Ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { supportsConnectionLevelSqlExecution } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { classifySqlActivityKind } from "@/lib/history/historyActivityKind";
import { sqlMetadataRefreshTarget } from "@/lib/sql/sqlMetadataRefresh";
import { isQueryExecutionErrorResult, usesMysqlProtocolDatabaseType } from "@/lib/query/queryResultError";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";
import { isSqlExecutionSnapshot, resolveExecutableSql, type SqlExecutionOverride, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { isElasticsearchRestRequestText, parseElasticsearchRestRequestTarget, splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { extractSqlParameterDescriptors, type SqlParameterDescriptor, type SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { expandSqlVariables } from "@/lib/sql/sqlVariables";
import { enabledSqlParameterSyntaxes, resolveSqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import type { ConnectionConfig, DatabaseType, QueryTab } from "@/types/database";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

const ELASTICSEARCH_TRANSIENT_DELETE_PATHS = [/^\/_search\/scroll\/?$/i, /^\/_pit\/?$/i, /^\/_async_search\/[^/?]+\/?$/i];
const ELASTICSEARCH_DESTRUCTIVE_POST_PATHS = [/(?:^|\/)_(?:delete_by_query|update_by_query|bulk)(?:\/|$)/i, /^\/_reindex(?:\/|$)/i, /^\/_aliases(?:\/|$)/i, /\/_restore(?:\/|$)/i];

function isDangerousElasticsearchRequest(method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD", path: string): boolean {
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (method === "DELETE") return !ELASTICSEARCH_TRANSIENT_DELETE_PATHS.some((pattern) => pattern.test(pathname));
  if (method === "PUT") return true;
  return method === "POST" && ELASTICSEARCH_DESTRUCTIVE_POST_PATHS.some((pattern) => pattern.test(pathname));
}

export function isDangerousSql(sql: string, databaseType?: DatabaseType): boolean {
  if (databaseType === "elasticsearch") {
    const requests = splitSqlStatementRanges(sql, databaseType)
      .map((statement) => parseElasticsearchRestRequestTarget(statement.sql))
      .filter((request): request is NonNullable<typeof request> => request !== null);
    if (requests.length > 0) return requests.some((request) => isDangerousElasticsearchRequest(request.method, request.path));
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

function firstQueryExecutionError(tab: Pick<QueryTab, "result" | "results">, databaseType: DatabaseType | undefined) {
  const activeResult = tab.result;
  if (activeResult && isQueryExecutionErrorResult(activeResult)) return activeResult;
  if (!usesMysqlProtocolDatabaseType(databaseType) && activeResult?.columns.includes("Error")) return activeResult;

  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  return results.find((result) => isQueryExecutionErrorResult(result));
}

export function useSqlExecution(deps: {
  activeTab: ComputedRef<QueryTab | undefined>;
  activeConnection: ComputedRef<ConnectionConfig | undefined>;
  executableSql: ComputedRef<string>;
  resolveExecutableSql?: (snapshot?: SqlExecutionSnapshot) => Promise<string>;
  activeOutputView: Ref<"result" | "summary" | "explain" | "chart">;
  blockDangerousRedisCommands?: Ref<boolean>;
  onMissingDatabase?: () => void;
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

  async function tryExecute(sqlOverride?: SqlExecutionOverride) {
    const tab = deps.activeTab.value;
    const { sql, sourceOffset } = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) return;
    if (requiresDatabaseSelection(tab, deps.activeConnection.value, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    if (supportsSqlTemplateParameters(deps.activeConnection.value, sql) && prepareSqlParameterDialog(sql, sourceOffset)) return;
    await continueExecute(sql, sourceOffset);
  }

  async function continueExecute(sql: string, sourceOffset?: number) {
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
      if (confirmed) await doExecute(sql, sourceOffset);
      return;
    }
    if (isDangerousSql(sql, deps.activeConnection.value?.db_type) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      dangerSql.value = sql;
      pendingDangerSql.value = sql;
      pendingDangerKind.value = "sql";
      pendingDangerSourceOffset.value = sourceOffset;
      suppressDangerConfirm.value = false;
      showDangerDialog.value = true;
    } else {
      await doExecute(sql, sourceOffset);
    }
  }

  function prepareSqlParameterDialog(sql: string, sourceOffset?: number): boolean {
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
    showSqlParameterDialog.value = true;
    return true;
  }

  async function doExecute(sql?: string, sourceOffset?: number) {
    if (sql === undefined) ({ sql, sourceOffset } = await resolvedExecutableSql());
    const tab = deps.activeTab.value;
    if (!tab || !sql.trim()) return;
    const executionConnection = connectionStore.getConfig(tab.connectionId) ?? deps.activeConnection.value;
    const executionDatabaseType = executionConnection?.db_type;
    if (requiresDatabaseSelection(tab, executionConnection, sql)) {
      deps.onMissingDatabase?.();
      return;
    }
    deps.activeOutputView.value = "result";
    const connName = executionConnection?.name || "";
    const start = Date.now();
    const isRedis = executionDatabaseType === "redis";
    await queryStore.executeCurrentSql(sql, {
      ...(isRedis ? { skipRedisSafetyCheck: deps.blockDangerousRedisCommands?.value === false } : {}),
      ...(sourceOffset !== undefined ? { sourceOffset } : {}),
    });
    if (tab.result && !tab.result.columns.length && !tab.results?.some((result) => result.columns.length > 0)) {
      deps.activeOutputView.value = "summary";
    }
    const elapsed = Date.now() - start;
    const failure = firstQueryExecutionError(tab, executionDatabaseType);
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
    const result = await queryStore.explainTabSql(tab.id, sql, deps.activeConnection.value?.db_type, explainMode.value);
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
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    if (suppressDangerConfirm.value && kind === "sql") {
      settingsStore.updateEditorSettings({ confirmDangerousSqlExecution: false });
    }
    suppressDangerConfirm.value = false;
    await doExecute(sql, sourceOffset);
  }

  async function onSqlParametersConfirm(sql: string) {
    showSqlParameterDialog.value = false;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    const sourceOffset = pendingSourceOffset.value;
    pendingSourceOffset.value = undefined;
    await continueExecute(sql, sourceOffset);
  }

  watch(showSqlParameterDialog, (open) => {
    if (open) return;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    sqlParameterDatabaseType.value = undefined;
    sqlParameterEnabledSyntaxes.value = [];
    pendingSourceOffset.value = undefined;
  });

  watch(showDangerDialog, (open) => {
    if (open) return;
    pendingDangerSql.value = "";
    pendingDangerSourceOffset.value = undefined;
    pendingDangerKind.value = "sql";
    suppressDangerConfirm.value = false;
  });

  return {
    dangerSql,
    pendingDangerSql,
    showDangerDialog,
    suppressDangerConfirm,
    tryExecute,
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
    explainMode,
  };
}

export function supportsSqlTemplateParameters(connection: Pick<ConnectionConfig, "db_type"> | undefined, sql = ""): boolean {
  if (!connection) return false;
  if (connection.db_type === "elasticsearch") return !isElasticsearchRestRequestText(sql);
  return connection.db_type !== "redis" && connection.db_type !== "mongodb";
}

export function requiresDatabaseSelection(tab: QueryTab, connection: ConnectionConfig | undefined, _sql = ""): boolean {
  if (tab.mode !== "query") return false;
  if (!connection) return false;
  if (tab.database) return false;
  if (tab.database === "" && usesTreeSchemaMode(connection.db_type)) return false;
  if (isSingleDatabase(connection.db_type)) return false;
  // MySQL-compatible servers decide per statement whether a default database is required.
  // Keep interactive execution connection-scoped instead of rejecting valid qualified or constant queries.
  if (supportsConnectionLevelSqlExecution(connection)) return false;
  return !["elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "zookeeper"].includes(connection.db_type);
}
