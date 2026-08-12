import type {
  ConnectionConfig,
  ConnectionTestResult,
  DatabaseConnectionInfo,
  DatabaseInfo,
  DatabaseStorageInfo,
  SqlServerCompletionContext,
  SchemaInfo,
  LinkedServerInfo,
  CatalogInfo,
  TableInfo,
  TableNameFilter,
  ObjectInfo,
  CompletionAssistantRequest,
  CompletionAssistantResponse,
  ObjectStatistics,
  CustomTypeDetails,
  ObjectSource,
  ObjectSourceKind,
  ColumnInfo,
  SqlServerColumnMetadata,
  IndexInfo,
  ForeignKeyInfo,
  TriggerInfo,
  ConstraintInfo,
  PartitionInfo,
  SubpartitionInfo,
  ExtensionInfo,
  FunctionInfo,
  SequenceInfo,
  RuleInfo,
  OwnerInfo,
  QueryResult,
  SqlReferenceAnalysis,
  DatabaseType,
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcLocalBundleInfo,
  JdbcMavenBundleInfo,
  JdbcPluginStatus,
  SidebarLayout,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
  SshConfigHostEntry,
  TunnelProfile,
} from "@/types/database";
import { normalizeRustMongoCommand, type MongoCommand } from "@/lib/mongo/mongoShellCommand";
import { BackendErrorException, type BackendError } from "@/lib/backend/errorUtils";
import type { CollectionInfo } from "@/types/database";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff, FunctionDiff, SequenceDiff, RuleDiff, OwnerDiff } from "@/lib/schema/schemaDiff";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { AiConfig, AiTestConnectionResult } from "@/stores/settingsStore";
import type { AiChatSelectionState, AiEffortCapability } from "@/types/ai";
import type {
  AgentDriverInfo,
  AiCompletionRequest,
  AiStreamChunk,
  AiConversation,
  AiModelInfo,
  DriverStoreUsage,
  DriverRuntimeSummary,
  UpgradeAllAgentDriversResult,
  AgentUpdateBlocker,
  DesktopSettings,
  McpGlobalPolicy,
  SavedSqlSyncRequest,
  DriverInstallProgress,
  JavaRuntimeConfig,
  UpdateInfo,
  UpdateDownloadSource,
  RedisCollectionPage,
  RedisDatabaseInfo,
  RedisStreamConsumer,
  RedisStreamGroup,
  RedisStreamPage,
  RedisStreamPendingPage,
  RedisValue,
  RedisScanResult,
  RedisCommandResult,
  RedisSlowlogEntry,
  RedisNodeEndpoint,
  KvInt64,
  KvValue,
  KvListPrefixResponse,
  KvListPrefixOptions,
  KvGetResponse,
  KvGetOptions,
  KvPutOptions,
  KvPutResponse,
  KvDeleteOptions,
  KvDeleteResponse,
  KvHistoryResponse,
  KvStatusResponse,
  EtcdDefragResponse,
  EtcdWatchStartRequest,
  EtcdWatchStartResponse,
  EtcdWatchPollResponse,
  EtcdLeaseListResponse,
  DocumentQueryResult,
  MongoDocumentResult,
  MongoCollectionStatsResult,
  MongoCloneCollectionResult,
  MongoDropIndexesResult,
  MongoGridFsBucketInfo,
  HistoryEntry,
  HistorySearchRequest,
  HistorySearchResult,
  HistoryConnectionOption,
  SqlFileRequest,
  SqlFilePreview,
  SqlFileProgress,
  TransferRequest,
  TransferProgress,
  TransferOwnershipPreview,
  TableImportPreviewRequest,
  TableImportPreview,
  TableImportRequest,
  TableImportSummary,
  TableImportProgress,
  DatabaseBackupSnapshot,
  DatabaseExportRequest,
  ExportProgress,
  TableExportRequest,
  TableExportProgress,
  QueryResultExportRequest,
  TableCsvExportOptions,
  XlsxCellValue,
  QueryPaginationExecutionPlanOptions,
  QueryPaginationExecutionPlan,
  SortedQuerySqlOptions,
  QuerySqlBuildResult,
  BuildExplainSqlOptions,
  ExplainSqlBuildResult,
  DroppedFilePreviewSqlOptions,
  MongoGridFsFileInfo,
  AppSupportInfo,
  PromptTemplate,
  SshPromptResolution,
} from "@/lib/backend/tauri";
import type { QueryEditability } from "@/lib/sql/sqlAnalysis";
import { isTerminalTransferProgress } from "@/lib/backend/transferProgress";
import type {
  DataGridColumnDistinctValuesSqlOptions,
  DataGridColumnValueFilterConditionOptions,
  DataGridColumnValuesFilterConditionOptions,
  DataGridContextFilterConditionOptions,
  DataGridCountSqlOptions,
  DataGridCopyInsertStatementOptions,
  DataGridCopyUpdateStatementOptions,
  DataGridSaveStatementOptions,
  HiveTablePropertiesSqlOptions,
} from "@/lib/dataGrid/dataGridSql";
import type { DataGridExtractRequest, DataGridExtractResult } from "@/lib/dataGrid/dataGridCopyExtractor";
import type { BuildTableStructureChangeSqlOptions, BuildSingleColumnAlterSqlOptions, SqliteTableStructureChangePreview, TableStructureChangeSql } from "@/lib/table/tableStructureEditorSql";
import type { BuildTableSelectSqlOptions } from "@/lib/table/tableSelectSql";
import type { DatabaseSearchSql, DatabaseSearchSqlOptions, SearchResultWhereOptions } from "@/lib/database/databaseSearch";
import type { BuildEditableObjectSourceSqlInput, BuildRoutineRenameObjectSourceInput } from "@/lib/table/objectSourceEditor";
import type { BuildViewDdlInput } from "@/lib/table/viewDdl";
import type { BuildRenameObjectSqlOptions } from "@/lib/table/objectRenameSql";
import type { CreateDatabaseSqlOptions } from "@/lib/database/createDatabaseSql";
import type { DatabaseNameSqlOptions, DatabasePropertyEditSqlOptions, DropTableChildObjectSqlOptions, DropObjectSqlOptions, DuplicateTableStructureSqlOptions, CopyTableDataSqlOptions, SchemaNameSqlOptions, TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import type { BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions } from "@/lib/export/databaseExport";
import { loadBrowserAppState, saveBrowserAppState } from "@/lib/backend/browserAppStateStorage";
import type { DataCompareFromTablesOptions, DataCompareFromTablesPreparation, DataCompareSyncPlan, DataCompareSyncPlanOptions, DataComparePreparation, DataComparePreparationOptions } from "@/lib/dataGrid/dataCompare";
import { apiUrl, apiWebSocketUrl } from "@/lib/common/webPath";
import type { DataGridSavePreparation } from "@/lib/backend/tauri";
import type {
  NacosBatchPreview,
  NacosBatchReport,
  NacosConfigSelector,
  NacosConfigTransferRequest,
  NacosConflictPolicy,
  NacosContentSearchRequest,
  NacosContentSearchResult,
  NacosConfigHistoryKey,
  NacosConfigHistoryList,
  NacosConfigHistoryQuery,
  NacosConfigItem,
  NacosConfigKey,
  NacosConfigList,
  NacosConfigQuery,
  NacosConfigRollbackRequest,
  NacosConfigUpsert,
  NacosConnectionInfo,
  NacosRNacosConsoleCaptcha,
  NacosInstanceInfo,
  NacosInstanceRef,
  NacosInstanceRegistration,
  NacosInstanceQuery,
  NacosInstanceUpdateRequest,
  NacosDashboardQuery,
  NacosDashboardSnapshot,
  NacosNamespaceCreate,
  NacosNamespaceInfo,
  NacosNamespaceUpdate,
  NacosRawRequest,
  NacosRawResponse,
  NacosServiceList,
  NacosServiceDetail,
  NacosServiceQuery,
  NacosServiceUpsert,
  NacosSearchProgress,
} from "@/types/nacos";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";
import type { AnnotationFile, SchemaSnapshot } from "@/docs/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DESKTOP_SETTINGS_STORAGE_KEY = "dbx-desktop-settings";
const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  show_tray_icon: true,
  icon_theme: "default",
  quit_on_close: false,
  close_action_prompted: false,
  debug_logging_enabled: false,
  duckdb_worker_process_isolation: false,
  duckdb_worker_max_processes: 4,
  saved_sql_sync_dir: null,
  driver_store_dir: null,
  plugin_store_dir: null,
  agent_store_dir: null,
  sidebar_table_page_size: 1000,
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url));
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function backendResponseError(response: Response): Promise<BackendErrorException> {
  const text = await response.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Preserve legacy plain-text responses at the same compatibility boundary.
  }
  return new BackendErrorException(payload);
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
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

