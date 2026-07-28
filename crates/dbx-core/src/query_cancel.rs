use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunningQueryDiagnostics {
    pub active_execution_ids: Vec<String>,
    pub active_by_connection: HashMap<String, usize>,
    pub interrupt_registrations: usize,
}

type InterruptFn = Box<dyn Fn() + Send + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RunningTaskKind {
    Query,
    Count,
    Explain,
    Export,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Default)]
pub struct RunningTaskMetadata {
    pub kind: RunningTaskKind,
    pub connection_id: Option<String>,
    pub database: Option<String>,
    pub client_session_id: Option<String>,
    pub owner_scope: Option<String>,
}

impl RunningTaskMetadata {
    pub fn query(
        connection_id: impl Into<String>,
        database: impl Into<String>,
        client_session_id: Option<String>,
    ) -> Self {
        let kind = task_kind_from_client_session_id(client_session_id.as_deref());
        let owner_scope = client_session_id.as_deref().and_then(owner_scope_from_client_session_id);
        Self {
            kind,
            connection_id: Some(connection_id.into()),
            database: Some(database.into()),
            client_session_id,
            owner_scope,
        }
    }

    pub fn with_owner_scope(mut self, owner_scope: impl Into<String>) -> Self {
        self.owner_scope = Some(owner_scope.into());
        self
    }
}

#[derive(Clone)]
struct RunningTask {
    registration_id: u64,
    token: CancellationToken,
    metadata: RunningTaskMetadata,
    pool_key: Option<String>,
}

#[derive(Clone, Default)]
pub struct RunningQueries {
    inner: Arc<Mutex<HashMap<String, RunningTask>>>,
    interrupts: Arc<Mutex<HashMap<String, InterruptFn>>>,
    next_registration_id: Arc<AtomicU64>,
}

impl RunningQueries {
    pub fn register(&self, execution_id: String) -> RegisteredQuery {
        self.register_task(execution_id, RunningTaskMetadata::default())
    }

    pub fn register_task(&self, execution_id: String, metadata: RunningTaskMetadata) -> RegisteredQuery {
        let token = CancellationToken::new();
        let registration_id = self.next_registration_id.fetch_add(1, Ordering::Relaxed) + 1;
        let previous = self.inner.lock().unwrap_or_else(|e| e.into_inner()).insert(
            execution_id.clone(),
            RunningTask { registration_id, token: token.clone(), metadata, pool_key: None },
        );
        if let Some(previous) = previous {
            previous.token.cancel();
            if let Some(interrupt) = self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).remove(&execution_id) {
                interrupt();
            }
        }

