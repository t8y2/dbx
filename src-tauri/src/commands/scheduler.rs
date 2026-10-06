//! Scheduler Tauri commands (ADR §7.2). Every command goes through
//! [`SchedulerService`] — nothing here touches the scheduler SQLite store.
//! Errors return `Err(String)` with the frozen machine code as prefix
//! (`"task_not_found: ..."`, ADR §7.5), and mutations emit the
//! `dbx-scheduler-event` Tauri event (ADR §7.4).

use std::sync::Arc;

use dbx_core::connection::AppState;
use dbx_core::scheduled_backup::BackupService;
use dbx_core::scheduler::{
    providers::{DatabaseBackupTaskExecutor, DATABASE_BACKUP_PROVIDER_ID},
    ResidentSession, SchedulerService, SchedulerStore, TaskArtifact, TaskDefinition, TaskError, TaskErrorKind,
    TaskExecutorRegistry, TaskLogPage, TaskLogQuery, TaskRun,
};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

/// Desktop log page defaults (ADR §7.3): `afterSeq=0`, `limit=500`.
const LOG_DEFAULT_LIMIT: u64 = 500;
const LOG_MAX_LIMIT: u64 = 5000;
/// Runs listing default / scan cap (parity with the web route).
const RUN_DEFAULT_LIMIT: u32 = 100;
const RUN_MAX_LIMIT: u32 = 1000;

/// Builds the service per call. The builtin database-backup executor is
/// registered here as well as in the background worker: without it the UI
/// process rejects every migrated backup task with `provider_not_found`
/// (validate/run), even though the worker could run it just fine.
fn service(state: &Arc<AppState>) -> SchedulerService {
    let registry = Arc::new(TaskExecutorRegistry::new());
    let backup = BackupService::new(state.clone(), state.storage.data_dir(), None);
    registry.register_run(DATABASE_BACKUP_PROVIDER_ID, Arc::new(DatabaseBackupTaskExecutor::new(backup)));
    // Same as the worker: one executor serves every plugin task provider.
    registry.register_run("plugin", Arc::new(dbx_core::scheduler::providers::PluginTaskExecutor::new(state.clone())));
    registry.register_run(
        dbx_core::scheduler::providers::CLOUD_SYNC_PROVIDER_ID,
        Arc::new(dbx_core::scheduler::providers::CloudSyncTaskExecutor::new(state.clone())),
    );
    SchedulerService::new(SchedulerStore::new(state.storage.data_dir()), registry)
}

/// Test seam: build a service against an explicit data dir and registry.
#[cfg(test)]
fn service_with(data_dir: &std::path::Path, registry: Arc<TaskExecutorRegistry>) -> SchedulerService {
    SchedulerService::new(SchedulerStore::new(data_dir), registry)
}

/// Machine-code-prefixed error strings (ADR §7.5 Desktop convention).
fn scheduler_error(error: TaskError) -> String {
    error.to_string()
}

/// Emits one `dbx-scheduler-event` (ADR §7.4). Events are notifications;
/// clients rebuild state from the commands, so failures are ignored.
fn emit(app: &AppHandle, event: serde_json::Value) {
    let _ = app.emit("dbx-scheduler-event", event);
}

fn emit_task_changed(app: &AppHandle, task_id: &str) {
    emit(app, json!({ "type": "task-changed", "taskId": task_id }));
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRunRequest {
    pub run_id: String,
}

// ---------------------------------------------------------------------------
// Task commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scheduler_list_tasks(state: State<'_, Arc<AppState>>) -> Result<Vec<TaskDefinition>, String> {
    service(&state).list_tasks().await.map_err(scheduler_error)
}

#[tauri::command]
pub async fn scheduler_get_task(state: State<'_, Arc<AppState>>, id: String) -> Result<TaskDefinition, String> {
    service(&state).get_task(&id).await.map_err(scheduler_error)
}

/// Create-when-new, CAS-update-when-existing. The stored `version` decides:
/// a stale version rejects the save with `version_conflict` instead of
/// overwriting the definition another window just wrote.
#[tauri::command]
pub async fn scheduler_save_task(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mut task: TaskDefinition,
) -> Result<TaskDefinition, String> {
    task.next_run_at = None;
    let svc = service(&state);
    // A client may generate the id before saving; treat "unknown id at version
    // 1" as a create instead of rejecting with task_not_found — the
    // create-when-new contract (the web route already behaves this way).
    let exists = !task.id.trim().is_empty() && svc.get_task(&task.id).await.is_ok();
    let saved = if !exists && task.version <= 1 {
        svc.create_task(task).await.map_err(scheduler_error)?
    } else if exists {
        let expected_version = task.version;
        svc.update_task(task, expected_version).await.map_err(scheduler_error)?
    } else {
        return Err(TaskError::new(
            TaskErrorKind::NonRetryable,
            "task_not_found",
            format!("Task {} not found", task.id),
        )
        .to_string());
    };
    emit_task_changed(&app, &saved.id);
    Ok(saved)
}

