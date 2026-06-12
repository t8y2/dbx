import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConnectionConfig,
  DatabaseInfo,
  TableInfo,
  ObjectInfo,
  ObjectSource,
  ObjectSourceKind,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TriggerInfo,
  QueryResult,
  SqlReferenceAnalysis,
  DatabaseType,
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcMavenBundleInfo,
  JdbcPluginStatus,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
} from "@/types/database";
import type { SidebarObjectKind } from "@/lib/databaseObjectCapabilities";
import type { AiConfig } from "@/stores/settingsStore";
import type { QueryEditability } from "@/lib/sqlAnalysis";
import type { DataGridColumnValueFilterConditionOptions, DataGridContextFilterConditionOptions, DataGridCountSqlOptions, DataGridCopyInsertStatementOptions, DataGridCopyUpdateStatementOptions, DataGridSaveStatementOptions, HiveTablePropertiesSqlOptions } from "@/lib/dataGridSql";
import type { DataCompareFromTablesOptions, DataCompareFromTablesPreparation, DataCompareSyncPlan, DataCompareSyncPlanOptions, DataComparePreparation, DataComparePreparationOptions } from "@/lib/dataCompare";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff } from "@/lib/schemaDiff";
import type { BuildTableStructureChangeSqlOptions, BuildSingleColumnAlterSqlOptions, TableStructureChangeSql } from "@/lib/tableStructureEditorSql";
import type { BuildTableSelectSqlOptions } from "@/lib/tableSelectSql";
import type { DatabaseSearchSql, DatabaseSearchSqlOptions, SearchResultWhereOptions } from "@/lib/databaseSearch";
import type { BuildEditableObjectSourceSqlInput, BuildRoutineRenameObjectSourceInput } from "@/lib/objectSourceEditor";
import type { BuildViewDdlInput } from "@/lib/viewDdl";
import type { BuildRenameObjectSqlOptions } from "@/lib/objectRenameSql";
import type { CreateDatabaseSqlOptions } from "@/lib/createDatabaseSql";
import type { DatabaseNameSqlOptions, DropTableChildObjectSqlOptions, DropObjectSqlOptions, DuplicateTableStructureSqlOptions, SchemaNameSqlOptions, TableAdminSqlOptions } from "@/lib/dbAdminSql";
import type { BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions } from "@/lib/databaseExport";

export interface AgentDriverInfo {
  db_type: string;
  label: string;
  version: string;
  size: number;
  installed: boolean;
  installed_version: string | null;
  update_available: boolean;
  jre: string;
  jre_installed: boolean;
}

export interface AgentDriverUpdateIssue {
  db_type: string;
  error: string;
}

export interface UpgradeAllAgentDriversResult {
  upgraded: number;
  failed: AgentDriverUpdateIssue[];
}

export interface AgentUpdateBlocker {
  db_type: string;
  label: string;
}

export type JavaRuntimeMode = "managed" | "system" | "custom";

export interface JavaRuntimeConfig {
  mode: JavaRuntimeMode;
  custom_java_path: string | null;
}

export interface DriverStoreUsageItem {
  id: string;
  bytes: number;
}

export interface DriverStoreUsage {
  total_bytes: number;
  jre_bytes: number;
  agent_driver_bytes: number;
  download_cache_bytes?: number;
  jdbc_plugin_bytes: number;
  jdbc_driver_bytes: number;
  jres: DriverStoreUsageItem[];
  agent_drivers: DriverStoreUsageItem[];
}

export type DriverRuntimeHealth = "healthy" | "warning" | "error";
export type DriverRuntimeStatus = "running" | "stopped" | "error" | "unknown";

export interface DriverRuntimeInfo {
  id: string;
  driver_key: string;
  label: string;
  kind: string;
  source: string;
  status: DriverRuntimeStatus;
  pid: number | null;
  memory_bytes: number | null;
  cpu_percent: number | null;
  uptime_seconds: number | null;
  version: string | null;
  last_error: string | null;
  can_stop: boolean;
  can_restart: boolean;
  control_unavailable_reason: string | null;
}

export interface DriverRuntimeSummary {
  running_count: number;
  total_memory_bytes: number;
  last_error: string | null;
  health: DriverRuntimeHealth;
  runtimes: DriverRuntimeInfo[];
}

export interface DesktopSettings {
  show_tray_icon: boolean;
  icon_theme: "default" | "black";
  debug_logging_enabled: boolean;
  saved_sql_sync_dir?: string | null;
}

export interface SavedSqlSyncEntry {
  folderName?: string;
  fileName: string;
  sql: string;
}

export interface SavedSqlSyncRequest {
  targetDir: string;
  entries: SavedSqlSyncEntry[];
}

export interface WebDavConfig {
  endpoint: string;
  username?: string;
  password?: string;
  remotePath?: string;
}

export interface WebDavSyncSummary {
  remotePath: string;
  bytes: number;
  exportedAt?: string;
  appVersion?: string;
}

export interface WebDavDownloadResult {
  summary: WebDavSyncSummary;
  editorSettings?: unknown;
  desktopSettings: DesktopSettings;
  applySummary: {
    encryptedSecretsPresent: boolean;
    secretsApplied: boolean;
  };
}

export interface WebDavPasswordStatus {
  hasSavedPassword: boolean;
}

export interface QueryPagination {
  limit: number;
  offset: number;
  sessionId?: string;
}

export interface QueryPaginationExecutionPlanOptions {
  sql: string;
  queryBaseSql: string;
  databaseType?: DatabaseType;
  pagination: QueryPagination;
  useAgentCursor: boolean;
}

