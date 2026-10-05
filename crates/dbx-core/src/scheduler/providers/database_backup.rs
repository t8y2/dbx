//! Database backup builtin provider (ADR §8): adapts `TaskRun` onto the
//! **existing** `BackupService` export pipeline. This module is an adapter —
//! it never re-implements export, compression, retention or scheduling
//! algorithms; it only translates the task contract onto the service entry
//! points the legacy scheduler already uses:
//!
//! `TaskRun → executor → BackupService.export_job → artifact → TaskExecutionResult`
//!
//! Secret red line (ADR §10): the task only carries `connectionId`; no
//! credential ever enters config, logs, artifacts or payloads.

use std::{path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, NaiveTime, Timelike, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::{
    database_export,
    models::connection::DatabaseType,
    scheduled_backup::{BackupConfig, BackupRun, BackupSchedule, BackupService, Job, DEFAULT_DIRECTORY},
};

use super::super::{
    artifacts::TaskArtifact,
    executor::{TaskExecutionContext, TaskExecutionResult, TaskExecutor, TaskProgress},
    models::{
        TaskDefinition, TaskExecutionMode, TaskExecutionPolicy, TaskProviderType, TaskRun, TaskRunStatus,
        TaskRunTrigger, TaskTarget,
    },
    trigger::TaskTrigger,
    TaskError,
};

/// Namespaced builtin provider id (ADR §2.2, frozen).
pub const DATABASE_BACKUP_PROVIDER_ID: &str = "dbx.database-backup";

/// Provider config stored on `TaskDefinition.config` (`config_version = 1`).
/// The backup fields are exactly the legacy `BackupConfig` (ADR §8.2) plus the
/// schedule-scoped `runDirectoryPattern` / `retentionCount`. The schedule time
/// zone lives on the trigger, not here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupTaskConfig {
    #[serde(flatten)]
    pub backup: BackupConfig,
    #[serde(default)]
    pub run_directory_pattern: Option<String>,
    #[serde(default = "default_retention_count")]
    pub retention_count: usize,
}

fn default_retention_count() -> usize {
    10
}

impl DatabaseBackupTaskConfig {
    /// Same invariants the legacy `BackupSchedule::validate` applies to these
    /// fields; failures are non-retryable `invalid_config` errors.
    pub fn validate(&self) -> Result<(), TaskError> {
        self.backup.validate().map_err(|error| TaskError::invalid_config(error))?;
        if !(1..=100).contains(&self.retention_count) {
            return Err(TaskError::invalid_config("Invalid backup schedule"));
        }
        if let Some(pattern) = &self.run_directory_pattern {
            crate::scheduled_backup::validate_template(pattern, true)
                .map_err(|error| TaskError::invalid_config(error))?;
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<serde_json::Value, TaskError> {
        serde_json::to_value(self).map_err(|error| TaskError::internal(format!("Encode failed: {error}")))
    }

    pub fn from_json(value: &serde_json::Value) -> Result<Self, TaskError> {
        serde_json::from_value(value.clone())
            .map_err(|error| TaskError::invalid_config(format!("Invalid database backup task config: {error}")))
    }
}

/// Adapter around the existing `BackupService`. Cloned cheaply like the
/// service itself; the scheduler engine holds it behind `Arc<dyn TaskExecutor>`.
#[derive(Clone)]
pub struct DatabaseBackupTaskExecutor {
    service: BackupService,
}

impl DatabaseBackupTaskExecutor {
    pub fn new(service: BackupService) -> Self {
        Self { service }
    }

    pub fn service(&self) -> &BackupService {
        &self.service
    }

    fn parse_config(task: &TaskDefinition) -> Result<DatabaseBackupTaskConfig, TaskError> {
        let config = DatabaseBackupTaskConfig::from_json(&task.config)?;
        config.validate()?;
        Ok(config)
    }

    /// Connection checks mirrored from `BackupService::export_job`: the
    /// connection must exist, support consistent backups and carry saved
    /// credentials for unattended runs. Metadata only — no secret plaintext.
    async fn validate_connection(&self, config: &BackupConfig) -> Result<(), TaskError> {
        let connections =
            self.service.state.storage.load_connections().await.map_err(|error| TaskError::unavailable(error))?;
        let Some(connection) = connections.iter().find(|connection| connection.id == config.connection_id) else {
            return Err(TaskError::connection_missing(format!(
                "Saved backup connection {} is unavailable",
                config.connection_id
            )));
        };
        if !matches!(connection.db_type, DatabaseType::Mysql | DatabaseType::Postgres) {
            return Err(TaskError::invalid_config("This connection does not support consistent scheduled backups"));
        }
        if !connection.save_password || connection.one_time {
            return Err(TaskError::invalid_config(
                "Unattended backups require a saved connection and saved credentials",
            ));
        }
        Ok(())
    }

    /// Applies the legacy post-success retention step (mirrors the tail of
    /// `BackupService::serve/tick`): count successful runs of the schedule and
    /// delete the surplus through the existing `delete_runs` cleanup.
    async fn apply_retention(&self, task_id: &str, config: &DatabaseBackupTaskConfig) -> Result<(), String> {
        let snapshot = self.service.store.snapshot().await?;
        // Migrated schedules keep their authoritative retention on the legacy
        // row; fresh tasks fall back to the task config.
        let retention = snapshot
            .schedules
            .iter()
            .find(|schedule| schedule.id == task_id)
            .map(|schedule| schedule.retention_count)
            .unwrap_or(config.retention_count);
        let ids = snapshot
            .runs
            .iter()
            .filter(|run| run.schedule_id.as_deref() == Some(task_id) && run.status == "success")
            .skip(retention)
            .map(|run| run.id.clone())
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(());
        }
        self.service.delete_runs(ids).await
    }
}

#[async_trait]
impl TaskExecutor for DatabaseBackupTaskExecutor {
    async fn validate(&self, task: &TaskDefinition) -> Result<(), TaskError> {
        let config = Self::parse_config(task)?;
        self.validate_connection(&config.backup).await?;
        self.service
            .validate_destination(&config.backup.destination_directory)
            .map_err(|error| TaskError::invalid_config(error))?;
        Ok(())
    }

