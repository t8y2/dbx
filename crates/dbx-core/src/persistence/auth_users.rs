//! Persistence for web login users (the `auth_users` table).
//!
//! Accounts for multi-user authentication: local password accounts
//! (provider_id = "local", Argon2 hash) and external identities JIT-provisioned
//! by external providers (LDAP/OIDC/callback/proxy) live here. Roles are only `admin` / `member` (see dbx-auth's `UserRole`).

/// A row of `auth_users`. `role` is `"admin"` | `"member"` (the storage layer does not
/// constrain the enum; dbx-auth's `UserRole::parse` gates it upstream).
#[derive(Debug, Clone, PartialEq)]
pub struct AuthUserRow {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// Argon2 PHC string; local accounts only.
    pub password_hash: Option<String>,
    pub role: String,
    pub provider_id: String,
    pub subject: String,
    pub disabled: bool,
    /// Unix seconds.
    pub created_at: i64,
    pub updated_at: i64,
}

/// Fixed id of the built-in local provider (matches dbx-auth's `LOCAL_PROVIDER_ID`;
/// depending on dbx-auth here would couple the storage layer back to the auth framework).
pub const LOCAL_PROVIDER_ID: &str = "local";

/// Initial admin username created by the legacy migration.
pub const LEGACY_ADMIN_USERNAME: &str = "admin";