export interface QueryPaginationExecutionPlan {
  sqlToExecute: string;
  pageSql?: string;
  pageLimit?: number;
  pageOffset?: number;
  countSql?: string;
  useAgentResultSession: boolean;
}

export type QuerySortDirection = "asc" | "desc";

export interface SortedQuerySqlOptions {
  originalSql: string;
  databaseType?: DatabaseType;
  resultColumns: string[];
  columnIndex: number;
  column: string;
  direction: QuerySortDirection;
}

export interface QuerySqlBuildResult {
  ok: boolean;
  sql?: string;
  reason?: "empty" | "multi" | "not_select" | "unsupported" | "with";
}

export interface BuildExplainSqlOptions {
  databaseType?: DatabaseType;
  sql: string;
}

export interface ExplainSqlBuildResult {
  ok: boolean;
  sql?: string;
  reason?: "unsupported" | "empty" | "unsafe";
}

export interface DroppedFilePreviewSqlOptions {
  path: string;
  limit?: number;
}

export type XlsxCellValue = string | number | boolean | null;

export interface DriverInstallProgress {
  step: string;
  downloaded?: number;
  total?: number;
  db_type?: string;
  current?: number;
  total_drivers?: number;
}

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiCompletionRequest {
  config: AiConfig;
  systemPrompt: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface AiModelInfo {
  id: string;
  displayName?: string;
}

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return invoke("ai_complete", { request });
}

export interface AiStreamChunk {
  session_id: string;
  delta: string;
  reasoning_delta?: string;
  done: boolean;
}

export async function aiStream(sessionId: string, request: AiCompletionRequest, onChunk: (chunk: AiStreamChunk) => void): Promise<void> {
  const unlisten: UnlistenFn = await listen<AiStreamChunk>("ai-stream-chunk", (event) => {
    if (event.payload.session_id === sessionId) {
      onChunk(event.payload);
      if (event.payload.done) unlisten();
    }
  });
  try {
    await invoke("ai_stream", { sessionId, request });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; tool_call_id: string; tool_name: string; args: Record<string, unknown> }
  | { type: "tool_call_end"; tool_call_id: string; tool_name: string; result: unknown; is_error: boolean }
  | { type: "turn_end"; turn: number }
  | { type: "agent_end"; total_tokens?: number }
  | { type: "error"; message: string };

export async function aiAgentStream(sessionId: string, request: AiCompletionRequest, connectionId: string, database: string, dbType: string, onEvent: (event: AgentEvent) => void): Promise<string> {
  const unlisten: UnlistenFn = await listen<AgentEvent>("ai-agent-event", (event) => {
    onEvent(event.payload);
    if (event.payload.type === "agent_end" || event.payload.type === "error") {
      unlisten();
    }
  });
  try {
    return await invoke("ai_agent_stream", { sessionId, request, connectionId, database, dbType });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export async function aiTestConnection(config: AiConfig): Promise<string> {
  return invoke("ai_test_connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return invoke("ai_list_models", { config });
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return invoke("ai_cancel_stream", { sessionId });
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return invoke("load_ai_config");
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  return invoke("load_desktop_settings");
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  return invoke("save_desktop_settings", { settings });
}

export async function webdavSyncTest(config: WebDavConfig): Promise<void> {
  return invoke("webdav_sync_test", { config });
}

export async function webdavPasswordStatus(config: WebDavConfig): Promise<WebDavPasswordStatus> {
  return invoke("webdav_password_status", { config });
}

export async function saveWebdavSavedPassword(config: WebDavConfig, password: string): Promise<void> {
  return invoke("save_webdav_saved_password", { config, password });
}

export async function forgetWebdavSavedPassword(config: WebDavConfig): Promise<void> {
  return invoke("forget_webdav_saved_password", { config });
}

export async function webdavSyncUpload(config: WebDavConfig, editorSettings?: unknown, secretsPassphrase?: string): Promise<WebDavSyncSummary> {
  return invoke("webdav_sync_upload", { config, editorSettings, secretsPassphrase });
}

export async function webdavSyncDownload(config: WebDavConfig, secretsPassphrase?: string): Promise<WebDavDownloadResult> {
  return invoke("webdav_sync_download", { config, secretsPassphrase });
}

export async function loadPinnedTreeNodeIds(): Promise<string[]> {
  return invoke("load_pinned_tree_node_ids");
}

export async function savePinnedTreeNodeIds(ids: string[]): Promise<void> {
  return invoke("save_pinned_tree_node_ids", { ids });
}

export async function listSystemFonts(): Promise<string[]> {
  return invoke("list_system_fonts");
}

export async function pendingOpenSqlFiles(): Promise<string[]> {
  return invoke("pending_open_sql_files");
}

export async function pendingOpenDbFiles(): Promise<string[]> {
  return invoke("pending_open_db_files");
}

export async function pendingOpenConnectionLinks(): Promise<string[]> {
  return invoke("pending_open_connection_links");
}

export async function readExternalSqlFile(path: string): Promise<string> {
  return invoke("read_external_sql_file", { path });
}

// --- AI Conversations ---

export interface AiChatMessage {
  role: string;
  content: string;
  reasoning?: string;
}

export interface AiConversation {
  id: string;
  title: string;
  connectionName: string;
  database: string;
  messages: AiChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export async function saveAiConversation(conversation: AiConversation): Promise<void> {
  return invoke("save_ai_conversation", { conversation });
}

export async function loadAiConversations(): Promise<AiConversation[]> {
  return invoke("load_ai_conversations");
}

export async function deleteAiConversation(id: string): Promise<void> {
  return invoke("delete_ai_conversation", { id });
}

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return invoke("test_connection", { config });
}

export async function connectDb(config: ConnectionConfig): Promise<string> {
  return invoke("connect_db", { config });
}

export async function connectionFinalProxyPort(config: ConnectionConfig): Promise<number> {
  return invoke("connection_final_proxy_port", { config });
}

export async function disconnectDb(connectionId: string): Promise<void> {
  return invoke("disconnect_db", { connectionId });
}

export async function closeDatabaseConnection(connectionId: string, database: string): Promise<boolean> {
  return invoke("close_database_connection", { connectionId, database });
}

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { connectionId });
}

export async function saveSchemaCache(cacheKey: string, payload: unknown): Promise<void> {
  return invoke("save_schema_cache", { cacheKey, payload });
}

export async function loadSchemaCache<T = unknown>(cacheKey: string): Promise<T | null> {
  return invoke("load_schema_cache", { cacheKey });
}

export async function deleteSchemaCachePrefix(prefix: string): Promise<void> {
  return invoke("delete_schema_cache_prefix", { prefix });
}

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number): Promise<TableInfo[]> {
  return invoke("list_tables", { connectionId, database, schema, filter, limit });
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: SidebarObjectKind[]): Promise<ObjectInfo[]> {
  return invoke("list_objects", { connectionId, database, schema, objectTypes });
}

export async function listCompletionObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return invoke("list_completion_objects", { connectionId, database, schema });
}

