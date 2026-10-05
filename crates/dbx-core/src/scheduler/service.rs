//! SchedulerService (ADR §4): the only entry point upper layers may call.
//! Tauri commands, web routes and the plugin Host API all go through here —
//! nothing outside this module touches the scheduler SQLite store directly.
//! The service owns task CRUD (CAS optimistic locking), manual runs,
//! cancellation, validation, provider dispatch and resident actions, and
//! writes the corresponding audit trail entries.

use std::sync::Arc;

use serde_json::json;

use super::executor::{TaskExecutor, TaskExecutorRegistry};
use super::logs::{TaskLogPage, TaskLogQuery};
use super::models::*;
use super::resident::{ResidentSession, ResidentState};
use super::store::SchedulerStore;
use super::trigger::TaskTrigger;
use super::TaskError;

#[derive(Debug, Clone)]
pub struct SchedulerService {
    store: SchedulerStore,
    registry: Arc<TaskExecutorRegistry>,
}

impl SchedulerService {
    pub fn new(store: SchedulerStore, registry: Arc<TaskExecutorRegistry>) -> Self {
        Self { store, registry }
    }

    pub fn store(&self) -> &SchedulerStore {
        &self.store
    }

    pub fn registry(&self) -> &Arc<TaskExecutorRegistry> {
        &self.registry
    }

    // ------------------------------------------------------------------
    // Task CRUD
    // ------------------------------------------------------------------

    /// Creates a task. Missing IDs and timestamps are filled in; the schedule
    /// (`next_run_at`) is computed from the trigger by the store. Config is
    /// secret-redacted before persisting.
    pub async fn create_task(&self, mut task: TaskDefinition) -> Result<TaskDefinition, TaskError> {
        if task.id.trim().is_empty() {
            task.id = uuid::Uuid::new_v4().simple().to_string();
        }
        task.next_run_at = None;
        let saved = self.store.save_task(task, None).await?;
        self.audit(&saved.id, TaskAuditAction::Create, json!({"name": saved.name})).await;
        Ok(saved)
    }

