import { isTauriRuntime } from "./tauriRuntime";
import type * as TauriModule from "./tauri";
import { appendDebugLog } from "./debugLog";

// ---------------------------------------------------------------------------
// Lazy backend resolution (avoids top-level await)
// ---------------------------------------------------------------------------

type Backend = typeof TauriModule;

let _backend: Backend | null = null;

async function getBackend(): Promise<Backend> {
  if (_backend) return _backend;
  _backend = isTauriRuntime(globalThis) ? await import("./tauri") : await import("./http");
  return _backend;
}

// ---------------------------------------------------------------------------
// Helper: create a forwarding function that lazily resolves the backend
// ---------------------------------------------------------------------------

function forward<K extends keyof Backend>(name: K): Backend[K] {
  return (async (...args: unknown[]) => {
    const startedAt = performance.now();
    const operation = String(name);
    appendDebugLog("debug", "[DBX][api:start]", operation);
    const b = await getBackend();
    try {
      const result = await (b[name] as (...a: unknown[]) => unknown)(...args);
      appendDebugLog("debug", "[DBX][api:success]", {
        operation,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return result;
    } catch (error) {
      appendDebugLog("error", "[DBX][api:error]", {
        operation,
        elapsedMs: Math.round(performance.now() - startedAt),
        error,
      });
      throw error;
    }
  }) as unknown as Backend[K];
}

// ---------------------------------------------------------------------------
// Re-export all functions via lazy forwarding
// ---------------------------------------------------------------------------

// Connection
export const testConnection = forward("testConnection");
export const connectDb = forward("connectDb");
export const connectionFinalProxyPort = forward("connectionFinalProxyPort");
export const disconnectDb = forward("disconnectDb");
export const closeDatabaseConnection = forward("closeDatabaseConnection");
export const refreshConnections = forward("refreshConnections");
export const saveConnections = forward("saveConnections");
export const loadConnections = forward("loadConnections");
export const readKeychainPassword = forward("readKeychainPassword");
export const readKeychainPasswords = forward("readKeychainPasswords");
export const decryptConfig = forward("decryptConfig");
export const listPlugins = forward("listPlugins");
export const listJdbcDrivers = forward("listJdbcDrivers");
export const listJdbcMavenBundles = forward("listJdbcMavenBundles");
export const importJdbcDrivers = forward("importJdbcDrivers");
export const installJdbcDriverFromMaven = forward("installJdbcDriverFromMaven");
export const deleteJdbcDriver = forward("deleteJdbcDriver");
export const deleteJdbcMavenBundle = forward("deleteJdbcMavenBundle");
export const jdbcPluginStatus = forward("jdbcPluginStatus");
export const installJdbcPlugin = forward("installJdbcPlugin");
export const installJdbcPluginLocal = forward("installJdbcPluginLocal");
export const uninstallJdbcPlugin = forward("uninstallJdbcPlugin");
export const listInstalledAgentsLocal = forward("listInstalledAgentsLocal");
export const listInstalledAgents = forward("listInstalledAgents");
export const getDriverStoreUsage = forward("getDriverStoreUsage");
export const getDriverRuntimeSummary = forward("getDriverRuntimeSummary");
export const stopDriverRuntime = forward("stopDriverRuntime");
export const restartDriverRuntime = forward("restartDriverRuntime");
export const installAgent = forward("installAgent");
export const upgradeAllAgents = forward("upgradeAllAgents");
export const checkAgentUpdateBlockers = forward("checkAgentUpdateBlockers");
export const uninstallAgent = forward("uninstallAgent");
export const getAgentJavaRuntimeConfig = forward("getAgentJavaRuntimeConfig");
export const setAgentJavaRuntimeConfig = forward("setAgentJavaRuntimeConfig");
export const invalidateAgentRegistryCache = forward("invalidateAgentRegistryCache");
export const importAgentsFromZip = forward("importAgentsFromZip");
export const importAgentJar = forward("importAgentJar");
export const reinstallJre = forward("reinstallJre");
export const uninstallJre = forward("uninstallJre");
export const listenAgentInstallProgress = forward("listenAgentInstallProgress");
export const loadSavedSqlLibrary = forward("loadSavedSqlLibrary");
export const saveSavedSqlFolder = forward("saveSavedSqlFolder");
export const deleteSavedSqlFolder = forward("deleteSavedSqlFolder");
export const saveSavedSqlFile = forward("saveSavedSqlFile");
export const deleteSavedSqlFile = forward("deleteSavedSqlFile");
export const savedSqlStorageDir = forward("savedSqlStorageDir");
export const openSavedSqlStorageDir = forward("openSavedSqlStorageDir");
export const revealPathInFileManager = forward("revealPathInFileManager");
export const backupSqliteDatabase = forward("backupSqliteDatabase");
export const syncSavedSqlDirectory = forward("syncSavedSqlDirectory");

// Schema
export const listDatabases = forward("listDatabases");
export const saveSchemaCache = forward("saveSchemaCache");
export const loadSchemaCache = forward("loadSchemaCache");
export const deleteSchemaCachePrefix = forward("deleteSchemaCachePrefix");
export const listSchemas = forward("listSchemas");
export const listTables = forward("listTables");
export const listObjects = forward("listObjects");
export const listCompletionObjects = forward("listCompletionObjects");
export const getObjectSource = forward("getObjectSource");
export const getColumns = forward("getColumns");
export const listIndexes = forward("listIndexes");
export const listForeignKeys = forward("listForeignKeys");
export const listTriggers = forward("listTriggers");
export const getTableDdl = forward("getTableDdl");
export const listFunctions = forward("listFunctions");
export const listSequences = forward("listSequences");
export const listRules = forward("listRules");
export const listOwners = forward("listOwners");
export const prepareSchemaDiff = forward("prepareSchemaDiff");
export const generateSchemaSyncSql = forward("generateSchemaSyncSql");

// Query
export const executeQuery = forward("executeQuery");
export const executeMulti = forward("executeMulti");
export const executeBatch = forward("executeBatch");
export const executeScript = forward("executeScript");
export const executeInTransaction = forward("executeInTransaction");
export const cancelQuery = forward("cancelQuery");
export const closeQuerySession = forward("closeQuerySession");
export const closeClientConnectionSession = forward("closeClientConnectionSession");
export const analyzeSqlReferences = forward("analyzeSqlReferences");
export const findStatementAtCursor = forward("findStatementAtCursor");
export const prepareQueryPaginationExecutionPlan = forward("prepareQueryPaginationExecutionPlan");
export const buildSortedQuerySql = forward("buildSortedQuerySql");
export const buildExplainSql = forward("buildExplainSql");
export const getExplainInfo = forward("getExplainInfo");
export const buildCreateUserSql = forward("buildCreateUserSql");
export const buildDroppedFilePreviewSql = forward("buildDroppedFilePreviewSql");
export const buildTableSelectSql = forward("buildTableSelectSql");
export const buildDatabaseSearchSql = forward("buildDatabaseSearchSql");
export const buildSearchResultWhere = forward("buildSearchResultWhere");
export const buildRenameObjectSql = forward("buildRenameObjectSql");
export const buildCreateDatabaseSql = forward("buildCreateDatabaseSql");
export const buildDuckDbAttachDatabaseSql = forward("buildDuckDbAttachDatabaseSql");
export const buildDropObjectSql = forward("buildDropObjectSql");
export const buildDropTableSql = forward("buildDropTableSql");
export const buildDropTableChildObjectSql = forward("buildDropTableChildObjectSql");
export const buildEmptyTableSql = forward("buildEmptyTableSql");
export const buildTruncateTableSql = forward("buildTruncateTableSql");
export const buildDropDatabaseSql = forward("buildDropDatabaseSql");
export const buildCreateSchemaSql = forward("buildCreateSchemaSql");
export const buildDropSchemaSql = forward("buildDropSchemaSql");
export const buildDuplicateTableStructureSql = forward("buildDuplicateTableStructureSql");
export const buildExecutableObjectSourceStatements = forward("buildExecutableObjectSourceStatements");
export const buildExecutableObjectSourceSql = forward("buildExecutableObjectSourceSql");
export const buildRoutineRenameObjectSourceStatements = forward("buildRoutineRenameObjectSourceStatements");
export const buildViewDdlSql = forward("buildViewDdlSql");
export const buildTableStructureChangeSql = forward("buildTableStructureChangeSql");
export const buildCreateTableSql = forward("buildCreateTableSql");
export const buildSingleColumnAlterSql = forward("buildSingleColumnAlterSql");
export const analyzeEditableQueryEditability = forward("analyzeEditableQueryEditability");
export const prepareDataGridSave = forward("prepareDataGridSave");
export const buildDataGridCopyUpdateStatements = forward("buildDataGridCopyUpdateStatements");
export const buildDataGridCopyInsertStatement = forward("buildDataGridCopyInsertStatement");
export const buildDataGridContextFilterCondition = forward("buildDataGridContextFilterCondition");
export const buildDataGridColumnValueFilterCondition = forward("buildDataGridColumnValueFilterCondition");
export const buildDataGridCountSql = forward("buildDataGridCountSql");
export const buildHiveTablePropertiesSql = forward("buildHiveTablePropertiesSql");
export const buildExportInsertStatements = forward("buildExportInsertStatements");
export const buildExportSqlInsert = forward("buildExportSqlInsert");
export const buildDatabaseSqlExport = forward("buildDatabaseSqlExport");
export const prepareDataCompare = forward("prepareDataCompare");
export const prepareDataCompareFromTables = forward("prepareDataCompareFromTables");
export const prepareDataCompareMissingTarget = forward("prepareDataCompareMissingTarget");
export const buildDataCompareSyncPlan = forward("buildDataCompareSyncPlan");

// AI
export const aiComplete = forward("aiComplete");
export const aiStream = forward("aiStream");
export const aiAgentStream = forward("aiAgentStream");
export const aiCancelStream = forward("aiCancelStream");
export const aiTestConnection = forward("aiTestConnection");
export const aiListModels = forward("aiListModels");
export const saveAiConfig = forward("saveAiConfig");
export const loadAiConfig = forward("loadAiConfig");
export const loadDesktopSettings = forward("loadDesktopSettings");
export const saveDesktopSettings = forward("saveDesktopSettings");
export const setDriverStoreDir = forward("setDriverStoreDir");
export const setPluginStoreDir = forward("setPluginStoreDir");
export const setAgentStoreDir = forward("setAgentStoreDir");
export const getDriverStorePath = forward("getDriverStorePath");
export const loadPinnedTreeNodeIds = forward("loadPinnedTreeNodeIds");
export const savePinnedTreeNodeIds = forward("savePinnedTreeNodeIds");
export const webdavSyncTest = forward("webdavSyncTest");
export const webdavPasswordStatus = forward("webdavPasswordStatus");
export const saveWebdavSavedPassword = forward("saveWebdavSavedPassword");
export const forgetWebdavSavedPassword = forward("forgetWebdavSavedPassword");
export const webdavSyncUpload = forward("webdavSyncUpload");
export const webdavSyncDownload = forward("webdavSyncDownload");
export const saveAiConversation = forward("saveAiConversation");
export const loadAiConversations = forward("loadAiConversations");
export const deleteAiConversation = forward("deleteAiConversation");

// System
export const listSystemFonts = forward("listSystemFonts");

// SQL File Execution
export const previewSqlFile = forward("previewSqlFile");
export const executeSqlFile = forward("executeSqlFile");
export const cancelSqlFileExecution = forward("cancelSqlFileExecution");
export const listenSqlFileProgress = forward("listenSqlFileProgress");
export const pendingOpenSqlFiles = forward("pendingOpenSqlFiles");
export const pendingOpenDbFiles = forward("pendingOpenDbFiles");
export const pendingOpenConnectionLinks = forward("pendingOpenConnectionLinks");
export const readExternalSqlFile = forward("readExternalSqlFile");

// Data Transfer
export const startTransfer = forward("startTransfer");
export const cancelTransfer = forward("cancelTransfer");

// Table File Import
export const previewTableImportFile = forward("previewTableImportFile");
export const importTableFile = forward("importTableFile");
export const cancelTableImport = forward("cancelTableImport");

// Database Export
export const exportDatabaseSql = forward("exportDatabaseSql");
export const cancelDatabaseExport = forward("cancelDatabaseExport");
export const exportQueryResultCsv = forward("exportQueryResultCsv");
export const exportTableDataCsv = forward("exportTableDataCsv");
export const exportQueryResultXlsx = forward("exportQueryResultXlsx");
export const exportQueryResultJson = forward("exportQueryResultJson");
export const exportQueryResultMarkdown = forward("exportQueryResultMarkdown");
export const startTableExport = forward("startTableExport");
export const cancelTableExport = forward("cancelTableExport");

// Redis
export const redisListDatabases = forward("redisListDatabases");
export const redisScanKeys = forward("redisScanKeys");
export const redisScanKeysBatch = forward("redisScanKeysBatch");
export const redisScanValues = forward("redisScanValues");
export const redisGetValue = forward("redisGetValue");
export const redisSetString = forward("redisSetString");
export const redisDeleteKey = forward("redisDeleteKey");
export const redisHashSet = forward("redisHashSet");
export const redisHashDel = forward("redisHashDel");
export const redisListPush = forward("redisListPush");
export const redisListSet = forward("redisListSet");
export const redisListRemove = forward("redisListRemove");
export const redisSetAdd = forward("redisSetAdd");
export const redisSetRemove = forward("redisSetRemove");
export const redisZadd = forward("redisZadd");
export const redisZrem = forward("redisZrem");
export const redisStreamAdd = forward("redisStreamAdd");
export const redisJsonSet = forward("redisJsonSet");
export const redisCheckJsonModule = forward("redisCheckJsonModule");
export const redisSetTtl = forward("redisSetTtl");
export const redisDeleteKeys = forward("redisDeleteKeys");
export const redisFlushDb = forward("redisFlushDb");
export const redisExecuteCommand = forward("redisExecuteCommand");
export const redisLoadMore = forward("redisLoadMore");
export const redisPubSubPublish = forward("redisPubSubPublish");

export function redisPubSubConnect(connectionId: string): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${protocol}//${window.location.host}/api/redis/pubsub/ws?connectionId=${encodeURIComponent(connectionId)}`);
}

// etcd
export const etcdListPrefix = forward("etcdListPrefix");
export const etcdGet = forward("etcdGet");
export const etcdPut = forward("etcdPut");
export const etcdDelete = forward("etcdDelete");

// MongoDB
export const mongoListDatabases = forward("mongoListDatabases");
export const mongoListCollections = forward("mongoListCollections");
export const documentFindDocuments = forward("documentFindDocuments");
export const mongoFindDocuments = forward("mongoFindDocuments");
export const mongoAggregateDocuments = forward("mongoAggregateDocuments");
export const mongoInsertDocument = forward("mongoInsertDocument");
export const mongoInsertDocuments = forward("mongoInsertDocuments");
export const mongoUpdateDocument = forward("mongoUpdateDocument");
export const mongoUpdateDocuments = forward("mongoUpdateDocuments");
export const mongoDeleteDocument = forward("mongoDeleteDocument");
export const mongoDeleteDocuments = forward("mongoDeleteDocuments");

// Elasticsearch
export const elasticsearchListIndices = forward("elasticsearchListIndices");

// History
export const saveHistory = forward("saveHistory");
export const loadHistory = forward("loadHistory");
export const loadRedisHistory = forward("loadRedisHistory");
export const clearHistory = forward("clearHistory");
export const clearRedisHistory = forward("clearRedisHistory");
export const deleteHistoryEntry = forward("deleteHistoryEntry");

// Updates
export const checkMcpServerStatus = forward("checkMcpServerStatus");
export const installMcpServer = forward("installMcpServer");
export const checkForUpdates = forward("checkForUpdates");
export const getSystemProxyUrl = forward("getSystemProxyUrl");
export const getAppVersion = forward("getAppVersion");

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
  AiModelInfo,
  AiChatMessage,
  AiConversation,
  AgentDriverInfo,
  DriverStoreUsage,
  DriverStoreUsageItem,
  DriverRuntimeHealth,
  DriverRuntimeStatus,
  DriverRuntimeInfo,
  DriverRuntimeSummary,
  JavaRuntimeMode,
  JavaRuntimeConfig,
  DriverInstallProgress,
  DriverStoreMigrationResult,
  DriverStorePathInfo,
  WebDavConfig,
  WebDavPasswordStatus,
  WebDavSyncSummary,
  WebDavDownloadResult,
  McpServerStatus,
  UpdateInfo,
  RedisDatabaseInfo,
  RedisKeyInfo,
  RedisValue,
  RedisScanResult,
  RedisCommandSafety,
  RedisCommandResult,
  KvValueEncoding,
  KvValue,
  KvKeyMetadata,
  KvKeySummary,
  KvListPrefixResponse,
  KvGetResponse,
  KvPutResponse,
  KvDeleteResponse,
  MongoDocumentResult,
  HistoryEntry,
  SqlFileStatus,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TransferMode,
  TableImportMode,
  TableImportStatus,
  TableImportColumnMapping,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
  DatabaseExportRequest,
  ExportProgress,
  TableExportProgress,
  TableExportStatus,
  TableExportRequest,
  AgentEvent,
} from "./tauri";
