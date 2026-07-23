import type {
  ConnectionConfig,
  ConnectionTestResult,
  DatabaseConnectionInfo,
  DatabaseInfo,
  DatabaseStorageInfo,
  SchemaInfo,
  LinkedServerInfo,
  CatalogInfo,
  TableInfo,
  ObjectInfo,
  CompletionAssistantRequest,
  CompletionAssistantResponse,
  ObjectStatistics,
  ObjectSource,
  ObjectSourceKind,
  ColumnInfo,
  SqlServerColumnMetadata,
  IndexInfo,
  ForeignKeyInfo,
  TriggerInfo,
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
import type { CollectionInfo } from "@/types/database";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff, FunctionDiff, SequenceDiff, RuleDiff, OwnerDiff } from "@/lib/schema/schemaDiff";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { AiConfig, AiTestConnectionResult } from "@/stores/settingsStore";
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
  RedisValue,
  RedisScanResult,
  RedisCommandResult,
  RedisSlowlogEntry,
  RedisNodeEndpoint,
  KvValue,
  KvListPrefixResponse,
  KvListPrefixOptions,
  KvGetResponse,
  KvPutOptions,
  KvPutResponse,
  KvDeleteResponse,
  DocumentQueryResult,
  MongoDocumentResult,
  MongoCollectionStatsResult,
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
  NacosInstanceQuery,
  NacosInstanceUpdate,
  NacosNamespaceCreate,
  NacosNamespaceInfo,
  NacosNamespaceUpdate,
  NacosRawRequest,
  NacosRawResponse,
  NacosServiceList,
  NacosServiceQuery,
} from "@/types/nacos";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";

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
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function get<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function del<T>(url: string): Promise<T> {
  const res = await fetch(apiUrl(url), { method: "DELETE" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function put<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(url), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
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
  if (!response.ok) throw new Error(await response.text());
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
  return post("/api/connection/database-info/save", { connectionId, databaseInfo });
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
  const quote = await post<string | null>("/api/connection/identifier-quote", { connectionId, database });
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
  const res = await fetch(apiUrl("/api/jdbc/drivers"), { method: "POST", body: formData });
  if (!res.ok) throw new Error(await res.text());
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
  const uploadRes = await fetch(apiUrl("/api/jdbc/plugin/install-local"), { method: "POST", body: formData });
  if (!uploadRes.ok) throw new Error(await uploadRes.text());
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

export async function installAgent(dbType: string, _source?: UpdateDownloadSource): Promise<void> {
  await post("/api/agents/install", { dbType });
}

export async function upgradeAllAgents(_source?: UpdateDownloadSource): Promise<UpgradeAllAgentDriversResult> {
  return post("/api/agents/upgrade-all", {});
}

export async function checkAgentUpdateBlockers(_dbTypes: string[]): Promise<AgentUpdateBlocker[]> {
  return [];
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

export async function importAgentsFromZip(fileOrPath: string | File): Promise<number> {
  if (typeof fileOrPath === "string") {
    throw new Error("Offline ZIP import in web mode requires a File object, not a file path");
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  const res = await fetch(apiUrl("/api/agents/import-offline"), { method: "POST", body: formData });
  if (!res.ok) throw new Error(await res.text());
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
  const uploadRes = await fetch(apiUrl("/api/agents/import-driver"), { method: "POST", body: formData });
  if (!uploadRes.ok) throw new Error(await uploadRes.text());
}

export const importAgentJar = importAgentDriver;

export async function reinstallJre(jreKey?: string, _source?: UpdateDownloadSource): Promise<void> {
  await post("/api/agents/reinstall-jre", { jreKey });
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

export async function listDatabaseStorage(connectionId: string, databases: string[]): Promise<DatabaseStorageInfo[]> {
  return post("/api/schema/database-storage", { connection_id: connectionId, databases });
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

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: SidebarObjectKind[], catalog?: string): Promise<TableInfo[]> {
  return get(`/api/schema/tables?${qs({ connection_id: connectionId, database, schema, filter, limit, offset, object_types: objectTypes?.join(","), catalog })}`);
}

export async function getTableComment(_connectionId: string, _database: string, _schema: string, _table: string, _catalog?: string): Promise<string | null> {
  throw new Error("Table comment lookup is not available in the web backend");
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: SidebarObjectKind[], filter?: string, limit?: number, offset?: number, catalog?: string): Promise<ObjectInfo[]> {
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

export async function getColumns(connectionId: string, database: string, schema: string, table: string, catalog?: string, clientSessionId?: string): Promise<ColumnInfo[]> {
  return get(`/api/schema/columns?${qs({ connection_id: connectionId, database, schema, table, catalog, client_session_id: clientSessionId })}`);
}

export async function getSqlServerColumnMetadata(connectionId: string, database: string, schema: string, table: string): Promise<SqlServerColumnMetadata[]> {
  return get(`/api/schema/sqlserver/column-metadata?${qs({ connection_id: connectionId, database, schema, table })}`);
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

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return get(`/api/schema/ddl?${qs({ connection_id: connectionId, database, schema, table, object_type: objectType, catalog })}`);
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
    fetchSize?: number;
    pageSize?: number;
    resultSessionId?: string;
    clientSessionId?: string;
    timeoutSecs?: number;
    executionMode?: "simple";
  },
): Promise<QueryResult> {
  return post("/api/query/execute", { connectionId, database, sql, schema, executionId, ...options });
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
    useTransaction?: boolean;
    continueOnError?: boolean;
    executionMode?: "simple";
  },
): Promise<QueryResult[]> {
  return post("/api/query/execute-multi", { connectionId, database, sql, schema, executionId, ...options });
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string): Promise<boolean> {
  return post("/api/query/close-session", { connectionId, database, sessionId, clientSessionId });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string): Promise<boolean> {
  return post("/api/query/close-client-session", { connectionId, database, clientSessionId });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-batch", { connectionId, database, statements, schema });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-script", { connectionId, database, sql, schema });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string): Promise<QueryResult> {
  return post("/api/query/execute-in-transaction", { connectionId, database, statements, schema });
}

export async function beginManualTransaction(_connectionId: string, _database: string, _schema?: string): Promise<string> {
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
  return post("/api/query/find-statement-at-cursor", { sql, cursorPos, databaseType });
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
  return post("/api/query/build-create-user-sql", { username, password, tablespace });
}

export async function getExplainInfo(connectionId: string, database: string | undefined, schema: string | undefined, sql: string, mode: string): Promise<string | undefined> {
  // Match the Tauri path: transport and Agent failures must remain distinguishable from an empty plan.
  return post<string>("/api/query/get-explain-info", { connectionId, database, schema, sql, mode });
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
  return post("/api/query/build-duckdb-attach-database-sql", { options: { path, name } });
}

export async function buildSqliteAttachDatabaseSql(path: string, name: string): Promise<string> {
  return post("/api/query/build-sqlite-attach-database-sql", { options: { path, name } });
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
  return post("/api/query/build-executable-object-source-statements", { input });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-executable-object-source-sql", { input });
}

export async function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return post("/api/query/build-editable-object-source", { input });
}

export async function buildRoutineRenameObjectSourceStatements(input: BuildRoutineRenameObjectSourceInput): Promise<string[]> {
  return post("/api/query/build-routine-rename-object-source-statements", { input });
}

export async function buildViewDdlSql(input: BuildViewDdlInput): Promise<string> {
  return post("/api/query/build-view-ddl-sql", { input });
}

export async function buildTableStructureChangeSql(options: BuildTableStructureChangeSqlOptions): Promise<TableStructureChangeSql> {
  return post("/api/query/build-table-structure-change-sql", { options });
}

export async function previewSqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions): Promise<SqliteTableStructureChangePreview> {
  return post("/api/query/preview-sqlite-table-structure-change", { connectionId, database, options });
}

export async function applySqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions, schemaRevision: string): Promise<QueryResult> {
  return post("/api/query/apply-sqlite-table-structure-change", { connectionId, database, options, schemaRevision });
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

export async function prepareDataGridSave(options: DataGridSaveStatementOptions): Promise<DataGridSavePreparation> {
  return post("/api/query/prepare-data-grid-save", { options });
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
  return post("/api/query/build-data-grid-column-distinct-values-sql", { options });
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

export async function aiTestConnection(config: AiConfig): Promise<AiTestConnectionResult> {
  return post("/api/ai/test-connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return post("/api/ai/models", { config });
}

export type { AgentEvent } from "@/lib/backend/tauri";

function isAgentEvent(v: unknown): v is import("@/lib/backend/tauri").AgentEvent {
  return typeof v === "object" && v !== null && "type" in v && typeof (v as Record<string, unknown>).type === "string";
}

export async function aiAgentStream(sessionId: string, request: AiCompletionRequest, connectionId: string, database: string, dbType: string, onEvent: (event: import("@/lib/backend/tauri").AgentEvent) => void, mode?: string, allowWriteSql = false, signal?: AbortSignal): Promise<string> {
  const res = await fetch(apiUrl("/api/ai/agent-stream"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, request, connectionId, database, dbType, mode: mode || "ask", allowWriteSql }),
    signal,
  });
  if (!res.ok) throw new Error(await res.text());

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
    return raw ? { ...DEFAULT_DESKTOP_SETTINGS, ...(JSON.parse(raw) as Partial<DesktopSettings>) } : { ...DEFAULT_DESKTOP_SETTINGS };
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
  if (!res.ok) throw new Error(await res.text());
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
  if (!res.ok) throw new Error(await res.text());
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
  return Array.isArray(payload.tabs) ? { tabs: payload.tabs, activeTabId: typeof payload.activeTabId === "string" ? payload.activeTabId : null } : null;
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
}

export interface SnippetSyncSummary {
  provider: SnippetProvider;
  snippetId: string;
  bytes: number;
  exportedAt?: string;
  appVersion?: string;
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
  return post("/api/cloud-sync/webdav/save-sync-secrets-preference", { enabled, passphrase });
}

export async function forgetWebdavSyncSecretsPassphrase(): Promise<void> {
  return post("/api/cloud-sync/webdav/forget-sync-secrets-passphrase", {});
}

export async function webdavSyncUpload(config: WebDavConfig, editorSettings?: unknown, secretsPassphrase?: string): Promise<WebDavSyncSummary> {
  return post("/api/cloud-sync/webdav/upload", { config, editorSettings, secretsPassphrase });
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

export async function snippetSyncUpload(config: SnippetSyncConfig, editorSettings?: unknown, secretsPassphrase?: string): Promise<SnippetSyncSummary> {
  return post("/api/cloud-sync/snippet/upload", { config, editorSettings, secretsPassphrase });
}

export async function snippetSyncDownload(config: SnippetSyncConfig, secretsPassphrase?: string): Promise<SnippetDownloadResult> {
  return post("/api/cloud-sync/snippet/download", { config, secretsPassphrase });
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
  const res = await fetch(apiUrl("/api/sql-file/preview"), { method: "POST", body: formData });
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

export async function writeExternalSqlFile(_path: string, _content: string): Promise<void> {
  throw new Error("Saving external SQL file paths is only available in the desktop app");
}

export async function saveExternalSqlFile(_defaultFileName: string, _content: string): Promise<string | null> {
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
  if (!res.ok) throw new Error(await res.text());

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
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
  const formData = new FormData();
  formData.append("file", fileOrPath);
  if (options.sourceFormat) formData.append("sourceFormat", options.sourceFormat);
  if (options.parseOptions) formData.append("parseOptions", JSON.stringify(options.parseOptions));
  if (options.previewLimit != null) formData.append("previewLimit", String(options.previewLimit));
  const res = await fetch(apiUrl("/api/import/preview"), { method: "POST", body: formData });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function importTableFile(request: TableImportRequest, onProgress: (progress: TableImportProgress) => void): Promise<TableImportSummary> {
  // 1. POST to start the import
  const res = await fetch(apiUrl("/api/import/execute"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request }),
  });
  if (!res.ok) throw new Error(await res.text());

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
  if (!res.ok) throw new Error(await res.text());

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
  const blob = new Blob(["\uFEFF", content], { type: "text/csv;charset=utf-8" });
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

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], columnTypes: string[], rows: readonly (readonly XlsxCellValue[])[]): Promise<void> {
  const { buildXlsxWorkbook } = await import("@/lib/export/xlsxExport");
  const workbook = buildXlsxWorkbook({
    sheetName: sheetName || "Export",
    columns,
    columnTypes,
    rows,
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

export async function exportQueryResultsXlsx(filePath: string, worksheets: readonly { sheetName?: string; columns: readonly string[]; columnTypes?: readonly string[]; rows: readonly (readonly XlsxCellValue[])[] }[]): Promise<void> {
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
  return post("/api/redis/scan-keys", { connectionId, db, cursor, pattern, count });
}

export async function redisScanKeysBatch(connectionId: string, db: number, cursor: number, pattern: string, count: number, maxIterations: number, includeTypes = true): Promise<RedisScanResult> {
  return post("/api/redis/scan-keys-batch", { connectionId, db, cursor, pattern, count, maxIterations, includeTypes });
}

export async function redisScanValues(connectionId: string, db: number, cursor: number, pattern: string, query: string, count: number, includeKeyMatches = false): Promise<RedisScanResult> {
  return post("/api/redis/scan-values", { connectionId, db, cursor, pattern, query, includeKeyMatches, count });
}

export async function redisGetValue(connectionId: string, db: number, keyRaw: string): Promise<RedisValue> {
  return post("/api/redis/get-value", { connectionId, db, keyRaw });
}

export async function redisSetString(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/set-string", { connectionId, db, keyRaw, value, ttl });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return post("/api/redis/delete-key", { connectionId, db, keyRaw });
}

export async function redisHashSet(connectionId: string, db: number, keyRaw: string, field: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/hash-set", { connectionId, db, keyRaw, field, value, ttl });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return post("/api/redis/hash-del", { connectionId, db, keyRaw, field });
}

export async function redisListPush(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return post("/api/redis/list-push", { connectionId, db, keyRaw, value, ttl });
}

export async function redisListSet(connectionId: string, db: number, keyRaw: string, index: number, value: string): Promise<void> {
  return post("/api/redis/list-set", { connectionId, db, keyRaw, index, value });
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
  return post("/api/redis/zadd", { connectionId, db, keyRaw, member, score, ttl });
}

export async function redisZrem(connectionId: string, db: number, keyRaw: string, member: string): Promise<void> {
  return post("/api/redis/zrem", { connectionId, db, keyRaw, member });
}

export async function redisStreamAdd(connectionId: string, db: number, keyRaw: string, entryId: string, fields: [string, string][], ttl?: number): Promise<void> {
  return post("/api/redis/stream-add", { connectionId, db, keyRaw, entryId, fields, ttl });
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

export async function redisDeleteKeys(connectionId: string, db: number, keyRaws: string[]): Promise<number> {
  return post("/api/redis/delete-keys", { connectionId, db, keyRaws });
}

export async function redisFlushDb(connectionId: string, db: number): Promise<void> {
  return post("/api/redis/flush-db", { connectionId, db });
}

export async function redisExecuteCommand(connectionId: string, db: number, command: string, skipSafetyCheck?: boolean): Promise<RedisCommandResult> {
  return post("/api/redis/execute-command", { connectionId, db, command, skipSafetyCheck: skipSafetyCheck ?? false });
}

export async function redisLoadMore(connectionId: string, db: number, keyRaw: string, keyType: string, cursor: number, count: number, filter?: string): Promise<RedisCollectionPage> {
  return post("/api/redis/load-more", { connectionId, db, keyRaw, keyType, cursor, count, filter });
}

export async function redisPubSubPublish(connectionId: string, db: number, channel: string, message: string): Promise<{ subscribers: number }> {
  return post("/api/redis/pubsub/publish", { connectionId, db, channel, message });
}

export async function redisPubSubConnect(connectionId: string): Promise<WebSocket> {
  return new WebSocket(apiWebSocketUrl(`/api/redis/pubsub/ws?connectionId=${encodeURIComponent(connectionId)}`));
}

export async function redisSlowlogGet(connectionId: string, count: number, nodeHost?: string, nodePort?: number): Promise<RedisSlowlogEntry[]> {
  return post("/api/redis/slowlog-get", { connectionId, count, nodeHost, nodePort });
}

export async function redisClusterMasterNodes(connectionId: string): Promise<RedisNodeEndpoint[]> {
  return post("/api/redis/cluster-master-nodes", { connectionId });
}

// ---------------------------------------------------------------------------
// etcd
// ---------------------------------------------------------------------------

export async function etcdListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null): Promise<KvListPrefixResponse> {
  return post("/api/etcd/list-prefix", { connectionId, prefix, limit, continuation });
}

export async function etcdGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return post("/api/etcd/get", { connectionId, key });
}

export async function etcdPut(connectionId: string, key: string, value: KvValue, lease?: number | null): Promise<KvPutResponse> {
  return post("/api/etcd/put", { connectionId, key, value, lease });
}

export async function etcdDelete(connectionId: string, key: string): Promise<KvDeleteResponse> {
  return post("/api/etcd/delete", { connectionId, key });
}

// ---------------------------------------------------------------------------
// ZooKeeper
// ---------------------------------------------------------------------------

export async function zookeeperListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null): Promise<KvListPrefixResponse> {
  return post("/api/zookeeper/list-prefix", { connectionId, prefix, limit, continuation, recursive: options?.recursive ?? null });
}

export async function zookeeperGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return post("/api/zookeeper/get", { connectionId, key });
}

export async function zookeeperPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null): Promise<KvPutResponse> {
  return post("/api/zookeeper/put", { connectionId, key, value, options: options ?? null });
}

export async function zookeeperDelete(connectionId: string, key: string): Promise<KvDeleteResponse> {
  return post("/api/zookeeper/delete", { connectionId, key });
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

export async function nacosListInstances(connectionId: string, query: NacosInstanceQuery): Promise<NacosInstanceInfo[]> {
  return post("/api/nacos/instances/list", { connectionId, query });
}

export async function nacosUpdateInstance(connectionId: string, req: NacosInstanceUpdate): Promise<void> {
  return post("/api/nacos/instances/update", { connectionId, req });
}

export async function nacosRawRequest(connectionId: string, req: NacosRawRequest): Promise<NacosRawResponse> {
  return post("/api/nacos/raw", { connectionId, req });
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
  return post("/api/document-store/list-collections", { connectionId, database });
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
  await post("/api/mongo/drop-collection", { connectionId, database, collection });
}

export async function mongoRenameCollection(connectionId: string, database: string, collection: string, newName: string): Promise<void> {
  await post("/api/mongo/rename-collection", { connectionId, database, collection, newName });
}

export async function elasticsearchListIndices(connectionId: string): Promise<string[]> {
  const collections = await documentListCollections(connectionId, "default");
  return collections.map((c) => c.name);
}

export async function vectorListCollections(connectionId: string, database?: string): Promise<CollectionInfo[]> {
  return documentListCollections(connectionId, database || "default");
}

export async function vectorGetCollectionDetail(connectionId: string, database: string, collection: string): Promise<CollectionInfo> {
  return post("/api/mongo/vector-collection-detail", { connectionId, database, collection });
}

export async function mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, executionId?: string): Promise<MongoDocumentResult> {
  return documentFindDocuments(connectionId, database, collection, skip, limit, filter, projection, sort, executionId);
}

export async function mongoParseShellCommand(source: string): Promise<MongoCommand> {
  const raw = await post<Record<string, unknown>>("/api/mongo/parse-shell-command", { source });
  return normalizeRustMongoCommand(raw);
}

export async function mongoFindOne(connectionId: string, database: string, collection: string, filter?: string, projection?: string, options?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one", { connectionId, database, collection, filter, projection, options, executionId });
}

export async function documentFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, executionId?: string): Promise<DocumentQueryResult> {
  return post("/api/document-store/find-documents", { connectionId, database, collection, skip, limit, filter, projection, sort, executionId });
}

