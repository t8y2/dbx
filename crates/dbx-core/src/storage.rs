use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ai::{AiChatMessage, AiConfig, AiConversation};
use crate::db::sqlite::{connect_path_create_if_missing, SqliteHandle};
use crate::history::{HistoryEntry, MAX_HISTORY};
use crate::models::connection::ConnectionConfig;
use crate::saved_sql::{SavedSqlFile, SavedSqlFolder, SavedSqlLibrary};

const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";

pub struct Storage {
    db: SqliteHandle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopSettings {
    pub show_tray_icon: bool,
    pub icon_theme: DesktopIconTheme,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self { show_tray_icon: true, icon_theme: DesktopIconTheme::Default }
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
    "CREATE TABLE IF NOT EXISTS schema_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )",
    "CREATE TABLE IF NOT EXISTS saved_sql_folders (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
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

fn scrub_ssh_tunnel_secrets(config: &mut ConnectionConfig) {
    for hop in &mut config.ssh_tunnels {
        hop.password.clear();
        hop.key_passphrase.clear();
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

    pub async fn load_history_entries(&self, limit: usize, offset: usize) -> Result<Vec<HistoryEntry>, String> {
        self.with_conn(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, connection_name, database, sql_text, executed_at, execution_time_ms, success, \
                     error, activity_kind, connection_id, operation, target, affected_rows, rollback_sql, details_json \
                     FROM history ORDER BY executed_at DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit as i64, offset as i64], |row| {
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
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
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
                sanitized.ssh_password = String::new();
                sanitized.ssh_key_passphrase = String::new();
                scrub_ssh_tunnel_secrets(&mut sanitized);
                sanitized.proxy_password = String::new();
                sanitized.redis_sentinel_password = String::new();
                sanitized.connection_string = None;
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
                sanitized.ssh_password = String::new();
                sanitized.ssh_key_passphrase = String::new();
                scrub_ssh_tunnel_secrets(&mut sanitized);
                sanitized.proxy_password = String::new();
                sanitized.redis_sentinel_password = String::new();
                sanitized.connection_string = None;
                let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

                tx.execute("INSERT INTO connections (id, config_json) VALUES (?1, ?2)", params![config_id, json])
                    .map_err(|e| e.to_string())?;

                persist_secret_in_tx(&tx, &config.id, "password", &config.password)?;
                persist_secret_in_tx(&tx, &config.id, "ssh_password", &config.ssh_password)?;
                persist_secret_in_tx(&tx, &config.id, "ssh_key_passphrase", &config.ssh_key_passphrase)?;
                delete_secret_prefix_in_tx(&tx, &config.id, SSH_TUNNEL_SECRET_PREFIX)?;
                for (index, hop) in config.ssh_tunnels.iter().enumerate() {
                    persist_secret_in_tx(&tx, &config.id, &ssh_tunnel_password_key(index, hop), &hop.password)?;
                    persist_secret_in_tx(
                        &tx,
                        &config.id,
                        &ssh_tunnel_key_passphrase_key(index, hop),
                        &hop.key_passphrase,
                    )?;
                }
                persist_secret_in_tx(&tx, &config.id, "proxy_password", &config.proxy_password)?;
                persist_secret_in_tx(&tx, &config.id, "redis_sentinel_password", &config.redis_sentinel_password)?;
                if let Some(cs) = &config.connection_string {
                    persist_secret_in_tx(&tx, &config.id, "connection_string", cs)?;
                } else {
                    tx.execute(
                        "DELETE FROM connection_secrets WHERE connection_id = ?1 AND key = ?2",
                        params![config.id, "connection_string"],
                    )
                    .map_err(|e| e.to_string())?;
                }
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
            config.ssh_password = self.get_secret(&id, "ssh_password").await?.unwrap_or_default();
            config.ssh_key_passphrase = self.get_secret(&id, "ssh_key_passphrase").await?.unwrap_or_default();
            for (index, hop) in config.ssh_tunnels.iter_mut().enumerate() {
                hop.password = self.get_secret(&id, &ssh_tunnel_password_key(index, hop)).await?.unwrap_or_default();
                hop.key_passphrase =
                    self.get_secret(&id, &ssh_tunnel_key_passphrase_key(index, hop)).await?.unwrap_or_default();
            }
            config.proxy_password = self.get_secret(&id, "proxy_password").await?.unwrap_or_default();
            config.redis_sentinel_password = self.get_secret(&id, "redis_sentinel_password").await?.unwrap_or_default();
            config.connection_string = self.get_secret(&id, "connection_string").await?;
            configs.push(config.canonicalized());
        }
        Ok(configs)
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
                    "INSERT INTO saved_sql_folders (id, connection_id, name, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?)",
                    params![folder.id, folder.connection_id, folder.name, folder.created_at, folder.updated_at],
                )
                .map_err(|e| e.to_string())?;
            }

            for file in &library.files {
                tx.execute(
                    "INSERT INTO saved_sql_files \
                     (id, connection_id, folder_id, name, database_name, schema_name, sql_text, created_at, updated_at) \
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    params![
                        file.id,
                        file.connection_id,
                        file.folder_id,
                        file.name,
                        file.database,
                        file.schema,
                        file.sql,
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
                    "SELECT id, connection_id, name, created_at, updated_at \
                     FROM saved_sql_folders ORDER BY connection_id, name COLLATE NOCASE",
                )
                .map_err(|e| e.to_string())?;
            let folders = folder_stmt
                .query_map([], |row| {
                    Ok(SavedSqlFolder {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        name: row.get(2)?,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            let mut file_stmt = conn
                .prepare(
                    "SELECT id, connection_id, folder_id, name, database_name, schema_name, sql_text, created_at, updated_at \
                     FROM saved_sql_files ORDER BY connection_id, folder_id, name COLLATE NOCASE",
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
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;

            Ok(SavedSqlLibrary { folders, files })
        })
        .await
    }

    pub async fn save_saved_sql_folder(&self, folder: &SavedSqlFolder) -> Result<(), String> {
        let folder = folder.clone();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO saved_sql_folders (id, connection_id, name, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 connection_id = excluded.connection_id, \
                 name = excluded.name, \
                 updated_at = excluded.updated_at",
                params![folder.id, folder.connection_id, folder.name, folder.created_at, folder.updated_at],
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
            tx.execute("DELETE FROM saved_sql_files WHERE folder_id = ?1", [id.as_str()]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM saved_sql_folders WHERE id = ?1", [id.as_str()]).map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn save_saved_sql_file(&self, file: &SavedSqlFile) -> Result<(), String> {
        let file = file.clone();
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO saved_sql_files \
                 (id, connection_id, folder_id, name, database_name, schema_name, sql_text, created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(id) DO UPDATE SET \
                 connection_id = excluded.connection_id, \
                 folder_id = excluded.folder_id, \
                 name = excluded.name, \
                 database_name = excluded.database_name, \
                 schema_name = excluded.schema_name, \
                 sql_text = excluded.sql_text, \
                 updated_at = excluded.updated_at",
                params![
                    file.id,
                    file.connection_id,
                    file.folder_id,
                    file.name,
                    file.database,
                    file.schema,
                    file.sql,
                    file.created_at,
                    file.updated_at
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

fn map_from_sql_err(err: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
}

#[cfg(test)]
mod tests {
    use super::{DesktopIconTheme, DesktopSettings, Storage};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-storage-{name}-{}-{stamp}.db", std::process::id()))
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
            .save_desktop_settings(&DesktopSettings { show_tray_icon: false, icon_theme: DesktopIconTheme::Black })
            .await
            .unwrap();

        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-1".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { show_tray_icon: false, icon_theme: DesktopIconTheme::Black }
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
    }

    #[tokio::test]
    async fn password_hash_preserves_existing_desktop_settings() {
        let path = temp_db_path("password-preserve-desktop-settings");
        let storage = Storage::open(&path).await.unwrap();

        storage
            .save_desktop_settings(&DesktopSettings { show_tray_icon: false, icon_theme: DesktopIconTheme::Black })
            .await
            .unwrap();
        storage.save_password_hash("hash-2").await.unwrap();

        assert_eq!(storage.load_password_hash().await.unwrap(), Some("hash-2".to_string()));
        assert_eq!(
            storage.load_desktop_settings().await.unwrap(),
            DesktopSettings { show_tray_icon: false, icon_theme: DesktopIconTheme::Black }
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
}
