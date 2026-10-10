//! Wake-file nudge (manual-trigger latency): scheduler mutations touch
//! `<scheduler dir>/wake` and the engine's watcher ticks immediately, so a
//! manual run or a cancel must not wait out the worker's poll interval (the
//! desktop worker defaults to 10s). These tests run the engine with an
//! hour-long poll interval — only the wake watcher can make progress, which
//! is what makes the assertions meaningful.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{registry_with, run_definition, save, temp_store, Behavior, TestExecutor};
use dbx_core::scheduler::{SchedulerEngine, SchedulerService, TaskRunStatus, TaskTrigger};
use tokio_util::sync::CancellationToken;

fn long_poll_engine(store: &dbx_core::scheduler::SchedulerStore, executor: TestExecutor) -> Arc<SchedulerEngine> {
    Arc::new(
        SchedulerEngine::new(store.clone(), registry_with(executor), "wake-worker", Duration::from_secs(3600))
            .with_lease_ttl(Duration::from_secs(7200)),
    )
}

async fn wait_until(mut condition: impl FnMut() -> bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(condition(), "{what} not reached in time");
}

#[tokio::test]
async fn a_manual_run_is_claimed_promptly_once_the_service_touches_the_wake_file() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::default();
    let engine = long_poll_engine(&store, executor.clone());
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let service = SchedulerService::new(store.clone(), registry_with(executor.clone()));
    let shutdown = CancellationToken::new();
    tokio::spawn(engine.clone().run(shutdown.clone()));

    let run = service.run_now("t1").await.expect("manual run");
    assert!(store.wake_mtime().is_some(), "run_now must touch the wake file");

    // With a 1h poll interval only the wake watcher can claim the run; the
    // executor recording the run proves the wake worked end to end.
    wait_until(|| executor.execution_count() > 0, "wake-driven claim of the manual run").await;
    shutdown.cancel();
    let _ = run;
}

#[tokio::test]
async fn cancelling_a_running_run_stops_it_without_waiting_for_the_poll_interval() {
    let (_dir, store) = temp_store();
    let executor = TestExecutor::new(Behavior::WaitCancelled);
    let engine = long_poll_engine(&store, executor.clone());
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let service = SchedulerService::new(store.clone(), registry_with(executor.clone()));
    let shutdown = CancellationToken::new();
    tokio::spawn(engine.clone().run(shutdown.clone()));

    let run = service.run_now("t1").await.expect("manual run");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = store.get_run(run.id.clone()).await.ok().map(|r| r.status);
        assert!(status != Some(TaskRunStatus::Failed), "run failed instead of starting");
        if status == Some(TaskRunStatus::Running) || Instant::now() >= deadline {
            assert_eq!(status, Some(TaskRunStatus::Running), "wake-driven start not reached in time");
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let accepted = service.cancel_run(&run.id).await.expect("cancel request");
    assert!(accepted);
    // The wake nudge runs `reap`, which fires the executor's token; with a 1h
    // poll interval only that path can settle the run now.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let status = store.get_run(run.id.clone()).await.ok().map(|r| r.status);
        if status == Some(TaskRunStatus::Cancelled) {
            break;
        }
        assert!(Instant::now() < deadline, "wake-driven cancellation not reached in time");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(executor.cancellations_seen(), vec![run.id]);
    shutdown.cancel();
}