    /// Updates a task with optimistic locking. The stored version must equal
    /// `expected_version` or a `version_conflict` (HTTP 409) is returned.
    pub async fn update_task(&self, task: TaskDefinition, expected_version: i64) -> Result<TaskDefinition, TaskError> {
        let mut task = task;
        // The schedule is scheduler-owned and always recomputed from the
        // (possibly changed) trigger.
        task.next_run_at = None;
        let saved = self.store.save_task(task, Some(expected_version)).await?;
        self.audit(&saved.id, TaskAuditAction::Update, json!({"version": saved.version})).await;
        Ok(saved)
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<TaskDefinition, TaskError> {
        let mut task = self.store.get_task(id).await?;
        let expected_version = task.version;
        task.enabled = enabled;
        task.next_run_at = None;
        let saved = self.store.save_task(task, Some(expected_version)).await?;
        self.audit(&saved.id, if enabled { TaskAuditAction::Enable } else { TaskAuditAction::Disable }, json!({}))
            .await;
        Ok(saved)
    }

    pub async fn delete_task(&self, id: &str) -> Result<(), TaskError> {
        self.store.delete_task(id.to_owned()).await?;
        self.audit(id, TaskAuditAction::Delete, json!({})).await;
        Ok(())
    }

    // ------------------------------------------------------------------
    // Runs
    // ------------------------------------------------------------------

    /// Manual "run now". Enforces the concurrency policy up front.
    pub async fn run_now(&self, id: &str) -> Result<TaskRun, TaskError> {
        let run = self.store.enqueue_manual(id.to_owned()).await?;
        self.audit(id, TaskAuditAction::Run, json!({"runId": run.id})).await;
        Ok(run)
    }

    /// Cancels a run: queued runs are cancelled immediately; running runs get
    /// their cancel flag flipped so the engine can stop the executor for real.
    pub async fn cancel_run(&self, run_id: &str) -> Result<bool, TaskError> {
        let run = self.store.get_run(run_id.to_owned()).await?;
        let accepted = self.store.request_cancel(run_id.to_owned()).await?;
        if accepted {
            self.audit(&run.task_id, TaskAuditAction::Cancel, json!({"runId": run_id})).await;
        }
        Ok(accepted)
    }

    /// Validates a task: domain invariants first, then the provider's own
    /// validation (connection / parameters / environment).
    pub async fn validate_task(&self, task: &TaskDefinition) -> Result<(), TaskError> {
        task.validate()?;
        let executor: Option<Arc<dyn TaskExecutor>> = self.registry.task_executor(&task.provider_id);
        match executor {
            Some(executor) => executor.validate(task).await,
            None => Err(TaskError::provider_not_found(format!(
                "No task executor registered for provider {}",
                task.provider_id
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Queries (pass-through to the store)
    // ------------------------------------------------------------------

    pub async fn list_tasks(&self) -> Result<Vec<TaskDefinition>, TaskError> {
        self.store.list_tasks().await
    }

    pub async fn get_task(&self, id: &str) -> Result<TaskDefinition, TaskError> {
        self.store.get_task(id).await
    }

    pub async fn list_runs(&self, task_id: Option<String>, limit: u32) -> Result<Vec<TaskRun>, TaskError> {
        self.store.list_runs(task_id, limit).await
    }

    pub async fn get_run(&self, run_id: &str) -> Result<TaskRun, TaskError> {
        self.store.get_run(run_id.to_owned()).await
    }

    pub async fn list_logs(&self, run_id: &str, query: TaskLogQuery) -> Result<TaskLogPage, TaskError> {
        self.store.list_logs(run_id.to_owned(), query).await
    }

    pub async fn list_artifacts(&self, run_id: &str) -> Result<Vec<super::TaskArtifact>, TaskError> {
        self.store.list_artifacts(run_id.to_owned()).await
    }

    pub async fn list_audit(&self, task_id: Option<String>, limit: u32) -> Result<Vec<TaskAuditEntry>, TaskError> {
        self.store.list_audit(task_id, limit).await
    }

    pub async fn list_resident_sessions(&self) -> Result<Vec<ResidentSession>, TaskError> {
        self.store.list_sessions().await
    }

    // ------------------------------------------------------------------
    // Resident actions
    // ------------------------------------------------------------------

    /// Stops a resident session through its executor, then finalizes the run.
    pub async fn resident_stop(&self, session_id: &str) -> Result<(), TaskError> {
        let session = self.find_session(session_id).await?;
        if let Some(executor) = self.registry.resident_executor(&session.plugin_id) {
            executor.stop(&session).await?;
        }
        self.store.update_session_state(session_id.to_owned(), ResidentState::Stopped, session.restart_count).await?;
        self.store
            .finish_run(
                session.run_id.clone(),
                TaskRunStatus::Cancelled,
                None,
                Some("cancelled".into()),
                Some("Resident session stopped".into()),
            )
            .await?;
        self.audit(&session.task_id, TaskAuditAction::ResidentStop, json!({"sessionId": session_id})).await;
        Ok(())
    }

    /// Stops the current session and schedules a restart run. A restart keeps
    /// the restart budget of the session (attempt = restart_count + 1).
    pub async fn resident_restart(&self, session_id: &str) -> Result<TaskRun, TaskError> {
        let session = self.find_session(session_id).await?;
        if let Some(executor) = self.registry.resident_executor(&session.plugin_id) {
            let _ = executor.stop(&session).await;
        }
        self.store.update_session_state(session_id.to_owned(), ResidentState::Stopped, session.restart_count).await?;
        self.store
            .finish_run(
                session.run_id.clone(),
                TaskRunStatus::Cancelled,
                None,
                Some("cancelled".into()),
                Some("Resident session restarted".into()),
            )
            .await?;
        let run = self
            .store
            .enqueue_run(
                session.task_id.clone(),
                TaskRunTrigger::Restart,
                session.restart_count.saturating_add(1),
                chrono::Utc::now(),
            )
            .await?;
        self.audit(
            &session.task_id,
            TaskAuditAction::ResidentRestart,
            json!({"sessionId": session_id, "runId": run.id}),
        )
        .await;
        Ok(run)
    }

    async fn find_session(&self, session_id: &str) -> Result<ResidentSession, TaskError> {
        self.store.list_sessions().await?.into_iter().find(|session| session.id == session_id).ok_or_else(|| {
            TaskError::new(
                super::TaskErrorKind::NonRetryable,
                "session_not_found",
                format!("Resident session {session_id} not found"),
            )
        })
    }

    async fn audit(&self, task_id: &str, action: TaskAuditAction, metadata: serde_json::Value) {
        let entry = TaskAuditEntry::new(task_id, action, "user", metadata);
        if let Err(error) = self.store.append_audit(entry).await {
            log::warn!("[scheduler] cannot write audit entry for task {task_id}: {error}");
        }
    }

    /// Whether the trigger of a definition participates in `enqueue_due`.
    pub fn trigger_is_schedulable(trigger: &TaskTrigger) -> bool {
        matches!(trigger, TaskTrigger::Once { .. } | TaskTrigger::Interval { .. } | TaskTrigger::Cron { .. })
    }
}