export async function elasticsearchCountDocuments(connectionId: string, index: string, filter?: string, executionId?: string): Promise<number> {
  return post("/api/document-store/elasticsearch-count-documents", { connectionId, index, filter, executionId });
}

export async function mongoCountDocuments(connectionId: string, database: string, collection: string, filter?: string, mode?: "accurate" | "legacy", executionId?: string): Promise<number> {
  return post("/api/mongo/count-documents", { connectionId, database, collection, filter, mode, executionId });
}

export async function documentListGridFsFiles(connectionId: string, database: string, bucket: string, filter?: string, sort?: string): Promise<MongoGridFsFileInfo[]> {
  return post("/api/document-store/list-gridfs-files", { connectionId, database, bucket, filter, sort });
}

export async function documentListGridFsBuckets(connectionId: string, database: string, filter?: string, sort?: string): Promise<MongoGridFsBucketInfo[]> {
  return post("/api/document-store/list-gridfs-buckets", { connectionId, database, filter, sort });
}

export async function documentCreateGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return post("/api/document-store/create-gridfs-bucket", { connectionId, database, bucket });
}

export async function documentDeleteGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return post("/api/document-store/delete-gridfs-bucket", { connectionId, database, bucket });
}

export async function documentDownloadGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<Uint8Array> {
  const res = await fetch(apiUrl("/api/document-store/download-gridfs-file"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connectionId, database, bucket, fileId }),
  });
  if (!res.ok) throw new Error(await res.text());
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
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function documentDeleteGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<void> {
  return post("/api/document-store/delete-gridfs-file", { connectionId, database, bucket, fileId });
}

