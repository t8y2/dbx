//! Engine tests (plan §84–90): manual/scheduled/once/interval/startup flows,
//! retry classification, timeout with real cancellation, cancel, concurrency
//! policies, misfire and the full `run()` lifecycle including lease release.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use dbx_core::scheduler::ResidentState;
use dbx_core::scheduler::{
    LeaseGuard, TaskConcurrencyPolicy, TaskExecutionMode, TaskRestartPolicy, TaskRunStatus, TaskRunTrigger,
    TaskTrigger, SCHEDULER_LEASE,
};
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn manual_run_executes_and_persists_logs() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::Succeed);
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();

    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);
    assert_eq!(finished.worker_id.as_deref(), Some("worker-1"));
    assert!(finished.started_at.is_some() && finished.completed_at.is_some());
    assert_eq!(executor.execution_count(), 1);

    // Logs were persisted under the run and sequenced from 1.
    let page = store.list_logs(run.id.clone(), Default::default()).await.unwrap();
    let messages: Vec<&str> = page.entries.iter().map(|entry| entry.message.as_str()).collect();
    assert!(messages.iter().any(|m| m.contains("executing run")), "executor output persisted");
    assert!(page.entries.windows(2).all(|w| w[0].seq < w[1].seq), "seq strictly increasing");
    assert_eq!(page.entries[0].seq, 1);

    // Task bookkeeping updated.
    let task = store.get_task("t1").await.unwrap();
    assert_eq!(task.last_run_status, Some(TaskRunStatus::Success));
}

#[tokio::test]
async fn missing_provider_fails_the_run_without_retry() {
    let (_dir, store) = temp_store();
    let engine = engine(&store, registry_with(TestExecutor::new(Behavior::Succeed)), "worker-1");
    save(&store, run_definition("t1", "dbx.nope", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Failed]).await;
    assert_eq!(finished.error_code.as_deref(), Some("provider_not_found"));
}

#[tokio::test]
async fn retryable_errors_are_retried_up_to_max_attempts() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::FailNTimes(1));
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.retry.max_attempts = 3;
    task.execution.retry.backoff_seconds = 0;
    save(&store, task).await;
    store.enqueue_manual("t1".into()).await.unwrap();

    // Drive until the retry chain settles: two attempts, the second succeeds.
    for _ in 0..300 {
        engine.tick().await.unwrap();
        let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
        if executor.execution_count() >= 2 && runs.iter().all(|r| r.status.is_terminal()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(executor.execution_count(), 2, "one retry after the scripted failure");
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    assert_eq!(runs.len(), 2, "the retry is a new run");
    assert!(runs.iter().any(|r| r.status == TaskRunStatus::Success));
    let retry = runs.iter().find(|r| r.attempt == 2).expect("attempt 2 run exists");
    assert_eq!(retry.trigger, TaskRunTrigger::Retry);
}

#[tokio::test]
async fn non_retryable_errors_are_never_retried() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::FailNonRetryable);
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.retry.max_attempts = 5;
    save(&store, task).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Failed]).await;
    assert_eq!(finished.error_code.as_deref(), Some("invalid_config"));
    assert_eq!(executor.execution_count(), 1, "invalid config is not retried");
    assert_eq!(store.list_runs(Some("t1".into()), 10).await.unwrap().len(), 1);
}

#[tokio::test]
async fn retry_stops_after_max_attempts() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::FailRetryable);
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.retry.max_attempts = 3;
    task.execution.retry.backoff_seconds = 0;
    save(&store, task).await;
    let _run = store.enqueue_manual("t1".into()).await.unwrap();

    // Drive until no queued/starting/running run remains.
    for _ in 0..300 {
        engine.tick().await.unwrap();
        let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
        if runs.iter().all(|r| r.status.is_terminal()) && runs.len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(executor.execution_count(), 3, "attempts are capped at max_attempts");
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    let mut attempts: Vec<u32> = runs.iter().map(|r| r.attempt).collect();
    attempts.sort_unstable();
    assert_eq!(attempts, vec![1, 2, 3]);
    assert!(runs.iter().all(|r| r.status == TaskRunStatus::Failed));
}

