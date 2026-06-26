import { ref, type Ref, type ComputedRef } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isSingleDatabase } from "@/lib/databaseCapabilities";
import { classifySqlActivityKind } from "@/lib/historyActivityKind";
import { sqlMetadataRefreshTarget } from "@/lib/sqlMetadataRefresh";
import { classifyRedisCommandSafety, firstRedisCommandToken } from "@/lib/redisCommandSafety";
import { isSqlExecutionSnapshot, resolveExecutableSql, type SqlExecutionOverride, type SqlExecutionSnapshot } from "@/lib/sqlExecutionTarget";
import { extractSqlParameters } from "@/lib/sqlParameters";
import type { ConnectionConfig, QueryTab } from "@/types/database";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

export function isDangerousSql(sql: string): boolean {
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
  const { toast } = useToast();

  const dangerSql = ref("");
  const pendingDangerSql = ref("");
  const showDangerDialog = ref(false);
  const suppressDangerConfirm = ref(false);
  const explainMode = ref<"explain" | "autotrace">("explain");
  const showSqlParameterDialog = ref(false);
  const sqlParameterSourceSql = ref("");
  const sqlParameterNames = ref<string[]>([]);

  async function resolvedExecutableSql(source?: SqlExecutionOverride): Promise<string> {
    if (typeof source === "string") return source;
    if (deps.resolveExecutableSql) return await deps.resolveExecutableSql(source);
    if (isSqlExecutionSnapshot(source)) return resolveExecutableSql(source.fullSql, source.selectedSql, { cursorPos: source.cursorPos });
    return deps.executableSql.value;
  }

  async function tryExecute(sqlOverride?: SqlExecutionOverride) {
    const tab = deps.activeTab.value;
    const sql = await resolvedExecutableSql(sqlOverride);
    if (!tab || !sql.trim()) return;
    if (requiresDatabaseSelection(tab, deps.activeConnection.value)) {
      deps.onMissingDatabase?.();
      return;
    }
    if (supportsSqlTemplateParameters(deps.activeConnection.value) && prepareSqlParameterDialog(sql)) return;
    await continueExecute(sql);
  }

  async function continueExecute(sql: string) {
    // Redis: block dangerous commands when toggle is on (check each line for multi-line input)
    if (deps.activeConnection.value?.db_type === "redis" && deps.blockDangerousRedisCommands?.value !== false) {
      const commands = sql
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const cmd of commands) {
        const safety = classifyRedisCommandSafety(cmd);
        if (safety === "blocked") {
          toast(t("redis.blockedCommand", { command: firstRedisCommandToken(cmd) }), 5000);
          return;
        }
      }
    }
    if (isDangerousSql(sql) && settingsStore.editorSettings.confirmDangerousSqlExecution) {
      dangerSql.value = sql;
      pendingDangerSql.value = sql;
      suppressDangerConfirm.value = false;
      showDangerDialog.value = true;
    } else {
      await doExecute(sql);
    }
  }

  function prepareSqlParameterDialog(sql: string): boolean {
    const parameters = extractSqlParameters(sql);
    if (!parameters.length) return false;
    sqlParameterSourceSql.value = sql;
    sqlParameterNames.value = parameters;
    showSqlParameterDialog.value = true;
    return true;
  }

  async function doExecute(sql?: string) {
    sql ??= await resolvedExecutableSql();
    const tab = deps.activeTab.value;
    if (!tab || !sql.trim()) return;
    if (requiresDatabaseSelection(tab, deps.activeConnection.value)) {
      deps.onMissingDatabase?.();
      return;
    }
    deps.activeOutputView.value = "result";
    const connName = connectionStore.getConfig(tab.connectionId)?.name || "";
    const start = Date.now();
    const isRedis = deps.activeConnection.value?.db_type === "redis";
    await queryStore.executeCurrentSql(sql, isRedis ? { skipRedisSafetyCheck: deps.blockDangerousRedisCommands?.value === false } : undefined);
    if (tab.result && !tab.result.columns.length && !tab.results?.some((result) => result.columns.length > 0)) {
      deps.activeOutputView.value = "summary";
    }
    const elapsed = Date.now() - start;
    const success = !tab.result?.columns.includes("Error");
    historyStore.add({
      connection_id: tab.connectionId,
      connection_name: connName,
      database: tab.database,
      sql,
      execution_time_ms: elapsed,
      success,
      error: success ? undefined : String(tab.result?.rows?.[0]?.[0] ?? ""),
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
    const sql = await resolvedExecutableSql(sqlOverride);
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
    const sql = pendingDangerSql.value || (await resolvedExecutableSql());
    if (suppressDangerConfirm.value) {
      settingsStore.updateEditorSettings({ confirmDangerousSqlExecution: false });
    }
    suppressDangerConfirm.value = false;
    pendingDangerSql.value = "";
    await doExecute(sql);
  }

  async function onSqlParametersConfirm(sql: string) {
    showSqlParameterDialog.value = false;
    sqlParameterSourceSql.value = "";
    sqlParameterNames.value = [];
    await continueExecute(sql);
  }

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
    onSqlParametersConfirm,
    explainMode,
  };
}

function supportsSqlTemplateParameters(connection: ConnectionConfig | undefined): boolean {
  if (!connection) return false;
  return connection.db_type !== "redis" && connection.db_type !== "mongodb";
}

function requiresDatabaseSelection(tab: QueryTab, connection: ConnectionConfig | undefined): boolean {
  if (tab.mode !== "query") return false;
  if (!connection || tab.database) return false;
  if (isSingleDatabase(connection.db_type)) return false;
  return !["elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "zookeeper"].includes(connection.db_type);
}
