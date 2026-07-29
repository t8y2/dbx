use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;
use uuid::Uuid;

/// Idle time after which an MCP session is considered expired and its pinned
/// backend connection pool may be reclaimed.
const SESSION_IDLE_TTL: Duration = Duration::from_secs(30 * 60);

/// Maximum number of concurrent MCP sessions. Bounds how many pinned backend
/// connection pools an agent can hold at once.
const MAX_SESSIONS: usize = 32;

#[derive(Debug, Clone)]
pub struct McpSession {
    /// Opaque handle returned to the MCP client (`dbx_open_session` result).
    pub id: String,
    pub connection_id: String,
    pub database: String,
    /// Value forwarded to the backend as `client_session_id`, pinning all
    /// queries in this session to the same connection pool.
    pub client_session_id: String,
    last_used: Instant,
}

#[derive(Default)]
pub struct McpSessionStore {
    sessions: Mutex<HashMap<String, McpSession>>,
}

impl McpSessionStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Open a new session bound to `connection_id` + `database`.
    ///
    /// Returns `Err` with a human-readable message when the session cap is
    /// reached; expired sessions are swept before the cap is enforced.
    pub async fn open(&self, connection_id: &str, database: &str) -> Result<McpSession, String> {
        let mut sessions = self.sessions.lock().await;
        sweep_expired(&mut sessions);
        if sessions.len() >= MAX_SESSIONS {
            return Err(format!(
                "Too many open MCP sessions (max {MAX_SESSIONS}). Close unused sessions with dbx_close_session."
            ));
        }
        let id = format!("mcp-session-{}", Uuid::new_v4());
        let session = McpSession {
            id: id.clone(),
            connection_id: connection_id.to_string(),
            database: database.to_string(),
            // Prefixed so these pools are easy to distinguish from desktop UI
            // sessions in backend diagnostics. `:` is normalized away by the
            // backend pool key sanitizer.
            client_session_id: format!("mcp:{id}"),
            last_used: Instant::now(),
        };
        sessions.insert(id, session.clone());
        Ok(session)
    }

    /// Resolve a session id and refresh its idle timer.
    pub async fn resolve(&self, session_id: &str) -> Option<McpSession> {
        let mut sessions = self.sessions.lock().await;
        sweep_expired(&mut sessions);
        let session = sessions.get_mut(session_id)?;
        session.last_used = Instant::now();
        Some(session.clone())
    }

    /// Remove a session and return it so the caller can release the pinned
    /// backend connection pool. Returns `None` for unknown/expired ids.
    pub async fn remove(&self, session_id: &str) -> Option<McpSession> {
        let mut sessions = self.sessions.lock().await;
        sweep_expired(&mut sessions);
        sessions.remove(session_id)
    }
}

fn sweep_expired(sessions: &mut HashMap<String, McpSession>) {
    let now = Instant::now();
    sessions.retain(|_, session| now.duration_since(session.last_used) < SESSION_IDLE_TTL);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_resolve_and_remove_roundtrip() {
        let store = McpSessionStore::new();
        let session = store.open("conn-1", "analytics").await.unwrap();
        assert!(session.id.starts_with("mcp-session-"));
        assert!(session.client_session_id.contains(&session.id));

        let resolved = store.resolve(&session.id).await.unwrap();
        assert_eq!(resolved.connection_id, "conn-1");
        assert_eq!(resolved.database, "analytics");

        let removed = store.remove(&session.id).await.unwrap();
        assert_eq!(removed.id, session.id);
        assert!(store.resolve(&session.id).await.is_none());
        assert!(store.remove(&session.id).await.is_none());
    }

    #[tokio::test]
    async fn session_cap_is_enforced() {
        let store = McpSessionStore::new();
        for _ in 0..MAX_SESSIONS {
            store.open("conn-1", "").await.unwrap();
        }
        let error = store.open("conn-1", "").await.unwrap_err();
        assert!(error.contains("Too many open MCP sessions"));
    }

    #[tokio::test]
    async fn expired_sessions_are_swept_and_free_capacity() {
        let store = McpSessionStore::new();
        for _ in 0..MAX_SESSIONS {
            let session = store.open("conn-1", "").await.unwrap();
            // Force the session to look idle beyond the TTL.
            store.sessions.lock().await.get_mut(&session.id).unwrap().last_used =
                Instant::now() - SESSION_IDLE_TTL - Duration::from_secs(1);
        }
        // All sessions are expired: the sweep must reclaim them before the cap
        // check, so opening a new session succeeds.
        store.open("conn-1", "").await.unwrap();

        // Resolving an expired session must fail instead of silently pinning a
        // fresh backend connection.
        let expired = store.open("conn-1", "").await.unwrap();
        store.sessions.lock().await.get_mut(&expired.id).unwrap().last_used =
            Instant::now() - SESSION_IDLE_TTL - Duration::from_secs(1);
        assert!(store.resolve(&expired.id).await.is_none());
    }
}
