use std::path::Path;
use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use crate::ai::{AiChatMessage, AiConfig, AiConversation};
use crate::encryption;
use crate::history::HistoryEntry;
use crate::models::connection::ConnectionConfig;

pub struct Storage {
    db: SqlitePool,
    encryption_key: Vec<u8>,
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
        connection_name TEXT NOT NULL DEFAULT '',
        database TEXT NOT NULL DEFAULT '',
        sql_text TEXT NOT NULL DEFAULT '',
        executed_at TEXT NOT NULL DEFAULT '',
        execution_time_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT
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
];

// ---------------------------------------------------------------------------
// Construction / schema
// ---------------------------------------------------------------------------

impl Storage {
    pub async fn open(db_path: &Path) -> Result<Self, String> {
        let url = format!("sqlite:{}?mode=rwc", db_path.display());
        let options = SqliteConnectOptions::from_str(&url).map_err(|e| e.to_string())?.create_if_missing(true);
        let pool =
            SqlitePoolOptions::new().max_connections(5).connect_with(options).await.map_err(|e| e.to_string())?;

        for statement in SCHEMA_STATEMENTS {
            sqlx::query(statement).execute(&pool).await.map_err(|e| e.to_string())?;
        }

        // Derive encryption key from environment or generate from secure source
        let encryption_key = derive_encryption_key()?;

        Ok(Self { db: pool, encryption_key })
    }
}

/// Derives encryption key from OS keyring or environment variable.
///
/// Priority:
/// 1. OS Keyring (secure, persisted across restarts)
/// 2. DBX_ENCRYPTION_KEY environment variable (hex-encoded 32 bytes)
/// 3. Auto-generate and store in OS Keyring on first run
fn derive_encryption_key() -> Result<Vec<u8>, String> {
    const KEYRING_SERVICE: &str = "dbx";
    const KEYRING_ACCOUNT: &str = "encryption_key";

    // Try to get from OS keyring first
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
        Ok(entry) => {
            match entry.get_password() {
                Ok(key_hex) => {
                    // Key exists in keyring, decode it
                    match hex::decode(&key_hex) {
                        Ok(key_bytes) if key_bytes.len() == 32 => {
                            tracing::info!("Loaded encryption key from OS keyring");
                            return Ok(key_bytes);
                        }
                        _ => {
                            tracing::warn!("Invalid encryption key in OS keyring, generating new one");
                            // Fall through to generate new key
                        }
                    }
                }
                Err(_) => {
                    // Key doesn't exist in keyring yet, will generate and store
                }
            }
        }
        Err(e) => {
            tracing::warn!("Failed to access OS keyring: {}", e);
            // Fall through to try env var
        }
    }

    // Try environment variable
    if let Ok(key_hex) = std::env::var("DBX_ENCRYPTION_KEY") {
        match hex::decode(&key_hex) {
            Ok(key_bytes) if key_bytes.len() == 32 => {
                tracing::info!("Loaded encryption key from DBX_ENCRYPTION_KEY environment variable");

                // Store in keyring for future use
                if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
                    if let Err(e) = entry.set_password(&key_hex) {
                        tracing::warn!("Failed to store encryption key in OS keyring: {}", e);
                    } else {
                        tracing::info!("Stored encryption key in OS keyring for future use");
                    }
                }

                return Ok(key_bytes);
            }
            _ => {
                return Err("DBX_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters)".to_string());
            }
        }
    }

    // Auto-generate new key and store in keyring on first run
    tracing::info!("No encryption key found. Generating new key and storing in OS keyring...");
    generate_and_store_key(KEYRING_SERVICE, KEYRING_ACCOUNT)
}

