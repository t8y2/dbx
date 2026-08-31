use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

/// How long a [`RegisteredQuery::detach`]ed registration stays reachable for
/// an explicit cancel before it is automatically reclaimed. Bounds the
/// resource this leaves behind (pool-activity accounting, and — while it
/// exists — any KILL-QUERY-style interrupt) to a single session's worth of
/// recently-timed-out operations, rather than leaking indefinitely.
const DETACHED_REGISTRATION_GRACE_PERIOD: Duration = Duration::from_secs(30 * 60);

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

struct RunningTask {
    registration_id: u64,
    token: CancellationToken,
    completion: watch::Sender<bool>,
    remember_completion: bool,
    metadata: RunningTaskMetadata,
    pool_key: Option<String>,
    interrupt: Option<InterruptFn>,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancellationWaitResult {
    pub requested: bool,
    pub terminal: bool,
}

#[derive(Clone, Default)]
pub struct RunningQueries {
    // Interrupt closures live inside `RunningTask` rather than a second map
    // so that a task's presence and its interrupt handle always change
    // together under one lock acquisition. Splitting them across two
    // mutexes previously left a window where `cancel()` could remove the
    // task while a driver's `register_interrupt()` — running concurrently,
    // before its interrupt handle was ready — inserted a closure keyed to
    // an execution id nothing would ever look at again, leaking it forever.
    inner: Arc<Mutex<HashMap<String, RunningTask>>>,
    completed: Arc<Mutex<HashMap<String, std::time::Instant>>>,
    next_registration_id: Arc<AtomicU64>,
}

impl RunningQueries {
    pub fn register(&self, execution_id: String) -> RegisteredQuery {
        self.register_task(execution_id, RunningTaskMetadata::default())
    }

    pub fn register_task(&self, execution_id: String, metadata: RunningTaskMetadata) -> RegisteredQuery {
        self.register_task_with_completion_tracking(execution_id, metadata, false)
    }

    /// Register an operation whose terminal state may need to be confirmed
    /// after the caller has already observed a timeout.
    pub fn register_task_for_terminal_confirmation(
        &self,
        execution_id: String,
        metadata: RunningTaskMetadata,
    ) -> RegisteredQuery {
        self.register_task_with_completion_tracking(execution_id, metadata, true)
    }

    fn register_task_with_completion_tracking(
        &self,
        execution_id: String,
        metadata: RunningTaskMetadata,
        remember_completion: bool,
    ) -> RegisteredQuery {
        let token = CancellationToken::new();
        let registration_id = self.next_registration_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (completion, _) = watch::channel(false);
        let previous = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let mut completed = self.completed.lock().unwrap_or_else(|e| e.into_inner());
            completed.retain(|_, completed_at| completed_at.elapsed() < DETACHED_REGISTRATION_GRACE_PERIOD);
            completed.remove(&execution_id);
            inner.insert(
                execution_id.clone(),
                RunningTask {
                    registration_id,
                    token: token.clone(),
                    completion,
                    remember_completion,
                    metadata,
                    pool_key: None,
                    interrupt: None,
                },
            )
        };
        if let Some(mut previous) = previous {
            previous.token.cancel();
            previous.completion.send_replace(true);
            if let Some(interrupt) = previous.interrupt.take() {
                interrupt();
            }
        }

        RegisteredQuery { execution_id, registration_id, token, running_queries: self.clone(), detached: false }
    }

    fn completed_execution_is_terminal(&self, execution_id: &str) -> bool {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.contains_key(execution_id) {
            return false;
        }
        let mut completed = self.completed.lock().unwrap_or_else(|e| e.into_inner());
        completed.retain(|_, completed_at| completed_at.elapsed() < DETACHED_REGISTRATION_GRACE_PERIOD);
        completed.contains_key(execution_id)
    }