export async function testConnectionWithInfo(config: ConnectionConfig): Promise<ConnectionTestResult> {
  const response = await fetch(apiUrl("/api/connection/test-info"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (response.status === 404) {
    return normalizeConnectionTestResult(await testConnection(config), config);
  }
  if (!response.ok) throw await backendResponseError(response);
  return normalizeConnectionTestResult(await response.json(), config);
}

export async function connectDb(config: ConnectionConfig, clientAttempt?: number): Promise<string> {
  return post("/api/connection/connect", { config, clientAttempt });
}

export async function connectionDatabaseInfo(connectionId: string, database?: string): Promise<DatabaseConnectionInfo | undefined> {
  const info = await post<DatabaseConnectionInfo | null>("/api/connection/database-info", { connectionId, database });
  return info ?? undefined;
}

export async function saveConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo): Promise<void> {
  return post("/api/connection/database-info/save", {
    connectionId,
    databaseInfo,
  });
}

export async function connectionFinalProxyPort(config: ConnectionConfig): Promise<number> {
  return post("/api/connection/final-proxy-port", { config });
}

export async function disconnectDb(connectionId: string, clientAttempt?: number): Promise<void> {
  return post("/api/connection/disconnect", { connectionId, clientAttempt });
}

export async function checkConnectionHealth(connectionId: string): Promise<void> {
  return post("/api/connection/check-health", { connectionId });
}

export async function connectionIdentifierQuote(connectionId: string, database?: string): Promise<string | undefined> {
  const quote = await post<string | null>("/api/connection/identifier-quote", {
    connectionId,
    database,
  });
  return quote ?? undefined;
}

export async function closeDatabaseConnection(connectionId: string, database: string): Promise<boolean> {
  return post("/api/connection/close-database", { connectionId, database });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return post("/api/connection/save", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return get("/api/connection/list");
}

export async function loadTunnelProfiles(): Promise<TunnelProfile[]> {
  return get("/api/tunnel-profiles/list");
}

export async function saveTunnelProfiles(profiles: TunnelProfile[]): Promise<void> {
  return post("/api/tunnel-profiles/save", { profiles });
}

export async function testTunnelProfile(profile: TunnelProfile): Promise<string> {
  return post("/api/tunnel-profiles/test", profile);
}

export async function resolveSshPrompt(resolution: SshPromptResolution): Promise<void> {
  await post("/api/ssh/prompts/resolve", resolution);
}

export async function readKeychainPassword(_service: string): Promise<string> {
  return ""; // Not available in web backend
}

export async function readKeychainPasswords(services: string[]): Promise<[string, string][]> {
  return services.map((s) => [s, ""]); // Not available in web backend
}

export async function decryptConfig(payload: unknown, passphrase: string): Promise<string> {
  return post("/api/app-settings/config/decrypt", { payload, passphrase });
}

export async function listSystemFonts(): Promise<string[]> {
  return get("/api/system/fonts");
}

export async function listSshConfigHosts(): Promise<SshConfigHostEntry[]> {
  return get("/api/ssh/config-hosts");
}

export async function listPlugins(): Promise<InstalledPlugin[]> {
  return get("/api/plugins");
}

export async function listJdbcDrivers(): Promise<JdbcDriverInfo[]> {
  return get("/api/jdbc/drivers");
}

export async function listJdbcMavenBundles(): Promise<JdbcMavenBundleInfo[]> {
  return get("/api/jdbc/drivers/maven");
}

export async function listJdbcLocalBundles(): Promise<JdbcLocalBundleInfo[]> {
  return get("/api/jdbc/drivers/local");
}

export async function importJdbcDrivers(pathsOrFiles: (string | File)[]): Promise<JdbcDriverInfo[]> {
  const formData = new FormData();
  for (const item of pathsOrFiles) {
    if (item instanceof File) {
      formData.append("files", item, item.name);
    } else {
      const fileName = item.split("/").pop() || "driver.jar";
      const blob = await (await fetch(item)).blob();
      formData.append("files", blob, fileName);
    }
  }
  const res = await fetch(apiUrl("/api/jdbc/drivers"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function installJdbcDriverFromMaven(coordinate: string, repositories: string[] = []): Promise<JdbcDriverInfo[]> {
  return post("/api/jdbc/drivers/maven", { coordinate, repositories });
}

export async function installPrestoSqlJdbcDriver(): Promise<JdbcDriverInfo[]> {
  return post("/api/jdbc/drivers/prestosql", {});
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  const fileName = path.split("/").pop() || path;
  return del(`/api/jdbc/drivers/${encodeURIComponent(fileName)}`);
}

export async function deleteJdbcMavenBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return del(`/api/jdbc/drivers/maven/${encodeURIComponent(bundleId)}`);
}

export async function deleteJdbcLocalBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return del(`/api/jdbc/drivers/local/${encodeURIComponent(bundleId)}`);
}

export async function jdbcPluginStatus(): Promise<JdbcPluginStatus> {
  return get("/api/jdbc/plugin/status");
}

export async function installJdbcPlugin(): Promise<JdbcPluginStatus> {
  return post("/api/jdbc/plugin/install", {});
}

export async function installJdbcPluginLocal(pathOrFile: string | File): Promise<JdbcPluginStatus> {
  let blob: Blob;
  let fileName: string;
  if (pathOrFile instanceof File) {
    blob = pathOrFile;
    fileName = pathOrFile.name;
  } else {
    fileName = pathOrFile.split("/").pop() || "plugin.zip";
    blob = await (await fetch(pathOrFile)).blob();
  }
  const formData = new FormData();
  formData.append("file", blob, fileName);
  const uploadRes = await fetch(apiUrl("/api/jdbc/plugin/install-local"), {
    method: "POST",
    body: formData,
  });
  if (!uploadRes.ok) throw await backendResponseError(uploadRes);
  return uploadRes.json();
}

export async function uninstallJdbcPlugin(): Promise<JdbcPluginStatus> {
  return post("/api/jdbc/plugin/uninstall", {});
}

export async function listInstalledAgentsLocal(): Promise<AgentDriverInfo[]> {
  return get("/api/agents/installed-local");
}

export async function listInstalledAgents(_source?: UpdateDownloadSource): Promise<AgentDriverInfo[]> {
  return get("/api/agents/installed");
}

export async function isAgentInstalled(dbType: string): Promise<boolean> {
  return get(`/api/agents/installed/${encodeURIComponent(dbType)}`);
}

export async function getDriverStoreUsage(): Promise<DriverStoreUsage> {
  return get("/api/agents/storage-usage");
}

export async function clearDriverDownloadCache(): Promise<void> {
  await del("/api/agents/download-cache");
}

export async function getDriverRuntimeSummary(): Promise<DriverRuntimeSummary> {
  return get("/api/agents/runtime");
}

export async function stopDriverRuntime(runtimeId: string): Promise<void> {
  await post("/api/agents/runtime/stop", { runtimeId });
}

export async function restartDriverRuntime(runtimeId: string): Promise<void> {
  await post("/api/agents/runtime/restart", { runtimeId });
}

export async function installAgent(dbType: string, _source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  await post("/api/agents/install", { dbType, operationId });
}

export async function upgradeAllAgents(_source?: UpdateDownloadSource, operationId?: string): Promise<UpgradeAllAgentDriversResult> {
  return post("/api/agents/upgrade-all", { operationId });
}

export async function checkAgentUpdateBlockers(dbTypes: string[]): Promise<AgentUpdateBlocker[]> {
  return post("/api/agents/update-blockers", { dbTypes });
}

export async function uninstallAgent(dbType: string): Promise<void> {
  await post("/api/agents/uninstall", { dbType });
}

export async function getAgentJavaRuntimeConfig(): Promise<JavaRuntimeConfig> {
  return get("/api/agents/java-runtime");
}

export async function setAgentJavaRuntimeConfig(config: JavaRuntimeConfig): Promise<JavaRuntimeConfig> {
  return post("/api/agents/java-runtime", { config });
}

export async function invalidateAgentRegistryCache(): Promise<void> {
  await post("/api/agents/invalidate-registry-cache", {});
}

export async function importAgentsFromZip(fileOrPath: string | File, operationId?: string): Promise<number> {
  if (typeof fileOrPath === "string") {
    throw new Error("Offline package import in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  if (operationId) formData.append("operationId", operationId);
  formData.append("file", fileOrPath);
  const res = await fetch(apiUrl("/api/agents/import-offline"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  const result: { count: number } = await res.json();
  return result.count;
}

export async function importAgentDriver(dbType: string, pathOrFile: string | File): Promise<void> {
  let blob: Blob;
  let fileName: string;
  if (pathOrFile instanceof File) {
    blob = pathOrFile;
    fileName = pathOrFile.name;
  } else {
    fileName = pathOrFile.split("/").pop() || "agent";
    blob = await (await fetch(pathOrFile)).blob();
  }
  const formData = new FormData();
  formData.append("dbType", dbType);
  formData.append("file", blob, fileName);
  const uploadRes = await fetch(apiUrl("/api/agents/import-driver"), {
    method: "POST",
    body: formData,
  });
  if (!uploadRes.ok) throw await backendResponseError(uploadRes);
}

export const importAgentJar = importAgentDriver;

export async function reinstallJre(jreKey?: string, _source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  await post("/api/agents/reinstall-jre", { jreKey, operationId });
}

export async function uninstallJre(jreKey: string): Promise<void> {
  await post("/api/agents/uninstall-jre", { jreKey });
}

export async function listenAgentInstallProgress(handler: (progress: DriverInstallProgress) => void): Promise<() => void> {
  const es = new EventSource(apiUrl("/api/agents/progress/global"));
  es.onmessage = (event) => {
    try {
      handler(JSON.parse(event.data));
    } catch {
      /* ignore malformed progress events */
    }
  };
  return () => es.close();
}

export async function loadSavedSqlLibrary(): Promise<SavedSqlLibrary> {
  return get("/api/saved-sql");
}

export async function loadSavedSqlFile(id: string): Promise<SavedSqlFile | null> {
  return get(`/api/saved-sql/${encodeURIComponent(id)}`);
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

export async function savedSqlStorageDir(): Promise<string> {
  return "";
}

export async function openSavedSqlStorageDir(_dir?: string | null): Promise<void> {
  throw new Error("SQL storage directory is only available in the desktop app.");
}

export async function revealPathInFileManager(_path: string): Promise<void> {
  throw new Error("Reveal in file manager is only available in the desktop app.");
}

export async function deleteDatabaseBackupFiles(_paths: string[]): Promise<number> {
  throw new Error("Database backup file management is only available in the desktop app.");
}

export async function isSqliteDatabaseFile(_path: string): Promise<boolean> {
  return false;
}

export async function backupSqliteDatabase(_connectionId: string, _destinationPath: string): Promise<void> {
  throw new Error("SQLite backup is only available in the desktop app.");
}

export async function syncSavedSqlDirectory(_request: SavedSqlSyncRequest): Promise<void> {
  throw new Error("SQL directory sync is only available in the desktop app.");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/databases?${qs({ connection_id: connectionId })}`);
}

export async function listDatabaseMetadata(connectionId: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/database-metadata?${qs({ connection_id: connectionId })}`);
}

export async function listDatabaseStorage(connectionId: string, databases: string[]): Promise<DatabaseStorageInfo[]> {
  return post("/api/schema/database-storage", {
    connection_id: connectionId,
    databases,
  });
}

export async function getSqlServerCompletionContext(connectionId: string, database: string): Promise<SqlServerCompletionContext> {
  return get(`/api/schema/sqlserver/completion-context?${qs({ connection_id: connectionId, database })}`);
}

export async function listDorisCatalogs(connectionId: string): Promise<CatalogInfo[]> {
  return get(`/api/schema/doris/catalogs?${qs({ connection_id: connectionId })}`);
}

export async function listDorisCatalogDatabases(connectionId: string, catalog: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/doris/catalog-databases?${qs({ connection_id: connectionId, catalog })}`);
}

export async function listSqlServerLinkedServers(connectionId: string): Promise<LinkedServerInfo[]> {
  return get(`/api/schema/sqlserver/linked-servers?${qs({ connection_id: connectionId })}`);
}

export async function listSqlServerLinkedServerCatalogs(connectionId: string, server: string): Promise<DatabaseInfo[]> {
  return get(`/api/schema/sqlserver/linked-server-catalogs?${qs({ connection_id: connectionId, server })}`);
}

export async function listSqlServerLinkedServerSchemas(connectionId: string, server: string, catalog: string): Promise<string[]> {
  return get(`/api/schema/sqlserver/linked-server-schemas?${qs({ connection_id: connectionId, server, catalog })}`);
}

export async function listSqlServerLinkedServerTables(connectionId: string, server: string, catalog: string, schema: string, filter?: string, limit?: number, offset?: number): Promise<TableInfo[]> {
  return get(`/api/schema/sqlserver/linked-server-tables?${qs({ connection_id: connectionId, server, catalog, schema, filter, limit, offset })}`);
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

export async function listSchemas(connectionId: string, database: string, applyVisibleFilter = false): Promise<string[]> {
  return get(`/api/schema/schemas?${qs({ connection_id: connectionId, database, apply_visible_filter: applyVisibleFilter || undefined })}`);
}

export async function listSchemaInfos(connectionId: string, database: string): Promise<SchemaInfo[]> {
  const schemas = await listSchemas(connectionId, database);
  return schemas.map((name) => ({ name, comment: null }));
}

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: SidebarObjectKind[], catalog?: string, tableNameFilter?: TableNameFilter): Promise<TableInfo[]> {
  return get(`/api/schema/tables?${qs({ connection_id: connectionId, database, schema, filter, limit, offset, object_types: objectTypes?.join(","), catalog, table_name_filter: tableNameFilter ? JSON.stringify(tableNameFilter) : undefined })}`);
}

export async function getTableComment(_connectionId: string, _database: string, _schema: string, _table: string, _catalog?: string): Promise<string | null> {
  throw new Error("Table comment lookup is not available in the web backend");
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: (SidebarObjectKind | "EVENT")[], filter?: string, limit?: number, offset?: number, catalog?: string): Promise<ObjectInfo[]> {
  return get(
    `/api/schema/objects?${qs({
      connection_id: connectionId,
      database,
      schema,
      object_types: objectTypes?.join(","),
      filter,
      limit,
      offset,
      catalog,
    })}`,
  );
}

export async function listObjectStatistics(connectionId: string, database: string, schema: string): Promise<ObjectStatistics[]> {
  return get(`/api/schema/object-statistics?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listCompletionObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return get(`/api/schema/completion-objects?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function completionAssistantSearch(request: CompletionAssistantRequest): Promise<CompletionAssistantResponse> {
  return post("/api/schema/completion-assistant", request);
}

export async function getObjectSource(connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string): Promise<ObjectSource> {
  return get(`/api/schema/object-source?${qs({ connection_id: connectionId, database, schema, table: name, object_type: objectType, signature, relation_name: relationName })}`);
}

export async function getCustomTypeDetails(connectionId: string, database: string, schema: string, name: string): Promise<CustomTypeDetails> {
  return get(`/api/schema/custom-type-details?${qs({ connection_id: connectionId, database, schema, table: name })}`);
}

export async function getColumns(connectionId: string, database: string, schema: string, table: string, catalog?: string, clientSessionId?: string): Promise<ColumnInfo[]> {
  return get(`/api/schema/columns?${qs({ connection_id: connectionId, database, schema, table, catalog, client_session_id: clientSessionId })}`);
}

export async function getSqlServerColumnMetadata(connectionId: string, database: string, schema: string, table: string): Promise<SqlServerColumnMetadata[]> {
  return get(`/api/schema/sqlserver/column-metadata?${qs({ connection_id: connectionId, database, schema, table })}`);
}

export interface TableColumnsResult {
  table_name: string;
  columns: ColumnInfo[];
  error?: string;
}

export async function getAllColumns(connectionId: string, database: string, schema: string): Promise<TableColumnsResult[]> {
  return get(`/api/schema/all-columns?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listDataTypes(connectionId: string, database: string): Promise<string[]> {
  return get(`/api/schema/data-types?${qs({ connection_id: connectionId, database })}`);
}

export async function listIndexes(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<IndexInfo[]> {
  return get(`/api/schema/indexes?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listForeignKeys(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ForeignKeyInfo[]> {
  return get(`/api/schema/foreign-keys?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listTriggers(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<TriggerInfo[]> {
  return get(`/api/schema/triggers?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listConstraints(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ConstraintInfo[]> {
  return get(`/api/schema/constraints?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listPartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<PartitionInfo[]> {
  return get(`/api/schema/partitions?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function listSubpartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<SubpartitionInfo[]> {
  return get(`/api/schema/subpartitions?${qs({ connection_id: connectionId, database, schema, table, catalog })}`);
}

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table, object_type: objectType, catalog })}`);
}

export async function getTableDisplayDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table, object_type: objectType, catalog, include_postgres_access: true })}`);
}

export async function prepareSchemaDiff(options: SchemaDiffPreparationOptions): Promise<SchemaDiffPreparation> {
  return post("/api/schema-diff/prepare", options);
}

export async function generateSchemaSyncSql(diffs: TableDiff[], databaseType: DatabaseType, targetSchema?: string, functionDiffs?: FunctionDiff[], sequenceDiffs?: SequenceDiff[], ruleDiffs?: RuleDiff[], ownerDiffs?: OwnerDiff[], cascadeDelete?: boolean): Promise<string> {
  return post("/api/schema-diff/generate-sync-sql", {
    diffs,
    databaseType,
    targetSchema,
    functionDiffs: functionDiffs ?? [],
    sequenceDiffs: sequenceDiffs ?? [],
    ruleDiffs: ruleDiffs ?? [],
    ownerDiffs: ownerDiffs ?? [],
    cascadeDelete: cascadeDelete ?? false,
  });
}

export async function listFunctions(connectionId: string, database: string, schema: string): Promise<FunctionInfo[]> {
  return get(`/api/schema/functions?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listSequences(connectionId: string, database: string, schema: string, withLastValues: boolean): Promise<SequenceInfo[]> {
  return get(`/api/schema/sequences?${qs({ connection_id: connectionId, database, schema, with_last_values: withLastValues })}`);
}

export async function listRules(connectionId: string, database: string, schema: string): Promise<RuleInfo[]> {
  return get(`/api/schema/rules?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listOwners(connectionId: string, database: string, schema: string): Promise<OwnerInfo[]> {
  return get(`/api/schema/owners?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {
  return get(`/api/schema/extensions?${qs({ connection_id: connectionId, database, schema })}`);
}

export async function listAvailableExtensions(connectionId: string, database: string): Promise<ExtensionInfo[]> {
  return get(`/api/schema/available-extensions?${qs({ connection_id: connectionId, database })}`);
}

export async function listDialectDataTypes(dialectName: string): Promise<string[]> {
  return get(`/api/dialect/data-types?${qs({ dialect_name: dialectName })}`);
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

export async function collectDocsSnapshot(connectionId: string, database: string, schemas: string[], tables: string[], projectName?: string): Promise<SchemaSnapshot> {
  return post("/api/docs/snapshot", { connectionId, database, schemas, tables, projectName });
}

export async function loadDocsAnnotations(connectionId: string): Promise<AnnotationFile | null> {
  return post("/api/docs/annotations/load", { connectionId });
}

export async function applyDocsAnnotations(connectionId: string, snapshot: SchemaSnapshot, annotations: AnnotationFile): Promise<SchemaSnapshot> {
  return post("/api/docs/annotations/apply", { connectionId, snapshot, annotations });
}

export async function saveDocsAnnotations(connectionId: string, annotations: AnnotationFile): Promise<void> {
  return post("/api/docs/annotations/save", { connectionId, annotations });
}

export async function exportDocsHtml(filePath: string, snapshot: SchemaSnapshot, annotations: AnnotationFile, lang: string): Promise<void> {
  const result = await post<{ content: string }>("/api/docs/export", { snapshot, annotations, lang });
  // No `downloadTextFile` here: it prepends a BOM, which the Tauri command's
  // `std::fs::write(&file_path, html)` does not. The two callers must produce
  // byte-identical output for the same inputs.
  const fileName = filePath.split(/[\\/]/).pop() || "docs.html";
  const blob = new Blob([result.content], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
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
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    executionMode?: "simple" | "postgres_read_only_transaction";
  },
): Promise<QueryResult> {
  return post("/api/query/execute", {
    connectionId,
    database,
    sql,
    schema,
    executionId,
    ...options,
  });
}

export async function executeMulti(
  connectionId: string,
  database: string,
  sql: string,
  schema?: string,
  executionId?: string,
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    useTransaction?: boolean;
    continueOnError?: boolean;
    executionMode?: "simple";
  },
): Promise<QueryResult[]> {
  return post("/api/query/execute-multi", {
    connectionId,
    database,
    sql,
    schema,
    executionId,
    ...options,
  });
}

export interface ExecuteMultiProgress {
  executionId: string;
  statementIndex: number;
  completed: number;
  total: number;
  success: boolean;
  executionTimeMs: number;
  affectedRows: number;
  error?: BackendError;
}

export async function executeMultiWithProgress(
  connectionId: string,
  database: string,
  sql: string,
  onProgress: (progress: ExecuteMultiProgress) => void,
  schema?: string,
  options?: {
    maxRows?: number;
    catalog?: string;
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    useTransaction?: boolean;
    continueOnError?: boolean;
    executionMode?: "simple";
    executionId?: string;
  },
): Promise<QueryResult[]> {
  const executionId = options?.executionId ?? crypto.randomUUID();
  const { executionId: _executionId, ...executeOptions } = options ?? {};
  const results = await executeMulti(connectionId, database, sql, schema, executionId, executeOptions);
  const total = results.length;
  results.forEach((result, index) => {
    const statementIndex = result.statement_index ?? index;
    const success = result.execution_error !== true;
    onProgress({
      executionId,
      statementIndex,
      completed: index + 1,
      total,
      success,
      executionTimeMs: result.execution_time_ms,
      affectedRows: result.affected_rows,
      error: success ? undefined : result.error,
    });
  });
  return results;
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string, catalog?: string): Promise<boolean> {
  return post("/api/query/close-session", {
    connectionId,
    database,
    sessionId,
    clientSessionId,
    catalog,
  });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string, catalog?: string): Promise<boolean> {
  return post("/api/query/close-client-session", {
    connectionId,
    database,
    clientSessionId,
    catalog,
  });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-batch", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-script", {
    connectionId,
    database,
    sql,
    schema,
  });
}

export async function executeScriptWith2pc(connectionId: string, database: string, statements: string[], schema?: string): Promise<any> {
  return post("/api/query/execute-script-2pc", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string, catalog?: string): Promise<QueryResult> {
  return post("/api/query/execute-in-transaction", {
    connectionId,
    database,
    statements,
    schema,
    catalog,
  });
}

export async function beginManualTransaction(_connectionId: string, _database: string, _schema?: string, _catalog?: string): Promise<string> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function executeInManualTransaction(_txnSessionId: string, _sql: string, _database: string, _schema?: string, _maxRows?: number): Promise<QueryResult[]> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function commitManualTransaction(_txnSessionId: string): Promise<QueryResult> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function rollbackManualTransaction(_txnSessionId: string): Promise<QueryResult> {
  throw new Error("Manual transaction management is only available in the desktop app.");
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  const result = await post<boolean | { cancelled?: boolean }>("/api/query/cancel", { executionId });
  return typeof result === "boolean" ? result : result.cancelled === true;
}

export async function analyzeSqlReferences(sql: string, dialect?: string): Promise<SqlReferenceAnalysis> {
  return post("/api/query/analyze-sql-references", { sql, dialect });
}

export async function findStatementAtCursor(sql: string, cursorPos: number, databaseType?: DatabaseType): Promise<string> {
  return post("/api/query/find-statement-at-cursor", {
    sql,
    cursorPos,
    databaseType,
  });
}

export async function prepareQueryPaginationExecutionPlan(options: QueryPaginationExecutionPlanOptions): Promise<QueryPaginationExecutionPlan> {
  return post("/api/query/prepare-pagination-plan", { options });
}

export async function buildSortedQuerySql(options: SortedQuerySqlOptions): Promise<QuerySqlBuildResult> {
  return post("/api/query/build-sorted-sql", { options });
}

export async function buildExplainSql(options: BuildExplainSqlOptions): Promise<ExplainSqlBuildResult> {
  return post("/api/query/build-explain-sql", { options });
}

export async function buildCreateUserSql(username: string, password: string, tablespace: string): Promise<string> {
  return post("/api/query/build-create-user-sql", {
    username,
    password,
    tablespace,
  });
}

export async function getExplainInfo(connectionId: string, database: string | undefined, schema: string | undefined, sql: string, mode: string): Promise<string | undefined> {
  // Match the Tauri path: transport and Agent failures must remain distinguishable from an empty plan.
  return post<string>("/api/query/get-explain-info", {
    connectionId,
    database,
    schema,
    sql,
    mode,
  });
}

export async function buildDroppedFilePreviewSql(options: DroppedFilePreviewSqlOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-dropped-file-preview-sql", { options });
  return result ?? undefined;
}

export async function buildTableSelectSql(options: BuildTableSelectSqlOptions): Promise<string> {
  return post("/api/query/build-table-select-sql", { options });
}

export async function buildDatabaseSearchSql(options: DatabaseSearchSqlOptions): Promise<DatabaseSearchSql | null> {
  return post("/api/query/build-database-search-sql", { options });
}

export async function buildSearchResultWhere(options: SearchResultWhereOptions): Promise<string> {
  return post("/api/query/build-search-result-where", { options });
}

export async function buildRenameObjectSql(options: BuildRenameObjectSqlOptions): Promise<string> {
  return post("/api/query/build-rename-object-sql", { options });
}

export async function buildCreateDatabaseSql(options: CreateDatabaseSqlOptions): Promise<string> {
  return post("/api/query/build-create-database-sql", { options });
}

export async function buildDuckDbAttachDatabaseSql(path: string, name: string): Promise<string> {
  return post("/api/query/build-duckdb-attach-database-sql", {
    options: { path, name },
  });
}

export async function buildSqliteAttachDatabaseSql(path: string, name: string): Promise<string> {
  return post("/api/query/build-sqlite-attach-database-sql", {
    options: { path, name },
  });
}

export async function buildDropObjectSql(options: DropObjectSqlOptions): Promise<string> {
  return post("/api/query/build-drop-object-sql", { options });
}

export async function buildDropTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-drop-table-sql", { options });
}

export async function buildDropTableChildObjectSql(options: DropTableChildObjectSqlOptions): Promise<string> {
  return post("/api/query/build-drop-table-child-object-sql", { options });
}

export async function buildEmptyTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-empty-table-sql", { options });
}

export async function buildTruncateTableSql(options: TableAdminSqlOptions): Promise<string> {
  return post("/api/query/build-truncate-table-sql", { options });
}

export async function buildDropDatabaseSql(options: DatabaseNameSqlOptions): Promise<string> {
  return post("/api/query/build-drop-database-sql", { options });
}

export async function buildCreateSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return post("/api/query/build-create-schema-sql", { options });
}

export async function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return post("/api/query/build-update-database-properties-sql", { options });
}

export async function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return post("/api/query/build-drop-schema-sql", { options });
}

export async function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return post("/api/query/build-duplicate-table-structure-sql", { options });
}

export async function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return post("/api/query/build-copy-table-data-sql", { options });
}

export async function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return post("/api/query/build-executable-object-source-statements", {
    input,
  });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-executable-object-source-sql", { input });
}

export async function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-editable-object-source", { input });
}

export async function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return post("/api/query/build-routine-rename-object-source-statements", {
    input,
  });
}

export async function buildViewDdlSql(input: BuildViewDdlInput): Promise<string> {
  return post("/api/query/build-view-ddl-sql", { input });
}

export async function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-table-structure-change-sql", { options });
}

export async function previewSqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions): Promise<SqliteTableStructureChangePreview> {
  return post("/api/query/preview-sqlite-table-structure-change", {
    connectionId,
    database,
    options,
  });
}

export async function applySqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions, schemaRevision: string): Promise<QueryResult> {
  return post("/api/query/apply-sqlite-table-structure-change", {
    connectionId,
    database,
    options,
    schemaRevision,
  });
}

export async function buildCreateTableSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-create-table-sql", { options });
}

