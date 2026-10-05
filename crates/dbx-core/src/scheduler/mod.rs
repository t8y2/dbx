//! Generic scheduler / task runtime (contract:
//! `docs/adr/scheduler-task-contract.md`). The scheduler owns *when / where /
//! how many times / timeout / retry / cancel / log / persistence / process
//! lifetime*; providers own *what to do*. All upper layers (Tauri commands,
//! web routes, background worker) go through [`SchedulerService`] and
//! [`SchedulerEngine`] — nothing outside this module touches the SQLite store
//! directly.

pub mod artifacts;
pub mod engine;
pub mod error;
pub mod events;
pub mod executor;
pub mod lease;
pub mod logs;
pub mod migration;
pub mod models;
pub mod policy;
pub mod providers;
pub mod queue;
pub mod resident;
pub mod service;
pub mod store;
pub mod trigger;

pub use artifacts::TaskArtifact;
pub use engine::SchedulerEngine;
pub use error::{redact_secrets, remove_secret_keys, validate_config_secrets, TaskError, TaskErrorKind};
pub use events::{register_event_sink, SchedulerEventSink};
pub use executor::{
    ResidentExecutor, TaskExecutionContext, TaskExecutionResult, TaskExecutor, TaskExecutorRegistry, TaskProgress,
    TaskProgressReporter,
};
pub use lease::LeaseGuard;
pub use logs::{TaskLogEntry, TaskLogPage, TaskLogQuery, TaskLogger};
pub use migration::SchedulerMigration;
pub use models::{
    TaskAuditAction, TaskAuditEntry, TaskBackoffStrategy, TaskConcurrencyPolicy, TaskDefinition, TaskExecutionMode,
    TaskExecutionPolicy, TaskMisfirePolicy, TaskProviderType, TaskRestartPolicy, TaskRetryPolicy, TaskRun,
    TaskRunStatus, TaskRunTrigger, TaskTarget, MAX_PENDING_RUNS, MAX_TIMEOUT_SECONDS,
};
pub use queue::RunQueue;
pub use resident::{ResidentSession, ResidentState, ResidentStatus};
pub use service::SchedulerService;
pub use store::{RecoveryReport, RunJob, SchedulerStore, SCHEDULER_LEASE};
pub use trigger::TaskTrigger;
