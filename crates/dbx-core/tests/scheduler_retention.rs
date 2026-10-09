//! Run retention (stability): finished runs grow without bound on an
//! always-on desktop — an hourly task alone writes ~880 runs, artifact rows,
//! log-index rows and on-disk log directories per year, and nothing ever
//! deleted them. `prune_finished_runs` removes terminal runs past the age
//! cutoff and beyond the per-task history cap together with their disk
//! traces. Active runs are never touched.

mod common;

use chrono::{Duration as ChronoDuration, Utc};
use common::{registry_with, run_definition, save, temp_store, TestExecutor};
use dbx_core::scheduler::{RunRetentionPolicy, SchedulerStore, TaskRunStatus, TaskRunTrigger, TaskTrigger};

async fn seeded_run(
    store: &SchedulerStore,
    task_id: &str,
    age: ChronoDuration,
    terminal: Option<TaskRunStatus>,
) -> String {
    let run = store
        .enqueue_run(task_id.to_owned(), TaskRunTrigger::Scheduled, 1, Utc::now() - age)
        .await
        .expect("enqueue backdated run");
    if let Some(status) = terminal {
        store.finish_run(run.id.clone(), status, None, None, None).await.expect("finish run");
    }
    run.id
}

async fn status_of(store: &SchedulerStore, run_id: &str) -> Option<TaskRunStatus> {
    store.get_run(run_id.to_owned()).await.ok().map(|run| run.status)
}

fn day_dir(store: &SchedulerStore, run_id: &str, age: ChronoDuration) -> std::path::PathBuf {
    let date = (Utc::now() - age).format("%Y/%m/%d").to_string();
    let dir = store.logs_root().join(date).join(run_id);
    std::fs::create_dir_all(&dir).expect("create log dir");
    std::fs::write(dir.join("run.log"), b"log body").expect("write log");
    dir
}

#[tokio::test]
async fn prune_deletes_age_past_runs_with_artifacts_logs_and_directories() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let old = seeded_run(&store, "t1", ChronoDuration::days(40), Some(TaskRunStatus::Success)).await;
    let fresh = seeded_run(&store, "t1", ChronoDuration::days(1), Some(TaskRunStatus::Success)).await;
    store
        .save_artifact(
            old.clone(),
            dbx_core::scheduler::TaskArtifact {
                name: "out.txt".into(),
                uri: "/tmp/old.txt".into(),
                content_type: None,
                size: None,
                checksum: None,
            },
        )
        .await
        .expect("save artifact");
    store.upsert_log_index(old.clone(), 0, std::path::PathBuf::from("/tmp/old.log"), 10, 1).await.expect("log index");
    let old_log_dir = day_dir(&store, &old, ChronoDuration::days(40));

    let pruned = store.prune_finished_runs(&RunRetentionPolicy::default()).await.expect("prune");

    assert_eq!(pruned, 1);
    assert!(status_of(&store, &old).await.is_none(), "age-past run is gone");
    assert!(status_of(&store, &fresh).await.is_some(), "recent run stays");
    assert!(store.list_artifacts(old.clone()).await.unwrap().is_empty(), "artifacts pruned");
    assert!(store.log_segments(old).await.unwrap().is_empty(), "log index pruned");
    assert!(!old_log_dir.exists(), "on-disk log directory removed");
}

#[tokio::test]
async fn active_runs_are_never_pruned_even_when_old() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let running = seeded_run(&store, "t1", ChronoDuration::days(40), None).await;
    // Mirror the real dispatch lifecycle: claim marks the run `starting`,
    // mark_run_started then makes it `running` (ADR §3.3).
    store.claim("worker-1".to_owned(), Utc::now()).await.expect("claim run");
    store.mark_run_started(running.clone(), "worker-1".to_string()).await.expect("mark started");

    let pruned = store.prune_finished_runs(&RunRetentionPolicy::default()).await.expect("prune");

    assert_eq!(pruned, 0);
    assert_eq!(status_of(&store, &running).await, Some(TaskRunStatus::Running));
}

#[tokio::test]
async fn history_cap_keeps_the_newest_terminal_runs_per_task() {
    let (_dir, store) = temp_store();
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let oldest = seeded_run(&store, "t1", ChronoDuration::days(20), Some(TaskRunStatus::Success)).await;
    seeded_run(&store, "t1", ChronoDuration::days(10), Some(TaskRunStatus::Success)).await;
    seeded_run(&store, "t1", ChronoDuration::days(1), Some(TaskRunStatus::Success)).await;
    let policy = RunRetentionPolicy { older_than_days: 30, keep_per_task: 2 };

    let pruned = store.prune_finished_runs(&policy).await.expect("prune");

    assert_eq!(pruned, 1);
    assert!(status_of(&store, &oldest).await.is_none(), "cap prunes the oldest terminal run");
}

#[tokio::test]
async fn pruning_an_empty_store_is_a_quiet_noop() {
    let (_dir, store) = temp_store();
    let pruned = store.prune_finished_runs(&RunRetentionPolicy::default()).await.expect("prune");
    assert_eq!(pruned, 0);
}

// The engine prunes on its first scheduling pass, then at most once per hour.
#[tokio::test]
async fn the_engine_prunes_on_its_first_tick() {
    let (_dir, store) = temp_store();
    let engine = common::engine(&store, registry_with(TestExecutor::default()), "prune-worker");
    save(&store, run_definition("t1", "dbx.test", TaskTrigger::Manual)).await;
    let old = seeded_run(&store, "t1", ChronoDuration::days(40), Some(TaskRunStatus::Success)).await;

    engine.tick().await.expect("first tick");

    assert!(status_of(&store, &old).await.is_none(), "first tick prunes past-retention runs");
}
