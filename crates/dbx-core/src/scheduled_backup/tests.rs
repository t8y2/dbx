use super::*;
use chrono::{DateTime, Utc};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

fn schedule(dir: &std::path::Path) -> BackupSchedule {
    serde_json::from_value(json!({
        "id":"daily", "name":"Daily backup", "enabled":true, "connectionId":"mysql", "databases":[],
        "destinationDirectory":dir.to_string_lossy(), "includeStructure":true, "includeData":true, "includeObjects":true,
        "frequency":"daily", "intervalHours":1, "timeOfDay":"02:30", "weekday":0, "retentionCount":2,
        "timeZone":"America/New_York", "createdAt":"2026-01-01T00:00:00Z", "updatedAt":"2026-01-01T00:00:00Z",
        "nextRunAt":"2026-01-01T00:00:00Z"
    })).unwrap()
}
fn utc(value: &str) -> DateTime<Utc> {
    value.parse().unwrap()
}
fn request(config: BackupConfig) -> RunRequest {
    RunRequest { schedule_id: None, config: Some(config), display_name: None, time_zone: None }
}

#[test]
fn wall_clock_schedule_handles_dst_and_does_not_repeat_ambiguous_time() {
    let dir = tempfile::tempdir().unwrap();
    let mut schedule = schedule(dir.path());
    assert_eq!(schedule.next_after(utc("2026-03-08T06:00:00Z")).unwrap(), utc("2026-03-08T07:00:00Z"));
    schedule.time_of_day = "01:30".into();
    assert_eq!(schedule.next_after(utc("2026-11-01T04:00:00Z")).unwrap(), utc("2026-11-01T05:30:00Z"));
    assert_eq!(schedule.next_after(utc("2026-11-01T05:31:00Z")).unwrap(), utc("2026-11-02T06:30:00Z"));
}

#[test]
fn hourly_uses_elapsed_time_and_weekly_uses_saved_zone() {
    let dir = tempfile::tempdir().unwrap();
    let mut schedule = schedule(dir.path());
    schedule.frequency = "hourly".into();
    assert_eq!(schedule.next_after(utc("2026-03-08T06:30:00Z")).unwrap(), utc("2026-03-08T07:30:00Z"));
    schedule.frequency = "weekly".into();
    schedule.time_zone = "Asia/Shanghai".into();
    assert_eq!(schedule.next_after(utc("2026-09-12T10:00:00Z")).unwrap(), utc("2026-09-12T18:30:00Z"));
}

#[test]
fn invalid_schedule_and_path_templates_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut schedule = schedule(dir.path());
    schedule.time_zone = "invalid/timezone".into();
    assert!(schedule.validate().is_err());
    for path in ["../escape", "/absolute", "C:\\escape", "safe/../escape", "a/", "a\\..\\b"] {
        assert!(super::models::validate_template(path, true).is_err(), "{path}");
    }
    assert!(super::models::validate_template("{date}/{schedule}/{runId}", true).is_ok());
    assert!(super::models::matches_pattern("app.public.user?", "users", "app", "public", true));
    assert!(!super::models::matches_pattern("PUBLIC.*", "users", "app", "public", true));
    assert!(super::models::matches_pattern("PUBLIC.*", "users", "app", "public", false));
}

#[tokio::test]
async fn schedule_survives_reopen_and_rejects_stale_edit() {
    let dir = tempfile::tempdir().unwrap();
    let store = BackupStore::new(dir.path());
    let first = store.save_schedule(schedule(dir.path())).await.unwrap();
    let mut next = first.clone();
    next.name = "Renamed".into();
    store.save_schedule(next).await.unwrap();
    assert!(store.save_schedule(first).await.unwrap_err().contains("changed"));
    let reopened = BackupStore::new(dir.path()).snapshot().await.unwrap();
    assert_eq!(reopened.schedules[0].name, "Renamed");
    assert!(DateTime::parse_from_rfc3339(&reopened.schedules[0].next_run_at).unwrap().with_timezone(&Utc) > Utc::now());
}

