//! In-memory session store.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::identity::UserRole;
use crate::user_store::AuthUserRecord;

/// One login session. The `token` doubles as the credential-owner scope (dbx-core
/// `session_credentials`); its string form is fully compatible with the legacy `HashSet<String>`.
#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub token: String,
    pub user_id: String,
    pub username: String,
    pub provider_id: String,
    pub role: UserRole,
    pub created_at: Instant,
    pub last_seen: Instant,
    pub expires_at: Option<Instant>,
}

impl SessionRecord {
    /// Current-user info exposed to the frontend (the `user` field of `auth/check`).
    pub fn user_summary(&self) -> SessionUserSummary {
        SessionUserSummary {
            username: self.username.clone(),
            role: self.role.as_str().to_string(),
            provider_id: self.provider_id.clone(),
        }
    }
}

/// Current-user summary returned by `auth/check`.
#[derive(Debug, serde::Serialize)]
pub struct SessionUserSummary {
    pub username: String,
    pub role: String,
    pub provider_id: String,
}

/// In-memory session store. Cleared on process restart (same as the legacy behavior);
/// an optional TTL via `DBX_WEB_SESSION_TTL_SECS`; expired sessions are lazily dropped on read and sweep.
pub struct SessionStore {
    ttl: Option<Duration>,
    sessions: RwLock<HashMap<String, SessionRecord>>,
}

impl SessionStore {
    pub fn new(ttl: Option<Duration>) -> Self {
        Self { ttl, sessions: RwLock::new(HashMap::new()) }
    }

    pub fn ttl(&self) -> Option<Duration> {
        self.ttl
    }

    /// Issues a new session for a user and returns the record (opaque token, burned on logout).
    pub async fn create(&self, user: &AuthUserRecord) -> SessionRecord {
        let token = uuid::Uuid::new_v4().to_string();
        self.register_inner(token, user).await
    }

    /// Registers a session with a specific token (for test injection or future session
    /// backfill; normal login goes through `create`). Expiry semantics match `create`.
    pub async fn register(&self, token: &str, user: &AuthUserRecord) -> SessionRecord {
        self.register_inner(token.to_string(), user).await
    }

    /// Registers an anonymous-admin session (password-disabled deployments and tests: the caller has no dedicated account).
    pub async fn register_anonymous(&self, token: &str) -> SessionRecord {
        let user = AuthUserRecord {
            id: token.to_string(),
            username: "anonymous".to_string(),
            display_name: None,
            email: None,
            password_hash: None,
            role: UserRole::Admin,
            provider_id: "local".to_string(),
            subject: token.to_string(),
            disabled: false,
            created_at: 0,
            updated_at: 0,
        };
        self.register_inner(token.to_string(), &user).await
    }

    async fn register_inner(&self, token: String, user: &AuthUserRecord) -> SessionRecord {
        let now = Instant::now();
        let record = SessionRecord {
            token: token.clone(),
            user_id: user.id.clone(),
            username: user.username.clone(),
            provider_id: user.provider_id.clone(),
            role: user.role,
            created_at: now,
            last_seen: now,
            expires_at: self.ttl.map(|ttl| now + ttl),
        };
        self.sessions.write().await.insert(token, record.clone());
        record
    }

    /// Reads a session and slides `last_seen`; expired sessions count as misses and are removed.
    pub async fn get(&self, token: &str) -> Option<SessionRecord> {
        let mut sessions = self.sessions.write().await;
        let record = sessions.get(token).cloned()?;
        if record.expires_at.is_some_and(|expires_at| expires_at <= Instant::now()) {
            sessions.remove(token);
            return None;
        }
        if let Some(entry) = sessions.get_mut(token) {
            entry.last_seen = Instant::now();
        }
        Some(record)
    }

    pub async fn contains(&self, token: &str) -> bool {
        self.get(token).await.is_some()
    }

    pub async fn remove(&self, token: &str) -> Option<SessionRecord> {
        self.sessions.write().await.remove(token)
    }

    /// Clears all sessions (test helper; production code revokes by token/user).
    pub async fn clear(&self) {
        self.sessions.write().await.clear();
    }

    /// Keeps only the given session (revokes siblings after a password change) and returns the revoked count.
    pub async fn retain_only(&self, token: &str) -> usize {
        let mut sessions = self.sessions.write().await;
        let before = sessions.len();
        sessions.retain(|key, _| key == token);
        before - sessions.len()
    }

