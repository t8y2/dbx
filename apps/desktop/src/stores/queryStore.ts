import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { computed, markRaw, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BatchSqlExecution, ConnectionConfig, DatabaseType, IndexInfo, ObjectBrowserViewport, QueryResult, QueryTab, TableInfoTab, TableStructureEditorTarget } from "@/types/database";
import { orderPinnedFirst } from "@/lib/app/pinnedItems";
import { canCancelQueryExecution } from "@/lib/sql/queryExecutionState";
import { buildExplainSql, parseExplainResult, parseDamengExplainText, parseOracleExplainText, sqlServerExplainResult, type BuildExplainSqlResult } from "@/lib/diagram/explainPlan";
import { mysqlExplainCompatibilityHint } from "@/lib/diagram/mysqlExplainCompatibility";
import { allEditableColumnsWriteable, allPrimaryKeysPresent, analyzeEditableQueryEditability, resolveMetadataColumnName, sourceColumnsForResult, type EditableQueryInfo, type EditableQuerySource } from "@/lib/sql/sqlAnalysis";
import { buildQueryWithHiddenPrimaryKeys, hiddenResultColumnIndexes, type HiddenPrimaryKeyProjection } from "@/lib/sql/editableQueryHiddenKeys";
import { ACTIVE_TAB_STORAGE_KEY, OPEN_TABS_STORAGE_KEY, restoreOpenTabsPayload, restoreOpenTabsState, serializeOpenTabs } from "@/lib/app/openTabsPersistence";
import {
  evaluateMongoAggregateSafety,
  evaluateMongoWriteSafety,
  mongoCollectionStatsToQueryResult,
  mongoCountToQueryResult,
  mongoDistinctToQueryResult,
  mongoCreateIndexToQueryResult,
  mongoDocumentsToQueryResult,
  describeMongoCommandParseFailure,
  mongoDroppedIndexesToQueryResult,
  mongoFindLogicalTotal,
  mongoIndexesToQueryResult,
  planMongoFindPagination,
  mongoUseToQueryResult,
  mongoVersionToQueryResult,
  mongoWriteToQueryResult,
  splitMongoCommandRanges,
  type MongoAggregateSafetyOptions,
} from "@/lib/mongo/mongoShellCommand";
import { refreshLoadedMongoIndexes } from "@/lib/mongo/mongoIndexMetadata";
import { redisCommandResultToQueryResult } from "@/lib/redis/redisQueryResult";
import { nextRedisCommandDb } from "@/lib/redis/redisCommandSession";
import { isRedisMutatingCommand } from "@/lib/redis/redisCommandTable";
import { usesAgentCursorForQuery } from "@/lib/database/databaseDriverManifest";
import { supportsClearableQuerySchema } from "@/lib/database/databaseFeatureSupport";
import { canUseKeylessRowPredicate, DBX_ROWID_COLUMN, editablePrimaryKeys, usesSyntheticRowIdKey } from "@/lib/table/tableEditing";
import { TABLE_DATA_EXPORT_PAGE_SIZE } from "@/lib/table/tableDataExport";
import { tableMetaForDataTab } from "@/lib/table/tableDataTabMeta";
import { dataTabExecutionDatabase } from "@/lib/table/dataTabExecutionDatabase";
import { tableOpenPageLimit } from "@/lib/table/tableOpenPageLimit";
import { getCachedTableMetadata, loadTableIndexes, loadTableMetadata, type TableMetadataRequest } from "@/lib/metadata/tableMetadataCache";
import { buildTableSelectSql, quoteTableDataIdentifier } from "@/lib/table/tableSelectSql";
import { connectionObjectTreeNodeSchema, connectionQueryExecutionSchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection, metadataSchemaForConnection } from "@/lib/database/jdbcDialect";
import { frontendQueryTimeoutSecsForSql, queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import { queryResultNameFromPreamble, queryResultSourceLabel } from "@/lib/sql/queryResultSource";
import { beginDataGridNativeSelectionBlock, finishDataGridNativeSelectionBlock } from "@/lib/dataGrid/dataGridNativeSelection";
import { simpleDataGridOrderByReferencesMissingColumn, sortDataGridRowIndexes, type DataGridSortDirection } from "@/lib/dataGrid/dataGridSort";
import { MAX_RESULT_PAGE_SIZE, normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { elasticsearchRestRequestRanges, executableStatementRanges, splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { externalSqlFileDisplayTitles, normalizeExternalSqlPath } from "@/lib/sql/sqlFileOpen";
import { clearDataGridPendingSnapshotsForTab } from "@/composables/useDataGridEditor";
import { buildTabResultSnapshot, deleteTabResultSnapshot, pruneTabResultSnapshots, readTabResultSnapshot, tabResultCacheKey, writeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import { estimateQueryResultsBytes, selectInactiveResultEvictions } from "@/lib/tabs/queryResultSize";
import { queryResultBaseSql, queryResultExecutionSql } from "@/lib/tabs/tabPresentation";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import { decodeQueryResultArchive, encodeQueryResultArchive, type DecodedQueryResultArchive } from "@/lib/query/queryResultArchive";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useExportTracker } from "@/composables/useExportTracker";
import { recordQueryCancellationLatency, resourceLifecycleDiagnostics } from "@/lib/diagnostics/resourceLifecycleDiagnostics";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { BackendErrorException, formatError, normalizeBackendError, type BackendError } from "@/lib/backend/errorUtils";
import { createSavedSqlEditorPosition, initSavedSqlEditorPositions, restoreSavedSqlEditorPosition, saveSavedSqlEditorPosition } from "@/lib/app/savedSqlEditorPosition";
import { ensureSqlExtension } from "@/lib/savedSql/savedSqlFileName";
import { resolveSavedSqlExecutionTarget, savedSqlExecutionTargetFromTab, type SavedSqlExecutionTarget, type SavedSqlOpenTargetMode } from "@/lib/savedSql/savedSqlExecutionTarget";
import { safeLocalStorageGet, safeLocalStorageRemove } from "@/lib/backend/safeStorage";
import { sqlTextFingerprint } from "@/lib/sql/sqlTextFingerprint";
import type { SavedSqlFile } from "@/types/database";
import i18n from "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";

const ORACLE_LIKE_METADATA_TYPES = new Set<string>(["oracle", "dameng", "oceanbase-oracle"]);
const HIDDEN_QUERY_KEY_DATABASE_TYPES = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "oracle"]);
const QUERY_RESULT_EXPORT_UNSUPPORTED_ERROR = "Streaming export is unsupported for this query. Simplify it or use a supported driver.";
const BACKGROUND_CLIENT_SESSION_SUFFIXES = ["count", "explain", "export"] as const;
const CANCEL_QUERY_TIMEOUT_MS = 10_000;
const CANCEL_ACK_SETTLE_TIMEOUT_MS = 2_000;
const SAVED_SQL_EDITOR_POSITION_PERSIST_DELAY_MS = 500;
type CloseConfirmContext = "tab" | "batch" | "app";

function hasHiddenPhysicalRowKey(databaseType: DatabaseType | undefined, hiddenPrimaryKeys: HiddenPrimaryKeyProjection[]): boolean {
  return hiddenPrimaryKeys.some((projection) => !usesSyntheticRowIdKey(databaseType, [projection.sourceName]));
}

function cloneTabDraft<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface BuildQueryResultExportRequestOptions {
  exportId: string;
  filePath: string;
  format: "csv" | "xlsx" | "txt" | "sql";
  includeSqlSheet?: boolean;
  exportTableName?: string;
  exportColumnTypes?: Array<string | null | undefined>;
}

interface OpenSavedSqlOptions {
  targetMode?: SavedSqlOpenTargetMode;
}

interface UpdateExecutionTargetOptions {
  persistSavedSqlTarget?: boolean;
}

type DroppedTableObjectType = "TABLE" | "VIEW" | "MATERIALIZED_VIEW";

interface DroppedTableObjectTarget {
  connectionId: string;
  database: string;
  schema?: string;
  schemaCandidates?: Array<string | undefined>;
  name: string;
  objectType?: DroppedTableObjectType;
}

interface TableDataRefreshTarget {
  connectionId: string;
  database: string;
  schema?: string;
  schemaCandidates?: Array<string | undefined>;
  catalog?: string;
  name: string;
}

function tabClientSessionId(tab: Pick<QueryTab, "id">, suffix?: (typeof BACKGROUND_CLIENT_SESSION_SUFFIXES)[number]): string {
  return suffix ? `${tab.id}:${suffix}` : tab.id;
}

function resultRunCacheKey(tabId: string, runId: string): string {
  return `tab:${tabId}:run:${runId}`;
}

function normalizeOptionalSchema(schema: string | null | undefined): string {
  return schema?.trim() ?? "";
}

function droppedTableObjectSchemaCandidates(target: DroppedTableObjectTarget): Set<string> {
  const schemas = target.schemaCandidates?.length ? target.schemaCandidates : [target.schema];
  return new Set(schemas.map(normalizeOptionalSchema));
}

function markQueryResultRowsRaw(result: QueryResult): QueryResult {
  markRaw(result.rows);
  if (result.mongo_documents) markRaw(result.mongo_documents);
  if (result.mongo_copy_documents) markRaw(result.mongo_copy_documents);
  return result;
}

function markQueryResultsRowsRaw(results: QueryResult[]): QueryResult[] {
  for (const result of results) markQueryResultRowsRaw(result);
  return results;
}

function exactTotalFromIncompletePage(result: QueryResult, pageLimit: number | undefined, pageOffset: number | undefined, useAgentResultSession: boolean | undefined): number | undefined {
  if (typeof pageLimit !== "number" || result.rows.length >= pageLimit || result.truncated === true) return undefined;
  // Cursor-backed drivers must explicitly confirm exhaustion; an omitted
  // has_more value may come from an older driver or an exhausted row cap.
  if (useAgentResultSession && result.has_more !== false) return undefined;
  return (pageOffset ?? 0) + result.rows.length;
}

export function appendQueryResultSegment(previous: QueryResult, segment: QueryResult, maxRows: number): QueryResult {
  if (segment.execution_error) {
    throw segment.error ? new BackendErrorException(segment.error) : new BackendErrorException(String(segment.rows[0]?.[0] ?? "Failed to load the next result segment"));
  }
  if (previous.columns.length !== segment.columns.length || previous.columns.some((column, index) => column !== segment.columns[index])) {
    throw new Error("Result columns changed while loading the next segment");
  }
  const remainingRows = Math.max(0, maxRows - previous.rows.length);
  const appendedRowCount = Math.min(remainingRows, segment.rows.length);
  const appendParallelValues = <T>(existing: T[] | undefined, next: T[] | undefined): T[] | undefined => {
    if (!existing || !next) return undefined;
    if (existing.length !== previous.rows.length || next.length !== segment.rows.length) return undefined;
    return [...existing, ...next.slice(0, appendedRowCount)];
  };
  const sridByColumn = new Map<number, number | null>();
  for (const column of previous.spatial_columns ?? []) {
    sridByColumn.set(column.column_index, column.srid);
  }
  for (const column of segment.spatial_columns ?? []) {
    const existing = sridByColumn.get(column.column_index) ?? null;
    sridByColumn.set(column.column_index, existing ?? column.srid);
  }
  const spatial_columns = Array.from(sridByColumn.entries())
    .map(([column_index, srid]) => ({ column_index, srid }))
    .sort((a, b) => a.column_index - b.column_index);
  // Keep prior row objects intact so source-index based dirty/new/deleted state
  // remains valid, while bounding the in-memory result by the configured cap.
  return markQueryResultRowsRaw({
    ...segment,
    appended_from_row_count: previous.rows.length,
    rows: [...previous.rows, ...segment.rows.slice(0, appendedRowCount)],
    spatial_columns: spatial_columns.length > 0 ? spatial_columns : undefined,
    spatial_values: appendParallelValues(previous.spatial_values, segment.spatial_values),
    mongo_documents: appendParallelValues(previous.mongo_documents, segment.mongo_documents),
    mongo_copy_documents: appendParallelValues(previous.mongo_copy_documents, segment.mongo_copy_documents),
    execution_time_ms: (previous.execution_time_ms ?? 0) + (segment.execution_time_ms ?? 0),
    has_more: previous.rows.length + appendedRowCount >= maxRows ? false : segment.has_more,
  });
}

function markQueryResultRunsRowsRaw(resultRuns: NonNullable<QueryTab["resultRuns"]>): NonNullable<QueryTab["resultRuns"]> {
  for (const run of resultRuns) {
    if (run.result) markQueryResultRowsRaw(run.result);
    if (run.results) markQueryResultsRowsRaw(run.results);
    if (run.resultLocalSortOriginalRows) markRaw(run.resultLocalSortOriginalRows);
    if (run.resultLocalSortOriginalMongoDocuments) markRaw(run.resultLocalSortOriginalMongoDocuments);
    if (run.resultLocalSortOriginalMongoCopyDocuments) markRaw(run.resultLocalSortOriginalMongoCopyDocuments);
  }
  return resultRuns;
}

function preservedResultIndex(results: QueryResult[], currentIndex: number | undefined, preserve: boolean | undefined): number | undefined {
  if (preserve !== true || typeof currentIndex !== "number" || currentIndex < 0 || currentIndex >= results.length) return undefined;
  return currentIndex;
}

function annotateQueryResultSources(results: QueryResult[], sql: string, database: string | undefined, databaseType?: DatabaseType, sourceOffset?: number): QueryResult[] {
  const statements = splitSqlStatementRanges(sql, databaseType);
  let statementIndex = 0;
  for (const result of results) {
    const explicitIndex = Number.isInteger(result.statement_index) && result.statement_index! >= 0 ? result.statement_index : undefined;
    const sourceIndex = explicitIndex ?? statementIndex;
    statementIndex = Math.max(statementIndex, sourceIndex + 1);
    const statement = statements[sourceIndex];
    if (!statement) continue;
    annotateQueryResultSource(result, statement.sql, database, databaseType, sourceOffset === undefined ? undefined : { from: sourceOffset + statement.from, to: sourceOffset + statement.to });
    const customName = queryResultNameFromPreamble(sql.slice(statement.hitFrom, statement.from));
    if (customName) result.sourceLabel = customName;
  }
  return results;
}

const NON_STREAMING_BATCH_DATABASE_TYPES = new Set<DatabaseType>(["sqlserver", "turso", "cloudflare-d1"]);
const liveBatchSqlExecutions = new WeakMap<QueryTab, BatchSqlExecution>();

function cloneBatchSqlExecution(batch: BatchSqlExecution | undefined): BatchSqlExecution | undefined {
  return batch ? { ...batch, items: batch.items.map((item) => ({ ...item })) } : undefined;
}

function batchSqlExecutionFor(tab: QueryTab, executionId: string): BatchSqlExecution | undefined {
  const liveBatch = liveBatchSqlExecutions.get(tab);
  if (liveBatch?.executionId === executionId) return liveBatch;
  return tab.batchSqlExecution?.executionId === executionId ? tab.batchSqlExecution : undefined;
}

function clearLiveBatchSqlExecution(tab: QueryTab, executionId: string) {
  if (liveBatchSqlExecutions.get(tab)?.executionId === executionId) liveBatchSqlExecutions.delete(tab);
}

function createBatchSqlExecution(executionId: string, editorSql: string, submittedSql: string, databaseType: DatabaseType | undefined, sourceOffset: number | undefined): BatchSqlExecution | undefined {
  const statements = splitSqlStatementRanges(submittedSql, databaseType);
  if (statements.length === 0) return undefined;
  if (statements.length > 1 && databaseType && NON_STREAMING_BATCH_DATABASE_TYPES.has(databaseType)) return undefined;
  const offset = sourceOffset ?? 0;
  return {
    executionId,
    submittedSql,
    editorFingerprint: sqlTextFingerprint(editorSql),
    sourceOffset: offset,
    completed: 0,
    total: statements.length,
    startedAt: Date.now(),
    items: statements.map((statement, statementIndex) => ({
      statementIndex,
      sql: statement.sql,
      from: offset + statement.from,
      to: offset + statement.to,
      status: statementIndex === 0 ? "running" : "pending",
    })),
  };
}

function applyBatchSqlProgress(
  tab: QueryTab,
  progress: {
    executionId: string;
    statementIndex: number;
    completed: number;
    total: number;
    success: boolean;
    executionTimeMs: number;
    affectedRows: number;
    error?: BackendError;
  },
  continueOnError: boolean,
) {
  const batch = batchSqlExecutionFor(tab, progress.executionId);
  if (!batch) return;
  const item = batch.items[progress.statementIndex];
  if (!item) return;
  item.status = progress.success ? "success" : "error";
  item.executionTimeMs = progress.executionTimeMs;
  item.affectedRows = progress.affectedRows;
  item.errorDetails = progress.error;
  item.error = progress.error ? translateBackendError(i18n.global.t, progress.error) : undefined;
  batch.completed = Math.max(batch.completed, progress.completed);
  if ((progress.success || continueOnError) && progress.completed < batch.total) {
    const next = batch.items[progress.statementIndex + 1];
    if (next?.status === "pending") next.status = "running";
  }
}

function reconcileBatchSqlResults(tab: QueryTab, executionId: string, results: QueryResult[]) {
  const batch = batchSqlExecutionFor(tab, executionId);
  if (!batch) return;
  let fallbackIndex = 0;
  for (const result of results) {
    const statementIndex = Number.isInteger(result.statement_index) && result.statement_index! >= 0 ? result.statement_index! : fallbackIndex;
    fallbackIndex = Math.max(fallbackIndex, statementIndex + 1);
    const item = batch.items[statementIndex];
    if (!item) continue;
    const failed = result.execution_error === true;
    item.status = failed ? "error" : "success";
    item.executionTimeMs = result.execution_time_ms;
    item.affectedRows = result.affected_rows;
    item.errorDetails = failed ? result.error : undefined;
    item.error = failed ? (result.error ? translateBackendError(i18n.global.t, result.error) : String(result.rows[0]?.[0] ?? "")) : undefined;
  }
  batch.completed = batch.items.filter((item) => item.status === "success" || item.status === "error").length;
}

function failBatchSqlExecution(tab: QueryTab, executionId: string, error: unknown, cancelled: boolean) {
  const batch = batchSqlExecutionFor(tab, executionId);
  if (!batch) return;
  const item = batch.items.find((candidate) => candidate.status === "running") ?? batch.items.find((candidate) => candidate.status === "pending");
  if (!item) return;
  item.status = cancelled ? "cancelled" : "error";
  item.errorDetails = cancelled ? undefined : (normalizeBackendError(error) ?? undefined);
  item.error = cancelled ? undefined : translateBackendError(i18n.global.t, error);
  batch.completed = batch.items.filter((candidate) => candidate.status === "success" || candidate.status === "error").length;
}

function finishBatchSqlExecution(tab: QueryTab, executionId: string, cancelled: boolean) {
  const batch = batchSqlExecutionFor(tab, executionId);
  if (!batch) return;
  if (cancelled) {
    const cancelledError = [...batch.items].reverse().find((item) => item.status === "error" && (item.errorDetails?.code === "DBX-JDBC-2003" || /cancel|取消/i.test(item.error ?? "")));
    if (cancelledError) {
      cancelledError.status = "cancelled";
      cancelledError.error = undefined;
    }
  }
  let markedCancelled = false;
  for (const item of batch.items) {
    if (item.status === "running" && cancelled && !markedCancelled) {
      item.status = "cancelled";
      markedCancelled = true;
    } else if (item.status === "running" || item.status === "pending") {
      item.status = "skipped";
    }
  }
  batch.completed = batch.items.filter((item) => item.status === "success" || item.status === "error").length;
  batch.finishedAt = Date.now();
}

function sqlStatementWithoutLeadingComments(statement: string | undefined): string {
  let remaining = statement?.trimStart() ?? "";
  while (remaining) {
    if (remaining.startsWith("--")) {
      const newline = remaining.indexOf("\n");
      remaining = newline < 0 ? "" : remaining.slice(newline + 1).trimStart();
      continue;
    }
    if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end < 0) return "";
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  return remaining;
}

function isOracleCurrentSchemaStatement(statement: string | undefined): boolean {
  return /^ALTER\s+SESSION\s+SET\s+CURRENT_SCHEMA\s*=/i.test(sqlStatementWithoutLeadingComments(statement));
}

function isSapHanaSetSchemaStatement(statement: string | undefined): boolean {
  return /^SET\s+SCHEMA\s+(?:"(?:[^"]|"")*"|[A-Za-z_][\w$#]*)\s*;?\s*$/i.test(sqlStatementWithoutLeadingComments(statement));
}

function sqlServerUseDatabaseFromStatement(statement: string | undefined): string | undefined {
  const match = /^USE\s+(?:\[((?:[^\]]|\]\])*)\]|"((?:[^"]|"")*)"|([A-Za-z_][\w@$#]*))\s*;?\s*$/i.exec(sqlStatementWithoutLeadingComments(statement));
  if (!match) return undefined;
  if (match[1] !== undefined) return match[1].replaceAll("]]", "]");
  if (match[2] !== undefined) return match[2].replaceAll('""', '"');
  return match[3];
}

function isSqlServerBatchErrorResult(result: QueryResult): boolean {
  return result.execution_error === true;
}

function sapHanaCurrentSchemaFromResult(result: QueryResult): string | undefined {
  const schema = result.rows[0]?.[0];
  return typeof schema === "string" && schema.trim() ? schema.trim() : undefined;
}

function annotateQueryResultSource(result: QueryResult, sourceStatement: string, database?: string, databaseType?: DatabaseType, sourceRange?: { from: number; to: number }): QueryResult {
  result.sourceStatement = sourceStatement;
  if (sourceRange) {
    result.sourceFrom = sourceRange.from;
    result.sourceTo = sourceRange.to;
  }
  const label = databaseType ? queryResultSourceLabel(sourceStatement, { database, databaseType }) : undefined;
  if (label) result.sourceLabel = label;
  return result;
}

function elasticsearchHttpErrorStatus(result: QueryResult): number | undefined {
  const statusIndex = result.columns.findIndex((column) => column.toLowerCase() === "status");
  if (statusIndex < 0) return undefined;
  const value = result.rows[0]?.[statusIndex];
  const status = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(status) && status >= 400 ? status : undefined;
}

function displayedQueryMetadataSql(tab: QueryTab, fallbackSql: string): string {
  return tab.results?.length ? (tab.result?.sourceStatement ?? fallbackSql) : fallbackSql;
}