#[tokio::test]
async fn timeout_cancels_the_token_and_marks_the_run_timeout() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::SleepThenSucceed(Duration::from_secs(60)));
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.timeout_seconds = Some(1);
    save(&store, task).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();

    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Timeout]).await;
    assert_eq!(finished.status, TaskRunStatus::Timeout);
    assert_eq!(finished.error_code.as_deref(), Some("timeout"));
    // The cancellation token really reached the executor (ADR §2.5).
    assert!(executor.cancellations_seen().contains(&run.id), "executor must observe the timeout cancellation");
    assert_eq!(store.list_runs(Some("t1".into()), 10).await.unwrap().len(), 1);
}

#[tokio::test]
async fn explicit_cancel_stops_the_executor_and_finalizes_cancelled() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::WaitCancelled);
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();

    // Wait until the run is executing, then cancel through the service path.
    drive_until(&engine, || async {
        store.get_run(run.id.clone()).await.map(|r| r.status == TaskRunStatus::Running).unwrap_or(false)
    })
    .await;
    let service = dbx_core::scheduler::SchedulerService::new(store.clone(), engine.registry().clone());
    assert!(service.cancel_run(&run.id).await.unwrap());
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Cancelled]).await;
    assert_eq!(finished.status, TaskRunStatus::Cancelled);
    assert!(executor.cancellations_seen().contains(&run.id), "cancellation must reach the executor");
}

#[tokio::test]
async fn queued_run_can_be_cancelled_without_dispatch() {
    let (_dir, store) = temp_store();
    let engine = engine(&store, registry_with(TestExecutor::new(Behavior::Succeed)), "worker-1");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    assert!(store.request_cancel(run.id.clone()).await.unwrap());
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Cancelled]).await;
    assert_eq!(finished.status, TaskRunStatus::Cancelled);
}

#[tokio::test]
async fn parallel_policy_executes_runs_concurrently() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::SleepThenSucceed(Duration::from_millis(300)));
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.concurrency = TaskConcurrencyPolicy::Parallel;
    save(&store, task).await;
    let first = store.enqueue_manual("t1".into()).await.unwrap();
    let second = store.enqueue_manual("t1".into()).await.unwrap();

    let (a, b) = tokio::join!(
        drive_until_terminal(&engine, &store, &first.id, &[TaskRunStatus::Success]),
        drive_until_terminal(&engine, &store, &second.id, &[TaskRunStatus::Success])
    );
    assert_eq!(a.status, TaskRunStatus::Success);
    assert_eq!(b.status, TaskRunStatus::Success);
}

#[tokio::test]
async fn queue_policy_runs_one_after_another() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::SleepThenSucceed(Duration::from_millis(200)));
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.concurrency = TaskConcurrencyPolicy::Queue;
    save(&store, task).await;
    let first = store.enqueue_manual("t1".into()).await.unwrap();
    // Ensure distinct created_at ordering between the two enqueues.
    tokio::time::sleep(Duration::from_millis(20)).await;
    let second = store.enqueue_manual("t1".into()).await.unwrap();

    let (a, b) = tokio::join!(
        drive_until_terminal(&engine, &store, &first.id, &[TaskRunStatus::Success]),
        drive_until_terminal(&engine, &store, &second.id, &[TaskRunStatus::Success])
    );
    assert_eq!(a.status, TaskRunStatus::Success);
    assert_eq!(b.status, TaskRunStatus::Success);
    // Strict serialization: the second execution starts after the first ends.
    let executions = executor.executions();
    assert_eq!(executions.len(), 2);
    assert_eq!(executions[0], first.id, "claim order follows created_at");
    assert_eq!(executions[1], second.id);
}

#[tokio::test]
async fn scheduled_interval_runs_fire_repeatedly() {
    let (_dir, store) = temp_store();
    let engine = engine(&store, registry_with(TestExecutor::new(Behavior::Succeed)), "worker-1");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Interval { seconds: 1 })).await;
    drive_until(&engine, || async {
        store.list_runs(Some("t1".into()), 10).await.map(|runs| runs.len() >= 2).unwrap_or(false)
    })
    .await;
    let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
    assert!(runs.iter().any(|r| r.trigger == TaskRunTrigger::Scheduled));
}

