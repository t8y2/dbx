import { isTauriRuntime } from "./tauriRuntime";
import type * as TauriModule from "./tauri";

// ---------------------------------------------------------------------------
// Lazy backend resolution (avoids top-level await)
// ---------------------------------------------------------------------------

type Backend = typeof TauriModule;

let _backend: Backend | null = null;

async function getBackend(): Promise<Backend> {
  if (_backend) return _backend;
  _backend = isTauriRuntime(globalThis)
    ? await import("./tauri")
    : await import("./http");
  return _backend;
}

// ---------------------------------------------------------------------------
// Helper: create a forwarding function that lazily resolves the backend
// ---------------------------------------------------------------------------

function forward<K extends keyof Backend>(name: K): Backend[K] {
  return (async (...args: unknown[]) => {
    const b = await getBackend();
    return (b[name] as (...a: unknown[]) => unknown)(...args);
  }) as unknown as Backend[K];
}

// ---------------------------------------------------------------------------
// Re-export all functions via lazy forwarding
// ---------------------------------------------------------------------------

// Connection
export const testConnection = forward("testConnection");
export const connectDb = forward("connectDb");
export const disconnectDb = forward("disconnectDb");
export const saveConnections = forward("saveConnections");
export const loadConnections = forward("loadConnections");

// Schema
export const listDatabases = forward("listDatabases");
export const listSchemas = forward("listSchemas");
export const listTables = forward("listTables");
export const getColumns = forward("getColumns");
export const listIndexes = forward("listIndexes");
export const listForeignKeys = forward("listForeignKeys");
export const listTriggers = forward("listTriggers");
export const getTableDdl = forward("getTableDdl");

// Query
export const executeQuery = forward("executeQuery");
export const executeMulti = forward("executeMulti");
export const executeBatch = forward("executeBatch");
export const executeScript = forward("executeScript");
export const cancelQuery = forward("cancelQuery");

// AI
export const aiComplete = forward("aiComplete");
export const aiStream = forward("aiStream");
export const aiCancelStream = forward("aiCancelStream");
export const aiTestConnection = forward("aiTestConnection");
export const saveAiConfig = forward("saveAiConfig");
export const loadAiConfig = forward("loadAiConfig");
export const saveAiConversation = forward("saveAiConversation");
export const loadAiConversations = forward("loadAiConversations");
export const deleteAiConversation = forward("deleteAiConversation");

// SQL File Execution
export const previewSqlFile = forward("previewSqlFile");
export const executeSqlFile = forward("executeSqlFile");
export const cancelSqlFileExecution = forward("cancelSqlFileExecution");
export const listenSqlFileProgress = forward("listenSqlFileProgress");

// Data Transfer
export const startTransfer = forward("startTransfer");
export const cancelTransfer = forward("cancelTransfer");

// Table File Import
export const previewTableImportFile = forward("previewTableImportFile");
export const importTableFile = forward("importTableFile");
export const cancelTableImport = forward("cancelTableImport");

// Redis
export const redisListDatabases = forward("redisListDatabases");
export const redisScanKeys = forward("redisScanKeys");
export const redisGetValue = forward("redisGetValue");
export const redisSetString = forward("redisSetString");
export const redisDeleteKey = forward("redisDeleteKey");
export const redisHashSet = forward("redisHashSet");
export const redisHashDel = forward("redisHashDel");
export const redisListPush = forward("redisListPush");
export const redisListRemove = forward("redisListRemove");
export const redisSetAdd = forward("redisSetAdd");
export const redisSetRemove = forward("redisSetRemove");

// MongoDB
export const mongoListDatabases = forward("mongoListDatabases");
export const mongoListCollections = forward("mongoListCollections");
export const mongoFindDocuments = forward("mongoFindDocuments");
export const mongoInsertDocument = forward("mongoInsertDocument");
export const mongoUpdateDocument = forward("mongoUpdateDocument");
export const mongoDeleteDocument = forward("mongoDeleteDocument");

// History
export const saveHistory = forward("saveHistory");
export const loadHistory = forward("loadHistory");
export const clearHistory = forward("clearHistory");
export const deleteHistoryEntry = forward("deleteHistoryEntry");

// Updates
export const checkForUpdates = forward("checkForUpdates");

// Layout
export const saveSidebarLayout = forward("saveSidebarLayout");
export const loadSidebarLayout = forward("loadSidebarLayout");

// ---------------------------------------------------------------------------
// Re-export all types from tauri.ts (shared between both backends)
// ---------------------------------------------------------------------------

export type {
  AiMessage,
  AiCompletionRequest,
  AiStreamChunk,
  AiChatMessage,
  AiConversation,
  UpdateInfo,
  RedisKeyInfo,
  RedisValue,
  RedisScanResult,
  MongoDocumentResult,
  HistoryEntry,
  SqlFileStatus,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TableImportMode,
  TableImportStatus,
  TableImportColumnMapping,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
} from "./tauri";