export async function buildSingleColumnAlterSql(options: BuildSingleColumnAlterSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-single-column-alter-sql", { options });
}

export async function analyzeEditableQueryEditability(sql: string): Promise<QueryEditability> {
  return post("/api/query/analyze-editability", { sql });
}

export async function prepareDataGridSave(options: DataGridSaveStatementOptions, driverProfile?: string): Promise<DataGridSavePreparation> {
  return post("/api/query/prepare-data-grid-save", { options, driverProfile });
}

export async function extractDataGridSelection(request: DataGridExtractRequest): Promise<DataGridExtractResult> {
  return post("/api/query/extract-data-grid-selection", { request });
}

export async function buildDataGridCopyUpdateStatements(options: DataGridCopyUpdateStatementOptions): Promise<string[]> {
  return post("/api/query/build-data-grid-copy-update-statements", { options });
}

export async function buildDataGridCopyInsertStatement(options: DataGridCopyInsertStatementOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-copy-insert-statement", { options });
  return result ?? undefined;
}

export async function buildDataGridContextFilterCondition(options: DataGridContextFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-context-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValueFilterCondition(options: DataGridColumnValueFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-column-value-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnValuesFilterCondition(options: DataGridColumnValuesFilterConditionOptions): Promise<string | undefined> {
  const result = await post<string | null>("/api/query/build-data-grid-column-values-filter-condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnDistinctValuesSql(options: DataGridColumnDistinctValuesSqlOptions): Promise<string> {
  return post("/api/query/build-data-grid-column-distinct-values-sql", {
    options,
  });
}

export async function buildDataGridCountSql(options: DataGridCountSqlOptions): Promise<string> {
  return post("/api/query/build-data-grid-count-sql", { options });
}

export async function buildHiveTablePropertiesSql(options: HiveTablePropertiesSqlOptions): Promise<string> {
  return post("/api/query/build-hive-table-properties-sql", { options });
}

export async function buildExportInsertStatements(options: BuildExportInsertStatementsOptions): Promise<string[]> {
  return post("/api/query/build-export-insert-statements", { options });
}

export async function buildExportSqlInsert(options: BuildExportInsertStatementsOptions): Promise<string> {
  return post("/api/query/build-export-sql-insert", { options });
}

export async function buildDatabaseSqlExport(options: BuildDatabaseSqlExportOptions): Promise<string> {
  return post("/api/query/build-database-sql-export", { options });
}

export async function prepareDataCompare(options: DataComparePreparationOptions): Promise<DataComparePreparation> {
  return post("/api/data-compare/prepare", options);
}

export async function prepareDataCompareFromTables(options: DataCompareFromTablesOptions): Promise<DataCompareFromTablesPreparation> {
  return post("/api/data-compare/prepare-from-tables", options);
}

export async function prepareDataCompareMissingTarget(options: import("@/lib/dataGrid/dataCompare").DataCompareMissingTargetOptions): Promise<DataCompareFromTablesPreparation> {
  return post("/api/data-compare/prepare-missing-target", options);
}

export async function buildDataCompareSyncPlan(options: DataCompareSyncPlanOptions): Promise<DataCompareSyncPlan> {
  return post("/api/data-compare/build-sync-plan", options);
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export async function aiComplete(request: AiCompletionRequest): Promise<string> {
  return post("/api/ai/complete", { request });
}

export async function aiStream(sessionId: string, request: AiCompletionRequest, onChunk: (chunk: AiStreamChunk) => void): Promise<void> {
  const res = await fetch(apiUrl("/api/ai/stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionId, request }),
  });
  if (!res.ok) throw await backendResponseError(res);

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

export async function aiTestConnection(config: AiConfig): Promise<AiTestConnectionResult> {
  return post("/api/ai/test-connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return post("/api/ai/models", { config });
}

export async function aiResolveModelEffort(config: AiConfig, modelId: string): Promise<AiEffortCapability> {
  return post("/api/ai/model-effort", { config, modelId });
}

export async function saveAiChatSelection(selection: AiChatSelectionState): Promise<void> {
  return post("/api/ai/chat-selection", { selection });
}

export async function loadAiChatSelection(): Promise<AiChatSelectionState | null> {
  return get("/api/ai/chat-selection");
}

export type { AgentEvent } from "@/lib/backend/tauri";

function isAgentEvent(v: unknown): v is import("@/lib/backend/tauri").AgentEvent {
  return typeof v === "object" && v !== null && "type" in v && typeof (v as Record<string, unknown>).type === "string";
}

export async function aiAgentStream(
  sessionId: string,
  request: AiCompletionRequest,
  connectionId: string,
  database: string,
  schema: string | undefined,
  dbType: string,
  onEvent: (event: import("@/lib/backend/tauri").AgentEvent) => void,
  mode?: string,
  allowWriteSql = false,
  confirmedWriteSql?: string,
  confirmedConnectionId?: string,
  confirmedDatabase?: string,
  confirmedSchema?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(apiUrl("/api/ai/agent-stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      request,
      connectionId,
      database,
      schema,
      dbType,
      mode: mode || "ask",
      allowWriteSql,
      confirmedWriteSql,
      confirmedConnectionId,
      confirmedDatabase,
      confirmedSchema,
    }),
    signal,
  });
  if (!res.ok) throw await backendResponseError(res);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = "";

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
            const parsed = JSON.parse(data);
            if (!isAgentEvent(parsed)) {
              console.warn("[aiAgentStream] Skipping invalid agent event:", data);
              continue;
            }
            onEvent(parsed);
            if (parsed.type === "agent_end" || parsed.type === "error") {
              result = data;
            }
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  }
  return result;
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return post("/api/ai/config", { config });
}

export async function saveAiProviderConfig(provider: string, config: AiConfig): Promise<void> {
  return post("/api/ai/provider-config", { provider, config });
}

export async function loadAiProviderConfigs(): Promise<Record<string, AiConfig>> {
  return get("/api/ai/provider-configs");
}

export async function loadAiConfig(): Promise<AiConfig | null> {
  return get("/api/ai/config");
}

export async function saveAiConfigs(configs: import("@/types/ai").AiConfigItem[]): Promise<void> {
  return post("/api/ai/configs", { configs });
}

export async function loadAiConfigs(): Promise<import("@/types/ai").AiConfigItem[]> {
  return get("/api/ai/configs");
}

export async function setDefaultAiConfig(configId: string): Promise<void> {
  return post("/api/ai/default-config", { configId });
}

export async function saveAiConfigItem(config: import("@/types/ai").AiConfigItem): Promise<void> {
  return post("/api/ai/config-item", { config });
}

export async function deleteAiConfig(configId: string): Promise<void> {
  return del(`/api/ai/config/${configId}`);
}

export async function loadDesktopSettings(): Promise<DesktopSettings> {
  try {
    const raw = safeLocalStorageGet(DESKTOP_SETTINGS_STORAGE_KEY);
    return raw
      ? {
          ...DEFAULT_DESKTOP_SETTINGS,
          ...(JSON.parse(raw) as Partial<DesktopSettings>),
        }
      : { ...DEFAULT_DESKTOP_SETTINGS };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export async function saveDesktopSettings(settings: DesktopSettings): Promise<void> {
  safeLocalStorageSet(DESKTOP_SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULT_DESKTOP_SETTINGS, ...settings }));
}

export async function loadMcpGlobalPolicy(): Promise<McpGlobalPolicy> {
  return get("/api/app-settings/mcp-policy");
}

export async function saveMcpGlobalPolicy(policy: Omit<McpGlobalPolicy, "configured">): Promise<void> {
  const res = await fetch(apiUrl("/api/app-settings/mcp-policy"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
  if (!res.ok) throw await backendResponseError(res);
}

export async function loadMaxAgentTurns(): Promise<number> {
  return get("/api/app-settings/max-agent-turns");
}

export async function saveMaxAgentTurns(maxAgentTurns: number): Promise<void> {
  const res = await fetch(apiUrl("/api/app-settings/max-agent-turns"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxAgentTurns }),
  });
  if (!res.ok) throw await backendResponseError(res);
}

export async function loadMaxRetries(): Promise<number> {
  return get("/api/app-settings/max-retries");
}

export async function saveMaxRetries(maxRetries: number): Promise<void> {
  const res = await fetch(apiUrl("/api/app-settings/max-retries"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ maxRetries }),
  });
  if (!res.ok) throw await backendResponseError(res);
}

export interface OpenTabsStatePayload {
  tabs: unknown[];
  activeTabId: string | null;
}

export async function loadEditorSettings(): Promise<unknown | null> {
  return loadBrowserAppState("editor_settings");
}

export async function saveEditorSettings(settings: unknown): Promise<void> {
  await saveBrowserAppState("editor_settings", settings);
}

export async function loadOpenTabsState(): Promise<OpenTabsStatePayload | null> {
  const value = await loadBrowserAppState("open_tabs");
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<OpenTabsStatePayload>;
  return Array.isArray(payload.tabs)
    ? {
        tabs: payload.tabs,
        activeTabId: typeof payload.activeTabId === "string" ? payload.activeTabId : null,
      }
    : null;
}

export async function saveOpenTabsState(payload: OpenTabsStatePayload): Promise<void> {
  await saveBrowserAppState("open_tabs", payload);
}

export async function loadSavedSqlEditorPositions(): Promise<unknown[] | null> {
  const value = await loadBrowserAppState("saved_sql_editor_positions");
  return Array.isArray(value) ? value : null;
}

export async function saveSavedSqlEditorPositions(positions: unknown[]): Promise<void> {
  await saveBrowserAppState("saved_sql_editor_positions", positions);
}

export async function completeAppClose(_action: "quit" | "hide"): Promise<void> {
  return undefined;
}

export async function requestAppClose(): Promise<void> {
  return undefined;
}

export interface DriverStoreMigrationResult {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
  migrated_plugins: boolean;
  migrated_agents: boolean;
}

export async function setDriverStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export async function setPluginStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export async function setAgentStoreDir(_newDir: string | null): Promise<DriverStoreMigrationResult> {
  throw new Error("Not available in web mode");
}

export interface DriverStorePathInfo {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
}

export async function getDriverStorePath(): Promise<DriverStorePathInfo> {
  throw new Error("Not available in web mode");
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

export interface WebDavSyncSecretsStatus {
  enabled: boolean;
  hasSavedPassphrase: boolean;
}

export type SnippetProvider = "github" | "gitee";

export interface SnippetSyncConfig {
  provider: SnippetProvider;
  token?: string;
  snippetId?: string;
  replaceLegacySnippet?: boolean;
}

export interface SnippetSyncSettings {
  snippetId?: string;
  legacyCleanupRequiredId?: string;
}

export interface SnippetSyncSummary {
  provider: SnippetProvider;
  snippetId: string;
  bytes: number;
  exportedAt?: string;
  appVersion?: string;
  legacyCleanupRequiredId?: string;
}

export interface SnippetDownloadResult {
  summary: SnippetSyncSummary;
  editorSettings?: unknown;
  desktopSettings: DesktopSettings;
  applySummary: WebDavDownloadResult["applySummary"];
}

export interface SnippetTokenStatus {
  hasSavedToken: boolean;
}

export async function webdavSyncTest(config: WebDavConfig): Promise<void> {
  return post("/api/cloud-sync/webdav/test", { config });
}

export async function webdavPasswordStatus(config: WebDavConfig): Promise<WebDavPasswordStatus> {
  return post("/api/cloud-sync/webdav/password-status", { config });
}

export async function saveWebdavSavedPassword(config: WebDavConfig, password: string): Promise<void> {
  return post("/api/cloud-sync/webdav/save-password", { config, password });
}

export async function forgetWebdavSavedPassword(config: WebDavConfig): Promise<void> {
  return post("/api/cloud-sync/webdav/forget-password", { config });
}

export async function webdavSyncSecretsStatus(): Promise<WebDavSyncSecretsStatus> {
  return post("/api/cloud-sync/webdav/sync-secrets-status", {});
}

export async function saveWebdavSyncSecretsPreference(enabled: boolean, passphrase?: string): Promise<void> {
  return post("/api/cloud-sync/webdav/save-sync-secrets-preference", {
    enabled,
    passphrase,
  });
}

export async function forgetWebdavSyncSecretsPassphrase(): Promise<void> {
  return post("/api/cloud-sync/webdav/forget-sync-secrets-passphrase", {});
}

export async function webdavSyncUpload(config: WebDavConfig, editorSettings?: unknown, secretsPassphrase?: string): Promise<WebDavSyncSummary> {
  return post("/api/cloud-sync/webdav/upload", {
    config,
    editorSettings,
    secretsPassphrase,
  });
}

export async function webdavSyncDownload(config: WebDavConfig, secretsPassphrase?: string): Promise<WebDavDownloadResult> {
  return post("/api/cloud-sync/webdav/download", { config, secretsPassphrase });
}

export async function snippetSyncTest(config: SnippetSyncConfig): Promise<void> {
  await post("/api/cloud-sync/snippet/test", { config });
}

export async function snippetTokenStatus(config: SnippetSyncConfig): Promise<SnippetTokenStatus> {
  return post("/api/cloud-sync/snippet/token-status", { config });
}

export async function saveSnippetSavedToken(config: SnippetSyncConfig, token: string): Promise<void> {
  await post("/api/cloud-sync/snippet/save-token", { config, token });
}

export async function forgetSnippetSavedToken(config: SnippetSyncConfig): Promise<void> {
  await post("/api/cloud-sync/snippet/forget-token", { config });
}

export async function snippetSyncSettings(provider: SnippetProvider): Promise<SnippetSyncSettings> {
  return post("/api/cloud-sync/snippet/settings", { provider });
}

export async function saveSnippetSyncId(provider: SnippetProvider, snippetId?: string): Promise<void> {
  await post("/api/cloud-sync/snippet/save-id", { provider, snippetId });
}

export async function retrySnippetLegacyCleanup(config: SnippetSyncConfig): Promise<SnippetSyncSettings> {
  return post("/api/cloud-sync/snippet/retry-legacy-cleanup", { config });
}

export async function snippetSyncUpload(config: SnippetSyncConfig, editorSettings?: unknown, snippetPassphrase?: string, includeSecrets = false, secretsPassphrase?: string): Promise<SnippetSyncSummary> {
  return post("/api/cloud-sync/snippet/upload", {
    config,
    editorSettings,
    snippetPassphrase,
    includeSecrets,
    secretsPassphrase,
  });
}

export async function snippetSyncDownload(config: SnippetSyncConfig, snippetPassphrase?: string, restoreSecrets = false, secretsPassphrase?: string): Promise<SnippetDownloadResult> {
  return post("/api/cloud-sync/snippet/download", {
    config,
    snippetPassphrase,
    restoreSecrets,
    secretsPassphrase,
  });
}

export async function loadPinnedTreeNodeIds(): Promise<string[]> {
  return get("/api/app-settings/pinned-tree-node-ids");
}

export async function savePinnedTreeNodeIds(_ids: string[]): Promise<void> {
  return post("/api/app-settings/pinned-tree-node-ids", { ids: _ids });
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
// Prompt Templates
// ---------------------------------------------------------------------------

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  return get("/api/prompt-templates");
}

export async function savePromptTemplate(id: string, name: string, content: string): Promise<PromptTemplate> {
  return post("/api/prompt-templates", { id, name, content });
}

export async function deletePromptTemplate(id: string): Promise<void> {
  return del(`/api/prompt-templates/${encodeURIComponent(id)}`);
}

export async function getAiGlobalCustomInstructions(): Promise<string> {
  const result = await get<{ content: string }>("/api/prompt-templates/global-instructions");
  return result.content ?? "";
}

export async function setAiGlobalCustomInstructions(content: string): Promise<void> {
  return put("/api/prompt-templates/global-instructions", { content });
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
  const res = await fetch(apiUrl("/api/sql-file/preview"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return post("/api/sql-file/execute", { request });
}

export async function executeSqlFiles(request: SqlFileRequest, filePaths: string[]): Promise<void> {
  return post("/api/sql-file/execute", { request, filePaths });
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

export async function pendingOpenSqlFiles(): Promise<string[]> {
  return [];
}

export async function pendingOpenDbFiles(): Promise<string[]> {
  return [];
}

export async function pendingOpenConnectionLinks(): Promise<string[]> {
  return [];
}

export async function readExternalSqlFile(_path: string): Promise<string> {
  throw new Error("Opening external SQL file paths is only available in the desktop app");
}

export async function readExternalSqlFileSnapshot(_path: string): Promise<import("@/lib/backend/tauri").ExternalSqlFileSnapshot> {
  throw new Error("Opening external SQL file paths is only available in the desktop app");
}

export async function inspectExternalSqlFile(_path: string): Promise<import("@/lib/backend/tauri").ExternalSqlFileStatus> {
  throw new Error("Inspecting external SQL file paths is only available in the desktop app");
}

export async function writeExternalSqlFile(_path: string, _content: string, _options: { expectedContentHash?: string; expectedMissing?: boolean } = {}): Promise<import("@/lib/backend/tauri").ExternalSqlFileWriteResult> {
  throw new Error("Saving external SQL file paths is only available in the desktop app");
}

export async function saveExternalSqlFile(_defaultFileName: string, _content: string): Promise<{ path: string; version: import("@/types/database").ExternalSqlFileVersion } | null> {
  throw new Error("Saving SQL files locally is only available in the desktop app");
}

export interface SqlFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: SqlFileEntry[];
}

export async function listSqlFilesInFolder(_folderPath: string): Promise<SqlFileEntry[]> {
  throw new Error("Listing SQL files in a folder is only available in the desktop app");
}

// ---------------------------------------------------------------------------
// Data Transfer
// ---------------------------------------------------------------------------

export async function startTransfer(request: TransferRequest, onProgress: (progress: TransferProgress) => void): Promise<void> {
  // 1. POST to start the transfer
  const res = await fetch(apiUrl("/api/transfer/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/transfer/progress/${request.transferId}`));
    es.onmessage = (e) => {
      const progress: TransferProgress = JSON.parse(e.data);
      onProgress(progress);
      if (isTerminalTransferProgress(progress)) {
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

export async function previewTransferOwnership(request: TransferRequest): Promise<TransferOwnershipPreview> {
  return post("/api/transfer/ownership-preview", { request });
}

export interface SortTablesByFkOptions {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
  parentsFirst: boolean;
}

export async function sortTablesByFkDependency(options: SortTablesByFkOptions): Promise<string[]> {
  return post("/api/transfer/sort-tables-by-fk", options);
}

// ---------------------------------------------------------------------------
// Table File Import
// ---------------------------------------------------------------------------

export async function previewTableImportFile(fileOrPath: string | File | TableImportPreviewRequest, options: Partial<TableImportPreviewRequest> = {}): Promise<TableImportPreview> {
  if (typeof fileOrPath === "object" && !(fileOrPath instanceof File)) {
    throw new Error("previewTableImportFile in web mode requires a File object for upload previews");
  }
  if (typeof fileOrPath === "string") {
    if (!options.sourceRef) {
      throw new Error("previewTableImportFile in web mode requires a File object for new uploads");
    }
    const res = await fetch(apiUrl("/api/import/preview-source"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceRef: options.sourceRef,
        sourceFormat: options.sourceFormat,
        parseOptions: options.parseOptions,
        previewLimit: options.previewLimit,
      }),
    });
    if (!res.ok) throw await backendResponseError(res);
    return res.json();
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  if (options.sourceFormat) formData.append("sourceFormat", options.sourceFormat);
  if (options.parseOptions) formData.append("parseOptions", JSON.stringify(options.parseOptions));
  if (options.previewLimit != null) formData.append("previewLimit", String(options.previewLimit));
  const res = await fetch(apiUrl("/api/import/preview"), {
    method: "POST",
    body: formData,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function importTableFile(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void): Promise<TableImportSummary> {
  // 1. POST to start the import
  const res = await fetch(apiUrl("/api/import/execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/import/progress/${request.importId}`));
    let summary: TableImportSummary | null = null;
    es.onmessage = (e) => {
      const progress: TableImportProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "done") {
        summary = {
          importId: progress.importId,
          rowsImported: progress.rowsImported,
          totalRows: progress.totalRows,
          elapsedMs: progress.elapsedMs,
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

export async function releaseTableImportSource(sourceRef: string): Promise<boolean> {
  const result = await post<{ released: boolean }>("/api/import/source/release", { sourceRef });
  return result.released;
}

// ---------------------------------------------------------------------------
// Database Export
// ---------------------------------------------------------------------------

export async function beginDatabaseBackupSnapshot(_connectionId: string, _database: string): Promise<DatabaseBackupSnapshot> {
  throw new Error("Consistent database backup snapshots are only available in the desktop app.");
}

export async function exportDatabaseSql(request: DatabaseExportRequest, onProgress: (progress: ExportProgress) => void): Promise<void> {
  // 1. POST to start the export
  const res = await fetch(apiUrl("/api/export/database"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw await backendResponseError(res);

  // 2. SSE to listen for progress
  return new Promise((resolve, reject) => {
    const es = new EventSource(apiUrl(`/api/export/database/progress/${request.exportId}`));
    es.onmessage = (e) => {
      const progress: ExportProgress = JSON.parse(e.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        es.close();
        if (progress.status === "Done") {
          // Trigger browser download; filename is decided by the server's
          // Content-Disposition header.
          downloadDatabaseExportFile(request.exportId);
        }
        resolve();
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Export SSE connection failed"));
    };
  });
}

function downloadDatabaseExportFile(exportId: string): void {
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/database/download/${exportId}`);
  a.click();
}

export async function cancelDatabaseExport(exportId: string): Promise<void> {
  await post("/api/export/database/cancel", { exportId });
}

// --- Table Export ---

export async function startTableExport(request: TableExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  const { exportId } = request;

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const eventSource = new EventSource(apiUrl(`/api/export/table/progress/${exportId}`));

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onopen = () => {
      if (started) return;
      started = true;
      post("/api/export/table", { request }).catch((error) => {
        finish(() => reject(error));
      });
    };

    eventSource.onmessage = (event) => {
      const progress: TableExportProgress = JSON.parse(event.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        if (progress.status === "Error") {
          finish(() => reject(new Error(progress.errorMessage || "Export failed")));
        } else if (progress.status === "Done") {
          // Trigger browser download
          downloadTableExportFile(exportId, request.format);
          finish(() => resolve(progress));
        } else {
          finish(() => resolve(progress));
        }
      }
    };

    eventSource.onerror = () => {
      finish(() => reject(new Error("Export progress connection lost")));
    };
  });
}

function downloadTableExportFile(exportId: string, format: string): void {
  const ext = format === "markdown" || format === "md" ? "md" : format;
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/table/download/${exportId}`);
  a.download = `table_export_${exportId}.${ext}`;
  a.click();
}

export async function cancelTableExport(exportId: string): Promise<void> {
  return post("/api/export/table/cancel", { exportId });
}

export async function startQueryResultExport(request: QueryResultExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
  const { exportId } = request;

  return new Promise((resolve, reject) => {
    let started = false;
    let settled = false;
    const eventSource = new EventSource(apiUrl(`/api/export/query-result/progress/${exportId}`));

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      eventSource.close();
      callback();
    };

    eventSource.onopen = () => {
      if (started) return;
      started = true;
      post("/api/export/query-result", { request }).catch((error) => {
        finish(() => reject(error));
      });
    };

    eventSource.onmessage = (event) => {
      const progress: TableExportProgress = JSON.parse(event.data);
      onProgress(progress);
      if (progress.status === "Done" || progress.status === "Error" || progress.status === "Cancelled") {
        if (progress.status === "Error") {
          finish(() => reject(new Error(progress.errorMessage || "Export failed")));
        } else if (progress.status === "Done") {
          downloadQueryResultExportFile(exportId, request.format);
          finish(() => resolve(progress));
        } else {
          finish(() => resolve(progress));
        }
      }
    };

    eventSource.onerror = () => {
      finish(() => reject(new Error("Export progress connection lost")));
    };
  });
}

function downloadQueryResultExportFile(exportId: string, format: string): void {
  const a = document.createElement("a");
  a.href = apiUrl(`/api/export/query-result/download/${exportId}`);
  a.download = `query_result_export_${exportId}.${format}`;
  a.click();
}

export async function cancelQueryResultExport(exportId: string, executionId?: string): Promise<void> {
  return post("/api/export/query-result/cancel", {
    exportId,
    ...(executionId ? { executionId } : {}),
  });
}

export async function exportQueryResultCsv(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const { formatCsv } = await import("@/lib/export/exportFormats");
  const content = formatCsv(columns, rows as (string | number | boolean | null)[][]);
  const fileName = filePath.split(/[\\/]/).pop() || "export.csv";
  const blob = new Blob(["\uFEFF", content], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportTableDataCsv(_options: TableCsvExportOptions): Promise<number> {
  throw new Error("Streaming table CSV export is only available in the desktop runtime");
}

function downloadTextFile(filePath: string, fallbackFileName: string, content: string, mimeType: string): void {
  const fileName = filePath.split(/[\\/]/).pop() || fallbackFileName;
  const blob = new Blob(["\uFEFF", content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], columnTypes: string[], columnComments: readonly (string | null)[] | undefined, rows: readonly (readonly XlsxCellValue[])[], numericColumnRightAlign?: boolean): Promise<void> {
  const { buildXlsxWorkbook } = await import("@/lib/export/xlsxExport");
  const workbook = buildXlsxWorkbook({
    sheetName: sheetName || "Export",
    columns,
    columnTypes,
    columnComments,
    rows,
    numericColumnRightAlign,
  });
  const fileName = filePath.split(/[\\/]/).pop() || "export.xlsx";
  const blob = new Blob([new Uint8Array(workbook)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultsXlsx(
  filePath: string,
  worksheets: readonly {
    sheetName?: string;
    columns: readonly string[];
    columnTypes?: readonly string[];
    columnComments?: readonly (string | null)[];
    rows: readonly (readonly XlsxCellValue[])[];
    numericColumnRightAlign?: boolean;
  }[],
): Promise<void> {
  const { buildXlsxWorkbookMulti } = await import("@/lib/export/xlsxExport");
  const workbook = buildXlsxWorkbookMulti(worksheets);
  const fileName = filePath.split(/[\\/]/).pop() || "export.xlsx";
  const blob = new Blob([new Uint8Array(workbook)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportQueryResultJson(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const result = await post<{ content: string }>("/api/export/query-result-json", { columns, rows });
  downloadTextFile(filePath, "export.json", result.content, "application/json;charset=utf-8");
}

export async function exportQueryResultMarkdown(filePath: string, columns: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const result = await post<{ content: string }>("/api/export/query-result-markdown", { columns, rows });
  downloadTextFile(filePath, "export.md", result.content, "text/markdown;charset=utf-8");
}

// ---------------------------------------------------------------------------
// Redis
// ---------------------------------------------------------------------------

export async function redisListDatabases(connectionId: string): Promise<RedisDatabaseInfo[]> {
  return post("/api/redis/list-databases", { connectionId });
}

export async function redisScanKeys(connectionId: string, db: number, cursor: number, pattern: string, count: number): Promise<RedisScanResult> {
  return post("/api/redis/scan-keys", {
    connectionId,
    db,
    cursor,
    pattern,
    count,
  });
}

export async function redisScanKeysBatch(connectionId: string, db: number, cursor: number, pattern: string, count: number, maxIterations: number, includeTypes = true): Promise<RedisScanResult> {
  return post("/api/redis/scan-keys-batch", {
    connectionId,
    db,
    cursor,
    pattern,
    count,
    maxIterations,
    includeTypes,
  });
}

export async function redisScanValues(connectionId: string, db: number, cursor: number, pattern: string, query: string, count: number, includeKeyMatches = false): Promise<RedisScanResult> {
  return post("/api/redis/scan-values", {
    connectionId,
    db,
    cursor,
    pattern,
    query,
    includeKeyMatches,
    count,
  });
}

export async function redisGetValue(connectionId: string, db: number, keyRaw: string): Promise<RedisValue> {
  return post("/api/redis/get-value", { connectionId, db, keyRaw });
}

export async function redisGetTtl(connectionId: string, db: number, keyRaw: string): Promise<number> {
  return post("/api/redis/get-ttl", { connectionId, db, keyRaw });
}

export async function redisGetStreamEntries(connectionId: string, db: number, keyRaw: string, cursor?: string): Promise<RedisStreamPage> {
  return post("/api/redis/get-stream-entries", { connectionId, db, keyRaw, cursor });
}

export async function redisGetStreamGroups(connectionId: string, db: number, keyRaw: string): Promise<RedisStreamGroup[]> {
  return post("/api/redis/get-stream-groups", { connectionId, db, keyRaw });
}

export async function redisGetStreamConsumers(connectionId: string, db: number, keyRaw: string, groupRaw: string): Promise<RedisStreamConsumer[]> {
  return post("/api/redis/get-stream-consumers", {
    connectionId,
    db,
    keyRaw,
    groupRaw,
  });
}

export async function redisGetStreamPending(connectionId: string, db: number, keyRaw: string, groupRaw: string, cursor?: string, consumerRaw?: string): Promise<RedisStreamPendingPage> {
  return post("/api/redis/get-stream-pending", {
    connectionId,
    db,
    keyRaw,
    groupRaw,
    cursor,
    ...(consumerRaw === undefined ? {} : { consumerRaw }),
  });
}

export async function redisSetString(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/set-string", {
    connectionId,
    db,
    keyRaw,
    value,
    ttl,
  });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return post("/api/redis/delete-key", { connectionId, db, keyRaw });
}

export async function redisHashSet(connectionId: string, db: number, keyRaw: string, field: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/hash-set", {
    connectionId,
    db,
    keyRaw,
    field,
    value,
    ttl,
  });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return post("/api/redis/hash-del", { connectionId, db, keyRaw, field });
}

export async function redisHashFieldSetTtl(connectionId: string, db: number, keyRaw: string, field: string, ttl: number): Promise<void> {
  return post("/api/redis/hash-field-set-ttl", { connectionId, db, keyRaw, field, ttl });
}

export async function redisHashFieldSetExpireAt(connectionId: string, db: number, keyRaw: string, field: string, expireAt: number): Promise<void> {
  return post("/api/redis/hash-field-set-expire-at", { connectionId, db, keyRaw, field, expireAt });
}

export async function redisListPush(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/list-push", { connectionId, db, keyRaw, value, ttl });
}

export async function redisListSet(connectionId: string, db: number, keyRaw: string, index: number, value: string): Promise<void> {
  return post("/api/redis/list-set", {
    connectionId,
    db,
    keyRaw,
    index,
    value,
  });
}

export async function redisListRemove(connectionId: string, db: number, keyRaw: string, index: number): Promise<void> {
  return post("/api/redis/list-remove", { connectionId, db, keyRaw, index });
}

export async function redisSetAdd(connectionId: string, db: number, keyRaw: string, member: string, ttl?: number): Promise<void> {
  return post("/api/redis/set-add", { connectionId, db, keyRaw, member, ttl });
}

export async function redisSetRemove(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/set-remove", { connectionId, db, keyRaw, member });
}

export async function redisZadd(connectionId: string, db: number, keyRaw: string, member: string, score: number, ttl?: number): Promise<void> {
  return post("/api/redis/zadd", {
    connectionId,
    db,
    keyRaw,
    member,
    score,
    ttl,
  });
}

export async function redisZrem(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/zrem", { connectionId, db, keyRaw, member });
}

export async function redisZsetUpdate(connectionId: string, db: number, keyRaw: string, originalMember: string, expectedScore: string, member: string, score: string): Promise<boolean> {
  return post("/api/redis/zset-update", { connectionId, db, keyRaw, originalMember, expectedScore, member, score });
}

export async function redisStreamAdd(connectionId: string, db: number, keyRaw: string, entryId: string, fields: [string, string][], ttl?: number): Promise<void> {
  return post("/api/redis/stream-add", {
    connectionId,
    db,
    keyRaw,
    entryId,
    fields,
    ttl,
  });
}

export async function redisJsonSet(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/json-set", { connectionId, db, keyRaw, value, ttl });
}

export async function redisCheckJsonModule(connectionId: string, db: number): Promise<boolean> {
  return post("/api/redis/check-json-module", { connectionId, db });
}

export async function redisSetTtl(connectionId: string, db: number, keyRaw: string, ttl: number): Promise<void> {
  return post("/api/redis/set-ttl", { connectionId, db, keyRaw, ttl });
}

export async function redisSetExpireAt(connectionId: string, db: number, keyRaw: string, expireAt: number): Promise<void> {
  return post("/api/redis/set-expire-at", {
    connectionId,
    db,
    keyRaw,
    expireAt,
  });
}

export async function redisDeleteKeys(connectionId: string, db: number, keyRaws: string[]): Promise<number> {
  return post("/api/redis/delete-keys", { connectionId, db, keyRaws });
}

export async function redisFlushDb(connectionId: string, db: number): Promise<void> {
  return post("/api/redis/flush-db", { connectionId, db });
}

export async function redisExecuteCommand(connectionId: string, db: number, command: string, skipSafetyCheck?: boolean): Promise<RedisCommandResult> {
  return post("/api/redis/execute-command", {
    connectionId,
    db,
    command,
    skipSafetyCheck: skipSafetyCheck ?? false,
  });
}

export async function redisLoadMore(connectionId: string, db: number, keyRaw: string, keyType: string, cursor: number, count: number, filter?: string, sortDirection?: "asc" | "desc"): Promise<RedisCollectionPage> {
  return post("/api/redis/load-more", {
    connectionId,
    db,
    keyRaw,
    keyType,
    cursor,
    count,
    filter,
    sortDirection,
  });
}

export async function redisPubSubPublish(connectionId: string, db: number, channel: string, message: string): Promise<{ subscribers: number }> {
  return post("/api/redis/pubsub/publish", {
    connectionId,
    db,
    channel,
    message,
  });
}

export async function redisPubSubConnect(connectionId: string): Promise<WebSocket> {
  return new WebSocket(apiWebSocketUrl(`/api/redis/pubsub/ws?connectionId=${encodeURIComponent(connectionId)}`));
}

export async function redisSlowlogGet(connectionId: string, count: number, nodeHost?: string, nodePort?: number): Promise<RedisSlowlogEntry[]> {
  return post("/api/redis/slowlog-get", {
    connectionId,
    count,
    nodeHost,
    nodePort,
  });
}

export async function redisClusterMasterNodes(connectionId: string): Promise<RedisNodeEndpoint[]> {
  return post("/api/redis/cluster-master-nodes", { connectionId });
}

// ---------------------------------------------------------------------------
// etcd
// ---------------------------------------------------------------------------

export async function etcdListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null): Promise<KvListPrefixResponse> {
  return post("/api/etcd/list-prefix", {
    connectionId,
    prefix,
    limit,
    continuation,
    revision: options?.revision ?? null,
    includeValues: options?.includeValues ?? null,
  });
}

export async function etcdSupportsTtl(connectionId: string): Promise<boolean> {
  return post("/api/etcd/supports-ttl", { connectionId });
}

export async function etcdGet(connectionId: string, key: string, options?: KvGetOptions | null): Promise<KvGetResponse> {
  return post("/api/etcd/get", {
    connectionId,
    key,
    keyBytes: options?.keyBytes ?? null,
    revision: options?.revision ?? null,
    metadataOnly: options?.metadataOnly ?? null,
  });
}

export async function etcdPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | number | null): Promise<KvPutResponse> {
  const legacyLease = typeof options === "number" ? options : null;
  const putOptions = typeof options === "object" ? options : null;
  return post("/api/etcd/put", {
    connectionId,
    key,
    value,
    lease: legacyLease ?? putOptions?.lease ?? null,
    ttl: putOptions?.ttl ?? null,
    preserveLease: putOptions?.preserveLease ?? null,
    keyBytes: putOptions?.keyBytes ?? null,
    expectedModRevision: putOptions?.expectedModRevision ?? null,
    expectedCreateRevision: putOptions?.expectedCreateRevision ?? null,
  });
}

export async function etcdDelete(connectionId: string, key: string, options?: KvDeleteOptions | null): Promise<KvDeleteResponse> {
  return post("/api/etcd/delete", {
    connectionId,
    key,
    keyBytes: options?.keyBytes ?? null,
    expectedModRevision: options?.expectedModRevision ?? null,
  });
}

export async function etcdRename(
  connectionId: string,
  request: {
    key: string;
    keyBytes?: KvValue | null;
    newKey: string;
    expectedModRevision?: KvInt64 | null;
  },
): Promise<{ renamed: boolean; revision?: KvInt64 | null }> {
  return post("/api/etcd/rename", { connectionId, request });
}

export async function etcdHistory(
  connectionId: string,
  request: {
    key: string;
    keyBytes?: KvValue | null;
    startRevision?: KvInt64 | null;
    endRevision?: KvInt64 | null;
    limit: number;
  },
): Promise<KvHistoryResponse> {
  return post("/api/etcd/history", { connectionId, request });
}

export async function etcdStatus(connectionId: string): Promise<KvStatusResponse> {
  return post("/api/etcd/status", { connectionId });
}
export async function etcdPreflight(connectionId: string, action: string, params: Record<string, unknown>): Promise<import("./tauri").EtcdPreflightResponse> {
  return post("/api/etcd/preflight", { connectionId, request: { action, params } });
}
export async function etcdCompact(connectionId: string, revision: KvInt64, approval: import("./tauri").EtcdDangerousApproval): Promise<{ revision: KvInt64 }> {
  return post("/api/etcd/compact", { connectionId, revision, ...approval });
}
export async function etcdDefrag(connectionId: string, endpoints: string[], approval: import("./tauri").EtcdDangerousApproval): Promise<EtcdDefragResponse> {
  return post("/api/etcd/defrag", { connectionId, endpoints, ...approval });
}
export async function etcdWatchStart(connectionId: string, request: EtcdWatchStartRequest): Promise<EtcdWatchStartResponse> {
  return post("/api/etcd/watch/start", { connectionId, request });
}
export async function etcdWatchPoll(connectionId: string, watchId: string): Promise<EtcdWatchPollResponse> {
  return post("/api/etcd/watch/poll", { connectionId, watchId });
}
export async function etcdWatchStop(connectionId: string, watchId: string): Promise<{ stopped: boolean }> {
  return post("/api/etcd/watch/stop", { connectionId, watchId });
}
export async function etcdLeaseList(connectionId: string, limit = 100, continuation?: string | null): Promise<EtcdLeaseListResponse> {
  return post("/api/etcd/lease/list", { connectionId, limit, continuation: continuation ?? null });
}
export async function etcdLeaseCall<T = unknown>(connectionId: string, operation: "get" | "grant" | "keepalive" | "revoke", params: Record<string, unknown>, approval?: import("./tauri").EtcdDangerousApproval): Promise<T> {
  return post("/api/etcd/lease/call", { connectionId, operation, params, ...approval });
}
export async function etcdAuthCall<T = unknown>(connectionId: string, operation: string, params: Record<string, unknown>, approval?: import("./tauri").EtcdDangerousApproval): Promise<T> {
  return post("/api/etcd/auth/call", { connectionId, operation, params, ...approval });
}

// ---------------------------------------------------------------------------
// ZooKeeper
// ---------------------------------------------------------------------------

export async function zookeeperListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null): Promise<KvListPrefixResponse> {
  return post("/api/zookeeper/list-prefix", {
    connectionId,
    prefix,
    limit,
    continuation,
    recursive: options?.recursive ?? null,
  });
}

export async function zookeeperGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return post("/api/zookeeper/get", { connectionId, key });
}

export async function zookeeperPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null): Promise<KvPutResponse> {
  return post("/api/zookeeper/put", {
    connectionId,
    key,
    value,
    options: options ?? null,
  });
}

export async function zookeeperDelete(connectionId: string, key: string): Promise<KvDeleteResponse> {
  return post("/api/zookeeper/delete", { connectionId, key });
}

// ---------------------------------------------------------------------------
// Consul
// ---------------------------------------------------------------------------

export async function consulCapabilities(connectionId: string): Promise<import("@/types/consul").ConsulCapabilities> {
  return post("/api/consul/capabilities", { connectionId });
}

export async function consulTxn(connectionId: string, request: import("@/types/consul").ConsulTxnRequest): Promise<import("@/types/consul").ConsulTxnResult> {
  return post("/api/consul/txn", { connectionId, request });
}

export async function consulRenameKey(connectionId: string, source: string, target: string, expectedModifyIndex: KvInt64, copy = false): Promise<import("@/types/consul").ConsulTxnResult> {
  return post("/api/consul/rename-key", { connectionId, source, target, expectedModifyIndex, copy });
}

export async function consulBlockingQuery(connectionId: string, request: import("@/types/consul").ConsulBlockingRequest): Promise<import("@/types/consul").ConsulBlockingResponse> {
  return post("/api/consul/blocking-query", { connectionId, request });
}

export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "catalogServices" } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<Record<string, string[]>>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "catalogNodes" } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulCatalogNode[]>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "catalogServiceNodes"; service: string } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulCatalogServiceNode[]>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "catalogNodeServices"; node: string } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulNodeServices>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "healthNode"; node: string } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulHealthCheck[]>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "healthServiceChecks"; service: string } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulHealthCheck[]>>;
export function consulDomainWatch(
  connectionId: string,
  request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "healthServiceInstances"; service: string; passing: boolean | null } },
): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulServiceInstance[]>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest & { target: { kind: "healthState"; state: string } }): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulHealthCheck[]>>;
export function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulDomainWatchItems>>;
export async function consulDomainWatch(connectionId: string, request: import("@/types/consul").ConsulDomainWatchRequest): Promise<import("@/types/consul").ConsulDomainWatchResponse<import("@/types/consul").ConsulDomainWatchItems>> {
  return post("/api/consul/domain-watch", { connectionId, request });
}

export async function consulCancelBlocking(connectionId: string, scope: import("@/types/consul").ConsulScope, generation: number, operationId: string): Promise<boolean> {
  return post("/api/consul/cancel-blocking", { connectionId, scope, generation, operationId });
}

export async function consulWatchStart(connectionId: string, request: import("@/types/consul").ConsulBlockingRequest): Promise<string> {
  await consulBlockingQuery(connectionId, request);
  return request.operationId;
}

export async function consulListRecursive(connectionId: string, prefix: string, maxEntries = 10_000, maxValueBytes = 32 * 1024 * 1024): Promise<import("@/types/consul").ConsulRecursiveListResponse> {
  return post("/api/consul/list-recursive", { connectionId, prefix, maxEntries, maxValueBytes });
}

export async function consulSearch(connectionId: string, request: import("@/types/consul").ConsulSearchRequest): Promise<import("@/types/consul").ConsulSearchResponse> {
  return post("/api/consul/search", { connectionId, request });
}

export async function consulSearchProgress(connectionId: string, requestId: string, scope: import("@/types/consul").ConsulScope, generation: number): Promise<import("@/types/consul").ConsulSearchProgress> {
  return post("/api/consul/search-progress", { connectionId, requestId, scope, generation });
}

export async function consulCancelSearch(connectionId: string, requestId: string, scope: import("@/types/consul").ConsulScope, generation: number): Promise<boolean> {
  return post("/api/consul/cancel-search", { connectionId, requestId, scope, generation });
}

export async function consulExportBundle(connectionId: string, request: import("@/types/consul").ConsulExportRequest): Promise<import("@/types/consul").ConsulKvBundle> {
  return post("/api/consul/export-bundle", { connectionId, request });
}

export async function consulImportPreview(connectionId: string, request: import("@/types/consul").ConsulImportRequest): Promise<import("@/types/consul").ConsulImportPreview> {
  return post("/api/consul/import-preview", { connectionId, request });
}

export async function consulImportExecute(connectionId: string, request: import("@/types/consul").ConsulImportRequest): Promise<import("@/types/consul").ConsulImportReport> {
  return post("/api/consul/import-execute", { connectionId, request });
}

export async function consulDeletePrefixPreview(connectionId: string, prefix: string): Promise<import("@/types/consul").ConsulDeletePrefixPreview> {
  return post("/api/consul/delete-prefix-preview", { connectionId, prefix });
}

export async function consulDeletePrefixExecute(connectionId: string, request: import("@/types/consul").ConsulDeletePrefixRequest): Promise<import("@/types/consul").ConsulDeletePrefixReport> {
  return post("/api/consul/delete-prefix-execute", { connectionId, request });
}

export async function consulListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null): Promise<KvListPrefixResponse> {
  return post("/api/consul/list-prefix", { connectionId, prefix, limit, continuation: continuation ?? null });
}

export async function consulGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return post("/api/consul/get", { connectionId, key });
}

export async function consulPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null): Promise<KvPutResponse> {
  return post("/api/consul/put", { connectionId, key, value, options: options ?? null });
}

export async function consulDelete(connectionId: string, key: string, options?: KvDeleteOptions | null): Promise<KvDeleteResponse> {
  return post("/api/consul/delete", { connectionId, key, options: options ?? null });
}

export async function consulPreparedQueryList(connectionId: string): Promise<import("@/types/consul").ConsulPreparedQuery[]> {
  return post("/api/consul/prepared-query/list", { connectionId });
}
export async function consulPreparedQueryRead(connectionId: string, id: string): Promise<import("@/types/consul").ConsulPreparedQuery> {
  return post("/api/consul/prepared-query/read", { connectionId, id });
}
export async function consulPreparedQueryCreate(connectionId: string, input: import("@/types/consul").ConsulPreparedQueryInput): Promise<string> {
  return post("/api/consul/prepared-query/create", { connectionId, input });
}
export async function consulPreparedQueryUpdate(connectionId: string, id: string, input: import("@/types/consul").ConsulPreparedQueryInput): Promise<void> {
  await post("/api/consul/prepared-query/update", { connectionId, id, input });
}
export async function consulPreparedQueryDelete(connectionId: string, id: string): Promise<void> {
  await post("/api/consul/prepared-query/delete", { connectionId, id });
}
export async function consulPreparedQueryExecute(connectionId: string, request: import("@/types/consul").ConsulPreparedQueryExecuteRequest): Promise<import("@/types/consul").ConsulPreparedQueryExecuteResponse> {
  return post("/api/consul/prepared-query/execute", { connectionId, request });
}
export async function consulPreparedQueryExplain(connectionId: string, query: string): Promise<unknown> {
  return post("/api/consul/prepared-query/explain", { connectionId, id: query });
}
export async function consulEventList(connectionId: string, name?: string | null): Promise<import("@/types/consul").ConsulEvent[]> {
  return post("/api/consul/event/list", { connectionId, name: name ?? null });
}
export async function consulEventFire(connectionId: string, request: import("@/types/consul").ConsulEventFireRequest): Promise<import("@/types/consul").ConsulEvent> {
  return post("/api/consul/event/fire", { connectionId, request });
}
export async function consulCoordinateNodes(connectionId: string): Promise<import("@/types/consul").ConsulCoordinate[]> {
  return post("/api/consul/coordinate/nodes", { connectionId });
}
export async function consulOperatorRead(connectionId: string, kind: import("@/types/consul").ConsulOperatorReadKind): Promise<import("@/types/consul").ConsulOperatorDocument> {
  return post("/api/consul/operator/read", { connectionId, kind });
}
export async function consulSnapshotGenerate(connectionId: string): Promise<import("@/types/consul").ConsulSnapshot> {
  return post("/api/consul/operator/snapshot/generate", { connectionId });
}
export async function consulSnapshotRestore(connectionId: string, request: import("@/types/consul").ConsulSnapshotRestoreRequest): Promise<void> {
  await post("/api/consul/operator/snapshot/restore", { connectionId, request });
}
export async function consulAutopilotUpdate(connectionId: string, update: import("@/types/consul").ConsulAutopilotUpdate, confirmation: string): Promise<void> {
  await post("/api/consul/operator/autopilot/update", { connectionId, update, confirmation });
}
export async function consulRaftTransfer(connectionId: string, request: import("@/types/consul").ConsulRaftWriteRequest): Promise<void> {
  await post("/api/consul/operator/raft/transfer", { connectionId, request });
}
export async function consulRaftRemove(connectionId: string, request: import("@/types/consul").ConsulRaftWriteRequest): Promise<void> {
  await post("/api/consul/operator/raft/remove", { connectionId, request });
}
export async function consulKeyringWrite(connectionId: string, request: import("@/types/consul").ConsulKeyringWriteRequest): Promise<void> {
  await post("/api/consul/operator/keyring/write", { connectionId, request });
}
export async function consulLicenseWrite(connectionId: string, request: import("@/types/consul").ConsulLicenseWriteRequest): Promise<void> {
  await post("/api/consul/operator/license/write", { connectionId, request });
}

export async function consulStatusLeader(connectionId: string): Promise<string> {
  return post("/api/consul/status/leader", { connectionId });
}
export async function consulStatusPeers(connectionId: string): Promise<string[]> {
  return post("/api/consul/status/peers", { connectionId });
}
export async function consulAgentSelf(connectionId: string): Promise<import("@/types/consul").ConsulAgentIdentity> {
  return post("/api/consul/agent/self", { connectionId });
}
export async function consulAgentMembers(connectionId: string, wan = false, segment?: string | null): Promise<import("@/types/consul").ConsulAgentMember[]> {
  return post("/api/consul/agent/members", { connectionId, wan, segment: segment ?? null });
}
export async function consulAgentMetrics(connectionId: string): Promise<unknown> {
  return post("/api/consul/agent/metrics", { connectionId });
}
export async function consulCatalogDatacenters(connectionId: string): Promise<string[]> {
  return post("/api/consul/catalog/datacenters", { connectionId });
}
export async function consulCatalogNodes(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulCatalogNode[]>> {
  return post("/api/consul/catalog/nodes", { connectionId, options });
}
export async function consulCatalogServices(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<Record<string, string[]>>> {
  return post("/api/consul/catalog/services", { connectionId, options });
}
export async function consulCatalogServiceNodes(connectionId: string, service: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulCatalogServiceNode[]>> {
  return post("/api/consul/catalog/service-nodes", { connectionId, name: service, options });
}
export async function consulCatalogNodeServices(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulNodeServices>> {
  return post("/api/consul/catalog/node-services", { connectionId, name: node, options });
}
export async function consulHealthNode(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return post("/api/consul/health/node", { connectionId, name: node, options });
}
export async function consulHealthChecks(connectionId: string, service: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return post("/api/consul/health/checks", { connectionId, name: service, options });
}
export async function consulHealthService(connectionId: string, service: string, passing: boolean | null = null, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulServiceInstance[]>> {
  return post("/api/consul/health/service", { connectionId, name: service, passing, options });
}
export async function consulHealthState(connectionId: string, healthState: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return post("/api/consul/health/state", { connectionId, name: healthState, options });
}
export async function consulAgentServices(connectionId: string): Promise<Record<string, import("@/types/consul").ConsulAgentService>> {
  return post("/api/consul/agent/services", { connectionId });
}
export async function consulAgentService(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentService> {
  return post("/api/consul/agent/service", { connectionId, id });
}
export async function consulAgentChecks(connectionId: string): Promise<Record<string, import("@/types/consul").ConsulHealthCheck>> {
  return post("/api/consul/agent/checks", { connectionId });
}
export async function consulAgentRegisterService(connectionId: string, registration: import("@/types/consul").ConsulAgentServiceRegistration): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/service/register", { connectionId, registration });
}
export async function consulAgentDeregisterService(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/service/deregister", { connectionId, id });
}
export async function consulAgentServiceMaintenance(connectionId: string, id: string, enable: boolean, reason?: string | null): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/service/maintenance", { connectionId, id, enable, reason: reason ?? null });
}
export async function consulAgentRegisterCheck(connectionId: string, registration: import("@/types/consul").ConsulAgentCheckRegistration): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/check/register", { connectionId, registration });
}
export async function consulAgentDeregisterCheck(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/check/deregister", { connectionId, id });
}
export async function consulAgentUpdateTtl(connectionId: string, id: string, status: import("@/types/consul").ConsulCheckStatus, output?: string | null): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return post("/api/consul/agent/check/ttl", { connectionId, id, status, output: output ?? null });
}
export async function consulSessions(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulSession[]>> {
  return post("/api/consul/sessions", { connectionId, options });
}
export async function consulNodeSessions(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulSession[]>> {
  return post("/api/consul/sessions/node", { connectionId, name: node, options });
}
export async function consulSession(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSession | null> {
  return post("/api/consul/session", { connectionId, id });
}
export async function consulSessionKeys(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSessionKeysResponse> {
  return post("/api/consul/session/keys", { connectionId, id });
}
export async function consulSessionDestroyImpact(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSessionDestroyImpact> {
  return post("/api/consul/session/destroy-impact", { connectionId, id });
}
export async function consulCreateSession(connectionId: string, request: import("@/types/consul").ConsulSessionCreateRequest): Promise<import("@/types/consul").ConsulSession> {
  return post("/api/consul/session/create", { connectionId, request });
}
export async function consulRenewSession(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSession> {
  return post("/api/consul/session/renew", { connectionId, id });
}
export async function consulDestroySession(connectionId: string, request: import("@/types/consul").ConsulSessionDestroyRequest): Promise<boolean> {
  return post("/api/consul/session/destroy", { connectionId, request });
}
export async function consulAcquireLock(connectionId: string, request: import("@/types/consul").ConsulLockRequest): Promise<import("@/types/consul").ConsulLockResponse> {
  return post("/api/consul/lock/acquire", { connectionId, request });
}
export async function consulReleaseLock(connectionId: string, key: string, session: string): Promise<import("@/types/consul").ConsulLockResponse> {
  return post("/api/consul/lock/release", { connectionId, key, session });
}

export async function consulAclList(connectionId: string, kind: import("@/types/consul").ConsulAclKind): Promise<import("@/types/consul").ConsulAclList> {
  return post("/api/consul/acl/list", { connectionId, kind });
}
export async function consulAclTokenSelf(connectionId: string): Promise<import("@/types/consul").ConsulAclToken> {
  return post("/api/consul/acl/token/self", { connectionId });
}
export async function consulAclTokenClone(connectionId: string, accessorId: string, description: string): Promise<import("@/types/consul").ConsulAclToken> {
  return post("/api/consul/acl/token/clone", { connectionId, id: accessorId, description });
}
export async function consulAclGet(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclItem> {
  return post("/api/consul/acl/get", { connectionId, kind, id });
}
export async function consulAclApply(connectionId: string, id: string | null, value: import("@/types/consul").ConsulAclWrite): Promise<import("@/types/consul").ConsulAclItem> {
  return post("/api/consul/acl/apply", { connectionId, id, value });
}
export async function consulAclReferences(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclReferences> {
  return post("/api/consul/acl/references", { connectionId, kind, id });
}
export async function consulAclDelete(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclReferences> {
  return post("/api/consul/acl/delete", { connectionId, kind, id });
}
export async function consulEnterpriseList(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind): Promise<import("@/types/consul").ConsulEnterpriseList> {
  return post("/api/consul/enterprise/list", { connectionId, kind });
}
export async function consulEnterpriseGet(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulEnterpriseItem> {
  return post("/api/consul/enterprise/get", { connectionId, kind, name });
}
export async function consulEnterpriseApply(connectionId: string, existingName: string | null, item: import("@/types/consul").ConsulEnterpriseWrite): Promise<import("@/types/consul").ConsulEnterpriseItem> {
  return post("/api/consul/enterprise/apply", { connectionId, existingName, item });
}
export async function consulEnterpriseImpact(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulScopeImpact> {
  return post("/api/consul/enterprise/impact", { connectionId, kind, name });
}
export async function consulEnterpriseDelete(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulScopeImpact> {
  return post("/api/consul/enterprise/delete", { connectionId, kind, name });
}
export async function consulMeshConfigList(connectionId: string, kind: string): Promise<import("@/types/consul").ConsulConfigEntry[]> {
  return post("/api/consul/mesh/config/list", { connectionId, kind });
}
export async function consulMeshConfigGet(connectionId: string, kind: string, name: string): Promise<import("@/types/consul").ConsulConfigEntry> {
  return post("/api/consul/mesh/config/get", { connectionId, kind, name });
}
export async function consulMeshConfigApply(connectionId: string, request: import("@/types/consul").ConsulConfigEntryApply): Promise<import("@/types/consul").ConsulConfigEntry> {
  return post("/api/consul/mesh/config/apply", { connectionId, request });
}
export async function consulMeshConfigDelete(connectionId: string, kind: string, name: string, expectedModifyIndex: number): Promise<boolean> {
  return post("/api/consul/mesh/config/delete", { connectionId, kind, name, expectedModifyIndex });
}
export async function consulMeshIntentionsList(connectionId: string): Promise<import("@/types/consul").ConsulIntention[]> {
  return post("/api/consul/mesh/intentions/list", { connectionId });
}
export async function consulMeshIntentionGet(connectionId: string, id: string): Promise<import("@/types/consul").ConsulIntention> {
  return post("/api/consul/mesh/intentions/get", { connectionId, id });
}
export async function consulMeshIntentionGetExact(connectionId: string, request: import("@/types/consul").ConsulIntentionExactRequest): Promise<import("@/types/consul").ConsulIntention> {
  return post("/api/consul/mesh/intentions/get-exact", { connectionId, exactRequest: request });
}
export async function consulMeshIntentionUpsert(connectionId: string, item: import("@/types/consul").ConsulIntention): Promise<import("@/types/consul").ConsulIntention> {
  return post("/api/consul/mesh/intentions/upsert", { connectionId, intention: item });
}
export async function consulMeshIntentionDelete(connectionId: string, id: string): Promise<boolean> {
  return post("/api/consul/mesh/intentions/delete", { connectionId, id });
}
export async function consulMeshIntentionDeleteExact(connectionId: string, request: import("@/types/consul").ConsulIntentionExactRequest): Promise<boolean> {
  return post("/api/consul/mesh/intentions/delete-exact", { connectionId, exactRequest: request });
}
export async function consulMeshIntentionMatch(connectionId: string, request: import("@/types/consul").ConsulIntentionMatchRequest): Promise<import("@/types/consul").ConsulIntention[]> {
  return post("/api/consul/mesh/intentions/match", { connectionId, matchRequest: request });
}
export async function consulMeshIntentionCheck(connectionId: string, request: import("@/types/consul").ConsulIntentionCheckRequest): Promise<import("@/types/consul").ConsulIntentionCheckResponse> {
  return post("/api/consul/mesh/intentions/check", { connectionId, checkRequest: request });
}
export async function consulMeshDiscoveryChain(connectionId: string, service: string): Promise<import("@/types/consul").ConsulDiscoveryChain> {
  return post("/api/consul/mesh/discovery-chain", { connectionId, service });
}
export async function consulMeshPeeringList(connectionId: string): Promise<import("@/types/consul").ConsulPeering[]> {
  return post("/api/consul/mesh/peerings/list", { connectionId });
}
export async function consulMeshPeeringGet(connectionId: string, name: string): Promise<import("@/types/consul").ConsulPeering> {
  return post("/api/consul/mesh/peerings/get", { connectionId, name });
}
export async function consulMeshPeeringGenerateToken(connectionId: string, request: import("@/types/consul").ConsulPeeringGenerateRequest): Promise<import("@/types/consul").ConsulPeeringToken> {
  return post("/api/consul/mesh/peerings/generate-token", { connectionId, generateRequest: request });
}
export async function consulMeshPeeringEstablish(connectionId: string, request: import("@/types/consul").ConsulPeeringEstablishRequest): Promise<import("@/types/consul").ConsulPeering> {
  return post("/api/consul/mesh/peerings/establish", { connectionId, establishRequest: request });
}
export async function consulMeshPeeringDelete(connectionId: string, name: string): Promise<boolean> {
  return post("/api/consul/mesh/peerings/delete", { connectionId, name });
}
export async function consulMeshExportedServicesList(connectionId: string): Promise<import("@/types/consul").ConsulExportedService[]> {
  return post("/api/consul/mesh/exported-services/list", { connectionId });
}
export async function consulMeshExportedServicesApply(connectionId: string, name: string, expectedModifyIndex: number, raw: Record<string, unknown>): Promise<import("@/types/consul").ConsulConfigEntry> {
  return post("/api/consul/mesh/exported-services/apply", { connectionId, name, expectedModifyIndex, raw });
}

// ---------------------------------------------------------------------------
// Nacos
// ---------------------------------------------------------------------------

export async function nacosTestConnection(connectionId: string): Promise<NacosConnectionInfo> {
  return post("/api/nacos/test-connection", { connectionId });
}

export async function nacosListNamespaces(connectionId: string): Promise<NacosNamespaceInfo[]> {
  return post("/api/nacos/namespaces/list", { connectionId });
}

export async function nacosCreateNamespace(connectionId: string, req: NacosNamespaceCreate): Promise<void> {
  return post("/api/nacos/namespaces/create", { connectionId, req });
}

export async function nacosUpdateNamespace(connectionId: string, req: NacosNamespaceUpdate): Promise<void> {
  return post("/api/nacos/namespaces/update", { connectionId, req });
}

export async function nacosListConfigs(connectionId: string, query: NacosConfigQuery): Promise<NacosConfigList> {
  return post("/api/nacos/configs/list", { connectionId, query });
}

export async function nacosGetConfig(connectionId: string, key: NacosConfigKey): Promise<NacosConfigItem> {
  return post("/api/nacos/configs/get", { connectionId, key });
}

export async function nacosPublishConfig(connectionId: string, req: NacosConfigUpsert): Promise<void> {
  return post("/api/nacos/configs/publish", { connectionId, req });
}

export async function nacosDeleteConfig(connectionId: string, key: NacosConfigKey): Promise<void> {
  return post("/api/nacos/configs/delete", { connectionId, key });
}

export async function nacosSearchConfigContent(connectionId: string, req: NacosContentSearchRequest, onProgress?: (progress: NacosSearchProgress) => void): Promise<NacosContentSearchResult> {
  const response = await fetch(apiUrl("/api/nacos/configs/search"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, req }),
  });
  if (!response.ok) throw await backendResponseError(response);
  if (!response.body) throw new Error("Nacos content search did not return a response stream");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: NacosContentSearchResult | null = null;

  const consumeLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    const event = JSON.parse(data) as { type: "progress"; progress: NacosSearchProgress } | { type: "result"; result: NacosContentSearchResult } | { type: "error"; error: string };
    if (event.type === "progress") onProgress?.(event.progress);
    else if (event.type === "result") result = event.result;
    else throw new Error(event.error);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    if (!result) throw new Error("Nacos content search stream ended without a final result");
    return result;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function nacosCancelConfigContentSearch(operationId: string): Promise<boolean> {
  const result = await post<{ cancelled: boolean }>("/api/nacos/configs/search/cancel", { operationId });
  return result.cancelled;
}

export async function nacosExportConfigs(connectionId: string, selector: NacosConfigSelector, _destination: string, fileName = "nacos-configs.zip"): Promise<void> {
  const response = await fetch(apiUrl("/api/nacos/configs/export"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connectionId, selector, fileName }),
  });
  if (!response.ok) throw await backendResponseError(response);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function nacosPreviewConfigImport(connectionId: string, targetNamespace: string, archivePath: string | File): Promise<NacosBatchPreview> {
  if (!(archivePath instanceof File)) throw new Error("Nacos ZIP import in web mode requires a File object");
  const formData = new FormData();
  formData.append("connectionId", connectionId);
  formData.append("targetNamespace", targetNamespace);
  formData.append("file", archivePath, archivePath.name);
  const response = await fetch(apiUrl("/api/nacos/configs/import/preview"), {
    method: "POST",
    body: formData,
  });
  if (!response.ok) throw await backendResponseError(response);
  return response.json();
}

export async function nacosApplyConfigImport(connectionId: string, operationId: string, targetNamespace: string, _archivePath: string | File, planHash: string, conflictPolicy: NacosConflictPolicy, archiveToken?: string): Promise<NacosBatchReport> {
  if (!archiveToken) throw new Error("The Nacos import preview token is missing or expired");
  return post("/api/nacos/configs/import/apply", {
    connectionId,
    operationId,
    targetNamespace,
    archiveToken,
    planHash,
    conflictPolicy,
  });
}

export async function nacosPreviewConfigTransfer(req: NacosConfigTransferRequest): Promise<NacosBatchPreview> {
  return post("/api/nacos/configs/copy/preview", { req });
}

export async function nacosApplyConfigTransfer(req: NacosConfigTransferRequest, planHash: string): Promise<NacosBatchReport> {
  return post("/api/nacos/configs/copy/apply", { req, planHash });
}

export async function nacosListConfigHistory(connectionId: string, query: NacosConfigHistoryQuery): Promise<NacosConfigHistoryList> {
  return post("/api/nacos/configs/history/list", { connectionId, query });
}

export async function nacosGetConfigHistory(connectionId: string, key: NacosConfigHistoryKey): Promise<NacosConfigItem> {
  return post("/api/nacos/configs/history/get", { connectionId, key });
}

export async function nacosRollbackConfig(connectionId: string, req: NacosConfigRollbackRequest): Promise<void> {
  return post("/api/nacos/configs/history/rollback", { connectionId, req });
}

export async function nacosGetRNacosConsoleCaptcha(connectionId: string): Promise<NacosRNacosConsoleCaptcha> {
  return post("/api/nacos/rnacos-console/captcha", { connectionId });
}

export async function nacosLoginRNacosConsole(connectionId: string, captcha?: string): Promise<void> {
  return post("/api/nacos/rnacos-console/login", { connectionId, captcha });
}

export async function nacosListServices(connectionId: string, query: NacosServiceQuery): Promise<NacosServiceList> {
  return post("/api/nacos/services/list", { connectionId, query });
}

export async function nacosGetService(connectionId: string, query: NacosServiceQuery): Promise<NacosServiceDetail> {
  return post("/api/nacos/services/get", { connectionId, query });
}

export async function nacosCreateService(connectionId: string, req: NacosServiceUpsert): Promise<void> {
  return post("/api/nacos/services/create", { connectionId, req });
}

export async function nacosUpdateService(connectionId: string, req: NacosServiceUpsert): Promise<void> {
  return post("/api/nacos/services/update", { connectionId, req });
}

export async function nacosDeleteService(connectionId: string, query: NacosServiceQuery): Promise<void> {
  return post("/api/nacos/services/delete", { connectionId, query });
}

export async function nacosListInstances(connectionId: string, query: NacosInstanceQuery): Promise<NacosInstanceInfo[]> {
  return post("/api/nacos/instances/list", { connectionId, query });
}

export async function nacosUpdateInstance(connectionId: string, req: NacosInstanceUpdateRequest): Promise<void> {
  return post("/api/nacos/instances/update", { connectionId, req });
}

export async function nacosRegisterInstance(connectionId: string, req: NacosInstanceRegistration): Promise<void> {
  return post("/api/nacos/instances/register", { connectionId, req });
}

export async function nacosDeregisterInstance(connectionId: string, req: NacosInstanceRef): Promise<void> {
  return post("/api/nacos/instances/deregister", { connectionId, req });
}

export async function nacosGetDashboard(connectionId: string, query: NacosDashboardQuery): Promise<NacosDashboardSnapshot> {
  return post("/api/nacos/dashboard", { connectionId, query });
}

export async function nacosRawRequest(connectionId: string, req: NacosRawRequest): Promise<NacosRawResponse> {
  return post("/api/nacos/raw", { connectionId, req });
}

// ---------------------------------------------------------------------------
// HBase
// ---------------------------------------------------------------------------

export async function hbaseGetTableSchema(connectionId: string, namespace: string, table: string): Promise<import("@/types/hbase").HBaseTableSchema> {
  return post("/api/hbase/table-schema", { connectionId, namespace, table });
}

export async function hbaseScanRows(connectionId: string, namespace: string, table: string, rowKeyPrefix: string | undefined, limit: number): Promise<import("@/types/hbase").HBaseScanResult> {
  return post("/api/hbase/scan-rows", {
    connectionId,
    namespace,
    table,
    rowKeyPrefix,
    limit,
  });
}

export async function hbaseGetRow(connectionId: string, namespace: string, table: string, rowKey: string, rowKeyEncoding?: import("@/types/hbase").HBaseValueEncoding): Promise<import("@/types/hbase").HBaseRow | null> {
  return post("/api/hbase/get-row", {
    connectionId,
    namespace,
    table,
    rowKey,
    rowKeyEncoding,
  });
}

export async function hbasePutRow(connectionId: string, namespace: string, table: string, input: import("@/types/hbase").HBasePutRowInput): Promise<void> {
  return post("/api/hbase/put-row", { connectionId, namespace, table, input });
}

export async function hbaseDeleteRow(connectionId: string, namespace: string, table: string, rowKey: string, rowKeyEncoding?: import("@/types/hbase").HBaseValueEncoding): Promise<void> {
  return post("/api/hbase/delete-row", {
    connectionId,
    namespace,
    table,
    rowKey,
    rowKeyEncoding,
  });
}

export async function hbaseCreateTable(connectionId: string, namespace: string, table: string, columnFamilies: string[]): Promise<void> {
  return post("/api/hbase/create-table", {
    connectionId,
    namespace,
    table,
    columnFamilies,
  });
}

export async function hbaseDeleteTable(connectionId: string, namespace: string, table: string): Promise<void> {
  return post("/api/hbase/delete-table", { connectionId, namespace, table });
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------

export async function documentListDatabases(connectionId: string): Promise<string[]> {
  return post("/api/document-store/list-databases", { connectionId });
}

export async function mongoListDatabases(connectionId: string): Promise<string[]> {
  return documentListDatabases(connectionId);
}

export async function documentListCollections(connectionId: string, database: string): Promise<CollectionInfo[]> {
  return post("/api/document-store/list-collections", {
    connectionId,
    database,
  });
}

export async function mongoListCollections(connectionId: string, database: string): Promise<CollectionInfo[]> {
  return documentListCollections(connectionId, database);
}

export async function mongoCreateDatabase(connectionId: string, database: string): Promise<void> {
  await post("/api/mongo/create-database", { connectionId, database });
}

export async function mongoDropDatabase(connectionId: string, database: string): Promise<void> {
  await post("/api/mongo/drop-database", { connectionId, database });
}

export async function mongoDropCollection(connectionId: string, database: string, collection: string): Promise<void> {
  await post("/api/mongo/drop-collection", {
    connectionId,
    database,
    collection,
  });
}

export async function mongoRenameCollection(connectionId: string, database: string, collection: string, newName: string): Promise<void> {
  await post("/api/mongo/rename-collection", {
    connectionId,
    database,
    collection,
    newName,
  });
}

export async function mongoCloneCollection(connectionId: string, database: string, sourceCollection: string, targetCollection: string): Promise<MongoCloneCollectionResult> {
  return post("/api/mongo/clone-collection", {
    connectionId,
    database,
    sourceCollection,
    targetCollection,
  });
}

export async function elasticsearchListIndices(connectionId: string): Promise<string[]> {
  const collections = await documentListCollections(connectionId, "default");
  return collections.map((c) => c.name);
}

export async function vectorListCollections(connectionId: string, database?: string): Promise<CollectionInfo[]> {
  return documentListCollections(connectionId, database || "default");
}

export async function vectorGetCollectionDetail(connectionId: string, database: string, collection: string): Promise<CollectionInfo> {
  return post("/api/mongo/vector-collection-detail", {
    connectionId,
    database,
    collection,
  });
}

export async function mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, collation?: string, executionId?: string): Promise<MongoDocumentResult> {
  return documentFindDocuments(connectionId, database, collection, skip, limit, filter, projection, sort, collation, executionId);
}

export async function mongoParseShellCommand(source: string): Promise<MongoCommand> {
  const raw = await post<Record<string, unknown>>("/api/mongo/parse-shell-command", { source });
  return normalizeRustMongoCommand(raw);
}

export async function mongoFindOne(connectionId: string, database: string, collection: string, filter?: string, projection?: string, options?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one", {
    connectionId,
    database,
    collection,
    filter,
    projection,
    options,
    executionId,
  });
}

export async function documentFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, collation?: string, executionId?: string): Promise<DocumentQueryResult> {
  return post("/api/document-store/find-documents", {
    connectionId,
    database,
    collection,
    skip,
    limit,
    filter,
    projection,
    sort,
    collation,
    executionId,
  });
}

export async function elasticsearchCountDocuments(connectionId: string, index: string, filter?: string, executionId?: string): Promise<number> {
  return post("/api/document-store/elasticsearch-count-documents", {
    connectionId,
    index,
    filter,
    executionId,
  });
}

export async function mongoCountDocuments(connectionId: string, database: string, collection: string, filter?: string, mode?: "accurate" | "legacy", executionId?: string): Promise<number> {
  return post("/api/mongo/count-documents", {
    connectionId,
    database,
    collection,
    filter,
    mode,
    executionId,
  });
}

export async function documentListGridFsFiles(connectionId: string, database: string, bucket: string, filter?: string, sort?: string): Promise<MongoGridFsFileInfo[]> {
  return post("/api/document-store/list-gridfs-files", {
    connectionId,
    database,
    bucket,
    filter,
    sort,
  });
}

export async function documentListGridFsBuckets(connectionId: string, database: string, filter?: string, sort?: string): Promise<MongoGridFsBucketInfo[]> {
  return post("/api/document-store/list-gridfs-buckets", {
    connectionId,
    database,
    filter,
    sort,
  });
}

export async function documentCreateGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return post("/api/document-store/create-gridfs-bucket", {
    connectionId,
    database,
    bucket,
  });
}

export async function documentDeleteGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return post("/api/document-store/delete-gridfs-bucket", {
    connectionId,
    database,
    bucket,
  });
}

export async function documentDownloadGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(apiUrl("/api/document-store/download-gridfs-file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, database, bucket, fileId }),
  });
  if (!res.ok) throw await backendResponseError(res);
  const data = (await res.json()) as number[];
  return new Uint8Array(data);
}

export async function documentUploadGridFsFile(connectionId: string, database: string, bucket: string, fileName: string, data: Uint8Array, contentType?: string): Promise<string> {
  const body = new FormData();
  body.append("connectionId", connectionId);
  body.append("database", database);
  body.append("bucket", bucket);
  body.append("fileName", fileName);
  if (contentType) body.append("contentType", contentType);
  const bytes = new Uint8Array(data.byteLength);
  bytes.set(data);
  body.append("file", new Blob([bytes], { type: contentType || "application/octet-stream" }), fileName);
  const res = await fetch(apiUrl("/api/document-store/upload-gridfs-file"), {
    method: "POST",
    body,
  });
  if (!res.ok) throw await backendResponseError(res);
  return res.json();
}

export async function documentDeleteGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<void> {
  return post("/api/document-store/delete-gridfs-file", {
    connectionId,
    database,
    bucket,
    fileId,
  });
}

export async function mongoServerVersion(connectionId: string, database: string, executionId?: string): Promise<string> {
  return post("/api/mongo/server-version", {
    connectionId,
    database,
    executionId,
  });
}

export async function mongoAggregateDocuments(connectionId: string, database: string, collection: string, pipelineJson: string, maxRows?: number, optionsJson?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/aggregate-documents", {
    connectionId,
    database,
    collection,
    pipelineJson,
    maxRows,
    optionsJson,
    executionId,
  });
}

export async function mongoDistinct(connectionId: string, database: string, collection: string, field: string, filter?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/distinct", {
    connectionId,
    database,
    collection,
    field,
    filter,
    executionId,
  });
}

export async function mongoCollectionStats(connectionId: string, database: string, collection: string, scale?: number, executionId?: string): Promise<MongoCollectionStatsResult> {
  return post("/api/mongo/collection-stats", {
    connectionId,
    database,
    collection,
    scale,
    executionId,
  });
}

export async function mongoCreateIndex(connectionId: string, database: string, collection: string, keysJson: string, optionsJson?: string): Promise<{ name: string }> {
  return post("/api/mongo/create-index", {
    connectionId,
    database,
    collection,
    keysJson,
    optionsJson,
  });
}

export async function mongoCreateUser(connectionId: string, database: string, userJson: string, writeConcernJson?: string): Promise<{ affected_rows: number }> {
  return post("/api/mongo/create-user", {
    connectionId,
    database,
    userJson,
    writeConcernJson,
  });
}

export async function mongoDropIndexes(connectionId: string, database: string, collection: string, indexesJson?: string, single = false): Promise<MongoDropIndexesResult> {
  return post("/api/mongo/drop-indexes", {
    connectionId,
    database,
    collection,
    indexesJson,
    single,
  });
}

export async function mongoInsertDocument(connectionId: string, database: string, collection: string, docJson: string, routing?: string): Promise<string> {
  return documentInsertDocument(connectionId, database, collection, docJson, routing);
}

export async function documentInsertDocument(connectionId: string, database: string, collection: string, docJson: string, routing?: string, preserveBsonTypes?: boolean): Promise<string> {
  return post("/api/document-store/insert-document", {
    connectionId,
    database,
    collection,
    docJson,
    routing,
    preserveBsonTypes,
  });
}

export async function mongoInsertDocuments(connectionId: string, database: string, collection: string, docsJson: string): Promise<{ affected_rows: number }> {
  return post("/api/mongo/insert-documents", {
    connectionId,
    database,
    collection,
    docsJson,
  });
}

export async function mongoUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return documentUpdateDocument(connectionId, database, collection, id, docJson, routing);
}

export async function documentUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return post("/api/document-store/update-document", {
    connectionId,
    database,
    collection,
    id,
    docJson,
    routing,
  });
}

export async function mongoUpdateDocuments(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, many: boolean, optionsJson?: string): Promise<{ affected_rows: number }> {
  return post("/api/mongo/update-documents", {
    connectionId,
    database,
    collection,
    filterJson,
    updateJson,
    many,
    optionsJson,
  });
}

export async function mongoDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string): Promise<number> {
  return documentDeleteDocument(connectionId, database, collection, id, routing);
}

export async function documentDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string, documentType?: string): Promise<number> {
  return post("/api/document-store/delete-document", {
    connectionId,
    database,
    collection,
    id,
    routing,
    documentType,
  });
}

export async function mongoDeleteDocuments(connectionId: string, database: string, collection: string, filterJson: string, many: boolean): Promise<{ affected_rows: number }> {
  return post("/api/mongo/delete-documents", {
    connectionId,
    database,
    collection,
    filterJson,
    many,
  });
}

export async function mongoFindOneAndUpdate(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-update", {
    connectionId,
    database,
    collection,
    filterJson,
    updateJson,
    optionsJson,
  });
}

export async function mongoFindOneAndReplace(connectionId: string, database: string, collection: string, filterJson: string, replacementJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-replace", {
    connectionId,
    database,
    collection,
    filterJson,
    replacementJson,
    optionsJson,
  });
}