    /// Hands over the driver-specific interrupt handle (e.g. a MySQL
    /// `KILL QUERY` or a DuckDB worker cancel) once it becomes available,
    /// which is necessarily *after* the task itself was registered.
    ///
    /// If a `cancel()` already ran for this execution id by the time this
    /// arrives, the task is already gone and nothing will ever call
    /// `cancel()` again for it — so the interrupt runs immediately instead
    /// of being stored, which would otherwise leak it forever (nothing ever
    /// visits an interrupt for a task that no longer exists).
    pub fn register_interrupt(&self, execution_id: &str, interrupt: impl Fn() + Send + 'static) {
        let mut interrupt = Some(Box::new(interrupt) as InterruptFn);
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(task) = inner.get_mut(execution_id) {
                if !task.token.is_cancelled() {
                    task.interrupt = interrupt.take();
                    return;
                }
            }
        }
        interrupt.expect("interrupt must remain available for a cancelled or missing task")();
    }

    pub fn cancel(&self, execution_id: &str) -> bool {
        let (interrupt, completed_task) = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let Some(task) = inner.get_mut(execution_id) else {
                return false;
            };
            task.token.cancel();
            if task.remember_completion {
                (task.interrupt.take(), None)
            } else {
                let mut task = inner.remove(execution_id).expect("registered task must still exist");
                (task.interrupt.take(), Some(task))
            }
        };
        if let Some(interrupt) = interrupt {
            interrupt();
        }
        if let Some(task) = completed_task {
            task.completion.send_replace(true);
        }
        true
    }

    /// A cancellation signal is not a terminal execution result. Wait for the
    /// owning task to finish before reporting that callers may reconcile data.
    pub async fn cancel_and_wait(&self, execution_id: &str, timeout: Duration) -> CancellationWaitResult {
        let Some(mut completion) = ({
            let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.get(execution_id).map(|task| task.completion.subscribe())
        }) else {
            return CancellationWaitResult {
                requested: false,
                terminal: self.completed_execution_is_terminal(execution_id),
            };
        };
        if !self.cancel(execution_id) {
            return CancellationWaitResult {
                requested: false,
                terminal: self.completed_execution_is_terminal(execution_id),
            };
        }

        let terminal = tokio::time::timeout(timeout, async {
            loop {
                if *completion.borrow() {
                    return;
                }
                if completion.changed().await.is_err() {
                    return;
                }
            }
        })
        .await
        .is_ok();
        CancellationWaitResult { requested: true, terminal }
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
        let mut interrupt_registrations = 0;
        for task in inner.values() {
            if let Some(connection_id) = &task.metadata.connection_id {
                *active_by_connection.entry(connection_id.clone()).or_insert(0) += 1;
            }
            if task.interrupt.is_some() {
                interrupt_registrations += 1;
            }
        }
        RunningQueryDiagnostics { active_execution_ids, active_by_connection, interrupt_registrations }
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
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let tasks = inner.len();
        let interrupts = inner.values().filter(|task| task.interrupt.is_some()).count();
        (tasks, interrupts)
    }

    fn remove(&self, execution_id: &str, registration_id: u64) {
        let removed = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            let should_remove = inner.get(execution_id).is_some_and(|task| task.registration_id == registration_id);
            if !should_remove {
                return;
            }
            if inner.get(execution_id).is_some_and(|task| task.remember_completion) {
                self.completed
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(execution_id.to_string(), std::time::Instant::now());
            }
            inner.remove(execution_id)
        };
        if let Some(task) = removed {
            task.completion.send_replace(true);
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
    detached: bool,
}

impl RegisteredQuery {
    pub fn token(&self) -> CancellationToken {
        self.token.clone()
    }

