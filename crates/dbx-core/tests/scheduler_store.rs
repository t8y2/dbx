//! Store tests (plan §84–90): CAS optimistic locking, claim race, duplicate
//! execution, cancel, recovery, lease, misfire records, logs, artifacts,
//! audit and migration idempotency.

mod common;

use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use common::*;
use dbx_core::scheduler::{
    ResidentSession, ResidentState, TaskConcurrencyPolicy, TaskMisfirePolicy, TaskRunStatus, TaskRunTrigger,
    TaskTrigger, SCHEDULER_LEASE,
};

#[tokio::test]
async fn task_crud_with_optimistic_locking() {
    let (_dir, store) = temp_store();
    let task = save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    assert_eq!(task.version, 1);
    assert!(task.next_run_at.is_none(), "manual trigger carries no schedule");

    // Stale version → 409.
    let mut stale = task.clone();
    stale.name = "renamed".into();
    let error = store.save_task(stale.clone(), Some(99)).await.unwrap_err();
    assert_eq!(error.code, "version_conflict");

    // Fresh version → CAS bump.
    let updated = store.save_task(stale, Some(1)).await.unwrap();
    assert_eq!(updated.version, 2);
    assert_eq!(updated.name, "renamed");
    assert_eq!(updated.created_at, task.created_at, "created_at survives updates");

    // Updating a non-existent task with a version is a conflict, not a create.
    let mut ghost = run_definition("ghost", "dbx.test", TaskTrigger::Manual);
    ghost.version = 1;
    let error = store.save_task(ghost, Some(1)).await.unwrap_err();
    assert_eq!(error.code, "version_conflict");
}

#[tokio::test]
async fn scheduled_tasks_get_next_run_at_on_create() {
    let (_dir, store) = temp_store();
    let task = save(&store, run_definition("t2", "dbx.test", TaskTrigger::Interval { seconds: 60 })).await;
    assert!(task.next_run_at.is_some(), "interval trigger schedules immediately");
    let manual = save(&store, run_definition("t3", "dbx.test", TaskTrigger::Startup)).await;
    assert!(manual.next_run_at.is_none());
}

#[tokio::test]
async fn secret_shaped_config_keys_are_redacted_on_save() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t4", "dbx.test", TaskTrigger::Manual);
    task.config = serde_json::json!({"command": "ls", "nested": {"password": "hunter2"}});
    let saved = save(&store, task).await;
    assert_eq!(saved.config["command"], "ls");
    assert_eq!(saved.config["nested"]["password"], serde_json::Value::Null);
}

#[tokio::test]
async fn concurrent_save_race_produces_exactly_one_winner() {
    let (_dir, store) = temp_store();
    let task = save(&store, run_definition("t5", "dbx.test", TaskTrigger::Manual)).await;
    let mut handles = Vec::new();
    for index in 0..4 {
        let store = store.clone();
        let mut candidate = task.clone();
        candidate.name = format!("racer-{index}");
        handles.push(tokio::spawn(async move {
            let result = store.save_task(candidate, Some(1)).await;
            println!("racer {index}: {:?}", result.as_ref().map(|t| t.version).map_err(|e| e.code.clone()));
            result
        }));
    }
    let winners = futures::future::join_all(handles).await.into_iter().filter(|r| matches!(r, Ok(Ok(_)))).count();
    assert_eq!(winners, 1, "exactly one CAS update may win");
    let final_task = store.get_task("t5".into()).await.unwrap();
    assert_eq!(final_task.version, 2);
}

#[tokio::test]
async fn claim_race_allows_exactly_one_winner() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    let mut handles = Vec::new();
    for worker in 0..8 {
        let store = store.clone();
        handles.push(tokio::spawn(async move { store.claim(format!("worker-{worker}"), Utc::now()).await.unwrap() }));
    }
    let winners = futures::future::join_all(handles).await.into_iter().filter(|job| matches!(job, Ok(Some(_)))).count();
    assert_eq!(winners, 1, "a queued run may only be claimed once");
    let claimed = store.get_run(run.id.clone()).await.unwrap();
    assert_eq!(claimed.status, TaskRunStatus::Starting);
    assert!(claimed.worker_id.is_some());
}

#[tokio::test]
async fn forbid_policy_rejects_duplicate_manual_runs() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.concurrency = TaskConcurrencyPolicy::Forbid;
    save(&store, task).await;
    store.enqueue_manual("t1".into()).await.unwrap();
    let error = store.enqueue_manual("t1".into()).await.unwrap_err();
    assert_eq!(error.code, "run_already_active");
}