    async fn execute(&self, context: TaskExecutionContext) -> Result<TaskExecutionResult, TaskError> {
        let config = Self::parse_config(&context.task)?;
        let run_id = context.run.id.clone();
        let time_zone = task_time_zone(&context.task);
        let manual = matches!(context.run.trigger, TaskRunTrigger::Manual);
        // The legacy run record keeps the old UI (history, progress, cancel,
        // export tracker) fully working while the scheduler drives execution.
        let run = BackupRun {
            id: run_id.clone(),
            schedule_id: Some(context.task.id.clone()),
            schedule_name: context.task.name.clone(),
            display_name: None,
            connection_id: config.backup.connection_id.clone(),
            connection_name: String::new(),
            destination_directory: config.backup.destination_directory.clone(),
            trigger: if manual { "manual" } else { "scheduled" }.into(),
            source: "scheduled".into(),
            status: "running".into(),
            started_at: Utc::now().to_rfc3339(),
            completed_at: None,
            files: Vec::new(),
            progress_percent: 0.0,
            error: None,
        };
        let mut job = Job {
            run: run.clone(),
            config: config.backup.clone(),
            directory_pattern: Some(config.run_directory_pattern.clone().unwrap_or_else(|| DEFAULT_DIRECTORY.into())),
            time_zone,
        };
        self.service.store.insert_running(&job).await.map_err(|error| TaskError::unavailable(error))?;
        let mut logger = context.logger.clone();
        let _ = logger.append(
            "info",
            "system",
            &format!("backup started: {} -> {}", job.config.connection_id, job.config.destination_directory),
        );

        // Fresh AppState per job, exactly like the legacy worker tick.
        let state = Arc::new(crate::connection::AppState::new_with_plugin_dir(
            self.service.state.storage.clone(),
            self.service.state.storage.data_dir().join("plugins"),
        ));

        let (progress, receiver) = watch::channel(job.run.clone());
        // `stop` honors the scheduler cancellation token plus the legacy
        // cancel flag (old UI cancel button writes it into the legacy store).
        let stop = context.cancellation.child_token();
        let bridge_store = self.service.store.clone();
        let bridge_stop = stop.clone();
        let bridge_scheduler = context.cancellation.clone();
        let bridge_run_id = run_id.clone();
        let bridge = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = bridge_scheduler.cancelled() => {
                        bridge_stop.cancel();
                        database_export::set_export_cancelled(&bridge_run_id).await;
                        break;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {
                        if bridge_store.cancelled(bridge_run_id.clone()).await.unwrap_or(false) {
                            bridge_stop.cancel();
                            database_export::set_export_cancelled(&bridge_run_id).await;
                            break;
                        }
                    }
                }
            }
        });
        let reporter = context.progress.clone();
        let mut receiver = receiver;
        let forwarder = tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                let percent = receiver.borrow().progress_percent;
                let _ = reporter.report(TaskProgress { percent: Some(percent), ..Default::default() }).await;
            }
        });

        // The existing export pipeline: snapshot, scope discovery, per-schema
        // SQL export, progress. Nothing here is re-implemented.
        let export = self.service.export_job(&mut job, &state, &stop, &progress).await;
        bridge.abort();
        forwarder.abort();

        job.run.status = if stop.is_cancelled() {
            "cancelled"
        } else if export.is_ok() {
            "success"
        } else {
            "failed"
        }
        .into();
        job.run.error = export.err();
        if job.run.status == "success" {
            job.run.progress_percent = 100.0;
        }
        state.shutdown(Duration::from_secs(3)).await;
        if job.run.status != "success" {
            if let Err(error) = self.service.cleanup(&mut job.run).await {
                job.run.error = Some(format!(
                    "{}; partial files retained: {error}",
                    job.run.error.as_deref().unwrap_or("Backup cancelled")
                ));
            }
        }
        job.run.completed_at = Some(Utc::now().to_rfc3339());
        let success = job.run.status == "success";
        self.service.store.finish(job.run.clone()).await.map_err(|error| TaskError::unavailable(error))?;
        if success {
            if let Err(error) = self.apply_retention(&context.task.id, &config).await {
                let _ = logger.append("warn", "system", &format!("retention cleanup failed: {error}"));
            }
        }
        database_export::clear_export_cancelled(&run_id).await;

        let artifacts = job
            .run
            .files
            .iter()
            .map(|file| TaskArtifact {
                name: file.display_name.clone(),
                uri: file.file_path.clone(),
                content_type: Some(
                    if job.config.output_compression == "gzip" { "application/gzip" } else { "application/sql" }
                        .to_owned(),
                ),
                size: std::fs::metadata(Path::new(&file.file_path)).ok().map(|metadata| metadata.len()),
                checksum: None,
            })
            .collect::<Vec<_>>();
        let _ = logger.system(&format!("backup finished as {}: {} artifact(s)", job.run.status, artifacts.len()));
        if success {
            return Ok(TaskExecutionResult { success: true, exit_code: Some(0), message: None, artifacts });
        }
        let message = job.run.error.clone().unwrap_or_else(|| "Backup failed".into());
        if stop.is_cancelled() || context.cancellation.is_cancelled() {
            return Err(TaskError::cancelled(message));
        }
        Ok(TaskExecutionResult { success: false, exit_code: Some(1), message: Some(message), artifacts })
    }
}