    /// Consumes the guard without immediately removing its `RunningQueries`
    /// entry.
    ///
    /// Used when a caller is giving up on *waiting* for a query (e.g. a
    /// client-observed timeout) but the statement may still be executing
    /// server-side: the registration — and any KILL-QUERY-style interrupt
    /// registered against it — must stay reachable so a later explicit
    /// `cancel()` can still reach it, instead of losing that capability the
    /// instant the caller stops awaiting the result. The entry is still
    /// reclaimed automatically after [`DETACHED_REGISTRATION_GRACE_PERIOD`]
    /// so it does not leak forever if nobody ever revisits it.
    pub fn detach(mut self) {
        self.detached = true;
        let running_queries = self.running_queries.clone();
        let execution_id = self.execution_id.clone();
        let registration_id = self.registration_id;
        tokio::spawn(async move {
            tokio::time::sleep(DETACHED_REGISTRATION_GRACE_PERIOD).await;
            running_queries.remove(&execution_id, registration_id);
        });
    }

    /// Detaches on a client-observed timeout (server-side execution may
    /// still be running and reachable for a later explicit cancel);
    /// otherwise drops normally. Centralizes the branch duplicated across
    /// every HTTP/Tauri query-execution entry point.
    pub fn finish<T>(self, result: &Result<T, crate::query::QueryExecutionError>) {
        self.finish_with_late_cancel(result, true);
    }

    /// Finishes a registration while preserving timed-out work only when the
    /// caller has an execution id it can use for a later explicit cancel.
    pub fn finish_with_late_cancel<T>(
        self,
        result: &Result<T, crate::query::QueryExecutionError>,
        keep_timeout_reachable: bool,
    ) {
        if keep_timeout_reachable && matches!(result, Err(crate::query::QueryExecutionError::Timeout(_))) {
            self.detach();
        }
        // else: falls out of scope here and Drop removes the registration.
    }
}

