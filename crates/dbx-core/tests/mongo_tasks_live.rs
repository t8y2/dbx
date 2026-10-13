//! Explicit opt-in isolated MongoDB task-service integration (never a saved user connection).
use std::{sync::Arc, time::Duration};
use futures::TryStreamExt;
use dbx_core::{connection::AppState, models::connection::ConnectionConfig, mongo_tasks::{MongoTask, MongoTaskCommand, MongoTaskRun, MongoTaskService, MongoTaskSnapshot, MongoTaskStep}};
use mongodb::{bson::{doc, Document}, Client};
use tokio_util::sync::CancellationToken;

async fn snapshot(service: &MongoTaskService) -> MongoTaskSnapshot {
    serde_json::from_value(service.command(MongoTaskCommand::Snapshot).await.unwrap()).unwrap()
}

async fn finished(service: &MongoTaskService, id: &str) -> MongoTaskRun {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(run) = snapshot(service).await.runs.into_iter().find(|run| run.id == id && run.completed_at.is_some()) { return run; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.expect("task completion deadline")
}

#[tokio::test]
#[ignore = "requires a disposable loopback MongoDB from scripts/mongo-native-integration.cjs"]
async fn native_task_reads_cancels_times_out_and_releases_cursors() {
    let port: u16 = std::env::var("DBX_MONGO_FIXTURE_PORT").expect("explicit disposable fixture port").parse().unwrap();
    let uri = format!("mongodb://127.0.0.1:{port}/?directConnection=true");
    let client = Client::with_uri_str(&uri).await.unwrap();
    let database = format!("dbx_native_tasks_{}", uuid::Uuid::new_v4().simple());
    let db = client.database(&database);
    let docs = (0..200).map(|n| doc! {"n": n, "secret": "fixture-only"}).collect::<Vec<_>>();
    db.collection("items").insert_many(docs).await.unwrap();
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let connection: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "fixture", "name": "Disposable Mongo task integration", "db_type": "mongodb",
        "host": "127.0.0.1", "port": port, "username": "", "password": "", "database": database, "connection_string": uri,
        "save_password": true, "connect_timeout_secs": 3, "query_timeout_secs": 10
    })).unwrap();
    storage.save_connections(&[connection]).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
    let service = MongoTaskService::new(state.clone(), directory.path());
    let stop = CancellationToken::new();
    let worker = service.start(stop.clone());
    let step = MongoTaskStep { name: "Read fixture".into(), connection_id: "fixture".into(), database: database.clone(), collection: "items".into(), kind: "find".into(), query: serde_json::json!({}), max_rows: 10, timeout_seconds: 5 };
    let task = MongoTask { id: "native-fixture".into(), name: "Native fixture".into(), enabled: false, interval_minutes: 1, steps: vec![step.clone(), step], revision: String::new(), next_run_at: None };
    let saved: MongoTask = serde_json::from_value(service.command(MongoTaskCommand::Save { task }).await.unwrap()).unwrap();
    let run: MongoTaskRun = serde_json::from_value(service.command(MongoTaskCommand::Run { id: saved.id.clone(), revision: saved.revision.clone() }).await.unwrap()).unwrap();
    let result = finished(&service, &run.id).await;
    assert_eq!(result.status, "success", "{:?}", result.error);
    assert_eq!(result.results.len(), 2);
    assert!(result.results.iter().all(|r| r.returned_rows == 10 && r.sample.len() == 5 && r.row_limit_reached));
    // A fixture-only server failpoint makes a real aggregate wait predictably.
    // This is possible only because the fixture process enables test commands.
    let admin = client.database("admin");
    for cancel in [false, true] {
        let mut task = saved.clone();
        task.id = if cancel { "cancel" } else { "timeout" }.into(); task.revision.clear();
        task.steps[0].timeout_seconds = if cancel { 10 } else { 1 };
        let task: MongoTask = serde_json::from_value(service.command(MongoTaskCommand::Save { task }).await.unwrap()).unwrap();
        let configured = admin.run_command(doc! {"configureFailPoint": "failCommand", "mode": {"times": 1}, "data": {"failCommands": ["aggregate"], "blockConnection": true, "blockTimeMS": 5000}}).await.unwrap();
        let run: MongoTaskRun = serde_json::from_value(service.command(MongoTaskCommand::Run { id: task.id, revision: task.revision }).await.unwrap()).unwrap();
        if cancel {
            let count = configured.get("count").and_then(|v| v.as_i64().or_else(|| v.as_i32().map(i64::from))).unwrap();
            admin.run_command(doc! {"waitForFailPoint": "failCommand", "timesEntered": count + 1, "maxTimeMS": 10000}).await.unwrap();
            service.command(MongoTaskCommand::Cancel { id: run.id.clone() }).await.unwrap();
        }
        let result = finished(&service, &run.id).await;
        assert_eq!(result.status, if cancel { "cancelled" } else { "failed" });
        assert!(result.results.is_empty(), "later steps must not start");
        if !cancel { assert!(result.error.as_deref().unwrap().contains("timeout")); }
        admin.run_command(doc! {"configureFailPoint": "failCommand", "mode": "off"}).await.unwrap();
    }
    let mut scheduled = saved;
    scheduled.id = "scheduled".into();
    scheduled.revision.clear();
    scheduled.enabled = true;
    scheduled.steps.truncate(1);
    service.command(MongoTaskCommand::Save { task: scheduled }).await.unwrap();
    let scheduled_run = tokio::time::timeout(Duration::from_secs(80), async {
        loop {
            if let Some(run) = snapshot(&service).await.runs.into_iter().find(|run| run.task_id == "scheduled" && run.completed_at.is_some()) { break run; }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }).await.expect("backend must execute the one-minute schedule without any UI timer");
    assert_eq!(scheduled_run.trigger, "schedule");
    assert_eq!(scheduled_run.status, "success", "{:?}", scheduled_run.error);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(10), worker).await.unwrap().unwrap();
    state.shutdown(Duration::from_secs(3)).await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    let status = admin.run_command(doc! {"serverStatus": 1}).await.unwrap();
    let cursors = status.get_document("metrics").unwrap().get_document("cursor").unwrap().get_document("open").unwrap();
    let operations: Vec<Document> = admin.aggregate(vec![doc! {"$currentOp": {"allUsers": true, "idleCursors": true}}]).await.unwrap().try_collect().await.unwrap();
    let task_cursors: Vec<&Document> = operations.iter().filter(|operation| operation.get_str("type").ok() == Some("idleCursor") && operation.get_str("ns").is_ok_and(|namespace| namespace.starts_with(&database))).collect();
    assert_eq!(cursors.get_i64("total").unwrap(), 0, "fixture server must not retain task cursors: {task_cursors:?}");
    db.drop().await.unwrap();
}
