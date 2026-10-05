//! A9 Integration QA evidence tests (task brief: 十六项核心验收). These go a
//! layer below the per-module suites and audit *persisted artifacts* instead
//! of return values:
//!
//! 1. Secret red line (ADR §10) proven at the byte level: after a full task
//!    lifecycle, the raw `state.db` (+ WAL), every persisted JSON column, the
//!    run log files and every published event must be free of a planted
//!    secret value.
//! 2. Migration idempotency across three consecutive worker startups (the
//!    release checklist's "连续启动 3 次" case), each start rebuilding the
//!    store/migration objects the way the real worker does.
//! 3. Log rotation produces a second segment with a contiguous `seq`, driven
//!    through the real 32 MiB threshold.
//! 4. Artifacts belong to their run id (metadata in `task_artifacts`,
//!    `artifacts_count` derived) while the artifact *body* never reaches
//!    SQLite — the byte-level half of the acceptance item the store round
//!    trip alone cannot prove.

mod common;

use std::sync::{Arc, Mutex};

use common::{drive_until_terminal, engine, registry_with, save, temp_store, Behavior, TestExecutor};
use dbx_core::scheduler::{
    register_event_sink, SchedulerMigration, SchedulerStore, TaskDefinition, TaskRunStatus, TaskTrigger,
};
use tempfile::TempDir;

const SECRET_VALUE: &str = "QA-SUPERSECRET-do-not-persist-9f2c1ab7";

fn secret_config_task(id: &str) -> TaskDefinition {
    let mut task = common::run_definition(id, "dbx.test", TaskTrigger::Manual);
    task.config = serde_json::json!({
        "command": "echo hi",
        "password": SECRET_VALUE,
        "auth": {
            "privateKey": SECRET_VALUE,
            "apiToken": SECRET_VALUE,
            "authorization": SECRET_VALUE,
            "secretRef": "vault://keep-me",
        },
        "nested": [{ "sessionKey": SECRET_VALUE, "client_secret": SECRET_VALUE, "note": "safe" }],
    });
    task
}

/// 1. Secret red line, byte level (ADR §10 / acceptance item 11).
#[tokio::test]
async fn secrets_never_reach_database_logs_or_events_across_a_full_lifecycle() {
    // Capture every engine event for this task (sink registry is global, so
    // filter on the unique task id).
    let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let events = Arc::clone(&events);
        register_event_sink(
            "qa-secret-audit",
            Arc::new(move |event| {
                if event["taskId"] == "qa-secret-task" {
                    events.lock().unwrap().push(event.clone());
                }
            }),
        );
    }

    let (dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::Succeed);
    let engine = engine(&store, registry_with(executor), "qa-secret-worker");

    // Save with planted secrets: the store must strip the keys before they
    // ever reach SQLite.
    let saved = save(&store, secret_config_task("qa-secret-task")).await;
    assert!(saved.config.get("password").is_none(), "secret key stripped from the in-memory definition");
    assert_eq!(
        saved.config["auth"]["secretRef"], "vault://keep-me",
        "secretRef stays (it is a reference, not a value)"
    );

    // Drive the full lifecycle: enqueue → claim → execute → finalize.
    let run = store.enqueue_manual("qa-secret-task".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);

    // (a) Raw database bytes — including the WAL sidecars — must not contain
    // the secret value anywhere.
    for name in ["state.db", "state.db-wal", "state.db-shm"] {
        let path = dir.path().join("scheduler").join(name);
        if let Ok(bytes) = std::fs::read(&path) {
            let haystack = String::from_utf8_lossy(&bytes).to_owned();
            assert!(!haystack.contains(SECRET_VALUE), "{name} contains the planted secret value");
        }
    }

    // (b) Every persisted JSON payload column, swept directly over SQLite.
    let conn = rusqlite::Connection::open(dir.path().join("scheduler/state.db")).unwrap();
    for (table, column) in [
        ("task_definitions", "config_json"),
        ("task_definitions", "trigger_json"),
        ("task_definitions", "execution_json"),
        ("task_runs", "payload_json"),
        ("task_audit", "metadata_json"),
        ("task_log_index", "path"),
        ("task_artifacts", "name"),
        ("task_artifacts", "uri"),
    ] {
        let mut statement = conn.prepare(&format!("SELECT {column} FROM {table}")).unwrap();
        let values: Vec<String> = statement.query_map([], |row| row.get::<_, String>(0)).unwrap().flatten().collect();
        for value in values {
            assert!(!value.contains(SECRET_VALUE), "{table}.{column} contains the planted secret: {value}");
        }
    }

    // (c) Run log files on disk.
    fn sweep(directory: &std::path::Path, violations: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(directory).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                sweep(&path, violations);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                if content.contains(SECRET_VALUE) {
                    violations.push(path);
                }
            }
        }
    }
    let mut violations = Vec::new();
    sweep(&dir.path().join("scheduler/logs"), &mut violations);
    assert!(violations.is_empty(), "run logs contain the planted secret: {violations:?}");

    // (d) Published events.
    let captured = events.lock().unwrap().clone();
    assert!(!captured.is_empty(), "the lifecycle must have published events");
    for event in captured {
        assert!(!event.to_string().contains(SECRET_VALUE), "event contains the planted secret: {event}");
    }
}

