//! Integration tests for the database backup builtin provider and the legacy
//! migration (ADR §8, plan §41–45): field mapping, run history migration,
//! idempotency, rollback / partial-recovery, and the scheduler-driven backup
//! execution chain. The existing legacy `scheduled_backup` unit tests remain
//! the regression suite for export / retention / cancel behavior itself.

use std::{path::Path, sync::Arc, time::Duration};

use dbx_core::connection::AppState;
use dbx_core::scheduled_backup::{BackupRun, BackupSchedule, BackupService, Migration, RunRequest};
use dbx_core::scheduler::migration::{LegacyBackupMigrationReport, DATABASE_BACKUP_MIGRATION_KEY};
use dbx_core::scheduler::{
    providers::DatabaseBackupTaskExecutor, SchedulerEngine, SchedulerMigration, SchedulerStore, TaskDefinition,
    TaskExecutor, TaskExecutorRegistry, TaskProviderType, TaskRunStatus, TaskRunTrigger, TaskTarget, TaskTrigger,
};
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn legacy_schedule(id: &str, name: &str, dir: &Path, frequency: &str) -> BackupSchedule {
    serde_json::from_value(json!({
        "id": id, "name": name, "enabled": true, "connectionId": "mysql-1", "databases": ["app"],
        "tableFilterMode": "all", "tablePatterns": [], "destinationDirectory": dir.join("backups"),
        "includeStructure": true, "includeData": true, "includeObjects": true,
        "outputCompression": "gzip", "runDirectoryPattern": "dbx/{date}",
        "frequency": frequency, "intervalHours": 4, "timeOfDay": "02:30", "weekday": 1,
        "retentionCount": 3, "timeZone": "Asia/Shanghai",
        "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-02T00:00:00+00:00",
        "nextRunAt": "2026-10-06T02:30:00+00:00", "lastRunAt": "2026-10-05T02:30:00+00:00",
        "lastRunStatus": "success"
    }))
    .unwrap()
}

fn legacy_run(id: &str, schedule_id: Option<&str>, status: &str, started_at: &str) -> BackupRun {
    BackupRun {
        id: id.to_owned(),
        schedule_id: schedule_id.map(str::to_owned),
        schedule_name: "Nightly".into(),
        display_name: None,
        connection_id: "mysql-1".into(),
        connection_name: "Main".into(),
        destination_directory: "/tmp/backups".into(),
        trigger: "scheduled".into(),
        source: "scheduled".into(),
        status: status.to_owned(),
        started_at: started_at.to_owned(),
        completed_at: (status != "running").then(|| started_at.to_owned()),
        files: Vec::new(),
        progress_percent: if status == "success" { 100.0 } else { 40.0 },
        error: (status == "failed").then(|| "boom".to_owned()),
    }
}

/// App state + service + scheduler store sharing one data directory, like a
/// real host. The app state is returned so tests can seed connections through
/// the same public surface the host uses.
async fn world(dir: &Path) -> (Arc<AppState>, BackupService, SchedulerStore) {
    let storage = dbx_core::persistence::test_storage::open(&dir.join("dbx.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let service = BackupService::new(state.clone(), dir, None);
    (state, service, SchedulerStore::new(dir))
}

fn unreachable_mysql(id: &str, save_password: bool) -> dbx_core::models::connection::ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": id, "db_type": "mysql", "save_password": save_password,
        "host": "127.0.0.1", "port": 1, "username": "u", "password": "p",
        "database": null, "connect_timeout_secs": 1, "query_timeout_secs": 5
    }))
    .unwrap()
}

