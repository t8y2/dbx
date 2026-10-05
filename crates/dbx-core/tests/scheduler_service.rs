//! Resident supervision and SchedulerService tests: bounded restart policy,
//! crash recovery, degraded state, resident stop/restart through the service,
//! and CAS validation paths.

mod common;

use std::sync::Arc;

use chrono::Utc;
use common::*;
use dbx_core::scheduler::{
    ResidentState, SchedulerService, TaskExecutionMode, TaskRestartPolicy, TaskRunStatus, TaskRunTrigger, TaskTrigger,
};

fn resident_task(id: &str, max_restarts: u32) -> dbx_core::scheduler::TaskDefinition {
    let mut task = run_definition(id, "dbx.test", TaskTrigger::Manual);
    task.execution.mode = TaskExecutionMode::Resident;
    task.execution.restart =
        Some(TaskRestartPolicy { enabled: true, max_restarts, backoff_seconds: 0, restart_window_seconds: None });
    task
}

#[tokio::test]
async fn resident_crash_restarts_are_bounded_and_end_degraded() {
    let (_dir, store) = temp_store();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    let resident = TestResidentExecutor::new();
    registry.register_resident("dbx.test", Arc::new(resident.clone()));
    let engine = engine(&store, registry, "worker-1");

    save(&store, resident_task("t1", 1)).await;
    let _first_run = store.enqueue_manual("t1".into()).await.unwrap();

    // Start the session.
    drive_until(&engine, || async { store.list_sessions().await.map(|s| !s.is_empty()).unwrap_or(false) }).await;
    assert_eq!(resident.starts().len(), 1);
    let session_id = resident.last_session_id();

    // First crash: restart policy allows one restart.
    resident.set_state(&session_id, ResidentState::Crashed);
    drive_until(&engine, || async {
        store.list_runs(Some("t1".into()), 10).await.map(|runs| runs.len() >= 2).unwrap_or(false)
    })
    .await;
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    assert_eq!(runs.len(), 2, "restart creates a new run");
    assert!(runs.iter().any(|r| r.error_code.as_deref() == Some("worker_interrupted")));
    assert!(runs.iter().any(|r| r.trigger == TaskRunTrigger::Restart));

    // The restart reuses the session row (restart_count preserved) and starts
    // a new plugin session.
    drive_until(&engine, || async {
        store
            .list_sessions()
            .await
            .map(|s| s.iter().any(|s| s.restart_count == 1 && s.state == ResidentState::Running))
            .unwrap_or(false)
    })
    .await;
    assert_eq!(resident.starts().len(), 2, "session restarted once");

    // Second crash: restart budget (max_restarts = 1) exhausted → degraded.
    // The restart started a NEW plugin session (sess-2); crash that one.
    let session_id = resident.last_session_id();
    resident.set_state(&session_id, ResidentState::Crashed);
    drive_until(&engine, || async {
        store.list_sessions().await.map(|s| s.iter().any(|s| s.state == ResidentState::Degraded)).unwrap_or(false)
    })
    .await;
    assert_eq!(resident.starts().len(), 2, "no restart beyond the budget — no crash loop");
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    assert!(runs.iter().any(|r| r.error_code.as_deref() == Some("restart_limit_reached")));
    assert!(runs.iter().all(|r| r.status.is_terminal()));
}