        RegisteredQuery { execution_id, registration_id, token, running_queries: self.clone() }
    }

    pub fn register_interrupt(&self, execution_id: &str, interrupt: impl Fn() + Send + 'static) {
        self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).insert(execution_id.to_string(), Box::new(interrupt));
    }

    pub fn cancel(&self, execution_id: &str) -> bool {
        let token =
            self.inner.lock().unwrap_or_else(|e| e.into_inner()).get(execution_id).map(|task| task.token.clone());
        let interrupt = self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).remove(execution_id);

        if let Some(interrupt) = interrupt {
            interrupt();
        }
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub fn cancel_connection(&self, connection_id: &str) -> usize {
        self.cancel_matching(|task| task.metadata.connection_id.as_deref() == Some(connection_id))
    }

    pub fn cancel_client_session(&self, client_session_id: &str) -> usize {
        self.cancel_matching(|task| task.metadata.client_session_id.as_deref() == Some(client_session_id))
    }

    pub fn cancel_owner_scope(&self, owner_scope: &str) -> usize {
        self.cancel_matching(|task| task.metadata.owner_scope.as_deref() == Some(owner_scope))
    }

    pub fn cancel_all(&self) -> usize {
        self.cancel_matching(|_| true)
    }

    pub fn diagnostics(&self) -> RunningQueryDiagnostics {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut active_execution_ids = inner.keys().cloned().collect::<Vec<_>>();
        active_execution_ids.sort();
        let mut active_by_connection = HashMap::new();
        for task in inner.values() {
            if let Some(connection_id) = &task.metadata.connection_id {
                *active_by_connection.entry(connection_id.clone()).or_insert(0) += 1;
            }
        }
        drop(inner);
        RunningQueryDiagnostics {
            active_execution_ids,
            active_by_connection,
            interrupt_registrations: self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).len(),
        }
    }

    fn cancel_matching(&self, predicate: impl Fn(&RunningTask) -> bool) -> usize {
        let execution_ids: Vec<String> = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, task)| predicate(task))
            .map(|(execution_id, _)| execution_id.clone())
            .collect();
        execution_ids.iter().filter(|execution_id| self.cancel(execution_id)).count()
    }

    pub fn set_pool_key(&self, execution_id: &str, pool_key: impl Into<String>) {
        if let Some(task) = self.inner.lock().unwrap_or_else(|e| e.into_inner()).get_mut(execution_id) {
            task.pool_key = Some(pool_key.into());
        }
    }

    pub fn is_pool_active(&self, pool_key: &str) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).values().any(|task| {
            let _kind = task.metadata.kind;
            task.pool_key.as_deref() == Some(pool_key)
        })
    }

    #[cfg(test)]
    pub fn has(&self, execution_id: &str) -> bool {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).contains_key(execution_id)
    }

    #[cfg(test)]
    pub fn task_kind(&self, execution_id: &str) -> Option<RunningTaskKind> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).get(execution_id).map(|task| task.metadata.kind)
    }

    #[cfg(test)]
    pub fn registration_counts(&self) -> (usize, usize) {
        (
            self.inner.lock().unwrap_or_else(|e| e.into_inner()).len(),
            self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).len(),
        )
    }

    fn remove(&self, execution_id: &str, registration_id: u64) {
        let removed = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if inner.get(execution_id).is_some_and(|task| task.registration_id == registration_id) {
                inner.remove(execution_id);
                true
            } else {
                false
            }
        };
        if removed {
            self.interrupts.lock().unwrap_or_else(|e| e.into_inner()).remove(execution_id);
        }
    }
}

fn task_kind_from_client_session_id(client_session_id: Option<&str>) -> RunningTaskKind {
    let Some(session_id) = client_session_id else {
        return RunningTaskKind::Query;
    };
    let session_id = session_id.trim().to_ascii_lowercase();
    if session_id.ends_with(":count") {
        RunningTaskKind::Count
    } else if session_id.ends_with(":explain") {
        RunningTaskKind::Explain
    } else if session_id.ends_with(":export") {
        RunningTaskKind::Export
    } else {
        RunningTaskKind::Query
    }
}

fn owner_scope_from_client_session_id(client_session_id: &str) -> Option<String> {
    let owner = client_session_id.trim().split(':').next()?.trim();
    (!owner.is_empty()).then(|| owner.to_string())
}

pub struct RegisteredQuery {
    execution_id: String,
    registration_id: u64,
    token: CancellationToken,
    running_queries: RunningQueries,
}

impl RegisteredQuery {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for RegisteredQuery {
    fn drop(&mut self) {
        self.running_queries.remove(&self.execution_id, self.registration_id);
    }
}

#[cfg(test)]
mod tests {
    use super::{RunningQueries, RunningTaskKind, RunningTaskMetadata};

    #[test]
    fn cancel_marks_registered_query_as_cancelled() {
        let running = RunningQueries::default();
        let registered = running.register("exec-1".to_string());

        assert!(running.cancel("exec-1"));
        assert!(registered.token().is_cancelled());
    }