async function withFrontendQueryTimeout<T>(promise: Promise<T>, timeoutSecs: number, message: string): Promise<T> {
  if (timeoutSecs === 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutSecs * 1000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withCancelQueryTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Cancel request timed out after 10s.")), CANCEL_QUERY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeOracleLikeMetadataIdentifier(dbType: string, identifier: string | undefined, quoted?: boolean) {
  if (!identifier || quoted || !ORACLE_LIKE_METADATA_TYPES.has(dbType)) return identifier;
  return identifier.toUpperCase();
}

function normalizeOracleLikeQueryAnalysis(dbType: string, analysis: EditableQueryInfo, schema: string | undefined, tableName: string): EditableQueryInfo {
  if (!ORACLE_LIKE_METADATA_TYPES.has(dbType)) return analysis;
  return {
    ...analysis,
    schema,
    tableName,
    sources: analysis.sources?.map((source) => ({
      ...source,
      schema: normalizeOracleLikeMetadataIdentifier(dbType, source.schema, source.schemaQuoted),
      tableName: normalizeOracleLikeMetadataIdentifier(dbType, source.tableName, source.tableNameQuoted)!,
    })),
    columns: analysis.columns.map((column) => ({
      ...column,
      sourceName: normalizeOracleLikeMetadataIdentifier(dbType, column.sourceName, column.sourceNameQuoted),
    })),
  };
}

function editableQuerySources(analysis: EditableQueryInfo): EditableQuerySource[] {
  return analysis.sources?.length
    ? analysis.sources
    : [
        {
          key: `${analysis.tableAlias ?? analysis.tableName}:0`,
          catalog: analysis.catalog,
          catalogQuoted: analysis.catalogQuoted,
          schema: analysis.schema,
          schemaQuoted: analysis.schemaQuoted,
          tableName: analysis.tableName,
          tableNameQuoted: analysis.tableNameQuoted,
          alias: analysis.tableAlias,
        },
      ];
}

function projectsAllColumnsForSource(analysis: EditableQueryInfo, sourceKey: string): boolean {
  return analysis.selectStar || analysis.columns.some((column) => column.star && (!column.sourceKey || column.sourceKey === sourceKey));
}

function cloneAnalysisForSource(analysis: EditableQueryInfo, source: EditableQuerySource): EditableQueryInfo {
  return {
    ...analysis,
    catalog: source.catalog,
    catalogQuoted: source.catalogQuoted,
    schema: source.schema,
    schemaQuoted: source.schemaQuoted,
    tableName: source.tableName,
    tableNameQuoted: source.tableNameQuoted,
    tableAlias: source.alias,
    editableSourceKey: source.key,
    allowInsertDelete: analysis.sources?.length || analysis.distinct ? false : analysis.allowInsertDelete,
  };
}

function resolveSourceColumnName(dbType: string, columnName: string, quoted: boolean | undefined, tableColumns: readonly { name: string }[]): string | undefined {
  return resolveMetadataColumnName(
    dbType,
    columnName,
    quoted,
    tableColumns.map((column) => column.name),
  );
}

function bindColumnsForSource(
  dbType: string,
  analysis: EditableQueryInfo,
  source: EditableQuerySource,
  tableColumns: readonly { name: string }[],
  allSourceColumns: Array<{ source: EditableQuerySource; columns: readonly { name: string }[] }> = [{ source, columns: tableColumns }],
): EditableQueryInfo {
  return {
    ...analysis,
    columns: analysis.columns.map((column) => {
      if (!column.sourceName) return column;
      if (column.sourceKey) {
        if (column.sourceKey !== source.key) return column;
        const canonicalName = resolveSourceColumnName(dbType, column.sourceName, column.sourceNameQuoted, tableColumns);
        return { ...column, sourceName: canonicalName };
      }
      if (column.sourceQualifier) return column;
      const matchingSources = allSourceColumns.flatMap((entry) => {
        const canonicalName = resolveSourceColumnName(dbType, column.sourceName!, column.sourceNameQuoted, entry.columns);
        return canonicalName ? [{ source: entry.source, canonicalName }] : [];
      });
      if (matchingSources.length !== 1 || matchingSources[0]?.source.key !== source.key) return column;
      return { ...column, sourceName: matchingSources[0].canonicalName, sourceKey: source.key };
    }),
  };
}

function primaryKeysPresentForSource(dbType: string, primaryKeys: string[], resultColumns: string[], analysis: EditableQueryInfo, sourceKey: string, tableColumns: readonly { name: string }[]): boolean {
  if (!analysis.selectStar) return allPrimaryKeysPresent(primaryKeys, resultColumns, analysis, sourceKey);
  const metadataNames = tableColumns.map((column) => column.name);
  const canonicalResultColumns = resultColumns.flatMap((column) => {
    const canonicalName = resolveMetadataColumnName(dbType, column, undefined, metadataNames);
    return canonicalName ? [canonicalName] : [];
  });
  return allPrimaryKeysPresent(primaryKeys, canonicalResultColumns);
}

function expandStarProjectionColumnsForSource(analysis: EditableQueryInfo, source: EditableQuerySource, tableColumns: readonly { name: string }[]): EditableQueryInfo {
  if (analysis.selectStar || !analysis.columns.some((column) => column.star)) return analysis;
  return {
    ...analysis,
    columns: analysis.columns.flatMap((column) => {
      if (!column.star) return [column];
      if (column.sourceKey && column.sourceKey !== source.key) return [column];
      return tableColumns.map((tableColumn) => ({
        sourceName: tableColumn.name,
        sourceNameQuoted: false,
        ...(column.sourceQualifier ? { sourceQualifier: column.sourceQualifier } : {}),
        sourceKey: source.key,
        resultName: tableColumn.name,
        expression: column.sourceQualifier ? `${column.sourceQualifier}.${tableColumn.name}` : tableColumn.name,
      }));
    }),
  };
}

let saveTabsQueue = Promise.resolve();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistGeneration = 0;

function saveTabs(tabs: QueryTab[], activeTabId: string | null): Promise<void> {
  const payload = { tabs: serializeOpenTabs(tabs), activeTabId };
  saveTabsQueue = saveTabsQueue.catch(() => undefined).then(() => api.saveOpenTabsState(payload));
  return saveTabsQueue;
}

function loadLegacySavedTabs(): { rawTabs: string | null; rawActiveTabId: string | null } {
  return {
    rawTabs: safeLocalStorageGet(OPEN_TABS_STORAGE_KEY),
    rawActiveTabId: safeLocalStorageGet(ACTIVE_TAB_STORAGE_KEY),
  };
}

function clearLegacySavedTabs() {
  safeLocalStorageRemove(OPEN_TABS_STORAGE_KEY);
  safeLocalStorageRemove(ACTIVE_TAB_STORAGE_KEY);
}

function restoreSavedTabsFromPayload(payload: { tabs?: unknown; activeTabId?: unknown } | null | undefined, options: { validConnectionIds?: Iterable<string> } = {}): { tabs: QueryTab[]; activeTabId: string | null } {
  const restoreMode = useSettingsStore().editorSettings.openTabsRestoreMode;
  if (restoreMode === "none") return { tabs: [], activeTabId: null };
  return restoreOpenTabsPayload(payload, {
    filter: restoreMode === "pinned" ? "pinned" : "all",
    validConnectionIds: options.validConnectionIds,
  });
}

function restoreLegacySavedTabs(options: { validConnectionIds?: Iterable<string> } = {}): { tabs: QueryTab[]; activeTabId: string | null } {
  const restoreMode = useSettingsStore().editorSettings.openTabsRestoreMode;
  if (restoreMode === "none") return { tabs: [], activeTabId: null };
  const legacy = loadLegacySavedTabs();
  return restoreOpenTabsState(legacy.rawTabs, legacy.rawActiveTabId, {
    filter: restoreMode === "pinned" ? "pinned" : "all",
    validConnectionIds: options.validConnectionIds,
  });
}

function getI18nT() {
  try {
    return useI18n().t;
  } catch {
    return ((key: string, ..._args: unknown[]) => key) as ReturnType<typeof useI18n>["t"];
  }
}

export const useQueryStore = defineStore("query", () => {
  const t = getI18nT();
  const settingsStore = useSettingsStore();
  const tabs = ref<QueryTab[]>([]);
  // A stable Set of "connectionId\x00database" keys. Computed only from the
  // minimal tab identity fields so that it does NOT invalidate when other
  // properties change (isExecuting, result, sql, tableMeta...). Previously
  // isDatabaseOpen() called tabs.value.some() which tracked the full reactive
  // array — every mutation during openData() forced all database-type sidebar
  // TreeItems to recompute showsDatabaseOpenIndicator.
  const openDatabaseKeys = computed(() => {
    const keys = new Set<string>();
    for (const tab of tabs.value) {
      if (tab.connectionId && tab.database != null) {
        keys.add(`${tab.connectionId}\x00${tab.database}`);
      }
    }
    return keys;
  });
  const activeTabId = ref<string | null>(null);
  const isOpenTabsLoaded = ref(false);
  const activeTabHistory = ref<string[]>([]);
  const showCloseConfirm = ref(false);
  const pendingCloseTabId = ref<string | null>(null);
  const pendingBatchCloseTabIds = ref<string[] | null>(null);
  const pendingBatchCloseFinalActiveTabId = ref<string | null | undefined>(undefined);
  let pendingBatchCloseComplete: (() => void) | null = null;
  const isConfirmingAppClose = ref(false);
  const closeConfirmContext = ref<CloseConfirmContext>("tab");
  const tableStructureRefreshVersions = ref<Record<string, number>>({});
  const savedSqlEditorPositionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTabSessionResets = new Map<string, Promise<void>>();
  const pendingResultRunRestores = new Map<string, string>();
  let resultCacheTrimScheduled = false;
  let resultCacheTrimRunning = false;
  let resultCacheTrimRequested = false;

  function tableStructureKey(connectionId: string, database: string, schema: string | undefined, tableName: string): string {
    return [connectionId, database, schema || "", tableName].map((part) => part.toLowerCase()).join("\u0000");
  }

  function invalidateTableStructure(connectionId: string, database: string, schema: string | undefined, tableName: string) {
    if (!tableName) return;
    const key = tableStructureKey(connectionId, database, schema, tableName);
    tableStructureRefreshVersions.value = {
      ...tableStructureRefreshVersions.value,
      [key]: (tableStructureRefreshVersions.value[key] ?? 0) + 1,
    };
    for (const tab of tabs.value) {
      if (tab.mode !== "query" || tab.connectionId !== connectionId || tab.database !== database) continue;
      tab.completionContextVersion = (tab.completionContextVersion ?? 0) + 1;
    }
  }

  function tableStructureRefreshVersion(connectionId: string, database: string, schema: string | undefined, tableName: string): number {
    return tableStructureRefreshVersions.value[tableStructureKey(connectionId, database, schema, tableName)] ?? 0;
  }
  const MAX_CACHED_RESULTS = 5;
  const MAX_CACHED_RESULT_BYTES = 128 * 1024 * 1024;

  function queryExecutionLog(level: "debug" | "info" | "warn" | "error", event: string, details: Record<string, unknown>) {
    appendDebugLog(level, `[DBX][executeTabSql:${event}]`, details);
  }

  async function refreshLoadedMongoIndexesAfterMutation(connectionId: string, database: string, collection: string, traceId: string) {
    const connStore = useConnectionStore();
    try {
      await refreshLoadedMongoIndexes(connStore, { connectionId, database, collection });
    } catch (error) {
      queryExecutionLog("warn", "mongo-indexes:refresh-failed", {
        traceId,
        connectionId,
        database,
        collection,
        error: formatError(error),
      });
    }
  }

  async function closeResultSession(tab: QueryTab | undefined, preserveSessionId?: string, throwOnError = false) {
    const sessionId = tab?.resultSessionId ?? tab?.result?.session_id;
    if (!tab || !sessionId || sessionId === preserveSessionId) return;
    try {
      const catalog = tab.mode === "data" ? tab.tableMeta?.catalog : tab.catalog;
      const connection = catalog ? useConnectionStore().getConfig(tab.connectionId) : undefined;
      const executionDatabase = dataTabExecutionDatabase(connection, tab.database, catalog);
      if (catalog) await api.closeQuerySession(tab.connectionId, executionDatabase, sessionId, tab.id, catalog);
      else await api.closeQuerySession(tab.connectionId, executionDatabase, sessionId, tab.id);
    } catch (error) {
      console.warn("[DBX][query-session:close:error]", { tabId: tab.id, sessionId, error });
      if (throwOnError) throw error;
    } finally {
      if (tab.resultSessionId === sessionId) tab.resultSessionId = undefined;
      if (tab.result?.session_id === sessionId) {
        tab.result.session_id = undefined;
        // 原地修改了负载，让持有它的 tab 与 run 的估算值都失效
        invalidateResultEstimateForPayload(tab.result);
      }
    }
  }

  async function closeClientSessionId(connectionId: string, database: string, clientSessionId: string, catalog: string | undefined, logContext: Record<string, unknown> = {}, throwOnError = false) {
    try {
      if (catalog) await api.closeClientConnectionSession(connectionId, database, clientSessionId, catalog);
      else await api.closeClientConnectionSession(connectionId, database, clientSessionId);
    } catch (error) {
      console.warn("[DBX][client-session:close:error]", { ...logContext, clientSessionId, error });
      if (throwOnError) throw error;
    }
  }

  async function closeClientConnectionSession(tab: QueryTab | undefined, throwOnError = false) {
    if (!tab?.connectionId) return;
    const catalog = tab.mode === "data" ? tab.tableMeta?.catalog : tab.catalog;
    const connection = catalog ? useConnectionStore().getConfig(tab.connectionId) : undefined;
    const executionDatabase = dataTabExecutionDatabase(connection, tab.database, catalog);
    const clientSessionIds = [...new Set([tabClientSessionId(tab), ...BACKGROUND_CLIENT_SESSION_SUFFIXES.map((suffix) => tabClientSessionId(tab, suffix)), tab.explainClientSessionId].filter((sessionId): sessionId is string => !!sessionId))];
    for (const clientSessionId of clientSessionIds) {
      await closeClientSessionId(tab.connectionId, executionDatabase, clientSessionId, catalog, { tabId: tab.id }, throwOnError);
    }
  }

  function queueTabSessionReset(tab: QueryTab) {
    tab.completionContextVersion = (tab.completionContextVersion ?? 0) + 1;
    const previousReset = pendingTabSessionResets.get(tab.id);
    const reset = (async () => {
      if (previousReset) await previousReset;
      // A schema reset must fail closed: reusing the old session would retain Oracle CURRENT_SCHEMA.
      await closeResultSession(tab, undefined, true);
      await closeClientConnectionSession(tab, true);
    })();
    pendingTabSessionResets.set(tab.id, reset);
    const clearPendingReset = () => {
      if (pendingTabSessionResets.get(tab.id) === reset) pendingTabSessionResets.delete(tab.id);
    };
    void reset.then(clearPendingReset, clearPendingReset);
  }

  async function waitForTabSessionReset(tabId: string) {
    while (true) {
      const pendingReset = pendingTabSessionResets.get(tabId);
      if (!pendingReset) return;
      await pendingReset;
      if (pendingTabSessionResets.get(tabId) === pendingReset) pendingTabSessionResets.delete(tabId);
    }
  }

  function touchResult(tab: QueryTab | undefined, accessedAt = Date.now(), options: { reuseEstimatedBytes?: boolean } = {}) {
    if (tab?.result || tab?.results) {
      tab.resultAccessedAt = accessedAt;
      // 纯访问路径（如切换标签页）可复用已算好的估算值：estimateQueryResultsBytes
      // 会同步深遍历整份结果集，挂在 sync watch 上会直接阻塞切页交互。
      if (!options.reuseEstimatedBytes || tab.resultEstimatedBytes === undefined) {
        tab.resultEstimatedBytes = estimateQueryResultsBytes(tab.result, tab.results);
      }
      tab.resultCacheState = "memory";
      tab.resultEvicted = undefined;
    }
  }

  /** 结果负载被原地修改（如保存后写回单元格）时，让持有它的 tab/run 的字节估算失效，下次访问按需重算。 */
  function invalidateResultEstimateForPayload(result: QueryResult | undefined) {
    if (!result) return;
    for (const tab of tabs.value) {
      if (tab.result === result || tab.results?.includes(result)) tab.resultEstimatedBytes = undefined;
      for (const run of tab.resultRuns ?? []) {
        if (run.result === result || run.results?.includes(result)) run.resultEstimatedBytes = undefined;
      }
    }
  }

  function clearResultPayload(tab: QueryTab, options: { evicted?: boolean; preserveCacheSnapshot?: boolean } = {}) {
    tab.result = undefined;
    tab.results = undefined;
    tab.activeResultIndex = undefined;
    tab.batchSqlExecution = undefined;
    tab.resultEditorFingerprint = undefined;
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultLocalSortOriginalMongoDocuments = undefined;
    tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    tab.resultSortMode = undefined;
    tab.resultSessionId = undefined;
    tab.resultAccessedAt = undefined;
    tab.resultEstimatedBytes = undefined;
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    tab.mongoEditTarget = undefined;
    if (tab.mode === "query") tab.tableMeta = undefined;
    tab.resultEvicted = options.evicted ? true : undefined;
    tab.resultCacheState = options.evicted ? tab.resultCacheState : undefined;
    if (!options.evicted) {
      if (tab.resultCacheKey && !options.preserveCacheSnapshot) void deleteTabResultSnapshot(tab.resultCacheKey);
      tab.resultCacheKey = undefined;
    }
  }

  function clearResultNavigationState(tab: QueryTab) {
    tab.resultSortedSql = undefined;
    tab.resultSortColumn = undefined;
    tab.resultSortColumnIndex = undefined;
    tab.resultSortDirection = undefined;
    tab.resultSortMode = undefined;
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultLocalSortOriginalMongoDocuments = undefined;
    tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    tab.orderByInput = undefined;
    tab.resultPageSql = undefined;
    tab.resultPageLimit = undefined;
    tab.resultPageOffset = undefined;
    tab.resultCountSql = undefined;
    tab.resultTotalRowCount = undefined;
    tab.resultTotalRowCountLoading = false;
    tab.resultSessionId = undefined;
  }

  function clearResultRunSnapshots(tab: QueryTab) {
    for (const run of tab.resultRuns ?? []) {
      if (run.resultCacheKey) void deleteTabResultSnapshot(run.resultCacheKey);
    }
  }

  function clearResultRunPayload(run: NonNullable<QueryTab["resultRuns"]>[number], options: { evicted?: boolean } = {}) {
    run.result = undefined;
    run.results = undefined;
    run.resultLocalSortOriginalRows = undefined;
    run.resultLocalSortOriginalMongoDocuments = undefined;
    run.resultLocalSortOriginalMongoCopyDocuments = undefined;
    run.resultSessionId = undefined;
    run.resultEstimatedBytes = undefined;
    run.queryAnalysis = undefined;
    run.querySourceColumns = undefined;
    run.queryEditabilityReason = undefined;
    run.mongoEditTarget = undefined;
    run.tableMeta = undefined;
    run.resultEvicted = options.evicted ? true : undefined;
    run.resultCacheState = options.evicted ? "disk" : undefined;
  }

  function projectResultRun(tab: QueryTab, run: NonNullable<QueryTab["resultRuns"]>[number]) {
    const activeIndex = run.activeResultIndex ?? 0;
    tab.activeResultRunId = run.id;
    tab.result = run.result ?? run.results?.[activeIndex];
    tab.results = run.results;
    tab.activeResultIndex = run.activeResultIndex;
    tab.batchSqlExecution = cloneBatchSqlExecution(run.batchSqlExecution);
    tab.resultBaseSql = run.resultBaseSql;
    tab.resultEditorFingerprint = run.resultEditorFingerprint;
    tab.resultSortedSql = run.resultSortedSql;
    tab.resultSortColumn = run.resultSortColumn;
    tab.resultSortColumnIndex = run.resultSortColumnIndex;
    tab.resultSortDirection = run.resultSortDirection;
    tab.resultSortMode = run.resultSortMode;
    tab.resultLocalSortOriginalRows = run.resultLocalSortOriginalRows;
    tab.resultLocalSortOriginalMongoDocuments = run.resultLocalSortOriginalMongoDocuments;
    tab.resultLocalSortOriginalMongoCopyDocuments = run.resultLocalSortOriginalMongoCopyDocuments;
    tab.orderByInput = run.orderByInput;
    tab.resultPageSql = run.resultPageSql;
    tab.resultPageLimit = run.resultPageLimit;
    tab.resultPageOffset = run.resultPageOffset;
    tab.resultCountSql = run.resultCountSql;
    tab.resultTotalRowCount = run.resultTotalRowCount;
    tab.resultTotalRowCountLoading = run.resultTotalRowCountLoading;
    tab.resultSessionId = run.resultSessionId;
    tab.resultAccessedAt = run.resultAccessedAt;
    tab.resultCacheKey = run.resultCacheKey;
    tab.resultCacheState = run.resultCacheState;
    tab.resultEstimatedBytes = run.resultEstimatedBytes ?? estimateQueryResultsBytes(run.result, run.results);
    tab.resultEvicted = run.resultEvicted;
    tab.queryAnalysis = run.queryAnalysis;
    tab.querySourceColumns = run.querySourceColumns;
    tab.queryEditabilityReason = run.queryEditabilityReason;
    tab.mongoEditTarget = run.mongoEditTarget;
    tab.tableMeta = run.tableMeta;
    touchResult(tab, Date.now(), { reuseEstimatedBytes: true });
  }

  function restorePendingResultRun(tab: QueryTab, executionId: string): boolean {
    const runId = pendingResultRunRestores.get(executionId);
    pendingResultRunRestores.delete(executionId);
    if (!runId) return false;
    const run = tab.resultRuns?.find((item) => item.id === runId);
    if (!run || !resultRunHasPayload(run)) return false;
    projectResultRun(tab, run);
    evictInactiveResultRunPayloads(tab);
    return true;
  }

  async function restoreResultRunPayload(tab: QueryTab, runId: string) {
    const run = tab.resultRuns?.find((item) => item.id === runId);
    if (!run || run.result || run.results?.length) return run;

    const cacheKey = run.resultCacheKey ?? tab.resultCacheKey;
    if (!cacheKey) return run;

    const snapshot = await readTabResultSnapshot(cacheKey);
    const snapshotRun = snapshot?.resultRuns?.find((item) => item.id === runId);
    if (!snapshotRun) return run;

    const restoredRun = markQueryResultRunsRowsRaw([
      {
        ...run,
        ...snapshotRun,
        result: snapshotRun.result ? markQueryResultRowsRaw(snapshotRun.result) : undefined,
        results: snapshotRun.results ? markQueryResultsRowsRaw(snapshotRun.results) : undefined,
        resultCacheState: "memory" as const,
        // 快照编解码会重建负载（如省略 session_id），落盘前的估算值不再对应
        // 恢复后的对象，置空以便 projectResultRun 按当前负载重算
        resultEstimatedBytes: undefined,
      },
    ])[0]!;
    tab.resultRuns = tab.resultRuns?.map((item) => (item.id === runId ? restoredRun : item));
    return restoredRun;
  }

  async function setActiveResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return false;
    const run = await restoreResultRunPayload(tab, runId);
    if (!run?.result && !run?.results?.length) return false;
    projectResultRun(tab, run);
    evictInactiveResultRunPayloads(tab);
    return true;
  }

  async function removeResultRun(id: string, runId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    const runIndex = tab?.resultRuns?.findIndex((run) => run.id === runId) ?? -1;
    if (!tab || !tab.resultRuns || runIndex < 0) return false;

    const removedRun = tab.resultRuns[runIndex];
    if (removedRun?.resultCacheKey) void deleteTabResultSnapshot(removedRun.resultCacheKey);
    const wasActive = tab.activeResultRunId === runId;
    const remainingRuns = tab.resultRuns.filter((run) => run.id !== runId);
    tab.resultRuns = remainingRuns;

    if (!wasActive) return true;

    const adjacentIndex = Math.min(runIndex, remainingRuns.length - 1);
    for (let offset = 0; offset < remainingRuns.length; offset += 1) {
      const candidate = remainingRuns[(adjacentIndex + offset) % remainingRuns.length];
      // Disk-backed runs may have missing or unreadable snapshots; keep searching before clearing output.
      if (candidate && (await setActiveResultRun(id, candidate.id))) return true;
    }

    tab.activeResultRunId = undefined;
    clearResultPayload(tab);
    return true;
  }

  function nextResultRunSequence(tab: QueryTab): number {
    return (tab.resultRuns?.reduce((max, run) => Math.max(max, run.sequence), 0) ?? 0) + 1;
  }

  function persistResultRun(tab: QueryTab, run: NonNullable<QueryTab["resultRuns"]>[number]): Promise<boolean> {
    const key = run.resultCacheKey ?? resultRunCacheKey(tab.id, run.id);
    run.resultCacheKey = key;
    run.resultCacheState = "memory";
    return writeTabResultSnapshot(
      key,
      {
        result: run.result,
        results: run.results,
        activeResultIndex: run.activeResultIndex,
        resultEditorFingerprint: run.resultEditorFingerprint,
        resultRuns: [run],
        activeResultRunId: run.id,
        queryAnalysis: run.queryAnalysis,
        querySourceColumns: run.querySourceColumns,
        queryEditabilityReason: run.queryEditabilityReason,
        tableMeta: run.tableMeta,
        resultPageSql: run.resultPageSql,
        resultPageLimit: run.resultPageLimit,
        resultPageOffset: run.resultPageOffset,
        resultCountSql: run.resultCountSql,
        resultTotalRowCount: run.resultTotalRowCount,
        cachedAt: Date.now(),
      },
      tab.connectionId,
    );
  }

  function evictInactiveResultRunPayloads(tab: QueryTab) {
    const activeRunId = tab.activeResultRunId;
    if (!activeRunId || !tab.resultRuns?.length) return;

    for (const run of tab.resultRuns) {
      if (run.id === activeRunId || !resultRunHasPayload(run)) continue;
      const runId = run.id;
      void persistResultRun(tab, run).then((cached) => {
        const currentRun = tab.resultRuns?.find((item) => item.id === runId);
        if (!cached || !currentRun || currentRun.id === tab.activeResultRunId || !resultRunHasPayload(currentRun)) return;
        if (tab.result === currentRun.result || (currentRun.results && tab.results === currentRun.results)) return;
        clearResultRunPayload(currentRun, { evicted: true });
      });
    }
  }

  function captureDisplayedResultRun(tab: QueryTab, sql: string, createdAt = Date.now(), options: { reuseResultCacheKey?: boolean } = {}) {
    if (tab.mode !== "query" || !tab.result) return;
    const sequence = nextResultRunSequence(tab);
    const run: NonNullable<QueryTab["resultRuns"]>[number] = {
      id: uuid(),
      title: `Run ${sequence}`,
      sequence,
      sql,
      createdAt,
      result: tab.result,
      results: tab.results,
      activeResultIndex: tab.activeResultIndex,
      batchSqlExecution: cloneBatchSqlExecution(tab.batchSqlExecution),
      resultBaseSql: tab.resultBaseSql,
      resultEditorFingerprint: tab.resultEditorFingerprint,
      resultSortedSql: tab.resultSortedSql,
      resultSortColumn: tab.resultSortColumn,
      resultSortColumnIndex: tab.resultSortColumnIndex,
      resultSortDirection: tab.resultSortDirection,
      resultSortMode: tab.resultSortMode,
      resultLocalSortOriginalRows: tab.resultLocalSortOriginalRows,
      resultLocalSortOriginalMongoDocuments: tab.resultLocalSortOriginalMongoDocuments,
      resultLocalSortOriginalMongoCopyDocuments: tab.resultLocalSortOriginalMongoCopyDocuments,
      orderByInput: tab.orderByInput,
      resultPageSql: tab.resultPageSql,
      resultPageLimit: tab.resultPageLimit,
      resultPageOffset: tab.resultPageOffset,
      resultCountSql: tab.resultCountSql,
      resultTotalRowCount: tab.resultTotalRowCount,
      resultTotalRowCountLoading: tab.resultTotalRowCountLoading,
      resultSessionId: tab.resultSessionId,
      resultAccessedAt: tab.resultAccessedAt,
      resultEstimatedBytes: tab.resultEstimatedBytes,
      resultCacheKey: options.reuseResultCacheKey === false ? undefined : tab.resultCacheKey,
      resultCacheState: tab.resultCacheState,
      resultEvicted: tab.resultEvicted,
      queryAnalysis: tab.queryAnalysis,
      querySourceColumns: tab.querySourceColumns,
      queryEditabilityReason: tab.queryEditabilityReason,
      mongoEditTarget: tab.mongoEditTarget,
      tableMeta: tab.tableMeta,
    };
    void persistResultRun(tab, run);
    tab.resultRuns = [...(tab.resultRuns ?? []), run];
    tab.activeResultRunId = run.id;
    if (options.reuseResultCacheKey === false) {
      tab.resultCacheKey = run.resultCacheKey;
      tab.resultCacheState = run.resultCacheState;
    }
    evictInactiveResultRunPayloads(tab);
  }

  function toggleResultAutoSave(id: string): boolean {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return false;
    tab.resultAutoSave = tab.resultAutoSave ? undefined : true;
    if (tab.resultAutoSave && tab.result && !tab.activeResultRunId) {
      captureDisplayedResultRun(tab, tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql);
    }
    return tab.resultAutoSave === true;
  }

  function syncActiveResultRunFromDisplayed(tab: QueryTab, sql?: string) {
    if (!tab.activeResultRunId || !tab.resultRuns?.length) return;
    const index = tab.resultRuns.findIndex((run) => run.id === tab.activeResultRunId);
    if (index < 0) return;
    const run = {
      ...tab.resultRuns[index],
      ...(sql ? { sql } : {}),
      result: tab.result,
      results: tab.results,
      activeResultIndex: tab.activeResultIndex,
      batchSqlExecution: cloneBatchSqlExecution(tab.batchSqlExecution),
      resultBaseSql: tab.resultBaseSql,
      resultEditorFingerprint: tab.resultEditorFingerprint,
      resultSortedSql: tab.resultSortedSql,
      resultSortColumn: tab.resultSortColumn,
      resultSortColumnIndex: tab.resultSortColumnIndex,
      resultSortDirection: tab.resultSortDirection,
      resultSortMode: tab.resultSortMode,
      resultLocalSortOriginalRows: tab.resultLocalSortOriginalRows,
      resultLocalSortOriginalMongoDocuments: tab.resultLocalSortOriginalMongoDocuments,
      resultLocalSortOriginalMongoCopyDocuments: tab.resultLocalSortOriginalMongoCopyDocuments,
      orderByInput: tab.orderByInput,
      resultPageSql: tab.resultPageSql,
      resultPageLimit: tab.resultPageLimit,
      resultPageOffset: tab.resultPageOffset,
      resultCountSql: tab.resultCountSql,
      resultTotalRowCount: tab.resultTotalRowCount,
      resultTotalRowCountLoading: tab.resultTotalRowCountLoading,
      resultSessionId: tab.resultSessionId,
      resultAccessedAt: tab.resultAccessedAt,
      resultEstimatedBytes: tab.resultEstimatedBytes,
      resultCacheKey: tab.resultCacheKey,
      resultCacheState: tab.resultCacheState,
      resultEvicted: tab.resultEvicted,
      queryAnalysis: tab.queryAnalysis,
      querySourceColumns: tab.querySourceColumns,
      queryEditabilityReason: tab.queryEditabilityReason,
      mongoEditTarget: tab.mongoEditTarget,
      tableMeta: tab.tableMeta,
    };
    void persistResultRun(tab, run);
    tab.resultRuns[index] = run;
  }

  function syncDisplayedResultRun(tab: QueryTab, sql: string, captureNewRun = false) {
    if (tab.mode !== "query" || !tab.result) return;
    if (captureNewRun) {
      captureDisplayedResultRun(tab, sql, Date.now(), { reuseResultCacheKey: false });
    } else if (tab.activeResultRunId) {
      syncActiveResultRunFromDisplayed(tab, sql);
    } else if (tab.resultAutoSave) {
      captureDisplayedResultRun(tab, sql);
    }
  }

  function assignDisplayedResult(tab: QueryTab, result: QueryResult) {
    tab.result = markQueryResultRowsRaw(result);
    if (tab.results?.length) {
      const activeIndex = tab.activeResultIndex ?? 0;
      if (activeIndex >= 0 && activeIndex < tab.results.length) {
        tab.results[activeIndex] = tab.result;
      }
    }
  }

  function sortTabResultLocally(id: string, column: string, columnIndex: number, direction: DataGridSortDirection | null) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result) return;

    if (!tab.resultLocalSortOriginalRows) {
      tab.resultLocalSortOriginalRows = tab.result.rows.slice();
      tab.resultLocalSortOriginalMongoDocuments = tab.result.mongo_documents?.slice();
      tab.resultLocalSortOriginalMongoCopyDocuments = tab.result.mongo_copy_documents?.slice();
    }

    const originalRows = tab.resultLocalSortOriginalRows;
    const columnType = tab.result.column_types?.[columnIndex];
    const rowIndexes = direction ? sortDataGridRowIndexes(originalRows, columnIndex, direction, columnType) : originalRows.map((_, index) => index);
    const rows = rowIndexes.map((index) => originalRows[index]!);
    const originalMongoDocuments = tab.resultLocalSortOriginalMongoDocuments;
    const mongo_documents = originalMongoDocuments ? rowIndexes.map((index) => originalMongoDocuments[index]) : undefined;
    const originalMongoCopyDocuments = tab.resultLocalSortOriginalMongoCopyDocuments;
    const mongo_copy_documents = originalMongoCopyDocuments ? rowIndexes.map((index) => originalMongoCopyDocuments[index]) : undefined;
    assignDisplayedResult(tab, { ...tab.result, rows, mongo_documents, mongo_copy_documents });

    tab.resultSortColumn = direction ? column : undefined;
    tab.resultSortColumnIndex = direction ? columnIndex : undefined;
    tab.resultSortDirection = direction ?? undefined;
    tab.resultSortMode = direction ? "local" : undefined;
    tab.resultSortedSql = undefined;
    if (!direction) {
      tab.resultLocalSortOriginalRows = undefined;
      tab.resultLocalSortOriginalMongoDocuments = undefined;
      tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    }

    // 本地排序只是重排既有行/文档，字节规模不变，可复用估算值
    touchResult(tab, Date.now(), { reuseEstimatedBytes: true });
    syncDisplayedResultRun(tab, tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql);
  }

  function resultRunHasPayload(run: NonNullable<QueryTab["resultRuns"]>[number]): boolean {
    return !!run.result || !!run.results?.length;
  }

  function resultSnapshotHasPayload(snapshot: NonNullable<ReturnType<typeof buildTabResultSnapshot>>): boolean {
    return !!snapshot.result || !!snapshot.results?.length || !!snapshot.resultRuns?.some(resultRunHasPayload);
  }

  async function evictCachedResult(tab: QueryTab) {
    await closeResultSession(tab);
    const cacheKey = tabResultCacheKey(tab.id);
    const cached = await writeTabResultSnapshot(cacheKey, buildTabResultSnapshot(tab), tab.connectionId);
    tab.resultCacheKey = cached ? cacheKey : undefined;
    tab.resultCacheState = cached ? "disk" : "missing";
    clearResultPayload(tab, { evicted: true });
  }

  function applyRestoredOpenTabs(restored: { tabs: QueryTab[]; activeTabId: string | null }) {
    const connectionStore = useConnectionStore();
    for (const tab of restored.tabs) {
      if (tab.mode !== "data") continue;
      const connection = connectionStore.getConfig(tab.connectionId);
      if (connection) tab.schema = connectionObjectTreeNodeSchema(connection, tab.database, tab.schema);
    }
    tabs.value = restored.tabs;
    activeTabId.value = restored.activeTabId;
    activeTabHistory.value = restored.activeTabId ? [restored.activeTabId] : [];
    for (const tab of restored.tabs) {
      if (tab.mode === "data") void deleteTabResultSnapshot(tabResultCacheKey(tab.id));
    }
  }

  function scheduleResultCacheMaintenance() {
    const maintain = () => {
      const liveKeys = tabs.value.flatMap((tab) => [tab.resultCacheKey, ...(tab.resultRuns?.map((run) => run.resultCacheKey) ?? [])]).filter((key): key is string => !!key);
      void pruneTabResultSnapshots(liveKeys).catch((error) => console.warn("[DBX][result-cache:maintenance:error]", error));
    };
    if (typeof requestIdleCallback !== "undefined") requestIdleCallback(maintain, { timeout: 5000 });
    else if (typeof window !== "undefined") window.setTimeout(maintain, 0);
    else setTimeout(maintain, 0);
  }

  async function initOpenTabs(options: { validConnectionIds?: Iterable<string> } = {}) {
    if (isOpenTabsLoaded.value) return;
    const saved = await api.loadOpenTabsState().catch(() => null);
    if (saved?.tabs && Array.isArray(saved.tabs)) {
      const restored = restoreSavedTabsFromPayload(saved, options);
      applyRestoredOpenTabs(restored);
      if (useSettingsStore().editorSettings.openTabsRestoreMode === "none") {
        // Restore is explicitly disabled, so stale saved payloads should not
        // reappear if the user later changes the setting.
        clearLegacySavedTabs();
        await saveTabs(tabs.value, activeTabId.value).catch(() => undefined);
      }
      isOpenTabsLoaded.value = true;
      scheduleResultCacheMaintenance();
      return;
    }

    const legacy = loadLegacySavedTabs();
    if (legacy.rawTabs || legacy.rawActiveTabId) {
      const restored = restoreLegacySavedTabs(options);
      applyRestoredOpenTabs(restored);
      if (useSettingsStore().editorSettings.openTabsRestoreMode === "none") {
        // Restore is explicitly disabled, so keeping the legacy startup payload
        // would resurrect old tabs if the user later changes the setting.
        clearLegacySavedTabs();
        isOpenTabsLoaded.value = true;
        scheduleResultCacheMaintenance();
        return;
      }
      try {
        await saveTabs(tabs.value, activeTabId.value);
        // Keep old desktop installs readable until the async store has the
        // migrated state; only then remove the synchronous startup payload.
        clearLegacySavedTabs();
      } catch {
        /* keep legacy values for a later migration attempt */
      }
    }
    isOpenTabsLoaded.value = true;
    scheduleResultCacheMaintenance();
  }

  const _persistSnapshot = computed(() =>
    tabs.value.map((t) => ({
      id: t.id,
      title: t.title,
      connectionId: t.connectionId,
      database: t.database,
      schema: t.schema,
      sql: t.sql,
      savedSqlId: t.savedSqlId,
      externalSqlPath: t.externalSqlPath,
      lastExecutedSql: t.lastExecutedSql,
      resultBaseSql: t.resultBaseSql,
      resultSortedSql: t.resultSortedSql,
      resultSortColumn: t.resultSortColumn,
      resultSortColumnIndex: t.resultSortColumnIndex,
      resultSortDirection: t.resultSortDirection,
      resultSortMode: t.resultSortMode,
      orderByInput: t.orderByInput,
      resultPageLimit: t.resultPageLimit,
      resultPageOffset: t.resultPageOffset,
      whereInput: t.whereInput,
      pinned: t.pinned,
      mode: t.mode,
      resultAutoSave: t.resultAutoSave,
      structureTableName: t.structureTableName,
      objectBrowser: t.objectBrowser,
      objectSource: t.objectSource,
      tableMeta: t.tableMeta,
      mongoEditTarget: t.mongoEditTarget,
      resultEvicted: t.resultEvicted,
      resultCacheKey: t.resultCacheKey,
    })),
  );

  const storePersistGeneration = ++persistGeneration;
  watch(
    [_persistSnapshot, activeTabId],
    () => {
      if (storePersistGeneration !== persistGeneration) return;
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        void saveTabs(tabs.value, activeTabId.value).catch(() => {});
        persistTimer = null;
      }, 300);
    },
    { flush: "post" },
  );

  onScopeDispose(() => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = null;
  });

  // Immediately flush any pending debounced persist so the on-disk content
  // reflects the latest in-memory tabs without waiting for the 300ms debounce.
  // Lets callers (e.g. tests that reload the store) read back persisted state
  // deterministically instead of racing the debounce timer.
  function flushPendingPersist(): Promise<void> {
    if (storePersistGeneration !== persistGeneration) return Promise.resolve();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    return saveTabs(tabs.value, activeTabId.value);
  }

  function findTabByIdentity(connectionId: string, database: string, title: string, mode: QueryTab["mode"], schema?: string, catalog?: string) {
    return tabs.value.find((tab) => tab.connectionId === connectionId && tab.database === database && tab.title === title && tab.mode === mode && (tab.schema || "") === (schema || "") && (tab.catalog || "") === (catalog || ""));
  }

  function createTab(connectionId: string, database: string, title?: string, mode: QueryTab["mode"] = "query", schema?: string, initialSql?: string, catalog?: string, options: { forceNew?: boolean } = {}) {
    if (title && !options.forceNew) {
      const existing = findTabByIdentity(connectionId, database, title, mode, schema, catalog);
      if (existing) {
        switchTab(existing.id);
        return existing.id;
      }
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: title || `query_${tabs.value.length + 1}`,
      customTitle: mode === "query" && !!title ? true : undefined,
      connectionId,
      database,
      schema,
      catalog,
      sql: initialSql ?? "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode,
    };
    if (mode === "query") tab.originalSql = initialSql ?? "";
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function showExecutedQueryResults(connectionId: string, database: string, sql: string, queryResults: QueryResult[]) {
    const id = createTab(connectionId, database, undefined, "query", undefined, sql);
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab) return id;

    const results = markQueryResultsRowsRaw(queryResults);
    const firstDataResult = results.findIndex((result) => result.columns.length > 0);
    const activeIndex = firstDataResult >= 0 ? firstDataResult : 0;
    tab.lastExecutedSql = sql;
    tab.resultBaseSql = sql;
    tab.results = results.length > 1 ? results : undefined;
    tab.activeResultIndex = results.length > 1 ? activeIndex : undefined;
    tab.result = results[activeIndex];
    tab.isExecuting = false;
    tab.isCancelling = false;
    tab.executionId = undefined;
    tab.queryExecutionStartedAt = undefined;
    if (tab.result) touchResult(tab);
    return id;
  }

  function refreshExternalSqlFileTitles() {
    const externalTabs = tabs.value.filter((tab) => tab.mode === "query" && tab.externalSqlPath);
    const titles = externalSqlFileDisplayTitles(externalTabs.map((tab) => tab.externalSqlPath!));
    externalTabs.forEach((tab, index) => {
      tab.title = titles[index];
      tab.customTitle = true;
    });
  }

  function openExternalSqlFile(connectionId: string, database: string, path: string, sql: string) {
    const normalizedPath = normalizeExternalSqlPath(path);
    const existing = tabs.value.find((tab) => tab.mode === "query" && tab.externalSqlPath && normalizeExternalSqlPath(tab.externalSqlPath) === normalizedPath);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    // File-backed tabs are identified by their full path, not their basename.
    // Bypassing createTab avoids overwriting another file with the same name.
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: "",
      customTitle: true,
      connectionId,
      database,
      sql,
      originalSql: sql,
      externalSqlPath: path,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "query",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    refreshExternalSqlFileTitles();
    return id;
  }

  function openObjectBrowser(connectionId: string, database: string, schema?: string, catalog?: string) {
    const title = catalog ? `${catalog}.${database} objects` : schema ? `${schema} objects` : `${database} objects`;
    const existing = tabs.value.find((tab) => tab.mode === "objects" && tab.connectionId === connectionId && tab.database === database && (tab.objectBrowser?.catalog || "") === (catalog || "") && (tab.objectBrowser?.schema || "") === (schema || ""));
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title,
      connectionId,
      database,
      schema,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "objects",
      objectBrowser: {
        catalog,
        schema,
        objectType: "tables",
      },
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function switchTab(tabId: string) {
    activeTabId.value = tabId;
    settingsStore.settingsPageActive = false;
  }

  function openUserAdmin(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "users" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: t("userAdmin.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "users",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openProcessList(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "processlist" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: conn?.name ? `${conn.name} - ${t("processList.title")}` : t("processList.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "processlist",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMysqlDashboard(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "mysql-dashboard" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: conn?.name ? `${conn.name} - ${t("serverDashboard.title")}` : t("serverDashboard.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mysql-dashboard",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openPostgresDashboard(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "postgres-dashboard" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: conn?.name ? `${conn.name} - ${t("serverDashboard.title")}` : t("serverDashboard.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "postgres-dashboard",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openNacosDashboard(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "nacos-dashboard" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: conn?.name ? `${conn.name} - ${t("serverDashboard.title")}` : t("serverDashboard.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "nacos-dashboard",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openDamengJobAdmin(connectionId: string) {
    const existing = tabs.value.find((tab) => tab.mode === "dameng-jobs" && tab.connectionId === connectionId);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: t("damengJobAdmin.title"),
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "dameng-jobs",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMongoBucket(connectionId: string, database: string, bucketName: string) {
    const title = `${database}.${bucketName}`;
    const existing = tabs.value.find((tab) => tab.mode === "mongo-bucket" && tab.connectionId === connectionId && tab.database === database && tab.mongoBucket?.bucketName === bucketName);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title,
      connectionId,
      database,
      sql: bucketName,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mongo-bucket",
      mongoBucket: {
        bucketName,
      },
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMongoGridFs(connectionId: string, database: string) {
    const existing = tabs.value.find((tab) => tab.mode === "mongo-gridfs" && tab.connectionId === connectionId && tab.database === database);
    if (existing) {
      switchTab(existing.id);
      return existing.id;
    }

    const id = uuid();
    const tab: QueryTab = {
      id,
      title: "GridFS",
      connectionId,
      database,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mongo-gridfs",
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMqAdmin(connectionId: string, target?: { tenant?: string; initialTab?: QueryTab["mqInitialTab"] }) {
    const existing = tabs.value.find((tab) => tab.mode === "mq" && tab.connectionId === connectionId);
    if (existing) {
      if (target?.tenant) existing.mqTenant = target.tenant;
      if (target?.initialTab) existing.mqInitialTab = target.initialTab;
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: `${conn?.name || "Message Queue"} Admin`,
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mq",
      mqTenant: target?.tenant,
      mqInitialTab: target?.initialTab,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openNacosAdmin(connectionId: string, target?: { namespace?: string; namespaceName?: string; dataId?: string; group?: string; keyword?: string }) {
    const namespace = target?.namespace ?? "";
    const namespaceName = target?.namespaceName || (namespace ? namespace : "public");
    const existing = tabs.value.find((tab) => tab.mode === "nacos" && tab.connectionId === connectionId && (tab.nacosNamespace || "") === namespace);
    if (existing) {
      existing.nacosNamespaceName = namespaceName;
      if (target?.dataId) {
        existing.nacosTargetDataId = target.dataId;
        existing.nacosTargetGroup = target.group || "DEFAULT_GROUP";
        existing.nacosTargetKeyword = target.keyword;
        existing.nacosTargetRequestId = (existing.nacosTargetRequestId ?? 0) + 1;
      }
      if (!existing.customTitle) existing.title = `${useConnectionStore().getConfig(connectionId)?.name || "Nacos"}:${namespaceName}`;
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: `${conn?.name || "Nacos"}:${namespaceName}`,
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "nacos",
      nacosNamespace: namespace,
      nacosNamespaceName: namespaceName,
      nacosTargetDataId: target?.dataId,
      nacosTargetGroup: target?.group,
      nacosTargetKeyword: target?.keyword,
      nacosTargetRequestId: target?.dataId ? 1 : undefined,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function openMqttAdmin(connectionId: string, target?: { initialTopic?: string }) {
    const existing = tabs.value.find((tab) => tab.mode === "mqtt" && tab.connectionId === connectionId);
    if (existing) {
      if (target?.initialTopic) existing.mqttInitialTopic = target.initialTopic;
      switchTab(existing.id);
      return existing.id;
    }

    const conn = useConnectionStore().getConfig(connectionId);
    const id = uuid();
    const tab: QueryTab = {
      id,
      title: `${conn?.name || "MQTT"} Console`,
      connectionId,
      database: conn?.database || "",
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "mqtt",
      mqttInitialTopic: target?.initialTopic,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function clearNacosNavigationTarget(connectionId: string, namespace: string, requestId?: number) {
    const tab = tabs.value.find((candidate) => candidate.mode === "nacos" && candidate.connectionId === connectionId && (candidate.nacosNamespace || "") === namespace);
    if (!tab || (requestId !== undefined && tab.nacosTargetRequestId !== requestId)) return;
    tab.nacosTargetDataId = undefined;
    tab.nacosTargetGroup = undefined;
    tab.nacosTargetKeyword = undefined;
  }

  function applyTableStructureInitialTab(tab: QueryTab, initialTab?: TableInfoTab, initialTarget?: TableStructureEditorTarget) {
    if (!initialTab && !initialTarget?.name) return;
    if (initialTab) tab.structureInitialTab = initialTab;
    tab.structureInitialTarget = initialTarget?.name ? initialTarget : undefined;
    tab.structureInitialTabRequestId = (tab.structureInitialTabRequestId ?? 0) + 1;
  }

  function openTableStructure(connectionId: string, database: string, schema?: string, tableName?: string, initialTab?: TableInfoTab, initialTarget?: TableStructureEditorTarget, catalog?: string) {
    const resolvedTableName = tableName || "";
    if (resolvedTableName) {
      const existing = tabs.value.find((tab) => tab.mode === "structure" && tab.connectionId === connectionId && tab.database === database && (tab.catalog || "") === (catalog || "") && (tab.structureTableName || "") === resolvedTableName);
      if (existing) {
        applyTableStructureInitialTab(existing, initialTab, initialTarget);
        switchTab(existing.id);
        return existing.id;
      }
    }

    const title = resolvedTableName ? t("structureEditor.editTabTitle", { tableName: resolvedTableName }) : t("structureEditor.createTitle");
    const id = uuid();
    const tab: QueryTab = {
      id,
      title,
      connectionId,
      database,
      schema,
      catalog,
      sql: "",
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "structure",
      structureTableName: resolvedTableName,
      structureInitialTab: initialTab,
      structureInitialTabRequestId: initialTab || initialTarget?.name ? 1 : undefined,
      structureInitialTarget: initialTarget?.name ? initialTarget : undefined,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  function isTabDirty(tab: QueryTab): boolean {
    if (tab.mode === "structure") {
      // Legacy persisted structure drafts predate the dirty flag; treat them as dirty until the editor rehydrates them.
      return !!tab.structureDraft && tab.structureDraft.dirty !== false;
    }
    if (tab.mode !== "query") return false;
    if (!tab.externalSqlPath && !tab.sql.trim()) return false;
    const original = tab.originalSql;
    if (original === undefined) return !!tab.savedSqlId;
    return tab.sql !== original;
  }

  const hasDirtyTabs = computed(() => tabs.value.some((tab) => isTabDirty(tab)));
  const shouldConfirmUnsavedSqlClose = computed(() => useSettingsStore().editorSettings.confirmUnsavedSqlClose);

  const closeConfirmDirtyTabIds = computed(() => {
    if (isConfirmingAppClose.value) return tabs.value.filter((tab) => isTabDirty(tab)).map((tab) => tab.id);
    if (pendingBatchCloseTabIds.value) {
      return pendingBatchCloseTabIds.value
        .map((id) => tabs.value.find((tab) => tab.id === id))
        .filter((tab): tab is QueryTab => !!tab && isTabDirty(tab))
        .map((tab) => tab.id);
    }
    const pendingTab = pendingCloseTabId.value ? tabs.value.find((tab) => tab.id === pendingCloseTabId.value) : undefined;
    return pendingTab && isTabDirty(pendingTab) ? [pendingTab.id] : [];
  });

  function showDirtyTabCloseConfirm(tab: QueryTab, context: CloseConfirmContext) {
    pendingCloseTabId.value = tab.id;
    closeConfirmContext.value = context;
    activeTabId.value = tab.id;
    showCloseConfirm.value = true;
  }

  function markTabClean(tab: QueryTab | undefined) {
    if (tab) tab.originalSql = tab.sql;
  }

  function persistSavedSqlEditorPosition(tab: QueryTab | undefined) {
    if (!tab?.savedSqlId || tab.mode !== "query") return;
    const pending = savedSqlEditorPositionTimers.get(tab.savedSqlId);
    if (pending) {
      clearTimeout(pending);
      savedSqlEditorPositionTimers.delete(tab.savedSqlId);
    }
    saveSavedSqlEditorPosition(
      createSavedSqlEditorPosition({
        savedSqlId: tab.savedSqlId,
        sql: tab.sql,
        selection: tab.editorSelection,
        viewport: tab.editorViewport,
      }),
    );
  }

  function queueSavedSqlEditorPositionPersist(tab: QueryTab | undefined) {
    if (!tab?.savedSqlId || tab.mode !== "query") return;
    const pending = savedSqlEditorPositionTimers.get(tab.savedSqlId);
    if (pending) clearTimeout(pending);
    const tabId = tab.id;
    const savedSqlId = tab.savedSqlId;
    const timer = setTimeout(() => {
      savedSqlEditorPositionTimers.delete(savedSqlId);
      persistSavedSqlEditorPosition(tabs.value.find((item) => item.id === tabId));
    }, SAVED_SQL_EDITOR_POSITION_PERSIST_DELAY_MS);
    savedSqlEditorPositionTimers.set(savedSqlId, timer);
  }

  function discardTabChanges(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab) return false;
    if (tab.mode === "structure") {
      tab.structureDraft = undefined;
      return true;
    }
    if (tab.mode !== "query") return false;
    if (tab.originalSql !== undefined) {
      tab.sql = tab.originalSql;
      return true;
    }
    if (tab.savedSqlId) {
      tab.sql = "";
      return true;
    }
    tab.sql = "";
    tab.originalSql = "";
    return true;
  }

  function finishPendingBatchClose() {
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    const onComplete = pendingBatchCloseComplete;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    pendingBatchCloseComplete = null;
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
    return onComplete;
  }

  function continuePendingBatchClose() {
    const pendingIds = pendingBatchCloseTabIds.value;
    if (!pendingIds) return;

    const remainingIds = pendingIds.filter((id) => tabs.value.some((tab) => tab.id === id));
    pendingBatchCloseTabIds.value = remainingIds;
    if (remainingIds.length === 0) {
      finishPendingBatchClose()?.();
      return;
    }

    const dirtyTab = remainingIds.map((id) => tabs.value.find((tab) => tab.id === id)).find((tab): tab is QueryTab => !!tab && shouldConfirmTabClose(tab));
    if (dirtyTab) {
      // Batch close must pause before dropping dirty tabs so the shared save/discard dialog protects every editable surface.
      showDirtyTabCloseConfirm(dirtyTab, "batch");
      return;
    }

    const onComplete = finishPendingBatchClose();
    for (const id of remainingIds) closeTab(id, { force: true });
    onComplete?.();
  }

  function beginBatchClose(ids: string[], finalActiveTabId?: string | null, onComplete?: () => void) {
    const uniqueIds = [...new Set(ids)].filter((id) => tabs.value.some((tab) => tab.id === id));
    if (uniqueIds.length === 0) {
      onComplete?.();
      return;
    }
    pendingBatchCloseTabIds.value = uniqueIds;
    pendingBatchCloseFinalActiveTabId.value = finalActiveTabId;
    pendingBatchCloseComplete = onComplete ?? null;
    continuePendingBatchClose();
  }

  function resumePendingBatchCloseAfter(id: string) {
    const pendingIds = pendingBatchCloseTabIds.value;
    if (!pendingIds?.includes(id)) return;
    pendingBatchCloseTabIds.value = pendingIds.filter((pendingId) => pendingId !== id);
    continuePendingBatchClose();
  }

  function closeTab(id: string, { force = false }: { force?: boolean } = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    if (!force && shouldConfirmTabClose(tab)) {
      showDirtyTabCloseConfirm(tab, "tab");
      return;
    }
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    persistSavedSqlEditorPosition(tabs.value[idx]);
    clearDataGridPendingSnapshotsForTab(id);
    if (tabs.value[idx].txnSessionId) void rollbackTransaction(id);
    if (tabs.value[idx].isExecuting) void cancelTabExecution(id);
    if (tabs.value[idx].isExplaining) void cancelTabExplain(id);
    void closeResultSession(tabs.value[idx]);
    void closeClientConnectionSession(tabs.value[idx]);
    clearResultRunSnapshots(tabs.value[idx]);
    void deleteTabResultSnapshot(tabResultCacheKey(id));
    clearResultPayload(tabs.value[idx]);
    tabs.value.splice(idx, 1);
    if (tab.externalSqlPath) refreshExternalSqlFileTitles();
    if (activeTabId.value === id) {
      activeTabId.value = fallbackActiveTabAfterClose(id, idx);
    }
    if (force) resumePendingBatchCloseAfter(id);
  }

  function shouldConfirmTabClose(tab: QueryTab): boolean {
    if (tab.mode === "structure") return isTabDirty(tab);
    return shouldConfirmUnsavedSqlClose.value && isTabDirty(tab);
  }

  function forceClosePendingTab() {
    const id = pendingCloseTabId.value;
    const confirmingAppClose = isConfirmingAppClose.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    closeConfirmContext.value = "tab";
    if (confirmingAppClose) {
      if (id) discardTabChanges(id);
      isConfirmingAppClose.value = false;
      return;
    }
    if (id) closeTab(id, { force: true });
  }

  function forceCloseAllPendingTabs() {
    const dirtyIds = closeConfirmDirtyTabIds.value;
    const pendingId = pendingCloseTabId.value;
    const batchIds = pendingBatchCloseTabIds.value?.filter((id) => tabs.value.some((tab) => tab.id === id)) ?? null;
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    const onBatchComplete = pendingBatchCloseComplete;
    const confirmingAppClose = isConfirmingAppClose.value;

    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    pendingBatchCloseComplete = null;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";

    for (const id of dirtyIds) discardTabChanges(id);
    if (confirmingAppClose) return;

    const idsToClose = batchIds ?? (pendingId ? [pendingId] : []);
    for (const id of idsToClose) closeTab(id, { force: true });
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
    if (batchIds) onBatchComplete?.();
  }

  function cancelClosePendingTab() {
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    pendingBatchCloseComplete = null;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";
  }

  function saveAndClosePendingTab() {
    const id = pendingCloseTabId.value;
    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";
    if (id) return id;
    return null;
  }

  function suspendCloseConfirm() {
    showCloseConfirm.value = false;
  }

  function resumeCloseConfirm() {
    const dirtyId = closeConfirmDirtyTabIds.value[0];
    const dirtyTab = dirtyId ? tabs.value.find((tab) => tab.id === dirtyId) : undefined;
    if (!dirtyTab) return false;
    pendingCloseTabId.value = dirtyTab.id;
    activeTabId.value = dirtyTab.id;
    showCloseConfirm.value = true;
    return true;
  }

  function completePendingCloseAfterSaveAll() {
    const pendingId = pendingCloseTabId.value;
    const batchIds = pendingBatchCloseTabIds.value?.filter((id) => tabs.value.some((tab) => tab.id === id)) ?? null;
    const finalActiveTabId = pendingBatchCloseFinalActiveTabId.value;
    const onBatchComplete = pendingBatchCloseComplete;
    const confirmingAppClose = isConfirmingAppClose.value;

    pendingCloseTabId.value = null;
    showCloseConfirm.value = false;
    pendingBatchCloseTabIds.value = null;
    pendingBatchCloseFinalActiveTabId.value = undefined;
    pendingBatchCloseComplete = null;
    isConfirmingAppClose.value = false;
    closeConfirmContext.value = "tab";

    if (confirmingAppClose) return "app" as const;

    const idsToClose = batchIds ?? (pendingId ? [pendingId] : []);
    for (const id of idsToClose) closeTab(id, { force: true });
    if (finalActiveTabId !== undefined) {
      activeTabId.value = finalActiveTabId && tabs.value.some((tab) => tab.id === finalActiveTabId) ? finalActiveTabId : null;
    }
    if (batchIds) onBatchComplete?.();
    return "tabs" as const;
  }

  function closeOtherTabs(id: string) {
    if (!tabs.value.some((tab) => tab.id === id)) return;
    beginBatchClose(
      tabs.value.filter((tab) => tab.id !== id).map((tab) => tab.id),
      id,
    );
  }

  function closeRightTabs(id: string, onComplete?: () => void) {
    const target = tabs.value.find((tab) => tab.id === id);
    if (!target) return;

    const groupedTabs = tabs.value.filter((tab) => Boolean(tab.pinned) === Boolean(target.pinned));
    const targetIndex = groupedTabs.findIndex((tab) => tab.id === id);
    const ids = groupedTabs.slice(targetIndex + 1).map((tab) => tab.id);
    if (ids.length === 0) {
      onComplete?.();
      return;
    }

    const finalActiveTabId = activeTabId.value && !ids.includes(activeTabId.value) ? activeTabId.value : id;
    beginBatchClose(ids, finalActiveTabId, onComplete);
  }

  function finalActiveTabAfterClosing(ids: string[]) {
    const closingIds = new Set(ids);
    const activeTab = activeTabId.value ? tabs.value.find((tab) => tab.id === activeTabId.value) : undefined;
    if (activeTab && !closingIds.has(activeTab.id)) return activeTab.id;
    return tabs.value.find((tab) => !closingIds.has(tab.id))?.id ?? null;
  }

  function closeOtherRegularTabs(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || tab.pinned) return;
    beginBatchClose(
      tabs.value.filter((item) => !item.pinned && item.id !== id).map((item) => item.id),
      id,
    );
  }

  function closeRegularTabs() {
    const ids = tabs.value.filter((tab) => !tab.pinned).map((tab) => tab.id);
    beginBatchClose(ids, finalActiveTabAfterClosing(ids));
  }

  function closeOtherFixedTabs(id: string) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || !tab.pinned) return;
    beginBatchClose(
      tabs.value.filter((item) => item.pinned && item.id !== id).map((item) => item.id),
      id,
    );
  }

  function closeFixedTabs() {
    const ids = tabs.value.filter((tab) => tab.pinned).map((tab) => tab.id);
    beginBatchClose(ids, finalActiveTabAfterClosing(ids));
  }

  function closeAllTabs() {
    beginBatchClose(
      tabs.value.map((tab) => tab.id),
      null,
    );
  }

  function requestAppCloseConfirmation() {
    const dirtyTab = tabs.value.find((tab) => shouldConfirmTabClose(tab));
    if (!dirtyTab) return false;
    isConfirmingAppClose.value = true;
    showDirtyTabCloseConfirm(dirtyTab, "app");
    return true;
  }

  function duplicateTab(id: string) {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const original = tabs.value[idx];
    const newId = uuid();
    const newTab: QueryTab = {
      id: newId,
      title: original.title,
      customTitle: original.customTitle,
      connectionId: original.connectionId,
      database: original.database,
      schema: original.schema,
      catalog: original.catalog,
      sql: original.sql,
      originalSql: "",
      savedSqlId: undefined,
      externalSqlPath: undefined,
      lastExecutedSql: undefined,
      resultBaseSql: original.resultBaseSql,
      resultSortedSql: undefined,
      resultSortColumn: undefined,
      resultSortColumnIndex: undefined,
      resultSortDirection: undefined,
      resultSortMode: undefined,
      resultLocalSortOriginalRows: undefined,
      resultLocalSortOriginalMongoDocuments: undefined,
      resultLocalSortOriginalMongoCopyDocuments: undefined,
      orderByInput: undefined,
      resultPageSql: undefined,
      resultPageLimit: undefined,
      resultPageOffset: undefined,
      resultCountSql: undefined,
      resultTotalRowCount: undefined,
      resultTotalRowCountLoading: undefined,
      resultSessionId: undefined,
      resultAccessedAt: undefined,
      resultCacheKey: undefined,
      resultCacheState: undefined,
      pinned: false,
      result: undefined,
      results: undefined,
      activeResultIndex: undefined,
      explainPlan: undefined,
      explainError: undefined,
      explainSql: undefined,
      lastExplainedSql: undefined,
      isExecuting: false,
      isCancelling: false,
      queryExecutionStartedAt: undefined,
      editorViewport: undefined,
      editorSelection: undefined,
      executionId: undefined,
      isExplaining: false,
      explainExecutionId: undefined,
      mode: original.mode,
      mqTenant: original.mqTenant,
      mqInitialTab: original.mqInitialTab,
      nacosNamespace: original.nacosNamespace,
      nacosNamespaceName: original.nacosNamespaceName,
      structureTableName: original.structureTableName,
      structureDraft: original.structureDraft ? cloneTabDraft(original.structureDraft) : undefined,
      objectBrowser: original.objectBrowser ? { ...original.objectBrowser } : undefined,
      objectSource: original.objectSource ? { ...original.objectSource } : undefined,
      tableMeta: original.tableMeta ? { ...original.tableMeta, columns: [...original.tableMeta.columns], primaryKeys: [...original.tableMeta.primaryKeys] } : undefined,
      queryAnalysis: original.queryAnalysis ? { ...original.queryAnalysis, sources: original.queryAnalysis.sources?.map((source) => ({ ...source })), columns: original.queryAnalysis.columns.map((c) => ({ ...c })) } : undefined,
      querySourceColumns: original.querySourceColumns ? [...original.querySourceColumns] : undefined,
      queryEditabilityReason: original.queryEditabilityReason,
      resultEvicted: undefined,
      whereInput: original.whereInput,
      previewSql: original.previewSql,
    };
    tabs.value.splice(idx + 1, 0, newTab);
    activeTabId.value = newId;
  }

  function closeTabsWhere(predicate: (tab: QueryTab) => boolean) {
    const closingIds = new Set(tabs.value.filter((tab) => predicate(tab)).map((tab) => tab.id));
    if (closingIds.size === 0) return;

    tabs.value
      .filter((tab) => closingIds.has(tab.id))
      .forEach((tab) => {
        clearDataGridPendingSnapshotsForTab(tab.id);
        if (tab.txnSessionId) void rollbackTransaction(tab.id);
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultRunSnapshots(tab);
        void deleteTabResultSnapshot(tabResultCacheKey(tab.id));
        clearResultPayload(tab);
      });

    const activeClosingIndex = tabs.value.findIndex((tab) => tab.id === activeTabId.value && closingIds.has(tab.id));
    tabs.value = tabs.value.filter((tab) => !closingIds.has(tab.id));
    if (activeClosingIndex >= 0) {
      activeTabId.value = tabs.value[Math.min(activeClosingIndex, tabs.value.length - 1)]?.id ?? null;
    }
  }

  function closeConnectionTabs(connectionId: string) {
    closeTabsWhere((tab) => tab.connectionId === connectionId);
  }

  function closeDatabaseTabs(connectionId: string, database: string) {
    closeTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database);
  }

  function tabMatchesDroppedTableObject(tab: QueryTab, target: DroppedTableObjectTarget): boolean {
    if (tab.connectionId !== target.connectionId || tab.database !== target.database) return false;
    const targetSchemas = droppedTableObjectSchemaCandidates(target);

    if ((target.objectType ?? "TABLE") === "TABLE" && tab.mode === "hbase") {
      return tab.sql === target.name;
    }

    if (tab.mode === "data") {
      const tableMeta = tableMetaForDataTab(tab);
      if (!tableMeta || tableMeta.tableName !== target.name) return false;
      return targetSchemas.has(normalizeOptionalSchema(tableMeta.schema ?? tab.schema));
    }

    if ((target.objectType ?? "TABLE") === "TABLE" && tab.mode === "structure") {
      if ((tab.structureTableName || "") !== target.name) return false;
      return targetSchemas.has(normalizeOptionalSchema(tab.schema));
    }

    return false;
  }

  function tabMatchesTableDataRefreshTarget(tab: QueryTab, target: TableDataRefreshTarget): boolean {
    if (tab.mode !== "data" || tab.connectionId !== target.connectionId || tab.database !== target.database) return false;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta || tableMeta.tableName !== target.name) return false;
    if ((tableMeta.catalog || "") !== (target.catalog || "")) return false;
    const targetSchemas = droppedTableObjectSchemaCandidates(target);
    return targetSchemas.has(normalizeOptionalSchema(tableMeta.schema ?? tab.schema));
  }

  function closeDroppedTableObjectTabs(target: DroppedTableObjectTarget) {
    // A dropped table-like object makes existing data/structure tabs stale; close
    // them immediately instead of letting the next refresh fail against a missing object.
    closeTabsWhere((tab) => tabMatchesDroppedTableObject(tab, target));
  }

  async function refreshDataTabInternal(id: string, options?: { supersedeBusy?: boolean; propagateBuildError?: boolean }): Promise<boolean> {
    const tab = tabs.value.find((candidate) => candidate.id === id);
    if (!tab || tab.mode !== "data" || (tab.isExecuting && !options?.supersedeBusy)) return false;
    const tableMeta = tableMetaForDataTab(tab);
    if (!tableMeta?.tableName) return false;

    const connStore = useConnectionStore();
    const conn = connStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    const identifierQuote = connStore.connectionIdentifierQuote?.(tab.connectionId);
    clearInvalidDataTabSortState(tab, tableMeta.columns);
    const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : tableMeta.primaryKeys;
    const sortOrder = tab.resultSortColumn && tab.resultSortDirection ? `${quoteTableDataIdentifier(effectiveDbType, tab.resultSortColumn, identifierQuote)} ${tab.resultSortDirection.toUpperCase()}` : undefined;
    const orderBy = tab.orderByInput?.trim() || sortOrder;
    const limit = tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
    const offset = tab.resultPageOffset ?? 0;
    const refreshPreparationId = uuid();

    // Reserve the tab synchronously before SQL construction yields so repeated
    // refresh requests cannot build and execute duplicate queries.
    setExecutingWithId(tab.id, refreshPreparationId);
    try {
      const sql = await buildTableSelectSql({
        databaseType: effectiveDbType,
        identifierQuote,
        database: tableMeta.database,
        schema: tableMeta.schema,
        tableName: tableMeta.tableName,
        tableType: tableMeta.tableType,
        catalog: tableMeta.catalog,
        columns: tableMeta.columns.map((column) => column.name),
        primaryKeys,
        includeRowId: usesSyntheticRowIdKey(effectiveDbType, primaryKeys, tableMeta.tableType),
        whereInput: tab.whereInput,
        orderBy,
        limit,
        offset,
      });
      if (!sql.trim()) throw new Error("Failed to build table refresh SQL");
      const current = tabs.value.find((candidate) => candidate.id === id);
      if (!current || current.executionId !== refreshPreparationId) return false;
      updateSql(tab.id, sql);
      await executeTabSql(tab.id, sql, {
        pagination: { limit, offset },
        preserveResultDuringExecution: true,
      });
      return true;
    } catch (error) {
      const current = tabs.value.find((candidate) => candidate.id === id);
      if (current?.executionId === refreshPreparationId) setErrorResult(id, error);
      if (options?.propagateBuildError) throw error;
      return false;
    }
  }

  function refreshDataTab(id: string): Promise<boolean> {
    return refreshDataTabInternal(id);
  }

  async function refreshDataTabsForTable(target: TableDataRefreshTarget): Promise<number> {
    const matchingTabs = tabs.value.filter((tab) => tabMatchesTableDataRefreshTarget(tab, target));
    if (matchingTabs.length === 0) return 0;

    let refreshed = 0;
    for (const tab of matchingTabs) {
      if (await refreshDataTabInternal(tab.id, { supersedeBusy: true, propagateBuildError: true })) refreshed += 1;
    }

    return refreshed;
  }

  function releaseTabsWhere(predicate: (tab: QueryTab) => boolean) {
    closeTabsWhere((tab) => predicate(tab) && tab.mode !== "query");
    tabs.value
      .filter((tab) => predicate(tab))
      .forEach((tab) => {
        rollbackTabTransaction(tab, { resetAutoCommit: true });
        if (tab.isExecuting) void cancelTabExecution(tab.id);
        if (tab.isExplaining) void cancelTabExplain(tab.id);
        void closeResultSession(tab);
        void closeClientConnectionSession(tab);
        clearResultPayload(tab);
      });
  }

  function releaseConnectionTabs(connectionId: string) {
    releaseTabsWhere((tab) => tab.connectionId === connectionId);
  }

  function releaseDatabaseTabs(connectionId: string, database: string) {
    releaseTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database);
  }

  function isDatabaseOpen(connectionId: string, database: string) {
    return openDatabaseKeys.value.has(`${connectionId}\x00${database}`);
  }

  function rollbackTabsWhere(predicate: (tab: QueryTab) => boolean, options?: { resetAutoCommit?: boolean }) {
    tabs.value.filter((tab) => predicate(tab)).forEach((tab) => rollbackTabTransaction(tab, options));
  }

  function rollbackConnectionTransactions(connectionId: string) {
    rollbackTabsWhere((tab) => tab.connectionId === connectionId, { resetAutoCommit: true });
  }

  function rollbackDatabaseTransactions(connectionId: string, database: string) {
    rollbackTabsWhere((tab) => tab.connectionId === connectionId && tab.database === database, { resetAutoCommit: true });
  }

  function updateSql(id: string, sql: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.sql = sql;
      queueSavedSqlEditorPositionPersist(tab);
    }
  }

  function updateDataGridLocalColumnFilters(id: string, filters: Record<string, string[]>) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab?.result) return;
    if (Object.keys(filters).length === 0) {
      delete tab.result.local_column_filters;
    } else {
      tab.result.local_column_filters = Object.fromEntries(Object.entries(filters).map(([columnIndex, values]) => [columnIndex, [...values]]));
    }
  }

  function updateDataGridHiddenColumnKeys(id: string, keys: string[]) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab?.result) return;
    if (keys.length === 0) {
      delete tab.result.local_hidden_column_keys;
    } else {
      tab.result.local_hidden_column_keys = [...keys];
    }
  }

  function setAutoCommit(id: string, autoCommit: boolean) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      const wasManual = tab.autoCommit === false;
      tab.autoCommit = autoCommit;
      if (autoCommit && wasManual) {
        if (tab.txnSessionId) {
          void rollbackTransaction(id);
        } else {
          tab.txnAutoRolledBack = false;
        }
      }
    }
  }

  function rollbackTabTransaction(tab: QueryTab, options?: { resetAutoCommit?: boolean }) {
    if (tab.txnSessionId) void rollbackTransaction(tab.id);
    if (options?.resetAutoCommit) tab.autoCommit = true;
    tab.txnAutoRolledBack = false;
  }

  async function commitTransaction(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.txnSessionId) return;
    try {
      await api.commitManualTransaction(tab.txnSessionId);
    } finally {
      tab.txnSessionId = undefined;
      tab.txnAutoRolledBack = false;
    }
  }

  async function rollbackTransaction(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.txnSessionId) return;
    try {
      await api.rollbackManualTransaction(tab.txnSessionId);
    } finally {
      tab.txnSessionId = undefined;
      tab.txnAutoRolledBack = false;
    }
  }

  function updateEditorViewport(id: string, viewport: { scrollTop: number; scrollLeft: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    if (tab.editorViewport?.scrollTop === viewport.scrollTop && tab.editorViewport?.scrollLeft === viewport.scrollLeft) return;
    tab.editorViewport = viewport;
    queueSavedSqlEditorPositionPersist(tab);
  }

  function updateEditorSelection(id: string, selection: { anchor: number; head: number }) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.editorSelection = selection;
    queueSavedSqlEditorPositionPersist(tab);
  }

  function updateObjectBrowserViewport(id: string, viewport: ObjectBrowserViewport) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "objects") return;
    const previous = tab.objectBrowser?.viewport;
    if (previous?.scrollTop === viewport.scrollTop && previous.viewMode === viewport.viewMode) return;
    tab.objectBrowser = { ...tab.objectBrowser, viewport };
  }

  function renameTab(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return false;
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return false;
    const normalizedTitle = tab.savedSqlId ? ensureSqlExtension(trimmed) : trimmed;
    const previousTitle = tab.title;
    tab.title = normalizedTitle;
    tab.customTitle = true;
    if (tab.savedSqlId) {
      const savedSqlStore = useSavedSqlStore();
      const existing = savedSqlStore.getFile(tab.savedSqlId);
      if (existing && existing.name !== normalizedTitle) {
        void savedSqlStore.renameFile(tab.savedSqlId, normalizedTitle).catch((error) => {
          console.warn("[DBX][saved-sql:rename:error]", error);
          tab.title = previousTitle;
        });
      }
    }
    return true;
  }

  function linkSavedSql(id: string, savedSqlId: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.savedSqlId = savedSqlId;
    tab.externalSqlPath = undefined;
    if (title) {
      tab.title = title;
      tab.customTitle = true;
    }
  }

  function linkExternalSqlPath(id: string, path: string, title?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.externalSqlPath = path;
    tab.savedSqlId = undefined;
    if (title) {
      tab.title = title;
      tab.customTitle = true;
    }
    markTabClean(tab);
    refreshExternalSqlFileTitles();
  }

  function currentSavedSqlExecutionTarget(): SavedSqlExecutionTarget | undefined {
    const activeTab = tabs.value.find((tab) => tab.id === activeTabId.value);
    const target = savedSqlExecutionTargetFromTab(activeTab);
    if (!target || !useConnectionStore().getConfig(target.connectionId)) return undefined;
    return target;
  }

  function applySavedSqlExecutionTarget(tab: QueryTab, target: SavedSqlExecutionTarget) {
    const options = { persistSavedSqlTarget: false };
    updateConnection(tab.id, target.connectionId, target.database, options);
    if (tab.catalog !== target.catalog || tab.database !== target.database) {
      if (tab.catalog !== undefined || target.catalog !== undefined) updateCatalog(tab.id, target.catalog, target.database, options);
      else updateDatabase(tab.id, target.database, options);
    }
    updateSchema(tab.id, target.schema, options);
  }

  function openSavedSql(file: SavedSqlFile, options: OpenSavedSqlOptions = {}) {
    const targetMode = options.targetMode ?? useSettingsStore().editorSettings.savedSqlOpenTargetMode;
    const currentTarget = targetMode === "current" ? currentSavedSqlExecutionTarget() : undefined;
    const target = resolveSavedSqlExecutionTarget(file, targetMode, currentTarget);
    const existing = tabs.value.find((tab) => tab.savedSqlId === file.id);
    if (existing) {
      persistSavedSqlEditorPosition(existing);
      if (!existing.sql && file.sql) {
        existing.sql = file.sql;
        existing.originalSql = file.sql;
        const restored = restoreSavedSqlEditorPosition(file.id, file.sql);
        existing.editorSelection = restored.selection;
        existing.editorViewport = restored.viewport;
      }
      applySavedSqlExecutionTarget(existing, target);
      switchTab(existing.id);
      return existing.id;
    }

    const id = uuid();
    const restoredPosition = restoreSavedSqlEditorPosition(file.id, file.sql);
    const tab: QueryTab = {
      id,
      title: file.name,
      customTitle: true,
      connectionId: target.connectionId,
      database: target.database,
      schema: target.schema,
      catalog: target.catalog,
      sql: file.sql,
      savedSqlId: file.id,
      originalSql: file.sql,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "query",
      editorSelection: restoredPosition.selection,
      editorViewport: restoredPosition.viewport,
    };
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  async function hydrateSavedSqlTabs() {
    await initSavedSqlEditorPositions();
    const savedSqlStore = useSavedSqlStore();
    const linkedTabs = tabs.value.filter((tab) => tab.savedSqlId && tab.sql === "");
    for (const tab of linkedTabs) {
      const file = await savedSqlStore.ensureFileContent(tab.savedSqlId!);
      if (!file) continue;
      tab.title = tab.customTitle ? tab.title : file.name;
      tab.sql = file.sql;
      tab.originalSql = file.sql;
      const restored = restoreSavedSqlEditorPosition(file.id, file.sql);
      tab.editorSelection = restored.selection;
      tab.editorViewport = restored.viewport;
    }
  }

  function togglePinnedTab(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    tabs.value = orderPinnedFirst(tabs.value, (item) => !!item.pinned);
  }

  function reorderTab(id: string, targetId: string, position: "before" | "after") {
    const fromIdx = tabs.value.findIndex((t) => t.id === id);
    const toIdx = tabs.value.findIndex((t) => t.id === targetId);
    if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;
    const [tab] = tabs.value.splice(fromIdx, 1);
    const newToIdx = tabs.value.findIndex((t) => t.id === targetId);
    tabs.value.splice(newToIdx + (position === "after" ? 1 : 0), 0, tab);
    tabs.value = orderPinnedFirst(tabs.value, (item) => !!item.pinned);
  }

  function persistSavedSqlExecutionTarget(tab: QueryTab, options: UpdateExecutionTargetOptions) {
    if (options.persistSavedSqlTarget === false || tab.mode !== "query" || !tab.savedSqlId) return;
    const savedSqlStore = useSavedSqlStore();
    void savedSqlStore
      .updateFileExecutionTarget(tab.savedSqlId, {
        connectionId: tab.connectionId,
        database: tab.database,
        schema: tab.schema,
      })
      .catch((error) => console.warn("[DBX][saved-sql:target:error]", error));
  }

  function updateDatabase(id: string, database: string, options: UpdateExecutionTargetOptions = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.database === database) return;
    rollbackTabTransaction(tab);
    void closeResultSession(tab);
    void closeClientConnectionSession(tab);
    tab.database = database;
    tab.schema = undefined;
    tab.objectBrowser = undefined;
    clearResultPayload(tab);
    tab.lastExecutedSql = undefined;
    tab.resultBaseSql = undefined;
    tab.resultSortedSql = undefined;
    clearExplain(tab);
    tab.tableMeta = undefined;
    persistSavedSqlExecutionTarget(tab, options);
  }

  function updateCatalog(id: string, catalog: string | undefined, database: string, options: UpdateExecutionTargetOptions = {}) {
    const tab = tabs.value.find((candidate) => candidate.id === id);
    if (!tab || (tab.catalog === catalog && tab.database === database)) return;
    rollbackTabTransaction(tab);
    void closeResultSession(tab);
    void closeClientConnectionSession(tab);
    tab.catalog = catalog;
    tab.database = database;
    tab.schema = undefined;
    tab.objectBrowser = undefined;
    clearResultPayload(tab);
    tab.lastExecutedSql = undefined;
    tab.resultBaseSql = undefined;
    tab.resultSortedSql = undefined;
    clearExplain(tab);
    tab.tableMeta = undefined;
    persistSavedSqlExecutionTarget(tab, options);
  }

  function updateSchema(id: string, schema: string | undefined, options: UpdateExecutionTargetOptions = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.schema === schema) return;
    rollbackTabTransaction(tab);
    const clearsQuerySchema = tab.mode === "query" && tab.schema && !schema && supportsClearableQuerySchema(useConnectionStore().getConfig(tab.connectionId)?.db_type);
    if (clearsQuerySchema) {
      queueTabSessionReset(tab);
      clearResultPayload(tab);
      tab.lastExecutedSql = undefined;
      tab.resultBaseSql = undefined;
      tab.resultSortedSql = undefined;
      clearExplain(tab);
    }
    tab.schema = schema;
    if (tab.mode === "objects") tab.objectBrowser = { ...tab.objectBrowser, schema, viewport: undefined };
    persistSavedSqlExecutionTarget(tab, options);
  }

  function updateConnection(id: string, connectionId: string, database = "", options: UpdateExecutionTargetOptions = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.connectionId === connectionId) return;
    rollbackTabTransaction(tab, { resetAutoCommit: true });
    void closeResultSession(tab);
    void closeClientConnectionSession(tab);
    tab.connectionId = connectionId;
    tab.catalog = undefined;
    tab.database = database;
    tab.catalog = undefined;
    tab.objectBrowser = undefined;
    tab.schema = undefined;
    clearResultPayload(tab);
    tab.lastExecutedSql = undefined;
    tab.resultBaseSql = undefined;
    tab.resultSortedSql = undefined;
    clearExplain(tab);
    tab.tableMeta = undefined;
    persistSavedSqlExecutionTarget(tab, options);
  }

  function clearInvalidDataTabSortState(tab: QueryTab, columns: NonNullable<QueryTab["tableMeta"]>["columns"]): boolean {
    if (tab.mode !== "data") return false;
    const hasColumn = (name: string) => columns.some((column) => column.name === name);
    const structuredSortMissing = !!tab.resultSortColumn && !hasColumn(tab.resultSortColumn);
    const simpleOrderMissing = simpleDataGridOrderByReferencesMissingColumn(
      tab.orderByInput,
      columns.map((column) => column.name),
    );
    if (!structuredSortMissing && !simpleOrderMissing) return false;
    if (structuredSortMissing) {
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultSortedSql = undefined;
      tab.resultLocalSortOriginalRows = undefined;
      tab.resultLocalSortOriginalMongoDocuments = undefined;
      tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    }
    if (simpleOrderMissing) tab.orderByInput = undefined;
    return true;
  }

  function clearInvalidDataTabSort(id: string): boolean {
    const tab = tabs.value.find((candidate) => candidate.id === id);
    if (!tab?.tableMeta?.columns.length) return false;
    return clearInvalidDataTabSortState(tab, tab.tableMeta.columns);
  }

  function setTableMeta(id: string, meta: NonNullable<QueryTab["tableMeta"]>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) {
      tab.tableMeta = meta;
      tab.tableMetaUpdatedAt = Date.now();
      if (meta.columns.length > 0) clearInvalidDataTabSortState(tab, meta.columns);
      // 只有真实元数据（columns 非空）落地才结束行标识等待；多处调用方会先写
      // columns/primaryKeys 为空的占位身份（如 useNavigationTargets），不得
      // 借此提前解除编辑门控。失败/中止路径不清除——标签页保持只读是安全
      // 兜底，刷新或重开表会重新加载元数据恢复
      if (meta.columns.length > 0) tab.tableMetaPending = false;
    }
  }

  function setObjectSource(id: string, objectSource: NonNullable<QueryTab["objectSource"]>) {
    const tab = tabs.value.find((t) => t.id === id);
    if (tab) tab.objectSource = objectSource;
  }

  function setExecuting(id: string, isExecuting: boolean) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.isExecuting = isExecuting;
    tab.queryExecutionStartedAt = isExecuting ? Date.now() : undefined;
    if (!isExecuting) {
      tab.isCancelling = false;
      tab.executionId = undefined;
    }
  }

  function setExecutingWithId(id: string, executionId: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.isExecuting = true;
    tab.executionId = executionId;
    tab.isCancelling = false;
    tab.queryExecutionStartedAt = Date.now();
  }

  function clearExplain(tab: QueryTab) {
    tab.explainPlan = undefined;
    tab.explainTableResult = undefined;
    tab.explainError = undefined;
    tab.explainTableError = undefined;
    tab.explainSql = undefined;
    tab.explainTableSql = undefined;
    tab.lastExplainedSql = undefined;
    tab.isExplaining = false;
    tab.explainExecutionId = undefined;
    tab.explainClientSessionId = undefined;
  }

  function toErrorResult(e: any): NonNullable<QueryTab["result"]> {
    // Single funnel for every query execution failure, so backend messages DBX
    // knows about are shown in the active locale rather than as raw English.
    const error = normalizeBackendError(e) ?? undefined;
    const message = translateBackendError(i18n.global.t, e);
    return markQueryResultRowsRaw({
      columns: ["Error"],
      execution_error: true,
      error,
      rows: [[message]],
      affected_rows: 0,
      execution_time_ms: 0,
    });
  }

  function setErrorResult(id: string, e: any) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return;
    tab.result = toErrorResult(e);
    tab.results = undefined;
    tab.activeResultIndex = undefined;
    tab.resultSessionId = undefined;
    tab.isExecuting = false;
    tab.isCancelling = false;
    tab.queryExecutionStartedAt = undefined;
    tab.executionId = undefined;
    touchResult(tab);
  }

  function clearAcknowledgedCancelIfStillRunning(id: string, executionId: string) {
    setTimeout(() => {
      const current = tabs.value.find((t) => t.id === id);
      if (!current || current.executionId !== executionId || !current.isCancelling) {
        pendingResultRunRestores.delete(executionId);
        return;
      }
      finishBatchSqlExecution(current, executionId, true);
      current.isExecuting = false;
      current.isCancelling = false;
      current.executionId = undefined;
      current.queryExecutionStartedAt = undefined;
      if (!restorePendingResultRun(current, executionId)) {
        current.result = toErrorResult(new Error("Query canceled"));
        current.results = undefined;
        current.activeResultIndex = undefined;
        current.resultSessionId = undefined;
        touchResult(current);
      }
      clearLiveBatchSqlExecution(current, executionId);
    }, CANCEL_ACK_SETTLE_TIMEOUT_MS);
  }

  async function executeCurrentTab() {
    const tab = tabs.value.find((t) => t.id === activeTabId.value);
    if (!tab || !tab.sql.trim()) return;

    await executeCurrentSql(tab.sql);
  }

  async function executeCurrentSql(sql: string, options?: { skipRedisSafetyCheck?: boolean; sourceOffset?: number; openInNewResultTab?: boolean }) {
    if (!activeTabId.value) return;
    const tab = tabs.value.find((item) => item.id === activeTabId.value);
    if (tab?.mode === "query") {
      tab.resultSortColumn = undefined;
      tab.resultSortColumnIndex = undefined;
      tab.resultSortDirection = undefined;
      tab.resultSortMode = undefined;
      tab.resultSortedSql = undefined;
    }
    return await executeTabSql(activeTabId.value, sql, { resultBaseSql: sql, resultSortedSql: undefined, ...options });
  }

  type QueryMetadataPatch = Pick<QueryTab, "queryAnalysis" | "querySourceColumns" | "queryEditabilityReason" | "tableMeta">;

  type LoadedEditableSource = {
    source: EditableQuerySource;
    analysis: EditableQueryInfo;
    tableMeta: NonNullable<QueryTab["tableMeta"]>;
  };

  type EditableSourceMetadataTarget = {
    source: EditableQuerySource;
    analysis: EditableQueryInfo;
    request: TableMetadataRequest;
    writeSchema?: string;
  };

  interface EditableQueryExecutionPreparation {
    sql: string;
    metadataSql: string;
    hiddenPrimaryKeys: HiddenPrimaryKeyProjection[];
  }

  function applyQueryMetadataPatch(tab: QueryTab, patch: QueryMetadataPatch) {
    tab.queryAnalysis = patch.queryAnalysis;
    tab.querySourceColumns = patch.querySourceColumns;
    tab.queryEditabilityReason = patch.queryEditabilityReason;
    tab.mongoEditTarget = undefined;
    tab.tableMeta = patch.tableMeta;
  }

  function resolveEditableSourceMetadataTarget(tab: QueryTab, analysis: EditableQueryInfo, source: EditableQuerySource, conn: ConnectionConfig | undefined, dbType: string, executionDatabase: string): EditableSourceMetadataTarget {
    // Metadata must resolve in the same namespace as the query execution. An
    // empty query-tab database still executes in the connection's default DB,
    // while database-tree dialects and SQL Server 3-part names may override it
    // with a qualified source.
    const qualifiedSourceDatabase = dbType === "sqlserver" ? source.catalog : connectionUsesDatabaseObjectTreeMode(conn) ? source.schema : undefined;
    const metadataDatabase = qualifiedSourceDatabase || executionDatabase || conn?.database || tab.database;
    // SQL Server does not apply the query tab's selected schema to an
    // unqualified object reference. Resolve metadata through the login's
    // default schema (with the driver's dbo fallback) so metadata and writes
    // target the same object as the original SELECT.
    let schema = source.schema || (dbType === "sqlserver" ? "" : tab.schema);
    if (!schema) {
      if (dbType === "postgres" || dbType === "kwdb") schema = "public";
      else schema = "";
    }
    // Oracle-family connection databases are service names, not schemas. When
    // the query does not qualify a schema, let the driver resolve the current
    // login user's schema instead of looking up metadata under the service name.
    const resolvedSchema = (dbType === "sqlserver" && !source.schema) || (ORACLE_LIKE_METADATA_TYPES.has(dbType) && !schema) ? "" : metadataSchemaForConnection(conn, metadataDatabase, schema || undefined);
    const metadataSchema = normalizeOracleLikeMetadataIdentifier(dbType, resolvedSchema || undefined, source.schema ? source.schemaQuoted : false) || "";
    const metadataTableName = normalizeOracleLikeMetadataIdentifier(dbType, source.tableName, source.tableNameQuoted)!;
    const metadataCatalog = normalizeOracleLikeMetadataIdentifier(dbType, source.catalog, source.catalogQuoted);
    const metadataSource: EditableQuerySource = {
      ...source,
      catalog: metadataCatalog,
      schema: metadataSchema || undefined,
      tableName: metadataTableName,
    };
    // Keep SQL Server writes unqualified unless the SELECT source explicitly
    // named a schema, so SELECT and UPDATE resolve the same object.
    const writeSchema = dbType === "sqlserver" && !source.schema ? undefined : metadataSchema || undefined;
    const knownTableType = tab.tableMeta?.tableName.toLowerCase() === metadataTableName.toLowerCase() && normalizeOptionalSchema(tab.tableMeta.schema) === normalizeOptionalSchema(metadataSchema) ? tab.tableMeta.tableType : undefined;
    return {
      source: metadataSource,
      analysis: normalizeOracleLikeQueryAnalysis(dbType, cloneAnalysisForSource(analysis, metadataSource), metadataSchema || undefined, metadataTableName),
      writeSchema,
      request: {
        connectionId: tab.connectionId!,
        database: metadataDatabase,
        schema: metadataSchema,
        tableName: metadataTableName,
        tableType: knownTableType,
        databaseType: dbType,
        driverProfile: conn?.driver_profile || conn?.db_type,
        catalog: metadataCatalog,
      },
    };
  }

  function loadedEditableSourceFromMetadata(target: EditableSourceMetadataTarget, metadata: Awaited<ReturnType<typeof loadTableMetadata>>["metadata"]): LoadedEditableSource {
    return {
      source: target.source,
      analysis: target.analysis,
      tableMeta: {
        catalog: target.request.catalog,
        database: target.request.database,
        schema: target.writeSchema,
        tableName: target.request.tableName,
        tableType: metadata.tableType,
        columns: metadata.columns,
        primaryKeys: metadata.primaryKeys,
      },
    };
  }

  async function loadEditableQuerySource(tab: QueryTab, analysis: EditableQueryInfo, source: EditableQuerySource, conn: ConnectionConfig | undefined, dbType: string, executionDatabase: string, traceId?: string, elapsed?: () => string): Promise<LoadedEditableSource> {
    const target = resolveEditableSourceMetadataTarget(tab, analysis, source, conn, dbType, executionDatabase);
    queryExecutionLog("info", "metadata:table:start", {
      traceId,
      schema: target.request.schema,
      table: target.request.tableName,
      alias: source.alias,
      elapsed: elapsed?.(),
    });
    const loadedMetadata = await loadTableMetadata({
      ...target.request,
      traceLogger: (event) => queryExecutionLog("debug", "metadata:table-trace", { sourceTraceId: traceId, ...event }),
    });
    const columns = loadedMetadata.metadata.columns;
    const primaryKeys = loadedMetadata.metadata.primaryKeys;
    queryExecutionLog("info", "metadata:table:done", {
      traceId,
      columnCount: columns.length,
      primaryKeyCount: primaryKeys.length,
      cacheStatus: loadedMetadata.cacheStatus,
      ageMs: Math.round(loadedMetadata.ageMs),
      elapsed: elapsed?.(),
    });
    return loadedEditableSourceFromMetadata(target, loadedMetadata.metadata);
  }

  function missingPrimaryKeysForSource(primaryKeys: string[], analysis: EditableQueryInfo, sourceKey: string): string[] {
    if (analysis.selectStar) return [];
    const selectedColumns = new Set(analysis.columns.flatMap((column) => (column.sourceName && column.sourceKey === sourceKey ? [column.sourceName] : [])));
    return primaryKeys.filter((primaryKey) => !selectedColumns.has(primaryKey));
  }

  async function oracleRowIdIsSafeForQuery(tab: QueryTab, loaded: LoadedEditableSource): Promise<boolean> {
    const knownType = loaded.tableMeta.tableType?.trim().toUpperCase();
    if (knownType) return knownType === "TABLE";
    const objects = await api.listObjects(tab.connectionId!, loaded.tableMeta.database ?? tab.database, loaded.tableMeta.schema ?? "", ["TABLE", "VIEW", "MATERIALIZED_VIEW"], loaded.tableMeta.tableName, 20, 0, loaded.tableMeta.catalog);
    const matching = objects.find((object) => object.name.toLowerCase() === loaded.tableMeta.tableName.toLowerCase());
    return matching?.object_type.trim().toUpperCase() === "TABLE";
  }

  function primaryKeyIndex(indexes: IndexInfo[]): IndexInfo | undefined {
    return indexes.find((index) => !index.filter && index.columns.length > 0 && index.is_primary);
  }

  function buildHiddenPrimaryKeyPreparation(sql: string, databaseType: DatabaseType, loaded: LoadedEditableSource, primaryKeys: string[], declaredPrimaryKeys: string[], traceId: string, elapsed: () => string): EditableQueryExecutionPreparation {
    const unchanged = { sql, metadataSql: sql, hiddenPrimaryKeys: [] };
    const metadataAnalysis = expandStarProjectionColumnsForSource(bindColumnsForSource(databaseType, loaded.analysis, loaded.source, loaded.tableMeta.columns), loaded.source, loaded.tableMeta.columns);
    const missingPrimaryKeys = declaredPrimaryKeys.length === 0 ? primaryKeys : missingPrimaryKeysForSource(primaryKeys, metadataAnalysis, loaded.source.key);
    if (missingPrimaryKeys.length === 0) return unchanged;
    const primaryKeySet = new Set(primaryKeys);
    const hasWritableProjection = metadataAnalysis.selectStar ? loaded.tableMeta.columns.some((column) => !primaryKeySet.has(column.name)) : metadataAnalysis.columns.some((column) => column.sourceName && column.sourceKey === loaded.source.key && !primaryKeySet.has(column.sourceName));
    if (!hasWritableProjection) return unchanged;

    const rewritten = buildQueryWithHiddenPrimaryKeys({
      sql,
      databaseType,
      primaryKeys: missingPrimaryKeys,
      existingResultNames: metadataAnalysis.selectStar ? loaded.tableMeta.columns.map((column) => column.name) : metadataAnalysis.columns.map((column) => column.resultName),
      sourceExpressions: databaseType === "oracle" && missingPrimaryKeys.includes(DBX_ROWID_COLUMN) ? { [DBX_ROWID_COLUMN]: "ROWIDTOCHAR(ROWID)" } : undefined,
    });
    if (!rewritten) return unchanged;
    queryExecutionLog("info", "hidden-primary-keys", {
      traceId,
      table: loaded.tableMeta.tableName,
      keyCount: rewritten.projections.length,
      elapsed: elapsed(),
    });
    return { sql: rewritten.sql, metadataSql: rewritten.sql, hiddenPrimaryKeys: rewritten.projections };
  }

  async function prepareEditableQueryExecution(tab: QueryTab, sql: string, conn: ConnectionConfig | undefined, databaseType: DatabaseType | undefined, executionDatabase: string, traceId: string, elapsed: () => string): Promise<EditableQueryExecutionPreparation> {
    const unchanged = { sql, metadataSql: sql, hiddenPrimaryKeys: [] };
    if (!databaseType || !HIDDEN_QUERY_KEY_DATABASE_TYPES.has(databaseType) || !tab.connectionId) return unchanged;

    try {
      const editability = analyzeEditableQueryEditability(sql);
      if (!editability.editable || !editability.analysis) return unchanged;
      const analysis = editability.analysis;
      const sources = editableQuerySources(analysis);
      if (sources.length !== 1 || analysis.distinct) return unchanged;
      // Whole-source projections already include declared primary keys. Only
      // Oracle needs preflight metadata here to add ROWID for a keyless table.
      if (databaseType !== "oracle" && projectsAllColumnsForSource(analysis, sources[0]!.key)) return unchanged;

      const target = resolveEditableSourceMetadataTarget(tab, analysis, sources[0]!, conn, databaseType, executionDatabase);
      const cached = getCachedTableMetadata(target.request);
      let loaded = cached ? loadedEditableSourceFromMetadata(target, cached.metadata) : undefined;
      if (!cached && databaseType === "oracle") {
        // Oracle column discovery can be slow. A star projection over a table
        // with a declared primary key already returns the complete row identity,
        // so SQL can start while the full metadata needed for editing loads.
        const fullMetadataPromise = loadTableMetadata({
          ...target.request,
          traceLogger: (event) => queryExecutionLog("debug", "metadata:table-trace", { sourceTraceId: traceId, ...event }),
        });
        void fullMetadataPromise.catch((error) => queryExecutionLog("warn", "metadata:table-prefetch:failed", { traceId, error, elapsed: elapsed() }));
        const indexes = await loadTableIndexes(target.request);
        if (primaryKeyIndex(indexes) && projectsAllColumnsForSource(target.analysis, target.source.key)) {
          return unchanged;
        }
        loaded = loadedEditableSourceFromMetadata(target, (await fullMetadataPromise).metadata);
      }

      loaded ??= await loadEditableQuerySource(tab, analysis, sources[0]!, conn, databaseType, executionDatabase, traceId, elapsed);
      if (loaded.tableMeta.columns.length === 0) return unchanged;
      if (loaded.tableMeta.tableType?.toUpperCase().includes("VIEW")) return unchanged;
      const declaredPrimaryKeys = loaded.tableMeta.columns.filter((column) => column.is_primary_key).map((column) => column.name);
      // Oracle base tables without declared keys use the same ROWID identity as
      // table-data tabs. Confirm the object is a base table because selecting
      // ROWID from a view can fail with ORA-01445.
      if (databaseType === "oracle" && declaredPrimaryKeys.length === 0 && !(await oracleRowIdIsSafeForQuery(tab, loaded))) return unchanged;
      const primaryKeys = editablePrimaryKeys(databaseType, loaded.tableMeta.columns, loaded.tableMeta.tableType);
      return buildHiddenPrimaryKeyPreparation(sql, databaseType, loaded, primaryKeys, declaredPrimaryKeys, traceId, elapsed);
    } catch (error) {
      // Metadata enrichment is optional. Query execution must retain its prior
      // behavior when metadata is unavailable or the SQL cannot be rewritten.
      queryExecutionLog("warn", "hidden-primary-keys:skip", { traceId, error, elapsed: elapsed() });
      return unchanged;
    }
  }

  async function buildQueryMetadataPatch(tab: QueryTab, sql: string, executionDatabase: string, traceId?: string, elapsed?: () => string, hiddenPrimaryKeys: HiddenPrimaryKeyProjection[] = []): Promise<QueryMetadataPatch | undefined> {
    if (tab.mode !== "query") return;
    if (!tab.result || !tab.result.columns.length) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: undefined,
        tableMeta: undefined,
      };
    }

    queryExecutionLog("info", "metadata:editability:start", { traceId, elapsed: elapsed?.() });
    const editability = await api.analyzeEditableQueryEditability(sql);
    queryExecutionLog("info", "metadata:editability:done", {
      traceId,
      editable: editability.editable,
      reason: editability.editable ? undefined : editability.reason,
      elapsed: elapsed?.(),
    });
    if (!editability.editable) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: editability.reason,
        tableMeta: undefined,
      };
    }
    const analysis = editability.analysis;

    if (!tab.connectionId) {
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: "metadata-unavailable",
        tableMeta: undefined,
      };
    }

    const connStore = useConnectionStore();
    const conn = connStore.getConfig(tab.connectionId);
    const dbType = conn?.db_type || "";
    const sources = editableQuerySources(analysis);
    const loadedSources: LoadedEditableSource[] = [];
    try {
      for (const source of sources) {
        loadedSources.push(await loadEditableQuerySource(tab, analysis, source, conn, dbType, executionDatabase, traceId, elapsed));
      }

      const allSourceColumns = loadedSources.map((source) => ({ source: source.source, columns: source.tableMeta.columns }));
      // Match DBeaver's safety model: a joined result is writable only when one
      // source table has a complete row identifier and at least one writable column.
      const candidates = loadedSources
        .map((loaded) => {
          const metadataAnalysis = expandStarProjectionColumnsForSource(bindColumnsForSource(dbType, loaded.analysis, loaded.source, loaded.tableMeta.columns, allSourceColumns), loaded.source, loaded.tableMeta.columns);
          const primaryKeys = loaded.tableMeta.primaryKeys;
          const sourceColumns = sourceColumnsForResult(metadataAnalysis, tab.result!.columns, loaded.source.key);
          const primaryKeysPresent = primaryKeysPresentForSource(dbType, primaryKeys, tab.result!.columns, metadataAnalysis, loaded.source.key, loaded.tableMeta.columns);
          const keylessAllowed = sources.length === 1 && canUseKeylessRowPredicate(dbType as DatabaseType, primaryKeys);
          const primaryKeySet = new Set(primaryKeys);
          const editableSourceColumnCount = (sourceColumns ?? []).filter((column) => column && !primaryKeySet.has(column)).length;
          return {
            ...loaded,
            analysis: metadataAnalysis,
            sourceColumns,
            primaryKeysPresent,
            keylessAllowed,
            editableSourceColumnCount,
          };
        })
        .filter((loaded) => (loaded.primaryKeysPresent || loaded.keylessAllowed) && !!loaded.sourceColumns && loaded.editableSourceColumnCount > 0);

      if (loadedSources.length === 1) {
        const loaded = loadedSources[0]!;
        const metadataAnalysis = expandStarProjectionColumnsForSource(bindColumnsForSource(dbType, loaded.analysis, loaded.source, loaded.tableMeta.columns, allSourceColumns), loaded.source, loaded.tableMeta.columns);
        const syntheticRowIdProjection = hiddenPrimaryKeys.find((projection) => projection.sourceName.toUpperCase() === DBX_ROWID_COLUMN);
        const primaryKeys = loaded.tableMeta.primaryKeys.length === 0 && syntheticRowIdProjection ? [DBX_ROWID_COLUMN] : loaded.tableMeta.primaryKeys;
        const sourceColumns = sourceColumnsForResult(metadataAnalysis, tab.result.columns, loaded.source.key);
        if (sourceColumns && syntheticRowIdProjection) {
          const resultIndex = tab.result.columns.findIndex((column) => column.toLowerCase() === syntheticRowIdProjection.alias.toLowerCase());
          if (resultIndex >= 0) sourceColumns[resultIndex] = DBX_ROWID_COLUMN;
        }
        if (primaryKeys.length === 0 && !canUseKeylessRowPredicate(dbType as DatabaseType, primaryKeys)) {
          return {
            queryAnalysis: undefined,
            querySourceColumns: undefined,
            queryEditabilityReason: "no-primary-key",
            tableMeta: loaded.tableMeta,
          };
        }

        const primaryKeysPresent = syntheticRowIdProjection ? sourceColumns?.some((column) => column?.toUpperCase() === DBX_ROWID_COLUMN) === true : primaryKeysPresentForSource(dbType, primaryKeys, tab.result.columns, metadataAnalysis, loaded.source.key, loaded.tableMeta.columns);
        if (!primaryKeysPresent) {
          return {
            queryAnalysis: undefined,
            querySourceColumns: undefined,
            queryEditabilityReason: "primary-key-not-returned",
            tableMeta: loaded.tableMeta,
          };
        }

        if (!allEditableColumnsWriteable(metadataAnalysis, tab.result.columns)) {
          return {
            queryAnalysis: undefined,
            querySourceColumns: undefined,
            queryEditabilityReason: "aliased-columns",
            tableMeta: loaded.tableMeta,
          };
        }

        return {
          queryAnalysis: metadataAnalysis,
          querySourceColumns: sourceColumns,
          queryEditabilityReason: undefined,
          tableMeta: primaryKeys === loaded.tableMeta.primaryKeys ? loaded.tableMeta : { ...loaded.tableMeta, primaryKeys },
        };
      }

      if (candidates.length === 0) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: loadedSources.some((loaded) => loaded.tableMeta.primaryKeys.length > 0) ? "primary-key-not-returned" : "no-primary-key",
          tableMeta: undefined,
        };
      }

      if (candidates.length > 1) {
        return {
          queryAnalysis: undefined,
          querySourceColumns: undefined,
          queryEditabilityReason: "complex-source",
          tableMeta: undefined,
        };
      }

      const target = candidates[0]!;
      const queryAnalysis = {
        ...target.analysis,
        allowInsertDelete: false,
        multiSource: true,
      };
      return {
        queryAnalysis,
        querySourceColumns: target.sourceColumns,
        queryEditabilityReason: undefined,
        tableMeta: target.tableMeta,
      };
    } catch (err) {
      console.error("[DBX] ERROR fetching columns for query metadata:", err);
      return {
        queryAnalysis: undefined,
        querySourceColumns: undefined,
        queryEditabilityReason: "metadata-unavailable",
        tableMeta: undefined,
      };
    }
  }

  function analyzeQueryMetadataInBackground(tabId: string, sql: string, result: QueryResult, executionDatabase: string, traceId: string, elapsed: () => string, databaseType: DatabaseType | undefined, hiddenPrimaryKeys: HiddenPrimaryKeyProjection[] = []) {
    void (async () => {
      const tab = tabs.value.find((t) => t.id === tabId);
      if (!tab || tab.result !== result) return;
      queryExecutionLog("info", "metadata:start", { traceId, elapsed: elapsed() });
      const patch = await buildQueryMetadataPatch(tab, sql, executionDatabase, traceId, elapsed, hiddenPrimaryKeys);
      if (patch?.queryAnalysis && hasHiddenPhysicalRowKey(databaseType, hiddenPrimaryKeys)) {
        patch.queryAnalysis = { ...patch.queryAnalysis, allowInsert: false };
      }
      const current = tabs.value.find((t) => t.id === tabId);
      if (patch && current?.result === result) {
        applyQueryMetadataPatch(current, patch);
        syncActiveResultRunFromDisplayed(current);
        queryExecutionLog("info", "metadata:done", { traceId, elapsed: elapsed() });
      } else {
        queryExecutionLog("warn", "metadata:stale", { traceId, elapsed: elapsed() });
      }
    })();
  }

  function setQueryTotalRowCountIfCurrent(tabId: string, executionId: string, result: QueryResult, totalRowCount: number | undefined) {
    const current = tabs.value.find((t) => t.id === tabId);
    if (!current || (current.mode !== "query" && current.mode !== "data")) return;
    if (current.executionId !== executionId && current.result !== result) return;
    current.resultTotalRowCount = totalRowCount;
    current.resultTotalRowCountLoading = false;
    syncActiveResultRunFromDisplayed(current);
  }

  type TotalRowCountSqlTarget = { sql: string; schema?: string };

  function countQueryTotalRowsInBackground(options: {
    tabId: string;
    connectionId: string;
    database: string;
    schema?: string;
    catalog?: string;
    countSql?: string;
    countSqlTarget?: () => Promise<TotalRowCountSqlTarget | undefined>;
    result: QueryResult;
    pageLimit?: number;
    pageOffset?: number;
    useAgentResultSession?: boolean;
    executionId: string;
    traceId: string;
    elapsed: () => string;
    timeoutSecs: number;
  }) {
    const resultRowCount = options.result.rows.length;
    if (resultRowCount <= 0) {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
      return;
    }
    const exactIncompletePageTotal = exactTotalFromIncompletePage(options.result, options.pageLimit, options.pageOffset, options.useAgentResultSession);
    if (typeof exactIncompletePageTotal === "number") {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, exactIncompletePageTotal);
      return;
    }

    // A full page was returned, so more rows may exist and determining the true
    // total requires a potentially expensive COUNT(*) over the user's query.
    // Only run it automatically when the user opted in; otherwise leave the
    // total unknown and let them trigger it on demand from the result grid
    // (matches DBeaver's default of not counting large result sets).
    if (!useSettingsStore().editorSettings.autoCalculateTotalRows) {
      setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
      return;
    }

    const clientSessionId = tabClientSessionId({ id: options.tabId }, "count");
    const countExecutionId = `${options.executionId}:count`;
    void (async () => {
      try {
        const countTarget = options.countSql ? { sql: options.countSql, schema: options.schema } : await options.countSqlTarget?.();
        if (!countTarget?.sql) {
          setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
          return;
        }
        queryExecutionLog("info", "count:start", { traceId: options.traceId, elapsed: options.elapsed() });
        const countResult = await api.executeQuery(options.connectionId, options.database, countTarget.sql, countTarget.schema, countExecutionId, {
          clientSessionId,
          catalog: options.catalog,
          timeoutSecs: options.timeoutSecs,
        });
        const total = Number(countResult.rows?.[0]?.[0] ?? 0);
        if (!Number.isFinite(total) || total < 0) {
          setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
          return;
        }
        setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, total);
        queryExecutionLog("info", "count:done", {
          traceId: options.traceId,
          total,
          elapsed: options.elapsed(),
        });
      } catch (error) {
        setQueryTotalRowCountIfCurrent(options.tabId, options.executionId, options.result, undefined);
        queryExecutionLog("warn", "count:error", {
          traceId: options.traceId,
          elapsed: options.elapsed(),
          error,
        });
      } finally {
        void closeClientSessionId(options.connectionId, options.database, clientSessionId, options.catalog, { tabId: options.tabId });
      }
    })();
  }

  async function executeTabSql(
    id: string,
    sql: string,
    options?: {
      resultBaseSql?: string;
      resultSortedSql?: string | undefined;
      querySort?: {
        resultColumns: string[];
        columnIndex: number;
        column: string;
        direction: "asc" | "desc";
      };
      pagination?: { limit: number; offset: number; sessionId?: string };
      appendResult?: { maxRows: number };
      mongoSafety?: MongoAggregateSafetyOptions;
      preserveResultDuringExecution?: boolean;
      preserveTotalRowCountDuringExecution?: boolean;
      preserveActiveResultIndex?: boolean;
      replaceActiveResultInGroup?: boolean;
      skipRedisSafetyCheck?: boolean;
      sourceOffset?: number;
      sourceTraceId?: string;
      skipEnsureConnected?: boolean;
      openInNewResultTab?: boolean;
    },
  ) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !sql.trim()) return;

    const openInNewResultTab = tab.mode === "query" && options?.openInNewResultTab === true;
    if (openInNewResultTab && tab.activeResultRunId && !tab.result) {
      await setActiveResultRun(id, tab.activeResultRunId);
      if (tabs.value.find((item) => item.id === id) !== tab) return false;
    }
    const executionId = uuid();
    const executionEditorFingerprint = tab.mode === "query" ? sqlTextFingerprint(tab.sql) : undefined;
    const traceId = executionId.slice(0, 8);
    const startedAt = performance.now();
    const elapsed = () => `${Math.round(performance.now() - startedAt)}ms`;
    tab.isExecuting = true;
    tab.isCancelling = false;
    if (!tab.queryExecutionStartedAt) {
      tab.queryExecutionStartedAt = Date.now();
    }
    tab.executionId = executionId;
    const tableDataNativeSelectionBlockOwner = tab.mode === "data" ? {} : undefined;
    if (tableDataNativeSelectionBlockOwner) beginDataGridNativeSelectionBlock(tableDataNativeSelectionBlockOwner);
    const previousDisplayedSql = tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
    tab.lastExecutedSql = sql;
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultLocalSortOriginalMongoDocuments = undefined;
    tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    if (openInNewResultTab && tab.result && !tab.activeResultRunId) {
      captureDisplayedResultRun(tab, previousDisplayedSql);
    }
    if (openInNewResultTab && tab.activeResultRunId) {
      pendingResultRunRestores.set(executionId, tab.activeResultRunId);
    }
    tab.batchSqlExecution = undefined;
    liveBatchSqlExecutions.delete(tab);
    const preserveResultDuringExecution = options?.preserveResultDuringExecution === true || (tab.mode === "query" && !!tab.activeResultRunId && !tab.resultAutoSave && !openInNewResultTab);
    const updateActiveResultRun = !!tab.activeResultRunId && preserveResultDuringExecution;
    if (!updateActiveResultRun) {
      tab.activeResultRunId = undefined;
    }
    if (!options?.preserveTotalRowCountDuringExecution) {
      tab.resultTotalRowCount = undefined;
    }
    tab.resultTotalRowCountLoading = false;
    const previousResultSessionClose = closeResultSession(tab, options?.pagination?.sessionId);
    if (!preserveResultDuringExecution || !tab.result) {
      clearResultPayload(tab, { preserveCacheSnapshot: openInNewResultTab && pendingResultRunRestores.has(executionId) });
    }
    queryExecutionLog("info", "start", {
      traceId,
      tabId: id,
      mode: tab.mode,
      sourceTraceId: options?.sourceTraceId,
      sqlLength: sql.length,
    });
    const queryBaseSql = options?.resultBaseSql ?? sql;
    let sqlToExecute = sql;
    let resultSortedSql = options?.resultSortedSql;
    let queryMetadataSql = queryBaseSql;
    let hiddenPrimaryKeys: HiddenPrimaryKeyProjection[] = [];
    let pageSql: string | undefined;
    let pageLimit: number | undefined;
    let pageOffset: number | undefined;
    let countSql: string | undefined;
    let useAgentResultSession = false;
    let executionDispatched = false;
    let producedResult = false;
    try {
      await waitForTabSessionReset(id);
      const connStore = useConnectionStore();
      let conn = connStore.getConfig(tab.connectionId);
      const parsedMongoCommands = conn?.db_type === "mongodb" ? splitMongoCommandRanges(sql) : undefined;
      let mongoCommands = parsedMongoCommands ?? [];
      const mongoNeedsConnection = mongoCommands.some(({ command }) => command.kind !== "use");

      if (options?.skipEnsureConnected) {
        queryExecutionLog("info", "ensure-connected:skip", { traceId, elapsed: elapsed(), reason: "caller" });
      } else if (conn?.db_type === "mongodb" && mongoCommands.length > 0 && !mongoNeedsConnection) {
        queryExecutionLog("info", "ensure-connected:skip", { traceId, elapsed: elapsed(), reason: "mongo-use-only" });
      } else {
        queryExecutionLog("info", "ensure-connected:start", { traceId, elapsed: elapsed() });
        await connStore.ensureConnected(tab.connectionId);
        queryExecutionLog("info", "ensure-connected:done", { traceId, elapsed: elapsed() });
      }
      conn = connStore.getConfig(tab.connectionId);
      if (parsedMongoCommands === undefined && conn?.db_type === "mongodb") {
        mongoCommands = splitMongoCommandRanges(sql);
      }
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const executionDatabase = dataTabExecutionDatabase(conn, tab.database, tab.mode === "data" ? tab.tableMeta?.catalog : tab.catalog);
      const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const settingsStore = useSettingsStore();
      const statementExecution = tab.mode === "query" ? createBatchSqlExecution(executionId, tab.sql, sql, effectiveDbType, options?.sourceOffset) : undefined;
      tab.batchSqlExecution = statementExecution && (tab.autoCommit !== false || statementExecution.total === 1) ? statementExecution : undefined;
      if (tab.batchSqlExecution) liveBatchSqlExecutions.set(tab, tab.batchSqlExecution);
      queryExecutionLog("info", "previous-session-close:start", { traceId, elapsed: elapsed() });
      await previousResultSessionClose;
      queryExecutionLog("info", "previous-session-close:done", { traceId, elapsed: elapsed() });

      // Redis command execution — split multi-line input into individual commands
      if (conn?.db_type === "redis") {
        await connStore.ensureConnected(tab.connectionId);
        let currentDb = Number(tab.database) || 0;
        const commands = sql
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        if (commands.length === 0) return false;
        queryExecutionLog("info", "redis:start", { traceId, db: currentDb, commandCount: commands.length, sqlLength: sql.length });

        const allResults: QueryResult[] = [];
        const commandRanges = executableStatementRanges(sql, "redis");
        const skipSafety = options?.skipRedisSafetyCheck;
        let hadMutatingCommand = false;
        for (const [commandIndex, command] of commands.entries()) {
          const commandRange = commandRanges[commandIndex];
          const sourceRange = commandRange && options?.sourceOffset !== undefined ? { from: options.sourceOffset + commandRange.from, to: options.sourceOffset + commandRange.to } : undefined;
          try {
            const result = await api.redisExecuteCommand(tab.connectionId, currentDb, command, skipSafety);
            allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(redisCommandResultToQueryResult(result.value, performance.now() - startedAt, result.command), command, undefined, undefined, sourceRange)));
            // Track db switches from SELECT N so later commands in the same batch run on the right db.
            currentDb = nextRedisCommandDb(currentDb, command, result.value);
            // Write commands (SET/DEL/...) mutate the key set — drop the cached key-name completion
            // for the db this command ran on so the next autocomplete fetch reflects the new keys.
            if (isRedisMutatingCommand(command)) {
              hadMutatingCommand = true;
              connStore.invalidateCompletionCache(tab.connectionId, String(currentDb));
            }
          } catch (e: any) {
            allResults.push(annotateQueryResultSource(toErrorResult(e), command, undefined, undefined, sourceRange));
          }
        }
        queryExecutionLog("info", "redis:done", { traceId, commandCount: commands.length, elapsed: elapsed() });

        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          if (openInNewResultTab && current.isCancelling && restorePendingResultRun(current, executionId)) return false;
          if (allResults.length > 1) {
            const activeResultIndex = allResults.findIndex((result) => !isQueryExecutionErrorResult(result));
            const resultIndex = preservedResultIndex(allResults, current.activeResultIndex, options?.preserveActiveResultIndex) ?? (activeResultIndex >= 0 ? activeResultIndex : 0);
            current.results = allResults;
            current.activeResultIndex = resultIndex;
            current.result = allResults[resultIndex];
          } else {
            current.results = undefined;
            current.activeResultIndex = undefined;
            current.result = allResults[0];
          }
          producedResult = current.result !== undefined;
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.mongoEditTarget = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = options?.resultSortedSql;
          syncDisplayedResultRun(current, options?.resultBaseSql ?? sql, openInNewResultTab);
          // Reflect db switches from SELECT N in the tab so the toolbar dropdown, tab title and
          // sidebar stay in sync with the command's effective db.
          if (current.database !== String(currentDb)) {
            current.database = String(currentDb);
          }
        }
        // Refresh the sidebar db key counts (INFO keyspace) when at least one command in
        // this batch mutated the key set, so `dbN (count)` stays accurate without a manual
        // refresh. Fire-and-forget: never block result display.
        if (hadMutatingCommand) {
          void connStore.refreshRedisDbKeyCounts(tab.connectionId);
        }
        return producedResult;
      }

      if (conn?.db_type === "mongodb" && mongoCommands.length === 0 && sql.trim()) {
        // Avoid falling through to the SQL executor, which only returns the generic
        // "Use MongoDB-specific commands" rejection and hides parse/syntax details.
        throw new Error(describeMongoCommandParseFailure(sql));
      }

      if (mongoCommands.length > 0) {
        queryExecutionLog("info", "mongo:start", { traceId, commandCount: mongoCommands.length, sqlLength: sql.length });

        const allResults: QueryResult[] = [];
        // Track the effective db as we walk the batch so later commands observe
        // earlier `use ...` statements in the same editor selection.
        let currentDatabase = tab.database;
        let mongoEditTarget: QueryTab["mongoEditTarget"] | undefined;
        let mongoFindPageState: { pageLimit: number; pageOffset: number; total: number; totalIsExact: boolean } | undefined;

        for (const parsedCommand of mongoCommands) {
          let mongoCommand = parsedCommand.command;
          const sourceStatement = parsedCommand.text;
          const sourceRange = options?.sourceOffset === undefined ? undefined : { from: options.sourceOffset + parsedCommand.from, to: options.sourceOffset + parsedCommand.to };
          const commandStartedAt = performance.now();
          const annotateMongoResult = (result: QueryResult): QueryResult => {
            const annotated = annotateQueryResultSource(result, sourceStatement, undefined, undefined, sourceRange);
            if ("collection" in mongoCommand) {
              annotated.sourceLabel = currentDatabase ? `${currentDatabase}.${mongoCommand.collection}` : mongoCommand.collection;
            }
            return annotated;
          };
          try {
            // The frontend parser remains responsible for editor ranges, while
            // dbx-core is authoritative for command semantics at execution time.
            mongoCommand = await api.mongoParseShellCommand(sourceStatement);
            switch (mongoCommand.kind) {
              case "find": {
                queryExecutionLog("info", "mongo-find:start", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const pagePlan = planMongoFindPagination(sourceStatement, mongoCommand, options?.pagination?.offset ?? 0, normalizeResultPageSize(options?.pagination?.limit ?? settingsStore.editorSettings.pageSize));
                if (!pagePlan) throw new Error(describeMongoCommandParseFailure(sourceStatement));
                // A stale request can point past an explicit .limit() bound. Keep
                // the backend call bounded so limit(0) cannot become unbounded.
                const result = await api.mongoFindDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, pagePlan.requestSkip, Math.max(1, pagePlan.requestLimit), mongoCommand.filter, mongoCommand.projection, mongoCommand.sort, mongoCommand.collation, executionId);
                const documents = pagePlan.requestLimit === 0 ? [] : result.documents;
                const extendedDocuments = pagePlan.requestLimit === 0 ? [] : result.extended_documents;
                const totalIsExact = result.total_is_exact !== false;
                const reportedTotal = mongoFindLogicalTotal(result.total, pagePlan);
                const loadedLowerBound = pagePlan.pageOffset + documents.length;
                const total = totalIsExact ? reportedTotal : Math.max(reportedTotal, loadedLowerBound);
                const hasMore = totalIsExact ? loadedLowerBound < total : pagePlan.requestLimit > 0 && documents.length >= pagePlan.requestLimit && (pagePlan.logicalLimit === undefined || loadedLowerBound < pagePlan.logicalLimit);
                const queryResult = markQueryResultRowsRaw(annotateMongoResult(mongoDocumentsToQueryResult(documents, performance.now() - commandStartedAt, total, extendedDocuments, totalIsExact)));
                queryResult.truncated = hasMore;
                queryResult.has_more = hasMore;
                allResults.push(queryResult);
                if (mongoCommands.length === 1) {
                  mongoFindPageState = { pageLimit: pagePlan.pageLimit, pageOffset: pagePlan.pageOffset, total, totalIsExact };
                }
                mongoEditTarget = mongoCommands.length === 1 && !mongoCommand.projection && queryResult.columns.includes("_id") ? { collection: mongoCommand.collection, idColumn: "_id" } : undefined;
                queryExecutionLog("info", "mongo-find:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  total: result.total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "findOne": {
                queryExecutionLog("info", "mongo-find-one:start", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const result = await api.mongoFindOne(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.projection, mongoCommand.options, executionId);
                const queryResult = markQueryResultRowsRaw(annotateMongoResult(mongoDocumentsToQueryResult(result.documents, performance.now() - commandStartedAt, result.total, result.extended_documents, result.total_is_exact !== false)));
                allResults.push(queryResult);
                mongoEditTarget = mongoCommands.length === 1 && !mongoCommand.projection && queryResult.columns.includes("_id") ? { collection: mongoCommand.collection, idColumn: "_id" } : undefined;
                queryExecutionLog("info", "mongo-find-one:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  elapsed: elapsed(),
                });
                break;
              }
              case "version": {
                queryExecutionLog("info", "mongo-version:start", { traceId, database: currentDatabase });
                const version = await api.mongoServerVersion(tab.connectionId, currentDatabase, executionId);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoVersionToQueryResult(version, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-version:done", {
                  traceId,
                  database: currentDatabase,
                  version,
                  elapsed: elapsed(),
                });
                break;
              }
              case "countDocuments": {
                queryExecutionLog("info", "mongo-count:start", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const total = await api.mongoCountDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.mode, executionId);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoCountToQueryResult(total, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-count:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "aggregate": {
                if (options?.mongoSafety) {
                  const safety = evaluateMongoAggregateSafety(mongoCommand, options.mongoSafety);
                  if (!safety.allowed) throw new Error(safety.reason);
                }
                queryExecutionLog("info", "mongo-aggregate:start", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const aggregateMaxRows = normalizeResultPageSize(pageLimit ?? options?.pagination?.limit ?? settingsStore.editorSettings.pageSize);
                const result = await api.mongoAggregateDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.pipeline, aggregateMaxRows, mongoCommand.options, executionId);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoDocumentsToQueryResult(result.documents, performance.now() - commandStartedAt, result.total, result.extended_documents, result.total_is_exact !== false))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-aggregate:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  total: result.total,
                  elapsed: elapsed(),
                });
                break;
              }
              case "distinct": {
                queryExecutionLog("info", "mongo-distinct:start", { traceId, collection: mongoCommand.collection, database: currentDatabase, field: mongoCommand.field });
                const result = await api.mongoDistinct(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.field, mongoCommand.filter, executionId);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoDistinctToQueryResult(mongoCommand.field, result.documents, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-distinct:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  field: mongoCommand.field,
                  valueCount: result.documents.length,
                  elapsed: elapsed(),
                });
                break;
              }
              case "getIndexes": {
                queryExecutionLog("info", "mongo-indexes:start", { traceId, collection: mongoCommand.collection, database: currentDatabase });
                const indexes = await api.listIndexes(tab.connectionId, currentDatabase, "", mongoCommand.collection);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoIndexesToQueryResult(indexes, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-indexes:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  indexCount: indexes.length,
                  elapsed: elapsed(),
                });
                break;
              }
              case "collectionStats": {
                queryExecutionLog("info", "mongo-collection-stats:start", {
                  traceId,
                  collection: mongoCommand.collection,
                  metric: mongoCommand.metric,
                  database: currentDatabase,
                });
                const stats = await api.mongoCollectionStats(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.scale, executionId);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoCollectionStatsToQueryResult(mongoCommand.metric, stats as unknown as Record<string, unknown>, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-collection-stats:done", {
                  traceId,
                  collection: mongoCommand.collection,
                  metric: mongoCommand.metric,
                  database: currentDatabase,
                  elapsed: elapsed(),
                });
                break;
              }
              case "findOneAndUpdate":
              case "findOneAndReplace":
              case "findOneAndDelete": {
                if (options?.mongoSafety) {
                  const safety = evaluateMongoWriteSafety(mongoCommand, options.mongoSafety);
                  if (!safety.allowed) throw new Error(safety.reason);
                }
                queryExecutionLog("info", "mongo-find-and-modify:start", {
                  traceId,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                });
                const result =
                  mongoCommand.kind === "findOneAndUpdate"
                    ? await api.mongoFindOneAndUpdate(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.update, mongoCommand.options)
                    : mongoCommand.kind === "findOneAndReplace"
                      ? await api.mongoFindOneAndReplace(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.replacement, mongoCommand.options)
                      : await api.mongoFindOneAndDelete(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.options);
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoDocumentsToQueryResult(result.documents, performance.now() - commandStartedAt, result.total, result.extended_documents, result.total_is_exact !== false))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-find-and-modify:done", {
                  traceId,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                  database: currentDatabase,
                  rowCount: result.documents.length,
                  elapsed: elapsed(),
                });
                break;
              }
              case "insert":
              case "update":
              case "delete":
              case "createIndex":
              case "dropIndex":
              case "dropIndexes":
              case "dropCollection": {
                if (options?.mongoSafety) {
                  const safety = evaluateMongoWriteSafety(mongoCommand, options.mongoSafety);
                  if (!safety.allowed) throw new Error(safety.reason);
                }
                queryExecutionLog("info", "mongo-write:start", {
                  traceId,
                  database: currentDatabase,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                });
                mongoEditTarget = undefined;
                if (mongoCommand.kind === "insert") {
                  const result = await api.mongoInsertDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.docsJson);
                  allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt))));
                } else if (mongoCommand.kind === "update") {
                  const result = await api.mongoUpdateDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.update, mongoCommand.many, mongoCommand.options);
                  allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt))));
                } else if (mongoCommand.kind === "createIndex") {
                  const result = await api.mongoCreateIndex(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.keys, mongoCommand.options);
                  allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoCreateIndexToQueryResult(result.name, performance.now() - commandStartedAt))));
                } else if (mongoCommand.kind === "dropIndex" || mongoCommand.kind === "dropIndexes") {
                  try {
                    const result = await api.mongoDropIndexes(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.kind === "dropIndex" ? mongoCommand.index : mongoCommand.indexes, mongoCommand.kind === "dropIndex");
                    allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoDroppedIndexesToQueryResult(result.dropped_names, performance.now() - commandStartedAt, result.failures))));
                  } finally {
                    await refreshLoadedMongoIndexesAfterMutation(tab.connectionId, currentDatabase, mongoCommand.collection, traceId);
                  }
                } else if (mongoCommand.kind === "dropCollection") {
                  await api.mongoDropCollection(tab.connectionId, currentDatabase, mongoCommand.collection);
                  allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoWriteToQueryResult(1, performance.now() - commandStartedAt))));
                } else {
                  const result = await api.mongoDeleteDocuments(tab.connectionId, currentDatabase, mongoCommand.collection, mongoCommand.filter, mongoCommand.many);
                  allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoWriteToQueryResult(result.affected_rows, performance.now() - commandStartedAt))));
                }
                queryExecutionLog("info", "mongo-write:done", {
                  traceId,
                  database: currentDatabase,
                  kind: mongoCommand.kind,
                  collection: mongoCommand.collection,
                  elapsed: elapsed(),
                });
                break;
              }
              case "use": {
                currentDatabase = mongoCommand.database;
                allResults.push(markQueryResultRowsRaw(annotateMongoResult(mongoUseToQueryResult(currentDatabase, performance.now() - commandStartedAt))));
                mongoEditTarget = undefined;
                queryExecutionLog("info", "mongo-use:done", {
                  traceId,
                  database: currentDatabase,
                  elapsed: elapsed(),
                });
                break;
              }
            }
          } catch (error: any) {
            // Surface per-command failures inline and continue collecting results
            // for the rest of the batch, matching the grouped-result UX.
            allResults.push(annotateMongoResult(toErrorResult(error)));
            mongoEditTarget = undefined;
          }
        }

        queryExecutionLog("info", "mongo:done", {
          traceId,
          database: currentDatabase,
          commandCount: mongoCommands.length,
          elapsed: elapsed(),
        });

        const current = tabs.value.find((t) => t.id === id);
        if (current?.executionId === executionId) {
          if (openInNewResultTab && current.isCancelling && restorePendingResultRun(current, executionId)) return false;
          const activeGroupIndex = current.activeResultIndex;
          const activeGroupResults = current.results;
          const findPageState = mongoFindPageState;
          const shouldAppendResult = !!findPageState && !!options?.appendResult && !!current.result && allResults.length === 1;
          const shouldReplaceActiveResultInGroup = options?.replaceActiveResultInGroup === true && allResults.length === 1 && Array.isArray(activeGroupResults) && typeof activeGroupIndex === "number" && activeGroupIndex >= 0 && activeGroupIndex < activeGroupResults.length;
          if (shouldAppendResult) {
            if (findPageState!.pageOffset !== current.result!.rows.length) {
              throw new Error("Ignoring a stale MongoDB result segment whose offset no longer matches the loaded rows");
            }
            const appendedResult = appendQueryResultSegment(current.result!, allResults[0]!, options!.appendResult!.maxRows);
            if (Array.isArray(activeGroupResults) && typeof activeGroupIndex === "number" && activeGroupIndex >= 0 && activeGroupIndex < activeGroupResults.length) {
              current.results = activeGroupResults.slice();
              current.results[activeGroupIndex] = appendedResult;
            }
            current.result = appendedResult;
          } else if (shouldReplaceActiveResultInGroup) {
            current.results = activeGroupResults.slice();
            current.results[activeGroupIndex] = allResults[0];
            current.result = allResults[0];
          } else if (allResults.length > 1) {
            // Open grouped output on the first non-error result when possible so
            // mixed success/error batches land on the most useful table first.
            const activeResultIndex = allResults.findIndex((result) => !isQueryExecutionErrorResult(result));
            const resultIndex = preservedResultIndex(allResults, current.activeResultIndex, options?.preserveActiveResultIndex) ?? (activeResultIndex >= 0 ? activeResultIndex : 0);
            current.results = allResults;
            current.activeResultIndex = resultIndex;
            current.result = allResults[resultIndex];
          } else {
            current.results = undefined;
            current.activeResultIndex = undefined;
            current.result = allResults[0];
          }
          producedResult = current.result !== undefined;
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.mongoEditTarget = mongoCommands.length === 1 ? mongoEditTarget : undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = shouldReplaceActiveResultInGroup ? (current.resultBaseSql ?? options?.resultBaseSql ?? sql) : (options?.resultBaseSql ?? sql);
          current.resultSortedSql = options?.resultSortedSql;
          current.resultPageSql = undefined;
          current.resultPageLimit = mongoFindPageState?.pageLimit;
          current.resultPageOffset = shouldAppendResult ? (current.resultPageOffset ?? 0) : mongoFindPageState?.pageOffset;
          current.resultCountSql = undefined;
          current.resultSessionId = undefined;
          current.resultTotalRowCount = mongoFindPageState?.totalIsExact ? mongoFindPageState.total : undefined;
          current.resultTotalRowCountLoading = false;
          syncDisplayedResultRun(current, current.resultBaseSql ?? options?.resultBaseSql ?? sql, openInNewResultTab);
          if (current.database !== currentDatabase) current.database = currentDatabase;
        }
        return producedResult;
      }

      const elasticsearchRequests = elasticsearchRestRequestRanges(sqlToExecute, effectiveDbType);
      if (elasticsearchRequests.length > 0) {
        console.info("[DBX][executeTabSql:elasticsearch-rest-batch:start]", {
          traceId,
          requestCount: elasticsearchRequests.length,
          sql,
        });
        const allResults: QueryResult[] = [];
        const continueOnError = settingsStore.editorSettings.continueOnErrorOnBatch;
        for (const request of elasticsearchRequests) {
          const current = tabs.value.find((item) => item.id === id);
          if (current?.executionId !== executionId) break;
          const sourceRange = options?.sourceOffset === undefined ? undefined : { from: options.sourceOffset + request.from, to: options.sourceOffset + request.to };
          try {
            const result = await api.executeQuery(tab.connectionId, executionDatabase, request.sql, undefined, executionId, {
              timeoutSecs: queryTimeoutSecs,
            });
            allResults.push(markQueryResultRowsRaw(annotateQueryResultSource(result, request.sql, tab.database || conn?.database, effectiveDbType, sourceRange)));
            if (elasticsearchHttpErrorStatus(result) !== undefined && !continueOnError) break;
          } catch (error) {
            const latest = tabs.value.find((item) => item.id === id);
            if (latest?.executionId !== executionId) break;
            allResults.push(annotateQueryResultSource(toErrorResult(error), request.sql, tab.database || conn?.database, effectiveDbType, sourceRange));
            if (!continueOnError) break;
          }
        }

        console.info("[DBX][executeTabSql:elasticsearch-rest-batch:done]", {
          traceId,
          requestCount: elasticsearchRequests.length,
          resultCount: allResults.length,
          elapsed: elapsed(),
        });
        const current = tabs.value.find((item) => item.id === id);
        if (current?.executionId === executionId && openInNewResultTab && current.isCancelling && restorePendingResultRun(current, executionId)) return false;
        if (current?.executionId === executionId && allResults.length > 0) {
          clearResultNavigationState(current);
          const errorResultIndex = allResults.findIndex((result) => isQueryExecutionErrorResult(result) || elasticsearchHttpErrorStatus(result) !== undefined);
          const resultIndex = errorResultIndex >= 0 ? errorResultIndex : 0;
          current.results = allResults.length > 1 ? allResults : undefined;
          current.activeResultIndex = allResults.length > 1 ? resultIndex : undefined;
          current.result = allResults[resultIndex];
          producedResult = current.result !== undefined;
          touchResult(current);
          current.queryAnalysis = undefined;
          current.querySourceColumns = undefined;
          current.queryEditabilityReason = undefined;
          current.mongoEditTarget = undefined;
          current.tableMeta = undefined;
          current.resultBaseSql = options?.resultBaseSql ?? sql;
          current.resultSortedSql = undefined;
          syncDisplayedResultRun(current, current.resultBaseSql, openInNewResultTab);
        }
        return producedResult;
      }

      if (tab.mode === "query") {
        const prepared = await prepareEditableQueryExecution(tab, sqlToExecute, conn, effectiveDbType, executionDatabase, traceId, elapsed);
        sqlToExecute = prepared.sql;
        // Database sorting executes a generated wrapper around the user's query.
        // Keep editability metadata anchored to the original query so the wrapper
        // does not turn an otherwise editable result into a complex read-only one.
        queryMetadataSql = options?.resultSortedSql && !options?.querySort ? queryBaseSql : prepared.metadataSql;
        hiddenPrimaryKeys = prepared.hiddenPrimaryKeys;
        if (options?.querySort) {
          const sorted = await api.buildSortedQuerySql({
            originalSql: sqlToExecute,
            databaseType: effectiveDbType,
            resultColumns: [...options.querySort.resultColumns, ...hiddenPrimaryKeys.map((projection) => projection.alias)],
            columnIndex: options.querySort.columnIndex,
            column: options.querySort.column,
            direction: options.querySort.direction,
          });
          if (!sorted.ok || !sorted.sql) throw new Error("Unable to build sorted query SQL");
          sqlToExecute = sorted.sql;
          resultSortedSql = sorted.sql;
        }
        const pagination = options?.pagination ?? { limit: settingsStore.editorSettings.pageSize, offset: 0 };
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql: sqlToExecute,
          queryBaseSql,
          databaseType: effectiveDbType,
          pagination,
          useAgentCursor,
          firstPageUsesActualSql: hiddenPrimaryKeys.length > 0,
        });
        sqlToExecute = plan.sqlToExecute;
        pageSql = plan.pageSql;
        pageLimit = plan.pageLimit;
        pageOffset = plan.pageOffset;
        countSql = plan.countSql;
        useAgentResultSession = plan.useAgentResultSession;
        const hasBoundedPagination = typeof pageLimit === "number" && typeof pageOffset === "number";
        if (options?.appendResult && !hasBoundedPagination && !useAgentResultSession) {
          const current = tabs.value.find((item) => item.id === id);
          if (current?.executionId === executionId && current.result) {
            current.result.has_more = false;
            const activeResultIndex = current.activeResultIndex;
            if (Array.isArray(current.results) && typeof activeResultIndex === "number" && activeResultIndex >= 0 && activeResultIndex < current.results.length) {
              current.results[activeResultIndex]!.has_more = false;
            }
            touchResult(current);
            syncDisplayedResultRun(current, queryBaseSql, openInNewResultTab);
          }
          queryExecutionLog("info", "append-result:pagination-unsupported", { traceId, elapsed: elapsed() });
          return false;
        }
      } else if (tab.mode === "data") {
        pageLimit = options?.pagination?.limit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize);
        pageOffset = options?.pagination?.offset ?? 0;
      }

      const executionSchema = connectionQueryExecutionSchema(conn, tab.database, tab.schema, tab.mode === "data");
      const frontendTimeoutSecs = frontendQueryTimeoutSecsForSql(sqlToExecute, effectiveDbType, queryTimeoutSecs);
      const sourceLabelDatabase = tab.database || conn?.database;

      let executionPromise: Promise<QueryResult[]>;
      if (tab.autoCommit === false) {
        if (!tab.txnSessionId) {
          queryExecutionLog("info", "begin-manual-txn:start", { traceId, elapsed: elapsed() });
          tab.txnSessionId = await api.beginManualTransaction(tab.connectionId, executionDatabase, executionSchema, tab.catalog);
          queryExecutionLog("info", "begin-manual-txn:done", { traceId, txnSessionId: tab.txnSessionId, elapsed: elapsed() });
        }
        queryExecutionLog("info", "execute-in-txn:invoke", { traceId, txnSessionId: tab.txnSessionId, elapsed: elapsed() });
        executionDispatched = true;
        executionPromise = api.executeInManualTransaction(tab.txnSessionId, sqlToExecute, executionDatabase, executionSchema, pageLimit);
      } else {
        queryExecutionLog("info", "execute-multi:start", { traceId, elapsed: elapsed() });
        // Query and data tabs use a tab-scoped pool so repeated executions keep
        // connection-local state and avoid MySQL pool resets on every refresh.
        const clientSessionId = tab.mode === "query" || tab.mode === "data" ? tabClientSessionId(tab) : undefined;
        const executionOptions = {
          ...(typeof pageLimit === "number"
            ? useAgentResultSession
              ? {
                  // Agent cursors apply maxRows cumulatively across fetched pages.
                  // Keep multi-page navigation available without allowing unbounded reads.
                  maxRows: MAX_RESULT_PAGE_SIZE,
                  fetchSize: pageLimit,
                  pageSize: pageLimit,
                  resultSessionId: options?.pagination?.sessionId,
                }
              : { maxRows: pageLimit, fetchSize: pageLimit }
            : {}),
          ...(clientSessionId ? { clientSessionId } : {}),
          timeoutSecs: queryTimeoutSecs,
          catalog: tab.catalog,
          continueOnError: settingsStore.editorSettings.continueOnErrorOnBatch,
        };
        queryExecutionLog("info", "execute-multi:invoke", {
          traceId,
          elapsed: elapsed(),
          executionSchema,
          optionKeys: Object.keys(executionOptions),
          clientSession: Boolean(clientSessionId),
        });
        executionDispatched = true;
        executionPromise =
          tab.batchSqlExecution && tab.batchSqlExecution.total > 1
            ? api.executeMultiWithProgress(
                tab.connectionId,
                executionDatabase,
                sqlToExecute,
                (progress) => {
                  const current = tabs.value.find((item) => item.id === id);
                  if (current?.executionId === executionId) {
                    applyBatchSqlProgress(current, progress, settingsStore.editorSettings.continueOnErrorOnBatch);
                  }
                },
                executionSchema,
                { ...executionOptions, executionId },
              )
            : api.executeMulti(tab.connectionId, executionDatabase, sqlToExecute, executionSchema, executionId, executionOptions);
      }
      const results = annotateQueryResultSources(markQueryResultsRowsRaw(await withFrontendQueryTimeout(executionPromise, frontendTimeoutSecs, t("editor.queryTimeoutError", { seconds: frontendTimeoutSecs }))), queryBaseSql, sourceLabelDatabase, effectiveDbType, options?.sourceOffset);
      reconcileBatchSqlResults(tab, executionId, results);
      const successfulOracleSchemaChanges = effectiveDbType === "oracle" ? results.filter((result) => result.execution_error !== true && isOracleCurrentSchemaStatement(result.sourceStatement)).length : 0;
      const successfulSapHanaSchemaChanges = effectiveDbType === "saphana" ? results.filter((result) => result.execution_error !== true && isSapHanaSetSchemaStatement(result.sourceStatement)).length : 0;
      const sqlServerUseDatabase = effectiveDbType === "sqlserver" && !results.some(isSqlServerBatchErrorResult) ? sqlServerUseDatabaseFromStatement(sql) : undefined;
      if (hiddenPrimaryKeys.length > 0 && results.length === 1) {
        const hiddenIndexes = hiddenResultColumnIndexes(results[0]!.columns, hiddenPrimaryKeys);
        if (hiddenIndexes.length > 0) results[0]!.hidden_column_indexes = hiddenIndexes;
        if (hiddenIndexes.length !== hiddenPrimaryKeys.length) queryMetadataSql = queryBaseSql;
      } else if (hiddenPrimaryKeys.length > 0) {
        queryMetadataSql = queryBaseSql;
      }
      queryExecutionLog("info", "execute-multi:done", {
        traceId,
        resultCount: results.length,
        rowCounts: results.map((result) => result.rows.length),
        columnCounts: results.map((result) => result.columns.length),
        elapsed: elapsed(),
      });
      let resolvedSapHanaSchema: string | undefined;
      if (successfulSapHanaSchemaChanges > 0 && tabs.value.find((item) => item.id === id)?.executionId === executionId) {
        try {
          const schemaResult = await api.executeQuery(tab.connectionId, executionDatabase, "SELECT CURRENT_SCHEMA FROM DUMMY", undefined, executionId, {
            clientSessionId: tabClientSessionId(tab),
            timeoutSecs: queryTimeoutSecs,
          });
          resolvedSapHanaSchema = sapHanaCurrentSchemaFromResult(schemaResult);
        } catch (error) {
          console.warn("[DBX] Failed to resolve SAP HANA CURRENT_SCHEMA", error);
        }
      }
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        if (openInNewResultTab && current.isCancelling && restorePendingResultRun(current, executionId)) return false;
        if (successfulOracleSchemaChanges > 0) {
          current.completionContextVersion = (current.completionContextVersion ?? 0) + successfulOracleSchemaChanges;
        }
        if (resolvedSapHanaSchema) {
          current.schema = resolvedSapHanaSchema;
          current.completionContextVersion = (current.completionContextVersion ?? 0) + successfulSapHanaSchemaChanges;
        }
        if (sqlServerUseDatabase && current.database !== sqlServerUseDatabase) {
          rollbackTabTransaction(current);
          void closeClientConnectionSession(current);
          current.database = sqlServerUseDatabase;
          current.schema = undefined;
        }
        const activeGroupIndex = current.activeResultIndex;
        const activeGroupResults = current.results;
        const shouldAppendResult = !!options?.appendResult && !!current.result;
        const shouldReplaceActiveResultInGroup = options?.replaceActiveResultInGroup === true && results.length === 1 && Array.isArray(activeGroupResults) && typeof activeGroupIndex === "number" && activeGroupIndex >= 0 && activeGroupIndex < activeGroupResults.length;
        if (shouldAppendResult) {
          if (results.length !== 1) throw new Error("Expected one result while loading the next segment");
          if (options.pagination?.offset !== current.result!.rows.length) {
            throw new Error("Ignoring a stale result segment whose offset no longer matches the loaded rows");
          }
          const appendedResult = appendQueryResultSegment(current.result!, results[0]!, options.appendResult!.maxRows);
          if (Array.isArray(activeGroupResults) && typeof activeGroupIndex === "number" && activeGroupIndex >= 0 && activeGroupIndex < activeGroupResults.length) {
            current.results = activeGroupResults.slice();
            current.results[activeGroupIndex] = appendedResult;
          }
          current.result = appendedResult;
        } else if (shouldReplaceActiveResultInGroup) {
          current.results = activeGroupResults.slice();
          current.results[activeGroupIndex] = results[0];
          current.result = results[0];
        } else if (results.length > 1) {
          const errorResultIndex = results.findIndex((result) => isQueryExecutionErrorResult(result));
          const activeResultIndex = results.findIndex((result) => result.columns.length > 0);
          const resultIndex = errorResultIndex >= 0 ? errorResultIndex : (preservedResultIndex(results, current.activeResultIndex, options?.preserveActiveResultIndex) ?? (activeResultIndex >= 0 ? activeResultIndex : 0));
          current.results = results;
          current.activeResultIndex = resultIndex;
          current.result = results[resultIndex];
        } else {
          current.results = undefined;
          current.activeResultIndex = undefined;
          current.result = results[0];
        }
        producedResult = current.result !== undefined;
        current.resultBaseSql = shouldReplaceActiveResultInGroup ? (current.resultBaseSql ?? queryBaseSql) : queryBaseSql;
        current.resultEditorFingerprint = shouldReplaceActiveResultInGroup ? (current.resultEditorFingerprint ?? executionEditorFingerprint) : executionEditorFingerprint;
        current.resultSortedSql = resultSortedSql;
        // Appended rows form one logical result starting at the original page.
        // Keep the base page state so later table refresh/cache recovery does
        // not re-execute only the most recently fetched tail segment.
        current.resultPageSql = shouldAppendResult ? (current.resultPageSql ?? pageSql) : pageSql;
        current.resultPageLimit = pageLimit;
        current.resultPageOffset = shouldAppendResult ? (current.resultPageOffset ?? 0) : pageOffset;
        current.resultCountSql = countSql;
        current.resultSessionId = current.result?.session_id ?? undefined;
        if (!options?.preserveTotalRowCountDuringExecution) {
          current.resultTotalRowCount = undefined;
        }
        const resultRowCount = current.result?.rows.length ?? 0;
        const totalKnownFromIncompletePage = !!current.result && typeof exactTotalFromIncompletePage(current.result, pageLimit, pageOffset, useAgentResultSession) === "number";
        const dataCountTarget =
          current.mode === "data"
            ? (() => {
                const tableMeta = tableMetaForDataTab(current);
                if (!tableMeta?.tableName) return undefined;
                return {
                  databaseType: effectiveDbType,
                  identifierQuote: useConnectionStore().connectionIdentifierQuote?.(current.connectionId),
                  catalog: tableMeta.catalog,
                  database: tableMeta.database,
                  schema: tableMeta.schema,
                  tableName: tableMeta.tableName,
                  whereInput: current.whereInput?.trim() || undefined,
                };
              })()
            : undefined;
        const canAutoCalculateTotalRows = !options?.appendResult && !!current.result && resultRowCount > 0 && !totalKnownFromIncompletePage && settingsStore.editorSettings.autoCalculateTotalRows && ((current.mode === "query" && !!countSql) || (current.mode === "data" && !!dataCountTarget));
        current.resultTotalRowCountLoading = canAutoCalculateTotalRows;
        // Server-side pagination without a countSql: the backend (currently
        // the Elasticsearch driver) already reports the true match total via
        // affected_rows. Use it directly so the result-grid can compute the
        // page count without issuing a separate COUNT query.
        let totalRowCountResolved = false;
        if (current.result && current.result.total_is_exact !== false && current.mode === "query" && typeof pageLimit === "number" && !countSql && typeof current.result.affected_rows === "number" && current.result.affected_rows > current.result.rows.length) {
          current.resultTotalRowCount = current.result.affected_rows;
          current.resultTotalRowCountLoading = false;
          totalRowCountResolved = true;
        }
        touchResult(current);
        syncDisplayedResultRun(current, queryBaseSql, openInNewResultTab);
        if (!options?.appendResult && !totalRowCountResolved && (current.mode === "query" || current.mode === "data") && current.result) {
          countQueryTotalRowsInBackground({
            tabId: id,
            connectionId: current.connectionId,
            database: executionDatabase,
            schema: current.schema,
            catalog: current.catalog,
            countSql,
            countSqlTarget: dataCountTarget
              ? async () => ({
                  sql: await api.buildDataGridCountSql(dataCountTarget),
                  schema: undefined,
                })
              : undefined,
            result: current.result,
            pageLimit,
            pageOffset,
            useAgentResultSession,
            executionId,
            traceId,
            elapsed,
            timeoutSecs: queryTimeoutSecs,
          });
        }
        queryExecutionLog("info", "result:assigned", {
          traceId,
          activeResultIndex: current.activeResultIndex,
          rowCount: current.result?.rows.length ?? 0,
          columnCount: current.result?.columns.length ?? 0,
          backendMs: current.result?.execution_time_ms,
          elapsed: elapsed(),
        });
        if (current.mode === "query" && current.result) {
          analyzeQueryMetadataInBackground(id, displayedQueryMetadataSql(current, queryMetadataSql), current.result, executionDatabase, traceId, elapsed, effectiveDbType, hiddenPrimaryKeys);
        }
      } else {
        queryExecutionLog("warn", "stale-result", {
          traceId,
          currentExecutionId: current?.executionId,
          elapsed: elapsed(),
        });
      }
    } catch (e: any) {
      queryExecutionLog("error", "error", { traceId, elapsed: elapsed(), error: e });
      // Sync connection state if the error indicates a lost connection
      useConnectionStore().recordConnectionLostError(tab.connectionId, e);
      // Handle manual transaction auto-rollback (e.g. deadlock detected by server,
      // statement error inside a manual transaction, or idle timeout).
      if (tab.autoCommit === false) {
        const errMsg: string = e?.message ?? String(e);
        if (/rolled.?back/i.test(errMsg) || errMsg.includes("已自动回滚")) {
          tab.txnSessionId = undefined;
          tab.txnAutoRolledBack = true;
        }
      }
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        failBatchSqlExecution(current, executionId, e, current.isCancelling === true);
        const restoredRetainedResult = openInNewResultTab && (current.isCancelling || !executionDispatched) && restorePendingResultRun(current, executionId);
        if (restoredRetainedResult) {
          queryExecutionLog("info", "retained-result:restored-after-abort", { traceId, elapsed: elapsed() });
          return false;
        } else if (options?.appendResult && current.result) {
          // A failed background segment must not replace the visible result or
          // silently invalidate pending edits. The next explicit refresh can retry.
          queryExecutionLog("warn", "append-result:preserved-after-error", { traceId, elapsed: elapsed() });
          return false;
        }
        const errorResult = toErrorResult(e);
        const activeGroupIndex = current.activeResultIndex;
        const activeGroupResults = current.results;
        const shouldReplaceActiveResultInGroup = options?.replaceActiveResultInGroup === true && Array.isArray(activeGroupResults) && typeof activeGroupIndex === "number" && activeGroupIndex >= 0 && activeGroupIndex < activeGroupResults.length;
        if (shouldReplaceActiveResultInGroup) {
          current.results = activeGroupResults.slice();
          current.results[activeGroupIndex] = errorResult;
          current.result = errorResult;
        } else {
          current.result = errorResult;
          current.results = undefined;
          current.activeResultIndex = undefined;
        }
        current.queryAnalysis = undefined;
        current.querySourceColumns = undefined;
        current.queryEditabilityReason = undefined;
        current.mongoEditTarget = undefined;
        if (current.mode !== "data") current.tableMeta = undefined;
        current.resultBaseSql = shouldReplaceActiveResultInGroup ? (current.resultBaseSql ?? queryBaseSql) : queryBaseSql;
        current.resultSortedSql = resultSortedSql;
        current.resultPageSql = pageSql;
        current.resultPageLimit = pageLimit;
        current.resultPageOffset = pageOffset;
        current.resultCountSql = countSql;
        current.resultSessionId = undefined;
        current.resultTotalRowCount = undefined;
        current.resultTotalRowCountLoading = false;
        touchResult(current);
        producedResult = true;
        syncDisplayedResultRun(current, queryBaseSql, openInNewResultTab);
      }
    } finally {
      if (tableDataNativeSelectionBlockOwner) finishDataGridNativeSelectionBlock(tableDataNativeSelectionBlockOwner);
      const current = tabs.value.find((t) => t.id === id);
      if (current?.executionId === executionId) {
        const liveBatch = liveBatchSqlExecutions.get(current);
        if (liveBatch?.executionId === executionId) current.batchSqlExecution = liveBatch;
        finishBatchSqlExecution(current, executionId, current.isCancelling === true);
        if (current.activeResultRunId && current.result) syncActiveResultRunFromDisplayed(current);
        if (openInNewResultTab && !current.activeResultRunId) {
          restorePendingResultRun(current, executionId);
        } else {
          pendingResultRunRestores.delete(executionId);
        }
        current.isExecuting = false;
        current.isCancelling = false;
        current.queryExecutionStartedAt = undefined;
        current.executionId = undefined;
        clearLiveBatchSqlExecution(current, executionId);
        queryExecutionLog("info", "finish", { traceId, elapsed: elapsed() });
      } else {
        pendingResultRunRestores.delete(executionId);
        if (current) clearLiveBatchSqlExecution(current, executionId);
        queryExecutionLog("warn", "finish-stale", {
          traceId,
          currentExecutionId: current?.executionId,
          elapsed: elapsed(),
        });
      }
    }
    scheduleResultCacheTrim();
    return producedResult;
  }

  async function explainTabSql(id: string, sql: string, databaseType?: DatabaseType, explainMode?: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab) return { ok: false as const, reason: "empty" as const };
    const conn = useConnectionStore().getConfig(tab.connectionId);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
    const executionId = uuid();

    tab.isExplaining = true;
    tab.explainExecutionId = executionId;
    tab.explainPlan = undefined;
    tab.explainTableResult = undefined;
    tab.explainError = undefined;
    tab.explainTableError = undefined;
    tab.explainSql = undefined;
    tab.explainTableSql = undefined;
    tab.lastExplainedSql = sql;

    try {
      await waitForTabSessionReset(id);
    } catch (e: any) {
      // Do not start an explain with a session whose schema reset did not complete.
      tab.isExplaining = false;
      tab.explainExecutionId = undefined;
      tab.explainError = String(e?.message || e);
      return { ok: false as const, reason: tab.explainError };
    }

    // DM and Oracle agents expose native text plans. DM also supports autotrace.
    if (databaseType === "dameng" || databaseType === "oracle") {
      let explainSql = sql;
      if (databaseType === "oracle") {
        const built = await buildExplainSql(databaseType, sql);
        if (!built.ok) {
          tab.isExplaining = false;
          tab.explainExecutionId = undefined;
          tab.explainPlan = undefined;
          tab.explainError = built.reason;
          return built;
        }
        explainSql = built.sql;
      }

      // Autotrace executes the SQL, so keep its stricter safety check.
      if (databaseType === "dameng" && explainMode === "autotrace") {
        const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;
        const cleaned = sql
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/--.*$/gm, " ")
          .replace(/#.*$/gm, " ");
        if (cleaned.split(";").some((stmt) => DANGER_RE.test(stmt))) {
          tab.isExplaining = false;
          tab.explainExecutionId = undefined;
          return { ok: false as const, reason: "unsafe" as const };
        }
      }
      try {
        const mode = databaseType === "dameng" && explainMode === "autotrace" ? "autotrace" : "explain";
        const planText = (await api.getExplainInfo(tab.connectionId, tab.database, tab.schema, sql, mode)) as string | undefined;
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          if (planText && planText.length > 0) {
            current.explainPlan = databaseType === "oracle" ? parseOracleExplainText(planText) : parseDamengExplainText(planText);
            current.explainSql = explainSql;
            current.explainError = undefined;
          } else {
            current.explainPlan = undefined;
            current.explainError = "No explain plan returned";
          }
        }
      } catch (e: any) {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.explainPlan = undefined;
          // Backend rejections contain the real ORA/Agent diagnostic; only successful empty responses use the generic empty-plan message.
          current.explainError = formatError(e);
        }
      } finally {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
          current.explainExecutionId = undefined;
        }
      }
      return { ok: true as const, sql: explainSql };
    }

    if (databaseType === "mysql") {
      let tableBuilt: BuildExplainSqlResult;
      let jsonBuilt: BuildExplainSqlResult;
      try {
        [tableBuilt, jsonBuilt] = await Promise.all([buildExplainSql(databaseType, sql, "standard"), buildExplainSql(databaseType, sql, "json")]);
      } catch (e: any) {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
          current.explainExecutionId = undefined;
          current.explainError = String(e?.message || e);
        }
        return { ok: true as const, sql: "" };
      }
      if (tabs.value.find((t) => t.id === id)?.explainExecutionId !== executionId) {
        return { ok: true as const, sql: jsonBuilt.ok ? jsonBuilt.sql : "" };
      }
      if (!tableBuilt.ok || !jsonBuilt.ok) {
        const failed = !tableBuilt.ok ? tableBuilt : jsonBuilt;
        const reason = !tableBuilt.ok ? tableBuilt.reason : !jsonBuilt.ok ? jsonBuilt.reason : "unsupported";
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
          current.explainExecutionId = undefined;
          current.explainError = reason;
        }
        return failed;
      }

      let tableSql = tableBuilt.sql;
      let jsonSupportedByServer: boolean | undefined;
      tab.explainTableSql = tableSql;
      tab.explainSql = undefined;
      // Keep the two EXPLAIN statements on the same one-connection MySQL session.
      const clientSessionId = `${tabClientSessionId(tab, "explain")}:${executionId}`;
      tab.explainClientSessionId = clientSessionId;
      try {
        let tableResult: QueryResult | undefined;
        let tableError: unknown;
        try {
          tableResult = await api.executeQuery(tab.connectionId, tab.database, tableSql, tab.schema, executionId, {
            clientSessionId,
            catalog: tab.catalog,
            timeoutSecs: queryTimeoutSecs,
          });
        } catch (error: unknown) {
          const compatibility = mysqlExplainCompatibilityHint(error, tableSql);
          jsonSupportedByServer = compatibility?.supportsJson;
          if (compatibility?.fallbackSql && tabs.value.find((t) => t.id === id)?.explainExecutionId === executionId) {
            tableSql = compatibility.fallbackSql;
            tab.explainTableSql = tableSql;
            try {
              tableResult = await api.executeQuery(tab.connectionId, tab.database, tableSql, tab.schema, executionId, {
                clientSessionId,
                catalog: tab.catalog,
                timeoutSecs: queryTimeoutSecs,
              });
            } catch (fallbackError: unknown) {
              tableError = fallbackError;
            }
          } else {
            tableError = error;
          }
        }
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          if (tableResult) {
            current.explainTableResult = markQueryResultRowsRaw(tableResult);
            current.explainTableError = undefined;
          } else if (tableError !== undefined) {
            current.explainTableResult = undefined;
            current.explainTableError = formatError(tableError);
          }
        }

        // A canceled or superseded standard request must not start a fallback or JSON request.
        if (tabs.value.find((t) => t.id === id)?.explainExecutionId !== executionId) {
          return { ok: true as const, sql: tableSql };
        }

        // ADB MySQL advertises its accepted formats in the first error; avoid a second known-invalid request.
        if (jsonSupportedByServer === false) {
          const latest = tabs.value.find((t) => t.id === id);
          if (latest?.explainExecutionId === executionId) {
            latest.explainPlan = undefined;
            latest.explainError = latest.explainTableResult ? undefined : latest.explainTableError;
          }
          return { ok: true as const, sql: tableSql };
        }

        try {
          const latest = tabs.value.find((t) => t.id === id);
          if (latest?.explainExecutionId === executionId) latest.explainSql = jsonBuilt.sql;
          const jsonResult = await api.executeQuery(tab.connectionId, tab.database, jsonBuilt.sql, tab.schema, executionId, {
            clientSessionId,
            catalog: tab.catalog,
            timeoutSecs: queryTimeoutSecs,
          });
          const current = tabs.value.find((t) => t.id === id);
          if (current?.explainExecutionId === executionId) {
            current.explainPlan = parseExplainResult("mysql", jsonResult);
            current.explainError = undefined;
          }
        } catch (e: any) {
          const latest = tabs.value.find((t) => t.id === id);
          if (latest?.explainExecutionId === executionId) {
            latest.explainPlan = undefined;
            // Keep a usable tabular plan visible when the server explicitly rejects JSON.
            const compatibility = mysqlExplainCompatibilityHint(e, jsonBuilt.sql);
            latest.explainError = compatibility?.supportsJson === false && latest.explainTableResult ? undefined : formatError(e);
          }
        }
      } finally {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
          current.explainExecutionId = undefined;
        }
        if (current?.explainClientSessionId === clientSessionId) current.explainClientSessionId = undefined;
        void closeClientSessionId(tab.connectionId, tab.database, clientSessionId, tab.catalog, { tabId: tab.id, explainExecutionId: executionId });
      }
      return { ok: true as const, sql: tab.explainSql ?? tableSql };
    }

    if (databaseType === "sqlserver") {
      // SQL Server reuses the autotrace toggle to ask for the actual execution plan:
      // STATISTICS XML runs the statement and adds runtime counters to the same
      // ShowPlanXML document, while SHOWPLAN_XML only estimates.
      const actualPlan = explainMode === "autotrace";
      const planCaptureOn = actualPlan ? "SET STATISTICS XML ON;" : "SET SHOWPLAN_XML ON;";
      const planCaptureOff = actualPlan ? "SET STATISTICS XML OFF;" : "SET SHOWPLAN_XML OFF;";
      let built: BuildExplainSqlResult;
      try {
        built = actualPlan ? await buildExplainSql(databaseType, sql, "json", true) : await buildExplainSql(databaseType, sql);
      } catch (e: any) {
        tab.isExplaining = false;
        tab.explainExecutionId = undefined;
        tab.explainError = String(e?.message || e);
        return { ok: true as const, sql: "" };
      }
      if (!built.ok) {
        tab.isExplaining = false;
        tab.explainExecutionId = undefined;
        tab.explainError = built.reason;
        return built;
      }

      tab.explainSql = built.sql;
      const clientSessionId = `${tabClientSessionId(tab, "explain")}:${executionId}`;
      tab.explainClientSessionId = clientSessionId;
      let planCaptureEnabled = false;
      try {
        await api.executeQuery(tab.connectionId, tab.database, planCaptureOn, tab.schema, executionId, {
          clientSessionId,
          timeoutSecs: queryTimeoutSecs,
          executionMode: "simple",
        });
        planCaptureEnabled = true;
        if (tabs.value.find((t) => t.id === id)?.explainExecutionId !== executionId) {
          return { ok: true as const, sql: built.sql };
        }

        const results = await api.executeMulti(tab.connectionId, tab.database, sql, tab.schema, executionId, {
          clientSessionId,
          timeoutSecs: queryTimeoutSecs,
          executionMode: "simple",
        });
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          const outcome = sqlServerExplainResult(results);
          if (outcome.error !== undefined) {
            current.explainPlan = undefined;
            current.explainError = outcome.error;
          } else if (outcome.result) {
            current.explainPlan = parseExplainResult("sqlserver", outcome.result);
            current.explainError = undefined;
          } else {
            current.explainPlan = undefined;
            current.explainError = t("explain.empty");
          }
        }
      } catch (e: any) {
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.explainPlan = undefined;
          current.explainError = String(e?.message || e);
        }
      } finally {
        if (planCaptureEnabled) {
          try {
            await api.executeQuery(tab.connectionId, tab.database, planCaptureOff, tab.schema, undefined, {
              clientSessionId,
              timeoutSecs: queryTimeoutSecs > 0 ? Math.min(queryTimeoutSecs, 5) : 5,
              executionMode: "simple",
            });
          } catch (error) {
            console.warn("[DBX][sqlserver-explain:cleanup:error]", { tabId: tab.id, error });
          }
        }
        const current = tabs.value.find((t) => t.id === id);
        if (current?.explainExecutionId === executionId) {
          current.isExplaining = false;
          current.explainExecutionId = undefined;
        }
        if (current?.explainClientSessionId === clientSessionId) current.explainClientSessionId = undefined;
        await closeClientSessionId(tab.connectionId, tab.database, clientSessionId, tab.catalog, { tabId: tab.id, explainExecutionId: executionId });
      }
      return { ok: true as const, sql: built.sql };
    }

    const postgresAnalyze = databaseType === "postgres" && explainMode === "autotrace";
    const built = postgresAnalyze ? await buildExplainSql(databaseType, sql, "json", true) : await buildExplainSql(databaseType, sql);
    if (!built.ok) {
      tab.explainPlan = undefined;
      tab.explainError = built.reason;
      tab.isExplaining = false;
      tab.explainExecutionId = undefined;
      return built;
    }

    tab.explainSql = built.sql;
    const clientSessionId = postgresAnalyze ? `${tabClientSessionId(tab, "explain")}:${executionId}` : tabClientSessionId(tab, "explain");
    if (postgresAnalyze) tab.explainClientSessionId = clientSessionId;
    try {
      const result = await api.executeQuery(tab.connectionId, tab.database, built.sql, tab.schema, executionId, {
        clientSessionId,
        catalog: tab.catalog,
        timeoutSecs: queryTimeoutSecs,
        executionMode: postgresAnalyze ? "postgres_read_only_transaction" : undefined,
      });
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.explainPlan = parseExplainResult(databaseType as "mysql" | "postgres", result);
        current.explainError = undefined;
      }
    } catch (e: any) {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.explainPlan = undefined;
        current.explainError = String(e?.message || e);
      }
    } finally {
      const current = tabs.value.find((t) => t.id === id);
      if (current?.explainExecutionId === executionId) {
        current.isExplaining = false;
        current.explainExecutionId = undefined;
      }
      if (current?.explainClientSessionId === clientSessionId) current.explainClientSessionId = undefined;
      const closePromise = closeClientSessionId(tab.connectionId, tab.database, clientSessionId, tab.catalog, { tabId: tab.id, explainExecutionId: executionId });
      if (postgresAnalyze) await closePromise;
      else void closePromise;
    }
    return { ok: true as const, sql: built.sql };
  }

  async function cancelTabExecution(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !canCancelQueryExecution(tab)) return false;

    const executionId = tab.executionId;
    if (!executionId) return false;
    tab.isCancelling = true;
    // 单调递增、不随取消结果回退：导航流程据此判断"执行期间用户请求过停止"
    // （isCancelling 在取消失败或查询先完成时会被清掉，无法承担这个语义）
    tab.cancelRequestCount = (tab.cancelRequestCount ?? 0) + 1;
    const cancellationStartedAt = performance.now();
    try {
      const canceled = await withCancelQueryTimeout(api.cancelQuery(executionId));
      if (canceled) {
        clearAcknowledgedCancelIfStillRunning(id, executionId);
      }
      if (!canceled) {
        const current = tabs.value.find((t) => t.id === id);
        if (current && current.executionId === executionId) {
          finishBatchSqlExecution(current, executionId, false);
          restorePendingResultRun(current, executionId);
          current.isExecuting = false;
          current.isCancelling = false;
          current.executionId = undefined;
          current.queryExecutionStartedAt = undefined;
          clearLiveBatchSqlExecution(current, executionId);
        }
      }
      return canceled;
    } catch (e: any) {
      // Sync connection state if the error indicates a lost connection
      if (tab) useConnectionStore().recordConnectionLostError(tab.connectionId, e);
      const current = tabs.value.find((t) => t.id === id);
      if (current && current.executionId === executionId) {
        failBatchSqlExecution(current, executionId, e, false);
        finishBatchSqlExecution(current, executionId, false);
        if (restorePendingResultRun(current, executionId)) {
          current.isExecuting = false;
          current.isCancelling = false;
          current.queryExecutionStartedAt = undefined;
          current.executionId = undefined;
        } else {
          // 复用 setErrorResult 的完整清理：分组结果不清空的话，错误结果不会展示，
          // 估算值也会继续按旧的 results 计算
          setErrorResult(id, e);
        }
        clearLiveBatchSqlExecution(current, executionId);
      }
      return false;
    } finally {
      recordQueryCancellationLatency(performance.now() - cancellationStartedAt);
    }
  }

  async function cancelTabExplain(id: string) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.isExplaining || !tab.explainExecutionId) return false;

    const executionId = tab.explainExecutionId;
    // Invalidate locally before the remote cancellation call so no later stage can start.
    tab.isExplaining = false;
    tab.explainExecutionId = undefined;
    try {
      return await api.cancelQuery(executionId);
    } catch {
      return false;
    }
  }

  function setActiveResultIndex(id: string, index: number) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.results || index < 0 || index >= tab.results.length) return;
    tab.activeResultIndex = index;
    tab.result = tab.results[index];
    tab.resultLocalSortOriginalRows = undefined;
    tab.resultLocalSortOriginalMongoDocuments = undefined;
    tab.resultLocalSortOriginalMongoCopyDocuments = undefined;
    tab.resultSortColumn = undefined;
    tab.resultSortColumnIndex = undefined;
    tab.resultSortDirection = undefined;
    tab.resultSortMode = undefined;
    tab.resultSortedSql = undefined;
    // results 数组未变，估算值与当前激活的 result 无关，可直接复用
    touchResult(tab, Date.now(), { reuseEstimatedBytes: true });
    tab.queryAnalysis = undefined;
    tab.querySourceColumns = undefined;
    tab.queryEditabilityReason = undefined;
    tab.mongoEditTarget = undefined;
    syncActiveResultRunFromDisplayed(tab);
    const sourceStatement = tab.result?.sourceStatement;
    if (tab.mode === "query" && sourceStatement && splitMongoCommandRanges(sourceStatement).length === 0) {
      const metadataStartedAt = performance.now();
      const connection = useConnectionStore().getConfig(tab.connectionId);
      const executionDatabase = dataTabExecutionDatabase(connection, tab.database, tab.catalog);
      analyzeQueryMetadataInBackground(id, sourceStatement, tab.result, executionDatabase, uuid().slice(0, 8), () => `${Math.round(performance.now() - metadataStartedAt)}ms`, effectiveDatabaseTypeForConnection(connection));
    }
  }

  function notifyConnectionMayBeLost() {
    const stuck = tabs.value.filter((t) => t.isExecuting);
    if (stuck.length > 0) {
      const connStore = useConnectionStore();
      stuck.forEach((tab) => {
        const error = new Error(t("editor.connectionMayBeLost"));
        setErrorResult(tab.id, error);
        connStore.markConnectionLost(tab.connectionId, error);
      });
    }
  }

  async function trimResultCache() {
    const inactive = tabs.value.filter((t) => t.id !== activeTabId.value && (t.result || t.results));
    const evictionIds = new Set(
      selectInactiveResultEvictions(
        inactive.map((tab) => ({
          id: tab.id,
          estimatedBytes: tab.resultEstimatedBytes ?? estimateQueryResultsBytes(tab.result, tab.results),
          accessedAt: tab.resultAccessedAt ?? 0,
        })),
        MAX_CACHED_RESULT_BYTES,
        MAX_CACHED_RESULTS,
      ),
    );
    const toEvict = inactive.filter((tab) => evictionIds.has(tab.id));
    if (toEvict.length > 0) {
      await Promise.all(toEvict.map((t) => evictCachedResult(t)));
    }
  }

  function scheduleResultCacheTrim() {
    resultCacheTrimRequested = true;
    if (resultCacheTrimScheduled || resultCacheTrimRunning) return;
    resultCacheTrimScheduled = true;

    const run = () => {
      resultCacheTrimScheduled = false;
      void runRequestedResultCacheTrim();
    };

    // Eviction serializes large result payloads; schedule it after the result
    // assignment so the grid can paint before cache maintenance starts.
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 0);
    }
  }

  async function runRequestedResultCacheTrim() {
    if (resultCacheTrimRunning) return;
    resultCacheTrimRunning = true;
    try {
      while (resultCacheTrimRequested) {
        resultCacheTrimRequested = false;
        await trimResultCache();
      }
    } finally {
      resultCacheTrimRunning = false;
      if (resultCacheTrimRequested) scheduleResultCacheTrim();
    }
  }

  function rememberActiveTab(id: string | null) {
    if (!id || !tabs.value.some((tab) => tab.id === id)) return;
    activeTabHistory.value = [...activeTabHistory.value.filter((tabId) => tabId !== id), id];
  }

  function fallbackActiveTabAfterClose(closedId: string, closedIndex: number): string | null {
    const remainingIds = new Set(tabs.value.map((tab) => tab.id));
    // Prefer the most recently focused remaining tab. This preserves the
    // source query tab when a transient table-info/data tab is closed.
    const history = activeTabHistory.value.filter((tabId) => tabId !== closedId && remainingIds.has(tabId));
    activeTabHistory.value = history;
    return [...history].reverse().find((tabId) => remainingIds.has(tabId)) ?? tabs.value[Math.min(closedIndex, tabs.value.length - 1)]?.id ?? null;
  }

  watch(
    activeTabId,
    (id) => {
      rememberActiveTab(id);
      touchResult(
        tabs.value.find((tab) => tab.id === id),
        Date.now(),
        { reuseEstimatedBytes: true },
      );
    },
    { flush: "sync" },
  );

  function restoreCachedResultPayload(tab: QueryTab, snapshot: Awaited<ReturnType<typeof readTabResultSnapshot>>) {
    if (!snapshot) return false;
    const results = snapshot.results ? markQueryResultsRowsRaw(snapshot.results) : undefined;
    const activeIndex = snapshot.activeResultIndex ?? 0;
    tab.results = results;
    tab.activeResultIndex = snapshot.activeResultIndex;
    tab.resultEditorFingerprint = snapshot.resultEditorFingerprint;
    tab.result = snapshot.result ? markQueryResultRowsRaw(snapshot.result) : results?.[activeIndex] ? markQueryResultRowsRaw(results[activeIndex]) : undefined;
    tab.resultLocalSortOriginalRows = snapshot.resultLocalSortOriginalRows ? markRaw(snapshot.resultLocalSortOriginalRows) : undefined;
    tab.resultLocalSortOriginalMongoDocuments = snapshot.resultLocalSortOriginalMongoDocuments ? markRaw(snapshot.resultLocalSortOriginalMongoDocuments) : undefined;
    tab.resultLocalSortOriginalMongoCopyDocuments = snapshot.resultLocalSortOriginalMongoCopyDocuments ? markRaw(snapshot.resultLocalSortOriginalMongoCopyDocuments) : undefined;
    // 快照编解码会重建负载，落盘前的各 run 估算值不再对应恢复后的对象，
    // 置空让 projectResultRun 按需重算
    tab.resultRuns = snapshot.resultRuns ? markQueryResultRunsRowsRaw(snapshot.resultRuns).map((run) => ({ ...run, resultEstimatedBytes: undefined })) : tab.resultRuns;
    tab.activeResultRunId = snapshot.activeResultRunId ?? tab.activeResultRunId;
    if (!tab.result && !tab.results && !tab.resultRuns) return false;

    tab.queryAnalysis = snapshot.queryAnalysis;
    tab.querySourceColumns = snapshot.querySourceColumns;
    tab.queryEditabilityReason = snapshot.queryEditabilityReason;
    tab.mongoEditTarget = snapshot.mongoEditTarget;
    // Data tab 的结果快照可能早于最近一次结构变更。已持有真实元数据时，
    // 不允许旧快照回滚列名或主键；若恢复后仍没有真实列，重新挂起编辑门控。
    if (tab.mode === "data" && tab.tableMeta?.columns.length) {
      // 保留当前真实元数据
    } else {
      tab.tableMeta = snapshot.tableMeta;
    }
    if (tab.mode === "data" && !tab.tableMeta?.columns.length) {
      tab.tableMetaPending = true;
    }
    tab.resultPageSql = snapshot.resultPageSql;
    tab.resultPageLimit = snapshot.resultPageLimit;
    tab.resultPageOffset = snapshot.resultPageOffset;
    tab.resultCountSql = snapshot.resultCountSql;
    tab.resultTotalRowCount = snapshot.resultTotalRowCount;
    tab.resultTotalRowCountLoading = false;
    tab.resultSessionId = undefined;
    tab.resultEvicted = undefined;
    tab.resultCacheState = "memory";
    touchResult(tab);
    return true;
  }

  async function hydrateResultRunsForArchive(tab: QueryTab, snapshot: NonNullable<ReturnType<typeof buildTabResultSnapshot>>) {
    if (!snapshot.resultRuns?.length) return snapshot;
    const resultRuns = await Promise.all(
      snapshot.resultRuns.map(async (run) => {
        if (resultRunHasPayload(run)) return run;
        const cacheKey = run.resultCacheKey ?? tab.resultRuns?.find((item) => item.id === run.id)?.resultCacheKey;
        if (!cacheKey) return run;
        const cached = await readTabResultSnapshot(cacheKey);
        return cached?.resultRuns?.find((item) => item.id === run.id) ?? run;
      }),
    );
    return { ...snapshot, resultRuns };
  }

  async function resultArchiveSnapshotForTab(tab: QueryTab) {
    let snapshot = buildTabResultSnapshot(tab);
    if (tab.resultCacheKey && (!snapshot || tab.resultEvicted || !resultSnapshotHasPayload(snapshot))) {
      snapshot = (await readTabResultSnapshot(tab.resultCacheKey)) ?? snapshot;
    }
    if (snapshot) snapshot = await hydrateResultRunsForArchive(tab, snapshot);
    return snapshot && resultSnapshotHasPayload(snapshot) ? snapshot : undefined;
  }

  async function exportResultArchive(id: string): Promise<Uint8Array | undefined> {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || tab.mode !== "query") return undefined;
    const snapshot = await resultArchiveSnapshotForTab(tab);
    if (!snapshot) return undefined;
    return encodeQueryResultArchive(tab, snapshot);
  }

  function openResultArchiveTab(archive: DecodedQueryResultArchive): string | undefined {
    const id = uuid();
    const title = archive.tab.title.trim() || t("tabs.importedResultArchive");
    const tab: QueryTab = {
      id,
      title,
      customTitle: true,
      connectionId: archive.tab.connectionId,
      database: archive.tab.database,
      schema: archive.tab.schema,
      sql: archive.tab.sql,
      originalSql: archive.tab.sql,
      lastExecutedSql: archive.tab.lastExecutedSql,
      resultBaseSql: archive.tab.resultBaseSql,
      resultSortedSql: archive.tab.resultSortedSql,
      isExecuting: false,
      isCancelling: false,
      isExplaining: false,
      mode: "query",
    };
    if (!restoreCachedResultPayload(tab, archive.snapshot)) return undefined;
    const activeRun = tab.resultRuns?.find((run) => run.id === tab.activeResultRunId) ?? tab.resultRuns?.[0];
    if (activeRun) projectResultRun(tab, activeRun);
    tabs.value.push(tab);
    activeTabId.value = id;
    return id;
  }

  async function importResultArchive(bytes: Uint8Array | ArrayBuffer): Promise<string | undefined> {
    const archive = await decodeQueryResultArchive(bytes);
    if (!archive) return undefined;
    return openResultArchiveTab(archive);
  }

  async function reloadEvictedTab(id: string, { reexecuteOnMissing = false }: { reexecuteOnMissing?: boolean } = {}) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab || !tab.resultEvicted) return;
    if (tab.resultCacheKey) {
      const restored = restoreCachedResultPayload(tab, await readTabResultSnapshot(tab.resultCacheKey));
      if (restored) return;
      tab.resultCacheState = "missing";
      if (!reexecuteOnMissing) return;
    }
    tab.resultEvicted = false;
    const sql = tab.lastExecutedSql ?? tab.sql;
    if (!sql?.trim()) return;
    await executeTabSql(tab.id, sql, {
      resultBaseSql: tab.resultBaseSql ?? sql,
      resultSortedSql: tab.resultSortedSql,
      pagination:
        tab.mode === "data"
          ? {
              limit: tab.resultPageLimit ?? tableOpenPageLimit(settingsStore.editorSettings.tableOpenPageSize),
              offset: tab.resultPageOffset ?? 0,
            }
          : undefined,
    });
  }

  async function fetchTabResultForExport(id: string, onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void): Promise<QueryResult | undefined> {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result) return undefined;

    if (tab.mode === "data") {
      const connStore = useConnectionStore();
      await connStore.ensureConnected(tab.connectionId);
      const conn = connStore.getConfig(tab.connectionId);
      const tableMeta = tableMetaForDataTab(tab);
      if (!tableMeta?.tableName) return tab.result;

      // Use the already-computed total row count as a progress estimate so the
      // export dialog shows a moving bar instead of a stuck 0 while paginating.
      const totalRows = typeof tab.resultTotalRowCount === "number" ? tab.resultTotalRowCount : null;
      const pageLimit = TABLE_DATA_EXPORT_PAGE_SIZE;
      const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
      const identifierQuote = connStore.connectionIdentifierQuote?.(tab.connectionId);
      const primaryKeys = tab.tableMeta ? tab.tableMeta.primaryKeys : tableMeta.primaryKeys;
      const sortOrder = tab.resultSortColumn && tab.resultSortDirection ? `${quoteTableDataIdentifier(effectiveDbType, tab.resultSortColumn, identifierQuote)} ${tab.resultSortDirection.toUpperCase()}` : undefined;
      const orderBy = tab.orderByInput?.trim() || sortOrder;
      const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
      const executionDatabase = dataTabExecutionDatabase(conn, tab.database, tableMeta.catalog);
      const rows: QueryResult["rows"] = [];
      let columns: string[] = [];
      let executionTimeMs = 0;
      let offset = 0;
      const clientSessionId = tabClientSessionId(tab, "export");
      const exportExecutionId = uuid();

      try {
        while (true) {
          const sql = await api.buildTableSelectSql({
            databaseType: effectiveDbType,
            identifierQuote,
            database: tableMeta.database,
            schema: tableMeta.schema,
            tableName: tableMeta.tableName,
            tableType: tableMeta.tableType,
            catalog: tableMeta.catalog,
            columns: tableMeta.columns.map((column) => column.name),
            primaryKeys,
            whereInput: tab.whereInput,
            orderBy,
            limit: pageLimit,
            offset,
          });
          const results = await api.executeMulti(tab.connectionId, executionDatabase, sql, undefined, exportExecutionId, {
            maxRows: pageLimit,
            fetchSize: pageLimit,
            clientSessionId,
            catalog: tableMeta.catalog,
            timeoutSecs: queryTimeoutSecs,
          });
          const result = results[0];
          if (!result) break;
          if (columns.length === 0) columns = result.columns;
          rows.push(...result.rows);
          executionTimeMs += result.execution_time_ms ?? 0;
          onProgress?.({ rowsExported: rows.length, totalRows });
          if (result.rows.length < pageLimit) break;
          offset += result.rows.length;
        }
      } finally {
        void closeClientSessionId(tab.connectionId, executionDatabase, clientSessionId, tableMeta.catalog, { tabId: tab.id });
      }

      return {
        columns: columns.length ? columns : tab.result.columns,
        rows,
        affected_rows: 0,
        execution_time_ms: executionTimeMs,
        truncated: false,
        has_more: false,
      };
    }

    if (tab.mode !== "query") return tab.result;

    const sql = queryResultExecutionSql(tab);
    if (!sql.trim()) return tab.result;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    const queryTimeoutSecs = queryTimeoutSecsForConnection(conn);
    const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
    const queryBaseSql = queryResultBaseSql(tab);
    const exportSettings = useSettingsStore().editorSettings;
    const exportRowLimit = exportSettings.exportRowLimitEnabled ? exportSettings.exportRowLimit : Number.POSITIVE_INFINITY;

    if (effectiveDbType === "mongodb") {
      let mongoCommand;
      try {
        mongoCommand = await api.mongoParseShellCommand(sql);
      } catch {
        throw new Error(QUERY_RESULT_EXPORT_UNSUPPORTED_ERROR);
      }
      if (mongoCommand.kind !== "find") throw new Error(QUERY_RESULT_EXPORT_UNSUPPORTED_ERROR);

      const pageLimit = Math.max(1, Math.trunc(exportSettings.exportBatchSize));
      const documents: unknown[] = [];
      let copyDocuments: unknown[] | undefined = [];
      let pageOffset = 0;
      let totalRows = typeof tab.resultTotalRowCount === "number" ? Math.min(tab.resultTotalRowCount, exportRowLimit) : null;
      const exportStartedAt = performance.now();
      const exportExecutionId = uuid();

      while (documents.length < exportRowLimit) {
        const remaining = exportRowLimit - documents.length;
        const plan = planMongoFindPagination(sql, mongoCommand, pageOffset, Math.min(pageLimit, remaining));
        if (!plan) throw new Error(QUERY_RESULT_EXPORT_UNSUPPORTED_ERROR);
        if (plan.requestLimit === 0) break;

        const result = await api.mongoFindDocuments(tab.connectionId, tab.database, mongoCommand.collection, plan.requestSkip, plan.requestLimit, mongoCommand.filter, mongoCommand.projection, mongoCommand.sort, mongoCommand.collation, exportExecutionId);
        const pageDocuments = result.documents.slice(0, plan.requestLimit);
        documents.push(...pageDocuments);

        if (copyDocuments) {
          if (result.extended_documents?.length === result.documents.length) {
            copyDocuments.push(...result.extended_documents.slice(0, pageDocuments.length));
          } else {
            copyDocuments = undefined;
          }
        }

        if (result.total_is_exact !== false) {
          totalRows = Math.min(mongoFindLogicalTotal(result.total, plan), exportRowLimit);
        }
        onProgress?.({ rowsExported: documents.length, totalRows });

        pageOffset += pageDocuments.length;
        const reachedLogicalLimit = plan.logicalLimit !== undefined && pageOffset >= plan.logicalLimit;
        const reachedExactTotal = result.total_is_exact !== false && pageOffset >= mongoFindLogicalTotal(result.total, plan);
        if (pageDocuments.length === 0 || pageDocuments.length < plan.requestLimit || reachedLogicalLimit || reachedExactTotal) break;
      }

      const result = mongoDocumentsToQueryResult(documents, performance.now() - exportStartedAt, totalRows ?? documents.length, copyDocuments, totalRows !== null);
      if (result.columns.length === 0) {
        result.columns = tab.result.columns;
        result.column_types = tab.result.column_types;
      }
      result.affected_rows = documents.length;
      result.truncated = false;
      result.has_more = false;
      return result;
    }

    const agentExportMaxRows = exportSettings.exportRowLimitEnabled ? exportSettings.exportRowLimit : 2_147_483_647;
    // Use the already-computed total row count as a progress estimate so the
    // export dialog shows a moving bar instead of a stuck 0 while paginating.
    const totalRows = typeof tab.resultTotalRowCount === "number" ? Math.min(tab.resultTotalRowCount, exportRowLimit) : null;
    const pageLimit = Math.max(tab.resultPageLimit ?? 0, TABLE_DATA_EXPORT_PAGE_SIZE);
    const rows: QueryResult["rows"] = [];
    let columns: string[] = [];
    let executionTimeMs = 0;
    let offset = 0;
    let sessionId: string | undefined;
    const clientSessionId = tabClientSessionId(tab, "export");
    const exportExecutionId = uuid();

    try {
      while (rows.length < exportRowLimit) {
        const remaining = exportRowLimit - rows.length;
        const effectivePageLimit = Math.min(pageLimit, remaining);
        const plan = await api.prepareQueryPaginationExecutionPlan({
          sql,
          queryBaseSql,
          databaseType: effectiveDbType,
          pagination: { limit: effectivePageLimit, offset, sessionId },
          useAgentCursor,
          firstPageUsesActualSql: true,
        });
        if (typeof plan.pageLimit !== "number" || typeof plan.pageOffset !== "number") return tab.result;
        const executionOptions = plan.useAgentResultSession
          ? {
              maxRows: agentExportMaxRows,
              fetchSize: plan.pageLimit,
              pageSize: plan.pageLimit,
              resultSessionId: sessionId,
              clientSessionId,
              catalog: tab.catalog,
              timeoutSecs: queryTimeoutSecs,
            }
          : { maxRows: plan.pageLimit, fetchSize: plan.pageLimit, clientSessionId, catalog: tab.catalog, timeoutSecs: queryTimeoutSecs };
        const results = await api.executeMulti(tab.connectionId, tab.database, plan.sqlToExecute, tab.schema, exportExecutionId, executionOptions);
        const result = results[0];
        if (!result) break;
        if (columns.length === 0) columns = result.columns;
        rows.push(...result.rows);
        executionTimeMs += result.execution_time_ms ?? 0;
        onProgress?.({ rowsExported: rows.length, totalRows });
        sessionId = result.session_id ?? undefined;
        const shouldFetchNextPage = plan.useAgentResultSession ? result.has_more === true : result.rows.length >= plan.pageLimit;
        if (!shouldFetchNextPage || rows.length >= exportRowLimit) break;
        offset += result.rows.length;
      }
    } finally {
      if (sessionId) void api.closeQuerySession(tab.connectionId, tab.database, sessionId, clientSessionId, tab.catalog);
      void closeClientSessionId(tab.connectionId, tab.database, clientSessionId, tab.catalog, { tabId: tab.id });
    }

    return {
      columns: columns.length ? columns : tab.result.columns,
      rows,
      affected_rows: 0,
      execution_time_ms: executionTimeMs,
      truncated: false,
      has_more: false,
    };
  }

  async function buildQueryResultExportRequest(id: string, options: BuildQueryResultExportRequestOptions) {
    const tab = tabs.value.find((t) => t.id === id);
    if (!tab?.result || tab.mode !== "query") return undefined;

    const sql = queryResultExecutionSql(tab);
    if (!sql.trim()) return undefined;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const settings = useSettingsStore().editorSettings;
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    if (!effectiveDbType) return undefined;
    if (effectiveDbType === "mongodb") return undefined;
    const useAgentCursor = usesAgentCursorForQuery(conn?.db_type);
    const queryBaseSql = queryResultBaseSql(tab);
    const resultStatementIndex = tab.result.statement_index;
    const batchSql = tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql;
    const batchStatements = effectiveDbType === "postgres" && tab.result.truncated === true && Number.isInteger(resultStatementIndex) && resultStatementIndex! > 0 ? splitSqlStatementRanges(batchSql, effectiveDbType) : [];
    const setupSql = batchStatements[resultStatementIndex!]?.sql === tab.result.sourceStatement ? batchStatements.slice(0, resultStatementIndex).map((statement) => statement.sql) : undefined;
    const rowLimit = settings.exportRowLimitEnabled ? settings.exportRowLimit : null;
    const totalRows = typeof tab.resultTotalRowCount === "number" ? (rowLimit === null ? tab.resultTotalRowCount : Math.min(tab.resultTotalRowCount, rowLimit)) : null;
    const clientSessionId = `${tabClientSessionId(tab, "export")}:${options.exportId}`;

    return {
      exportId: options.exportId,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      sql,
      queryBaseSql,
      setupSql,
      databaseType: effectiveDbType,
      useAgentCursor,
      filePath: options.filePath,
      format: options.format,
      includeSqlSheet: options.format === "xlsx" && options.includeSqlSheet === true,
      pageSize: settings.exportBatchSize,
      rowLimit,
      totalRows,
      timeoutSecs: queryTimeoutSecsForConnection(conn),
      keysetOptimizationEnabled: settings.queryExportKeysetOptimizationEnabled,
      clientSessionId,
      executionId: uuid(),
      exportTableName: options.exportTableName,
      exportColumnTypes: options.exportColumnTypes,
      numericColumnRightAlign: settings.numericColumnRightAlign,
    };
  }

  async function exportQuerySqlDirect(id: string, sql: string, format: "csv" | "xlsx" | "txt", filePath: string, columnComments?: (string | null)[]) {
    const tab = tabs.value.find((item) => item.id === id);
    if (!tab || tab.mode !== "query" || !sql.trim()) return;

    const connStore = useConnectionStore();
    await connStore.ensureConnected(tab.connectionId);
    const conn = connStore.getConfig(tab.connectionId);
    const settings = useSettingsStore().editorSettings;
    const effectiveDbType = effectiveDatabaseTypeForConnection(conn);
    if (!effectiveDbType) return;

    const exportId = uuid();
    const request: api.QueryResultExportRequest = {
      exportId,
      connectionId: tab.connectionId,
      database: tab.database,
      schema: tab.schema,
      sql,
      queryBaseSql: sql,
      databaseType: effectiveDbType,
      useAgentCursor: usesAgentCursorForQuery(conn?.db_type),
      filePath,
      format,
      pageSize: settings.exportBatchSize,
      rowLimit: settings.exportRowLimitEnabled ? settings.exportRowLimit : null,
      totalRows: null,
      timeoutSecs: queryTimeoutSecsForConnection(conn),
      keysetOptimizationEnabled: settings.queryExportKeysetOptimizationEnabled,
      clientSessionId: `${tabClientSessionId(tab, "export")}:${exportId}`,
      executionId: uuid(),
      numericColumnRightAlign: settings.numericColumnRightAlign,
      columnComments,
    };

    const tracker = useExportTracker();
    tracker.addTask("Query Result", format, filePath, request.exportId);
    tracker.registerTaskCancelHandler(request.exportId, () => api.cancelQueryResultExport(request.exportId, request.executionId));

    void (async () => {
      try {
        await api.startQueryResultExport(request, (progress) => tracker.updateTableExportTask(request.exportId, progress));
      } catch (error: any) {
        const task = tracker.tasks.value.find((item) => item.exportId === request.exportId);
        if (task) {
          task.status = "Error";
          task.errorMessage = error?.message || String(error);
        }
      } finally {
        tracker.unregisterTaskCancelHandler(request.exportId);
      }
    })();
  }

  return {
    tabs,
    activeTabId,
    isOpenTabsLoaded,
    initOpenTabs,
    showCloseConfirm,
    pendingCloseTabId,
    closeConfirmContext,
    closeConfirmDirtyTabIds,
    hasDirtyTabs,
    isConfirmingAppClose,
    createTab,
    showExecutedQueryResults,
    switchTab,
    closeTab,
    forceClosePendingTab,
    forceCloseAllPendingTabs,
    cancelClosePendingTab,
    flushPendingPersist,
    saveAndClosePendingTab,
    suspendCloseConfirm,
    resumeCloseConfirm,
    completePendingCloseAfterSaveAll,
    isTabDirty,
    markTabClean,
    discardTabChanges,
    requestAppCloseConfirmation,
    closeOtherTabs,
    closeRightTabs,
    closeOtherRegularTabs,
    closeRegularTabs,
    closeOtherFixedTabs,
    closeFixedTabs,
    closeAllTabs,
    duplicateTab,
    closeConnectionTabs,
    closeDatabaseTabs,
    closeDroppedTableObjectTabs,
    refreshDataTab,
    refreshDataTabsForTable,
    releaseConnectionTabs,
    releaseDatabaseTabs,
    isDatabaseOpen,
    openDatabaseKeys,
    rollbackConnectionTransactions,
    rollbackDatabaseTransactions,
    updateSql,
    updateDataGridLocalColumnFilters,
    updateDataGridHiddenColumnKeys,
    updateEditorViewport,
    updateEditorSelection,
    updateObjectBrowserViewport,
    setAutoCommit,
    commitTransaction,
    rollbackTransaction,
    renameTab,
    openObjectBrowser,
    openMongoGridFs,
    openMongoBucket,
    openUserAdmin,
    openProcessList,
    openMysqlDashboard,
    openPostgresDashboard,
    openNacosDashboard,
    openDamengJobAdmin,
    openMqAdmin,
    openMqttAdmin,
    openNacosAdmin,
    clearNacosNavigationTarget,
    openTableStructure,
    linkSavedSql,
    linkExternalSqlPath,
    openExternalSqlFile,
    openSavedSql,
    hydrateSavedSqlTabs,
    togglePinnedTab,
    reorderTab,
    updateDatabase,
    updateCatalog,
    updateSchema,
    updateConnection,
    setTableMeta,
    clearInvalidDataTabSort,
    invalidateTableStructure,
    tableStructureRefreshVersion,
    setObjectSource,
    setExecuting,
    setExecutingWithId,
    setErrorResult,
    invalidateResultEstimateForPayload,
    toggleResultAutoSave,
    setActiveResultRun,
    removeResultRun,
    setActiveResultIndex,
    executeCurrentTab,
    executeCurrentSql,
    executeTabSql,
    sortTabResultLocally,
    explainTabSql,
    cancelTabExecution,
    cancelTabExplain,
    reloadEvictedTab,
    exportResultArchive,
    importResultArchive,
    fetchTabResultForExport,
    buildQueryResultExportRequest,
    exportQuerySqlDirect,
    getResourceLifecycleDiagnostics: () => resourceLifecycleDiagnostics(tabs.value),
    notifyConnectionMayBeLost,
  };
});