impl Drop for RegisteredQuery {
    fn drop(&mut self) {
        if !self.detached {
            self.running_queries.remove(&self.execution_id, self.registration_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{RunningQueries, RunningTaskKind, RunningTaskMetadata, DETACHED_REGISTRATION_GRACE_PERIOD};
    use std::time::{Duration, Instant};

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

    #[tokio::test(start_paused = true)]
    async fn detached_registration_survives_and_stays_cancellable() {
        let running = RunningQueries::default();
        let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = interrupted.clone();
        let registered = running.register("exec-timeout".to_string());
        running.set_pool_key("exec-timeout", "pool-1");
        running.register_interrupt("exec-timeout", move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        // Simulate the Tauri command giving up on waiting (client-observed
        // timeout) while the statement may still be running server-side.
        registered.detach();
        assert!(running.has("exec-timeout"));
        assert!(running.is_pool_active("pool-1"));

        // A later explicit cancel must still reach the (still registered)
        // KILL-QUERY-style interrupt.
        assert!(running.cancel("exec-timeout"));
        assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));

        // Cancelling a detached, timed-out query must free it immediately —
        // not after the 30-minute detach grace period.
        assert!(!running.has("exec-timeout"));
        assert!(!running.is_pool_active("pool-1"));
    }

    #[tokio::test(start_paused = true)]
    async fn detached_registration_is_reclaimed_after_the_grace_period() {
        let running = RunningQueries::default();
        let registered = running.register("exec-timeout".to_string());

        registered.detach();
        assert!(running.has("exec-timeout"));

        // Let the spawned cleanup task reach its `sleep().await` and
        // register its timer before we fast-forward the clock, then let it
        // run to completion afterward.
        tokio::task::yield_now().await;
        tokio::time::advance(DETACHED_REGISTRATION_GRACE_PERIOD + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        tokio::task::yield_now().await;

        assert!(!running.has("exec-timeout"));
    }

    #[tokio::test(start_paused = true)]
    async fn finish_detaches_on_timeout_and_drops_otherwise() {
        let running = RunningQueries::default();

        let registered = running.register("exec-timeout".to_string());
        registered.finish(&Result::<(), _>::Err(crate::query::QueryExecutionError::Timeout("t".into())));
        assert!(running.has("exec-timeout"));

        let registered = running.register("exec-ok".to_string());
        registered.finish(&Result::<(), _>::Ok(()));
        assert!(!running.has("exec-ok"));
    }

    #[tokio::test(start_paused = true)]
    async fn finish_only_keeps_timed_out_registration_when_late_cancel_is_reachable() {
        let running = RunningQueries::default();
        let timeout = Result::<(), _>::Err(crate::query::QueryExecutionError::Timeout("t".into()));

        let registered = running.register("exec-internal".to_string());
        registered.finish_with_late_cancel(&timeout, false);
        assert!(!running.has("exec-internal"));

        let registered = running.register("exec-client".to_string());
        registered.finish_with_late_cancel(&timeout, true);
        assert!(running.has("exec-client"));
        assert!(running.cancel("exec-client"));
    }

    #[tokio::test]
    async fn cancel_and_wait_requires_the_execution_guard_to_finish() {
        let running = RunningQueries::default();
        let registered = running.register_task_for_terminal_confirmation("exec-1".to_string(), Default::default());
        let waiting = {
            let running = running.clone();
            tokio::spawn(async move { running.cancel_and_wait("exec-1", Duration::from_secs(1)).await })
        };

        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(registered);

        let result = waiting.await.unwrap();
        assert!(result.requested);
        assert!(result.terminal);
    }

    #[tokio::test]
    async fn cancel_and_wait_recognizes_a_recently_completed_execution() {
        let running = RunningQueries::default();
        let registered = running.register_task_for_terminal_confirmation("exec-1".to_string(), Default::default());
        drop(registered);

        let result = running.cancel_and_wait("exec-1", Duration::from_secs(1)).await;
        assert!(!result.requested);
        assert!(result.terminal);
    }

    #[tokio::test]
    async fn terminal_completion_is_available_after_cancel_wait_times_out() {
        let running = RunningQueries::default();
        let registered = running.register_task_for_terminal_confirmation("exec-1".to_string(), Default::default());

        let first = running.cancel_and_wait("exec-1", Duration::from_millis(1)).await;
        assert!(first.requested);
        assert!(!first.terminal);

        drop(registered);
        let later = running.cancel_and_wait("exec-1", Duration::from_secs(1)).await;
        assert!(!later.requested);
        assert!(later.terminal);
    }

    #[tokio::test]
    async fn stale_terminal_completion_is_reclaimed() {
        let running = RunningQueries::default();
        running
            .completed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert("exec-1".to_string(), Instant::now() - DETACHED_REGISTRATION_GRACE_PERIOD);

        let result = running.cancel_and_wait("exec-1", Duration::from_secs(1)).await;

        assert!(!result.requested);
        assert!(!result.terminal);
        assert!(running.completed.lock().unwrap_or_else(|error| error.into_inner()).is_empty());
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
    fn late_interrupt_registration_after_cancel_runs_immediately_and_does_not_leak() {
        let running = RunningQueries::default();
        let registered = running.register("exec-1".to_string());

        // The user cancels before the driver has a chance to hand over its
        // interrupt handle (e.g. it is still establishing the connection it
        // would issue a KILL QUERY against).
        assert!(running.cancel("exec-1"));

        let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = interrupted.clone();
        running.register_interrupt("exec-1", move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        // Nobody will ever call cancel() again for this execution id, so the
        // late registration must run immediately instead of being stored.
        assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));

        drop(registered);

        assert_eq!(running.registration_counts(), (0, 0));
    }

    #[test]
    fn late_interrupt_after_tracked_cancel_runs_immediately_but_waits_for_guard_cleanup() {
        let running = RunningQueries::default();
        let registered = running.register_task_for_terminal_confirmation("exec-1".to_string(), Default::default());

        assert!(running.cancel("exec-1"));

        let interrupted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = interrupted.clone();
        running.register_interrupt("exec-1", move || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        assert!(interrupted.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(running.registration_counts(), (1, 0));

        drop(registered);
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