#[tokio::test]
async fn resident_recovery_after_worker_restart_reconciles() {
    let (_dir, store) = temp_store();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    let resident = TestResidentExecutor::new();
    registry.register_resident("dbx.test", Arc::new(resident.clone()));

    save(&store, resident_task("t1", 0)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    store.claim("worker-1".into(), Utc::now()).await.unwrap();
    store.mark_run_started(run.id.clone(), "worker-1".into()).await.unwrap();
    let now = Utc::now().to_rfc3339();
    store
        .upsert_session(dbx_core::scheduler::ResidentSession {
            id: "session-1".into(),
            task_id: "t1".into(),
            run_id: run.id.clone(),
            plugin_id: "dbx.test".into(),
            session_id: "sess-1".into(),
            state: ResidentState::Running,
            heartbeat_at: Some(now.clone()),
            restart_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
        .await
        .unwrap();

    // New engine start: recovery marks the session crashed (store behavior),
    // then supervision reconciles: restart disabled → degraded.
    let report = store.recover().await.unwrap();
    assert_eq!(report.crashed_sessions.len(), 1);

    let engine = engine(&store, registry, "worker-2");
    drive_until(&engine, || async {
        store.list_sessions().await.map(|s| s.iter().any(|s| s.state == ResidentState::Degraded)).unwrap_or(false)
    })
    .await;
    assert_eq!(resident.starts().len(), 0, "restart disabled → no new session");
    let finished = store.get_run(run.id).await.unwrap();
    assert_eq!(finished.status, TaskRunStatus::Failed);
    assert_eq!(finished.error_code.as_deref(), Some("restart_limit_reached"));
}

#[tokio::test]
async fn service_resident_stop_and_restart() {
    let (_dir, store) = temp_store();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    let resident = TestResidentExecutor::new();
    registry.register_resident("dbx.test", Arc::new(resident.clone()));
    let engine = engine(&store, registry.clone(), "worker-1");
    let service = SchedulerService::new(store.clone(), registry);

    save(&store, resident_task("t1", 5)).await;
    let run = service.run_now("t1").await.unwrap();
    drive_until(&engine, || async { store.list_sessions().await.map(|s| !s.is_empty()).unwrap_or(false) }).await;
    let sessions = store.list_sessions().await.unwrap();
    assert_eq!(sessions.len(), 1);
    let session_id = sessions[0].id.clone();

    // Manual stop: executor.stop called, session stopped, run cancelled.
    service.resident_stop(&session_id).await.unwrap();
    assert_eq!(resident.stops(), vec![sessions[0].session_id.clone()]);
    let sessions = store.list_sessions().await.unwrap();
    assert_eq!(sessions[0].state, ResidentState::Stopped);
    let stopped_run = store.get_run(run.id).await.unwrap();
    assert_eq!(stopped_run.status, TaskRunStatus::Cancelled);

    // Manual restart: schedules a restart run (fresh plugin session).
    let restart = service.resident_restart(&session_id).await.unwrap();
    assert_eq!(restart.trigger, TaskRunTrigger::Restart);
    // The restart's session must come up before it can be stopped again.
    drive_until(&engine, || async {
        store
            .list_sessions()
            .await
            .map(|s| s.iter().any(|s| s.run_id == restart.id && s.state == ResidentState::Running))
            .unwrap_or(false)
    })
    .await;
    // Session reports stopped → the restart run succeeds.
    resident.set_state(&resident.last_session_id(), ResidentState::Stopped);
    let finished = drive_until_terminal(&engine, &store, &restart.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);
    assert!(store
        .list_sessions()
        .await
        .unwrap()
        .iter()
        .any(|s| s.run_id == restart.id && s.state == ResidentState::Stopped));

    // Unknown session → machine-readable error.
    let error = service.resident_stop("nope").await.unwrap_err();
    assert_eq!(error.code, "session_not_found");
}

#[tokio::test]
async fn service_crud_and_validation_paths() {
    let (_dir, store) = temp_store();
    let registry = registry_with(TestExecutor::new(Behavior::Succeed));
    let service = SchedulerService::new(store.clone(), registry);

    // Create fills in the id and validates config.
    let mut task = run_definition("", "dbx.test", TaskTrigger::Manual);
    let created = service.create_task(task.clone()).await.unwrap();
    assert!(!created.id.is_empty(), "missing id generated");
    assert_eq!(created.version, 1);

    // CAS conflict on update.
    task.id = created.id.clone();
    task.name = "v2".into();
    let error = service.update_task(task.clone(), 42).await.unwrap_err();
    assert_eq!(error.code, "version_conflict");
    let updated = service.update_task(task, 1).await.unwrap();
    assert_eq!(updated.version, 2);

    // Enable/disable.
    let disabled = service.set_enabled(&created.id, false).await.unwrap();
    assert!(!disabled.enabled);
    let enabled = service.set_enabled(&created.id, true).await.unwrap();
    assert!(enabled.enabled);

    // Provider validation: unknown provider fails with provider_not_found.
    let mut unknown = run_definition("t-unknown", "dbx.nope", TaskTrigger::Manual);
    let error = service.validate_task(&unknown).await.unwrap_err();
    assert_eq!(error.code, "provider_not_found");
    assert!(service.validate_task(&created).await.is_ok());

    // Manual run + audit trail.
    let run = service.run_now(&created.id).await.unwrap();
    assert_eq!(run.trigger, TaskRunTrigger::Manual);
    assert!(service.cancel_run(&run.id).await.unwrap());
    let audit = service.list_audit(Some(created.id.clone()), 10).await.unwrap();
    let actions: Vec<String> = audit.iter().map(|entry| format!("{:?}", entry.action)).collect();
    assert!(actions.iter().any(|a| a.contains("Create")));
    assert!(actions.iter().any(|a| a.contains("Run")));
    assert!(actions.iter().any(|a| a.contains("Cancel")));

    // Delete without active runs.
    service.delete_task(&created.id).await.unwrap();
    let error = service.get_task(&created.id).await.unwrap_err();
    assert_eq!(error.code, "task_not_found");
}

#[tokio::test]
async fn resident_start_timeout_is_enforced_through_the_token() {
    let (_dir, store) = temp_store();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    let resident = TestResidentExecutor::new();
    resident.set_hang_start(true);
    registry.register_resident("dbx.test", Arc::new(resident.clone()));
    let engine = engine(&store, registry, "worker-1");

    let mut task = resident_task("t1", 3);
    task.execution.timeout_seconds = Some(1);
    save(&store, task).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();

    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Timeout]).await;
    assert_eq!(finished.status, TaskRunStatus::Timeout);
    assert_eq!(resident.starts().len(), 0, "start never completed");
    assert!(store.list_sessions().await.unwrap().is_empty());
}
