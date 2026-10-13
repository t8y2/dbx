use super::{models::*, store::Store};
use serde_json::json;

fn task() -> MongoTask {
    MongoTask { id: "test-task".into(), name: "Read sample".into(), enabled: false, interval_minutes: 60, revision: String::new(), next_run_at: None, steps: vec![MongoTaskStep { name: "read".into(), connection_id: "test-connection".into(), database: "isolated_test".into(), collection: "items".into(), kind: "find".into(), query: json!({}), max_rows: 100, timeout_seconds: 30 }] }
}

#[test]
fn validates_bounds_and_rejects_writes_and_javascript() {
    let mut task = task();
    assert!(task.validate().is_ok());
    for query in [json!({"$where": "evil()"}), json!({"nested": {"$function": {}}}), json!({"x": {"$accumulator": {}}})] {
        task.steps[0].query = query; assert!(task.validate().is_err());
    }
    task.steps[0].kind = "aggregate".into();
    for pipeline in [json!([{"$out": "target"}]), json!([{"$merge": "target"}]), json!([{"$facet": {"nested": [{"$out": "target"}]}}]), json!([{"$changeStream": {}}]), json!([{"$newUnknownStage": {}}]), json!([{"$lookup": {"from": "items", "pipeline": [{"$newUnknownStage": {}}], "as": "items"}}])] {
        task.steps[0].query = pipeline; assert!(task.validate().is_err());
    }
    task.steps[0].query = json!([{"$match": {}}, {"$facet": {"counts": [{"$count": "n"}]}}]);
    assert!(task.validate().is_ok());
    task.steps[0].max_rows = 0; assert!(task.validate().is_err());
    task.steps[0].max_rows = 1001; assert!(task.validate().is_err());
    task.steps[0].max_rows = 100; task.steps[0].timeout_seconds = 301; assert!(task.validate().is_err());
}

#[test]
fn find_becomes_bounded_read_only_pipeline() {
    let task = task();
    let value: serde_json::Value = serde_json::from_str(&task.steps[0].pipeline().unwrap()).unwrap();
    assert_eq!(value, json!([{"$match": {}}, {"$limit": 100}]));
}

#[tokio::test]
async fn persistence_revisions_single_active_run_and_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path());
    let saved = store.save(task()).await.unwrap();
    assert!(!saved.revision.is_empty());
    assert!(store.save(task()).await.is_err());
    let run = store.run(saved.id.clone(), saved.revision.clone()).await.unwrap();
    assert!(store.run(saved.id.clone(), saved.revision.clone()).await.is_err());
    assert!(store.save(saved.clone()).await.is_err());
    assert!(store.delete(saved.id.clone(), saved.revision.clone()).await.is_err());
    let job = store.claim().await.unwrap().unwrap();
    assert_eq!(job.run.id, run.id);
    assert_eq!(job.run.status, "running");
    assert!(store.claim().await.unwrap().is_none());
    let reopened = Store::new(dir.path());
    reopened.recover().await.unwrap();
    let snapshot = reopened.snapshot().await.unwrap();
    assert_eq!(snapshot.tasks.len(), 1);
    assert_eq!(snapshot.runs[0].status, "interrupted");
    assert!(snapshot.runs[0].completed_at.is_some());
    assert!(reopened.claim().await.unwrap().is_none());
    assert!(reopened.run(saved.id, saved.revision).await.is_ok());
}

#[tokio::test]
async fn queued_cancel_is_durable_and_prevents_claim() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path());
    let saved = store.save(task()).await.unwrap();
    let run = store.run(saved.id, saved.revision).await.unwrap();
    store.cancel(run.id.clone()).await.unwrap();
    assert!(store.cancelled(run.id).await.unwrap());
    assert!(store.claim().await.unwrap().is_none());
    assert_eq!(store.snapshot().await.unwrap().runs[0].status, "cancelled");
}

#[tokio::test]
async fn concurrent_enqueue_is_atomic_across_store_instances() {
    let dir = tempfile::tempdir().unwrap();
    let first = Store::new(dir.path());
    let second = Store::new(dir.path());
    let task = first.save(task()).await.unwrap();
    let (a, b) = tokio::join!(first.run(task.id.clone(), task.revision.clone()), second.run(task.id, task.revision));
    assert_ne!(a.is_ok(), b.is_ok());
    assert_eq!(first.snapshot().await.unwrap().runs.len(), 1);
}

#[tokio::test]
async fn overdue_intervals_coalesce_and_new_schedule_ignores_client_next_time() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path());
    let mut task = task(); task.enabled = true; task.next_run_at = Some("2000-01-01T00:00:00Z".into());
    let saved = store.save(task).await.unwrap();
    assert!(saved.next_run_at.as_deref().unwrap() > "2020");
    let mut overdue = saved; overdue.next_run_at = Some("2000-01-01T00:00:00Z".into());
    let conn = rusqlite::Connection::open(store.directory.join("state.db")).unwrap();
    conn.execute("UPDATE tasks SET payload=? WHERE id=?", rusqlite::params![serde_json::to_string(&overdue).unwrap(), overdue.id]).unwrap();
    drop(conn);
    store.enqueue_due().await.unwrap();
    store.enqueue_due().await.unwrap();
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.runs.len(), 1);
    assert_eq!(snapshot.runs[0].trigger, "schedule");
    assert!(snapshot.tasks[0].next_run_at.as_deref().unwrap() > "2020");
}

#[test]
fn file_lock_prevents_two_workers() {
    let dir = tempfile::tempdir().unwrap();
    let a = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(dir.path().join("worker.lock")).unwrap();
    let b = std::fs::OpenOptions::new().read(true).write(true).open(dir.path().join("worker.lock")).unwrap();
    fs2::FileExt::try_lock_exclusive(&a).unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&b).is_err());
    drop(a);
    assert!(fs2::FileExt::try_lock_exclusive(&b).is_ok());
}

#[tokio::test]
async fn cancel_history_is_bounded_and_does_not_remove_saved_tasks() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path());
    let task = store.save(task()).await.unwrap();
    for _ in 0..105 {
        let run = store.run(task.id.clone(), task.revision.clone()).await.unwrap();
        store.cancel(run.id).await.unwrap();
    }
    let snapshot = store.snapshot().await.unwrap();
    assert_eq!(snapshot.tasks.len(), 1);
    assert_eq!(snapshot.runs.len(), 100);
    assert!(snapshot.runs.iter().all(|run| run.status == "cancelled"));
}

#[tokio::test]
async fn stale_run_and_delete_cannot_operate_on_replaced_definition() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::new(dir.path());
    let first = store.save(task()).await.unwrap();
    let mut edited = first.clone(); edited.name = "Changed".into();
    let second = store.save(edited).await.unwrap();
    assert!(store.run(first.id.clone(), first.revision.clone()).await.is_err());
    assert!(store.delete(first.id, first.revision).await.is_err());
    assert!(store.delete(second.id, second.revision).await.is_ok());
}