export async function getObjectSource(connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind): Promise<ObjectSource> {
  return invoke("get_object_source", { connectionId, database, schema, name, objectType });
}

export async function listSchemas(connectionId: string, database: string): Promise<string[]> {
  return invoke("list_schemas", { connectionId, database });
}

export async function getColumns(connectionId: string, database: string, schema: string, table: string): Promise<ColumnInfo[]> {
  return invoke("get_columns", { connectionId, database, schema, table });
}

export async function executeQuery(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: {
    maxRows?: number;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
  },
): Promise<QueryResult> {
  return invoke("execute_query", { connectionId, database, sql, schema, executionId, ...options });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: {
    maxRows?: number;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
  },
): Promise<QueryResult[]> {
  return invoke("execute_multi", { connectionId, database, sql, schema, executionId, ...options });
}

export async function refreshConnections(): Promise<void> {
  return invoke("refresh_connections");
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return invoke("cancel_query", { executionId });
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string): Promise<boolean> {
  return invoke("close_query_session", { connectionId, database, sessionId, clientSessionId });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string): Promise<boolean> {
  return invoke("close_client_connection_session", { connectionId, database, clientSessionId });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string, timeoutSecs?: number): Promise<QueryResult> {
  return invoke("execute_batch", { connectionId, database, statements, schema, timeoutSecs });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return invoke("execute_script", { connectionId, database, sql, schema });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string): Promise<QueryResult> {
  return invoke("execute_in_transaction", { connectionId, database, statements, schema });
}

export async function analyzeSqlReferences(sql: string, dialect?: string): Promise<SqlReferenceAnalysis> {
  return invoke("analyze_sql_references", { sql, dialect });
}

export async function findStatementAtCursor(sql: string, cursorPos: number, databaseType?: DatabaseType): Promise<string> {
  return invoke("find_statement_at_cursor", { sql, cursorPos, databaseType });
}

export async function prepareQueryPaginationExecutionPlan(options: QueryPaginationExecutionPlanOptions): Promise<QueryPaginationExecutionPlan> {
  return invoke("prepare_query_pagination_execution_plan", { options });
}

export async function buildSortedQuerySql(options: SortedQuerySqlOptions): Promise<QuerySqlBuildResult> {
  return invoke("build_sorted_query_sql", { options });
}

export async function buildExplainSql(options: BuildExplainSqlOptions): Promise<ExplainSqlBuildResult> {
  return invoke("build_explain_sql", { options });
}

export async function buildCreateUserSql(username: string, password: string, tablespace: string): Promise<string> {
  return invoke("build_create_user_sql", { username, password, tablespace });
}

export async function getExplainInfo(connectionId: string, database: string | undefined, schema: string | undefined, sql: string, mode: string): Promise<string | undefined> {
  try {
    const result = await invoke<string>("get_explain_info", { connectionId, database, schema, sql, mode });
    return result;
  } catch (e: any) {
    console.error("[getExplainInfo] invoke failed:", e?.message || e);
    return undefined;
  }
}

export async function buildDroppedFilePreviewSql(options: DroppedFilePreviewSqlOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_dropped_file_preview_sql", { options });
  return result ?? undefined;
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return invoke("build_table_select_sql", { options });
}

export async function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): Promise<DatabaseSearchSql | null> {
  return invoke("build_database_search_sql", { options });
}

export async function buildSearchResultWhere(options: SearchResultWhereOptions): Promise<string> {
  return invoke("build_search_result_where", { options });
}

export async function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return invoke("build_rename_object_sql", { options });
}

export async function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return invoke("build_create_database_sql", { options });
}

export async function buildDuckDbAttachDatabaseSql(path: string, name: string): Promise<string> {
  return invoke("build_duckdb_attach_database_sql", { options: { path, name } });
}

export async function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return invoke("build_drop_object_sql", { options });
}

export async function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_drop_table_sql", { options });
}

export async function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return invoke("build_drop_table_child_object_sql", { options });
}

export async function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_empty_table_sql", { options });
}