#[tokio::test]
async fn replace_policy_skips_queued_runs() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.concurrency = TaskConcurrencyPolicy::Replace;
    save(&store, task).await;
    let first = store.enqueue_manual("t1".into()).await.unwrap();
    let second = store.enqueue_manual("t1".into()).await.unwrap();
    let first = store.get_run(first.id).await.unwrap();
    assert_eq!(first.status, TaskRunStatus::Skipped, "queued run replaced by newer one");
    let second = store.get_run(second.id).await.unwrap();
    assert_eq!(second.status, TaskRunStatus::Queued);
}

#[tokio::test]
async fn queue_and_parallel_allow_manual_enqueue() {
    for policy in [TaskConcurrencyPolicy::Queue, TaskConcurrencyPolicy::Parallel] {
        let (_dir, store) = temp_store();
        let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
        task.execution.concurrency = policy;
        save(&store, task).await;
        store.enqueue_manual("t1".into()).await.unwrap();
        store.enqueue_manual("t1".into()).await.unwrap();
    }
}

#[tokio::test]
async fn cancel_queued_run_immediately_and_running_run_via_flag() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;

    // Queued: cancelled outright.
    let queued = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    assert!(store.request_cancel(queued.id.clone()).await.unwrap());
    assert_eq!(store.get_run(queued.id.clone()).await.unwrap().status, TaskRunStatus::Cancelled);
    assert!(!store.request_cancel(queued.id.clone()).await.unwrap(), "terminal runs reject cancel");

    // Running: cancel flag flipped, engine finalizes later.
    let running = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    store.claim("worker-1".into(), Utc::now()).await.unwrap();
    store.mark_run_started(running.id.clone(), "worker-1".into()).await.unwrap();
    assert!(store.request_cancel(running.id.clone()).await.unwrap());
    assert!(store.is_cancel_requested(running.id.clone()).await.unwrap());
}

#[tokio::test]
async fn finish_run_is_idempotent_and_updates_task_status() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    let finished = store.finish_run(run.id.clone(), TaskRunStatus::Success, Some(0), None, None).await.unwrap();
    assert_eq!(finished.status, TaskRunStatus::Success);
    // Second finish is a no-op returning the stored row.
    let again = store.finish_run(run.id.clone(), TaskRunStatus::Failed, None, Some("boom".into()), None).await.unwrap();
    assert_eq!(again.status, TaskRunStatus::Success);
    let task = store.get_task("t1".into()).await.unwrap();
    assert_eq!(task.last_run_status, Some(TaskRunStatus::Success));
}

#[tokio::test]
async fn recovery_requeues_starting_and_fails_running() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    save(&store, run_definition("t2", "dbx.test", TaskTrigger::Manual)).await;

    let starting = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    store.claim("worker-1".into(), Utc::now()).await.unwrap();
    let running = store.enqueue_run("t2".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    store.claim("worker-1".into(), Utc::now()).await.unwrap();
    store.mark_run_started(running.id.clone(), "worker-1".into()).await.unwrap();

    let report = store.recover().await.unwrap();
    assert_eq!(report.requeued, vec![starting.id.clone()]);
    assert_eq!(report.interrupted, vec![running.id.clone()]);

    let requeued = store.get_run(starting.id).await.unwrap();
    assert_eq!(requeued.status, TaskRunStatus::Queued);
    assert!(requeued.worker_id.is_none(), "attempt must not be consumed");
    let interrupted = store.get_run(running.id).await.unwrap();
    assert_eq!(interrupted.status, TaskRunStatus::Failed);
    assert_eq!(interrupted.error_code.as_deref(), Some("worker_interrupted"));
}

