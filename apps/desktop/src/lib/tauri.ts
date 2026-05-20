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
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcPluginStatus,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
} from "@/types/database";
import type { AiConfig } from "@/stores/settingsStore";

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

export type JavaRuntimeMode = "managed" | "system" | "custom";

export interface JavaRuntimeConfig {
  mode: JavaRuntimeMode;
  custom_java_path: string | null;
}

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

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return invoke("ai_complete", { request });
}

export interface AiStreamChunk {
  session_id: string;
  delta: string;
  reasoning_delta?: string;
  done: boolean;
}

export async function aiStream(
  sessionId: string,
  request: AiCompletionRequest,
  onChunk: (chunk: AiStreamChunk) => void,
): Promise<void> {
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

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export async function aiTestConnection(config: AiConfig): Promise<string> {
  return invoke("ai_test_connection", { config });
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return invoke("ai_cancel_stream", { sessionId });
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return invoke("load_ai_config");
}

export async function pendingOpenSqlFiles(): Promise<string[]> {
  return invoke("pending_open_sql_files");
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

export async function disconnectDb(connectionId: string): Promise<void> {
  return invoke("disconnect_db", { connectionId });
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

export async function listTables(
  connectionId: string,
  database: string,
  schema: string,
  filter?: string,
  limit?: number,
): Promise<TableInfo[]> {
  return invoke("list_tables", { connectionId, database, schema, filter, limit });
}

export async function listObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return invoke("list_objects", { connectionId, database, schema });
}

export async function getObjectSource(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  objectType: ObjectSourceKind,
): Promise<ObjectSource> {
  return invoke("get_object_source", { connectionId, database, schema, name, objectType });
}

export async function listSchemas(connectionId: string, database: string): Promise<string[]> {
  return invoke("list_schemas", { connectionId, database });
}

export async function getColumns(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  return invoke("get_columns", { connectionId, database, schema, table });
}

export async function executeQuery(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: { maxRows?: number; fetchSize?: number; pageSize?: number; resultSessionId?: string },
): Promise<QueryResult> {
  return invoke("execute_query", { connectionId, database, sql, schema, executionId, ...options });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: { maxRows?: number; fetchSize?: number; pageSize?: number; resultSessionId?: string },
): Promise<QueryResult[]> {
  return invoke("execute_multi", { connectionId, database, sql, schema, executionId, ...options });
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return invoke("cancel_query", { executionId });
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string): Promise<boolean> {
  return invoke("close_query_session", { connectionId, database, sessionId });
}

export async function executeBatch(
  connectionId: string,
  database: string,
  statements: string[],
  schema?: string,
): Promise<QueryResult> {
  return invoke("execute_batch", { connectionId, database, statements, schema });
}

export async function executeScript(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
): Promise<QueryResult> {
  return invoke("execute_script", { connectionId, database, sql, schema });
}

export async function executeInTransaction(
  connectionId: string,
  database: string,
  statements: string[],
  schema?: string,
): Promise<QueryResult> {
  return invoke("execute_in_transaction", { connectionId, database, statements, schema });
}

export async function listIndexes(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<IndexInfo[]> {
  return invoke("list_indexes", { connectionId, database, schema, table });
}

export async function listForeignKeys(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<ForeignKeyInfo[]> {
  return invoke("list_foreign_keys", { connectionId, database, schema, table });
}

export async function listTriggers(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<TriggerInfo[]> {
  return invoke("list_triggers", { connectionId, database, schema, table });
}

export async function getTableDdl(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<string> {
  return invoke("get_table_ddl", { connectionId, database, schema, table });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return invoke("save_connections", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return invoke("load_connections");
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return invoke("list_plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return invoke("list_jdbc_drivers");
}

export async function importJdbcDrivers(paths: string[]): Promise<JdbcDriverInfo[]> {
  return invoke("import_jdbc_drivers", { paths });
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_driver", { path });
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return invoke("jdbc_plugin_status");
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return invoke("install_jdbc_plugin");
}

export async function installJdbcPluginLocal(path: string): Promise<JdbcPluginStatus> {
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

export async function installAgent(dbType: string): Promise<void> {
  return invoke("install_agent", { dbType });
}

export async function upgradeAllAgents(): Promise<number> {
  return invoke("upgrade_all_agents");
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

export async function importAgentsFromZip(path: string): Promise<number> {
  return invoke("import_agents_from_zip", { path });
}

export async function importAgentJar(dbType: string, path: string): Promise<void> {
  return invoke("import_agent_jar_cmd", { dbType, path });
}

export async function reinstallJre(jreKey?: string): Promise<void> {
  return invoke("reinstall_jre", { jreKey });
}

export async function uninstallJre(jreKey: string): Promise<void> {
  return invoke("uninstall_jre", { jreKey });
}

export async function listenAgentInstallProgress(
  handler: (progress: DriverInstallProgress) => void,
): Promise<UnlistenFn> {
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
  release_name: string;
  release_url: string;
  release_notes: string;
}

export async function checkForUpdates(): Promise<UpdateInfo> {
  return invoke("check_for_updates");
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

export async function redisScanKeys(
  connectionId: string,
  db: number,
  cursor: number,
  pattern: string,
  count: number,
): Promise<RedisScanResult> {
  return invoke("redis_scan_keys", { connectionId, db, cursor, pattern, count });
}

export async function redisScanValues(
  connectionId: string,
  db: number,
  cursor: number,
  pattern: string,
  query: string,
  count: number,
): Promise<RedisScanResult> {
  return invoke("redis_scan_values", { connectionId, db, cursor, pattern, query, count });
}

export async function redisGetValue(connectionId: string, db: number, keyRaw: string): Promise<RedisValue> {
  return invoke("redis_get_value", { connectionId, db, keyRaw });
}

export async function redisSetString(
  connectionId: string,
  db: number,
  keyRaw: string,
  value: string,
  ttl?: number,
): Promise<void> {
  return invoke("redis_set_string", { connectionId, db, keyRaw, value, ttl });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return invoke("redis_delete_key", { connectionId, db, keyRaw });
}

export async function redisHashSet(
  connectionId: string,
  db: number,
  keyRaw: string,
  field: string,
  value: string,
): Promise<void> {
  return invoke("redis_hash_set", { connectionId, db, keyRaw, field, value });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return invoke("redis_hash_del", { connectionId, db, keyRaw, field });
}

export async function redisListPush(connectionId: string, db: number, keyRaw: string, value: string): Promise<void> {
  return invoke("redis_list_push", { connectionId, db, keyRaw, value });
}

export async function redisListSet(
  connectionId: string,
  db: number,
  keyRaw: string,
  index: number,
  value: string,
): Promise<void> {
  return invoke("redis_list_set", { connectionId, db, keyRaw, index, value });
}

export async function redisListRemove(connectionId: string, db: number, keyRaw: string, index: number): Promise<void> {
  return invoke("redis_list_remove", { connectionId, db, keyRaw, index });
}

export async function redisSetAdd(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_set_add", { connectionId, db, keyRaw, member });
}

export async function redisSetRemove(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_set_remove", { connectionId, db, keyRaw, member });
}

export async function redisZadd(
  connectionId: string,
  db: number,
  keyRaw: string,
  member: string,
  score: number,
): Promise<void> {
  return invoke("redis_zadd", { connectionId, db, keyRaw, member, score });
}

export async function redisZrem(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_zrem", { connectionId, db, keyRaw, member });
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

export async function redisExecuteCommand(
  connectionId: string,
  db: number,
  command: string,
): Promise<RedisCommandResult> {
  return invoke("redis_execute_command", { connectionId, db, command });
}

export async function redisLoadMore(
  connectionId: string,
  db: number,
  keyRaw: string,
  keyType: string,
  cursor: number,
  count: number,
): Promise<RedisValue> {
  return invoke("redis_load_more", { connectionId, db, keyRaw, keyType, cursor, count });
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

export async function mongoFindDocuments(
  connectionId: string,
  database: string,
  collection: string,
  skip: number,
  limit: number,
  filter?: string,
  sort?: string,
): Promise<MongoDocumentResult> {
  return invoke("mongo_find_documents", { connectionId, database, collection, skip, limit, filter, sort });
}

export async function mongoInsertDocument(
  connectionId: string,
  database: string,
  collection: string,
  docJson: string,
): Promise<string> {
  return invoke("mongo_insert_document", { connectionId, database, collection, docJson });
}

export async function mongoUpdateDocument(
  connectionId: string,
  database: string,
  collection: string,
  id: string,
  docJson: string,
): Promise<number> {
  return invoke("mongo_update_document", { connectionId, database, collection, id, docJson });
}

export async function mongoDeleteDocument(
  connectionId: string,
  database: string,
  collection: string,
  id: string,
): Promise<number> {
  return invoke("mongo_delete_document", { connectionId, database, collection, id });
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
  activity_kind?: "query" | "data_change" | "schema_change" | "import" | "transfer";
  operation?: string;
  target?: string;
  affected_rows?: number | null;
  rollback_sql?: string | null;
  details_json?: string | null;
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return invoke("save_history", { entry });
}

export async function loadHistory(limit: number, offset: number): Promise<HistoryEntry[]> {
  return invoke("load_history", { limit, offset });
}

export async function clearHistory(): Promise<void> {
  return invoke("clear_history");
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return invoke("delete_history_entry", { id });
}

// --- SQL File Execution ---
export type SqlFileStatus =
  | "started"
  | "running"
  | "statementDone"
  | "statementFailed"
  | "done"
  | "error"
  | "cancelled";

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

export async function startTransfer(
  request: TransferRequest,
  onProgress: (progress: TransferProgress) => void,
): Promise<void> {
  const unlisten: UnlistenFn = await listen<TransferProgress>("transfer-progress", (event) => {
    if (event.payload.transferId === request.transferId) {
      onProgress(event.payload);
      if (event.payload.status === "done" || event.payload.status === "error" || event.payload.status === "cancelled") {
        unlisten();
      }
    }
  });
  try {
    await invoke("start_transfer", { request });
  } catch (e) {
    unlisten();
    throw e;
  }
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

export async function importTableFile(
  request: TableImportRequest,
  onProgress: (progress: TableImportProgress) => void,
): Promise<TableImportSummary> {
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

export async function exportDatabaseSql(
  request: DatabaseExportRequest,
  onProgress: (progress: ExportProgress) => void,
): Promise<void> {
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
