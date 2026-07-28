use std::{ffi::OsString, sync::Arc};

use dbx_core::{models::connection::ConnectionConfig, storage::Storage};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map, Value};
use tempfile::tempdir;

struct EnvVarGuard {
    name: &'static str,
    original: Option<OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let original = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, original }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        if let Some(value) = self.original.take() {
            std::env::set_var(self.name, value);
        } else {
            std::env::remove_var(self.name);
        }
    }
}

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
async fn legacy_read_only_config_applies_before_settings_are_opened() {
    let _allow_writes = EnvVarGuard::set("DBX_MCP_ALLOW_WRITES", "0");
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    assert!(!storage.load_mcp_global_policy().await.expect("load MCP policy").configured);
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "legacy-read-only",
        "name": "legacy-read-only",
        "db_type": "sqlite",
        "host": "",
        "port": 0,
        "username": "",
        "password": "",
        "database": directory.path().join("legacy.sqlite").to_string_lossy(),
        "ssl": false
    }))
    .expect("minimal connection config");
    storage.save_connections(&[connection]).await.expect("save connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");
    let arguments = json!({
        "connection_id": "legacy-read-only",
        "sql": "INSERT INTO items (name) VALUES ('blocked')",
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::<String, Value>::new);
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments))
        .await
        .expect("execute query");
    let text = result.content[0].as_text().expect("text result");
    assert_eq!(result.is_error, Some(true));
    assert!(text.text.contains("MCP_READ_ONLY"), "unexpected MCP response: {}", text.text);
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

    call_query(&client, "db.items.deleteOne({_id: 'rust-mcp-e2e'})").await;
    call_query(&client, "db.items.insert({_id: 'rust-mcp-e2e', name: 'Ada'})").await;
    let result = call_query(&client, "db.items.find({_id: 'rust-mcp-e2e'}).limit(1)").await;
    assert!(result.contains("Ada"), "unexpected MongoDB result: {result}");
    call_query(&client, "db.items.deleteOne({_id: 'rust-mcp-e2e'})").await;

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
