#![recursion_limit = "256"]

use std::sync::Arc;
use std::time::Duration;

use dbx_core::agent_events::ToolCall;
use dbx_core::agent_tools::{all_tools, execute_tool, read_only_tools, AgentSqlPermissions};
use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::agent_driver::{AgentDriverClient, AgentLaunchSpec};
use dbx_core::db::mongo_driver;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::mongo_ops::mongo_run_command_core;
use dbx_core::schema::get_columns_core;
use serde_json::json;

async fn state_with_pool(pool: PoolKind, db_type: DatabaseType, database: &str) -> (Arc<AppState>, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&directory.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let config: ConnectionConfig = serde_json::from_value(json!({
        "id": "metadata", "name": "Column metadata regression", "db_type": db_type,
        "host": "127.0.0.1", "port": 1, "username": "", "password": "",
        "database": "default_database", "connect_timeout_secs": 1,
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config);
    state
        .update_connection_pools(|connections| {
            connections.insert("metadata".to_string(), pool.clone());
            connections.insert(format!("metadata:{database}"), pool);
        })
        .await;
    (state, directory)
}

async fn columns_tool(
    state: &Arc<AppState>,
    database: &str,
    collection: &str,
    db_type: DatabaseType,
) -> dbx_core::agent_events::ToolResult {
    execute_tool(
        &ToolCall {
            id: "columns".to_string(),
            name: "get_columns".to_string(),
            arguments: json!({"table": collection, "database": database}),
            provider_payload: None,
        },
        state,
        "metadata",
        "default_database",
        None,
        &db_type,
        AgentSqlPermissions::default(),
    )
    .await
}

#[cfg(unix)]
async fn scripted_state(mode: &str, db_type: DatabaseType) -> (Arc<AppState>, tempfile::TempDir) {
    let script = format!(
        r#"import json, sys
mode = {mode:?}
print(json.dumps({{"ready": True}}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    response = {{"jsonrpc": "2.0", "id": request["id"]}}
    try:
        method = request["method"]
        if method == "handshake":
            result = {{"protocolVersion": 1, "agentProtocolVersion": 1, "capabilities": [] if mode == "unsupported" else ["mongo_run_command"]}}
        elif method == "get_columns" and mode == "sql":
            result = [{{"name": "id", "data_type": "int", "is_nullable": False, "is_primary_key": True}}]
        elif method == "run_command":
            params = request["params"]
            assert params["database"] == "fixture", params
            command = json.loads(params["command_json"])
            assert command == {{"find": "items", "filter": {{}}, "limit": 100, "batchSize": 100, "singleBatch": True, "maxTimeMS": 5000}}, command
            if mode == "denied":
                raise RuntimeError("not authorized to read collection")
            documents = [] if mode == "empty" else [{{"_id": {{"$oid": "000000000000000000000001"}}, "amount": 42, "profile": {{"city": "private-value"}}, "tags": ["a"]}}, {{"amount": "unknown", "optional": None}}]
            result = {{"documents": [], "extended_documents": [{{"cursor": {{"firstBatch": documents}}}}], "total": 1}}
        else:
            raise RuntimeError("Unknown method: " + method)
        response["result"] = result
    except Exception as error:
        response["error"] = {{"code": -1, "message": str(error)}}
    print(json.dumps(response), flush=True)
"#
    );
    let mut client =
        AgentDriverClient::spawn(AgentLaunchSpec::new("python3").with_args(["-u", "-c", &script])).await.unwrap();
    client.try_optional_handshake("test").await.unwrap();
    state_with_pool(PoolKind::agent(client), db_type, "fixture").await
}

#[test]
fn mongodb_columns_tools_describe_sampling_without_changing_sql_tools() {
    for tools in
        [read_only_tools(DatabaseType::MongoDb), all_tools(DatabaseType::MongoDb, AgentSqlPermissions::default())]
    {
        let tool = tools.iter().find(|tool| tool.name == "get_columns").unwrap();
        assert!(tool.description.contains("100 documents"));
        assert!(tool.description.contains("not a complete schema"));
        assert!(!tool.description.contains("authoritative"));
        assert!(tool.read_only);
    }
    let tools = read_only_tools(DatabaseType::Mysql);
    assert!(tools
        .iter()
        .find(|tool| tool.name == "get_columns")
        .unwrap()
        .description
        .contains("authoritative and complete"));
}

#[cfg(unix)]
#[tokio::test]
async fn mongodb_legacy_columns_use_bounded_sampling_and_database_override() {
    let (state, _directory) = scripted_state("sample", DatabaseType::MongoDb).await;
    let columns = get_columns_core(&state, "metadata", "fixture", "", "items").await.unwrap();
    assert_eq!(columns.len(), 5);
    assert_eq!(columns.iter().find(|column| column.name == "amount").unwrap().data_type, "number | string");
    assert!(columns.iter().all(|column| column.is_nullable));
    let result = columns_tool(&state, "fixture", "items", DatabaseType::MongoDb).await;
    assert!(!result.is_error, "{}", result.content);
    assert!(result.content.contains("Sampled fields of items"));
    assert!(result.content.contains("not a complete schema"));
    assert!(result.content.contains("profile: object"));
    assert!(result.content.contains("tags: array"));
    assert!(!result.content.contains("private-value"));
    assert!(!result.content.contains("NOT NULL"));
    state.remove_connection_pools("metadata").await;
}

#[cfg(unix)]
#[tokio::test]
async fn mongodb_legacy_empty_sample_is_not_an_rpc_failure() {
    let (state, _directory) = scripted_state("empty", DatabaseType::MongoDb).await;
    let result = columns_tool(&state, "fixture", "items", DatabaseType::MongoDb).await;
    assert!(!result.is_error, "{}", result.content);
    assert!(result.content.contains("No fields could be inferred"));
    state.remove_connection_pools("metadata").await;
}

#[cfg(unix)]
#[tokio::test]
async fn mongodb_legacy_preserves_permission_errors_and_reports_unsupported_drivers() {
    for (mode, expected) in [("denied", "not authorized"), ("unsupported", "upgrade or reinstall")] {
        let (state, _directory) = scripted_state(mode, DatabaseType::MongoDb).await;
        let result = columns_tool(&state, "fixture", "items", DatabaseType::MongoDb).await;
        assert!(result.is_error);
        assert!(result.content.contains(expected), "{}", result.content);
        state.remove_connection_pools("metadata").await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn sql_agent_columns_keep_the_existing_rpc_and_output() {
    let (state, _directory) = scripted_state("sql", DatabaseType::Mysql).await;
    let result = columns_tool(&state, "fixture", "items", DatabaseType::Mysql).await;
    assert!(!result.is_error, "{}", result.content);
    assert_eq!(result.content, "Columns of items:\n  - id: int (PK, NOT NULL)");
    state.remove_connection_pools("metadata").await;
}

async fn verify_live_columns(pool: PoolKind) {
    let database = format!("dbx_issue9398_{}", uuid::Uuid::new_v4().simple());
    let (state, _directory) = state_with_pool(pool, DatabaseType::MongoDb, &database).await;
    let collection = "youzy_uyk_plandata_tagged_2026";
    let documents = (0..101)
        .map(|index| {
            let mut document = json!({
                "_id": {"$oid": format!("{:024x}", index + 1)},
                "amount": if index % 2 == 0 { json!(index) } else { json!("unknown") },
                "created": {"$date": "2026-01-01T00:00:00Z"},
                "profile": {"city": "sample"}, "tags": ["sample"], "optional": null,
            });
            if index == 100 {
                document["outside_sample"] = json!(true);
            }
            document
        })
        .collect::<Vec<_>>();
    mongo_run_command_core(
        &state,
        "metadata",
        &database,
        &json!({"insert": collection, "documents": documents}).to_string(),
    )
    .await
    .unwrap();
    mongo_run_command_core(&state, "metadata", &database, r#"{"create":"empty_collection"}"#).await.unwrap();
    let columns = Box::pin(get_columns_core(&state, "metadata", &database, "", collection)).await.unwrap();
    let types = columns
        .iter()
        .map(|column| (column.name.as_str(), column.data_type.as_str()))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(types["_id"], "objectId");
    assert_eq!(types["amount"], "number | string");
    assert_eq!(types["created"], "date");
    assert_eq!(types["profile"], "object");
    assert_eq!(types["tags"], "array");
    assert!(!types.contains_key("outside_sample"));
    assert!(columns.iter().all(|column| column.extra.as_deref().unwrap().contains("100 document(s)")));
    let result = Box::pin(columns_tool(&state, &database, collection, DatabaseType::MongoDb)).await;
    assert!(!result.is_error, "{}", result.content);
    assert!(result.content.contains("not a complete schema"));
    assert!(result.content.contains("amount: number | string"));
    let empty = Box::pin(columns_tool(&state, &database, "empty_collection", DatabaseType::MongoDb)).await;
    assert!(!empty.is_error, "{}", empty.content);
    assert!(empty.content.contains("No fields could be inferred"));
    mongo_run_command_core(&state, "metadata", &database, r#"{"dropDatabase":1}"#).await.unwrap();
    state.remove_connection_pools("metadata").await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_URL pointing to a test MongoDB server; creates and removes a temporary database"]
async fn live_native_mongodb_column_sampling() {
    let url = std::env::var("DBX_LIVE_MONGODB_URL").expect("DBX_LIVE_MONGODB_URL");
    let client = mongo_driver::connect(&url, Duration::from_secs(10), Duration::from_secs(60)).await.unwrap();
    Box::pin(verify_live_columns(PoolKind::MongoDb(client))).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MONGODB_AGENT_JAR and DBX_LIVE_MONGODB_LEGACY_PORT via a localhost SSH tunnel; creates and removes a temporary database"]
async fn live_legacy_mongodb_column_sampling() {
    let jar = std::env::var("DBX_LIVE_MONGODB_AGENT_JAR").expect("DBX_LIVE_MONGODB_AGENT_JAR");
    let port =
        std::env::var("DBX_LIVE_MONGODB_LEGACY_PORT").expect("DBX_LIVE_MONGODB_LEGACY_PORT").parse::<u16>().unwrap();
    let mut client = AgentDriverClient::spawn(AgentLaunchSpec::new("java").with_args(["-jar", &jar])).await.unwrap();
    client.try_optional_handshake("test").await.unwrap();
    client.connect(json!({"connection": {"host": "127.0.0.1", "port": port, "database": "admin", "username": "", "password": ""}})).await.unwrap();
    Box::pin(verify_live_columns(PoolKind::agent(client))).await;
}
