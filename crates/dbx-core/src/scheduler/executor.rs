//! Executor traits (ADR §5.2): the core abstraction between the scheduler and
//! any provider. Two separate traits — `TaskExecutor` for run-mode jobs and
//! `ResidentExecutor` for long-running sessions — so the engine can dispatch
//! by capability without knowing provider internals.

use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

use super::artifacts::TaskArtifact;
use super::logs::TaskLogger;
use super::models::{TaskDefinition, TaskRun};
use super::resident::{ResidentSession, ResidentStatus};
use super::store::SchedulerStore;
use super::TaskError;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone)]
pub struct TaskExecutionContext {
    pub task: TaskDefinition,
    pub run: TaskRun,
    /// Cancellation must be honored by every executor implementation: the
    /// engine cancels it on explicit cancel, shutdown and timeout.
    pub cancellation: CancellationToken,
    pub logger: TaskLogger,
    pub progress: TaskProgressReporter,
}

#[derive(Debug, Clone, Default)]
pub struct TaskExecutionResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub message: Option<String>,
    pub artifacts: Vec<TaskArtifact>,
}

/// Normalized progress update (plan §27–36): engine persists the percent and
/// upper layers broadcast it as `task/progress`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TaskProgress {
    pub percent: Option<f64>,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub label: Option<String>,
}

/// Persists run progress into the store; providers never touch SQLite.
/// Successful reports also broadcast a `run-progress` event (ADR §7.4,
/// fire-and-forget — persistence stays the source of truth).
#[derive(Clone)]
pub struct TaskProgressReporter {
    store: SchedulerStore,
    run_id: String,
    task_id: Option<String>,
}

impl TaskProgressReporter {
    pub fn new(store: SchedulerStore, run_id: &str) -> Self {
        Self { store, run_id: run_id.to_owned(), task_id: None }
    }

    /// Attaches the owning task id so broadcast events carry the frozen
    /// §7.4 `taskId` field. Add-only builder: `new` keeps its signature for
    /// existing callers.
    pub fn with_task_id(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub async fn report(&self, progress: TaskProgress) -> Result<(), TaskError> {
        let percent = progress.percent.map(|value| value.clamp(0.0, 100.0));
        self.store.update_run_progress(&self.run_id, percent).await?;
        super::events::publish(serde_json::json!({
            "type": "run-progress",
            "taskId": self.task_id,
            "runId": self.run_id,
            "percent": percent,
            "current": progress.current,
            "total": progress.total,
            "label": progress.label,
        }));
        Ok(())
    }
}

impl std::fmt::Debug for TaskProgressReporter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskProgressReporter").field("run_id", &self.run_id).finish()
    }
}

/// Run-mode executor: validates a task and executes it once.
#[async_trait]
pub trait TaskExecutor: Send + Sync {
    /// Validates connection / parameters / environment; must not touch
    /// secret plaintext.
    async fn validate(&self, task: &TaskDefinition) -> Result<(), TaskError>;

    /// Executes one run. Implementations must respect
    /// `context.cancellation` and stream logs via `context.logger`.
    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError>;
}

/// Resident-mode executor: start / stop / status of a long-running session.
#[async_trait]
pub trait ResidentExecutor: Send + Sync {
    async fn start(&self, context: TaskExecutionContext) -> Result<ResidentSession, TaskError>;
    async fn stop(&self, session: &ResidentSession) -> Result<(), TaskError>;
    async fn status(&self, session: &ResidentSession) -> Result<ResidentStatus, TaskError>;
}

/// Provider registry keyed by namespaced provider id. Builtin executors are
/// registered at startup; plugin executors arrive through the plugin adapter
/// (`scheduler/providers/plugin.rs`, Agent A2/A4) and reuse the same lookup.
#[derive(Default)]
pub struct TaskExecutorRegistry {
    run_executors: RwLock<HashMap<String, Arc<dyn TaskExecutor>>>,
    resident_executors: RwLock<HashMap<String, Arc<dyn ResidentExecutor>>>,
}

impl TaskExecutorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_run(&self, provider_id: &str, executor: Arc<dyn TaskExecutor>) {
        self.run_executors.write().expect("executor registry poisoned").insert(provider_id.to_owned(), executor);
    }

    pub fn register_resident(&self, provider_id: &str, executor: Arc<dyn ResidentExecutor>) {
        self.resident_executors.write().expect("executor registry poisoned").insert(provider_id.to_owned(), executor);
    }

    pub fn task_executor(&self, provider_id: &str) -> Option<Arc<dyn TaskExecutor>> {
        let guard = self.run_executors.read().expect("executor registry poisoned");
        if let Some(executor) = guard.get(provider_id).cloned() {
            return Some(executor);
        }
        // Plugin providers are served by the shared executor registered under
        // the "plugin" key: every `io.dbx.*.tasks` provider id routes there
        // and the executor itself resolves the owning plugin from the task's
        // target. Builtin ids never collide (they contain no "plugin" key).
        if guard.contains_key("plugin") {
            return guard.get("plugin").cloned();
        }
        None
    }

    pub fn resident_executor(&self, provider_id: &str) -> Option<Arc<dyn ResidentExecutor>> {
        self.resident_executors.read().expect("executor registry poisoned").get(provider_id).cloned()
    }

    pub fn provider_ids(&self) -> Vec<String> {
        let run_guard = self.run_executors.read().expect("executor registry poisoned");
        let resident_guard = self.resident_executors.read().expect("executor registry poisoned");
        let mut ids: Vec<String> = run_guard.keys().chain(resident_guard.keys()).cloned().collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

impl std::fmt::Debug for TaskExecutorRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskExecutorRegistry").field("providers", &self.provider_ids()).finish()
    }
}
