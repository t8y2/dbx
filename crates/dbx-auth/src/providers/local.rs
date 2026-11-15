//! Local multi-user password authentication.

use std::sync::Arc;

use argon2::{Argon2, PasswordHash, PasswordVerifier};
use async_trait::async_trait;

use crate::identity::AuthIdentity;
use crate::provider::{AuthError, AuthProvider, AuthProviderKind, FormCredentials, LoginMode};
use crate::user_store::AuthUserStore;

/// Fixed id of the built-in local provider (`auth_users.provider_id = "local"`).
pub const LOCAL_PROVIDER_ID: &str = "local";

/// Local multi-user password auth. Backwards compatible with the legacy single admin:
/// an empty username matches the sole usable local account, keeping the password-only login page.
pub struct LocalAuthProvider {
    users: Arc<dyn AuthUserStore>,
    label: String,
}

impl LocalAuthProvider {
    pub fn new(users: Arc<dyn AuthUserStore>) -> Self {
        Self { users, label: "Local".to_string() }
    }

    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// Count of usable local accounts (with a password, not disabled), used by the login page to decide whether to show the username field.
    pub async fn local_user_count(&self) -> Result<usize, AuthError> {
        Ok(self
            .users
            .list_users()
            .await
            .map_err(AuthError::Internal)?
            .iter()
            .filter(|user| user.provider_id == LOCAL_PROVIDER_ID && user.password_hash.is_some())
            .count())
    }
}

#[async_trait]
impl AuthProvider for LocalAuthProvider {
    fn id(&self) -> &str {
        LOCAL_PROVIDER_ID
    }