export async function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return invoke("build_truncate_table_sql", { options });
}

export async function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return invoke("build_drop_database_sql", { options });
}

export async function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return invoke("build_create_schema_sql", { options });
}

export async function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return invoke("build_drop_schema_sql", { options });
}

export async function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return invoke("build_duplicate_table_structure_sql", { options });
}

export async function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return invoke("build_executable_object_source_statements", { input });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return invoke("build_executable_object_source_sql", { input });
}

export async function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return invoke("build_routine_rename_object_source_statements", { input });
}

export async function buildViewDdlSql(input: BuildViewDdlInput): Promise<string> {
  return invoke("build_view_ddl_sql", { input });
}

export async function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_table_structure_change_sql", { options });
}

export async function buildCreateTableSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_create_table_sql", { options });
}

export async function buildSingleColumnAlterSql(options: BuildSingleColumnAlterSqlOptions): Promise<TableStructureChangeSql> {
  return invoke("build_single_column_alter_sql", { options });
}

export async function analyzeEditableQueryEditability(sql: string): Promise<QueryEditability> {
  return invoke("analyze_editable_query_editability", { sql });
}

export interface DataGridSavePreparation {
  validationError?: string;
  statements: string[];
  rollbackStatements: string[];
  executionSchema?: string;
}

export async function prepareDataGridSave(options: DataGridSaveStatementOptions): Promise<DataGridSavePreparation> {
  return invoke("prepare_data_grid_save", { options });
}

export async function buildDataGridCopyUpdateStatements(options: DataGridCopyUpdateStatementOptions): Promise<string[]> {
  return invoke("build_data_grid_copy_update_statements", { options });
}

export async function buildDataGridCopyInsertStatement(options: DataGridCopyInsertStatementOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_copy_insert_statement", { options });
  return result ?? undefined;
}

export async function buildDataGridContextFilterCondition(options: DataGridContextFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_context_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValueFilterCondition(options: DataGridColumnValueFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_column_value_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridCountSql(options: DataGridCountSqlOptions): Promise<string> {
  return invoke("build_data_grid_count_sql", { options });
}

export async function buildHiveTablePropertiesSql(options: HiveTablePropertiesSqlOptions): Promise<string> {
  return invoke("build_hive_table_properties_sql", { options });
}

export async function buildExportInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return invoke("build_export_insert_statements", { options });
}

export async function buildExportSqlInsert(options: BuildExportInsertStatementsOptions): Promise<string> {
  return invoke("build_export_sql_insert", { options });
}

export async function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return invoke("build_database_sql_export", { options });
}

export async function prepareDataCompare(options: DataComparePreparationOptions): Promise<DataComparePreparation> {
  return invoke("prepare_data_compare", { options });
}

export async function prepareDataCompareFromTables(options: DataCompareFromTablesOptions): Promise<DataCompareFromTablesPreparation> {
  return invoke("prepare_data_compare_from_tables", { options });
}

export async function prepareDataCompareMissingTarget(options: import("@/lib/dataCompare").DataCompareMissingTargetOptions): Promise<DataCompareFromTablesPreparation> {
  return invoke("prepare_data_compare_missing_target", { options });
}

export async function buildDataCompareSyncPlan(options: DataCompareSyncPlanOptions): Promise<DataCompareSyncPlan> {
  return invoke("build_data_compare_sync_plan", { options });
}

export async function listIndexes(connectionId: string, database: string, schema: string, table: string): Promise<IndexInfo[]> {
  return invoke("list_indexes", { connectionId, database, schema, table });
}

export async function listForeignKeys(connectionId: string, database: string, schema: string, table: string): Promise<ForeignKeyInfo[]> {
  return invoke("list_foreign_keys", { connectionId, database, schema, table });
}

export async function listTriggers(connectionId: string, database: string, schema: string, table: string): Promise<TriggerInfo[]> {
  return invoke("list_triggers", { connectionId, database, schema, table });
}

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string): Promise<string> {
  return invoke("get_table_ddl", { connectionId, database, schema, table });
}

export async function prepareSchemaDiff(options: SchemaDiffPreparationOptions): Promise<SchemaDiffPreparation> {
  return invoke("prepare_schema_diff", { options });
}