#[tokio::test]
async fn migration_is_atomic_idempotent_and_keeps_only_one_catchup_job() {
    let dir = tempfile::tempdir().unwrap();
    let store = BackupStore::new(dir.path());
    let mut invalid = schedule(dir.path());
    invalid.time_zone = "bad".into();
    assert!(store.migrate(Migration { schedules: vec![schedule(dir.path()), invalid], runs: vec![] }).await.is_err());
    assert!(!store.snapshot().await.unwrap().migrated);
    store.migrate(Migration { schedules: vec![schedule(dir.path())], runs: vec![] }).await.unwrap();
    store.migrate(Migration::default()).await.unwrap();
    let (a, b) = tokio::join!(store.enqueue_due(), store.enqueue_due());
    a.unwrap();
    b.unwrap();
    let snapshot = store.snapshot().await.unwrap();
    assert!(snapshot.migrated);
    assert_eq!(snapshot.schedules.len(), 1);
    assert_eq!(snapshot.runs.len(), 1);
    assert_eq!(snapshot.runs[0].trigger, "scheduled");
    assert!(utc(&snapshot.schedules[0].next_run_at) > Utc::now());
    assert!(store.delete_schedule("daily".into()).await.is_err());
}

#[tokio::test]
async fn concurrent_manual_requests_do_not_duplicate_a_schedule() {
    let dir = tempfile::tempdir().unwrap();
    let store = BackupStore::new(dir.path());
    store.save_schedule(schedule(dir.path())).await.unwrap();
    let req = RunRequest { schedule_id: Some("daily".into()), config: None, display_name: None, time_zone: None };
    let (left, right) = tokio::join!(store.enqueue(req.clone()), store.enqueue(req));
    assert_ne!(left.is_ok(), right.is_ok());
    assert_eq!(store.snapshot().await.unwrap().runs.len(), 1);
}

#[tokio::test]
async fn recovery_preserves_queued_jobs_and_marks_orphaned_running_jobs_failed() {
    let dir = tempfile::tempdir().unwrap();
    let store = BackupStore::new(dir.path());
    let run = store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    store.recover().await.unwrap();
    assert_eq!(store.claim().await.unwrap().unwrap().run.id, run.id);
    store.recover().await.unwrap();
    assert!(store.claim().await.unwrap().is_none());
    let recovered = &store.snapshot().await.unwrap().runs[0];
    assert_eq!(recovered.status, "failed");
    assert!(recovered.error.as_ref().unwrap().contains("interrupted"));
}

async fn service(dir: &std::path::Path, root: Option<std::path::PathBuf>) -> BackupService {
    let storage = crate::persistence::test_storage::open(&dir.join("dbx.db")).await.unwrap();
    BackupService::new(Arc::new(crate::connection::AppState::new(storage)), dir, root)
}

#[tokio::test]
async fn web_rejects_external_directories_and_untrusted_history_import() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("backups");
    std::fs::create_dir(&root).unwrap();
    let service = service(dir.path(), Some(root.clone())).await;
    assert!(service.command(BackupCommand::Save { schedule: schedule(dir.path()) }).await.is_err());
    assert!(service
        .command(BackupCommand::Migrate { migration: Migration { schedules: vec![schedule(&root)], runs: vec![] } })
        .await
        .is_err());
    service.command(BackupCommand::Save { schedule: schedule(&root) }).await.unwrap();
    let snapshot = service.store.snapshot().await.unwrap();
    assert_eq!(snapshot.schedules.len(), 1);
}

