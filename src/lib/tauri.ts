import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ConnectionConfig,
  DatabaseInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  ForeignKeyInfo,
  TriggerInfo,
  QueryResult,
} from "@/types/database";
import type { AiConfig } from "@/stores/settingsStore";

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

export async function listTables(connectionId: string, database: string, schema: string): Promise<TableInfo[]> {
  return invoke("list_tables", { connectionId, database, schema });
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
): Promise<QueryResult> {
  return invoke("execute_query", { connectionId, database, sql, schema, executionId });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
): Promise<QueryResult[]> {
  return invoke("execute_multi", { connectionId, database, sql, schema, executionId });
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return invoke("cancel_query", { executionId });
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
}

export interface RedisValue {
  key_display: string;
  key_raw: string;
  key_type: string;
  ttl: number;
  value_is_binary: boolean;
  value: any;
}

export interface RedisScanResult {
  cursor: number;
  keys: RedisKeyInfo[];
}

export async function redisListDatabases(connectionId: string): Promise<number[]> {
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

export async function redisListRemove(connectionId: string, db: number, keyRaw: string, index: number): Promise<void> {
  return invoke("redis_list_remove", { connectionId, db, keyRaw, index });
}

export async function redisSetAdd(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_set_add", { connectionId, db, keyRaw, member });
}

export async function redisSetRemove(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return invoke("redis_set_remove", { connectionId, db, keyRaw, member });
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
): Promise<MongoDocumentResult> {
  return invoke("mongo_find_documents", { connectionId, database, collection, skip, limit });
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
  connection_name: string;
  database: string;
  sql: string;
  executed_at: string;
  execution_time_ms: number;
  success: boolean;
  error?: string;
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