export async function generateSchemaSyncSql(diffs: TableDiff[], databaseType: DatabaseType, targetSchema?: string): Promise<string> {
  return invoke("generate_schema_sync_sql", { diffs, databaseType, targetSchema });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return invoke("save_connections", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return invoke("load_connections");
}

export async function readKeychainPassword(service: string): Promise<string> {
  return invoke("read_keychain_password", { service, account: null });
}

export async function readKeychainPasswords(services: string[]): Promise<[string, string][]> {
  return invoke("read_keychain_passwords", { services });
}

export async function decryptConfig(payload: unknown, passphrase: string): Promise<string> {
  const { decryptConfig: decryptConfigPayload } = await import("@/lib/configCrypto");
  return decryptConfigPayload(payload as any, passphrase);
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return invoke("list_plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return invoke("list_jdbc_drivers");
}

export async function listJdbcMavenBundles(): Promise<JdbcMavenBundleInfo[]> {
  return invoke("list_jdbc_maven_bundles");
}

export async function importJdbcDrivers(paths: (string | File)[]): Promise<JdbcDriverInfo[]> {
  if (paths.some((path) => typeof path !== "string")) {
    throw new Error("Desktop JDBC driver import requires local file paths");
  }
  return invoke("import_jdbc_drivers", { paths });
}

export async function installJdbcDriverFromMaven(coordinate: string, repositories: string[] = []): Promise<JdbcDriverInfo[]> {
  return invoke("install_jdbc_driver_from_maven", { request: { coordinate, repositories } });
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_driver", { path });
}

export async function deleteJdbcMavenBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_maven_bundle", { bundleId });
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return invoke("jdbc_plugin_status");
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return invoke("install_jdbc_plugin");
}

export async function installJdbcPluginLocal(path: string | File): Promise<JdbcPluginStatus> {
  if (typeof path !== "string") {
    throw new Error("Desktop JDBC plugin install requires a local file path");
  }
  return invoke("install_jdbc_plugin_local", { path });
}

export async function uninstallJdbcPlugin(): Promise<JdbcPluginStatus> {
  return invoke("uninstall_jdbc_plugin");
}

export async function listInstalledAgentsLocal(): Promise<AgentDriverInfo[]> {
  return invoke("list_installed_agents_local");
}

export async function listInstalledAgents(): Promise<AgentDriverInfo[]> {
  return invoke("list_installed_agents");
}

export async function getDriverStoreUsage(): Promise<DriverStoreUsage> {
  return invoke("get_driver_store_usage");
}

export async function getDriverRuntimeSummary(): Promise<DriverRuntimeSummary> {
  return invoke("get_driver_runtime_summary");
}

export async function stopDriverRuntime(runtimeId: string): Promise<void> {
  return invoke("stop_driver_runtime", { runtimeId });
}

export async function restartDriverRuntime(runtimeId: string): Promise<void> {
  return invoke("restart_driver_runtime", { runtimeId });
}

export async function installAgent(dbType: string): Promise<void> {
  return invoke("install_agent", { dbType });
}

export async function upgradeAllAgents(): Promise<UpgradeAllAgentDriversResult> {
  return invoke("upgrade_all_agents");
}

export async function checkAgentUpdateBlockers(dbTypes: string[]): Promise<AgentUpdateBlocker[]> {
  return invoke("check_agent_update_blockers", { dbTypes });
}

export async function uninstallAgent(dbType: string): Promise<void> {
  return invoke("uninstall_agent", { dbType });
}

export async function getAgentJavaRuntimeConfig(): Promise<JavaRuntimeConfig> {
  return invoke("get_agent_java_runtime_config");
}

export async function setAgentJavaRuntimeConfig(config: JavaRuntimeConfig): Promise<JavaRuntimeConfig> {
  return invoke("set_agent_java_runtime_config", { config });
}

export async function invalidateAgentRegistryCache(): Promise<void> {
  return invoke("invalidate_agent_registry_cache");
}

export async function importAgentsFromZip(path: string | File): Promise<number> {
  if (typeof path !== "string") {
    throw new Error("Desktop offline ZIP import requires a local file path");
  }
  return invoke("import_agents_from_zip", { path });
}

export async function importAgentJar(dbType: string, path: string | File): Promise<void> {
  if (typeof path !== "string") {
    throw new Error("Desktop driver JAR import requires a local file path");
  }
  return invoke("import_agent_jar_cmd", { dbType, path });
}

export async function reinstallJre(jreKey?: string): Promise<void> {
  return invoke("reinstall_jre", { jreKey });
}

export async function uninstallJre(jreKey: string): Promise<void> {
  return invoke("uninstall_jre", { jreKey });
}

export async function listenAgentInstallProgress(handler: (progress: DriverInstallProgress) => void): Promise<UnlistenFn> {
  return listen<DriverInstallProgress>("agent-install-progress", (event) => handler(event.payload));
}

export async function loadSavedSqlLibrary(): Promise<SavedSqlLibrary> {
  return invoke("load_saved_sql_library");
}

export async function saveSavedSqlFolder(folder: SavedSqlFolder): Promise<SavedSqlFolder> {
  return invoke("save_saved_sql_folder", { folder });
}

export async function deleteSavedSqlFolder(id: string): Promise<void> {
  return invoke("delete_saved_sql_folder", { id });
}

export async function saveSavedSqlFile(file: SavedSqlFile): Promise<SavedSqlFile> {
  return invoke("save_saved_sql_file", { file });
}

export async function deleteSavedSqlFile(id: string): Promise<void> {
  return invoke("delete_saved_sql_file", { id });
}

export async function savedSqlStorageDir(): Promise<string> {
  return invoke("saved_sql_storage_dir");
}

export async function openSavedSqlStorageDir(dir?: string | null): Promise<void> {
  return invoke("open_saved_sql_storage_dir", { dir });
}

export async function syncSavedSqlDirectory(request: SavedSqlSyncRequest): Promise<void> {
  return invoke("sync_saved_sql_directory", { request });
}

export async function saveSidebarLayout(layout: import("@/types/database").SidebarLayout): Promise<void> {
  return invoke("save_sidebar_layout", { layout });
}

export async function loadSidebarLayout(): Promise<import("@/types/database").SidebarLayout | null> {
  return invoke("load_sidebar_layout");
}

// --- Updates ---
export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  portable_mode: boolean;
  release_name: string;
  release_url: string;
  release_notes: string;
}

export interface McpServerStatus {
  installed: boolean;
  npm_available: boolean;
  node_version: string | null;
  current_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  bin_path: string | null;
  install_command: string;
  update_command: string;
  error: string | null;
}

export async function checkMcpServerStatus(): Promise<McpServerStatus> {
  return invoke("check_mcp_server_status");
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  return invoke("check_for_updates");
}

export async function getSystemProxyUrl(): Promise<string | null> {
  return invoke("get_system_proxy_url");
}