#[tokio::test]
async fn recovery_marks_resident_sessions_crashed_without_failing_runs() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.mode = dbx_core::scheduler::TaskExecutionMode::Resident;
    save(&store, task).await;
    let run = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    store.claim("worker-1".into(), Utc::now()).await.unwrap();
    store.mark_run_started(run.id.clone(), "worker-1".into()).await.unwrap();
    let now = Utc::now().to_rfc3339();
    store
        .upsert_session(ResidentSession {
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

    let report = store.recover().await.unwrap();
    assert_eq!(report.crashed_sessions, vec![run.id.clone()]);
    // Resident runs are reconciled, never failed directly.
    assert_eq!(store.get_run(run.id).await.unwrap().status, TaskRunStatus::Running);
    let sessions = store.list_sessions().await.unwrap();
    assert_eq!(sessions[0].state, ResidentState::Crashed);
}

#[tokio::test]
async fn lease_acquire_heartbeat_release_and_expiry() {
    let (_dir, store) = temp_store();
    assert!(store.acquire_lease(SCHEDULER_LEASE.into(), "worker-1".into(), Duration::from_secs(30)).await.unwrap());
    // Another live worker cannot take it.
    assert!(!store.acquire_lease(SCHEDULER_LEASE.into(), "worker-2".into(), Duration::from_secs(5)).await.unwrap());
    // The holder renews.
    assert!(store.heartbeat_lease(SCHEDULER_LEASE.into(), "worker-1".into(), Duration::from_secs(30)).await.unwrap());
    // Release frees the lease immediately.
    store.release_lease(SCHEDULER_LEASE.into(), "worker-1".into()).await.unwrap();
    assert!(store.acquire_lease(SCHEDULER_LEASE.into(), "worker-2".into(), Duration::from_secs(30)).await.unwrap());
    // The previous holder's heartbeat is rejected after losing the lease.
    assert!(!store.heartbeat_lease(SCHEDULER_LEASE.into(), "worker-1".into(), Duration::from_secs(5)).await.unwrap());
    // Expiry frees the lease for the next worker.
    assert!(store.acquire_lease("short".into(), "worker-1".into(), Duration::from_millis(40)).await.unwrap());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(store.acquire_lease("short".into(), "worker-2".into(), Duration::from_secs(5)).await.unwrap());
}

#[tokio::test]
async fn enqueue_due_coalesce_misfire_runs_once_with_current_time() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Interval { seconds: 3600 });
    task.execution.misfire = TaskMisfirePolicy::Coalesce;
    let next = (Utc::now() - ChronoDuration::hours(6)).to_rfc3339();
    task.next_run_at = Some(next);
    save(&store, task).await;
    let now = Utc::now();
    let enqueued = store.enqueue_due(now).await.unwrap();
    assert_eq!(enqueued.len(), 1, "six missed hourly fires coalesce into one run");
    assert_eq!(enqueued[0].status, TaskRunStatus::Queued);
    let created = enqueued[0].created_at.parse::<chrono::DateTime<Utc>>().unwrap();
    assert!(
        (now - created).num_milliseconds() < 1,
        "coalesce runs at the recovery instant (created {created}, now {now})"
    );
    let task = store.get_task("t1".into()).await.unwrap();
    let advanced = task.next_run_at.unwrap().parse::<chrono::DateTime<Utc>>().unwrap();
    assert!(advanced > now, "next_run_at advanced atomically with the enqueue");
    // A second pass does not enqueue again.
    assert!(store.enqueue_due(Utc::now()).await.unwrap().is_empty());
}

#[tokio::test]
async fn enqueue_due_fire_once_runs_at_last_scheduled_fire() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Interval { seconds: 3600 });
    task.execution.misfire = TaskMisfirePolicy::FireOnce;
    let next = Utc::now() - ChronoDuration::hours(6);
    task.next_run_at = Some(next.to_rfc3339());
    save(&store, task).await;
    let now = Utc::now();
    let enqueued = store.enqueue_due(now).await.unwrap();
    assert_eq!(enqueued.len(), 1);
    let created = enqueued[0].created_at.parse::<chrono::DateTime<Utc>>().unwrap();
    assert!(created > next && created < now, "fire-once runs at the last scheduled fire, not now");
}

#[tokio::test]
async fn enqueue_due_skip_misfire_records_a_skipped_run() {
    let (_dir, store) = temp_store();
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Interval { seconds: 3600 });
    task.execution.misfire = TaskMisfirePolicy::Skip;
    task.next_run_at = Some((Utc::now() - ChronoDuration::hours(6)).to_rfc3339());
    save(&store, task).await;
    let enqueued = store.enqueue_due(Utc::now()).await.unwrap();
    assert!(enqueued.is_empty(), "skip never enqueues");
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, TaskRunStatus::Skipped, "the skipped fire stays traceable");
}

#[tokio::test]
async fn enqueue_due_fires_once_trigger_exactly_once_and_clears_schedule() {
    let (_dir, store) = temp_store();
    let mut task = run_definition(
        "t1",
        "dbx.test",
        TaskTrigger::Once { at: (Utc::now() - ChronoDuration::minutes(1)).to_rfc3339(), time_zone: "UTC".into() },
    );
    task.next_run_at = Some((Utc::now() - ChronoDuration::minutes(1)).to_rfc3339());
    save(&store, task).await;
    let enqueued = store.enqueue_due(Utc::now()).await.unwrap();
    assert_eq!(enqueued.len(), 1);
    let task = store.get_task("t1".into()).await.unwrap();
    assert!(task.next_run_at.is_none(), "once clears next_run_at but keeps the task");
    assert!(task.enabled);
    assert!(store.enqueue_due(Utc::now()).await.unwrap().is_empty());
}

