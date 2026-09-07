use std::sync::{Arc, Mutex};
use std::time::Duration;

use dbx_core::agent_events::{ToolCall, ToolResult};
use dbx_core::agent_tools::{execute_tool, AgentSqlPermissions};
use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::mongo_ops::mongo_create_index_core;
use dbx_core::storage::Storage;
use mongodb::bson::{doc, Bson};
use mongodb::event::{command::CommandEvent, EventHandler};
use mongodb::options::ClientOptions;
use mongodb::Client;

fn live_mongodb_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MONGODB_HOST").expect("DBX_LIVE_MONGODB_HOST");
    let port = std::env::var("DBX_LIVE_MONGODB_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(27017);
    let username = std::env::var("DBX_LIVE_MONGODB_USER").expect("DBX_LIVE_MONGODB_USER");
    let password = std::env::var("DBX_LIVE_MONGODB_PASSWORD").expect("DBX_LIVE_MONGODB_PASSWORD");
    let database = std::env::var("DBX_LIVE_MONGODB_DATABASE").expect("DBX_LIVE_MONGODB_DATABASE");
    let auth_source = std::env::var("DBX_LIVE_MONGODB_AUTH_SOURCE").unwrap_or_else(|_| database.clone());

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Live MongoDB agent tools",
        "db_type": DatabaseType::MongoDb,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "url_params": format!("authSource={auth_source}"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MongoDB connection config should deserialize")
}

async fn call_agent_tool(state: &Arc<AppState>, connection_id: &str, database: &str, source: &str) -> ToolResult {
    call_agent_tool_with_limit(state, connection_id, database, source, None).await
}

async fn call_agent_tool_with_limit(
    state: &Arc<AppState>,
    connection_id: &str,
    database: &str,
    source: &str,
    limit: Option<u64>,
) -> ToolResult {
    let mut arguments = serde_json::json!({ "sql": source });
    if let Some(limit) = limit {
        arguments["limit"] = serde_json::json!(limit);
    }
    execute_tool(
        &ToolCall {
            id: "live-mongodb-agent".to_string(),
            name: "execute_query".to_string(),
            arguments,
            provider_payload: None,
        },
        state,
        connection_id,
        database,
        None,
        &DatabaseType::MongoDb,
        AgentSqlPermissions::default(),
    )
    .await
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a MongoDB database with a non-empty stores collection"]
async fn mongodb_agent_find_one_returns_real_data_and_keeps_writes_blocked() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let config = live_mongodb_config("live-mongodb-agent");
    let database = config.database.clone().expect("database");
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let read = call_agent_tool(&state, &config.id, &database, "db.stores.findOne({})").await;
    assert!(!read.is_error, "{}", read.content);
    assert!(read.content.contains("(1 rows,"), "{}", read.content);

    let write =
        call_agent_tool(&state, &config.id, &database, "db.agent_regression.insertOne({marker: 'blocked'})").await;
    assert!(write.is_error);
    assert!(write.content.contains("read-only"), "{}", write.content);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_* env vars pointing at a MongoDB database with a products collection containing at least 8 documents"]
async fn mongodb_agent_enforces_limits_and_find_skips_total_count() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let config = live_mongodb_config("live-mongodb-agent-limits");
    let database = config.database.clone().expect("database");

    let command_names = Arc::new(Mutex::new(Vec::<String>::new()));
    let observed_names = command_names.clone();
    let mut options = ClientOptions::parse(config.connection_url()).await.unwrap();
    options.command_event_handler = Some(EventHandler::callback(move |event| {
        if let CommandEvent::Started(event) = event {
            observed_names.lock().unwrap().push(event.command_name);
        }
    }));
    let client = Client::with_options(options).unwrap();

    state.configs.write().await.insert(config.id.clone(), config.clone());
    state
        .update_connection_pools(|connections| {
            connections.insert(config.id.clone(), PoolKind::MongoDb(client));
        })
        .await;

    let zero_limit =
        call_agent_tool_with_limit(&state, &config.id, &database, "db.products.find({}).limit(0)", Some(0)).await;
    assert!(!zero_limit.is_error, "{}", zero_limit.content);
    assert!(zero_limit.content.contains("(1 rows,"), "{}", zero_limit.content);

    let commands = command_names.lock().unwrap().clone();
    assert!(commands.iter().any(|command| command == "find"), "{commands:?}");
    assert!(!commands.iter().any(|command| command == "count" || command == "aggregate"), "{commands:?}");

    let bounded =
        call_agent_tool_with_limit(&state, &config.id, &database, "db.products.find({}).limit(0)", Some(7)).await;
    assert!(!bounded.is_error, "{}", bounded.content);
    assert!(bounded.content.contains("(7 rows,"), "{}", bounded.content);

    let distinct =
        call_agent_tool_with_limit(&state, &config.id, &database, "db.products.distinct('_id')", Some(7)).await;
    assert!(!distinct.is_error, "{}", distinct.content);
    assert!(distinct.content.contains("(7 rows,"), "{}", distinct.content);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_42_URL pointing at MongoDB 4.2 with enableTestCommands=1"]
async fn stalled_mongodb_index_build_does_not_block_another_connection() {
    let uri = std::env::var("DBX_LIVE_MONGODB_42_URL").expect("DBX_LIVE_MONGODB_42_URL");
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let primary_id = "live-mongodb-42-index";
    let database = "dbx_issue_7720_primary";
    let collection = "records";
    let index_name = "issue_7720_pool_registry";

    let client = Client::with_uri_str(&uri).await.expect("MongoDB 4.2 client");
    let primary_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": primary_id,
        "name": "MongoDB 4.2 stalled index",
        "db_type": DatabaseType::MongoDb,
        "host": "127.0.0.1",
        "port": 17720,
        "username": "",
        "password": "",
        "database": database,
        "connection_string": uri,
        "driver_profile": "mongodb-native",
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(primary_id.to_string(), primary_config);
    state
        .update_connection_pools(|connections| {
            connections.insert(primary_id.to_string(), PoolKind::MongoDb(client.clone()));
        })
        .await;

    let database_handle = client.database(database);
    let _ = database_handle.run_command(doc! { "dropIndexes": collection, "index": index_name }).await;
    let enabled = client
        .database("admin")
        .run_command(doc! { "configureFailPoint": "hangAfterStartingIndexBuild", "mode": "alwaysOn" })
        .await
        .expect("enable index-build failpoint");
    let entered = match enabled.get("count") {
        Some(Bson::Int32(value)) => i64::from(*value),
        Some(Bson::Int64(value)) => *value,
        value => panic!("unexpected failpoint counter: {value:?}"),
    };

    let index_state = Arc::clone(&state);
    let mut index_task = tokio::spawn(async move {
        mongo_create_index_core(
            &index_state,
            primary_id,
            database,
            collection,
            r#"{"pool_registry_probe":1}"#,
            Some(&format!(r#"{{"name":"{index_name}"}}"#)),
        )
        .await
    });
    let admin_handle = client.database("admin");
    let wait_for_index = admin_handle.run_command(doc! {
        "waitForFailPoint": "hangAfterStartingIndexBuild",
        "timesEntered": entered + 1,
        "maxTimeMS": 5_000_i64
    });
    let early_index_result = tokio::select! {
        wait_result = wait_for_index => {
            if let Err(error) = wait_result {
                admin_handle
                    .run_command(doc! { "configureFailPoint": "hangAfterStartingIndexBuild", "mode": "off" })
                    .await
                    .expect("disable index-build failpoint after wait failure");
                index_task.abort();
                let _ = (&mut index_task).await;
                panic!("index build must reach the failpoint: {error}");
            }
            None
        },
        index_result = &mut index_task => Some(index_result),
    };
    if let Some(index_result) = early_index_result {
        admin_handle
            .run_command(doc! { "configureFailPoint": "hangAfterStartingIndexBuild", "mode": "off" })
            .await
            .expect("disable index-build failpoint after early completion");
        panic!("index build ended before reaching the failpoint: {index_result:?}");
    }

    let sqlite_path = directory.path().join("other-connection.db");
    std::fs::File::create(&sqlite_path).expect("create SQLite fixture");
    let other_config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "other-connection",
        "name": "Other connection",
        "db_type": DatabaseType::Sqlite,
        "host": sqlite_path.to_string_lossy(),
        "port": 0,
        "username": "",
        "password": "",
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .unwrap();
    state.configs.write().await.insert(other_config.id.clone(), other_config);
    let other_connection =
        tokio::time::timeout(Duration::from_secs(2), state.get_or_create_pool("other-connection", None)).await;

    client
        .database("admin")
        .run_command(doc! { "configureFailPoint": "hangAfterStartingIndexBuild", "mode": "off" })
        .await
        .expect("disable index-build failpoint");
    let index_result = index_task.await.expect("index task join");
    let _ = database_handle.run_command(doc! { "dropIndexes": collection, "index": index_name }).await;

    assert!(other_connection.expect("other connection must not wait on the registry lock").is_ok());
    assert_eq!(index_result.as_deref(), Ok(index_name));
}