export async function getAppVersion(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

// --- Redis ---
export interface RedisKeyInfo {
  key_display: string;
  key_raw: string;
  key_type: string;
  ttl: number;
  size: number;
  value_preview: string;
}

export interface RedisDatabaseInfo {
  db: number;
  keys: number;
}

export interface RedisValue {
  key_display: string;
  key_raw: string;
  key_type: string;
  ttl: number;
  value_is_binary: boolean;
  value: any;
  total?: number;
  scan_cursor?: number;
}

export interface RedisScanResult {
  cursor: number;
  keys: RedisKeyInfo[];
  total_keys: number;
}

export type RedisCommandSafety = "allowed" | "confirm" | "blocked";

export interface RedisCommandResult {
  command: string;
  safety: RedisCommandSafety;
  value: any;
}

export async function redisListDatabases(connectionId: string): Promise<RedisDatabaseInfo[]> {
  return invoke("redis_list_databases", { connectionId });
}

export async function redisScanKeys(connectionId: string, db: number, cursor: number, pattern: string, count: number): Promise<RedisScanResult> {
  return invoke("redis_scan_keys", { connectionId, db, cursor, pattern, count });
}

export async function redisScanValues(connectionId: string, db: number, cursor: number, pattern: string, query: string, count: number, includeKeyMatches = false): Promise<RedisScanResult> {
  return invoke("redis_scan_values", { connectionId, db, cursor, pattern, query, includeKeyMatches, count });
}

export async function redisGetValue(connectionId: string, db: number, keyRaw: string): Promise<RedisValue> {
  return invoke("redis_get_value", { connectionId, db, keyRaw });
}

export async function redisSetString(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_set_string", { connectionId, db, keyRaw, value, ttl });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return invoke("redis_delete_key", { connectionId, db, keyRaw });
}

export async function redisHashSet(connectionId: string, db: number, keyRaw: string, field: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_hash_set", { connectionId, db, keyRaw, field, value, ttl });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return invoke("redis_hash_del", { connectionId, db, keyRaw, field });
}

export async function redisListPush(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_list_push", { connectionId, db, keyRaw, value, ttl });
}

export async function redisListSet(connectionId: string, db: number, keyRaw: string, index: number, value: string): Promise<void> {
  return invoke("redis_list_set", { connectionId, db, keyRaw, index, value });
}

export async function redisListRemove(connectionId: string, db: number, keyRaw: string, index: number): Promise<void> {
  return invoke("redis_list_remove", { connectionId, db, keyRaw, index });
}

export async function redisSetAdd(connectionId: string, db: number, keyRaw: string, member: string, ttl?: number): Promise<void> {
  return invoke("redis_set_add", { connectionId, db, keyRaw, member, ttl });
}

export async function redisSetRemove(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_set_remove", { connectionId, db, keyRaw, member });
}

export async function redisZadd(connectionId: string, db: number, keyRaw: string, member: string, score: number, ttl?: number): Promise<void> {
  return invoke("redis_zadd", { connectionId, db, keyRaw, member, score, ttl });
}

export async function redisZrem(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_zrem", { connectionId, db, keyRaw, member });
}

export async function redisStreamAdd(connectionId: string, db: number, keyRaw: string, entryId: string, fields: [string, string][], ttl?: number): Promise<void> {
  return invoke("redis_stream_add", { connectionId, db, keyRaw, entryId, fields, ttl });
}

export async function redisJsonSet(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_json_set", { connectionId, db, keyRaw, value, ttl });
}

export async function redisCheckJsonModule(connectionId: string, db: number): Promise<boolean> {
  return invoke("redis_check_json_module", { connectionId, db });
}

export async function redisSetTtl(connectionId: string, db: number, keyRaw: string, ttl: number): Promise<void> {
  return invoke("redis_set_ttl", { connectionId, db, keyRaw, ttl });
}

export async function redisDeleteKeys(connectionId: string, db: number, keyRaws: string[]): Promise<number> {
  return invoke("redis_delete_keys", { connectionId, db, keyRaws });
}

export async function redisFlushDb(connectionId: string, db: number): Promise<void> {
  return invoke("redis_flush_db", { connectionId, db });
}

export async function redisExecuteCommand(connectionId: string, db: number, command: string, skipSafetyCheck?: boolean): Promise<RedisCommandResult> {
  return invoke("redis_execute_command", { connectionId, db, command, skipSafetyCheck: skipSafetyCheck ?? false });
}

export async function redisLoadMore(connectionId: string, db: number, keyRaw: string, keyType: string, cursor: number, count: number): Promise<RedisValue> {
  return invoke("redis_load_more", { connectionId, db, keyRaw, keyType, cursor, count });
}

// --- etcd ---
export type KvValueEncoding = "utf8" | "base64";

export interface KvValue {
  encoding: KvValueEncoding;
  data: string;
}

export interface KvKeyMetadata {
  createRevision?: number | null;
  modRevision?: number | null;
  version?: number | null;
  lease?: number | null;
  valueSize?: number | null;
}

export interface KvKeySummary extends KvKeyMetadata {
  key: string;
}

export interface KvListPrefixResponse {
  keys: KvKeySummary[];
  continuation?: string | null;
  revision?: number | null;
}

export interface KvGetResponse {
  found: boolean;
  key?: string | null;
  value?: KvValue | null;
  metadata?: KvKeyMetadata | null;
}

export interface KvPutResponse {
  revision?: number | null;
}

export interface KvDeleteResponse {
  deleted: number;
  revision?: number | null;
}

export async function etcdListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null): Promise<KvListPrefixResponse> {
  return invoke("etcd_list_prefix", { connectionId, prefix, limit, continuation });
}

