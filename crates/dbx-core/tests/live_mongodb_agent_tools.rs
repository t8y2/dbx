use std::sync::{Arc, Mutex};

use dbx_core::agent_events::{ToolCall, ToolResult};
use dbx_core::agent_tools::{execute_tool, AgentSqlPermissions};
use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::storage::Storage;
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
    state.connections.write().await.insert(config.id.clone(), PoolKind::MongoDb(client));

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
