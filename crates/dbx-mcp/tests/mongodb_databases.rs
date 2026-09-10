use std::{sync::Arc, time::Duration};

use dbx_core::{
    models::connection::ConnectionConfig,
    storage::{McpConnectionPolicy, McpDatabaseScope, McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::json;
use tempfile::tempdir;

fn mongo_connection() -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": "mongo-discovery",
        "name": "mongo-discovery",
        "db_type": "mongodb",
        "host": "127.0.0.1",
        "port": 1,
        "username": "root",
        "password": "unused",
        "url_params": "authSource=admin&serverSelectionTimeoutMS=1000",
        "ssl": false
    }))
    .expect("MongoDB connection config without a default database")
}

fn live_mongo_connection() -> ConnectionConfig {
    let mut connection = mongo_connection();
    connection.host = std::env::var("DBX_MCP_TEST_MONGO_HOST").expect("MongoDB host");
    connection.port =
        std::env::var("DBX_MCP_TEST_MONGO_PORT").unwrap_or_else(|_| "27017".to_string()).parse().expect("MongoDB port");
    connection.password = std::env::var("DBX_MCP_TEST_MONGO_PASSWORD").expect("MongoDB password");
    connection
}

async fn list_databases(
    connection: ConnectionConfig,
    database_scope: McpDatabaseScope,
    allowed_databases: Vec<String>,
    warm_up: bool,
) -> CallToolResult {
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    storage.save_connections(&[connection]).await.expect("save connection");
    storage
        .save_mcp_global_policy(&McpGlobalPolicy {
            connection_policies: vec![McpConnectionPolicy {
                connection_id: "mongo-discovery".to_string(),
                read_only: true,
                allow_dangerous_sql: false,
                execution_mode_configured: false,
                execution_mode_policy_version: None,
                database_scope,
                allowed_databases,
                database_policies: Vec::new(),
            }],
            ..Default::default()
        })
        .await
        .expect("save MCP database scope");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");

    if warm_up {
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    json!({"connection_id": "mongo-discovery", "database": "admin", "sql": "db.version()"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .expect("execute MongoDB query before discovery");
        assert_ne!(result.is_error, Some(true), "MongoDB warm-up failed: {result:?}");
    }

    let result = tokio::time::timeout(
        Duration::from_secs(10),
        client.peer().call_tool(
            CallToolRequestParams::new("dbx_list_databases")
                .with_arguments(json!({"connection_id": "mongo-discovery"}).as_object().unwrap().clone()),
        ),
    )
    .await
    .expect("database discovery timed out")
    .expect("list MongoDB databases");
    client.cancel().await.expect("close client");
    server_task.abort();
    result
}

fn result_text(result: &CallToolResult) -> &str {
    &result.content[0].as_text().expect("text result").text
}

fn assert_root_databases(result: &CallToolResult) {
    assert_ne!(result.is_error, Some(true), "database discovery failed: {result:?}");
    let databases = result_text(result).lines().collect::<Vec<_>>();
    assert!(databases.contains(&"- admin"), "missing admin database: {result:?}");
    assert!(databases.contains(&"- local"), "missing local database: {result:?}");
}

#[tokio::test]
async fn mongodb_database_scope_none_blocks_discovery_without_connecting() {
    let result = list_databases(mongo_connection(), McpDatabaseScope::None, Vec::new(), false).await;
    assert_eq!(result.is_error, Some(true));
    assert!(result_text(&result).contains("DATABASE_OUT_OF_SCOPE"), "unexpected response: {result:?}");
}

#[tokio::test]
async fn mongodb_selected_databases_are_listed_without_connecting() {
    let result = list_databases(
        mongo_connection(),
        McpDatabaseScope::Selected,
        vec!["allowed_a".to_string(), "allowed_b".to_string()],
        false,
    )
    .await;
    assert_ne!(result.is_error, Some(true), "unexpected response: {result:?}");
    assert_eq!(result_text(&result), "- allowed_a\n- allowed_b");
}

#[tokio::test]
async fn mongodb_empty_selected_scope_does_not_discover_databases() {
    let result = list_databases(mongo_connection(), McpDatabaseScope::Selected, Vec::new(), false).await;
    assert_ne!(result.is_error, Some(true), "unexpected response: {result:?}");
    assert_eq!(result_text(&result), "No databases are available through this MCP connection.");
}

#[tokio::test]
#[cfg(unix)]
async fn mongodb_agent_discovery_keeps_one_health_check_for_a_warm_pool() {
    use dbx_core::{
        connection::PoolKind,
        db::agent_driver::{AgentDriverClient, AgentLaunchSpec, AgentRuntimeClient},
    };
    use dbx_mcp::DbxBackend;

    let directory = tempdir().expect("temporary Agent directory");
    let script_path = directory.path().join("agent.py");
    let calls_path = directory.path().join("calls.jsonl");
    std::fs::write(
        &script_path,
        r#"import json, sys
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    request = json.loads(line)
    method = request['method']
    with open(sys.argv[1], 'a') as calls:
        calls.write(json.dumps(method) + '\n')
    if method == 'handshake':
        result = {'protocolVersion': 2, 'agentProtocolVersion': 2, 'capabilities': ['multi_session']}
    elif method == 'list_databases':
        result = [{'name': 'agent_database'}]
    else:
        result = {}
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#,
    )
    .expect("write Agent fixture");
    let storage_path = directory.path().join("dbx.db");
    let storage = Storage::open(&storage_path).await.expect("open storage");
    let mut connection = mongo_connection();
    connection.driver_profile = Some("mongodb-legacy".to_string());
    connection.keepalive_interval_secs = 0;
    storage.save_connections(&[connection.clone()]).await.expect("save Agent connection");
    let backend = LocalBackend::open(&storage_path).await.expect("open local backend");
    let runtime = AgentRuntimeClient::spawn(
        AgentLaunchSpec::new("python3")
            .with_args([script_path.to_string_lossy().to_string(), calls_path.to_string_lossy().to_string()]),
        "test",
    )
    .await
    .expect("start Agent fixture");
    runtime.increment_session_count();
    let pool = PoolKind::agent(AgentDriverClient::shared_session(runtime.clone(), "discovery-session".to_string()));
    let inserted = backend.state().insert_connection_pool(connection.id.clone(), pool, &connection).await;
    let databases = if inserted.is_ok() {
        Some(tokio::time::timeout(Duration::from_secs(10), backend.list_databases(&connection)).await)
    } else {
        None
    };
    backend.state().shutdown(Duration::from_secs(1)).await;
    runtime.kill();

    inserted.expect("publish warm Agent pool");
    assert_eq!(databases.unwrap().expect("Agent discovery timed out").unwrap(), vec!["agent_database"]);
    let calls = std::fs::read_to_string(calls_path).expect("read Agent calls");
    let methods = calls.lines().map(|line| serde_json::from_str::<String>(line).unwrap()).collect::<Vec<_>>();
    assert_eq!(methods.iter().filter(|method| *method == "validate_connection").count(), 1, "{methods:?}");
    assert_eq!(methods.iter().filter(|method| *method == "list_databases").count(), 1, "{methods:?}");
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD (root, authSource=admin)"]
async fn mongodb_lists_databases_on_cold_start_without_default_database() {
    let result = list_databases(live_mongo_connection(), McpDatabaseScope::All, Vec::new(), false).await;
    assert_root_databases(&result);
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD (root, authSource=admin)"]
async fn mongodb_lists_other_databases_when_a_default_database_is_configured() {
    let mut connection = live_mongo_connection();
    connection.database = Some("admin".to_string());
    let result = list_databases(connection, McpDatabaseScope::All, Vec::new(), false).await;
    assert_root_databases(&result);
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD (root, authSource=admin)"]
async fn mongodb_lists_databases_after_query_initializes_the_connection() {
    let result = list_databases(live_mongo_connection(), McpDatabaseScope::All, Vec::new(), true).await;
    assert_root_databases(&result);
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD (root, authSource=admin)"]
async fn mongodb_database_discovery_reports_authentication_errors() {
    let mut connection = live_mongo_connection();
    connection.password.push_str("-invalid");
    let result = list_databases(connection, McpDatabaseScope::All, Vec::new(), false).await;
    assert_eq!(result.is_error, Some(true));
    let text = result_text(&result);
    assert!(text.contains("DATABASE_LIST_ERROR"), "unexpected response: {result:?}");
    assert!(text.to_lowercase().contains("auth"), "authentication failure was lost: {result:?}");
}