export async function etcdGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return invoke("etcd_get", { connectionId, key });
}

export async function etcdPut(connectionId: string, key: string, value: KvValue, lease?: number | null): Promise<KvPutResponse> {
  return invoke("etcd_put", { connectionId, key, value, lease });
}

export async function etcdDelete(connectionId: string, key: string): Promise<KvDeleteResponse> {
  return invoke("etcd_delete", { connectionId, key });
}

// --- MongoDB ---
export interface MongoDocumentResult {
  documents: any[];
  total: number;
}

export async function mongoListDatabases(connectionId: string): Promise<string[]> {
  return invoke("mongo_list_databases", { connectionId });
}

export async function mongoListCollections(connectionId: string, database: string): Promise<string[]> {
  return invoke("mongo_list_collections", { connectionId, database });
}

export async function elasticsearchListIndices(connectionId: string): Promise<string[]> {
  return mongoListCollections(connectionId, "default");
}

export async function mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, sort?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_find_documents", { connectionId, database, collection, skip, limit, filter, sort });
}

export async function documentFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, sort?: string): Promise<MongoDocumentResult> {
  return invoke("document_find_documents", { connectionId, database, collection, skip, limit, filter, sort });
}

export async function mongoAggregateDocuments(connectionId: string, database: string, collection: string, pipelineJson: string, maxRows?: number): Promise<MongoDocumentResult> {
  return invoke("mongo_aggregate_documents", { connectionId, database, collection, pipelineJson, maxRows });
}

export async function mongoInsertDocument(connectionId: string, database: string, collection: string, docJson: string): Promise<string> {
  return invoke("mongo_insert_document", { connectionId, database, collection, docJson });
}

export async function mongoInsertDocuments(connectionId: string, database: string, collection: string, docsJson: string): Promise<{ affected_rows: number }> {
  const affectedRows = await invoke<number>("mongo_insert_documents", { connectionId, database, collection, docsJson });
  return { affected_rows: affectedRows };
}

export async function mongoUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string): Promise<number> {
  return invoke("mongo_update_document", { connectionId, database, collection, id, docJson });
}

export async function mongoUpdateDocuments(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, many: boolean): Promise<{ affected_rows: number }> {
  const affectedRows = await invoke<number>("mongo_update_documents", {
    connectionId,
    database,
    collection,
    filterJson,
    updateJson,
    many,
  });
  return { affected_rows: affectedRows };
}

export async function mongoDeleteDocument(connectionId: string, database: string, collection: string, id: string): Promise<number> {
  return invoke("mongo_delete_document", { connectionId, database, collection, id });
}

export async function mongoDeleteDocuments(connectionId: string, database: string, collection: string, filterJson: string, many: boolean): Promise<{ affected_rows: number }> {
  const affectedRows = await invoke<number>("mongo_delete_documents", {
    connectionId,
    database,
    collection,
    filterJson,
    many,
  });
  return { affected_rows: affectedRows };
}

// --- History ---
export interface HistoryEntry {
  id: string;
  connection_id?: string;
  connection_name: string;
  database: string;
  sql: string;
  executed_at: string;
  execution_time_ms: number;
  success: boolean;
  error?: string;
  activity_kind?: "query" | "data_change" | "schema_change" | "import" | "transfer" | "redis_command";
  operation?: string;
  target?: string;
  affected_rows?: number | null;
  rollback_sql?: string | null;
  details_json?: string | null;
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return invoke("save_history", { entry });
}

export async function loadHistory(limit: number, offset: number, activityKind?: string): Promise<HistoryEntry[]> {
  return invoke("load_history", { limit, offset, activityKind: activityKind ?? null });
}

export async function loadRedisHistory(limit = 100, offset = 0): Promise<HistoryEntry[]> {
  return loadHistory(limit, offset, "redis_command");
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

export async function clearRedisHistory(): Promise<void> {
  const entries = await loadRedisHistory(1000, 0);
  await Promise.all(entries.map((e) => deleteHistoryEntry(e.id)));
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return invoke("delete_history_entry", { id });
}

// --- SQL File Execution ---
export type SqlFileStatus = "started" | "running" | "statementDone" | "statementFailed" | "done" | "error" | "cancelled";

export interface SqlFileRequest {
  executionId: string;
  connectionId: string;
  database: string;
  filePath: string;
  continueOnError: boolean;
}

export interface SqlFilePreview {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  preview: string;
}

export interface SqlFileProgress {
  executionId: string;
  status: SqlFileStatus;
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
  elapsedMs: number;
  statementSummary: string;
  error?: string | null;
}

export async function previewSqlFile(filePath: string): Promise<SqlFilePreview> {
  return invoke("preview_sql_file", { filePath });
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return invoke("execute_sql_file", { request });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return invoke("cancel_sql_file_execution", { executionId });
}

export async function listenSqlFileProgress(handler: (progress: SqlFileProgress) => void): Promise<UnlistenFn> {
  return listen<SqlFileProgress>("sql-file-progress", (event) => handler(event.payload));
}

// --- Data Transfer ---
export type TransferMode = "append" | "overwrite" | "upsert";

export interface TransferRequest {
  transferId: string;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  tables: string[];
  createTable: boolean;
  mode: TransferMode;
  batchSize: number;
}

export interface TransferProgress {
  transferId: string;
  table: string;
  tableIndex: number;
  totalTables: number;
  rowsTransferred: number;
  totalRows: number | null;
  status: "running" | "tableDone" | "done" | "error" | "cancelled";
  error: string | null;
}

export async function startTransfer(request: TransferRequest, onProgress: (progress: TransferProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        unlisten = await listen<TransferProgress>("transfer-progress", (event) => {
          if (event.payload.transferId !== request.transferId) return;
          onProgress(event.payload);
          if (event.payload.status === "done" || event.payload.status === "cancelled") {
            unlisten?.();
            resolve();
          }
        });

        await invoke("start_transfer", { request });
      } catch (e) {
        unlisten?.();
        reject(e);
      }
    })();
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  return invoke("cancel_transfer", { transferId });
}

