pub use dbx_drivers::runtime_config::{
    normalize_duckdb_worker_max_processes, DUCKDB_WORKER_MAX_PROCESSES_DEFAULT, DUCKDB_WORKER_MAX_PROCESSES_MAX,
    DUCKDB_WORKER_MAX_PROCESSES_MIN,
};

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use log::warn;
use rusqlite::{
    params, params_from_iter, types::Value, Connection, DatabaseName, OpenFlags, OptionalExtension, ToSql, Transaction,
    TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::{
    AiChatMessage, AiChatSelectionState, AiConfig, AiConfigItem, AiConversation, AiProvider, AiRun, AiRunFifoCategory,
    AiRunStatus,
};
use crate::connection_secrets::{
    plugin_connection_secret_key, CASSANDRA_KEYSTORE_PASSWORD_KEY, CASSANDRA_TLS_SECRET_PREFIX,
    CASSANDRA_TRUSTSTORE_PASSWORD_KEY, MQTT_AUTH_PASSWORD_KEY, MQTT_AUTH_SECRET_PREFIX, MQ_AUTH_API_KEY_VALUE_KEY,
    MQ_AUTH_CLIENT_SECRET_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_SECRET_PREFIX, MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY,
    MQ_TOKEN_SIGNING_SECRET_PREFIX, NACOS_AUTH_PASSWORD_KEY, NACOS_AUTH_SECRET_PREFIX,
    NACOS_RNACOS_CONSOLE_PASSWORD_KEY, PLUGIN_CONNECTION_SECRET_PREFIX, SALESFORCE_AUTH_CLIENT_SECRET_KEY,
    SALESFORCE_AUTH_PASSWORD_KEY, SALESFORCE_AUTH_REFRESH_TOKEN_KEY, SALESFORCE_AUTH_SECRET_PREFIX,
};
use crate::db::sqlite::{connect_path_create_if_missing, SqliteHandle};
use crate::history::{
    HistoryConnectionFilter, HistoryConnectionOption, HistoryCursor, HistoryDatabaseFilter, HistoryEntry,
    HistorySearchRequest, HistorySearchResult, MAX_HISTORY,
};
use crate::models::connection::{ConnectionConfig, DatabaseConnectionInfo, DatabaseType, TransportLayerConfig};
use crate::persistence::secret_codec::{
    key_file_candidates, SecretCodec, SecretKeyPolicy, SecretKeyResolution, SecretKeySource,
};
use crate::prompt_template::PromptTemplate;
use crate::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";
const URL_PARAMS_SECRET_KEY: &str = "url_params";
const AI_SECRET_NAMESPACE_PREFIX: &str = "ai_config.";
const TUNNEL_SECRET_NAMESPACE_PREFIX: &str = "tunnel_profile.";
const CONFIG_SECRET_BLOB_KEY: &str = "config";
pub(crate) const GLOBAL_SECRET_NAMESPACE: &str = "dbx.global";
const STORAGE_DB_FILE_NAME: &str = "dbx.db";
static DATA_MIGRATION_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
const APP_STATE_EDITOR_SETTINGS_KEY: &str = "editor_settings";
const APP_STATE_OPEN_TABS_KEY: &str = "open_tabs";
const APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY: &str = "saved_sql_editor_positions";
const APP_STATE_TRANSFER_TASK_LIBRARY_KEY: &str = "transfer_task_library";
const MCP_GLOBAL_POLICY_KEY: &str = "mcp_global_policy";
const MCP_HTTP_SERVER_SETTINGS_KEY: &str = "mcp_http_server_settings";
const WEB_MCP_SETTINGS_KEY: &str = "web_mcp_settings";
const MAX_RETRIES_KEY: &str = "max_retries";
const HISTORY_RETENTION_LIMIT_KEY: &str = "history_retention_limit";
const SQL_FILE_UPLOAD_MAX_MB_KEY: &str = "sql_file_upload_max_mb";
/// Plugin ids whose MCP tools the built-in AI agent may call.
const AI_PLUGIN_TOOL_PLUGINS_KEY: &str = "ai_plugin_tool_plugins";
/// `{ pluginId: [connectionId, ...] }` — connections a plugin may read through
/// the `host.data:read` Host API. Written only after an explicit user consent.
const PLUGIN_DATA_GRANTS_KEY: &str = "plugin_data_grants";
/// Upper bound for one plugin's persisted data grants; consent is per
/// connection, so a legitimate plugin never approaches it.
const MAX_PLUGIN_DATA_GRANTS_PER_PLUGIN: usize = 512;
const APP_STATE_AI_GLOBAL_INSTRUCTIONS_KEY: &str = "ai_global_custom_instructions";
const APP_STATE_AI_CHAT_SELECTION_KEY: &str = "ai_chat_selection_v1";
const SNIPPET_SYNC_IDS_KEY: &str = "snippet_sync_ids";
const SNIPPET_PENDING_CLEANUPS_KEY: &str = "snippet_pending_legacy_cleanups";
const USER_DATA_TABLES: &[&str] = &[
    "connections",
    "connection_secrets",
    "history",
    "ai_config",
    "ai_provider_configs",
    "ai_conversations",
    "ai_runs",
    "sidebar_layout",
    "app_settings",
    "app_state",
    "tunnel_profiles",
    "mq_token_records",
    "saved_sql_folders",
    "saved_sql_files",
    "ai_configs",
    "state_store",
    "prompt_templates",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataDbImportResult {
    Imported,
    SkippedNoSource,
    SkippedInvalidSource,
    SkippedInvalidTarget,
    SkippedSourceEmpty,
    SkippedTargetHasData,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetPendingCleanup {
    pub snippet_id: String,
    pub expected_content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnippetSyncState {
    pub snippet_id: Option<String>,
    pub pending_cleanup: Option<SnippetPendingCleanup>,
}

fn required_snippet_state_value<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    Ok(value)
}

fn validate_snippet_pending_cleanup(mut cleanup: SnippetPendingCleanup) -> Result<SnippetPendingCleanup, String> {
    cleanup.snippet_id = required_snippet_state_value(&cleanup.snippet_id, "legacy snippet id")?.to_string();
    cleanup.expected_content_hash =
        required_snippet_state_value(&cleanup.expected_content_hash, "legacy content hash")?.to_string();
    Ok(cleanup)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SqliteDbFileState {
    Missing,
    Empty,
    Valid,
    Invalid,
}

pub fn maybe_import_user_data_db(
    target_data_dir: &Path,
    source_data_dir: Option<&Path>,
) -> Result<DataDbImportResult, String> {
    let Some(source_data_dir) = source_data_dir else {
        return Ok(DataDbImportResult::SkippedNoSource);
    };

    let source_db_path = source_data_dir.join(STORAGE_DB_FILE_NAME);
    if !source_db_path.is_file() {
        return Ok(DataDbImportResult::SkippedNoSource);
    }
    if inspect_sqlite_db_file(&source_db_path)? != SqliteDbFileState::Valid {
        return Ok(DataDbImportResult::SkippedInvalidSource);
    }

    let source_conn = open_read_only_sqlite(&source_db_path)?;
    if !sqlite_db_has_user_data(&source_conn)? {
        return Ok(DataDbImportResult::SkippedSourceEmpty);
    }

    let target_db_path = target_data_dir.join(STORAGE_DB_FILE_NAME);
    match inspect_sqlite_db_file(&target_db_path)? {
        SqliteDbFileState::Missing => {}
        SqliteDbFileState::Empty => {
            remove_sqlite_db_files(&target_db_path)?;
        }
        SqliteDbFileState::Valid => {
            let target_conn = open_read_only_sqlite(&target_db_path)?;
            if sqlite_db_has_user_data(&target_conn)? {
                return Ok(DataDbImportResult::SkippedTargetHasData);
            }
            drop(target_conn);
            remove_sqlite_db_files(&target_db_path)?;
        }
        SqliteDbFileState::Invalid => return Ok(DataDbImportResult::SkippedInvalidTarget),
    }

    std::fs::create_dir_all(target_data_dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
    source_conn
        .backup(DatabaseName::Main, &target_db_path, None)
        .map_err(|e| format!("Failed to import user data db: {e}"))?;

    Ok(DataDbImportResult::Imported)
}

#[derive(Clone)]
pub struct Storage {
    db: SqliteHandle,
    /// Path to the SQLite database file (`dbx.db`). Its parent directory is the
    /// application data dir where dbx-managed state (e.g. `known_hosts`) lives.
    path: PathBuf,
    /// The owning process chooses the key lifecycle. Desktop keeps the
    /// platform credential-store default; Web selects the data-dir policy.
    secret_key_policy: SecretKeyPolicy,
    /// Standalone CLI/MCP processes may use an existing key but must never
    /// provision one as a side effect of a write.
    secret_key_creation_allowed: bool,
    /// Key material resolved for business reads and writes. Every resolution
    /// round-trips to the OS credential store, so hydrating N stored secrets
    /// used to mean N credential-store accesses on the startup path.
    secret_codec_cache: Arc<Mutex<Option<CachedSecretCodec>>>,
}

/// Key material plus the digest of every key file it was resolved from.
struct CachedSecretCodec {
    codec: SecretCodec,
    key_files: Vec<(PathBuf, Option<[u8; 32]>)>,
}

pub const SECRET_STORE_MIGRATION_ID: &str = "secret-store-v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Pending,
    Running,
    Succeeded,
    Failed,
    NotRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationKeyStatus {
    Ready,
    WillCreate,
    Unavailable,
    Invalid,
    Mismatch,
    MissingForCiphertext,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LegacyJsonFileStatus {
    pub name: String,
    pub exists: bool,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPreflight {
    pub migration_id: String,
    pub state: MigrationState,
    pub needs_migration: bool,
    pub key_provider_available: bool,
    pub key_status: MigrationKeyStatus,
    /// Desktop may provision a new local key only for plaintext-only data.
    /// Headless callers always set this false.
    pub key_creation_allowed: bool,
    pub database_plaintext_count: usize,
    pub connection_count: usize,
    pub plugin_secret_count: usize,
    pub ai_secret_count: usize,
    pub tunnel_secret_count: usize,
    pub sync_credential_count: usize,
    pub legacy_json_files: Vec<LegacyJsonFileStatus>,
    pub backup_required: bool,
    pub backup_path: Option<String>,
    pub error_message: Option<String>,
    pub error_code: Option<String>,
    pub data_dir: String,
    pub backup_dir: String,
    pub key_file_configured: bool,
    pub key_file_readable: bool,
    pub persistent_key_configured: bool,
    pub key_source: String,
}

impl MigrationPreflight {
    pub fn is_ready(&self) -> bool {
        // A brand-new desktop profile has no secrets and may provision its
        // first key lazily. Strict headless profiles report missing keys as
        // `needs_migration`, so no additional provider check is needed here.
        !self.needs_migration && matches!(self.state, MigrationState::Succeeded | MigrationState::NotRequired)
    }
}

struct MigrationStateRecord {
    state: MigrationState,
    backup_path: Option<String>,
    error_code: Option<String>,
    error_message: Option<String>,
    source_fingerprint: Option<String>,
    counts_json: String,
}

impl Default for MigrationStateRecord {
    fn default() -> Self {
        Self {
            state: MigrationState::Pending,
            backup_path: None,
            error_code: None,
            error_message: None,
            source_fingerprint: None,
            counts_json: "{}".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub migration_id: String,
    pub state: MigrationState,
    pub backup_path: Option<String>,
    pub database_plaintext_count: usize,
    pub legacy_json_files: Vec<String>,
    pub verified_secret_count: usize,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

/// All state needed by a sync restore is committed through one SQLite
/// transaction.  The sync module deliberately passes plain values here; this
/// type stays independent from the transport envelope and keeps local secret
/// re-encryption inside the storage boundary.
pub(crate) struct SyncImportPlan {
    pub connections: Vec<ConnectionConfig>,
    pub tunnel_profiles: Option<Vec<TransportLayerConfig>>,
    pub tunnel_secret_profiles: Option<Vec<TransportLayerConfig>>,
    pub sidebar_layout: Option<serde_json::Value>,
    pub pinned_tree_node_ids: Vec<String>,
    pub saved_sql: SavedSqlLibrary,
    pub desktop_settings: DesktopSettings,
    pub editor_settings: Option<serde_json::Value>,
    pub connection_secrets: Option<Vec<SyncImportSecret>>,
    /// Keep destination plugin credentials when the transport payload
    /// intentionally omitted plugin secrets.
    pub preserve_plugin_secrets: bool,
    pub sync_credentials: Option<Vec<SyncImportCredential>>,
    pub ai_configs: Option<Vec<AiConfigItem>>,
}

pub(crate) struct SyncImportSecret {
    pub connection_id: String,
    pub key: String,
    pub secret: String,
}

pub(crate) struct SyncImportCredential {
    pub account: String,
    /// JSON representation of an `EncryptedSecretsBlob`, wrapped with the
    /// destination device secret before it is stored in `connection_secrets`.
    pub blob: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRuntimeCacheEntry {
    pub key: String,
    pub payload: Vec<u8>,
    pub row_count: i64,
    pub column_count: i64,
    pub byte_size: i64,
    pub updated_at: String,
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRuntimeCacheMetadata {
    pub key: String,
    pub row_count: i64,
    pub column_count: i64,
    pub byte_size: i64,
    pub updated_at: String,
    pub created_at: i64,
    pub last_accessed_at: i64,
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRuntimeCachePruneResult {
    pub deleted_entries: usize,
    pub deleted_bytes: i64,
    pub orphan_deletions: usize,
    pub remaining_entries: usize,
    pub remaining_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopSettings {
    pub show_tray_icon: bool,
    pub icon_theme: DesktopIconTheme,
    #[serde(default)]
    pub quit_on_close: bool,
    #[serde(default)]
    pub close_action_prompted: bool,
    #[serde(default)]
    pub debug_logging_enabled: bool,
    #[serde(default = "default_metadata_cache_max_memory_mb")]
    pub metadata_cache_max_memory_mb: usize,
    #[serde(default)]
    pub duckdb_worker_process_isolation: bool,
    #[serde(default = "default_duckdb_worker_max_processes")]
    pub duckdb_worker_max_processes: usize,
    #[serde(default)]
    pub saved_sql_sync_dir: Option<String>,
    #[serde(default)]
    pub driver_store_dir: Option<String>,
    #[serde(default)]
    pub plugin_store_dir: Option<String>,
    #[serde(default)]
    pub agent_store_dir: Option<String>,
    #[serde(default)]
    pub custom_ai_skill_root_enabled: bool,
    #[serde(default)]
    pub custom_ai_skill_root: Option<String>,
    #[serde(default = "default_sidebar_table_page_size")]
    pub sidebar_table_page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalPolicy {
    pub read_only: bool,
    #[serde(default)]
    pub allow_dangerous_sql: bool,
    pub allowed_connection_ids: Option<Vec<String>>,
    /// Stable sidebar group ids whose current descendant connections are
    /// exposed when an explicit connection scope is configured.
    #[serde(default)]
    pub allowed_group_ids: Vec<String>,
    /// `None` exposes every built-in MCP tool. A list is an explicit
    /// allowlist and is enforced independently of connection permissions.
    #[serde(default)]
    pub allowed_tool_names: Option<Vec<String>>,
    /// Per-connection execution defaults and database overrides. Rules without
    /// the current execution policy version remain legacy ceilings.
    #[serde(default)]
    pub connection_policies: Vec<McpConnectionPolicy>,
    /// Execution defaults inherited by every connection currently contained
    /// in the referenced sidebar group. Nested groups are resolved from root
    /// to leaf, so the closest configured group wins.
    #[serde(default)]
    pub group_policies: Vec<McpGroupPolicy>,
    #[serde(default)]
    pub query_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGroupPolicy {
    pub group_id: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub allow_dangerous_sql: bool,
}

fn default_mcp_connection_execution_mode_configured() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectionPolicy {
    pub connection_id: String,
    /// When true, this connection is read-only even if the MCP-wide policy
    /// permits writes.
    #[serde(default)]
    pub read_only: bool,
    /// Enables high-risk SQL for this connection. Legacy rules require this
    /// to remain within the global ceiling; versioned rules use it as the
    /// connection default and still honor independent connection protections.
    #[serde(default)]
    pub allow_dangerous_sql: bool,
    /// Whether the operation ceiling is explicitly overridden for this
    /// connection. Missing on older saved policies defaults to true for
    /// deserialization compatibility; the version marker determines whether
    /// those fields use legacy ceiling or current override semantics.
    #[serde(default = "default_mcp_connection_execution_mode_configured")]
    pub execution_mode_configured: bool,
    /// Rules without this marker retain the legacy ceiling behavior. New UI
    /// writes use version 1 for scoped override semantics.
    #[serde(default)]
    pub execution_mode_policy_version: Option<u8>,
    /// Limits which databases below this connection can be reached by MCP.
    /// The default preserves existing installations: all databases remain
    /// available until a user explicitly narrows the scope.
    #[serde(default)]
    pub database_scope: McpDatabaseScope,
    /// Exact database names allowed when `database_scope` is `selected`.
    /// An empty selected list intentionally denies every database.
    #[serde(default)]
    pub allowed_databases: Vec<String>,
    /// Optional per-database execution settings. A missing entry inherits the
    /// connection default, while a present entry takes priority over it.
    #[serde(default)]
    pub database_policies: Vec<McpDatabasePolicy>,
    /// Opt-in switch letting an AI agent write to this Salesforce org through
    /// MCP. Absent on every policy saved before the switch existed, and `false`
    /// by default: SOQL reads need no permission beyond the execution mode, but
    /// Salesforce DML has no transaction and no rollback, so an agent may only
    /// reach it after a person turns this on for the connection and confirms
    /// each write (`dbx_salesforce_prepare_write` → `dbx_salesforce_apply_write`).
    /// Forced back to false whenever `read_only` is set.
    #[serde(default)]
    pub allow_salesforce_dml: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpDatabasePolicy {
    /// Exact database name matched after the connection scope has admitted it.
    pub database_name: String,
    /// When true, this database rejects writes regardless of the connection
    /// and global defaults.
    #[serde(default)]
    pub read_only: bool,
    /// Enables high-risk SQL for this database. Connection read-only,
    /// production protection, scope, and database credentials remain hard limits.
    #[serde(default)]
    pub allow_dangerous_sql: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum McpDatabaseScope {
    #[default]
    All,
    Selected,
    None,
}

/// Configuration for the optional MCP Streamable HTTP server managed by the
/// desktop application. Credentials deliberately do not live here: the
/// desktop service stores its token in a private file under the DBX data dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHttpServerSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_mcp_http_host")]
    pub host: String,
    #[serde(default = "default_mcp_http_port")]
    pub port: u16,
    #[serde(default = "default_mcp_http_path")]
    pub path: String,
    #[serde(default)]
    pub allow_remote: bool,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

/// Configuration for the optional DBX Web MCP endpoint. The bearer token is
/// deliberately kept out of this JSON and stored through the encrypted secret
/// store instead.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebMcpSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    #[serde(default)]
    pub allowed_origins: Vec<String>,
}

impl Default for McpHttpServerSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            host: default_mcp_http_host(),
            port: default_mcp_http_port(),
            path: default_mcp_http_path(),
            allow_remote: false,
            allowed_hosts: Vec::new(),
            allowed_origins: Vec::new(),
        }
    }
}

fn default_mcp_http_host() -> String {
    "127.0.0.1".to_string()
}

fn default_mcp_http_port() -> u16 {
    5225
}

fn default_mcp_http_path() -> String {
    "/mcp".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalPolicyState {
    pub configured: bool,
    pub read_only: bool,
    pub allow_dangerous_sql: bool,
    pub allowed_connection_ids: Option<Vec<String>>,
    #[serde(default)]
    pub allowed_group_ids: Vec<String>,
    #[serde(default)]
    pub allowed_tool_names: Option<Vec<String>>,
    #[serde(default)]
    pub connection_policies: Vec<McpConnectionPolicy>,
    #[serde(default)]
    pub group_policies: Vec<McpGroupPolicy>,
    #[serde(default)]
    pub query_timeout_secs: Option<u64>,
}

impl McpGlobalPolicyState {
    pub fn policy(&self) -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: self.read_only,
            allow_dangerous_sql: self.allow_dangerous_sql,
            allowed_connection_ids: self.allowed_connection_ids.clone(),
            allowed_group_ids: self.allowed_group_ids.clone(),
            allowed_tool_names: self.allowed_tool_names.clone(),
            connection_policies: self.connection_policies.clone(),
            group_policies: self.group_policies.clone(),
            query_timeout_secs: self.query_timeout_secs,
        }
    }
}

impl McpGlobalPolicy {
    /// Produces the single fail-closed representation persisted by the MCP
    /// policy API. This protects the policy boundary even when a caller does
    /// not use the desktop settings form (for example, a Web API client).
    pub fn normalized(&self) -> Self {
        let allowed_connection_ids = self.allowed_connection_ids.as_ref().map(|ids| {
            let mut ids =
                ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()).map(ToOwned::to_owned).collect::<Vec<_>>();
            ids.sort();
            ids.dedup();
            ids
        });
        let allowed_group_ids =
            if allowed_connection_ids.is_some() { normalize_mcp_ids(&self.allowed_group_ids) } else { Vec::new() };
        let allowed_tool_names = self.allowed_tool_names.as_ref().map(|tools| {
            let mut tools = tools
                .iter()
                .map(|tool| tool.trim())
                .filter(|tool| !tool.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            tools.sort();
            tools.dedup();
            tools
        });

        let mut policies = HashMap::<String, McpConnectionPolicy>::new();
        for rule in &self.connection_policies {
            let connection_id = rule.connection_id.trim();
            if connection_id.is_empty() {
                continue;
            }
            policies
                .entry(connection_id.to_string())
                .and_modify(|current| {
                    // Multiple rules are treated as a conjunction: any
                    // read-only rule wins and high-risk access requires every
                    // duplicate rule to explicitly permit it.
                    if rule.execution_mode_configured {
                        if current.execution_mode_configured {
                            current.read_only |= rule.read_only;
                            current.allow_dangerous_sql &= rule.allow_dangerous_sql;
                        } else {
                            current.read_only = rule.read_only;
                            current.allow_dangerous_sql = rule.allow_dangerous_sql;
                        }
                        current.execution_mode_configured = true;
                    }
                    current.execution_mode_policy_version =
                        match (current.execution_mode_policy_version, rule.execution_mode_policy_version) {
                            (Some(left), Some(right))
                                if left == crate::mcp_policy::MCP_EXECUTION_POLICY_VERSION && right == left =>
                            {
                                Some(left)
                            }
                            _ => None,
                        };
                    let (scope, databases) = intersect_mcp_database_scopes(
                        current.database_scope,
                        &current.allowed_databases,
                        rule.database_scope,
                        &rule.allowed_databases,
                    );
                    current.database_scope = scope;
                    current.allowed_databases = databases;
                    current.database_policies =
                        merge_mcp_database_policies(&current.database_policies, &rule.database_policies);
                    // Same conjunction as high-risk SQL: every duplicate rule has
                    // to opt in before an agent may write to the org.
                    current.allow_salesforce_dml &= rule.allow_salesforce_dml;
                })
                .or_insert_with(|| McpConnectionPolicy {
                    connection_id: connection_id.to_string(),
                    read_only: rule.read_only,
                    allow_dangerous_sql: rule.allow_dangerous_sql,
                    execution_mode_configured: rule.execution_mode_configured,
                    execution_mode_policy_version: rule.execution_mode_policy_version,
                    database_scope: rule.database_scope,
                    allowed_databases: normalize_mcp_database_names(&rule.allowed_databases),
                    database_policies: normalize_mcp_database_policies(&rule.database_policies),
                    allow_salesforce_dml: rule.allow_salesforce_dml,
                });
        }
        let mut connection_policies = policies.into_values().collect::<Vec<_>>();
        connection_policies.sort_by(|left, right| left.connection_id.cmp(&right.connection_id));
        for rule in &mut connection_policies {
            if rule.read_only {
                rule.allow_dangerous_sql = false;
                // A read-only connection cannot carry a Salesforce write opt-in,
                // however the saved rules were merged.
                rule.allow_salesforce_dml = false;
            }
            rule.allowed_databases = normalize_mcp_database_names(&rule.allowed_databases);
            if rule.database_scope != McpDatabaseScope::Selected {
                rule.allowed_databases.clear();
                rule.database_policies.clear();
            } else {
                rule.database_policies
                    .retain(|policy| rule.allowed_databases.binary_search(&policy.database_name).is_ok());
            }
        }

        let mut group_policies = HashMap::<String, McpGroupPolicy>::new();
        for rule in &self.group_policies {
            let group_id = rule.group_id.trim();
            if group_id.is_empty() {
                continue;
            }
            group_policies
                .entry(group_id.to_string())
                .and_modify(|current| {
                    current.read_only |= rule.read_only;
                    current.allow_dangerous_sql &= rule.allow_dangerous_sql;
                })
                .or_insert_with(|| McpGroupPolicy {
                    group_id: group_id.to_string(),
                    read_only: rule.read_only,
                    allow_dangerous_sql: !rule.read_only && rule.allow_dangerous_sql,
                });
        }
        let mut group_policies = group_policies.into_values().collect::<Vec<_>>();
        group_policies.sort_by(|left, right| left.group_id.cmp(&right.group_id));
        for rule in &mut group_policies {
            if rule.read_only {
                rule.allow_dangerous_sql = false;
            }
        }

        Self {
            read_only: self.read_only,
            allow_dangerous_sql: !self.read_only && self.allow_dangerous_sql,
            allowed_connection_ids,
            allowed_group_ids,
            allowed_tool_names,
            connection_policies,
            group_policies,
            query_timeout_secs: self.query_timeout_secs,
        }
    }
}

fn normalize_mcp_ids(ids: &[String]) -> Vec<String> {
    let mut ids = ids.iter().map(|id| id.trim()).filter(|id| !id.is_empty()).map(ToOwned::to_owned).collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    ids
}

fn normalize_mcp_database_names(databases: &[String]) -> Vec<String> {
    let mut databases = databases
        .iter()
        .map(|database| database.trim())
        .filter(|database| !database.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    databases.sort();
    databases.dedup();
    databases
}

fn normalize_mcp_database_policies(policies: &[McpDatabasePolicy]) -> Vec<McpDatabasePolicy> {
    let mut normalized = HashMap::<String, McpDatabasePolicy>::new();
    for policy in policies {
        let database_name = policy.database_name.trim();
        if database_name.is_empty() {
            continue;
        }
        normalized
            .entry(database_name.to_string())
            .and_modify(|current| {
                // Duplicate entries represent independently supplied limits,
                // so combine them as the strictest possible policy.
                current.read_only |= policy.read_only;
                current.allow_dangerous_sql &= policy.allow_dangerous_sql;
            })
            .or_insert_with(|| McpDatabasePolicy {
                database_name: database_name.to_string(),
                read_only: policy.read_only,
                allow_dangerous_sql: !policy.read_only && policy.allow_dangerous_sql,
            });
    }
    let mut normalized = normalized.into_values().collect::<Vec<_>>();
    normalized.sort_by(|left, right| left.database_name.cmp(&right.database_name));
    for policy in &mut normalized {
        if policy.read_only {
            policy.allow_dangerous_sql = false;
        }
    }
    normalized
}

fn merge_mcp_database_policies(left: &[McpDatabasePolicy], right: &[McpDatabasePolicy]) -> Vec<McpDatabasePolicy> {
    let mut policies = Vec::with_capacity(left.len() + right.len());
    policies.extend_from_slice(left);
    policies.extend_from_slice(right);
    normalize_mcp_database_policies(&policies)
}

fn intersect_mcp_database_scopes(
    left_scope: McpDatabaseScope,
    left_databases: &[String],
    right_scope: McpDatabaseScope,
    right_databases: &[String],
) -> (McpDatabaseScope, Vec<String>) {
    use McpDatabaseScope::{All, None, Selected};
    match (left_scope, right_scope) {
        (None, _) | (_, None) => (None, Vec::new()),
        (All, All) => (All, Vec::new()),
        (All, Selected) => (Selected, normalize_mcp_database_names(right_databases)),
        (Selected, All) => (Selected, normalize_mcp_database_names(left_databases)),
        (Selected, Selected) => {
            let right = normalize_mcp_database_names(right_databases);
            let databases = normalize_mcp_database_names(left_databases)
                .into_iter()
                .filter(|database| right.binary_search(database).is_ok())
                .collect();
            (Selected, databases)
        }
    }
}

fn default_sidebar_table_page_size() -> usize {
    1000
}

pub const METADATA_CACHE_MEMORY_MIN_MB: usize = 16;
pub const METADATA_CACHE_MEMORY_RECOMMENDED_MAX_MB: usize = 256;
pub const METADATA_CACHE_MEMORY_HARD_MAX_MB: usize = 512;
pub const METADATA_CACHE_MEMORY_DEFAULT_MB: usize = 64;

pub fn default_metadata_cache_max_memory_mb() -> usize {
    METADATA_CACHE_MEMORY_DEFAULT_MB
}

pub fn normalize_metadata_cache_max_memory_mb(value: usize) -> usize {
    if value > METADATA_CACHE_MEMORY_HARD_MAX_MB {
        log::warn!(
            "Metadata cache memory limit {value} MB exceeds the hard limit; falling back to {METADATA_CACHE_MEMORY_DEFAULT_MB} MB"
        );
        METADATA_CACHE_MEMORY_DEFAULT_MB
    } else {
        if value > METADATA_CACHE_MEMORY_RECOMMENDED_MAX_MB {
            log::warn!(
                "Metadata cache memory limit {value} MB exceeds the recommended {METADATA_CACHE_MEMORY_RECOMMENDED_MAX_MB} MB"
            );
        }
        value.clamp(METADATA_CACHE_MEMORY_MIN_MB, METADATA_CACHE_MEMORY_HARD_MAX_MB)
    }
}

pub fn default_duckdb_worker_max_processes() -> usize {
    DUCKDB_WORKER_MAX_PROCESSES_DEFAULT
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            show_tray_icon: true,
            icon_theme: DesktopIconTheme::Default,
            quit_on_close: false,
            close_action_prompted: false,
            debug_logging_enabled: false,
            metadata_cache_max_memory_mb: default_metadata_cache_max_memory_mb(),
            duckdb_worker_process_isolation: false,
            duckdb_worker_max_processes: default_duckdb_worker_max_processes(),
            saved_sql_sync_dir: None,
            driver_store_dir: None,
            plugin_store_dir: None,
            agent_store_dir: None,
            custom_ai_skill_root_enabled: false,
            custom_ai_skill_root: None,
            sidebar_table_page_size: default_sidebar_table_page_size(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopIconTheme {
    Default,
    Black,
}

impl DesktopIconTheme {
    fn from_settings_value(value: Option<&serde_json::Value>) -> Self {
        match value.and_then(|value| value.as_str()) {
            Some("black") => Self::Black,
            _ => Self::Default,
        }
    }
}

const SCHEMA_STATEMENTS: &[&str] = &[
    "CREATE TABLE IF NOT EXISTS data_migrations (
        migration_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_fingerprint TEXT,
        counts_json TEXT NOT NULL DEFAULT '{}',
        backup_path TEXT,
        error_code TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT
    )",
    "CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS connection_secrets (
        connection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        secret TEXT NOT NULL,
        secret_enc TEXT,
        PRIMARY KEY (connection_id, key)
    )",
    "CREATE TABLE IF NOT EXISTS history (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL DEFAULT '',
        connection_name TEXT NOT NULL DEFAULT '',
        database TEXT NOT NULL DEFAULT '',
        sql_text TEXT NOT NULL DEFAULT '',
        executed_at TEXT NOT NULL DEFAULT '',
        execution_time_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        activity_kind TEXT NOT NULL DEFAULT 'query',
        operation TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '',
        affected_rows INTEGER,
        rollback_sql TEXT,
        details_json TEXT
    )",
    "CREATE TABLE IF NOT EXISTS ai_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS ai_provider_configs (
        provider TEXT PRIMARY KEY,
        config_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS tunnel_profiles (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        connection_name TEXT NOT NULL DEFAULT '',
        connection_id TEXT NOT NULL DEFAULT '',
        database TEXT NOT NULL DEFAULT '',
        schema_name TEXT,
        messages_json TEXT NOT NULL DEFAULT '[]',
        queued_input TEXT,
        plugin_context_json TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
    "CREATE TABLE IF NOT EXISTS ai_runs (
        run_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        session_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        connection_id TEXT NOT NULL DEFAULT '',
        database TEXT NOT NULL DEFAULT '',
        schema_name TEXT,
        pending_confirmation_json TEXT,
        fifo_category TEXT,
        pending_input TEXT,
        max_seq INTEGER,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (conversation_id) REFERENCES ai_conversations(id) ON DELETE CASCADE
    )",
    "CREATE INDEX IF NOT EXISTS idx_ai_runs_conversation_status ON ai_runs(conversation_id, status)",
    "CREATE TABLE IF NOT EXISTS sidebar_layout (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        layout_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS table_vgroups (
        scope_key TEXT PRIMARY KEY,
        layout_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS app_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        settings_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS schema_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL DEFAULT 0,
        last_accessed_at_ms INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT NOT NULL DEFAULT ''
    )",
    "CREATE TABLE IF NOT EXISTS tab_runtime_cache (
        cache_key TEXT PRIMARY KEY,
        payload BLOB NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        column_count INTEGER NOT NULL DEFAULT 0,
        byte_size INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT
    )",
    "CREATE TABLE IF NOT EXISTS mq_token_records (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        token_fingerprint TEXT NOT NULL,
        scope_json TEXT,
        actions_json TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT,
        created_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
    )",
    "CREATE INDEX IF NOT EXISTS idx_mq_token_records_connection_subject
        ON mq_token_records (connection_id, subject, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_mq_token_records_fingerprint
        ON mq_token_records (token_fingerprint)",
    "CREATE TABLE IF NOT EXISTS saved_sql_folders (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        parent_folder_id TEXT,
        name TEXT NOT NULL DEFAULT '',
        order_index INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
    "CREATE TABLE IF NOT EXISTS saved_sql_files (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        folder_id TEXT,
        name TEXT NOT NULL DEFAULT '',
        database_name TEXT NOT NULL DEFAULT '',
        catalog_name TEXT,
        schema_name TEXT,
        sql_text TEXT NOT NULL DEFAULT '',
        order_index INTEGER NOT NULL DEFAULT 0,
        open_count INTEGER NOT NULL DEFAULT 0,
        opened_at TEXT,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
    "CREATE TABLE IF NOT EXISTS ai_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        model TEXT NOT NULL DEFAULT '',
        models TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0
    )",
    "CREATE TABLE IF NOT EXISTS state_store (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
        version INTEGER NOT NULL DEFAULT 1,
        payload BLOB DEFAULT x''
    )",
    "CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
];

fn migration_counts_json(preflight: &MigrationPreflight) -> String {
    serde_json::json!({
        "databasePlaintextCount": preflight.database_plaintext_count,
        "connectionCount": preflight.connection_count,
        "pluginSecretCount": preflight.plugin_secret_count,
        "aiSecretCount": preflight.ai_secret_count,
        "tunnelSecretCount": preflight.tunnel_secret_count,
        "syncCredentialCount": preflight.sync_credential_count,
    })
    .to_string()
}

fn migration_backup_paths(counts: &serde_json::Value) -> Result<Vec<String>, String> {
    let Some(value) = counts.get("backupPaths") else {
        return Ok(Vec::new());
    };
    serde_json::from_value::<Vec<String>>(value.clone())
        .map_err(|_| "Invalid migration backup manifest: backupPaths must be an array".to_string())
}

fn migration_error_code(error: &str) -> &'static str {
    if error.contains("MISSING_MANAGED_KEY") {
        "MISSING_MANAGED_KEY"
    } else if error.contains("ENCRYPTED_DATA_KEY_MISSING") {
        "ENCRYPTED_DATA_KEY_MISSING"
    } else if error.contains("SECRET_KEY_MISMATCH") {
        "SECRET_KEY_MISMATCH"
    } else if error.contains("SECRET_KEY_INVALID") {
        "SECRET_KEY_INVALID"
    } else if error.contains("KEY_FILE_UNAVAILABLE") {
        "KEY_FILE_UNAVAILABLE"
    } else if error.contains("MISSING_EXTERNAL_KEY") || error.contains("MISSING_PERSISTENT_KEY") {
        "MISSING_EXTERNAL_KEY"
    } else if error.contains("KEY_PROVIDER_UNAVAILABLE") {
        "KEY_PROVIDER_UNAVAILABLE"
    } else if error.contains("JSON") || error.contains("json") {
        "LEGACY_JSON_INVALID"
    } else if error.contains("verification") || error.contains("plaintext remains") {
        "VERIFICATION_FAILED"
    } else if error.contains("backup") {
        "BACKUP_FAILED"
    } else {
        "MIGRATION_FAILED"
    }
}

fn migration_safe_message(code: &str, _error: &str) -> String {
    match code {
        "MISSING_MANAGED_KEY" => "A managed data-directory secret key is required".to_string(),
        "ENCRYPTED_DATA_KEY_MISSING" => "The key for existing encrypted data is missing".to_string(),
        "SECRET_KEY_MISMATCH" => "The configured secret key cannot decrypt existing data".to_string(),
        "SECRET_KEY_INVALID" => "The configured secret key is invalid".to_string(),
        "KEY_FILE_UNAVAILABLE" => "The configured secret key file is unavailable".to_string(),
        "MISSING_EXTERNAL_KEY" => "An external secret key is required".to_string(),
        "BACKUP_FAILED" => "Could not create a migration backup".to_string(),
        "LEGACY_JSON_INVALID" => "A legacy configuration file could not be read".to_string(),
        "VERIFICATION_FAILED" => "Encrypted data verification failed".to_string(),
        "KEY_PROVIDER_UNAVAILABLE" => "The local secret provider is unavailable".to_string(),
        _ => "Data migration failed; your original data was preserved".to_string(),
    }
}

const LEGACY_JSON_NAMES: &[&str] = &[
    "connections.json",
    "secrets.json",
    "ai_config.json",
    "ai_conversations.json",
    "query_history.json",
    "sidebar_layout.json",
];

fn file_digest(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|_| "Cannot read migration source file".to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl Storage {
    pub async fn open(db_path: &Path) -> Result<Self, String> {
        Self::open_with_secret_key_policy(db_path, SecretKeyPolicy::PlatformDefault).await
    }

    pub async fn open_with_secret_key_policy(db_path: &Path, policy: SecretKeyPolicy) -> Result<Self, String> {
        let storage = Self::open_unmigrated(db_path).await?.with_secret_key_policy(policy);
        let preflight = storage.inspect_data_migration().await?;
        if preflight.needs_migration && !preflight.key_provider_available && !preflight.key_creation_allowed {
            return Err(preflight.error_code.unwrap_or_else(|| "KEY_PROVIDER_UNAVAILABLE".to_string()));
        }
        if preflight.database_plaintext_count > 0 || preflight.sync_credential_count > 0 {
            let codec = storage.secret_codec(preflight.key_creation_allowed)?;
            storage.run_database_legacy_migrations(&codec).await?;
        }
        Ok(storage)
    }

    /// Open the database schema without touching legacy plaintext data. The
    /// desktop and web applications use this entry point so the migration
    /// wizard can inspect and execute the upgrade visibly.
    pub async fn open_unmigrated(db_path: &Path) -> Result<Self, String> {
        let path = db_path.to_path_buf();
        let db_path = db_path.to_string_lossy().to_string();
        let db = connect_path_create_if_missing(&db_path).await?;
        let storage = Self {
            db,
            path,
            secret_key_policy: SecretKeyPolicy::PlatformDefault,
            secret_key_creation_allowed: true,
            secret_codec_cache: Arc::new(Mutex::new(None)),
        };
        // Best-effort: switching journal mode is itself a lock-sensitive
        // operation, so a transient failure here (e.g. another process
        // racing to open the same brand-new database file) must never stop
        // the app from starting.
        // Restrict as soon as the file exists, so the guarantee does not
        // depend on the journal-mode switch or the schema pass succeeding.
        restrict_db_file_permissions(&storage.path);
        storage.enable_wal_mode().await;
        let schema = storage.init_schema(false).await;
        // Second pass: the journal sidecars only appear once something has
        // written to the database, and this runs on the failure path too.
        restrict_db_file_permissions(&storage.path);
        schema?;
        Ok(storage)
    }

    pub fn with_secret_key_policy(mut self, policy: SecretKeyPolicy) -> Self {
        self.secret_key_policy = policy;
        self
    }

    pub fn with_secret_key_creation(mut self, allowed: bool) -> Self {
        self.secret_key_creation_allowed = allowed;
        self
    }

    /// Compatibility builder for callers that require an externally managed key.
    pub fn require_persistent_key(self) -> Self {
        self.with_secret_key_policy(SecretKeyPolicy::ExternalOnly)
    }

    pub fn require_persistent_secret_key(self) -> Self {
        self.require_persistent_key()
    }

    fn resolve_secret_key(&self, allow_create: bool) -> Result<SecretKeyResolution, String> {
        SecretCodec::resolve(self.secret_key_policy, self.data_dir(), allow_create)
    }

    /// Resolution cost is dominated by the platform credential store, so the
    /// codec is cached for the process. Key files are re-digested on every use,
    /// and migration invalidates the cache, so no caller serves material that
    /// the provider no longer agrees with. Callers that must observe a key
    /// change immediately (status probes, migration) use `resolve_secret_key`.
    fn secret_codec(&self, allow_create: bool) -> Result<SecretCodec, String> {
        if let Some(cached) = self.cached_secret_codec() {
            return Ok(cached);
        }
        let key_files = self.key_file_digests();
        let codec = self.resolve_secret_key(allow_create).map(|resolved| resolved.codec)?;
        // Pair the codec with the pre-resolve digests, and only when the key
        // files are unchanged across the resolve. A pair taken after resolving
        // could combine a stale codec with fresh digests, which the use-time
        // digest check would then never reject.
        if self.key_file_digests() == key_files {
            self.cache_secret_codec(codec, key_files);
        }
        Ok(codec)
    }

    fn cached_secret_codec(&self) -> Option<SecretCodec> {
        let mut cache = self.secret_codec_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let cached = cache.as_ref()?;
        let codec = cached.codec;
        let resolved_key_files = cached.key_files.clone();
        if resolved_key_files != self.key_file_digests() {
            // A key file was added, replaced, or removed after resolution.
            *cache = None;
            return None;
        }
        Some(codec)
    }

    fn cache_secret_codec(&self, codec: SecretCodec, key_files: Vec<(PathBuf, Option<[u8; 32]>)>) {
        let entry = CachedSecretCodec { codec, key_files };
        *self.secret_codec_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(entry);
    }

    fn invalidate_secret_codec(&self) {
        *self.secret_codec_cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }

    /// Digest of every file that can supply key material on its own. Comparing
    /// these on use costs a few small reads instead of a credential-store
    /// round trip, and still catches a key file replaced outside DBX.
    fn key_file_digests(&self) -> Vec<(PathBuf, Option<[u8; 32]>)> {
        use sha2::Digest;
        key_file_candidates(self.data_dir())
            .into_iter()
            .map(|path| {
                let digest = std::fs::read(&path).ok().map(|contents| sha2::Sha256::digest(contents).into());
                (path, digest)
            })
            .collect()
    }

    async fn secret_codec_for_write(&self, needs_key: bool) -> Result<SecretCodec, String> {
        match self.secret_codec(false) {
            Ok(codec) => Ok(codec),
            Err(error)
                if matches!(
                    error.as_str(),
                    "MISSING_MANAGED_KEY" | "MISSING_EXTERNAL_KEY" | "KEY_PROVIDER_UNAVAILABLE"
                ) =>
            {
                if !needs_key {
                    return Ok(SecretCodec::new([0u8; 32]));
                }
                if !self.secret_key_creation_allowed {
                    return Err(error);
                }
                let has_ciphertext = self
                    .with_conn(|conn| {
                        conn.query_row(
                            "SELECT EXISTS(SELECT 1 FROM connection_secrets WHERE secret_enc IS NOT NULL AND secret_enc <> '')",
                            [],
                            |row| row.get::<_, bool>(0),
                        )
                        .map_err(|error| error.to_string())
                    })
                    .await?;
                if has_ciphertext {
                    return Err("ENCRYPTED_DATA_KEY_MISSING".to_string());
                }
                self.secret_codec(true)
            }
            Err(error) => Err(error),
        }
    }

    /// Multiple `dbx` processes can end up pointed at the same data directory
    /// (e.g. a portable install shared by several users on one machine).
    /// WAL mode lets readers and writers proceed without blocking each other,
    /// which combined with `TransactionBehavior::Immediate` on every write
    /// transaction (see `conn.transaction_with_behavior` call sites below)
    /// avoids the instant `SQLITE_BUSY` that a deferred transaction's
    /// SHARED-to-RESERVED lock upgrade can trigger under concurrent access.
    /// Never fails: this is a best-effort upgrade, retried a handful of
    /// times, that logs and gives up rather than blocking startup.
    async fn enable_wal_mode(&self) {
        const ATTEMPTS: u32 = 5;
        for attempt in 1..=ATTEMPTS {
            let result = self
                .with_conn(|conn| {
                    conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get::<_, String>(0))
                        .map_err(|e| e.to_string())
                })
                .await;
            match result {
                Ok(mode) if mode.eq_ignore_ascii_case("wal") => return,
                Ok(mode) => {
                    // Non-lock reasons WAL can't apply (e.g. an in-memory
                    // database in tests) won't be fixed by retrying.
                    warn!("dbx.db journal_mode did not switch to WAL (got '{mode}'); concurrent multi-process access may hit 'database is locked' more often");
                    return;
                }
                Err(_) if attempt < ATTEMPTS => {
                    std::thread::sleep(std::time::Duration::from_millis(100 * attempt as u64));
                }
                Err(error) => {
                    warn!("dbx.db could not switch journal_mode to WAL after {ATTEMPTS} attempts: {error}; concurrent multi-process access may hit 'database is locked' more often");
                    return;
                }
            }
        }
    }

    /// Directory containing the SQLite database (`dbx.db`). SSH host keys are
    /// stored in `<data_dir>/known_hosts` so dbx never touches `~/.ssh`.
    pub fn data_dir(&self) -> &Path {
        self.path.parent().unwrap_or_else(|| Path::new("."))
    }

    /// Hash logical rows so changes still in SQLite's WAL and same-size
    /// replacement JSON files invalidate the cached migration scan.
    async fn migration_source_fingerprint(&self) -> Result<String, String> {
        let mut digest = self
            .with_conn(|conn| {
                use sha2::{Digest, Sha256};
                let mut digest = Sha256::new();
                for table in [
                    "connections",
                    "connection_secrets",
                    "ai_configs",
                    "ai_config",
                    "ai_provider_configs",
                    "tunnel_profiles",
                    "app_settings",
                ] {
                    digest.update(table.as_bytes());
                    let mut stmt = conn
                        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
                        .map_err(|_| "Cannot inspect migration source")?;
                    let columns = stmt.column_count();
                    let mut rows = stmt.query([]).map_err(|_| "Cannot inspect migration source")?;
                    while let Some(row) = rows.next().map_err(|_| "Cannot inspect migration source")? {
                        for i in 0..columns {
                            let value = format!("{:?}", row.get_ref(i).map_err(|_| "Cannot inspect migration source")?);
                            digest.update((value.len() as u64).to_le_bytes());
                            digest.update(value.as_bytes());
                        }
                    }
                }
                Ok(digest)
            })
            .await?;
        use sha2::Digest;
        for name in LEGACY_JSON_NAMES {
            digest.update(name.as_bytes());
            let path = self.data_dir().join(name);
            if path.exists() {
                digest.update(file_digest(&path)?.as_bytes());
            }
        }
        Ok(format!("{:x}", digest.finalize()))
    }

    pub async fn inspect_data_migration(&self) -> Result<MigrationPreflight, String> {
        let files = self.legacy_json_files().await?;
        let stored = self.load_migration_state().await?;
        let current_fingerprint = self.migration_source_fingerprint().await?;
        let cached_scan: Option<(i64, i64, i64, i64, i64, i64, i64)> =
            if stored.source_fingerprint.as_deref() == Some(current_fingerprint.as_str()) {
                serde_json::from_str::<serde_json::Value>(&stored.counts_json).ok().and_then(|value| {
                    // A state transition may update source_fingerprint without a scan.
                    // Legacy caches lacking their own fingerprint must be rescanned.
                    (value["cachedScanFingerprint"].as_str() == Some(current_fingerprint.as_str()))
                        .then(|| serde_json::from_value(value["cachedScan"].clone()).ok())
                        .flatten()
                })
            } else {
                None
            };
        let (plaintext, encrypted, connections, plugins, ai, tunnels, sync_credentials) = match cached_scan {
            Some(scan) => scan,
            None => {
                self.with_conn(|conn| {
                    let plaintext: i64 = conn
                        .query_row("SELECT COUNT(*) FROM connection_secrets WHERE secret <> ''", [], |row| row.get(0))
                        .map_err(|e| e.to_string())?;
                    let encrypted: i64 = conn
                        .query_row(
                            "SELECT COUNT(*) FROM connection_secrets WHERE secret_enc IS NOT NULL AND secret_enc <> ''",
                            [],
                            |row| row.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    let connections: i64 = conn
                        .query_row("SELECT COUNT(*) FROM connections", [], |row| row.get(0))
                        .map_err(|e| e.to_string())?;
                    let plugins: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM connection_secrets WHERE key LIKE 'plugin_connection.%' AND secret <> ''",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                    let ai = count_ai_secret_rows(conn)?;
                    let tunnels = count_tunnel_secret_rows(conn)?;
                    let inline_connections: i64 = {
                        let mut statement =
                            conn.prepare("SELECT config_json FROM connections").map_err(|e| e.to_string())?;
                        let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
                        let mut count = 0;
                        for row in rows {
                            let json = row.map_err(|e| e.to_string())?;
                            let config: ConnectionConfig = serde_json::from_str(&json).map_err(|e| {
                                format!("invalid connection configuration during migration preflight: {e}")
                            })?;
                            if connection_config_has_inline_secrets(&config) {
                                count += 1;
                            }
                        }
                        count
                    };
                    let sync_credentials: i64 = conn
                        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| {
                            row.get::<_, String>(0)
                        })
                        .optional()
                        .map_err(|e| e.to_string())?
                        .map(|json| {
                            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                                .ok()
                                .map(|settings| {
                                    ["local_device_secret", "webdav_sync_secrets_passphrase"]
                                        .iter()
                                        .filter(|key| settings.get(**key).is_some_and(nonempty_json_value))
                                        .count()
                                        + settings
                                            .get("webdav_passwords")
                                            .and_then(serde_json::Value::as_object)
                                            .map_or(0, serde_json::Map::len)
                                })
                                .unwrap_or(0) as i64
                        })
                        .unwrap_or(0);
                    Ok((plaintext + inline_connections, encrypted, connections, plugins, ai, tunnels, sync_credentials))
                })
                .await?
            }
        };
        // This probe is deliberately read-only. It must not create a keyring
        // entry, key file, or change permissions while displaying status.
        let key_probe = self.resolve_secret_key(false);
        let mut key_provider_available = key_probe.is_ok();
        let database_plaintext_count = (plaintext + ai + tunnels).max(0) as usize;
        let has_legacy_data =
            database_plaintext_count > 0 || sync_credentials > 0 || files.iter().any(|file| file.exists);
        let key_creation_allowed = key_probe
            .as_ref()
            .err()
            .is_some_and(|error| matches!(error.as_str(), "MISSING_MANAGED_KEY" | "KEY_PROVIDER_UNAVAILABLE"))
            && !matches!(self.secret_key_policy, SecretKeyPolicy::ExternalOnly)
            && encrypted == 0
            && (database_plaintext_count > 0 || sync_credentials > 0 || files.iter().any(|file| file.exists));
        let mut key_error_code = key_probe.as_ref().err().cloned();
        if let Ok(resolved) = key_probe.as_ref() {
            if encrypted > 0 && self.validate_existing_encrypted_data(resolved.codec).await.is_err() {
                key_provider_available = false;
                key_error_code = Some("SECRET_KEY_MISMATCH".to_string());
            }
        } else if encrypted > 0
            && matches!(
                key_error_code.as_deref(),
                Some("MISSING_MANAGED_KEY") | Some("MISSING_EXTERNAL_KEY") | Some("KEY_PROVIDER_UNAVAILABLE")
            )
        {
            key_error_code = Some("ENCRYPTED_DATA_KEY_MISSING".to_string());
        }
        // External-only profiles require explicit configuration. Managed
        // profiles may create their key later, but never when ciphertext
        // already exists without its original key.
        let missing_required_key =
            !key_provider_available && matches!(self.secret_key_policy, SecretKeyPolicy::ExternalOnly);
        let missing_existing_key = encrypted > 0 && !key_provider_available;
        let fatal_key_error = key_error_code.as_deref().is_some_and(|code| {
            matches!(
                code,
                "SECRET_KEY_INVALID"
                    | "SECRET_KEY_MISMATCH"
                    | "KEY_FILE_UNAVAILABLE"
                    | "MISSING_EXTERNAL_KEY"
                    | "ENCRYPTED_DATA_KEY_MISSING"
            )
        });
        let key_status = match key_error_code.as_deref() {
            Some("SECRET_KEY_INVALID") => MigrationKeyStatus::Invalid,
            Some("SECRET_KEY_MISMATCH") => MigrationKeyStatus::Mismatch,
            Some("ENCRYPTED_DATA_KEY_MISSING") => MigrationKeyStatus::MissingForCiphertext,
            Some("KEY_PROVIDER_UNAVAILABLE") | Some("MISSING_MANAGED_KEY") if key_creation_allowed => {
                MigrationKeyStatus::WillCreate
            }
            Some(_) => MigrationKeyStatus::Unavailable,
            None if key_provider_available => MigrationKeyStatus::Ready,
            None => MigrationKeyStatus::Unavailable,
        };
        let source_changed = stored.source_fingerprint.as_deref().is_some_and(|value| value != current_fingerprint);
        let state = if fatal_key_error
            || missing_required_key
            || missing_existing_key
            || (has_legacy_data
                && (source_changed || matches!(stored.state, MigrationState::Succeeded | MigrationState::NotRequired)))
        {
            MigrationState::Pending
        } else if !has_legacy_data && matches!(stored.state, MigrationState::Pending) {
            MigrationState::NotRequired
        } else {
            stored.state.clone()
        };
        let needs_migration = fatal_key_error
            || missing_required_key
            || missing_existing_key
            || matches!(state, MigrationState::Failed | MigrationState::Running)
            || (has_legacy_data && !matches!(state, MigrationState::Succeeded | MigrationState::NotRequired));
        let (error_code, error_message) = if let Some(code) = key_error_code.clone() {
            let message = match code.as_str() {
                "MISSING_MANAGED_KEY" => {
                    "A managed data-directory secret key will be created when migration or first secret write starts"
                }
                "ENCRYPTED_DATA_KEY_MISSING" => "The key for existing encrypted data is missing",
                "SECRET_KEY_INVALID" => "The configured secret key is invalid",
                "SECRET_KEY_MISMATCH" => "The configured secret key cannot decrypt existing data",
                "KEY_FILE_UNAVAILABLE" => "The configured secret key file is unavailable",
                "MISSING_EXTERNAL_KEY" => "An external secret key is required",
                _ => "The local secret provider is unavailable",
            };
            (Some(code), Some(message.to_string()))
        } else if missing_required_key {
            (Some("MISSING_EXTERNAL_KEY".to_string()), Some("An external secret key is required".to_string()))
        } else if missing_existing_key {
            (
                Some("ENCRYPTED_DATA_KEY_MISSING".to_string()),
                Some("The key for existing encrypted data is missing".to_string()),
            )
        } else {
            (stored.error_code, stored.error_message)
        };
        let key_source = key_probe
            .as_ref()
            .map(|resolved| resolved.source.as_str())
            .unwrap_or(SecretKeySource::Unavailable.as_str())
            .to_string();
        let preflight = MigrationPreflight {
            migration_id: SECRET_STORE_MIGRATION_ID.to_string(),
            state,
            needs_migration,
            key_provider_available,
            key_status,
            key_creation_allowed,
            database_plaintext_count,
            connection_count: connections.max(0) as usize,
            plugin_secret_count: plugins.max(0) as usize,
            ai_secret_count: ai.max(0) as usize,
            tunnel_secret_count: tunnels.max(0) as usize,
            sync_credential_count: sync_credentials.max(0) as usize,
            legacy_json_files: files,
            backup_required: needs_migration,
            backup_path: stored.backup_path,
            error_message,
            error_code,
            data_dir: self.data_dir().to_string_lossy().to_string(),
            backup_dir: self.data_dir().to_string_lossy().to_string(),
            key_file_configured: std::env::var_os("DBX_SECRET_KEY_FILE").is_some(),
            key_file_readable: std::env::var("DBX_SECRET_KEY_FILE")
                .ok()
                .is_some_and(|path| std::fs::read_to_string(path).is_ok()),
            persistent_key_configured: key_provider_available,
            key_source,
        };
        Ok(preflight)
    }

    async fn validate_existing_encrypted_data(&self, codec: SecretCodec) -> Result<(), String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT connection_id, key, secret_enc FROM connection_secrets
                     WHERE secret_enc IS NOT NULL AND secret_enc <> ''",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (connection_id, key, envelope) = row.map_err(|error| error.to_string())?;
                codec.decrypt(&connection_id, &key, &envelope).map_err(|_| "SECRET_KEY_MISMATCH".to_string())?;
            }
            Ok(())
        })
        .await
    }

    pub async fn start_data_migration(&self) -> Result<MigrationReport, String> {
        let lock = DATA_MIGRATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
        // Migration may create or replace key material, so the codec resolved
        // for earlier reads must not be reused here.
        self.invalidate_secret_codec();
        let preflight = self.inspect_data_migration().await?;
        if preflight.is_ready() {
            return Ok(MigrationReport {
                migration_id: SECRET_STORE_MIGRATION_ID.to_string(),
                state: preflight.state,
                backup_path: preflight.backup_path,
                database_plaintext_count: 0,
                legacy_json_files: Vec::new(),
                verified_secret_count: 0,
                error_code: None,
                error_message: None,
            });
        }
        if !preflight.key_provider_available && !preflight.key_creation_allowed {
            let code = preflight.error_code.as_deref().unwrap_or("KEY_PROVIDER_UNAVAILABLE");
            let error = code.to_string();
            self.set_migration_state(MigrationState::Failed, None, Some(code), Some(&error), None).await?;
            return Err(error);
        }
        self.set_migration_state(MigrationState::Running, None, None, None, Some(&migration_counts_json(&preflight)))
            .await?;
        let backup_path = match self.create_migration_backup().await {
            Ok(path) => path,
            Err(error) => {
                let _ = self
                    .set_migration_state(MigrationState::Failed, None, Some("BACKUP_FAILED"), Some(&error), None)
                    .await;
                return Err(error);
            }
        };
        self.set_migration_state(MigrationState::Running, Some(&backup_path), None, None, None).await?;
        let result = async {
            let codec = self.secret_codec(preflight.key_creation_allowed)?;
            self.run_database_legacy_migrations(&codec).await?;
            self.migrate_from_json_staged(self.data_dir()).await?;
            let verified = self.verify_migration().await?;
            let renamed = self.finalize_legacy_json_files().await?;
            self.set_migration_state(
                MigrationState::Succeeded,
                Some(&backup_path),
                None,
                None,
                Some(&{
                    let mut counts: serde_json::Value =
                        serde_json::from_str(&migration_counts_json(&preflight)).unwrap();
                    let mut files = serde_json::Map::new();
                    for name in &renamed {
                        let name = format!("{name}.bak");
                        files.insert(
                            name.clone(),
                            serde_json::Value::String(file_digest(&self.data_dir().join(&name))?),
                        );
                    }
                    counts["legacyBakFiles"] = serde_json::Value::Object(files);
                    counts.to_string()
                }),
            )
            .await?;
            Ok::<MigrationReport, String>(MigrationReport {
                migration_id: SECRET_STORE_MIGRATION_ID.to_string(),
                state: MigrationState::Succeeded,
                backup_path: Some(backup_path.clone()),
                database_plaintext_count: preflight.database_plaintext_count,
                legacy_json_files: renamed,
                verified_secret_count: verified,
                error_code: None,
                error_message: None,
            })
        }
        .await;
        if let Err(error) = &result {
            // Every database migration helper uses its own transaction. Restore
            // the pre-migration SQLite snapshot if a later JSON parse, write,
            // or verification step fails, so the live database is never left
            // half-upgraded.
            let _ = self.restore_database_backup(&backup_path).await;
            let _ = self
                .set_migration_state(
                    MigrationState::Failed,
                    Some(&backup_path),
                    Some(migration_error_code(error)),
                    Some(error),
                    None,
                )
                .await;
        }
        drop(lock);
        result
    }

    pub async fn retry_data_migration(&self) -> Result<MigrationReport, String> {
        self.start_data_migration().await
    }

    pub async fn cleanup_migration_backups(&self) -> Result<(), String> {
        let _lock = DATA_MIGRATION_LOCK.get_or_init(|| tokio::sync::Mutex::new(())).lock().await;
        let record = self.load_migration_state().await?;
        if record.state != MigrationState::Succeeded {
            return Err("Migration backups may only be cleaned after success".to_string());
        }
        let mut counts: serde_json::Value =
            serde_json::from_str(&record.counts_json).map_err(|_| "Invalid migration backup manifest")?;
        let mut paths = migration_backup_paths(&counts)?;
        if let Some(path) = record.backup_path {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
        let root = self.data_dir().canonicalize().map_err(|_| "Cannot access migration backup directory")?;
        let mut backups = Vec::new();
        for path in paths {
            let path = PathBuf::from(path);
            if !path.exists() {
                continue;
            }
            let candidate = path.canonicalize().map_err(|_| "Invalid migration backup path")?;
            if candidate.parent() != Some(root.as_path())
                || !candidate
                    .file_name()
                    .and_then(|v| v.to_str())
                    .is_some_and(|v| v.starts_with("dbx-secret-migration-"))
                || path.symlink_metadata().map_err(|_| "Invalid migration backup path")?.file_type().is_symlink()
            {
                return Err("Invalid migration backup path".to_string());
            }
            backups.push(path);
        }
        let mut legacy = Vec::new();
        if let Some(files) = counts["legacyBakFiles"].as_object() {
            for (name, expected_hash) in files {
                if !LEGACY_JSON_NAMES.iter().any(|allowed| name == &format!("{allowed}.bak")) {
                    return Err("Invalid legacy backup manifest".to_string());
                }
                let path = self.data_dir().join(name);
                if !path.exists() {
                    continue;
                }
                if path.symlink_metadata().map_err(|_| "Cannot inspect legacy backup")?.file_type().is_symlink()
                    || expected_hash.as_str() != Some(file_digest(&path)?.as_str())
                {
                    return Err("Legacy backup changed; manual inspection is required".to_string());
                }
                legacy.push(path);
            }
        }
        // Validate every manifest entry before removing any file.
        for path in legacy {
            std::fs::remove_file(path).map_err(|_| "Cannot clean legacy backup")?;
        }
        for path in backups {
            std::fs::remove_dir_all(path).map_err(|_| "Cannot clean migration backup")?;
        }
        counts["legacyBakFiles"] = serde_json::json!({});
        counts["backupPaths"] = serde_json::json!([]);
        self.with_conn(move |conn| {
            conn.execute(
                "UPDATE data_migrations SET backup_path=NULL, counts_json=?1 WHERE migration_id=?2",
                params![counts.to_string(), SECRET_STORE_MIGRATION_ID],
            )
            .map_err(|_| "Cannot update backup manifest")?;
            Ok(())
        })
        .await
    }

    async fn restore_database_backup(&self, backup_path: &str) -> Result<(), String> {
        let backup = PathBuf::from(backup_path).join(STORAGE_DB_FILE_NAME);
        if !backup.is_file() {
            return Err("migration database backup is missing".to_string());
        }
        let live = self.path.clone();
        self.with_conn(move |_conn| {
            let source =
                Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| e.to_string())?;
            source.backup(DatabaseName::Main, &live, None).map_err(|e| e.to_string())
        })
        .await
    }

    async fn legacy_json_files(&self) -> Result<Vec<LegacyJsonFileStatus>, String> {
        let names = [
            "connections.json",
            "secrets.json",
            "ai_config.json",
            "ai_conversations.json",
            "query_history.json",
            "sidebar_layout.json",
        ];
        names
            .into_iter()
            .map(|name| {
                let path = self.data_dir().join(name);
                let metadata = std::fs::metadata(&path).ok();
                Ok(LegacyJsonFileStatus {
                    name: name.to_string(),
                    exists: metadata.is_some(),
                    bytes: metadata.map(|m| m.len()).unwrap_or(0),
                })
            })
            .collect()
    }

    async fn load_migration_state(&self) -> Result<MigrationStateRecord, String> {
        self.with_conn(|conn| {
            type MigrationStateRow = (String, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);
            let row: Option<MigrationStateRow> = conn
                .query_row(
                    "SELECT state, backup_path, error_code, error_message, source_fingerprint, counts_json FROM data_migrations WHERE migration_id = ?1",
                    [SECRET_STORE_MIGRATION_ID],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((state, backup, error_code, error_message, source_fingerprint, counts_json)) = row else {
                return Ok(MigrationStateRecord::default());
            };
            let state = serde_json::from_value(serde_json::Value::String(state)).unwrap_or(MigrationState::Pending);
            Ok(MigrationStateRecord { state, backup_path: backup, error_code, error_message, source_fingerprint, counts_json: counts_json.unwrap_or_else(|| "{}".to_string()) })
        })
        .await
    }

    async fn set_migration_state(
        &self,
        state: MigrationState,
        backup_path: Option<&str>,
        error_code: Option<&str>,
        error_message: Option<&str>,
        counts_json: Option<&str>,
    ) -> Result<(), String> {
        let state = serde_json::to_value(state).map_err(|e| e.to_string())?.as_str().unwrap_or("pending").to_string();
        let backup_path = backup_path.map(ToOwned::to_owned);
        let error_code = error_code.map(ToOwned::to_owned);
        let error_message = error_message
            .map(|value| migration_safe_message(error_code.as_deref().unwrap_or("MIGRATION_FAILED"), value));
        let previous = self.load_migration_state().await?;
        let mut counts: serde_json::Value =
            serde_json::from_str(&previous.counts_json).map_err(|_| "Invalid migration backup manifest".to_string())?;
        if let Some(update) = counts_json {
            let update: serde_json::Map<String, serde_json::Value> =
                serde_json::from_str(update).map_err(|_| "Invalid migration state update".to_string())?;
            for (key, value) in update {
                counts[&key] = value;
            }
        }
        let mut paths = migration_backup_paths(&counts)?;
        for path in previous.backup_path.iter().chain(backup_path.iter()) {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
        }
        counts["backupPaths"] = serde_json::json!(paths);
        // Never associate pre-migration scan counts with the post-migration source.
        if let Some(object) = counts.as_object_mut() {
            object.remove("cachedScan");
            object.remove("cachedScanFingerprint");
        }
        let counts_json = counts.to_string();
        let backup_path = backup_path.or(previous.backup_path);
        let source_fingerprint = Some(self.migration_source_fingerprint().await?);
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO data_migrations (migration_id,state,source_fingerprint,counts_json,backup_path,error_code,error_message,started_at,completed_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,datetime('now'),CASE WHEN ?2 IN ('succeeded','not_required') THEN datetime('now') ELSE NULL END)
                 ON CONFLICT(migration_id) DO UPDATE SET state=excluded.state, backup_path=excluded.backup_path,
                 source_fingerprint=excluded.source_fingerprint, counts_json=excluded.counts_json,
                 error_code=excluded.error_code, error_message=excluded.error_message,
                 completed_at=excluded.completed_at",
                params![SECRET_STORE_MIGRATION_ID, state, source_fingerprint, counts_json, backup_path, error_code, error_message],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    async fn create_migration_backup(&self) -> Result<String, String> {
        let root = self.data_dir().join(format!("dbx-secret-migration-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        restrict_backup_permissions(&root);
        let result = async {
            let backup_db = root.join(STORAGE_DB_FILE_NAME);
            let backup_db_for_sqlite = backup_db.clone();
            self.with_conn(move |conn| {
                conn.backup(DatabaseName::Main, &backup_db_for_sqlite, None).map_err(|e| e.to_string())
            })
            .await?;
            for name in [
                "connections.json",
                "secrets.json",
                "ai_config.json",
                "ai_conversations.json",
                "query_history.json",
                "sidebar_layout.json",
            ] {
                let source = self.data_dir().join(name);
                if source.is_file() {
                    std::fs::copy(&source, root.join(name)).map_err(|e| e.to_string())?;
                }
            }
            for entry in std::fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
                restrict_backup_file_permissions(&entry.path());
            }
            Ok::<(), String>(())
        }
        .await;
        match result {
            Ok(()) => Ok(root.to_string_lossy().to_string()),
            Err(error) => {
                // A failed backup may already contain a plaintext JSON copy.
                // Remove the temporary directory before reporting failure so a
                // retry cannot accumulate an untracked sensitive backup.
                let _ = std::fs::remove_dir_all(&root);
                Err(error)
            }
        }
    }

    async fn verify_migration(&self) -> Result<usize, String> {
        let codec = self.secret_codec(false)?;
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare("SELECT connection_id,key,secret,secret_enc FROM connection_secrets")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            let mut count = 0;
            for row in rows {
                let (namespace, key, legacy, encrypted) = row.map_err(|e| e.to_string())?;
                if !legacy.is_empty() {
                    return Err("plaintext secret remains after migration".to_string());
                }
                if let Some(encrypted) = encrypted.filter(|value| !value.is_empty()) {
                    codec.decrypt(&namespace, &key, &encrypted)?;
                    count += 1;
                }
            }
            let mut configs = conn.prepare("SELECT config_json FROM connections").map_err(|e| e.to_string())?;
            for row in configs.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
                let json = row.map_err(|e| e.to_string())?;
                let config: ConnectionConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                if connection_config_has_inline_secrets(&config) {
                    return Err("plaintext connection configuration remains after migration".to_string());
                }
            }
            for (table, query) in [
                ("ai_configs", "SELECT config_json FROM ai_configs"),
                ("ai_config", "SELECT config_json FROM ai_config"),
                ("ai_provider_configs", "SELECT config_json FROM ai_provider_configs"),
            ] {
                let mut statement = conn.prepare(query).map_err(|e| e.to_string())?;
                for row in statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
                    let json = row.map_err(|e| e.to_string())?;
                    let config: AiConfig = serde_json::from_str(&json)
                        .map_err(|e| format!("invalid {table} config after migration: {e}"))?;
                    let (_sanitized, secrets) = split_ai_config_secrets(&config)?;
                    if secrets.as_object().is_some_and(|value| !value.is_empty()) {
                        return Err(format!("plaintext {table} configuration remains after migration"));
                    }
                }
            }
            let mut statement = conn.prepare("SELECT config_json FROM tunnel_profiles").map_err(|e| e.to_string())?;
            for row in statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
                let json = row.map_err(|e| e.to_string())?;
                let profile: TransportLayerConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
                let mut scrubbed = profile.clone();
                scrubbed.scrub_secrets();
                if scrubbed != profile {
                    return Err("plaintext tunnel configuration remains after migration".to_string());
                }
            }
            Ok(count)
        })
        .await
    }

    async fn finalize_legacy_json_files(&self) -> Result<Vec<String>, String> {
        for name in LEGACY_JSON_NAMES {
            if self.data_dir().join(name).is_file() && self.data_dir().join(format!("{name}.bak")).exists() {
                return Err("legacy backup file already exists".to_string());
            }
        }
        let mut renamed = Vec::new();
        for name in [
            "connections.json",
            "secrets.json",
            "ai_config.json",
            "ai_conversations.json",
            "query_history.json",
            "sidebar_layout.json",
        ] {
            let source = self.data_dir().join(name);
            if source.is_file() {
                let target = self.data_dir().join(format!("{name}.bak"));
                if target.exists() {
                    return Err("legacy backup file already exists".to_string());
                }
                if let Err(error) = std::fs::rename(&source, &target) {
                    // Restore files already renamed in this pass. The DB
                    // snapshot is restored by the caller as well.
                    for previous in &renamed {
                        let old = self.data_dir().join(previous);
                        let bak = self.data_dir().join(format!("{previous}.bak"));
                        let _ = std::fs::rename(bak, old);
                    }
                    return Err(error.to_string());
                }
                renamed.push(name.to_string());
            }
        }
        Ok(renamed)
    }

    async fn init_schema(&self, migrate_legacy: bool) -> Result<(), String> {
        let migration_codec = migrate_legacy.then(|| self.secret_codec(true)).transpose()?;
        self.db.with_connection(move |conn| {
            for statement in SCHEMA_STATEMENTS {
                conn.execute(statement, []).map_err(|e| e.to_string())?;
            }
            ensure_history_columns_sync(conn)?;
            ensure_connection_secret_columns_sync(conn)?;
            if migrate_legacy {
                let codec = migration_codec.as_ref().ok_or_else(|| "KEY_PROVIDER_UNAVAILABLE".to_string())?;
                migrate_legacy_connection_secrets_sync(conn, codec)?;
                migrate_legacy_connection_config_json_sync(conn, codec)?;
            }
            ensure_saved_sql_columns_sync(conn)?;
            ensure_tab_runtime_cache_columns_sync(conn)?;
            ensure_schema_cache_columns_sync(conn)?;
            ensure_ai_configs_columns_sync(conn)?;
            if migrate_legacy {
                let codec = migration_codec.as_ref().ok_or_else(|| "KEY_PROVIDER_UNAVAILABLE".to_string())?;
                migrate_legacy_config_secrets_sync(conn, codec)?;
                migrate_legacy_app_settings_secrets_sync(conn, codec)?;
            }
            ensure_state_store_columns_sync(conn)?;
            ensure_ai_conversations_columns_sync(conn)?;
            ensure_ai_runs_columns_sync(conn)?;
            // After the column exists: bind legacy conversations to their
            // connection when the stored name identifies exactly one (#9902).
            backfill_ai_conversation_connections(conn)?;
            Ok(())
        })
    }

    async fn run_database_legacy_migrations(&self, codec: &SecretCodec) -> Result<(), String> {
        let codec = *codec;
        self.with_conn(move |conn| {
            migrate_legacy_connection_secrets_sync(conn, &codec)?;
            migrate_legacy_connection_config_json_sync(conn, &codec)?;
            migrate_legacy_config_secrets_sync(conn, &codec)?;
            migrate_legacy_app_settings_secrets_sync(conn, &codec)
        })
        .await
    }

    async fn with_conn<T, F>(&self, f: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    {
        let db = self.db.clone();
        tokio::task::spawn_blocking(move || db.with_connection(f)).await.map_err(|e| e.to_string())?
    }
}

fn inspect_sqlite_db_file(path: &Path) -> Result<SqliteDbFileState, String> {
    if !path.exists() {
        return Ok(SqliteDbFileState::Missing);
    }

    let metadata = path.metadata().map_err(|e| format!("Failed to inspect db file: {e}"))?;
    if metadata.len() == 0 {
        return Ok(SqliteDbFileState::Empty);
    }

    if crate::db::sqlite::path_has_sqlite_header(path)? {
        Ok(SqliteDbFileState::Valid)
    } else {
        Ok(SqliteDbFileState::Invalid)
    }
}

fn ensure_schema_cache_columns_sync(conn: &Connection) -> Result<(), String> {
    let mut columns = HashSet::new();
    let mut statement = conn.prepare("PRAGMA table_info(schema_cache)").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?;
    for row in rows {
        columns.insert(row.map_err(|error| error.to_string())?);
    }

    for (name, definition) in [
        ("updated_at_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("last_accessed_at_ms", "INTEGER NOT NULL DEFAULT 0"),
        ("byte_size", "INTEGER NOT NULL DEFAULT 0"),
        ("owner_id", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.contains(name) {
            conn.execute(&format!("ALTER TABLE schema_cache ADD COLUMN {name} {definition}"), [])
                .map_err(|error| error.to_string())?;
        }
    }

    conn.execute(
        "UPDATE schema_cache
         SET byte_size = length(payload_json)
         WHERE byte_size = 0 AND payload_json IS NOT NULL",
        [],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "UPDATE schema_cache
         SET updated_at_ms = COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, 0),
             last_accessed_at_ms = COALESCE(CAST(strftime('%s', updated_at) AS INTEGER) * 1000, 0)
         WHERE updated_at_ms = 0",
        [],
    )
    .map_err(|error| error.to_string())?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_schema_cache_updated_at_ms ON schema_cache (updated_at_ms)", [])
        .map_err(|error| error.to_string())?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_schema_cache_owner_lru
         ON schema_cache (owner_id, last_accessed_at_ms, updated_at_ms, cache_key)",
        [],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn ensure_connection_secret_columns_sync(conn: &Connection) -> Result<(), String> {
    let mut columns = HashSet::new();
    let mut statement = conn.prepare("PRAGMA table_info(connection_secrets)").map_err(|error| error.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1)).map_err(|error| error.to_string())?;
    for row in rows {
        columns.insert(row.map_err(|error| error.to_string())?);
    }
    if !columns.contains("secret_enc") {
        conn.execute("ALTER TABLE connection_secrets ADD COLUMN secret_enc TEXT", [])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Upgrade every legacy plaintext secret during database initialization.  The
/// old lazy-on-read migration left untouched rows readable in `dbx.db`; doing
/// this as part of schema startup gives upgrades a deterministic at-rest
/// guarantee while keeping the migration in one SQLite transaction.
fn migrate_legacy_connection_secrets_sync(conn: &mut Connection, codec: &SecretCodec) -> Result<(), String> {
    let rows = {
        let mut statement = conn
            .prepare("SELECT connection_id, key, secret FROM connection_secrets WHERE secret <> '' AND (secret_enc IS NULL OR secret_enc = '')")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
    };
    if rows.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    for (connection_id, key, secret) in rows {
        let encrypted = codec.encrypt(&connection_id, &key, &secret)?;
        tx.execute(
            "UPDATE connection_secrets SET secret = '', secret_enc = ?1 WHERE connection_id = ?2 AND key = ?3",
            params![encrypted, connection_id, key],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

/// Older databases stored the hydrated `ConnectionConfig` directly in
/// `connections.config_json`. Re-save only rows that still contain inline
/// credentials so the existing connection persistence path moves every
/// supported field into encrypted `connection_secrets` in one transaction.
///
/// The parsed JSON only carries the fields that were still inline, so every
/// field an earlier release already externalized reads back as empty here.
/// Re-saving writes those empty values through `persist_secret_in_tx`, which
/// turns them into DELETEs: a legacy row with an empty inline `password` next to
/// an inline `url_params` would silently lose its stored password. Snapshot the
/// stored secrets first so the re-save can never drop one. Rows are copied
/// verbatim, and `migrate_legacy_connection_secrets_sync` has already encrypted
/// every legacy plaintext value before this runs, so the restored rows keep the
/// at-rest guarantee. `save_password == false` is the one case where losing the
/// password is intended, so that row is not restored.
fn migrate_legacy_connection_config_json_sync(conn: &mut Connection, codec: &SecretCodec) -> Result<(), String> {
    let rows = {
        let mut statement =
            conn.prepare("SELECT id, config_json FROM connections").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let mut legacy = Vec::new();
    for (id, json) in rows {
        let config: ConnectionConfig = match serde_json::from_str(&json) {
            Ok(config) => config,
            Err(error) => {
                return Err(format!("Failed to parse legacy connection '{id}' during secret migration: {error}"))
            }
        };
        if connection_config_has_inline_secrets(&config) {
            legacy.push(config);
        }
    }
    if legacy.is_empty() {
        return Ok(());
    }
    let keep_password =
        legacy.iter().filter(|config| config.save_password).map(|config| config.id.clone()).collect::<HashSet<_>>();
    let connection_ids = legacy.iter().map(|config| config.id.clone()).collect::<HashSet<_>>();
    let stored_secrets = load_stored_connection_secrets_sync(conn, &connection_ids)?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    for config in legacy {
        tx.execute("DELETE FROM connections WHERE id = ?1", [&config.id]).map_err(|error| error.to_string())?;
        persist_connection_in_tx(&tx, codec, &config)?;
    }
    for (connection_id, key, secret, secret_enc) in stored_secrets {
        if key == "password" && !keep_password.contains(&connection_id) {
            continue;
        }
        if connection_secret_in_tx_exists(&tx, &connection_id, &key)? {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?1, ?2, ?3, ?4)",
            params![connection_id, key, secret, secret_enc],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

type StoredConnectionSecretRow = (String, String, String, Option<String>);

/// Read every non-empty secret row that belongs to `connection_ids` so a
/// migration re-save can put back anything it would otherwise delete.
fn load_stored_connection_secrets_sync(
    conn: &Connection,
    connection_ids: &HashSet<String>,
) -> Result<Vec<StoredConnectionSecretRow>, String> {
    let mut statement = conn
        .prepare(
            "SELECT connection_id, key, secret, secret_enc FROM connection_secrets
             WHERE secret <> '' OR (secret_enc IS NOT NULL AND secret_enc <> '')",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows.into_iter().filter(|(connection_id, ..)| connection_ids.contains(connection_id)).collect())
}

fn connection_secret_in_tx_exists(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key: &str,
) -> Result<bool, String> {
    tx.query_row(
        "SELECT 1 FROM connection_secrets
         WHERE connection_id = ?1 AND key = ?2 AND (secret <> '' OR (secret_enc IS NOT NULL AND secret_enc <> ''))",
        params![connection_id, key],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| error.to_string())
}

fn connection_config_has_inline_secrets(config: &ConnectionConfig) -> bool {
    if !config.password.is_empty()
        || config.url_params.as_deref().is_some_and(|value| !value.is_empty())
        || config.init_script.as_deref().is_some_and(|value| !value.is_empty())
        || config.connection_string.as_deref().is_some_and(|value| !value.is_empty())
        || !config.redis_sentinel_password.is_empty()
        || config.connection_secrets.values().any(|value| !value.is_empty())
    {
        return true;
    }
    for layer in &config.transport_layers {
        match layer {
            TransportLayerConfig::Ssh(layer) if !layer.password.is_empty() || !layer.key_passphrase.is_empty() => {
                return true;
            }
            TransportLayerConfig::Proxy(layer) if !layer.password.is_empty() => return true,
            TransportLayerConfig::HttpTunnel(layer) if !layer.token.is_empty() => return true,
            _ => {}
        }
    }
    let Some(external) = config.external_config.as_ref().and_then(serde_json::Value::as_object) else {
        return false;
    };
    let auth_secret = external
        .get("auth")
        .and_then(serde_json::Value::as_object)
        .and_then(|auth| ["token", "password", "value", "clientSecret"].iter().find_map(|key| auth.get(*key)))
        .is_some_and(nonempty_json_value);
    let signing_secret = external
        .get("tokenSigning")
        .and_then(serde_json::Value::as_object)
        .and_then(|signing| signing.get("key"))
        .is_some_and(nonempty_json_value);
    let nacos_console_secret = external
        .get("rnacosConsoleAuth")
        .and_then(serde_json::Value::as_object)
        .and_then(|auth| auth.get("password"))
        .is_some_and(nonempty_json_value);
    let cassandra_secret = external.get("tls").and_then(serde_json::Value::as_object).is_some_and(|tls| {
        ["truststore_password", "keystore_password"].iter().filter_map(|key| tls.get(*key)).any(nonempty_json_value)
    });
    auth_secret || signing_secret || nacos_console_secret || cassandra_secret
}

fn nonempty_json_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(value) => !value.is_empty(),
        serde_json::Value::Null => false,
        _ => true,
    }
}

/// Move credentials that older releases kept inline in AI and Tunnel JSON into
/// the same encrypted secret store used by connections. This runs during
/// startup so a successful upgrade never leaves a known credential in
/// `config_json`. Existing encrypted blobs win over stale inline values.
fn migrate_legacy_config_secrets_sync(conn: &mut Connection, codec: &SecretCodec) -> Result<(), String> {
    let legacy_ai = {
        let mut statement =
            conn.prepare("SELECT id, config_json FROM ai_configs").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let legacy_ai_single = {
        let mut statement =
            conn.prepare("SELECT config_json FROM ai_config WHERE id = 1").map_err(|error| error.to_string())?;
        statement.query_row([], |row| row.get::<_, String>(0)).optional().map_err(|error| error.to_string())?
    };
    let legacy_ai_providers = {
        let mut statement =
            conn.prepare("SELECT provider, config_json FROM ai_provider_configs").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let legacy_tunnels = {
        let mut statement =
            conn.prepare("SELECT id, config_json FROM tunnel_profiles").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    if legacy_ai.is_empty() && legacy_ai_single.is_none() && legacy_ai_providers.is_empty() && legacy_tunnels.is_empty()
    {
        return Ok(());
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;

    for (id, json) in legacy_ai {
        let config: AiConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let (sanitized, secrets) = split_ai_config_secrets(&config)?;
        let sanitized_json = serde_json::to_string(&sanitized).map_err(|error| error.to_string())?;
        tx.execute("UPDATE ai_configs SET config_json = ?1 WHERE id = ?2", params![sanitized_json, id])
            .map_err(|error| error.to_string())?;
        migrate_config_blob_in_tx(&tx, codec, &format!("{AI_SECRET_NAMESPACE_PREFIX}{id}"), &secrets)?;
    }
    if let Some(json) = legacy_ai_single {
        let config: AiConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let (sanitized, secrets) = split_ai_config_secrets(&config)?;
        let sanitized_json = serde_json::to_string(&sanitized).map_err(|error| error.to_string())?;
        tx.execute("UPDATE ai_config SET config_json = ?1 WHERE id = 1", [sanitized_json])
            .map_err(|error| error.to_string())?;
        migrate_config_blob_in_tx(&tx, codec, &format!("{AI_SECRET_NAMESPACE_PREFIX}legacy"), &secrets)?;
    }
    for (provider, json) in legacy_ai_providers {
        let config: AiConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let (sanitized, secrets) = split_ai_config_secrets(&config)?;
        let sanitized_json = serde_json::to_string(&sanitized).map_err(|error| error.to_string())?;
        tx.execute(
            "UPDATE ai_provider_configs SET config_json = ?1 WHERE provider = ?2",
            params![sanitized_json, provider],
        )
        .map_err(|error| error.to_string())?;
        migrate_config_blob_in_tx(&tx, codec, &format!("{AI_SECRET_NAMESPACE_PREFIX}provider.{provider}"), &secrets)?;
    }
    for (id, json) in legacy_tunnels {
        let profile: TransportLayerConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let mut sanitized = profile.clone();
        sanitized.scrub_secrets();
        let sanitized_json = serde_json::to_string(&sanitized).map_err(|error| error.to_string())?;
        tx.execute("UPDATE tunnel_profiles SET config_json = ?1 WHERE id = ?2", params![sanitized_json, id])
            .map_err(|error| error.to_string())?;
        if sanitized != profile {
            migrate_config_blob_in_tx(
                &tx,
                codec,
                &format!("{TUNNEL_SECRET_NAMESPACE_PREFIX}{id}"),
                &serde_json::to_value(profile).map_err(|error| error.to_string())?,
            )?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

fn migrate_config_blob_in_tx(
    tx: &Transaction<'_>,
    codec: &SecretCodec,
    namespace: &str,
    value: &serde_json::Value,
) -> Result<(), String> {
    let has_value = value.as_object().is_some_and(|object| !object.is_empty());
    if !has_value {
        return Ok(());
    }
    let existing: Option<String> = tx
        .query_row(
            "SELECT secret_enc FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![namespace, CONFIG_SECRET_BLOB_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if existing.as_deref().is_some_and(|value| !value.is_empty()) {
        tx.execute(
            "UPDATE connection_secrets SET secret = '' WHERE connection_id = ?1 AND key = ?2",
            params![namespace, CONFIG_SECRET_BLOB_KEY],
        )
        .map_err(|error| error.to_string())?;
        return Ok(());
    }
    let encrypted = codec.encrypt(namespace, CONFIG_SECRET_BLOB_KEY, &value.to_string())?;
    tx.execute(
        "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?1, ?2, '', ?3)",
        params![namespace, CONFIG_SECRET_BLOB_KEY, encrypted],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// Move credentials that older releases kept in `app_settings.settings_json`
/// into the encrypted global namespace during database initialization. This
/// is deliberately eager rather than lazy: after a successful upgrade, a
/// plain-text settings row must not remain merely because the user has not
/// opened the sync settings screen yet.
fn migrate_legacy_app_settings_secrets_sync(conn: &mut Connection, codec: &SecretCodec) -> Result<(), String> {
    let Some(json) = conn
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let mut settings =
        serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).map_err(|error| error.to_string())?;
    let legacy_device_secret = settings.remove("local_device_secret");
    let legacy_sync_passphrase = settings.remove("webdav_sync_secrets_passphrase");
    let legacy_accounts =
        settings.remove("webdav_passwords").and_then(|value| value.as_object().cloned()).unwrap_or_default();
    let has_migration =
        legacy_device_secret.is_some() || legacy_sync_passphrase.is_some() || !legacy_accounts.is_empty();
    if !has_migration {
        return Ok(());
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let store_value = |namespace: &str, key: &str, value: &serde_json::Value| -> Result<(), String> {
        let plaintext = match value {
            serde_json::Value::String(value) if !value.is_empty() => value.clone(),
            value if !value.is_null() => value.to_string(),
            _ => return Ok(()),
        };
        let existing: Option<String> = tx
            .query_row(
                "SELECT secret_enc FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                params![namespace, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing.as_deref().is_some_and(|value| !value.is_empty()) {
            return Ok(());
        }
        let encrypted = codec.encrypt(namespace, key, &plaintext)?;
        tx.execute(
            "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?1, ?2, '', ?3)",
            params![namespace, key, encrypted],
        )
        .map_err(|error| error.to_string())?;
        Ok(())
    };

    if let Some(value) = legacy_device_secret {
        store_value(GLOBAL_SECRET_NAMESPACE, "local_device_secret", &value)?;
    }
    if let Some(value) = legacy_sync_passphrase {
        store_value(GLOBAL_SECRET_NAMESPACE, "webdav_sync_secrets_passphrase", &value)?;
    }
    for (account, value) in legacy_accounts {
        store_value(GLOBAL_SECRET_NAMESPACE, &format!("webdav_password.{account}"), &value)?;
    }

    let updated = serde_json::Value::Object(settings).to_string();
    tx.execute("UPDATE app_settings SET settings_json = ?1 WHERE id = 1", [updated])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

fn open_read_only_sqlite(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Failed to open db read-only: {e}"))
}

fn sqlite_db_has_user_data(conn: &Connection) -> Result<bool, String> {
    for table_name in USER_DATA_TABLES {
        if sqlite_table_has_rows(conn, table_name)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn sqlite_table_has_rows(conn: &Connection, table_name: &str) -> Result<bool, String> {
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table_name],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(false);
    }

    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table_name} LIMIT 1)");
    conn.query_row(&sql, [], |row| row.get(0)).map_err(|e| e.to_string())
}

fn remove_sqlite_db_files(db_path: &Path) -> Result<(), String> {
    for path in [db_path.to_path_buf(), db_path.with_extension("db-wal"), db_path.with_extension("db-shm")] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("Failed to remove empty target db file {}: {err}", path.display())),
        }
    }
    Ok(())
}

/// Every file that can hold database contents: the database itself plus the
/// rollback journal, WAL, and shared-memory sidecars. SQLite derives these by
/// appending to the database filename, so they are built the same way rather
/// than through `Path::with_extension`, which would depend on the database
/// being named `*.db`.
///
/// Master journals (`<database>-mjXXXXXXXX`) are only written for a
/// transaction spanning several attached databases, which the storage handle
/// never performs.
#[cfg(unix)]
fn sqlite_file_set(db_path: &Path) -> [PathBuf; 4] {
    let sidecar = |suffix: &str| {
        let mut name = db_path.as_os_str().to_os_string();
        name.push(suffix);
        PathBuf::from(name)
    };
    [db_path.to_path_buf(), sidecar("-journal"), sidecar("-wal"), sidecar("-shm")]
}

/// Restrict the SQLite files to the sharing model declared by the data
/// directory itself.
///
/// `connection_secrets` stores authenticated ciphertext, while the file mode
/// still keeps the local credential store out of reach of other local accounts on
/// platforms whose per-user data directory is world-traversable: most Linux
/// desktops create `~/.local/share` as 0755, unlike `~/Library` on macOS.
///
/// A data directory that several local accounts share — the portable layout
/// documented on `Storage::open` and `enable_wal_mode` — has to be
/// group-writable for those accounts to use it at all, so that is taken as
/// the operator opting into group access: world bits are dropped and group
/// bits are preserved. Any other directory is treated as single-user and its
/// files become owner-only. World-readable is never a supported sharing
/// model, because it cannot be narrowed to a set of accounts.
///
/// Deliberately best-effort: a portable data directory can live on a
/// filesystem without POSIX modes, and a file owned by another user fails
/// `chmod` with `EPERM` instead of being re-permissioned behind that user's
/// back. Neither case should stop the app from starting.
#[cfg(unix)]
fn restrict_db_file_permissions(db_path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    // S_IWGRP on the directory: the operator made it writable by a group, so
    // group members are expected to reach the database through it.
    let group_shared = db_path
        .parent()
        .and_then(|dir| std::fs::metadata(dir).ok())
        .is_some_and(|dir| dir.permissions().mode() & 0o020 != 0);
    let keep = if group_shared { 0o770 } else { 0o700 };

    for path in sqlite_file_set(db_path) {
        let Ok(metadata) = std::fs::metadata(&path) else { continue };
        let mode = metadata.permissions().mode() & 0o777;
        // Owner bits, and group bits in a shared directory, are preserved.
        let restricted = mode & keep;
        if mode == restricted {
            continue;
        }
        if let Err(err) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(restricted)) {
            log::debug!("Could not restrict permissions on {}: {err}", path.display());
        }
    }
}

#[cfg(not(unix))]
fn restrict_db_file_permissions(_db_path: &Path) {}

#[cfg(unix)]
fn restrict_backup_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
}

#[cfg(unix)]
fn restrict_backup_file_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(metadata.permissions().mode() & 0o600));
    }
}

#[cfg(not(unix))]
fn restrict_backup_permissions(_path: &Path) {}

#[cfg(not(unix))]
fn restrict_backup_file_permissions(_path: &Path) {}

fn ensure_history_columns_sync(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str)] = &[
        ("activity_kind", "TEXT NOT NULL DEFAULT 'query'"),
        ("connection_id", "TEXT NOT NULL DEFAULT ''"),
        ("operation", "TEXT NOT NULL DEFAULT ''"),
        ("target", "TEXT NOT NULL DEFAULT ''"),
        ("affected_rows", "INTEGER"),
        ("rollback_sql", "TEXT"),
        ("details_json", "TEXT"),
    ];

    let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('history')").map_err(|e| e.to_string())?;
    let existing = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (name, definition) in COLUMNS {
        if existing.contains(*name) {
            continue;
        }
        conn.execute(&format!("ALTER TABLE history ADD COLUMN {name} {definition}"), []).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_saved_sql_columns_sync(conn: &Connection) -> Result<(), String> {
    const FOLDER_COLUMNS: &[(&str, &str)] =
        &[("parent_folder_id", "TEXT"), ("order_index", "INTEGER NOT NULL DEFAULT 0")];
    const FILE_COLUMNS: &[(&str, &str)] = &[
        ("catalog_name", "TEXT"),
        ("order_index", "INTEGER NOT NULL DEFAULT 0"),
        ("open_count", "INTEGER NOT NULL DEFAULT 0"),
        ("opened_at", "TEXT"),
    ];

    ensure_table_columns(conn, "saved_sql_folders", FOLDER_COLUMNS)?;
    ensure_table_columns(conn, "saved_sql_files", FILE_COLUMNS)?;
    Ok(())
}

fn ensure_tab_runtime_cache_columns_sync(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str)] = &[
        ("created_at", "INTEGER NOT NULL DEFAULT 0"),
        ("last_accessed_at", "INTEGER NOT NULL DEFAULT 0"),
        ("owner_id", "TEXT"),
    ];
    ensure_table_columns(conn, "tab_runtime_cache", COLUMNS)?;
    let now = unix_timestamp_millis();
    // Legacy rows must receive a grace period instead of being treated as ancient crash leftovers.
    conn.execute("UPDATE tab_runtime_cache SET created_at = ?1 WHERE created_at = 0", [now])
        .map_err(|e| e.to_string())?;
    conn.execute("UPDATE tab_runtime_cache SET last_accessed_at = created_at WHERE last_accessed_at = 0", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn unix_timestamp_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}

fn ensure_ai_configs_columns_sync(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str)] = &[
        ("model", "TEXT NOT NULL DEFAULT ''"),
        ("models", "TEXT NOT NULL DEFAULT '[]'"),
        ("is_default", "INTEGER NOT NULL DEFAULT 0"),
    ];

    ensure_table_columns(conn, "ai_configs", COLUMNS)?;

    // Create partial unique index (if not exists)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_configs_default ON ai_configs(is_default) WHERE is_default = 1",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Adds conversation metadata columns to databases created before these fields.
fn ensure_ai_conversations_columns_sync(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str)] = &[
        ("queued_input", "TEXT"),
        ("plugin_context_json", "TEXT"),
        // Session-scoped connection binding (#9902). Existing rows keep the
        // empty default and are backfilled from `connection_name` by
        // [`backfill_ai_conversation_connections`].
        ("connection_id", "TEXT NOT NULL DEFAULT ''"),
        ("schema_name", "TEXT"),
    ];

    ensure_table_columns(conn, "ai_conversations", COLUMNS)
}

/// Backfills `connection_id` for conversations persisted before session-scoped
/// binding existed (#9902).
///
/// `connection_name` is **not unique** (the import dedup key is
/// name + host + port), so only an unambiguous match may be written back: a name
/// that resolves to exactly one saved connection is bound, while zero matches
/// (connection deleted or never saved) and several matches (duplicates) stay
/// empty and surface as "unbound" in the UI. Guessing here would silently pin a
/// conversation to the wrong database, which is the defect this column exists to
/// fix.
///
/// Runs on every open but only touches rows that are still empty, so it is
/// idempotent and picks up connections imported after the last run.
fn backfill_ai_conversation_connections(conn: &Connection) -> Result<usize, String> {
    let mut by_name: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, config_json FROM connections").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, json) = row.map_err(|e| e.to_string())?;
            // Only the display name is needed, and it is exactly what the
            // frontend persisted into `connection_name`. Reading it straight
            // from the JSON avoids depending on the full `ConnectionConfig`
            // deserializer (which also handles legacy shapes) for a migration.
            let name = serde_json::from_str::<serde_json::Value>(&json)
                .ok()
                .and_then(|value| value.get("name").and_then(|name| name.as_str()).map(|name| name.trim().to_string()))
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            by_name.entry(name).or_default().push(id);
        }
    }

    let mut stmt = conn
        .prepare("SELECT id, connection_name FROM ai_conversations WHERE connection_id = ''")
        .map_err(|e| e.to_string())?;
    let pending = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    let mut updated = 0usize;
    for (conversation_id, connection_name) in pending {
        let candidates = match by_name.get(connection_name.trim()) {
            Some(candidates) => candidates,
            None => continue,
        };
        if candidates.len() != 1 {
            continue;
        }
        let changed = conn
            .execute(
                "UPDATE ai_conversations SET connection_id = ?1 WHERE id = ?2 AND connection_id = ''",
                params![candidates[0], conversation_id],
            )
            .map_err(|e| e.to_string())?;
        updated += changed;
    }
    Ok(updated)
}

/// Adds the background-run recovery columns (`fifo_category`, `pending_input`,
/// `max_seq`) to databases created by earlier iterations of the uncommitted
/// WIP, where the `ai_runs` table predates these fields.
fn ensure_ai_runs_columns_sync(conn: &Connection) -> Result<(), String> {
    const COLUMNS: &[(&str, &str)] = &[("fifo_category", "TEXT"), ("pending_input", "TEXT"), ("max_seq", "INTEGER")];

    ensure_table_columns(conn, "ai_runs", COLUMNS)
}

fn ensure_table_columns(conn: &Connection, table_name: &str, columns: &[(&str, &str)]) -> Result<(), String> {
    let mut stmt =
        conn.prepare(&format!("SELECT name FROM pragma_table_info('{table_name}')")).map_err(|e| e.to_string())?;
    let existing = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;

    for (name, definition) in columns {
        if existing.contains(*name) {
            continue;
        }
        conn.execute(&format!("ALTER TABLE {table_name} ADD COLUMN {name} {definition}"), [])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_state_store_columns_sync(conn: &Connection) -> Result<(), String> {
    conn.execute("CREATE TABLE IF NOT EXISTS state_store (key TEXT PRIMARY KEY, value BLOB NOT NULL, content_type TEXT NOT NULL DEFAULT 'application/octet-stream', version INTEGER NOT NULL DEFAULT 1)", []).map_err(|e| e.to_string())?;

    // SQLite ALTER TABLE ADD COLUMN rejects parenthesized default expressions.
    const COLUMNS: &[(&str, &str)] = &[
        ("value", "BLOB NOT NULL DEFAULT x''"),
        ("content_type", "TEXT NOT NULL DEFAULT 'application/octet-stream'"),
        ("version", "INTEGER NOT NULL DEFAULT 1"),
        ("payload", "BLOB DEFAULT x''"),
    ];
    ensure_table_columns(conn, "state_store", COLUMNS)
}

fn ssh_tunnel_secret_segment(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    if hop.id.trim().is_empty() {
        index.to_string()
    } else {
        hop.id.clone()
    }
}

fn ssh_tunnel_password_key(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    format!("{}{}.password", SSH_TUNNEL_SECRET_PREFIX, ssh_tunnel_secret_segment(index, hop))
}

fn ssh_tunnel_key_passphrase_key(index: usize, hop: &crate::models::connection::SshTunnelConfig) -> String {
    format!("{}{}.key_passphrase", SSH_TUNNEL_SECRET_PREFIX, ssh_tunnel_secret_segment(index, hop))
}

fn transport_layer_secret_segment(index: usize, layer: &TransportLayerConfig) -> String {
    let id = layer.id().trim();
    if id.is_empty() {
        index.to_string()
    } else {
        id.to_string()
    }
}

fn transport_layer_ssh_password_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.ssh_password", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_ssh_key_passphrase_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.ssh_key_passphrase", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_proxy_password_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.proxy_password", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_http_tunnel_token_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.http_tunnel_token", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn scrub_transport_layer_secrets(config: &mut ConnectionConfig) {
    for layer in &mut config.transport_layers {
        match layer {
            TransportLayerConfig::Ssh(ssh) => {
                ssh.password.clear();
                ssh.key_passphrase.clear();
            }
            TransportLayerConfig::Proxy(proxy) => {
                proxy.password.clear();
            }
            TransportLayerConfig::HttpTunnel(http) => {
                http.token.clear();
            }
        }
    }
}

fn scrub_mq_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::MessageQueue {
        return;
    }
    let Some(auth) = mq_auth_object_mut(config.external_config.as_mut()) else {
        return;
    };
    match mq_auth_kind(auth) {
        Some("token") => scrub_json_secret(auth, "token"),
        Some("basic") => scrub_json_secret(auth, "password"),
        Some(kind) if is_api_key_auth_kind(kind) => scrub_json_secret(auth, "value"),
        Some("oauth2") => scrub_json_secret(auth, "clientSecret"),
        _ => {}
    }
}

fn scrub_mqtt_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Mqtt {
        return;
    }
    let Some(auth) = config.external_config.as_mut().and_then(|external| external.get_mut("auth")) else {
        return;
    };
    let Some(auth) = auth.as_object_mut() else {
        return;
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("password") {
        scrub_json_secret(auth, "password");
    }
}

fn scrub_mq_token_signing_secret(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::MessageQueue {
        return;
    }
    let Some(signing) = mq_token_signing_object_mut(config.external_config.as_mut()) else {
        return;
    };
    scrub_json_secret(signing, "key");
}

fn scrub_nacos_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Nacos {
        return;
    }
    if let Some(auth) = nacos_auth_object_mut(config.external_config.as_mut()) {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            scrub_json_secret(auth, "password");
        }
    }
    if let Some(auth) = nacos_console_auth_object_mut(config.external_config.as_mut()) {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            scrub_json_secret(auth, "password");
        }
    }
}

fn scrub_cassandra_tls_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Cassandra {
        return;
    }
    let Some(tls) = cassandra_tls_object_mut(config.external_config.as_mut()) else {
        return;
    };
    scrub_json_secret(tls, "truststore_password");
    scrub_json_secret(tls, "keystore_password");
}

fn scrub_salesforce_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Salesforce {
        return;
    }
    let Some(auth) = salesforce_auth_object_mut(config.external_config.as_mut()) else {
        return;
    };
    scrub_json_secret(auth, "clientSecret");
    scrub_json_secret(auth, "refreshToken");
    scrub_json_secret(auth, "password");
}

fn delete_secret_prefix_in_tx(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key_prefix: &str,
) -> Result<(), String> {
    let like = format!("{key_prefix}%");
    tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1 AND key LIKE ?2", params![connection_id, like])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// History

fn history_filter_targets_connection(connection: &HistoryConnectionFilter, database: &HistoryDatabaseFilter) -> bool {
    if !connection.connection_id.is_empty() || !database.connection_id.is_empty() {
        !connection.connection_id.is_empty() && connection.connection_id == database.connection_id
    } else {
        !connection.connection_name.is_empty() && connection.connection_name == database.connection_name
    }
}

fn append_history_scope_clause(
    clauses: &mut Vec<String>,
    values: &mut Vec<Value>,
    connections: &[HistoryConnectionFilter],
    databases: &[HistoryDatabaseFilter],
) {
    let mut alternatives = Vec::new();
    for connection in connections {
        // Database selections narrow only their owning connection; other selected connections remain whole scopes.
        if databases
            .iter()
            .any(|database| !database.database.is_empty() && history_filter_targets_connection(connection, database))
        {
            continue;
        }
        if !connection.connection_id.is_empty() {
            alternatives.push("connection_id = ?".to_string());
            values.push(Value::Text(connection.connection_id.clone()));
        } else if !connection.connection_name.is_empty() {
            // Legacy JSON entries have no connection ID, so name fallback is limited to empty-ID rows.
            alternatives.push("(connection_id = '' AND connection_name = ?)".to_string());
            values.push(Value::Text(connection.connection_name.clone()));
        }
    }
    for database in databases.iter().filter(|database| !database.database.is_empty()) {
        if !database.connection_id.is_empty() {
            alternatives.push("(connection_id = ? AND database = ?)".to_string());
            values.push(Value::Text(database.connection_id.clone()));
            values.push(Value::Text(database.database.clone()));
        } else if !database.connection_name.is_empty() {
            alternatives.push("(connection_id = '' AND connection_name = ? AND database = ?)".to_string());
            values.push(Value::Text(database.connection_name.clone()));
            values.push(Value::Text(database.database.clone()));
        }
    }
    if !alternatives.is_empty() {
        clauses.push(format!("({})", alternatives.join(" OR ")));
    }
}

fn escape_history_like_pattern(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

// Only fixed SQL fragments are assembled dynamically; every filter value remains parameter-bound.
fn history_search_predicate(request: &HistorySearchRequest) -> (String, Vec<Value>) {
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    append_history_scope_clause(&mut clauses, &mut values, &request.connections, &request.databases);

    if let Some(kind) = request.activity_kind.as_ref().filter(|kind| !kind.is_empty()) {
        clauses.push("activity_kind = ?".to_string());
        values.push(Value::Text(kind.clone()));
    }
    if let Some(success) = request.success {
        clauses.push("success = ?".to_string());
        values.push(Value::Integer(i64::from(success)));
    }
    if let Some(started_at) = request.started_at.as_ref().filter(|value| !value.is_empty()) {
        clauses.push("julianday(executed_at) >= julianday(?)".to_string());
        values.push(Value::Text(started_at.clone()));
    }
    if let Some(ended_at) = request.ended_at.as_ref().filter(|value| !value.is_empty()) {
        clauses.push("julianday(executed_at) <= julianday(?)".to_string());
        values.push(Value::Text(ended_at.clone()));
    }

    let search_text = request.search_text.trim();
    if !search_text.is_empty() {
        let pattern = format!("%{}%", escape_history_like_pattern(search_text));
        let fields = ["sql_text", "connection_name", "database", "operation", "target"];
        clauses.push(format!(
            "({})",
            fields
                .iter()
                .map(|field| format!("{field} LIKE ? ESCAPE '\\' COLLATE NOCASE"))
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
        values.extend(fields.iter().map(|_| Value::Text(pattern.clone())));
    }

    let predicate = if clauses.is_empty() { String::new() } else { format!(" WHERE {}", clauses.join(" AND ")) };
    (predicate, values)
}

fn map_history_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HistoryEntry> {
    Ok(HistoryEntry {
        id: row.get(0)?,
        connection_name: row.get(1)?,
        database: row.get(2)?,
        sql: row.get(3)?,
        executed_at: row.get(4)?,
        execution_time_ms: row.get::<_, i64>(5)? as u128,
        success: row.get(6)?,
        error: row.get(7)?,
        activity_kind: {
            let value: String = row.get(8)?;
            if value.is_empty() {
                "query".to_string()
            } else {
                value
            }
        },
        connection_id: row.get(9)?,
        operation: row.get(10)?,
        target: row.get(11)?,
        affected_rows: row.get(12)?,
        rollback_sql: row.get(13)?,
        details_json: row.get(14)?,
    })
}

fn history_retention_limit_from_settings(settings: &serde_json::Map<String, serde_json::Value>) -> u32 {
    settings
        .get(HISTORY_RETENTION_LIMIT_KEY)
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| crate::history::validate_history_retention_limit(*value).is_ok())
        .unwrap_or(MAX_HISTORY as u32)
}

fn load_history_retention_limit_from_conn(conn: &Connection) -> Result<u32, String> {
    let current: Option<String> = conn
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let settings = match current {
        Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
            .map_err(|e| format!("invalid app settings JSON: {e}"))?,
        None => serde_json::Map::new(),
    };
    Ok(history_retention_limit_from_settings(&settings))
}

fn app_settings_map_from_conn(conn: &Connection) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let current: Option<String> = conn
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match current {
        Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
            .map_err(|e| format!("invalid app settings JSON: {e}")),
        None => Ok(serde_json::Map::new()),
    }
}

fn write_app_settings_map(
    conn: &Connection,
    settings: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|e| e.to_string())?;
    conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", [json])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Reads a JSON string array setting, dropping blanks and duplicates so a
/// hand-edited or partially written value can never widen a permission list.
fn normalized_string_list(value: Option<&serde_json::Value>) -> Vec<String> {
    let mut values: Vec<String> = value
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    values.sort();
    values.dedup();
    values
}

fn normalized_setting_id(value: &str, label: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.chars().count() > 256 {
        return Err(format!("A valid {label} is required"));
    }
    Ok(trimmed.to_string())
}

impl Storage {
    pub async fn save_history_entry(&self, entry: &HistoryEntry) -> Result<(), String> {
        let entry = entry.clone();
        self.with_conn(move |conn| {
            let tx =
                conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let limit = load_history_retention_limit_from_conn(&tx)?;
            tx.execute(
                "INSERT OR REPLACE INTO history \
                 (id, connection_name, database, sql_text, executed_at, execution_time_ms, success, error, \
                  activity_kind, connection_id, operation, target, affected_rows, rollback_sql, details_json) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    entry.id,
                    entry.connection_name,
                    entry.database,
                    entry.sql,
                    entry.executed_at,
                    entry.execution_time_ms as i64,
                    entry.success,
                    entry.error,
                    entry.activity_kind,
                    entry.connection_id,
                    entry.operation,
                    entry.target,
                    entry.affected_rows,
                    entry.rollback_sql,
                    entry.details_json
                ],
            )
            .map_err(|e| e.to_string())?;

            if limit != 0 {
                tx.execute(
                    "DELETE FROM history WHERE id NOT IN \
                     (SELECT id FROM history ORDER BY executed_at DESC, id DESC LIMIT ?1)",
                    [i64::from(limit)],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_history_entries(
        &self,
        limit: usize,
        offset: usize,
        activity_kind: Option<String>,
    ) -> Result<Vec<HistoryEntry>, String> {
        self.with_conn(move |conn| {
            let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<HistoryEntry> {
                Ok(HistoryEntry {
                    id: row.get(0)?,
                    connection_name: row.get(1)?,
                    database: row.get(2)?,
                    sql: row.get(3)?,
                    executed_at: row.get(4)?,
                    execution_time_ms: row.get::<_, i64>(5)? as u128,
                    success: row.get(6)?,
                    error: row.get(7)?,
                    activity_kind: {
                        let value: String = row.get(8)?;
                        if value.is_empty() { "query".to_string() } else { value }
                    },
                    connection_id: row.get(9)?,
                    operation: row.get(10)?,
                    target: row.get(11)?,
                    affected_rows: row.get(12)?,
                    rollback_sql: row.get(13)?,
                    details_json: row.get(14)?,
                })
            };

            if let Some(kind) = activity_kind {
                let mut stmt = conn
                    .prepare(
                        "SELECT id, connection_name, database, sql_text, executed_at, execution_time_ms, success, \
                         error, activity_kind, connection_id, operation, target, affected_rows, rollback_sql, details_json \
                         FROM history WHERE activity_kind = ?1 ORDER BY executed_at DESC LIMIT ?2 OFFSET ?3",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![kind, limit as i64, offset as i64], map_row)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
            } else {
                let mut stmt = conn
                    .prepare(
                        "SELECT id, connection_name, database, sql_text, executed_at, execution_time_ms, success, \
                         error, activity_kind, connection_id, operation, target, affected_rows, rollback_sql, details_json \
                         FROM history ORDER BY executed_at DESC LIMIT ?1 OFFSET ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![limit as i64, offset as i64], map_row)
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
            }
        })
        .await
    }

    pub async fn search_history_entries(&self, request: HistorySearchRequest) -> Result<HistorySearchResult, String> {
        self.with_conn(move |conn| {
            let (predicate, values) = history_search_predicate(&request);
            // Count before applying the cursor so the UI keeps the full filtered total.
            let count_sql = format!("SELECT COUNT(*) FROM history{predicate}");
            let total = conn
                .query_row(&count_sql, params_from_iter(values.iter()), |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())? as usize;

            let mut page_predicate = predicate;
            let mut page_values = values;
            // Keep this predicate aligned with ORDER BY to avoid skipping equal-timestamp rows.
            if let Some(cursor) = &request.cursor {
                let cursor_clause = "(executed_at < ? OR (executed_at = ? AND id < ?))";
                if page_predicate.is_empty() {
                    page_predicate = format!(" WHERE {cursor_clause}");
                } else {
                    page_predicate.push_str(" AND ");
                    page_predicate.push_str(cursor_clause);
                }
                page_values.push(Value::Text(cursor.executed_at.clone()));
                page_values.push(Value::Text(cursor.executed_at.clone()));
                page_values.push(Value::Text(cursor.id.clone()));
            }

            let limit = if request.limit == 0 { 100 } else { request.limit.clamp(1, 200) };
            let sql = format!(
                "SELECT id, connection_name, database, sql_text, executed_at, execution_time_ms, success, \
                 error, activity_kind, connection_id, operation, target, affected_rows, rollback_sql, details_json \
                 FROM history{page_predicate} ORDER BY executed_at DESC, id DESC LIMIT ?"
            );
            page_values.push(Value::Integer((limit + 1) as i64));
            let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map(params_from_iter(page_values.iter()), map_history_row)
                .map_err(|error| error.to_string())?;
            let mut entries = rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            let has_more = entries.len() > limit;
            entries.truncate(limit);
            let next_cursor = if has_more {
                entries
                    .last()
                    .map(|entry| HistoryCursor { executed_at: entry.executed_at.clone(), id: entry.id.clone() })
            } else {
                None
            };

            Ok(HistorySearchResult { entries, next_cursor, total })
        })
        .await
    }

    pub async fn load_history_connection_options(&self) -> Result<Vec<HistoryConnectionOption>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT connection_id, connection_name, database \
                     FROM history ORDER BY executed_at DESC, id DESC",
                )
                .map_err(|error| error.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
                .map_err(|error| error.to_string())?;

            let mut options = Vec::<HistoryConnectionOption>::new();
            let mut indexes = HashMap::<String, usize>::new();
            for row in rows {
                let (connection_id, connection_name, database) = row.map_err(|error| error.to_string())?;
                let key = if connection_id.is_empty() {
                    format!("legacy:{connection_name}")
                } else {
                    format!("id:{connection_id}")
                };
                let index = if let Some(index) = indexes.get(&key) {
                    *index
                } else {
                    let index = options.len();
                    indexes.insert(key, index);
                    options.push(HistoryConnectionOption { connection_id, connection_name, databases: Vec::new() });
                    index
                };
                if !database.is_empty() && !options[index].databases.contains(&database) {
                    options[index].databases.push(database);
                }
            }
            Ok(options)
        })
        .await
    }

    pub async fn clear_history(&self) -> Result<(), String> {
        self.with_conn(|conn| conn.execute("DELETE FROM history", []).map(|_| ()).map_err(|e| e.to_string())).await
    }

    pub async fn delete_history_entry(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM history WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
        })
        .await
    }
}

// AI Config

fn ai_provider_key(provider: &AiProvider) -> String {
    serde_json::to_value(provider).ok().and_then(|value| value.as_str().map(ToOwned::to_owned)).unwrap_or_default()
}

fn ai_provider_from_key(provider: &str) -> Result<AiProvider, String> {
    serde_json::from_value(serde_json::Value::String(provider.to_string()))
        .map_err(|_| format!("Invalid AI provider: {provider}"))
}

impl Storage {
    pub async fn save_ai_config(&self, config: &AiConfig) -> Result<(), String> {
        let (sanitized, secrets) = split_ai_config_secrets(config)?;
        let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
        let secrets_json = serde_json::to_string(&secrets).map_err(|e| e.to_string())?;
        let codec = self.secret_codec_for_write(secrets.as_object().is_some_and(|object| !object.is_empty())).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("INSERT OR REPLACE INTO ai_config (id, config_json) VALUES (1, ?1)", [json])
                .map_err(|e| e.to_string())?;
            let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}legacy");
            if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                persist_secret_in_tx(&tx, &codec, &namespace, CONFIG_SECRET_BLOB_KEY, &secrets_json)?;
            } else {
                tx.execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                    params![namespace, CONFIG_SECRET_BLOB_KEY],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_ai_config(&self) -> Result<Option<AiConfig>, String> {
        let json: Option<String> = self
            .with_conn(|conn| {
                conn.query_row("SELECT config_json FROM ai_config WHERE id = 1", [], |row| row.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            })
            .await?;
        let Some(json) = json else {
            return Ok(None);
        };
        let mut config: AiConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}legacy");
        if let Some(blob) = self.get_secret(&namespace, CONFIG_SECRET_BLOB_KEY).await? {
            merge_ai_config_secrets(&mut config, &blob)?;
        } else {
            let (_sanitized, secrets) = split_ai_config_secrets(&config)?;
            if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                self.set_secret(
                    &namespace,
                    CONFIG_SECRET_BLOB_KEY,
                    &serde_json::to_string(&secrets).map_err(|e| e.to_string())?,
                )
                .await?;
            }
        }
        Ok(Some(config))
    }

    pub async fn save_ai_provider_config(&self, provider: &str, config: &AiConfig) -> Result<(), String> {
        let parsed_provider = ai_provider_from_key(provider)?;
        let (mut config, secrets) = split_ai_config_secrets(config)?;
        let config_provider = ai_provider_key(&config.provider);
        if config_provider != provider {
            warn!(
                "save_ai_provider_config: config.provider ({}) does not match provider key ({}), normalizing",
                config_provider, provider
            );
            config.provider = parsed_provider;
        }
        let provider = provider.to_string();
        let secret_provider = provider.clone();
        let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        let secrets_json = serde_json::to_string(&secrets).map_err(|e| e.to_string())?;
        let codec = self.secret_codec_for_write(secrets.as_object().is_some_and(|object| !object.is_empty())).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO ai_provider_configs (provider, config_json) VALUES (?1, ?2)",
                params![provider, json],
            )
            .map_err(|e| e.to_string())?;
            let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}provider.{secret_provider}");
            if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                persist_secret_in_tx(&tx, &codec, &namespace, CONFIG_SECRET_BLOB_KEY, &secrets_json)?;
            } else {
                tx.execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                    params![namespace, CONFIG_SECRET_BLOB_KEY],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_ai_provider_configs(&self) -> Result<HashMap<String, AiConfig>, String> {
        let mut map = self.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT provider, config_json FROM ai_provider_configs")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut map = HashMap::new();
            for row in rows {
                let (provider, json) = row.map_err(|e| e.to_string())?;
                match serde_json::from_str::<AiConfig>(&json) {
                    Ok(mut config) => {
                        if let Ok(parsed_provider) = ai_provider_from_key(&provider) {
                            let config_provider = ai_provider_key(&config.provider);
                            if config_provider != provider {
                                warn!(
                                    "load_ai_provider_configs: stored config.provider ({}) does not match provider key ({}), normalizing",
                                    config_provider, provider
                                );
                                config.provider = parsed_provider;
                            }
                            map.insert(provider, config);
                        }
                    }
                    Err(e) => {
                        warn!("Failed to deserialize AI config for provider '{}': {}", provider, e);
                    }
                }
            }
            Ok(map)
        })
        .await?;
        for (provider, config) in &mut map {
            let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}provider.{provider}");
            if let Some(blob) = self.get_secret(&namespace, CONFIG_SECRET_BLOB_KEY).await? {
                merge_ai_config_secrets(config, &blob)?;
            } else {
                let (_sanitized, secrets) = split_ai_config_secrets(config)?;
                if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                    self.set_secret(
                        &namespace,
                        CONFIG_SECRET_BLOB_KEY,
                        &serde_json::to_string(&secrets).map_err(|e| e.to_string())?,
                    )
                    .await?;
                }
            }
        }
        Ok(map)
    }

    pub async fn save_ai_configs(&self, configs: &[AiConfigItem]) -> Result<(), String> {
        let mut sanitized_configs = Vec::with_capacity(configs.len());
        let mut secret_blobs = Vec::with_capacity(configs.len());
        for item in configs {
            let (config, secrets) = split_ai_config_secrets(&item.config)?;
            sanitized_configs.push(AiConfigItem { config, ..item.clone() });
            secret_blobs.push((item.id.clone(), secrets));
        }
        let needs_key =
            secret_blobs.iter().any(|(_, secrets)| secrets.as_object().is_some_and(|object| !object.is_empty()));
        let codec = self.secret_codec_for_write(needs_key).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_configs", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM connection_secrets WHERE connection_id LIKE 'ai_config.%'", [])
                .map_err(|e| e.to_string())?;
            for config in &sanitized_configs {
                let json = serde_json::to_string(&config.config).map_err(|e| e.to_string())?;
                let models_json = serde_json::to_string(&config.config.models).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT OR REPLACE INTO ai_configs (id, name, model, models, config_json, is_default) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![config.id, config.name, config.config.model, models_json, json, config.is_default as i32],
                )
                .map_err(|e| e.to_string())?;
            }
            // Clear old single-config tables — migration is complete, avoids re-migration on empty ai_configs
            tx.execute("DELETE FROM ai_config", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_provider_configs", []).map_err(|e| e.to_string())?;
            for (id, secrets) in &secret_blobs {
                if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                    let blob = serde_json::to_string(secrets).map_err(|e| e.to_string())?;
                    persist_secret_in_tx(&tx, &codec, &format!("{AI_SECRET_NAMESPACE_PREFIX}{id}"), CONFIG_SECRET_BLOB_KEY, &blob)?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn load_ai_configs(&self) -> Result<Vec<AiConfigItem>, String> {
        let mut configs = self
            .with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT id, name, model, models, config_json, is_default FROM ai_configs")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, bool>(5)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?;
                let mut configs = Vec::new();
                for row in rows {
                    let (id, name, model_col, models_json_col, json, is_default_col) =
                        row.map_err(|e| e.to_string())?;
                    match serde_json::from_str::<AiConfig>(&json) {
                        Ok(mut config) => {
                            // 优先使用列值，如果列值为空则从 config_json 回退读取
                            if model_col.is_empty() {
                                // config.model 已经从 json 解析出来了
                            } else {
                                config.model = model_col;
                            }
                            if models_json_col.is_empty() || models_json_col == "[]" {
                                // config.models 已经从 json 解析出来了
                            } else {
                                config.models = serde_json::from_str(&models_json_col).unwrap_or_default();
                            }
                            let is_default = is_default_col;
                            configs.push(AiConfigItem { id, name, is_default, config });
                        }
                        Err(e) => {
                            warn!("Failed to deserialize AI config item '{}': {}", id, e);
                        }
                    }
                }
                Ok(configs)
            })
            .await?;
        for item in &mut configs {
            let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}{}", item.id);
            if let Some(blob) = self.get_secret(&namespace, CONFIG_SECRET_BLOB_KEY).await? {
                merge_ai_config_secrets(&mut item.config, &blob)?;
            } else {
                // Existing databases kept these fields inside config_json.
                // Hydrate first, then opportunistically move them into the
                // encrypted store on the next save.
                let (_sanitized, secrets) = split_ai_config_secrets(&item.config)?;
                if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                    self.set_secret(
                        &namespace,
                        CONFIG_SECRET_BLOB_KEY,
                        &serde_json::to_string(&secrets).map_err(|e| e.to_string())?,
                    )
                    .await?;
                }
            }
        }
        Ok(configs)
    }

    pub async fn set_default_ai_config(&self, config_id: &str) -> Result<(), String> {
        let config_id = config_id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("UPDATE ai_configs SET is_default = 0 WHERE is_default = 1", []).map_err(|e| e.to_string())?;
            tx.execute("UPDATE ai_configs SET is_default = 1 WHERE id = ?1", params![config_id])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn save_ai_config_item(&self, config: &AiConfigItem) -> Result<(), String> {
        let (sanitized_config, secrets) = split_ai_config_secrets(&config.config)?;
        let config = AiConfigItem { config: sanitized_config, ..config.clone() };
        let secret_id = config.id.clone();
        let codec = self.secret_codec_for_write(secrets.as_object().is_some_and(|object| !object.is_empty())).await?;
        self.with_conn(move |conn| {
            let json = serde_json::to_string(&config.config).map_err(|e| e.to_string())?;
            let models_json = serde_json::to_string(&config.config.models).map_err(|e| e.to_string())?;
            let secrets_json = serde_json::to_string(&secrets).map_err(|e| e.to_string())?;
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;

            // 如果设该配置为默认，先清除其他默认，避免与 idx_ai_configs_default 冲突
            if config.is_default {
                tx.execute(
                    "UPDATE ai_configs SET is_default = 0 WHERE is_default = 1 AND id != ?1",
                    params![config.id],
                )
                .map_err(|e| e.to_string())?;
            }

            tx.execute(
                "INSERT INTO ai_configs (id, name, model, models, config_json, is_default)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, model = excluded.model,
                 models = excluded.models, config_json = excluded.config_json, is_default = excluded.is_default",
                params![config.id, config.name, config.config.model, models_json, json, config.is_default as i32],
            )
            .map_err(|e| {
                let msg = e.to_string();
                // SQLite UNIQUE constraint error contains the table and column name
                if msg.contains("UNIQUE constraint failed") && msg.contains("ai_configs.name") {
                    format!("ai.configNameExists:{}", config.name)
                } else {
                    msg
                }
            })?;

            let namespace = format!("{AI_SECRET_NAMESPACE_PREFIX}{secret_id}");
            if secrets.as_object().is_some_and(|object| !object.is_empty()) {
                persist_secret_in_tx(&tx, &codec, &namespace, CONFIG_SECRET_BLOB_KEY, &secrets_json)?;
            } else {
                tx.execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                    params![namespace, CONFIG_SECRET_BLOB_KEY],
                )
                .map_err(|e| e.to_string())?;
            }

            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn delete_ai_config(&self, config_id: &str) -> Result<(), String> {
        let config_id = config_id.to_string();
        let delete_id = config_id.clone();
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_configs WHERE id = ?1", params![config_id]).map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                params![format!("{AI_SECRET_NAMESPACE_PREFIX}{delete_id}"), CONFIG_SECRET_BLOB_KEY],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }
}

// Tunnel profiles — shared transport-layer configurations managed in
// Settings and referenced from connections via `profile_id`. Public profile
// metadata is stored in `config_json`; credentials are kept in the encrypted
// Secret Store and hydrated only when a profile is loaded.

impl Storage {
    pub async fn load_tunnel_profiles(&self) -> Result<Vec<TransportLayerConfig>, String> {
        let rows: Vec<String> = self
            .with_conn(|conn| {
                let mut stmt = conn
                    .prepare("SELECT config_json FROM tunnel_profiles ORDER BY rowid")
                    .map_err(|e| e.to_string())?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
            })
            .await?;

        let mut profiles = Vec::new();
        for json in rows {
            match serde_json::from_str::<TransportLayerConfig>(&json) {
                Ok(profile) => profiles.push(profile),
                Err(e) => warn!("Failed to deserialize tunnel profile: {}", e),
            }
        }
        for profile in &mut profiles {
            let namespace = format!("{TUNNEL_SECRET_NAMESPACE_PREFIX}{}", profile.id());
            if let Some(blob) = self.get_secret(&namespace, CONFIG_SECRET_BLOB_KEY).await? {
                let stored: TransportLayerConfig = serde_json::from_str(&blob).map_err(|e| e.to_string())?;
                merge_missing_tunnel_profile_secrets(profile, &stored);
            } else {
                // Migrate legacy inline tunnel credentials on first read.
                let mut scrubbed = profile.clone();
                scrubbed.scrub_secrets();
                if serde_json::to_value(&scrubbed).map_err(|e| e.to_string())?
                    != serde_json::to_value(&*profile).map_err(|e| e.to_string())?
                {
                    self.set_secret(
                        &namespace,
                        CONFIG_SECRET_BLOB_KEY,
                        &serde_json::to_string(&*profile).map_err(|e| e.to_string())?,
                    )
                    .await?;
                }
            }
        }
        Ok(profiles)
    }

    pub async fn save_tunnel_profiles(&self, profiles: &[TransportLayerConfig]) -> Result<(), String> {
        for profile in profiles {
            if profile.id().trim().is_empty() {
                return Err("Tunnel profile id must not be empty".to_string());
            }
        }
        let mut sanitized_profiles = Vec::with_capacity(profiles.len());
        let mut secret_blobs = Vec::with_capacity(profiles.len());
        for profile in profiles {
            let mut sanitized = profile.clone();
            sanitized.scrub_secrets();
            sanitized_profiles.push(sanitized);
            secret_blobs.push((profile.id().to_string(), profile.clone()));
        }
        let needs_key =
            sanitized_profiles.iter().zip(&secret_blobs).any(|(sanitized, (_, profile))| sanitized != profile);
        let codec = self.secret_codec_for_write(needs_key).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM tunnel_profiles", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM connection_secrets WHERE connection_id LIKE 'tunnel_profile.%'", [])
                .map_err(|e| e.to_string())?;
            for profile in &sanitized_profiles {
                let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO tunnel_profiles (id, config_json) VALUES (?1, ?2)",
                    params![profile.id(), json],
                )
                .map_err(|e| e.to_string())?;
            }
            for (id, profile) in &secret_blobs {
                let mut scrubbed = profile.clone();
                scrubbed.scrub_secrets();
                if scrubbed != *profile {
                    let blob = serde_json::to_string(profile).map_err(|e| e.to_string())?;
                    persist_secret_in_tx(
                        &tx,
                        &codec,
                        &format!("{TUNNEL_SECRET_NAMESPACE_PREFIX}{id}"),
                        CONFIG_SECRET_BLOB_KEY,
                        &blob,
                    )?;
                }
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    /// Replaces the profile catalog while keeping the secrets already stored
    /// for a profile when the incoming copy has them scrubbed. Used when
    /// applying sync snapshots, whose plain (non-encrypted) part strips
    /// tunnel secrets.
    pub async fn save_tunnel_profiles_preserving_secrets(
        &self,
        profiles: &[TransportLayerConfig],
    ) -> Result<(), String> {
        let existing: HashMap<String, TransportLayerConfig> =
            self.load_tunnel_profiles().await?.into_iter().map(|p| (p.id().to_string(), p)).collect();
        let merged: Vec<TransportLayerConfig> = profiles
            .iter()
            .map(|profile| {
                let mut profile = profile.clone();
                if let Some(previous) = existing.get(profile.id()) {
                    merge_missing_tunnel_profile_secrets(&mut profile, previous);
                }
                profile
            })
            .collect();
        self.save_tunnel_profiles(&merged).await
    }
}

fn merge_missing_tunnel_profile_secrets(profile: &mut TransportLayerConfig, previous: &TransportLayerConfig) {
    match (profile, previous) {
        (TransportLayerConfig::Ssh(current), TransportLayerConfig::Ssh(previous)) => {
            if current.password.is_empty() {
                current.password = previous.password.clone();
            }
            if current.key_passphrase.is_empty() {
                current.key_passphrase = previous.key_passphrase.clone();
            }
        }
        (TransportLayerConfig::Proxy(current), TransportLayerConfig::Proxy(previous)) => {
            if current.password.is_empty() {
                current.password = previous.password.clone();
            }
        }
        (TransportLayerConfig::HttpTunnel(current), TransportLayerConfig::HttpTunnel(previous))
            if current.token.is_empty() =>
        {
            current.token = previous.token.clone();
        }
        _ => {}
    }
}

fn split_ai_config_secrets(config: &AiConfig) -> Result<(AiConfig, serde_json::Value), String> {
    let mut value = serde_json::to_value(config).map_err(|e| e.to_string())?;
    let Some(object) = value.as_object_mut() else {
        return Err("AI config must serialize to an object".to_string());
    };
    let mut secrets = serde_json::Map::new();
    for field in [
        "apiKey",
        "customHeaders",
        "proxyUrl",
        "codexCliEnv",
        "claudeCodeCliEnv",
        "piAgentCliEnv",
        "opencodeCliEnv",
        "cursorCliEnv",
        "grokCliEnv",
        "codebuddyCliEnv",
        "qoderCliEnv",
    ] {
        if let Some(value) = object.remove(field) {
            let keep = match &value {
                serde_json::Value::String(value) => !value.is_empty(),
                serde_json::Value::Object(value) => !value.is_empty(),
                _ => !value.is_null(),
            };
            if keep {
                secrets.insert(field.to_string(), value);
            }
        }
    }
    let sanitized = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok((sanitized, serde_json::Value::Object(secrets)))
}

fn count_ai_secret_rows(conn: &Connection) -> Result<i64, String> {
    let mut count = 0;
    for (table, query) in [
        ("ai_configs", "SELECT id, config_json FROM ai_configs"),
        ("ai_config", "SELECT id, config_json FROM ai_config"),
        ("ai_provider_configs", "SELECT provider, config_json FROM ai_provider_configs"),
    ] {
        let mut statement = conn.prepare(query).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, rusqlite::types::Value>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, json) = row.map_err(|e| e.to_string())?;
            let id = format!("{id:?}");
            let config: AiConfig = serde_json::from_str(&json).map_err(|e| format!("invalid {table} row {id}: {e}"))?;
            let (_, secrets) = split_ai_config_secrets(&config)?;
            if secrets.as_object().is_some_and(|value| !value.is_empty()) {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn count_tunnel_secret_rows(conn: &Connection) -> Result<i64, String> {
    let mut statement = conn.prepare("SELECT id, config_json FROM tunnel_profiles").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    for row in rows {
        let (id, json) = row.map_err(|e| e.to_string())?;
        let profile: TransportLayerConfig =
            serde_json::from_str(&json).map_err(|e| format!("invalid tunnel profile {id}: {e}"))?;
        let mut scrubbed = profile.clone();
        scrubbed.scrub_secrets();
        if scrubbed != profile {
            count += 1;
        }
    }
    Ok(count)
}

fn merge_ai_config_secrets(config: &mut AiConfig, blob: &str) -> Result<(), String> {
    let secret_value: serde_json::Value = serde_json::from_str(blob).map_err(|e| e.to_string())?;
    let mut value = serde_json::to_value(&*config).map_err(|e| e.to_string())?;
    let Some(target) = value.as_object_mut() else {
        return Err("AI config must serialize to an object".to_string());
    };
    let Some(source) = secret_value.as_object() else {
        return Err("AI secret payload must be an object".to_string());
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
    *config = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(())
}

// App Settings

impl Storage {
    async fn load_app_settings_json(&self) -> Result<serde_json::Map<String, serde_json::Value>, String> {
        let json: Option<String> = self
            .with_conn(|conn| {
                conn.query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            })
            .await?;
        let Some(json) = json else {
            return Ok(serde_json::Map::new());
        };
        match serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())? {
            serde_json::Value::Object(map) => Ok(map),
            _ => Err("app settings JSON must be an object".to_string()),
        }
    }

    async fn save_app_settings_json(
        &self,
        settings: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let mut settings = settings.clone();
        self.with_conn(move |conn| {
            // Dedicated writers are the only owners of these keys. Keep their
            // latest values across overlapping legacy settings saves.
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let dedicated_keys = [
                MCP_GLOBAL_POLICY_KEY,
                WEB_MCP_SETTINGS_KEY,
                MAX_RETRIES_KEY,
                SQL_FILE_UPLOAD_MAX_MB_KEY,
                HISTORY_RETENTION_LIMIT_KEY,
                AI_PLUGIN_TOOL_PLUGINS_KEY,
                PLUGIN_DATA_GRANTS_KEY,
            ];
            for key in dedicated_keys {
                settings.remove(key);
            }
            if let Some(current) = current {
                let current = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&current)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?;
                for key in dedicated_keys {
                    if let Some(value) = current.get(key) {
                        settings.insert(key.to_string(), value.clone());
                    }
                }
            }
            let json = serde_json::Value::Object(settings).to_string();
            conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_password_hash(&self, hash: &str) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        settings.insert("password_hash".to_string(), serde_json::Value::String(hash.to_string()));
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_password_hash(&self) -> Result<Option<String>, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings.get("password_hash").and_then(|v| v.as_str()).map(|s| s.to_string()))
    }

    pub async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicyState, String> {
        let result = self
            .with_conn(|conn| {
                let json: Option<String> = conn
                    .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                    .optional()
                    .map_err(|e| e.to_string())?;
                let Some(json) = json else {
                    let policy = McpGlobalPolicy::default();
                    return Ok(McpGlobalPolicyState {
                        configured: false,
                        read_only: policy.read_only,
                        allow_dangerous_sql: policy.allow_dangerous_sql,
                        allowed_connection_ids: policy.allowed_connection_ids,
                        allowed_group_ids: policy.allowed_group_ids,
                        allowed_tool_names: policy.allowed_tool_names,
                        connection_policies: policy.connection_policies,
                        group_policies: policy.group_policies,
                        query_timeout_secs: policy.query_timeout_secs,
                    });
                };
                let settings = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?;
                let Some(value) = settings.get(MCP_GLOBAL_POLICY_KEY) else {
                    let policy = McpGlobalPolicy::default();
                    return Ok(McpGlobalPolicyState {
                        configured: false,
                        read_only: policy.read_only,
                        allow_dangerous_sql: policy.allow_dangerous_sql,
                        allowed_connection_ids: policy.allowed_connection_ids,
                        allowed_group_ids: policy.allowed_group_ids,
                        allowed_tool_names: policy.allowed_tool_names,
                        connection_policies: policy.connection_policies,
                        group_policies: policy.group_policies,
                        query_timeout_secs: policy.query_timeout_secs,
                    });
                };
                let policy = serde_json::from_value::<McpGlobalPolicy>(value.clone())
                    .map_err(|e| format!("invalid MCP policy: {e}"))?
                    .normalized();
                Ok(McpGlobalPolicyState {
                    configured: true,
                    read_only: policy.read_only,
                    allow_dangerous_sql: policy.allow_dangerous_sql,
                    allowed_connection_ids: policy.allowed_connection_ids,
                    allowed_group_ids: policy.allowed_group_ids,
                    allowed_tool_names: policy.allowed_tool_names,
                    connection_policies: policy.connection_policies,
                    group_policies: policy.group_policies,
                    query_timeout_secs: policy.query_timeout_secs,
                })
            })
            .await;
        result.map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))
    }

    pub async fn save_mcp_global_policy(&self, policy: &McpGlobalPolicy) -> Result<(), String> {
        let policy = serde_json::to_value(policy.normalized()).map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
        self.with_conn(move |conn| {
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let mut settings = match current {
                Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?,
                None => serde_json::Map::new(),
            };
            settings.insert(MCP_GLOBAL_POLICY_KEY.to_string(), policy);
            let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
            conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))
    }

    /// Plugin ids whose MCP tools the built-in AI agent may call. Empty until
    /// the user enables a plugin in the Plugin Center.
    pub async fn load_ai_plugin_tool_plugin_ids(&self) -> Result<Vec<String>, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(normalized_string_list(settings.get(AI_PLUGIN_TOOL_PLUGINS_KEY)))
    }

    /// Enables or disables built-in AI access to one plugin's tools and returns
    /// the updated list. The read-modify-write runs inside one connection
    /// closure so concurrent settings saves cannot drop the change.
    pub async fn set_ai_plugin_tool_plugin_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Vec<String>, String> {
        let plugin_id = normalized_setting_id(plugin_id, "plugin id")?;
        self.with_conn(move |conn| {
            let mut settings = app_settings_map_from_conn(conn)?;
            let mut plugin_ids = normalized_string_list(settings.get(AI_PLUGIN_TOOL_PLUGINS_KEY));
            plugin_ids.retain(|candidate| candidate != &plugin_id);
            if enabled {
                plugin_ids.push(plugin_id);
                plugin_ids.sort();
            }
            settings.insert(AI_PLUGIN_TOOL_PLUGINS_KEY.to_string(), serde_json::json!(plugin_ids));
            write_app_settings_map(conn, &settings)?;
            Ok(plugin_ids)
        })
        .await
    }

    /// Connections the plugin may read through `host.data:read`.
    pub async fn load_plugin_data_grants(&self, plugin_id: &str) -> Result<Vec<String>, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(normalized_string_list(settings.get(PLUGIN_DATA_GRANTS_KEY).and_then(|grants| grants.get(plugin_id.trim()))))
    }

    /// Records or revokes the user's consent for one plugin to read one
    /// connection and returns the plugin's updated grant list.
    pub async fn set_plugin_data_grant(
        &self,
        plugin_id: &str,
        connection_id: &str,
        granted: bool,
    ) -> Result<Vec<String>, String> {
        let plugin_id = normalized_setting_id(plugin_id, "plugin id")?;
        let connection_id = normalized_setting_id(connection_id, "connection id")?;
        self.with_conn(move |conn| {
            let mut settings = app_settings_map_from_conn(conn)?;
            let mut all_grants = match settings.remove(PLUGIN_DATA_GRANTS_KEY) {
                Some(serde_json::Value::Object(grants)) => grants,
                _ => serde_json::Map::new(),
            };
            let mut connection_ids = normalized_string_list(all_grants.get(&plugin_id));
            connection_ids.retain(|candidate| candidate != &connection_id);
            if granted {
                if connection_ids.len() >= MAX_PLUGIN_DATA_GRANTS_PER_PLUGIN {
                    return Err(format!(
                        "A plugin can hold at most {MAX_PLUGIN_DATA_GRANTS_PER_PLUGIN} data access grants"
                    ));
                }
                connection_ids.push(connection_id);
                connection_ids.sort();
            }
            if connection_ids.is_empty() {
                all_grants.remove(&plugin_id);
            } else {
                all_grants.insert(plugin_id, serde_json::json!(connection_ids));
            }
            if !all_grants.is_empty() {
                settings.insert(PLUGIN_DATA_GRANTS_KEY.to_string(), serde_json::Value::Object(all_grants));
            }
            write_app_settings_map(conn, &settings)?;
            Ok(connection_ids)
        })
        .await
    }

    /// Drops everything the user granted to a plugin (AI tool access and data
    /// grants). Called after uninstall so a reinstall starts without consent.
    pub async fn forget_plugin_permissions(&self, plugin_id: &str) -> Result<(), String> {
        let plugin_id = normalized_setting_id(plugin_id, "plugin id")?;
        self.with_conn(move |conn| {
            let mut settings = app_settings_map_from_conn(conn)?;
            let mut plugin_ids = normalized_string_list(settings.get(AI_PLUGIN_TOOL_PLUGINS_KEY));
            plugin_ids.retain(|candidate| candidate != &plugin_id);
            settings.insert(AI_PLUGIN_TOOL_PLUGINS_KEY.to_string(), serde_json::json!(plugin_ids));
            if let Some(serde_json::Value::Object(grants)) = settings.get_mut(PLUGIN_DATA_GRANTS_KEY) {
                grants.remove(&plugin_id);
            }
            write_app_settings_map(conn, &settings)
        })
        .await
    }

    pub async fn load_mcp_http_server_settings(&self) -> Result<McpHttpServerSettings, String> {
        let settings = self.load_app_settings_json().await?;
        match settings.get(MCP_HTTP_SERVER_SETTINGS_KEY) {
            Some(value) => serde_json::from_value(value.clone())
                .map_err(|error| format!("invalid MCP HTTP server settings: {error}")),
            None => Ok(McpHttpServerSettings::default()),
        }
    }

    pub async fn save_mcp_http_server_settings(&self, settings: &McpHttpServerSettings) -> Result<(), String> {
        let mut app_settings = self.load_app_settings_json().await?;
        let value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
        app_settings.insert(MCP_HTTP_SERVER_SETTINGS_KEY.to_string(), value);
        self.save_app_settings_json(&app_settings).await
    }

    pub async fn load_web_mcp_settings(&self) -> Result<WebMcpSettings, String> {
        let settings = self.load_app_settings_json().await?;
        match settings.get(WEB_MCP_SETTINGS_KEY) {
            Some(value) => {
                serde_json::from_value(value.clone()).map_err(|error| format!("invalid Web MCP settings: {error}"))
            }
            None => Ok(WebMcpSettings::default()),
        }
    }

    pub async fn save_web_mcp_credentials(&self, settings: &WebMcpSettings, token: Option<&str>) -> Result<(), String> {
        let token = token.unwrap_or_default().to_string();
        let codec = self.secret_codec_for_write(!token.is_empty()).await?;
        let value = serde_json::to_value(settings).map_err(|error| error.to_string())?;
        self.with_conn(move |conn| {
            let tx =
                conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            let mut app_settings = app_settings_map_from_conn(&tx)?;
            app_settings.insert(WEB_MCP_SETTINGS_KEY.to_string(), value);
            persist_secret_in_tx(&tx, &codec, GLOBAL_SECRET_NAMESPACE, "web_mcp_token", &token)?;
            write_app_settings_map(&tx, &app_settings)?;
            tx.commit().map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn save_desktop_settings(&self, desktop_settings: &DesktopSettings) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        settings.remove("run_in_background");
        settings.insert("show_tray_icon".to_string(), serde_json::Value::Bool(desktop_settings.show_tray_icon));
        settings.insert(
            "icon_theme".to_string(),
            serde_json::to_value(desktop_settings.icon_theme).map_err(|e| e.to_string())?,
        );
        settings.insert("quit_on_close".to_string(), serde_json::Value::Bool(desktop_settings.quit_on_close));
        settings.insert(
            "close_action_prompted".to_string(),
            serde_json::Value::Bool(desktop_settings.close_action_prompted),
        );
        settings.insert(
            "debug_logging_enabled".to_string(),
            serde_json::Value::Bool(desktop_settings.debug_logging_enabled),
        );
        settings.insert(
            "metadata_cache_max_memory_mb".to_string(),
            serde_json::Value::Number(serde_json::Number::from(normalize_metadata_cache_max_memory_mb(
                desktop_settings.metadata_cache_max_memory_mb,
            ))),
        );
        settings.insert(
            "duckdb_worker_process_isolation".to_string(),
            serde_json::Value::Bool(desktop_settings.duckdb_worker_process_isolation),
        );
        settings.insert(
            "duckdb_worker_max_processes".to_string(),
            serde_json::Value::Number(serde_json::Number::from(normalize_duckdb_worker_max_processes(
                desktop_settings.duckdb_worker_max_processes,
            ))),
        );
        match desktop_settings.saved_sql_sync_dir.as_ref().filter(|path| !path.trim().is_empty()) {
            Some(path) => {
                settings.insert("saved_sql_sync_dir".to_string(), serde_json::Value::String(path.clone()));
            }
            None => {
                settings.remove("saved_sql_sync_dir");
            }
        }
        match desktop_settings.driver_store_dir.as_ref().filter(|path| !path.trim().is_empty()) {
            Some(path) => {
                settings.insert("driver_store_dir".to_string(), serde_json::Value::String(path.clone()));
            }
            None => {
                settings.remove("driver_store_dir");
            }
        }
        match desktop_settings.plugin_store_dir.as_ref().filter(|path| !path.trim().is_empty()) {
            Some(path) => {
                settings.insert("plugin_store_dir".to_string(), serde_json::Value::String(path.clone()));
            }
            None => {
                settings.remove("plugin_store_dir");
            }
        }
        match desktop_settings.agent_store_dir.as_ref().filter(|path| !path.trim().is_empty()) {
            Some(path) => {
                settings.insert("agent_store_dir".to_string(), serde_json::Value::String(path.clone()));
            }
            None => {
                settings.remove("agent_store_dir");
            }
        }
        settings.insert(
            "custom_ai_skill_root_enabled".to_string(),
            serde_json::Value::Bool(desktop_settings.custom_ai_skill_root_enabled),
        );
        match desktop_settings.custom_ai_skill_root.as_ref().filter(|path| !path.trim().is_empty()) {
            Some(path) => {
                settings.insert("custom_ai_skill_root".to_string(), serde_json::Value::String(path.clone()));
            }
            None => {
                settings.remove("custom_ai_skill_root");
            }
        }
        settings.insert(
            "sidebar_table_page_size".to_string(),
            serde_json::Value::Number(serde_json::Number::from(desktop_settings.sidebar_table_page_size)),
        );
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_desktop_settings(&self) -> Result<DesktopSettings, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(DesktopSettings {
            show_tray_icon: settings
                .get("show_tray_icon")
                .and_then(|value| value.as_bool())
                .or_else(|| settings.get("run_in_background").and_then(|value| value.as_bool()))
                .unwrap_or_else(|| DesktopSettings::default().show_tray_icon),
            icon_theme: DesktopIconTheme::from_settings_value(settings.get("icon_theme")),
            quit_on_close: settings
                .get("quit_on_close")
                .and_then(|value| value.as_bool())
                .unwrap_or_else(|| DesktopSettings::default().quit_on_close),
            close_action_prompted: settings
                .get("close_action_prompted")
                .and_then(|value| value.as_bool())
                .unwrap_or_else(|| DesktopSettings::default().close_action_prompted),
            debug_logging_enabled: settings
                .get("debug_logging_enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or_else(|| DesktopSettings::default().debug_logging_enabled),
            metadata_cache_max_memory_mb: settings
                .get("metadata_cache_max_memory_mb")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .map(normalize_metadata_cache_max_memory_mb)
                .unwrap_or_else(|| DesktopSettings::default().metadata_cache_max_memory_mb),
            duckdb_worker_process_isolation: settings
                .get("duckdb_worker_process_isolation")
                .and_then(|value| value.as_bool())
                .unwrap_or_else(|| DesktopSettings::default().duckdb_worker_process_isolation),
            duckdb_worker_max_processes: settings
                .get("duckdb_worker_max_processes")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .map(normalize_duckdb_worker_max_processes)
                .unwrap_or_else(|| DesktopSettings::default().duckdb_worker_max_processes),
            saved_sql_sync_dir: settings
                .get("saved_sql_sync_dir")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            driver_store_dir: settings
                .get("driver_store_dir")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            plugin_store_dir: settings
                .get("plugin_store_dir")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            agent_store_dir: settings
                .get("agent_store_dir")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            custom_ai_skill_root_enabled: settings
                .get("custom_ai_skill_root_enabled")
                .and_then(|value| value.as_bool())
                .unwrap_or_else(|| DesktopSettings::default().custom_ai_skill_root_enabled),
            custom_ai_skill_root: settings
                .get("custom_ai_skill_root")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string),
            sidebar_table_page_size: settings
                .get("sidebar_table_page_size")
                .and_then(|value| value.as_u64())
                .map(|value| value as usize)
                .unwrap_or_else(|| DesktopSettings::default().sidebar_table_page_size),
        })
    }

    pub async fn save_pinned_tree_node_ids(&self, ids: &[String]) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        let values = ids.iter().map(|id| serde_json::Value::String(id.clone())).collect::<Vec<_>>();
        settings.insert("pinned_tree_node_ids".to_string(), serde_json::Value::Array(values));
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_pinned_tree_node_ids(&self) -> Result<Vec<String>, String> {
        let settings = self.load_app_settings_json().await?;
        let Some(value) = settings.get("pinned_tree_node_ids") else {
            return Ok(Vec::new());
        };
        let Some(array) = value.as_array() else {
            return Ok(Vec::new());
        };
        Ok(array.iter().filter_map(|item| item.as_str().map(|value| value.to_string())).collect())
    }

    async fn save_app_state_value(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        let key = key.to_string();
        let value_json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute("INSERT OR REPLACE INTO app_state (key, value_json) VALUES (?1, ?2)", params![key, value_json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }

    async fn load_app_state_value(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let key = key.to_string();
        let json: Option<String> = self
            .with_conn(move |conn| {
                conn.query_row("SELECT value_json FROM app_state WHERE key = ?1", [key], |row| row.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            })
            .await?;
        json.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string())).transpose()
    }

    pub async fn save_editor_settings(&self, settings: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(APP_STATE_EDITOR_SETTINGS_KEY, settings).await
    }

    pub async fn load_editor_settings(&self) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(APP_STATE_EDITOR_SETTINGS_KEY).await
    }

    pub async fn save_open_tabs_state(&self, state: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(APP_STATE_OPEN_TABS_KEY, state).await
    }

    pub async fn load_open_tabs_state(&self) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(APP_STATE_OPEN_TABS_KEY).await
    }

    /// Persist open tabs under an isolated state key while sharing the rest of the database.
    ///
    /// Desktop development builds use this to avoid overwriting the installed app's
    /// in-progress SQL when both instances use the same data directory.
    pub async fn save_open_tabs_state_with_key(&self, key: &str, state: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(key, state).await
    }

    /// Load open tabs from an isolated state key.
    pub async fn load_open_tabs_state_with_key(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(key).await
    }

    pub async fn save_saved_sql_editor_positions(&self, positions: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY, positions).await
    }

    pub async fn load_saved_sql_editor_positions(&self) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY).await
    }

    /// Persist the saved data-transfer task library (folders + task configs) as
    /// one JSON document, mirroring the editor-settings app-state pattern.
    pub async fn save_transfer_task_library(&self, library: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(APP_STATE_TRANSFER_TASK_LIBRARY_KEY, library).await
    }

    pub async fn load_transfer_task_library(&self) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(APP_STATE_TRANSFER_TASK_LIBRARY_KEY).await
    }

    pub async fn save_ai_global_custom_instructions(&self, content: &str) -> Result<(), String> {
        let trimmed = content.trim();
        if trimmed.chars().count() > 8000 {
            return Err("global instructions too long (max 8000 chars)".to_string());
        }
        self.save_app_state_value(APP_STATE_AI_GLOBAL_INSTRUCTIONS_KEY, &serde_json::Value::String(trimmed.to_string()))
            .await
    }

    pub async fn load_ai_global_custom_instructions(&self) -> Result<String, String> {
        let value = self.load_app_state_value(APP_STATE_AI_GLOBAL_INSTRUCTIONS_KEY).await?;
        Ok(match value {
            Some(serde_json::Value::String(s)) => s,
            None | Some(serde_json::Value::Null) => String::new(),
            other => other.map(|v| v.to_string()).unwrap_or_default(),
        })
    }

    pub async fn save_ai_chat_selection(&self, selection: &AiChatSelectionState) -> Result<(), String> {
        let value = serde_json::to_value(selection).map_err(|e| e.to_string())?;
        self.save_app_state_value(APP_STATE_AI_CHAT_SELECTION_KEY, &value).await
    }

    pub async fn load_ai_chat_selection(&self) -> Result<Option<AiChatSelectionState>, String> {
        self.load_app_state_value(APP_STATE_AI_CHAT_SELECTION_KEY)
            .await?
            .map(|value| serde_json::from_value(value).map_err(|e| e.to_string()))
            .transpose()
    }

    pub async fn load_or_create_local_device_secret(&self) -> Result<String, String> {
        let mut settings = self.load_app_settings_json().await?;
        if let Some(secret) = self.get_secret(GLOBAL_SECRET_NAMESPACE, "local_device_secret").await? {
            return Ok(secret);
        }
        if let Some(secret) = settings.get("local_device_secret").and_then(|value| value.as_str()).map(str::to_string) {
            if !secret.is_empty() {
                self.set_secret(GLOBAL_SECRET_NAMESPACE, "local_device_secret", &secret).await?;
                settings.remove("local_device_secret");
                self.save_app_settings_json(&settings).await?;
                return Ok(secret);
            }
        }
        let secret = Uuid::new_v4().to_string();
        self.set_secret(GLOBAL_SECRET_NAMESPACE, "local_device_secret", &secret).await?;
        Ok(secret)
    }

    pub async fn save_webdav_password_blob(&self, account: &str, blob: &serde_json::Value) -> Result<(), String> {
        self.set_secret(
            GLOBAL_SECRET_NAMESPACE,
            &format!("webdav_password.{account}"),
            &serde_json::to_string(blob).map_err(|e| e.to_string())?,
        )
        .await
    }

    pub async fn load_webdav_password_blob(&self, account: &str) -> Result<Option<serde_json::Value>, String> {
        if let Some(blob) = self.get_secret(GLOBAL_SECRET_NAMESPACE, &format!("webdav_password.{account}")).await? {
            return serde_json::from_str(&blob).map(Some).map_err(|e| e.to_string());
        }
        let mut settings = self.load_app_settings_json().await?;
        let legacy = settings
            .get("webdav_passwords")
            .and_then(|value| value.as_object())
            .and_then(|credentials| credentials.get(account))
            .cloned();
        if let Some(blob) = &legacy {
            self.save_webdav_password_blob(account, blob).await?;
            if let Some(credentials) = settings.get_mut("webdav_passwords").and_then(|value| value.as_object_mut()) {
                credentials.remove(account);
            }
            self.save_app_settings_json(&settings).await?;
        }
        Ok(legacy)
    }

    /// List locally stored WebDAV/snippet credential account names so the
    /// sync transport can explicitly re-encrypt them for another device.
    pub async fn load_webdav_password_accounts(&self) -> Result<Vec<String>, String> {
        const PREFIX: &str = "webdav_password.";
        let mut accounts = self
            .with_conn(|conn| {
                let mut statement = conn
                    .prepare("SELECT key FROM connection_secrets WHERE connection_id = ?1 AND key LIKE ?2")
                    .map_err(|error| error.to_string())?;
                let rows = statement
                    .query_map(params![GLOBAL_SECRET_NAMESPACE, format!("{PREFIX}%")], |row| row.get::<_, String>(0))
                    .map_err(|error| error.to_string())?;
                let mut accounts = Vec::new();
                for row in rows {
                    let key = row.map_err(|error| error.to_string())?;
                    if let Some(account) = key.strip_prefix(PREFIX).filter(|account| !account.is_empty()) {
                        accounts.push(account.to_string());
                    }
                }
                accounts.sort();
                accounts.dedup();
                Ok(accounts)
            })
            .await?;

        // Upgrade legacy app-settings credentials even when the caller is
        // building a snapshot directly (without first making a WebDAV or
        // snippet request that would otherwise trigger lazy migration).
        let legacy_accounts = self
            .load_app_settings_json()
            .await?
            .get("webdav_passwords")
            .and_then(serde_json::Value::as_object)
            .map(|credentials| credentials.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for account in legacy_accounts {
            if self.load_webdav_password_blob(&account).await?.is_some() {
                accounts.push(account);
            }
        }
        accounts.sort();
        accounts.dedup();
        Ok(accounts)
    }

    pub async fn delete_webdav_password_blob(&self, account: &str) -> Result<(), String> {
        self.delete_secret(GLOBAL_SECRET_NAMESPACE, &format!("webdav_password.{account}")).await?;
        let mut settings = self.load_app_settings_json().await?;
        if let Some(credentials) = settings.get_mut("webdav_passwords").and_then(|value| value.as_object_mut()) {
            credentials.remove(account);
        }
        self.save_app_settings_json(&settings).await
    }

    pub async fn save_webdav_sync_secrets_preference(
        &self,
        enabled: bool,
        blob: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        settings.insert("webdav_sync_secrets_enabled".to_string(), serde_json::Value::Bool(enabled));
        if let Some(blob) = blob {
            self.set_secret(
                GLOBAL_SECRET_NAMESPACE,
                "webdav_sync_secrets_passphrase",
                &serde_json::to_string(blob).map_err(|e| e.to_string())?,
            )
            .await?;
        }
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_webdav_sync_secrets_enabled(&self) -> Result<bool, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings.get("webdav_sync_secrets_enabled").and_then(serde_json::Value::as_bool).unwrap_or(false))
    }

    pub async fn load_webdav_sync_secrets_passphrase_blob(&self) -> Result<Option<serde_json::Value>, String> {
        if let Some(blob) = self.get_secret(GLOBAL_SECRET_NAMESPACE, "webdav_sync_secrets_passphrase").await? {
            return serde_json::from_str(&blob).map(Some).map_err(|e| e.to_string());
        }
        let mut settings = self.load_app_settings_json().await?;
        let legacy = settings.remove("webdav_sync_secrets_passphrase");
        if let Some(blob) = &legacy {
            self.save_webdav_sync_secrets_preference(
                settings.get("webdav_sync_secrets_enabled").and_then(serde_json::Value::as_bool).unwrap_or(false),
                Some(blob),
            )
            .await?;
            self.save_app_settings_json(&settings).await?;
        }
        Ok(legacy)
    }

    pub async fn delete_webdav_sync_secrets_passphrase_blob(&self) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        self.delete_secret(GLOBAL_SECRET_NAMESPACE, "webdav_sync_secrets_passphrase").await?;
        settings.remove("webdav_sync_secrets_passphrase");
        self.save_app_settings_json(&settings).await
    }

    pub async fn save_snippet_sync_id(&self, provider: &str, snippet_id: Option<&str>) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        let mut ids =
            settings.remove(SNIPPET_SYNC_IDS_KEY).and_then(|value| value.as_object().cloned()).unwrap_or_default();
        match snippet_id.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => {
                ids.insert(provider.to_string(), serde_json::Value::String(id.to_string()));
            }
            None => {
                ids.remove(provider);
            }
        }
        settings.insert(SNIPPET_SYNC_IDS_KEY.to_string(), serde_json::Value::Object(ids));
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_snippet_sync_id(&self, provider: &str) -> Result<Option<String>, String> {
        Ok(self.load_snippet_sync_state(provider).await?.snippet_id)
    }

    pub async fn save_snippet_migration_state(
        &self,
        provider: &str,
        replacement_snippet_id: &str,
        legacy_snippet_id: &str,
        expected_content_hash: &str,
    ) -> Result<(), String> {
        let replacement_snippet_id = required_snippet_state_value(replacement_snippet_id, "replacement snippet id")?;
        let legacy_snippet_id = required_snippet_state_value(legacy_snippet_id, "legacy snippet id")?;
        let expected_content_hash = required_snippet_state_value(expected_content_hash, "legacy content hash")?;
        let mut settings = self.load_app_settings_json().await?;
        let mut ids =
            settings.remove(SNIPPET_SYNC_IDS_KEY).and_then(|value| value.as_object().cloned()).unwrap_or_default();
        ids.insert(provider.to_string(), serde_json::Value::String(replacement_snippet_id.to_string()));
        settings.insert(SNIPPET_SYNC_IDS_KEY.to_string(), serde_json::Value::Object(ids));

        let mut pending_cleanups = settings
            .remove(SNIPPET_PENDING_CLEANUPS_KEY)
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        pending_cleanups.insert(
            provider.to_string(),
            serde_json::to_value(SnippetPendingCleanup {
                snippet_id: legacy_snippet_id.to_string(),
                expected_content_hash: expected_content_hash.to_string(),
            })
            .map_err(|e| e.to_string())?,
        );
        settings.insert(SNIPPET_PENDING_CLEANUPS_KEY.to_string(), serde_json::Value::Object(pending_cleanups));
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_snippet_sync_state(&self, provider: &str) -> Result<SnippetSyncState, String> {
        let settings = self.load_app_settings_json().await?;
        let snippet_id = settings
            .get(SNIPPET_SYNC_IDS_KEY)
            .and_then(serde_json::Value::as_object)
            .and_then(|ids| ids.get(provider))
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string);
        let pending_cleanup = settings
            .get(SNIPPET_PENDING_CLEANUPS_KEY)
            .and_then(serde_json::Value::as_object)
            .and_then(|cleanups| cleanups.get(provider))
            .cloned()
            .map(serde_json::from_value::<SnippetPendingCleanup>)
            .transpose()
            .map_err(|e| format!("invalid pending snippet cleanup state: {e}"))?
            .map(validate_snippet_pending_cleanup)
            .transpose()?;
        Ok(SnippetSyncState { snippet_id, pending_cleanup })
    }

    pub async fn clear_snippet_pending_cleanup_if_matches(
        &self,
        provider: &str,
        expected: &SnippetPendingCleanup,
    ) -> Result<bool, String> {
        let mut settings = self.load_app_settings_json().await?;
        let mut pending_cleanups = settings
            .remove(SNIPPET_PENDING_CLEANUPS_KEY)
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        let Some(current) = pending_cleanups
            .get(provider)
            .cloned()
            .map(serde_json::from_value::<SnippetPendingCleanup>)
            .transpose()
            .map_err(|e| format!("invalid pending snippet cleanup state: {e}"))?
            .map(validate_snippet_pending_cleanup)
            .transpose()?
        else {
            settings.insert(SNIPPET_PENDING_CLEANUPS_KEY.to_string(), serde_json::Value::Object(pending_cleanups));
            return Ok(false);
        };
        if current != *expected {
            settings.insert(SNIPPET_PENDING_CLEANUPS_KEY.to_string(), serde_json::Value::Object(pending_cleanups));
            return Ok(false);
        }
        pending_cleanups.remove(provider);
        settings.insert(SNIPPET_PENDING_CLEANUPS_KEY.to_string(), serde_json::Value::Object(pending_cleanups));
        self.save_app_settings_json(&settings).await?;
        Ok(true)
    }

    pub async fn save_max_agent_turns(&self, max_agent_turns: u32) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        settings.insert(
            "max_agent_turns".to_string(),
            serde_json::Value::Number(serde_json::Number::from(crate::agent_loop::clamp_max_agent_turns(
                max_agent_turns,
            ))),
        );
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_max_agent_turns(&self) -> Result<u32, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings
            .get("max_agent_turns")
            .and_then(serde_json::Value::as_u64)
            .map(|value| crate::agent_loop::clamp_max_agent_turns(value.min(u32::MAX as u64) as u32))
            .unwrap_or(crate::agent_loop::DEFAULT_MAX_AGENT_TURNS))
    }

    pub async fn load_history_retention_limit(&self) -> Result<u32, String> {
        self.with_conn(|conn| load_history_retention_limit_from_conn(conn)).await
    }

    pub async fn save_history_retention_limit(&self, limit: u32) -> Result<(), String> {
        crate::history::validate_history_retention_limit(limit)?;
        self.with_conn(move |conn| {
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let mut settings = match current {
                Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?,
                None => serde_json::Map::new(),
            };
            settings.insert(HISTORY_RETENTION_LIMIT_KEY.to_string(), serde_json::Value::from(limit));
            conn.execute(
                "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                [serde_json::Value::Object(settings).to_string()],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_max_retries(&self, max_retries: u32) -> Result<(), String> {
        let max_retries = crate::ai::clamp_max_retries(max_retries);
        self.with_conn(move |conn| {
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let mut settings = match current {
                Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?,
                None => serde_json::Map::new(),
            };
            settings
                .insert(MAX_RETRIES_KEY.to_string(), serde_json::Value::Number(serde_json::Number::from(max_retries)));
            let json = serde_json::Value::Object(settings).to_string();
            conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_max_retries(&self) -> Result<u32, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings
            .get(MAX_RETRIES_KEY)
            .and_then(serde_json::Value::as_u64)
            .map(|value| crate::ai::clamp_max_retries(value.min(u32::MAX as u64) as u32))
            .unwrap_or(crate::ai::DEFAULT_MAX_RETRIES))
    }

    pub async fn save_sql_file_upload_max_mb(&self, max_mb: u32) -> Result<(), String> {
        let max_mb = crate::sql_file_import::clamp_sql_file_upload_max_mb(max_mb);
        self.with_conn(move |conn| {
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let mut settings = match current {
                Some(json) => serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?,
                None => serde_json::Map::new(),
            };
            settings.insert(
                SQL_FILE_UPLOAD_MAX_MB_KEY.to_string(),
                serde_json::Value::Number(serde_json::Number::from(max_mb)),
            );
            let json = serde_json::Value::Object(settings).to_string();
            conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_sql_file_upload_max_mb(&self) -> Result<u32, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings
            .get(SQL_FILE_UPLOAD_MAX_MB_KEY)
            .and_then(serde_json::Value::as_u64)
            .map(|value| crate::sql_file_import::clamp_sql_file_upload_max_mb(value.min(u32::MAX as u64) as u32))
            .unwrap_or(crate::sql_file_import::DEFAULT_SQL_FILE_UPLOAD_MAX_MB))
    }
}

// AI Conversations

// Terminal runs beyond this many per conversation are pruned on every AI save.
// Only the newest terminal run per conversation is ever read at recovery (it
// drives the history row's status badge after a restart); the older ones are
// pure, unbounded storage + startup-load growth.
const KEEP_TERMINAL_AI_RUNS_PER_CONVERSATION: i64 = 2;

/// Caps each conversation's terminal run history. `save_ai_run` /
/// `save_ai_run_state` persist every run unconditionally and `load_ai_runs`
/// loads the whole table at startup, so without this cap repeated completed/
/// failed/cancelled runs grow SQLite storage and recovery work forever. The
/// frontend recovery loop dedups to the newest run per conversation, so keeping
/// the newest few terminal runs preserves the row status badge exactly while
/// bounding the table. Non-terminal statuses (preparing/queued/running/
/// awaiting_write_confirmation/pending_recoverable) are never touched - they
/// are the recovery payload.
fn prune_terminal_ai_runs(tx: &Transaction<'_>) -> Result<(), String> {
    tx.execute(
        "DELETE FROM ai_runs
         WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
           AND run_id NOT IN (
               SELECT run_id FROM (
                   SELECT run_id,
                          ROW_NUMBER() OVER (
                              PARTITION BY conversation_id
                              ORDER BY updated_at DESC, run_id DESC
                          ) AS rn
                   FROM ai_runs
                   WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
               ) WHERE rn <= ?1
           )",
        params![KEEP_TERMINAL_AI_RUNS_PER_CONVERSATION],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn prune_ai_conversations(tx: &Transaction<'_>) -> Result<(), String> {
    // The 50-row limit is a soft cap: conversations with active or actionable
    // runs remain reachable even when they exceed the cap. Only terminal,
    // unprotected conversations compete for the remaining budget.
    tx.execute(
        "WITH protected AS (
             SELECT DISTINCT conversation_id FROM ai_runs
             WHERE status IN ('preparing', 'queued', 'running', 'awaiting_write_confirmation', 'pending_recoverable')
         ), budget AS (
             SELECT MAX(0, 50 - COUNT(*)) AS value FROM protected
         ), keepers AS (
             SELECT conversation_id AS id FROM protected
             UNION
             SELECT id FROM (
                 SELECT id FROM ai_conversations
                 WHERE id NOT IN (SELECT conversation_id FROM protected)
                 ORDER BY updated_at DESC
                 LIMIT (SELECT value FROM budget)
             )
         )
         DELETE FROM ai_conversations WHERE id NOT IN (SELECT id FROM keepers)",
        [],
    )
    .map_err(|e| e.to_string())?;
    // Do not depend on a connection-wide foreign_keys pragma for cleanup.
    tx.execute("DELETE FROM ai_runs WHERE conversation_id NOT IN (SELECT id FROM ai_conversations)", [])
        .map_err(|e| e.to_string())?;
    // Cap terminal run history for the conversations that survive the cap
    // above (they are deliberately retained), so normal use cannot grow the
    // ai_runs table without bound.
    prune_terminal_ai_runs(tx)?;
    Ok(())
}

impl Storage {
    pub async fn save_ai_conversation(&self, conv: &AiConversation) -> Result<(), String> {
        let conv = conv.clone();
        let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO ai_conversations \
                 (id, title, connection_name, connection_id, database, schema_name, messages_json, queued_input, created_at, updated_at, plugin_context_json) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                   title = excluded.title, \
                   connection_name = excluded.connection_name, \
                   connection_id = excluded.connection_id, \
                   database = excluded.database, \
                   schema_name = excluded.schema_name, \
                   messages_json = excluded.messages_json, \
                   queued_input = excluded.queued_input, \
                   created_at = excluded.created_at, \
                   updated_at = excluded.updated_at, plugin_context_json = excluded.plugin_context_json",
                params![
                    conv.id,
                    conv.title,
                    conv.connection_name,
                    conv.connection_id,
                    conv.database,
                    conv.schema,
                    messages_json,
                    conv.queued_input,
                    conv.created_at,
                    conv.updated_at,
                    conv.plugin_context.map(|value| value.to_string())
                ],
            )
            .map_err(|e| e.to_string())?;

            prune_ai_conversations(&tx)?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_ai_conversations(&self) -> Result<Vec<AiConversation>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, connection_name, database, messages_json, queued_input, created_at, updated_at, plugin_context_json, connection_id, schema_name \
                     FROM ai_conversations ORDER BY updated_at DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let messages_json: String = row.get(4)?;
                    let messages: Vec<AiChatMessage> =
                        serde_json::from_str(&messages_json).map_err(map_from_sql_err)?;
                    Ok(AiConversation {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        connection_name: row.get(2)?,
                        database: row.get(3)?,
                        messages,
                        queued_input: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                        plugin_context: row.get::<_, Option<String>>(8)?.map(|json| serde_json::from_str(&json)).transpose().map_err(map_from_sql_err)?,
                        connection_id: row.get(9)?,
                        schema: row.get(10)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_ai_conversation(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_runs WHERE conversation_id = ?1", [&id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_conversations WHERE id = ?1", [&id]).map_err(|e| e.to_string())?;
            prune_ai_conversations(&tx)?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_ai_run(&self, run: &AiRun) -> Result<(), String> {
        let run = run.clone();
        let session_ids_json = serde_json::to_string(&run.session_ids).map_err(|e| e.to_string())?;
        let pending_confirmation_json = run.pending_confirmation.map(|value| value.to_string());
        let fifo_category = run.fifo_category.map(|c| c.as_str().to_string());
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO ai_runs
                 (run_id, conversation_id, session_ids_json, status, connection_id, database, schema_name,
                  pending_confirmation_json, fifo_category, pending_input, max_seq, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    run.run_id,
                    run.conversation_id,
                    session_ids_json,
                    run.status.as_str(),
                    run.connection_id,
                    run.database,
                    run.schema,
                    pending_confirmation_json,
                    fifo_category,
                    run.pending_input,
                    run.max_seq,
                    run.created_at,
                    run.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
            prune_ai_conversations(&tx)?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_ai_run_state(&self, conv: &AiConversation, run: &AiRun) -> Result<(), String> {
        let conv = conv.clone();
        let run = run.clone();
        let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
        let session_ids_json = serde_json::to_string(&run.session_ids).map_err(|e| e.to_string())?;
        let pending_confirmation_json = run.pending_confirmation.map(|value| value.to_string());
        let fifo_category = run.fifo_category.map(|c| c.as_str().to_string());
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO ai_conversations
                 (id, title, connection_name, connection_id, database, schema_name, messages_json, queued_input, created_at, updated_at, plugin_context_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   title = excluded.title,
                   connection_name = excluded.connection_name,
                   connection_id = excluded.connection_id,
                   database = excluded.database,
                   schema_name = excluded.schema_name,
                   messages_json = excluded.messages_json,
                   queued_input = excluded.queued_input,
                   created_at = excluded.created_at,
                   updated_at = excluded.updated_at, plugin_context_json = excluded.plugin_context_json",
                params![
                    conv.id,
                    conv.title,
                    conv.connection_name,
                    conv.connection_id,
                    conv.database,
                    conv.schema,
                    messages_json,
                    conv.queued_input,
                    conv.created_at,
                    conv.updated_at,
                    conv.plugin_context.map(|value| value.to_string())
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT OR REPLACE INTO ai_runs
                 (run_id, conversation_id, session_ids_json, status, connection_id, database, schema_name,
                  pending_confirmation_json, fifo_category, pending_input, max_seq, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    run.run_id,
                    run.conversation_id,
                    session_ids_json,
                    run.status.as_str(),
                    run.connection_id,
                    run.database,
                    run.schema,
                    pending_confirmation_json,
                    fifo_category,
                    run.pending_input,
                    run.max_seq,
                    run.created_at,
                    run.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
            prune_ai_conversations(&tx)?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_ai_runs(&self) -> Result<Vec<AiRun>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT run_id, conversation_id, session_ids_json, status, connection_id, database,
                            schema_name, pending_confirmation_json, fifo_category, pending_input, max_seq, created_at, updated_at
                     FROM ai_runs ORDER BY updated_at DESC",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    let session_ids_json: String = row.get(2)?;
                    let status: String = row.get(3)?;
                    let pending_confirmation_json: Option<String> = row.get(7)?;
                    let fifo_category: Option<String> = row.get(8)?;
                    let pending_input: Option<String> = row.get(9)?;
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        session_ids_json,
                        status,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        pending_confirmation_json,
                        fifo_category,
                        pending_input,
                        row.get::<_, Option<u64>>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            rows.map(|row| {
                let (
                    run_id,
                    conversation_id,
                    session_ids_json,
                    status,
                    connection_id,
                    database,
                    schema,
                    pending_confirmation_json,
                    fifo_category,
                    pending_input,
                    max_seq,
                    created_at,
                    updated_at,
                ) = row.map_err(|e| e.to_string())?;
                Ok(AiRun {
                    run_id,
                    conversation_id,
                    session_ids: serde_json::from_str(&session_ids_json).map_err(|e| e.to_string())?,
                    status: AiRunStatus::parse(&status)?,
                    connection_id,
                    database,
                    schema,
                    pending_confirmation: pending_confirmation_json
                        .map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
                        .transpose()?,
                    fifo_category: fifo_category.map(|value| AiRunFifoCategory::parse(&value)).transpose()?,
                    pending_input,
                    max_seq,
                    created_at,
                    updated_at,
                })
            })
            .collect::<Result<Vec<_>, String>>()
        })
        .await
    }

    // Prompt Templates

    pub async fn load_prompt_templates(&self) -> Result<Vec<PromptTemplate>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, content, created_at, updated_at \
                     FROM prompt_templates ORDER BY created_at, id",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(PromptTemplate {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        content: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_prompt_template(&self, id: &str, name: &str, content: &str) -> Result<PromptTemplate, String> {
        let id = id.to_string();
        let name = name.trim().to_string();
        let content = content.to_string();

        // Validation
        if name.is_empty() {
            return Err("template name cannot be empty".to_string());
        }
        if name.chars().count() > 50 {
            return Err("template name too long (max 50 chars)".to_string());
        }
        if content.chars().count() > 8000 {
            return Err("template content too long (max 8000 chars)".to_string());
        }

        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

        self.with_conn(move |conn| {
            // Case-insensitive duplicate name check (Unicode-aware).
            // SQLite LOWER() is ASCII-only, so we compare in Rust where
            // str::to_lowercase() handles full Unicode case folding.
            let name_lower = name.to_lowercase();
            let mut stmt = conn
                .prepare("SELECT name FROM prompt_templates WHERE id != ?1")
                .map_err(|e| e.to_string())?;
            let duplicate = stmt
                .query_map(params![id], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .any(|existing| existing.to_lowercase() == name_lower);
            if duplicate {
                return Err("duplicate template name".to_string());
            }

            // Check if row exists to decide INSERT vs UPDATE
            let existing_created_at: Option<String> = conn
                .query_row("SELECT created_at FROM prompt_templates WHERE id = ?1", params![id], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;

            if let Some(created_at) = existing_created_at {
                // UPDATE — preserve created_at
                conn.execute(
                    "UPDATE prompt_templates SET name = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
                    params![name, content, now, id],
                )
                .map_err(|e| e.to_string())?;
                Ok(PromptTemplate { id, name, content, created_at, updated_at: now })
            } else {
                // INSERT
                conn.execute(
                    "INSERT INTO prompt_templates (id, name, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![id, name, content, now, now],
                )
                .map_err(|e| e.to_string())?;
                Ok(PromptTemplate { id, name, content, created_at: now.clone(), updated_at: now })
            }
        })
        .await
    }

    pub async fn delete_prompt_template(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            let rows =
                conn.execute("DELETE FROM prompt_templates WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
            if rows == 0 {
                Err("template not found".to_string())
            } else {
                Ok(())
            }
        })
        .await
    }
}

// Connections

fn load_mcp_global_policy_in_tx(tx: &rusqlite::Transaction<'_>) -> Result<McpGlobalPolicy, String> {
    let settings_json: Option<String> = tx
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
    Ok(match settings_json {
        Some(json) => {
            let settings = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json)
                .map_err(|e| format!("MCP_POLICY_UNAVAILABLE: invalid app settings JSON: {e}"))?;
            match settings.get(MCP_GLOBAL_POLICY_KEY) {
                Some(value) => serde_json::from_value::<McpGlobalPolicy>(value.clone())
                    .map_err(|e| format!("MCP_POLICY_UNAVAILABLE: invalid MCP policy: {e}"))?
                    .normalized(),
                None => McpGlobalPolicy::default(),
            }
        }
        None => McpGlobalPolicy::default(),
    })
}

fn ensure_mcp_connection_change_allowed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    target_connection_id: Option<&str>,
) -> Result<(), String> {
    let policy = load_mcp_global_policy_in_tx(tx)?;
    if policy.read_only {
        return Err(
            "MCP_READ_ONLY: DBX global MCP read-only mode is enabled. Connection changes are blocked.".to_string()
        );
    }
    if let Some(connection_id) = target_connection_id {
        let group_paths = if crate::mcp_policy::policy_uses_connection_groups(&policy) {
            let layout_json: Option<String> = tx
                .query_row("SELECT layout_json FROM sidebar_layout WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|error| format!("MCP_POLICY_UNAVAILABLE: {error}"))?;
            layout_json
                .map(|json| {
                    let layout = serde_json::from_str(&json)
                        .map_err(|error| format!("MCP_POLICY_UNAVAILABLE: invalid sidebar layout JSON: {error}"))?;
                    crate::mcp_policy::connection_group_paths(&layout)
                        .map_err(|error| format!("MCP_POLICY_UNAVAILABLE: {error}"))
                })
                .transpose()?
                .unwrap_or_default()
        } else {
            HashMap::new()
        };
        if !crate::mcp_policy::policy_allows_connection(&policy, group_paths.get(connection_id), connection_id) {
            return Err(format!(
                "CONNECTION_OUT_OF_SCOPE: connection '{connection_id}' is not allowed by the current DBX MCP policy"
            ));
        }
    }
    Ok(())
}

fn sanitized_connection_config(config: &ConnectionConfig) -> ConnectionConfig {
    let mut sanitized = config.clone().canonicalized();
    sanitized.password = String::new();
    sanitized.url_params = None;
    scrub_transport_layer_secrets(&mut sanitized);
    sanitized.redis_sentinel_password = String::new();
    sanitized.connection_string = None;
    sanitized.init_script = None;
    scrub_mq_auth_secrets(&mut sanitized);
    scrub_mqtt_auth_secrets(&mut sanitized);
    scrub_mq_token_signing_secret(&mut sanitized);
    scrub_nacos_auth_secrets(&mut sanitized);
    scrub_cassandra_tls_secrets(&mut sanitized);
    scrub_salesforce_auth_secrets(&mut sanitized);
    sanitized.connection_secrets.clear();
    sanitized
}

fn persist_connection_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    let config = config.clone().canonicalized();
    let config_id = config.id.clone();
    let sanitized = sanitized_connection_config(&config);
    let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

    tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config_id, json])
        .map_err(|e| e.to_string())?;

    if config.save_password {
        persist_secret_in_tx(tx, codec, &config.id, "password", &config.password)?;
    } else {
        // "Don't save password": write an empty value, which persist_secret_in_tx
        // turns into a DELETE — the password secret is never persisted (and any
        // previously stored secret is removed on this save).
        persist_secret_in_tx(tx, codec, &config.id, "password", "")?;
    }
    delete_secret_prefix_in_tx(tx, &config.id, TRANSPORT_LAYER_SECRET_PREFIX)?;
    for (index, layer) in config.transport_layers.iter().enumerate() {
        match layer {
            TransportLayerConfig::Ssh(ssh) => {
                persist_secret_in_tx(
                    tx,
                    codec,
                    &config.id,
                    &transport_layer_ssh_password_key(index, layer),
                    &ssh.password,
                )?;
                persist_secret_in_tx(
                    tx,
                    codec,
                    &config.id,
                    &transport_layer_ssh_key_passphrase_key(index, layer),
                    &ssh.key_passphrase,
                )?;
            }
            TransportLayerConfig::Proxy(proxy) => {
                persist_secret_in_tx(
                    tx,
                    codec,
                    &config.id,
                    &transport_layer_proxy_password_key(index, layer),
                    &proxy.password,
                )?;
            }
            TransportLayerConfig::HttpTunnel(http) => {
                persist_secret_in_tx(
                    tx,
                    codec,
                    &config.id,
                    &transport_layer_http_tunnel_token_key(index, layer),
                    &http.token,
                )?;
            }
        }
    }
    persist_secret_in_tx(tx, codec, &config.id, "redis_sentinel_password", &config.redis_sentinel_password)?;
    if let Some(url_params) = &config.url_params {
        persist_secret_in_tx(tx, codec, &config.id, URL_PARAMS_SECRET_KEY, url_params)?;
    } else {
        persist_secret_in_tx(tx, codec, &config.id, URL_PARAMS_SECRET_KEY, "")?;
    }
    persist_secret_in_tx(tx, codec, &config.id, "ssh_password", "")?;
    persist_secret_in_tx(tx, codec, &config.id, "ssh_key_passphrase", "")?;
    persist_secret_in_tx(tx, codec, &config.id, "proxy_password", "")?;
    delete_secret_prefix_in_tx(tx, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
    if let Some(cs) = &config.connection_string {
        persist_secret_in_tx(tx, codec, &config.id, "connection_string", cs)?;
    } else {
        tx.execute(
            "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![config.id, "connection_string"],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(script) = &config.init_script {
        persist_secret_in_tx(tx, codec, &config.id, "init_script", script)?;
    } else {
        tx.execute(
            "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![config.id, "init_script"],
        )
        .map_err(|e| e.to_string())?;
    }
    persist_mq_auth_secrets_in_tx(tx, codec, &config)?;
    persist_mqtt_auth_secrets_in_tx(tx, codec, &config)?;
    persist_mq_token_signing_secret_in_tx(tx, codec, &config)?;
    persist_nacos_auth_secrets_in_tx(tx, codec, &config)?;
    persist_cassandra_tls_secrets_in_tx(tx, codec, &config)?;
    persist_salesforce_auth_secrets_in_tx(tx, codec, &config)?;
    delete_secret_prefix_in_tx(tx, &config.id, PLUGIN_CONNECTION_SECRET_PREFIX)?;
    for (key, secret) in &config.connection_secrets {
        if !key.is_empty() {
            persist_secret_in_tx(tx, codec, &config.id, &format!("{PLUGIN_CONNECTION_SECRET_PREFIX}{key}"), secret)?;
        }
    }
    Ok(())
}

async fn load_plugin_connection_secrets(
    storage: &Storage,
    connection_id: &str,
) -> Result<HashMap<String, String>, String> {
    let connection_id = connection_id.to_string();
    let secret_storage = storage.clone();
    storage
        .with_conn(move |conn| {
            let like = format!("{PLUGIN_CONNECTION_SECRET_PREFIX}%");
            let mut statement = conn
                .prepare(
                    "SELECT key, secret, secret_enc FROM connection_secrets WHERE connection_id = ?1 AND key LIKE ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![connection_id, like], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
                })
                .map_err(|error| error.to_string())?;
            let mut secrets = HashMap::new();
            for row in rows {
                let (key, secret, encrypted) = row.map_err(|error| error.to_string())?;
                let secret = encrypted
                    .filter(|value| !value.is_empty())
                    .map(|value| secret_storage.secret_codec(false)?.decrypt(&connection_id, &key, &value))
                    .transpose()?
                    .unwrap_or(secret);
                if let Some(key) = key.strip_prefix(PLUGIN_CONNECTION_SECRET_PREFIX) {
                    secrets.insert(key.to_string(), secret);
                }
            }
            Ok(secrets)
        })
        .await
}

fn insert_connection_copy_next_to_source(entries: &mut Vec<serde_json::Value>, source_id: &str, copy_id: &str) -> bool {
    let mut index = 0;
    while index < entries.len() {
        let entry_type = entries[index].get("type").and_then(serde_json::Value::as_str);
        if entry_type == Some("connection")
            && entries[index].get("id").and_then(serde_json::Value::as_str) == Some(source_id)
        {
            entries.insert(index + 1, serde_json::json!({ "type": "connection", "id": copy_id }));
            return true;
        }
        if entry_type == Some("group") {
            if let Some(children) = entries[index].get_mut("children").and_then(serde_json::Value::as_array_mut) {
                if insert_connection_copy_next_to_source(children, source_id, copy_id) {
                    return true;
                }
            } else if let Some(connection_ids) =
                entries[index].get_mut("connectionIds").and_then(serde_json::Value::as_array_mut)
            {
                if let Some(source_index) = connection_ids.iter().position(|id| id.as_str() == Some(source_id)) {
                    connection_ids.insert(source_index + 1, serde_json::Value::String(copy_id.to_string()));
                    return true;
                }
            }
        }
        index += 1;
    }
    false
}

fn copy_sidebar_layout_entry_in_tx(
    tx: &rusqlite::Transaction<'_>,
    source_id: &str,
    copy_id: &str,
) -> Result<(), String> {
    let Some(layout_json) = tx
        .query_row("SELECT layout_json FROM sidebar_layout WHERE id = 1", [], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let mut layout: serde_json::Value = serde_json::from_str(&layout_json).map_err(|error| error.to_string())?;
    let Some(order) = layout.get_mut("order").and_then(serde_json::Value::as_array_mut) else {
        return Err("INVALID_SIDEBAR_LAYOUT: sidebar order is not an array".to_string());
    };
    if !insert_connection_copy_next_to_source(order, source_id, copy_id) {
        order.push(serde_json::json!({ "type": "connection", "id": copy_id }));
    }
    let updated = serde_json::to_string(&layout).map_err(|error| error.to_string())?;
    tx.execute("UPDATE sidebar_layout SET layout_json = ?1 WHERE id = 1", [updated])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn preserve_unreadable_connections_for_replacement(
    tx: &rusqlite::Transaction<'_>,
    replacement_ids: &HashSet<String>,
) -> Result<Vec<String>, String> {
    let unreadable_rows = {
        let mut stmt = tx.prepare("SELECT id, config_json FROM connections").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter_map(|(id, json)| {
                serde_json::from_str::<ConnectionConfig>(&json).err().map(|error| (id, json, error.to_string()))
            })
            .collect::<Vec<_>>()
    };

    tx.execute("DELETE FROM connections", []).map_err(|e| e.to_string())?;

    let mut preserved_ids = Vec::new();
    for (id, json, error) in unreadable_rows {
        if replacement_ids.contains(&id) {
            continue;
        }
        warn!("Preserving unreadable saved connection '{}' during connection list update: {}", id, error);
        tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![id, json])
            .map_err(|e| e.to_string())?;
        preserved_ids.push(id);
    }
    Ok(preserved_ids)
}

fn delete_unreferenced_connection_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    retained_ids: &[String],
) -> Result<(), String> {
    if retained_ids.is_empty() {
        tx.execute(
            "DELETE FROM connection_secrets
             WHERE connection_id NOT LIKE 'ai_config.%'
               AND connection_id NOT LIKE 'tunnel_profile.%'
               AND connection_id != 'dbx.global'",
            [],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let placeholders = vec!["?"; retained_ids.len()].join(",");
        let sql = format!(
            "DELETE FROM connection_secrets
             WHERE connection_id NOT IN ({placeholders})
               AND connection_id NOT LIKE 'ai_config.%'
               AND connection_id NOT LIKE 'tunnel_profile.%'
               AND connection_id != 'dbx.global'"
        );
        let ids = retained_ids.iter().map(|id| id as &dyn ToSql);
        tx.execute(&sql, params_from_iter(ids)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

impl Storage {
    pub(crate) async fn apply_sync_import_transaction(&self, plan: SyncImportPlan) -> Result<(), String> {
        let needs_key =
            plan.connections.iter().any(|config| config.url_params.as_deref().is_some_and(|value| !value.is_empty()))
                || plan
                    .connection_secrets
                    .as_ref()
                    .is_some_and(|secrets| secrets.iter().any(|secret| !secret.secret.is_empty()))
                || plan.sync_credentials.as_ref().is_some_and(|credentials| !credentials.is_empty())
                || plan.tunnel_secret_profiles.is_some()
                || plan.ai_configs.is_some();
        let codec = self.secret_codec_for_write(needs_key).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;

            apply_sync_connections_in_tx(&tx, &codec, &plan.connections)?;
            if let Some(profiles) = &plan.tunnel_profiles {
                apply_sync_tunnel_profiles_in_tx(&tx, &codec, profiles, plan.tunnel_secret_profiles.as_deref())?;
            }
            if let Some(layout) = &plan.sidebar_layout {
                let json = serde_json::to_string(layout).map_err(|e| e.to_string())?;
                tx.execute("INSERT OR REPLACE INTO sidebar_layout (id, layout_json) VALUES (1, ?1)", [json])
                    .map_err(|e| e.to_string())?;
            }
            let pinned = serde_json::to_string(&plan.pinned_tree_node_ids).map_err(|e| e.to_string())?;
            update_app_settings_key_in_tx(
                &tx,
                "pinned_tree_node_ids",
                serde_json::from_str(&pinned).map_err(|e| e.to_string())?,
            )?;
            apply_saved_sql_in_tx(&tx, &plan.saved_sql)?;
            apply_desktop_settings_in_tx(&tx, &plan.desktop_settings)?;
            if let Some(editor_settings) = &plan.editor_settings {
                let value = serde_json::to_string(editor_settings).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT OR REPLACE INTO app_state (key, value_json) VALUES (?1, ?2)",
                    params![APP_STATE_EDITOR_SETTINGS_KEY, value],
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(ai_configs) = &plan.ai_configs {
                apply_ai_configs_in_tx(&tx, &codec, ai_configs)?;
            }
            if let Some(secrets) = &plan.connection_secrets {
                clear_sync_connection_secrets_in_tx(&tx, &plan.connections, plan.preserve_plugin_secrets)?;
                for secret in secrets {
                    if secret.secret.is_empty() {
                        continue;
                    }
                    persist_secret_in_tx(&tx, &codec, &secret.connection_id, &secret.key, &secret.secret)?;
                }
            }
            if let Some(credentials) = &plan.sync_credentials {
                tx.execute(
                    "DELETE FROM connection_secrets
                     WHERE connection_id = ?1 AND key LIKE 'webdav_password.%'",
                    [GLOBAL_SECRET_NAMESPACE],
                )
                .map_err(|e| e.to_string())?;
                for credential in credentials {
                    if credential.account.trim().is_empty() {
                        return Err("Synced credential account must not be empty".to_string());
                    }
                    persist_secret_in_tx(
                        &tx,
                        &codec,
                        GLOBAL_SECRET_NAMESPACE,
                        &format!("webdav_password.{}", credential.account),
                        &credential.blob,
                    )?;
                }
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_connection_metadata_preserving_secrets(
        &self,
        configs: &[ConnectionConfig],
    ) -> Result<(), String> {
        let configs = configs.to_vec();
        let codec = self.secret_codec_for_write(false).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let replacement_ids = configs.iter().map(|config| config.id.clone()).collect::<HashSet<_>>();
            let mut retained_ids = preserve_unreadable_connections_for_replacement(&tx, &replacement_ids)?;

            for config in &configs {
                let config = config.canonicalized();
                let config_id = config.id.clone();
                if !config.save_password {
                    // Metadata-only imports/sync preserve existing secrets by default.
                    // This preference is an exception: retaining the old password would
                    // make a no-save connection silently authenticate without prompting.
                    persist_secret_in_tx(&tx, &codec, &config.id, "password", "")?;
                    delete_secret_prefix_in_tx(&tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
                }
                let mut sanitized = config;
                sanitized.password = String::new();
                sanitized.url_params = None;
                scrub_transport_layer_secrets(&mut sanitized);
                sanitized.redis_sentinel_password = String::new();
                sanitized.connection_string = None;
                sanitized.init_script = None;
                scrub_mq_auth_secrets(&mut sanitized);
                scrub_mqtt_auth_secrets(&mut sanitized);
                scrub_mq_token_signing_secret(&mut sanitized);
                scrub_nacos_auth_secrets(&mut sanitized);
                scrub_cassandra_tls_secrets(&mut sanitized);
                scrub_salesforce_auth_secrets(&mut sanitized);
                sanitized.connection_secrets.clear();
                let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

                tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config_id, json])
                    .map_err(|e| e.to_string())?;
            }

            retained_ids.extend(configs.iter().map(|config| config.id.clone()));
            delete_unreferenced_connection_secrets_in_tx(&tx, &retained_ids)?;

            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_connections(&self, configs: &[ConnectionConfig]) -> Result<(), String> {
        let configs = configs.to_vec();
        let needs_key = configs.iter().any(connection_config_has_inline_secrets);
        let codec = self.secret_codec_for_write(needs_key).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let replacement_ids = configs.iter().map(|config| config.id.clone()).collect::<HashSet<_>>();
            let mut retained_ids = preserve_unreadable_connections_for_replacement(&tx, &replacement_ids)?;

            for config in &configs {
                persist_connection_in_tx(&tx, &codec, config)?;
            }

            retained_ids.extend(configs.iter().map(|config| config.id.clone()));
            delete_unreferenced_connection_secrets_in_tx(&tx, &retained_ids)?;

            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        let config = config.canonicalized();
        let codec = self.secret_codec_for_write(connection_config_has_inline_secrets(&config)).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            ensure_mcp_connection_change_allowed_in_tx(&tx, None)?;
            persist_connection_in_tx(&tx, &codec, &config)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(config)
        })
        .await
    }

    pub async fn duplicate_connection_for_mcp(
        &self,
        source_id: &str,
        copy_id: &str,
        copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        let source_id = source_id.to_string();
        let copy_id = copy_id.to_string();
        let copied_id = copy_id.clone();
        let copy_name = copy_name.to_string();
        let codec = self.secret_codec(false)?;
        self.with_conn(move |conn| {
            let tx =
                conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            ensure_mcp_connection_change_allowed_in_tx(&tx, Some(&source_id))?;
            let copy_name_lower = copy_name.to_lowercase();
            let mut names = tx.prepare("SELECT config_json FROM connections").map_err(|error| error.to_string())?;
            let duplicate_name = names
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .filter_map(Result::ok)
                .filter_map(|json| serde_json::from_str::<ConnectionConfig>(&json).ok())
                .any(|connection| connection.name.to_lowercase() == copy_name_lower);
            drop(names);
            if duplicate_name {
                return Err(format!("CONNECTION_ALREADY_EXISTS: connection '{copy_name}' already exists"));
            }
            let source_json = tx
                .query_row("SELECT config_json FROM connections WHERE id = ?1", [&source_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("CONNECTION_NOT_FOUND: connection '{source_id}' was not found"))?;
            let mut copy: ConnectionConfig = serde_json::from_str(&source_json).map_err(|error| error.to_string())?;
            copy.id = copy_id.clone();
            copy.name = copy_name;
            let copy_json = serde_json::to_string(&copy).map_err(|error| error.to_string())?;
            tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![copy_id, copy_json])
                .map_err(|error| error.to_string())?;
            let source_secrets = {
                let mut statement = tx
                    .prepare("SELECT key, secret, secret_enc FROM connection_secrets WHERE connection_id = ?1")
                    .map_err(|error| error.to_string())?;
                let rows = statement
                    .query_map([&source_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
                    })
                    .map_err(|error| error.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?
            };
            for (key, legacy, encrypted) in source_secrets {
                let plaintext = encrypted
                    .filter(|value| !value.is_empty())
                    .map(|value| codec.decrypt(&source_id, &key, &value))
                    .transpose()?
                    .unwrap_or(legacy);
                if plaintext.is_empty() {
                    continue;
                }
                let rewrapped = codec.encrypt(&copy.id, &key, &plaintext)?;
                tx.execute(
                    "INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?1, ?2, '', ?3)",
                    params![copy.id, key, rewrapped],
                )
                .map_err(|error| error.to_string())?;
            }
            copy_sidebar_layout_entry_in_tx(&tx, &source_id, &copy.id)?;
            tx.commit().map_err(|error| error.to_string())?;
            Ok(copy)
        })
        .await?;
        self.load_connections()
            .await?
            .into_iter()
            .find(|connection| connection.id == copied_id)
            .ok_or_else(|| "CONNECTION_SAVE_ERROR: copied connection could not be reloaded".to_string())
    }

    pub async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String> {
        let connection_id = connection_id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            ensure_mcp_connection_change_allowed_in_tx(&tx, Some(&connection_id))?;
            let removed =
                tx.execute("DELETE FROM connections WHERE id = ?1", [&connection_id]).map_err(|e| e.to_string())? > 0;
            if removed {
                tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1", [&connection_id])
                    .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            Ok(removed)
        })
        .await
    }

    pub async fn save_connection_database_info(
        &self,
        connection_id: &str,
        database_info: Option<DatabaseConnectionInfo>,
    ) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        self.with_conn(move |conn| {
            let json = conn
                .query_row("SELECT config_json FROM connections WHERE id = ?1", [&connection_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
            let mut config = sanitized_connection_config(
                &serde_json::from_str::<ConnectionConfig>(&json).map_err(|error| error.to_string())?,
            );
            config.database_info = database_info;
            let json = serde_json::to_string(&config).map_err(|error| error.to_string())?;
            conn.execute("UPDATE connections SET config_json = ?1 WHERE id = ?2", params![json, connection_id])
                .map(|_| ())
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Update only the persisted `database` of one saved connection.
    ///
    /// Unlike `save_connections`, this is an in-place update for a value DBX discovered
    /// while connecting (a legacy KingbaseES/Vastbase connection without a database) and
    /// must not replace the saved connection list or touch separately stored secrets.
    /// Returns `false` when the connection is not persisted, for example a temporary
    /// connection-test id.
    pub async fn save_connection_database(&self, connection_id: &str, database: &str) -> Result<bool, String> {
        let connection_id = connection_id.to_string();
        let database = database.to_string();
        self.with_conn(move |conn| {
            let json = conn
                .query_row("SELECT config_json FROM connections WHERE id = ?1", [&connection_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?;
            let Some(json) = json else {
                return Ok(false);
            };
            let mut config: ConnectionConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            config.database = Some(database);
            let json = serde_json::to_string(&config).map_err(|error| error.to_string())?;
            conn.execute("UPDATE connections SET config_json = ?1 WHERE id = ?2", params![json, connection_id])
                .map(|_| true)
                .map_err(|error| error.to_string())
        })
        .await
    }

    /// Update only the persisted MQTT saved-topic metadata for one connection.
    ///
    /// Unlike `save_connections`, this is an in-place update and must not replace
    /// the saved connection list or touch separately stored connection secrets.
    pub async fn save_connection_mqtt_saved_topics(
        &self,
        connection_id: &str,
        saved_topics: serde_json::Value,
    ) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        self.with_conn(move |conn| {
            let json = conn
                .query_row("SELECT config_json FROM connections WHERE id = ?1", [&connection_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or_else(|| format!("Connection config not found: {connection_id}"))?;
            let mut config = sanitized_connection_config(
                &serde_json::from_str::<ConnectionConfig>(&json).map_err(|error| error.to_string())?,
            );
            let mut external_config = config.external_config.take().unwrap_or_else(|| serde_json::json!({}));
            let Some(external_object) = external_config.as_object_mut() else {
                return Err("MQTT external_config 必须是 JSON 对象".to_string());
            };
            external_object.insert("savedTopics".to_string(), saved_topics);
            config.external_config = Some(external_config);
            let updated_json = serde_json::to_string(&config).map_err(|error| error.to_string())?;
            conn.execute("UPDATE connections SET config_json = ?1 WHERE id = ?2", params![updated_json, connection_id])
                .map(
                    |updated| {
                        if updated == 0 {
                            Err(format!("Connection config not found: {connection_id}"))
                        } else {
                            Ok(())
                        }
                    },
                )
                .map_err(|error| error.to_string())?
        })
        .await
    }

    /// Update only the persisted driver identity for an existing connection.
    /// This is used after runtime driver fallback and deliberately leaves all
    /// other connection metadata and separately stored secrets untouched.
    pub async fn save_connection_driver_profile(
        &self,
        expected_config: &ConnectionConfig,
        driver_profile: Option<String>,
        driver_label: Option<String>,
    ) -> Result<bool, String> {
        let expected_config = sanitized_connection_config(expected_config);
        let connection_id = expected_config.id.clone();
        self.with_conn(move |conn| {
            let Some(json) = conn
                .query_row("SELECT config_json FROM connections WHERE id = ?1", [&connection_id], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .map_err(|error| error.to_string())?
            else {
                return Ok(false);
            };
            let current: ConnectionConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            let mut current_identity = sanitized_connection_config(&current);
            let mut expected_identity = expected_config.clone();
            current_identity.note.clear();
            current_identity.database_info = None;
            expected_identity.note.clear();
            expected_identity.database_info = None;

            let identity_matches = current_identity == expected_identity
                || (current_identity.driver_profile == driver_profile
                    && current_identity.driver_label == driver_label
                    && {
                        current_identity.driver_profile = expected_identity.driver_profile.clone();
                        current_identity.driver_label = expected_identity.driver_label.clone();
                        current_identity == expected_identity
                    });
            if !identity_matches {
                return Ok(false);
            }

            if current.driver_profile == driver_profile && current.driver_label == driver_label {
                return Ok(true);
            }

            let mut updated = sanitized_connection_config(&current);
            updated.driver_profile = driver_profile;
            updated.driver_label = driver_label;
            let updated_json = serde_json::to_string(&updated).map_err(|error| error.to_string())?;
            conn.execute(
                "UPDATE connections SET config_json = ?1 WHERE id = ?2 AND config_json = ?3",
                params![updated_json, connection_id, json],
            )
            .map(|updated| updated > 0)
            .map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        let rows: Vec<(String, String)> = self
            .with_conn(|conn| {
                let mut stmt = conn.prepare("SELECT id, config_json FROM connections").map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
            })
            .await?;

        let mut configs = Vec::new();
        for (id, json) in rows {
            let mut config: ConnectionConfig = match serde_json::from_str(&json) {
                Ok(config) => config,
                Err(error) => {
                    warn!("Skipping unreadable saved connection '{}': {}", id, error);
                    continue;
                }
            };
            config.password = self.get_secret(&id, "password").await?.unwrap_or_default();
            config.url_params = self.get_secret(&id, URL_PARAMS_SECRET_KEY).await?.or(config.url_params);
            for index in 0..config.transport_layers.len() {
                let layer_for_key = config.transport_layers[index].clone();
                match &mut config.transport_layers[index] {
                    TransportLayerConfig::Ssh(ssh) => {
                        ssh.password = self
                            .get_secret(&id, &transport_layer_ssh_password_key(index, &layer_for_key))
                            .await?
                            .or(match &layer_for_key {
                                TransportLayerConfig::Ssh(layer) if layer.id == "legacy" => {
                                    self.get_secret(&id, "ssh_password").await?
                                }
                                TransportLayerConfig::Ssh(layer) => {
                                    self.get_secret(&id, &ssh_tunnel_password_key(index, layer)).await?
                                }
                                TransportLayerConfig::Proxy(_) | TransportLayerConfig::HttpTunnel(_) => None,
                            })
                            .unwrap_or_default();
                        ssh.key_passphrase = self
                            .get_secret(&id, &transport_layer_ssh_key_passphrase_key(index, &layer_for_key))
                            .await?
                            .or(match &layer_for_key {
                                TransportLayerConfig::Ssh(layer) if layer.id == "legacy" => {
                                    self.get_secret(&id, "ssh_key_passphrase").await?
                                }
                                TransportLayerConfig::Ssh(layer) => {
                                    self.get_secret(&id, &ssh_tunnel_key_passphrase_key(index, layer)).await?
                                }
                                TransportLayerConfig::Proxy(_) | TransportLayerConfig::HttpTunnel(_) => None,
                            })
                            .unwrap_or_default();
                    }
                    TransportLayerConfig::Proxy(proxy) => {
                        proxy.password = self
                            .get_secret(&id, &transport_layer_proxy_password_key(index, &layer_for_key))
                            .await?
                            .or(match &layer_for_key {
                                TransportLayerConfig::Proxy(layer) if layer.id == "legacy-proxy" => {
                                    self.get_secret(&id, "proxy_password").await?
                                }
                                _ => None,
                            })
                            .unwrap_or_default();
                    }
                    TransportLayerConfig::HttpTunnel(http) => {
                        http.token = self
                            .get_secret(&id, &transport_layer_http_tunnel_token_key(index, &layer_for_key))
                            .await?
                            .unwrap_or_default();
                    }
                }
            }
            config.redis_sentinel_password = self.get_secret(&id, "redis_sentinel_password").await?.unwrap_or_default();
            config.connection_string = self.get_secret(&id, "connection_string").await?;
            config.init_script = self.get_secret(&id, "init_script").await?;
            let stored_plugin_secrets = load_plugin_connection_secrets(self, &id).await?;
            if !stored_plugin_secrets.is_empty() {
                config.connection_secrets = stored_plugin_secrets;
            }
            let needs_mq_auth_rewrite = self.hydrate_mq_auth_secrets(&id, &mut config).await?;
            let needs_mqtt_auth_rewrite = self.hydrate_mqtt_auth_secret(&id, &mut config).await?;
            let needs_mq_token_signing_rewrite = self.hydrate_mq_token_signing_secret(&id, &mut config).await?;
            let needs_nacos_auth_rewrite = self.hydrate_nacos_auth_secret(&id, &mut config).await?;
            let needs_cassandra_tls_rewrite = self.hydrate_cassandra_tls_secrets(&id, &mut config).await?;
            let needs_salesforce_auth_rewrite = self.hydrate_salesforce_auth_secrets(&id, &mut config).await?;
            let mut needs_plugin_secret_rewrite = false;
            let plugin_secret_keys = config.connection_secrets.keys().cloned().collect::<Vec<_>>();
            for key in plugin_secret_keys {
                let storage_key = plugin_connection_secret_key(&key)?;
                let current = config.connection_secrets.get(&key).cloned().unwrap_or_default();
                if current.is_empty() {
                    if let Some(secret) = self.get_secret(&id, &storage_key).await? {
                        config.connection_secrets.insert(key, secret);
                    }
                } else {
                    self.set_secret(&id, &storage_key, &current).await?;
                    needs_plugin_secret_rewrite = true;
                }
            }
            let needs_external_secret_rewrite = needs_mq_auth_rewrite
                || needs_mqtt_auth_rewrite
                || needs_mq_token_signing_rewrite
                || needs_nacos_auth_rewrite
                || needs_cassandra_tls_rewrite
                || needs_salesforce_auth_rewrite
                || needs_plugin_secret_rewrite;
            if needs_external_secret_rewrite {
                // `config` is hydrated above, so always use the canonical
                // full scrubber before persisting it again. Otherwise a
                // plugin-secret rewrite could write the decrypted password,
                // SSH credentials, or connection string back to config_json.
                let sanitized = sanitized_connection_config(&config);
                let sanitized_json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
                let update_id = id.clone();
                self.with_conn(move |conn| {
                    conn.execute(
                        "UPDATE connections SET config_json = ?1 WHERE id = ?2",
                        params![sanitized_json, update_id],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                })
                .await?;
            }
            configs.push(config.canonicalized());
        }
        Ok(configs)
    }

    async fn hydrate_mq_auth_secrets(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::MessageQueue {
            return Ok(false);
        }
        let Some(auth) = mq_auth_object_mut(config.external_config.as_mut()) else {
            return Ok(false);
        };

        let needs_rewrite = match mq_auth_kind(auth) {
            Some("token") => hydrate_mq_json_secret(self, connection_id, MQ_AUTH_TOKEN_KEY, auth, "token").await?,
            Some("basic") => {
                hydrate_mq_json_secret(self, connection_id, MQ_AUTH_PASSWORD_KEY, auth, "password").await?
            }
            Some(kind) if is_api_key_auth_kind(kind) => {
                hydrate_mq_json_secret(self, connection_id, MQ_AUTH_API_KEY_VALUE_KEY, auth, "value").await?
            }
            Some("oauth2") => {
                hydrate_mq_json_secret(self, connection_id, MQ_AUTH_CLIENT_SECRET_KEY, auth, "clientSecret").await?
            }
            _ => false,
        };

        Ok(needs_rewrite)
    }

    async fn hydrate_mqtt_auth_secret(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::Mqtt {
            return Ok(false);
        }
        let Some(auth) = config.external_config.as_mut().and_then(|external| external.get_mut("auth")) else {
            return Ok(false);
        };
        let Some(auth) = auth.as_object_mut() else {
            return Ok(false);
        };
        if auth.get("kind").and_then(serde_json::Value::as_str) != Some("password") {
            return Ok(false);
        }
        hydrate_mq_json_secret(self, connection_id, MQTT_AUTH_PASSWORD_KEY, auth, "password").await
    }

    async fn hydrate_mq_token_signing_secret(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::MessageQueue {
            return Ok(false);
        }
        let Some(signing) = mq_token_signing_object_mut(config.external_config.as_mut()) else {
            return Ok(false);
        };

        hydrate_mq_json_secret(self, connection_id, MQ_TOKEN_SIGNING_KEY, signing, "key").await
    }

    async fn hydrate_nacos_auth_secret(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::Nacos {
            return Ok(false);
        }
        if !config.save_password {
            let primary_needs_rewrite = nacos_auth_object(config.external_config.as_ref())
                .filter(|auth| auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword"))
                .and_then(|auth| auth.get("password").and_then(serde_json::Value::as_str))
                .is_some_and(|password| !password.is_empty());
            let console_needs_rewrite = nacos_console_auth_object(config.external_config.as_ref())
                .filter(|auth| auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword"))
                .and_then(|auth| auth.get("password").and_then(serde_json::Value::as_str))
                .is_some_and(|password| !password.is_empty());
            scrub_nacos_auth_secrets(config);

            let connection_id = connection_id.to_string();
            let key_prefix = format!("{NACOS_AUTH_SECRET_PREFIX}%");
            self.with_conn(move |conn| {
                conn.execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key LIKE ?2",
                    params![connection_id, key_prefix],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await?;

            return Ok(primary_needs_rewrite || console_needs_rewrite);
        }
        let mut rewritten = false;
        if let Some(auth) = nacos_auth_object_mut(config.external_config.as_mut()) {
            if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
                rewritten |=
                    hydrate_mq_json_secret(self, connection_id, NACOS_AUTH_PASSWORD_KEY, auth, "password").await?;
            }
        }
        if let Some(auth) = nacos_console_auth_object_mut(config.external_config.as_mut()) {
            if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
                rewritten |=
                    hydrate_mq_json_secret(self, connection_id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY, auth, "password")
                        .await?;
            }
        }
        Ok(rewritten)
    }

    async fn hydrate_cassandra_tls_secrets(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::Cassandra {
            return Ok(false);
        }
        let Some(tls) = cassandra_tls_object_mut(config.external_config.as_mut()) else {
            return Ok(false);
        };
        let truststore_rewrite =
            hydrate_mq_json_secret(self, connection_id, CASSANDRA_TRUSTSTORE_PASSWORD_KEY, tls, "truststore_password")
                .await?;
        let keystore_rewrite =
            hydrate_mq_json_secret(self, connection_id, CASSANDRA_KEYSTORE_PASSWORD_KEY, tls, "keystore_password")
                .await?;
        Ok(truststore_rewrite || keystore_rewrite)
    }

    async fn hydrate_salesforce_auth_secrets(
        &self,
        connection_id: &str,
        config: &mut ConnectionConfig,
    ) -> Result<bool, String> {
        if config.db_type != DatabaseType::Salesforce {
            return Ok(false);
        }
        let Some(auth) = salesforce_auth_object_mut(config.external_config.as_mut()) else {
            return Ok(false);
        };
        let client_secret_rewrite =
            hydrate_mq_json_secret(self, connection_id, SALESFORCE_AUTH_CLIENT_SECRET_KEY, auth, "clientSecret")
                .await?;
        let refresh_token_rewrite =
            hydrate_mq_json_secret(self, connection_id, SALESFORCE_AUTH_REFRESH_TOKEN_KEY, auth, "refreshToken")
                .await?;
        let password_rewrite =
            hydrate_mq_json_secret(self, connection_id, SALESFORCE_AUTH_PASSWORD_KEY, auth, "password").await?;
        Ok(client_secret_rewrite || refresh_token_rewrite || password_rewrite)
    }
}

// Saved SQL

impl Storage {
    pub async fn replace_saved_sql_library(&self, library: &SavedSqlLibrary) -> Result<(), String> {
        let library = library.clone();
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM saved_sql_files", []).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM saved_sql_folders", []).map_err(|e| e.to_string())?;

            for folder in &library.folders {
                tx.execute(
                    "INSERT INTO saved_sql_folders (id, connection_id, parent_folder_id, name, order_index, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        folder.id,
                        folder.connection_id,
                        folder.parent_folder_id,
                        folder.name,
                        folder.order_index,
                        folder.created_at,
                        folder.updated_at
                    ],
                )
                .map_err(|e| e.to_string())?;
            }

            for file in &library.files {
                tx.execute(
                    "INSERT INTO saved_sql_files \
                     (id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        file.id,
                        file.connection_id,
                        file.folder_id,
                        file.name,
                        file.database,
                        file.catalog,
                        file.schema,
                        file.sql,
                        file.order_index,
                        file.open_count,
                        file.opened_at,
                        file.created_at,
                        file.updated_at
                    ],
                )
                .map_err(|e| e.to_string())?;
            }

            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_saved_sql_library(&self) -> Result<SavedSqlLibrary, String> {
        self.with_conn(|conn| {
            let mut folder_stmt = conn
                .prepare(
                    "SELECT id, connection_id, parent_folder_id, name, order_index, created_at, updated_at \
                     FROM saved_sql_folders ORDER BY COALESCE(parent_folder_id, ''), order_index, connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let folders = folder_stmt
                .query_map([], |row| {
                    Ok(SavedSqlFolder {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        parent_folder_id: row.get(2)?,
                        name: row.get(3)?,
                        order_index: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut file_stmt = conn
                .prepare(
                    "SELECT id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at \
                     FROM saved_sql_files ORDER BY COALESCE(folder_id, ''), order_index, connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let files = file_stmt
                .query_map([], |row| {
                    Ok(SavedSqlFile {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        folder_id: row.get(2)?,
                        name: row.get(3)?,
                        database: row.get(4)?,
                        catalog: row.get(5)?,
                        schema: row.get(6)?,
                        sql: row.get(7)?,
                        sql_loaded: true,
                        order_index: row.get(8)?,
                        open_count: row.get(9)?,
                        opened_at: row.get(10)?,
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(SavedSqlLibrary { folders, files })
        })
        .await
    }

    pub async fn load_saved_sql_files_for_sync(&self) -> Result<Vec<SavedSqlFile>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at \
                     FROM saved_sql_files ORDER BY COALESCE(folder_id, ''), order_index, connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let files = stmt
                .query_map([], |row| {
                    Ok(SavedSqlFile {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        folder_id: row.get(2)?,
                        name: row.get(3)?,
                        database: row.get(4)?,
                        catalog: row.get(5)?,
                        schema: row.get(6)?,
                        sql: row.get(7)?,
                        sql_loaded: true,
                        order_index: row.get(8)?,
                        open_count: row.get(9)?,
                        opened_at: row.get(10)?,
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(files)
        })
        .await
    }

    pub async fn load_saved_sql_library_summary(&self) -> Result<SavedSqlLibrary, String> {
        self.with_conn(|conn| {
            let mut folder_stmt = conn
                .prepare(
                    "SELECT id, connection_id, parent_folder_id, name, order_index, created_at, updated_at \
                     FROM saved_sql_folders ORDER BY COALESCE(parent_folder_id, ''), order_index, connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let folders = folder_stmt
                .query_map([], |row| {
                    Ok(SavedSqlFolder {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        parent_folder_id: row.get(2)?,
                        name: row.get(3)?,
                        order_index: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut file_stmt = conn
                .prepare(
                    "SELECT id, connection_id, folder_id, name, database_name, catalog_name, schema_name, order_index, open_count, opened_at, created_at, updated_at \
                     FROM saved_sql_files ORDER BY COALESCE(folder_id, ''), order_index, connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let files = file_stmt
                .query_map([], |row| {
                    Ok(SavedSqlFile {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        folder_id: row.get(2)?,
                        name: row.get(3)?,
                        database: row.get(4)?,
                        catalog: row.get(5)?,
                        schema: row.get(6)?,
                        sql: String::new(),
                        sql_loaded: false,
                        order_index: row.get(7)?,
                        open_count: row.get(8)?,
                        opened_at: row.get(9)?,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(SavedSqlLibrary { folders, files })
        })
        .await
    }

    pub async fn load_saved_sql_file(&self, id: &str) -> Result<Option<SavedSqlFile>, String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at \
                     FROM saved_sql_files WHERE id = ?1",
                )
                .map_err(|e| e.to_string())?;
            match stmt.query_row([id], |row| {
                Ok(SavedSqlFile {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    folder_id: row.get(2)?,
                    name: row.get(3)?,
                    database: row.get(4)?,
                    catalog: row.get(5)?,
                    schema: row.get(6)?,
                    sql: row.get(7)?,
                    sql_loaded: true,
                    order_index: row.get(8)?,
                    open_count: row.get(9)?,
                    opened_at: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            }) {
                Ok(file) => Ok(Some(file)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(err) => Err(err.to_string()),
            }
        })
        .await
    }

    pub async fn save_saved_sql_folder(&self, folder: &SavedSqlFolder) -> Result<(), String> {
        let folder = folder.clone();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO saved_sql_folders (id, connection_id, parent_folder_id, name, order_index, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 connection_id = excluded.connection_id, \
                 parent_folder_id = excluded.parent_folder_id, \
                 name = excluded.name, \
                 order_index = excluded.order_index, \
                 updated_at = excluded.updated_at",
                params![
                    folder.id,
                    folder.connection_id,
                    folder.parent_folder_id,
                    folder.name,
                    folder.order_index,
                    folder.created_at,
                    folder.updated_at
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_saved_sql_folder(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            let mut folder_ids = vec![id.clone()];
            let mut index = 0;
            while index < folder_ids.len() {
                let parent_id = folder_ids[index].clone();
                let mut stmt = tx
                    .prepare("SELECT id FROM saved_sql_folders WHERE parent_folder_id = ?1")
                    .map_err(|e| e.to_string())?;
                let child_ids = stmt
                    .query_map([parent_id.as_str()], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                folder_ids.extend(child_ids);
                index += 1;
            }
            for folder_id in folder_ids.iter().rev() {
                tx.execute("DELETE FROM saved_sql_files WHERE folder_id = ?1", [folder_id.as_str()])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM saved_sql_folders WHERE id = ?1", [folder_id.as_str()])
                    .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_saved_sql_file(&self, file: &SavedSqlFile) -> Result<(), String> {
        let file = file.clone();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO saved_sql_files \
                 (id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 connection_id = excluded.connection_id, \
                 folder_id = excluded.folder_id, \
                 name = excluded.name, \
                 database_name = excluded.database_name, \
                 catalog_name = excluded.catalog_name, \
                 schema_name = excluded.schema_name, \
                 sql_text = CASE WHEN ?14 THEN excluded.sql_text ELSE saved_sql_files.sql_text END, \
                 order_index = excluded.order_index, \
                 open_count = excluded.open_count, \
                 opened_at = excluded.opened_at, \
                 updated_at = excluded.updated_at",
                params![
                    file.id,
                    file.connection_id,
                    file.folder_id,
                    file.name,
                    file.database,
                    file.catalog,
                    file.schema,
                    file.sql,
                    file.order_index,
                    file.open_count,
                    file.opened_at,
                    file.created_at,
                    file.updated_at,
                    file.sql_loaded
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_saved_sql_file(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM saved_sql_files WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
        })
        .await
    }
}

// Secrets

impl Storage {
    pub async fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
        let connection_id = connection_id.to_string();
        let key = key.to_string();
        let result = self
            .with_conn({
                let connection_id = connection_id.clone();
                let key = key.clone();
                move |conn| {
                    conn.query_row(
                        "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                        params![connection_id, key],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                    )
                    .optional()
                    .map_err(|e| e.to_string())
                }
            })
            .await?;
        let Some((legacy, encrypted)) = result else {
            return Ok(None);
        };
        if let Some(encrypted) = encrypted.filter(|value| !value.is_empty()) {
            return self.secret_codec(false)?.decrypt(&connection_id, &key, &encrypted).map(Some);
        }
        if !legacy.is_empty() {
            // Read old plaintext rows during migration and opportunistically
            // rewrite them in the new envelope format.
            self.set_secret(&connection_id, &key, &legacy).await?;
            return Ok(Some(legacy));
        }
        Ok(None)
    }

    pub async fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        let key = key.to_string();
        let secret = secret.to_string();
        let codec = if secret.is_empty() { None } else { Some(self.secret_codec_for_write(true).await?) };
        self.with_conn(move |conn| {
            if secret.is_empty() {
                conn.execute(
                    "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                    params![connection_id, key],
                ).map_err(|e| e.to_string())?;
                return Ok(());
            }
            let encrypted = codec
                .as_ref()
                .ok_or_else(|| "KEY_PROVIDER_UNAVAILABLE".to_string())?
                .encrypt(&connection_id, &key, &secret)?;
            conn.execute(
                "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, ?, '', ?)",
                params![connection_id, key, encrypted],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        let key = key.to_string();
        self.with_conn(move |conn| {
            conn.execute(
                "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                params![connection_id, key],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_secret_prefix(&self, connection_id: &str, key_prefix: &str) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        let key_prefix = key_prefix.to_string();
        self.with_conn(move |conn| {
            let like = format!("{key_prefix}%");
            conn.execute(
                "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key LIKE ?2",
                params![connection_id, like],
            )
            .map(|_| ())
            .map_err(|error| error.to_string())
        })
        .await
    }
}

// MQ token records

#[cfg(feature = "mq-admin")]
impl Storage {
    pub async fn save_mq_token_record(&self, record: &crate::mq::MqTokenRecord) -> Result<(), String> {
        let record = record.clone();
        self.with_conn(move |conn| {
            let scope_json = record
                .scope
                .as_ref()
                .map(serde_json::to_string)
                .transpose()
                .map_err(|e| e.to_string())?;
            let actions_json = serde_json::to_string(&record.actions).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO mq_token_records \
                 (id, connection_id, subject, algorithm, token_fingerprint, scope_json, actions_json, expires_at, created_at, note) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    record.id,
                    record.connection_id,
                    record.subject,
                    record.algorithm.as_str(),
                    record.token_fingerprint,
                    scope_json,
                    actions_json,
                    record.expires_at,
                    record.created_at,
                    record.note
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_mq_token_records(
        &self,
        connection_id: &str,
        subject: Option<&str>,
    ) -> Result<Vec<crate::mq::MqTokenRecord>, String> {
        let connection_id = connection_id.to_string();
        let subject = subject.map(str::to_string);
        self.with_conn(move |conn| {
            let sql = if subject.is_some() {
                "SELECT id, connection_id, subject, algorithm, token_fingerprint, scope_json, actions_json, expires_at, created_at, note \
                 FROM mq_token_records WHERE connection_id = ?1 AND subject = ?2 ORDER BY created_at DESC"
            } else {
                "SELECT id, connection_id, subject, algorithm, token_fingerprint, scope_json, actions_json, expires_at, created_at, note \
                 FROM mq_token_records WHERE connection_id = ?1 ORDER BY created_at DESC"
            };
            let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
            let rows = if let Some(subject) = subject {
                stmt.query_map(params![connection_id, subject], mq_token_record_from_row)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            } else {
                stmt.query_map(params![connection_id], mq_token_record_from_row)
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
            };
            Ok(rows)
        })
        .await
    }
}

// Layout

impl Storage {
    pub async fn save_sidebar_layout(&self, layout: &serde_json::Value) -> Result<(), String> {
        let json = serde_json::to_string(layout).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute("INSERT OR REPLACE INTO sidebar_layout (id, layout_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_sidebar_layout(&self) -> Result<Option<serde_json::Value>, String> {
        let json: Option<String> = self
            .with_conn(|conn| {
                conn.query_row("SELECT layout_json FROM sidebar_layout WHERE id = 1", [], |row| row.get(0))
                    .optional()
                    .map_err(|e| e.to_string())
            })
            .await?;
        json.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string())).transpose()
    }

    pub async fn save_table_vgroups(&self, scope_key: &str, layout: &serde_json::Value) -> Result<(), String> {
        let scope_key = scope_key.to_string();
        let json = serde_json::to_string(layout).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO table_vgroups (scope_key, layout_json) VALUES (?1, ?2)",
                params![scope_key, json],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_table_vgroups(&self) -> Result<serde_json::Value, String> {
        self.with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT scope_key, layout_json FROM table_vgroups").map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut layouts = serde_json::Map::new();
            for row in rows {
                let (scope_key, json) = row.map_err(|e| e.to_string())?;
                match serde_json::from_str::<serde_json::Value>(&json) {
                    Ok(layout) => {
                        layouts.insert(scope_key, layout);
                    }
                    Err(e) => warn!("Failed to deserialize table vgroups for scope {scope_key}: {e}"),
                }
            }
            Ok(serde_json::Value::Object(layouts))
        })
        .await
    }

    /// 删除连接时清理其名下全部表分组布局（scope_key 前缀 = `{connectionId}\u{0}`）。
    pub async fn delete_table_vgroups_for_connection(&self, connection_id: &str) -> Result<(), String> {
        // 前缀用 instr 做大小写敏感的字节匹配：LIKE 默认大小写不敏感且把 `%`/`_` 当通配符，
        // 会连带删除 id 仅大小写不同或含通配符的连接行。
        let prefix = format!("{connection_id}\u{0}");
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM table_vgroups WHERE instr(scope_key, ?1) = 1", params![prefix])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }
}

// Schema cache

const SCHEMA_CACHE_MAX_TOTAL_BYTES: i64 = 256 * 1024 * 1024;
const SCHEMA_CACHE_MAX_CONNECTION_BYTES: i64 = 64 * 1024 * 1024;
const SCHEMA_CACHE_MAX_ENTRIES: usize = 50_000;
const SCHEMA_CACHE_MAX_AGE_MILLIS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy)]
struct SchemaCachePolicy {
    max_total_bytes: i64,
    max_connection_bytes: i64,
    max_entries: usize,
    max_age_millis: i64,
}

impl Default for SchemaCachePolicy {
    fn default() -> Self {
        Self {
            max_total_bytes: SCHEMA_CACHE_MAX_TOTAL_BYTES,
            max_connection_bytes: SCHEMA_CACHE_MAX_CONNECTION_BYTES,
            max_entries: SCHEMA_CACHE_MAX_ENTRIES,
            max_age_millis: SCHEMA_CACHE_MAX_AGE_MILLIS,
        }
    }
}

fn schema_cache_owner(cache_key: &str) -> &str {
    let mut parts = cache_key.split(':');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("object-ddl" | "object-meta"), Some("v1"), Some(owner)) => owner,
        _ => "",
    }
}

fn delete_oldest_schema_cache_entry(conn: &Connection, owner_id: Option<&str>) -> Result<bool, String> {
    let deleted = match owner_id {
        Some(owner_id) => conn.execute(
            "DELETE FROM schema_cache
             WHERE cache_key = (
                 SELECT cache_key FROM schema_cache WHERE owner_id = ?1
                 ORDER BY last_accessed_at_ms ASC, updated_at_ms ASC, cache_key ASC LIMIT 1
             )",
            [owner_id],
        ),
        None => conn.execute(
            "DELETE FROM schema_cache
             WHERE cache_key = (
                 SELECT cache_key FROM schema_cache
                 ORDER BY last_accessed_at_ms ASC, updated_at_ms ASC, cache_key ASC LIMIT 1
             )",
            [],
        ),
    }
    .map_err(|error| error.to_string())?;
    Ok(deleted > 0)
}

fn prune_schema_cache(conn: &Connection, policy: SchemaCachePolicy, now_ms: i64) -> Result<(), String> {
    let expires_before = now_ms.saturating_sub(policy.max_age_millis.max(0));
    conn.execute("DELETE FROM schema_cache WHERE updated_at_ms = 0 OR updated_at_ms <= ?1", [expires_before])
        .map_err(|error| error.to_string())?;

    loop {
        let over_budget_owner: Option<String> = conn
            .query_row(
                "SELECT owner_id FROM schema_cache
                 GROUP BY owner_id
                 HAVING SUM(byte_size) > ?1
                 ORDER BY SUM(byte_size) DESC, owner_id ASC
                 LIMIT 1",
                [policy.max_connection_bytes.max(0)],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(owner_id) = over_budget_owner else {
            break;
        };
        if !delete_oldest_schema_cache_entry(conn, Some(&owner_id))? {
            break;
        }
    }

    loop {
        let (entry_count, total_bytes): (i64, i64) = conn
            .query_row("SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM schema_cache", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|error| error.to_string())?;
        if entry_count <= policy.max_entries as i64 && total_bytes <= policy.max_total_bytes.max(0) {
            break;
        }
        if !delete_oldest_schema_cache_entry(conn, None)? {
            break;
        }
    }
    Ok(())
}

impl Storage {
    pub async fn save_schema_cache(&self, cache_key: &str, payload: &serde_json::Value) -> Result<(), String> {
        self.save_schema_cache_with_policy(cache_key, payload, SchemaCachePolicy::default()).await
    }

    async fn save_schema_cache_with_policy(
        &self,
        cache_key: &str,
        payload: &serde_json::Value,
        policy: SchemaCachePolicy,
    ) -> Result<(), String> {
        let cache_key = cache_key.to_string();
        let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        let byte_size = json.len().min(i64::MAX as usize) as i64;
        let owner_id = schema_cache_owner(&cache_key).to_string();
        let now_ms = unix_timestamp_millis();
        self.with_conn(move |conn| {
            let transaction =
                conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "INSERT INTO schema_cache (
                         cache_key, payload_json, updated_at, updated_at_ms, last_accessed_at_ms, byte_size, owner_id
                     ) VALUES (?1, ?2, datetime('now'), ?3, ?3, ?4, ?5)
                     ON CONFLICT(cache_key) DO UPDATE SET
                         payload_json = excluded.payload_json,
                         updated_at = excluded.updated_at,
                         updated_at_ms = excluded.updated_at_ms,
                         last_accessed_at_ms = excluded.last_accessed_at_ms,
                         byte_size = excluded.byte_size,
                         owner_id = excluded.owner_id",
                    params![cache_key, json, now_ms, byte_size, owner_id],
                )
                .map_err(|error| error.to_string())?;
            prune_schema_cache(&transaction, policy, now_ms)?;
            transaction.commit().map_err(|error| error.to_string())
        })
        .await
    }

    pub async fn load_schema_cache(&self, cache_key: &str) -> Result<Option<serde_json::Value>, String> {
        let cache_key = cache_key.to_string();
        let now_ms = unix_timestamp_millis();
        let json: Option<String> = self
            .with_conn(move |conn| {
                let transaction = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
                let json = transaction
                    .query_row(
                        "SELECT payload_json FROM schema_cache
                         WHERE cache_key = ?1 AND updated_at_ms > ?2",
                        params![cache_key, now_ms.saturating_sub(SCHEMA_CACHE_MAX_AGE_MILLIS.max(0))],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|error| error.to_string())?;
                if json.is_some() {
                    transaction
                        .execute(
                            "UPDATE schema_cache SET last_accessed_at_ms = ?2 WHERE cache_key = ?1",
                            params![cache_key, now_ms],
                        )
                        .map_err(|error| error.to_string())?;
                }
                transaction.commit().map_err(|error| error.to_string())?;
                Ok(json)
            })
            .await?;
        json.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string())).transpose()
    }

    pub async fn delete_schema_cache_prefix(&self, prefix: &str) -> Result<(), String> {
        let prefix = prefix.to_string();
        let prefix_len = prefix.len() as i64;
        self.with_conn(move |conn| {
            conn.execute(
                "DELETE FROM schema_cache WHERE cache_key = ?1 OR substr(cache_key, 1, ?2) = ?3",
                params![prefix.clone(), prefix_len, prefix],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    // State persistence store (CAS-aware key-value store for state machines)

    pub async fn save_state(&self, key: &str, value: &[u8], content_type: &str) -> Result<(), String> {
        let key = key.to_string();
        let value = value.to_vec();
        let content_type = content_type.to_string();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO state_store (key, value, content_type, version, payload) \
                 VALUES (?1, ?2, ?3, 1, x'') \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, content_type = excluded.content_type, \
                 version = version + 1, payload = excluded.payload",
                params![key, value, content_type],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_state(&self, key: &str) -> Result<Option<(Vec<u8>, String)>, String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            let mut stmt = conn
                .prepare("SELECT value, content_type FROM state_store WHERE key = ?1")
                .map_err(|e| e.to_string())?;
            let result: Option<(Vec<u8>, String)> = stmt
                .query_row(params![key], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(result)
        })
        .await
    }

    pub async fn delete_state(&self, key: &str) -> Result<(), String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM state_store WHERE key = ?1", params![key]).map(|_| ()).map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn state_exists(&self, key: &str) -> Result<bool, String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            let exists: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM state_store WHERE key = ?1)", params![key], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            Ok(exists)
        })
        .await
    }

    pub async fn get_state_version(&self, key: &str) -> Result<Option<u64>, String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            conn.prepare("SELECT version FROM state_store WHERE key = ?1")
                .and_then(|mut stmt| stmt.query_row(params![key], |row| row.get(0)).optional())
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn compare_and_swap_state(
        &self,
        key: &str,
        expected_version: Option<u64>,
        new_value: &[u8],
        content_type: &str,
    ) -> Result<bool, String> {
        let key = key.to_string();
        let new_value = new_value.to_vec();
        let content_type = content_type.to_string();
        self.with_conn(move |conn| {
            let current: Option<u64> = conn
                .prepare("SELECT version FROM state_store WHERE key = ?1")
                .and_then(|mut stmt| stmt.query_row(params![&key], |row| row.get(0)).optional())
                .map_err(|e| e.to_string())?;

            match (current, expected_version) {
                (None, None) => {
                    conn.execute(
                        "INSERT INTO state_store (key, value, content_type, version, payload) VALUES (?1, ?2, ?3, 1, x'')",
                        params![key, new_value, content_type],
                    )
                    .map(|_| true)
                    .map_err(|e| e.to_string())
                }
                (Some(v), Some(expected)) if v == expected => {
                    conn.execute(
                        "UPDATE state_store SET value = ?1, content_type = ?2, version = version + 1 WHERE key = ?3 AND version = ?4",
                        params![new_value, content_type, key, expected],
                    )
                    .map(|rows| rows > 0)
                    .map_err(|e| e.to_string())
                }
                _ => Ok(false),
            }
        })
        .await
    }
}

// Tab runtime cache

impl Storage {
    pub async fn save_tab_runtime_cache(
        &self,
        key: &str,
        payload: Vec<u8>,
        row_count: i64,
        column_count: i64,
        owner_id: Option<String>,
    ) -> Result<(), String> {
        let key = key.to_string();
        let byte_size = payload.len() as i64;
        let now = unix_timestamp_millis();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO tab_runtime_cache \
                 (cache_key, payload, row_count, column_count, byte_size, updated_at, created_at, last_accessed_at, owner_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6, ?6, ?7) \
                 ON CONFLICT(cache_key) DO UPDATE SET \
                 payload = excluded.payload, row_count = excluded.row_count, column_count = excluded.column_count, \
                 byte_size = excluded.byte_size, updated_at = excluded.updated_at, \
                 last_accessed_at = excluded.last_accessed_at, owner_id = excluded.owner_id",
                params![key, payload, row_count, column_count, byte_size, now, owner_id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_tab_runtime_cache(&self, key: &str) -> Result<Option<TabRuntimeCacheEntry>, String> {
        let key = key.to_string();
        let now = unix_timestamp_millis();
        self.with_conn(move |conn| {
            let entry = conn
                .query_row(
                "SELECT cache_key, payload, row_count, column_count, byte_size, updated_at, created_at, last_accessed_at, owner_id \
                 FROM tab_runtime_cache WHERE cache_key = ?1",
                [&key],
                |row| {
                    Ok(TabRuntimeCacheEntry {
                        key: row.get(0)?,
                        payload: row.get(1)?,
                        row_count: row.get(2)?,
                        column_count: row.get(3)?,
                        byte_size: row.get(4)?,
                        updated_at: row.get(5)?,
                        created_at: row.get(6)?,
                        last_accessed_at: now,
                        owner_id: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
            if entry.is_some() {
                conn.execute(
                    "UPDATE tab_runtime_cache SET last_accessed_at = ?2 WHERE cache_key = ?1",
                    params![key, now],
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(entry)
        })
        .await
    }

    pub async fn list_tab_runtime_cache_metadata(&self) -> Result<Vec<TabRuntimeCacheMetadata>, String> {
        self.with_conn(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT cache_key, row_count, column_count, byte_size, updated_at, created_at, last_accessed_at, owner_id \
                     FROM tab_runtime_cache ORDER BY last_accessed_at ASC, cache_key ASC",
                )
                .map_err(|e| e.to_string())?;
            let metadata = statement
                .query_map([], |row| {
                    Ok(TabRuntimeCacheMetadata {
                        key: row.get(0)?,
                        row_count: row.get(1)?,
                        column_count: row.get(2)?,
                        byte_size: row.get(3)?,
                        updated_at: row.get(4)?,
                        created_at: row.get(5)?,
                        last_accessed_at: row.get(6)?,
                        owner_id: row.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(metadata)
        })
        .await
    }

    pub async fn prune_tab_runtime_cache(
        &self,
        live_keys: Vec<String>,
        max_bytes: i64,
        orphan_grace_ms: i64,
        max_age_ms: Option<i64>,
    ) -> Result<TabRuntimeCachePruneResult, String> {
        let now = unix_timestamp_millis();
        self.with_conn(move |conn| {
            let live_keys: HashSet<String> = live_keys.into_iter().collect();
            let mut statement = conn
                .prepare(
                    "SELECT cache_key, byte_size, created_at, last_accessed_at \
                     FROM tab_runtime_cache ORDER BY last_accessed_at ASC, cache_key ASC",
                )
                .map_err(|e| e.to_string())?;
            let entries = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(statement);

            let mut total_bytes = entries.iter().map(|(_, bytes, _, _)| *bytes).sum::<i64>();
            let mut deleted = HashSet::new();
            let mut orphan_deletions = 0usize;
            for (key, bytes, created_at, last_accessed_at) in &entries {
                if live_keys.contains(key) {
                    continue;
                }
                let orphan_expired = now.saturating_sub(*created_at) >= orphan_grace_ms.max(0);
                let age_expired =
                    max_age_ms.is_some_and(|max_age| now.saturating_sub(*last_accessed_at) >= max_age.max(0));
                if orphan_expired || age_expired {
                    deleted.insert(key.clone());
                    total_bytes = total_bytes.saturating_sub(*bytes);
                    if orphan_expired {
                        orphan_deletions += 1;
                    }
                }
            }

            for (key, bytes, _, _) in &entries {
                if total_bytes <= max_bytes.max(0) {
                    break;
                }
                if live_keys.contains(key) || deleted.contains(key) {
                    continue;
                }
                deleted.insert(key.clone());
                total_bytes = total_bytes.saturating_sub(*bytes);
            }

            let deleted_bytes =
                entries.iter().filter(|(key, _, _, _)| deleted.contains(key)).map(|(_, bytes, _, _)| *bytes).sum();
            let transaction =
                conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            for key in &deleted {
                transaction
                    .execute("DELETE FROM tab_runtime_cache WHERE cache_key = ?1", [key])
                    .map_err(|e| e.to_string())?;
            }
            transaction.commit().map_err(|e| e.to_string())?;
            Ok(TabRuntimeCachePruneResult {
                deleted_entries: deleted.len(),
                deleted_bytes,
                orphan_deletions,
                remaining_entries: entries.len().saturating_sub(deleted.len()),
                remaining_bytes: total_bytes,
            })
        })
        .await
    }

    pub async fn delete_tab_runtime_cache_owner(&self, owner_id: &str) -> Result<usize, String> {
        let owner_id = owner_id.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM tab_runtime_cache WHERE owner_id = ?1", [owner_id]).map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_tab_runtime_cache(&self, key: &str) -> Result<(), String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM tab_runtime_cache WHERE cache_key = ?1", [key])
                .map(|_| ())
                .map_err(|e| e.to_string())
        })
        .await
    }
}

// JSON migration

impl Storage {
    pub async fn migrate_from_json(&self, data_dir: &Path) -> Result<(), String> {
        self.migrate_from_json_with_finalize(data_dir, true).await
    }

    async fn migrate_from_json_staged(&self, data_dir: &Path) -> Result<(), String> {
        self.migrate_from_json_with_finalize(data_dir, false).await
    }

    async fn migrate_from_json_with_finalize(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        self.migrate_connections_json(data_dir, finalize).await?;
        self.migrate_secrets_json(data_dir, finalize).await?;
        self.migrate_history_json(data_dir, finalize).await?;
        self.migrate_ai_config_json(data_dir, finalize).await?;
        self.migrate_ai_conversations_json(data_dir, finalize).await?;
        self.migrate_sidebar_layout_json(data_dir, finalize).await?;
        Ok(())
    }

    async fn migrate_connections_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("connections.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let configs: Vec<ConnectionConfig> = serde_json::from_str(&json)
            .map_err(|error| format!("Failed to parse legacy connections.json; original file was kept: {error}"))?;
        // Route legacy hydrated configs through the same sanitized/encrypted
        // persistence path as normal saves.  Inserting the old JSON directly
        // would briefly reintroduce plaintext credentials into dbx.db.
        let codec = self.secret_codec_for_write(true).await?;
        self.with_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
            for config in &configs {
                let exists: bool = tx
                    .query_row("SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)", [&config.id], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                if !exists {
                    persist_connection_in_tx(&tx, &codec, config)?;
                }
            }
            tx.commit().map_err(|e| e.to_string())
        })
        .await?;
        if finalize {
            tokio::fs::rename(&path, data_dir.join("connections.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn migrate_secrets_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("secrets.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let secrets: HashMap<String, String> = serde_json::from_str(&json)
            .map_err(|error| format!("Failed to parse legacy secrets.json; original file was kept: {error}"))?;
        for (key, secret) in &secrets {
            let parts: Vec<&str> = key.splitn(3, ':').collect();
            if parts.len() == 3 && parts[0] == "connection" {
                let connection_id = parts[1].to_string();
                let field = parts[2].to_string();
                let secret = secret.clone();
                // Legacy JSON files contain plaintext values.  Route them
                // through the same encrypted writer used by normal saves;
                // never copy the old value directly into SQLite.
                if self.get_secret(&connection_id, &field).await?.is_none() {
                    self.set_secret(&connection_id, &field, &secret).await?;
                }
            }
        }
        if finalize {
            tokio::fs::rename(&path, data_dir.join("secrets.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn migrate_history_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("query_history.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let entries: Vec<HistoryEntry> = serde_json::from_str(&json)
            .map_err(|error| format!("Failed to parse legacy query_history.json; original file was kept: {error}"))?;
        for entry in &entries {
            self.save_history_entry(entry).await?;
        }
        if finalize {
            tokio::fs::rename(&path, data_dir.join("query_history.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn migrate_ai_config_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("ai_config.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let count: i64 = self
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM ai_config", [], |row| row.get(0)).map_err(|e| e.to_string())
            })
            .await?;
        if count == 0 {
            // Parse and save through the split/secrets path instead of copying
            // the legacy hydrated JSON into the database.
            let config = serde_json::from_str::<AiConfig>(&json)
                .map_err(|error| format!("Failed to parse legacy ai_config.json; original file was kept: {error}"))?;
            self.save_ai_config(&config).await?;
        }
        if finalize {
            tokio::fs::rename(&path, data_dir.join("ai_config.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn migrate_ai_conversations_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("ai_conversations.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let conversations: Vec<AiConversation> = serde_json::from_str(&json).map_err(|error| {
            format!("Failed to parse legacy ai_conversations.json; original file was kept: {error}")
        })?;
        for conv in &conversations {
            let conv = conv.clone();
            let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
            self.with_conn(move |conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO ai_conversations \
                     (id, title, connection_name, connection_id, database, schema_name, messages_json, created_at, updated_at, plugin_context_json) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        conv.id,
                        conv.title,
                        conv.connection_name,
                        conv.connection_id,
                        conv.database,
                        conv.schema,
                        messages_json,
                        conv.created_at,
                        conv.updated_at,
                        conv.plugin_context.map(|value| value.to_string())
                    ],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await?;
        }
        // Rows just imported predate the binding column (or carry a binding from
        // a newer JSON export); bind the ones the stored name identifies
        // unambiguously now, since `init_schema` already ran its pass (#9902).
        self.with_conn(|conn| backfill_ai_conversation_connections(conn).map(|_| ())).await?;
        if finalize {
            tokio::fs::rename(&path, data_dir.join("ai_conversations.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    async fn migrate_sidebar_layout_json(&self, data_dir: &Path, finalize: bool) -> Result<(), String> {
        let path = data_dir.join("sidebar_layout.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&json)
            .map_err(|error| format!("Failed to parse legacy sidebar_layout.json; original file was kept: {error}"))?;
        let count: i64 = self
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM sidebar_layout", [], |row| row.get(0)).map_err(|e| e.to_string())
            })
            .await?;
        if count == 0 {
            self.with_conn(move |conn| {
                conn.execute("INSERT OR IGNORE INTO sidebar_layout (id, layout_json) VALUES (1, ?1)", [json])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await?;
        }
        if finalize {
            tokio::fs::rename(&path, data_dir.join("sidebar_layout.json.bak")).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn persist_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    connection_id: &str,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2", params![connection_id, key])
            .map_err(|e| e.to_string())?;
    } else {
        let encrypted = codec.encrypt(connection_id, key, secret)?;
        tx.execute(
            "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, ?, '', ?)",
            params![connection_id, key, encrypted],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn apply_sync_connections_in_tx(
    tx: &Transaction<'_>,
    codec: &SecretCodec,
    configs: &[ConnectionConfig],
) -> Result<(), String> {
    let replacement_ids = configs.iter().map(|config| config.id.clone()).collect::<HashSet<_>>();
    let mut retained_ids = preserve_unreadable_connections_for_replacement(tx, &replacement_ids)?;
    for config in configs {
        let config = config.canonicalized();
        if !config.save_password {
            persist_secret_in_tx(tx, codec, &config.id, "password", "")?;
            delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
        }
        if let Some(url_params) = &config.url_params {
            if !connection_secret_in_tx_exists(tx, &config.id, URL_PARAMS_SECRET_KEY)? {
                persist_secret_in_tx(tx, codec, &config.id, URL_PARAMS_SECRET_KEY, url_params)?;
            }
        }
        let sanitized = sanitized_connection_config(&config);
        let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config.id, json])
            .map_err(|e| e.to_string())?;
    }
    retained_ids.extend(configs.iter().map(|config| config.id.clone()));
    delete_unreferenced_connection_secrets_in_tx(tx, &retained_ids)
}

fn clear_sync_connection_secrets_in_tx(
    tx: &Transaction<'_>,
    configs: &[ConnectionConfig],
    preserve_plugin_secrets: bool,
) -> Result<(), String> {
    for config in configs {
        if preserve_plugin_secrets {
            tx.execute(
                "DELETE FROM connection_secrets
                 WHERE connection_id = ?1
                   AND key NOT LIKE 'plugin_connection.%'",
                [&config.id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1", [&config.id])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn apply_sync_tunnel_profiles_in_tx(
    tx: &Transaction<'_>,
    codec: &SecretCodec,
    profiles: &[TransportLayerConfig],
    secret_profiles: Option<&[TransportLayerConfig]>,
) -> Result<(), String> {
    let mut existing = HashMap::<String, TransportLayerConfig>::new();
    let mut statement = tx.prepare("SELECT id, config_json FROM tunnel_profiles").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (id, json) = row.map_err(|e| e.to_string())?;
        let mut profile: TransportLayerConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let namespace = format!("{TUNNEL_SECRET_NAMESPACE_PREFIX}{id}");
        if let Some(blob) = get_secret_in_tx(tx, codec, &namespace, CONFIG_SECRET_BLOB_KEY)? {
            let stored: TransportLayerConfig = serde_json::from_str(&blob).map_err(|e| e.to_string())?;
            merge_missing_tunnel_profile_secrets(&mut profile, &stored);
        }
        existing.insert(id, profile);
    }
    drop(statement);

    let mut full_by_id = HashMap::new();
    if let Some(secret_profiles) = secret_profiles {
        for profile in secret_profiles {
            full_by_id.insert(profile.id().to_string(), profile.clone());
        }
    }
    let mut effective = Vec::with_capacity(profiles.len());
    for profile in profiles {
        let (mut profile, has_synced_secrets) = match full_by_id.remove(profile.id()) {
            Some(profile) => (profile, true),
            None => (profile.clone(), false),
        };
        if !has_synced_secrets {
            if let Some(previous) = existing.get(profile.id()) {
                merge_missing_tunnel_profile_secrets(&mut profile, previous);
            }
        }
        effective.push(profile);
    }

    tx.execute("DELETE FROM tunnel_profiles", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM connection_secrets WHERE connection_id LIKE 'tunnel_profile.%'", [])
        .map_err(|e| e.to_string())?;
    for profile in effective {
        let mut sanitized = profile.clone();
        sanitized.scrub_secrets();
        let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
        tx.execute("INSERT INTO tunnel_profiles (id, config_json) VALUES (?1, ?2)", params![profile.id(), json])
            .map_err(|e| e.to_string())?;
        if sanitized != profile {
            persist_secret_in_tx(
                tx,
                codec,
                &format!("{TUNNEL_SECRET_NAMESPACE_PREFIX}{}", profile.id()),
                CONFIG_SECRET_BLOB_KEY,
                &serde_json::to_string(&profile).map_err(|e| e.to_string())?,
            )?;
        }
    }
    Ok(())
}

fn apply_ai_configs_in_tx(tx: &Transaction<'_>, codec: &SecretCodec, configs: &[AiConfigItem]) -> Result<(), String> {
    tx.execute("DELETE FROM ai_configs", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM ai_config", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM ai_provider_configs", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM connection_secrets WHERE connection_id LIKE 'ai_config.%'", [])
        .map_err(|e| e.to_string())?;
    for item in configs {
        let (sanitized, secrets) = split_ai_config_secrets(&item.config)?;
        let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;
        let models_json = serde_json::to_string(&sanitized.models).map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO ai_configs (id, name, model, models, config_json, is_default) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![item.id, item.name, sanitized.model, models_json, json, item.is_default as i32],
        )
        .map_err(|e| e.to_string())?;
        if secrets.as_object().is_some_and(|object| !object.is_empty()) {
            persist_secret_in_tx(
                tx,
                codec,
                &format!("{AI_SECRET_NAMESPACE_PREFIX}{}", item.id),
                CONFIG_SECRET_BLOB_KEY,
                &serde_json::to_string(&secrets).map_err(|e| e.to_string())?,
            )?;
        }
    }
    Ok(())
}

fn update_app_settings_key_in_tx(tx: &Transaction<'_>, key: &str, value: serde_json::Value) -> Result<(), String> {
    let current: Option<String> = tx
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let mut settings = current
        .map(|json| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or_default();
    settings.insert(key.to_string(), value);
    tx.execute(
        "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
        [serde_json::Value::Object(settings).to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn apply_desktop_settings_in_tx(tx: &Transaction<'_>, settings: &DesktopSettings) -> Result<(), String> {
    let mut values = serde_json::Map::new();
    values.insert("show_tray_icon".to_string(), serde_json::Value::Bool(settings.show_tray_icon));
    values.insert("icon_theme".to_string(), serde_json::to_value(settings.icon_theme).map_err(|e| e.to_string())?);
    values.insert("quit_on_close".to_string(), serde_json::Value::Bool(settings.quit_on_close));
    values.insert("close_action_prompted".to_string(), serde_json::Value::Bool(settings.close_action_prompted));
    values.insert("debug_logging_enabled".to_string(), serde_json::Value::Bool(settings.debug_logging_enabled));
    values.insert(
        "metadata_cache_max_memory_mb".to_string(),
        serde_json::Value::Number(serde_json::Number::from(normalize_metadata_cache_max_memory_mb(
            settings.metadata_cache_max_memory_mb,
        ))),
    );
    values.insert(
        "duckdb_worker_process_isolation".to_string(),
        serde_json::Value::Bool(settings.duckdb_worker_process_isolation),
    );
    values.insert(
        "duckdb_worker_max_processes".to_string(),
        serde_json::Value::Number(serde_json::Number::from(normalize_duckdb_worker_max_processes(
            settings.duckdb_worker_max_processes,
        ))),
    );
    values.insert(
        "sidebar_table_page_size".to_string(),
        serde_json::Value::Number(serde_json::Number::from(settings.sidebar_table_page_size)),
    );
    let optional_dirs = [
        ("saved_sql_sync_dir", settings.saved_sql_sync_dir.as_ref()),
        ("driver_store_dir", settings.driver_store_dir.as_ref()),
        ("plugin_store_dir", settings.plugin_store_dir.as_ref()),
        ("agent_store_dir", settings.agent_store_dir.as_ref()),
    ];
    for (key, value) in optional_dirs {
        if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
            values.insert(key.to_string(), serde_json::Value::String(value.clone()));
        } else {
            values.insert(key.to_string(), serde_json::Value::Null);
        }
    }
    let current: Option<String> = tx
        .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let mut merged = current
        .map(|json| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&json).map_err(|e| e.to_string())
        })
        .transpose()?
        .unwrap_or_default();
    for (key, value) in values {
        merged.insert(key, value);
    }
    tx.execute(
        "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
        [serde_json::Value::Object(merged).to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn apply_saved_sql_in_tx(tx: &Transaction<'_>, library: &SavedSqlLibrary) -> Result<(), String> {
    tx.execute("DELETE FROM saved_sql_files", []).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM saved_sql_folders", []).map_err(|e| e.to_string())?;
    for folder in &library.folders {
        tx.execute(
            "INSERT INTO saved_sql_folders (id, connection_id, parent_folder_id, name, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![folder.id, folder.connection_id, folder.parent_folder_id, folder.name, folder.order_index, folder.created_at, folder.updated_at],
        )
        .map_err(|e| e.to_string())?;
    }
    for file in &library.files {
        tx.execute(
            "INSERT INTO saved_sql_files (id, connection_id, folder_id, name, database_name, catalog_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![file.id, file.connection_id, file.folder_id, file.name, file.database, file.catalog, file.schema, file.sql, file.order_index, file.open_count, file.opened_at, file.created_at, file.updated_at],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn persist_mq_auth_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::MessageQueue {
        delete_secret_prefix_in_tx(tx, &config.id, MQ_AUTH_SECRET_PREFIX)?;
        return Ok(());
    }

    let Some(auth) = mq_auth_object(config.external_config.as_ref()) else {
        delete_secret_prefix_in_tx(tx, &config.id, MQ_AUTH_SECRET_PREFIX)?;
        return Ok(());
    };

    match mq_auth_kind(auth) {
        Some("none") => delete_secret_prefix_in_tx(tx, &config.id, MQ_AUTH_SECRET_PREFIX)?,
        Some("token") => replace_mq_auth_secret_in_tx(tx, codec, &config.id, MQ_AUTH_TOKEN_KEY, auth, "token")?,
        Some("basic") => replace_mq_auth_secret_in_tx(tx, codec, &config.id, MQ_AUTH_PASSWORD_KEY, auth, "password")?,
        Some(kind) if is_api_key_auth_kind(kind) => {
            replace_mq_auth_secret_in_tx(tx, codec, &config.id, MQ_AUTH_API_KEY_VALUE_KEY, auth, "value")?
        }
        Some("oauth2") => {
            replace_mq_auth_secret_in_tx(tx, codec, &config.id, MQ_AUTH_CLIENT_SECRET_KEY, auth, "clientSecret")?
        }
        _ => delete_secret_prefix_in_tx(tx, &config.id, MQ_AUTH_SECRET_PREFIX)?,
    }

    Ok(())
}

fn persist_mqtt_auth_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::Mqtt {
        delete_secret_prefix_in_tx(tx, &config.id, MQTT_AUTH_SECRET_PREFIX)?;
        return Ok(());
    }
    let Some(auth) = config.external_config.as_ref().and_then(|external| external.get("auth")) else {
        delete_secret_prefix_in_tx(tx, &config.id, MQTT_AUTH_SECRET_PREFIX)?;
        return Ok(());
    };
    let Some(auth) = auth.as_object() else {
        delete_secret_prefix_in_tx(tx, &config.id, MQTT_AUTH_SECRET_PREFIX)?;
        return Ok(());
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) != Some("password") {
        delete_secret_prefix_in_tx(tx, &config.id, MQTT_AUTH_SECRET_PREFIX)?;
        return Ok(());
    }
    let current = auth.get("password").and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty());
    let existing =
        if current.is_none() { get_secret_in_tx(tx, codec, &config.id, MQTT_AUTH_PASSWORD_KEY)? } else { None };
    delete_secret_prefix_in_tx(tx, &config.id, MQTT_AUTH_SECRET_PREFIX)?;
    if let Some(secret) = current.or(existing.as_deref()) {
        persist_secret_in_tx(tx, codec, &config.id, MQTT_AUTH_PASSWORD_KEY, secret)?;
    }
    Ok(())
}

fn replace_mq_auth_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    let current = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty());
    let existing = if current.is_none() { get_secret_in_tx(tx, codec, connection_id, key)? } else { None };
    delete_secret_prefix_in_tx(tx, connection_id, MQ_AUTH_SECRET_PREFIX)?;
    match current {
        Some(secret) => persist_secret_in_tx(tx, codec, connection_id, key, secret),
        None => match existing {
            Some(secret) => persist_secret_in_tx(tx, codec, connection_id, key, &secret),
            None => Ok(()),
        },
    }
}

fn get_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    connection_id: &str,
    key: &str,
) -> Result<Option<String>, String> {
    let row = tx
        .query_row(
            "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![connection_id, key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((legacy, encrypted)) = row else {
        return Ok(None);
    };
    if let Some(encrypted) = encrypted.filter(|value| !value.is_empty()) {
        return codec.decrypt(connection_id, key, &encrypted).map(Some);
    }
    Ok((!legacy.is_empty()).then_some(legacy))
}

fn persist_mq_token_signing_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::MessageQueue {
        delete_secret_prefix_in_tx(tx, &config.id, MQ_TOKEN_SIGNING_SECRET_PREFIX)?;
        return Ok(());
    }

    let Some(signing) = mq_token_signing_object(config.external_config.as_ref()) else {
        delete_secret_prefix_in_tx(tx, &config.id, MQ_TOKEN_SIGNING_SECRET_PREFIX)?;
        return Ok(());
    };

    persist_json_secret_if_present_in_tx(tx, codec, &config.id, MQ_TOKEN_SIGNING_KEY, signing, "key")
}

fn persist_nacos_auth_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::Nacos || !config.save_password {
        delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
        return Ok(());
    }

    let primary_auth = nacos_auth_object(config.external_config.as_ref())
        .filter(|auth| auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword"));
    let primary = primary_auth
        .and_then(|auth| auth.get("password").and_then(serde_json::Value::as_str))
        .filter(|secret| !secret.is_empty());
    let console_auth = nacos_console_auth_object(config.external_config.as_ref())
        .filter(|auth| auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword"));
    let console = console_auth
        .and_then(|auth| auth.get("password").and_then(serde_json::Value::as_str))
        .filter(|secret| !secret.is_empty());
    let existing_primary = if primary.is_none() && primary_auth.is_some() {
        get_secret_in_tx(tx, codec, &config.id, NACOS_AUTH_PASSWORD_KEY)?
    } else {
        None
    };
    let existing_console = if console.is_none() && console_auth.is_some() {
        get_secret_in_tx(tx, codec, &config.id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY)?
    } else {
        None
    };
    delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
    if let Some(secret) = primary.or(existing_primary.as_deref()) {
        persist_secret_in_tx(tx, codec, &config.id, NACOS_AUTH_PASSWORD_KEY, secret)?;
    }
    if let Some(secret) = console.or(existing_console.as_deref()) {
        persist_secret_in_tx(tx, codec, &config.id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY, secret)?;
    }

    Ok(())
}

fn persist_cassandra_tls_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::Cassandra {
        delete_secret_prefix_in_tx(tx, &config.id, CASSANDRA_TLS_SECRET_PREFIX)?;
        return Ok(());
    }
    let Some(tls) = cassandra_tls_object(config.external_config.as_ref()) else {
        delete_secret_prefix_in_tx(tx, &config.id, CASSANDRA_TLS_SECRET_PREFIX)?;
        return Ok(());
    };
    persist_secret_in_tx(
        tx,
        codec,
        &config.id,
        CASSANDRA_TRUSTSTORE_PASSWORD_KEY,
        tls.get("truststore_password").and_then(serde_json::Value::as_str).unwrap_or(""),
    )?;
    persist_secret_in_tx(
        tx,
        codec,
        &config.id,
        CASSANDRA_KEYSTORE_PASSWORD_KEY,
        tls.get("keystore_password").and_then(serde_json::Value::as_str).unwrap_or(""),
    )
}

fn persist_salesforce_auth_secrets_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    config: &ConnectionConfig,
) -> Result<(), String> {
    if config.db_type != DatabaseType::Salesforce {
        delete_secret_prefix_in_tx(tx, &config.id, SALESFORCE_AUTH_SECRET_PREFIX)?;
        return Ok(());
    }
    let Some(auth) = salesforce_auth_object(config.external_config.as_ref()) else {
        delete_secret_prefix_in_tx(tx, &config.id, SALESFORCE_AUTH_SECRET_PREFIX)?;
        return Ok(());
    };
    replace_salesforce_auth_secret_in_tx(
        tx,
        codec,
        &config.id,
        SALESFORCE_AUTH_CLIENT_SECRET_KEY,
        auth,
        "clientSecret",
    )?;
    replace_salesforce_auth_secret_in_tx(
        tx,
        codec,
        &config.id,
        SALESFORCE_AUTH_REFRESH_TOKEN_KEY,
        auth,
        "refreshToken",
    )?;
    replace_salesforce_auth_secret_in_tx(tx, codec, &config.id, SALESFORCE_AUTH_PASSWORD_KEY, auth, "password")?;
    Ok(())
}

fn replace_salesforce_auth_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    let current = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty());
    let existing = if current.is_none() { get_secret_in_tx(tx, codec, connection_id, key)? } else { None };
    tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2", params![connection_id, key])
        .map_err(|e| e.to_string())?;
    match current {
        Some(secret) => persist_secret_in_tx(tx, codec, connection_id, key, secret),
        None => match existing {
            Some(secret) => persist_secret_in_tx(tx, codec, connection_id, key, &secret),
            None => Ok(()),
        },
    }
}

fn persist_json_secret_if_present_in_tx(
    tx: &rusqlite::Transaction<'_>,
    codec: &SecretCodec,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(secret) = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty()) {
        persist_secret_in_tx(tx, codec, connection_id, key, secret)?;
    }
    Ok(())
}

async fn hydrate_mq_json_secret(
    storage: &Storage,
    connection_id: &str,
    key: &str,
    auth: &mut serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<bool, String> {
    if let Some(secret) = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty()) {
        storage.set_secret(connection_id, key, secret).await?;
        Ok(true)
    } else if let Some(secret) = storage.get_secret(connection_id, key).await? {
        auth.insert(field.to_string(), serde_json::Value::String(secret));
        Ok(false)
    } else {
        Ok(false)
    }
}

fn scrub_json_secret(auth: &mut serde_json::Map<String, serde_json::Value>, field: &str) {
    if auth.contains_key(field) {
        auth.insert(field.to_string(), serde_json::Value::String(String::new()));
    }
}

fn mq_auth_kind(auth: &serde_json::Map<String, serde_json::Value>) -> Option<&str> {
    auth.get("kind").and_then(serde_json::Value::as_str)
}

fn mq_auth_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("auth")?.as_object()
}

fn mq_auth_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("auth")?.as_object_mut()
}

fn mq_token_signing_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("tokenSigning")?.as_object()
}

fn mq_token_signing_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("tokenSigning")?.as_object_mut()
}

fn cassandra_tls_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("tls")?.as_object()
}

fn cassandra_tls_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("tls")?.as_object_mut()
}

fn salesforce_auth_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("auth")?.as_object()
}

fn salesforce_auth_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("auth")?.as_object_mut()
}

fn nacos_auth_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("auth")?.as_object()
}

fn nacos_auth_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("auth")?.as_object_mut()
}

fn nacos_console_auth_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Map<String, serde_json::Value>> {
    value?.get("rnacosConsoleAuth")?.as_object()
}

fn nacos_console_auth_object_mut(
    value: Option<&mut serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    value?.get_mut("rnacosConsoleAuth")?.as_object_mut()
}

fn is_api_key_auth_kind(kind: &str) -> bool {
    matches!(kind, "apiKey" | "api_key" | "apikey")
}

#[cfg(feature = "mq-admin")]
fn mq_token_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::mq::MqTokenRecord> {
    let algorithm: String = row.get(3)?;
    let scope_json: Option<String> = row.get(5)?;
    let actions_json: String = row.get(6)?;
    Ok(crate::mq::MqTokenRecord {
        id: row.get(0)?,
        connection_id: row.get(1)?,
        subject: row.get(2)?,
        algorithm: serde_json::from_value(serde_json::Value::String(algorithm)).map_err(map_from_sql_err)?,
        token_fingerprint: row.get(4)?,
        scope: scope_json.as_deref().map(serde_json::from_str).transpose().map_err(map_from_sql_err)?,
        actions: serde_json::from_str(&actions_json).map_err(map_from_sql_err)?,
        expires_at: row.get(7)?,
        created_at: row.get(8)?,
        note: row.get(9)?,
    })
}

fn map_from_sql_err(err: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
}

#[cfg(test)]
mod tests {
    use super::{
        maybe_import_user_data_db, DataDbImportResult, DesktopIconTheme, DesktopSettings, McpGlobalPolicy,
        McpGlobalPolicyState, Storage, SyncImportPlan, KEEP_TERMINAL_AI_RUNS_PER_CONVERSATION, MCP_GLOBAL_POLICY_KEY,
    };
    use crate::ai::{
        AiActiveModelSelection, AiAssistantMode, AiChatMessage, AiChatSelectionState, AiConversation,
        AiEffortSelection, AiModelEffortPreference, AiRun, AiRunFifoCategory, AiRunStatus,
    };
    use crate::connection_secrets::NACOS_RNACOS_CONSOLE_PASSWORD_KEY;
    use crate::connection_secrets::{
        plugin_connection_secret_key, CASSANDRA_KEYSTORE_PASSWORD_KEY, CASSANDRA_TRUSTSTORE_PASSWORD_KEY,
        MQTT_AUTH_PASSWORD_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY, NACOS_AUTH_PASSWORD_KEY,
        PLUGIN_CONNECTION_SECRET_PREFIX,
    };
    use crate::history::{HistoryConnectionFilter, HistoryDatabaseFilter, HistoryEntry, HistorySearchRequest};
    use crate::models::connection::{
        ConnectionConfig, DatabaseConnectionInfo, DatabaseType, HttpTunnelConfig, SshTunnelConfig, TransportLayerConfig,
    };
    use crate::persistence::secret_codec::{managed_key_path, SecretCodec, SecretKeyPolicy};
    use crate::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};
    use rusqlite::{Connection, TransactionBehavior};
    use std::collections::BTreeMap;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn migration_scan_cache_recovers_legacy_success_with_stale_counts() {
        let dir = temp_data_dir("migration-stale-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&dir.join("dbx.db")).await.unwrap();
        storage.set_migration_state(super::MigrationState::Succeeded, None, None, None, None).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE data_migrations SET counts_json=?1",
                    [r#"{"cachedScan":[75,0,65,15,2,0,5],"backupPaths":[]}"#],
                )
                .unwrap();
                Ok(())
            })
            .await
            .unwrap();
        let status = storage.inspect_data_migration().await.unwrap();
        assert_eq!(status.state, super::MigrationState::Succeeded);
        assert!(!status.needs_migration);
        assert_eq!(status.database_plaintext_count, 0);
        let again = storage.inspect_data_migration().await.unwrap();
        assert!(!again.needs_migration);
        assert_eq!(again.database_plaintext_count, 0);
    }

    #[tokio::test]
    async fn migration_preflight_is_read_only() {
        let dir = temp_data_dir("migration-cache-transition");
        std::fs::create_dir_all(&dir).unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&dir.join("dbx.db")).await.unwrap();
        storage.inspect_data_migration().await.unwrap();
        let before = storage.load_migration_state().await.unwrap();
        assert_eq!(before.state, super::MigrationState::Pending);
        let before: serde_json::Value = serde_json::from_str(&before.counts_json).unwrap();
        assert!(before.get("cachedScanFingerprint").is_none());
        assert!(before.get("cachedScan").is_none());
        let rows = storage
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM data_migrations", [], |row| row.get::<_, i64>(0))
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert_eq!(rows, 0);
        storage.set_migration_state(super::MigrationState::Succeeded, None, None, None, None).await.unwrap();
        let after = storage.load_migration_state().await.unwrap();
        let after: serde_json::Value = serde_json::from_str(&after.counts_json).unwrap();
        assert!(after.get("cachedScan").is_none());
        assert!(after.get("cachedScanFingerprint").is_none());
        assert!(!storage.inspect_data_migration().await.unwrap().needs_migration);
    }

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}.db", std::process::id()))
    }

    #[tokio::test]
    async fn managed_data_dir_key_is_created_only_when_plaintext_migration_starts() {
        let dir = tempfile::tempdir().unwrap();
        let database_path = dir.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES ('legacy', 'password', 'old-secret', NULL)",
                    [],
                )
                .map_err(|error| error.to_string())?;
                Ok(())
            })
            .await
            .unwrap();

        let key_path = managed_key_path(dir.path());
        let status = storage.inspect_data_migration().await.unwrap();
        assert!(status.needs_migration);
        assert!(status.key_creation_allowed);
        assert_eq!(status.error_code.as_deref(), Some("MISSING_MANAGED_KEY"));
        assert!(!key_path.exists());

        storage.start_data_migration().await.unwrap();
        assert!(key_path.is_file());
        let row = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'legacy' AND key = 'password'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(row.0.is_empty());
        assert!(row.1.starts_with("dbxenc1."));

        drop(storage);
        let reopened = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        assert_eq!(reopened.get_secret("legacy", "password").await.unwrap().as_deref(), Some("old-secret"));
    }

    #[tokio::test]
    async fn secret_migration_write_failure_rolls_back_all_rows() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage
            .with_conn(|conn| {
                conn.execute_batch(
                    "INSERT INTO connection_secrets (connection_id, key, secret) VALUES
                     ('first', 'password', 'first-secret'), ('second', 'password', 'second-secret');
                     CREATE TRIGGER reject_second_encryption BEFORE UPDATE ON connection_secrets
                     WHEN (SELECT COUNT(*) FROM connection_secrets WHERE secret_enc IS NOT NULL) > 0
                     BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;",
                )
                .map_err(|error| error.to_string())?;
                let codec = super::SecretCodec::new([7u8; 32]);
                let error = super::migrate_legacy_connection_secrets_sync(conn, &codec).unwrap_err();
                assert!(error.contains("injected write failure"));
                let unchanged: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM connection_secrets WHERE secret <> '' AND secret_enc IS NULL",
                        [],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(unchanged, 2);
                Ok(())
            })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn secret_migration_late_failure_restores_backup_and_retries_after_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO connection_secrets (connection_id, key, secret) VALUES ('legacy', 'password', 'old-secret')",
                    [],
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        let legacy_path = directory.path().join("connections.json");
        std::fs::write(&legacy_path, "invalid json").unwrap();
        assert!(storage.start_data_migration().await.unwrap_err().contains("connections.json"));
        assert_eq!(std::fs::read_to_string(&legacy_path).unwrap(), "invalid json");
        assert!(!directory.path().join("connections.json.bak").exists());
        let record = storage.load_migration_state().await.unwrap();
        assert_eq!(record.state, super::MigrationState::Failed);
        assert!(std::path::Path::new(record.backup_path.as_ref().unwrap()).join("dbx.db").is_file());
        storage
            .with_conn(|conn| {
                let row: (String, Option<String>) = conn
                    .query_row(
                        "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'legacy'",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(|error| error.to_string())?;
                assert_eq!(row, ("old-secret".to_string(), None));
                Ok(())
            })
            .await
            .unwrap();
        assert!(storage.cleanup_migration_backups().await.is_err());
        drop(storage);

        std::fs::write(&legacy_path, "[]").unwrap();
        let reopened = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        reopened.retry_data_migration().await.unwrap();
        assert_eq!(reopened.get_secret("legacy", "password").await.unwrap().as_deref(), Some("old-secret"));
        assert!(!legacy_path.exists());
        assert!(directory.path().join("connections.json.bak").exists());
        assert!(reopened.inspect_data_migration().await.unwrap().is_ready());
    }

    #[tokio::test]
    async fn secret_migration_running_state_resumes_after_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = directory.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage.set_secret("legacy", "password", "secret").await.unwrap();
        let backup = storage.create_migration_backup().await.unwrap();
        storage.set_migration_state(super::MigrationState::Running, Some(&backup), None, None, None).await.unwrap();
        drop(storage);
        let reopened = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        let status = reopened.inspect_data_migration().await.unwrap();
        assert_eq!(status.state, super::MigrationState::Running);
        assert!(!status.is_ready());
        reopened.retry_data_migration().await.unwrap();
        assert!(reopened.inspect_data_migration().await.unwrap().is_ready());
        assert_eq!(reopened.get_secret("legacy", "password").await.unwrap().as_deref(), Some("secret"));
    }

    /// Reads through the same codec path business reads use, so a cached codec
    /// has to produce the right plaintext for the assertion to hold.
    fn open_with_resolved_codec(storage: &Storage, envelope: &str) -> Result<String, String> {
        storage.secret_codec(false)?.decrypt("connection", "password", envelope)
    }

    #[tokio::test]
    async fn resolved_secret_codec_is_cached_until_a_key_file_changes() {
        // Hydrating stored secrets used to re-resolve key material per secret,
        // which on the desktop means one OS credential-store round trip per
        // secret on the startup path.
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open_unmigrated(&dir.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        let key_path = managed_key_path(dir.path());
        std::fs::create_dir_all(key_path.parent().unwrap()).unwrap();
        std::fs::write(&key_path, "ab".repeat(32)).unwrap();
        let file_codec = storage.secret_codec(false).unwrap();
        let envelope = file_codec.encrypt("connection", "password", "secret").unwrap();

        storage.cache_secret_codec(SecretCodec::new([7u8; 32]), storage.key_file_digests());
        // Business reads answer from the cached codec instead of re-reading the
        // key file, so an envelope sealed with the file key stays shut.
        assert_eq!(open_with_resolved_codec(&storage, &envelope), Err("secret decryption failed".to_string()));

        // Replacing the key file drops the cached codec, so the next read uses
        // the material the provider now reports.
        std::fs::write(&key_path, "cd".repeat(32)).unwrap();
        assert!(storage.cached_secret_codec().is_none());
        assert_eq!(open_with_resolved_codec(&storage, &envelope), Err("secret decryption failed".to_string()));

        // Restoring the original material restores the working codec.
        std::fs::write(&key_path, "ab".repeat(32)).unwrap();
        assert_eq!(open_with_resolved_codec(&storage, &envelope).as_deref(), Ok("secret"));
    }

    #[tokio::test]
    async fn secret_migration_rejects_wrong_or_invalid_managed_keys_without_replacing_them() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage.set_secret("connection", "password", "secret").await.unwrap();
        let key_path = managed_key_path(directory.path());
        let original = std::fs::read(&key_path).unwrap();
        for (material, expected) in [("00".repeat(32), "SECRET_KEY_MISMATCH"), ("\n".to_string(), "SECRET_KEY_INVALID")]
        {
            std::fs::write(&key_path, &material).unwrap();
            let status = storage.inspect_data_migration().await.unwrap();
            assert!(!status.is_ready());
            assert!(!status.key_creation_allowed);
            assert_eq!(status.error_code.as_deref(), Some(expected));
            assert!(storage.get_secret("connection", "password").await.is_err());
            assert_eq!(storage.start_data_migration().await.unwrap_err(), expected);
            assert_eq!(std::fs::read_to_string(&key_path).unwrap(), material);
        }
        std::fs::write(&key_path, original).unwrap();
        assert_eq!(storage.get_secret("connection", "password").await.unwrap().as_deref(), Some("secret"));
    }

    #[tokio::test]
    async fn missing_managed_key_for_existing_ciphertext_never_creates_a_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let database_path = dir.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage.set_secret("connection", "password", "secret").await.unwrap();
        let key_path = managed_key_path(dir.path());
        std::fs::remove_file(&key_path).unwrap();

        let status = storage.inspect_data_migration().await.unwrap();
        assert!(status.needs_migration);
        assert!(!status.key_creation_allowed);
        assert_eq!(status.error_code.as_deref(), Some("ENCRYPTED_DATA_KEY_MISSING"));
        assert!(!key_path.exists());
        assert_eq!(storage.start_data_migration().await.unwrap_err(), "ENCRYPTED_DATA_KEY_MISSING");
        assert!(!key_path.exists());
    }

    #[tokio::test]
    async fn secret_write_after_managed_key_loss_never_creates_a_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage.set_secret("existing", "password", "original-secret").await.unwrap();
        let key_path = managed_key_path(directory.path());
        let original_key = std::fs::read(&key_path).unwrap();
        std::fs::remove_file(&key_path).unwrap();

        assert_eq!(
            storage.set_secret("new", "password", "new-secret").await.unwrap_err(),
            "ENCRYPTED_DATA_KEY_MISSING"
        );
        assert!(!key_path.exists());
        assert_eq!(storage.get_secret("new", "password").await.unwrap(), None);

        std::fs::write(&key_path, original_key).unwrap();
        assert_eq!(storage.get_secret("existing", "password").await.unwrap().as_deref(), Some("original-secret"));
        storage.set_secret("new", "password", "new-secret").await.unwrap();
        assert_eq!(storage.get_secret("new", "password").await.unwrap().as_deref(), Some("new-secret"));
    }

    #[tokio::test]
    async fn connection_write_after_managed_key_loss_preserves_existing_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        let original = plain_connection("existing", "original-secret");
        storage.save_connections(std::slice::from_ref(&original)).await.unwrap();
        let key_path = managed_key_path(directory.path());
        let original_key = std::fs::read(&key_path).unwrap();
        std::fs::remove_file(&key_path).unwrap();

        let replacement = plain_connection("replacement", "new-secret");
        assert_eq!(storage.save_connections(&[replacement]).await.unwrap_err(), "ENCRYPTED_DATA_KEY_MISSING");
        assert!(!key_path.exists());

        std::fs::write(&key_path, original_key).unwrap();
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, original.id);
        assert_eq!(loaded[0].password, "original-secret");
    }

    #[tokio::test]
    async fn disabled_secret_key_creation_does_not_provision_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let database_path = dir.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&database_path)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir)
            .with_secret_key_creation(false);

        assert_eq!(storage.set_secret("connection", "password", "secret").await.unwrap_err(), "MISSING_MANAGED_KEY");
        assert!(!managed_key_path(dir.path()).exists());
    }

    /// Data directory with an explicit mode. The process temp directory is
    /// group-writable on Linux (`/tmp` is 1777), which would otherwise be read
    /// as the shared-directory sharing model.
    #[cfg(unix)]
    fn temp_data_dir_with_mode(name: &str, mode: u32) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_data_dir(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
        dir
    }

    #[tokio::test]
    async fn delete_table_vgroups_for_connection_scopes_by_prefix() {
        let path = temp_db_path("vgroup-delete");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let layout = serde_json::json!({ "version": 1, "groups": [], "order": [] });
        // 真实 scope_key 形如 `{connectionId}\u{0}{linkedServer}\u{0}{catalog}\u{0}{database}\u{0}{schema}`。
        storage.save_table_vgroups("conn-1\u{0}\u{0}\u{0}db1\u{0}", &layout).await.unwrap();
        storage.save_table_vgroups("conn-1\u{0}\u{0}\u{0}db2\u{0}", &layout).await.unwrap();
        storage.save_table_vgroups("conn-2\u{0}\u{0}\u{0}db1\u{0}", &layout).await.unwrap();
        // 前缀恰好是另一连接 id 的连接不能被误删。
        storage.save_table_vgroups("conn-12\u{0}\u{0}\u{0}db1\u{0}", &layout).await.unwrap();
        // 仅大小写不同、或 id 含 LIKE 通配符的连接同样不能被误删。
        storage.save_table_vgroups("CONN-1\u{0}\u{0}\u{0}db1\u{0}", &layout).await.unwrap();
        storage.save_table_vgroups("conn_1\u{0}\u{0}\u{0}db1\u{0}", &layout).await.unwrap();

        storage.delete_table_vgroups_for_connection("conn-1").await.unwrap();

        let remaining = storage.load_table_vgroups().await.unwrap();
        let mut keys: Vec<&String> = remaining.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "CONN-1\u{0}\u{0}\u{0}db1\u{0}",
                "conn-12\u{0}\u{0}\u{0}db1\u{0}",
                "conn-2\u{0}\u{0}\u{0}db1\u{0}",
                "conn_1\u{0}\u{0}\u{0}db1\u{0}",
            ]
        );
    }

    #[cfg(unix)]
    fn file_mode(path: &std::path::Path) -> Option<u32> {
        use std::os::unix::fs::PermissionsExt;

        std::fs::metadata(path).ok().map(|metadata| metadata.permissions().mode() & 0o777)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_restricts_the_database_and_its_journals_to_the_owner() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_data_dir_with_mode("permission-single-user", 0o755);
        let path = dir.join("dbx.db");
        drop(crate::persistence::test_storage::open(&path).await.unwrap());

        // Stand in for an installation created before this hardening existed,
        // including a rollback journal left behind by an interrupted write.
        let journal = dir.join("dbx.db-journal");
        std::fs::write(&journal, b"").unwrap();
        for file in [&path, &journal] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        drop(crate::persistence::test_storage::open(&path).await.unwrap());

        for name in ["dbx.db", "dbx.db-journal", "dbx.db-wal", "dbx.db-shm"] {
            let Some(mode) = file_mode(&dir.join(name)) else { continue };
            assert_eq!(mode & 0o077, 0, "{name} kept group/other bits ({mode:o})");
            assert_ne!(mode & 0o600, 0, "{name} lost owner access ({mode:o})");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_preserves_group_access_in_a_shared_data_directory() {
        use std::os::unix::fs::PermissionsExt;

        // Group-writable: the layout the portable notes on `Storage::open` and
        // `enable_wal_mode` describe, where several local accounts share one
        // data directory.
        let dir = temp_data_dir_with_mode("permission-group-shared", 0o770);
        let path = dir.join("dbx.db");
        drop(crate::persistence::test_storage::open(&path).await.unwrap());

        let journal = dir.join("dbx.db-journal");
        std::fs::write(&journal, b"").unwrap();
        for file in [&path, &journal] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o664)).unwrap();
        }

        drop(crate::persistence::test_storage::open(&path).await.unwrap());

        for name in ["dbx.db", "dbx.db-journal"] {
            let Some(mode) = file_mode(&dir.join(name)) else { continue };
            assert_eq!(mode & 0o007, 0, "{name} stayed world-accessible ({mode:o})");
            assert_ne!(mode & 0o060, 0, "{name} lost the group access it is shared through ({mode:o})");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn open_restricts_the_database_even_when_schema_initialization_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = temp_data_dir_with_mode("permission-init-failure", 0o755);
        let path = dir.join("dbx.db");
        drop(crate::persistence::test_storage::open(&path).await.unwrap());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // A read-only directory keeps the database file itself writable while
        // denying the journal SQLite needs, so the schema pass fails.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = crate::persistence::test_storage::open(&path).await;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(result.is_err(), "expected schema initialization to fail on a read-only directory");
        let mode = file_mode(&path).expect("database file still exists");
        assert_eq!(mode & 0o077, 0, "database kept group/other bits after a failed open ({mode:o})");

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_data_dir(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}", std::process::id()))
    }

    fn history_entry(
        id: &str,
        connection_id: &str,
        connection_name: &str,
        database: &str,
        sql: &str,
        executed_at: &str,
        success: bool,
    ) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            connection_id: connection_id.to_string(),
            connection_name: connection_name.to_string(),
            database: database.to_string(),
            sql: sql.to_string(),
            executed_at: executed_at.to_string(),
            execution_time_ms: 10,
            success,
            error: (!success).then(|| "query failed".to_string()),
            activity_kind: "query".to_string(),
            operation: "SELECT".to_string(),
            target: "orders".to_string(),
            affected_rows: None,
            rollback_sql: None,
            details_json: None,
        }
    }

    fn ai_conversation(id: &str, updated_at: &str) -> AiConversation {
        AiConversation {
            plugin_context: None,
            id: id.to_string(),
            title: id.to_string(),
            connection_name: "local".to_string(),
            connection_id: "local".to_string(),
            database: "db".to_string(),
            schema: None,
            messages: vec![AiChatMessage {
                role: "user".to_string(),
                content: id.to_string(),
                mentions: None,
                reasoning: None,
                kind: None,
                failed: None,
                covered_messages: None,
                source_binding: None,
            }],
            queued_input: None,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    fn ai_run(id: &str, conversation_id: &str, status: AiRunStatus, updated_at: &str) -> AiRun {
        AiRun {
            run_id: id.to_string(),
            conversation_id: conversation_id.to_string(),
            session_ids: vec![],
            status,
            connection_id: "connection".to_string(),
            database: "db".to_string(),
            schema: None,
            pending_confirmation: None,
            fifo_category: None,
            pending_input: None,
            max_seq: None,
            created_at: updated_at.to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    #[tokio::test]
    async fn ai_conversation_soft_cap_never_evicts_protected_runs() {
        let path = temp_db_path("ai-conversation-soft-cap");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let protected = ai_conversation("protected", "0000");
        let protected_run = ai_run("protected-run", "protected", AiRunStatus::Running, "0000");
        storage.save_ai_run_state(&protected, &protected_run).await.unwrap();
        for index in 0..55 {
            let timestamp = format!("{index:04}");
            storage.save_ai_conversation(&ai_conversation(&format!("terminal-{index}"), &timestamp)).await.unwrap();
        }

        let conversations = storage.load_ai_conversations().await.unwrap();
        assert_eq!(conversations.len(), 50);
        assert!(conversations.iter().any(|conversation| conversation.id == "protected"));
        assert!(!conversations.iter().any(|conversation| conversation.id == "terminal-0"));
        assert!(conversations.iter().any(|conversation| conversation.id == "terminal-54"));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_soft_cap_allows_more_than_fifty_protected_runs() {
        let path = temp_db_path("ai-conversation-protected-overflow");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        for index in 0..51 {
            let id = format!("protected-{index}");
            let timestamp = format!("{index:04}");
            storage
                .save_ai_run_state(
                    &ai_conversation(&id, &timestamp),
                    &ai_run(&format!("run-{index}"), &id, AiRunStatus::AwaitingWriteConfirmation, &timestamp),
                )
                .await
                .unwrap();
        }
        storage.save_ai_conversation(&ai_conversation("terminal-extra", "9999")).await.unwrap();

        let conversations = storage.load_ai_conversations().await.unwrap();
        assert_eq!(conversations.len(), 51);
        assert!(conversations.iter().all(|conversation| conversation.id.starts_with("protected-")));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_soft_cap_protects_pending_recoverable_runs() {
        let path = temp_db_path("ai-conversation-pending-recoverable-protection");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        // A recovered pending-input run (PRD §7 line 93) must be protected like
        // any other non-terminal run: its draft is not lost to pruning.
        let protected = ai_conversation("recoverable", "0000");
        let mut protected_run = ai_run("recoverable-run", "recoverable", AiRunStatus::PendingRecoverable, "0000");
        protected_run.pending_input = Some("recover me".to_string());
        storage.save_ai_run_state(&protected, &protected_run).await.unwrap();
        for index in 0..55 {
            let timestamp = format!("{index:04}");
            storage.save_ai_conversation(&ai_conversation(&format!("terminal-{index}"), &timestamp)).await.unwrap();
        }

        let conversations = storage.load_ai_conversations().await.unwrap();
        assert_eq!(conversations.len(), 50);
        assert!(conversations.iter().any(|conversation| conversation.id == "recoverable"));
        assert!(!conversations.iter().any(|conversation| conversation.id == "terminal-0"));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_run_roundtrips_fifo_category_and_pending_input() {
        let path = temp_db_path("ai-run-fifo-category-roundtrip");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let conversation = ai_conversation("fifo-conv", "0000");
        let mut run = ai_run("fifo-run", "fifo-conv", AiRunStatus::Queued, "0000");
        run.fifo_category = Some(AiRunFifoCategory::NormalSend);
        run.pending_input = Some("select * from orders limit 5".to_string());
        run.max_seq = Some(42);
        storage.save_ai_run_state(&conversation, &run).await.unwrap();

        let loaded = storage.load_ai_runs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].run_id, "fifo-run");
        assert_eq!(loaded[0].status, AiRunStatus::Queued);
        assert_eq!(loaded[0].fifo_category, Some(AiRunFifoCategory::NormalSend));
        assert_eq!(loaded[0].pending_input.as_deref(), Some("select * from orders limit 5"));
        assert_eq!(loaded[0].max_seq, Some(42));

        // The write_confirmation_resume category survives too.
        let mut resume = ai_run("resume-run", "fifo-conv", AiRunStatus::Queued, "0001");
        resume.fifo_category = Some(AiRunFifoCategory::WriteConfirmationResume);
        storage.save_ai_run(&resume).await.unwrap();
        let loaded = storage.load_ai_runs().await.unwrap();
        let resume = loaded.iter().find(|run| run.run_id == "resume-run").unwrap();
        assert_eq!(resume.fifo_category, Some(AiRunFifoCategory::WriteConfirmationResume));
        assert!(resume.pending_input.is_none());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn saving_a_conversation_keeps_its_background_runs() {
        let path = temp_db_path("ai-conversation-upsert-keeps-runs");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        // `ai_runs` declares an ON DELETE CASCADE relationship. Exercise the
        // snapshot path with enforcement enabled so an accidental REPLACE
        // (delete + insert) cannot silently erase an active run on restart.
        storage
            .with_conn(|conn| conn.execute_batch("PRAGMA foreign_keys = ON").map_err(|e| e.to_string()))
            .await
            .unwrap();

        let mut conversation = ai_conversation("upsert-conv", "0000");
        let run = ai_run("upsert-run", "upsert-conv", AiRunStatus::Running, "0000");
        storage.save_ai_run_state(&conversation, &run).await.unwrap();

        conversation.updated_at = "0001".to_string();
        conversation.queued_input = Some("send later".to_string());
        storage.save_ai_conversation(&conversation).await.unwrap();

        let runs = storage.load_ai_runs().await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].run_id, "upsert-run");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn terminal_ai_runs_are_capped_per_conversation_while_nonterminal_survive() {
        // Reviewed finding (unbounded terminal run growth): save_ai_run /
        // save_ai_run_state persist every terminal run and load_ai_runs loads
        // the whole table at startup, but prune_ai_conversations only caps
        // conversations and deliberately retains runs for the survivors - so
        // repeated completed runs grew SQLite storage and recovery work
        // forever. The storage layer now caps terminal history per
        // conversation (keeping the newest few, which drive the row status
        // badge after restart) and never touches recovery-relevant runs.
        let path = temp_db_path("ai-terminal-runs-capped");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        // A non-terminal run must always survive - it is the recovery payload.
        let conversation = ai_conversation("cap-conv", "0000");
        storage
            .save_ai_run_state(&conversation, &ai_run("active-run", "cap-conv", AiRunStatus::Running, "0000"))
            .await
            .unwrap();
        // Repeated completed runs (normal use): older ones must be pruned.
        for index in 0..5 {
            let timestamp = format!("{index:04}");
            storage
                .save_ai_run(&ai_run(&format!("terminal-{index}"), "cap-conv", AiRunStatus::Completed, &timestamp))
                .await
                .unwrap();
        }

        let runs = storage.load_ai_runs().await.unwrap();
        assert!(runs.iter().any(|run| run.run_id == "active-run"), "recovery-relevant run must survive");
        let terminal: Vec<_> = runs.iter().filter(|run| run.status == AiRunStatus::Completed).collect();
        assert_eq!(
            terminal.len(),
            KEEP_TERMINAL_AI_RUNS_PER_CONVERSATION as usize,
            "only the newest terminal runs per conversation survive"
        );
        assert!(terminal.iter().any(|run| run.run_id == "terminal-4"), "the newest terminal run is retained");
        assert!(!runs.iter().any(|run| run.run_id == "terminal-0"), "the oldest terminal runs are pruned");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_upgrades_legacy_schema_for_plugin_context() {
        let path = temp_db_path("ai-plugin-legacy-schema");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE ai_conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', connection_name TEXT NOT NULL DEFAULT '',
            database TEXT NOT NULL DEFAULT '', messages_json TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
        ); INSERT INTO ai_conversations (id, title) VALUES ('legacy', 'SQL conversation');",
        )
        .unwrap();
        drop(conn);
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut loaded = storage.load_ai_conversations().await.unwrap();
        assert_eq!(loaded[0].title, "SQL conversation");
        assert!(loaded[0].plugin_context.is_none());
        loaded[0].plugin_context = Some(serde_json::json!({"data": {"snapshotId": "s1"}}));
        storage.save_ai_conversation(&loaded[0]).await.unwrap();
        assert_eq!(storage.load_ai_conversations().await.unwrap()[0].plugin_context, loaded[0].plugin_context);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_retains_plugin_snapshot_without_a_database() {
        let path = temp_db_path("ai-plugin-conversation");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut conversation = ai_conversation("market-analysis", "0000");
        conversation.database.clear();
        let snapshot = serde_json::json!({
            "pluginId": "market-watch", "pluginName": "Market Watch", "title": "AAPL",
            "capturedAt": "2026-09-15T08:00:00Z", "data": { "price": 100, "currency": "USD" }
        });
        conversation.plugin_context = Some(snapshot.clone());
        storage.save_ai_conversation(&conversation).await.unwrap();
        let loaded = storage.load_ai_conversations().await.unwrap();
        assert_eq!(loaded[0].plugin_context, Some(snapshot.clone()));
        assert!(loaded[0].database.is_empty());
        // Existing database conversations remain compatible with the optional field.
        let mut legacy_json = serde_json::to_value(&conversation).unwrap();
        legacy_json.as_object_mut().unwrap().remove("pluginContext");
        let legacy: AiConversation = serde_json::from_value(legacy_json).unwrap();
        assert!(legacy.plugin_context.is_none());
        // A first turn recovered from the desktop FIFO has no sent messages yet.
        conversation.messages.clear();
        let mut run = ai_run("queued-plugin", &conversation.id, AiRunStatus::PendingRecoverable, "0001");
        run.pending_input = Some("analyse this snapshot".to_string());
        storage.save_ai_run_state(&conversation, &run).await.unwrap();
        let loaded = storage.load_ai_conversations().await.unwrap();
        assert!(loaded[0].messages.is_empty());
        assert_eq!(loaded[0].plugin_context, Some(snapshot));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_roundtrips_queued_input() {
        let path = temp_db_path("ai-conversation-queued-input-roundtrip");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let mut conversation = ai_conversation("queued-conv", "0000");
        conversation.queued_input = Some("run this after the current task".to_string());
        storage.save_ai_conversation(&conversation).await.unwrap();

        let loaded = storage.load_ai_conversations().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "queued-conv");
        assert_eq!(loaded[0].queued_input.as_deref(), Some("run this after the current task"));

        // Overwriting clears a stale queued input.
        conversation.queued_input = None;
        storage.save_ai_conversation(&conversation).await.unwrap();
        let loaded = storage.load_ai_conversations().await.unwrap();
        assert!(loaded[0].queued_input.is_none());

        let _ = std::fs::remove_file(path);
    }

    /// Legacy `ai_conversations` table (no `connection_id` / `schema_name`), plus
    /// a `connections` table whose rows the backfill matches against.
    fn create_legacy_conversation_db(path: &std::path::Path, conversations: &str, connections: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE ai_conversations (
                id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', connection_name TEXT NOT NULL DEFAULT '',
                database TEXT NOT NULL DEFAULT '', messages_json TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
            {connections}
            {conversations}"
        ))
        .unwrap();
        drop(conn);
    }

    #[tokio::test]
    async fn ai_conversation_roundtrips_connection_binding() {
        let path = temp_db_path("ai-conversation-binding-roundtrip");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let mut conversation = ai_conversation("bound-conv", "0000");
        conversation.connection_id = "conn-prod".to_string();
        conversation.schema = Some("public".to_string());
        conversation.messages[0].source_binding = Some(crate::ai::AiChatSourceBinding {
            connection_id: "conn-original".to_string(),
            database: "db-original".to_string(),
            schema: Some("legacy".to_string()),
        });
        storage.save_ai_conversation(&conversation).await.unwrap();

        let loaded = storage.load_ai_conversations().await.unwrap();
        assert_eq!(loaded[0].connection_id, "conn-prod");
        assert_eq!(loaded[0].schema.as_deref(), Some("public"));
        let source = loaded[0].messages[0].source_binding.as_ref().unwrap();
        assert_eq!(source.connection_id, "conn-original");
        assert_eq!(source.database, "db-original");
        assert_eq!(source.schema.as_deref(), Some("legacy"));
        let legacy: AiChatMessage = serde_json::from_str(r#"{"role":"assistant","content":"old reply"}"#).unwrap();
        assert!(legacy.source_binding.is_none());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_upgrades_legacy_schema_and_binds_a_unique_connection() {
        let path = temp_db_path("ai-conversation-legacy-binding");
        create_legacy_conversation_db(
            &path,
            "INSERT INTO ai_conversations (id, title, connection_name) VALUES ('prod', 'Prod chat', 'Prod MySQL');
             INSERT INTO ai_conversations (id, title, connection_name) VALUES ('orphan', 'Orphan chat', 'Deleted Conn');",
            "INSERT INTO connections (id, config_json) VALUES ('c-prod', '{\"id\":\"c-prod\",\"name\":\"Prod MySQL\",\"db_type\":\"mysql\",\"host\":\"127.0.0.1\",\"port\":3306,\"username\":\"u\",\"password\":\"p\",\"database\":null}');",
        );

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let loaded = storage.load_ai_conversations().await.unwrap();
        let conversation = |id: &str| loaded.iter().find(|item| item.id == id).unwrap();

        // Exactly one saved connection carries the stored name: bind it.
        assert_eq!(conversation("prod").connection_id, "c-prod");
        // Nothing carries that name; a guess would silently point at the wrong
        // database, so the conversation stays unbound for the UI to resolve.
        assert!(conversation("orphan").connection_id.is_empty());
        assert!(conversation("orphan").schema.is_none());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_backfill_skips_ambiguous_connection_names() {
        let path = temp_db_path("ai-conversation-binding-ambiguous");
        create_legacy_conversation_db(
            &path,
            "INSERT INTO ai_conversations (id, title, connection_name) VALUES ('dup', 'Dup chat', 'Shared Name');
             INSERT INTO ai_conversations (id, title, connection_name) VALUES ('nameless', 'Nameless chat', '');",
            "INSERT INTO connections (id, config_json) VALUES ('c1', '{\"id\":\"c1\",\"name\":\"Shared Name\",\"db_type\":\"mysql\",\"host\":\"127.0.0.1\",\"port\":3306,\"username\":\"u\",\"password\":\"p\",\"database\":null}');
             INSERT INTO connections (id, config_json) VALUES ('c2', '{\"id\":\"c2\",\"name\":\"Shared Name\",\"db_type\":\"mysql\",\"host\":\"127.0.0.1\",\"port\":3306,\"username\":\"u\",\"password\":\"p\",\"database\":null}');",
        );

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        for conversation in storage.load_ai_conversations().await.unwrap() {
            // Two connections share the name (names are not unique), and an empty
            // name identifies nothing: neither may be auto-bound.
            assert!(conversation.connection_id.is_empty(), "{} must stay unbound", conversation.id);
        }

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn ai_conversation_backfill_never_overwrites_an_existing_binding() {
        let path = temp_db_path("ai-conversation-binding-idempotent");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut conversation = ai_conversation("pinned", "0000");
        conversation.connection_id = "conn-a".to_string();
        storage.save_ai_conversation(&conversation).await.unwrap();
        drop(storage);

        // A connection matching the stored name appears *after* the binding was
        // written; re-running the backfill must leave the explicit binding alone.
        let conn = Connection::open(&path).unwrap();
        conn.execute("INSERT INTO connections (id, config_json) VALUES ('conn-later', '{\"id\":\"conn-later\",\"name\":\"local\",\"db_type\":\"mysql\",\"host\":\"127.0.0.1\",\"port\":3306,\"username\":\"u\",\"password\":\"p\",\"database\":null}')", [])
            .unwrap();
        drop(conn);

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let loaded = storage.load_ai_conversations().await.unwrap();
        assert_eq!(loaded[0].connection_id, "conn-a");

        let _ = std::fs::remove_file(path);
    }

    // Seed a backlog efficiently, then exercise the production write path that
    // applies retention. Settings must affect every caller of that path.
    async fn seed_history_backlog(storage: &Storage, count: usize) {
        storage.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|error| error.to_string())?;
            for index in 0..count {
                tx.execute(
                    "INSERT INTO history (id, connection_name, database, sql_text, executed_at, execution_time_ms, success) VALUES (?1, 'Main', 'app', 'select 1', '2026-07-18T12:00:00Z', 1, 1)",
                    [format!("{index:05}")],
                ).map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())
        }).await.unwrap();
    }

    #[tokio::test]
    async fn history_retention_uses_persisted_limit_on_the_next_write() {
        for (limit, expected) in [(200, 200), (5000, 1002), (10000, 1002), (0, 1002)] {
            let dir = tempfile::tempdir().unwrap();
            let storage = crate::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
            seed_history_backlog(&storage, 1001).await;
            storage
                .with_conn(move |conn| {
                    conn.execute(
                        "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                        [serde_json::json!({"history_retention_limit": limit}).to_string()],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                })
                .await
                .unwrap();
            // Changing the setting alone must not evict existing history.
            assert_eq!(storage.search_history_entries(HistorySearchRequest::default()).await.unwrap().total, 1001);
            storage
                .save_history_entry(&history_entry(
                    "newest",
                    "conn",
                    "Main",
                    "app",
                    "select 2",
                    "2026-07-19T00:00:00Z",
                    true,
                ))
                .await
                .unwrap();
            let result = storage.search_history_entries(HistorySearchRequest::default()).await.unwrap();
            assert_eq!(result.total, expected, "retention limit {limit}");
            assert_eq!(result.entries[0].id, "newest");
            if limit == 200 {
                let remaining = storage.load_history_entries(500, 0, None).await.unwrap();
                assert!(remaining.iter().all(|entry| entry.id == "newest" || entry.id.as_str() >= "00802"));
            }
        }
    }

    #[tokio::test]
    async fn history_retention_defaults_validates_and_survives_stale_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        assert_eq!(storage.load_history_retention_limit().await.unwrap(), 1000);
        let stale = storage.load_app_settings_json().await.unwrap();
        for limit in [200, 1000, 5000, 10000, 0] {
            storage.save_history_retention_limit(limit).await.unwrap();
            assert_eq!(storage.load_history_retention_limit().await.unwrap(), limit);
        }
        for invalid in [1, 199, 201, 10001, u32::MAX] {
            assert!(storage.save_history_retention_limit(invalid).await.is_err());
            assert_eq!(storage.load_history_retention_limit().await.unwrap(), 0);
        }
        storage.save_app_settings_json(&stale).await.unwrap();
        assert_eq!(storage.load_history_retention_limit().await.unwrap(), 0);
        drop(storage);
        let reopened = crate::persistence::test_storage::open(&path).await.unwrap();
        assert_eq!(reopened.load_history_retention_limit().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn history_retention_invalid_persisted_values_use_default() {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
        for value in [
            serde_json::json!(-1),
            serde_json::json!(1),
            serde_json::json!("200"),
            serde_json::json!(u64::MAX),
            serde_json::Value::Null,
        ] {
            storage
                .with_conn(move |conn| {
                    conn.execute(
                        "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                        [serde_json::json!({"history_retention_limit": value}).to_string()],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
                })
                .await
                .unwrap();
            assert_eq!(storage.load_history_retention_limit().await.unwrap(), 1000);
        }
        seed_history_backlog(&storage, 1001).await;
        storage
            .save_history_entry(&history_entry(
                "newest",
                "conn",
                "Main",
                "app",
                "select 2",
                "2026-07-19T00:00:00Z",
                true,
            ))
            .await
            .unwrap();
        assert_eq!(storage.search_history_entries(HistorySearchRequest::default()).await.unwrap().total, 1000);
    }

    #[tokio::test]
    async fn history_retention_setting_changes_do_not_prune_until_next_write() {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
        storage.save_history_retention_limit(0).await.unwrap();
        seed_history_backlog(&storage, 1001).await;
        storage.save_history_retention_limit(200).await.unwrap();
        assert_eq!(storage.search_history_entries(HistorySearchRequest::default()).await.unwrap().total, 1001);
        storage
            .save_history_entry(&history_entry(
                "newest",
                "conn",
                "Main",
                "app",
                "select 2",
                "2026-07-19T00:00:00Z",
                true,
            ))
            .await
            .unwrap();
        assert_eq!(storage.search_history_entries(HistorySearchRequest::default()).await.unwrap().total, 200);
    }

    #[tokio::test]
    async fn history_search_filters_connection_database_and_legacy_entries() {
        let path = temp_db_path("history-search-scope");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let entries = [
            history_entry("1", "conn-a", "Primary", "sales", "select 1", "2026-07-18T01:00:00Z", true),
            history_entry("2", "conn-b", "Replica", "sales", "select 2", "2026-07-18T02:00:00Z", true),
            history_entry("3", "", "Legacy", "archive", "select 3", "2026-07-18T03:00:00Z", true),
        ];
        for entry in &entries {
            storage.save_history_entry(entry).await.unwrap();
        }

        let result = storage
            .search_history_entries(HistorySearchRequest {
                connections: vec![HistoryConnectionFilter {
                    connection_id: "conn-a".to_string(),
                    connection_name: "Primary".to_string(),
                }],
                databases: vec![HistoryDatabaseFilter {
                    connection_id: "conn-a".to_string(),
                    connection_name: "Primary".to_string(),
                    database: "sales".to_string(),
                }],
                limit: 100,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(result.entries.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), vec!["1"]);
        assert_eq!(result.total, 1);

        let legacy = storage
            .search_history_entries(HistorySearchRequest {
                connections: vec![HistoryConnectionFilter {
                    connection_id: String::new(),
                    connection_name: "Legacy".to_string(),
                }],
                limit: 100,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(legacy.entries[0].id, "3");

        let options = storage.load_history_connection_options().await.unwrap();
        assert_eq!(options.len(), 3);
        assert!(options.iter().any(|option| option.connection_id == "conn-a" && option.databases == ["sales"]));
        assert!(options.iter().any(|option| option.connection_id.is_empty() && option.connection_name == "Legacy"));
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn history_search_combines_whole_connections_with_narrowed_database_scopes() {
        let path = temp_db_path("history-search-hierarchical-scope");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let entries = [
            history_entry("a-sales", "conn-a", "Primary", "sales", "select 1", "2026-07-18T01:00:00Z", true),
            history_entry("a-archive", "conn-a", "Primary", "archive", "select 2", "2026-07-18T02:00:00Z", true),
            history_entry("b-sales", "conn-b", "Replica", "sales", "select 3", "2026-07-18T03:00:00Z", true),
            history_entry("b-archive", "conn-b", "Replica", "archive", "select 4", "2026-07-18T04:00:00Z", true),
        ];
        for entry in &entries {
            storage.save_history_entry(entry).await.unwrap();
        }

        let result = storage
            .search_history_entries(HistorySearchRequest {
                connections: vec![
                    HistoryConnectionFilter {
                        connection_id: "conn-a".to_string(),
                        connection_name: "Primary".to_string(),
                    },
                    HistoryConnectionFilter {
                        connection_id: "conn-b".to_string(),
                        connection_name: "Replica".to_string(),
                    },
                ],
                databases: vec![HistoryDatabaseFilter {
                    connection_id: "conn-b".to_string(),
                    connection_name: "Replica".to_string(),
                    database: "sales".to_string(),
                }],
                limit: 100,
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(
            result.entries.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(),
            vec!["b-sales", "a-archive", "a-sales"]
        );
        assert_eq!(result.total, 3);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn history_search_combines_text_status_and_time_filters() {
        let path = temp_db_path("history-search-fields");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let entries = [
            history_entry("1", "conn", "Main", "app", "select 100% from orders", "2026-07-17T23:59:59Z", false),
            history_entry("2", "conn", "Main", "app", "select 1000 from orders", "2026-07-18T12:00:00Z", false),
            history_entry("3", "conn", "Main", "app", "select 100% from orders", "2026-07-18T12:00:00Z", true),
        ];
        for entry in &entries {
            storage.save_history_entry(entry).await.unwrap();
        }

        let result = storage
            .search_history_entries(HistorySearchRequest {
                search_text: "100%".to_string(),
                success: Some(false),
                started_at: Some("2026-07-18T00:00:00Z".to_string()),
                ended_at: Some("2026-07-18T23:59:59Z".to_string()),
                limit: 100,
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(result.entries.is_empty());

        let successful = storage
            .search_history_entries(HistorySearchRequest {
                search_text: "100%".to_string(),
                success: Some(true),
                started_at: Some("2026-07-18T00:00:00Z".to_string()),
                ended_at: Some("2026-07-18T23:59:59Z".to_string()),
                limit: 100,
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(successful.entries[0].id, "3");
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn history_search_cursor_is_stable_for_equal_timestamps() {
        let path = temp_db_path("history-search-cursor");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        for id in ["a", "b", "c"] {
            storage
                .save_history_entry(&history_entry(id, "conn", "Main", "app", "select 1", "2026-07-18T12:00:00Z", true))
                .await
                .unwrap();
        }

        let first =
            storage.search_history_entries(HistorySearchRequest { limit: 2, ..Default::default() }).await.unwrap();
        assert_eq!(first.entries.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), vec!["c", "b"]);
        let second = storage
            .search_history_entries(HistorySearchRequest { cursor: first.next_cursor, limit: 2, ..Default::default() })
            .await
            .unwrap();
        assert_eq!(second.entries.iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), vec!["a"]);
        assert!(second.next_cursor.is_none());
        let _ = std::fs::remove_file(path);
    }

    fn ssh_profile(id: &str, password: &str) -> TransportLayerConfig {
        TransportLayerConfig::Ssh(SshTunnelConfig {
            id: id.to_string(),
            name: "Bastion".to_string(),
            enabled: true,
            host: "bastion.example.com".to_string(),
            port: 22,
            user: "deploy".to_string(),
            password: password.to_string(),
            key_path: String::new(),
            key_passphrase: String::new(),
            connect_timeout_secs: 5,
            expose_lan: false,
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            auth_method: "password".to_string(),
            allow_exec_channel_proxy: false,
            profile_id: String::new(),
        })
    }

    #[tokio::test]
    async fn tunnel_profiles_roundtrip_and_preserve_secrets() {
        let path = temp_db_path("tunnel-profiles");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let profile = ssh_profile("profile-1", "s3cret");
        storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
        assert_eq!(storage.load_tunnel_profiles().await.unwrap(), vec![profile.clone()]);

        // Applying a scrubbed copy (e.g. from a sync snapshot) keeps stored secrets.
        let mut scrubbed = profile.clone();
        scrubbed.scrub_secrets();
        storage.save_tunnel_profiles_preserving_secrets(&[scrubbed.clone()]).await.unwrap();
        match &storage.load_tunnel_profiles().await.unwrap()[0] {
            TransportLayerConfig::Ssh(ssh) => assert_eq!(ssh.password, "s3cret"),
            other => panic!("expected ssh profile, got {other:?}"),
        }

        // A plain save is exact: clearing a secret really clears it.
        storage.save_tunnel_profiles(&[scrubbed.clone()]).await.unwrap();
        assert_eq!(storage.load_tunnel_profiles().await.unwrap(), vec![scrubbed]);

        storage.save_tunnel_profiles(&[]).await.unwrap();
        assert!(storage.load_tunnel_profiles().await.unwrap().is_empty());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn tunnel_profile_secret_fields_are_not_written_to_config_json() {
        let path = temp_db_path("tunnel-secret-at-rest");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let profile = TransportLayerConfig::HttpTunnel(HttpTunnelConfig {
            id: "http-secret".to_string(),
            name: "HTTP".to_string(),
            enabled: true,
            url: "https://bastion.example.com".to_string(),
            token: "tunnel-token".to_string(),
            connect_timeout_secs: 5,
            profile_id: String::new(),
        });
        storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();
        let raw = storage
            .with_conn(|conn| {
                conn.query_row("SELECT config_json FROM tunnel_profiles WHERE id = 'http-secret'", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(!raw.contains("tunnel-token"));
        let encrypted = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret_enc FROM connection_secrets WHERE connection_id = 'tunnel_profile.http-secret' AND key = 'config'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(encrypted.is_some_and(|value| value.starts_with("dbxenc1.")));
        assert_eq!(storage.load_tunnel_profiles().await.unwrap(), vec![profile]);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn tunnel_profiles_reject_empty_ids() {
        let path = temp_db_path("tunnel-profiles-empty-id");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let profile = ssh_profile("", "secret");
        assert!(storage.save_tunnel_profiles(&[profile]).await.is_err());

        let _ = std::fs::remove_file(path);
    }

    fn plain_connection(id: &str, password: &str) -> ConnectionConfig {
        serde_json::from_value::<ConnectionConfig>(serde_json::json!({
            "id": id,
            "name": format!("conn {id}"),
            "db_type": "postgres",
            "host": "127.0.0.1",
            "port": 5432,
            "username": "postgres",
            "password": password,
            "database": "app"
        }))
        .unwrap()
    }

    fn cassandra_connection(id: &str) -> ConnectionConfig {
        let mut config = plain_connection(id, "");
        config.name = "Cassandra".to_string();
        config.db_type = DatabaseType::Cassandra;
        config.port = 9042;
        config.ssl = true;
        config.external_config = Some(serde_json::json!({
            "tls": {
                "truststore_path": "/certs/client.truststore",
                "truststore_password": "trust-secret",
                "keystore_path": "/certs/client.keystore",
                "keystore_password": "key-secret"
            }
        }));
        config
    }

    #[tokio::test]
    async fn save_connections_moves_cassandra_tls_passwords_to_secret_table_and_restores_them() {
        let path = temp_db_path("cassandra-tls-secrets");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_connections(&[cassandra_connection("cassandra")]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "cassandra").await;
        assert!(!raw_json.contains("trust-secret"));
        assert!(!raw_json.contains("key-secret"));
        assert_eq!(
            storage.get_secret("cassandra", CASSANDRA_TRUSTSTORE_PASSWORD_KEY).await.unwrap().as_deref(),
            Some("trust-secret")
        );
        assert_eq!(
            storage.get_secret("cassandra", CASSANDRA_KEYSTORE_PASSWORD_KEY).await.unwrap().as_deref(),
            Some("key-secret")
        );

        let loaded = storage.load_connections().await.unwrap();
        let tls = loaded[0].external_config.as_ref().unwrap().get("tls").unwrap();
        assert_eq!(tls["truststore_password"], "trust-secret");
        assert_eq!(tls["keystore_password"], "key-secret");

        let mut disabled = cassandra_connection("cassandra");
        disabled.ssl = false;
        disabled.external_config = None;
        storage.save_connections(&[disabled]).await.unwrap();
        assert_eq!(storage.get_secret("cassandra", CASSANDRA_TRUSTSTORE_PASSWORD_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("cassandra", CASSANDRA_KEYSTORE_PASSWORD_KEY).await.unwrap(), None);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connections_does_not_persist_password_when_save_password_false() {
        let path = temp_db_path("save-password-false");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let mut config = plain_connection("no-save", "hunter2");
        config.save_password = false;
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        assert_eq!(storage.get_secret(&config.id, "password").await.unwrap(), None);
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].password, "");
        assert!(!loaded[0].save_password);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn concurrent_save_connections_from_two_connections_does_not_lock() {
        // Regression test for issue #6605: multiple `dbx` processes sharing one
        // data directory (e.g. a portable install shared by several users on
        // the same machine) each open their own connection to the same
        // `dbx.db`. Opening two independent `Storage` instances here exercises
        // the same inter-connection SQLite file locking that separate OS
        // processes would hit.
        let path = temp_db_path("concurrent-save-connections");
        let storage_a = std::sync::Arc::new(crate::persistence::test_storage::open(&path).await.unwrap());
        let storage_b = std::sync::Arc::new(crate::persistence::test_storage::open(&path).await.unwrap());

        let mut tasks = Vec::new();
        for i in 0..20 {
            let storage = if i % 2 == 0 { storage_a.clone() } else { storage_b.clone() };
            let config = plain_connection(&format!("concurrent-{i}"), "hunter2");
            tasks.push(tokio::spawn(async move { storage.save_connections(std::slice::from_ref(&config)).await }));
        }

        for task in tasks {
            task.await.unwrap().expect("concurrent save_connections should not fail with 'database is locked'");
        }

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connections_persists_password_when_save_password_true() {
        let path = temp_db_path("save-password-true");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let config = plain_connection("save-yes", "hunter2");
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        assert_eq!(storage.get_secret(&config.id, "password").await.unwrap().as_deref(), Some("hunter2"));
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].password, "hunter2");
        assert!(loaded[0].save_password);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn plugin_secret_reads_require_a_key_only_for_ciphertext() {
        let dir = tempfile::tempdir().unwrap();
        let storage = crate::persistence::test_storage::open_unmigrated(&dir.path().join("dbx.db"))
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        assert!(storage.secret_codec(false).is_err());
        assert!(super::load_plugin_connection_secrets(&storage, "conn").await.unwrap().is_empty());
        let codec = super::SecretCodec::new([7; 32]);
        let key = format!("{PLUGIN_CONNECTION_SECRET_PREFIX}token");
        let encrypted = codec.encrypt("conn", &key, "secret").unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute(
                "INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES ('conn', ?1, '', ?2)",
                rusqlite::params![key, encrypted],
            ).map_err(|error| error.to_string())?;
                Ok(())
            })
            .await
            .unwrap();
        assert!(super::load_plugin_connection_secrets(&storage, "conn").await.is_err());
    }

    #[tokio::test]
    async fn save_connections_moves_plugin_secrets_to_secret_table_and_clears_removed_values() {
        let path = temp_db_path("plugin-secrets");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = plain_connection("plugin", "");
        config.db_type = DatabaseType::Plugin;
        config.plugin_id = Some("example.plugin".to_string());
        config.plugin_connection_provider = Some("example.connection".to_string());
        config.connection_secrets.insert("api_token".to_string(), "plugin-secret".to_string());

        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        let raw_json = raw_connection_json(&storage, &config.id).await;
        assert!(!raw_json.contains("plugin-secret"));
        assert_eq!(
            storage
                .get_secret(&config.id, &format!("{PLUGIN_CONNECTION_SECRET_PREFIX}api_token"))
                .await
                .unwrap()
                .as_deref(),
            Some("plugin-secret")
        );
        assert_eq!(storage.load_connections().await.unwrap()[0].connection_secrets, config.connection_secrets);

        let mut cleared = config;
        cleared.connection_secrets.clear();
        storage.save_connections(std::slice::from_ref(&cleared)).await.unwrap();
        assert_eq!(
            storage.get_secret(&cleared.id, &format!("{PLUGIN_CONNECTION_SECRET_PREFIX}api_token")).await.unwrap(),
            None
        );

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn switching_save_password_off_removes_stored_password() {
        let path = temp_db_path("save-password-switch-off");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let mut config = plain_connection("switch", "hunter2");
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        assert_eq!(storage.get_secret(&config.id, "password").await.unwrap().as_deref(), Some("hunter2"));

        config.save_password = false;
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        assert_eq!(storage.get_secret(&config.id, "password").await.unwrap(), None);
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].password, "");
        assert!(!loaded[0].save_password);

        let _ = std::fs::remove_file(path);
    }

    fn mq_connection(id: &str, token: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: "Pulsar".to_string(),
            note: String::new(),
            db_type: DatabaseType::MessageQueue,
            driver_profile: Some("pulsar".to_string()),
            driver_label: Some("Apache Pulsar".to_string()),
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8080,
            username: String::new(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 30,
            query_timeout_secs: 300,
            idle_timeout_secs: 600,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({
                "systemKind": "pulsar",
                "adminUrl": "http://127.0.0.1:8080",
                "auth": {
                    "kind": "token",
                    "token": token
                }
            })),
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: Default::default(),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn nacos_connection(id: &str, password: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: "Nacos".to_string(),
            note: String::new(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: "nacos".to_string(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_database_patterns: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 30,
            query_timeout_secs: 300,
            idle_timeout_secs: 600,
            keepalive_interval_secs: crate::models::connection::default_keepalive_interval_secs(),
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: ":".to_string(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            redis_key_templates: Vec::new(),
            redis_key_grouping: None,
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({
                "namespace": "public",
                "group": "DEFAULT_GROUP",
                "auth": {
                    "kind": "usernamePassword",
                    "username": "nacos",
                    "password": password
                }
            })),
            plugin_id: None,
            plugin_connection_provider: None,
            plugin_connection_type: None,
            connection_secrets: Default::default(),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            save_password: true,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    async fn raw_connection_json(storage: &Storage, id: &str) -> String {
        let id = id.to_string();
        storage
            .with_conn(move |conn| {
                conn.query_row("SELECT config_json FROM connections WHERE id = ?1", [id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap()
    }

    async fn insert_raw_connection(storage: &Storage, config: &ConnectionConfig) {
        let id = config.id.clone();
        let json = serde_json::to_string(config).unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", rusqlite::params![id, json])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap();
    }

    fn mq_token(config: &ConnectionConfig) -> Option<&str> {
        config.external_config.as_ref()?.get("auth")?.get("token")?.as_str()
    }

    fn mq_token_signing_key(config: &ConnectionConfig) -> Option<&str> {
        config.external_config.as_ref()?.get("tokenSigning")?.get("key")?.as_str()
    }

    fn nacos_auth_password(config: &ConnectionConfig) -> Option<&str> {
        config.external_config.as_ref()?.get("auth")?.get("password")?.as_str()
    }

    fn nacos_console_auth_password(config: &ConnectionConfig) -> Option<&str> {
        config.external_config.as_ref()?.get("rnacosConsoleAuth")?.get("password")?.as_str()
    }

    fn nacos_connection_with_console_auth(
        id: &str,
        primary_password: &str,
        console_password: &str,
    ) -> ConnectionConfig {
        let mut config = nacos_connection(id, primary_password);
        config.external_config.as_mut().unwrap()["rnacosConsoleAuth"] = serde_json::json!({
            "kind": "usernamePassword",
            "username": "console",
            "password": console_password
        });
        config
    }

    async fn create_data_dir_with_connection(name: &str, connection_id: &str, token: &str) -> std::path::PathBuf {
        let data_dir = temp_data_dir(name);
        let storage = crate::persistence::test_storage::open(&data_dir.join("dbx.db")).await.unwrap();
        storage.save_connections(&[mq_connection(connection_id, token)]).await.unwrap();
        drop(storage);
        data_dir
    }

    #[tokio::test]
    async fn import_user_data_db_copies_source_when_target_is_missing() {
        let source_dir = create_data_dir_with_connection("import-source", "source-connection", "source-token").await;
        let target_dir = temp_data_dir("import-target");
        std::fs::create_dir_all(managed_key_path(&target_dir).parent().unwrap()).unwrap();
        std::fs::copy(managed_key_path(&source_dir), managed_key_path(&target_dir)).unwrap();

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::Imported);
        let storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "source-connection");
        assert_eq!(mq_token(&connections[0]), Some("source-token"));
    }

    #[tokio::test]
    async fn import_user_data_db_does_not_overwrite_target_with_user_data() {
        let source_dir =
            create_data_dir_with_connection("import-source-existing", "source-connection", "source-token").await;
        let target_dir =
            create_data_dir_with_connection("import-target-existing", "target-connection", "target-token").await;

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::SkippedTargetHasData);
        let storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "target-connection");
        assert_eq!(mq_token(&connections[0]), Some("target-token"));
    }

    #[tokio::test]
    async fn import_user_data_db_recognizes_settings_and_snippets_as_user_data() {
        let source_dir = temp_data_dir("import-settings-only-source");
        let source_storage = crate::persistence::test_storage::open(&source_dir.join("dbx.db")).await.unwrap();
        source_storage
            .save_desktop_settings(&DesktopSettings { debug_logging_enabled: true, ..DesktopSettings::default() })
            .await
            .unwrap();
        source_storage
            .save_editor_settings(&serde_json::json!({
                "snippets": [{ "id": "custom", "prefix": "selc", "body": "SELECT 42" }]
            }))
            .await
            .unwrap();
        drop(source_storage);
        let target_dir = temp_data_dir("import-settings-only-target");

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::Imported);
        let storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        assert!(storage.load_desktop_settings().await.unwrap().debug_logging_enabled);
        assert_eq!(storage.load_editor_settings().await.unwrap().unwrap()["snippets"][0]["body"], "SELECT 42");
    }

    #[tokio::test]
    async fn import_user_data_db_does_not_overwrite_target_with_settings() {
        let source_dir =
            create_data_dir_with_connection("import-source-settings-target", "source-connection", "source-token").await;
        let target_dir = temp_data_dir("import-target-settings-only");
        let target_storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        target_storage
            .save_editor_settings(&serde_json::json!({
                "snippets": [{ "id": "target", "prefix": "tgt", "body": "SELECT 7" }]
            }))
            .await
            .unwrap();
        drop(target_storage);

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::SkippedTargetHasData);
        let storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        assert_eq!(storage.load_editor_settings().await.unwrap().unwrap()["snippets"][0]["body"], "SELECT 7");
    }

    #[tokio::test]
    async fn import_user_data_db_replaces_empty_target_schema() {
        let source_dir =
            create_data_dir_with_connection("import-source-empty-target", "source-connection", "source-token").await;
        let target_dir = temp_data_dir("import-empty-target");
        std::fs::create_dir_all(managed_key_path(&target_dir).parent().unwrap()).unwrap();
        std::fs::copy(managed_key_path(&source_dir), managed_key_path(&target_dir)).unwrap();
        let _target_storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::Imported);
        let storage = crate::persistence::test_storage::open(&target_dir.join("dbx.db")).await.unwrap();
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "source-connection");
    }

    #[tokio::test]
    async fn import_user_data_db_skips_empty_source_schema() {
        let source_dir = temp_data_dir("import-empty-source");
        let source_storage = crate::persistence::test_storage::open(&source_dir.join("dbx.db")).await.unwrap();
        drop(source_storage);
        let target_dir = temp_data_dir("import-empty-source-target");

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::SkippedSourceEmpty);
        assert!(!target_dir.join("dbx.db").exists());
    }

    #[test]
    fn import_user_data_db_skips_invalid_source_file() {
        let source_dir = temp_data_dir("import-invalid-source");
        std::fs::create_dir_all(&source_dir).unwrap();
        std::fs::write(source_dir.join("dbx.db"), b"not sqlite").unwrap();
        let target_dir = temp_data_dir("import-invalid-source-target");

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::SkippedInvalidSource);
        assert!(!target_dir.join("dbx.db").exists());
    }

    #[tokio::test]
    async fn save_connections_preserves_database_info() {
        let path = temp_db_path("database-info");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = mq_connection("database-info", "mq-secret");
        config.database_info = Some(DatabaseConnectionInfo {
            product_name: Some("MySQL".to_string()),
            product_version: Some("8.4.0".to_string()),
            current_database: Some("app".to_string()),
            ..DatabaseConnectionInfo::default()
        });

        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        let raw_json = raw_connection_json(&storage, "database-info").await;
        assert!(raw_json.contains("8.4.0"));
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].database_info, config.database_info);

        let updated_info = DatabaseConnectionInfo {
            product_name: Some("MySQL".to_string()),
            product_version: Some("8.4.1".to_string()),
            ..DatabaseConnectionInfo::default()
        };
        storage.save_connection_database_info("database-info", Some(updated_info.clone())).await.unwrap();
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].database_info, Some(updated_info));
        assert_eq!(mq_token(&loaded[0]), Some("mq-secret"));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connection_mqtt_saved_topics_updates_only_target_and_preserves_secrets() {
        let path = temp_db_path("mqtt-saved-topics");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let target = mq_connection("target", "target-secret");
        let untouched = mq_connection("untouched", "untouched-secret");
        storage.save_connections(&[target.clone(), untouched.clone()]).await.unwrap();

        let saved_topics = serde_json::json!([{
            "topic": "sensors/temperature",
            "qos": "atleastonce",
            "noLocal": false,
        }]);
        storage.save_connection_mqtt_saved_topics(&target.id, saved_topics.clone()).await.unwrap();

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 2);
        let updated = loaded.iter().find(|config| config.id == target.id).unwrap();
        assert_eq!(updated.external_config.as_ref().unwrap()["savedTopics"], saved_topics);
        assert_eq!(mq_token(updated), Some("target-secret"));
        assert_eq!(loaded.iter().find(|config| config.id == untouched.id), Some(&untouched));
        assert_eq!(mq_token(loaded.iter().find(|config| config.id == untouched.id).unwrap()), Some("untouched-secret"));

        assert!(storage.save_connection_mqtt_saved_topics("missing", serde_json::json!([])).await.is_err());
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connection_mqtt_saved_topics_rejects_non_object_external_config() {
        let path = temp_db_path("mqtt-saved-topics-invalid");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut target = mq_connection("target", "target-secret");
        target.external_config = Some(serde_json::json!("invalid"));
        storage.save_connections(std::slice::from_ref(&target)).await.unwrap();

        let error = storage.save_connection_mqtt_saved_topics(&target.id, serde_json::json!([])).await.unwrap_err();
        assert!(error.contains("external_config"));
        assert_eq!(storage.load_connections().await.unwrap(), vec![target]);
        let _ = std::fs::remove_file(path);
    }
    #[tokio::test]
    async fn save_connection_driver_profile_updates_only_the_target_metadata() {
        let path = temp_db_path("connection-driver-profile");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let target = mq_connection("target", "target-secret");
        let untouched = mq_connection("untouched", "untouched-secret");
        storage.save_connections(&[target.clone(), untouched.clone()]).await.unwrap();

        assert!(storage
            .save_connection_driver_profile(
                &target,
                Some("mongodb-legacy".to_string()),
                Some("MongoDB (Legacy)".to_string()),
            )
            .await
            .unwrap());
        let mut wrong_type = untouched.clone();
        wrong_type.db_type = DatabaseType::MongoDb;
        assert!(!storage
            .save_connection_driver_profile(&wrong_type, Some("mongodb-legacy".to_string()), None,)
            .await
            .unwrap());
        let mut missing = wrong_type;
        missing.id = "missing".to_string();
        assert!(!storage
            .save_connection_driver_profile(&missing, Some("mongodb-legacy".to_string()), None)
            .await
            .unwrap());

        let loaded = storage.load_connections().await.unwrap();
        let target = loaded.iter().find(|config| config.id == "target").unwrap();
        assert_eq!(target.driver_profile.as_deref(), Some("mongodb-legacy"));
        assert_eq!(target.driver_label.as_deref(), Some("MongoDB (Legacy)"));
        assert_eq!(mq_token(target), Some("target-secret"));
        assert_eq!(loaded.iter().find(|config| config.id == "untouched"), Some(&untouched));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connection_database_updates_only_the_target_and_preserves_secrets() {
        let path = temp_db_path("connection-database");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let target = mq_connection("target", "target-secret");
        let untouched = mq_connection("untouched", "untouched-secret");
        storage.save_connections(&[target.clone(), untouched.clone()]).await.unwrap();

        assert!(storage.save_connection_database("target", "dbx_demo").await.unwrap());
        assert!(!storage.save_connection_database("missing", "dbx_demo").await.unwrap());

        let loaded = storage.load_connections().await.unwrap();
        let stored_target = loaded.iter().find(|config| config.id == "target").unwrap();
        assert_eq!(stored_target.database.as_deref(), Some("dbx_demo"));
        assert_eq!(mq_token(stored_target), Some("target-secret"));
        assert_eq!(loaded.iter().find(|config| config.id == "untouched"), Some(&untouched));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connection_driver_profile_rejects_a_stale_connection_config() {
        let path = temp_db_path("connection-driver-profile-stale");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let original = mq_connection("target", "target-secret");
        storage.save_connections(std::slice::from_ref(&original)).await.unwrap();

        let mut replacement = original.clone();
        replacement.host = "replacement.example.com".to_string();
        replacement.name = "Replacement".to_string();
        storage.save_connections(std::slice::from_ref(&replacement)).await.unwrap();

        assert!(!storage
            .save_connection_driver_profile(
                &original,
                Some("mongodb-legacy".to_string()),
                Some("MongoDB (Legacy)".to_string()),
            )
            .await
            .unwrap());

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded, vec![replacement]);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connections_moves_mq_auth_token_to_secret_table_and_restores_it() {
        let path = temp_db_path("mq-token-secrets");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_connections(&[mq_connection("pulsar", "mq-token-secret")]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "pulsar").await;
        assert!(!raw_json.contains("mq-token-secret"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(mq_token(&persisted), Some(""));
        assert_eq!(storage.get_secret("pulsar", MQ_AUTH_TOKEN_KEY).await.unwrap().as_deref(), Some("mq-token-secret"));

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(mq_token(&loaded[0]), Some("mq-token-secret"));
    }

    #[tokio::test]
    async fn unreadable_saved_connections_do_not_block_loading_or_get_deleted_by_list_saves() {
        let path = temp_db_path("unreadable-connection-preservation");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut known = mq_connection("known", "known-secret");
        storage.save_connections(std::slice::from_ref(&known)).await.unwrap();

        let future_json = serde_json::json!({
            "id": "future",
            "name": "Future database",
            "db_type": "future_database"
        })
        .to_string();
        let inserted_json = future_json.clone();
        storage
            .with_conn(move |conn| {
                let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO connections (id, config_json) VALUES (?1, ?2)",
                    rusqlite::params!["future", inserted_json],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?1, ?2, ?3)",
                    rusqlite::params!["future", "password", "future-secret"],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())
            })
            .await
            .unwrap();

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "known");

        known.name = "Known updated".to_string();
        storage.save_connection_metadata_preserving_secrets(std::slice::from_ref(&known)).await.unwrap();
        assert_eq!(raw_connection_json(&storage, "future").await, future_json);
        assert_eq!(storage.get_secret("future", "password").await.unwrap().as_deref(), Some("future-secret"));

        storage.save_connections(&[]).await.unwrap();
        assert!(storage.load_connections().await.unwrap().is_empty());
        assert_eq!(raw_connection_json(&storage, "future").await, future_json);
        assert_eq!(storage.get_secret("future", "password").await.unwrap().as_deref(), Some("future-secret"));

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn save_connections_moves_plugin_secrets_to_secret_table_and_restores_them() {
        let path = temp_db_path("plugin-connection-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = mq_connection("plugin-connection", "");
        config.name = "Hello plugin".to_string();
        config.db_type = DatabaseType::Plugin;
        config.driver_profile = Some("plugin".to_string());
        config.external_config = Some(serde_json::json!({ "greeting": "Hello" }));
        config.plugin_id = Some("dbx.example.hello".to_string());
        config.plugin_connection_provider = Some("hello.connection".to_string());
        config.plugin_connection_type = Some("hello".to_string());
        config.connection_secrets.insert("access_token".to_string(), "plugin-secret".to_string());

        storage.save_connections(&[config]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "plugin-connection").await;
        assert!(!raw_json.contains("plugin-secret"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(persisted.connection_secrets.get("access_token"), None);
        assert_eq!(
            storage
                .get_secret("plugin-connection", &plugin_connection_secret_key("access_token").unwrap())
                .await
                .unwrap()
                .as_deref(),
            Some("plugin-secret")
        );

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].connection_secrets.get("access_token").map(String::as_str), Some("plugin-secret"));
    }

    #[tokio::test]
    async fn load_connections_preserves_opaque_null_plugin_secrets() {
        let path = temp_db_path("plugin-null-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = mq_connection("plugin-connection", "");
        config.name = "SSH plugin".to_string();
        config.db_type = DatabaseType::Plugin;
        config.driver_profile = Some("plugin".to_string());
        config.plugin_id = Some("io.dbx.ssh".to_string());
        config.plugin_connection_provider = Some("io.dbx.ssh.connection".to_string());
        config.plugin_connection_type = Some("ssh".to_string());
        config.connection_secrets.insert("sudo_password".to_string(), "null".to_string());
        config.connection_secrets.insert("totp_secret".to_string(), "".to_string());
        config.connection_secrets.insert("private_key_passphrase".to_string(), "real-passphrase".to_string());

        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        storage
            .set_secret("plugin-connection", &plugin_connection_secret_key("totp_secret").unwrap(), "null")
            .await
            .unwrap();
        let loaded = storage.load_connections().await.unwrap();
        let secrets = &loaded[0].connection_secrets;
        assert_eq!(secrets.len(), 3);
        assert_eq!(secrets.get("sudo_password").map(String::as_str), Some("null"));
        assert_eq!(secrets.get("totp_secret").map(String::as_str), Some("null"));
        assert_eq!(secrets.get("private_key_passphrase").map(String::as_str), Some("real-passphrase"));
        assert_eq!(
            storage
                .get_secret("plugin-connection", &plugin_connection_secret_key("sudo_password").unwrap())
                .await
                .unwrap()
                .as_deref(),
            Some("null")
        );
        assert_eq!(
            storage
                .get_secret("plugin-connection", &plugin_connection_secret_key("totp_secret").unwrap())
                .await
                .unwrap()
                .as_deref(),
            Some("null")
        );
        assert_eq!(storage.load_connections().await.unwrap()[0].connection_secrets, *secrets);
        storage.save_connections(&loaded).await.unwrap();
        assert_eq!(storage.load_connections().await.unwrap()[0].connection_secrets, *secrets);
        drop(storage);
        let reopened = crate::persistence::test_storage::open(&path).await.unwrap();
        assert_eq!(reopened.load_connections().await.unwrap()[0].connection_secrets, *secrets);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn metadata_save_scrubs_mq_auth_token_and_preserves_existing_secret() {
        let path = temp_db_path("mq-token-metadata");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        let original = mq_connection("pulsar", "existing-token");
        storage.save_connections(std::slice::from_ref(&original)).await.unwrap();

        let mut metadata = original;
        metadata.name = "Pulsar renamed".to_string();
        if let Some(auth) = metadata.external_config.as_mut().and_then(|value| value.get_mut("auth")) {
            auth["token"] = serde_json::Value::String("new-token-that-should-not-persist".to_string());
        }

        storage.save_connection_metadata_preserving_secrets(&[metadata]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "pulsar").await;
        assert!(!raw_json.contains("existing-token"));
        assert!(!raw_json.contains("new-token-that-should-not-persist"));
        assert_eq!(storage.get_secret("pulsar", MQ_AUTH_TOKEN_KEY).await.unwrap().as_deref(), Some("existing-token"));

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded[0].name, "Pulsar renamed");
        assert_eq!(mq_token(&loaded[0]), Some("existing-token"));
    }

    #[tokio::test]
    async fn load_connections_migrates_legacy_mq_auth_token_out_of_config_json() {
        let path = temp_db_path("mq-token-legacy-migration");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        insert_raw_connection(&storage, &mq_connection("pulsar", "legacy-token")).await;

        let loaded = storage.load_connections().await.unwrap();

        assert_eq!(mq_token(&loaded[0]), Some("legacy-token"));
        assert_eq!(storage.get_secret("pulsar", MQ_AUTH_TOKEN_KEY).await.unwrap().as_deref(), Some("legacy-token"));
        let raw_json = raw_connection_json(&storage, "pulsar").await;
        assert!(!raw_json.contains("legacy-token"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(mq_token(&persisted), Some(""));
    }

    #[tokio::test]
    async fn save_connections_deletes_stale_mq_auth_secrets_when_kind_changes() {
        let path = temp_db_path("mq-auth-kind-change");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage.save_connections(&[mq_connection("pulsar", "old-token")]).await.unwrap();
        let mut config = mq_connection("pulsar", "");
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "http://127.0.0.1:8080",
            "auth": {
                "kind": "basic",
                "username": "admin",
                "password": "basic-secret"
            }
        }));

        storage.save_connections(&[config]).await.unwrap();

        assert_eq!(storage.get_secret("pulsar", MQ_AUTH_TOKEN_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("pulsar", MQ_AUTH_PASSWORD_KEY).await.unwrap().as_deref(), Some("basic-secret"));
    }

    #[tokio::test]
    async fn save_connections_moves_mq_token_signing_key_to_secret_table_and_restores_it() {
        let path = temp_db_path("mq-token-signing-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = mq_connection("pulsar", "");
        config.external_config = Some(serde_json::json!({
            "systemKind": "pulsar",
            "adminUrl": "http://127.0.0.1:8080",
            "auth": { "kind": "none" },
            "tokenSigning": {
                "algorithm": "hs256",
                "key": "broker-signing-secret"
            }
        }));

        storage.save_connections(&[config]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "pulsar").await;
        assert!(!raw_json.contains("broker-signing-secret"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(mq_token_signing_key(&persisted), Some(""));
        assert_eq!(
            storage.get_secret("pulsar", MQ_TOKEN_SIGNING_KEY).await.unwrap().as_deref(),
            Some("broker-signing-secret")
        );

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(mq_token_signing_key(&loaded[0]), Some("broker-signing-secret"));
    }

    #[tokio::test]
    async fn save_connections_moves_nacos_auth_password_to_secret_table_and_restores_it() {
        let path = temp_db_path("nacos-auth-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_connections(&[nacos_connection("nacos", "nacos-secret")]).await.unwrap();

        let raw_json = raw_connection_json(&storage, "nacos").await;
        assert!(!raw_json.contains("nacos-secret"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(nacos_auth_password(&persisted), Some(""));
        assert_eq!(
            storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap().as_deref(),
            Some("nacos-secret")
        );

        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(nacos_auth_password(&loaded[0]), Some("nacos-secret"));
    }

    #[tokio::test]
    async fn save_connections_moves_separate_rnacos_console_password_to_secret_table() {
        let path = temp_db_path("rnacos-console-auth-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = nacos_connection("rnacos", "");
        config.external_config = Some(serde_json::json!({
            "implementation": "rnacos",
            "serverAddr": "http://127.0.0.1:8848",
            "rnacosConsoleAddr": "http://127.0.0.1:10848/rnacos",
            "rnacosHistoryEnabled": true,
            "auth": { "kind": "none" },
            "rnacosConsoleAuth": { "kind": "usernamePassword", "username": "console", "password": "console-secret" }
        }));

        storage.save_connections(&[config]).await.unwrap();
        let raw_json = raw_connection_json(&storage, "rnacos").await;
        assert!(!raw_json.contains("console-secret"));
        assert_eq!(
            storage.get_secret("rnacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap().as_deref(),
            Some("console-secret")
        );
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(
            loaded[0]
                .external_config
                .as_ref()
                .and_then(|value| value.get("rnacosConsoleAuth"))
                .and_then(|auth| auth.get("password"))
                .and_then(serde_json::Value::as_str),
            Some("console-secret")
        );
    }

    #[tokio::test]
    async fn save_connections_does_not_persist_nacos_passwords_when_save_password_is_false() {
        let path = temp_db_path("nacos-auth-no-save");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = nacos_connection_with_console_auth("nacos", "primary-secret", "console-secret");
        config.save_password = false;

        storage.save_connections(&[config]).await.unwrap();

        assert_eq!(storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap(), None);
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(nacos_auth_password(&loaded[0]), Some(""));
        assert_eq!(nacos_console_auth_password(&loaded[0]), Some(""));
    }

    #[tokio::test]
    async fn switching_nacos_password_saving_off_removes_all_stored_auth_secrets() {
        let path = temp_db_path("nacos-auth-disable-save");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = nacos_connection_with_console_auth("nacos", "primary-secret", "console-secret");
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        assert!(storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap().is_some());
        assert!(storage.get_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap().is_some());

        config.save_password = false;
        storage.save_connections(&[config]).await.unwrap();

        assert_eq!(storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap(), None);
    }

    #[tokio::test]
    async fn metadata_sync_removes_nacos_auth_secrets_when_password_saving_is_disabled() {
        let path = temp_db_path("nacos-auth-no-save-metadata-sync");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = nacos_connection_with_console_auth("nacos", "primary-secret", "console-secret");
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        config.save_password = false;
        storage.save_connection_metadata_preserving_secrets(&[config]).await.unwrap();

        assert_eq!(storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap(), None);
        let loaded = storage.load_connections().await.unwrap();
        assert_eq!(nacos_auth_password(&loaded[0]), Some(""));
        assert_eq!(nacos_console_auth_password(&loaded[0]), Some(""));
    }

    #[tokio::test]
    async fn load_connections_cleans_legacy_nacos_passwords_when_saving_is_disabled() {
        let path = temp_db_path("nacos-auth-no-save-legacy-cleanup");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = nacos_connection_with_console_auth("nacos", "legacy-primary-secret", "legacy-console-secret");
        config.save_password = false;
        insert_raw_connection(&storage, &config).await;
        storage.set_secret("nacos", NACOS_AUTH_PASSWORD_KEY, "stale-primary-secret").await.unwrap();
        storage.set_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY, "stale-console-secret").await.unwrap();

        let loaded = storage.load_connections().await.unwrap();

        assert_eq!(nacos_auth_password(&loaded[0]), Some(""));
        assert_eq!(nacos_console_auth_password(&loaded[0]), Some(""));
        assert_eq!(storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap(), None);
        assert_eq!(storage.get_secret("nacos", NACOS_RNACOS_CONSOLE_PASSWORD_KEY).await.unwrap(), None);
        let raw_json = raw_connection_json(&storage, "nacos").await;
        assert!(!raw_json.contains("legacy-primary-secret"));
        assert!(!raw_json.contains("legacy-console-secret"));
    }

    #[tokio::test]
    async fn load_connections_migrates_legacy_nacos_auth_password_out_of_config_json() {
        let path = temp_db_path("nacos-auth-legacy-migration");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        insert_raw_connection(&storage, &nacos_connection("nacos", "legacy-nacos-secret")).await;

        let loaded = storage.load_connections().await.unwrap();

        assert_eq!(nacos_auth_password(&loaded[0]), Some("legacy-nacos-secret"));
        assert_eq!(
            storage.get_secret("nacos", NACOS_AUTH_PASSWORD_KEY).await.unwrap().as_deref(),
            Some("legacy-nacos-secret")
        );
        let raw_json = raw_connection_json(&storage, "nacos").await;
        assert!(!raw_json.contains("legacy-nacos-secret"));
        let persisted: ConnectionConfig = serde_json::from_str(&raw_json).unwrap();
        assert_eq!(nacos_auth_password(&persisted), Some(""));
    }

    #[tokio::test]
    async fn desktop_settings_default_to_background_enabled() {
        let path = temp_db_path("desktop-settings-default");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap(), DesktopSettings::default());
    }

    #[tokio::test]
    async fn mcp_global_policy_defaults_unconfigured_and_roundtrips_atomically() {
        let path = temp_db_path("mcp-global-policy");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(
            storage.load_mcp_global_policy().await.unwrap(),
            McpGlobalPolicyState {
                configured: false,
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
                allowed_group_ids: Vec::new(),
                allowed_tool_names: None,
                connection_policies: Vec::new(),
                group_policies: Vec::new(),
                query_timeout_secs: None,
            }
        );

        storage.save_password_hash("preserved").await.unwrap();
        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: true,
                allowed_connection_ids: Some(vec!["conn-1".to_string(), "conn-2".to_string()]),
                query_timeout_secs: Some(120),
                ..Default::default()
            })
            .await
            .unwrap();

        assert_eq!(
            storage.load_mcp_global_policy().await.unwrap(),
            McpGlobalPolicyState {
                configured: true,
                read_only: true,
                allow_dangerous_sql: false,
                allowed_connection_ids: Some(vec!["conn-1".to_string(), "conn-2".to_string()]),
                allowed_group_ids: Vec::new(),
                allowed_tool_names: None,
                connection_policies: Vec::new(),
                group_policies: Vec::new(),
                query_timeout_secs: Some(120),
            }
        );
        assert_eq!(storage.load_password_hash().await.unwrap().as_deref(), Some("preserved"));
        let settings = storage.load_app_settings_json().await.unwrap();
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["readOnly"], true);
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["allowDangerousSql"], false);
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["allowedConnectionIds"][0], "conn-1");
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["queryTimeoutSecs"], 120);
        assert!(settings[MCP_GLOBAL_POLICY_KEY].get("configured").is_none());

        storage.save_desktop_settings(&DesktopSettings::default()).await.unwrap();
        assert!(storage.load_mcp_global_policy().await.unwrap().read_only);
    }

    #[tokio::test]
    async fn mcp_global_policy_fails_closed_on_malformed_settings() {
        let path = temp_db_path("mcp-global-policy-malformed");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                    [r#"{"mcp_global_policy":{"readOnly":"yes","allowedConnectionIds":null}}"#],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await
            .unwrap();

        let error = storage.load_mcp_global_policy().await.unwrap_err();
        assert!(error.starts_with("MCP_POLICY_UNAVAILABLE:"));
    }

    #[tokio::test]
    async fn malformed_app_settings_cannot_be_silently_replaced_by_an_unrelated_save() {
        let path = temp_db_path("mcp-global-policy-invalid-settings-shape");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute("INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)", ["[]"])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap();

        assert!(storage.load_mcp_global_policy().await.unwrap_err().starts_with("MCP_POLICY_UNAVAILABLE:"));
        assert!(storage.save_password_hash("must-not-reset-policy").await.is_err());
        let raw = storage
            .with_conn(|conn| {
                conn.query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap();
        assert_eq!(raw, "[]");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn mcp_global_policy_defaults_dangerous_sql_to_disabled_for_existing_settings() {
        let path = temp_db_path("mcp-global-policy-existing");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                    [r#"{"mcp_global_policy":{"readOnly":false,"allowedConnectionIds":null}}"#],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await
            .unwrap();

        let policy = storage.load_mcp_global_policy().await.unwrap();
        assert!(policy.configured);
        assert!(!policy.allow_dangerous_sql);
        assert_eq!(policy.query_timeout_secs, None);
    }

    #[tokio::test]
    async fn mcp_connection_mutations_are_atomic_and_recheck_policy() {
        let path = temp_db_path("mcp-connection-mutation-guard");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let kept = mq_connection("kept", "kept-token");
        let removed = mq_connection("removed", "removed-token");
        storage.save_connections(&[kept.clone(), removed.clone()]).await.unwrap();

        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: Some(vec![kept.id.clone()]),
                query_timeout_secs: None,
                ..Default::default()
            })
            .await
            .unwrap();
        let error = storage.remove_connection_for_mcp(&removed.id).await.unwrap_err();
        assert!(error.starts_with("CONNECTION_OUT_OF_SCOPE:"));

        let mut concurrently_updated = removed.clone();
        concurrently_updated.host = "updated-by-web-ui".to_string();
        storage.save_connections(&[kept.clone(), concurrently_updated.clone()]).await.unwrap();
        let added = mq_connection("added", "added-token");
        storage.add_connection_for_mcp(added.clone()).await.unwrap();
        let after_add = storage.load_connections().await.unwrap();
        assert_eq!(after_add.len(), 3);
        assert_eq!(
            after_add.iter().find(|config| config.id == concurrently_updated.id).map(|config| config.host.as_str()),
            Some("updated-by-web-ui")
        );

        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
                query_timeout_secs: None,
                ..Default::default()
            })
            .await
            .unwrap();
        let error = storage.remove_connection_for_mcp(&kept.id).await.unwrap_err();
        assert!(error.starts_with("MCP_READ_ONLY:"));
        assert_eq!(storage.load_connections().await.unwrap().len(), 3);

        // Non-MCP callers remain governed by the ordinary DBX UI permissions.
        storage.save_connections(std::slice::from_ref(&kept)).await.unwrap();
        assert_eq!(storage.load_connections().await.unwrap()[0].id, kept.id);

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn desktop_settings_fall_back_to_legacy_background_preference() {
        let path = temp_db_path("desktop-settings-legacy-background");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut settings = serde_json::Map::new();
        settings.insert("run_in_background".to_string(), serde_json::Value::Bool(false));
        storage.save_app_settings_json(&settings).await.unwrap();

        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { show_tray_icon: false, ..DesktopSettings::default() }
        );
    }

    #[test]
    fn metadata_cache_memory_budget_is_bounded() {
        assert_eq!(super::normalize_metadata_cache_max_memory_mb(1), 16);
        assert_eq!(super::normalize_metadata_cache_max_memory_mb(256), 256);
        assert_eq!(super::normalize_metadata_cache_max_memory_mb(512), 512);
        assert_eq!(super::normalize_metadata_cache_max_memory_mb(513), 64);
    }

    #[tokio::test]
    async fn schema_cache_prunes_expired_rows_on_write_without_maintaining_during_reads() {
        let path = temp_db_path("schema-cache-ttl-prune");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage
            .save_schema_cache(
                "object-ddl:v1:conn-a:db:public:old::TABLE:",
                &serde_json::json!({ "version": 1, "ddl": "old" }),
            )
            .await
            .unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE schema_cache SET updated_at = datetime('now', '-25 hours'), updated_at_ms = CAST(strftime('%s', 'now', '-25 hours') AS INTEGER) * 1000",
                    [],
                )
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap();

        assert_eq!(storage.load_schema_cache("object-ddl:v1:conn-a:db:public:old::TABLE:").await.unwrap(), None);
        let remaining = storage
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM schema_cache", [], |row| row.get::<_, i64>(0))
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert_eq!(remaining, 1, "L2 reads must remain indexed point lookups without global maintenance");

        storage
            .save_schema_cache(
                "object-ddl:v1:conn-a:db:public:new::TABLE:",
                &serde_json::json!({ "version": 1, "ddl": "new" }),
            )
            .await
            .unwrap();
        let remaining = storage
            .with_conn(|conn| {
                conn.query_row("SELECT COUNT(*) FROM schema_cache", [], |row| row.get::<_, i64>(0))
                    .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert_eq!(remaining, 1, "the next write must prune the expired row");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn schema_cache_budget_covers_multiple_connections_objects_and_facets() {
        let path = temp_db_path("schema-cache-capacity");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let policy = super::SchemaCachePolicy {
            max_total_bytes: 1_100,
            max_connection_bytes: 700,
            max_entries: 5,
            max_age_millis: 86_400_000,
        };
        let payload = serde_json::json!({ "value": "x".repeat(180) });
        let keys = [
            "object-ddl:v1:conn-a:db:public:accounts::TABLE:",
            "object-meta:v1:conn-a:db:public:accounts::TABLE:columns:",
            "object-meta:v1:conn-a:db:public:billing::TABLE:indexes:",
            "object-ddl:v1:conn-b:db:public:events::TABLE:",
            "object-meta:v1:conn-b:db:public:events::TABLE:triggers:",
            "object-meta:v1:conn-c:db:public:audit::TABLE:comment:",
        ];
        for key in keys {
            storage.save_schema_cache_with_policy(key, &payload, policy).await.unwrap();
        }

        let (entries, bytes, conn_a_bytes) = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*), COALESCE(SUM(byte_size), 0), COALESCE(SUM(CASE WHEN owner_id = 'conn-a' THEN byte_size ELSE 0 END), 0) FROM schema_cache",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(entries <= policy.max_entries as i64);
        assert!(bytes <= policy.max_total_bytes);
        assert!(conn_a_bytes <= policy.max_connection_bytes);
        assert!(storage.load_schema_cache(keys.last().unwrap()).await.unwrap().is_some());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn schema_cache_lru_keeps_recently_accessed_entries() {
        let path = temp_db_path("schema-cache-lru");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let policy = super::SchemaCachePolicy {
            max_total_bytes: i64::MAX,
            max_connection_bytes: i64::MAX,
            max_entries: 2,
            max_age_millis: 86_400_000,
        };
        let first = "object-ddl:v1:conn-a:db:public:first::TABLE:";
        let second = "object-meta:v1:conn-b:db:public:second::TABLE:columns:";
        let newest = "object-meta:v1:conn-c:db:public:newest::TABLE:indexes:";
        storage.save_schema_cache_with_policy(first, &serde_json::json!({ "value": 1 }), policy).await.unwrap();
        storage.save_schema_cache_with_policy(second, &serde_json::json!({ "value": 2 }), policy).await.unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute(
                    "UPDATE schema_cache SET last_accessed_at_ms = CASE cache_key WHEN ?1 THEN 1 ELSE 2 END",
                    rusqlite::params![first],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(storage.load_schema_cache(first).await.unwrap().is_some());
        storage.save_schema_cache_with_policy(newest, &serde_json::json!({ "value": 3 }), policy).await.unwrap();

        assert!(storage.load_schema_cache(first).await.unwrap().is_some());
        assert_eq!(storage.load_schema_cache(second).await.unwrap(), None);
        assert!(storage.load_schema_cache(newest).await.unwrap().is_some());

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn schema_cache_50k_point_reads_stay_below_performance_gate() {
        const ENTRY_COUNT: usize = 50_000;
        const SAMPLE_COUNT: usize = 40;
        let path = temp_db_path("schema-cache-50k-read-performance");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage
            .with_conn(|conn| {
                let transaction = conn
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
                {
                    let mut statement = transaction
                        .prepare(
                            "INSERT INTO schema_cache (
                                cache_key, payload_json, updated_at, updated_at_ms,
                                last_accessed_at_ms, byte_size, owner_id
                             ) VALUES (?1, ?2, datetime('now'), ?3, ?3, ?4, ?5)",
                        )
                        .map_err(|error| error.to_string())?;
                    for index in 0..ENTRY_COUNT {
                        let cache_key =
                            format!("object-meta:v1:conn-{}:db:public:table-{index}::TABLE:columns:", index % 32);
                        let payload = format!(r#"{{"version":1,"value":{index}}}"#);
                        statement
                            .execute(rusqlite::params![
                                cache_key,
                                payload,
                                super::unix_timestamp_millis(),
                                32_i64,
                                format!("conn-{}", index % 32),
                            ])
                            .map_err(|error| error.to_string())?;
                    }
                }
                transaction.commit().map_err(|error| error.to_string())
            })
            .await
            .unwrap();

        let mut samples = Vec::with_capacity(SAMPLE_COUNT);
        for sample in 0..SAMPLE_COUNT {
            let index = sample * (ENTRY_COUNT / SAMPLE_COUNT);
            let cache_key = format!("object-meta:v1:conn-{}:db:public:table-{index}::TABLE:columns:", index % 32);
            let started = Instant::now();
            assert!(storage.load_schema_cache(&cache_key).await.unwrap().is_some());
            samples.push(started.elapsed());
        }
        samples.sort_unstable();
        let total = samples.iter().copied().sum::<Duration>();
        let average = total / SAMPLE_COUNT as u32;
        let p95 = samples[(SAMPLE_COUNT * 95 / 100).saturating_sub(1)];
        eprintln!("schema_cache_50k_point_reads average={average:?} p95={p95:?}");

        assert!(average < Duration::from_millis(20), "50k L2 point-read average {average:?} exceeded 20 ms");
        assert!(p95 < Duration::from_millis(50), "50k L2 point-read P95 {p95:?} exceeded 50 ms");

        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn desktop_settings_preserve_existing_password_hash() {
        let path = temp_db_path("desktop-settings-preserve-password");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_password_hash("hash-1").await.unwrap();
        storage
            .save_desktop_settings(&DesktopSettings {
                show_tray_icon: false,
                icon_theme: DesktopIconTheme::Black,
                quit_on_close: true,
                close_action_prompted: false,
                debug_logging_enabled: true,
                metadata_cache_max_memory_mb: 128,
                duckdb_worker_process_isolation: false,
                duckdb_worker_max_processes: DesktopSettings::default().duckdb_worker_max_processes,
                saved_sql_sync_dir: None,
                driver_store_dir: Some("/tmp/dbx-drivers".to_string()),
                plugin_store_dir: Some("/tmp/dbx-plugins".to_string()),
                agent_store_dir: Some("/tmp/dbx-agents".to_string()),
                custom_ai_skill_root_enabled: DesktopSettings::default().custom_ai_skill_root_enabled,
                custom_ai_skill_root: None,
                sidebar_table_page_size: DesktopSettings::default().sidebar_table_page_size,
            })
            .await
            .unwrap();

        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-1".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings {
                show_tray_icon: false,
                icon_theme: DesktopIconTheme::Black,
                quit_on_close: true,
                close_action_prompted: false,
                debug_logging_enabled: true,
                metadata_cache_max_memory_mb: 128,
                duckdb_worker_process_isolation: false,
                duckdb_worker_max_processes: DesktopSettings::default().duckdb_worker_max_processes,
                saved_sql_sync_dir: None,
                driver_store_dir: Some("/tmp/dbx-drivers".to_string()),
                plugin_store_dir: Some("/tmp/dbx-plugins".to_string()),
                agent_store_dir: Some("/tmp/dbx-agents".to_string()),
                custom_ai_skill_root_enabled: DesktopSettings::default().custom_ai_skill_root_enabled,
                custom_ai_skill_root: None,
                sidebar_table_page_size: DesktopSettings::default().sidebar_table_page_size,
            }
        );
    }

    #[tokio::test]
    async fn desktop_settings_roundtrip_custom_ai_skill_root() {
        let path = temp_db_path("desktop-settings-custom-ai-skill-root");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings {
                custom_ai_skill_root_enabled: true,
                custom_ai_skill_root: Some("/tmp/dbx-skills".to_string()),
                ..DesktopSettings::default()
            })
            .await
            .unwrap();

        let settings = storage.load_desktop_settings().await.unwrap();
        assert!(settings.custom_ai_skill_root_enabled);
        assert_eq!(settings.custom_ai_skill_root.as_deref(), Some("/tmp/dbx-skills"));

        let raw = storage.load_app_settings_json().await.unwrap();
        assert_eq!(raw.get("custom_ai_skill_root_enabled").and_then(|value| value.as_bool()), Some(true));
        assert_eq!(raw.get("custom_ai_skill_root").and_then(|value| value.as_str()), Some("/tmp/dbx-skills"));

        storage
            .save_desktop_settings(&DesktopSettings {
                custom_ai_skill_root_enabled: false,
                custom_ai_skill_root: Some("   ".to_string()),
                ..DesktopSettings::default()
            })
            .await
            .unwrap();

        let settings = storage.load_desktop_settings().await.unwrap();
        assert!(!settings.custom_ai_skill_root_enabled);
        assert_eq!(settings.custom_ai_skill_root, None);

        let raw = storage.load_app_settings_json().await.unwrap();
        assert_eq!(raw.get("custom_ai_skill_root_enabled").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(raw.get("custom_ai_skill_root"), None);
    }

    #[tokio::test]
    async fn desktop_settings_save_removes_legacy_background_preference() {
        let path = temp_db_path("desktop-settings-remove-legacy-background");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut settings = serde_json::Map::new();
        settings.insert("run_in_background".to_string(), serde_json::Value::Bool(false));
        storage.save_app_settings_json(&settings).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings {
                icon_theme: DesktopIconTheme::Black,
                ..DesktopSettings::default()
            })
            .await
            .unwrap();

        let settings = storage.load_app_settings_json().await.unwrap();
        assert_eq!(settings.get("run_in_background"), None);
        assert_eq!(settings.get("show_tray_icon").and_then(|value| value.as_bool()), Some(true));
        assert_eq!(settings.get("icon_theme").and_then(|value| value.as_str()), Some("black"));
        assert_eq!(settings.get("debug_logging_enabled").and_then(|value| value.as_bool()), Some(false));
        assert_eq!(
            settings.get("sidebar_table_page_size").and_then(|value| value.as_u64()),
            Some(DesktopSettings::default().sidebar_table_page_size as u64)
        );
    }

    #[tokio::test]
    async fn desktop_settings_persist_sidebar_table_page_size() {
        let path = temp_db_path("desktop-settings-sidebar-page-size");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings { sidebar_table_page_size: 1234, ..DesktopSettings::default() })
            .await
            .unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap().sidebar_table_page_size, 1234);
    }

    #[tokio::test]
    async fn desktop_settings_persist_duckdb_worker_max_processes() {
        let path = temp_db_path("desktop-settings-duckdb-worker-max-processes");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings { duckdb_worker_max_processes: 8, ..DesktopSettings::default() })
            .await
            .unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap().duckdb_worker_max_processes, 8);
    }

    #[tokio::test]
    async fn max_agent_turns_defaults_and_persists_clamped() {
        let path = temp_db_path("max-agent-turns");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(storage.load_max_agent_turns().await.unwrap(), crate::agent_loop::DEFAULT_MAX_AGENT_TURNS);

        storage.save_max_agent_turns(100).await.unwrap();
        assert_eq!(storage.load_max_agent_turns().await.unwrap(), 100);

        // Out-of-range values are clamped on save so raw DB edits cannot disable the safety limit.
        storage.save_max_agent_turns(0).await.unwrap();
        assert_eq!(storage.load_max_agent_turns().await.unwrap(), crate::agent_loop::MIN_MAX_AGENT_TURNS);
        storage.save_max_agent_turns(u32::MAX).await.unwrap();
        assert_eq!(storage.load_max_agent_turns().await.unwrap(), crate::agent_loop::MAX_MAX_AGENT_TURNS);
    }

    #[tokio::test]
    async fn max_retries_defaults_and_persists_clamped() {
        let path = temp_db_path("max-retries");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(storage.load_max_retries().await.unwrap(), crate::ai::DEFAULT_MAX_RETRIES);

        storage.save_max_retries(5).await.unwrap();
        assert_eq!(storage.load_max_retries().await.unwrap(), 5);

        storage.save_max_retries(0).await.unwrap();
        assert_eq!(storage.load_max_retries().await.unwrap(), 0);

        // Values above the cap are clamped so raw DB edits cannot bypass the limit.
        storage.save_max_retries(u32::MAX).await.unwrap();
        assert_eq!(storage.load_max_retries().await.unwrap(), crate::ai::MAX_MAX_RETRIES);
    }

    #[tokio::test]
    async fn plugin_ai_tools_and_data_grants_persist_and_survive_legacy_settings_saves() {
        let path = temp_db_path("plugin-permissions");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        assert!(storage.load_ai_plugin_tool_plugin_ids().await.unwrap().is_empty());
        assert!(storage.load_plugin_data_grants("io.dbx.chart").await.unwrap().is_empty());

        assert_eq!(storage.set_ai_plugin_tool_plugin_enabled("io.dbx.ssh", true).await.unwrap(), ["io.dbx.ssh"]);
        storage.set_ai_plugin_tool_plugin_enabled("io.dbx.kafka", true).await.unwrap();
        storage.set_ai_plugin_tool_plugin_enabled("io.dbx.ssh", true).await.unwrap();
        assert_eq!(storage.load_ai_plugin_tool_plugin_ids().await.unwrap(), ["io.dbx.kafka", "io.dbx.ssh"]);

        storage.set_plugin_data_grant("io.dbx.chart", "conn-b", true).await.unwrap();
        assert_eq!(storage.set_plugin_data_grant("io.dbx.chart", "conn-a", true).await.unwrap(), ["conn-a", "conn-b"]);
        storage.set_plugin_data_grant("io.dbx.other", "conn-a", true).await.unwrap();

        // A settings writer that rebuilds the whole JSON map must not drop the
        // dedicated permission keys.
        storage.save_password_hash("hash").await.unwrap();
        storage.save_app_settings_json(&serde_json::Map::new()).await.unwrap();
        assert_eq!(storage.load_ai_plugin_tool_plugin_ids().await.unwrap(), ["io.dbx.kafka", "io.dbx.ssh"]);
        assert_eq!(storage.load_plugin_data_grants("io.dbx.chart").await.unwrap(), ["conn-a", "conn-b"]);

        assert_eq!(storage.set_plugin_data_grant("io.dbx.chart", "conn-b", false).await.unwrap(), ["conn-a"]);
        assert_eq!(storage.set_ai_plugin_tool_plugin_enabled("io.dbx.kafka", false).await.unwrap(), ["io.dbx.ssh"]);
        assert!(storage.set_plugin_data_grant("io.dbx.chart", " ", true).await.is_err());

        storage.set_ai_plugin_tool_plugin_enabled("io.dbx.chart", true).await.unwrap();
        storage.forget_plugin_permissions("io.dbx.chart").await.unwrap();
        assert_eq!(storage.load_ai_plugin_tool_plugin_ids().await.unwrap(), ["io.dbx.ssh"]);
        assert!(storage.load_plugin_data_grants("io.dbx.chart").await.unwrap().is_empty());
        assert_eq!(storage.load_plugin_data_grants("io.dbx.other").await.unwrap(), ["conn-a"]);
    }

    #[tokio::test]
    async fn max_retries_survives_stale_app_settings_save() {
        let path = temp_db_path("max-retries-stale-save");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let stale_settings = storage.load_app_settings_json().await.unwrap();

        storage.save_max_retries(7).await.unwrap();
        storage.save_app_settings_json(&stale_settings).await.unwrap();

        assert_eq!(storage.load_max_retries().await.unwrap(), 7);
    }

    #[tokio::test]
    async fn sql_file_upload_max_mb_defaults_and_persists_clamped() {
        let path = temp_db_path("sql-file-upload-max-mb");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(
            storage.load_sql_file_upload_max_mb().await.unwrap(),
            crate::sql_file_import::DEFAULT_SQL_FILE_UPLOAD_MAX_MB
        );

        storage.save_sql_file_upload_max_mb(512).await.unwrap();
        assert_eq!(storage.load_sql_file_upload_max_mb().await.unwrap(), 512);

        // Values above the cap are clamped so raw DB edits cannot bypass the limit.
        storage.save_sql_file_upload_max_mb(u32::MAX).await.unwrap();
        assert_eq!(
            storage.load_sql_file_upload_max_mb().await.unwrap(),
            crate::sql_file_import::MAX_SQL_FILE_UPLOAD_MAX_MB
        );
    }

    #[tokio::test]
    async fn sql_file_upload_max_mb_survives_stale_app_settings_save() {
        let path = temp_db_path("sql-file-upload-max-mb-stale-save");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let stale_settings = storage.load_app_settings_json().await.unwrap();

        storage.save_sql_file_upload_max_mb(256).await.unwrap();
        storage.save_app_settings_json(&stale_settings).await.unwrap();

        assert_eq!(storage.load_sql_file_upload_max_mb().await.unwrap(), 256);
    }

    #[tokio::test]
    async fn password_hash_preserves_existing_desktop_settings() {
        let path = temp_db_path("password-preserve-desktop-settings");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings {
                show_tray_icon: false,
                icon_theme: DesktopIconTheme::Black,
                ..DesktopSettings::default()
            })
            .await
            .unwrap();
        storage.save_password_hash("hash-2").await.unwrap();

        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-2".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings {
                show_tray_icon: false,
                icon_theme: DesktopIconTheme::Black,
                ..DesktopSettings::default()
            }
        );
    }

    #[tokio::test]
    async fn pinned_tree_node_ids_default_to_empty() {
        let path = temp_db_path("pinned-tree-default");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        assert_eq!(storage.load_pinned_tree_node_ids().await.unwrap(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn pinned_tree_node_ids_roundtrip_and_preserve_password_hash() {
        let path = temp_db_path("pinned-tree-roundtrip");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_password_hash("hash-3").await.unwrap();
        storage.save_pinned_tree_node_ids(&["conn-1".to_string(), "conn-1:db:main".to_string()]).await.unwrap();

        assert_eq!(
            storage.load_pinned_tree_node_ids().await.unwrap(),
            vec!["conn-1".to_string(), "conn-1:db:main".to_string()]
        );
        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-3".to_string()));
    }

    #[tokio::test]
    async fn app_state_roundtrips_without_polluting_app_settings() {
        let path = temp_db_path("app-state-roundtrip");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage.save_password_hash("hash-4").await.unwrap();
        storage
            .save_desktop_settings(&DesktopSettings {
                icon_theme: DesktopIconTheme::Black,
                ..DesktopSettings::default()
            })
            .await
            .unwrap();

        storage.save_editor_settings(&serde_json::json!({ "openTabsRestoreMode": "pinned" })).await.unwrap();
        storage
            .save_open_tabs_state(&serde_json::json!({
                "tabs": [{ "id": "tab-1", "title": "Pinned", "connectionId": "pg", "database": "app", "sql": "select 1", "pinned": true }],
                "activeTabId": "tab-1"
            }))
            .await
            .unwrap();
        storage
            .save_saved_sql_editor_positions(&serde_json::json!([{ "savedSqlId": "file-1", "updatedAt": 1 }]))
            .await
            .unwrap();
        let transfer_task_library = serde_json::json!({ "version": 1, "folders": [], "tasks": [] });
        storage.save_transfer_task_library(&transfer_task_library).await.unwrap();

        assert_eq!(
            storage.load_editor_settings().await.unwrap(),
            Some(serde_json::json!({ "openTabsRestoreMode": "pinned" }))
        );
        assert_eq!(
            storage.load_open_tabs_state().await.unwrap().and_then(|value| value.get("activeTabId").cloned()),
            Some(serde_json::json!("tab-1"))
        );

        let development_open_tabs_key = "development_open_tabs";
        storage
            .save_open_tabs_state_with_key(
                development_open_tabs_key,
                &serde_json::json!({
                    "tabs": [{ "id": "tab-2", "title": "Development", "connectionId": "pg", "database": "app", "sql": "select 2" }],
                    "activeTabId": "tab-2"
                }),
            )
            .await
            .unwrap();
        assert_eq!(
            storage
                .load_open_tabs_state_with_key(development_open_tabs_key)
                .await
                .unwrap()
                .and_then(|value| value.get("activeTabId").cloned()),
            Some(serde_json::json!("tab-2"))
        );
        assert_eq!(
            storage.load_open_tabs_state().await.unwrap().and_then(|value| value.get("activeTabId").cloned()),
            Some(serde_json::json!("tab-1"))
        );
        assert_eq!(
            storage.load_saved_sql_editor_positions().await.unwrap(),
            Some(serde_json::json!([{ "savedSqlId": "file-1", "updatedAt": 1 }]))
        );
        assert_eq!(storage.load_transfer_task_library().await.unwrap(), Some(transfer_task_library));
        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-4".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { icon_theme: DesktopIconTheme::Black, ..DesktopSettings::default() }
        );
        assert_eq!(storage.load_app_settings_json().await.unwrap().get("open_tabs"), None);
    }

    #[tokio::test]
    async fn ai_chat_selection_roundtrips_in_local_app_state() {
        let path = temp_db_path("ai-chat-selection");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let selection = AiChatSelectionState {
            version: 1,
            active: Some(AiActiveModelSelection { config_id: "config-1".to_string(), model_id: "model-1".to_string() }),
            effort_preferences: vec![AiModelEffortPreference {
                config_id: "config-1".to_string(),
                model_id: "model-1".to_string(),
                selection: AiEffortSelection::Enum("high".to_string()),
            }],
            default_mode: Some(AiAssistantMode::Agent),
            default_auto_routing: true,
            restore_last_conversation: true,
            default_templates_by_db_type: BTreeMap::from([("postgresql".to_string(), vec!["tpl-1".to_string()])]),
            last_used_templates_by_db_type: BTreeMap::from([("mysql".to_string(), vec!["tpl-2".to_string()])]),
        };

        storage.save_ai_chat_selection(&selection).await.unwrap();

        assert_eq!(storage.load_ai_chat_selection().await.unwrap(), Some(selection));
        assert_eq!(storage.load_app_settings_json().await.unwrap().get("ai_chat_selection_v1"), None);
    }

    // Selection JSON written before per-db-type prompt template defaults existed
    // must still deserialize; the new maps fall back to empty.
    #[tokio::test]
    async fn ai_chat_selection_loads_legacy_payload_without_template_defaults() {
        let path = temp_db_path("ai-chat-selection-legacy");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let legacy = serde_json::json!({
            "version": 1,
            "active": { "configId": "config-1", "modelId": "model-1" },
            "effortPreferences": [],
            "defaultMode": "ask"
        });
        storage.save_app_state_value(super::APP_STATE_AI_CHAT_SELECTION_KEY, &legacy).await.unwrap();

        let loaded = storage.load_ai_chat_selection().await.unwrap().unwrap();
        assert_eq!(
            loaded.active,
            Some(AiActiveModelSelection { config_id: "config-1".to_string(), model_id: "model-1".to_string() })
        );
        assert!(loaded.default_templates_by_db_type.is_empty());
        assert!(loaded.last_used_templates_by_db_type.is_empty());
    }

    // Serialization must omit the per-db-type maps while empty so the payload
    // stays identical to the pre-defaults format for users without picks.
    #[test]
    fn ai_chat_selection_serialization_omits_empty_template_maps() {
        let json = serde_json::to_value(AiChatSelectionState::default()).unwrap();
        let object = json.as_object().unwrap();
        assert!(!object.contains_key("defaultTemplatesByDbType"));
        assert!(!object.contains_key("lastUsedTemplatesByDbType"));
    }

    #[tokio::test]
    async fn tab_runtime_cache_roundtrips_binary_payloads() {
        let path = temp_db_path("tab-runtime-cache");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();

        storage
            .save_tab_runtime_cache("tab:1:result", vec![1, 2, 3, 4], 10, 3, Some("connection-1".to_string()))
            .await
            .unwrap();
        let entry = storage.load_tab_runtime_cache("tab:1:result").await.unwrap().unwrap();

        assert_eq!(entry.key, "tab:1:result");
        assert_eq!(entry.payload, vec![1, 2, 3, 4]);
        assert_eq!(entry.row_count, 10);
        assert_eq!(entry.column_count, 3);
        assert_eq!(entry.byte_size, 4);
        assert_eq!(entry.owner_id.as_deref(), Some("connection-1"));
        assert!(entry.created_at > 0);
        assert!(entry.last_accessed_at >= entry.created_at);

        storage.delete_tab_runtime_cache("tab:1:result").await.unwrap();
        assert_eq!(storage.load_tab_runtime_cache("tab:1:result").await.unwrap(), None);
    }

    #[tokio::test]
    async fn tab_runtime_cache_pruning_retains_live_entries_and_enforces_byte_budget() {
        let path = temp_db_path("tab-runtime-cache-prune");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        for (key, size) in [("live", 6usize), ("old", 5), ("new", 4)] {
            storage.save_tab_runtime_cache(key, vec![1; size], 1, 1, Some("connection-1".to_string())).await.unwrap();
        }
        storage
            .with_conn(|conn| {
                conn.execute("UPDATE tab_runtime_cache SET last_accessed_at = 1 WHERE cache_key = 'old'", [])
                    .map_err(|e| e.to_string())?;
                conn.execute("UPDATE tab_runtime_cache SET last_accessed_at = 2 WHERE cache_key = 'new'", [])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
            .await
            .unwrap();

        let result = storage.prune_tab_runtime_cache(vec!["live".to_string()], 10, i64::MAX, None).await.unwrap();

        assert_eq!(result.deleted_entries, 1);
        assert!(storage.load_tab_runtime_cache("live").await.unwrap().is_some());
        assert!(storage.load_tab_runtime_cache("old").await.unwrap().is_none());
        assert!(storage.load_tab_runtime_cache("new").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn tab_runtime_cache_pruning_respects_orphan_grace_period() {
        let path = temp_db_path("tab-runtime-cache-orphan-grace");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        storage.save_tab_runtime_cache("fresh", vec![1], 1, 1, None).await.unwrap();
        storage.save_tab_runtime_cache("crash-leftover", vec![2], 1, 1, None).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute("UPDATE tab_runtime_cache SET created_at = 1 WHERE cache_key = 'crash-leftover'", [])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await
            .unwrap();

        let result = storage.prune_tab_runtime_cache(Vec::new(), 1024, 60_000, None).await.unwrap();

        assert_eq!(result.orphan_deletions, 1);
        assert!(storage.load_tab_runtime_cache("fresh").await.unwrap().is_some());
        assert!(storage.load_tab_runtime_cache("crash-leftover").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn tab_runtime_cache_migrates_legacy_schema_without_dropping_entries() {
        let path = temp_db_path("tab-runtime-cache-legacy-schema");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute(
                    "CREATE TABLE tab_runtime_cache (cache_key TEXT PRIMARY KEY, payload BLOB NOT NULL, row_count INTEGER NOT NULL DEFAULT 0, column_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)",
                    [],
                )
                .unwrap();
            connection
                .execute("INSERT INTO tab_runtime_cache VALUES ('legacy', X'0102', 1, 1, 2, '2026-01-01')", [])
                .unwrap();
        }

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let entry = storage.load_tab_runtime_cache("legacy").await.unwrap().unwrap();

        assert_eq!(entry.payload, vec![1, 2]);
        assert!(entry.created_at > 0);
        assert!(entry.last_accessed_at >= entry.created_at);
    }

    #[tokio::test]
    async fn saved_sql_catalog_column_migrates_legacy_database() {
        let path = temp_db_path("saved-sql-catalog-migration");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE saved_sql_files (
                        id TEXT PRIMARY KEY,
                        connection_id TEXT NOT NULL,
                        folder_id TEXT,
                        name TEXT NOT NULL DEFAULT '',
                        database_name TEXT NOT NULL DEFAULT '',
                        schema_name TEXT,
                        sql_text TEXT NOT NULL DEFAULT '',
                        order_index INTEGER NOT NULL DEFAULT 0,
                        open_count INTEGER NOT NULL DEFAULT 0,
                        opened_at TEXT,
                        created_at TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL DEFAULT ''
                    );
                    INSERT INTO saved_sql_files
                        (id, connection_id, name, database_name, sql_text, created_at, updated_at)
                    VALUES
                        ('legacy-sql', 'conn-1', 'legacy.sql', 'sales', 'SELECT 1;', '2026-01-01', '2026-01-01');",
                )
                .unwrap();
        }

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let loaded = storage.load_saved_sql_file("legacy-sql").await.unwrap().unwrap();

        assert_eq!(loaded.database, "sales");
        assert_eq!(loaded.catalog, None);
    }

    #[tokio::test]
    async fn saved_sql_summary_omits_sql_text_and_loads_file_on_demand() {
        let path = temp_db_path("saved-sql-summary");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let file = SavedSqlFile {
            id: "sql-1".to_string(),
            connection_id: "conn-1".to_string(),
            folder_id: None,
            name: "large.sql".to_string(),
            database: "main".to_string(),
            catalog: Some("hive".to_string()),
            schema: None,
            sql: "SELECT * FROM very_large_table;".repeat(100),
            sql_loaded: true,
            order_index: 0,
            open_count: 0,
            opened_at: None,
            created_at: "2026-06-27T00:00:00Z".to_string(),
            updated_at: "2026-06-27T00:00:00Z".to_string(),
        };

        storage.save_saved_sql_file(&file).await.unwrap();

        let summary = storage.load_saved_sql_library_summary().await.unwrap();
        assert_eq!(summary.files.len(), 1);
        assert_eq!(summary.files[0].sql, "");
        assert_eq!(summary.files[0].catalog.as_deref(), Some("hive"));
        assert!(!summary.files[0].sql_loaded);

        let loaded = storage.load_saved_sql_file("sql-1").await.unwrap().unwrap();
        assert_eq!(loaded.sql, file.sql);
        assert_eq!(loaded.catalog.as_deref(), Some("hive"));
        assert!(loaded.sql_loaded);

        let sync_files = storage.load_saved_sql_files_for_sync().await.unwrap();
        assert_eq!(sync_files.len(), 1);
        assert_eq!(sync_files[0].id, file.id);
        assert_eq!(sync_files[0].sql, file.sql);
        assert!(sync_files[0].sql_loaded);
    }

    #[tokio::test]
    async fn saved_sql_metadata_update_preserves_unloaded_sql_text() {
        let path = temp_db_path("saved-sql-preserve-unloaded-text");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut file = SavedSqlFile {
            id: "sql-1".to_string(),
            connection_id: "conn-1".to_string(),
            folder_id: None,
            name: "query.sql".to_string(),
            database: "main".to_string(),
            catalog: None,
            schema: None,
            sql: "SELECT 1;".to_string(),
            sql_loaded: true,
            order_index: 0,
            open_count: 0,
            opened_at: None,
            created_at: "2026-06-27T00:00:00Z".to_string(),
            updated_at: "2026-06-27T00:00:00Z".to_string(),
        };
        storage.save_saved_sql_file(&file).await.unwrap();

        file.name = "renamed.sql".to_string();
        file.sql.clear();
        file.sql_loaded = false;
        file.open_count = 1;
        storage.save_saved_sql_file(&file).await.unwrap();

        let loaded = storage.load_saved_sql_file("sql-1").await.unwrap().unwrap();
        assert_eq!(loaded.name, "renamed.sql");
        assert_eq!(loaded.open_count, 1);
        assert_eq!(loaded.sql, "SELECT 1;");
    }

    #[tokio::test]
    async fn saved_sql_catalog_migration_keeps_legacy_rows_in_default_scope_across_restart() {
        let path = temp_db_path("saved-sql-catalog-restart-migration");
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute(
                    "CREATE TABLE saved_sql_files (
                        id TEXT PRIMARY KEY,
                        connection_id TEXT NOT NULL,
                        folder_id TEXT,
                        name TEXT NOT NULL DEFAULT '',
                        database_name TEXT NOT NULL DEFAULT '',
                        schema_name TEXT,
                        sql_text TEXT NOT NULL DEFAULT '',
                        order_index INTEGER NOT NULL DEFAULT 0,
                        open_count INTEGER NOT NULL DEFAULT 0,
                        opened_at TEXT,
                        created_at TEXT NOT NULL DEFAULT '',
                        updated_at TEXT NOT NULL DEFAULT ''
                    )",
                    [],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO saved_sql_files
                     (id, connection_id, name, database_name, sql_text, created_at, updated_at)
                     VALUES ('legacy', 'conn-1', 'legacy.sql', 'analytics', 'SELECT 1;', '2026-08-12', '2026-08-12')",
                    [],
                )
                .unwrap();
        }

        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let legacy = storage.load_saved_sql_file("legacy").await.unwrap().unwrap();
        assert_eq!(legacy.catalog, None);

        let external = SavedSqlFile {
            id: "external".to_string(),
            connection_id: "conn-1".to_string(),
            catalog: Some("iceberg_catalog".to_string()),
            folder_id: None,
            name: "external.sql".to_string(),
            database: "analytics".to_string(),
            schema: None,
            sql: "SELECT 2;".to_string(),
            sql_loaded: true,
            order_index: 1,
            open_count: 0,
            opened_at: None,
            created_at: "2026-08-12".to_string(),
            updated_at: "2026-08-12".to_string(),
        };
        storage.save_saved_sql_file(&external).await.unwrap();
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&path).await.unwrap();
        assert_eq!(reopened.load_saved_sql_file("legacy").await.unwrap().unwrap().catalog, None);
        assert_eq!(
            reopened.load_saved_sql_file("external").await.unwrap().unwrap().catalog.as_deref(),
            Some("iceberg_catalog")
        );
    }

    // ---- AI Config tests ----

    use crate::ai::{
        AiApiStyle, AiAuthMethod, AiConfig, AiConfigItem, AiEffortLevel, AiModelListItem, AiProvider, AiReasoningLevel,
    };

    fn make_ai_config(name: &str, is_default: bool) -> AiConfigItem {
        AiConfigItem {
            id: format!("cfg-{name}"),
            name: name.to_string(),
            is_default,
            config: AiConfig {
                provider: AiProvider::Openai,
                api_key: "sk-test".to_string(),
                auth_method: AiAuthMethod::ApiKey,
                endpoint: "https://api.openai.com/v1".to_string(),
                model: "gpt-4o".to_string(),
                models: Vec::new(),
                api_style: AiApiStyle::Completions,
                custom_headers: Default::default(),
                proxy_enabled: false,
                proxy_url: String::new(),
                skip_tls_verify: false,
                enable_thinking: true,
                reasoning_level: AiReasoningLevel::Default,
                max_output_tokens: None,
                runtime_effort: None,
                context_window: None,
                max_retries: None,
                codex_cli_path: None,
                codex_cli_env: std::collections::HashMap::new(),
                claude_code_cli_path: None,
                claude_code_cli_env: std::collections::HashMap::new(),
                pi_agent_cli_path: None,
                pi_agent_cli_env: std::collections::HashMap::new(),
                opencode_cli_path: None,
                opencode_cli_env: std::collections::HashMap::new(),
                cursor_cli_path: None,
                cursor_cli_env: std::collections::HashMap::new(),
                grok_cli_path: None,
                grok_cli_env: std::collections::HashMap::new(),
                codebuddy_cli_path: None,
                codebuddy_cli_env: std::collections::HashMap::new(),
                qoder_cli_path: None,
                qoder_cli_env: Default::default(),
            },
        }
    }

    #[tokio::test]
    async fn ai_config_save_load_roundtrip() {
        let db = temp_db_path("ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("test-config", true);
        cfg.config.provider = AiProvider::ClaudeCodeCli;
        cfg.config.model = "claude-sonnet-4-6".to_string();
        cfg.config.reasoning_level = AiReasoningLevel::Xhigh;
        cfg.config.models = vec![AiModelListItem {
            name: "claude-sonnet-4-6".to_string(),
            label: Some("Sonnet 4.6".to_string()),
            supported_effort_levels: vec![AiEffortLevel::Low, AiEffortLevel::High, AiEffortLevel::Xhigh],
        }];
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "cfg-test-config");
        assert_eq!(loaded[0].name, "test-config");
        assert!(loaded[0].is_default);
        assert_eq!(loaded[0].config.model, "claude-sonnet-4-6");
        assert_eq!(loaded[0].config.reasoning_level, AiReasoningLevel::Xhigh);
        assert_eq!(loaded[0].config.models.len(), 1);
        assert_eq!(loaded[0].config.models[0].name, "claude-sonnet-4-6");
        assert_eq!(
            loaded[0].config.models[0].supported_effort_levels,
            vec![AiEffortLevel::Low, AiEffortLevel::High, AiEffortLevel::Xhigh]
        );

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn legacy_ai_and_tunnel_inline_secrets_are_migrated_on_reopen() {
        let db = temp_db_path("legacy-config-secret-migration");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut ai = make_ai_config("legacy", true);
        storage.save_ai_config_item(&ai).await.unwrap();
        ai.config.api_key = "legacy-ai-key".to_string();
        let ai_json = serde_json::to_string(&ai.config).unwrap();
        let tunnel = ssh_profile("legacy-tunnel", "legacy-tunnel-password");
        storage.save_tunnel_profiles(std::slice::from_ref(&tunnel)).await.unwrap();
        let tunnel_json = serde_json::to_string(&tunnel).unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute("UPDATE ai_configs SET config_json = ?1 WHERE id = 'cfg-legacy'", [&ai_json])
                    .map_err(|error| error.to_string())?;
                conn.execute("DELETE FROM connection_secrets WHERE connection_id = 'ai_config.cfg-legacy'", [])
                    .map_err(|error| error.to_string())?;
                conn.execute("UPDATE tunnel_profiles SET config_json = ?1 WHERE id = 'legacy-tunnel'", [&tunnel_json])
                    .map_err(|error| error.to_string())?;
                conn.execute("DELETE FROM connection_secrets WHERE connection_id = 'tunnel_profile.legacy-tunnel'", [])
                    .map_err(|error| error.to_string())?;
                Ok(())
            })
            .await
            .unwrap();
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        let raw_ai = reopened
            .with_conn(|conn| {
                conn.query_row("SELECT config_json FROM ai_configs WHERE id = 'cfg-legacy'", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        let raw_tunnel = reopened
            .with_conn(|conn| {
                conn.query_row("SELECT config_json FROM tunnel_profiles WHERE id = 'legacy-tunnel'", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(!raw_ai.contains("legacy-ai-key"));
        assert!(!raw_tunnel.contains("legacy-tunnel-password"));
        assert_eq!(reopened.load_ai_configs().await.unwrap()[0].config.api_key, "legacy-ai-key");
        assert_eq!(reopened.load_tunnel_profiles().await.unwrap(), vec![tunnel]);
        let encrypted = reopened
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM connection_secrets WHERE secret_enc LIKE 'dbxenc1.%' AND secret = ''",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(encrypted >= 2);
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn opencode_cli_ai_config_roundtrip() {
        let db = temp_db_path("opencode-cli-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("opencode-cli", true);
        cfg.config.provider = AiProvider::OpenCodeCli;
        cfg.config.api_key.clear();
        cfg.config.endpoint.clear();
        cfg.config.model = "openai/gpt-5.4-mini".to_string();
        cfg.config.opencode_cli_path = Some("/opt/homebrew/bin/opencode".to_string());
        cfg.config.opencode_cli_env.insert("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string());
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::OpenCodeCli));
        assert_eq!(loaded[0].config.model, "openai/gpt-5.4-mini");
        assert_eq!(loaded[0].config.opencode_cli_path.as_deref(), Some("/opt/homebrew/bin/opencode"));
        assert_eq!(
            loaded[0].config.opencode_cli_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn cursor_cli_ai_config_roundtrip() {
        let db = temp_db_path("cursor-cli-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("cursor-cli", true);
        cfg.config.provider = AiProvider::CursorCli;
        cfg.config.api_key.clear();
        cfg.config.endpoint.clear();
        cfg.config.model = "composer-2.5".to_string();
        cfg.config.cursor_cli_path = Some("~/.local/bin/agent".to_string());
        cfg.config.cursor_cli_env.insert("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string());
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::CursorCli));
        assert_eq!(loaded[0].config.model, "composer-2.5");
        assert_eq!(loaded[0].config.cursor_cli_path.as_deref(), Some("~/.local/bin/agent"));
        assert_eq!(
            loaded[0].config.cursor_cli_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn grok_cli_ai_config_roundtrip() {
        let db = temp_db_path("grok-cli-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("grok-cli", true);
        cfg.config.provider = AiProvider::GrokCli;
        cfg.config.api_key = String::new();
        cfg.config.auth_method = AiAuthMethod::Bearer;
        cfg.config.endpoint = String::new();
        cfg.config.model = "default".to_string();
        cfg.config.api_style = AiApiStyle::Completions;
        cfg.config.grok_cli_path = Some("/Users/me/.grok/bin/grok".to_string());
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::GrokCli));
        assert_eq!(loaded[0].config.model, "default");
        assert_eq!(loaded[0].config.grok_cli_path.as_deref(), Some("/Users/me/.grok/bin/grok"));

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn codebuddy_cli_ai_config_roundtrip() {
        let db = temp_db_path("codebuddy-cli-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("codebuddy-cli", true);
        cfg.config.provider = AiProvider::CodeBuddyCli;
        cfg.config.api_key.clear();
        cfg.config.endpoint.clear();
        cfg.config.model = "kimi-k2.5".to_string();
        cfg.config.codebuddy_cli_path = Some("/opt/homebrew/bin/codebuddy".to_string());
        cfg.config.codebuddy_cli_env.insert("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string());
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::CodeBuddyCli));
        assert_eq!(loaded[0].config.model, "kimi-k2.5");
        assert_eq!(loaded[0].config.codebuddy_cli_path.as_deref(), Some("/opt/homebrew/bin/codebuddy"));
        assert_eq!(
            loaded[0].config.codebuddy_cli_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn anthropic_compatible_ai_config_roundtrip() {
        let db = temp_db_path("anthropic-compatible-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("anthropic-compatible", true);
        cfg.config.provider = AiProvider::AnthropicCompatible;
        cfg.config.api_key = String::new();
        cfg.config.auth_method = AiAuthMethod::Bearer;
        cfg.config.endpoint = "https://gateway.example.com/anthropic/v1/messages".to_string();
        cfg.config.model = "vendor/future-model".to_string();
        cfg.config.api_style = AiApiStyle::AnthropicMessages;
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::AnthropicCompatible));
        assert_eq!(loaded[0].config.auth_method, AiAuthMethod::Bearer);
        assert_eq!(loaded[0].config.api_style, AiApiStyle::AnthropicMessages);
        assert_eq!(loaded[0].config.endpoint, "https://gateway.example.com/anthropic/v1/messages");
        assert_eq!(loaded[0].config.model, "vendor/future-model");
        assert!(loaded[0].config.api_key.is_empty());

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn minimax_ai_config_roundtrip() {
        let db = temp_db_path("minimax-ai-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let mut cfg = make_ai_config("minimax", true);
        cfg.config.provider = AiProvider::MiniMax;
        cfg.config.api_key = "key".to_string();
        cfg.config.auth_method = AiAuthMethod::Bearer;
        cfg.config.endpoint = "https://api.minimax.io/v1".to_string();
        cfg.config.model = "MiniMax-M3".to_string();
        cfg.config.api_style = AiApiStyle::Completions;
        storage.save_ai_config_item(&cfg).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(matches!(loaded[0].config.provider, AiProvider::MiniMax));
        assert_eq!(loaded[0].config.auth_method, AiAuthMethod::Bearer);
        assert_eq!(loaded[0].config.endpoint, "https://api.minimax.io/v1");
        assert_eq!(loaded[0].config.model, "MiniMax-M3");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_only_one_default() {
        let db = temp_db_path("ai-one-default");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let cfg1 = make_ai_config("config-a", true);
        let cfg2 = make_ai_config("config-b", true);
        storage.save_ai_config_item(&cfg1).await.unwrap();

        // Second default config should succeed and cascade-clear the first
        storage.save_ai_config_item(&cfg2).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        let defaults: Vec<_> = loaded.iter().filter(|c| c.is_default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].id, "cfg-config-b");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_update_existing_to_default() {
        let db = temp_db_path("ai-update-default");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let cfg1 = make_ai_config("config-a", true);
        let cfg2 = make_ai_config("config-b", false);
        storage.save_ai_config_item(&cfg1).await.unwrap();
        storage.save_ai_config_item(&cfg2).await.unwrap();
        assert_eq!(storage.load_ai_configs().await.unwrap().iter().filter(|c| c.is_default).count(), 1);

        // Update cfg-b to be default via save_ai_config_item — should succeed and clear cfg-a
        let cfg2 = make_ai_config("config-b", true);
        storage.save_ai_config_item(&cfg2).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        let defaults: Vec<_> = loaded.iter().filter(|c| c.is_default).collect();
        assert_eq!(defaults.len(), 1);
        assert_eq!(defaults[0].id, "cfg-config-b");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_duplicate_name_error() {
        let db = temp_db_path("ai-dup-name");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let cfg1 = make_ai_config("same-name", false);
        storage.save_ai_config_item(&cfg1).await.unwrap();

        // Different id, same name → should fail with name conflict
        let mut cfg2 = make_ai_config("same-name", false);
        cfg2.id = "cfg-other".to_string();
        let err = storage.save_ai_config_item(&cfg2).await.unwrap_err();
        assert!(err.contains("ai.configNameExists"), "Expected name conflict error, got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_set_default_switches() {
        let db = temp_db_path("ai-set-default");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let cfg1 = make_ai_config("first", true);
        let cfg2 = make_ai_config("second", false);
        storage.save_ai_config_item(&cfg1).await.unwrap();
        storage.save_ai_config_item(&cfg2).await.unwrap();

        // Switch default to second
        storage.set_default_ai_config("cfg-second").await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        let first = loaded.iter().find(|c| c.id == "cfg-first").unwrap();
        let second = loaded.iter().find(|c| c.id == "cfg-second").unwrap();
        assert!(!first.is_default);
        assert!(second.is_default);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_delete_default_no_cascade() {
        let db = temp_db_path("ai-delete-default");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let cfg1 = make_ai_config("default-one", true);
        let cfg2 = make_ai_config("other", false);
        storage.save_ai_config_item(&cfg1).await.unwrap();
        storage.save_ai_config_item(&cfg2).await.unwrap();

        // Delete the default config
        storage.delete_ai_config("cfg-default-one").await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        // Remaining config should NOT be auto-promoted to default
        assert!(!loaded[0].is_default);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_save_configs_batch() {
        let db = temp_db_path("ai-batch");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let configs =
            vec![make_ai_config("batch-a", true), make_ai_config("batch-b", false), make_ai_config("batch-c", false)];
        storage.save_ai_configs(&configs).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 3);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_secret_fields_are_not_written_to_config_json() {
        let db = temp_db_path("ai-secret-at-rest");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        let config = make_ai_config("secret-config", true);
        storage.save_ai_configs(std::slice::from_ref(&config)).await.unwrap();
        let raw = storage
            .with_conn(|conn| {
                conn.query_row("SELECT config_json FROM ai_configs WHERE id = 'cfg-secret-config'", [], |row| {
                    row.get::<_, String>(0)
                })
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(!raw.contains("sk-test"));
        let encrypted = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret_enc FROM connection_secrets WHERE connection_id = 'ai_config.cfg-secret-config' AND key = 'config'",
                    [],
                    |row| row.get::<_, Option<String>>(0),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(encrypted.is_some_and(|value| value.starts_with("dbxenc1.")));
        assert_eq!(storage.load_ai_configs().await.unwrap()[0].config.api_key, "sk-test");
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_save_configs_clears_old_tables() {
        let db = temp_db_path("ai-clear-old");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        // Pre-populate old tables as if migration hasn't run yet
        storage.save_ai_config(&make_ai_config("legacy-active", false).config).await.unwrap();
        storage.save_ai_provider_config("openai", &make_ai_config("legacy-openai", false).config).await.unwrap();

        // save_ai_configs should clear old tables
        let configs = vec![make_ai_config("new-a", true)];
        storage.save_ai_configs(&configs).await.unwrap();

        // New table has the saved config
        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "new-a");

        // Old tables are cleared — prevents re-migration on restart
        assert!(storage.load_ai_config().await.unwrap().is_none(), "ai_config should be deleted");
        let old_providers = storage.load_ai_provider_configs().await.unwrap();
        assert!(old_providers.is_empty(), "ai_provider_configs should be deleted");

        std::fs::remove_file(&db).ok();
    }

    // --- Prompt Templates ---

    #[tokio::test]
    async fn prompt_template_save_new_creates_timestamps() {
        let db = temp_db_path("pt-save-new");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let result = storage.save_prompt_template("t1", "Production Rules", "SELECT 1").await.unwrap();

        assert_eq!(result.id, "t1");
        assert_eq!(result.name, "Production Rules");
        assert_eq!(result.content, "SELECT 1");
        assert!(!result.created_at.is_empty());
        assert_eq!(result.created_at, result.updated_at);

        // Verify it's persisted in load
        let templates = storage.load_prompt_templates().await.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].id, "t1");
        assert_eq!(templates[0].created_at, result.created_at);
        assert_eq!(templates[0].updated_at, result.updated_at);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_update_preserves_created_at() {
        let db = temp_db_path("pt-save-update");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let first = storage.save_prompt_template("t1", "Original Name", "Original content").await.unwrap();
        // Ensure some time passes so updated_at changes
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let second = storage.save_prompt_template("t1", "Updated Name", "Updated content").await.unwrap();

        assert_eq!(second.id, "t1");
        assert_eq!(second.name, "Updated Name");
        assert_eq!(second.content, "Updated content");
        assert_eq!(second.created_at, first.created_at, "created_at must be preserved on update");
        assert_ne!(second.updated_at, first.updated_at, "updated_at must change on update");

        // Verify only one row exists
        let templates = storage.load_prompt_templates().await.unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].name, "Updated Name");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_blank_name() {
        let db = temp_db_path("pt-name-blank");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let err = storage.save_prompt_template("t1", "", "content").await.unwrap_err();
        assert!(err.contains("cannot be empty"), "expected 'cannot be empty', got: {err}");

        let err = storage.save_prompt_template("t1", "   ", "content").await.unwrap_err();
        assert!(err.contains("cannot be empty"), "expected 'cannot be empty', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_long_name() {
        let db = temp_db_path("pt-name-long");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let long_name = "a".repeat(51);
        let err = storage.save_prompt_template("t1", &long_name, "content").await.unwrap_err();
        assert!(err.contains("too long") && err.contains("50"), "expected too long (max 50), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_accepts_multi_byte_characters_within_char_limit() {
        let db = temp_db_path("pt-multibyte-name");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        // 25 Chinese characters = 75 bytes but only 25 chars — should be allowed under 50 char limit
        let name25 = "数".repeat(25); // 25 chars, 75 bytes
        assert_eq!(name25.chars().count(), 25);
        assert!(name25.len() > 50); // byte length exceeds 50

        let result = storage.save_prompt_template("t1", &name25, "content").await.unwrap();
        assert_eq!(result.name, name25);

        // 51 Chinese characters = 153 bytes — should be rejected (51 chars > 50)
        let name51 = "数".repeat(51);
        assert_eq!(name51.chars().count(), 51);
        let err = storage.save_prompt_template("t2", &name51, "content").await.unwrap_err();
        assert!(err.contains("too long") && err.contains("50"), "expected too long (max 50), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_long_content() {
        let db = temp_db_path("pt-content-long");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let long_content = "a".repeat(8001);
        let err = storage.save_prompt_template("t1", "Valid Name", &long_content).await.unwrap_err();
        assert!(err.contains("too long") && err.contains("8000"), "expected too long (max 8000), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_duplicate_name_case_insensitive() {
        let db = temp_db_path("pt-dup-name");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        storage.save_prompt_template("t1", "Production Rules", "content 1").await.unwrap();

        // Same name, different id → should fail
        let err = storage.save_prompt_template("t2", "production rules", "content 2").await.unwrap_err();
        assert!(err.contains("duplicate"), "expected 'duplicate', got: {err}");

        // Same name, same id → should update (not fail)
        let update = storage.save_prompt_template("t1", "Production Rules", "updated").await.unwrap();
        assert_eq!(update.id, "t1");
        assert_eq!(update.content, "updated");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_duplicate_name_unicode_case_folding() {
        let db = temp_db_path("pt-dup-unicode");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        // SQLite LOWER() is ASCII-only (U+00C4 'Ä' → no change), but Rust
        // str::to_lowercase() does full Unicode case folding (Ä → ä).
        // Both directions must detect the duplicate.
        storage.save_prompt_template("t1", "Ä规则", "content-upper").await.unwrap();
        let err = storage.save_prompt_template("t2", "ä规则", "content-lower").await.unwrap_err();
        assert!(err.contains("duplicate"), "expected 'duplicate', got: {err}");

        // Reverse: lower-case first, upper-case second.
        let db = temp_db_path("pt-dup-unicode-2");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        storage.save_prompt_template("t1", "ä规则", "content-lower").await.unwrap();
        let err = storage.save_prompt_template("t2", "Ä规则", "content-upper").await.unwrap_err();
        assert!(err.contains("duplicate"), "expected 'duplicate', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_load_order_is_stable() {
        let db = temp_db_path("pt-load-order");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        // Insert in reverse order of created_at by sleeping between inserts
        storage.save_prompt_template("a", "Template A", "a").await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        storage.save_prompt_template("b", "Template B", "b").await.unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        storage.save_prompt_template("c", "Template C", "c").await.unwrap();

        let templates = storage.load_prompt_templates().await.unwrap();
        assert_eq!(templates.len(), 3);
        // Order should be by created_at ascending: A first, C last
        assert_eq!(templates[0].id, "a");
        assert_eq!(templates[1].id, "b");
        assert_eq!(templates[2].id, "c");

        // Insert with same created_at — tie-break by id
        // We insert d right after c without delay
        storage.save_prompt_template("d", "Template D", "d").await.unwrap();

        let templates = storage.load_prompt_templates().await.unwrap();
        assert_eq!(templates.len(), 4);
        assert_eq!(templates[3].id, "d");

        // Second load should give same order
        let templates2 = storage.load_prompt_templates().await.unwrap();
        assert_eq!(templates, templates2);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_delete_unknown_id_errors() {
        let db = temp_db_path("pt-delete-unknown");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let err = storage.delete_prompt_template("nonexistent").await.unwrap_err();
        assert!(err.contains("not found"), "expected 'not found', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_delete_existing_removes() {
        let db = temp_db_path("pt-delete-existing");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        storage.save_prompt_template("t1", "Template", "content").await.unwrap();
        assert_eq!(storage.load_prompt_templates().await.unwrap().len(), 1);

        storage.delete_prompt_template("t1").await.unwrap();
        assert!(storage.load_prompt_templates().await.unwrap().is_empty());

        std::fs::remove_file(&db).ok();
    }

    // --- Global Custom Instructions ---

    #[tokio::test]
    async fn global_instructions_set_get_roundtrip() {
        let db = temp_db_path("gi-roundtrip");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let instructions = "Amounts are in cents. Always filter by date range.";
        storage.save_ai_global_custom_instructions(instructions).await.unwrap();

        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, instructions);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_defaults_to_empty() {
        let db = temp_db_path("gi-default");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, "");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_rejects_too_long() {
        let db = temp_db_path("gi-too-long");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        let long = "a".repeat(8001);
        let err = storage.save_ai_global_custom_instructions(&long).await.unwrap_err();
        assert!(err.contains("too long") && err.contains("8000"), "expected too long (max 8000), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_empty_string_clears() {
        let db = temp_db_path("gi-clear");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        storage.save_ai_global_custom_instructions("Some instructions").await.unwrap();
        assert_eq!(storage.load_ai_global_custom_instructions().await.unwrap(), "Some instructions");

        // Empty string (trimmed) is allowed — equivalent to clear
        storage.save_ai_global_custom_instructions("").await.unwrap();
        assert_eq!(storage.load_ai_global_custom_instructions().await.unwrap(), "");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_whitespace_only_trims() {
        let db = temp_db_path("gi-whitespace");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();

        storage.save_ai_global_custom_instructions("   \n  \t  ").await.unwrap();
        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, "");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn pending_snippet_cleanup_survives_restart_and_clears_only_when_matched() {
        let db = temp_db_path("snippet-cleanup-restart");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        storage.save_snippet_migration_state("github", "replacement-id", "legacy-id", "content-hash").await.unwrap();
        drop(storage);

        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        let state = storage.load_snippet_sync_state("github").await.unwrap();
        assert_eq!(state.snippet_id.as_deref(), Some("replacement-id"));
        let pending = state.pending_cleanup.unwrap();
        assert_eq!(pending.snippet_id, "legacy-id");
        assert_eq!(pending.expected_content_hash, "content-hash");

        let mut wrong_pending = pending.clone();
        wrong_pending.expected_content_hash = "newer-content-hash".to_string();
        assert!(!storage.clear_snippet_pending_cleanup_if_matches("github", &wrong_pending).await.unwrap());
        assert!(storage.load_snippet_sync_state("github").await.unwrap().pending_cleanup.is_some());
        assert!(storage.clear_snippet_pending_cleanup_if_matches("github", &pending).await.unwrap());
        assert!(storage.load_snippet_sync_state("github").await.unwrap().pending_cleanup.is_none());

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn connection_secrets_are_encrypted_at_rest_and_legacy_rows_migrate() {
        let db = temp_db_path("secret-store-at-rest");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        let mut url_config = plain_connection("url-params", "url-password");
        url_config.url_params = Some("applicationName=dbx&PASSWORD=url-password&sslmode=require".to_string());
        storage.save_connections(std::slice::from_ref(&url_config)).await.unwrap();
        let raw_url_config = raw_connection_json(&storage, "url-params").await;
        assert!(!raw_url_config.contains("url-password"));
        assert_eq!(
            storage.load_connections().await.unwrap()[0].url_params.as_deref(),
            Some("applicationName=dbx&PASSWORD=url-password&sslmode=require")
        );
        let url_secret = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'url-params' AND key = 'url_params'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(url_secret.0.is_empty());
        assert!(url_secret.1.as_deref().is_some_and(|value| value.starts_with("dbxenc1.")));
        storage.set_secret("connection-1", "password", "super-secret").await.unwrap();
        assert_eq!(storage.get_secret("connection-1", "password").await.unwrap().as_deref(), Some("super-secret"));
        let row = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'connection-1' AND key = 'password'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(row.0.is_empty());
        assert!(row.1.as_deref().is_some_and(|value| value.starts_with("dbxenc1.")));

        // An old plaintext row remains readable and is rewritten on access.
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES ('legacy', 'password', 'old-secret', NULL)",
                    [],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert_eq!(storage.get_secret("legacy", "password").await.unwrap().as_deref(), Some("old-secret"));
        let migrated = storage
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'legacy' AND key = 'password'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(migrated.0.is_empty());
        assert!(migrated.1.as_deref().is_some_and(|value| value.starts_with("dbxenc1.")));
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn legacy_connection_config_migration_keeps_externalized_password() {
        // Regression: re-saving a legacy inline config wrote the config's empty
        // `password` field straight back into `connection_secrets`, which the
        // persistence path turns into a DELETE. A connection whose password
        // already lived in the secret store therefore lost it on upgrade.
        let id = "legacy-inline-url-params";
        let db = temp_db_path("legacy-connection-config-keeps-password");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        let mut config = plain_connection(id, "saved-password");
        config.url_params = Some("authSource=dbx_test".to_string());
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        // Restore the shape an older release persisted: `url_params` is still
        // inline in config_json while the password only exists as a secret.
        let mut inline = config.clone();
        inline.password = String::new();
        let inline_json = serde_json::to_string(&inline).unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute(
                    "UPDATE connections SET config_json = ?1 WHERE id = ?2",
                    rusqlite::params![inline_json, id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        let raw = raw_connection_json(&reopened, id).await;
        assert!(!raw.contains("authSource=dbx_test"));
        assert_eq!(reopened.get_secret(id, "password").await.unwrap().as_deref(), Some("saved-password"));
        let loaded = reopened.load_connections().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].password, "saved-password");
        assert_eq!(loaded[0].url_params.as_deref(), Some("authSource=dbx_test"));
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn legacy_connection_config_migration_still_drops_password_when_not_saved() {
        let id = "legacy-inline-url-params-unsaved";
        let db = temp_db_path("legacy-connection-config-drops-unsaved-password");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        let mut config = plain_connection(id, "saved-password");
        config.url_params = Some("authSource=dbx_test".to_string());
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        let mut inline = config.clone();
        inline.password = String::new();
        inline.save_password = false;
        let inline_json = serde_json::to_string(&inline).unwrap();
        storage
            .with_conn(move |conn| {
                conn.execute(
                    "UPDATE connections SET config_json = ?1 WHERE id = ?2",
                    rusqlite::params![inline_json, id],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        drop(storage);

        // "Don't save password" must keep winning: the restore path must not
        // resurrect a credential this connection is configured not to keep.
        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        assert!(reopened.get_secret(id, "password").await.unwrap().is_none());
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn mqtt_password_is_encrypted_at_rest_and_hydrated_on_load() {
        let path = temp_db_path("mqtt-password-secret");
        let storage = crate::persistence::test_storage::open(&path).await.unwrap();
        let mut config = plain_connection("mqtt-password", "");
        config.db_type = DatabaseType::Mqtt;
        config.external_config = Some(serde_json::json!({
            "auth": { "kind": "password", "username": "mqtt-user", "password": "mqtt-secret" }
        }));
        storage.save_connections(std::slice::from_ref(&config)).await.unwrap();

        let raw = raw_connection_json(&storage, "mqtt-password").await;
        assert!(!raw.contains("mqtt-secret"));
        assert!(storage
            .get_secret("mqtt-password", MQTT_AUTH_PASSWORD_KEY)
            .await
            .unwrap()
            .is_some_and(|secret| secret == "mqtt-secret"));
        assert_eq!(storage.load_connections().await.unwrap()[0], config);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn legacy_plaintext_secrets_are_migrated_during_reopen() {
        let db = temp_db_path("secret-store-startup-migration");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES ('legacy-startup', 'password', 'old-secret', NULL)",
                    [],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        let row = reopened
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'legacy-startup' AND key = 'password'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(row.0.is_empty());
        assert!(row.1.as_deref().is_some_and(|value| value.starts_with("dbxenc1.")));

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn legacy_sync_credentials_are_migrated_from_app_settings_on_reopen() {
        let db = temp_db_path("legacy-app-settings-secrets");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        storage
            .with_conn(|conn| {
                conn.execute(
                    "INSERT OR REPLACE INTO app_settings (id, settings_json) VALUES (1, ?1)",
                    [serde_json::json!({
                        "local_device_secret": "legacy-device-secret",
                        "webdav_sync_secrets_passphrase": "legacy-sync-passphrase",
                        "webdav_passwords": {"webdav:https://example.test": {"ciphertext": "legacy-blob"}}
                    })
                    .to_string()],
                )
                .map(|_| ())
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        let settings = reopened.load_app_settings_json().await.unwrap();
        assert!(!settings.contains_key("local_device_secret"));
        assert!(!settings.contains_key("webdav_sync_secrets_passphrase"));
        assert!(!settings.contains_key("webdav_passwords"));
        assert_eq!(
            reopened.get_secret(super::GLOBAL_SECRET_NAMESPACE, "local_device_secret").await.unwrap().as_deref(),
            Some("legacy-device-secret")
        );
        assert_eq!(
            reopened
                .get_secret(super::GLOBAL_SECRET_NAMESPACE, "webdav_sync_secrets_passphrase")
                .await
                .unwrap()
                .as_deref(),
            Some("legacy-sync-passphrase")
        );
        assert_eq!(
            reopened
                .get_secret(super::GLOBAL_SECRET_NAMESPACE, "webdav_password.webdav:https://example.test")
                .await
                .unwrap()
                .as_deref(),
            Some(r#"{"ciphertext":"legacy-blob"}"#)
        );
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn legacy_inline_connection_secrets_are_migrated_during_reopen() {
        let db = temp_db_path("inline-secret-startup-migration");
        let storage = crate::persistence::test_storage::open(&db).await.unwrap();
        insert_raw_connection(&storage, &plain_connection("legacy-inline", "old-inline-secret")).await;
        drop(storage);

        let reopened = crate::persistence::test_storage::open(&db).await.unwrap();
        let raw = raw_connection_json(&reopened, "legacy-inline").await;
        assert!(!raw.contains("old-inline-secret"));
        assert_eq!(reopened.load_connections().await.unwrap()[0].password, "old-inline-secret");
        let row = reopened
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT secret, secret_enc FROM connection_secrets WHERE connection_id = 'legacy-inline' AND key = 'password'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
                )
                .map_err(|error| error.to_string())
            })
            .await
            .unwrap();
        assert!(row.0.is_empty());
        assert!(row.1.as_deref().is_some_and(|value| value.starts_with("dbxenc1.")));
        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn sync_import_transaction_rolls_back_metadata_when_later_write_fails() {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("dbx.db");
        let storage = crate::persistence::test_storage::open_unmigrated(&db)
            .await
            .unwrap()
            .with_secret_key_policy(SecretKeyPolicy::ManagedDataDir);
        storage.save_connections(&[plain_connection("existing", "old-secret")]).await.unwrap();
        let settings = storage.load_desktop_settings().await.unwrap();
        let mut incoming = plain_connection("incoming", "new-secret");
        incoming.url_params = Some("applicationName=dbx&sslmode=require".to_string());
        let plan = SyncImportPlan {
            connections: vec![incoming],
            tunnel_profiles: Some(Vec::new()),
            tunnel_secret_profiles: None,
            sidebar_layout: None,
            pinned_tree_node_ids: Vec::new(),
            saved_sql: SavedSqlLibrary {
                folders: vec![
                    SavedSqlFolder {
                        id: "duplicate-folder".to_string(),
                        connection_id: "incoming".to_string(),
                        parent_folder_id: None,
                        name: "one".to_string(),
                        order_index: 0,
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                    SavedSqlFolder {
                        id: "duplicate-folder".to_string(),
                        connection_id: "incoming".to_string(),
                        parent_folder_id: None,
                        name: "two".to_string(),
                        order_index: 1,
                        created_at: String::new(),
                        updated_at: String::new(),
                    },
                ],
                files: Vec::new(),
            },
            desktop_settings: settings,
            editor_settings: None,
            connection_secrets: None,
            preserve_plugin_secrets: false,
            sync_credentials: None,
            ai_configs: None,
        };
        assert!(storage.apply_sync_import_transaction(plan).await.is_err());
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "existing");
        assert_eq!(storage.get_secret("existing", "password").await.unwrap().as_deref(), Some("old-secret"));
        assert_eq!(storage.get_secret("incoming", "url_params").await.unwrap(), None);
    }

    #[test]
    fn migration_backup_manifest_rejects_invalid_paths() {
        let invalid = serde_json::json!({"backupPaths": "not-a-list"});
        assert!(super::migration_backup_paths(&invalid).is_err());
        let valid = serde_json::json!({"backupPaths": ["/tmp/dbx-secret-migration-a"]});
        assert_eq!(super::migration_backup_paths(&valid).unwrap(), vec!["/tmp/dbx-secret-migration-a"]);
    }
}
