//! Scheduler domain model: task definitions, triggers, execution policies and runs.
//!
//! This is the frozen Wave-1 contract shared by desktop, web and background
//! workers. Scheduler only owns *when / where / how many times / timeout /
//! retry / cancel / log / persistence*; providers own *what to do*.

use serde::{Deserialize, Serialize};

use super::trigger::TaskTrigger;

/// Upper bound on pending (queued/starting/running) runs across the scheduler.
pub const MAX_PENDING_RUNS: usize = 100;

/// Maximum accepted timeout for a single run: 30 days.
pub const MAX_TIMEOUT_SECONDS: u64 = 60 * 60 * 24 * 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskProviderType {
    Builtin,
    Plugin,
}

/// Where a task runs. The first version mainly uses `connection_id`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTarget {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRetryPolicy {
    #[serde(default = "default_retry_max_attempts")]
    pub max_attempts: u32,
    #[serde(default)]
    pub backoff_seconds: u64,
    #[serde(default)]
    pub backoff_strategy: TaskBackoffStrategy,
}

fn default_retry_max_attempts() -> u32 {
    1
}

impl Default for TaskRetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 1, backoff_seconds: 0, backoff_strategy: TaskBackoffStrategy::Fixed }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskBackoffStrategy {
    Fixed,
    Exponential,
}