#[tokio::test]
async fn startup_trigger_fires_once_per_engine_start() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::Succeed);
    let engine = Arc::new(
        dbx_core::scheduler::SchedulerEngine::new(
            store.clone(),
            registry_with(executor.clone()),
            "worker-1",
            Duration::from_millis(20),
        )
        .with_lease_ttl(Duration::from_secs(30)),
    );
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Startup)).await;
    // Startup runs are enqueued by the engine lifecycle, not by tick.
    let shutdown = CancellationToken::new();
    let handle = {
        let engine = engine.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move { engine.run(shutdown).await })
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
        if runs.len() == 1 && runs[0].status == TaskRunStatus::Success && runs[0].trigger == TaskRunTrigger::Startup {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "startup run did not finish in time");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Exactly one startup run per engine start.
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(store.list_runs(Some("t1".into()), 10).await.unwrap().len(), 1);
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(10), handle).await.expect("engine shuts down").unwrap();
}

#[tokio::test]
async fn artifacts_from_executor_are_persisted() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::EmitArtifact);
    let engine = engine(&store, registry_with(executor.clone()), "worker-1");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.artifacts_count, 1);
    let artifacts = store.list_artifacts(run.id).await.unwrap();
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0].name, "out.txt");
    assert!(artifacts[0].size.unwrap() > 0);
}

#[tokio::test]
async fn engine_run_lifecycle_executes_releases_lease_and_shuts_down_cleanly() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::Succeed);
    let registry = registry_with(executor.clone());
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Interval { seconds: 1 })).await;

    let engine = Arc::new(
        dbx_core::scheduler::SchedulerEngine::new(store.clone(), registry, "worker-1", Duration::from_millis(20))
            .with_lease_ttl(Duration::from_secs(2)),
    );
    let shutdown = CancellationToken::new();
    let handle = {
        let engine = engine.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move { engine.run(shutdown).await })
    };

    // The engine claims the lease and runs the task repeatedly.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let runs = store.list_runs(Some("t1".into()), 10).await.unwrap();
        if runs.iter().any(|r| r.status == TaskRunStatus::Success) {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "engine did not execute the task in time");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // Another worker cannot take the lease while worker-1 lives.
    assert!(LeaseGuard::acquire(&store, SCHEDULER_LEASE, "worker-2", Duration::from_millis(200))
        .await
        .unwrap()
        .is_none());

    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(10), handle).await.expect("engine shuts down").unwrap();

    // Lease released, nothing stuck.
    let guard = LeaseGuard::acquire(&store, SCHEDULER_LEASE, "worker-2", Duration::from_secs(5)).await.unwrap();
    assert!(guard.is_some(), "graceful shutdown releases the lease");
    let runs = store.list_runs(Some("t1".into()), 50).await.unwrap();
    assert!(runs.iter().all(|r| r.status.is_terminal()), "no run is left pending after shutdown");
}

#[tokio::test]
async fn second_engine_without_lease_never_executes() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::Succeed);
    let registry = registry_with(executor.clone());
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;

    // Engine-1 holds the lease.
    let guard = LeaseGuard::acquire(&store, SCHEDULER_LEASE, "worker-1", Duration::from_secs(30))
        .await
        .unwrap()
        .expect("first worker takes the lease");
    let engine = Arc::new(
        dbx_core::scheduler::SchedulerEngine::new(store.clone(), registry, "worker-2", Duration::from_millis(10))
            .with_lease_ttl(Duration::from_millis(100)),
    );
    let shutdown = CancellationToken::new();
    let handle = {
        let engine = engine.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move { engine.run(shutdown).await })
    };
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(executor.execution_count(), 0, "a worker without the lease must not run tasks");
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(5), handle).await.expect("shutdown").unwrap();
    guard.release().await;

    // Now the run can be claimed by the lease holder.
    let engine1 = common::engine(&store, registry_with(TestExecutor::new(Behavior::Succeed)), "worker-1");
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    let finished = drive_until_terminal(&engine1, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);
}

#[tokio::test]
async fn resident_mode_dispatches_through_resident_executor() {
    let (_dir, store) = temp_store();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    let resident = TestResidentExecutor::new();
    registry.register_resident("dbx.test", Arc::new(resident.clone()));
    let engine = engine(&store, registry, "worker-1");

    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.mode = TaskExecutionMode::Resident;
    save(&store, task).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();

    drive_until(&engine, || async { store.list_sessions().await.map(|s| !s.is_empty()).unwrap_or(false) }).await;
    // The run stays running while the session lives.
    let current = store.get_run(run.id.clone()).await.unwrap();
    assert_eq!(current.status, TaskRunStatus::Running);

    // Session reports stopped → run succeeds.
    let session_id = resident.last_session_id();
    resident.set_state(&session_id, dbx_core::scheduler::ResidentState::Stopped);
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);
    assert_eq!(resident.starts().len(), 1);
}