/// 2. Migration idempotency across three consecutive worker startups
/// (acceptance item 13). Each start rebuilds the store + migration the way
/// `background_scheduler::run_if_requested` does, so nothing but the data
/// directory carries over.
#[tokio::test]
async fn legacy_backup_migration_is_a_no_op_across_three_consecutive_worker_starts() {
    let dir = TempDir::new().unwrap();

    // Legacy store with one schedule and one finished run.
    let legacy = dbx_core::scheduled_backup::BackupStore::new(dir.path());
    let schedule: dbx_core::scheduled_backup::BackupSchedule = serde_json::from_str(
        r#"{
            "id": "qa-sched-1", "name": "Nightly", "enabled": true, "connectionId": "conn-1", "databases": [],
            "destinationDirectory": "/tmp/qa-backups", "includeStructure": true, "includeData": true,
            "includeObjects": true, "frequency": "daily", "intervalHours": 1,
            "timeOfDay": "02:30", "weekday": 0, "retentionCount": 3, "timeZone": "Asia/Shanghai",
            "createdAt": "2026-01-01T00:00:00+00:00", "updatedAt": "2026-01-01T00:00:00+00:00",
            "nextRunAt": "2026-10-06T02:30:00+00:00"
        }"#,
    )
    .unwrap();
    legacy.save_schedule(schedule).await.unwrap();

    let marker = dbx_core::scheduler::migration::DATABASE_BACKUP_MIGRATION_KEY;
    for startup in 1..=3 {
        // Fresh objects per startup, exactly like the worker entrypoint.
        let store = SchedulerStore::new(dir.path());
        let migration = SchedulerMigration::new(store.clone());
        let report = migration.migrate_legacy_database_backups(&legacy).await.unwrap();

        let tasks = store.list_tasks().await.unwrap();
        let runs = store.list_runs(None, 1000).await.unwrap();
        match startup {
            1 => {
                assert_eq!(report.schedules, 1, "first start migrates the schedule");
                assert_eq!(tasks.len(), 1);
            }
            _ => {
                assert_eq!(report, Default::default(), "start {startup} must be a no-op");
                assert_eq!(tasks.len(), 1, "start {startup} must not duplicate the task");
            }
        }
        assert_eq!(runs.len(), 0, "start {startup} must not fabricate runs");
        assert!(migration.is_applied(marker).await.unwrap(), "start {startup}: marker set");

        // The legacy record is preserved on every start (rollback/audit basis).
        let snapshot = legacy.snapshot().await.unwrap();
        assert_eq!(snapshot.schedules.len(), 1, "legacy schedule preserved on start {startup}");
        assert_eq!(tasks[0].id, "qa-sched-1", "old task id preserved");
    }
}

