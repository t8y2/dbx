import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { hexToRgba } from "@/lib/common/color";
import type { CSSProperties } from "vue";
import { findConnectionGroupPath } from "@/lib/sidebar/sidebarLayout";
import { supportsConnectionDatabaseInfo } from "@/lib/connection/connectionDatabaseInfo";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import { executableStatementRanges, splitSqlStatementRanges, sqlStatementParameterOptionsForCompatibility, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import type { SqlParameterOptions } from "@/lib/sql/sqlParameters";
import { sqlTextFingerprint } from "@/lib/sql/sqlTextFingerprint";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import type { SqlErrorPosition } from "@/lib/backend/errorUtils";
import { queryResultSourceNameParts } from "@/lib/sql/queryResultSource";
import type { BatchSqlExecution, ConnectionConfig, DatabaseType, QueryResult, QueryResultRun, QueryTab } from "@/types/database";

type Translate = (key: string, params?: Record<string, unknown>) => string;
export type OutputView = "result" | "summary" | "explain" | "chart";
const TABLE_COMMENT_TOOLTIP_MAX_LENGTH = 50;

function tableCommentTooltipValue(comment: string | null | undefined): string | undefined {
  const normalized = comment?.trim().replace(/\s+/g, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= TABLE_COMMENT_TOOLTIP_MAX_LENGTH ? normalized : `${characters.slice(0, TABLE_COMMENT_TOOLTIP_MAX_LENGTH - 1).join("")}…`;
}

export function connectionDisplayName(connectionId: string): string {
  const connectionStore = useConnectionStore();
  return connectionStore.getConfig(connectionId)?.name || connectionId;
}

export function connectionGroupDisplayName(connectionId: string, t: Translate): string | undefined {
  const connectionStore = useConnectionStore();
  const path = findConnectionGroupPath(connectionStore.sidebarLayout, connectionId);
  if (path === null) return undefined;
  return path.join(" / ") || t("connectionGroup.ungroupedLabel");
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
  // Tolerant of a config that has no name yet (partially loaded or migrated
  // connection): such a tab is simply not a preview tab.
  return Boolean(config?.name?.startsWith("[Preview]"));
}

function queryTitle(tab: QueryTab): string | undefined {
  if (tab.customTitle || tab.savedSqlId || tab.objectSource) return tab.title.trim() || undefined;
  return undefined;
}

export function isEventObjectBrowserTab(tab: QueryTab): boolean {
  return tab.mode === "objects" && (tab.objectBrowser?.initialObjectFilter === "events" || tab.objectBrowser?.eventName !== undefined || tab.objectBrowser?.eventCreateRequestId !== undefined);
}

/**
 * Display titles for a whole tab list.
 *
 * Tabs whose plain title collides (most obviously several query tabs on the
 * same connection and database, which all render `connection@database`) get a
 * 1-based numeric suffix so the strip stays readable. The first tab keeps no
 * suffix when its title is unique, so single-tab windows look exactly as
 * before.
 *
 * 编号不在这里计算，而是由 `syncTabTitleNumbers` 一次性写进标签（见该函数）：渲染
 * 函数只看标签上已有的编号，这样关闭一个重名标签不会让后面的标签被重新编号
 * （#9938）。未分配编号的标签按原样显示。
 */
export function tabDisplayTitles(tabs: QueryTab[], t: Translate): Map<string, string> {
  const titles = new Map<string, string>();
  for (const tab of tabs) {
    const title = tabDisplayTitle(tab, t);
    titles.set(tab.id, tabTitleNumber(tab, title) !== undefined ? `${title} ${tabTitleNumber(tab, title)}` : title);
  }
  return titles;
}

function tabTitleNumber(tab: QueryTab, title: string): number | undefined {
  if (isPreviewTab(tab)) return undefined;
  return tab.titleNumber !== undefined && tab.titleNumberKey === title ? tab.titleNumber : undefined;
}

/**
 * Assigns the stable numeric suffix used by `tabDisplayTitles` to every tab
 * whose plain title collides with another tab's.
 *
 * The number is minted once — when the collision first appears — and is never
 * recycled afterwards: closing the middle tab of `x 1 / x 2 / x 3` leaves
 * `x 1 / x 3` instead of renumbering the survivor to `x 2` (#9938), and a newly
 * created tab continues after the highest number still in use (so the next tab
 * there becomes `x 4`). A tab that no longer collides and was never numbered
 * stays unsuffixed, which keeps single-tab windows unchanged, while a tab that
 * carries a number keeps it until it is closed.
 *
 * Callers own the tab list, so this runs from the store whenever the list or
 * any contributing title changes — never from a render/computed path.
 */
export function syncTabTitleNumbers(tabs: QueryTab[], t: Translate): void {
  const groups = new Map<string, QueryTab[]>();
  for (const tab of tabs) {
    if (isPreviewTab(tab)) continue;
    const title = tabDisplayTitle(tab, t);
    const group = groups.get(title);
    if (group) group.push(tab);
    else groups.set(title, [tab]);
  }

  for (const [title, group] of groups) {
    const numbered = group.filter((tab) => tabTitleNumber(tab, title) !== undefined);
    if (group.length < 2 && numbered.length === 0) {
      // A lone, never-numbered tab shows its plain title; drop a number that a
      // previous title left behind so state does not accumulate stale suffixes.
      for (const tab of group) {
        if (tab.titleNumber !== undefined) {
          tab.titleNumber = undefined;
          tab.titleNumberKey = undefined;
        }
      }
      continue;
    }
    let next = numbered.reduce((highest, tab) => Math.max(highest, tab.titleNumber ?? 0), 0) + 1;
    for (const tab of group) {
      if (tabTitleNumber(tab, title) !== undefined) continue;
      tab.titleNumber = next;
      tab.titleNumberKey = title;
      next += 1;
    }
  }
}

export function tabDisplayTitle(tab: QueryTab, t: Translate): string {
  const database = databaseDisplayNameForTab(tab.connectionId, tab.database, t);
  const settingsStore = useSettingsStore();
  const compact = settingsStore.editorSettings.compactTabTitle;
  if (isPreviewTab(tab)) return tab.title;
  if (useConnectionStore().getConfig(tab.connectionId)?.db_type === "redis") {
    return tab.database ? database : connectionDisplayName(tab.connectionId);
  }
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
  if (tab.mode === "hbase" && tab.sql) {
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
  if (tab.mode === "etcd-dashboard") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@dashboard`;
  }
  if (tab.mode === "etcd-access-control") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${t("tabs.etcdAccessControl")}`;
  }
  if (tab.mode === "nacos-access-control") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${t("tabs.nacosAccessControl")}`;
  }
  if (tab.mode === "zookeeper") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@keys`;
  }
  if (tab.mode === "consul") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@keys`;
  }
  if (tab.mode === "consul-overview") {
    if (compact) return connectionDisplayName(tab.connectionId);
    return `${connectionDisplayName(tab.connectionId)}@${t("consul.ui.overview")}`;
  }
  if (tab.mode === "mqtt") {
    return `${connectionDisplayName(tab.connectionId)} - ${t("connection.mqttConsoleTitle")}`;
  }
  if (tab.mode === "dolt-version-control") {
    const branch = tab.workspaceBranch?.trim();
    return `${connectionDisplayName(tab.connectionId)} VCS@${database}${branch ? `.${branch}` : ""}`;
  }
  if (tab.mode === "databases") {
    if (compact) return t("tabs.databases");
    return `${t("tabs.databases")}@${connectionDisplayName(tab.connectionId)}`;
  }
  if (tab.mode === "objects") {
    if (isEventObjectBrowserTab(tab)) {
      const eventTitle = tab.objectBrowser?.eventName || t("tree.events");
      if (compact) return eventTitle;
      return `${eventTitle}@${database}`;
    }
    const schema = tab.objectBrowser?.schema;
    const objectScope = tab.catalog ? `${tab.catalog}.${database}` : database;
    if (compact) return schema || objectScope;
    return schema ? `${schema}@${objectScope}` : objectScope;
  }
  if (tab.mode === "users") {
    if (compact) return t("tabs.users");
    return `${t("tabs.users")}@${connectionDisplayName(tab.connectionId)}`;
  }
  return tab.title;
}

export function tabTooltipLines(tab: QueryTab, t: Translate): { label: string; value: string }[] {
  const connName = connectionDisplayName(tab.connectionId);
  const groupName = connectionGroupDisplayName(tab.connectionId, t);
  const connection = useConnectionStore().getConfig(tab.connectionId);
  const lines: { label: string; value: string }[] = [
    { label: t("tabs.tooltipConnection"), value: connName },
    ...(groupName ? [{ label: t("tabs.tooltipGroup"), value: groupName }] : []),
    ...(!connection || supportsConnectionDatabaseInfo(connection.db_type) ? [{ label: t("tabs.tooltipDatabase"), value: databaseDisplayNameForTab(tab.connectionId, tab.database, t) }] : []),
  ];
  if (tab.mode === "query" && queryTitle(tab)) {
    lines.unshift({ label: t("tabs.tooltipTitle"), value: tab.title });
  }
  if (tab.mode === "query" && tab.externalSqlPath) {
    lines.push({ label: t("tabs.tooltipFilePath"), value: tab.externalSqlPath });
    if (tab.externalSqlFileMissing) lines.push({ label: t("tabs.tooltipFileStatus"), value: t("tabs.externalFileMissing") });
  }
  if (tab.mode === "data" && tab.tableMeta?.tableName) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.tableMeta.tableName });
    const comment = tableCommentTooltipValue(tab.tableComment);
    if (comment) {
      lines.push({ label: t("tabs.tooltipTableComment"), value: comment });
    }
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
  if (tab.mode === "hbase" && tab.sql) {
    lines.push({ label: t("tabs.tooltipTable"), value: tab.sql });
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
export function resultSourceRange(editorSql: string, result: Pick<QueryResult, "sourceStatement" | "sourceFrom" | "sourceTo"> | undefined, resultIndex: number | undefined, databaseType?: DatabaseType, parameterOptions?: SqlParameterOptions): SqlTextRange | undefined {
  const sourceStatement = result?.sourceStatement;
  if (!sourceStatement) return undefined;
  if (typeof result.sourceFrom === "number" && typeof result.sourceTo === "number" && editorSql.slice(result.sourceFrom, result.sourceTo) === sourceStatement) {
    return { from: result.sourceFrom, to: result.sourceTo, sql: sourceStatement };
  }

  const statements = statementRanges(editorSql, databaseType, parameterOptions);
  const indexed = typeof resultIndex === "number" ? statements[resultIndex] : undefined;
  if (indexed?.sql === sourceStatement) {
    return { from: indexed.from, to: indexed.to, sql: indexed.sql };
  }

  const matches = statements.filter((statement) => statement.sql === sourceStatement);
  if (matches.length !== 1) return undefined;
  const [match] = matches;
  return { from: match.from, to: match.to, sql: match.sql };
}

export type StatementExecutionMarkerStatus = "running" | "success" | "error";

export interface StatementExecutionMarker {
  from: number;
  status: StatementExecutionMarkerStatus;
  successCount: number;
  errorCount: number;
  runningCount?: number;
}

function lineStartOffset(sql: string, from: number): number {
  return sql.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
}

function statementRanges(sql: string, databaseType?: DatabaseType, parameterOptions?: SqlParameterOptions): SqlTextRange[] {
  if (databaseType === "redis") return executableStatementRanges(sql, databaseType);
  if (databaseType === "mongodb") return splitMongoCommandRanges(sql).map(({ from, to, text }) => ({ from, to, sql: text }));
  return splitSqlStatementRanges(sql, databaseType, parameterOptions ?? sqlStatementParameterOptionsForCompatibility(databaseType));
}

function liveStatementExecutionMarkers(editorSql: string, batch: BatchSqlExecution): StatementExecutionMarker[] {
  if (sqlTextFingerprint(editorSql) !== batch.editorFingerprint || batch.total === 0) return [];
  const byLine = new Map<number, { success: number; error: number; running: number }>();
  for (const item of batch.items) {
    if (item.status !== "running" && item.status !== "success" && item.status !== "error") continue;
    if (editorSql.slice(item.from, item.to) !== item.sql) continue;
    const from = lineStartOffset(editorSql, item.from);
    const current = byLine.get(from) ?? { success: 0, error: 0, running: 0 };
    current[item.status] += 1;
    byLine.set(from, current);
  }
  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([from, counts]) => ({
      from,
      status: counts.error > 0 ? "error" : counts.running > 0 ? "running" : "success",
      successCount: counts.success,
      errorCount: counts.error,
      ...(counts.running > 0 ? { runningCount: counts.running } : {}),
    }));
}

export function statementExecutionMarkers(
  editorSql: string,
  results: QueryResult[] | undefined,
  databaseType?: DatabaseType,
  submittedSql = editorSql,
  executionEditorFingerprint = sqlTextFingerprint(editorSql),
  batch?: BatchSqlExecution,
  parameterOptions?: SqlParameterOptions,
): StatementExecutionMarker[] {
  if (batch?.items.length) return liveStatementExecutionMarkers(editorSql, batch);
  if (!results?.length || sqlTextFingerprint(editorSql) !== executionEditorFingerprint) return [];
  const submittedStatements = statementRanges(submittedSql, databaseType, parameterOptions);
  if (submittedStatements.length <= 1) return [];
  const editorStatements = submittedSql === editorSql ? submittedStatements : statementRanges(editorSql, databaseType, parameterOptions);

  const byLine = new Map<number, { success: number; error: number }>();
  for (const result of results) {
    if (!Number.isInteger(result.statement_index) || result.statement_index! < 0) continue;
    const statementIndex = result.statement_index!;
    const submittedStatement = submittedStatements[statementIndex];
    if (!submittedStatement || submittedStatement.sql !== result.sourceStatement) continue;
    const range =
      typeof result.sourceFrom === "number" && typeof result.sourceTo === "number" && editorSql.slice(result.sourceFrom, result.sourceTo) === result.sourceStatement
        ? { from: result.sourceFrom, to: result.sourceTo, sql: result.sourceStatement }
        : editorStatements[statementIndex]?.sql === result.sourceStatement
          ? editorStatements[statementIndex]
          : undefined;
    if (!range) continue;
    const from = lineStartOffset(editorSql, range.from);
    const current = byLine.get(from) ?? { success: 0, error: 0 };
    if (result.execution_error === true) current.error += 1;
    else current.success += 1;
    byLine.set(from, current);
  }

  return [...byLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([from, counts]) => {
      return {
        from,
        status: counts.error > 0 ? "error" : "success",
        successCount: counts.success,
        errorCount: counts.error,
      };
    });
}

export function queryResultBaseSql(tab: Pick<QueryTab, "result" | "resultBaseSql" | "lastExecutedSql" | "sql">): string {
  return resultSqlForGrid(tab);
}

export function queryResultExecutionSql(tab: Pick<QueryTab, "result" | "resultBaseSql" | "resultSortedSql" | "lastExecutedSql" | "sql">): string {
  return tab.resultSortedSql || resultSqlForGrid(tab);
}

export function tabularResultItems(results: QueryResult[] | undefined, options: { includeSourceDatabase?: boolean } = {}): { result: QueryResult; index: number; n: number; label?: string; displayLabel?: string; labelTruncated: boolean; title?: string }[] {
  if (!results) return [];
  return results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.columns.length > 0 && item.result.server_message !== true)
    .map((item, ordinal) => {
      const label = queryResultStatementLabel(item.result);
      const { sourceName, sourceQualifier } = item.result;
      // 只有在标签确实由“库名.对象名”拼成时才启用短名称，避免覆盖 `-- name: xxx` 之类的自定义名称
      const qualifiedLabel = sourceName ? (sourceQualifier ? `${sourceQualifier}.${sourceName}` : sourceName) : undefined;
      // 关闭“结果集名称包含数据库名”时，页签与结果列表只展示对象名；
      // 完整名称（含库名）仍保留在 title，供悬浮提示与搜索使用。
      const displaySource = options.includeSourceDatabase === false && sourceName && qualifiedLabel === label ? sourceName : label;
      const displayLabel = displaySource ? middleEllipsis(displaySource) : undefined;
      return {
        ...item,
        n: ordinal + 1,
        label: displaySource,
        displayLabel,
        labelTruncated: !!displaySource && displayLabel !== displaySource,
        title: item.result.sourceLabel || item.result.sourceStatement,
      };
    });
}

export function activeResultRun(tab: Pick<QueryTab, "resultRuns" | "activeResultRunId">) {
  return tab.resultRuns?.find((run) => run.id === tab.activeResultRunId);
}

/**
 * 执行批次默认显示名：取该批次主结果的来源（库名.表名 / 表名）。
 * 连表查询同样取 FROM 之后的第一个物理表，与结果集页签的来源解析保持一致。
 */
function resultRunSourceLabel(run: QueryResultRun, includeSourceDatabase: boolean, fallback: { database?: string; databaseType?: DatabaseType }): string | undefined {
  // 优先用批次自带的来源：非活动批次的结果 payload 会被回收，payload 里的来源会丢失
  const own = includeSourceDatabase ? run.sourceLabel || run.sourceName : run.sourceName || run.sourceLabel;
  if (own) return own;
  const candidates = run.result ? [run.result, ...(run.results ?? [])] : (run.results ?? []);
  for (const result of candidates) {
    if (!result) continue;
    // 批次级来源缺失时回退到结果本身；关闭“结果集名称包含数据库名”时优先用对象名
    const label = includeSourceDatabase ? result.sourceLabel || result.sourceName : result.sourceName || result.sourceLabel;
    if (label) return label;
  }
  // 历史批次（功能上线前创建的）没有来源信息：用批次 SQL 重新解析，连表查询同样取第一个物理表
  if (run.sql && fallback.databaseType) {
    const parts = queryResultSourceNameParts(run.sql, { database: fallback.database, databaseType: fallback.databaseType });
    if (parts) return includeSourceDatabase ? (parts.qualifier ? `${parts.qualifier}.${parts.name}` : parts.name) : parts.name;
  }
  return undefined;
}

export function resultRunItems(tab: Pick<QueryTab, "resultRuns" | "activeResultRunId">, options: { includeSourceDatabase?: boolean; database?: string; databaseType?: DatabaseType } = {}): { id: string; title: string; sequence: number; active: boolean; pinned: boolean; sourceLabel?: string }[] {
  const includeSourceDatabase = options.includeSourceDatabase !== false;
  const fallback = { database: options.database, databaseType: options.databaseType };
  const seenBySource = new Map<string, number>();
  return (tab.resultRuns ?? []).map((run) => {
    const source = resultRunSourceLabel(run, includeSourceDatabase, fallback);
    let sourceLabel = source;
    if (source) {
      // 同一张表被查询多次时用序号后缀区分页签（users、users (2)…）
      const seen = (seenBySource.get(source) ?? 0) + 1;
      seenBySource.set(source, seen);
      if (seen > 1) sourceLabel = `${source} (${seen})`;
    }
    return {
      id: run.id,
      // 系统默认标题（Run N）由来源名取代；用户重命名/多库按目标命名过的标题优先
      title: run.customTitle ? run.title : "",
      sequence: run.sequence,
      active: run.id === tab.activeResultRunId,
      pinned: run.pinned === true,
      sourceLabel,
    };
  });
}

export function resultGridCacheKey(tab: Pick<QueryTab, "id" | "activeResultRunId" | "activeResultIndex">): string {
  return `${tab.id}-${tab.activeResultRunId ?? "current"}-${tab.activeResultIndex ?? 0}`;
}

export function resultGridColumnWidthCacheKey(tab: Pick<QueryTab, "id"> & Partial<Pick<QueryTab, "activeResultIndex">>): string {
  return `result-column-width-${tab.id}-${tab.activeResultIndex ?? 0}`;
}

export function resultGridInstanceKey(tab: Pick<QueryTab, "id" | "activeResultRunId" | "activeResultIndex" | "resultGridRevision">): string {
  return `${resultGridCacheKey(tab)}-${tab.resultGridRevision ?? "initial"}`;
}

export function nextExecutionSummaryView(currentView: OutputView, canShowResult: boolean): OutputView {
  if (currentView === "summary" && canShowResult) return "result";
  return "summary";
}

export interface ExecutionSummaryItem {
  result?: QueryResult;
  index: number;
  statementIndex: number;
  sql?: string;
  sourceFrom?: number;
  sourceTo?: number;
  status: "pending" | "running" | "success" | "error" | "skipped" | "cancelled";
  error?: string;
  /** Backend-reported error row/column, when the driver provides one. */
  errorPosition?: SqlErrorPosition;
  returnedColumns: number;
  returnedRows: number;
  affectedRows: number;
  rowCount: number;
  executionTimeMs: number;
  hasTabularResult: boolean;
  isError: boolean;
}

export function executionSummaryItems(tab: Pick<QueryTab, "result" | "results" | "batchSqlExecution">): ExecutionSummaryItem[] {
  const results = tab.results?.length ? tab.results : tab.result ? [tab.result] : [];
  if (tab.batchSqlExecution?.items.length) {
    const resultsByStatementIndex = new Map<number, QueryResult>();
    results.forEach((result, resultIndex) => {
      resultsByStatementIndex.set(result.statement_index ?? resultIndex, result);
    });
    return tab.batchSqlExecution.items.map((item, index) => {
      const result = resultsByStatementIndex.get(item.statementIndex);
      const returnedRows = result?.rows.length ?? 0;
      const affectedRows = item.affectedRows ?? result?.affected_rows ?? 0;
      const hasTabularResult = (result?.columns.length ?? 0) > 0;
      return {
        result,
        index,
        statementIndex: item.statementIndex,
        sql: item.sql,
        sourceFrom: item.from,
        sourceTo: item.to,
        status: item.status,
        error: item.error,
        errorPosition: item.errorDetails?.errorPosition ?? result?.error?.errorPosition,
        returnedColumns: result?.columns.length ?? 0,
        returnedRows,
        affectedRows,
        rowCount: hasTabularResult ? returnedRows : affectedRows,
        executionTimeMs: item.executionTimeMs ?? result?.execution_time_ms ?? 0,
        hasTabularResult,
        isError: item.status === "error",
      };
    });
  }
  return results.map((result, index) => {
    const isError = isQueryExecutionErrorResult(result);
    return {
      result,
      index,
      statementIndex: result.statement_index ?? index,
      sql: result.sourceStatement,
      sourceFrom: result.sourceFrom,
      sourceTo: result.sourceTo,
      status: isError ? "error" : "success",
      error: isError ? String(result.rows[0]?.[0] ?? "") : undefined,
      errorPosition: result.error?.errorPosition,
      returnedColumns: result.columns.length,
      returnedRows: result.rows.length,
      affectedRows: result.affected_rows,
      rowCount: result.columns.length > 0 ? result.rows.length : result.affected_rows,
      executionTimeMs: result.execution_time_ms,
      hasTabularResult: result.columns.length > 0,
      isError,
    };
  });
}

export function tabModeLabel(tab: QueryTab, t: Translate): string {
  if (tab.mode === "data") return t("tabs.table");
  if (tab.mode === "query") return t("tabs.sql");
  if (tab.mode === "mongo") return t("tabs.mongo");
  if (tab.mode === "mongo-gridfs" || tab.mode === "mongo-bucket") return t("tabs.gridfs");
  if (tab.mode === "vector") return t("tabs.vector");
  if (tab.mode === "hbase") return "HBase";
  if (tab.mode === "redis") return t("tabs.redis");
  if (tab.mode === "etcd") return t("tabs.etcd");
  if (tab.mode === "etcd-dashboard") return t("tabs.etcdDashboard");
  if (tab.mode === "etcd-access-control") return t("tabs.etcdAccessControl");
  if (tab.mode === "nacos-access-control") return t("tabs.nacosAccessControl");
  if (tab.mode === "zookeeper") return t("tabs.zookeeper");
  if (tab.mode === "consul") return t("tabs.consul");
  if (tab.mode === "consul-overview") return t("consul.ui.overview");
  if (tab.mode === "nacos") return "Nacos";
  if (tab.mode === "databases") return t("tabs.databases");
  if (isEventObjectBrowserTab(tab)) return t("tree.events");
  if (tab.mode === "objects") return t("tabs.objects");
  if (tab.mode === "users") return t("tabs.users");
  if (tab.mode === "dolt-version-control") return t("doltVersionControl.title");
  return tab.mode;
}

export function tabDatabaseIconType(tab: QueryTab): string {
  const connectionStore = useConnectionStore();
  const connection = connectionStore.getConfig(tab.connectionId);
  if (!connection) return "mq";
  if (connection.db_type === "mq") {
    const externalConfig = connection.external_config as { systemKind?: unknown } | undefined;
    const systemKind = typeof externalConfig?.systemKind === "string" ? externalConfig.systemKind : "";
    if (connection.driver_profile === "kafka" || systemKind === "kafka") return "kafka";
    if (connection.driver_profile === "rocketmq" || systemKind === "rocketmq") return "rocketmq";
    if (connection.driver_profile === "rabbitmq" || systemKind === "rabbitmq") return "rabbitmq";
    if (connection.driver_profile === "pulsar" || systemKind === "pulsar") return "pulsar";
  }
  return connection.driver_profile || connection.db_type;
}

export function tabIconClass(tab: QueryTab): string {
  const connection = useConnectionStore().getConfig(tab.connectionId);
  if (tab.externalSqlFileMissing) return "text-amber-600 dark:text-amber-400";
  if (tab.mode === "mq") return "";
  if (tab.objectSource?.objectType === "VIEW") return "text-purple-500";
  if (tab.objectSource?.objectType === "MATERIALIZED_VIEW") return "text-indigo-500";
  if (tab.objectSource?.objectType === "PROCEDURE") return "text-blue-500";
  if (tab.objectSource?.objectType === "FUNCTION") return "text-amber-500";
  if (tab.objectSource?.objectType === "TRIGGER") return "text-orange-300";
  if (tab.objectSource?.objectType === "EVENT" || tab.objectSource?.objectType === "JOB") return "text-orange-400";
  if (tab.objectSource?.objectType === "SEQUENCE") return "text-emerald-500";
  if (tab.objectSource?.objectType === "SYNONYM") return "text-sky-500";
  if (tab.objectSource?.objectType === "PACKAGE") return "text-cyan-500";
  if (tab.objectSource?.objectType === "PACKAGE_BODY") return "text-cyan-400";
  if (tab.objectSource?.objectType === "TYPE") return "text-violet-500";
  if (tab.objectSource?.objectType === "TYPE_BODY") return "text-violet-400";
  if (isEventObjectBrowserTab(tab)) return "text-orange-400";
  if (tab.mode === "users") return "text-primary";
  if (tab.mode === "redis") return "text-red-400";
  if (tab.mode === "data" && tab.tableMeta?.tableType?.toUpperCase() === "VIEW") return "text-purple-500";
  if (tab.mode === "data" && tab.tableMeta?.tableType?.toUpperCase() === "MATERIALIZED_VIEW") return "text-indigo-500";
  if (tab.mode === "databases" || tab.mode === "objects") return "text-amber-500 dark:text-amber-400";
  if (tab.mode === "data" && connection?.db_type === "dynamodb") return "text-amber-500";
  if (tab.mode === "data" || tab.mode === "hbase") return "text-green-500";
  if (tab.mode === "mongo") return "text-green-400";
  if (tab.mode === "vector") return "text-cyan-400";
  if (tab.mode === "structure") return "text-blue-500";
  // query 的图标是数据库品牌 logo（TabModeIcon），不吃文字颜色；回退的
  // Database 图标自带 text-blue-400，与 mq 模式同样返回空串。
  if (tab.mode === "query") return "";
  return "text-blue-600 dark:text-blue-400";
}

export function tabColorStyle(tab: QueryTab, active: boolean, isClassic: boolean): CSSProperties | undefined {
  const activeIndicator = "inset 0 -2px 0 color-mix(in srgb, var(--foreground) 72%, transparent)";
  const color = connectionColor(tab.connectionId);
  if (!color) {
    if (isClassic) {
      return active ? { "--app-tab-background": "color-mix(in srgb, var(--foreground) 18%, var(--background))", boxShadow: activeIndicator } : undefined;
    }
    return active ? { "--app-tab-background": "color-mix(in srgb, var(--foreground) 18%, var(--background))", borderColor: "var(--ring)" } : undefined;
  }
  if (isClassic) {
    return {
      "--app-tab-background": hexToRgba(color, active ? 0.24 : 0.07),
      "--app-tab-hover-background": hexToRgba(color, 0.14),
      boxShadow: active ? activeIndicator : undefined,
    };
  }
  return {
    "--app-tab-background": hexToRgba(color, active ? 0.24 : 0.09),
    "--app-tab-hover-background": hexToRgba(color, 0.16),
    borderColor: active ? hexToRgba(color, 0.72) : hexToRgba(color, 0.18),
  };
}

export function dirtyTabTitleStyle(isDirty: boolean): CSSProperties | undefined {
  if (!isDirty) {
    return undefined;
  }
  return {
    fontStyle: "italic",
    fontWeight: 700,
    transform: "skewX(-8deg)",
    transformOrigin: "left center",
  };
}
