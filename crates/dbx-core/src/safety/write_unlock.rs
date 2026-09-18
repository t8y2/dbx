//! Temporary per-session write-unlock windows for persistently read-only connections.
//!
//! The saved `ConnectionConfig.read_only` flag is never flipped. A confirmed
//! desktop/web session may allow writes for 1 or 5 minutes; MCP and CLI keep
//! reading the persistent flag and cannot use this window.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

use crate::session_credentials::current_credential_owner;

pub const WRITE_UNLOCK_ONE_MINUTE_SECS: u64 = 60;
pub const WRITE_UNLOCK_FIVE_MINUTES_SECS: u64 = 300;

#[derive(Clone, Eq, Hash, PartialEq)]
struct WriteUnlockKey {
    owner_scope: String,
    connection_id: String,
}

impl WriteUnlockKey {
    fn current(connection_id: &str) -> Self {
        Self { owner_scope: current_credential_owner().unwrap_or_default(), connection_id: connection_id.to_string() }
    }
}

#[derive(Default)]
pub struct WriteUnlockWindows {
    inner: RwLock<HashMap<WriteUnlockKey, Instant>>,
}

impl WriteUnlockWindows {
    pub fn parse_duration_secs(secs: u64) -> Result<Duration, String> {
        match secs {
            WRITE_UNLOCK_ONE_MINUTE_SECS => Ok(Duration::from_secs(WRITE_UNLOCK_ONE_MINUTE_SECS)),
            WRITE_UNLOCK_FIVE_MINUTES_SECS => Ok(Duration::from_secs(WRITE_UNLOCK_FIVE_MINUTES_SECS)),
            _ => Err("Write unlock duration must be 1 minute or 5 minutes.".to_string()),
        }
    }

    pub async fn unlock(&self, connection_id: &str, duration_secs: u64) -> Result<u64, String> {
        if connection_id.trim().is_empty() {
            return Err("Connection id is required.".to_string());
        }
        let duration = Self::parse_duration_secs(duration_secs)?;
        let expires_at = Instant::now() + duration;
        self.inner.write().await.insert(WriteUnlockKey::current(connection_id), expires_at);
        Ok(duration.as_millis() as u64)
    }

    pub async fn lock(&self, connection_id: &str) {
        self.inner.write().await.remove(&WriteUnlockKey::current(connection_id));
    }

    pub async fn remaining_ms(&self, connection_id: &str) -> u64 {
        let key = WriteUnlockKey::current(connection_id);
        let expires_at = self.inner.read().await.get(&key).copied();
        let Some(expires_at) = expires_at else {
            return 0;
        };
        remaining_ms_from(expires_at, Instant::now(), &self.inner, key).await
    }

    pub async fn is_active(&self, connection_id: &str) -> bool {
        self.remaining_ms(connection_id).await > 0
    }

    #[cfg(test)]
    async fn force_expiry(&self, connection_id: &str) {
        let key = WriteUnlockKey::current(connection_id);
        self.inner
            .write()
            .await
            .insert(key, Instant::now().checked_sub(Duration::from_secs(1)).unwrap_or_else(Instant::now));
    }
}

