use std::{
    collections::HashMap,
    ops::Deref,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::{Notify, OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::{
    server::{PendingSalesforceWrites, SALESFORCE_WRITE_CONFIRM_TTL},
    session::session_idle_ttl_from_env,
    DbxMcpServer, McpSessionStore,
};

/// Includes principals whose handlers or backend cleanup are still running.
const MAX_PRINCIPAL_STATES: usize = 32;

#[derive(Default)]
struct Registry {
    closed: bool,
    states: HashMap<String, Arc<PrincipalState>>,
}

/// HTTP state belongs to an authenticated principal, not an SDK transport
/// session or a per-request service instance. Admission and shutdown share one
/// lock so no new principal can escape the shutdown drain.
pub(crate) struct PrincipalStates {
    template: DbxMcpServer,
    registry: Mutex<Registry>,
    slots: Arc<Semaphore>,
    idle_ttl: Duration,
}

pub(crate) struct PrincipalState {
    pub(crate) server: DbxMcpServer,
    pub(crate) cancellation: CancellationToken,
    sessions: Arc<McpSessionStore>,
    last_used: Mutex<Instant>,
    lease_released: Arc<Notify>,
    // Removing a map entry does not free capacity. Physical cleanup must finish
    // before another principal can consume this slot.
    _slot: OwnedSemaphorePermit,
}

/// Retain this lease for the entire request, including cancellation teardown.
/// Keeping the Arc private prevents untracked references from outliving leases.
pub(crate) struct PrincipalLease {
    state: Option<Arc<PrincipalState>>,
}

impl Deref for PrincipalLease {
    type Target = PrincipalState;

    fn deref(&self) -> &Self::Target {
        self.state.as_deref().expect("principal lease is live until drop")
    }
}

impl Drop for PrincipalLease {
    fn drop(&mut self) {
        if let Some(state) = self.state.take() {
            *state.last_used.lock().expect("principal idle timer poisoned") = Instant::now();
            let released = state.lease_released.clone();
            // Notify only after releasing the Arc. Otherwise cleanup could
            // wake, see this lease, and sleep forever without another wakeup.
            drop(state);
            released.notify_waiters();
        }
    }
}

impl PrincipalStates {
    pub(crate) fn new(template: DbxMcpServer) -> Arc<Self> {
        Arc::new(Self {
            template,
            registry: Mutex::new(Registry::default()),
            slots: Arc::new(Semaphore::new(MAX_PRINCIPAL_STATES)),
            // Neither a live database session nor a Salesforce confirmation
            // should disappear merely because its HTTP transport ended.
            idle_ttl: session_idle_ttl_from_env().max(SALESFORCE_WRITE_CONFIRM_TTL),
        })
    }

    pub(crate) fn acquire(&self, key: &str) -> Result<PrincipalLease, rmcp::ErrorData> {
        if key.trim().is_empty() {
            return Err(rmcp::ErrorData::internal_error("Missing authenticated HTTP principal", None));
        }
        let mut registry = self.registry.lock().expect("HTTP principal registry poisoned");
        if registry.closed {
            return Err(rmcp::ErrorData::internal_error("HTTP principal state is shutting down", None));
        }
        if let Some(state) = registry.states.get(key) {
            *state.last_used.lock().expect("principal idle timer poisoned") = Instant::now();
            return Ok(PrincipalLease { state: Some(state.clone()) });
        }

        // Never evict an active or recently used principal to admit another.
        // Retiring principals hold their permits until backend cleanup ends.
        let slot = self.slots.clone().try_acquire_owned().map_err(|_| {
            rmcp::ErrorData::internal_error("HTTP principal state capacity reached; retry after idle cleanup", None)
        })?;
        let sessions = McpSessionStore::new();
        let state = Arc::new(PrincipalState {
            server: self
                .template
                .with_isolated_state(sessions.clone(), PendingSalesforceWrites::new(SALESFORCE_WRITE_CONFIRM_TTL)),
            cancellation: CancellationToken::new(),
            sessions,
            last_used: Mutex::new(Instant::now()),
            lease_released: Arc::new(Notify::new()),
            _slot: slot,
        });
        registry.states.insert(key.to_owned(), state.clone());
        Ok(PrincipalLease { state: Some(state) })
    }

    pub(crate) async fn reap(&self) {
        let mut registry = self.registry.lock().expect("HTTP principal registry poisoned");
        let expired = registry
            .states
            .iter()
            .filter(|(_, state)| {
                Arc::strong_count(state) == 1
                    && state.last_used.lock().expect("principal idle timer poisoned").elapsed() >= self.idle_ttl
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in expired {
            if let Some(state) = registry.states.remove(&key) {
                retire(state);
            }
        }
    }

    pub(crate) async fn shutdown(&self) {
        {
            let mut registry = self.registry.lock().expect("HTTP principal registry poisoned");
            registry.closed = true;
            // Spawn before the first await so cancelling a shutdown waiter
            // cannot drop a drained state without scheduling its cleanup.
            for (_, state) in registry.states.drain() {
                retire(state);
            }
        }
        // This also joins cleanup already detached by reap(). No principal can
        // acquire a permit after closed was set under the admission lock.
        let _all_slots = self
            .slots
            .acquire_many(MAX_PRINCIPAL_STATES as u32)
            .await
            .expect("HTTP principal semaphore is never closed");
    }

    #[cfg(test)]
    pub(crate) async fn expire_all_for_test(&self) {
        let registry = self.registry.lock().expect("HTTP principal registry poisoned");
        for state in registry.states.values() {
            *state.last_used.lock().expect("principal idle timer poisoned") =
                Instant::now() - self.idle_ttl - Duration::from_secs(1);
        }
    }
}

fn retire(state: Arc<PrincipalState>) {
    state.cancellation.cancel();
    // Every task owns a slot, bounding live plus retiring state and detached
    // cleanup tasks by the same limit rather than allowing cleanup to pile up.
    tokio::spawn(async move {
        loop {
            let released = state.lease_released.notified();
            tokio::pin!(released);
            // Register before checking the reference count so the last lease
            // cannot disappear between the check and notification registration.
            released.as_mut().enable();
            if Arc::strong_count(&state) == 1 {
                break;
            }
            released.await;
        }
        // A cancelled request may still be unwinding a session operation. Wait
        // for its lease before taking the final snapshot, or late sessions can
        // miss rollback and backend-pool cleanup entirely.
        let sessions = state.sessions.take_all_active().await;
        state.server.close_backend_sessions_best_effort(sessions).await;
        // The state, and therefore its capacity permit, is released last.
    });
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use dbx_core::{
        agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig,
        storage::McpGlobalPolicy,
    };
    use serde_json::Value;

    use super::*;
    use crate::{server::PluginToolsMode, DbxBackend, McpScope, UnavailableBackend};

    fn registry(backend: Arc<dyn DbxBackend>) -> Arc<PrincipalStates> {
        let template = DbxMcpServer::with_plugin_tools_mode(backend, McpScope::default(), false, PluginToolsMode::Flat);
        let mut states = PrincipalStates::new(template);
        // Keep timing deterministic without changing the process environment.
        Arc::get_mut(&mut states).unwrap().idle_ttl = Duration::from_secs(300);
        states
    }

    fn empty_registry() -> Arc<PrincipalStates> {
        registry(Arc::new(UnavailableBackend::new("no backend needed")))
    }

    fn expire(states: &PrincipalStates, key: &str) {
        let registry = states.registry.lock().unwrap();
        let state = registry.states.get(key).unwrap();
        *state.last_used.lock().unwrap() = Instant::now() - states.idle_ttl - Duration::from_secs(1);
    }

    async fn wait_for_available_slot(states: &PrincipalStates) {
        let permit = tokio::time::timeout(Duration::from_secs(5), states.slots.acquire()).await.unwrap().unwrap();
        drop(permit);
    }

    #[tokio::test]
    async fn empty_principal_keys_fail_closed_without_consuming_capacity() {
        let states = empty_registry();
        for key in ["", " ", "\t\n"] {
            assert!(states.acquire(key).is_err());
        }
        assert!(states.registry.lock().unwrap().states.is_empty());
        assert_eq!(states.slots.available_permits(), MAX_PRINCIPAL_STATES);
        states.shutdown().await;
    }

    #[tokio::test]
    async fn same_principal_reuses_state_and_other_principals_are_isolated() {
        let states = empty_registry();
        let first = states.acquire("first").unwrap();
        let again = states.acquire("first").unwrap();
        let second = states.acquire("second").unwrap();
        assert!(Arc::ptr_eq(first.state.as_ref().unwrap(), again.state.as_ref().unwrap()));
        assert!(!Arc::ptr_eq(&first.sessions, &second.sessions));

        let session = first.sessions.open("connection", "database").await.into_parts().0.unwrap();
        assert!(again.sessions.resolve(&session.id).await.into_parts().0.is_some());
        assert!(second.sessions.resolve(&session.id).await.into_parts().0.is_none());
        drop((first, again, second));
        states.shutdown().await;
    }

    #[tokio::test]
    async fn capacity_rejects_new_principals_without_evicting_existing_state() {
        let states = empty_registry();
        let leases = (0..MAX_PRINCIPAL_STATES)
            .map(|index| states.acquire(&format!("principal-{index}")).unwrap())
            .collect::<Vec<_>>();
        assert!(states.acquire("overflow").is_err());
        assert!(states.acquire("principal-0").is_ok());
        assert_eq!(states.registry.lock().unwrap().states.len(), MAX_PRINCIPAL_STATES);
        drop(leases);
        // Dropping a request does not discard the principal's cached sessions.
        assert!(states.acquire("overflow").is_err());
        states.shutdown().await;
    }

    #[tokio::test]
    async fn active_lease_prevents_idle_eviction_and_drop_refreshes_idle_time() {
        let states = empty_registry();
        let lease = states.acquire("principal").unwrap();
        let cancellation = lease.cancellation.clone();
        expire(&states, "principal");
        states.reap().await;
        assert!(!cancellation.is_cancelled());
        assert_eq!(states.registry.lock().unwrap().states.len(), 1);

        drop(lease);
        states.reap().await;
        assert_eq!(states.registry.lock().unwrap().states.len(), 1);
        assert!(!cancellation.is_cancelled());

        expire(&states, "principal");
        states.reap().await;
        assert!(states.registry.lock().unwrap().states.is_empty());
        assert!(cancellation.is_cancelled());
        states.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_rejects_admission_and_waits_for_leases_before_draining_sessions() {
        let backend = Arc::new(BlockingCleanupBackend::default());
        let states = registry(backend.clone());
        let lease = states.acquire("principal").unwrap();
        let cancellation = lease.cancellation.clone();
        let shutdown = tokio::spawn({
            let states = states.clone();
            async move { states.shutdown().await }
        });
        tokio::time::timeout(Duration::from_secs(5), cancellation.cancelled()).await.unwrap();
        assert!(states.acquire("principal").is_err());
        assert!(states.acquire("another").is_err());
        assert!(!shutdown.is_finished());
        assert_eq!(backend.close_started.available_permits(), 0);

        // Simulate an admitted operation finishing its state update while it
        // unwinds cancellation. Cleanup must include this late session.
        let session = lease.sessions.open("connection", "database").await.into_parts().0.unwrap();
        drop(lease);
        backend.wait_for_cleanup().await;
        assert!(!shutdown.is_finished());
        backend.allow_close.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), shutdown).await.unwrap().unwrap();
        assert_eq!(*backend.closed.lock().unwrap(), vec![session.client_session_id]);
        assert_eq!(states.slots.available_permits(), MAX_PRINCIPAL_STATES);
    }

    #[tokio::test]
    async fn retiring_cleanup_keeps_its_capacity_slot_until_backend_close_finishes() {
        let backend = Arc::new(BlockingCleanupBackend::default());
        let states = registry(backend.clone());
        let retiring = states.acquire("retiring").unwrap();
        let _session = retiring.sessions.open("connection", "database").await.into_parts().0.unwrap();
        for index in 1..MAX_PRINCIPAL_STATES {
            drop(states.acquire(&format!("principal-{index}")).unwrap());
        }
        drop(retiring);
        expire(&states, "retiring");
        states.reap().await;
        backend.wait_for_cleanup().await;
        assert_eq!(states.registry.lock().unwrap().states.len(), MAX_PRINCIPAL_STATES - 1);
        assert_eq!(states.slots.available_permits(), 0);
        assert!(states.acquire("new").is_err());
        assert!(states.acquire("retiring").is_err());

        backend.allow_close.add_permits(1);
        wait_for_available_slot(&states).await;
        drop(states.acquire("new").unwrap());
        states.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_waits_for_cleanup_already_detached_by_reaping() {
        let backend = Arc::new(BlockingCleanupBackend::default());
        let states = registry(backend.clone());
        let lease = states.acquire("retiring").unwrap();
        let _session = lease.sessions.open("connection", "database").await.into_parts().0.unwrap();
        drop(lease);
        expire(&states, "retiring");
        states.reap().await;
        backend.wait_for_cleanup().await;

        let shutdown = states.shutdown();
        tokio::pin!(shutdown);
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut shutdown).await.is_err());
        assert!(states.acquire("new").is_err());
        backend.allow_close.add_permits(1);
        tokio::time::timeout(Duration::from_secs(5), shutdown).await.unwrap();
        assert_eq!(backend.closed.lock().unwrap().len(), 1);
    }

    struct BlockingCleanupBackend {
        close_started: Semaphore,
        allow_close: Semaphore,
        closed: Mutex<Vec<String>>,
    }

    impl Default for BlockingCleanupBackend {
        fn default() -> Self {
            Self { close_started: Semaphore::new(0), allow_close: Semaphore::new(0), closed: Mutex::new(Vec::new()) }
        }
    }

    impl BlockingCleanupBackend {
        async fn wait_for_cleanup(&self) {
            tokio::time::timeout(Duration::from_secs(5), self.close_started.acquire()).await.unwrap().unwrap().forget();
        }
    }

    #[async_trait]
    impl DbxBackend for BlockingCleanupBackend {
        async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
            Ok(McpGlobalPolicy::default())
        }

        async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
            Ok(Vec::new())
        }

        async fn execute_agent_tool(
            &self,
            _connection: &ConnectionConfig,
            _database: &str,
            _tool_name: &str,
            _arguments: Value,
            _permissions: AgentSqlPermissions,
        ) -> ToolResult {
            panic!("principal lifecycle tests do not execute tools")
        }

        async fn add_connection_for_mcp(&self, _config: ConnectionConfig) -> Result<ConnectionConfig, String> {
            Err("unused in principal lifecycle tests".to_owned())
        }

        async fn duplicate_connection_for_mcp(
            &self,
            _source_id: &str,
            _copy_id: &str,
            _copy_name: &str,
        ) -> Result<ConnectionConfig, String> {
            Err("unused in principal lifecycle tests".to_owned())
        }

        async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
            Err("unused in principal lifecycle tests".to_owned())
        }

        async fn close_client_session(
            &self,
            _connection_id: &str,
            _database: &str,
            client_session_id: &str,
        ) -> Result<bool, String> {
            self.close_started.add_permits(1);
            self.allow_close.acquire().await.unwrap().forget();
            self.closed.lock().unwrap().push(client_session_id.to_owned());
            Ok(true)
        }
    }
}
