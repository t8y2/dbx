//! User-store abstraction.

use async_trait::async_trait;
use uuid::Uuid;

use crate::identity::{AuthIdentity, UserRole};

/// Abstract row of the `auth_users` table. Implemented by the upper layer
/// (dbx-web adapts dbx-core Storage); this crate never touches persistence directly.
#[derive(Clone, Debug)]
pub struct AuthUserRecord {
    pub id: String,
    pub username: String,
    pub display_name: Option<String>,
    pub email: Option<String>,
    /// Argon2 PHC string; local accounts only, always `None` for external-provider users.
    pub password_hash: Option<String>,
    pub role: UserRole,
    pub provider_id: String,
    /// Provider-unique identifier (OIDC sub / LDAP DN hash / same as id for local accounts).
    pub subject: String,
    pub disabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

/// User-store contract. Keys: `(provider_id, username)` unique, `(provider_id, subject)`
/// unique; `id` globally unique.
#[async_trait]
pub trait AuthUserStore: Send + Sync {
    async fn list_users(&self) -> Result<Vec<AuthUserRecord>, String>;
    async fn count_users(&self) -> Result<u64, String>;
    async fn get_user_by_id(&self, id: &str) -> Result<Option<AuthUserRecord>, String>;
    /// Form-login path: locate the account by `(provider_id, username)`.
    async fn get_user_by_login(&self, provider_id: &str, username: &str) -> Result<Option<AuthUserRecord>, String>;
    async fn get_user_by_provider_subject(&self, provider_id: &str, subject: &str) -> Result<Option<AuthUserRecord>, String>;
    async fn create_user(&self, user: AuthUserRecord) -> Result<AuthUserRecord, String>;
    /// Full update (located by `id`).
    async fn update_user(&self, user: AuthUserRecord) -> Result<(), String>;
    async fn delete_user(&self, id: &str) -> Result<(), String>;

    /// JIT provisioning on first external-provider login: match by subject first;
    /// otherwise match by `(provider_id, username)`, backfill the subject, or create the account.
    /// Profile fields refresh from the identity (the IdP is the source of truth for external profiles).
    ///
    /// Note: `disabled` is intentionally not handled here — the login caller must
    /// verify it after fetching, so "account disabled" and "account missing" stay distinct.
    async fn get_or_provision(&self, identity: &AuthIdentity) -> Result<AuthUserRecord, String> {
        let now = unix_now();
        if let Some(user) = self.get_user_by_provider_subject(&identity.provider_id, &identity.subject).await? {
            let mut user = user;
            user.username = identity.username.clone();
            user.display_name = identity.display_name.clone();
            user.email = identity.email.clone();
            user.role = identity.role;
            user.updated_at = now;
            self.update_user(user.clone()).await?;
            return Ok(user);
        }
        if let Some(user) = self.get_user_by_login(&identity.provider_id, &identity.username).await? {
            let mut user = user;
            user.subject = identity.subject.clone();
            user.display_name = identity.display_name.clone();
            user.email = identity.email.clone();
            user.role = identity.role;
            user.updated_at = now;
            self.update_user(user.clone()).await?;
            return Ok(user);
        }
        let user = AuthUserRecord {
            id: Uuid::new_v4().to_string(),
            username: identity.username.clone(),
            display_name: identity.display_name.clone(),
            email: identity.email.clone(),
            password_hash: None,
            role: identity.role,
            provider_id: identity.provider_id.clone(),
            subject: identity.subject.clone(),
            disabled: false,
            created_at: now,
            updated_at: now,
        };
        self.create_user(user.clone()).await
    }
}

/// Convenience constructor for a new record (admin UI creating local users, etc.).
pub fn new_local_user(username: impl Into<String>, password_hash: Option<String>, role: UserRole) -> AuthUserRecord {
    let username = username.into();
    let now = unix_now();
    AuthUserRecord {
        id: Uuid::new_v4().to_string(),
        display_name: None,
        email: None,
        username: username.clone(),
        password_hash,
        role,
        provider_id: "local".into(),
        subject: username,
        disabled: false,
        created_at: now,
        updated_at: now,
    }
}
