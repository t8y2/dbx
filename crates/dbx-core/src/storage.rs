use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use log::warn;
use rusqlite::{params, params_from_iter, types::Value, Connection, DatabaseName, OpenFlags, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::{AiChatMessage, AiConfig, AiConfigItem, AiConversation, AiProvider};
use crate::connection_secrets::{
    MQ_AUTH_API_KEY_VALUE_KEY, MQ_AUTH_CLIENT_SECRET_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_SECRET_PREFIX,
    MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY, MQ_TOKEN_SIGNING_SECRET_PREFIX, NACOS_AUTH_PASSWORD_KEY,
    NACOS_AUTH_SECRET_PREFIX, NACOS_RNACOS_CONSOLE_PASSWORD_KEY,
};
use crate::db::sqlite::{connect_path_create_if_missing, SqliteHandle};
use crate::history::{
    HistoryConnectionFilter, HistoryConnectionOption, HistoryCursor, HistoryDatabaseFilter, HistoryEntry,
    HistorySearchRequest, HistorySearchResult, MAX_HISTORY,
};
use crate::models::connection::{ConnectionConfig, DatabaseConnectionInfo, DatabaseType, TransportLayerConfig};
use crate::prompt_template::PromptTemplate;
use crate::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";
const STORAGE_DB_FILE_NAME: &str = "dbx.db";
const APP_STATE_EDITOR_SETTINGS_KEY: &str = "editor_settings";
const APP_STATE_OPEN_TABS_KEY: &str = "open_tabs";
const APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY: &str = "saved_sql_editor_positions";
const MCP_GLOBAL_POLICY_KEY: &str = "mcp_global_policy";
const APP_STATE_AI_GLOBAL_INSTRUCTIONS_KEY: &str = "ai_global_custom_instructions";
const USER_DATA_TABLES: &[&str] = &[
    "connections",
    "connection_secrets",
    "history",
    "ai_conversations",
    "mq_token_records",
    "saved_sql_folders",
    "saved_sql_files",
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

pub struct Storage {
    db: SqliteHandle,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGlobalPolicyState {
    pub configured: bool,
    pub read_only: bool,
    pub allow_dangerous_sql: bool,
    pub allowed_connection_ids: Option<Vec<String>>,
}

impl McpGlobalPolicyState {
    pub fn policy(&self) -> McpGlobalPolicy {
        McpGlobalPolicy {
            read_only: self.read_only,
            allow_dangerous_sql: self.allow_dangerous_sql,
            allowed_connection_ids: self.allowed_connection_ids.clone(),
        }
    }
}

fn default_sidebar_table_page_size() -> usize {
    1000
}

pub const DUCKDB_WORKER_MAX_PROCESSES_MIN: usize = 1;
pub const DUCKDB_WORKER_MAX_PROCESSES_MAX: usize = 16;
pub const DUCKDB_WORKER_MAX_PROCESSES_DEFAULT: usize = 4;

pub fn default_duckdb_worker_max_processes() -> usize {
    DUCKDB_WORKER_MAX_PROCESSES_DEFAULT
}

pub fn normalize_duckdb_worker_max_processes(value: usize) -> usize {
    value.clamp(DUCKDB_WORKER_MAX_PROCESSES_MIN, DUCKDB_WORKER_MAX_PROCESSES_MAX)
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            show_tray_icon: true,
            icon_theme: DesktopIconTheme::Default,
            quit_on_close: false,
            close_action_prompted: false,
            debug_logging_enabled: false,
            duckdb_worker_process_isolation: false,
            duckdb_worker_max_processes: default_duckdb_worker_max_processes(),
            saved_sql_sync_dir: None,
            driver_store_dir: None,
            plugin_store_dir: None,
            agent_store_dir: None,
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
    "CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS connection_secrets (
        connection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        secret TEXT NOT NULL,
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
        database TEXT NOT NULL DEFAULT '',
        messages_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
    "CREATE TABLE IF NOT EXISTS sidebar_layout (
        id INTEGER PRIMARY KEY CHECK (id = 1),
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
        updated_at TEXT NOT NULL
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
    "CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        content TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT ''
    )",
];

impl Storage {
    pub async fn open(db_path: &Path) -> Result<Self, String> {
        let db_path = db_path.to_string_lossy().to_string();
        let db = connect_path_create_if_missing(&db_path).await?;
        let storage = Self { db };
        storage.init_schema().await?;
        Ok(storage)
    }

    async fn init_schema(&self) -> Result<(), String> {
        self.db.with_connection(|conn| {
            for statement in SCHEMA_STATEMENTS {
                conn.execute(statement, []).map_err(|e| e.to_string())?;
            }
            ensure_history_columns_sync(conn)?;
            ensure_saved_sql_columns_sync(conn)?;
            ensure_tab_runtime_cache_columns_sync(conn)?;
            ensure_ai_configs_columns_sync(conn)?;
            Ok(())
        })
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

impl Storage {
    pub async fn save_history_entry(&self, entry: &HistoryEntry) -> Result<(), String> {
        let entry = entry.clone();
        self.with_conn(move |conn| {
            conn.execute(
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

            conn.execute(
                "DELETE FROM history WHERE id NOT IN \
                 (SELECT id FROM history ORDER BY executed_at DESC LIMIT ?1)",
                [MAX_HISTORY as i64],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
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
        let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute("INSERT OR REPLACE INTO ai_config (id, config_json) VALUES (1, ?1)", [json])
                .map(|_| ())
                .map_err(|e| e.to_string())
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
        json.map(|value| serde_json::from_str(&value).map_err(|e| e.to_string())).transpose()
    }

    pub async fn save_ai_provider_config(&self, provider: &str, config: &AiConfig) -> Result<(), String> {
        let parsed_provider = ai_provider_from_key(provider)?;
        let mut config = config.clone();
        let config_provider = ai_provider_key(&config.provider);
        if config_provider != provider {
            warn!(
                "save_ai_provider_config: config.provider ({}) does not match provider key ({}), normalizing",
                config_provider, provider
            );
            config.provider = parsed_provider;
        }
        let provider = provider.to_string();
        let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO ai_provider_configs (provider, config_json) VALUES (?1, ?2)",
                params![provider, json],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_ai_provider_configs(&self) -> Result<HashMap<String, AiConfig>, String> {
        self.with_conn(|conn| {
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
        .await
    }

    pub async fn save_ai_configs(&self, configs: &[AiConfigItem]) -> Result<(), String> {
        let configs = configs.to_vec();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM ai_configs", []).map_err(|e| e.to_string())?;
            for config in &configs {
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
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn load_ai_configs(&self) -> Result<Vec<AiConfigItem>, String> {
        self.with_conn(|conn| {
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
                let (id, name, model_col, models_json_col, json, is_default_col) = row.map_err(|e| e.to_string())?;
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
        .await
    }

    pub async fn set_default_ai_config(&self, config_id: &str) -> Result<(), String> {
        let config_id = config_id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("UPDATE ai_configs SET is_default = 0 WHERE is_default = 1", []).map_err(|e| e.to_string())?;
            tx.execute("UPDATE ai_configs SET is_default = 1 WHERE id = ?1", params![config_id])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn save_ai_config_item(&self, config: &AiConfigItem) -> Result<(), String> {
        let config = config.clone();
        self.with_conn(move |conn| {
            let json = serde_json::to_string(&config.config).map_err(|e| e.to_string())?;
            let models_json = serde_json::to_string(&config.config.models).map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;

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

            tx.commit().map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn delete_ai_config(&self, config_id: &str) -> Result<(), String> {
        let config_id = config_id.to_string();
        self.with_conn(move |conn| {
            conn.execute("DELETE FROM ai_configs WHERE id = ?1", params![config_id]).map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }
}

// Tunnel profiles — shared transport-layer configurations managed in
// Settings and referenced from connections via `profile_id`. Secrets stay
// inline in `config_json`; that matches the plaintext-at-rest posture of
// `connection_secrets` in the same database file.

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
        Ok(profiles)
    }

    pub async fn save_tunnel_profiles(&self, profiles: &[TransportLayerConfig]) -> Result<(), String> {
        for profile in profiles {
            if profile.id().trim().is_empty() {
                return Err("Tunnel profile id must not be empty".to_string());
            }
        }
        let profiles = profiles.to_vec();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM tunnel_profiles", []).map_err(|e| e.to_string())?;
            for profile in &profiles {
                let json = serde_json::to_string(profile).map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO tunnel_profiles (id, config_json) VALUES (?1, ?2)",
                    params![profile.id(), json],
                )
                .map_err(|e| e.to_string())?;
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
            // The dedicated policy writer is the only owner of this key. Keep
            // its latest value across overlapping legacy settings saves.
            let current: Option<String> = conn
                .query_row("SELECT settings_json FROM app_settings WHERE id = 1", [], |row| row.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            settings.remove(MCP_GLOBAL_POLICY_KEY);
            if let Some(current) = current {
                let current = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&current)
                    .map_err(|e| format!("invalid app settings JSON: {e}"))?;
                if let Some(policy) = current.get(MCP_GLOBAL_POLICY_KEY) {
                    settings.insert(MCP_GLOBAL_POLICY_KEY.to_string(), policy.clone());
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
                    });
                };
                let policy = serde_json::from_value::<McpGlobalPolicy>(value.clone())
                    .map_err(|e| format!("invalid MCP policy: {e}"))?;
                Ok(McpGlobalPolicyState {
                    configured: true,
                    read_only: policy.read_only,
                    allow_dangerous_sql: policy.allow_dangerous_sql,
                    allowed_connection_ids: policy.allowed_connection_ids,
                })
            })
            .await;
        result.map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))
    }

    pub async fn save_mcp_global_policy(&self, policy: &McpGlobalPolicy) -> Result<(), String> {
        let policy = serde_json::to_value(policy).map_err(|e| format!("MCP_POLICY_UNAVAILABLE: {e}"))?;
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

    pub async fn load_or_create_local_device_secret(&self) -> Result<String, String> {
        let mut settings = self.load_app_settings_json().await?;
        if let Some(secret) = settings.get("local_device_secret").and_then(|value| value.as_str()) {
            if !secret.is_empty() {
                return Ok(secret.to_string());
            }
        }
        let secret = Uuid::new_v4().to_string();
        settings.insert("local_device_secret".to_string(), serde_json::Value::String(secret.clone()));
        self.save_app_settings_json(&settings).await?;
        Ok(secret)
    }

    pub async fn save_webdav_password_blob(&self, account: &str, blob: &serde_json::Value) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        let mut credentials =
            settings.remove("webdav_passwords").and_then(|value| value.as_object().cloned()).unwrap_or_default();
        credentials.insert(account.to_string(), blob.clone());
        settings.insert("webdav_passwords".to_string(), serde_json::Value::Object(credentials));
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_webdav_password_blob(&self, account: &str) -> Result<Option<serde_json::Value>, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings
            .get("webdav_passwords")
            .and_then(|value| value.as_object())
            .and_then(|credentials| credentials.get(account))
            .cloned())
    }

    pub async fn delete_webdav_password_blob(&self, account: &str) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        let Some(mut credentials) = settings.remove("webdav_passwords").and_then(|value| value.as_object().cloned())
        else {
            return Ok(());
        };
        credentials.remove(account);
        settings.insert("webdav_passwords".to_string(), serde_json::Value::Object(credentials));
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
            settings.insert("webdav_sync_secrets_passphrase".to_string(), blob.clone());
        }
        self.save_app_settings_json(&settings).await
    }

    pub async fn load_webdav_sync_secrets_enabled(&self) -> Result<bool, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings.get("webdav_sync_secrets_enabled").and_then(serde_json::Value::as_bool).unwrap_or(false))
    }

    pub async fn load_webdav_sync_secrets_passphrase_blob(&self) -> Result<Option<serde_json::Value>, String> {
        let settings = self.load_app_settings_json().await?;
        Ok(settings.get("webdav_sync_secrets_passphrase").cloned())
    }

    pub async fn delete_webdav_sync_secrets_passphrase_blob(&self) -> Result<(), String> {
        let mut settings = self.load_app_settings_json().await?;
        settings.remove("webdav_sync_secrets_passphrase");
        self.save_app_settings_json(&settings).await
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
}

// AI Conversations

impl Storage {
    pub async fn save_ai_conversation(&self, conv: &AiConversation) -> Result<(), String> {
        let conv = conv.clone();
        let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO ai_conversations \
                 (id, title, connection_name, database, messages_json, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
                params![
                    conv.id,
                    conv.title,
                    conv.connection_name,
                    conv.database,
                    messages_json,
                    conv.created_at,
                    conv.updated_at
                ],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "DELETE FROM ai_conversations WHERE id NOT IN \
                 (SELECT id FROM ai_conversations ORDER BY updated_at DESC LIMIT 50)",
                [],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        })
        .await
    }

    pub async fn load_ai_conversations(&self) -> Result<Vec<AiConversation>, String> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, connection_name, database, messages_json, created_at, updated_at \
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
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
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
            conn.execute("DELETE FROM ai_conversations WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string())
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
                    .map_err(|e| format!("MCP_POLICY_UNAVAILABLE: invalid MCP policy: {e}"))?,
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
        if policy.allowed_connection_ids.as_ref().is_some_and(|ids| !ids.iter().any(|id| id == connection_id)) {
            return Err(format!(
                "CONNECTION_OUT_OF_SCOPE: connection '{connection_id}' is not allowed by the current DBX MCP policy"
            ));
        }
    }
    Ok(())
}

fn persist_connection_in_tx(tx: &rusqlite::Transaction<'_>, config: &ConnectionConfig) -> Result<(), String> {
    let config = config.clone().canonicalized();
    let config_id = config.id.clone();
    let mut sanitized = config.clone();
    sanitized.password = String::new();
    scrub_transport_layer_secrets(&mut sanitized);
    sanitized.redis_sentinel_password = String::new();
    sanitized.connection_string = None;
    sanitized.init_script = None;
    scrub_mq_auth_secrets(&mut sanitized);
    scrub_mq_token_signing_secret(&mut sanitized);
    scrub_nacos_auth_secrets(&mut sanitized);
    let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

    tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config_id, json])
        .map_err(|e| e.to_string())?;

    persist_secret_in_tx(tx, &config.id, "password", &config.password)?;
    delete_secret_prefix_in_tx(tx, &config.id, TRANSPORT_LAYER_SECRET_PREFIX)?;
    for (index, layer) in config.transport_layers.iter().enumerate() {
        match layer {
            TransportLayerConfig::Ssh(ssh) => {
                persist_secret_in_tx(tx, &config.id, &transport_layer_ssh_password_key(index, layer), &ssh.password)?;
                persist_secret_in_tx(
                    tx,
                    &config.id,
                    &transport_layer_ssh_key_passphrase_key(index, layer),
                    &ssh.key_passphrase,
                )?;
            }
            TransportLayerConfig::Proxy(proxy) => {
                persist_secret_in_tx(
                    tx,
                    &config.id,
                    &transport_layer_proxy_password_key(index, layer),
                    &proxy.password,
                )?;
            }
            TransportLayerConfig::HttpTunnel(http) => {
                persist_secret_in_tx(
                    tx,
                    &config.id,
                    &transport_layer_http_tunnel_token_key(index, layer),
                    &http.token,
                )?;
            }
        }
    }
    persist_secret_in_tx(tx, &config.id, "redis_sentinel_password", &config.redis_sentinel_password)?;
    persist_secret_in_tx(tx, &config.id, "ssh_password", "")?;
    persist_secret_in_tx(tx, &config.id, "ssh_key_passphrase", "")?;
    persist_secret_in_tx(tx, &config.id, "proxy_password", "")?;
    delete_secret_prefix_in_tx(tx, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
    if let Some(cs) = &config.connection_string {
        persist_secret_in_tx(tx, &config.id, "connection_string", cs)?;
    } else {
        tx.execute(
            "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![config.id, "connection_string"],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(script) = &config.init_script {
        persist_secret_in_tx(tx, &config.id, "init_script", script)?;
    } else {
        tx.execute(
            "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
            params![config.id, "init_script"],
        )
        .map_err(|e| e.to_string())?;
    }
    persist_mq_auth_secrets_in_tx(tx, &config)?;
    persist_mq_token_signing_secret_in_tx(tx, &config)?;
    persist_nacos_auth_secrets_in_tx(tx, &config)
}

impl Storage {
    pub async fn save_connection_metadata_preserving_secrets(
        &self,
        configs: &[ConnectionConfig],
    ) -> Result<(), String> {
        let configs = configs.to_vec();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM connections", []).map_err(|e| e.to_string())?;

            for config in &configs {
                let config = config.canonicalized();
                let config_id = config.id.clone();
                let mut sanitized = config;
                sanitized.password = String::new();
                scrub_transport_layer_secrets(&mut sanitized);
                sanitized.redis_sentinel_password = String::new();
                sanitized.connection_string = None;
                sanitized.init_script = None;
                scrub_mq_auth_secrets(&mut sanitized);
                scrub_mq_token_signing_secret(&mut sanitized);
                scrub_nacos_auth_secrets(&mut sanitized);
                let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

                tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config_id, json])
                    .map_err(|e| e.to_string())?;
            }

            if configs.is_empty() {
                tx.execute("DELETE FROM connection_secrets", []).map_err(|e| e.to_string())?;
            } else {
                let placeholders = vec!["?"; configs.len()].join(",");
                let sql = format!("DELETE FROM connection_secrets WHERE connection_id NOT IN ({placeholders})");
                let ids = configs.iter().map(|config| &config.id as &dyn ToSql);
                tx.execute(&sql, params_from_iter(ids)).map_err(|e| e.to_string())?;
            }

            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_connections(&self, configs: &[ConnectionConfig]) -> Result<(), String> {
        let configs = configs.to_vec();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM connections", []).map_err(|e| e.to_string())?;

            for config in &configs {
                persist_connection_in_tx(&tx, config)?;
            }

            if configs.is_empty() {
                tx.execute("DELETE FROM connection_secrets", []).map_err(|e| e.to_string())?;
            } else {
                let placeholders = vec!["?"; configs.len()].join(",");
                let sql = format!("DELETE FROM connection_secrets WHERE connection_id NOT IN ({placeholders})");
                let ids = configs.iter().map(|config| &config.id as &dyn ToSql);
                tx.execute(&sql, params_from_iter(ids)).map_err(|e| e.to_string())?;
            }

            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        let config = config.canonicalized();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            ensure_mcp_connection_change_allowed_in_tx(&tx, None)?;
            persist_connection_in_tx(&tx, &config)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(config)
        })
        .await
    }

    pub async fn remove_connection_for_mcp(&self, connection_id: &str) -> Result<bool, String> {
        let connection_id = connection_id.to_string();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
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
            let mut config: ConnectionConfig = serde_json::from_str(&json).map_err(|error| error.to_string())?;
            config.database_info = database_info;
            let json = serde_json::to_string(&config).map_err(|error| error.to_string())?;
            conn.execute("UPDATE connections SET config_json = ?1 WHERE id = ?2", params![json, connection_id])
                .map(|_| ())
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
            let mut config: ConnectionConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            config.password = self.get_secret(&id, "password").await?.unwrap_or_default();
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
            let needs_mq_auth_rewrite = self.hydrate_mq_auth_secrets(&id, &mut config).await?;
            let needs_mq_token_signing_rewrite = self.hydrate_mq_token_signing_secret(&id, &mut config).await?;
            let needs_nacos_auth_rewrite = self.hydrate_nacos_auth_secret(&id, &mut config).await?;
            let needs_external_secret_rewrite =
                needs_mq_auth_rewrite || needs_mq_token_signing_rewrite || needs_nacos_auth_rewrite;
            if needs_external_secret_rewrite {
                let mut sanitized = config.clone().canonicalized();
                scrub_mq_auth_secrets(&mut sanitized);
                scrub_mq_token_signing_secret(&mut sanitized);
                scrub_nacos_auth_secrets(&mut sanitized);
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
}

// Saved SQL

impl Storage {
    pub async fn replace_saved_sql_library(&self, library: &SavedSqlLibrary) -> Result<(), String> {
        let library = library.clone();
        self.with_conn(move |conn| {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
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
                     (id, connection_id, folder_id, name, database_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        file.id,
                        file.connection_id,
                        file.folder_id,
                        file.name,
                        file.database,
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
                    "SELECT id, connection_id, folder_id, name, database_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at \
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
                        schema: row.get(5)?,
                        sql: row.get(6)?,
                        sql_loaded: true,
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
                    "SELECT id, connection_id, folder_id, name, database_name, schema_name, order_index, open_count, opened_at, created_at, updated_at \
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
                        schema: row.get(5)?,
                        sql: String::new(),
                        sql_loaded: false,
                        order_index: row.get(6)?,
                        open_count: row.get(7)?,
                        opened_at: row.get(8)?,
                        created_at: row.get(9)?,
                        updated_at: row.get(10)?,
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
                    "SELECT id, connection_id, folder_id, name, database_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at \
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
                    schema: row.get(5)?,
                    sql: row.get(6)?,
                    sql_loaded: true,
                    order_index: row.get(7)?,
                    open_count: row.get(8)?,
                    opened_at: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
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
            let tx = conn.transaction().map_err(|e| e.to_string())?;
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
                 (id, connection_id, folder_id, name, database_name, schema_name, sql_text, order_index, open_count, opened_at, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 connection_id = excluded.connection_id, \
                 folder_id = excluded.folder_id, \
                 name = excluded.name, \
                 database_name = excluded.database_name, \
                 schema_name = excluded.schema_name, \
                 sql_text = CASE WHEN ?13 THEN excluded.sql_text ELSE saved_sql_files.sql_text END, \
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
        self.with_conn(move |conn| {
            conn.query_row(
                "SELECT secret FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                params![connection_id, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
        let connection_id = connection_id.to_string();
        let key = key.to_string();
        let secret = secret.to_string();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)",
                params![connection_id, key, secret],
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
}

// Schema cache

impl Storage {
    pub async fn save_schema_cache(&self, cache_key: &str, payload: &serde_json::Value) -> Result<(), String> {
        let cache_key = cache_key.to_string();
        let json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO schema_cache (cache_key, payload_json, updated_at) \
                 VALUES (?1, ?2, datetime('now'))",
                params![cache_key, json],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_schema_cache(&self, cache_key: &str) -> Result<Option<serde_json::Value>, String> {
        let cache_key = cache_key.to_string();
        let json: Option<String> = self
            .with_conn(move |conn| {
                conn.query_row("SELECT payload_json FROM schema_cache WHERE cache_key = ?1", [cache_key], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|e| e.to_string())
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
            let transaction = conn.transaction().map_err(|e| e.to_string())?;
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
        self.migrate_connections_json(data_dir).await?;
        self.migrate_secrets_json(data_dir).await?;
        self.migrate_history_json(data_dir).await?;
        self.migrate_ai_config_json(data_dir).await?;
        self.migrate_ai_conversations_json(data_dir).await?;
        self.migrate_sidebar_layout_json(data_dir).await?;
        Ok(())
    }

    async fn migrate_connections_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("connections.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let configs: Vec<ConnectionConfig> = serde_json::from_str(&json).unwrap_or_default();
        for config in &configs {
            let config_json = serde_json::to_string(config).map_err(|e| e.to_string())?;
            let id = config.id.clone();
            self.with_conn(move |conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO connections (id, config_json) VALUES (?1, ?2)",
                    params![id, config_json],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await?;
        }
        let _ = tokio::fs::rename(&path, data_dir.join("connections.json.bak")).await;
        Ok(())
    }

    async fn migrate_secrets_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("secrets.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let secrets: HashMap<String, String> = serde_json::from_str(&json).unwrap_or_default();
        for (key, secret) in &secrets {
            let parts: Vec<&str> = key.splitn(3, ':').collect();
            if parts.len() == 3 && parts[0] == "connection" {
                let connection_id = parts[1].to_string();
                let field = parts[2].to_string();
                let secret = secret.clone();
                self.with_conn(move |conn| {
                    conn.execute(
                        "INSERT OR IGNORE INTO connection_secrets (connection_id, key, secret) VALUES (?1, ?2, ?3)",
                        params![connection_id, field, secret],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                })
                .await?;
            }
        }
        let _ = tokio::fs::rename(&path, data_dir.join("secrets.json.bak")).await;
        Ok(())
    }

    async fn migrate_history_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("query_history.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let entries: Vec<HistoryEntry> = serde_json::from_str(&json).unwrap_or_default();
        for entry in &entries {
            self.save_history_entry(entry).await?;
        }
        let _ = tokio::fs::rename(&path, data_dir.join("query_history.json.bak")).await;
        Ok(())
    }

    async fn migrate_ai_config_json(&self, data_dir: &Path) -> Result<(), String> {
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
            self.with_conn(move |conn| {
                conn.execute("INSERT OR IGNORE INTO ai_config (id, config_json) VALUES (1, ?1)", [json])
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            })
            .await?;
        }
        let _ = tokio::fs::rename(&path, data_dir.join("ai_config.json.bak")).await;
        Ok(())
    }

    async fn migrate_ai_conversations_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("ai_conversations.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
        let conversations: Vec<AiConversation> = serde_json::from_str(&json).unwrap_or_default();
        for conv in &conversations {
            let conv = conv.clone();
            let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
            self.with_conn(move |conn| {
                conn.execute(
                    "INSERT OR IGNORE INTO ai_conversations \
                     (id, title, connection_name, database, messages_json, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![
                        conv.id,
                        conv.title,
                        conv.connection_name,
                        conv.database,
                        messages_json,
                        conv.created_at,
                        conv.updated_at
                    ],
                )
                .map(|_| ())
                .map_err(|e| e.to_string())
            })
            .await?;
        }
        let _ = tokio::fs::rename(&path, data_dir.join("ai_conversations.json.bak")).await;
        Ok(())
    }

    async fn migrate_sidebar_layout_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("sidebar_layout.json");
        if tokio::fs::metadata(&path).await.is_err() {
            return Ok(());
        }
        let json = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
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
        let _ = tokio::fs::rename(&path, data_dir.join("sidebar_layout.json.bak")).await;
        Ok(())
    }
}

fn persist_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        tx.execute("DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2", params![connection_id, key])
            .map_err(|e| e.to_string())?;
    } else {
        tx.execute(
            "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret) VALUES (?, ?, ?)",
            params![connection_id, key, secret],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn persist_mq_auth_secrets_in_tx(tx: &rusqlite::Transaction<'_>, config: &ConnectionConfig) -> Result<(), String> {
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
        Some("token") => replace_mq_auth_secret_in_tx(tx, &config.id, MQ_AUTH_TOKEN_KEY, auth, "token")?,
        Some("basic") => replace_mq_auth_secret_in_tx(tx, &config.id, MQ_AUTH_PASSWORD_KEY, auth, "password")?,
        Some(kind) if is_api_key_auth_kind(kind) => {
            replace_mq_auth_secret_in_tx(tx, &config.id, MQ_AUTH_API_KEY_VALUE_KEY, auth, "value")?
        }
        Some("oauth2") => {
            replace_mq_auth_secret_in_tx(tx, &config.id, MQ_AUTH_CLIENT_SECRET_KEY, auth, "clientSecret")?
        }
        _ => delete_secret_prefix_in_tx(tx, &config.id, MQ_AUTH_SECRET_PREFIX)?,
    }

    Ok(())
}

fn replace_mq_auth_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    let current = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty());
    let existing = if current.is_none() { get_secret_in_tx(tx, connection_id, key)? } else { None };
    delete_secret_prefix_in_tx(tx, connection_id, MQ_AUTH_SECRET_PREFIX)?;
    match current {
        Some(secret) => persist_secret_in_tx(tx, connection_id, key, secret),
        None => match existing {
            Some(secret) => persist_secret_in_tx(tx, connection_id, key, &secret),
            None => Ok(()),
        },
    }
}

fn get_secret_in_tx(tx: &rusqlite::Transaction<'_>, connection_id: &str, key: &str) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT secret FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
        params![connection_id, key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

fn persist_mq_token_signing_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
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

    persist_json_secret_if_present_in_tx(tx, &config.id, MQ_TOKEN_SIGNING_KEY, signing, "key")
}

fn persist_nacos_auth_secrets_in_tx(tx: &rusqlite::Transaction<'_>, config: &ConnectionConfig) -> Result<(), String> {
    if config.db_type != DatabaseType::Nacos {
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
        get_secret_in_tx(tx, &config.id, NACOS_AUTH_PASSWORD_KEY)?
    } else {
        None
    };
    let existing_console = if console.is_none() && console_auth.is_some() {
        get_secret_in_tx(tx, &config.id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY)?
    } else {
        None
    };
    delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
    if let Some(secret) = primary.or(existing_primary.as_deref()) {
        persist_secret_in_tx(tx, &config.id, NACOS_AUTH_PASSWORD_KEY, secret)?;
    }
    if let Some(secret) = console.or(existing_console.as_deref()) {
        persist_secret_in_tx(tx, &config.id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY, secret)?;
    }

    Ok(())
}

fn persist_json_secret_if_present_in_tx(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    if let Some(secret) = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty()) {
        persist_secret_in_tx(tx, connection_id, key, secret)?;
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
        McpGlobalPolicyState, Storage, MCP_GLOBAL_POLICY_KEY,
    };
    use crate::connection_secrets::NACOS_RNACOS_CONSOLE_PASSWORD_KEY;
    use crate::connection_secrets::{
        MQ_AUTH_PASSWORD_KEY, MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY, NACOS_AUTH_PASSWORD_KEY,
    };
    use crate::history::{HistoryConnectionFilter, HistoryDatabaseFilter, HistoryEntry, HistorySearchRequest};
    use crate::models::connection::{
        ConnectionConfig, DatabaseConnectionInfo, DatabaseType, SshTunnelConfig, TransportLayerConfig,
    };
    use crate::saved_sql::SavedSqlFile;
    use rusqlite::Connection;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}.db", std::process::id()))
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

    #[tokio::test]
    async fn history_search_filters_connection_database_and_legacy_entries() {
        let path = temp_db_path("history-search-scope");
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
            profile_id: String::new(),
        })
    }

    #[tokio::test]
    async fn tunnel_profiles_roundtrip_and_preserve_secrets() {
        let path = temp_db_path("tunnel-profiles");
        let storage = Storage::open(&path).await.unwrap();

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
    async fn tunnel_profiles_reject_empty_ids() {
        let path = temp_db_path("tunnel-profiles-empty-id");
        let storage = Storage::open(&path).await.unwrap();

        let profile = ssh_profile("", "secret");
        assert!(storage.save_tunnel_profiles(&[profile]).await.is_err());

        let _ = std::fs::remove_file(path);
    }

    fn mq_connection(id: &str, token: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "Pulsar".to_string(),
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
            visible_databases: None,
            visible_schemas: None,
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
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn nacos_connection(id: &str, password: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "Nacos".to_string(),
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
            visible_databases: None,
            visible_schemas: None,
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
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
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

    async fn create_data_dir_with_connection(name: &str, connection_id: &str, token: &str) -> std::path::PathBuf {
        let data_dir = temp_data_dir(name);
        let storage = Storage::open(&data_dir.join("dbx.db")).await.unwrap();
        storage.save_connections(&[mq_connection(connection_id, token)]).await.unwrap();
        drop(storage);
        data_dir
    }

    #[tokio::test]
    async fn import_user_data_db_copies_source_when_target_is_missing() {
        let source_dir = create_data_dir_with_connection("import-source", "source-connection", "source-token").await;
        let target_dir = temp_data_dir("import-target");

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::Imported);
        let storage = Storage::open(&target_dir.join("dbx.db")).await.unwrap();
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
        let storage = Storage::open(&target_dir.join("dbx.db")).await.unwrap();
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "target-connection");
        assert_eq!(mq_token(&connections[0]), Some("target-token"));
    }

    #[tokio::test]
    async fn import_user_data_db_replaces_empty_target_schema() {
        let source_dir =
            create_data_dir_with_connection("import-source-empty-target", "source-connection", "source-token").await;
        let target_dir = temp_data_dir("import-empty-target");
        let target_storage = Storage::open(&target_dir.join("dbx.db")).await.unwrap();
        target_storage
            .save_desktop_settings(&DesktopSettings { debug_logging_enabled: true, ..DesktopSettings::default() })
            .await
            .unwrap();
        drop(target_storage);

        let result = maybe_import_user_data_db(&target_dir, Some(&source_dir)).unwrap();

        assert_eq!(result, DataDbImportResult::Imported);
        let storage = Storage::open(&target_dir.join("dbx.db")).await.unwrap();
        let connections = storage.load_connections().await.unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "source-connection");
    }

    #[tokio::test]
    async fn import_user_data_db_skips_empty_source_schema() {
        let source_dir = temp_data_dir("import-empty-source");
        let source_storage = Storage::open(&source_dir.join("dbx.db")).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
    async fn save_connections_moves_mq_auth_token_to_secret_table_and_restores_it() {
        let path = temp_db_path("mq-token-secrets");
        let storage = Storage::open(&path).await.unwrap();

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
    async fn metadata_save_scrubs_mq_auth_token_and_preserves_existing_secret() {
        let path = temp_db_path("mq-token-metadata");
        let storage = Storage::open(&path).await.unwrap();

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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();

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
        let storage = Storage::open(&path).await.unwrap();
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
    async fn load_connections_migrates_legacy_nacos_auth_password_out_of_config_json() {
        let path = temp_db_path("nacos-auth-legacy-migration");
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap(), DesktopSettings::default());
    }

    #[tokio::test]
    async fn mcp_global_policy_defaults_unconfigured_and_roundtrips_atomically() {
        let path = temp_db_path("mcp-global-policy");
        let storage = Storage::open(&path).await.unwrap();

        assert_eq!(
            storage.load_mcp_global_policy().await.unwrap(),
            McpGlobalPolicyState {
                configured: false,
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
            }
        );

        storage.save_password_hash("preserved").await.unwrap();
        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: true,
                allowed_connection_ids: Some(vec!["conn-1".to_string(), "conn-2".to_string()]),
            })
            .await
            .unwrap();

        assert_eq!(
            storage.load_mcp_global_policy().await.unwrap(),
            McpGlobalPolicyState {
                configured: true,
                read_only: true,
                allow_dangerous_sql: true,
                allowed_connection_ids: Some(vec!["conn-1".to_string(), "conn-2".to_string()]),
            }
        );
        assert_eq!(storage.load_password_hash().await.unwrap().as_deref(), Some("preserved"));
        let settings = storage.load_app_settings_json().await.unwrap();
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["readOnly"], true);
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["allowDangerousSql"], true);
        assert_eq!(settings[MCP_GLOBAL_POLICY_KEY]["allowedConnectionIds"][0], "conn-1");
        assert!(settings[MCP_GLOBAL_POLICY_KEY].get("configured").is_none());

        storage.save_desktop_settings(&DesktopSettings::default()).await.unwrap();
        assert!(storage.load_mcp_global_policy().await.unwrap().read_only);
    }

    #[tokio::test]
    async fn mcp_global_policy_fails_closed_on_malformed_settings() {
        let path = temp_db_path("mcp-global-policy-malformed");
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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
    }

    #[tokio::test]
    async fn mcp_connection_mutations_are_atomic_and_recheck_policy() {
        let path = temp_db_path("mcp-connection-mutation-guard");
        let storage = Storage::open(&path).await.unwrap();
        let kept = mq_connection("kept", "kept-token");
        let removed = mq_connection("removed", "removed-token");
        storage.save_connections(&[kept.clone(), removed.clone()]).await.unwrap();

        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: false,
                allowed_connection_ids: Some(vec![kept.id.clone()]),
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
        let storage = Storage::open(&path).await.unwrap();
        let mut settings = serde_json::Map::new();
        settings.insert("run_in_background".to_string(), serde_json::Value::Bool(false));
        storage.save_app_settings_json(&settings).await.unwrap();

        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { show_tray_icon: false, ..DesktopSettings::default() }
        );
    }

    #[tokio::test]
    async fn desktop_settings_preserve_existing_password_hash() {
        let path = temp_db_path("desktop-settings-preserve-password");
        let storage = Storage::open(&path).await.unwrap();

        storage.save_password_hash("hash-1").await.unwrap();
        storage
            .save_desktop_settings(&DesktopSettings {
                show_tray_icon: false,
                icon_theme: DesktopIconTheme::Black,
                quit_on_close: true,
                close_action_prompted: false,
                debug_logging_enabled: true,
                duckdb_worker_process_isolation: false,
                duckdb_worker_max_processes: DesktopSettings::default().duckdb_worker_max_processes,
                saved_sql_sync_dir: None,
                driver_store_dir: Some("/tmp/dbx-drivers".to_string()),
                plugin_store_dir: Some("/tmp/dbx-plugins".to_string()),
                agent_store_dir: Some("/tmp/dbx-agents".to_string()),
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
                duckdb_worker_process_isolation: false,
                duckdb_worker_max_processes: DesktopSettings::default().duckdb_worker_max_processes,
                saved_sql_sync_dir: None,
                driver_store_dir: Some("/tmp/dbx-drivers".to_string()),
                plugin_store_dir: Some("/tmp/dbx-plugins".to_string()),
                agent_store_dir: Some("/tmp/dbx-agents".to_string()),
                sidebar_table_page_size: DesktopSettings::default().sidebar_table_page_size,
            }
        );
    }

    #[tokio::test]
    async fn desktop_settings_save_removes_legacy_background_preference() {
        let path = temp_db_path("desktop-settings-remove-legacy-background");
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings { sidebar_table_page_size: 1234, ..DesktopSettings::default() })
            .await
            .unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap().sidebar_table_page_size, 1234);
    }

    #[tokio::test]
    async fn desktop_settings_persist_duckdb_worker_max_processes() {
        let path = temp_db_path("desktop-settings-duckdb-worker-max-processes");
        let storage = Storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings { duckdb_worker_max_processes: 8, ..DesktopSettings::default() })
            .await
            .unwrap();

        assert_eq!(storage.load_desktop_settings().await.unwrap().duckdb_worker_max_processes, 8);
    }

    #[tokio::test]
    async fn max_agent_turns_defaults_and_persists_clamped() {
        let path = temp_db_path("max-agent-turns");
        let storage = Storage::open(&path).await.unwrap();

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
    async fn password_hash_preserves_existing_desktop_settings() {
        let path = temp_db_path("password-preserve-desktop-settings");
        let storage = Storage::open(&path).await.unwrap();

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
        let storage = Storage::open(&path).await.unwrap();

        assert_eq!(storage.load_pinned_tree_node_ids().await.unwrap(), Vec::<String>::new());
    }

    #[tokio::test]
    async fn pinned_tree_node_ids_roundtrip_and_preserve_password_hash() {
        let path = temp_db_path("pinned-tree-roundtrip");
        let storage = Storage::open(&path).await.unwrap();

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
        let storage = Storage::open(&path).await.unwrap();

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
        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-4".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { icon_theme: DesktopIconTheme::Black, ..DesktopSettings::default() }
        );
        assert_eq!(storage.load_app_settings_json().await.unwrap().get("open_tabs"), None);
    }

    #[tokio::test]
    async fn tab_runtime_cache_roundtrips_binary_payloads() {
        let path = temp_db_path("tab-runtime-cache");
        let storage = Storage::open(&path).await.unwrap();

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
        let storage = Storage::open(&path).await.unwrap();
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
        let storage = Storage::open(&path).await.unwrap();
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

        let storage = Storage::open(&path).await.unwrap();
        let entry = storage.load_tab_runtime_cache("legacy").await.unwrap().unwrap();

        assert_eq!(entry.payload, vec![1, 2]);
        assert!(entry.created_at > 0);
        assert!(entry.last_accessed_at >= entry.created_at);
    }

    #[tokio::test]
    async fn saved_sql_summary_omits_sql_text_and_loads_file_on_demand() {
        let path = temp_db_path("saved-sql-summary");
        let storage = Storage::open(&path).await.unwrap();
        let file = SavedSqlFile {
            id: "sql-1".to_string(),
            connection_id: "conn-1".to_string(),
            folder_id: None,
            name: "large.sql".to_string(),
            database: "main".to_string(),
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
        assert!(!summary.files[0].sql_loaded);

        let loaded = storage.load_saved_sql_file("sql-1").await.unwrap().unwrap();
        assert_eq!(loaded.sql, file.sql);
        assert!(loaded.sql_loaded);
    }

    #[tokio::test]
    async fn saved_sql_metadata_update_preserves_unloaded_sql_text() {
        let path = temp_db_path("saved-sql-preserve-unloaded-text");
        let storage = Storage::open(&path).await.unwrap();
        let mut file = SavedSqlFile {
            id: "sql-1".to_string(),
            connection_id: "conn-1".to_string(),
            folder_id: None,
            name: "query.sql".to_string(),
            database: "main".to_string(),
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
                proxy_enabled: false,
                proxy_url: String::new(),
                enable_thinking: true,
                reasoning_level: AiReasoningLevel::Default,
                context_window: None,
                codex_cli_path: None,
                codex_cli_env: std::collections::HashMap::new(),
                claude_code_cli_path: None,
                claude_code_cli_env: std::collections::HashMap::new(),
            },
        }
    }

    #[tokio::test]
    async fn ai_config_save_load_roundtrip() {
        let db = temp_db_path("ai-roundtrip");
        let storage = Storage::open(&db).await.unwrap();

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
    async fn ai_config_only_one_default() {
        let db = temp_db_path("ai-one-default");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        let configs =
            vec![make_ai_config("batch-a", true), make_ai_config("batch-b", false), make_ai_config("batch-c", false)];
        storage.save_ai_configs(&configs).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 3);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn ai_config_save_configs_clears_old_tables() {
        let db = temp_db_path("ai-clear-old");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        let err = storage.save_prompt_template("t1", "", "content").await.unwrap_err();
        assert!(err.contains("cannot be empty"), "expected 'cannot be empty', got: {err}");

        let err = storage.save_prompt_template("t1", "   ", "content").await.unwrap_err();
        assert!(err.contains("cannot be empty"), "expected 'cannot be empty', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_long_name() {
        let db = temp_db_path("pt-name-long");
        let storage = Storage::open(&db).await.unwrap();

        let long_name = "a".repeat(51);
        let err = storage.save_prompt_template("t1", &long_name, "content").await.unwrap_err();
        assert!(err.contains("too long") && err.contains("50"), "expected too long (max 50), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_accepts_multi_byte_characters_within_char_limit() {
        let db = temp_db_path("pt-multibyte-name");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        let long_content = "a".repeat(8001);
        let err = storage.save_prompt_template("t1", "Valid Name", &long_content).await.unwrap_err();
        assert!(err.contains("too long") && err.contains("8000"), "expected too long (max 8000), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_save_rejects_duplicate_name_case_insensitive() {
        let db = temp_db_path("pt-dup-name");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        // SQLite LOWER() is ASCII-only (U+00C4 'Ä' → no change), but Rust
        // str::to_lowercase() does full Unicode case folding (Ä → ä).
        // Both directions must detect the duplicate.
        storage.save_prompt_template("t1", "Ä规则", "content-upper").await.unwrap();
        let err = storage.save_prompt_template("t2", "ä规则", "content-lower").await.unwrap_err();
        assert!(err.contains("duplicate"), "expected 'duplicate', got: {err}");

        // Reverse: lower-case first, upper-case second.
        let db = temp_db_path("pt-dup-unicode-2");
        let storage = Storage::open(&db).await.unwrap();
        storage.save_prompt_template("t1", "ä规则", "content-lower").await.unwrap();
        let err = storage.save_prompt_template("t2", "Ä规则", "content-upper").await.unwrap_err();
        assert!(err.contains("duplicate"), "expected 'duplicate', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_load_order_is_stable() {
        let db = temp_db_path("pt-load-order");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        let err = storage.delete_prompt_template("nonexistent").await.unwrap_err();
        assert!(err.contains("not found"), "expected 'not found', got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn prompt_template_delete_existing_removes() {
        let db = temp_db_path("pt-delete-existing");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        let instructions = "Amounts are in cents. Always filter by date range.";
        storage.save_ai_global_custom_instructions(instructions).await.unwrap();

        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, instructions);

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_defaults_to_empty() {
        let db = temp_db_path("gi-default");
        let storage = Storage::open(&db).await.unwrap();

        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, "");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_rejects_too_long() {
        let db = temp_db_path("gi-too-long");
        let storage = Storage::open(&db).await.unwrap();

        let long = "a".repeat(8001);
        let err = storage.save_ai_global_custom_instructions(&long).await.unwrap_err();
        assert!(err.contains("too long") && err.contains("8000"), "expected too long (max 8000), got: {err}");

        std::fs::remove_file(&db).ok();
    }

    #[tokio::test]
    async fn global_instructions_empty_string_clears() {
        let db = temp_db_path("gi-clear");
        let storage = Storage::open(&db).await.unwrap();

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
        let storage = Storage::open(&db).await.unwrap();

        storage.save_ai_global_custom_instructions("   \n  \t  ").await.unwrap();
        let loaded = storage.load_ai_global_custom_instructions().await.unwrap();
        assert_eq!(loaded, "");

        std::fs::remove_file(&db).ok();
    }
}
