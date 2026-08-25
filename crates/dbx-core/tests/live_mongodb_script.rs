#![cfg(feature = "mongo-js-runtime")]

//! Live MongoDB shell JavaScript integration coverage.
//!
//! Native driver:
//! ```text
//! DBX_LIVE_MONGODB_URL='mongodb://root:123456@127.0.0.1:10400/?authSource=admin' \
//!   cargo test -p dbx-core --test live_mongodb_script native -- --ignored --nocapture
//! ```
//!
//! MongoDB 3.4 Legacy Agent:
//! ```text
//! DBX_LIVE_MONGODB_LEGACY_HOST='127.0.0.1' \
//! DBX_LIVE_MONGODB_LEGACY_PORT='10402' \
//! DBX_LIVE_MONGODB_AGENT_JAR='agents/drivers/mongodb/build/libs/dbx-agent-mongodb.jar' \
//!   cargo test -p dbx-core --test live_mongodb_script legacy -- --ignored --nocapture
//! ```

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use dbx_core::agent_connection::agent_connect_params;
use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
use dbx_core::db::mongo_driver;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::mongo_script::{
    execute_mongo_script_managed_core, mongo_script_error_kind, MongoScriptErrorKind, MongoScriptLimits,
    MongoScriptRequest,
};
use dbx_core::storage::Storage;
use serde_json::json;

fn connection_config(
    id: &str,
    database: &str,
    driver_profile: Option<&str>,
    host: &str,
    port: u16,
) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id,
        "name": format!("Live MongoDB script {id}"),
        "db_type": DatabaseType::MongoDb,
        "driver_profile": driver_profile,
        "host": host,
        "port": port,
        "username": "",
        "password": "",
        "database": database,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 120,
        "idle_timeout_secs": 120,
        "keepalive_interval_secs": 0
    }))
    .expect("live MongoDB config")
}

async fn app_state() -> (Arc<AppState>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_dir(storage, directory.path().join("plugins")));
    (state, directory)
}

fn request(connection_id: &str, database: &str, source: impl Into<String>, execution_id: &str) -> MongoScriptRequest {
    MongoScriptRequest {
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        source: source.into(),
        execution_id: Some(execution_id.to_string()),
        max_rows: 100,
        timeout_secs: Some(120),
        dangerous_operation_confirmed: true,
    }
}

fn live_limits() -> MongoScriptLimits {
    MongoScriptLimits { safety_timeout: Duration::from_secs(120), ..MongoScriptLimits::default() }
}

async fn execute(
    state: Arc<AppState>,
    connection_id: &str,
    database: &str,
    source: impl Into<String>,
    execution_id: &str,
) -> Result<dbx_core::mongo_script::MongoScriptResult, String> {
    execute_mongo_script_managed_core(state, request(connection_id, database, source, execution_id), live_limits())
        .await
}

async fn assert_live_matrix(state: Arc<AppState>, connection_id: &str, database: &str) {
    let loop_result = execute(
        state.clone(),
        connection_id,
        database,
        r#"
        for (var index = 0; index < 1000; index++) {
          db.large_test.insertOne({ _id: index })
        }
        "#,
        "live-issue-loop",
    )
    .await
    .unwrap();
    assert_eq!(loop_result.operation_count, 1000);
    assert_eq!(loop_result.succeeded_operation_count, 1000);

    let verification = execute(
        state.clone(),
        connection_id,
        database,
        r#"
        const count = db.large_test.countDocuments({});
        const sample = db.large_test.findOne({ _id: 999 });
        const sampleId = sample._id && sample._id.$numberLong
          ? Number(sample._id.$numberLong)
          : sample._id;
        if (count === 1000 && sampleId === 999) {
          db.branch_probe.insertOne({ _id: "verified", count });
        }
        printjson({ count, sample });
        ({ count, sample });
        "#,
        "live-verify-loop",
    )
    .await
    .unwrap();
    assert_eq!(verification.operation_count, 3);
    assert_eq!(verification.succeeded_operation_count, 3);
    assert_eq!(verification.final_value.as_ref().and_then(|value| value.get("count")), Some(&json!(1000)));
    let sample_id = verification.final_value.as_ref().and_then(|value| value.pointer("/sample/_id"));
    assert!(sample_id == Some(&json!(999)) || sample_id == Some(&json!({ "$numberLong": "999" })));
    assert!(verification.output.iter().any(
        |output| matches!(output, dbx_core::mongo_script::MongoScriptOutput::Json(value) if value["count"] == 1000)
    ));

    let partial_error = execute(
        state.clone(),
        connection_id,
        database,
        r#"
        db.partial_probe.insertOne({ _id: "duplicate" });
        db.partial_probe.insertOne({ _id: "duplicate" });
        "#,
        "live-partial-failure",
    )
    .await
    .unwrap_err();
    assert_eq!(mongo_script_error_kind(&partial_error), Some(MongoScriptErrorKind::Host));
    assert!(partial_error.contains("1 of 2 attempted operations succeeded"), "{partial_error}");
}