/// The task's display/computation time zone: cron and once triggers carry an
/// IANA zone; other triggers compute in UTC (ADR §1.11).
pub(crate) fn task_time_zone(task: &TaskDefinition) -> String {
    match &task.trigger {
        TaskTrigger::Cron { time_zone, .. } | TaskTrigger::Once { time_zone, .. } => time_zone.clone(),
        _ => "UTC".into(),
    }
}

/// Legacy schedule frequency → frozen `TaskTrigger` (ADR §8.2):
/// hourly → interval seconds, daily/weekly → `m h * * [dow]` cron with the
/// saved IANA zone. Legacy `weekday` and cron both count from Sunday = 0.
pub(crate) fn frequency_to_trigger(schedule: &BackupSchedule) -> Result<TaskTrigger, TaskError> {
    let zone = || schedule.time_zone.clone();
    let time = NaiveTime::parse_from_str(&schedule.time_of_day, "%H:%M")
        .map_err(|_| TaskError::invalid_config(format!("Invalid legacy backup time: {}", schedule.time_of_day)))?;
    match schedule.frequency.as_str() {
        "hourly" => Ok(TaskTrigger::Interval { seconds: u64::from(schedule.interval_hours.clamp(1, 168)) * 60 * 60 }),
        "daily" => {
            Ok(TaskTrigger::Cron { expression: format!("{} {} * * *", time.minute(), time.hour()), time_zone: zone() })
        }
        "weekly" => Ok(TaskTrigger::Cron {
            expression: format!("{} {} * * {}", time.minute(), time.hour(), schedule.weekday),
            time_zone: zone(),
        }),
        other => Err(TaskError::invalid_config(format!("Invalid legacy backup frequency: {other}"))),
    }
}