// ---------------------------------------------------------------------------
// Migration: schedule conversion, run history, idempotency, rollback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_converts_schedules_preserves_ids_and_keeps_legacy_data() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, service, store) = world(dir.path()).await;
    let daily = legacy_schedule("sched-daily", "Nightly", dir.path(), "daily");
    let hourly = legacy_schedule("sched-hourly", "Every few hours", dir.path(), "hourly");
    service.store.save_schedule(daily).await.unwrap();
    service.store.save_schedule(hourly).await.unwrap();
    // Terminal history + a one-shot run, injected through the legacy
    // migration API (the only public writer of arbitrary terminal runs).
    service
        .store
        .migrate(Migration {
            schedules: vec![],
            runs: vec![
                legacy_run("run-success", Some("sched-daily"), "success", "2026-10-01T02:30:00+00:00"),
                legacy_run("run-failed", Some("sched-daily"), "failed", "2026-10-02T02:30:00+00:00"),
                legacy_run("run-oneshot", None, "success", "2026-10-03T02:30:00+00:00"),
            ],
        })
        .await
        .unwrap();

    let report = SchedulerMigration::new(store.clone()).migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(report, LegacyBackupMigrationReport { schedules: 2, runs: 2 });

    let tasks = store.list_tasks().await.unwrap();
    assert_eq!(tasks.len(), 2);
    let task = tasks.iter().find(|task| task.id == "sched-daily").unwrap();
    assert_eq!(task.name, "Nightly");
    assert_eq!(task.provider_type, TaskProviderType::Builtin);
    assert_eq!(task.provider_id, "dbx.database-backup");
    assert_eq!(task.target.connection_id.as_deref(), Some("mysql-1"));
    assert_eq!(task.trigger, TaskTrigger::Cron { expression: "30 2 * * *".into(), time_zone: "Asia/Shanghai".into() });
    assert_eq!(task.config["retentionCount"], 3);
    assert_eq!(task.config["runDirectoryPattern"], "dbx/{date}");
    assert_eq!(task.config["outputCompression"], "gzip");
    assert_eq!(task.config_version, 1);
    // The legacy next fire time is kept verbatim so migration never causes an
    // immediate double fire, and the last-run bookkeeping mirrors the legacy
    // row (the pure-function mapping of concrete statuses is pinned by the
    // provider unit tests).
    let legacy_daily =
        service.store.snapshot().await.unwrap().schedules.into_iter().find(|s| s.id == "sched-daily").unwrap();
    assert_eq!(task.next_run_at.as_deref(), Some(legacy_daily.next_run_at.as_str()));
    assert_eq!(task.last_run_at, legacy_daily.last_run_at);
    assert_eq!(task.last_run_status.map(|status| status.as_str()), legacy_daily.last_run_status.as_deref());
    assert!(task.enabled);
    task.validate().expect("migrated task passes frozen domain validation");

    let hourly = tasks.iter().find(|task| task.id == "sched-hourly").unwrap();
    assert_eq!(hourly.trigger, TaskTrigger::Interval { seconds: 4 * 60 * 60 });

    // Run history: old run ids preserved, one-shot run not migrated (FK).
    let runs = store.list_runs(Some("sched-daily".into()), 100).await.unwrap();
    assert_eq!(runs.len(), 2);
    let success = runs.iter().find(|run| run.id == "run-success").unwrap();
    assert_eq!(success.status, TaskRunStatus::Success);
    assert_eq!(success.trigger, TaskRunTrigger::Scheduled);
    assert_eq!(success.started_at.as_deref(), Some("2026-10-01T02:30:00+00:00"));
    assert_eq!(success.progress_percent, Some(100.0));
    let failed = runs.iter().find(|run| run.id == "run-failed").unwrap();
    assert_eq!(failed.status, TaskRunStatus::Failed);
    assert_eq!(failed.error_message.as_deref(), Some("boom"));

    // Legacy data survives untouched (rollback / audit basis, old UI keeps
    // working), including the one-shot run.
    let legacy = service.store.snapshot().await.unwrap();
    assert_eq!(legacy.schedules.len(), 2);
    assert_eq!(legacy.runs.len(), 3);
    assert!(legacy.runs.iter().any(|run| run.id == "run-oneshot"));
}