async fn assert_cancellation(state: Arc<AppState>, connection_id: &str, database: &str) {
    let cpu_state = state.clone();
    let cpu_connection = connection_id.to_string();
    let cpu_database = database.to_string();
    let cpu_task = tokio::spawn(async move {
        execute(cpu_state, &cpu_connection, &cpu_database, "while (true) {}", "live-cancel-cpu").await
    });
    wait_for_registration(&state, "live-cancel-cpu").await;
    assert!(state.running_queries.cancel("live-cancel-cpu"));
    let cpu_error = tokio::time::timeout(Duration::from_secs(5), cpu_task)
        .await
        .expect("CPU-only cancellation timeout")
        .unwrap()
        .unwrap_err();
    assert_eq!(mongo_script_error_kind(&cpu_error), Some(MongoScriptErrorKind::Cancelled));

    let database_state = state.clone();
    let database_connection = connection_id.to_string();
    let database_name = database.to_string();
    let database_task = tokio::spawn(async move {
        execute(
            database_state,
            &database_connection,
            &database_name,
            r#"
            let index = 0;
            while (true) {
              db.cancel_probe.insertOne({ _id: index++ });
            }
            "#,
            "live-cancel-database",
        )
        .await
    });
    wait_for_registration(&state, "live-cancel-database").await;
    tokio::time::sleep(Duration::from_millis(75)).await;
    assert!(state.running_queries.cancel("live-cancel-database"));
    let database_error = tokio::time::timeout(Duration::from_secs(5), database_task)
        .await
        .expect("database-operation cancellation timeout")
        .unwrap()
        .unwrap_err();
    assert_eq!(mongo_script_error_kind(&database_error), Some(MongoScriptErrorKind::Cancelled));

    let count =
        execute(state.clone(), connection_id, database, "db.cancel_probe.countDocuments({});", "live-cancel-count")
            .await
            .unwrap()
            .final_value
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
    assert!(count > 0, "the cancelled loop must have entered real database operations");
}

async fn wait_for_registration(state: &AppState, execution_id: &str) {
    for _ in 0..200 {
        if state.running_queries.diagnostics().active_execution_ids.iter().any(|id| id == execution_id) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("execution {execution_id} was not registered");
}

async fn cleanup(state: Arc<AppState>, connection_id: &str, database: &str) {
    let _ = execute(state, connection_id, database, "db.runCommand({ dropDatabase: 1 });", "live-cleanup").await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing at a writable MongoDB database"]
async fn native_driver_executes_and_cancels_real_shell_scripts() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let database = format!("dbx_live_script_native_{}", std::process::id());
    let connection_id = "live-mongodb-script-native";
    let config = connection_config(connection_id, &database, None, "127.0.0.1", 27017);
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(120)).await.unwrap();
    let (state, _directory) = app_state().await;
    state.configs.write().await.insert(connection_id.to_string(), config);
    state.connections.write().await.insert(connection_id.to_string(), PoolKind::MongoDb(client));

    cleanup(state.clone(), connection_id, &database).await;
    assert_live_matrix(state.clone(), connection_id, &database).await;
    assert_cancellation(state.clone(), connection_id, &database).await;
    cleanup(state, connection_id, &database).await;
}

#[tokio::test]
#[ignore = "requires MongoDB 3.4 and DBX_LIVE_MONGODB_AGENT_JAR"]
async fn legacy_agent_executes_real_single_and_bulk_shell_writes() {
    let host = std::env::var("DBX_LIVE_MONGODB_LEGACY_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_MONGODB_LEGACY_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(27017);
    let jar = PathBuf::from(std::env::var("DBX_LIVE_MONGODB_AGENT_JAR").expect("DBX_LIVE_MONGODB_AGENT_JAR"))
        .canonicalize()
        .expect("canonical MongoDB agent jar path");
    let java = std::env::var("DBX_LIVE_JAVA").unwrap_or_else(|_| "java".to_string());
    let database = format!("dbx_live_script_legacy_{}", std::process::id());
    let connection_id = "live-mongodb-script-legacy";
    let config = connection_config(connection_id, &database, Some("mongodb-legacy"), &host, port);
    let mut client = AgentDriverClient::spawn(AgentLaunchSpec {
        program: PathBuf::from(java),
        args: vec!["-jar".to_string(), jar.to_string_lossy().into_owned()],
        working_dir: jar.parent().map(PathBuf::from),
    })
    .await
    .unwrap();
    client
        .connect(json!({
            "connection": agent_connect_params(&config, &config.host, config.port, &database)
        }))
        .await
        .unwrap();
    let (state, _directory) = app_state().await;
    state.configs.write().await.insert(connection_id.to_string(), config);
    state.connections.write().await.insert(connection_id.to_string(), PoolKind::agent(client));

    cleanup(state.clone(), connection_id, &database).await;
    assert_live_matrix(state.clone(), connection_id, &database).await;

    let bulk = execute(
        state.clone(),
        connection_id,
        &database,
        "db.bulk_probe.insertMany([{ _id: 1 }, { _id: 2 }]);",
        "live-legacy-bulk",
    )
    .await
    .unwrap();
    assert_eq!(bulk.operation_count, 1);
    assert_eq!(bulk.succeeded_operation_count, 1);
    assert_eq!(bulk.final_value, Some(json!({ "acknowledged": true, "affectedRows": 2 })));

    cleanup(state, connection_id, &database).await;
}