/// Legacy schedule → `TaskDefinition` (ADR §8.2). Preserves the old schedule
/// id, name, timestamps, enabled flag and last-run bookkeeping.
pub(crate) fn backup_schedule_to_task(schedule: &BackupSchedule) -> Result<TaskDefinition, TaskError> {
    schedule.validate().map_err(|error| {
        TaskError::invalid_config(format!("Legacy backup schedule {} is invalid: {error}", schedule.id))
    })?;
    let trigger = frequency_to_trigger(schedule)?;
    let config = DatabaseBackupTaskConfig {
        backup: schedule.config.clone(),
        run_directory_pattern: schedule.run_directory_pattern.clone(),
        retention_count: schedule.retention_count,
    };
    // Keep the legacy next fire time so migration never causes an immediate
    // double fire; fall back to a fresh schedule when it is not parseable.
    let next_run_at = match chrono::DateTime::parse_from_rfc3339(&schedule.next_run_at) {
        Ok(_) => Some(schedule.next_run_at.clone()),
        Err(_) => trigger.next_after(Utc::now())?.map(|time| time.to_rfc3339()),
    };
    let last_run_status = schedule.last_run_status.as_deref().and_then(|status| match status {
        "success" => Some(TaskRunStatus::Success),
        "failed" => Some(TaskRunStatus::Failed),
        "cancelled" => Some(TaskRunStatus::Cancelled),
        _ => None,
    });
    Ok(TaskDefinition {
        id: schedule.id.clone(),
        name: schedule.name.clone(),
        provider_type: TaskProviderType::Builtin,
        provider_id: DATABASE_BACKUP_PROVIDER_ID.to_owned(),
        target: TaskTarget {
            connection_id: Some(schedule.config.connection_id.clone()),
            plugin_id: None,
            resource_id: None,
        },
        trigger,
        execution: TaskExecutionPolicy { mode: TaskExecutionMode::Run, ..Default::default() },
        config_version: 1,
        config: config.to_json()?,
        enabled: schedule.enabled,
        created_at: schedule.created_at.clone(),
        updated_at: schedule.updated_at.clone(),
        next_run_at,
        last_run_at: schedule.last_run_at.clone(),
        last_run_status,
        version: 1,
    })
}