#[tokio::test]
async fn engine_broadcasts_run_state_events_to_registered_sinks() {
    use std::sync::Mutex;

    // The sink registry is process-global and tests run in parallel; filter
    // for this test's unique task id before recording.
    let received: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    dbx_core::scheduler::register_event_sink(
        "engine-events-test",
        Arc::new(move |event| {
            if event["taskId"] == "evt-bridge" {
                sink.lock().unwrap().push(event.clone());
            }
        }),
    );

    let (_dir, store) = temp_store();
    let engine = engine(&store, registry_with(TestExecutor::new(Behavior::Succeed)), "worker-evt");
    save(&store, run_definition("evt-bridge", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("evt-bridge".into()).await.unwrap();
    let finished = drive_until_terminal(&engine, &store, &run.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);

    let events = received.lock().unwrap();
    let states: Vec<(&str, &str)> =
        events.iter().filter_map(|e| Some((e["type"].as_str()?, e["status"].as_str()?))).collect();
    assert_eq!(states, vec![("run-state", "running"), ("run-state", "success")]);
    assert!(events.iter().all(|e| e["runId"] == run.id), "every event carries the run id");
}

// A successful status probe must persist the liveness heartbeat. Without
// this write the supervisor's stale-heartbeat check compares against the
// session's START time forever, so the first probe hiccup after 60s crashes
// a perfectly healthy session and burns a restart (the production loop).
#[tokio::test]
async fn a_successful_probe_refreshes_the_session_heartbeat() {
    let (_dir, store) = temp_store();
    let resident = TestResidentExecutor::new();
    let registry = Arc::new(dbx_core::scheduler::TaskExecutorRegistry::new());
    registry.register_resident("dbx.test", Arc::new(resident.clone()));
    let engine = engine(&store, registry.clone(), "hb-worker");
    let service = dbx_core::scheduler::SchedulerService::new(store.clone(), registry);

    let mut task = run_definition("t1", "dbx.test", TaskTrigger::Manual);
    task.execution.mode = TaskExecutionMode::Resident;
    task.execution.restart =
        Some(TaskRestartPolicy { enabled: true, max_restarts: 5, backoff_seconds: 0, restart_window_seconds: None });
    save(&store, task).await;
    let run = service.run_now("t1").await.unwrap();
    drive_until(&engine, || async { store.list_sessions().await.map(|s| !s.is_empty()).unwrap_or(false) }).await;

    // Age the heartbeat far past the supervision timeout.
    let session = store.active_session_for_task("t1".to_owned()).await.unwrap().expect("active session");
    let mut aged = session.clone();
    aged.heartbeat_at = Some((chrono::Utc::now() - chrono::Duration::seconds(600)).to_rfc3339());
    store.upsert_session(aged).await.unwrap();

    engine.tick().await.expect("probe tick");

    let refreshed = store.active_session_for_task("t1".to_owned()).await.unwrap().expect("session still there");
    assert_eq!(refreshed.state, ResidentState::Running);
    let heartbeat = chrono::DateTime::parse_from_rfc3339(refreshed.heartbeat_at.as_deref().expect("heartbeat written"))
        .expect("parse heartbeat");
    let age = chrono::Utc::now() - heartbeat.with_timezone(&chrono::Utc);
    assert!(age.num_seconds() < 30, "heartbeat must be refreshed by the probe, aged {age}");
    let _ = run;
}

// Regression (review round 2, issue 1): a worker that has NOT acquired the
// lease must not run recovery on entry — `recover()` rewrites every
// starting/running row regardless of owner, so the old pre-lease call let a
// losing competitor fail the live holder's in-flight run (desktop takeover
// waits 20s against a 90s old-engine grace, so overlapping workers are real).
#[tokio::test]
async fn competitor_engine_never_recovers_while_the_lease_is_held() {
    let (_dir, store) = temp_store();
    let registry = registry_with(TestExecutor::new(Behavior::WaitCancelled));

    // worker-1 holds the lease and has a run in flight.
    let guard = LeaseGuard::acquire(&store, SCHEDULER_LEASE, "worker-1", Duration::from_secs(30))
        .await
        .unwrap()
        .expect("holder takes the lease");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let run = store.enqueue_manual("t1".into()).await.unwrap();
    // The holder's dispatch: claim (queued→starting) then mark running — the
    // same invariant the engine's execute path upholds.
    let claimed = store.claim("worker-1".into(), chrono::Utc::now()).await.unwrap().expect("holder claims its run");
    assert_eq!(claimed.run.id, run.id);
    store.mark_run_started(run.id.clone(), "worker-1".into()).await.unwrap();

    // Competitor: the old code recover()d before the lease loop and flipped
    // the holder's running row to failed/worker_interrupted right here.
    let engine = Arc::new(
        dbx_core::scheduler::SchedulerEngine::new(store.clone(), registry, "worker-2", Duration::from_millis(10))
            .with_lease_ttl(Duration::from_millis(100)),
    );
    let shutdown = CancellationToken::new();
    let handle = {
        let engine = engine.clone();
        let shutdown = shutdown.clone();
        tokio::spawn(async move { engine.run(shutdown).await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;

    let current = store.get_run(run.id.clone()).await.unwrap();
    assert_eq!(
        current.status,
        TaskRunStatus::Running,
        "a competitor without the lease must not fail the holder's active run"
    );
    assert_eq!(current.worker_id.as_deref(), Some("worker-1"), "the run must keep its owner");
    shutdown.cancel();
    tokio::time::timeout(Duration::from_secs(5), handle).await.expect("competitor shuts down").unwrap();
    let after = store.get_run(run.id).await.unwrap();
    assert_eq!(
        after.status,
        TaskRunStatus::Running,
        "shutdown of a never-leased worker must not touch the holder's run either"
    );
    guard.release().await;
}

// Regression (review round 2, issue 2): a worker whose lease was taken over
// must stop scheduling. `beat()` treats heartbeat `Ok(false)` as the end of
// its loop; the detached worker leaves queued runs for the new holder
// (canceling them would fight the takeover) and its run() returns.
#[tokio::test]
async fn engine_detaches_after_its_lease_is_taken_over() {
    let (_dir, store) = temp_store();
    let registry = registry_with(TestExecutor::new(Behavior::Succeed));
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;

    // worker-1 holds the lease with a poll interval far longer than the TTL:
    // it cannot renew before the lease expires and stays expired long enough
    // for worker-2 to take over deterministically.
    let engine1 = Arc::new(
        dbx_core::scheduler::SchedulerEngine::new(
            store.clone(),
            registry.clone(),
            "worker-1",
            Duration::from_millis(1000),
        )
        .with_lease_ttl(Duration::from_millis(100)),
    );
    let shutdown1 = CancellationToken::new();
    let handle1 = {
        let engine = engine1.clone();
        let shutdown = shutdown1.clone();
        tokio::spawn(async move { engine.run(shutdown).await })
    };
    tokio::time::sleep(Duration::from_millis(250)).await;

    // worker-2 takes the EXPIRED lease (100ms TTL vs the 250ms sleep) and
    // consumes the queued work.
    let guard2 = LeaseGuard::acquire(&store, SCHEDULER_LEASE, "worker-2", Duration::from_secs(30))
        .await
        .unwrap()
        .expect("worker-2 takes the expired lease");
    let run2 = store.enqueue_manual("t1".into()).await.unwrap();
    let engine2 = engine(&store, registry, "worker-2");
    let finished = drive_until_terminal(&engine2, &store, &run2.id, &[TaskRunStatus::Success]).await;
    assert_eq!(finished.status, TaskRunStatus::Success);
    assert_eq!(finished.worker_id.as_deref(), Some("worker-2"), "the new holder owns the work after takeover");

    // worker-1's next beat observes the takeover and detaches — without the
    // shutdown token firing (this is the lease-lost path, not a shutdown).
    let detached = tokio::time::timeout(Duration::from_secs(5), handle1)
        .await
        .expect("worker-1 must stop scheduling after losing the lease");
    assert!(detached.is_ok());
    assert!(!shutdown1.is_cancelled(), "detachment must be the lease-lost path, not shutdown");
    // The new holder's finished run was not cancelled by worker-1's exit.
    assert_eq!(store.get_run(run2.id).await.unwrap().status, TaskRunStatus::Success);
    guard2.release().await;
}