async fn remaining_ms_from(
    expires_at: Instant,
    now: Instant,
    inner: &RwLock<HashMap<WriteUnlockKey, Instant>>,
    key: WriteUnlockKey,
) -> u64 {
    if now >= expires_at {
        inner.write().await.remove(&key);
        return 0;
    }
    expires_at.duration_since(now).as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::AppState;
    use crate::models::connection::ConnectionConfig;
    use crate::query::{check_read_only_for_connection, connection_readonly_name};
    use crate::session_credentials::with_credential_owner;
    use crate::storage::Storage;

    fn mysql_config(id: &str, name: &str, read_only: bool) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": name,
            "db_type": "mysql",
            "host": "localhost",
            "port": 3306,
            "username": "tester",
            "password": "",
            "database": "test",
            "read_only": read_only
        }))
        .unwrap()
    }

    async fn test_state(configs: &[ConnectionConfig]) -> (AppState, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open storage");
        let state = AppState::new_with_plugin_dir(storage, dir.path().join("plugins"));
        {
            let mut stored = state.configs.write().await;
            for config in configs {
                stored.insert(config.id.clone(), config.clone());
            }
        }
        (state, dir)
    }

    #[test]
    fn parse_duration_secs_accepts_one_and_five_minutes_only() {
        assert_eq!(WriteUnlockWindows::parse_duration_secs(60).unwrap(), Duration::from_secs(60));
        assert_eq!(WriteUnlockWindows::parse_duration_secs(300).unwrap(), Duration::from_secs(300));
        assert!(WriteUnlockWindows::parse_duration_secs(0).is_err());
        assert!(WriteUnlockWindows::parse_duration_secs(120).is_err());
        assert!(WriteUnlockWindows::parse_duration_secs(600).is_err());
    }

    #[tokio::test]
    async fn read_only_gate_blocks_until_unlock_and_after_expiry() {
        let readonly = mysql_config("prod", "prod-db", true);
        let other = mysql_config("other", "other-db", true);
        let (state, _dir) = test_state(&[readonly, other]).await;

        assert_eq!(connection_readonly_name(&state, "prod").await.as_deref(), Some("prod-db"));
        check_read_only_for_connection(&state, "prod", "INSERT INTO t VALUES (1)")
            .await
            .expect_err("write blocked before unlock");
        check_read_only_for_connection(&state, "prod", "SELECT 1").await.expect("reads still allowed");

        let remaining = state.write_unlock_windows.unlock("prod", 60).await.expect("unlock");
        assert!(remaining > 0 && remaining <= 60_000, "remaining={remaining}");
        assert!(state.write_unlock_windows.is_active("prod").await);
        assert!(!state.write_unlock_windows.is_active("other").await);
        assert!(state.configs.read().await.get("prod").expect("config").read_only);

        assert_eq!(connection_readonly_name(&state, "prod").await, None);
        assert_eq!(connection_readonly_name(&state, "other").await.as_deref(), Some("other-db"));
        check_read_only_for_connection(&state, "prod", "INSERT INTO t VALUES (1)")
            .await
            .expect("write allowed during window");
        check_read_only_for_connection(&state, "other", "DELETE FROM t").await.expect_err("unlock is per connection");

        state.write_unlock_windows.force_expiry("prod").await;
        assert!(!state.write_unlock_windows.is_active("prod").await);
        assert_eq!(connection_readonly_name(&state, "prod").await.as_deref(), Some("prod-db"));
        check_read_only_for_connection(&state, "prod", "UPDATE t SET a = 1")
            .await
            .expect_err("write blocked after expiry");
        assert_eq!(state.write_unlock_windows.remaining_ms("prod").await, 0);
        assert!(state.configs.read().await.get("prod").expect("config").read_only);
    }

    #[tokio::test]
    async fn lock_now_ends_the_window_without_clearing_read_only() {
        let readonly = mysql_config("prod", "prod-db", true);
        let (state, _dir) = test_state(&[readonly]).await;
        state.write_unlock_windows.unlock("prod", 300).await.unwrap();
        assert_eq!(connection_readonly_name(&state, "prod").await, None);

        state.write_unlock_windows.lock("prod").await;
        assert_eq!(connection_readonly_name(&state, "prod").await.as_deref(), Some("prod-db"));
        assert!(state.configs.read().await.get("prod").expect("config").read_only);
    }

    #[tokio::test]
    async fn web_session_owners_cannot_share_an_unlock_window() {
        let readonly = mysql_config("prod", "prod-db", true);
        let (state, _dir) = test_state(&[readonly]).await;

        with_credential_owner(Some("token-a".to_string()), async {
            state.write_unlock_windows.unlock("prod", 60).await.unwrap();
            assert!(state.write_unlock_windows.is_active("prod").await);
        })
        .await;

        with_credential_owner(Some("token-b".to_string()), async {
            assert!(!state.write_unlock_windows.is_active("prod").await);
            assert_eq!(connection_readonly_name(&state, "prod").await.as_deref(), Some("prod-db"));
        })
        .await;
    }
}