/// Legacy run → `TaskRun` (ADR §8.2). Returns `None` for one-shot runs: they
/// have no schedule and the frozen schema requires `task_runs.task_id` to
/// reference a task definition, so they stay in the preserved legacy history.
/// A `running` legacy run was interrupted by the migration itself → `failed`
/// with `error_code = "worker_interrupted"` (same as `BackupStore::migrate`).
pub(crate) fn backup_run_to_task_run(run: &BackupRun, now: DateTime<Utc>) -> Result<Option<TaskRun>, TaskError> {
    let Some(task_id) = run.schedule_id.clone() else {
        return Ok(None);
    };
    let (status, error_code, error_message, completed_at) = match run.status.as_str() {
        "running" => (
            TaskRunStatus::Failed,
            Some("worker_interrupted".to_owned()),
            Some("Backup interrupted before migration".to_owned()),
            Some(now.to_rfc3339()),
        ),
        "success" => (TaskRunStatus::Success, None, run.error.clone(), run.completed_at.clone()),
        "failed" => (TaskRunStatus::Failed, None, run.error.clone(), run.completed_at.clone()),
        "cancelled" => (TaskRunStatus::Cancelled, None, run.error.clone(), run.completed_at.clone()),
        other => return Err(TaskError::invalid_config(format!("Invalid legacy backup run status: {other}"))),
    };
    let trigger = if run.trigger == "manual" { TaskRunTrigger::Manual } else { TaskRunTrigger::Scheduled };
    Ok(Some(TaskRun {
        id: run.id.clone(),
        task_id,
        status,
        trigger,
        attempt: 1,
        worker_id: None,
        started_at: Some(run.started_at.clone()),
        completed_at,
        exit_code: None,
        error_code,
        error_message,
        progress_percent: Some(run.progress_percent),
        artifacts_count: 0,
        created_at: run.started_at.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schedule(frequency: &str, time_of_day: &str, weekday: u32, zone: &str) -> BackupSchedule {
        serde_json::from_value(json!({
            "id": "sched-1", "name": "Nightly", "enabled": true, "connectionId": "mysql-1",
            "databases": ["app"], "tableFilterMode": "include", "tablePatterns": ["orders"],
            "destinationDirectory": "/tmp/backups", "includeStructure": true, "includeData": true,
            "includeObjects": true, "dropTableIfExists": true, "outputCompression": "gzip",
            "fileNamePattern": null, "runDirectoryPattern": "dbx/{date}",
            "frequency": frequency, "intervalHours": 3, "timeOfDay": time_of_day,
            "weekday": weekday, "retentionCount": 7, "timeZone": zone,
            "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-02T00:00:00+00:00",
            "nextRunAt": "2026-10-06T02:30:00+00:00", "lastRunAt": "2026-10-05T02:30:00+00:00",
            "lastRunStatus": "success"
        }))
        .unwrap()
    }

    #[test]
    fn hourly_schedule_maps_to_interval_seconds() {
        let task = backup_schedule_to_task(&schedule("hourly", "02:30", 0, "UTC")).unwrap();
        assert_eq!(task.trigger, TaskTrigger::Interval { seconds: 3 * 60 * 60 });
        assert_eq!(task.provider_id, DATABASE_BACKUP_PROVIDER_ID);
        assert_eq!(task.target.connection_id.as_deref(), Some("mysql-1"));
        assert_eq!(task.config["retentionCount"], 7);
        assert_eq!(task.config["runDirectoryPattern"], "dbx/{date}");
        assert_eq!(task.config["destinationDirectory"], "/tmp/backups");
        assert_eq!(task.config["outputCompression"], "gzip");
        assert_eq!(task.config["tableFilterMode"], "include");
        assert_eq!(task.config["tablePatterns"], json!(["orders"]));
        assert!(task.config.get("configVersion").is_none());
        assert_eq!(task.config_version, 1);
    }

    #[test]
    fn daily_and_weekly_map_to_cron_with_saved_zone() {
        let daily = backup_schedule_to_task(&schedule("daily", "02:30", 0, "Asia/Shanghai")).unwrap();
        assert_eq!(
            daily.trigger,
            TaskTrigger::Cron { expression: "30 2 * * *".into(), time_zone: "Asia/Shanghai".into() }
        );
        let weekly = backup_schedule_to_task(&schedule("weekly", "09:05", 1, "America/Los_Angeles")).unwrap();
        assert_eq!(
            weekly.trigger,
            TaskTrigger::Cron { expression: "5 9 * * 1".into(), time_zone: "America/Los_Angeles".into() }
        );
        // The trigger must actually be schedulable through the frozen engine.
        let next = weekly.trigger.next_after(Utc::now()).unwrap();
        assert!(next.is_some());
    }

    #[test]
    fn migrated_task_preserves_identity_and_bookkeeping() {
        let task = backup_schedule_to_task(&schedule("daily", "02:30", 0, "UTC")).unwrap();
        assert_eq!(task.id, "sched-1");
        assert_eq!(task.name, "Nightly");
        assert_eq!(task.created_at, "2026-01-01T00:00:00+00:00");
        assert_eq!(task.updated_at, "2026-01-02T00:00:00+00:00");
        assert_eq!(task.next_run_at.as_deref(), Some("2026-10-06T02:30:00+00:00"));
        assert_eq!(task.last_run_at.as_deref(), Some("2026-10-05T02:30:00+00:00"));
        assert_eq!(task.last_run_status, Some(TaskRunStatus::Success));
        assert!(task.enabled);
        assert_eq!(task.version, 1);
        task.validate().expect("migrated task passes the frozen domain validation");
    }

    #[test]
    fn unparseable_next_run_at_is_recomputed_not_kept() {
        let mut raw = schedule("daily", "02:30", 0, "UTC");
        raw.next_run_at = String::new();
        let task = backup_schedule_to_task(&raw).unwrap();
        let next =
            chrono::DateTime::parse_from_rfc3339(task.next_run_at.as_deref().unwrap()).unwrap().with_timezone(&Utc);
        assert!(next > Utc::now() - chrono::Duration::minutes(1));
    }

    #[test]
    fn invalid_legacy_schedule_fails_the_migration_entry() {
        let mut raw = schedule("daily", "02:30", 0, "UTC");
        raw.time_zone = "Not/AZone".into();
        assert!(backup_schedule_to_task(&raw).is_err());
        let mut raw = schedule("hourly", "02:30", 0, "UTC");
        raw.retention_count = 0;
        assert!(backup_schedule_to_task(&raw).is_err());
    }

    #[test]
    fn run_history_maps_field_by_field() {
        let now = Utc::now();
        let run = BackupRun {
            id: "run-1".into(),
            schedule_id: Some("sched-1".into()),
            schedule_name: "Nightly".into(),
            display_name: None,
            connection_id: "mysql-1".into(),
            connection_name: "Main".into(),
            destination_directory: "/tmp/backups".into(),
            trigger: "scheduled".into(),
            source: "scheduled".into(),
            status: "success".into(),
            started_at: "2026-10-05T02:30:00+00:00".into(),
            completed_at: Some("2026-10-05T02:31:00+00:00".into()),
            files: Vec::new(),
            progress_percent: 100.0,
            error: None,
        };
        let mapped = backup_run_to_task_run(&run, now).unwrap().unwrap();
        assert_eq!(mapped.id, "run-1");
        assert_eq!(mapped.task_id, "sched-1");
        assert_eq!(mapped.status, TaskRunStatus::Success);
        assert_eq!(mapped.trigger, TaskRunTrigger::Scheduled);
        assert_eq!(mapped.started_at.as_deref(), Some("2026-10-05T02:30:00+00:00"));
        assert_eq!(mapped.completed_at.as_deref(), Some("2026-10-05T02:31:00+00:00"));
        assert_eq!(mapped.progress_percent, Some(100.0));
        assert_eq!(mapped.error_code, None);

        let mut interrupted = run.clone();
        interrupted.status = "running".into();
        interrupted.completed_at = None;
        let mapped = backup_run_to_task_run(&interrupted, now).unwrap().unwrap();
        assert_eq!(mapped.status, TaskRunStatus::Failed);
        assert_eq!(mapped.error_code.as_deref(), Some("worker_interrupted"));
        assert_eq!(mapped.error_message.as_deref(), Some("Backup interrupted before migration"));
        assert!(mapped.completed_at.is_some());

        let mut cancelled = run.clone();
        cancelled.status = "cancelled".into();
        cancelled.error = Some("user stopped".into());
        let mapped = backup_run_to_task_run(&cancelled, now).unwrap().unwrap();
        assert_eq!(mapped.status, TaskRunStatus::Cancelled);
        assert_eq!(mapped.error_message.as_deref(), Some("user stopped"));

        let mut manual = run.clone();
        manual.trigger = "manual".into();
        assert_eq!(backup_run_to_task_run(&manual, now).unwrap().unwrap().trigger, TaskRunTrigger::Manual);

        // One-shot runs stay in the preserved legacy history.
        let mut one_shot = run.clone();
        one_shot.schedule_id = None;
        assert!(backup_run_to_task_run(&one_shot, now).unwrap().is_none());

        let mut unknown = run.clone();
        unknown.status = "weird".into();
        assert!(backup_run_to_task_run(&unknown, now).is_err());
    }

    #[test]
    fn config_json_round_trips_through_the_task_shape() {
        let task = backup_schedule_to_task(&schedule("daily", "02:30", 0, "UTC")).unwrap();
        let config = DatabaseBackupTaskConfig::from_json(&task.config).unwrap();
        assert_eq!(config.backup.connection_id, "mysql-1");
        assert_eq!(config.backup.databases, vec!["app".to_owned()]);
        assert!(config.backup.drop_table_if_exists);
        assert_eq!(config.retention_count, 7);
        assert_eq!(config.run_directory_pattern.as_deref(), Some("dbx/{date}"));
        config.validate().unwrap();
    }
}