    fn kind(&self) -> AuthProviderKind {
        AuthProviderKind::Local
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn login_mode(&self) -> LoginMode {
        LoginMode::Form
    }

    async fn authenticate(&self, input: &FormCredentials) -> Result<AuthIdentity, AuthError> {
        let username = input.username.as_deref().unwrap_or("").trim();
        let user = if username.is_empty() {
            let mut candidates: Vec<_> = self
                .users
                .list_users()
                .await
                .map_err(AuthError::Internal)?
                .into_iter()
                .filter(|user| user.provider_id == LOCAL_PROVIDER_ID && user.password_hash.is_some() && !user.disabled)
                .collect();
            match candidates.len() {
                0 => return Err(AuthError::Configuration("no local user configured".to_string())),
                1 => candidates.remove(0),
                _ => return Err(AuthError::UsernameRequired),
            }
        } else {
            match self.users.get_user_by_login(LOCAL_PROVIDER_ID, username).await.map_err(AuthError::Internal)? {
                Some(user) if user.password_hash.is_some() => user,
                // Do not distinguish "missing" from "no password" to avoid account enumeration.
                _ => return Err(AuthError::InvalidCredentials),
            }
        };

        if user.disabled {
            return Err(AuthError::UserDisabled);
        }

        let hash = user.password_hash.as_deref().ok_or(AuthError::InvalidCredentials)?;
        let parsed = PasswordHash::new(hash).map_err(|_| AuthError::Internal("corrupt local password hash".to_string()))?;
        if Argon2::default().verify_password(input.password.as_bytes(), &parsed).is_err() {
            return Err(AuthError::InvalidCredentials);
        }

        Ok(AuthIdentity {
            provider_id: LOCAL_PROVIDER_ID.to_string(),
            subject: user.id.clone(),
            username: user.username.clone(),
            display_name: user.display_name.clone(),
            email: user.email.clone(),
            groups: Vec::new(),
            role: user.role,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::UserRole;
    use crate::user_store::AuthUserRecord;
    use std::collections::HashMap;
    use tokio::sync::RwLock;

    #[derive(Default)]
    struct MemStore {
        users: RwLock<HashMap<String, AuthUserRecord>>,
    }

    fn record(username: &str, password_hash: Option<&str>, role: UserRole) -> AuthUserRecord {
        AuthUserRecord {
            id: format!("id-{username}"),
            username: username.to_string(),
            display_name: None,
            email: None,
            password_hash: password_hash.map(str::to_string),
            role,
            provider_id: "local".into(),
            subject: format!("id-{username}"),
            disabled: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn hash_of(password: &str) -> String {
        use argon2::password_hash::SaltString;
        use argon2::PasswordHasher;
        // Fixed salt: tests only need determinism; random salts are covered by the dbx-web integration tests.
        let salt = SaltString::encode_b64(b"dbx-auth-test-salt-v1").unwrap();
        Argon2::default().hash_password(password.as_bytes(), &salt).unwrap().to_string()
    }

    #[async_trait]
    impl AuthUserStore for MemStore {
        async fn list_users(&self) -> Result<Vec<AuthUserRecord>, String> {
            Ok(self.users.read().await.values().cloned().collect())
        }
        async fn count_users(&self) -> Result<u64, String> {
            Ok(self.users.read().await.len() as u64)
        }
        async fn get_user_by_id(&self, id: &str) -> Result<Option<AuthUserRecord>, String> {
            Ok(self.users.read().await.get(id).cloned())
        }
        async fn get_user_by_login(&self, provider_id: &str, username: &str) -> Result<Option<AuthUserRecord>, String> {
            Ok(self
                .users
                .read()
                .await
                .values()
                .find(|user| user.provider_id == provider_id && user.username == username)
                .cloned())
        }
        async fn get_user_by_provider_subject(&self, provider_id: &str, subject: &str) -> Result<Option<AuthUserRecord>, String> {
            Ok(self
                .users
                .read()
                .await
                .values()
                .find(|user| user.provider_id == provider_id && user.subject == subject)
                .cloned())
        }
        async fn create_user(&self, user: AuthUserRecord) -> Result<AuthUserRecord, String> {
            self.users.write().await.insert(user.id.clone(), user.clone());
            Ok(user)
        }
        async fn update_user(&self, user: AuthUserRecord) -> Result<(), String> {
            self.users.write().await.insert(user.id.clone(), user);
            Ok(())
        }
        async fn delete_user(&self, id: &str) -> Result<(), String> {
            self.users.write().await.remove(id);
            Ok(())
        }
    }

    #[tokio::test]
    async fn authenticates_with_username_and_password() {
        let store = Arc::new(MemStore::default());
        store.create_user(record("alice", Some(&hash_of("secret")), UserRole::Admin)).await.unwrap();
        let provider = LocalAuthProvider::new(store);

        let identity = provider.authenticate(&FormCredentials { username: Some("alice".into()), password: "secret".into() }).await.unwrap();
        assert_eq!(identity.username, "alice");
        assert_eq!(identity.role, UserRole::Admin);
        assert_eq!(identity.subject, "id-alice");

        let wrong = provider.authenticate(&FormCredentials { username: Some("alice".into()), password: "nope".into() }).await;
        assert!(matches!(wrong, Err(AuthError::InvalidCredentials)));
    }

    #[tokio::test]
    async fn empty_username_resolves_sole_local_account() {
        let store = Arc::new(MemStore::default());
        store.create_user(record("admin", Some(&hash_of("secret")), UserRole::Admin)).await.unwrap();
        let provider = LocalAuthProvider::new(store);

        let identity = provider.authenticate(&FormCredentials { username: None, password: "secret".into() }).await.unwrap();
        assert_eq!(identity.username, "admin");
    }

    #[tokio::test]
    async fn empty_username_with_multiple_accounts_requires_username() {
        let store = Arc::new(MemStore::default());
        store.create_user(record("admin", Some(&hash_of("a")), UserRole::Admin)).await.unwrap();
        store.create_user(record("bob", Some(&hash_of("b")), UserRole::Member)).await.unwrap();
        let provider = LocalAuthProvider::new(store);

        assert_eq!(provider.local_user_count().await.unwrap(), 2);
        let error = provider.authenticate(&FormCredentials { username: None, password: "a".into() }).await.unwrap_err();
        assert!(matches!(error, AuthError::UsernameRequired));
    }

    #[tokio::test]
    async fn disabled_users_are_rejected() {
        let store = Arc::new(MemStore::default());
        let mut user = record("bob", Some(&hash_of("pw")), UserRole::Member);
        user.disabled = true;
        store.create_user(user).await.unwrap();
        let provider = LocalAuthProvider::new(store);

        let error = provider.authenticate(&FormCredentials { username: Some("bob".into()), password: "pw".into() }).await.unwrap_err();
        assert!(matches!(error, AuthError::UserDisabled));
    }
}
