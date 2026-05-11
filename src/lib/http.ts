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
  SidebarLayout,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
} from "@/types/database";
import type { AiConfig } from "@/stores/settingsStore";
import type {
  AiCompletionRequest,
  AiStreamChunk,
  AiConversation,
  UpdateInfo,
  RedisValue,
  RedisScanResult,
  MongoDocumentResult,
  HistoryEntry,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
} from "./tauri";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  return sp.toString();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return post("/api/connection/test", { config });
}

export async function connectDb(config: ConnectionConfig): Promise<string> {
  return post("/api/connection/connect", { config });
}

export async function disconnectDb(connectionId: string): Promise<void> {
  return post("/api/connection/disconnect", { connectionId });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return post("/api/connection/save", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return get("/api/connection/list");
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return get("/api/plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return [];
}

export async function importJdbcDrivers(_paths: string[]): Promise<JdbcDriverInfo[]> {
  return [];
}

export async function deleteJdbcDriver(_path: string): Promise<JdbcDriverInfo[]> {
  return [];
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return { installed: false, version: null, protocol_version: null, compatible: true, path: "" };
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return { installed: false, version: null, protocol_version: null, compatible: true, path: "" };
}

export async function uninstallJdbcPlugin(): Promise<JdbcPluginStatus> {
  return { installed: false, version: null, protocol_version: null, compatible: true, path: "" };
}

export async function loadSavedSqlLibrary(): Promise<SavedSqlLibrary> {
  return get("/api/saved-sql");
}

export async function saveSavedSqlFolder(folder: SavedSqlFolder): Promise<SavedSqlFolder> {
  return post("/api/saved-sql/folders", folder);
}

export async function deleteSavedSqlFolder(id: string): Promise<void> {
  return del(`/api/saved-sql/folders/${encodeURIComponent(id)}`);
}

export async function saveSavedSqlFile(file: SavedSqlFile): Promise<SavedSqlFile> {
  return post("/api/saved-sql", file);
}

export async function deleteSavedSqlFile(id: string): Promise<void> {
  return del(`/api/saved-sql/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/databases?${qs({ connection_id: connectionId })}`);
}

export async function saveSchemaCache(cacheKey: string, payload: unknown): Promise<void> {
  return post("/api/schema/cache", { cacheKey, payload });
}

export async function loadSchemaCache<T = unknown>(cacheKey: string): Promise<T | null> {
  return get(`/api/schema/cache?${qs({ cache_key: cacheKey })}`);
}

export async function deleteSchemaCachePrefix(prefix: string): Promise<void> {
  return del(`/api/schema/cache-prefix?${qs({ prefix })}`);
}

export async function listSchemas(connectionId: string, database: string): Promise<string[]> {
  return get(`/api/schema/schemas?${qs({ connection_id: connectionId, database })}`);
}

export async function listTables(connectionId: string, database: string, schema: string): Promise<TableInfo[]> {
  return get(`/api/schema/tables?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return get(`/api/schema/objects?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function getObjectSource(
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  objectType: ObjectSourceKind,
): Promise<ObjectSource> {
  return get(
    `/api/schema/object-source?${qs({ connection_id: connectionId, database, schema, table: name, object_type: objectType })}`,
  );
}

export async function getColumns(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  return get(`/api/schema/columns?${qs({ connection_id: connectionId, database, schema, table })}`);
}

export async function listIndexes(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<IndexInfo[]> {
  return get(`/api/schema/indexes?${qs({ connection_id: connectionId, database, schema, table })}`);
}

export async function listForeignKeys(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<ForeignKeyInfo[]> {
  return get(`/api/schema/foreign-keys?${qs({ connection_id: connectionId, database, schema, table })}`);
}

export async function listTriggers(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<TriggerInfo[]> {
  return get(`/api/schema/triggers?${qs({ connection_id: connectionId, database, schema, table })}`);
}

export async function getTableDdl(
  connectionId: string,
  database: string,
  schema: string,
  table: string,
): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table })}`);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function executeQuery(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
): Promise<QueryResult> {
  return post("/api/query/execute", { connectionId, database, sql, schema, executionId });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
): Promise<QueryResult[]> {
  return post("/api/query/execute-multi", { connectionId, database, sql, schema, executionId });
}

export async function executeBatch(
  connectionId: string,
  database: string,
  statements: string[],
  schema?: string,
): Promise<QueryResult> {
  return post("/api/query/execute-batch", { connectionId, database, statements, schema });
}

export async function executeScript(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
): Promise<QueryResult> {
  return post("/api/query/execute-script", { connectionId, database, sql, schema });
}

export async function executeInTransaction(
  connectionId: string,
  database: string,
  statements: string[],
  schema?: string,
): Promise<QueryResult> {
  return post("/api/query/execute-in-transaction", { connectionId, database, statements, schema });
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return post("/api/query/cancel", { executionId });
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return post("/api/ai/complete", { request });
}

export async function aiStream(
  sessionId: string,
  request: AiCompletionRequest,
  onChunk: (chunk: AiStreamChunk) => void,
): Promise<void> {
  const res = await fetch("/api/ai/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request }),
  });
  if (!res.ok) throw new Error(await res.text());

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          try {
            const chunk: AiStreamChunk = JSON.parse(data);
            onChunk(chunk);
            if (chunk.done) return;
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  }
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return post("/api/ai/cancel-stream", { sessionId });
}

export async function aiTestConnection(config: AiConfig): Promise<string> {
  return post("/api/ai/test-connection", { config });
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return post("/api/ai/config", { config });
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return get("/api/ai/config");
}

// --- AI Conversations ---

export async function saveAiConversation(conversation: AiConversation): Promise<void> {
  return post("/api/ai/conversation", { conversation });
}

export async function loadAiConversations(): Promise<AiConversation[]> {
  return get("/api/ai/conversations");
}

export async function deleteAiConversation(id: string): Promise<void> {
  return del(`/api/ai/conversation/${id}`);
}

// ---------------------------------------------------------------------------
// SQL File Execution
// ---------------------------------------------------------------------------

export async function previewSqlFile(fileOrPath: string | File): Promise<SqlFilePreview> {
  if (typeof fileOrPath === "string") {
    // In web mode a raw path is not useful; throw a clear error
    throw new Error("previewSqlFile in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  const res = await fetch("/api/sql-file/preview", { method: "POST", body: formData });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return post("/api/sql-file/execute", { request });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return post("/api/sql-file/cancel", { executionId });
}

export async function listenSqlFileProgress(_handler: (progress: SqlFileProgress) => void): Promise<() => void> {
  // For HTTP mode we need an executionId, but the tauri API does not take one.
  // The SSE endpoint requires a specific executionId. As a workaround we return
  // a no-op unlisten; callers that need progress in web mode should use
  // the web-specific SQL file progress listener instead.
  return () => {};
}

// ---------------------------------------------------------------------------
// Data Transfer
// ---------------------------------------------------------------------------

export async function startTransfer(
  request: TransferRequest,
  onProgress: (progress: TransferProgress) => void,
): Promise<void> {
  // 1. POST to start the transfer
  const res = await fetch("/api/transfer/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw new Error(await res.text());

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/transfer/progress/${request.transferId}`);
    es.onmessage = (e) => {
      const progress: TransferProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "done" || progress.status === "error" || progress.status === "cancelled") {
        es.close();
        resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Transfer SSE connection failed"));
    };
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  return post("/api/transfer/cancel", { transferId });
}

// ---------------------------------------------------------------------------
// Table File Import
// ---------------------------------------------------------------------------

export async function previewTableImportFile(fileOrPath: string | File): Promise<TableImportPreview> {
  if (typeof fileOrPath === "string") {
    throw new Error("previewTableImportFile in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  const res = await fetch("/api/import/preview", { method: "POST", body: formData });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importTableFile(
  request: TableImportRequest,
  onProgress: (progress: TableImportProgress) => void,
): Promise<TableImportSummary> {
  // 1. POST to start the import
  const res = await fetch("/api/import/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw new Error(await res.text());

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/import/progress/${request.importId}`);
    let summary: TableImportSummary | null = null;
    es.onmessage = (e) => {
      const progress: TableImportProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "done") {
        summary = {
          importId: progress.importId,
          rowsImported: progress.rowsImported,
          totalRows: progress.totalRows,
        };
        es.close();
        resolve(summary);
      } else if (progress.status === "error" || progress.status === "cancelled") {
        es.close();
        reject(new Error(progress.error || "Import failed"));
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Import SSE connection failed"));
    };
  });
}

export async function cancelTableImport(importId: string): Promise<boolean> {
  return post("/api/import/cancel", { importId });
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export async function redisListDatabases(connectionId: string): Promise<number[]> {
  return post("/api/redis/list-databases", { connectionId });
}

export async function redisScanKeys(
  connectionId: string,
  db: number,
  cursor: number,
  pattern: string,
  count: number,
): Promise<RedisScanResult> {
  return post("/api/redis/scan-keys", { connectionId, db, cursor, pattern, count });
}

export async function redisGetValue(connectionId: string, db: number, keyRaw: string): Promise<RedisValue> {
  return post("/api/redis/get-value", { connectionId, db, keyRaw });
}

export async function redisSetString(
  connectionId: string,
  db: number,
  keyRaw: string,
  value: string,
  ttl?: number,
): Promise<void> {
  return post("/api/redis/set-string", { connectionId, db, keyRaw, value, ttl });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return post("/api/redis/delete-key", { connectionId, db, keyRaw });
}

export async function redisHashSet(
  connectionId: string,
  db: number,
  keyRaw: string,
  field: string,
  value: string,
): Promise<void> {
  return post("/api/redis/hash-set", { connectionId, db, keyRaw, field, value });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return post("/api/redis/hash-del", { connectionId, db, keyRaw, field });
}

export async function redisListPush(connectionId: string, db: number, keyRaw: string, value: string): Promise<void> {
  return post("/api/redis/list-push", { connectionId, db, keyRaw, value });
}

export async function redisListRemove(connectionId: string, db: number, keyRaw: string, index: number): Promise<void> {
  return post("/api/redis/list-remove", { connectionId, db, keyRaw, index });
}

export async function redisSetAdd(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/set-add", { connectionId, db, keyRaw, member });
}

export async function redisSetRemove(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/set-remove", { connectionId, db, keyRaw, member });
}

export async function redisZadd(
  connectionId: string,
  db: number,
  keyRaw: string,
  member: string,
  score: number,
): Promise<void> {
  return post("/api/redis/zadd", { connectionId, db, keyRaw, member, score });
}

export async function redisZrem(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/zrem", { connectionId, db, keyRaw, member });
}

export async function redisSetTtl(connectionId: string, db: number, keyRaw: string, ttl: number): Promise<void> {
  return post("/api/redis/set-ttl", { connectionId, db, keyRaw, ttl });
}

export async function redisDeleteKeys(connectionId: string, db: number, keyRaws: string[]): Promise<number> {
  return post("/api/redis/delete-keys", { connectionId, db, keyRaws });
}

export async function redisLoadMore(
  connectionId: string,
  db: number,
  keyRaw: string,
  keyType: string,
  cursor: number,
  count: number,
): Promise<RedisValue> {
  return post("/api/redis/load-more", { connectionId, db, keyRaw, keyType, cursor, count });
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export async function mongoListDatabases(connectionId: string): Promise<string[]> {
  return post("/api/mongo/list-databases", { connectionId });
}

export async function mongoListCollections(connectionId: string, database: string): Promise<string[]> {
  return post("/api/mongo/list-collections", { connectionId, database });
}

export async function mongoFindDocuments(
  connectionId: string,
  database: string,
  collection: string,
  skip: number,
  limit: number,
): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-documents", { connectionId, database, collection, skip, limit });
}

export async function mongoInsertDocument(
  connectionId: string,
  database: string,
  collection: string,
  docJson: string,
): Promise<string> {
  return post("/api/mongo/insert-document", { connectionId, database, collection, docJson });
}

export async function mongoUpdateDocument(
  connectionId: string,
  database: string,
  collection: string,
  id: string,
  docJson: string,
): Promise<number> {
  return post("/api/mongo/update-document", { connectionId, database, collection, id, docJson });
}

export async function mongoDeleteDocument(
  connectionId: string,
  database: string,
  collection: string,
  id: string,
): Promise<number> {
  return post("/api/mongo/delete-document", { connectionId, database, collection, id });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return post("/api/history/save", { entry });
}

export async function loadHistory(limit: number, offset: number): Promise<HistoryEntry[]> {
  return get(`/api/history?${qs({ limit, offset })}`);
}

export async function clearHistory(): Promise<void> {
  return del("/api/history");
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return del(`/api/history/${id}`);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function checkForUpdates(): Promise<UpdateInfo> {
  return get("/api/update/check");
}

export async function getAppVersion(): Promise<string> {
  const res: { version: string } = await get("/api/version");
  return res.version;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export async function saveSidebarLayout(layout: SidebarLayout): Promise<void> {
  return post("/api/layout/sidebar", { layout });
}

export async function loadSidebarLayout(): Promise<SidebarLayout | null> {
  return get("/api/layout/sidebar");
}