export async function mongoServerVersion(connectionId: string, database: string, executionId?: string): Promise<string> {
  return post("/api/mongo/server-version", { connectionId, database, executionId });
}

export async function mongoAggregateDocuments(connectionId: string, database: string, collection: string, pipelineJson: string, maxRows?: number, optionsJson?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/aggregate-documents", { connectionId, database, collection, pipelineJson, maxRows, optionsJson, executionId });
}

export async function mongoDistinct(connectionId: string, database: string, collection: string, field: string, filter?: string, executionId?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/distinct", { connectionId, database, collection, field, filter, executionId });
}

export async function mongoCollectionStats(connectionId: string, database: string, collection: string, scale?: number, executionId?: string): Promise<MongoCollectionStatsResult> {
  return post("/api/mongo/collection-stats", { connectionId, database, collection, scale, executionId });
}

export async function mongoCreateIndex(connectionId: string, database: string, collection: string, keysJson: string, optionsJson?: string): Promise<{ name: string }> {
  return post("/api/mongo/create-index", { connectionId, database, collection, keysJson, optionsJson });
}

export async function mongoDropIndexes(connectionId: string, database: string, collection: string, indexesJson?: string, single = false): Promise<{ dropped_names: string[]; affected_rows: number }> {
  return post("/api/mongo/drop-indexes", { connectionId, database, collection, indexesJson, single });
}