    /// Revokes a user's sessions except the given token (password rotation keeps the caller's
    /// session alive without touching other users' sessions) and returns the revoked tokens.
    pub async fn revoke_user_except(&self, user_id: &str, except_token: &str) -> Vec<String> {
        let mut sessions = self.sessions.write().await;
        let removed: Vec<String> = sessions
            .iter()
            .filter(|(_, record)| record.user_id == user_id && record.token != except_token)
            .map(|(token, _)| token.clone())
            .collect();
        for token in &removed {
            sessions.remove(token);
        }
        removed
    }

    /// Revokes all sessions of a user (called when disabling/deleting) and returns the revoked tokens.
    pub async fn revoke_user(&self, user_id: &str) -> Vec<String> {
        let mut sessions = self.sessions.write().await;
        let removed: Vec<String> = sessions
            .iter()
            .filter(|(_, record)| record.user_id == user_id)
            .map(|(token, _)| token.clone())
            .collect();
        for token in &removed {
            sessions.remove(token);
        }
        removed
    }

    /// Removes all expired sessions and returns the count. Called periodically by the background sweeper.
    pub async fn sweep_expired(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        let now = Instant::now();
        let before = sessions.len();
        sessions.retain(|_, record| record.expires_at.is_none_or(|expires_at| expires_at > now));
        before - sessions.len()
    }

    pub async fn list(&self) -> Vec<SessionRecord> {
        self.sessions.read().await.values().cloned().collect()
    }

    /// Snapshot of all live tokens (unexpired; eases migration for callers that still
    /// expect `HashSet` semantics, such as the PL debug access check).
    pub async fn tokens(&self) -> std::collections::HashSet<String> {
        self.sessions.read().await.keys().cloned().collect()
    }

    pub async fn len(&self) -> usize {
        self.sessions.read().await.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.sessions.read().await.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::UserRole;

    fn record_with_password() -> AuthUserRecord {
        AuthUserRecord {
            id: "user-1".into(),
            username: "alice".into(),
            display_name: None,
            email: None,
            password_hash: Some("hash".into()),
            role: UserRole::Admin,
            provider_id: "local".into(),
            subject: "user-1".into(),
            disabled: false,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn create_get_remove_round_trip() {
        let store = SessionStore::new(None);
        assert!(store.is_empty().await);

        let record = store.create(&record_with_password()).await;
        let fetched = store.get(&record.token).await.expect("session should exist");
        assert_eq!(fetched.user_id, "user-1");
        assert_eq!(fetched.role, UserRole::Admin);
        assert!(fetched.expires_at.is_none());

        assert!(store.contains(&record.token).await);
        assert_eq!(store.len().await, 1);

        store.remove(&record.token).await;
        assert!(store.get(&record.token).await.is_none());
    }

    #[tokio::test]
    async fn expired_sessions_are_rejected_and_swept() {
        let store = SessionStore::new(Some(Duration::from_millis(20)));
        let record = store.create(&record_with_password()).await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(store.get(&record.token).await.is_none());
        assert_eq!(store.sweep_expired().await, 0, "already cleared on read");
        assert!(store.is_empty().await);
    }

    #[tokio::test]
    async fn retain_only_and_revoke_user() {
        let store = SessionStore::new(None);
        let first = store.create(&record_with_password()).await;
        let second = store.create(&record_with_password()).await;

        assert_eq!(store.retain_only(&first.token).await, 1);
        assert!(store.get(&second.token).await.is_none());
        assert!(store.get(&first.token).await.is_some());

        let third = store.create(&record_with_password()).await;
        let revoked = store.revoke_user("user-1").await;
        assert_eq!(revoked.len(), 2);
        assert!(store.get(&third.token).await.is_none());
    }

    #[tokio::test]
    async fn sweep_clears_expired_but_keeps_live() {
        // No TTL: the sweep never touches live sessions.
        let store = SessionStore::new(None);
        let live = store.create(&record_with_password()).await;
        assert_eq!(store.sweep_expired().await, 0);
        assert_eq!(store.len().await, 1);
        assert_eq!(store.get(&live.token).await.expect("live session").token, live.token);

        // With a TTL: the sweep clears everything once expired.
        let ttl_store = SessionStore::new(Some(Duration::from_millis(20)));
        ttl_store.create(&record_with_password()).await;
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert_eq!(ttl_store.sweep_expired().await, 1);
        assert!(ttl_store.is_empty().await);
    }
}
