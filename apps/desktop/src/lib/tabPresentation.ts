import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ConnectionConfig, QueryResult, QueryTab } from "@/types/database";

type Translate = (key: string, params?: Record<string, unknown>) => string;
export type OutputView = "result" | "summary" | "explain" | "chart";

export function connectionDisplayName(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.name || connectionId;
}

export function connectionColor(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.color || "";
}

export function isConnectionReadonly(connectionId: string): boolean {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.read_only ?? false;
}

function jdbcTargetLabel(connection: ConnectionConfig): string {
  const url = connection.connection_string?.trim() || "";
  const serviceMatch = url.match(/@\/\/[^/?;]+\/([^?;]+)/);
  if (serviceMatch?.[1]) return serviceMatch[1];
  const sidMatch = url.match(/@[^:]+:\d+:([^?;]+)/);
  if (sidMatch?.[1]) return sidMatch[1];
  const pathMatch = url.match(/^jdbc:[^:]+:\/\/[^/?;]+\/([^?;]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  return connection.driver_label || "JDBC";
}

export function databaseDisplayNameForTab(connectionId: string, database: string, t: Translate): string {
  const connectionStore = useConnectionStore();
  const connection = connectionStore.getConfig(connectionId);
  if (connection?.db_type === "redis" && database !== "") return `db${database}`;
  if (connection?.db_type === "jdbc" && !database) return jdbcTargetLabel(connection);
  return database || t("editor.noDatabase");
}

export function isPreviewTab(tab: QueryTab): boolean {
  const connectionStore = useConnectionStore();
  const config = connectionStore.getConfig(tab.connectionId);
  return !!config?.name.startsWith("[Preview]");
}

function queryTitle(tab: QueryTab): string | undefined {
  if (tab.customTitle || tab.savedSqlId || tab.objectSource) return tab.title.trim() || undefined;
  return undefined;
}

export function tabDisplayTitle(tab: QueryTab, t: Translate): string {
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database, t);
  const settingsStore = useSettingsStore();
  const compact = settingsStore.editorSettings.compactTabTitle;
  if (isPreviewTab(tab)) return tab.title;
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    if (compact) return tab.tableMeta.tableName;
    const suffix = tab.tableMeta.schema && tab.tableMeta.schema !== tab.database ? `@${database}.${tab.tableMeta.schema}` : `@${database}`;
    return `${tab.tableMeta.tableName}${suffix}`;
  }
  if (tab.mode === "query") {
    const title = queryTitle(tab);
    if (title) return title;
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${database}`;
  }
  if (tab.mode === "mongo" && tab.sql) {
    if (compact) return tab.sql;
    return `${tab.sql}@${database}`;
  }
  if (tab.mode === "vector" && tab.sql) {
    if (compact) return tab.sql;
    return `${tab.sql}@${database}`;
  }
  if (tab.mode === "redis") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${database}`;
  }
  if (tab.mode === "etcd") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@keys`;
  }
  if (tab.mode === "zookeeper") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@keys`;
  }
  if (tab.mode === "objects") {
    const schema = tab.objectBrowser?.schema;
    if (compact) return schema || tab.title;
    return schema ? `${schema}@${database}` : `${tab.title}@${database}`;
  }
  if (tab.mode === "users") {
    if (compact) return t("tabs.users");
    return `${t("tabs.users")}@${connectionDisplayName(tab.connectionId)}`;
  }
  return tab.title;
}

export function tabTooltipLines(tab: QueryTab, t: Translate): { label: string; value: string }[] {
  const connName = connectionDisplayName(tab.connectionId);
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database, t);
  const lines: { label: string; value: string }[] = [
    { label: t("tabs.tooltipConnection"), value: connName },
    { label: t("tabs.tooltipDatabase"), value: database },
  ];
  if (tab.mode === "query" && queryTitle(tab)) {
    lines.unshift({ label: t("tabs.tooltipTitle"), value: tab.title });
  }
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.tableMeta.tableName });
  }
  if (tab.mode === "mongo" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  if (tab.mode === "vector" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  if (tab.mode === "objects" && tab.objectBrowser?.schema) {
    lines.push({ label: t("tabs.tooltipSchema"), value: tab.objectBrowser.schema });
  }
  return lines;
}

export function tabularResultItems(results: QueryResult[] | undefined): { result: QueryResult; index: number; n: number }[] {
  if (!results) return [];
  return results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.columns.length > 0)
    .map((item, ordinal) => ({ ...item, n: ordinal + 1 }));
}

export function activeResultRun(tab: Pick<QueryTab, "resultRuns" | "activeResultRunId">) {
  return tab.resultRuns?.find((run) => run.id === tab.activeResultRunId);
}

export function resultRunItems(tab: Pick<QueryTab, "resultRuns" | "activeResultRunId">): { id: string; title: string; sequence: number; active: boolean }[] {
  return (tab.resultRuns ?? []).map((run) => ({
    id: run.id,
    title: run.title,
    sequence: run.sequence,
    active: run.id === tab.activeResultRunId,
  }));
}

export function resultGridCacheKey(tab: Pick<QueryTab, "id" | "activeResultRunId" | "activeResultIndex">): string {
  return `${tab.id}-${tab.activeResultRunId ?? "current"}-${tab.activeResultIndex ?? 0}`;
}

export function nextExecutionSummaryView(currentView: OutputView, canShowResult: boolean): OutputView {
  if (currentView === "summary" && canShowResult) return "result";
  return "summary";
}

export interface ExecutionSummaryItem {
  result: QueryResult;
  index: number;
  returnedColumns: number;
  returnedRows: number;
  affectedRows: number;
  executionTimeMs: number;
  hasTabularResult: boolean;
  isError: boolean;
}

export function executionSummaryItems(tab: Pick<QueryTab, "result" | "results">): ExecutionSummaryItem[] {
  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  return results.map((result, index) => ({
    result,
    index,
    returnedColumns: result.columns.length,
    returnedRows: result.rows.length,
    affectedRows: result.affected_rows,
    executionTimeMs: result.execution_time_ms,
    hasTabularResult: result.columns.length > 0,
    isError: result.columns.includes("Error"),
  }));
}

export function tabModeLabel(tab: QueryTab, t: Translate): string {
  if (tab.mode === "data") return t("tabs.table");
  if (tab.mode === "query") return t("tabs.sql");
  if (tab.mode === "mongo") return t("tabs.mongo");
  if (tab.mode === "vector") return t("tabs.vector");
  if (tab.mode === "redis") return t("tabs.redis");
  if (tab.mode === "etcd") return t("tabs.etcd");
  if (tab.mode === "zookeeper") return t("tabs.zookeeper");
  if (tab.mode === "nacos") return "Nacos";
  if (tab.mode === "objects") return t("tabs.objects");
  if (tab.mode === "users") return t("tabs.users");
  return tab.mode;
}