/// Generates a new random encryption key and stores it in OS keyring.
fn generate_and_store_key(service: &str, account: &str) -> Result<Vec<u8>, String> {
    use rand::RngCore;

    // Generate random key
    let mut key = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let key_hex = hex::encode(&key);

    // Try to store in keyring
    match keyring::Entry::new(service, account) {
        Ok(entry) => match entry.set_password(&key_hex) {
            Ok(()) => {
                tracing::info!("Generated and stored new encryption key in OS keyring");
                Ok(key)
            }
            Err(e) => Err(format!(
                "Failed to store encryption key in OS keyring: {}. \
                         Please set DBX_ENCRYPTION_KEY environment variable to a 64-character hex string. \
                         Generate one with: openssl rand -hex 32",
                e
            )),
        },
        Err(e) => Err(format!(
            "Failed to access OS keyring: {}. \
                 Please set DBX_ENCRYPTION_KEY environment variable to a 64-character hex string. \
                 Generate one with: openssl rand -hex 32",
            e
        )),
    }
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct HistoryRow {
    id: String,
    connection_name: String,
    database: String,
    sql_text: String,
    executed_at: String,
    execution_time_ms: i64,
    success: bool,
    error: Option<String>,
}

impl Storage {
    pub async fn save_history_entry(&self, entry: &HistoryEntry) -> Result<(), String> {
        sqlx::query(
            "INSERT OR REPLACE INTO history \
             (id, connection_name, database, sql_text, executed_at, execution_time_ms, success, error) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&entry.id)
        .bind(&entry.connection_name)
        .bind(&entry.database)
        .bind(&entry.sql)
        .bind(&entry.executed_at)
        .bind(entry.execution_time_ms as i64)
        .bind(entry.success)
        .bind(&entry.error)
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        // Keep at most MAX_HISTORY entries
        sqlx::query(
            "DELETE FROM history WHERE id NOT IN \
             (SELECT id FROM history ORDER BY executed_at DESC LIMIT 1000)",
        )
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn load_history_entries(&self, limit: usize, offset: usize) -> Result<Vec<HistoryEntry>, String> {
        let rows: Vec<HistoryRow> = sqlx::query_as(
            "SELECT id, connection_name, database, sql_text, executed_at, \
             execution_time_ms, success, error \
             FROM history ORDER BY executed_at DESC LIMIT ? OFFSET ?",
        )
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        Ok(rows
            .into_iter()
            .map(|r| HistoryEntry {
                id: r.id,
                connection_name: r.connection_name,
                database: r.database,
                sql: r.sql_text,
                executed_at: r.executed_at,
                execution_time_ms: r.execution_time_ms as u128,
                success: r.success,
                error: r.error,
            })
            .collect())
    }

    pub async fn clear_history(&self) -> Result<(), String> {
        sqlx::query("DELETE FROM history").execute(&self.db).await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_history_entry(&self, id: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM history WHERE id = ?").bind(id).execute(&self.db).await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// AI Config
// ---------------------------------------------------------------------------

impl Storage {
    pub async fn save_ai_config(&self, config: &AiConfig) -> Result<(), String> {
        let json = serde_json::to_string(config).map_err(|e| e.to_string())?;
        sqlx::query("INSERT OR REPLACE INTO ai_config (id, config_json) VALUES (1, ?)")
            .bind(&json)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load_ai_config(&self) -> Result<Option<AiConfig>, String> {
        let row: Option<(String,)> = sqlx::query_as("SELECT config_json FROM ai_config WHERE id = 1")
            .fetch_optional(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        match row {
            Some((json,)) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------
// AI Conversations
// ---------------------------------------------------------------------------

#[derive(sqlx::FromRow)]
struct AiConversationRow {
    id: String,
    title: String,
    connection_name: String,
    database: String,
    messages_json: String,
    created_at: String,
    updated_at: String,
}

impl Storage {
    pub async fn save_ai_conversation(&self, conv: &AiConversation) -> Result<(), String> {
        let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT OR REPLACE INTO ai_conversations \
             (id, title, connection_name, database, messages_json, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&conv.id)
        .bind(&conv.title)
        .bind(&conv.connection_name)
        .bind(&conv.database)
        .bind(&messages_json)
        .bind(&conv.created_at)
        .bind(&conv.updated_at)
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        // Keep at most 50 conversations
        sqlx::query(
            "DELETE FROM ai_conversations WHERE id NOT IN \
             (SELECT id FROM ai_conversations ORDER BY updated_at DESC LIMIT 50)",
        )
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    pub async fn load_ai_conversations(&self) -> Result<Vec<AiConversation>, String> {
        let rows: Vec<AiConversationRow> = sqlx::query_as(
            "SELECT id, title, connection_name, database, messages_json, \
             created_at, updated_at \
             FROM ai_conversations ORDER BY updated_at DESC",
        )
        .fetch_all(&self.db)
        .await
        .map_err(|e| e.to_string())?;

        rows.into_iter()
            .map(|r| {
                let messages: Vec<AiChatMessage> = serde_json::from_str(&r.messages_json).map_err(|e| e.to_string())?;
                Ok(AiConversation {
                    id: r.id,
                    title: r.title,
                    connection_name: r.connection_name,
                    database: r.database,
                    messages,
                    created_at: r.created_at,
                    updated_at: r.updated_at,
                })
            })
            .collect()
    }

    pub async fn delete_ai_conversation(&self, id: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM ai_conversations WHERE id = ?")
            .bind(id)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Connections (with inline secrets)
// ---------------------------------------------------------------------------

impl Storage {
    pub async fn save_connections(&self, configs: &[ConnectionConfig]) -> Result<(), String> {
        let mut tx = self.db.begin().await.map_err(|e| e.to_string())?;

        sqlx::query("DELETE FROM connections").execute(&mut *tx).await.map_err(|e| e.to_string())?;

        for config in configs {
            // Store config without secrets
            let mut sanitized = config.clone();
            sanitized.password = String::new();
            sanitized.ssh_password = String::new();
            sanitized.ssh_key_passphrase = String::new();
            sanitized.connection_string = None;
            let json = serde_json::to_string(&sanitized).map_err(|e| e.to_string())?;

            sqlx::query("INSERT INTO connections (id, config_json) VALUES (?, ?)")
                .bind(&config.id)
                .bind(&json)
                .execute(&mut *tx)
                .await
                .map_err(|e| e.to_string())?;

            // Store secrets
            persist_secret_in_tx(&mut tx, &config.id, "password", &config.password).await?;
            persist_secret_in_tx(&mut tx, &config.id, "ssh_password", &config.ssh_password).await?;
            persist_secret_in_tx(&mut tx, &config.id, "ssh_key_passphrase", &config.ssh_key_passphrase).await?;
            if let Some(cs) = &config.connection_string {
                persist_secret_in_tx(&mut tx, &config.id, "connection_string", cs).await?;
            } else {
                sqlx::query("DELETE FROM connection_secrets WHERE connection_id = ? AND key = ?")
                    .bind(&config.id)
                    .bind("connection_string")
                    .execute(&mut *tx)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        // Remove secrets for connections that no longer exist
        if configs.is_empty() {
            sqlx::query("DELETE FROM connection_secrets").execute(&mut *tx).await.map_err(|e| e.to_string())?;
        } else {
            let placeholders: Vec<&str> = configs.iter().map(|_| "?").collect();
            let sql = format!("DELETE FROM connection_secrets WHERE connection_id NOT IN ({})", placeholders.join(","));
            let mut query = sqlx::query(&sql);
            for config in configs {
                query = query.bind(&config.id);
            }
            query.execute(&mut *tx).await.map_err(|e| e.to_string())?;
        }

        tx.commit().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        let rows: Vec<(String, String)> = sqlx::query_as("SELECT id, config_json FROM connections")
            .fetch_all(&self.db)
            .await
            .map_err(|e| e.to_string())?;

        let mut configs = Vec::new();
        for (id, json) in rows {
            let mut config: ConnectionConfig = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            config.password = self.get_secret(&id, "password").await?.unwrap_or_default();
            config.ssh_password = self.get_secret(&id, "ssh_password").await?.unwrap_or_default();
            config.ssh_key_passphrase = self.get_secret(&id, "ssh_key_passphrase").await?.unwrap_or_default();
            config.connection_string = self.get_secret(&id, "connection_string").await?;
            configs.push(config);
        }
        Ok(configs)
    }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

impl Storage {
    pub async fn get_secret(&self, connection_id: &str, key: &str) -> Result<Option<String>, String> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT secret FROM connection_secrets WHERE connection_id = ? AND key = ?")
                .bind(connection_id)
                .bind(key)
                .fetch_optional(&self.db)
                .await
                .map_err(|e| e.to_string())?;

        match row {
            Some((encrypted,)) => {
                // Try to decrypt first (new format)
                match encryption::decrypt_secret(&encrypted, &self.encryption_key) {
                    Ok(decrypted) => Ok(Some(decrypted)),
                    Err(_) => {
                        // Fallback: treat as plaintext (old format)
                        // This handles backward compatibility with existing unencrypted secrets
                        Ok(Some(encrypted))
                    }
                }
            }
            None => Ok(None),
        }
    }

    pub async fn set_secret(&self, connection_id: &str, key: &str, secret: &str) -> Result<(), String> {
        // Encrypt the secret before storing
        let encrypted = encryption::encrypt_secret(secret, &self.encryption_key)?;

        sqlx::query(
            "INSERT OR REPLACE INTO connection_secrets (connection_id, key, secret) \
             VALUES (?, ?, ?)",
        )
        .bind(connection_id)
        .bind(key)
        .bind(&encrypted)
        .execute(&self.db)
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn delete_secret(&self, connection_id: &str, key: &str) -> Result<(), String> {
        sqlx::query("DELETE FROM connection_secrets WHERE connection_id = ? AND key = ?")
            .bind(connection_id)
            .bind(key)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

impl Storage {
    pub async fn save_sidebar_layout(&self, layout: &serde_json::Value) -> Result<(), String> {
        let json = serde_json::to_string(layout).map_err(|e| e.to_string())?;
        sqlx::query("INSERT OR REPLACE INTO sidebar_layout (id, layout_json) VALUES (1, ?)")
            .bind(&json)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn load_sidebar_layout(&self) -> Result<Option<serde_json::Value>, String> {
        let row: Option<(String,)> = sqlx::query_as("SELECT layout_json FROM sidebar_layout WHERE id = 1")
            .fetch_optional(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        match row {
            Some((json,)) => serde_json::from_str(&json).map(Some).map_err(|e| e.to_string()),
            None => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------
// JSON migration
// ---------------------------------------------------------------------------

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
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let configs: Vec<ConnectionConfig> = serde_json::from_str(&json).unwrap_or_default();
        for config in &configs {
            let config_json = serde_json::to_string(config).map_err(|e| e.to_string())?;
            sqlx::query("INSERT OR IGNORE INTO connections (id, config_json) VALUES (?, ?)")
                .bind(&config.id)
                .bind(&config_json)
                .execute(&self.db)
                .await
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, data_dir.join("connections.json.bak")).ok();
        Ok(())
    }

    async fn migrate_secrets_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("secrets.json");
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let secrets: std::collections::HashMap<String, String> = serde_json::from_str(&json).unwrap_or_default();
        for (key, secret) in &secrets {
            // key format: "connection:{id}:{field}"
            let parts: Vec<&str> = key.splitn(3, ':').collect();
            if parts.len() == 3 && parts[0] == "connection" {
                sqlx::query(
                    "INSERT OR IGNORE INTO connection_secrets \
                     (connection_id, key, secret) VALUES (?, ?, ?)",
                )
                .bind(parts[1])
                .bind(parts[2])
                .bind(secret)
                .execute(&self.db)
                .await
                .map_err(|e| e.to_string())?;
            }
        }
        std::fs::rename(&path, data_dir.join("secrets.json.bak")).ok();
        Ok(())
    }

    async fn migrate_history_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("query_history.json");
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let entries: Vec<HistoryEntry> = serde_json::from_str(&json).unwrap_or_default();
        for entry in &entries {
            sqlx::query(
                "INSERT OR IGNORE INTO history \
                 (id, connection_name, database, sql_text, executed_at, \
                  execution_time_ms, success, error) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&entry.id)
            .bind(&entry.connection_name)
            .bind(&entry.database)
            .bind(&entry.sql)
            .bind(&entry.executed_at)
            .bind(entry.execution_time_ms as i64)
            .bind(entry.success)
            .bind(&entry.error)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, data_dir.join("query_history.json.bak")).ok();
        Ok(())
    }

    async fn migrate_ai_config_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("ai_config.json");
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        // Only migrate if the table is empty
        let count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM ai_config").fetch_one(&self.db).await.map_err(|e| e.to_string())?;
        if count.0 == 0 {
            sqlx::query("INSERT OR IGNORE INTO ai_config (id, config_json) VALUES (1, ?)")
                .bind(&json)
                .execute(&self.db)
                .await
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, data_dir.join("ai_config.json.bak")).ok();
        Ok(())
    }

    async fn migrate_ai_conversations_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("ai_conversations.json");
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let conversations: Vec<AiConversation> = serde_json::from_str(&json).unwrap_or_default();
        for conv in &conversations {
            let messages_json = serde_json::to_string(&conv.messages).map_err(|e| e.to_string())?;
            sqlx::query(
                "INSERT OR IGNORE INTO ai_conversations \
                 (id, title, connection_name, database, messages_json, \
                  created_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&conv.id)
            .bind(&conv.title)
            .bind(&conv.connection_name)
            .bind(&conv.database)
            .bind(&messages_json)
            .bind(&conv.created_at)
            .bind(&conv.updated_at)
            .execute(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, data_dir.join("ai_conversations.json.bak")).ok();
        Ok(())
    }

    async fn migrate_sidebar_layout_json(&self, data_dir: &Path) -> Result<(), String> {
        let path = data_dir.join("sidebar_layout.json");
        if !path.exists() {
            return Ok(());
        }
        let json = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sidebar_layout")
            .fetch_one(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        if count.0 == 0 {
            sqlx::query("INSERT OR IGNORE INTO sidebar_layout (id, layout_json) VALUES (1, ?)")
                .bind(&json)
                .execute(&self.db)
                .await
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&path, data_dir.join("sidebar_layout.json.bak")).ok();
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn persist_secret_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    connection_id: &str,
    key: &str,
    secret: &str,
) -> Result<(), String> {
    if secret.is_empty() {
        sqlx::query("DELETE FROM connection_secrets WHERE connection_id = ? AND key = ?")
            .bind(connection_id)
            .bind(key)
            .execute(&mut **tx)
            .await
            .map_err(|e| e.to_string())?;
    } else {
        sqlx::query(
            "INSERT OR REPLACE INTO connection_secrets \
             (connection_id, key, secret) VALUES (?, ?, ?)",
        )
        .bind(connection_id)
        .bind(key)
        .bind(secret)
        .execute(&mut **tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