#[tokio::test]
async fn deletion_only_removes_recorded_files_within_the_backup_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("backups");
    std::fs::create_dir(&root).unwrap();
    let service = service(dir.path(), Some(root.clone())).await;
    let inside = root.join("test.sql");
    std::fs::write(&inside, "SELECT 1;").unwrap();
    let outside = dir.path().join("outside.sql");
    std::fs::write(&outside, "keep").unwrap();
    let mut run = service.store.enqueue(request(schedule(&root).config)).await.unwrap();
    service.store.claim().await.unwrap();
    run.status = "success".into();
    run.files = vec![BackupFile {
        database: "app".into(),
        schema: "app".into(),
        display_name: "test".into(),
        file_path: outside.to_string_lossy().into_owned(),
        owned: true,
    }];
    service.store.finish(run.clone()).await.unwrap();
    assert!(service.file(&run.id, 0).await.is_err());
    assert!(service.delete_runs(vec![run.id.clone()]).await.is_err());
    assert!(outside.exists());
    assert!(inside.exists());
    run.files[0].file_path = inside.to_string_lossy().into_owned();
    run.files[0].owned = false;
    service.store.finish(run.clone()).await.unwrap();
    assert!(service.delete_runs(vec![run.id.clone()]).await.is_err());
    assert!(inside.exists());
    run.files[0].owned = true;
    service.store.finish(run.clone()).await.unwrap();
    assert_eq!(service.file(&run.id, 0).await.unwrap(), inside.canonicalize().unwrap());
    assert!(service.file(&run.id, 1).await.is_err());
    assert!(service.file("unknown", 0).await.is_err());
    service.delete_runs(vec![run.id]).await.unwrap();
    assert!(!inside.exists());
    assert!(outside.exists());
    assert!(service.store.snapshot().await.unwrap().runs.is_empty());
}

#[tokio::test]
async fn draining_transfers_leadership_without_cancelling_and_cancel_survives_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), None).await;
    let run = service.store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    assert!(service.store.cancel(run.id.clone()).await.unwrap());
    let first_stop = CancellationToken::new();
    let first_drain = CancellationToken::new();
    let second_stop = CancellationToken::new();
    let first = service.start_with_drain(first_stop.clone(), first_drain.clone());
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = service.store.snapshot().await.unwrap();
            if snapshot.heartbeat.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    let probe =
        std::fs::OpenOptions::new().read(true).write(true).open(service.store.directory.join("worker.lock")).unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&probe).is_err());
    let second = service.start(second_stop.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    first_drain.cancel();
    tokio::time::timeout(Duration::from_secs(5), first).await.unwrap().unwrap();
    assert!(!first_stop.is_cancelled());
    let previous = service.store.snapshot().await.unwrap().heartbeat;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if service.store.snapshot().await.unwrap().heartbeat != previous {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&probe).is_err());
    second_stop.cancel();
    second.await.unwrap();
    fs2::FileExt::try_lock_exclusive(&probe).unwrap();
    fs2::FileExt::unlock(&probe).unwrap();
    let snapshot = BackupStore::new(dir.path()).snapshot().await.unwrap();
    assert_eq!(snapshot.runs.len(), 1);
    assert_eq!(snapshot.runs[0].status, "cancelled");
}

#[tokio::test]
async fn worker_waits_for_security_migration_and_resumes_without_restarting() {
    let directory = tempfile::tempdir().unwrap();
    let legacy_path = directory.path().join("connections.json");
    std::fs::write(&legacy_path, "[]").unwrap();
    let storage = crate::persistence::test_storage::open_unmigrated(&directory.path().join("dbx.db")).await.unwrap();
    let service = BackupService::new(Arc::new(crate::connection::AppState::new(storage)), directory.path(), None);
    let queued = service.store.enqueue(request(schedule(directory.path()).config)).await.unwrap();
    assert!(!service.state.storage.inspect_data_migration().await.unwrap().is_ready());
    let stop = CancellationToken::new();
    let worker = service.start(stop.clone());

    tokio::time::sleep(Duration::from_millis(2200)).await;
    let waiting = service.store.snapshot().await.unwrap();
    assert!(waiting.heartbeat.is_none());
    assert_eq!(waiting.runs[0].id, queued.id);
    assert_eq!(waiting.runs[0].status, queued.status);
    assert_eq!(std::fs::read_to_string(&legacy_path).unwrap(), "[]");
    assert!(!directory.path().join("connections.json.bak").exists());

    service.state.storage.start_data_migration().await.unwrap();
    let resumed = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let snapshot = service.store.snapshot().await.unwrap();
            if snapshot.heartbeat.is_some() && snapshot.runs[0].status == "failed" {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), worker).await.unwrap().unwrap();
    let resumed = resumed.unwrap();
    assert_eq!(resumed.runs[0].id, queued.id);
    assert!(resumed.runs[0].error.is_some());
    assert!(!legacy_path.exists());
    assert!(directory.path().join("connections.json.bak").exists());
}