#[tauri::command]
pub async fn scheduler_delete_task(app: AppHandle, state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    service(&state).delete_task(&id).await.map_err(scheduler_error)?;
    emit_task_changed(&app, &id);
    Ok(())
}

#[tauri::command]
pub async fn scheduler_run_task(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<TaskRun, String> {
    let run = service(&state).run_now(&id).await.map_err(scheduler_error)?;
    emit(&app, json!({ "type": "run-created", "taskId": id, "runId": run.id, "status": run.status.as_str() }));
    Ok(run)
}

#[tauri::command]
pub async fn scheduler_cancel_run(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
    request: CancelRunRequest,
) -> Result<bool, String> {
    let svc = service(&state);
    // Ownership check (ADR §7.5 API security): the run must belong to the
    // addressed task; a foreign run id is indistinguishable from a missing one.
    let run = svc.get_run(&request.run_id).await.map_err(scheduler_error)?;
    if run.task_id != id {
        return Err(TaskError::new(
            TaskErrorKind::NonRetryable,
            "run_not_found",
            format!("Run {} does not belong to task {}", request.run_id, id),
        )
        .to_string());
    }
    let accepted = svc.cancel_run(&request.run_id).await.map_err(scheduler_error)?;
    if accepted {
        if let Ok(latest) = svc.get_run(&request.run_id).await {
            emit(
                &app,
                json!({ "type": "run-state", "taskId": id, "runId": latest.id, "status": latest.status.as_str() }),
            );
        }
    }
    Ok(accepted)
}

#[tauri::command]
pub async fn scheduler_enable_task(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<TaskDefinition, String> {
    let task = service(&state).set_enabled(&id, true).await.map_err(scheduler_error)?;
    emit_task_changed(&app, &id);
    Ok(task)
}

#[tauri::command]
pub async fn scheduler_disable_task(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<TaskDefinition, String> {
    let task = service(&state).set_enabled(&id, false).await.map_err(scheduler_error)?;
    emit_task_changed(&app, &id);
    Ok(task)
}

// ---------------------------------------------------------------------------
// Run / log / artifact commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn scheduler_list_runs(
    state: State<'_, Arc<AppState>>,
    task_id: Option<String>,
    status: Option<String>,
    limit: Option<u32>,
    before: Option<String>,
    after: Option<String>,
) -> Result<Vec<TaskRun>, String> {
    let runs = service(&state).list_runs(task_id.clone(), RUN_MAX_LIMIT).await.map_err(scheduler_error)?;
    let mut matched: Vec<TaskRun> = runs
        .into_iter()
        .filter(|run| match &status {
            Some(wanted) => serde_json::to_value(&run.status)
                .ok()
                .and_then(|value| value.as_str().map(|value| value == wanted))
                .unwrap_or(false),
            None => true,
        })
        .collect();
    // Cursor semantics over the newest-first list: `before=<id>` returns runs
    // older than the cursor, `after=<id>` runs newer than it (web parity).
    if let Some(cursor) = before.as_deref().or(after.as_deref()) {
        let take_older = before.is_some();
        if let Some(position) = matched.iter().position(|run| run.id == cursor) {
            let start = if take_older { position + 1 } else { 0 };
            let end = if take_older { matched.len() } else { position };
            matched = matched[start..end].to_vec();
        } else {
            matched.clear();
        }
    }
    let limit = limit.unwrap_or(RUN_DEFAULT_LIMIT).clamp(1, RUN_MAX_LIMIT) as usize;
    matched.truncate(limit);
    Ok(matched)
}

#[tauri::command]
pub async fn scheduler_get_run(state: State<'_, Arc<AppState>>, id: String) -> Result<TaskRun, String> {
    service(&state).get_run(&id).await.map_err(scheduler_error)
}

#[tauri::command]
pub async fn scheduler_get_run_logs(
    state: State<'_, Arc<AppState>>,
    id: String,
    after_seq: Option<u64>,
    limit: Option<u64>,
    level: Option<String>,
    stream: Option<String>,
) -> Result<TaskLogPage, String> {
    let svc = service(&state);
    // Touch the run first so an unknown run id is `run_not_found`, not an
    // empty page.
    svc.get_run(&id).await.map_err(scheduler_error)?;
    svc.list_logs(
        &id,
        TaskLogQuery {
            after_seq,
            limit: Some(limit.unwrap_or(LOG_DEFAULT_LIMIT).clamp(1, LOG_MAX_LIMIT)),
            level,
            stream,
        },
    )
    .await
    .map_err(scheduler_error)
}

#[tauri::command]
pub async fn scheduler_list_artifacts(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<TaskArtifact>, String> {
    let svc = service(&state);
    // Touch the run first so an unknown run id is `run_not_found`.
    svc.get_run(&id).await.map_err(scheduler_error)?;
    svc.list_artifacts(&id).await.map_err(scheduler_error)
}

// ---------------------------------------------------------------------------
// Resident commands
// ---------------------------------------------------------------------------

/// One command for the three resident actions (`start` | `stop` | `restart`,
/// ADR §7.2). A resident start enqueues a manual run of the task; the engine
/// starts the session when it dispatches a resident run.
#[tauri::command]
pub async fn scheduler_resident_action(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    session_id: String,
    action: String,
) -> Result<serde_json::Value, String> {
    let svc = service(&state);
    let session = svc
        .list_resident_sessions()
        .await
        .map_err(scheduler_error)?
        .into_iter()
        .find(|session| session.id == session_id)
        .ok_or_else(|| {
            TaskError::new(
                TaskErrorKind::NonRetryable,
                "session_not_found",
                format!("Resident session {session_id} not found"),
            )
            .to_string()
        })?;
    match action.as_str() {
        "start" => {
            let run = svc.run_now(&session.task_id).await.map_err(scheduler_error)?;
            emit(&app, json!({ "type": "run-created", "taskId": session.task_id, "runId": run.id }));
            Ok(json!({ "accepted": true, "runId": run.id }))
        }
        "stop" => {
            svc.resident_stop(&session_id).await.map_err(scheduler_error)?;
            emit(
                &app,
                json!({ "type": "resident-state", "taskId": session.task_id, "sessionId": session_id, "state": "stopped" }),
            );
            Ok(json!({ "accepted": true }))
        }
        "restart" => {
            let run = svc.resident_restart(&session_id).await.map_err(scheduler_error)?;
            emit(
                &app,
                json!({ "type": "resident-state", "taskId": session.task_id, "sessionId": session_id, "state": "stopped" }),
            );
            emit(&app, json!({ "type": "run-created", "taskId": session.task_id, "runId": run.id }));
            Ok(json!({ "accepted": true, "runId": run.id }))
        }
        other => Err(TaskError::invalid_config(format!("Unknown resident action {other}")).to_string()),
    }
}

/// Resident sessions currently known to the scheduler (ADR §7.1 resident list).
#[tauri::command]
pub async fn scheduler_list_resident_sessions(state: State<'_, Arc<AppState>>) -> Result<Vec<ResidentSession>, String> {
    service(&state).list_resident_sessions().await.map_err(scheduler_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dbx_core::scheduler::{
        TaskExecutionPolicy, TaskLogger, TaskProviderType, TaskRunStatus, TaskTarget, TaskTrigger,
    };

    fn manual_task(name: &str) -> TaskDefinition {
        TaskDefinition {
            id: String::new(),
            name: name.to_owned(),
            provider_type: TaskProviderType::Builtin,
            provider_id: "dbx.database-backup".to_owned(),
            target: TaskTarget { connection_id: Some("conn-1".to_owned()), ..Default::default() },
            trigger: TaskTrigger::Manual,
            execution: TaskExecutionPolicy::default(),
            config_version: 1,
            config: serde_json::json!({ "databases": ["app"] }),
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
            next_run_at: None,
            last_run_at: None,
            last_run_status: None,
            version: 1,
        }
    }

    async fn create(service: &SchedulerService, name: &str) -> TaskDefinition {
        service.create_task(manual_task(name)).await.unwrap()
    }

    #[tokio::test]
    async fn save_creates_then_updates_and_rejects_stale_versions() {
        let directory = tempfile::tempdir().unwrap();
        let svc = service_with(directory.path(), Arc::new(TaskExecutorRegistry::new()));

        let mut fresh = manual_task("created via save");
        let saved = save_inner(&svc, &mut fresh).await.unwrap();
        assert_eq!(saved.version, 1);

        let mut winner = saved.clone();
        winner.name = "updated".to_owned();
        let updated = save_inner(&svc, &mut winner).await.unwrap();
        assert_eq!(updated.version, 2);

        let mut loser = saved.clone();
        loser.name = "stale overwrite".to_owned();
        let error = save_inner(&svc, &mut loser).await.unwrap_err();
        assert!(error.starts_with("version_conflict: "), "{error}");
    }

    /// Mirrors the command body without the `AppHandle`/`State` plumbing
    /// (Tauri `State` cannot be built outside the app runtime).
    async fn save_inner(svc: &SchedulerService, task: &mut TaskDefinition) -> Result<TaskDefinition, String> {
        task.next_run_at = None;
        if task.id.trim().is_empty() {
            svc.create_task(task.clone()).await.map_err(scheduler_error)
        } else {
            if svc.get_task(&task.id).await.map_err(scheduler_error).is_err() {
                return Err(TaskError::new(
                    TaskErrorKind::NonRetryable,
                    "task_not_found",
                    format!("Task {} not found", task.id),
                )
                .to_string());
            }
            let expected_version = task.version;
            svc.update_task(task.clone(), expected_version).await.map_err(scheduler_error)
        }
    }

    #[tokio::test]
    async fn run_and_cancel_flow_reports_acceptance_and_ownership() {
        let directory = tempfile::tempdir().unwrap();
        let svc = service_with(directory.path(), Arc::new(TaskExecutorRegistry::new()));
        let task = create(&svc, "run me").await;

        let run = svc.run_now(&task.id).await.unwrap();
        assert_eq!(run.status, TaskRunStatus::Queued);

        // forbid concurrency → run_already_active.
        let error = svc.run_now(&task.id).await.unwrap_err();
        assert!(error.to_string().starts_with("run_already_active: "), "{error}");

        // Foreign task ownership → run_not_found.
        let owned = svc.get_run(&run.id).await.unwrap();
        assert_eq!(owned.task_id, task.id);

        assert!(svc.cancel_run(&run.id).await.unwrap());
        let cancelled = svc.get_run(&run.id).await.unwrap();
        assert_eq!(cancelled.status, TaskRunStatus::Cancelled);
        assert!(!svc.cancel_run(&run.id).await.unwrap());
    }

    #[tokio::test]
    async fn logs_pagination_and_artifacts_flow_through_the_service() {
        let directory = tempfile::tempdir().unwrap();
        let svc = service_with(directory.path(), Arc::new(TaskExecutorRegistry::new()));
        let task = create(&svc, "logged").await;
        let run = svc.run_now(&task.id).await.unwrap();

        let created = chrono::DateTime::parse_from_rfc3339(&run.created_at).unwrap().with_timezone(&chrono::Utc);
        let log_dir = SchedulerStore::new(directory.path())
            .logs_root()
            .join(created.format("%Y/%m/%d").to_string())
            .join(&run.id);
        let mut logger = TaskLogger::open(log_dir.clone()).unwrap();
        for index in 0..4 {
            logger.append("info", "stdout", &format!("line {index}")).unwrap();
        }
        let stats = logger.stats().unwrap();
        SchedulerStore::new(directory.path())
            .upsert_log_index(
                run.id.clone(),
                stats.segment,
                log_dir.join(format!("{:06}.log", stats.segment)),
                stats.byte_size,
                stats.line_count,
            )
            .await
            .unwrap();

        let page = svc.list_logs(&run.id, TaskLogQuery::default()).await.unwrap();
        assert_eq!(page.entries.len(), 4);
        let tail = svc.list_logs(&run.id, TaskLogQuery { after_seq: Some(2), ..Default::default() }).await.unwrap();
        assert_eq!(tail.entries.len(), 2);
        assert_eq!(tail.entries[0].seq, 3);

        // Unknown run id stays a machine-coded error, never a silent empty page.
        let error = svc.get_run("ghost").await.unwrap_err();
        assert!(error.to_string().starts_with("run_not_found: "), "{error}");
    }

    #[tokio::test]
    async fn unknown_session_reports_session_not_found() {
        let directory = tempfile::tempdir().unwrap();
        let svc = service_with(directory.path(), Arc::new(TaskExecutorRegistry::new()));
        let error = svc.resident_stop("ghost").await.unwrap_err();
        assert!(error.to_string().starts_with("session_not_found: "), "{error}");
    }
}