export async function mongoInsertDocument(connectionId: string, database: string, collection: string, docJson: string, routing?: string): Promise<string> {
  return documentInsertDocument(connectionId, database, collection, docJson, routing);
}

export async function documentInsertDocument(connectionId: string, database: string, collection: string, docJson: string, routing?: string): Promise<string> {
  return post("/api/document-store/insert-document", { connectionId, database, collection, docJson, routing });
}

export async function mongoInsertDocuments(connectionId: string, database: string, collection: string, docsJson: string): Promise<{ affected_rows: number }> {
  return post("/api/mongo/insert-documents", { connectionId, database, collection, docsJson });
}

export async function mongoUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return documentUpdateDocument(connectionId, database, collection, id, docJson, routing);
}

export async function documentUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return post("/api/document-store/update-document", { connectionId, database, collection, id, docJson, routing });
}

export async function mongoUpdateDocuments(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, many: boolean, optionsJson?: string): Promise<{ affected_rows: number }> {
  return post("/api/mongo/update-documents", { connectionId, database, collection, filterJson, updateJson, many, optionsJson });
}

export async function mongoDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string): Promise<number> {
  return documentDeleteDocument(connectionId, database, collection, id, routing);
}

export async function documentDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string): Promise<number> {
  return post("/api/document-store/delete-document", { connectionId, database, collection, id, routing });
}

export async function mongoDeleteDocuments(connectionId: string, database: string, collection: string, filterJson: string, many: boolean): Promise<{ affected_rows: number }> {
  return post("/api/mongo/delete-documents", { connectionId, database, collection, filterJson, many });
}

export async function mongoFindOneAndUpdate(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-update", { connectionId, database, collection, filterJson, updateJson, optionsJson });
}

export async function mongoFindOneAndReplace(connectionId: string, database: string, collection: string, filterJson: string, replacementJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-replace", { connectionId, database, collection, filterJson, replacementJson, optionsJson });
}

export async function mongoFindOneAndDelete(connectionId: string, database: string, collection: string, filterJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return post("/api/mongo/find-one-and-delete", { connectionId, database, collection, filterJson, optionsJson });
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
