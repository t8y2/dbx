#[cfg(feature = "duckdb-sidecar")]
use std::ffi::OsString;
use std::sync::Arc;

use dbx_core::{models::connection::ConnectionConfig, storage::Storage};
use dbx_mcp::{DbxBackend, DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map, Value};
use tempfile::tempdir;

#[cfg(feature = "duckdb-sidecar")]
struct EnvVarGuard {
    name: &'static str,
    original: Option<OsString>,
}

#[cfg(feature = "duckdb-sidecar")]
impl EnvVarGuard {
    fn set(name: &'static str, value: &str) -> Self {
        let original = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, original }
    }
}

#[cfg(feature = "duckdb-sidecar")]
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
    storage
        .save_sidebar_layout(&json!({
            "groups": [
                { "id": "project", "name": "Project", "collapsed": false },
                { "id": "environment", "name": "Staging", "collapsed": false }
            ],
            "order": [{
                "type": "group",
                "id": "project",
                "children": [{
                    "type": "group",
                    "id": "environment",
                    "children": [{ "type": "connection", "id": "local-sqlite" }]
                }]
            }]
        }))
        .await
        .expect("save sidebar layout");

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
    assert!(text.text.contains("Project / Staging"));
    client.cancel().await.expect("close client");
    server_task.abort();
}

#[tokio::test]
async fn duplicate_connection_preserves_secrets_ssh_and_sidebar_group() {
    let directory = tempdir().expect("temporary data directory");
    let db_path = directory.path().join("dbx.db");
    let storage = Storage::open(&db_path).await.expect("open storage");
    storage
        .save_mcp_global_policy(&dbx_core::storage::McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
        })
        .await
        .expect("enable MCP connection management");
    let source: ConnectionConfig = serde_json::from_value(json!({
        "id": "source",
        "name": "production-through-bastion",
        "note": "full configuration must survive",
        "db_type": "postgres",
        "driver_profile": "postgres-42.7",
        "host": "db.internal",
        "port": 5432,
        "username": "app",
        "password": "database-secret",
        "database": "app",
        "default_schema": "private",
        "url_params": "application_name=dbx",
        "connection_string": "postgres://app:database-secret@db.internal/app",
        "init_script": "SET application_name = 'dbx-secret-script'",
        "save_password": true,
        "ssl": true,
        "transport_layers": [{
            "type": "ssh",
            "id": "bastion",
            "name": "Bastion",
            "enabled": true,
            "host": "bastion.internal",
            "port": 22,
            "user": "deploy",
            "password": "ssh-secret",
            "key_path": "/keys/deploy",
            "key_passphrase": "key-secret",
            "auth_method": "key+password"
        }]
    }))
    .expect("full source connection");
    let unrelated: ConnectionConfig = serde_json::from_value(json!({
        "id": "unrelated",
        "name": "unrelated",
        "db_type": "sqlite",
        "host": ":memory:",
        "port": 0,
        "username": "",
        "password": "",
        "ssl": false
    }))
    .expect("unrelated connection");
    storage.save_connections(&[source.clone(), unrelated]).await.expect("save source connections");
    storage
        .save_sidebar_layout(&json!({
            "groups": [
                { "id": "project", "name": "Project", "collapsed": false },
                { "id": "production", "name": "Production", "collapsed": false }
            ],
            "order": [{
                "type": "group",
                "id": "project",
                "children": [{
                    "type": "group",
                    "id": "production",
                    "children": [{ "type": "connection", "id": "source" }]
                }]
            }, { "type": "connection", "id": "unrelated" }],
            "futureField": { "preserved": true }
        }))
        .await
        .expect("save sidebar layout");

    let backend = Arc::new(LocalBackend::open(&db_path).await.expect("open local backend"));
    let policy = backend.load_mcp_global_policy().await.expect("load configured policy");
    assert!(!policy.read_only);
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize client");
    let arguments = json!({
        "connection_id": "source",
        "new_name": "production-through-bastion-copy"
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::new);
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(arguments.clone()))
        .await
        .expect("duplicate connection");
    assert_ne!(result.is_error, Some(true), "unexpected duplicate error: {:?}", result.content);

    let duplicate_again = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(arguments))
        .await
        .expect("reject duplicate target name");
    assert_eq!(duplicate_again.is_error, Some(true));
    assert!(duplicate_again.content[0]
        .as_text()
        .expect("duplicate error text")
        .text
        .contains("CONNECTION_ALREADY_EXISTS"));

    let missing_arguments = json!({
        "connection_id": "missing",
        "new_name": "must-not-be-created"
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::new);
    let missing = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(missing_arguments))
        .await
        .expect("reject missing source");
    assert_eq!(missing.is_error, Some(true));
    assert!(missing.content[0].as_text().expect("missing error text").text.contains("CONNECTION_NOT_FOUND"));

    let root_arguments = json!({
        "connection_id": "unrelated",
        "new_name": "unrelated-copy"
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::new);
    let root_copy = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(root_arguments))
        .await
        .expect("duplicate root connection");
    assert_ne!(root_copy.is_error, Some(true));

    storage
        .save_mcp_global_policy(&dbx_core::storage::McpGlobalPolicy {
            read_only: true,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
        })
        .await
        .expect("enable MCP read-only policy");
    let read_only_arguments = json!({
        "connection_id": "source",
        "new_name": "must-not-pass-read-only"
    })
    .as_object()
    .cloned()
    .unwrap_or_else(Map::new);
    let read_only = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(read_only_arguments))
        .await
        .expect("reject read-only duplicate");
    assert_eq!(read_only.is_error, Some(true));
    assert!(read_only.content[0].as_text().expect("read-only error text").text.contains("MCP_READ_ONLY"));
    client.cancel().await.expect("close client");
    server_task.abort();

    let reopened = Storage::open(&db_path).await.expect("reopen storage");
    let connections = reopened.load_connections().await.expect("reload connections");
    assert_eq!(connections.len(), 4, "failed duplicates must not add connections");
    let copied = connections
        .iter()
        .find(|connection| connection.name == "production-through-bastion-copy")
        .expect("persisted copied connection");
    let mut expected = source.clone();
    expected.id = copied.id.clone();
    expected.name = copied.name.clone();
    assert_ne!(copied.id, source.id);
    assert_eq!(copied, &expected);
    let root_copy = connections.iter().find(|connection| connection.name == "unrelated-copy").expect("root copy");

    let layout = reopened.load_sidebar_layout().await.expect("load copied layout").expect("sidebar layout");
    assert_eq!(layout["futureField"]["preserved"], true);
    assert_eq!(layout["order"][0]["children"][0]["children"][0]["id"], "source");
    assert_eq!(layout["order"][0]["children"][0]["children"][1]["id"], copied.id);
    assert_eq!(layout["order"][1]["id"], "unrelated");
    assert_eq!(layout["order"][2]["id"], root_copy.id);
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
    const CHILD_ENV: &str = "DBX_MCP_LEGACY_READ_ONLY_TEST_CHILD";
    if std::env::var_os(CHILD_ENV).is_none() {
        let status = std::process::Command::new(std::env::current_exe().expect("locate test executable"))
            .args(["--exact", "legacy_read_only_config_applies_before_settings_are_opened", "--nocapture"])
            .env(CHILD_ENV, "1")
            .env("DBX_MCP_ALLOW_WRITES", "0")
            .status()
            .expect("run legacy read-only test in an isolated process");
        assert!(status.success(), "isolated legacy read-only test failed");
        return;
    }

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
