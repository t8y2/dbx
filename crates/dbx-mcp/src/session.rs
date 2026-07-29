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

#[must_use = "expired MCP sessions must be closed by the caller"]
pub struct McpSessionStoreResult<T> {
    value: T,
    expired: Vec<McpSession>,
}

impl<T> McpSessionStoreResult<T> {
    fn new(value: T, expired: Vec<McpSession>) -> Self {
        Self { value, expired }
    }

    pub fn into_parts(self) -> (T, Vec<McpSession>) {
        (self.value, self.expired)
    }
}

#[derive(Default)]
struct McpSessionState {
    active: HashMap<String, McpSession>,
    closing: HashMap<String, McpSession>,
}

#[derive(Default)]
pub struct McpSessionStore {
    state: Mutex<McpSessionState>,
}

impl McpSessionStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Open a new session bound to `connection_id` + `database`.
    ///
    /// Returns `Err` with a human-readable message when the session cap is
    /// reached; expired sessions are swept before the cap is enforced.
    pub async fn open(&self, connection_id: &str, database: &str) -> McpSessionStoreResult<Result<McpSession, String>> {
        let mut state = self.state.lock().await;
        let expired = sweep_expired(&mut state.active);
        if state.active.len() + state.closing.len() >= MAX_SESSIONS {
            return McpSessionStoreResult::new(
                Err(format!(
                    "Too many open MCP sessions (max {MAX_SESSIONS}). Close unused sessions with dbx_close_session."
                )),
                expired,
            );
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
        state.active.insert(id, session.clone());
        McpSessionStoreResult::new(Ok(session), expired)
    }

    /// Resolve a session id and refresh its idle timer.
    pub async fn resolve(&self, session_id: &str) -> McpSessionStoreResult<Option<McpSession>> {
        let mut state = self.state.lock().await;
        let expired = sweep_expired(&mut state.active);
        let session = state.active.get_mut(session_id).map(|session| {
            session.last_used = Instant::now();
            session.clone()
        });
        McpSessionStoreResult::new(session, expired)
    }

    /// Reserve a session for closing. It remains counted against the session
    /// cap until the backend pool is closed successfully.
    pub async fn begin_close(&self, session_id: &str) -> McpSessionStoreResult<Option<McpSession>> {
        let mut state = self.state.lock().await;
        let expired = sweep_expired(&mut state.active);
        let session = state.active.remove(session_id);
        if let Some(session) = &session {
            state.closing.insert(session.id.clone(), session.clone());
        }
        McpSessionStoreResult::new(session, expired)
    }

    pub async fn finish_close(&self, session_id: &str) {
        self.state.lock().await.closing.remove(session_id);
    }

    pub async fn restore_after_failed_close(&self, mut session: McpSession) {
        let mut state = self.state.lock().await;
        if state.closing.remove(&session.id).is_some() {
            session.last_used = Instant::now();
            state.active.insert(session.id.clone(), session);
        }
    }

    #[cfg(test)]
    pub(crate) async fn expire_for_test(&self, session_id: &str) {
        self.state.lock().await.active.get_mut(session_id).unwrap().last_used =
            Instant::now() - SESSION_IDLE_TTL - Duration::from_secs(1);
    }
}

fn sweep_expired(sessions: &mut HashMap<String, McpSession>) -> Vec<McpSession> {
    let now = Instant::now();
    let mut expired = Vec::new();
    sessions.retain(|_, session| {
        let active = now.duration_since(session.last_used) < SESSION_IDLE_TTL;
        if !active {
            expired.push(session.clone());
        }
        active
    });
    expired
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn open_resolve_and_remove_roundtrip() {
        let store = McpSessionStore::new();
        let (session, expired) = store.open("conn-1", "analytics").await.into_parts();
        assert!(expired.is_empty());
        let session = session.unwrap();
        assert!(session.id.starts_with("mcp-session-"));
        assert!(session.client_session_id.contains(&session.id));

        let (resolved, expired) = store.resolve(&session.id).await.into_parts();
        assert!(expired.is_empty());
        let resolved = resolved.unwrap();
        assert_eq!(resolved.connection_id, "conn-1");
        assert_eq!(resolved.database, "analytics");

        let (closing, expired) = store.begin_close(&session.id).await.into_parts();
        assert!(expired.is_empty());
        assert_eq!(closing.unwrap().id, session.id);
        assert!(store.resolve(&session.id).await.into_parts().0.is_none());
        store.finish_close(&session.id).await;
        assert!(store.begin_close(&session.id).await.into_parts().0.is_none());
    }

    #[tokio::test]
    async fn session_cap_is_enforced() {
        let store = McpSessionStore::new();
        for _ in 0..MAX_SESSIONS {
            store.open("conn-1", "").await.into_parts().0.unwrap();
        }
        let error = store.open("conn-1", "").await.into_parts().0.unwrap_err();
        assert!(error.contains("Too many open MCP sessions"));
    }

    #[tokio::test]
    async fn expired_sessions_are_swept_and_free_capacity() {
        let store = McpSessionStore::new();
        let mut session_ids = Vec::new();
        for _ in 0..MAX_SESSIONS {
            let session = store.open("conn-1", "").await.into_parts().0.unwrap();
            session_ids.push(session.id);
        }
        for session_id in &session_ids {
            store.expire_for_test(session_id).await;
        }
        // All sessions are expired: the sweep must reclaim them before the cap
        // check, return them for backend cleanup, and allow a new session.
        let (opened, expired) = store.open("conn-1", "").await.into_parts();
        opened.unwrap();
        assert_eq!(expired.len(), MAX_SESSIONS);

        // Resolving an expired session must fail instead of silently pinning a
        // fresh backend connection.
        let session = store.open("conn-1", "").await.into_parts().0.unwrap();
        store.expire_for_test(&session.id).await;
        let (resolved, expired) = store.resolve(&session.id).await.into_parts();
        assert!(resolved.is_none());
        assert_eq!(expired.len(), 1);
        assert_eq!(expired[0].id, session.id);
    }
}
