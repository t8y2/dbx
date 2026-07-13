import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type * as TauriModule from "@/lib/backend/tauri";
import { appendDebugLog } from "@/lib/backend/debugLog";
import { useSettingsStore } from "@/stores/settingsStore";
import { redisCommandDatabaseTargets, redisCommandIsMutation } from "@/lib/redis/redisCommandSafety";
import { productionWriteRequestDigest, withProductionWriteAuthorization, type ProductionWriteAuthorization } from "@/lib/backend/productionWriteAuthorization";

// ---------------------------------------------------------------------------
// Lazy backend resolution (avoids top-level await)
// ---------------------------------------------------------------------------

type Backend = typeof TauriModule;

let _backend: Backend | null = null;

async function getBackend(): Promise<Backend> {
  if (_backend) return _backend;
  _backend = isTauriRuntime(globalThis) ? await import("@/lib/backend/tauri") : await import("@/lib/backend/http");
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

interface ProductionWriteTarget {
  connectionId: string;
  database?: string;
  databaseCandidates?: string[];
  allDatabases?: boolean;
  operation?: string;
  source: string;
}

export class ProductionWriteCancelledError extends Error {
  constructor() {
    super("Production write cancelled.");
    this.name = "ProductionWriteCancelledError";
  }
}

/**
 * Wraps dedicated non-SQL mutation APIs so new callers inherit production
 * confirmation automatically instead of relying on every component to remember it.
 */
function forwardProductionWrite<K extends keyof Backend>(name: K, resolveTarget: (args: unknown[]) => ProductionWriteTarget | undefined, isMutation: (args: unknown[]) => boolean = () => true): Backend[K] {
  return (async (...args: unknown[]) => {
    const target = resolveTarget(args);
    const b = await getBackend();
    let authorization: ProductionWriteAuthorization | undefined;
    if (target && isMutation(args)) {
      const [{ useConnectionStore }, { useProductionSafetyStore }, { productionContextForDatabase }] = await Promise.all([import("@/stores/connectionStore"), import("@/stores/productionSafetyStore"), import("@/lib/database/productionSafety")]);
      const connection = useConnectionStore().getConfig(target.connectionId);
      const candidates = target.databaseCandidates?.length ? [...target.databaseCandidates] : [target.database];
      if (target.allDatabases) candidates.push(...(connection?.production_databases ?? []));
      const productionTarget = candidates.map((database) => ({ database, context: productionContextForDatabase(connection, database) })).find(({ context }) => context.active);
      if (productionTarget) {
        const confirmed = await useProductionSafetyStore().requestConfirmation({
          sql: target.source,
          connectionName: connection?.name,
          database: productionTarget.database,
          productionDatabases: productionTarget.context.databases,
          source: target.source,
        });
        if (!confirmed) throw new ProductionWriteCancelledError();
        // Aliases such as mongoInsertDocument invoke a differently named backend
        // command, so the permit must use the operation consumed by that command.
        const operation = target.operation ?? String(name);
        const requestDigest = await productionWriteRequestDigest(operation, args);
        authorization = await b.authorizeProductionWrite(target.connectionId, productionTarget.database, operation, requestDigest);
      }
    }
    return withProductionWriteAuthorization(authorization, () => (b[name] as (...a: unknown[]) => Promise<unknown>)(...args));
  }) as unknown as Backend[K];
}

const connectionWriteTarget =
  (source: string) =>
  (args: unknown[]): ProductionWriteTarget | undefined => {
    const connectionId = String(args[0] ?? "").trim();
    return connectionId ? { connectionId, source } : undefined;
  };

const databaseWriteTarget =
  (source: string, operation?: string) =>
  (args: unknown[]): ProductionWriteTarget | undefined => {
    const connectionId = String(args[0] ?? "").trim();
    const database = String(args[1] ?? "").trim();
    return connectionId ? { connectionId, database, operation, source } : undefined;
  };

function rawRequestIsMutation(args: unknown[]): boolean {
  const request = args[1] as { method?: unknown } | undefined;
  return !["GET", "HEAD", "OPTIONS"].includes(String(request?.method ?? "").toUpperCase());
}

function mongoAggregateWriteTarget(args: unknown[]): ProductionWriteTarget | undefined {
  const connectionId = String(args[0] ?? "").trim();
  const activeDatabase = String(args[1] ?? "").trim();
  if (!connectionId) return undefined;
  try {
    const pipeline = JSON.parse(String(args[3] ?? "[]"));
    if (!Array.isArray(pipeline)) {
      return { connectionId, database: activeDatabase, source: "Run mutating MongoDB aggregate" };
    }
    for (const stage of pipeline) {
      if (!stage || typeof stage !== "object") continue;
      const record = stage as Record<string, unknown>;
      if (!("$out" in record) && !("$merge" in record)) continue;
      const writeStage = "$out" in record ? record.$out : record.$merge;
      const target = writeStage && typeof writeStage === "object" && "into" in writeStage ? (writeStage as Record<string, unknown>).into : writeStage;
      const targetDatabase = target && typeof target === "object" ? String((target as Record<string, unknown>).db ?? "").trim() : "";
      return {
        connectionId,
        database: targetDatabase || activeDatabase,
        source: "Run mutating MongoDB aggregate",
      };
    }
    return undefined;
  } catch {
    // Invalid or unknown pipelines are classified conservatively; the backend will report syntax details.
    return { connectionId, database: activeDatabase, source: "Run mutating MongoDB aggregate" };
  }
}

function redisCommandWriteTarget(args: unknown[]): ProductionWriteTarget | undefined {
  const connectionId = String(args[0] ?? "").trim();
  const selectedDatabase = String(args[1] ?? "0").trim();
  const command = String(args[2] ?? "").trim();
  if (!connectionId || !redisCommandIsMutation(command)) return undefined;
  const scope = redisCommandDatabaseTargets(command, selectedDatabase);
  return {
    connectionId,
    database: selectedDatabase,
    databaseCandidates: scope.databases,
    allDatabases: scope.allDatabases,
    source: "Execute Redis write command",
  };
}

// ---------------------------------------------------------------------------
// Re-export all functions via lazy forwarding
// ---------------------------------------------------------------------------

// Connection
export const testConnection = forward("testConnection");
export const connectDb = forward("connectDb");
export const connectionFinalProxyPort = forward("connectionFinalProxyPort");
export const disconnectDb = forward("disconnectDb");
export const checkConnectionHealth = forward("checkConnectionHealth");
export const connectionIdentifierQuote = forward("connectionIdentifierQuote");
export const authorizeProductionWrite = forward("authorizeProductionWrite");
export const closeDatabaseConnection = forward("closeDatabaseConnection");
export const refreshConnections = forward("refreshConnections");
export const saveConnections = forward("saveConnections");
export const loadConnections = forward("loadConnections");
export const loadTunnelProfiles = forward("loadTunnelProfiles");
export const saveTunnelProfiles = forward("saveTunnelProfiles");
export const testTunnelProfile = forward("testTunnelProfile");
export const readKeychainPassword = forward("readKeychainPassword");
export const readKeychainPasswords = forward("readKeychainPasswords");
export const decryptConfig = forward("decryptConfig");
export const listPlugins = forward("listPlugins");
export const listJdbcDrivers = forward("listJdbcDrivers");
export const listJdbcMavenBundles = forward("listJdbcMavenBundles");
export const listJdbcLocalBundles = forward("listJdbcLocalBundles");
export const importJdbcDrivers = forward("importJdbcDrivers");
export const installJdbcDriverFromMaven = forward("installJdbcDriverFromMaven");
export const installPrestoSqlJdbcDriver = forward("installPrestoSqlJdbcDriver");
export const deleteJdbcDriver = forward("deleteJdbcDriver");
export const deleteJdbcMavenBundle = forward("deleteJdbcMavenBundle");
export const deleteJdbcLocalBundle = forward("deleteJdbcLocalBundle");
export const jdbcPluginStatus = forward("jdbcPluginStatus");
export const installJdbcPlugin = forward("installJdbcPlugin");
export const installJdbcPluginLocal = forward("installJdbcPluginLocal");
export const uninstallJdbcPlugin = forward("uninstallJdbcPlugin");
export const listInstalledAgentsLocal = forward("listInstalledAgentsLocal");
export async function listInstalledAgents() {
  const backend = await getBackend();
  return backend.listInstalledAgents(useSettingsStore().editorSettings.updateDownloadSource);
}
export const isAgentInstalled = forward("isAgentInstalled");
export const getDriverStoreUsage = forward("getDriverStoreUsage");
export const clearDriverDownloadCache = forward("clearDriverDownloadCache");
export const getDriverRuntimeSummary = forward("getDriverRuntimeSummary");
export const stopDriverRuntime = forward("stopDriverRuntime");
export const restartDriverRuntime = forward("restartDriverRuntime");
export async function installAgent(dbType: string) {
  const backend = await getBackend();
  return backend.installAgent(dbType, useSettingsStore().editorSettings.updateDownloadSource);
}
export async function upgradeAllAgents() {
  const backend = await getBackend();
  return backend.upgradeAllAgents(useSettingsStore().editorSettings.updateDownloadSource);
}
export const checkAgentUpdateBlockers = forward("checkAgentUpdateBlockers");
export const uninstallAgent = forward("uninstallAgent");
export const getAgentJavaRuntimeConfig = forward("getAgentJavaRuntimeConfig");
export const setAgentJavaRuntimeConfig = forward("setAgentJavaRuntimeConfig");
export const invalidateAgentRegistryCache = forward("invalidateAgentRegistryCache");
export const importAgentsFromZip = forward("importAgentsFromZip");
export const importAgentJar = forward("importAgentJar");
export async function reinstallJre(jreKey?: string) {
  const backend = await getBackend();
  return backend.reinstallJre(jreKey, useSettingsStore().editorSettings.updateDownloadSource);
}
export const uninstallJre = forward("uninstallJre");
export const listenAgentInstallProgress = forward("listenAgentInstallProgress");
export const loadSavedSqlLibrary = forward("loadSavedSqlLibrary");
export const loadSavedSqlFile = forward("loadSavedSqlFile");
export const saveSavedSqlFolder = forward("saveSavedSqlFolder");
export const deleteSavedSqlFolder = forward("deleteSavedSqlFolder");
export const saveSavedSqlFile = forward("saveSavedSqlFile");
export const deleteSavedSqlFile = forward("deleteSavedSqlFile");
export const savedSqlStorageDir = forward("savedSqlStorageDir");
export const openSavedSqlStorageDir = forward("openSavedSqlStorageDir");
export const revealPathInFileManager = forward("revealPathInFileManager");
export const isSqliteDatabaseFile = forward("isSqliteDatabaseFile");
export const backupSqliteDatabase = forward("backupSqliteDatabase");
export const syncSavedSqlDirectory = forward("syncSavedSqlDirectory");

// Schema
export const listDatabases = forward("listDatabases");
export const listDorisCatalogs = forward("listDorisCatalogs");
export const listDorisCatalogDatabases = forward("listDorisCatalogDatabases");
export const listSqlServerLinkedServers = forward("listSqlServerLinkedServers");
export const listSqlServerLinkedServerCatalogs = forward("listSqlServerLinkedServerCatalogs");
export const listSqlServerLinkedServerSchemas = forward("listSqlServerLinkedServerSchemas");
export const listSqlServerLinkedServerTables = forward("listSqlServerLinkedServerTables");
export const saveSchemaCache = forward("saveSchemaCache");
export const loadSchemaCache = forward("loadSchemaCache");
export const deleteSchemaCachePrefix = forward("deleteSchemaCachePrefix");
export const listSchemas = forward("listSchemas");
export const listSchemaInfos = forward("listSchemaInfos");
export const listTables = forward("listTables");
export const getTableComment = forward("getTableComment");
export const listObjects = forward("listObjects");
export const listObjectStatistics = forward("listObjectStatistics");
export const listCompletionObjects = forward("listCompletionObjects");
export const completionAssistantSearch = forward("completionAssistantSearch");
export const getObjectSource = forward("getObjectSource");
export const getColumns = forward("getColumns");
export const listDataTypes = forward("listDataTypes");
export const listIndexes = forward("listIndexes");
export const listForeignKeys = forward("listForeignKeys");
export const listTriggers = forward("listTriggers");
export const getTableDdl = forward("getTableDdl");
export const listFunctions = forward("listFunctions");
export const listSequences = forward("listSequences");
export const listRules = forward("listRules");
export const listOwners = forward("listOwners");
export const listExtensions = forward("listExtensions");
export const listAvailableExtensions = forward("listAvailableExtensions");
export const prepareSchemaDiff = forward("prepareSchemaDiff");
export const generateSchemaSyncSql = forward("generateSchemaSyncSql");

// Query
type ExecuteQueryOptions = Parameters<Backend["executeQuery"]>[5];
type ExecuteMultiOptions = Parameters<Backend["executeMulti"]>[5];

export async function executeQuery(connectionId: string, database: string, sql: string, schema?: string, executionId?: string, options?: ExecuteQueryOptions, productionWriteAuthorization?: ProductionWriteAuthorization): Promise<Awaited<ReturnType<Backend["executeQuery"]>>> {
  const backend = await getBackend();
  return withProductionWriteAuthorization(productionWriteAuthorization, () => backend.executeQuery(connectionId, database, sql, schema, executionId, options));
}

export async function executeMulti(connectionId: string, database: string, sql: string, schema?: string, executionId?: string, options?: ExecuteMultiOptions, productionWriteAuthorization?: ProductionWriteAuthorization): Promise<Awaited<ReturnType<Backend["executeMulti"]>>> {
  const backend = await getBackend();
  return withProductionWriteAuthorization(productionWriteAuthorization, () => backend.executeMulti(connectionId, database, sql, schema, executionId, options));
}
export const executeBatch = forward("executeBatch");
export const executeScript = forward("executeScript");
export const executeInTransaction = forward("executeInTransaction");
export const beginManualTransaction = forward("beginManualTransaction");
export const executeInManualTransaction = forward("executeInManualTransaction");
export const commitManualTransaction = forward("commitManualTransaction");
export const rollbackManualTransaction = forward("rollbackManualTransaction");
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
export const buildUpdateDatabasePropertiesSql = forward("buildUpdateDatabasePropertiesSql");
export const buildDropSchemaSql = forward("buildDropSchemaSql");
export const buildDuplicateTableStructureSql = forward("buildDuplicateTableStructureSql");
export const buildCopyTableDataSql = forward("buildCopyTableDataSql");
export const buildExecutableObjectSourceStatements = forward("buildExecutableObjectSourceStatements");
export const buildExecutableObjectSourceSql = forward("buildExecutableObjectSourceSql");
export const buildEditableObjectSource = forward("buildEditableObjectSource");
export const buildRoutineRenameObjectSourceStatements = forward("buildRoutineRenameObjectSourceStatements");
export const buildViewDdlSql = forward("buildViewDdlSql");
export const buildTableStructureChangeSql = forward("buildTableStructureChangeSql");
export const previewSqliteTableStructureChange = forward("previewSqliteTableStructureChange");
export const applySqliteTableStructureChange = forward("applySqliteTableStructureChange");
export const buildCreateTableSql = forward("buildCreateTableSql");
export const buildSingleColumnAlterSql = forward("buildSingleColumnAlterSql");
export const analyzeEditableQueryEditability = forward("analyzeEditableQueryEditability");
export const prepareDataGridSave = forward("prepareDataGridSave");
export const buildDataGridCopyUpdateStatements = forward("buildDataGridCopyUpdateStatements");
export const buildDataGridCopyInsertStatement = forward("buildDataGridCopyInsertStatement");
export const buildDataGridContextFilterCondition = forward("buildDataGridContextFilterCondition");
export const buildDataGridColumnValueFilterCondition = forward("buildDataGridColumnValueFilterCondition");
export const buildDataGridColumnValuesFilterCondition = forward("buildDataGridColumnValuesFilterCondition");
export const buildDataGridColumnDistinctValuesSql = forward("buildDataGridColumnDistinctValuesSql");
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
export const saveAiProviderConfig = forward("saveAiProviderConfig");
export const loadAiProviderConfigs = forward("loadAiProviderConfigs");
export const loadDesktopSettings = forward("loadDesktopSettings");
export const saveDesktopSettings = forward("saveDesktopSettings");
export const completeAppClose = forward("completeAppClose");
export const requestAppClose = forward("requestAppClose");
export const setDriverStoreDir = forward("setDriverStoreDir");
export const setPluginStoreDir = forward("setPluginStoreDir");
export const setAgentStoreDir = forward("setAgentStoreDir");
export const getDriverStorePath = forward("getDriverStorePath");
export const loadPinnedTreeNodeIds = forward("loadPinnedTreeNodeIds");
export const savePinnedTreeNodeIds = forward("savePinnedTreeNodeIds");
export const loadEditorSettings = forward("loadEditorSettings");
export const saveEditorSettings = forward("saveEditorSettings");
export const loadOpenTabsState = forward("loadOpenTabsState");
export const saveOpenTabsState = forward("saveOpenTabsState");
export const loadSavedSqlEditorPositions = forward("loadSavedSqlEditorPositions");
export const saveSavedSqlEditorPositions = forward("saveSavedSqlEditorPositions");
export const webdavSyncTest = forward("webdavSyncTest");
export const webdavPasswordStatus = forward("webdavPasswordStatus");
export const saveWebdavSavedPassword = forward("saveWebdavSavedPassword");
export const forgetWebdavSavedPassword = forward("forgetWebdavSavedPassword");
export const webdavSyncSecretsStatus = forward("webdavSyncSecretsStatus");
export const saveWebdavSyncSecretsPreference = forward("saveWebdavSyncSecretsPreference");
export const forgetWebdavSyncSecretsPassphrase = forward("forgetWebdavSyncSecretsPassphrase");
export const webdavSyncUpload = forward("webdavSyncUpload");
export const webdavSyncDownload = forward("webdavSyncDownload");
export const snippetSyncTest = forward("snippetSyncTest");
export const snippetTokenStatus = forward("snippetTokenStatus");
export const saveSnippetSavedToken = forward("saveSnippetSavedToken");
export const forgetSnippetSavedToken = forward("forgetSnippetSavedToken");
export const snippetSyncUpload = forward("snippetSyncUpload");
export const snippetSyncDownload = forward("snippetSyncDownload");
export const saveAiConversation = forward("saveAiConversation");
export const loadAiConversations = forward("loadAiConversations");
export const deleteAiConversation = forward("deleteAiConversation");

// System
export const listSystemFonts = forward("listSystemFonts");
export const listSshConfigHosts = forward("listSshConfigHosts");

// SQL File Execution
export const previewSqlFile = forward("previewSqlFile");
export const executeSqlFile = forward("executeSqlFile");
export const cancelSqlFileExecution = forward("cancelSqlFileExecution");
export const listenSqlFileProgress = forward("listenSqlFileProgress");
export const pendingOpenSqlFiles = forward("pendingOpenSqlFiles");
export const pendingOpenDbFiles = forward("pendingOpenDbFiles");
export const pendingOpenConnectionLinks = forward("pendingOpenConnectionLinks");
export const readExternalSqlFile = forward("readExternalSqlFile");
export const writeExternalSqlFile = forward("writeExternalSqlFile");
export const listSqlFilesInFolder = forward("listSqlFilesInFolder");

// Nacos
export const nacosTestConnection = forward("nacosTestConnection");
export const nacosListNamespaces = forward("nacosListNamespaces");
export const nacosCreateNamespace = forwardProductionWrite("nacosCreateNamespace", connectionWriteTarget("Create Nacos namespace"));
export const nacosUpdateNamespace = forwardProductionWrite("nacosUpdateNamespace", connectionWriteTarget("Update Nacos namespace"));
export const nacosListConfigs = forward("nacosListConfigs");
export const nacosGetConfig = forward("nacosGetConfig");
export const nacosPublishConfig = forwardProductionWrite("nacosPublishConfig", connectionWriteTarget("Publish Nacos config"));
export const nacosDeleteConfig = forwardProductionWrite("nacosDeleteConfig", connectionWriteTarget("Delete Nacos config"));
export const nacosListConfigHistory = forward("nacosListConfigHistory");
export const nacosGetConfigHistory = forward("nacosGetConfigHistory");
export const nacosRollbackConfig = forwardProductionWrite("nacosRollbackConfig", connectionWriteTarget("Rollback Nacos config"));
export const nacosListServices = forward("nacosListServices");
export const nacosListInstances = forward("nacosListInstances");
export const nacosUpdateInstance = forwardProductionWrite("nacosUpdateInstance", connectionWriteTarget("Update Nacos instance"));
export const nacosRawRequest = forwardProductionWrite("nacosRawRequest", connectionWriteTarget("Run Nacos raw write request"), rawRequestIsMutation);

// Data Transfer
export const startTransfer = forward("startTransfer");
export const cancelTransfer = forward("cancelTransfer");
export const previewTransferOwnership = forward("previewTransferOwnership");
export const sortTablesByFkDependency = forward("sortTablesByFkDependency");

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
export const exportQueryResultsXlsx = forward("exportQueryResultsXlsx");
export const exportQueryResultJson = forward("exportQueryResultJson");
export const exportQueryResultMarkdown = forward("exportQueryResultMarkdown");
export const startTableExport = forward("startTableExport");
export const cancelTableExport = forward("cancelTableExport");
export const startQueryResultExport = forward("startQueryResultExport");
export const cancelQueryResultExport = forward("cancelQueryResultExport");

// Redis
export const redisListDatabases = forward("redisListDatabases");
export const redisScanKeys = forward("redisScanKeys");
export const redisScanKeysBatch = forward("redisScanKeysBatch");
export const redisScanValues = forward("redisScanValues");
export const redisGetValue = forward("redisGetValue");
export const redisSetString = forwardProductionWrite("redisSetString", databaseWriteTarget("Redis SET"));
export const redisDeleteKey = forwardProductionWrite("redisDeleteKey", databaseWriteTarget("Delete Redis key"));
export const redisHashSet = forwardProductionWrite("redisHashSet", databaseWriteTarget("Redis HSET"));
export const redisHashDel = forwardProductionWrite("redisHashDel", databaseWriteTarget("Redis HDEL"));
export const redisListPush = forwardProductionWrite("redisListPush", databaseWriteTarget("Redis LPUSH"));
export const redisListSet = forwardProductionWrite("redisListSet", databaseWriteTarget("Redis LSET"));
export const redisListRemove = forwardProductionWrite("redisListRemove", databaseWriteTarget("Redis LREM"));
export const redisSetAdd = forwardProductionWrite("redisSetAdd", databaseWriteTarget("Redis SADD"));
export const redisSetRemove = forwardProductionWrite("redisSetRemove", databaseWriteTarget("Redis SREM"));
export const redisZadd = forwardProductionWrite("redisZadd", databaseWriteTarget("Redis ZADD"));
export const redisZrem = forwardProductionWrite("redisZrem", databaseWriteTarget("Redis ZREM"));
export const redisStreamAdd = forwardProductionWrite("redisStreamAdd", databaseWriteTarget("Redis XADD"));
export const redisJsonSet = forwardProductionWrite("redisJsonSet", databaseWriteTarget("Redis JSON.SET"));
export const redisCheckJsonModule = forward("redisCheckJsonModule");
export const redisSetTtl = forwardProductionWrite("redisSetTtl", databaseWriteTarget("Change Redis TTL"));
export const redisDeleteKeys = forwardProductionWrite("redisDeleteKeys", databaseWriteTarget("Delete Redis keys"));
export const redisFlushDb = forwardProductionWrite("redisFlushDb", databaseWriteTarget("Redis FLUSHDB"));
export const redisExecuteCommand = forwardProductionWrite("redisExecuteCommand", redisCommandWriteTarget);
export const redisLoadMore = forward("redisLoadMore");
export const redisPubSubPublish = forwardProductionWrite("redisPubSubPublish", databaseWriteTarget("Publish Redis message"));
export const redisPubSubConnect = forward("redisPubSubConnect");
export const redisSlowlogGet = forward("redisSlowlogGet");
export const redisClusterMasterNodes = forward("redisClusterMasterNodes");

// etcd
export const etcdListPrefix = forward("etcdListPrefix");
export const etcdGet = forward("etcdGet");
export const etcdPut = forwardProductionWrite("etcdPut", connectionWriteTarget("Put Etcd key"));
export const etcdDelete = forwardProductionWrite("etcdDelete", connectionWriteTarget("Delete Etcd key"));

// ZooKeeper
export const zookeeperListPrefix = forward("zookeeperListPrefix");
export const zookeeperGet = forward("zookeeperGet");
export const zookeeperPut = forwardProductionWrite("zookeeperPut", connectionWriteTarget("Put ZooKeeper node"));
export const zookeeperDelete = forwardProductionWrite("zookeeperDelete", connectionWriteTarget("Delete ZooKeeper node"));

// Message Queue
export const mqTestConnection = forward("mqTestConnection");
export const mqListTenants = forward("mqListTenants");
export const mqGetTenant = forward("mqGetTenant");
export const mqCreateTenant = forwardProductionWrite("mqCreateTenant", connectionWriteTarget("Create MQ tenant"));
export const mqUpdateTenant = forwardProductionWrite("mqUpdateTenant", connectionWriteTarget("Update MQ tenant"));
export const mqDeleteTenant = forwardProductionWrite("mqDeleteTenant", connectionWriteTarget("Delete MQ tenant"));
export const mqListNamespaces = forward("mqListNamespaces");
export const mqCreateNamespace = forwardProductionWrite("mqCreateNamespace", connectionWriteTarget("Create MQ namespace"));
export const mqDeleteNamespace = forwardProductionWrite("mqDeleteNamespace", connectionWriteTarget("Delete MQ namespace"));
export const mqGetNamespacePolicies = forward("mqGetNamespacePolicies");
export const mqListTopics = forward("mqListTopics");
export const mqCreateTopic = forwardProductionWrite("mqCreateTopic", connectionWriteTarget("Create MQ topic"));
export const mqDeleteTopic = forwardProductionWrite("mqDeleteTopic", connectionWriteTarget("Delete MQ topic"));
export const mqUpdatePartitions = forwardProductionWrite("mqUpdatePartitions", connectionWriteTarget("Update MQ partitions"));
export const mqGetTopicStats = forward("mqGetTopicStats");
export const mqGetTopicInternalStats = forward("mqGetTopicInternalStats");
export const mqListSubscriptions = forward("mqListSubscriptions");
export const mqCreateSubscription = forwardProductionWrite("mqCreateSubscription", connectionWriteTarget("Create MQ subscription"));
export const mqDeleteSubscription = forwardProductionWrite("mqDeleteSubscription", connectionWriteTarget("Delete MQ subscription"));
export const mqSkipMessages = forwardProductionWrite("mqSkipMessages", connectionWriteTarget("Skip MQ messages"));
export const mqResetCursor = forwardProductionWrite("mqResetCursor", connectionWriteTarget("Reset MQ cursor"));
export const mqClearBacklog = forwardProductionWrite("mqClearBacklog", connectionWriteTarget("Clear MQ backlog"));
export const mqPeekMessages = forward("mqPeekMessages");
export const mqExpireMessages = forwardProductionWrite("mqExpireMessages", connectionWriteTarget("Expire MQ messages"));
export const mqListProducers = forward("mqListProducers");
export const mqListConsumers = forward("mqListConsumers");
export const mqUnloadTopic = forwardProductionWrite("mqUnloadTopic", connectionWriteTarget("Unload MQ topic"));
export const mqSetPublishRate = forwardProductionWrite("mqSetPublishRate", connectionWriteTarget("Set MQ publish rate"));
export const mqSetDispatchRate = forwardProductionWrite("mqSetDispatchRate", connectionWriteTarget("Set MQ dispatch rate"));
export const mqSetSubscribeRate = forwardProductionWrite("mqSetSubscribeRate", connectionWriteTarget("Set MQ subscribe rate"));
export const mqSetBacklogQuota = forwardProductionWrite("mqSetBacklogQuota", connectionWriteTarget("Set MQ backlog quota"));
export const mqSetRetention = forwardProductionWrite("mqSetRetention", connectionWriteTarget("Set MQ retention"));
export const mqGetEffectivePolicies = forward("mqGetEffectivePolicies");
export const mqGrantPermission = forwardProductionWrite("mqGrantPermission", connectionWriteTarget("Grant MQ permission"));
export const mqRevokePermission = forwardProductionWrite("mqRevokePermission", connectionWriteTarget("Revoke MQ permission"));
export const mqListPermissions = forward("mqListPermissions");
export const mqIssueToken = forwardProductionWrite("mqIssueToken", connectionWriteTarget("Issue MQ token"));
export const mqListTokenRecords = forward("mqListTokenRecords");
export const mqGetBacklog = forward("mqGetBacklog");
export const mqGetClusterInfo = forward("mqGetClusterInfo");
export const mqRawRequest = forwardProductionWrite("mqRawRequest", connectionWriteTarget("Run MQ raw write request"), rawRequestIsMutation);
export const mqSendMessage = forwardProductionWrite("mqSendMessage", connectionWriteTarget("Send MQ message"));

// MongoDB
export const documentListDatabases = forward("documentListDatabases");
export const mongoListDatabases = forward("mongoListDatabases");
export const documentListCollections = forward("documentListCollections");
export const mongoListCollections = forward("mongoListCollections");
export const documentListGridFsBuckets = forward("documentListGridFsBuckets");
export const documentCreateGridFsBucket = forwardProductionWrite("documentCreateGridFsBucket", databaseWriteTarget("Create MongoDB GridFS bucket"));
export const documentDeleteGridFsBucket = forwardProductionWrite("documentDeleteGridFsBucket", databaseWriteTarget("Delete MongoDB GridFS bucket"));
export const documentListGridFsFiles = forward("documentListGridFsFiles");
export const documentDownloadGridFsFile = forward("documentDownloadGridFsFile");
export const documentUploadGridFsFile = forwardProductionWrite("documentUploadGridFsFile", databaseWriteTarget("Upload MongoDB GridFS file"));
export const documentDeleteGridFsFile = forwardProductionWrite("documentDeleteGridFsFile", databaseWriteTarget("Delete MongoDB GridFS file"));
export const vectorGetCollectionDetail = forward("vectorGetCollectionDetail");
export const mongoCreateDatabase = forwardProductionWrite("mongoCreateDatabase", databaseWriteTarget("Create MongoDB database"));
export const mongoDropDatabase = forwardProductionWrite("mongoDropDatabase", databaseWriteTarget("Drop MongoDB database"));
export const mongoDropCollection = forwardProductionWrite("mongoDropCollection", databaseWriteTarget("Drop MongoDB collection"));
export const documentFindDocuments = forward("documentFindDocuments");
export const mongoFindDocuments = forward("mongoFindDocuments");
export const mongoCountDocuments = forward("mongoCountDocuments");
export const mongoServerVersion = forward("mongoServerVersion");
export const mongoAggregateDocuments = forwardProductionWrite("mongoAggregateDocuments", mongoAggregateWriteTarget);
export const mongoCollectionStats = forward("mongoCollectionStats");
export const mongoCreateIndex = forwardProductionWrite("mongoCreateIndex", databaseWriteTarget("Create MongoDB index"));
export const mongoDropIndexes = forwardProductionWrite("mongoDropIndexes", databaseWriteTarget("Drop MongoDB indexes"));
export const documentInsertDocument = forwardProductionWrite("documentInsertDocument", databaseWriteTarget("Insert document"));
export const mongoInsertDocument = forwardProductionWrite("mongoInsertDocument", databaseWriteTarget("Insert MongoDB document", "documentInsertDocument"));
export const mongoInsertDocuments = forwardProductionWrite("mongoInsertDocuments", databaseWriteTarget("Insert MongoDB documents"));
export const documentUpdateDocument = forwardProductionWrite("documentUpdateDocument", databaseWriteTarget("Update document"));
export const mongoUpdateDocument = forwardProductionWrite("mongoUpdateDocument", databaseWriteTarget("Update MongoDB document", "documentUpdateDocument"));
export const mongoUpdateDocuments = forwardProductionWrite("mongoUpdateDocuments", databaseWriteTarget("Update MongoDB documents"));
export const documentDeleteDocument = forwardProductionWrite("documentDeleteDocument", databaseWriteTarget("Delete document"));
export const mongoDeleteDocument = forwardProductionWrite("mongoDeleteDocument", databaseWriteTarget("Delete MongoDB document", "documentDeleteDocument"));
export const mongoDeleteDocuments = forwardProductionWrite("mongoDeleteDocuments", databaseWriteTarget("Delete MongoDB documents"));

// Elasticsearch
export const elasticsearchListIndices = forward("elasticsearchListIndices");
export const vectorListCollections = forward("vectorListCollections");

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
export const downloadAndInstallUpdate = forward("downloadAndInstallUpdate");
export const getAppVersion = forward("getAppVersion");
export const getAppSupportInfo = forward("getAppSupportInfo");

// Layout
export const saveSidebarLayout = forward("saveSidebarLayout");
export const loadSidebarLayout = forward("loadSidebarLayout");

// ---------------------------------------------------------------------------
// Re-export all types from tauri.ts (shared between both backends)
// ---------------------------------------------------------------------------

export type {
  AppSupportInfo,
  AiMessage,
  AiCompletionRequest,
  AiTaskContract,
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
  SnippetProvider,
  SnippetSyncConfig,
  SnippetSyncSummary,
  SnippetDownloadResult,
  SnippetTokenStatus,
  McpServerStatus,
  UpdateInfo,
  RedisBlob,
  RedisCollectionPage,
  RedisDatabaseInfo,
  RedisHashItem,
  RedisKeyInfo,
  RedisListItem,
  RedisSetItem,
  RedisStreamEntry,
  RedisStreamField,
  RedisValue,
  RedisValueData,
  RedisZsetItem,
  RedisScanResult,
  RedisCommandSafety,
  RedisCommandResult,
  RedisSlowlogEntry,
  RedisNodeEndpoint,
  KvValueEncoding,
  KvValue,
  KvKeyMetadata,
  KvKeySummary,
  KvListPrefixResponse,
  KvListPrefixOptions,
  KvGetResponse,
  KvWriteMode,
  KvCreateMode,
  KvPutOptions,
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
  TransferTableNameCase,
  TransferOwnershipPolicy,
  TransferOwnershipPreview,
  TableImportMode,
  TableImportStatus,
  TableImportSourceFormat,
  TableImportJsonShape,
  TableImportColumnMapping,
  TableImportParseOptions,
  TableImportPreviewRequest,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
  DatabaseExportRequest,
  ExportProgress,
  TableExportProgress,
  TableExportStatus,
  TableExportRequest,
  QueryResultExportRequest,
  AgentEvent,
  SqlFileEntry,
} from "@/lib/backend/tauri";