// --- Table File Import ---
export type TableImportMode = "append" | "truncate";
export type TableImportStatus = "running" | "done" | "error" | "cancelled";

export interface TableImportColumnMapping {
  sourceColumn: string;
  targetColumn: string;
}

export interface TableImportPreview {
  fileName: string;
  filePath: string;
  fileType: string;
  sizeBytes: number;
  columns: string[];
  rows: unknown[][];
  totalRows: number;
}

export interface TableImportRequest {
  importId: string;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  filePath: string;
  mappings: TableImportColumnMapping[];
  mode: TableImportMode;
  batchSize: number;
}

export interface TableImportSummary {
  importId: string;
  rowsImported: number;
  totalRows: number;
}

export interface TableImportProgress {
  importId: string;
  status: TableImportStatus;
  rowsImported: number;
  totalRows: number;
  error?: string | null;
}

export async function previewTableImportFile(filePath: string): Promise<TableImportPreview> {
  return invoke("preview_table_import_file", { filePath });
}

export async function importTableFile(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void): Promise<TableImportSummary> {
  const unlisten: UnlistenFn = await listen<TableImportProgress>("table-import-progress", (event) => {
    if (event.payload.importId === request.importId) {
      onProgress(event.payload);
      if (event.payload.status === "done" || event.payload.status === "error" || event.payload.status === "cancelled") {
        unlisten();
      }
    }
  });
  try {
    return await invoke("import_table_file", { request });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function cancelTableImport(importId: string): Promise<boolean> {
  return invoke("cancel_table_import", { importId });
}

// --- Database Export ---
export interface DatabaseExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema: string;
  filePath: string;
  selectedTables?: string[];
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  dropTableIfExists?: boolean;
  batchSize: number;
}

export interface ExportProgress {
  exportId: string;
  currentObject: string;
  objectIndex: number;
  totalObjects: number;
  rowsExported: number;
  totalRows: number | null;
  status: "Running" | "Done" | "Error" | "Cancelled";
  error: string | null;
}

// --- Table Export ---
export type TableExportStatus = "Running" | "Writing" | "Done" | "Error" | "Cancelled";

export interface TableExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  filePath: string;
  format: "csv" | "xlsx" | "json" | "markdown" | "sql";
  columns?: string[];
  columnTypes?: Array<string | null | undefined>;
  primaryKeys?: string[];
  whereInput?: string;
  orderBy?: string;
  skipCount?: boolean;
  batchSize?: number;
}

export interface TableCsvExportOptions {
  filePath: string;
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  columns?: string[];
  pageSize?: number;
  timeoutSecs?: number;
}

export interface TableExportProgress {
  exportId: string;
  tableName: string;
  rowsExported: number;
  totalRows: number | null;
  status: TableExportStatus;
  errorMessage?: string;
}

export async function startTableExport(request: TableExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  let unlisten: UnlistenFn | undefined;
  let settled = false;
  let resolveTerminal: (progress: TableExportProgress) => void = () => {};
  let rejectTerminal: (error: unknown) => void = () => {};

  const terminalProgress = new Promise<TableExportProgress>((resolve, reject) => {
    resolveTerminal = resolve;
    rejectTerminal = reject;
  });

  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    unlisten?.();
    callback();
  };

  try {
    unlisten = await listen<TableExportProgress>("table-export-progress", (event) => {
      if (event.payload.exportId !== request.exportId) return;
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        if (event.payload.status === "Error") {
          finish(() => rejectTerminal(new Error(event.payload.errorMessage || "Export failed")));
        } else {
          finish(() => resolveTerminal(event.payload));
        }
      }
    });
    await invoke("start_table_export", { request });
    return await terminalProgress;
  } catch (error) {
    if (!settled) {
      settled = true;
      unlisten?.();
    }
    throw error;
  }
}

export async function cancelTableExport(exportId: string): Promise<void> {
  return invoke("cancel_table_export", { exportId });
}

export async function exportDatabaseSql(request: DatabaseExportRequest, onProgress: (progress: ExportProgress) => void): Promise<void> {
  const unlisten: UnlistenFn = await listen<ExportProgress>("database-export-progress", (event) => {
    if (event.payload.exportId === request.exportId) {
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        unlisten();
      }
    }
  });
  try {
    await invoke("export_database_sql", { request });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function cancelDatabaseExport(exportId: string): Promise<void> {
  await invoke("cancel_database_export", { exportId });
}

export async function exportQueryResultCsv(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_csv", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}

export async function exportTableDataCsv(options: TableCsvExportOptions): Promise<number> {
  return invoke("export_table_data_csv", { request: options });
}

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_xlsx", {
    request: {
      filePath,
      sheetName,
      columns,
      rows,
    },
  });
}

export async function exportQueryResultJson(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_json", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}

export async function exportQueryResultMarkdown(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  return invoke("export_query_result_markdown", {
    request: {
      filePath,
      columns,
      rows,
    },
  });
}