    #[test]
    fn cancel_invokes_registered_interrupt() {
        let running = RunningQueries::default();
        let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = interrupted.clone();
        let _registered = running.register("exec-1".to_string());
        running.register_interrupt("exec-1", move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        assert!(running.cancel("exec-1"));
        assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn dropping_registration_removes_running_query() {
        let running = RunningQueries::default();
        let registered = running.register("exec-1".to_string());

        assert!(running.has("exec-1"));
        drop(registered);

        assert!(!running.has("exec-1"));
    }

    #[test]
    fn stale_registration_drop_does_not_remove_replacement() {
        let running = RunningQueries::default();
        let first = running.register("exec-1".to_string());
        let second = running.register("exec-1".to_string());

        assert!(first.token().is_cancelled());
        drop(first);
        assert!(running.has("exec-1"));
        drop(second);
        assert!(!running.has("exec-1"));
    }

    #[test]
    fn scoped_cancellation_only_cancels_matching_tasks() {
        let running = RunningQueries::default();
        let first = running.register_task(
            "exec-1".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-1".to_string())),
        );
        let second = running.register_task(
            "exec-2".to_string(),
            RunningTaskMetadata::query("conn-2", "main", Some("tab-2".to_string())),
        );

        assert_eq!(running.cancel_connection("conn-1"), 1);
        assert!(first.token().is_cancelled());
        assert!(!second.token().is_cancelled());
        assert_eq!(running.cancel_client_session("tab-2"), 1);
        assert!(second.token().is_cancelled());
    }

    #[test]
    fn query_metadata_derives_stable_owner_scope() {
        let metadata = RunningTaskMetadata::query("conn-1", "main", Some("tab-1:export".to_string()));
        assert_eq!(metadata.owner_scope.as_deref(), Some("tab-1"));
    }

    #[test]
    fn owner_scope_cancellation_matches_related_task_kinds() {
        let running = RunningQueries::default();
        let query = running.register_task(
            "exec-query".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-1".to_string())),
        );
        let export = running.register_task(
            "exec-export".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-1:export".to_string())),
        );

        assert_eq!(running.cancel_owner_scope("tab-1"), 2);
        assert!(query.token().is_cancelled());
        assert!(export.token().is_cancelled());
    }

    #[test]
    fn register_task_tracks_kind_and_pool_activity() {
        let running = RunningQueries::default();
        let registered = running.register_task(
            "exec-1".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-1:export".to_string())),
        );

        running.set_pool_key("exec-1", "conn-1:main:session:tab-1_export");

        assert_eq!(running.task_kind("exec-1"), Some(RunningTaskKind::Export));
        assert!(running.is_pool_active("conn-1:main:session:tab-1_export"));
        drop(registered);
        assert!(!running.is_pool_active("conn-1:main:session:tab-1_export"));
    }

    #[test]
    fn unwind_removes_task_and_interrupt_registrations() {
        let running = RunningQueries::default();
        let unwind_running = running.clone();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _registered = unwind_running.register("exec-unwind".to_string());
            unwind_running.register_interrupt("exec-unwind", || {});
            panic!("simulate driver unwind");
        }));

        assert!(result.is_err());
        assert_eq!(running.registration_counts(), (0, 0));
    }

    #[test]
    fn completion_after_cancel_removes_all_registrations() {
        let running = RunningQueries::default();
        let registered = running.register("exec-cancel".to_string());
        running.register_interrupt("exec-cancel", || {});

        assert!(running.cancel("exec-cancel"));
        drop(registered);

        assert_eq!(running.registration_counts(), (0, 0));
    }

    #[test]
    fn diagnostics_expose_ids_and_scoped_counts_without_query_text() {
        let running = RunningQueries::default();
        let _first = running.register_task(
            "exec-2".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-1".to_string())),
        );
        let _second = running.register_task(
            "exec-1".to_string(),
            RunningTaskMetadata::query("conn-1", "main", Some("tab-2".to_string())),
        );

        let diagnostics = running.diagnostics();

        assert_eq!(diagnostics.active_execution_ids, vec!["exec-1", "exec-2"]);
        assert_eq!(diagnostics.active_by_connection.get("conn-1"), Some(&2));
    }
}
