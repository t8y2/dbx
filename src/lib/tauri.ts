import { invoke } from "@tauri-apps/api/core";
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

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return invoke("load_ai_config");
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

export async function executeQuery(connectionId: string, database: string, sql: string): Promise<QueryResult> {
  return invoke("execute_query", { connectionId, database, sql });
}

export async function executeBatch(connectionId: string, database: string, statements: string[]): Promise<QueryResult> {
  return invoke("execute_batch", { connectionId, database, statements });
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

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return invoke("save_connections", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return invoke("load_connections");
}

// --- Redis ---
export interface RedisKeyInfo {
  key: string;
  key_type: string;
  ttl: number;
}

export interface RedisValue {
  key: string;
  key_type: string;
  ttl: number;
  value: any;
}

export async function redisListDatabases(connectionId: string): Promise<number[]> {
  return invoke("redis_list_databases", { connectionId });
}

export async function redisScanKeys(connectionId: string, db: number, pattern: string, count: number): Promise<RedisKeyInfo[]> {
  return invoke("redis_scan_keys", { connectionId, db, pattern, count });
}

export async function redisGetValue(connectionId: string, key: string): Promise<RedisValue> {
  return invoke("redis_get_value", { connectionId, key });
}

export async function redisSetString(connectionId: string, key: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_set_string", { connectionId, key, value, ttl });
}

export async function redisDeleteKey(connectionId: string, key: string): Promise<void> {
  return invoke("redis_delete_key", { connectionId, key });
}

export async function redisHashSet(connectionId: string, key: string, field: string, value: string): Promise<void> {
  return invoke("redis_hash_set", { connectionId, key, field, value });
}

export async function redisHashDel(connectionId: string, key: string, field: string): Promise<void> {
  return invoke("redis_hash_del", { connectionId, key, field });
}

export async function redisListPush(connectionId: string, key: string, value: string): Promise<void> {
  return invoke("redis_list_push", { connectionId, key, value });
}

export async function redisListRemove(connectionId: string, key: string, index: number): Promise<void> {
  return invoke("redis_list_remove", { connectionId, key, index });
}

export async function redisSetAdd(connectionId: string, key: string, member: string): Promise<void> {
  return invoke("redis_set_add", { connectionId, key, member });
}

export async function redisSetRemove(connectionId: string, key: string, member: string): Promise<void> {
  return invoke("redis_set_remove", { connectionId, key, member });
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

export async function mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number): Promise<MongoDocumentResult> {
  return invoke("mongo_find_documents", { connectionId, database, collection, skip, limit });
}

export async function mongoInsertDocument(connectionId: string, database: string, collection: string, docJson: string): Promise<string> {
  return invoke("mongo_insert_document", { connectionId, database, collection, docJson });
}

export async function mongoUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string): Promise<number> {
  return invoke("mongo_update_document", { connectionId, database, collection, id, docJson });
}

export async function mongoDeleteDocument(connectionId: string, database: string, collection: string, id: string): Promise<number> {
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