#[tokio::test]
async fn interrupted_legacy_runs_migrate_as_failed_worker_interrupted() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, service, store) = world(dir.path()).await;
    service.store.save_schedule(legacy_schedule("sched-1", "Nightly", dir.path(), "daily")).await.unwrap();
    // A queued legacy job carries payload status "running" until claimed —
    // it migrates exactly like an interrupted run (BackupStore::migrate rule).
    let queued = service
        .store
        .enqueue(RunRequest { schedule_id: Some("sched-1".into()), config: None, display_name: None, time_zone: None })
        .await
        .unwrap();
    // A cancelled run keeps its status (seeded through the legacy migration
    // API because the store only allows one pending run per schedule).
    service
        .store
        .migrate(Migration {
            schedules: vec![],
            runs: vec![legacy_run("run-cancelled", Some("sched-1"), "cancelled", "2026-10-04T02:30:00+00:00")],
        })
        .await
        .unwrap();

    SchedulerMigration::new(store.clone()).migrate_legacy_database_backups(&service.store).await.unwrap();

    let queued = store.get_run(queued.id).await.unwrap();
    assert_eq!(queued.status, TaskRunStatus::Failed);
    assert_eq!(queued.error_code.as_deref(), Some("worker_interrupted"));
    assert!(queued.completed_at.is_some());
    let cancelled = store.get_run("run-cancelled".into()).await.unwrap();
    assert_eq!(cancelled.status, TaskRunStatus::Cancelled);
    assert!(cancelled.completed_at.is_some());
}

#[tokio::test]
async fn duplicate_migration_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, service, store) = world(dir.path()).await;
    service.store.save_schedule(legacy_schedule("sched-1", "Nightly", dir.path(), "daily")).await.unwrap();
    let migration = SchedulerMigration::new(store.clone());
    let first = migration.migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(first.schedules, 1);
    assert!(migration.is_applied(DATABASE_BACKUP_MIGRATION_KEY).await.unwrap());

    let second = migration.migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(second, LegacyBackupMigrationReport::default(), "marker short-circuits");
    assert_eq!(store.list_tasks().await.unwrap().len(), 1);
    assert_eq!(store.list_runs(Some("sched-1".into()), 100).await.unwrap().len(), 0);
}

#[tokio::test]
async fn invalid_legacy_data_rolls_back_and_next_attempt_recovers() {
    let dir = tempfile::tempdir().unwrap();
    let legacy_dir = dir.path().join("database-backups");
    std::fs::create_dir_all(&legacy_dir).unwrap();
    // Hand-written legacy store: one valid schedule plus one corrupt one, so
    // the transform fails partway through the transaction.
    let valid = serde_json::to_string(&legacy_schedule("sched-good", "Good", dir.path(), "daily")).unwrap();
    let mut corrupt = serde_json::to_value(legacy_schedule("sched-bad", "Bad", dir.path(), "daily")).unwrap();
    corrupt["timeZone"] = json!("Not/AZone");
    let conn = rusqlite::Connection::open(legacy_dir.join("state.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE schedules(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
         CREATE TABLE runs(id TEXT PRIMARY KEY,schedule_id TEXT,state TEXT NOT NULL,payload TEXT NOT NULL,job TEXT,created_at TEXT NOT NULL,cancel INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )
    .unwrap();
    for (id, payload) in [("sched-good", valid), ("sched-bad", corrupt.to_string())] {
        conn.execute("INSERT INTO schedules(id,payload) VALUES(?,?)", rusqlite::params![id, payload]).unwrap();
    }
    drop(conn);

    let (_state, service, store) = world(dir.path()).await;
    let migration = SchedulerMigration::new(store.clone());
    let error = migration.migrate_legacy_database_backups(&service.store).await.unwrap_err();
    assert_eq!(error.code, "invalid_config");
    // Nothing leaked: no marker, no rows.
    assert!(!migration.is_applied(DATABASE_BACKUP_MIGRATION_KEY).await.unwrap());
    assert!(store.list_tasks().await.unwrap().is_empty());
    // Legacy data untouched.
    assert_eq!(service.store.snapshot().await.unwrap().schedules.len(), 2);

    // Restart-safe: repair the corrupt row and the very next attempt commits
    // the whole migration.
    let conn = rusqlite::Connection::open(legacy_dir.join("state.db")).unwrap();
    conn.execute(
        "UPDATE schedules SET payload=? WHERE id='sched-bad'",
        [&serde_json::to_string(&legacy_schedule("sched-bad", "Bad", dir.path(), "daily")).unwrap()],
    )
    .unwrap();
    drop(conn);
    let report = migration.migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(report, LegacyBackupMigrationReport { schedules: 2, runs: 0 });
    assert_eq!(store.list_tasks().await.unwrap().len(), 2);
}

#[tokio::test]
async fn existing_task_definitions_are_not_overwritten_by_migration() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, service, store) = world(dir.path()).await;
    service.store.save_schedule(legacy_schedule("sched-1", "Nightly", dir.path(), "daily")).await.unwrap();
    // A definition with the legacy id already exists (created by hand between
    // two partial attempts): INSERT OR IGNORE must keep it.
    let existing = TaskDefinition {
        id: "sched-1".into(),
        name: "Hand-made".into(),
        provider_type: TaskProviderType::Builtin,
        provider_id: "dbx.database-backup".into(),
        target: TaskTarget::default(),
        trigger: TaskTrigger::Manual,
        execution: Default::default(),
        config_version: 1,
        config: json!({}),
        enabled: false,
        created_at: String::new(),
        updated_at: String::new(),
        next_run_at: None,
        last_run_at: None,
        last_run_status: None,
        version: 1,
    };
    store.save_task(existing, None).await.unwrap();

    let report = SchedulerMigration::new(store.clone()).migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(report.schedules, 1, "the protocol still counts the attempt");
    let task = store.get_task("sched-1".into()).await.unwrap();
    assert_eq!(task.name, "Hand-made", "existing definition wins");
    assert!(!task.enabled);
}