#[tokio::test]
async fn stopped_or_drained_startup_does_not_consume_existing_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), None).await;
    let queued = service.store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    for draining in [false, true] {
        let stop = CancellationToken::new();
        let drain = CancellationToken::new();
        if draining {
            drain.cancel();
        } else {
            stop.cancel();
        }
        tokio::time::timeout(Duration::from_secs(5), service.start_with_drain(stop, drain)).await.unwrap().unwrap();
        let snapshot = service.store.snapshot().await.unwrap();
        assert!(snapshot.heartbeat.is_none());
        assert_eq!(snapshot.runs.len(), 1);
        assert_eq!(snapshot.runs[0].id, queued.id);
        assert_eq!(snapshot.runs[0].status, queued.status);
    }
    assert_eq!(service.store.claim().await.unwrap().unwrap().run.id, queued.id);
}

#[tokio::test]
async fn upgrade_reopen_recovers_interrupted_work_without_losing_queued_jobs_or_disabled_schedules() {
    let dir = tempfile::tempdir().unwrap();
    let store = BackupStore::new(dir.path());
    let mut disabled = schedule(dir.path());
    disabled.enabled = false;
    store.save_schedule(disabled).await.unwrap();
    let interrupted = store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    assert_eq!(store.claim().await.unwrap().unwrap().run.id, interrupted.id);
    let queued = store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    let cancelled = store.enqueue(request(schedule(dir.path()).config)).await.unwrap();
    store.cancel(cancelled.id.clone()).await.unwrap();
    drop(store);

    let reopened = BackupStore::new(dir.path());
    reopened.recover().await.unwrap();
    reopened.recover().await.unwrap();
    let snapshot = reopened.snapshot().await.unwrap();
    assert!(!snapshot.schedules[0].enabled);
    assert_eq!(snapshot.runs.len(), 3);
    assert_eq!(snapshot.runs.iter().find(|run| run.id == interrupted.id).unwrap().status, "failed");
    assert_eq!(snapshot.runs.iter().find(|run| run.id == cancelled.id).unwrap().status, "cancelled");
    assert_eq!(reopened.claim().await.unwrap().unwrap().run.id, queued.id);
    assert!(reopened.claim().await.unwrap().is_none());
}

#[test]
#[ignore = "requires a disposable MySQL endpoint configured by DBX_LIVE_SQL_FILE_MYSQL_* variables"]
fn live_mysql_worker_exports_saved_connection_and_applies_retention() {
    live_backup_runtime().block_on(live_mysql_worker_scenario());
}