/// 3. Log rotation: crossing the real 32 MiB threshold opens segment 2 and
/// the `seq` stays contiguous across the boundary (acceptance item 15).
#[tokio::test]
async fn rotation_opens_the_next_segment_and_keeps_seq_monotonic() {
    let dir = TempDir::new().unwrap();
    let run_dir = dir.path().join("2026/10/05/qa-rotation-run");
    let mut logger = dbx_core::scheduler::TaskLogger::open(run_dir.clone()).unwrap();

    let chunk = "x".repeat(1024 * 1024); // 1 MiB per line
    let mut expected_seq = 0u64;
    for _ in 0..34 {
        expected_seq += 1;
        assert_eq!(logger.append("info", "stdout", &chunk).unwrap(), expected_seq);
    }
    assert_eq!(logger.stats().unwrap().segment, 2, "34 MiB crosses the 32 MiB rotation threshold");

    let page = dbx_core::scheduler::logs::read_run_logs(&run_dir, &Default::default()).unwrap();
    assert_eq!(page.entries.len(), 34);
    let seqs: Vec<u64> = page.entries.iter().map(|entry| entry.seq).collect();
    let contiguous: Vec<u64> = (1..=34).collect();
    assert_eq!(seqs, contiguous, "seq stays monotonic across the rotation boundary");
    assert!(page.eof);

    // afterSeq tail still works across segments.
    let tail = dbx_core::scheduler::logs::read_run_logs(
        &run_dir,
        &dbx_core::scheduler::TaskLogQuery { after_seq: Some(33), ..Default::default() },
    )
    .unwrap();
    assert_eq!(tail.entries.len(), 1);
    assert_eq!(tail.entries[0].seq, 34);
}

/// 4. Artifacts belong to their run id and the body stays out of SQLite
/// (acceptance item 16 / ADR §10.5). A full lifecycle with an artifact-
/// emitting executor, then the persisted state is audited directly.
#[tokio::test]
async fn artifacts_belong_to_their_run_and_the_body_never_reaches_sqlite() {
    const ARTIFACT_BODY: &str = "artifact body";
    let (dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::EmitArtifact);
    let engine = engine(&store, registry_with(executor), "qa-artifact-worker");

    save(&store, common::run_definition("qa-artifact-task", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("qa-artifact-task".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);

    // (a) The artifact is attributed to exactly its own run id.
    let artifacts = store.list_artifacts(run.id.clone()).await.unwrap();
    assert_eq!(artifacts.len(), 1, "the run owns exactly one artifact");
    assert_eq!(artifacts[0].name, "out.txt");
    assert_eq!(finished.artifacts_count, 1, "artifacts_count is derived from task_artifacts");
    // No leakage into other runs: a fabricated run id owns nothing.
    assert!(store.list_artifacts("no-such-run".into()).await.unwrap().is_empty());

    // (b) Metadata columns persisted; the uri points outside SQLite.
    let conn = rusqlite::Connection::open(dir.path().join("scheduler/state.db")).unwrap();
    let (name, uri, size): (String, String, i64) = conn
        .query_row("SELECT name, uri, size FROM task_artifacts WHERE run_id = ?", [&run.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(name, "out.txt");
    assert!(uri.ends_with(&format!("dbx-scheduler-test-artifact-{run_id}.txt", run_id = run.id)), "uri: {uri}");
    assert_eq!(size, ARTIFACT_BODY.len() as i64);

    // (c) The body itself never lands in the database bytes.
    for db_name in ["state.db", "state.db-wal", "state.db-shm"] {
        let path = dir.path().join("scheduler").join(db_name);
        if let Ok(bytes) = std::fs::read(&path) {
            let haystack = String::from_utf8_lossy(&bytes).to_owned();
            assert!(!haystack.contains(ARTIFACT_BODY), "{db_name} contains the artifact body");
        }
    }
}