#[tokio::test]
async fn delete_task_blocked_while_runs_are_active() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    let error = store.delete_task("t1".into()).await.unwrap_err();
    assert_eq!(error.code, "run_already_active");
    store.finish_run(run.id, TaskRunStatus::Success, Some(0), None, None).await.unwrap();
    store.delete_task("t1".into()).await.unwrap();
    assert_eq!(store.list_tasks().await.unwrap().len(), 0);
}

#[tokio::test]
async fn artifacts_and_log_index_round_trip() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_run("t1".into(), TaskRunTrigger::Manual, 1, Utc::now()).await.unwrap();
    store
        .save_artifact(
            run.id.clone(),
            dbx_core::scheduler::TaskArtifact {
                name: "dump.sql.gz".into(),
                uri: "/tmp/dump.sql.gz".into(),
                content_type: Some("application/gzip".into()),
                size: Some(1024),
                checksum: None,
            },
        )
        .await
        .unwrap();
    let artifacts = store.list_artifacts(run.id.clone()).await.unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].name, "dump.sql.gz");

    // Log index: two segments for one run (composite (run_id, segment) key).
    store.upsert_log_index(run.id.clone(), 1, store.logs_root().join("a.log"), 100, 5).await.unwrap();
    store.upsert_log_index(run.id.clone(), 2, store.logs_root().join("b.log"), 200, 9).await.unwrap();
    store.upsert_log_index(run.id.clone(), 1, store.logs_root().join("a.log"), 150, 7).await.unwrap();
    let segments = store.log_segments(run.id.clone()).await.unwrap();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0].0, 1);

    let finished = store.finish_run(run.id, TaskRunStatus::Success, Some(0), None, None).await.unwrap();
    assert_eq!(finished.artifacts_count, 1);
}

#[tokio::test]
async fn migration_marker_is_idempotent_and_rolls_back_on_failure() {
    let (_dir, store) = temp_store();
    let migration = dbx_core::scheduler::SchedulerMigration::new(store.clone());
    assert!(!migration.is_applied("legacy-backup").await.unwrap());

    let applied = migration
        .apply("legacy-backup", |conn| {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS legacy_probe (id TEXT PRIMARY KEY)")?;
            conn.execute("INSERT INTO legacy_probe(id) VALUES('row')", [])?;
            Ok(())
        })
        .await
        .unwrap();
    assert!(applied, "first apply runs the body");
    assert!(migration.is_applied("legacy-backup").await.unwrap());
    let applied = migration.apply("legacy-backup", |_| Ok(())).await.unwrap();
    assert!(!applied, "second apply is a no-op");

    // A failing body must not write the marker; the migration can be retried.
    let error = migration
        .apply("failing", |conn| {
            conn.execute_batch("CREATE TABLE failing_probe (id TEXT PRIMARY KEY)")?;
            Err(dbx_core::scheduler::TaskError::internal("boom"))
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "internal");
    assert!(!migration.is_applied("failing").await.unwrap());
    let applied = migration
        .apply("failing", |conn| {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='failing_probe')",
                [],
                |row| row.get(0),
            )?;
            assert!(!exists, "failed migration must roll back its schema changes");
            Ok(())
        })
        .await
        .unwrap();
    assert!(applied, "retry after failure runs the full body");
}

// The task-center page fires its first three reads concurrently, and before
// the one-shot `ensure_schema` every connection re-ran
// `PRAGMA journal_mode=WAL` — a pragma that fails immediately with
// "database is locked" on contention (busy_timeout does not apply). This race
// made the first page open fail intermittently, so pin it: N simultaneous
// cold-start accesses to the same fresh directory must all succeed.
#[tokio::test]
async fn concurrent_cold_start_accesses_all_succeed() {
    let (_dir, store) = temp_store();
    let runtime = tokio::runtime::Handle::current();

    let handles: Vec<_> = (0..8)
        .map(|index| {
            let store = store.clone();
            let runtime = runtime.clone();
            std::thread::spawn(move || {
                runtime.block_on(async move {
                    if index % 3 == 0 {
                        store.list_tasks().await
                    } else if index % 3 == 1 {
                        store.list_runs(None, 10).await.map(|_| Vec::new())
                    } else {
                        store.list_sessions().await.map(|_| Vec::new())
                    }
                })
            })
        })
        .collect();
    for handle in handles {
        let result = handle.join().expect("task thread panicked");
        assert!(result.is_ok(), "concurrent cold-start access failed: {result:?}");
    }
}
