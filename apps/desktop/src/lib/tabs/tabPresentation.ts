import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import { executableStatementRanges, splitSqlStatementRanges, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import type { ConnectionConfig, DatabaseType, QueryResult, QueryTab } from "@/types/database";

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
  if (tab.mode === "mongo-gridfs") {
    if (compact) return t("tabs.gridfs");
    return `${t("tabs.gridfs")}@${database}`;
  }
  if (tab.mode === "mongo-bucket") {
    const bucketName = tab.mongoBucket?.bucketName || tab.sql || tab.title.split(".").pop() || tab.title;
    if (compact) return bucketName;
    return `${bucketName}@${database}`;
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
  if (tab.mode === "query" && tab.externalSqlPath) {
    lines.push({ label: t("tabs.tooltipFilePath"), value: tab.externalSqlPath });
  }
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.tableMeta.tableName });
  }
  if (tab.mode === "mongo" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  if (tab.mode === "mongo-gridfs") {
    lines.push({ label: t("tabs.gridfs"), value: t("tabs.gridfs") });
  }
  if (tab.mode === "mongo-bucket") {
    lines.push({ label: t("tabs.gridfs"), value: tab.mongoBucket?.bucketName || tab.sql || tab.title });
  }
  if (tab.mode === "vector" && tab.sql) {
    lines.push({ label: t("tabs.tooltipCollection"), value: tab.sql });
  }
  if (tab.mode === "objects" && tab.objectBrowser?.schema) {
    lines.push({ label: t("tabs.tooltipSchema"), value: tab.objectBrowser.schema });
  }
  return lines;
}

export function queryResultStatementLabel(result: Pick<QueryResult, "sourceLabel">): string | undefined {
  return result.sourceLabel;
}

export function middleEllipsis(value: string, maxLength = 24): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return ".".repeat(Math.max(0, maxLength));
  const visibleLength = maxLength - 3;
  const startLength = Math.ceil(visibleLength / 2);
  const endLength = Math.floor(visibleLength / 2);
  const end = endLength > 0 ? value.slice(-endLength) : "";
  return `${value.slice(0, startLength)}...${end}`;
}

export function resultSqlForGrid(tab: Pick<QueryTab, "result" | "resultBaseSql" | "lastExecutedSql" | "sql">): string {
  return tab.result?.sourceStatement || tab.resultBaseSql || tab.lastExecutedSql || tab.sql;
}

/**
 * Resolves a result's executed statement back to its current editor range.
 * A stale or ambiguous source is ignored instead of highlighting a different
 * statement that happens to have the same text.
 */
export function resultSourceRange(editorSql: string, result: Pick<QueryResult, "sourceStatement" | "sourceFrom" | "sourceTo"> | undefined, resultIndex: number | undefined, databaseType?: DatabaseType): SqlTextRange | undefined {
  const sourceStatement = result?.sourceStatement;
  if (!sourceStatement) return undefined;
  if (typeof result.sourceFrom === "number" && typeof result.sourceTo === "number" && editorSql.slice(result.sourceFrom, result.sourceTo) === sourceStatement) {
    return { from: result.sourceFrom, to: result.sourceTo, sql: sourceStatement };
  }

  const statements = databaseType === "redis" ? executableStatementRanges(editorSql, databaseType) : databaseType === "mongodb" ? splitMongoCommandRanges(editorSql).map(({ from, to, text }) => ({ from, to, sql: text })) : splitSqlStatementRanges(editorSql, databaseType);
  const indexed = typeof resultIndex === "number" ? statements[resultIndex] : undefined;
  if (indexed?.sql === sourceStatement) {
    return { from: indexed.from, to: indexed.to, sql: indexed.sql };
  }

  const matches = statements.filter((statement) => statement.sql === sourceStatement);
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  return { from: match.from, to: match.to, sql: match.sql };
}

export function queryResultBaseSql(tab: Pick<QueryTab, "result" | "resultBaseSql" | "lastExecutedSql" | "sql">): string {
  return resultSqlForGrid(tab);
}

export function queryResultExecutionSql(tab: Pick<QueryTab, "result" | "resultBaseSql" | "resultSortedSql" | "lastExecutedSql" | "sql">): string {
  return tab.resultSortedSql || resultSqlForGrid(tab);
}

export function tabularResultItems(results: QueryResult[] | undefined): { result: QueryResult; index: number; n: number; label?: string; displayLabel?: string; labelTruncated: boolean; title?: string }[] {
  if (!results) return [];
  return results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.columns.length > 0)
    .map((item, ordinal) => {
      const label = queryResultStatementLabel(item.result);
      const displayLabel = label ? middleEllipsis(label) : undefined;
      return {
        ...item,
        n: ordinal + 1,
        label,
        displayLabel,
        labelTruncated: !!label && displayLabel !== label,
        title: item.result.sourceLabel || item.result.sourceStatement,
      };
    });
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
  if (tab.mode === "mongo-gridfs" || tab.mode === "mongo-bucket") return t("tabs.gridfs");
  if (tab.mode === "vector") return t("tabs.vector");
  if (tab.mode === "redis") return t("tabs.redis");
  if (tab.mode === "etcd") return t("tabs.etcd");
  if (tab.mode === "zookeeper") return t("tabs.zookeeper");
  if (tab.mode === "nacos") return "Nacos";
  if (tab.mode === "objects") return t("tabs.objects");
  if (tab.mode === "users") return t("tabs.users");
  return tab.mode;
}
