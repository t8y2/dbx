//! Persistence for external auth provider configuration (the `auth_providers` table).
//!
//! The admin UI manages LDAP / OIDC / HTTP-callback / proxy-header providers here;
//! `config_json` holds the provider config without sensitive fields — bind passwords,
//! client secrets etc. are encrypted via `set_secret` into `connection_secrets` under
//! the `AUTH_PROVIDERS_SECRET_NS` namespace. Env-injected providers (`DBX_AUTH_CONFIG`)
//! never hit the table; at assembly time they merge by id and take precedence.

/// Secret namespace for provider sensitive fields (connection_secrets.connection_id).
pub const AUTH_PROVIDERS_SECRET_NS: &str = "auth.providers";

/// A row of `auth_providers`. `kind` is `"ldap" | "oidc" | "http_callback" |
/// `"proxy_header"` (the built-in local provider never lands in the table).
#[derive(Debug, Clone, PartialEq)]
pub struct AuthProviderRow {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub config_json: String,
    pub enabled: bool,
    pub sort_order: i64,
    pub updated_at: i64,
}

impl Storage {
    pub async fn list_auth_providers(&self) -> Result<Vec<AuthProviderRow>, String> {
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, kind, label, config_json, enabled, sort_order, updated_at
                     FROM auth_providers ORDER BY sort_order ASC, id ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], row_to_auth_provider)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })
        .await
    }

    pub async fn get_auth_provider(&self, id: &str) -> Result<Option<AuthProviderRow>, String> {
        let id = id.to_string();
        self.with_conn(move |conn| {
            conn.query_row(
                "SELECT id, kind, label, config_json, enabled, sort_order, updated_at FROM auth_providers WHERE id = ?1",
                [id],
                row_to_auth_provider,
            )
            .optional()
            .map_err(|e| e.to_string())
        })
        .await
    }

    /// Upserts by id (admin UI save).
    pub async fn upsert_auth_provider(&self, provider: AuthProviderRow) -> Result<(), String> {
        self.with_conn(move |conn| {
            conn.execute(
                "INSERT INTO auth_providers (id, kind, label, config_json, enabled, sort_order, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET kind = ?2, label = ?3, config_json = ?4, enabled = ?5, sort_order = ?6, updated_at = ?7",
                rusqlite::params![
                    provider.id,
                    provider.kind,
                    provider.label,
                    provider.config_json,
                    provider.enabled as i64,
                    provider.sort_order,
                    provider.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .await
    }

    pub async fn delete_auth_provider(&self, id: &str) -> Result<(), String> {
        let id = id.to_string();
        self.with_conn(move |conn| conn.execute("DELETE FROM auth_providers WHERE id = ?1", [id]).map(|_| ()).map_err(|e| e.to_string()))
            .await
    }
}

use rusqlite::OptionalExtension;

use crate::persistence::storage::Storage;

fn row_to_auth_provider(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuthProviderRow> {
    Ok(AuthProviderRow {
        id: row.get(0)?,
        kind: row.get(1)?,
        label: row.get(2)?,
        config_json: row.get(3)?,
        enabled: row.get::<_, i64>(4)? != 0,
        sort_order: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

pub(super) const AUTH_PROVIDERS_SCHEMA: &str = "CREATE TABLE IF NOT EXISTS auth_providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
)";

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_storage() -> Storage {
        let directory = tempfile::tempdir().unwrap();
        Storage::open_unmigrated(&directory.path().join("test.db")).await.unwrap()
    }

    #[tokio::test]
    async fn provider_crud_round_trip() {
        let storage = test_storage().await;
        assert_eq!(storage.list_auth_providers().await.unwrap().len(), 0);

        let now = 1_700_000_000;
        storage
            .upsert_auth_provider(AuthProviderRow {
                id: "corp-ldap".into(),
                kind: "ldap".into(),
                label: "Corp LDAP".into(),
                config_json: r#"{"url":"ldap://ldap.corp"}"#.into(),
                enabled: true,
                sort_order: 10,
                updated_at: now,
            })
            .await
            .unwrap();

        let listed = storage.list_auth_providers().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, "ldap");
        assert!(listed[0].enabled);

        // Overwrite write
        storage
            .upsert_auth_provider(AuthProviderRow { enabled: false, ..listed[0].clone() })
            .await
            .unwrap();
        let fetched = storage.get_auth_provider("corp-ldap").await.unwrap().unwrap();
        assert!(!fetched.enabled);

        storage.delete_auth_provider("corp-ldap").await.unwrap();
        assert!(storage.get_auth_provider("corp-ldap").await.unwrap().is_none());
    }
}