export async function mongoFindOneAndDelete(connectionId: string, database: string, collection: string, filterJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-delete", {
    connectionId,
    database,
    collection,
    filterJson,
    optionsJson,
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return post("/api/history/save", { entry });
}

export async function loadHistory(limit: number, offset: number, activityKind?: string): Promise<HistoryEntry[]> {
  return get(`/api/history?${qs({ limit, offset, activity_kind: activityKind })}`);
}

export async function searchHistory(request: HistorySearchRequest): Promise<HistorySearchResult> {
  return post("/api/history/search", request);
}

export async function loadHistoryConnectionOptions(): Promise<HistoryConnectionOption[]> {
  return get("/api/history/options");
}

export async function loadRedisHistory(limit = 100, offset = 0): Promise<HistoryEntry[]> {
  return loadHistory(limit, offset, "redis_command");
}

export async function clearHistory(): Promise<void> {
  return del("/api/history");
}

export async function clearRedisHistory(): Promise<void> {
  const entries = await loadRedisHistory(1000, 0);
  await Promise.all(entries.map((e) => deleteHistoryEntry(e.id)));
}

export async function deleteHistoryEntry(id: string): Promise<void> {
  return del(`/api/history/${id}`);
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export async function checkForUpdates(locale?: string, source?: UpdateDownloadSource): Promise<UpdateInfo> {
  const params = new URLSearchParams();
  if (locale) params.set("locale", locale);
  if (source) params.set("source", source);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return get(`/api/update/check${query}`);
}

export async function fetchChangelog(lang?: string): Promise<import("@/lib/app/changelog").ChangelogData> {
  const query = lang ? `?lang=${encodeURIComponent(lang)}` : "";
  return get(`/api/changelog${query}`);
}

export async function checkMcpServerStatus(): Promise<import("@/lib/backend/tauri").McpServerStatus> {
  return {
    installed: false,
    npm_available: false,
    node_path: null,
    node_version: null,
    current_version: null,
    latest_version: null,
    update_available: false,
    bin_path: null,
    native_bin_path: null,
    script_path: null,
    data_dir: null,
    install_command: "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org",
    update_command: "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org",
    error: "MCP Server status is only available in the desktop app.",
  };
}

export async function installMcpServer(): Promise<string> {
  throw new Error("MCP Server installation is only available in the desktop app.");
}

export async function getSystemProxyUrl(): Promise<string | null> {
  return null;
}

export async function downloadUpdate(_source: UpdateDownloadSource, _latestVersion?: string): Promise<void> {
  throw new Error("In-app update downloads are only available in the desktop app.");
}

export async function cancelUpdateDownload(): Promise<void> {}

export async function installDownloadedUpdate(): Promise<void> {
  throw new Error("In-app update installation is only available in the desktop app.");
}

export async function getAppVersion(): Promise<string> {
  const res: { version: string } = await get("/api/version");
  return res.version;
}

export async function getAppSupportInfo(): Promise<AppSupportInfo> {
  const appVersion = await getAppVersion();
  return {
    appVersion,
    runtime: "web",
    osName: navigator.platform || "web",
    osVersion: null,
    arch: "",
  };
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

export async function refreshConnections(): Promise<void> {
  // Web mode doesn't maintain persistent connection pools - no-op
}

export * from "@/lib/backend/mq-http";
export * from "@/lib/backend/mqtt-http";
