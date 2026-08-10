import { invoke } from "@tauri-apps/api/core";
import { BackendErrorException, type BackendError } from "@/lib/backend/errorUtils";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { normalizeRustMongoCommand, type MongoCommand } from "@/lib/mongo/mongoShellCommand";
import { ExternalSqlFileTooLargeError } from "@/lib/sql/sqlFileOpen";

/** Normalize Tauri rejections once at the public backend boundary. */
async function invokeBackend<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}
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
  ConstraintInfo,
  PartitionInfo,
  SubpartitionInfo,
  FunctionInfo,
  SequenceInfo,
  RuleInfo,
  OwnerInfo,
  ExtensionInfo,
  QueryResult,
  SqlReferenceAnalysis,
  DatabaseType,
  InstalledPlugin,
  JdbcDriverInfo,
  JdbcLocalBundleInfo,
  JdbcMavenBundleInfo,
  JdbcPluginStatus,
  SavedSqlFile,
  SavedSqlFolder,
  SavedSqlLibrary,
  SshConfigHostEntry,
  TunnelProfile,
  TransactionLog,
  ExternalSqlFileVersion,
} from "@/types/database";
import { isTauriCommandUnavailable, normalizeConnectionTestResult } from "@/lib/connection/connectionDatabaseInfo";
import type { AnnotationFile, SchemaSnapshot } from "@/docs/types";
import type { CollectionInfo } from "@/types/database";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import type { AiChatSelectionState, AiConfig, AiConfigItem, AiEffortCapability, AiEffortLevel, AiTestConnectionResult } from "@/types/ai";
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
import type { DataCompareFromTablesOptions, DataCompareFromTablesPreparation, DataCompareSyncPlan, DataCompareSyncPlanOptions, DataComparePreparation, DataComparePreparationOptions } from "@/lib/dataGrid/dataCompare";
import type { SchemaDiffPreparation, SchemaDiffPreparationOptions, TableDiff, FunctionDiff, SequenceDiff, RuleDiff, OwnerDiff } from "@/lib/schema/schemaDiff";
import type { BuildTableStructureChangeSqlOptions, BuildSingleColumnAlterSqlOptions, SqliteTableStructureChangePreview, TableStructureChangeSql } from "@/lib/table/tableStructureEditorSql";
import type { BuildTableSelectSqlOptions } from "@/lib/table/tableSelectSql";
import type { DatabaseSearchSql, DatabaseSearchSqlOptions, SearchResultWhereOptions } from "@/lib/database/databaseSearch";
import type { BuildEditableObjectSourceSqlInput, BuildRoutineRenameObjectSourceInput } from "@/lib/table/objectSourceEditor";
import type { BuildViewDdlInput } from "@/lib/table/viewDdl";
import type { BuildRenameObjectSqlOptions } from "@/lib/table/objectRenameSql";
import type { CreateDatabaseSqlOptions } from "@/lib/database/createDatabaseSql";
import type { DatabaseNameSqlOptions, DatabasePropertyEditSqlOptions, DropTableChildObjectSqlOptions, DropObjectSqlOptions, DuplicateTableStructureSqlOptions, CopyTableDataSqlOptions, SchemaNameSqlOptions, TableAdminSqlOptions } from "@/lib/database/dbAdminSql";
import type { BuildDatabaseSqlExportOptions, BuildExportInsertStatementsOptions } from "@/lib/export/databaseExport";

export interface SshPromptResolution {
  id: string;
  action: "accept" | "reject" | "secret";
  remember?: boolean;
  secret?: string;
}

export interface AgentDriverInfo {
  db_type: string;
  label: string;
  version: string;
  size: number;
  installed: boolean;
  installed_version: string | null;
  update_available: boolean;
  requires_java_runtime?: boolean;
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
  protocol_mode: "multi_session" | "legacy" | null;
  active_sessions: number | null;
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
  quit_on_close: boolean;
  close_action_prompted: boolean;
  debug_logging_enabled: boolean;
  duckdb_worker_process_isolation: boolean;
  duckdb_worker_max_processes: number;
  saved_sql_sync_dir?: string | null;
  driver_store_dir?: string | null;
  plugin_store_dir?: string | null;
  agent_store_dir?: string | null;
  sidebar_table_page_size?: number | null;
}