async fn live_mysql_worker_scenario() {
    use crate::{models::connection::ConnectionConfig, query::execute_sql_statement};
    use futures::FutureExt;
    use std::io::Read;
    let dir = tempfile::tempdir().unwrap();
    let service = service(dir.path(), None).await;
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id":"mysql", "name":"Worker test", "db_type":"mysql", "save_password":true,
        "host":std::env::var("DBX_LIVE_SQL_FILE_MYSQL_HOST").unwrap(),
        "port":std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(3306),
        "username":std::env::var("DBX_LIVE_SQL_FILE_MYSQL_USER").unwrap(),
        "password":std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD").unwrap(),
        "database":null, "connect_timeout_secs":10, "query_timeout_secs":30
    }))
    .unwrap();
    service.state.storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
    service.state.configs.write().await.insert(config.id.clone(), config);
    let database = format!("dbx_worker_{}", uuid::Uuid::new_v4().simple());
    execute_sql_statement(&service.state, "mysql", "", &format!("CREATE DATABASE `{database}`"), None, None)
        .await
        .unwrap();
    let stop = CancellationToken::new();
    let worker = service.start(stop.clone());
    let outcome = std::panic::AssertUnwindSafe(async {
        execute_sql_statement(
            &service.state,
            "mysql",
            &database,
            "CREATE TABLE chosen (id INT PRIMARY KEY, value TEXT)",
            None,
            None,
        )
        .await?;
        execute_sql_statement(
            &service.state,
            "mysql",
            &database,
            "INSERT INTO chosen VALUES (101, 'background-worker-sentinel')",
            None,
            None,
        )
        .await?;
        execute_sql_statement(&service.state, "mysql", &database, "CREATE TABLE skipped (id INT)", None, None).await?;
        let mut plan = schedule(dir.path());
        plan.enabled = false;
        plan.retention_count = 1;
        plan.config.databases = vec![database.clone()];
        plan.config.output_compression = "gzip".into();
        plan.config.table_filter_mode = "include".into();
        plan.config.table_patterns = vec!["chosen".into()];
        service.command(BackupCommand::Save { schedule: plan }).await?;
        let mut previous = None;
        for _ in 0..2 {
            let run = service
                .store
                .enqueue(RunRequest {
                    schedule_id: Some("daily".into()),
                    config: None,
                    display_name: None,
                    time_zone: None,
                })
                .await?;
            let completed = tokio::time::timeout(Duration::from_secs(60), async {
                loop {
                    let snapshot = service.store.snapshot().await.unwrap();
                    let current = snapshot.runs.iter().find(|r| r.id == run.id).unwrap();
                    if current.status != "running" {
                        break current.clone();
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            })
            .await
            .map_err(|_| "Backup timed out")?;
            assert_eq!(completed.status, "success", "{:?}", completed.error);
            assert_eq!(completed.files.len(), 1);
            let path = std::path::PathBuf::from(&completed.files[0].file_path);
            let mut sql = String::new();
            flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap()).read_to_string(&mut sql).unwrap();
            assert!(sql.contains("background-worker-sentinel"));
            assert!(!sql.contains("CREATE TABLE `skipped`"));
            if let Some(previous) = previous {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while std::path::Path::new(&previous).exists() {
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                })
                .await
                .map_err(|_| "Retention did not remove the old file")?;
            }
            previous = Some(path);
        }
        assert_eq!(service.store.snapshot().await?.runs.len(), 1);
        let mut empty_scope = schedule(dir.path()).config;
        empty_scope.databases = vec![database.clone()];
        empty_scope.table_filter_mode = "include".into();
        empty_scope.table_patterns = vec!["missing_table".into()];
        let run = service.store.enqueue(request(empty_scope)).await?;
        let completed = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                let snapshot = service.store.snapshot().await.unwrap();
                let current = snapshot.runs.iter().find(|r| r.id == run.id).unwrap();
                if current.status != "running" {
                    break current.clone();
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| "Empty-scope backup timed out")?;
        assert_eq!(completed.status, "failed");
        assert!(completed.error.as_deref().unwrap().contains("No tables matched"));
        assert!(completed.files.is_empty());
        assert!(previous.unwrap().exists());
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    stop.cancel();
    worker.await.unwrap();
    let cleanup =
        execute_sql_statement(&service.state, "mysql", "", &format!("DROP DATABASE `{database}`"), None, None).await;
    service.state.shutdown(Duration::from_secs(3)).await;
    cleanup.unwrap();
    outcome.unwrap().unwrap();
}

/// Runs a live scenario on a runtime configured like the processes that drive
/// backups. The export path nests very large async futures, so it needs the same
/// roomy worker stack the desktop runtime sets; on tokio's default stack the
/// process aborts with `fatal runtime error: stack overflow` instead of
/// reporting a failed assertion.
fn live_backup_runtime() -> tokio::runtime::Runtime {
    super::worker_runtime().unwrap()
}

fn live_postgres_config(id: &str, database: &str) -> crate::models::connection::ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": id, "db_type": "postgres", "save_password": true,
        "host": std::env::var("DBX_LIVE_SQL_FILE_POSTGRES_HOST").unwrap(),
        "port": std::env::var("DBX_LIVE_SQL_FILE_POSTGRES_PORT").ok().and_then(|p| p.parse::<u16>().ok()).unwrap_or(5432),
        "username": std::env::var("DBX_LIVE_SQL_FILE_POSTGRES_USER").unwrap(),
        "password": std::env::var("DBX_LIVE_SQL_FILE_POSTGRES_PASSWORD").unwrap(),
        "database": database, "connect_timeout_secs": 10, "query_timeout_secs": 30
    }))
    .unwrap()
}

