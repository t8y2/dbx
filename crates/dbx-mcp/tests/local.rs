use std::sync::Arc;

use dbx_core::{models::connection::ConnectionConfig, storage::Storage};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map, Value};
use tempfile::tempdir;

#[tokio::test]
async fn local_backend_reads_dbx_storage_without_desktop_process() {
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "local-sqlite",
        "name": "offline-sqlite",
        "db_type": "sqlite",
        "host": "",
        "port": 0,
        "username": "",
        "password": "",
        "database": directory.path().join("data.sqlite").to_string_lossy(),
        "ssl": false
    }))
    .expect("minimal connection config");
    storage.save_connections(&[connection]).await.expect("save connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_list_connections"))
        .await
        .expect("list local connections");
    let text = result.content[0].as_text().expect("text response");
    assert!(text.text.contains("offline-sqlite"));
    assert!(text.text.contains("local-sqlite"));
    client.cancel().await.expect("close client");
    server_task.abort();
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PASSWORD"]
async fn executes_mongo_shell_commands_without_desktop_process() {
    let host = std::env::var("DBX_MCP_TEST_MONGO_HOST").expect("MongoDB host");
    let port = std::env::var("DBX_MCP_TEST_MONGO_PORT")
        .unwrap_or_else(|_| "27017".to_string())
        .parse::<u16>()
        .expect("MongoDB port");
    let password = std::env::var("DBX_MCP_TEST_MONGO_PASSWORD").expect("MongoDB password");
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "mongo-e2e",
        "name": "mongo-e2e",
        "db_type": "mongodb",
        "host": host,
        "port": port,
        "username": "root",
        "password": password,
        "database": "dbx_mcp_test",
        "url_params": "authSource=admin",
        "ssl": false
    }))
    .expect("MongoDB connection config");
    storage.save_connections(&[connection]).await.expect("save connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");
    let original_writes = std::env::var_os("DBX_MCP_ALLOW_WRITES");
    std::env::set_var("DBX_MCP_ALLOW_WRITES", "1");

    call_query(&client, "db.items.deleteOne({_id: 'rust-mcp-e2e'})").await;
    call_query(&client, "db.items.insert({_id: 'rust-mcp-e2e', name: 'Ada'})").await;
    let result = call_query(&client, "db.items.find({_id: 'rust-mcp-e2e'}).limit(1)").await;
    assert!(result.contains("Ada"), "unexpected MongoDB result: {result}");
    call_query(&client, "db.items.deleteOne({_id: 'rust-mcp-e2e'})").await;

    match original_writes {
        Some(value) => std::env::set_var("DBX_MCP_ALLOW_WRITES", value),
        None => std::env::remove_var("DBX_MCP_ALLOW_WRITES"),
    }
    client.cancel().await.expect("close client");
    server_task.abort();
}

async fn call_query(client: &rmcp::service::RunningService<rmcp::RoleClient, ()>, sql: &str) -> String {
    let arguments = json!({
        "connection_id": "mongo-e2e",
        "database": "dbx_mcp_test",
        "sql": sql,
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::<String, Value>::new);
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments))
        .await
        .expect("execute MongoDB command");
    let text = result.content[0].as_text().expect("text result").text.clone();
    assert_ne!(result.is_error, Some(true), "MongoDB command failed: {text}");
    text
}