export interface McpGlobalPolicy {
  readOnly: boolean;
  allowDangerousSql: boolean;
  allowedConnectionIds: string[] | null;
  configured: boolean;
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

export interface AppSupportInfo {
  appVersion: string;
  runtime: "desktop" | "web";
  osName: string;
  osVersion?: string | null;
  arch: string;
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
  firstPageUsesActualSql?: boolean;
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
  /** MySQL can return either the existing JSON plan or its native tabular plan. */
  format?: "json" | "standard";
  /** PostgreSQL only: run the statement so the plan carries measured rows and timings. */
  analyze?: boolean;
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
  operation_id?: string;
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

export interface AiTaskContract {
  action?: string;
  mode?: string;
  userRequest?: string;
}

export interface AiCompletionRequest {
  config: AiConfig;
  systemPrompt: string;
  messages: AiMessage[];
  taskContract?: AiTaskContract;
  maxTokens?: number;
}

export interface AiModelInfo {
  id: string;
  displayName?: string;
  supportedEffortLevels?: AiEffortLevel[];
  effortCapability?: AiEffortCapability;
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
  | {
      type: "tool_call_start";
      tool_call_id: string;
      tool_name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_call_end";
      tool_call_id: string;
      tool_name: string;
      result: unknown;
      is_error: boolean;
    }
  | { type: "turn_end"; turn: number }
  | { type: "agent_end"; input_tokens?: number; output_tokens?: number }
  | {
      type: "context_compacted";
      summary: string;
      summary_tokens: number;
      compacted_messages: number;
      estimated_before: number;
      estimated_after: number;
    }
  | { type: "error"; message: string };

export async function aiAgentStream(
  sessionId: string,
  request: AiCompletionRequest,
  connectionId: string,
  database: string,
  schema: string | undefined,
  dbType: string,
  onEvent: (event: AgentEvent) => void,
  mode?: string,
  allowWriteSql = false,
  confirmedWriteSql?: string,
  confirmedConnectionId?: string,
  confirmedDatabase?: string,
  confirmedSchema?: string,
  _signal?: AbortSignal,
): Promise<string> {
  const unlisten: UnlistenFn = await listen<AgentEvent>("ai-agent-event", (event) => {
    onEvent(event.payload);
    if (event.payload.type === "agent_end" || event.payload.type === "error") {
      unlisten();
    }
  });
  try {
    return await invoke("ai_agent_stream", {
      sessionId,
      request,
      connectionId,
      database,
      schema,
      dbType,
      mode,
      allowWriteSql,
      confirmedWriteSql,
      confirmedConnectionId,
      confirmedDatabase,
      confirmedSchema,
    });
  } catch (e) {
    unlisten();
    throw e;
  }
}

export async function saveAiConfig(config: AiConfig): Promise<void> {
  return invoke("save_ai_config", { config });
}

export async function saveAiProviderConfig(provider: string, config: AiConfig): Promise<void> {
  return invoke("save_ai_provider_config", { provider, config });
}

export async function loadAiProviderConfigs(): Promise<Record<string, AiConfig>> {
  return invoke("load_ai_provider_configs");
}

export async function aiTestConnection(config: AiConfig): Promise<AiTestConnectionResult> {
  return invoke("ai_test_connection", { config });
}

export async function aiListModels(config: AiConfig): Promise<AiModelInfo[]> {
  return invoke("ai_list_models", { config });
}

export async function aiResolveModelEffort(config: AiConfig, modelId: string): Promise<AiEffortCapability> {
  return invoke("ai_resolve_model_effort", { config, modelId });
}

export async function saveAiChatSelection(selection: AiChatSelectionState): Promise<void> {
  return invoke("save_ai_chat_selection", { selection });
}

export async function loadAiChatSelection(): Promise<AiChatSelectionState | null> {
  return invoke("load_ai_chat_selection");
}

export async function aiCancelStream(sessionId: string): Promise<boolean> {
  return invoke("ai_cancel_stream", { sessionId });
}

export async function saveAiConfigs(configs: AiConfigItem[]): Promise<void> {
  return invoke("save_ai_configs", { configs });
}

export async function loadAiConfigs(): Promise<AiConfigItem[]> {
  return invoke("load_ai_configs");
}

export async function setDefaultAiConfig(configId: string): Promise<void> {
  return invoke("set_default_ai_config", { configId });
}

export async function saveAiConfigItem(config: AiConfigItem): Promise<void> {
  return invoke("save_ai_config_item", { config });
}

export async function deleteAiConfig(configId: string): Promise<void> {
  return invoke("delete_ai_config", { configId });
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

export async function loadMcpGlobalPolicy(): Promise<McpGlobalPolicy> {
  return invoke("load_mcp_global_policy");
}

export async function saveMcpGlobalPolicy(policy: Omit<McpGlobalPolicy, "configured">): Promise<void> {
  return invoke("save_mcp_global_policy", { policy });
}

export async function loadMaxAgentTurns(): Promise<number> {
  return invoke("load_max_agent_turns");
}

export async function saveMaxAgentTurns(maxAgentTurns: number): Promise<void> {
  return invoke("save_max_agent_turns", { maxAgentTurns });
}

export async function loadMaxRetries(): Promise<number> {
  return invoke("load_max_retries");
}

export async function saveMaxRetries(maxRetries: number): Promise<void> {
  return invoke("save_max_retries", { maxRetries });
}

export interface OpenTabsStatePayload {
  tabs: unknown[];
  activeTabId: string | null;
}

export async function loadEditorSettings(): Promise<unknown | null> {
  return invoke("load_editor_settings");
}

export async function saveEditorSettings(settings: unknown): Promise<void> {
  return invoke("save_editor_settings", { settings });
}

export async function loadOpenTabsState(): Promise<OpenTabsStatePayload | null> {
  return invoke("load_open_tabs_state");
}

export async function saveOpenTabsState(payload: OpenTabsStatePayload): Promise<void> {
  return invoke("save_open_tabs_state", { payload });
}

export async function loadSavedSqlEditorPositions(): Promise<unknown[] | null> {
  return invoke("load_saved_sql_editor_positions");
}

export async function saveSavedSqlEditorPositions(positions: unknown[]): Promise<void> {
  return invoke("save_saved_sql_editor_positions", { positions });
}

export async function completeAppClose(action: "quit" | "hide"): Promise<void> {
  return invoke("complete_app_close", { action });
}

export async function requestAppClose(): Promise<void> {
  return invoke("request_app_close_from_window_controls");
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

export async function setDriverStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_driver_store_dir", { newDir });
}

export async function setPluginStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_plugin_store_dir", { newDir });
}

export async function setAgentStoreDir(newDir: string | null): Promise<DriverStoreMigrationResult> {
  return invoke("set_agent_store_dir", { newDir });
}

export interface DriverStorePathInfo {
  driver_store_dir: string | null;
  plugin_store_dir: string | null;
  agent_store_dir: string | null;
  plugins_dir: string;
  agents_dir: string;
}

export async function getDriverStorePath(): Promise<DriverStorePathInfo> {
  return invoke("get_driver_store_path");
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

export async function webdavSyncSecretsStatus(): Promise<WebDavSyncSecretsStatus> {
  return invoke("webdav_sync_secrets_status");
}

export async function saveWebdavSyncSecretsPreference(enabled: boolean, passphrase?: string): Promise<void> {
  return invoke("save_webdav_sync_secrets_preference", { enabled, passphrase });
}

export async function forgetWebdavSyncSecretsPassphrase(): Promise<void> {
  return invoke("forget_webdav_sync_secrets_passphrase");
}

export async function webdavSyncUpload(config: WebDavConfig, editorSettings?: unknown, secretsPassphrase?: string): Promise<WebDavSyncSummary> {
  return invoke("webdav_sync_upload", {
    config,
    editorSettings,
    secretsPassphrase,
  });
}

export async function webdavSyncDownload(config: WebDavConfig, secretsPassphrase?: string): Promise<WebDavDownloadResult> {
  return invoke("webdav_sync_download", { config, secretsPassphrase });
}

export async function snippetSyncTest(config: SnippetSyncConfig): Promise<void> {
  return invoke("snippet_sync_test", { config });
}

export async function snippetTokenStatus(config: SnippetSyncConfig): Promise<SnippetTokenStatus> {
  return invoke("snippet_token_status", { config });
}

export async function saveSnippetSavedToken(config: SnippetSyncConfig, token: string): Promise<void> {
  return invoke("save_snippet_saved_token", { config, token });
}

export async function forgetSnippetSavedToken(config: SnippetSyncConfig): Promise<void> {
  return invoke("forget_snippet_saved_token", { config });
}

export async function snippetSyncSettings(provider: SnippetProvider): Promise<SnippetSyncSettings> {
  return invoke("snippet_sync_settings", { provider });
}

export async function saveSnippetSyncId(provider: SnippetProvider, snippetId?: string): Promise<void> {
  return invoke("save_snippet_sync_id", { provider, snippetId });
}

export async function retrySnippetLegacyCleanup(config: SnippetSyncConfig): Promise<SnippetSyncSettings> {
  return invoke("retry_snippet_legacy_cleanup", { config });
}

export async function snippetSyncUpload(config: SnippetSyncConfig, editorSettings?: unknown, snippetPassphrase?: string, includeSecrets = false, secretsPassphrase?: string): Promise<SnippetSyncSummary> {
  return invoke("snippet_sync_upload", {
    config,
    editorSettings,
    snippetPassphrase,
    includeSecrets,
    secretsPassphrase,
  });
}

export async function snippetSyncDownload(config: SnippetSyncConfig, snippetPassphrase?: string, restoreSecrets = false, secretsPassphrase?: string): Promise<SnippetDownloadResult> {
  return invoke("snippet_sync_download", { config, snippetPassphrase, restoreSecrets, secretsPassphrase });
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

export async function listSshConfigHosts(): Promise<SshConfigHostEntry[]> {
  return invoke("list_ssh_config_hosts");
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

export interface ExternalSqlFileSnapshot {
  content: string;
  version: ExternalSqlFileVersion;
}

export type ExternalSqlFileStatus = { kind: "present"; sizeBytes: number; modifiedNs: string } | { kind: "missing" };

export type ExternalSqlFileWriteResult = { kind: "written"; version: ExternalSqlFileVersion } | { kind: "conflict"; currentVersion: ExternalSqlFileVersion } | { kind: "missing" };

export async function readExternalSqlFileSnapshot(path: string): Promise<ExternalSqlFileSnapshot> {
  const result = await invoke<{ kind: "content"; content: string; version: ExternalSqlFileVersion } | { kind: "tooLarge"; sizeBytes: number; maxSizeBytes: number }>("read_external_sql_file", { path });
  if (result.kind === "tooLarge") {
    throw new ExternalSqlFileTooLargeError(result.sizeBytes, result.maxSizeBytes);
  }
  return { content: result.content, version: result.version };
}

export async function readExternalSqlFile(path: string): Promise<string> {
  return (await readExternalSqlFileSnapshot(path)).content;
}

export async function inspectExternalSqlFile(path: string): Promise<ExternalSqlFileStatus> {
  return invoke("inspect_external_sql_file", { path });
}

export async function writeExternalSqlFile(path: string, content: string, options: { expectedContentHash?: string; expectedMissing?: boolean } = {}): Promise<ExternalSqlFileWriteResult> {
  return invoke("write_external_sql_file", {
    path,
    content,
    expectedContentHash: options.expectedContentHash ?? null,
    expectedMissing: options.expectedMissing ?? false,
  });
}

export async function saveExternalSqlFile(defaultFileName: string, content: string): Promise<{ path: string; version: ExternalSqlFileVersion } | null> {
  return invoke("save_external_sql_file", { defaultFileName, content });
}

export interface SqlFileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: SqlFileEntry[];
}

export async function listSqlFilesInFolder(folderPath: string): Promise<SqlFileEntry[]> {
  return invoke("list_sql_files_in_folder", { folderPath });
}

// --- AI Conversations ---

export interface AiChatMessage {
  role: string;
  content: string;
  mentions?: unknown[];
  reasoning?: string;
  kind?: "contextSummary";
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

// --- Prompt Templates ---

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export async function loadPromptTemplates(): Promise<PromptTemplate[]> {
  return invoke("load_prompt_templates");
}

export async function savePromptTemplate(id: string, name: string, content: string): Promise<PromptTemplate> {
  return invoke("save_prompt_template", { id, name, content });
}

export async function deletePromptTemplate(id: string): Promise<void> {
  return invoke("delete_prompt_template", { id });
}

export async function getAiGlobalCustomInstructions(): Promise<string> {
  return invoke("get_ai_global_custom_instructions");
}

export async function setAiGlobalCustomInstructions(content: string): Promise<void> {
  return invoke("set_ai_global_custom_instructions", { content });
}

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return invokeBackend("test_connection", { config });
}

export async function testConnectionWithInfo(config: ConnectionConfig): Promise<ConnectionTestResult> {
  try {
    const result = await invoke<unknown>("test_connection_with_info", {
      config,
    });
    return normalizeConnectionTestResult(result, config);
  } catch (error) {
    if (!isTauriCommandUnavailable(error, "test_connection_with_info")) throw error;
    return normalizeConnectionTestResult(await testConnection(config), config);
  }
}

export async function connectDb(config: ConnectionConfig, clientAttempt?: number): Promise<string> {
  return invokeBackend("connect_db", { config, clientAttempt });
}

export async function connectionDatabaseInfo(connectionId: string, database?: string): Promise<DatabaseConnectionInfo | undefined> {
  const info = await invokeBackend<DatabaseConnectionInfo | null>("connection_database_info", { connectionId, database });
  return info ?? undefined;
}

export async function saveConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo): Promise<void> {
  return invokeBackend("save_connection_database_info", {
    connectionId,
    databaseInfo,
  });
}

export async function connectionFinalProxyPort(config: ConnectionConfig): Promise<number> {
  return invokeBackend("connection_final_proxy_port", { config });
}

export async function disconnectDb(connectionId: string, clientAttempt?: number): Promise<void> {
  return invokeBackend("disconnect_db", { connectionId, clientAttempt });
}

export async function checkConnectionHealth(connectionId: string): Promise<void> {
  return invokeBackend("check_connection_health", { connectionId });
}

export async function connectionIdentifierQuote(connectionId: string, database?: string): Promise<string | undefined> {
  const quote = await invoke<string | null>("connection_identifier_quote", {
    connectionId,
    database,
  });
  return quote ?? undefined;
}

export async function closeDatabaseConnection(connectionId: string, database: string): Promise<boolean> {
  return invoke("close_database_connection", { connectionId, database });
}

export async function listDatabases(connectionId: string): Promise<DatabaseInfo[]> {
  return invoke("list_databases", { connectionId });
}

export async function listDatabaseStorage(connectionId: string, databases: string[]): Promise<DatabaseStorageInfo[]> {
  return invoke("list_database_storage", { connectionId, databases });
}

export async function getSqlServerCompletionContext(connectionId: string, database: string): Promise<SqlServerCompletionContext> {
  return invoke("get_sqlserver_completion_context", { connectionId, database });
}

export async function listDorisCatalogs(connectionId: string): Promise<CatalogInfo[]> {
  return invoke("list_doris_catalogs", { connectionId });
}

export async function listDorisCatalogDatabases(connectionId: string, catalog: string): Promise<DatabaseInfo[]> {
  return invoke("list_doris_catalog_databases", { connectionId, catalog });
}

export async function listSqlServerLinkedServers(connectionId: string): Promise<LinkedServerInfo[]> {
  return invoke("list_sqlserver_linked_servers", { connectionId });
}

export async function listSqlServerLinkedServerCatalogs(connectionId: string, server: string): Promise<DatabaseInfo[]> {
  return invoke("list_sqlserver_linked_server_catalogs", {
    connectionId,
    server,
  });
}

export async function listSqlServerLinkedServerSchemas(connectionId: string, server: string, catalog: string): Promise<string[]> {
  return invoke("list_sqlserver_linked_server_schemas", {
    connectionId,
    server,
    catalog,
  });
}

export async function listSqlServerLinkedServerTables(connectionId: string, server: string, catalog: string, schema: string, filter?: string, limit?: number, offset?: number): Promise<TableInfo[]> {
  return invoke("list_sqlserver_linked_server_tables", {
    connectionId,
    server,
    catalog,
    schema,
    filter,
    limit,
    offset,
  });
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

export async function listTables(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: SidebarObjectKind[], catalog?: string, tableNameFilter?: import("@/types/database").TableNameFilter): Promise<TableInfo[]> {
  return invoke("list_tables", {
    connectionId,
    database,
    schema,
    filter,
    limit,
    offset,
    objectTypes,
    catalog,
    tableNameFilter,
  });
}

export async function getTableComment(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<string | null> {
  return invoke("get_table_comment", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listObjects(connectionId: string, database: string, schema: string, objectTypes?: (SidebarObjectKind | "EVENT")[], filter?: string, limit?: number, offset?: number, catalog?: string): Promise<ObjectInfo[]> {
  return invoke("list_objects", {
    connectionId,
    database,
    schema,
    objectTypes,
    filter,
    limit,
    offset,
    catalog,
  });
}

export async function listObjectStatistics(connectionId: string, database: string, schema: string): Promise<ObjectStatistics[]> {
  return invoke("list_object_statistics", { connectionId, database, schema });
}

export async function listCompletionObjects(connectionId: string, database: string, schema: string): Promise<ObjectInfo[]> {
  return invoke("list_completion_objects", { connectionId, database, schema });
}

export async function completionAssistantSearch(request: CompletionAssistantRequest): Promise<CompletionAssistantResponse> {
  return invoke("completion_assistant_search", { request });
}

export async function getObjectSource(connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string): Promise<ObjectSource> {
  return invoke("get_object_source", {
    connectionId,
    database,
    schema,
    name,
    objectType,
    signature,
    relationName,
  });
}

export async function listSchemas(connectionId: string, database: string, applyVisibleFilter = false): Promise<string[]> {
  return invoke("list_schemas", { connectionId, database, applyVisibleFilter });
}

export async function listSchemaInfos(connectionId: string, database: string): Promise<SchemaInfo[]> {
  return invoke("list_schema_infos", { connectionId, database });
}

export async function getColumns(connectionId: string, database: string, schema: string, table: string, catalog?: string, clientSessionId?: string): Promise<ColumnInfo[]> {
  return invoke("get_columns", {
    connectionId,
    database,
    schema,
    table,
    catalog,
    clientSessionId,
  });
}

export async function getSqlServerColumnMetadata(connectionId: string, database: string, schema: string, table: string): Promise<SqlServerColumnMetadata[]> {
  return invoke("get_sqlserver_column_metadata", {
    connectionId,
    database,
    schema,
    table,
  });
}

export interface TableColumnsResult {
  table_name: string;
  columns: ColumnInfo[];
  error?: string;
}

export async function getAllColumns(connectionId: string, database: string, schema: string): Promise<TableColumnsResult[]> {
  return invoke("get_all_columns", { connectionId, database, schema });
}

export async function listDataTypes(connectionId: string, database: string): Promise<string[]> {
  return invoke("list_data_types", { connectionId, database });
}

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
  try {
    return await invoke("execute_query", {
      connectionId,
      database,
      sql,
      schema,
      executionId,
      ...options,
    });
  } catch (error) {
    throw new BackendErrorException(error);
  }
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
  try {
    return await invoke("execute_multi", {
      connectionId,
      database,
      sql,
      schema,
      executionId,
      ...options,
    });
  } catch (error) {
    throw new BackendErrorException(error);
  }
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
  const { executionId: _executionId, ...invokeOptions } = options ?? {};
  const unlisten = await listen<ExecuteMultiProgress>("query-batch-progress", (event) => {
    if (event.payload.executionId === executionId) onProgress(event.payload);
  });
  try {
    return await invoke("execute_multi", { connectionId, database, sql, schema, executionId, ...invokeOptions });
  } catch (error) {
    throw new BackendErrorException(error);
  } finally {
    unlisten();
  }
}

export async function refreshConnections(): Promise<void> {
  return invoke("refresh_connections");
}

export async function cancelQuery(executionId: string): Promise<boolean> {
  return invoke("cancel_query", { executionId });
}

export async function closeQuerySession(connectionId: string, database: string, sessionId: string, clientSessionId?: string, catalog?: string): Promise<boolean> {
  return invoke("close_query_session", {
    connectionId,
    database,
    sessionId,
    clientSessionId,
    catalog,
  });
}

export async function closeClientConnectionSession(connectionId: string, database: string, clientSessionId: string, catalog?: string): Promise<boolean> {
  return invoke("close_client_connection_session", {
    connectionId,
    database,
    clientSessionId,
    catalog,
  });
}

export async function executeBatch(connectionId: string, database: string, statements: string[], schema?: string, timeoutSecs?: number): Promise<QueryResult> {
  return invoke("execute_batch", {
    connectionId,
    database,
    statements,
    schema,
    timeoutSecs,
  });
}

export async function executeScript(connectionId: string, database: string, sql: string, schema?: string): Promise<QueryResult> {
  return invoke("execute_script", { connectionId, database, sql, schema });
}

export async function executeScriptWith2pc(connectionId: string, database: string, statements: string[], schema?: string): Promise<TransactionLog> {
  return invoke("execute_script_with_2pc", {
    connectionId,
    database,
    statements,
    schema,
  });
}

export async function executeInTransaction(connectionId: string, database: string, statements: string[], schema?: string, catalog?: string): Promise<QueryResult> {
  return invoke("execute_in_transaction", {
    connectionId,
    database,
    statements,
    schema,
    catalog,
  });
}

export async function beginManualTransaction(connectionId: string, database: string, schema?: string, catalog?: string): Promise<string> {
  return invoke("begin_manual_transaction", { connectionId, database, schema, catalog });
}

export async function executeInManualTransaction(txnSessionId: string, sql: string, database: string, schema?: string, maxRows?: number): Promise<QueryResult[]> {
  return invoke("execute_in_manual_transaction", {
    txnSessionId,
    sql,
    database,
    schema,
    maxRows,
  });
}

export async function commitManualTransaction(txnSessionId: string): Promise<QueryResult> {
  return invoke("commit_manual_transaction", { txnSessionId });
}

export async function rollbackManualTransaction(txnSessionId: string): Promise<QueryResult> {
  return invoke("rollback_manual_transaction", { txnSessionId });
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
  // Preserve Agent/driver errors so the explain view can show the actionable cause.
  return invoke<string>("get_explain_info", {
    connectionId,
    database,
    schema,
    sql,
    mode,
  });
}

export async function buildDroppedFilePreviewSql(options: DroppedFilePreviewSqlOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_dropped_file_preview_sql", {
    options,
  });
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
  return invoke("build_duckdb_attach_database_sql", {
    options: { path, name },
  });
}

export async function buildSqliteAttachDatabaseSql(path: string, name: string): Promise<string> {
  return invoke("build_sqlite_attach_database_sql", {
    options: { path, name },
  });
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

export async function buildUpdateDatabasePropertiesSql(options: DatabasePropertyEditSqlOptions): Promise<string> {
  return invoke("build_update_database_properties_sql", { options });
}

export async function buildDropSchemaSql(options: SchemaNameSqlOptions): Promise<string> {
  return invoke("build_drop_schema_sql", { options });
}

export async function buildDuplicateTableStructureSql(options: DuplicateTableStructureSqlOptions): Promise<string> {
  return invoke("build_duplicate_table_structure_sql", { options });
}

export async function buildCopyTableDataSql(options: CopyTableDataSqlOptions): Promise<string> {
  return invoke("build_copy_table_data_sql", { options });
}

export async function buildExecutableObjectSourceStatements(input: BuildEditableObjectSourceSqlInput): Promise<string[]> {
  return invoke("build_executable_object_source_statements", { input });
}

export async function buildExecutableObjectSourceSql(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return invoke("build_executable_object_source_sql", { input });
}

export async function buildEditableObjectSource(input: BuildEditableObjectSourceSqlInput): Promise<string> {
  return invoke("build_editable_object_source", { input });
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

export async function previewSqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions): Promise<SqliteTableStructureChangePreview> {
  return invoke("preview_sqlite_table_structure_change", {
    connectionId,
    database,
    options,
  });
}

export async function applySqliteTableStructureChange(connectionId: string, database: string, options: BuildTableStructureChangeSqlOptions, schemaRevision: string): Promise<QueryResult> {
  return invoke("apply_sqlite_table_structure_change", {
    connectionId,
    database,
    options,
    schemaRevision,
  });
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

export async function extractDataGridSelection(request: DataGridExtractRequest): Promise<DataGridExtractResult> {
  return invoke("extract_data_grid_selection", { request });
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

export async function buildDataGridColumnValuesFilterCondition(options: DataGridColumnValuesFilterConditionOptions): Promise<string | undefined> {
  const result = await invoke<string | null>("build_data_grid_column_values_filter_condition", { options });
  return result ?? undefined;
}

export async function buildDataGridColumnDistinctValuesSql(options: DataGridColumnDistinctValuesSqlOptions): Promise<string> {
  return invoke("build_data_grid_column_distinct_values_sql", { options });
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

export async function prepareDataCompareMissingTarget(options: import("@/lib/dataGrid/dataCompare").DataCompareMissingTargetOptions): Promise<DataCompareFromTablesPreparation> {
  return invoke("prepare_data_compare_missing_target", { options });
}

export async function buildDataCompareSyncPlan(options: DataCompareSyncPlanOptions): Promise<DataCompareSyncPlan> {
  return invoke("build_data_compare_sync_plan", { options });
}

export async function listIndexes(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<IndexInfo[]> {
  return invoke("list_indexes", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listForeignKeys(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ForeignKeyInfo[]> {
  return invoke("list_foreign_keys", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listTriggers(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<TriggerInfo[]> {
  return invoke("list_triggers", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listConstraints(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<ConstraintInfo[]> {
  return invoke("list_constraints", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listPartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<PartitionInfo[]> {
  return invoke("list_partitions", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function listSubpartitions(connectionId: string, database: string, schema: string, table: string, catalog?: string): Promise<SubpartitionInfo[]> {
  return invoke("list_subpartitions", {
    connectionId,
    database,
    schema,
    table,
    catalog,
  });
}

export async function getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return invoke("get_table_ddl", {
    connectionId,
    database,
    schema,
    table,
    objectType,
    catalog,
  });
}

export async function getTableDisplayDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind, catalog?: string): Promise<string> {
  return invoke("get_table_ddl", {
    connectionId,
    database,
    schema,
    table,
    objectType,
    catalog,
    includePostgresAccess: true,
  });
}

export async function prepareSchemaDiff(options: SchemaDiffPreparationOptions): Promise<SchemaDiffPreparation> {
  return invoke("prepare_schema_diff", { options });
}

export async function listDialectDataTypes(dialectName: string): Promise<string[]> {
  return invoke("list_dialect_data_types", { dialectName });
}

export async function generateSchemaSyncSql(diffs: TableDiff[], databaseType: DatabaseType, targetSchema?: string, functionDiffs?: FunctionDiff[], sequenceDiffs?: SequenceDiff[], ruleDiffs?: RuleDiff[], ownerDiffs?: OwnerDiff[], cascadeDelete?: boolean): Promise<string> {
  return invoke("generate_schema_sync_sql", {
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
  return invoke("list_functions", { connectionId, database, schema });
}

export async function listSequences(connectionId: string, database: string, schema: string, withLastValues: boolean): Promise<SequenceInfo[]> {
  return invoke("list_sequences", {
    connectionId,
    database,
    schema,
    withLastValues,
  });
}

export async function listRules(connectionId: string, database: string, schema: string): Promise<RuleInfo[]> {
  return invoke("list_rules", { connectionId, database, schema });
}

export async function listOwners(connectionId: string, database: string, schema: string): Promise<OwnerInfo[]> {
  return invoke("list_owners", { connectionId, database, schema });
}

export async function listExtensions(connectionId: string, database: string, schema?: string): Promise<ExtensionInfo[]> {
  return invoke("list_extensions", { connectionId, database, schema });
}

export async function listAvailableExtensions(connectionId: string, database: string): Promise<ExtensionInfo[]> {
  return invoke("list_available_extensions", { connectionId, database });
}

// --- Docs ---

export async function collectDocsSnapshot(connectionId: string, database: string, schemas: string[], tables: string[], projectName?: string): Promise<SchemaSnapshot> {
  return invoke("docs_collect_snapshot", { connectionId, database, schemas, tables, projectName });
}

export async function loadDocsAnnotations(connectionId: string): Promise<AnnotationFile | null> {
  return invoke("docs_load_annotations", { connectionId });
}

export async function applyDocsAnnotations(connectionId: string, snapshot: SchemaSnapshot, annotations: AnnotationFile): Promise<SchemaSnapshot> {
  return invoke("docs_apply_annotations", { connectionId, snapshot, annotations });
}

export async function saveDocsAnnotations(connectionId: string, annotations: AnnotationFile): Promise<void> {
  return invoke("docs_save_annotations", { connectionId, annotations });
}

export async function exportDocsHtml(filePath: string, snapshot: SchemaSnapshot, annotations: AnnotationFile, lang: string): Promise<void> {
  return invoke("docs_export_html", { filePath, snapshot, annotations, lang });
}

export async function saveConnections(configs: ConnectionConfig[]): Promise<void> {
  return invoke("save_connections", { configs });
}

export async function loadConnections(): Promise<ConnectionConfig[]> {
  return invoke("load_connections");
}

export async function loadTunnelProfiles(): Promise<TunnelProfile[]> {
  return invoke("load_tunnel_profiles");
}

export async function saveTunnelProfiles(profiles: TunnelProfile[]): Promise<void> {
  return invoke("save_tunnel_profiles", { profiles });
}

export async function testTunnelProfile(profile: TunnelProfile): Promise<string> {
  return invoke("test_tunnel_profile", { profile });
}

export async function resolveSshPrompt(resolution: SshPromptResolution): Promise<void> {
  await invoke("resolve_ssh_prompt", { resolution });
}

export async function readKeychainPassword(service: string): Promise<string> {
  return invoke("read_keychain_password", { service, account: null });
}

export async function readKeychainPasswords(services: string[]): Promise<[string, string][]> {
  return invoke("read_keychain_passwords", { services });
}

export async function decryptConfig(payload: unknown, passphrase: string): Promise<string> {
  const { decryptConfig: decryptConfigPayload } = await import("@/lib/backend/configCrypto");
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

export async function listJdbcLocalBundles(): Promise<JdbcLocalBundleInfo[]> {
  return invoke("list_jdbc_local_bundles");
}

export async function importJdbcDrivers(paths: (string | File)[]): Promise<JdbcDriverInfo[]> {
  if (paths.some((path) => typeof path !== "string")) {
    throw new Error("Desktop JDBC driver import requires local file paths");
  }
  return invoke("import_jdbc_drivers", { paths });
}

export async function installJdbcDriverFromMaven(coordinate: string, repositories: string[] = []): Promise<JdbcDriverInfo[]> {
  return invoke("install_jdbc_driver_from_maven", {
    request: { coordinate, repositories },
  });
}

export async function installPrestoSqlJdbcDriver(): Promise<JdbcDriverInfo[]> {
  return invoke("install_prestosql_jdbc_driver");
}

export async function deleteJdbcDriver(path: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_driver", { path });
}

export async function deleteJdbcMavenBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_maven_bundle", { bundleId });
}

export async function deleteJdbcLocalBundle(bundleId: string): Promise<JdbcDriverInfo[]> {
  return invoke("delete_jdbc_local_bundle", { bundleId });
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

export async function listInstalledAgents(source?: UpdateDownloadSource): Promise<AgentDriverInfo[]> {
  return invoke("list_installed_agents", { source });
}

export async function isAgentInstalled(dbType: string): Promise<boolean> {
  return invoke("is_agent_installed", { dbType });
}

export async function getDriverStoreUsage(): Promise<DriverStoreUsage> {
  return invoke("get_driver_store_usage");
}

export async function clearDriverDownloadCache(): Promise<void> {
  return invoke("clear_driver_download_cache");
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

export async function installAgent(dbType: string, source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  return invoke("install_agent", { dbType, source, operationId });
}

export async function upgradeAllAgents(source?: UpdateDownloadSource, operationId?: string): Promise<UpgradeAllAgentDriversResult> {
  return invoke("upgrade_all_agents", { source, operationId });
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

export async function importAgentsFromZip(path: string | File, operationId?: string): Promise<number> {
  if (typeof path !== "string") {
    throw new Error("Desktop offline package import requires a local file path");
  }
  return invoke("import_agents_from_zip", { path, operationId });
}

export async function importAgentDriver(dbType: string, path: string | File): Promise<void> {
  if (typeof path !== "string") {
    throw new Error("Desktop driver import requires a local file path");
  }
  return invoke("import_agent_driver_cmd", { dbType, path });
}

export const importAgentJar = importAgentDriver;

export async function reinstallJre(jreKey?: string, source?: UpdateDownloadSource, operationId?: string): Promise<void> {
  return invoke("reinstall_jre", { jreKey, source, operationId });
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

export async function loadSavedSqlFile(id: string): Promise<SavedSqlFile | null> {
  return invoke("load_saved_sql_file", { id });
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

export async function revealPathInFileManager(path: string): Promise<void> {
  return invoke("reveal_path_in_file_manager", { path });
}

export async function deleteDatabaseBackupFiles(paths: string[]): Promise<number> {
  return invoke("delete_database_backup_files", { paths });
}

export async function isSqliteDatabaseFile(path: string): Promise<boolean> {
  return invoke("is_sqlite_database_file", { path });
}

export async function backupSqliteDatabase(connectionId: string, destinationPath: string): Promise<void> {
  return invoke("backup_sqlite_database", { connectionId, destinationPath });
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
  manual_update_only: boolean;
  release_name: string;
  release_url: string;
  release_notes: string;
}

export type UpdateDownloadSource = "official" | "cnb";

export interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
}

export interface McpServerStatus {
  installed: boolean;
  npm_available: boolean;
  node_path: string | null;
  node_version: string | null;
  current_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  bin_path: string | null;
  native_bin_path: string | null;
  script_path: string | null;
  data_dir: string | null;
  install_command: string;
  update_command: string;
  error: string | null;
}

export async function checkMcpServerStatus(): Promise<McpServerStatus> {
  return invoke("check_mcp_server_status");
}

export async function installMcpServer(): Promise<string> {
  return invoke("install_mcp_server");
}

export async function checkForUpdates(locale?: string, source?: UpdateDownloadSource): Promise<UpdateInfo> {
  return invoke("check_for_updates", { locale, source });
}

export async function fetchChangelog(lang?: string): Promise<import("@/lib/app/changelog").ChangelogData> {
  return invoke("fetch_changelog", { lang });
}

export async function getSystemProxyUrl(): Promise<string | null> {
  return invoke("get_system_proxy_url");
}

export async function downloadUpdate(source: UpdateDownloadSource, latestVersion?: string): Promise<void> {
  return invoke("download_update", { source, latestVersion });
}

export async function cancelUpdateDownload(): Promise<void> {
  return invoke("cancel_update_download");
}

export async function installDownloadedUpdate(): Promise<void> {
  return invoke("install_downloaded_update");
}

export async function getAppVersion(): Promise<string> {
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

export async function getAppSupportInfo(): Promise<AppSupportInfo> {
  return invoke<AppSupportInfo>("get_app_support_info");
}

// --- Redis ---
export interface RedisKeyInfo {
  key_display: string;
  key_raw: string;
  key_type?: string;
  ttl?: number;
  size?: number;
  value_preview?: string;
}

export interface RedisDatabaseInfo {
  db: number;
  keys: number;
}

export type RedisBlobEncoding = "utf8" | "binary";

export interface RedisBlob {
  raw_base64: string;
  encoding: RedisBlobEncoding;
}

export interface RedisListItem {
  index: number;
  value: RedisBlob;
}

export interface RedisSetItem {
  member: RedisBlob;
}

export interface RedisHashItem {
  field: RedisBlob;
  value: RedisBlob;
  field_ttl?: number;
}

export interface RedisZsetItem {
  score: string;
  member: RedisBlob;
}

export interface RedisStreamField {
  field: string;
  value: string;
}

export interface RedisStreamEntry {
  id: string;
  fields: RedisStreamField[];
}

export interface RedisStreamPage {
  entries: RedisStreamEntry[];
  next_cursor?: string;
}

// Redis counters above Number.MAX_SAFE_INTEGER are transported as decimal strings.
export type RedisStreamMetric = number | string;

export interface RedisStreamGroup {
  name: RedisBlob;
  consumers: RedisStreamMetric;
  pending: RedisStreamMetric;
  last_delivered_id: string;
  entries_read?: RedisStreamMetric;
  lag?: RedisStreamMetric;
}

export interface RedisStreamConsumer {
  name: RedisBlob;
  pending: RedisStreamMetric;
  idle_ms: RedisStreamMetric;
  inactive_ms?: RedisStreamMetric;
}

export interface RedisStreamPendingEntry {
  id: string;
  consumer: RedisBlob;
  idle_ms: RedisStreamMetric;
  deliveries: RedisStreamMetric;
}

export interface RedisStreamPendingPage {
  entries: RedisStreamPendingEntry[];
  next_cursor?: string;
}

export type RedisValueData =
  | { kind: "string"; content: RedisBlob }
  | { kind: "json"; value: string }
  | {
      kind: "list";
      items: RedisListItem[];
      total: number;
      scan_cursor?: number;
    }
  | { kind: "set"; items: RedisSetItem[]; total: number; scan_cursor?: number }
  | {
      kind: "hash";
      items: RedisHashItem[];
      total: number;
      scan_cursor?: number;
    }
  | {
      kind: "zset";
      items: RedisZsetItem[];
      total: number;
      scan_cursor?: number;
    }
  | { kind: "stream"; entries: RedisStreamEntry[]; total?: number; next_cursor?: string }
  | { kind: "unknown" };

export interface RedisValue {
  key_display: string;
  key_raw: string;
  ttl: number;
  redis_type: string;
  data: RedisValueData;
}

export type RedisCollectionPage = { kind: "list"; items: RedisListItem[]; scan_cursor?: number } | { kind: "set"; items: RedisSetItem[]; scan_cursor?: number } | { kind: "hash"; items: RedisHashItem[]; scan_cursor?: number } | { kind: "zset"; items: RedisZsetItem[]; scan_cursor?: number };

export interface RedisScanResult {
  cursor: number;
  keys: RedisKeyInfo[];
  total_keys: number;
}

export type RedisCommandSafety = "allowed" | "write" | "confirm" | "blocked";

export interface RedisCommandResult {
  command: string;
  safety: RedisCommandSafety;
  value: any;
}

export interface RedisSlowlogEntry {
  id: number;
  timestamp: number;
  duration_micros: number;
  command: string;
  client_addr: string | null;
  client_name: string | null;
}

export interface RedisNodeEndpoint {
  host: string;
  port: number;
}

export async function redisListDatabases(connectionId: string): Promise<RedisDatabaseInfo[]> {
  return invoke("redis_list_databases", { connectionId });
}

export async function redisScanKeys(connectionId: string, db: number, cursor: number, pattern: string, count: number): Promise<RedisScanResult> {
  return invoke("redis_scan_keys", {
    connectionId,
    db,
    cursor,
    pattern,
    count,
  });
}

export async function redisScanKeysBatch(connectionId: string, db: number, cursor: number, pattern: string, count: number, maxIterations: number, includeTypes = true): Promise<RedisScanResult> {
  return invoke("redis_scan_keys_batch", {
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
  return invoke("redis_scan_values", {
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
  return invoke("redis_get_value", { connectionId, db, keyRaw });
}

export async function redisGetTtl(connectionId: string, db: number, keyRaw: string): Promise<number> {
  return invoke("redis_get_ttl", { connectionId, db, keyRaw });
}

export async function redisGetStreamEntries(connectionId: string, db: number, keyRaw: string, cursor?: string): Promise<RedisStreamPage> {
  return invoke("redis_get_stream_entries", { connectionId, db, keyRaw, cursor });
}

export async function redisGetStreamGroups(connectionId: string, db: number, keyRaw: string): Promise<RedisStreamGroup[]> {
  return invoke("redis_get_stream_groups", { connectionId, db, keyRaw });
}

export async function redisGetStreamConsumers(connectionId: string, db: number, keyRaw: string, groupRaw: string): Promise<RedisStreamConsumer[]> {
  return invoke("redis_get_stream_consumers", {
    connectionId,
    db,
    keyRaw,
    groupRaw,
  });
}

export async function redisGetStreamPending(connectionId: string, db: number, keyRaw: string, groupRaw: string, cursor?: string, consumerRaw?: string): Promise<RedisStreamPendingPage> {
  return invoke("redis_get_stream_pending", {
    connectionId,
    db,
    keyRaw,
    groupRaw,
    cursor,
    ...(consumerRaw === undefined ? {} : { consumerRaw }),
  });
}

export async function redisSetString(connectionId: string, db: number, keyRaw: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_set_string", { connectionId, db, keyRaw, value, ttl });
}

export async function redisDeleteKey(connectionId: string, db: number, keyRaw: string): Promise<void> {
  return invoke("redis_delete_key", { connectionId, db, keyRaw });
}

export async function redisHashSet(connectionId: string, db: number, keyRaw: string, field: string, value: string, ttl?: number): Promise<void> {
  return invoke("redis_hash_set", {
    connectionId,
    db,
    keyRaw,
    field,
    value,
    ttl,
  });
}

export async function redisHashDel(connectionId: string, db: number, keyRaw: string, field: string): Promise<void> {
  return invoke("redis_hash_del", { connectionId, db, keyRaw, field });
}

export async function redisHashFieldSetTtl(connectionId: string, db: number, keyRaw: string, field: string, ttl: number): Promise<void> {
  return invoke("redis_hash_field_set_ttl", { connectionId, db, keyRaw, field, ttl });
}

export async function redisHashFieldSetExpireAt(connectionId: string, db: number, keyRaw: string, field: string, expireAt: number): Promise<void> {
  return invoke("redis_hash_field_set_expire_at", { connectionId, db, keyRaw, field, expireAt });
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

export async function redisZsetUpdate(connectionId: string, db: number, keyRaw: string, originalMember: string, expectedScore: string, member: string, score: string): Promise<boolean> {
  return invoke("redis_zset_update", { connectionId, db, keyRaw, originalMember, expectedScore, member, score });
}

export async function redisStreamAdd(connectionId: string, db: number, keyRaw: string, entryId: string, fields: [string, string][], ttl?: number): Promise<void> {
  return invoke("redis_stream_add", {
    connectionId,
    db,
    keyRaw,
    entryId,
    fields,
    ttl,
  });
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

export async function redisSetExpireAt(connectionId: string, db: number, keyRaw: string, expireAt: number): Promise<void> {
  return invoke("redis_set_expire_at", { connectionId, db, keyRaw, expireAt });
}

export async function redisDeleteKeys(connectionId: string, db: number, keyRaws: string[]): Promise<number> {
  return invoke("redis_delete_keys", { connectionId, db, keyRaws });
}

export async function redisFlushDb(connectionId: string, db: number): Promise<void> {
  return invoke("redis_flush_db", { connectionId, db });
}

export async function redisExecuteCommand(connectionId: string, db: number, command: string, skipSafetyCheck?: boolean): Promise<RedisCommandResult> {
  return invoke("redis_execute_command", {
    connectionId,
    db,
    command,
    skipSafetyCheck: skipSafetyCheck ?? false,
  });
}

export async function redisLoadMore(connectionId: string, db: number, keyRaw: string, keyType: string, cursor: number, count: number, filter?: string, sortDirection?: "asc" | "desc"): Promise<RedisCollectionPage> {
  return invoke("redis_load_more", {
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
  return invoke("redis_pubsub_publish", { connectionId, db, channel, message });
}

export async function redisPubSubConnect(connectionId: string): Promise<WebSocket> {
  const port = await invoke<number>("redis_pubsub_server_port");
  return new WebSocket(`ws://127.0.0.1:${port}/api/redis/pubsub/ws?connectionId=${encodeURIComponent(connectionId)}`);
}

export async function redisSlowlogGet(connectionId: string, count: number, nodeHost?: string, nodePort?: number): Promise<RedisSlowlogEntry[]> {
  return invoke("redis_slowlog_get", {
    connectionId,
    count,
    nodeHost,
    nodePort,
  });
}

export async function redisClusterMasterNodes(connectionId: string): Promise<RedisNodeEndpoint[]> {
  return invoke("redis_cluster_master_nodes", { connectionId });
}

// --- etcd ---
export type KvValueEncoding = "utf8" | "base64";
export type KvInt64 = string;

export interface KvValue {
  encoding: KvValueEncoding;
  data: string;
}

export interface KvKeyMetadata {
  createRevision?: KvInt64 | number | null;
  modRevision?: KvInt64 | number | null;
  version?: KvInt64 | number | null;
  lease?: KvInt64 | number | null;
  ttl?: number | null;
  valueSize?: number | null;
  czxid?: number | null;
  mzxid?: number | null;
  pzxid?: number | null;
  ctime?: number | null;
  mtime?: number | null;
  cversion?: number | null;
  aversion?: number | null;
  ephemeralOwner?: number | null;
  dataLength?: number | null;
  numChildren?: number | null;
  flags?: KvInt64 | number | null;
  lockIndex?: KvInt64 | number | null;
  session?: string | null;
}

export interface KvKeySummary extends KvKeyMetadata {
  key: string;
  keyIdentity?: string | null;
  keyBytes?: KvValue | null;
  value?: KvValue | null;
}

export interface KvListPrefixResponse {
  keys: KvKeySummary[];
  continuation?: string | null;
  revision?: KvInt64 | number | null;
  filteredByAcls?: boolean | null;
}

export interface KvListPrefixOptions {
  recursive?: boolean | null;
  revision?: KvInt64 | null;
  includeValues?: boolean | null;
}

export interface KvGetResponse {
  found: boolean;
  key?: string | null;
  keyIdentity?: string | null;
  keyBytes?: KvValue | null;
  value?: KvValue | null;
  metadata?: KvKeyMetadata | null;
}

export interface KvGetOptions {
  metadataOnly?: boolean | null;
  keyBytes?: KvValue | null;
  revision?: KvInt64 | null;
}

export interface KvPutResponse {
  revision?: number | null;
  version?: number | null;
  mtime?: number | null;
  key?: string | null;
  createdKey?: string | null;
}

export type KvWriteMode = "upsert" | "create" | "update";
export type KvCreateMode = "persistent" | "ephemeral" | "persistent_sequential" | "ephemeral_sequential";

export interface KvPutOptions {
  lease?: KvInt64 | number | null;
  ttl?: number | null;
  preserveLease?: boolean | null;
  writeMode?: KvWriteMode | null;
  createMode?: KvCreateMode | null;
  keyBytes?: KvValue | null;
  expectedModRevision?: KvInt64 | null;
  expectedCreateRevision?: KvInt64 | null;
  flags?: KvInt64 | null;
}

export interface KvDeleteOptions {
  keyBytes?: KvValue | null;
  expectedModRevision?: KvInt64 | null;
}

export interface KvDeleteResponse {
  deleted: number;
  revision?: KvInt64 | number | null;
}

export type KvHistoryEventType = "put" | "delete";
export interface KvHistoryEvent {
  eventType: KvHistoryEventType;
  revision: KvInt64;
  value?: KvValue | null;
  previousValue?: KvValue | null;
  metadata?: KvKeyMetadata | null;
}
export interface KvHistoryResponse {
  events: KvHistoryEvent[];
  observedRevision: KvInt64;
  truncated: boolean;
}
export interface KvStatusMember {
  endpoint: string;
  memberId?: KvInt64 | null;
  name?: string | null;
  version?: string | null;
  leaderId?: KvInt64 | null;
  revision?: KvInt64 | null;
  raftTerm?: KvInt64 | null;
  raftIndex?: KvInt64 | null;
  raftAppliedIndex?: KvInt64 | null;
  dbSize?: KvInt64 | null;
  dbSizeInUse?: KvInt64 | null;
  learner: boolean;
  reachable: boolean;
  latencyMs?: number | null;
  errors: string[];
}
export interface KvPrometheusMetrics {
  available: boolean;
  sourceUrl?: string | null;
  error?: string | null;
  collectedAtMs?: number | null;
  sampleCount?: number | null;
  serverVersion?: string | null;
  clusterVersion?: string | null;
  goVersion?: string | null;
  authRevision?: number | null;
  hasLeader?: number | null;
  isLeader?: number | null;
  leaderChangesTotal?: number | null;
  proposalsCommittedTotal?: number | null;
  proposalsAppliedTotal?: number | null;
  proposalsPending?: number | null;
  proposalsFailedTotal?: number | null;
  grpcRequestsTotal?: number | null;
  grpcFailuresTotal?: number | null;
  grpcMethodRequestsTotal: Record<string, number>;
  grpcMethodFailuresTotal: Record<string, number>;
  requestDurationSecondsSumByType: Record<string, number>;
  requestDurationSecondsCountByType: Record<string, number>;
  mvccPutTotal?: number | null;
  mvccDeleteTotal?: number | null;
  mvccRangeTotal?: number | null;
  mvccTxnTotal?: number | null;
  mvccCurrentRevision?: number | null;
  mvccCompactRevision?: number | null;
  mvccKeysTotal?: number | null;
  mvccEventsTotal?: number | null;
  mvccPendingEventsTotal?: number | null;
  mvccSlowWatcherTotal?: number | null;
  mvccWatchStreamTotal?: number | null;
  mvccWatcherTotal?: number | null;
  mvccTotalPutSizeBytes?: number | null;
  openReadTransactions?: number | null;
  leaseGrantedTotal?: number | null;
  leaseRenewedTotal?: number | null;
  leaseRevokedTotal?: number | null;
  leaseExpiredTotal?: number | null;
  leaseTtlSecondsSum?: number | null;
  leaseTtlSecondsCount?: number | null;
  clientReceivedBytesTotal?: number | null;
  clientSentBytesTotal?: number | null;
  peerReceivedBytesTotal?: number | null;
  peerSentBytesTotal?: number | null;
  peerReceivedFailuresTotal?: number | null;
  peerSentFailuresTotal?: number | null;
  walFsyncDurationSecondsSum?: number | null;
  walFsyncDurationSecondsCount?: number | null;
  walWriteBytesTotal?: number | null;
  walWriteDurationSecondsSum?: number | null;
  walWriteDurationSecondsCount?: number | null;
  backendCommitDurationSecondsSum?: number | null;
  backendCommitDurationSecondsCount?: number | null;
  backendSnapshotDurationSecondsSum?: number | null;
  backendSnapshotDurationSecondsCount?: number | null;
  backendDefragDurationSecondsSum?: number | null;
  backendDefragDurationSecondsCount?: number | null;
  diskDefragInflight?: number | null;
  snapshotApplyInProgress?: number | null;
  quotaBackendBytes?: number | null;
  knownPeers?: number | null;
  heartbeatSendFailuresTotal?: number | null;
  readIndexesFailedTotal?: number | null;
  slowApplyTotal?: number | null;
  slowReadIndexesTotal?: number | null;
  healthSuccessTotal?: number | null;
  healthFailuresTotal?: number | null;
  residentMemoryBytes?: number | null;
  virtualMemoryBytes?: number | null;
  cpuSecondsTotal?: number | null;
  processStartTimeSeconds?: number | null;
  processReceivedBytesTotal?: number | null;
  processTransmittedBytesTotal?: number | null;
  openFds?: number | null;
  maxFds?: number | null;
  goroutines?: number | null;
  goThreads?: number | null;
  goMaxProcs?: number | null;
  goHeapAllocBytes?: number | null;
  goHeapInuseBytes?: number | null;
  goHeapSysBytes?: number | null;
  goHeapObjects?: number | null;
  goNextGcBytes?: number | null;
  goGcDurationSecondsSum?: number | null;
  goGcDurationSecondsCount?: number | null;
  dbSizeMetricBytes?: number | null;
  dbSizeInUseMetricBytes?: number | null;
}
export interface KvStatusResponse {
  clusterId?: KvInt64 | null;
  revision?: KvInt64 | null;
  leaderId?: KvInt64 | null;
  keyCount?: KvInt64 | null;
  alarms: string[];
  members: KvStatusMember[];
  metrics?: KvPrometheusMetrics | null;
}

export interface EtcdDefragMemberResult {
  endpoint: string;
  status: "succeeded" | "failed" | "not_executed";
  durationMs?: number | null;
  error?: string | null;
}
export interface EtcdDefragResponse {
  members: EtcdDefragMemberResult[];
}
export interface EtcdWatchStartRequest {
  key: string;
  keyBytes?: KvValue | null;
  scope: "key" | "prefix";
  startRevision?: KvInt64 | null;
  includePrevKv: boolean;
}
export interface EtcdWatchStartResponse {
  watchId: string;
  startedRevision: KvInt64;
}
export interface EtcdWatchPollResponse {
  watchId: string;
  batches: Array<{ revision: KvInt64; events: Array<{ eventType: "put" | "delete"; revision: KvInt64; key: string; keyBytes?: KvValue | null; value?: KvValue | null; previousValue?: KvValue | null; metadata?: KvKeyMetadata | null }> }>;
  terminal?: { reason: string; message?: string; compactedRevision?: KvInt64 | null } | null;
}
export interface EtcdLeaseListResponse {
  leases: Array<{ id: KvInt64; ttl: number; grantedTtl?: number }>;
  partial: boolean;
  nextContinuation?: string | null;
}
export interface EtcdLeaseDetail {
  id: KvInt64;
  ttl: number;
  grantedTtl?: number;
  keys: KvValue[];
  truncated: boolean;
}
export interface EtcdAuthUserListResponse {
  users: string[];
}
export interface EtcdAuthUserDetail {
  user: string;
  roles: string[];
}
export interface EtcdAuthPermission {
  access: "read" | "write" | "readwrite";
  key: KvValue;
  rangeEnd: KvValue;
  resource: "all" | "key" | "prefix";
}
export interface EtcdAuthRoleListResponse {
  roles: string[];
}
export interface EtcdAuthRoleDetail {
  role: string;
  permissions: EtcdAuthPermission[];
}
export interface EtcdPreflightResponse {
  token: string;
  action: string;
  confirmationText: string;
  expiresAtMs: number;
  clusterId?: KvInt64 | null;
}
export interface EtcdDangerousApproval {
  preflightToken: string;
  confirmationText: string;
}

export async function etcdListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null): Promise<KvListPrefixResponse> {
  return invoke("etcd_list_prefix", {
    connectionId,
    prefix,
    limit,
    continuation,
    revision: options?.revision ?? null,
    includeValues: options?.includeValues ?? null,
  });
}

export async function etcdSupportsTtl(connectionId: string): Promise<boolean> {
  return invoke("etcd_supports_ttl", { connectionId });
}

export async function etcdGet(connectionId: string, key: string, options?: KvGetOptions | null): Promise<KvGetResponse> {
  return invoke("etcd_get", {
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
  return invoke("etcd_put", {
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
  return invoke("etcd_delete", {
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
  return invoke("etcd_rename", { connectionId, request });
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
  return invoke("etcd_history", { connectionId, request });
}
export async function etcdStatus(connectionId: string): Promise<KvStatusResponse> {
  return invoke("etcd_status", { connectionId });
}
export async function etcdPreflight(connectionId: string, action: string, params: Record<string, unknown>): Promise<EtcdPreflightResponse> {
  return invoke("etcd_preflight", { connectionId, request: { action, params } });
}
export async function etcdCompact(connectionId: string, revision: KvInt64, approval: EtcdDangerousApproval): Promise<{ revision: KvInt64 }> {
  return invoke("etcd_compact", { connectionId, revision, ...approval });
}
export async function etcdDefrag(connectionId: string, endpoints: string[], approval: EtcdDangerousApproval): Promise<EtcdDefragResponse> {
  return invoke("etcd_defrag", { connectionId, endpoints, ...approval });
}
export async function etcdWatchStart(connectionId: string, request: EtcdWatchStartRequest): Promise<EtcdWatchStartResponse> {
  return invoke("etcd_watch_start", { connectionId, request });
}
export async function etcdWatchPoll(connectionId: string, watchId: string): Promise<EtcdWatchPollResponse> {
  return invoke("etcd_watch_poll", { connectionId, watchId });
}
export async function etcdWatchStop(connectionId: string, watchId: string): Promise<{ stopped: boolean }> {
  return invoke("etcd_watch_stop", { connectionId, watchId });
}
export async function etcdLeaseList(connectionId: string, limit = 100, continuation?: string | null): Promise<EtcdLeaseListResponse> {
  return invoke("etcd_lease_list", { connectionId, limit, continuation: continuation ?? null });
}
export async function etcdLeaseCall<T = unknown>(connectionId: string, operation: "get" | "grant" | "keepalive" | "revoke", params: Record<string, unknown>, approval?: EtcdDangerousApproval): Promise<T> {
  return invoke("etcd_lease_call", { connectionId, operation, params, ...approval });
}
export async function etcdAuthCall<T = unknown>(connectionId: string, operation: string, params: Record<string, unknown>, approval?: EtcdDangerousApproval): Promise<T> {
  return invoke("etcd_auth_call", { connectionId, operation, params, ...approval });
}

// --- ZooKeeper ---
export async function zookeeperListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null): Promise<KvListPrefixResponse> {
  return invoke("zookeeper_list_prefix", {
    connectionId,
    prefix,
    limit,
    continuation,
    recursive: options?.recursive ?? null,
  });
}

export async function zookeeperGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return invoke("zookeeper_get", { connectionId, key });
}

export async function zookeeperPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null): Promise<KvPutResponse> {
  return invoke("zookeeper_put", {
    connectionId,
    key,
    value,
    options: options ?? null,
  });
}

export async function zookeeperDelete(connectionId: string, key: string): Promise<KvDeleteResponse> {
  return invoke("zookeeper_delete", { connectionId, key });
}

// --- Consul KV ---
export async function consulCapabilities(connectionId: string): Promise<import("@/types/consul").ConsulCapabilities> {
  return invoke("consul_capabilities", { connectionId });
}

export async function consulTxn(connectionId: string, request: import("@/types/consul").ConsulTxnRequest): Promise<import("@/types/consul").ConsulTxnResult> {
  return invoke("consul_txn", { connectionId, request });
}

export async function consulRenameKey(connectionId: string, source: string, target: string, expectedModifyIndex: KvInt64, copy = false): Promise<import("@/types/consul").ConsulTxnResult> {
  return invoke("consul_rename_key", { connectionId, source, target, expectedModifyIndex, copy });
}

export async function consulBlockingQuery(connectionId: string, request: import("@/types/consul").ConsulBlockingRequest): Promise<import("@/types/consul").ConsulBlockingResponse> {
  return invoke("consul_blocking_query", { connectionId, request });
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
  return invoke("consul_domain_watch", { connectionId, request });
}

export async function consulCancelBlocking(connectionId: string, scope: import("@/types/consul").ConsulScope, generation: number, operationId: string): Promise<boolean> {
  return invoke("consul_cancel_blocking", { connectionId, scope, generation, operationId });
}

export async function consulWatchStart(connectionId: string, request: import("@/types/consul").ConsulBlockingRequest): Promise<string> {
  return invoke("consul_watch_start", { connectionId, request });
}

export async function consulListRecursive(connectionId: string, prefix: string, maxEntries = 10_000, maxValueBytes = 32 * 1024 * 1024): Promise<import("@/types/consul").ConsulRecursiveListResponse> {
  return invoke("consul_list_recursive", { connectionId, prefix, maxEntries, maxValueBytes });
}

export async function consulSearch(connectionId: string, request: import("@/types/consul").ConsulSearchRequest): Promise<import("@/types/consul").ConsulSearchResponse> {
  return invoke("consul_search", { connectionId, request });
}

export async function consulSearchProgress(connectionId: string, requestId: string, scope: import("@/types/consul").ConsulScope, generation: number): Promise<import("@/types/consul").ConsulSearchProgress> {
  return invoke("consul_search_progress", { connectionId, requestId, scope, generation });
}

export async function consulCancelSearch(connectionId: string, requestId: string, scope: import("@/types/consul").ConsulScope, generation: number): Promise<boolean> {
  return invoke("consul_cancel_search", { connectionId, requestId, scope, generation });
}

export async function consulExportBundle(connectionId: string, request: import("@/types/consul").ConsulExportRequest): Promise<import("@/types/consul").ConsulKvBundle> {
  return invoke("consul_export_bundle", { connectionId, request });
}

export async function consulImportPreview(connectionId: string, request: import("@/types/consul").ConsulImportRequest): Promise<import("@/types/consul").ConsulImportPreview> {
  return invoke("consul_import_preview", { connectionId, request });
}

export async function consulImportExecute(connectionId: string, request: import("@/types/consul").ConsulImportRequest): Promise<import("@/types/consul").ConsulImportReport> {
  return invoke("consul_import_execute", { connectionId, request });
}

export async function consulDeletePrefixPreview(connectionId: string, prefix: string): Promise<import("@/types/consul").ConsulDeletePrefixPreview> {
  return invoke("consul_delete_prefix_preview", { connectionId, prefix });
}

export async function consulDeletePrefixExecute(connectionId: string, request: import("@/types/consul").ConsulDeletePrefixRequest): Promise<import("@/types/consul").ConsulDeletePrefixReport> {
  return invoke("consul_delete_prefix_execute", { connectionId, request });
}

export async function consulListPrefix(connectionId: string, prefix: string, limit: number, continuation?: string | null): Promise<KvListPrefixResponse> {
  return invoke("consul_list_prefix", { connectionId, prefix, limit, continuation: continuation ?? null });
}

export async function consulGet(connectionId: string, key: string): Promise<KvGetResponse> {
  return invoke("consul_get", { connectionId, key });
}

export async function consulPut(connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null): Promise<KvPutResponse> {
  return invoke("consul_put", { connectionId, key, value, options: options ?? null });
}

export async function consulDelete(connectionId: string, key: string, options?: KvDeleteOptions | null): Promise<KvDeleteResponse> {
  return invoke("consul_delete", { connectionId, key, options: options ?? null });
}

export async function consulPreparedQueryList(connectionId: string): Promise<import("@/types/consul").ConsulPreparedQuery[]> {
  return invoke("consul_prepared_query_list", { connectionId });
}
export async function consulPreparedQueryRead(connectionId: string, id: string): Promise<import("@/types/consul").ConsulPreparedQuery> {
  return invoke("consul_prepared_query_read", { connectionId, id });
}
export async function consulPreparedQueryCreate(connectionId: string, input: import("@/types/consul").ConsulPreparedQueryInput): Promise<string> {
  return invoke("consul_prepared_query_create", { connectionId, input });
}
export async function consulPreparedQueryUpdate(connectionId: string, id: string, input: import("@/types/consul").ConsulPreparedQueryInput): Promise<void> {
  return invoke("consul_prepared_query_update", { connectionId, id, input });
}
export async function consulPreparedQueryDelete(connectionId: string, id: string): Promise<void> {
  return invoke("consul_prepared_query_delete", { connectionId, id });
}
export async function consulPreparedQueryExecute(connectionId: string, request: import("@/types/consul").ConsulPreparedQueryExecuteRequest): Promise<import("@/types/consul").ConsulPreparedQueryExecuteResponse> {
  return invoke("consul_prepared_query_execute", { connectionId, request });
}
export async function consulPreparedQueryExplain(connectionId: string, query: string): Promise<unknown> {
  return invoke("consul_prepared_query_explain", { connectionId, query });
}
export async function consulEventList(connectionId: string, name?: string | null): Promise<import("@/types/consul").ConsulEvent[]> {
  return invoke("consul_event_list", { connectionId, name: name ?? null });
}
export async function consulEventFire(connectionId: string, request: import("@/types/consul").ConsulEventFireRequest): Promise<import("@/types/consul").ConsulEvent> {
  return invoke("consul_event_fire", { connectionId, request });
}
export async function consulCoordinateNodes(connectionId: string): Promise<import("@/types/consul").ConsulCoordinate[]> {
  return invoke("consul_coordinate_nodes", { connectionId });
}
export async function consulOperatorRead(connectionId: string, kind: import("@/types/consul").ConsulOperatorReadKind): Promise<import("@/types/consul").ConsulOperatorDocument> {
  return invoke("consul_operator_read", { connectionId, kind });
}
export async function consulSnapshotGenerate(connectionId: string): Promise<import("@/types/consul").ConsulSnapshot> {
  return invoke("consul_snapshot_generate", { connectionId });
}
export async function consulSnapshotRestore(connectionId: string, request: import("@/types/consul").ConsulSnapshotRestoreRequest): Promise<void> {
  return invoke("consul_snapshot_restore", { connectionId, request });
}
export async function consulAutopilotUpdate(connectionId: string, update: import("@/types/consul").ConsulAutopilotUpdate, confirmation: string): Promise<void> {
  return invoke("consul_autopilot_update", { connectionId, update, confirmation });
}
export async function consulRaftTransfer(connectionId: string, request: import("@/types/consul").ConsulRaftWriteRequest): Promise<void> {
  return invoke("consul_raft_transfer", { connectionId, request });
}
export async function consulRaftRemove(connectionId: string, request: import("@/types/consul").ConsulRaftWriteRequest): Promise<void> {
  return invoke("consul_raft_remove", { connectionId, request });
}
export async function consulKeyringWrite(connectionId: string, request: import("@/types/consul").ConsulKeyringWriteRequest): Promise<void> {
  return invoke("consul_keyring_write", { connectionId, request });
}
export async function consulLicenseWrite(connectionId: string, request: import("@/types/consul").ConsulLicenseWriteRequest): Promise<void> {
  return invoke("consul_license_write", { connectionId, request });
}

export async function consulStatusLeader(connectionId: string): Promise<string> {
  return invoke("consul_status_leader", { connectionId });
}
export async function consulStatusPeers(connectionId: string): Promise<string[]> {
  return invoke("consul_status_peers", { connectionId });
}
export async function consulAgentSelf(connectionId: string): Promise<import("@/types/consul").ConsulAgentIdentity> {
  return invoke("consul_agent_self", { connectionId });
}
export async function consulAgentMembers(connectionId: string, wan = false, segment?: string | null): Promise<import("@/types/consul").ConsulAgentMember[]> {
  return invoke("consul_agent_members", { connectionId, wan, segment: segment ?? null });
}
export async function consulAgentMetrics(connectionId: string): Promise<unknown> {
  return invoke("consul_agent_metrics", { connectionId });
}
export async function consulCatalogDatacenters(connectionId: string): Promise<string[]> {
  return invoke("consul_catalog_datacenters", { connectionId });
}
export async function consulCatalogNodes(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulCatalogNode[]>> {
  return invoke("consul_catalog_nodes", { connectionId, options });
}
export async function consulCatalogServices(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<Record<string, string[]>>> {
  return invoke("consul_catalog_services", { connectionId, options });
}
export async function consulCatalogServiceNodes(connectionId: string, service: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulCatalogServiceNode[]>> {
  return invoke("consul_catalog_service_nodes", { connectionId, service, options });
}
export async function consulCatalogNodeServices(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulNodeServices>> {
  return invoke("consul_catalog_node_services", { connectionId, node, options });
}
export async function consulHealthNode(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return invoke("consul_health_node", { connectionId, node, options });
}
export async function consulHealthChecks(connectionId: string, service: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return invoke("consul_health_checks", { connectionId, service, options });
}
export async function consulHealthService(connectionId: string, service: string, passing: boolean | null = null, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulServiceInstance[]>> {
  return invoke("consul_health_service", { connectionId, service, passing, options });
}
export async function consulHealthState(connectionId: string, healthState: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulHealthCheck[]>> {
  return invoke("consul_health_state", { connectionId, healthState, options });
}
export async function consulAgentServices(connectionId: string): Promise<Record<string, import("@/types/consul").ConsulAgentService>> {
  return invoke("consul_agent_services", { connectionId });
}
export async function consulAgentService(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentService> {
  return invoke("consul_agent_service", { connectionId, id });
}
export async function consulAgentChecks(connectionId: string): Promise<Record<string, import("@/types/consul").ConsulHealthCheck>> {
  return invoke("consul_agent_checks", { connectionId });
}
export async function consulAgentRegisterService(connectionId: string, registration: import("@/types/consul").ConsulAgentServiceRegistration): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_register_service", { connectionId, registration });
}
export async function consulAgentDeregisterService(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_deregister_service", { connectionId, id });
}
export async function consulAgentServiceMaintenance(connectionId: string, id: string, enable: boolean, reason?: string | null): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_service_maintenance", { connectionId, id, enable, reason: reason ?? null });
}
export async function consulAgentRegisterCheck(connectionId: string, registration: import("@/types/consul").ConsulAgentCheckRegistration): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_register_check", { connectionId, registration });
}
export async function consulAgentDeregisterCheck(connectionId: string, id: string): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_deregister_check", { connectionId, id });
}
export async function consulAgentUpdateTtl(connectionId: string, id: string, status: import("@/types/consul").ConsulCheckStatus, output?: string | null): Promise<import("@/types/consul").ConsulAgentWriteResult> {
  return invoke("consul_agent_update_ttl", { connectionId, id, status, output: output ?? null });
}
export async function consulSessions(connectionId: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulSession[]>> {
  return invoke("consul_sessions", { connectionId, options });
}
export async function consulNodeSessions(connectionId: string, node: string, options: import("@/types/consul").ConsulReadOptions = {}): Promise<import("@/types/consul").ConsulListResponse<import("@/types/consul").ConsulSession[]>> {
  return invoke("consul_node_sessions", { connectionId, node, options });
}
export async function consulSession(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSession | null> {
  return invoke("consul_session", { connectionId, id });
}
export async function consulSessionKeys(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSessionKeysResponse> {
  return invoke("consul_session_keys", { connectionId, id });
}
export async function consulSessionDestroyImpact(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSessionDestroyImpact> {
  return invoke("consul_session_destroy_impact", { connectionId, id });
}
export async function consulCreateSession(connectionId: string, request: import("@/types/consul").ConsulSessionCreateRequest): Promise<import("@/types/consul").ConsulSession> {
  return invoke("consul_create_session", { connectionId, request });
}
export async function consulRenewSession(connectionId: string, id: string): Promise<import("@/types/consul").ConsulSession> {
  return invoke("consul_renew_session", { connectionId, id });
}
export async function consulDestroySession(connectionId: string, request: import("@/types/consul").ConsulSessionDestroyRequest): Promise<boolean> {
  return invoke("consul_destroy_session", { connectionId, request });
}
export async function consulAcquireLock(connectionId: string, request: import("@/types/consul").ConsulLockRequest): Promise<import("@/types/consul").ConsulLockResponse> {
  return invoke("consul_acquire_lock", { connectionId, request });
}
export async function consulReleaseLock(connectionId: string, key: string, session: string): Promise<import("@/types/consul").ConsulLockResponse> {
  return invoke("consul_release_lock", { connectionId, key, session });
}

export async function consulAclList(connectionId: string, kind: import("@/types/consul").ConsulAclKind): Promise<import("@/types/consul").ConsulAclList> {
  return invoke("consul_acl_list", { connectionId, kind });
}
export async function consulAclTokenSelf(connectionId: string): Promise<import("@/types/consul").ConsulAclToken> {
  return invoke("consul_acl_token_self", { connectionId });
}
export async function consulAclTokenClone(connectionId: string, accessorId: string, description: string): Promise<import("@/types/consul").ConsulAclToken> {
  return invoke("consul_acl_token_clone", { connectionId, accessorId, request: { Description: description } });
}
export async function consulAclGet(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclItem> {
  return invoke("consul_acl_get", { connectionId, kind, id });
}
export async function consulAclApply(connectionId: string, id: string | null, value: import("@/types/consul").ConsulAclWrite): Promise<import("@/types/consul").ConsulAclItem> {
  return invoke("consul_acl_apply", { connectionId, id, value });
}
export async function consulAclReferences(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclReferences> {
  return invoke("consul_acl_references", { connectionId, kind, id });
}
export async function consulAclDelete(connectionId: string, kind: import("@/types/consul").ConsulAclKind, id: string): Promise<import("@/types/consul").ConsulAclReferences> {
  return invoke("consul_acl_delete", { connectionId, kind, id });
}
export async function consulEnterpriseList(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind): Promise<import("@/types/consul").ConsulEnterpriseList> {
  return invoke("consul_enterprise_list", { connectionId, kind });
}
export async function consulEnterpriseGet(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulEnterpriseItem> {
  return invoke("consul_enterprise_get", { connectionId, kind, name });
}
export async function consulEnterpriseApply(connectionId: string, existingName: string | null, item: import("@/types/consul").ConsulEnterpriseWrite): Promise<import("@/types/consul").ConsulEnterpriseItem> {
  return invoke("consul_enterprise_apply", { connectionId, existingName, item });
}
export async function consulEnterpriseImpact(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulScopeImpact> {
  return invoke("consul_enterprise_impact", { connectionId, kind, name });
}
export async function consulEnterpriseDelete(connectionId: string, kind: import("@/types/consul").ConsulEnterpriseKind, name: string): Promise<import("@/types/consul").ConsulScopeImpact> {
  return invoke("consul_enterprise_delete", { connectionId, kind, name });
}
export async function consulMeshConfigList(connectionId: string, kind: string): Promise<import("@/types/consul").ConsulConfigEntry[]> {
  return invoke("consul_mesh_config_list", { connectionId, kind });
}
export async function consulMeshConfigGet(connectionId: string, kind: string, name: string): Promise<import("@/types/consul").ConsulConfigEntry> {
  return invoke("consul_mesh_config_get", { connectionId, kind, name });
}
export async function consulMeshConfigApply(connectionId: string, request: import("@/types/consul").ConsulConfigEntryApply): Promise<import("@/types/consul").ConsulConfigEntry> {
  return invoke("consul_mesh_config_apply", { connectionId, request });
}
export async function consulMeshConfigDelete(connectionId: string, kind: string, name: string, expectedModifyIndex: number): Promise<boolean> {
  return invoke("consul_mesh_config_delete", { connectionId, kind, name, expectedModifyIndex });
}
export async function consulMeshIntentionsList(connectionId: string): Promise<import("@/types/consul").ConsulIntention[]> {
  return invoke("consul_mesh_intentions_list", { connectionId });
}
export async function consulMeshIntentionGet(connectionId: string, id: string): Promise<import("@/types/consul").ConsulIntention> {
  return invoke("consul_mesh_intention_get", { connectionId, id });
}
export async function consulMeshIntentionGetExact(connectionId: string, request: import("@/types/consul").ConsulIntentionExactRequest): Promise<import("@/types/consul").ConsulIntention> {
  return invoke("consul_mesh_intention_get_exact", { connectionId, request });
}
export async function consulMeshIntentionUpsert(connectionId: string, item: import("@/types/consul").ConsulIntention): Promise<import("@/types/consul").ConsulIntention> {
  return invoke("consul_mesh_intention_upsert", { connectionId, item });
}
export async function consulMeshIntentionDelete(connectionId: string, id: string): Promise<boolean> {
  return invoke("consul_mesh_intention_delete", { connectionId, id });
}
export async function consulMeshIntentionDeleteExact(connectionId: string, request: import("@/types/consul").ConsulIntentionExactRequest): Promise<boolean> {
  return invoke("consul_mesh_intention_delete_exact", { connectionId, request });
}
export async function consulMeshIntentionMatch(connectionId: string, request: import("@/types/consul").ConsulIntentionMatchRequest): Promise<import("@/types/consul").ConsulIntention[]> {
  return invoke("consul_mesh_intention_match", { connectionId, request });
}
export async function consulMeshIntentionCheck(connectionId: string, request: import("@/types/consul").ConsulIntentionCheckRequest): Promise<import("@/types/consul").ConsulIntentionCheckResponse> {
  return invoke("consul_mesh_intention_check", { connectionId, request });
}
export async function consulMeshDiscoveryChain(connectionId: string, service: string): Promise<import("@/types/consul").ConsulDiscoveryChain> {
  return invoke("consul_mesh_discovery_chain", { connectionId, service });
}
export async function consulMeshPeeringList(connectionId: string): Promise<import("@/types/consul").ConsulPeering[]> {
  return invoke("consul_mesh_peering_list", { connectionId });
}
export async function consulMeshPeeringGet(connectionId: string, name: string): Promise<import("@/types/consul").ConsulPeering> {
  return invoke("consul_mesh_peering_get", { connectionId, name });
}
export async function consulMeshPeeringGenerateToken(connectionId: string, request: import("@/types/consul").ConsulPeeringGenerateRequest): Promise<import("@/types/consul").ConsulPeeringToken> {
  return invoke("consul_mesh_peering_generate_token", { connectionId, request });
}
export async function consulMeshPeeringEstablish(connectionId: string, request: import("@/types/consul").ConsulPeeringEstablishRequest): Promise<import("@/types/consul").ConsulPeering> {
  return invoke("consul_mesh_peering_establish", { connectionId, request });
}
export async function consulMeshPeeringDelete(connectionId: string, name: string): Promise<boolean> {
  return invoke("consul_mesh_peering_delete", { connectionId, name });
}
export async function consulMeshExportedServicesList(connectionId: string): Promise<import("@/types/consul").ConsulExportedService[]> {
  return invoke("consul_mesh_exported_services_list", { connectionId });
}
export async function consulMeshExportedServicesApply(connectionId: string, name: string, expectedModifyIndex: number, raw: Record<string, unknown>): Promise<import("@/types/consul").ConsulConfigEntry> {
  return invoke("consul_mesh_exported_services_apply", { connectionId, name, expectedModifyIndex, raw });
}

// --- HBase ---
export async function hbaseGetTableSchema(connectionId: string, namespace: string, table: string): Promise<import("@/types/hbase").HBaseTableSchema> {
  return invoke("hbase_get_table_schema", { connectionId, namespace, table });
}

export async function hbaseScanRows(connectionId: string, namespace: string, table: string, rowKeyPrefix: string | undefined, limit: number): Promise<import("@/types/hbase").HBaseScanResult> {
  return invoke("hbase_scan_rows", {
    connectionId,
    namespace,
    table,
    rowKeyPrefix,
    limit,
  });
}

export async function hbaseGetRow(connectionId: string, namespace: string, table: string, rowKey: string, rowKeyEncoding?: import("@/types/hbase").HBaseValueEncoding): Promise<import("@/types/hbase").HBaseRow | null> {
  return invoke("hbase_get_row", {
    connectionId,
    namespace,
    table,
    rowKey,
    rowKeyEncoding,
  });
}

export async function hbasePutRow(connectionId: string, namespace: string, table: string, input: import("@/types/hbase").HBasePutRowInput): Promise<void> {
  return invoke("hbase_put_row", { connectionId, namespace, table, input });
}

export async function hbaseDeleteRow(connectionId: string, namespace: string, table: string, rowKey: string, rowKeyEncoding?: import("@/types/hbase").HBaseValueEncoding): Promise<void> {
  return invoke("hbase_delete_row", {
    connectionId,
    namespace,
    table,
    rowKey,
    rowKeyEncoding,
  });
}

export async function hbaseCreateTable(connectionId: string, namespace: string, table: string, columnFamilies: string[]): Promise<void> {
  return invoke("hbase_create_table", {
    connectionId,
    namespace,
    table,
    columnFamilies,
  });
}

export async function hbaseDeleteTable(connectionId: string, namespace: string, table: string): Promise<void> {
  return invoke("hbase_delete_table", { connectionId, namespace, table });
}

// --- Document stores ---
export interface DocumentQueryResult {
  documents: any[];
  raw_documents?: string[];
  extended_documents?: any[];
  total: number;
  total_is_exact?: boolean;
}

// Kept for callers that are specifically using MongoDB APIs.
export type MongoDocumentResult = DocumentQueryResult;

export interface MongoCollectionStatsResult {
  count: unknown;
  size: unknown;
  avgObjSize: unknown;
  storageSize: unknown;
  totalIndexSize: unknown;
  nindexes: unknown;
}

export interface MongoDropIndexFailure {
  name: string;
  message: string;
}

export interface MongoDropIndexesResult {
  dropped_names: string[];
  affected_rows: number;
  failures?: MongoDropIndexFailure[];
}

export interface MongoCloneCollectionResult {
  documents_copied: number;
  indexes_copied: number;
}

export interface MongoGridFsFileInfo {
  id: string;
  filename?: string;
  length: number;
  chunkSize: number;
  uploadDate?: string;
  metadata?: any;
  md5?: string;
  contentType?: string;
  aliases?: string[];
}

export interface MongoGridFsBucketInfo {
  name: string;
  fileCount: number;
  totalBytes: number;
}

export async function documentListDatabases(connectionId: string): Promise<string[]> {
  return invoke("document_list_databases", { connectionId });
}

export async function mongoListDatabases(connectionId: string): Promise<string[]> {
  return documentListDatabases(connectionId);
}

export async function documentListCollections(connectionId: string, database: string): Promise<CollectionInfo[]> {
  return invoke("document_list_collections", { connectionId, database });
}

export async function mongoListCollections(connectionId: string, database: string): Promise<CollectionInfo[]> {
  return documentListCollections(connectionId, database);
}

export async function vectorGetCollectionDetail(connectionId: string, database: string, collection: string): Promise<CollectionInfo> {
  return invoke("vector_collection_detail", {
    connectionId,
    database,
    collection,
  });
}

export async function mongoCreateDatabase(connectionId: string, database: string): Promise<void> {
  return invoke("mongo_create_database", { connectionId, database });
}

export async function mongoDropDatabase(connectionId: string, database: string): Promise<void> {
  return invoke("mongo_drop_database", { connectionId, database });
}

export async function mongoDropCollection(connectionId: string, database: string, collection: string): Promise<void> {
  return invoke("mongo_drop_collection", {
    connectionId,
    database,
    collection,
  });
}

export async function mongoRenameCollection(connectionId: string, database: string, collection: string, newName: string): Promise<void> {
  return invoke("mongo_rename_collection", {
    connectionId,
    database,
    collection,
    newName,
  });
}

export async function mongoCloneCollection(connectionId: string, database: string, sourceCollection: string, targetCollection: string): Promise<MongoCloneCollectionResult> {
  return invoke("mongo_clone_collection", {
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

export async function mongoFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, collation?: string, executionId?: string): Promise<MongoDocumentResult> {
  return documentFindDocuments(connectionId, database, collection, skip, limit, filter, projection, sort, collation, executionId);
}

export async function mongoFindOne(connectionId: string, database: string, collection: string, filter?: string, projection?: string, options?: string, executionId?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_find_one", {
    connectionId,
    database,
    collection,
    filter,
    projection,
    options,
    executionId,
  });
}

export async function mongoParseShellCommand(source: string): Promise<MongoCommand> {
  const raw = await invoke<Record<string, unknown>>("mongo_parse_shell_command", { source });
  return normalizeRustMongoCommand(raw);
}

export async function documentFindDocuments(connectionId: string, database: string, collection: string, skip: number, limit: number, filter?: string, projection?: string, sort?: string, collation?: string, executionId?: string): Promise<DocumentQueryResult> {
  return invoke("document_find_documents", {
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
  return invoke("elasticsearch_count_documents", {
    connectionId,
    index,
    filter,
    executionId,
  });
}

export async function mongoCountDocuments(connectionId: string, database: string, collection: string, filter?: string, mode?: "accurate" | "legacy", executionId?: string): Promise<number> {
  return invoke("mongo_count_documents", {
    connectionId,
    database,
    collection,
    filter,
    mode,
    executionId,
  });
}

export async function documentListGridFsFiles(connectionId: string, database: string, bucket: string, filter?: string, sort?: string): Promise<MongoGridFsFileInfo[]> {
  return invoke("document_list_gridfs_files", {
    connectionId,
    database,
    bucket,
    filter,
    sort,
  });
}

export async function documentListGridFsBuckets(connectionId: string, database: string, filter?: string, sort?: string): Promise<MongoGridFsBucketInfo[]> {
  return invoke("document_list_gridfs_buckets", {
    connectionId,
    database,
    filter,
    sort,
  });
}

export async function documentCreateGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return invoke("document_create_gridfs_bucket", {
    connectionId,
    database,
    bucket,
  });
}

export async function documentDeleteGridFsBucket(connectionId: string, database: string, bucket: string): Promise<void> {
  return invoke("document_delete_gridfs_bucket", {
    connectionId,
    database,
    bucket,
  });
}

export async function documentDownloadGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<Uint8Array> {
  const data = await invoke<number[]>("document_download_gridfs_file", {
    connectionId,
    database,
    bucket,
    fileId,
  });
  return new Uint8Array(data);
}

export async function documentUploadGridFsFile(connectionId: string, database: string, bucket: string, fileName: string, data: Uint8Array, contentType?: string): Promise<string> {
  return invoke("document_upload_gridfs_file", {
    connectionId,
    database,
    bucket,
    fileName,
    data: Array.from(data),
    contentType,
  });
}

export async function documentDeleteGridFsFile(connectionId: string, database: string, bucket: string, fileId: string): Promise<void> {
  return invoke("document_delete_gridfs_file", {
    connectionId,
    database,
    bucket,
    fileId,
  });
}

export async function mongoServerVersion(connectionId: string, database: string, executionId?: string): Promise<string> {
  return invoke("mongo_server_version", {
    connectionId,
    database,
    executionId,
  });
}

export async function mongoAggregateDocuments(connectionId: string, database: string, collection: string, pipelineJson: string, maxRows?: number, optionsJson?: string, executionId?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_aggregate_documents", {
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
  return invoke("mongo_distinct", {
    connectionId,
    database,
    collection,
    field,
    filter,
    executionId,
  });
}

export async function mongoCollectionStats(connectionId: string, database: string, collection: string, scale?: number, executionId?: string): Promise<MongoCollectionStatsResult> {
  return invoke("mongo_collection_stats", {
    connectionId,
    database,
    collection,
    scale,
    executionId,
  });
}

export async function mongoCreateIndex(connectionId: string, database: string, collection: string, keysJson: string, optionsJson?: string): Promise<{ name: string }> {
  return invoke("mongo_create_index", {
    connectionId,
    database,
    collection,
    keysJson,
    optionsJson,
  });
}

export async function mongoCreateUser(connectionId: string, database: string, userJson: string, writeConcernJson?: string): Promise<{ affected_rows: number }> {
  return invoke("mongo_create_user", {
    connectionId,
    database,
    userJson,
    writeConcernJson,
  });
}

export async function mongoDropIndexes(connectionId: string, database: string, collection: string, indexesJson?: string, single = false): Promise<MongoDropIndexesResult> {
  return invoke("mongo_drop_indexes", {
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
  return invoke("document_insert_document", {
    connectionId,
    database,
    collection,
    docJson,
    routing,
    preserveBsonTypes,
  });
}

export async function mongoInsertDocuments(connectionId: string, database: string, collection: string, docsJson: string): Promise<{ affected_rows: number }> {
  const affectedRows = await invoke<number>("mongo_insert_documents", {
    connectionId,
    database,
    collection,
    docsJson,
  });
  return { affected_rows: affectedRows };
}

export async function mongoUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return documentUpdateDocument(connectionId, database, collection, id, docJson, routing);
}

export async function documentUpdateDocument(connectionId: string, database: string, collection: string, id: string, docJson: string, routing?: string): Promise<number> {
  return invoke("document_update_document", {
    connectionId,
    database,
    collection,
    id,
    docJson,
    routing,
  });
}

export async function mongoUpdateDocuments(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, many: boolean, optionsJson?: string): Promise<{ affected_rows: number }> {
  const affectedRows = await invoke<number>("mongo_update_documents", {
    connectionId,
    database,
    collection,
    filterJson,
    updateJson,
    many,
    optionsJson,
  });
  return { affected_rows: affectedRows };
}

export async function mongoDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string): Promise<number> {
  return documentDeleteDocument(connectionId, database, collection, id, routing);
}

export async function documentDeleteDocument(connectionId: string, database: string, collection: string, id: string, routing?: string, documentType?: string): Promise<number> {
  return invoke("document_delete_document", {
    connectionId,
    database,
    collection,
    id,
    routing,
    documentType,
  });
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

export async function mongoFindOneAndUpdate(connectionId: string, database: string, collection: string, filterJson: string, updateJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_find_one_and_update", {
    connectionId,
    database,
    collection,
    filterJson,
    updateJson,
    optionsJson,
  });
}

export async function mongoFindOneAndReplace(connectionId: string, database: string, collection: string, filterJson: string, replacementJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_find_one_and_replace", {
    connectionId,
    database,
    collection,
    filterJson,
    replacementJson,
    optionsJson,
  });
}

export async function mongoFindOneAndDelete(connectionId: string, database: string, collection: string, filterJson: string, optionsJson?: string): Promise<MongoDocumentResult> {
  return invoke("mongo_find_one_and_delete", {
    connectionId,
    database,
    collection,
    filterJson,
    optionsJson,
  });
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

export interface HistoryConnectionFilter {
  connection_id: string;
  connection_name: string;
}

export interface HistoryDatabaseFilter extends HistoryConnectionFilter {
  database: string;
}

export interface HistoryCursor {
  executed_at: string;
  id: string;
}

export interface HistorySearchRequest {
  search_text: string;
  connections: HistoryConnectionFilter[];
  databases: HistoryDatabaseFilter[];
  activity_kind?: string;
  success?: boolean;
  started_at?: string;
  ended_at?: string;
  cursor?: HistoryCursor;
  limit: number;
}

export interface HistorySearchResult {
  entries: HistoryEntry[];
  next_cursor?: HistoryCursor | null;
  total: number;
}

export interface HistoryConnectionOption extends HistoryConnectionFilter {
  databases: string[];
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  return invoke("save_history", { entry });
}

export async function loadHistory(limit: number, offset: number, activityKind?: string): Promise<HistoryEntry[]> {
  return invoke("load_history", {
    limit,
    offset,
    activityKind: activityKind ?? null,
  });
}

export async function searchHistory(request: HistorySearchRequest): Promise<HistorySearchResult> {
  return invoke("search_history", { request });
}

export async function loadHistoryConnectionOptions(): Promise<HistoryConnectionOption[]> {
  return invoke("load_history_connection_options");
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
  canExecuteWithoutSelectedDatabase: boolean;
  establishesDatabaseContext?: boolean;
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
  fileIndex?: number;
  fileName?: string;
}

export async function previewSqlFile(filePath: string): Promise<SqlFilePreview> {
  return invoke("preview_sql_file", { filePath });
}

export async function executeSqlFile(request: SqlFileRequest): Promise<void> {
  return invoke("execute_sql_file", { request });
}

export async function executeSqlFiles(request: SqlFileRequest, filePaths: string[]): Promise<void> {
  return invoke("execute_sql_files", { request, filePaths });
}

export async function cancelSqlFileExecution(executionId: string): Promise<boolean> {
  return invoke("cancel_sql_file_execution", { executionId });
}

export async function listenSqlFileProgress(handler: (progress: SqlFileProgress) => void): Promise<UnlistenFn> {
  return listen<SqlFileProgress>("sql-file-progress", (event) => handler(event.payload));
}

// --- Data Transfer ---
export type TransferMode = "append" | "overwrite" | "upsert";
export type TransferTableNameCase = "preserve" | "lower" | "upper";
export type TransferOwnershipPolicy = "preserve" | "skip" | "reassignMissing";
export type TransferContent = "structureAndData" | "structureOnly" | "dataOnly";
export type TransferObjectKind = "TABLE" | "VIEW" | "MATERIALIZED_VIEW" | "PROCEDURE" | "FUNCTION" | "TRIGGER" | "SEQUENCE" | "EVENT";

export interface TransferObjectSelection {
  objectType: TransferObjectKind;
  names: string[];
}

export interface TransferRequest {
  transferId: string;
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema: string;
  sourceCatalog?: string;
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  targetCatalog?: string;
  tables: string[];
  createTable: boolean;
  content: TransferContent;
  objects: TransferObjectSelection[];
  mode: TransferMode;
  targetTableNameCase: TransferTableNameCase;
  ownershipPolicy?: TransferOwnershipPolicy;
  batchSize: number;
}

export interface TransferOwnershipPreview {
  missingOwners: string[];
  targetOwner: string;
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
  terminal: boolean;
  transferFailuresOmitted?: number;
}

export async function startTransfer(request: TransferRequest, onProgress: (progress: TransferProgress) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      try {
        unlisten = await listen<TransferProgress>("transfer-progress", (event) => {
          if (event.payload.transferId !== request.transferId) return;
          onProgress(event.payload);
          if (isTerminalTransferProgress(event.payload)) {
            unlisten?.();
            resolve();
          }
        });

        await invoke("start_transfer", { request });
      } catch (e) {
        unlisten?.();
        reject(e instanceof BackendErrorException ? e : new BackendErrorException(e));
      }
    })();
  });
}

export async function cancelTransfer(transferId: string): Promise<void> {
  return invoke("cancel_transfer", { transferId });
}

export async function previewTransferOwnership(request: TransferRequest): Promise<TransferOwnershipPreview> {
  return invoke("preview_transfer_ownership", { request });
}

export interface SortTablesByFkOptions {
  connectionId: string;
  database: string;
  schema: string;
  tables: string[];
  parentsFirst: boolean;
}

export async function sortTablesByFkDependency(options: SortTablesByFkOptions): Promise<string[]> {
  return invoke("sort_tables_by_fk_dependency", {
    connectionId: options.connectionId,
    database: options.database,
    schema: options.schema,
    tables: options.tables,
    parentsFirst: options.parentsFirst,
  });
}

// --- Table File Import ---
export type TableImportMode = "append" | "truncate";
export type TableImportStatus = "running" | "done" | "error" | "cancelled";
export type TableImportPhase = "preparing" | "detectingEncoding" | "reading" | "writing" | "finalizing" | "done";
export type TableImportSourceFormat = "csv" | "tsv" | "delimited" | "json" | "excel";
export type TableImportJsonShape = "auto" | "objects" | "arrays";
export type TableImportTextEncoding = "auto" | "utf8" | "gbk" | "utf16Le" | "utf16Be";

export interface TableImportColumnMapping {
  sourceColumn: string;
  targetColumn: string;
  targetDataType?: string | null;
}

export interface TableImportParseOptions {
  delimiter?: string | null;
  encoding?: TableImportTextEncoding | null;
  hasHeader?: boolean | null;
  titleRow?: number | null;
  dataStartRow?: number | null;
  lastDataRow?: number | null;
  trimValues?: boolean | null;
  emptyStringAsNull?: boolean | null;
  sheetName?: string | null;
  sheetIndex?: number | null;
  jsonShape?: TableImportJsonShape | null;
}

export interface TableImportPreviewRequest {
  filePath: string;
  sourceRef?: string | null;
  sourceFormat?: TableImportSourceFormat | null;
  parseOptions?: TableImportParseOptions | null;
  previewLimit?: number | null;
}

export interface TableImportPreview {
  fileName: string;
  filePath: string;
  sourceRef?: string | null;
  fileType: string;
  sizeBytes: number;
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  totalRowsExact?: boolean;
  sourceFingerprint: string;
  effectiveEncoding?: TableImportTextEncoding | null;
  sheets?: string[];
}

export interface TableImportPreparedSource {
  fingerprint: string;
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  totalRowsExact?: boolean;
  effectiveEncoding?: TableImportTextEncoding | null;
}

export interface TableImportRequest {
  importId: string;
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  filePath: string;
  sourceRef?: string | null;
  sourceFormat?: TableImportSourceFormat | null;
  parseOptions?: TableImportParseOptions | null;
  mappings: TableImportColumnMapping[];
  mode: TableImportMode;
  createTable?: boolean;
  batchSize: number;
  dateTimeFormat?: string;
  preparedSource?: TableImportPreparedSource | null;
  retainSource?: boolean;
}

export interface TableImportSummary {
  importId: string;
  rowsImported: number;
  totalRows: number;
  elapsedMs: number;
}

export interface TableImportProgress {
  importId: string;
  status: TableImportStatus;
  phase?: TableImportPhase;
  rowsImported: number;
  totalRows: number;
  totalRowsExact?: boolean;
  bytesRead?: number;
  totalBytes?: number;
  elapsedMs: number;
  error?: string | null;
}

export async function previewTableImportFile(filePathOrRequest: string | File | TableImportPreviewRequest, options: Partial<TableImportPreviewRequest> = {}): Promise<TableImportPreview> {
  if (typeof filePathOrRequest !== "string" && !("filePath" in filePathOrRequest)) {
    throw new Error("previewTableImportFile in desktop mode requires a file path, not a File object");
  }
  const request: TableImportPreviewRequest = typeof filePathOrRequest === "string" ? { ...options, filePath: filePathOrRequest } : filePathOrRequest;
  return invoke("preview_table_import_file", { request });
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
    const summary = await invoke<TableImportSummary>("import_table_file", {
      request,
    });
    unlisten();
    return summary;
  } catch (e) {
    unlisten();
    throw e instanceof BackendErrorException ? e : new BackendErrorException(e);
  }
}

export async function cancelTableImport(importId: string): Promise<boolean> {
  return invoke("cancel_table_import", { importId });
}

export async function releaseTableImportSource(_sourceRef: string): Promise<boolean> {
  return false;
}

// --- Database Export ---
export interface DatabaseExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema: string;
  filePath: string;
  selectedTables?: string[];
  excludedTables?: string[];
  includeStructure: boolean;
  includeData: boolean;
  includeObjects: boolean;
  includeCreateDatabase?: boolean;
  dropTableIfExists?: boolean;
  omitAutoIncrement?: boolean;
  failOnError?: boolean;
  snapshotSessionId?: string;
  batchSize: number;
}

export interface DatabaseBackupSnapshot {
  sessionId: string;
  schemas: string[];
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
  /** True while listing schema / prefetching metadata before objects are written. */
  preparing?: boolean;
}

// --- Table Export ---
export type TableExportStatus = "Running" | "Writing" | "Done" | "Error" | "Cancelled";

export interface TableExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema?: string;
  identifierQuote?: string;
  tableName: string;
  filePath: string;
  format: "csv" | "xlsx" | "json" | "markdown" | "sql" | "txt";
  columns?: string[];
  columnTypes?: Array<string | null | undefined>;
  columnComments?: Array<string | null> | null;
  primaryKeys?: string[];
  whereInput?: string;
  orderBy?: string;
  skipCount?: boolean;
  batchSize?: number;
  rowLimit?: number | null;
  dateTimeFormat?: string;
  numericColumnRightAlign?: boolean;
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

export interface QueryResultExportRequest {
  exportId: string;
  connectionId: string;
  database: string;
  schema?: string;
  catalog?: string;
  sql: string;
  queryBaseSql: string;
  setupSql?: string[];
  databaseType: DatabaseType;
  useAgentCursor: boolean;
  filePath: string;
  format: "csv" | "xlsx" | "txt" | "sql";
  includeSqlSheet?: boolean;
  pageSize: number;
  rowLimit?: number | null;
  totalRows?: number | null;
  timeoutSecs?: number;
  keysetOptimizationEnabled: boolean;
  clientSessionId?: string;
  executionId?: string;
  dateTimeFormat?: string;
  exportTableName?: string;
  exportColumnTypes?: Array<string | null | undefined>;
  numericColumnRightAlign?: boolean;
  columnComments?: Array<string | null> | null;
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
          finish(() => rejectTerminal(new BackendErrorException(event.payload.errorMessage || "Export failed")));
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
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}

export async function cancelTableExport(exportId: string): Promise<void> {
  return invoke("cancel_table_export", { exportId });
}

export async function startQueryResultExport(request: QueryResultExportRequest, onProgress: (progress: TableExportProgress) => void): Promise<TableExportProgress> {
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
    unlisten = await listen<TableExportProgress>("query-result-export-progress", (event) => {
      if (event.payload.exportId !== request.exportId) return;
      onProgress(event.payload);
      if (event.payload.status === "Done" || event.payload.status === "Error" || event.payload.status === "Cancelled") {
        if (event.payload.status === "Error") {
          finish(() => rejectTerminal(new BackendErrorException(event.payload.errorMessage || "Export failed")));
        } else {
          finish(() => resolveTerminal(event.payload));
        }
      }
    });
    await invoke("start_query_result_export", { request });
    return await terminalProgress;
  } catch (error) {
    if (!settled) {
      settled = true;
      unlisten?.();
    }
    throw error instanceof BackendErrorException ? error : new BackendErrorException(error);
  }
}

export async function cancelQueryResultExport(exportId: string, executionId?: string): Promise<void> {
  return invoke("cancel_query_result_export", {
    exportId,
    executionId: executionId || null,
  });
}

export async function beginDatabaseBackupSnapshot(connectionId: string, database: string): Promise<DatabaseBackupSnapshot> {
  return invoke("begin_database_backup_snapshot", { connectionId, database });
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

export async function exportQueryResultXlsx(filePath: string, sheetName: string | undefined, columns: string[], columnTypes: string[], columnComments: readonly (string | null)[] | undefined, rows: readonly (readonly XlsxCellValue[])[], numericColumnRightAlign?: boolean): Promise<void> {
  return invoke("export_query_result_xlsx", {
    request: {
      filePath,
      sheetName,
      columns,
      columnTypes,
      columnComments,
      rows,
      numericColumnRightAlign,
    },
  });
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
  return invoke("export_query_results_xlsx", {
    request: {
      filePath,
      worksheets,
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

export * from "@/lib/backend/mq-tauri";
export * from "@/lib/backend/mqtt-tauri";
export * from "@/lib/backend/nacos-tauri";