async fn await_run(service: &BackupService, run_id: &str) -> BackupRun {
    tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let snapshot = service.store.snapshot().await.unwrap();
            let current = snapshot.runs.iter().find(|r| r.id == run_id).unwrap().clone();
            if current.status != "running" && current.status != "queued" {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("backup run did not finish within 60s")
}

async fn enqueue_and_run(service: &BackupService, schedule_id: &str) -> BackupRun {
    let run = service
        .store
        .enqueue(RunRequest {
            schedule_id: Some(schedule_id.into()),
            config: None,
            display_name: None,
            time_zone: None,
        })
        .await
        .unwrap();
    await_run(service, &run.id).await
}

fn plan_with_id(dir: &std::path::Path, id: &str) -> BackupSchedule {
    let mut plan = schedule(dir);
    plan.id = id.to_string();
    plan.enabled = false;
    plan
}

fn read_backup(path: &str, gzip: bool) -> String {
    let file = std::fs::File::open(path).unwrap();
    if !gzip {
        return std::fs::read_to_string(path).unwrap();
    }
    use std::io::Read;
    let mut sql = String::new();
    flate2::read::GzDecoder::new(file).read_to_string(&mut sql).unwrap();
    sql
}

#[test]
#[ignore = "requires a disposable PostgreSQL endpoint configured by DBX_LIVE_SQL_FILE_POSTGRES_* variables"]
fn live_postgres_worker_exports_selected_tables_across_schemas() {
    use crate::query::execute_sql_statement;
    live_backup_runtime().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path(), None).await;
        let stop = CancellationToken::new();
        let worker = service.start(stop.clone());
        let admin_id = "postgres-admin";
        let admin = live_postgres_config(admin_id, "postgres");
        service.state.storage.save_connections(std::slice::from_ref(&admin)).await.unwrap();
        service.state.configs.write().await.insert(admin.id.clone(), admin);
        let database = format!("dbx_pg_backup_{}", uuid::Uuid::new_v4().simple());
        execute_sql_statement(
            &service.state,
            admin_id,
            "postgres",
            &format!("CREATE DATABASE \"{database}\""),
            None,
            None,
        )
        .await
        .unwrap();
        let config = live_postgres_config("postgres", &database);
        service.state.storage.save_connections(std::slice::from_ref(&config)).await.unwrap();
        service.state.configs.write().await.insert(config.id.clone(), config);

        for statement in [
            "CREATE SCHEMA app",
            "CREATE SCHEMA audit",
            "CREATE TABLE public.accounts (id integer PRIMARY KEY, name text NOT NULL)",
            "CREATE TABLE app.orders (id integer PRIMARY KEY, total numeric(12,2) NOT NULL)",
            "CREATE TABLE app.\"MixedCase\" (id integer PRIMARY KEY)",
            "CREATE VIEW app.big_orders AS SELECT id, total FROM app.orders WHERE total > 100",
            "CREATE TABLE audit.events (id integer PRIMARY KEY, note text)",
            "INSERT INTO public.accounts VALUES (1, 'Alice')",
            "INSERT INTO app.orders VALUES (7, 42.50), (8, 420.00)",
            "INSERT INTO app.\"MixedCase\" VALUES (1)",
            "INSERT INTO audit.events VALUES (9, 'sentinel-event')",
        ] {
            execute_sql_statement(&service.state, "postgres", &database, statement, None, None).await.unwrap();
        }

        // Table scope: only `app.orders` (schema-qualified pattern) and the
        // case-sensitive `MixedCase` name, which pg resolves case-sensitively.
        let mut plan = plan_with_id(dir.path(), "scope");
        plan.retention_count = 2;
        plan.config.connection_id = "postgres".into();
        plan.config.databases = vec![database.clone()];
        plan.config.output_compression = "gzip".into();
        plan.config.table_filter_mode = "include".into();
        plan.config.table_patterns = vec!["app.orders".into(), "MixedCase".into()];
        service.command(BackupCommand::Save { schedule: plan }).await.unwrap();

        let completed = enqueue_and_run(&service, "scope").await;
        assert_eq!(completed.status, "success", "{:?}", completed.error);
        assert_eq!(
            completed.files.len(),
            1,
            "{:?}",
            completed.files.iter().map(|f| &f.display_name).collect::<Vec<_>>()
        );
        let sql = read_backup(&completed.files[0].file_path, true);
        assert!(sql.contains("CREATE TABLE \"app\".\"orders\""), "{sql}");
        assert!(sql.contains("\"MixedCase\""), "{sql}");
        assert!(sql.contains("420.00"), "{sql}");
        assert!(!sql.contains("accounts"), "{sql}");
        assert!(!sql.contains("events"), "{sql}");
        // A view inside the same schema is not part of a table-name scope.
        assert!(!sql.contains("big_orders"), "{sql}");

        // Patterns are case-sensitive on PostgreSQL, and a scope that matches
        // nothing must fail without leaving a partial file behind.
        let mut empty = plan_with_id(dir.path(), "empty");
        empty.config.connection_id = "postgres".into();
        empty.config.databases = vec![database.clone()];
        empty.config.output_compression = "gzip".into();
        empty.config.table_filter_mode = "include".into();
        empty.config.table_patterns = vec!["mixedcase".into()];
        service.command(BackupCommand::Save { schedule: empty }).await.unwrap();
        let cancelled = enqueue_and_run(&service, "empty").await;
        assert_eq!(cancelled.status, "failed");
        assert!(cancelled.error.as_deref().unwrap().contains("No tables matched"), "{:?}", cancelled.error);
        assert!(cancelled.files.is_empty());

        // Every schema of the database is exported when no table scope is set.
        let mut full = plan_with_id(dir.path(), "full");
        full.config.connection_id = "postgres".into();
        full.config.databases = vec![database.clone()];
        full.config.output_compression = "gzip".into();
        service.command(BackupCommand::Save { schedule: full }).await.unwrap();
        let full_run = enqueue_and_run(&service, "full").await;
        assert_eq!(full_run.status, "success", "{:?}", full_run.error);
        assert_eq!(full_run.files.len(), 3, "{:?}", full_run.files.iter().map(|f| &f.display_name).collect::<Vec<_>>());
        let bodies =
            full_run.files.iter().map(|f| (f.schema.clone(), read_backup(&f.file_path, true))).collect::<Vec<_>>();
        let app = bodies.iter().find(|(schema, _)| schema == "app").unwrap();
        assert!(app.1.contains("CREATE TABLE \"app\".\"MixedCase\""));
        assert!(app.1.contains("big_orders"), "views belong to the schema-wide export");
        let audit = bodies.iter().find(|(schema, _)| schema == "audit").unwrap();
        assert!(audit.1.contains("sentinel-event"));
        assert!(!audit.1.contains("orders"));
        let public = bodies.iter().find(|(schema, _)| schema == "public").unwrap();
        assert!(public.1.contains("accounts"));

        stop.cancel();
        worker.await.unwrap();
        let cleanup = execute_sql_statement(
            &service.state,
            admin_id,
            "postgres",
            &format!("DROP DATABASE \"{database}\" WITH (FORCE)"),
            None,
            None,
        )
        .await;
        service.state.shutdown(Duration::from_secs(3)).await;
        cleanup.unwrap();
    });
}
