use std::{ffi::OsString, sync::Arc};

use dbx_core::{models::connection::ConnectionConfig, storage::Storage};
use dbx_mcp::{DbxBackend, DbxMcpServer, LocalBackend, McpScope};
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
async fn local_backend_picks_up_connections_added_after_startup_without_reload() {
    // Regression for issue #5428: after an agent connects to MCP, a connection created in the DBX
    // desktop UI is not reflected in the MCP server's AppState.configs in-memory cache, so the
    // agent can list the new connection but executing an operation fails with
    // "Connection config not found". After the fix the new connection is usable without reload.
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let initial: ConnectionConfig = serde_json::from_value(json!({
        "id": "startup-sqlite",
        "name": "startup-sqlite",
        "db_type": "sqlite",
        "host": ":memory:",
        "port": 0,
        "username": "",
        "password": "",
        "database": "",
        "ssl": false
    }))
    .expect("initial connection config");
    storage.save_connections(std::slice::from_ref(&initial)).await.expect("save initial connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");

    // Simulate a connection created in the DBX desktop UI: write directly to the shared storage,
    // bypassing the MCP server's in-process cache.
    let added: ConnectionConfig = serde_json::from_value(json!({
        "id": "added-sqlite",
        "name": "added-sqlite",
        "db_type": "sqlite",
        "host": ":memory:",
        "port": 0,
        "username": "",
        "password": "",
        "database": "",
        "ssl": false
    }))
    .expect("added connection config");
    storage.save_connections(&[initial, added.clone()]).await.expect("save added connection");

    // list_connections reads storage live, so the new connection is already visible.
    let list_result =
        client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("list connections");
    let list_text = list_result.content[0].as_text().expect("text response").text.clone();
    assert!(list_text.contains("added-sqlite"), "list should include added connection: {list_text}");

    // execute_query resolves through the AppState.configs cache: before the fix this failed with
    // "Connection config not found"; after the fix load_connections syncs the cache and the query
    // succeeds.
    let arguments = json!({
        "connection_id": "added-sqlite",
        "sql": "SELECT 1",
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::<String, Value>::new);
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments))
        .await
        .expect("execute query on added connection");
    let text = result.content[0].as_text().expect("text result").text.clone();
    assert_ne!(result.is_error, Some(true), "query on added connection failed: {text}");
    assert!(text.contains('1'), "unexpected query result: {text}");

    client.cancel().await.expect("close client");
    server_task.abort();
    drop(backend);
}

#[tokio::test]
#[cfg(feature = "duckdb-sidecar")]
async fn local_backend_uses_the_installed_duckdb_sidecar() {
    let directory = tempdir().expect("temporary data directory");
    let missing_driver = directory.path().join("missing-duckdb-driver");
    let _driver_path = EnvVarGuard::set("DBX_DUCKDB_DRIVER_PATH", &missing_driver.to_string_lossy());
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "local-duckdb",
        "name": "local-duckdb",
        "db_type": "duckdb",
        "host": ":memory:",
        "port": 0,
        "username": "",
        "password": "",
        "ssl": false
    }))
    .expect("minimal DuckDB connection config");
    storage.save_connections(std::slice::from_ref(&connection)).await.expect("save connection");

    let backend = LocalBackend::open(&db_path).await.expect("open local backend");
    let error = backend
        .execute_query(&connection, "main", "SELECT 1", Some(1), Some(5))
        .await
        .expect_err("missing DuckDB driver should fail");

    assert!(error.contains("DBX_DUCKDB_DRIVER_PATH"), "unexpected DuckDB error: {error}");
    assert!(!error.contains("not compiled"), "DuckDB sidecar feature was not enabled: {error}");
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

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PORT pointing at MongoDB 4.0+"]
async fn executes_legacy_mongo_get_indexes_without_desktop_process() {
    let host = std::env::var("DBX_MCP_TEST_MONGO_HOST").expect("MongoDB host");
    let port = std::env::var("DBX_MCP_TEST_MONGO_PORT")
        .unwrap_or_else(|_| "27017".to_string())
        .parse::<u16>()
        .expect("MongoDB port");
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "mongo-e2e",
        "name": "mongo-legacy-e2e",
        "db_type": "mongodb",
        "driver_profile": "mongodb-legacy",
        "host": host,
        "port": port,
        "username": "",
        "password": "",
        "database": "dbx_mcp_test",
        "ssl": false
    }))
    .expect("MongoDB Legacy connection config");
    storage.save_connections(&[connection]).await.expect("save connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");

    let result = call_query(&client, "db.im_msg.getIndexes()").await;
    assert!(result.contains("| name | columns | unique | primary | type | filter |"), "{result}");
    assert!(result.contains("_id_"), "{result}");
    assert!(result.contains("email_1"), "{result}");

    client.cancel().await.expect("close client");
    server_task.abort();
}

#[tokio::test]
#[ignore = "requires DBX_MCP_TEST_MONGO_HOST and DBX_MCP_TEST_MONGO_PORT pointing at MongoDB 4.0+"]
async fn executes_legacy_mongo_find_explain_without_desktop_process() {
    let host = std::env::var("DBX_MCP_TEST_MONGO_HOST").expect("MongoDB host");
    let port = std::env::var("DBX_MCP_TEST_MONGO_PORT")
        .unwrap_or_else(|_| "27017".to_string())
        .parse::<u16>()
        .expect("MongoDB port");
    let collection = std::env::var("DBX_MCP_TEST_MONGO_COLLECTION").unwrap_or_else(|_| "im_msg".to_string());
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    let connection: ConnectionConfig = serde_json::from_value(json!({
        "id": "mongo-e2e",
        "name": "mongo-legacy-e2e",
        "db_type": "mongodb",
        "driver_profile": "mongodb-legacy",
        "host": host,
        "port": port,
        "username": "",
        "password": "",
        "database": "dbx_mcp_test",
        "ssl": false
    }))
    .expect("MongoDB Legacy connection config");
    storage.save_connections(&[connection]).await.expect("save connection");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");

    let planner =
        call_query(&client, &format!("db.{collection}.find({{active: true}}).sort({{email: 1}}).limit(1).explain()"))
            .await;
    assert!(planner.contains("queryPlanner"), "unexpected MongoDB explain result: {planner}");

    let result = call_query(
        &client,
        &format!("db.{collection}.find({{active: true}}).sort({{email: 1}}).limit(1).explain(\"executionStats\")"),
    )
    .await;
    assert!(result.contains("queryPlanner"), "unexpected MongoDB explain result: {result}");
    assert!(result.contains("executionStats"), "unexpected MongoDB explain result: {result}");

    client.cancel().await.expect("close client");
    server_task.abort();
}

#[test]
#[cfg(feature = "mq-admin")]
fn mcp_default_features_include_message_queue_admin() {
    assert_eq!(dbx_core::mq::MqSystemKind::Kafka.as_str(), "kafka");
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