impl Default for TaskBackoffStrategy {
    fn default() -> Self {
        Self::Fixed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskMisfirePolicy {
    Coalesce,
    FireOnce,
    Skip,
}

impl Default for TaskMisfirePolicy {
    fn default() -> Self {
        Self::Coalesce
    }
}

/// Bounded resident restart policy: restart must never become an unbounded
/// crash loop; once `max_restarts` is exhausted the session turns degraded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRestartPolicy {
    pub enabled: bool,
    pub max_restarts: u32,
    #[serde(default)]
    pub backoff_seconds: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskExecutionMode {
    Run,
    Resident,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskConcurrencyPolicy {
    Forbid,
    Queue,
    Replace,
    Parallel,
}

impl Default for TaskConcurrencyPolicy {
    fn default() -> Self {
        Self::Forbid
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskExecutionPolicy {
    pub mode: TaskExecutionMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    #[serde(default)]
    pub concurrency: TaskConcurrencyPolicy,
    #[serde(default)]
    pub retry: TaskRetryPolicy,
    #[serde(default)]
    pub misfire: TaskMisfirePolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart: Option<TaskRestartPolicy>,
}

impl Default for TaskExecutionPolicy {
    fn default() -> Self {
        Self {
            mode: TaskExecutionMode::Run,
            timeout_seconds: None,
            concurrency: TaskConcurrencyPolicy::Forbid,
            retry: TaskRetryPolicy::default(),
            misfire: TaskMisfirePolicy::default(),
            restart: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDefinition {
    pub id: String,
    pub name: String,
    pub provider_type: TaskProviderType,
    pub provider_id: String,
    #[serde(default)]
    pub target: TaskTarget,
    pub trigger: TaskTrigger,
    #[serde(default)]
    pub execution: TaskExecutionPolicy,
    /// Schema version of the provider config; first version is always 1.
    /// Lives on the definition (ADR §14 D2) — the config JSON itself must not
    /// embed a `configVersion` key.
    #[serde(default = "default_config_version")]
    pub config_version: u32,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default = "bool_true")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub next_run_at: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_run_status: Option<TaskRunStatus>,
    #[serde(default = "one")]
    pub version: i64,
}

fn default_config_version() -> u32 {
    1
}

fn bool_true() -> bool {
    true
}
fn one() -> i64 {
    1
}

impl TaskDefinition {
    /// Stable logical identity used for default naming: provider + trigger + connection.
    pub fn identity(&self) -> String {
        format!(
            "{} · {} · {}",
            self.provider_id,
            self.trigger.kind(),
            self.target.connection_id.as_deref().unwrap_or("-")
        )
    }

    pub fn validate(&self) -> Result<(), super::TaskError> {
        bounded_text(&self.id, 256, "Task ID")?;
        bounded_text(&self.name, 256, "Task name")?;
        bounded_text(&self.provider_id, 256, "Provider ID")?;
        if let Some(connection) = &self.target.connection_id {
            bounded_text(connection, 256, "Connection ID")?;
        }
        self.trigger.validate()?;
        if let Some(config) = self.config.as_object() {
            if config.contains_key("configVersion") {
                return Err(super::TaskError::invalid_config(
                    "Task config must not embed configVersion; use task.configVersion",
                ));
            }
        }
        if self.config_version == 0 {
            return Err(super::TaskError::invalid_config("Task config version must be at least 1"));
        }
        if let Some(timeout) = self.execution.timeout_seconds {
            if timeout == 0 || timeout > MAX_TIMEOUT_SECONDS {
                return Err(super::TaskError::invalid_config("Task timeout is out of range"));
            }
        }
        if self.execution.retry.max_attempts == 0 || self.execution.retry.max_attempts > 100 {
            return Err(super::TaskError::invalid_config("Task retry attempts are out of range"));
        }
        if self.execution.retry.backoff_seconds > 86_400 {
            return Err(super::TaskError::invalid_config("Task retry backoff is out of range"));
        }
        if self.execution.mode == TaskExecutionMode::Resident {
            let restart = self.execution.restart.clone().unwrap_or(TaskRestartPolicy {
                enabled: false,
                max_restarts: 0,
                backoff_seconds: 0,
                restart_window_seconds: None,
            });
            if restart.max_restarts > 10_000 || restart.backoff_seconds > 86_400 {
                return Err(super::TaskError::invalid_config("Resident restart policy is out of range"));
            }
        }
        super::validate_config_secrets(&self.config)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunStatus {
    Queued,
    Starting,
    Running,
    Success,
    Failed,
    Cancelled,
    Timeout,
    Skipped,
}

impl TaskRunStatus {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Success | Self::Failed | Self::Cancelled | Self::Timeout | Self::Skipped)
    }

    pub fn is_active(self) -> bool {
        matches!(self, Self::Queued | Self::Starting | Self::Running)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Success => "success",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Skipped => "skipped",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskRunTrigger {
    Manual,
    Scheduled,
    Startup,
    Retry,
    Restart,
}

/// One execution of a task. Runs are the unit of claim, lease, retry and logs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub task_id: String,
    pub status: TaskRunStatus,
    pub trigger: TaskRunTrigger,
    pub attempt: u32,
    #[serde(default)]
    pub worker_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub progress_percent: Option<f64>,
    #[serde(default)]
    pub artifacts_count: u32,
    #[serde(default)]
    pub created_at: String,
}

impl TaskRun {
    pub fn new(
        task_id: &str,
        trigger: TaskRunTrigger,
        attempt: u32,
        created_at: chrono::DateTime<chrono::Utc>,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            task_id: task_id.to_owned(),
            status: TaskRunStatus::Queued,
            trigger,
            attempt,
            worker_id: None,
            started_at: None,
            completed_at: None,
            exit_code: None,
            error_code: None,
            error_message: None,
            progress_percent: None,
            artifacts_count: 0,
            created_at: created_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskAuditAction {
    Create,
    Update,
    Delete,
    Run,
    Cancel,
    Enable,
    Disable,
    ResidentStart,
    ResidentStop,
    ResidentRestart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAuditEntry {
    pub id: String,
    pub task_id: String,
    pub action: TaskAuditAction,
    pub actor_type: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
    pub created_at: String,
}

impl TaskAuditEntry {
    pub fn new(task_id: &str, action: TaskAuditAction, actor_type: &str, metadata: serde_json::Value) -> Self {
        Self {
            id: uuid::Uuid::new_v4().simple().to_string(),
            task_id: task_id.to_owned(),
            action,
            actor_type: actor_type.to_owned(),
            actor_id: None,
            metadata: if metadata.is_null() { serde_json::json!({}) } else { metadata },
            created_at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

pub(crate) fn bounded_text(value: &str, max: usize, label: &str) -> Result<(), super::TaskError> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err(super::TaskError::invalid_config(format!("Invalid {label}")))
    } else {
        Ok(())
    }
}
