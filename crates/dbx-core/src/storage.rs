use std::collections::{HashMap, HashSet};
use std::path::Path;

use log::warn;
use rusqlite::{params, params_from_iter, Connection, DatabaseName, OpenFlags, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::{AiChatMessage, AiConfig, AiConversation, AiProvider};
use crate::connection_secrets::{
    MQ_AUTH_API_KEY_VALUE_KEY, MQ_AUTH_CLIENT_SECRET_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_SECRET_PREFIX,
    MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY, MQ_TOKEN_SIGNING_SECRET_PREFIX, NACOS_AUTH_PASSWORD_KEY,
    NACOS_AUTH_SECRET_PREFIX,
};
use crate::db::sqlite::{connect_path_create_if_missing, SqliteHandle};
use crate::history::{HistoryEntry, MAX_HISTORY};
use crate::models::connection::{ConnectionConfig, DatabaseType, TransportLayerConfig};
use crate::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";
const STORAGE_DB_FILE_NAME: &str = "dbx.db";
const APP_STATE_EDITOR_SETTINGS_KEY: &str = "editor_settings";
const APP_STATE_OPEN_TABS_KEY: &str = "open_tabs";
const APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY: &str = "saved_sql_editor_positions";
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
pub struct TabRuntimeCacheEntry {
    pub key: String,
    pub payload: Vec<u8>,
    pub row_count: i64,
    pub column_count: i64,
    pub byte_size: i64,
    pub updated_at: String,
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
        updated_at TEXT NOT NULL
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
    let Some(auth) = nacos_auth_object_mut(config.external_config.as_mut()) else {
        return;
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
        scrub_json_secret(auth, "password");
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
        (TransportLayerConfig::HttpTunnel(current), TransportLayerConfig::HttpTunnel(previous)) => {
            if current.token.is_empty() {
                current.token = previous.token.clone();
            }
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
            _ => Ok(serde_json::Map::new()),
        }
    }

    async fn save_app_settings_json(
        &self,
        settings: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(), String> {
        let json = serde_json::Value::Object(settings.clone()).to_string();
        self.with_conn(move |conn| {
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

    pub async fn save_saved_sql_editor_positions(&self, positions: &serde_json::Value) -> Result<(), String> {
        self.save_app_state_value(APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY, positions).await
    }

    pub async fn load_saved_sql_editor_positions(&self) -> Result<Option<serde_json::Value>, String> {
        self.load_app_state_value(APP_STATE_SAVED_SQL_EDITOR_POSITIONS_KEY).await
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
}

// Connections

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
                let config = config.canonicalized();
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

                persist_secret_in_tx(&tx, &config.id, "password", &config.password)?;
                delete_secret_prefix_in_tx(&tx, &config.id, TRANSPORT_LAYER_SECRET_PREFIX)?;
                for (index, layer) in config.transport_layers.iter().enumerate() {
                    match layer {
                        TransportLayerConfig::Ssh(ssh) => {
                            persist_secret_in_tx(
                                &tx,
                                &config.id,
                                &transport_layer_ssh_password_key(index, layer),
                                &ssh.password,
                            )?;
                            persist_secret_in_tx(
                                &tx,
                                &config.id,
                                &transport_layer_ssh_key_passphrase_key(index, layer),
                                &ssh.key_passphrase,
                            )?;
                        }
                        TransportLayerConfig::Proxy(proxy) => {
                            persist_secret_in_tx(
                                &tx,
                                &config.id,
                                &transport_layer_proxy_password_key(index, layer),
                                &proxy.password,
                            )?;
                        }
                        TransportLayerConfig::HttpTunnel(http) => {
                            persist_secret_in_tx(
                                &tx,
                                &config.id,
                                &transport_layer_http_tunnel_token_key(index, layer),
                                &http.token,
                            )?;
                        }
                    }
                }
                persist_secret_in_tx(&tx, &config.id, "redis_sentinel_password", &config.redis_sentinel_password)?;
                persist_secret_in_tx(&tx, &config.id, "ssh_password", "")?;
                persist_secret_in_tx(&tx, &config.id, "ssh_key_passphrase", "")?;
                persist_secret_in_tx(&tx, &config.id, "proxy_password", "")?;
                delete_secret_prefix_in_tx(&tx, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
                if let Some(cs) = &config.connection_string {
                    persist_secret_in_tx(&tx, &config.id, "connection_string", cs)?;
                } else {
                    tx.execute(
                        "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                        params![config.id, "connection_string"],
                    )
                    .map_err(|e| e.to_string())?;
                }
                if let Some(script) = &config.init_script {
                    persist_secret_in_tx(&tx, &config.id, "init_script", script)?;
                } else {
                    tx.execute(
                        "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                        params![config.id, "init_script"],
                    )
                    .map_err(|e| e.to_string())?;
                }
                persist_mq_auth_secrets_in_tx(&tx, &config)?;
                persist_mq_token_signing_secret_in_tx(&tx, &config)?;
                persist_nacos_auth_secrets_in_tx(&tx, &config)?;
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
        let Some(auth) = nacos_auth_object_mut(config.external_config.as_mut()) else {
            return Ok(false);
        };
        if auth.get("kind").and_then(serde_json::Value::as_str) != Some("usernamePassword") {
            return Ok(false);
        }

        hydrate_mq_json_secret(self, connection_id, NACOS_AUTH_PASSWORD_KEY, auth, "password").await
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
    ) -> Result<(), String> {
        let key = key.to_string();
        let byte_size = payload.len() as i64;
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO tab_runtime_cache \
                 (cache_key, payload, row_count, column_count, byte_size, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) \
                 ON CONFLICT(cache_key) DO UPDATE SET \
                 payload = excluded.payload, row_count = excluded.row_count, column_count = excluded.column_count, \
                 byte_size = excluded.byte_size, updated_at = excluded.updated_at",
                params![key, payload, row_count, column_count, byte_size],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn load_tab_runtime_cache(&self, key: &str) -> Result<Option<TabRuntimeCacheEntry>, String> {
        let key = key.to_string();
        self.with_conn(move |conn| {
            conn.query_row(
                "SELECT cache_key, payload, row_count, column_count, byte_size, updated_at \
                 FROM tab_runtime_cache WHERE cache_key = ?1",
                [key],
                |row| {
                    Ok(TabRuntimeCacheEntry {
                        key: row.get(0)?,
                        payload: row.get(1)?,
                        row_count: row.get(2)?,
                        column_count: row.get(3)?,
                        byte_size: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
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

    let Some(auth) = nacos_auth_object(config.external_config.as_ref()) else {
        delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
        return Ok(());
    };

    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
        replace_nacos_auth_secret_in_tx(tx, &config.id, NACOS_AUTH_PASSWORD_KEY, auth, "password")?;
    } else {
        delete_secret_prefix_in_tx(tx, &config.id, NACOS_AUTH_SECRET_PREFIX)?;
    }

    Ok(())
}

fn replace_nacos_auth_secret_in_tx(
    tx: &rusqlite::Transaction<'_>,
    connection_id: &str,
    key: &str,
    auth: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) -> Result<(), String> {
    let current = auth.get(field).and_then(serde_json::Value::as_str).filter(|secret| !secret.is_empty());
    let existing = if current.is_none() { get_secret_in_tx(tx, connection_id, key)? } else { None };
    delete_secret_prefix_in_tx(tx, connection_id, NACOS_AUTH_SECRET_PREFIX)?;
    match current {
        Some(secret) => persist_secret_in_tx(tx, connection_id, key, secret),
        None => match existing {
            Some(secret) => persist_secret_in_tx(tx, connection_id, key, &secret),
            None => Ok(()),
        },
    }
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
    use super::{maybe_import_user_data_db, DataDbImportResult, DesktopIconTheme, DesktopSettings, Storage};
    use crate::connection_secrets::{
        MQ_AUTH_PASSWORD_KEY, MQ_AUTH_TOKEN_KEY, MQ_TOKEN_SIGNING_KEY, NACOS_AUTH_PASSWORD_KEY,
    };
    use crate::models::connection::{ConnectionConfig, DatabaseType, SshTunnelConfig, TransportLayerConfig};
    use crate::saved_sql::SavedSqlFile;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}.db", std::process::id()))
    }

    fn temp_data_dir(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}", std::process::id()))
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
        storage.save_connections(&[original.clone()]).await.unwrap();

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

        storage.save_tab_runtime_cache("tab:1:result", vec![1, 2, 3, 4], 10, 3).await.unwrap();
        let entry = storage.load_tab_runtime_cache("tab:1:result").await.unwrap().unwrap();

        assert_eq!(entry.key, "tab:1:result");
        assert_eq!(entry.payload, vec![1, 2, 3, 4]);
        assert_eq!(entry.row_count, 10);
        assert_eq!(entry.column_count, 3);
        assert_eq!(entry.byte_size, 4);

        storage.delete_tab_runtime_cache("tab:1:result").await.unwrap();
        assert_eq!(storage.load_tab_runtime_cache("tab:1:result").await.unwrap(), None);
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
}