#[tokio::test]
async fn missing_legacy_store_migrates_nothing_but_marks_applied() {
    let dir = tempfile::tempdir().unwrap();
    let (_state, service, store) = world(dir.path()).await;
    // BackupStore::new only computes the path; no state.db exists yet.
    assert!(!dir.path().join("database-backups").join("state.db").exists());
    let migration = SchedulerMigration::new(store.clone());
    let report = migration.migrate_legacy_database_backups(&service.store).await.unwrap();
    assert_eq!(report, LegacyBackupMigrationReport::default());
    assert!(migration.is_applied(DATABASE_BACKUP_MIGRATION_KEY).await.unwrap());
    assert!(store.list_tasks().await.unwrap().is_empty());
}

// ---------------------------------------------------------------------------
// Executor: validation and the scheduler-driven execution chain
// ---------------------------------------------------------------------------

fn backup_task(id: &str, config: Value) -> TaskDefinition {
    TaskDefinition {
        id: id.to_owned(),
        name: "Nightly backup".into(),
        provider_type: TaskProviderType::Builtin,
        provider_id: "dbx.database-backup".into(),
        target: TaskTarget { connection_id: Some("mysql-1".into()), plugin_id: None, resource_id: None },
        trigger: TaskTrigger::Manual,
        execution: Default::default(),
        config_version: 1,
        config,
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
        next_run_at: None,
        last_run_at: None,
        last_run_status: None,
        version: 1,
    }
}

fn task_config(dir: &Path) -> Value {
    json!({
        "connectionId": "mysql-1", "databases": ["app"], "destinationDirectory": dir.join("backups"),
        "includeStructure": true, "includeData": true, "includeObjects": false,
        "tableFilterMode": "all", "retentionCount": 2
    })
}

async fn executor_world(dir: &Path) -> (Arc<AppState>, BackupService, SchedulerStore, Arc<TaskExecutorRegistry>) {
    let (state, service, store) = world(dir).await;
    std::fs::create_dir_all(dir.join("backups")).unwrap();
    // Unreachable MySQL endpoint: the export chain fails fast after the real
    // connection checks, which is all the offline regression needs.
    state.storage.save_connections(std::slice::from_ref(&unreachable_mysql("mysql-1", true))).await.unwrap();
    let registry = Arc::new(TaskExecutorRegistry::new());
    registry.register_run("dbx.database-backup", Arc::new(DatabaseBackupTaskExecutor::new(service.clone())));
    (state, service, store, registry)
}

