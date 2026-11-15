//! Adapter exposing dbx-core Storage as the `AuthUserStore`.

use std::sync::Arc;

use async_trait::async_trait;
use dbx_auth::{AuthUserRecord, AuthUserStore, UserRole};
use dbx_core::connection::AppState;
use dbx_core::persistence::auth_users::AuthUserRow;

/// Hooks the `auth_users` table into the auth framework: `dbx-auth` only sees the trait; persistence details stay
/// dbx-core。
pub struct StorageAuthUserStore {
    app: Arc<AppState>,
}

impl StorageAuthUserStore {
    pub fn new(app: Arc<AppState>) -> Self {
        Self { app }
    }
}

fn row_to_record(row: AuthUserRow) -> AuthUserRecord {
    AuthUserRecord {
        id: row.id,
        username: row.username,
        display_name: row.display_name,
        email: row.email,
        password_hash: row.password_hash,
        role: UserRole::parse(&row.role).unwrap_or(UserRole::Member),
        provider_id: row.provider_id,
        subject: row.subject,
        disabled: row.disabled,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn record_to_row(record: AuthUserRecord) -> AuthUserRow {
    AuthUserRow {
        id: record.id,
        username: record.username,
        display_name: record.display_name,
        email: record.email,
        password_hash: record.password_hash,
        role: record.role.as_str().to_string(),
        provider_id: record.provider_id,
        subject: record.subject,
        disabled: record.disabled,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

#[async_trait]
impl AuthUserStore for StorageAuthUserStore {
    async fn list_users(&self) -> Result<Vec<AuthUserRecord>, String> {
        Ok(self.app.storage.list_auth_users().await?.into_iter().map(row_to_record).collect())
    }

    async fn count_users(&self) -> Result<u64, String> {
        self.app.storage.count_auth_users().await
    }

    async fn get_user_by_id(&self, id: &str) -> Result<Option<AuthUserRecord>, String> {
        Ok(self.app.storage.get_auth_user_by_id(id).await?.map(row_to_record))
    }

    async fn get_user_by_login(&self, provider_id: &str, username: &str) -> Result<Option<AuthUserRecord>, String> {
        Ok(self.app.storage.get_auth_user_by_login(provider_id, username).await?.map(row_to_record))
    }

    async fn get_user_by_provider_subject(&self, provider_id: &str, subject: &str) -> Result<Option<AuthUserRecord>, String> {
        Ok(self.app.storage.get_auth_user_by_provider_subject(provider_id, subject).await?.map(row_to_record))
    }

    async fn create_user(&self, user: AuthUserRecord) -> Result<AuthUserRecord, String> {
        Ok(row_to_record(self.app.storage.insert_auth_user(record_to_row(user)).await?))
    }

    async fn update_user(&self, user: AuthUserRecord) -> Result<(), String> {
        self.app.storage.update_auth_user(record_to_row(user)).await
    }

    async fn delete_user(&self, id: &str) -> Result<(), String> {
        self.app.storage.delete_auth_user(id).await
    }
}