impl Storage {
    pub async fn list_auth_users(&self) -> Result<Vec<AuthUserRow>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at
                     FROM auth_users ORDER BY created_at ASC, username ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], row_to_auth_user)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    pub async fn count_auth_users(&self) -> Result<u64, String> {
        self.with_conn(|conn| {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM auth_users", [], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            Ok(count.max(0) as u64)
        })
        .await
    }

    pub async fn get_auth_user_by_id(&self, id: &str) -> Result<Option<AuthUserRow>, String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.query_row(AUTH_USER_SELECT_BY_ID, [id], row_to_auth_user).optional().map_err(|e| e.to_string())
        })
        .await
    }

    /// Form-login path: locate the account by `(provider_id, username)`.
    pub async fn get_auth_user_by_login(&self, provider_id: &str, username: &str) -> Result<Option<AuthUserRow>, String> {
        let provider_id = provider_id.to_string();
        let username = username.to_string();
        self.with_conn(move |conn| {
            conn.query_row(AUTH_USER_SELECT_BY_LOGIN, [provider_id, username], row_to_auth_user)
                .optional()
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn get_auth_user_by_provider_subject(&self, provider_id: &str, subject: &str) -> Result<Option<AuthUserRow>, String> {
        let provider_id = provider_id.to_string();
        let subject = subject.to_string();
        self.with_conn(move |conn| {
            conn.query_row(AUTH_USER_SELECT_BY_PROVIDER_SUBJECT, [provider_id, subject], row_to_auth_user)
                .optional()
                .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn insert_auth_user(&self, user: AuthUserRow) -> Result<AuthUserRow, String> {
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO auth_users (id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![
                    user.id,
                    user.username,
                    user.display_name,
                    user.email,
                    user.password_hash,
                    user.role,
                    user.provider_id,
                    user.subject,
                    user.disabled as i64,
                    user.created_at,
                    user.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(user)
        })
        .await
    }

    /// Full update (located by `id`); `id` and `created_at` stay unchanged.
    pub async fn update_auth_user(&self, user: AuthUserRow) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute(
                "UPDATE auth_users SET username = ?2, display_name = ?3, email = ?4, password_hash = ?5,
                     role = ?6, provider_id = ?7, subject = ?8, disabled = ?9, updated_at = ?10
                 WHERE id = ?1",
                rusqlite::params![
                    user.id,
                    user.username,
                    user.display_name,
                    user.email,
                    user.password_hash,
                    user.role,
                    user.provider_id,
                    user.subject,
                    user.disabled as i64,
                    user.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_auth_user(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| conn.execute("DELETE FROM auth_users WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string()))
            .await
    }

    /// Ensures a local admin named `username` exists and sets its password to `hash`.
    ///
    /// The `DBX_PASSWORD` env var goes through here on every startup (env overrides the
    /// stored value, matching the legacy single-admin semantics); the first-run setup uses `insert_auth_user`.
    pub async fn upsert_local_admin_password(&self, username: &str, hash: &str) -> Result<(), String> {
        let now = unix_now();
        let username = username.to_string();
        let hash = hash.to_string();
        self.with_conn(move |conn| {
            let existing: Option<String> = conn
                .query_row(
                    "SELECT id FROM auth_users WHERE provider_id = ?1 AND username = ?2",
                    [LOCAL_PROVIDER_ID, &username],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match existing {
                Some(id) => {
                    conn.execute(
                        "UPDATE auth_users SET password_hash = ?2, role = 'admin', disabled = 0, updated_at = ?3 WHERE id = ?1",
                        rusqlite::params![id, hash, now],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                }
                None => {
                    conn.execute(
                        "INSERT INTO auth_users (id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at)
                         VALUES (?1, ?2, NULL, NULL, ?3, 'admin', ?4, ?2, 0, ?5, ?5)",
                        rusqlite::params![uuid::Uuid::new_v4().to_string(), username, hash, LOCAL_PROVIDER_ID, now],
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                }
            }
        })
        .await
    }

    /// Legacy migration: the old single-admin setup stored the Argon2 hash in
    /// `app_settings.password_hash`. On the first startup after the upgrade, when
    /// `auth_users` is empty and the legacy hash exists, a local admin user inherits
    /// that hash and the login page behaves exactly as before. The legacy key is kept (safe rollback).
    pub async fn migrate_legacy_password_admin(&self) -> Result<bool, String> {
        if self.count_auth_users().await? > 0 {
            return Ok(false);
        }
        let Some(hash) = self.load_password_hash().await? else {
            return Ok(false);
        };
        let now = unix_now();
        self.insert_auth_user(AuthUserRow {
            id: uuid::Uuid::new_v4().to_string(),
            username: LEGACY_ADMIN_USERNAME.to_string(),
            display_name: None,
            email: None,
            password_hash: Some(hash),
            role: "admin".to_string(),
            provider_id: LOCAL_PROVIDER_ID.to_string(),
            subject: LEGACY_ADMIN_USERNAME.to_string(),
            disabled: false,
            created_at: now,
            updated_at: now,
        })
        .await?;
        Ok(true)
    }
}

use rusqlite::OptionalExtension;

use crate::persistence::storage::Storage;

const AUTH_USER_SELECT_BY_ID: &str = "SELECT id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at FROM auth_users WHERE id = ?1";
const AUTH_USER_SELECT_BY_LOGIN: &str = "SELECT id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at FROM auth_users WHERE provider_id = ?1 AND username = ?2";
const AUTH_USER_SELECT_BY_PROVIDER_SUBJECT: &str = "SELECT id, username, display_name, email, password_hash, role, provider_id, subject, disabled, created_at, updated_at FROM auth_users WHERE provider_id = ?1 AND subject = ?2";

fn row_to_auth_user(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthUserRow> {
    Ok(AuthUserRow {
        id: row.get(0)?,
        username: row.get(1)?,
        display_name: row.get(2)?,
        email: row.get(3)?,
        password_hash: row.get(4)?,
        role: row.get(5)?,
        provider_id: row.get(6)?,
        subject: row.get(7)?,
        disabled: row.get::<_, i64>(8)? != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub(super) const AUTH_USERS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT,
    email TEXT,
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'member',
    provider_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
)";

pub(super) const AUTH_USERS_SCHEMA_INDEX_LOGIN: &str =
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_login ON auth_users(provider_id, username)";

pub(super) const AUTH_USERS_SCHEMA_INDEX_PROVIDER_SUBJECT: &str =
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_provider_subject ON auth_users(provider_id, subject)";

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}