#[tokio::test]
async fn executor_validation_rejects_missing_connection_and_invalid_config() {
    let dir = tempfile::tempdir().unwrap();
    let (state, service, _store, _registry) = executor_world(dir.path()).await;
    let executor = DatabaseBackupTaskExecutor::new(service.clone());

    // Missing connection → non-retryable connection_missing.
    let mut task = backup_task("t1", task_config(dir.path()));
    task.config["connectionId"] = json!("nope");
    let error = executor.validate(&task).await.unwrap_err();
    assert_eq!(error.code, "connection_missing");
    assert!(!error.retryable());

    // Secret-shaped config keys are rejected by the frozen domain validation.
    let mut task = backup_task("t2", task_config(dir.path()));
    task.config["password"] = json!("hunter2");
    assert!(task.validate().is_err());

    // No backup contents selected → invalid_config.
    let mut task = backup_task("t3", task_config(dir.path()));
    task.config["includeStructure"] = json!(false);
    task.config["includeData"] = json!(false);
    let error = executor.validate(&task).await.unwrap_err();
    assert_eq!(error.code, "invalid_config");

    // Relative destination → invalid_config.
    let mut config = task_config(dir.path());
    config["destinationDirectory"] = json!("relative/backups");
    let task = backup_task("t4", config);
    let error = executor.validate(&task).await.unwrap_err();
    assert_eq!(error.code, "invalid_config");

    // Unsaved credentials → invalid_config (unattended runs are pointless).
    state.storage.save_connections(std::slice::from_ref(&unreachable_mysql("no-creds", false))).await.unwrap();
    let mut config = task_config(dir.path());
    config["connectionId"] = json!("no-creds");
    let task = backup_task("t5", config);
    let error = executor.validate(&task).await.unwrap_err();
    assert_eq!(error.code, "invalid_config");
}

async fn run_to_terminal(engine: &Arc<SchedulerEngine>, store: &SchedulerStore, run_id: &str) -> TaskRunStatus {
    for _ in 0..600 {
        engine.tick().await.expect("engine tick");
        if let Ok(run) = store.get_run(run_id.to_owned()).await {
            if run.status.is_terminal() {
                return run.status;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("run {run_id} did not reach a terminal status in time");
}

/// The export path nests very large futures: reuse the roomy runtime the
/// backup worker uses (see `scheduled_backup::WORKER_STACK_SIZE`).
#[test]
fn scheduler_driven_backup_run_fails_through_the_full_chain_and_updates_legacy_history() {
    let runtime = dbx_core::scheduled_backup::worker_runtime().unwrap();
    runtime.block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let (_state, service, store, registry) = executor_world(dir.path()).await;
        // A migrated world: the legacy schedule row exists (preserved data),
        // so the executor can refresh its bookkeeping after the run.
        service.store.save_schedule(legacy_schedule("sched-1", "Nightly backup", dir.path(), "daily")).await.unwrap();
        let task = backup_task("sched-1", task_config(dir.path()));
        store.save_task(task, None).await.unwrap();

        let engine = Arc::new(
            SchedulerEngine::new(store.clone(), registry, "worker-test", Duration::from_millis(20))
                .with_lease_ttl(Duration::from_secs(30)),
        );
        let run = store.enqueue_manual("sched-1".into()).await.unwrap();
        let status = run_to_terminal(&engine, &store, &run.id).await;
        assert_eq!(status, TaskRunStatus::Failed);

        let finished = store.get_run(run.id.clone()).await.unwrap();
        assert_eq!(finished.error_code.as_deref(), Some("execution_failed"));
        assert!(!finished.error_message.as_deref().unwrap_or_default().is_empty());
        assert_eq!(finished.trigger, TaskRunTrigger::Manual);
        assert_eq!(finished.attempt, 1);

        // The legacy store saw the whole run: recorded as running by the
        // executor, finalized as failed, and the schedule bookkeeping was
        // refreshed — so the old UI stays consistent during double-track.
        let legacy = service.store.snapshot().await.unwrap();
        assert_eq!(legacy.runs.len(), 1);
        let legacy_run = &legacy.runs[0];
        assert_eq!(legacy_run.id, run.id);
        assert_eq!(legacy_run.schedule_id.as_deref(), Some("sched-1"));
        assert_eq!(legacy_run.status, "failed");
        assert_eq!(legacy_run.trigger, "manual");
        assert!(legacy_run.error.is_some());
        let schedule = legacy.schedules.iter().find(|schedule| schedule.id == "sched-1").unwrap();
        assert_eq!(schedule.last_run_status.as_deref(), Some("failed"));
        assert!(schedule.last_run_at.is_some());

        // The scheduler definition now carries the same last-run state.
        let definition = store.get_task("sched-1".into()).await.unwrap();
        assert_eq!(definition.last_run_status, Some(TaskRunStatus::Failed));
        assert!(definition.last_run_at.is_some());
    });
}
