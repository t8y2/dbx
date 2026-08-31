use std::{collections::HashMap, sync::Arc, sync::Mutex};

use async_trait::async_trait;
use dbx_core::{
    agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig,
    storage::McpGlobalPolicy,
};
use dbx_mcp::{DbxBackend, DbxMcpServer, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map, Value};

struct EmptyBackend;

#[async_trait]
impl DbxBackend for EmptyBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        Ok(McpGlobalPolicy::default())
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        Ok(Vec::new())
    }

    async fn execute_agent_tool(
        &self,
        _connection: &ConnectionConfig,
        _database: &str,
        tool_name: &str,
        _arguments: Value,
        _permissions: AgentSqlPermissions,
    ) -> ToolResult {
        ToolResult {
            tool_call_id: "protocol-test".to_string(),
            tool_name: tool_name.to_string(),
            content: "ok".to_string(),
            is_error: false,
            explain_data: None,
        }
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        Ok(config)
    }

    async fn duplicate_connection_for_mcp(
        &self,
        _source_id: &str,
        _copy_id: &str,
        _copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        Err("not exercised".to_string())
    }

    async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct PolicyBackend {
    policy: McpGlobalPolicy,
    connections: Vec<ConnectionConfig>,
    group_paths: Result<HashMap<String, Vec<String>>, String>,
}

#[async_trait]
impl DbxBackend for PolicyBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        Ok(self.policy.clone())
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        Ok(self.connections.clone())
    }

    async fn load_connection_group_paths(&self) -> Result<HashMap<String, Vec<String>>, String> {
        self.group_paths.clone()
    }

    async fn execute_agent_tool(
        &self,
        _connection: &ConnectionConfig,
        _database: &str,
        tool_name: &str,
        _arguments: Value,
        _permissions: AgentSqlPermissions,
    ) -> ToolResult {
        ToolResult {
            tool_call_id: "policy-test".to_string(),
            tool_name: tool_name.to_string(),
            content: "query should have been blocked".to_string(),
            is_error: true,
            explain_data: None,
        }
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        Ok(config)
    }

    async fn duplicate_connection_for_mcp(
        &self,
        _source_id: &str,
        _copy_id: &str,
        _copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        Err("not exercised".to_string())
    }

    async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct CapturingBackend {
    policy: McpGlobalPolicy,
    connections: Vec<ConnectionConfig>,
    /// Records the arguments passed to `execute_agent_tool` so tests can assert
    /// what the server injected (e.g. `timeout_secs` from the MCP policy).
    calls: Mutex<Vec<Value>>,
}

#[async_trait]
impl DbxBackend for CapturingBackend {
    async fn load_mcp_global_policy(&self) -> Result<McpGlobalPolicy, String> {
        Ok(self.policy.clone())
    }

    async fn load_connections(&self) -> Result<Vec<ConnectionConfig>, String> {
        Ok(self.connections.clone())
    }

    async fn execute_agent_tool(
        &self,
        _connection: &ConnectionConfig,
        _database: &str,
        tool_name: &str,
        arguments: Value,
        _permissions: AgentSqlPermissions,
    ) -> ToolResult {
        self.calls.lock().expect("lock captures").push(arguments);
        ToolResult {
            tool_call_id: "capture-test".to_string(),
            tool_name: tool_name.to_string(),
            content: "ok".to_string(),
            is_error: false,
            explain_data: None,
        }
    }

    async fn add_connection_for_mcp(&self, config: ConnectionConfig) -> Result<ConnectionConfig, String> {
        Ok(config)
    }

    async fn duplicate_connection_for_mcp(
        &self,
        _source_id: &str,
        _copy_id: &str,
        _copy_name: &str,
    ) -> Result<ConnectionConfig, String> {
        Err("not exercised".to_string())
    }

    async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
        Ok(true)
    }
}

/// Drives one `dbx_execute_query` call against a `CapturingBackend`, returning
/// the captured arguments for assertion.
async fn captured_query_arguments(backend: Arc<CapturingBackend>, sql_arguments: Value) -> Vec<Value> {
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");
    let _ = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("dbx_execute_query")
                .with_arguments(sql_arguments.as_object().cloned().unwrap_or_else(Map::new)),
        )
        .await
        .expect("call execute_query");
    client.cancel().await.expect("close MCP client");
    server_task.abort();
    backend.calls.lock().expect("lock captures").clone()
}

/// Regression for the MCP global query-timeout override: the server must inject
/// `timeout_secs` into the `dbx_execute_query` arguments whenever the persisted
/// policy carries a value, and must NOT inject it when the policy inherits the
/// connection (None). This is the native boundary that turns the settings-page
/// value into a per-query argument (server.rs `if let Some(secs) = ...`).
#[tokio::test]
async fn execute_query_injects_and_omits_timeout_secs_from_policy() {
    // Case 1: a positive policy timeout is injected on every call.
    let backend = Arc::new(CapturingBackend {
        policy: McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            query_timeout_secs: Some(300),
            ..Default::default()
        },
        connections: vec![test_connection("scoped", "shared-db")],
        calls: Mutex::new(Vec::new()),
    });
    let captured = captured_query_arguments(backend, json!({ "connection_id": "scoped", "sql": "SELECT 1" })).await;
    assert_eq!(captured.len(), 1, "expected one captured execute_query call");
    assert_eq!(captured[0]["timeout_secs"], json!(300), "policy timeout must be injected");

    // Case 2: an inheriting policy (None) omits the key so the connection-level
    // default is honoured rather than overridden by a stale value.
    let backend = Arc::new(CapturingBackend {
        policy: McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: None,
            query_timeout_secs: None,
            ..Default::default()
        },
        connections: vec![test_connection("scoped", "shared-db")],
        calls: Mutex::new(Vec::new()),
    });
    let captured = captured_query_arguments(backend, json!({ "connection_id": "scoped", "sql": "SELECT 1" })).await;
    assert_eq!(captured.len(), 1, "expected one captured execute_query call");
    assert!(
        !captured[0].get("timeout_secs").is_some(),
        "no timeout_secs must be injected when the policy inherits the connection: {}",
        captured[0]
    );
}

fn test_connection(id: &str, name: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "db_type": "sqlite",
        "host": "",
        "port": 0,
        "username": "",
        "password": "",
        "database": ":memory:",
        "ssl": false
    }))
    .expect("test connection")
}

fn mysql_connection(id: &str, name: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "db_type": "mysql",
        "host": "localhost",
        "port": 3306,
        "username": "tester",
        "password": "",
        "database": "reporting",
        "ssl": false
    }))
    .expect("test MySQL connection")
}

fn postgres_connection(id: &str, name: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id,
        "name": name,
        "db_type": "postgres",
        "host": "localhost",
        "port": 5432,
        "username": "tester",
        "password": "",
        "database": "reporting",
        "ssl": false
    }))
    .expect("test PostgreSQL connection")
}

#[tokio::test]
async fn initializes_lists_tools_and_calls_a_tool() {
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(EmptyBackend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let tools = client.peer().list_tools(None).await.expect("list tools");
    let names = tools.tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
    #[cfg(feature = "mq-admin")]
    assert_eq!(names.len(), 15);
    #[cfg(not(feature = "mq-admin"))]
    assert_eq!(names.len(), 14);
    assert!(names.contains(&"dbx_list_connections"));
    assert!(names.contains(&"dbx_list_databases"));
    assert!(names.contains(&"dbx_duplicate_connection"));
    assert!(names.contains(&"dbx_execute_redis_command"));
    assert!(names.contains(&"dbx_execute_and_show"));
    assert!(names.contains(&"dbx_open_session"));
    assert!(names.contains(&"dbx_close_session"));
    #[cfg(feature = "mq-admin")]
    assert!(names.contains(&"dbx_send_message"));

    let result = client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("call tool");
    let response = result.content[0].as_text().expect("text response");
    assert_eq!(response.text, "No connections configured in DBX.");

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
async fn remove_connection_respects_global_connection_scope() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy {
            read_only: false,
            allow_dangerous_sql: false,
            allowed_connection_ids: Some(vec!["allowed".to_string()]),
            ..Default::default()
        },
        connections: vec![test_connection("allowed", "allowed-db"), test_connection("blocked", "blocked-db")],
        group_paths: Ok(HashMap::new()),
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let result = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("dbx_remove_connection")
                .with_arguments(json!({ "connection_id": "blocked" }).as_object().cloned().unwrap_or_else(Map::new)),
        )
        .await
        .expect("call blocked connection removal");
    assert_eq!(result.is_error, Some(true));
    assert!(result.content[0].as_text().expect("blocked removal result").text.contains("CONNECTION_OUT_OF_SCOPE"));

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
async fn enforces_global_connection_scope_and_read_only_policy() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy {
            read_only: true,
            allow_dangerous_sql: false,
            allowed_connection_ids: Some(vec!["allowed".to_string(), "allowed-staging".to_string()]),
            ..Default::default()
        },
        connections: vec![
            test_connection("allowed", "shared-db"),
            test_connection("allowed-staging", "shared-db"),
            test_connection("blocked", "blocked-db"),
        ],
        group_paths: Ok(HashMap::from([
            ("allowed".to_string(), vec!["Project".to_string(), "Production".to_string()]),
            ("allowed-staging".to_string(), vec!["Project".to_string(), "Staging".to_string()]),
            ("blocked".to_string(), vec!["Secret".to_string()]),
        ])),
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let listed =
        client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("list connections");
    let listed_text = listed.content[0].as_text().expect("list result").text.clone();
    assert_eq!(listed_text.matches("shared-db").count(), 2);
    assert!(!listed_text.contains("blocked-db"));
    assert!(listed_text.contains("Project / Production"));
    assert!(listed_text.contains("Project / Staging"));
    assert!(!listed_text.contains("Secret"));

    let blocked = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
            json!({ "connection_id": "blocked", "sql": "SELECT 1" }).as_object().cloned().unwrap_or_else(Map::new),
        ))
        .await
        .expect("call blocked connection");
    assert_eq!(blocked.is_error, Some(true));
    assert!(blocked.content[0].as_text().expect("blocked result").text.contains("CONNECTION_OUT_OF_SCOPE"));

    let read_only = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("dbx_execute_query").with_arguments(
                json!({ "connection_id": "allowed", "sql": "DELETE FROM users" })
                    .as_object()
                    .cloned()
                    .unwrap_or_else(Map::new),
            ),
        )
        .await
        .expect("call read-only policy");
    assert_eq!(read_only.is_error, Some(true));
    assert!(read_only.content[0].as_text().expect("read-only result").text.contains("MCP_READ_ONLY"));

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

/// Regression for issue #6053: MCP read-only mode let some write-capable SQL
/// through because the read-only gate consulted only the keyword heuristic and
/// ignored the SQL risk classifier it had already computed.
#[tokio::test]
async fn read_only_policy_blocks_write_capable_sql_the_keyword_scan_misses() {
    for (allow_dangerous_sql, sql) in [
        // MySQL's legacy spelling of FOR SHARE — takes the same shared row
        // locks and is reachable with the plain read-only execution mode.
        (false, "SELECT * FROM users LOCK IN SHARE MODE"),
        (true, "SELECT * FROM users LOCK IN SHARE MODE"),
        (true, "SELECT * FROM users FOR SHARE"),
    ] {
        let backend = PolicyBackend {
            policy: McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql,
                allowed_connection_ids: None,
                ..Default::default()
            },
            connections: vec![mysql_connection("mysql", "reporting")],
            group_paths: Ok(HashMap::new()),
        };
        let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
        let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let client = ().serve(client_transport).await.expect("initialize MCP client");

        let result = client
            .peer()
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
                json!({ "connection_id": "mysql", "sql": sql }).as_object().cloned().unwrap_or_else(Map::new),
            ))
            .await
            .expect("call read-only policy");
        let text = result.content[0].as_text().expect("tool result text").text.clone();
        assert_eq!(
            result.is_error,
            Some(true),
            "{sql} (allow_dangerous_sql={allow_dangerous_sql}) reached the backend"
        );
        assert!(
            text.contains("MCP_READ_ONLY"),
            "expected MCP_READ_ONLY for {sql} (allow_dangerous_sql={allow_dangerous_sql}), got: {text}"
        );

        client.cancel().await.expect("close MCP client");
        server_task.abort();
    }
}

#[tokio::test]
async fn read_only_policy_allows_read_only_show_statements() {
    for (connection, sql) in [
        (mysql_connection("mysql", "reporting"), "SHOW COLLATION"),
        (postgres_connection("postgres", "reporting"), "SHOW search_path"),
    ] {
        let connection_id = connection.id.clone();
        let backend = PolicyBackend {
            policy: McpGlobalPolicy {
                read_only: true,
                allow_dangerous_sql: false,
                allowed_connection_ids: None,
                ..Default::default()
            },
            connections: vec![connection],
            group_paths: Ok(HashMap::new()),
        };
        let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
        let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let client = ().serve(client_transport).await.expect("initialize MCP client");

        let result = client
            .peer()
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
                json!({ "connection_id": connection_id, "sql": sql }).as_object().cloned().unwrap_or_else(Map::new),
            ))
            .await
            .expect("call read-only policy");
        let text = result.content[0].as_text().expect("tool result text").text.clone();
        assert!(!text.contains("MCP_READ_ONLY"), "read-only SHOW was blocked: {sql}: {text}");
        assert!(text.contains("query should have been blocked"), "expected {sql} to reach the backend, got: {text}");

        client.cancel().await.expect("close MCP client");
        server_task.abort();
    }
}

#[tokio::test]
async fn duplicate_connection_rejects_ambiguous_source_names() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy::default(),
        connections: vec![test_connection("first", "shared"), test_connection("second", "shared")],
        group_paths: Ok(HashMap::new()),
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");
    let result = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_duplicate_connection").with_arguments(
            json!({ "connection_name": "shared", "new_name": "copy" }).as_object().cloned().unwrap_or_else(Map::new),
        ))
        .await
        .expect("call duplicate connection");
    assert_eq!(result.is_error, Some(true));
    assert!(result.content[0].as_text().expect("ambiguous result").text.contains("AMBIGUOUS_CONNECTION"));
    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
async fn connection_group_path_failure_preserves_connection_listing() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy::default(),
        connections: vec![test_connection("local", "local-db")],
        group_paths: Err("layout unavailable".to_string()),
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let listed =
        client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("list connections");
    let listed_text = listed.content[0].as_text().expect("list result").text.clone();
    assert_ne!(listed.is_error, Some(true));
    assert!(listed_text.contains("| ID | Name | Group Path |"));
    assert!(listed_text.contains("local-db"));

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
async fn runtime_connection_scope_preserves_group_paths() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy::default(),
        connections: vec![test_connection("scoped", "shared-db"), test_connection("outside", "shared-db")],
        group_paths: Ok(HashMap::from([
            ("scoped".to_string(), vec!["Project".to_string(), "Production".to_string()]),
            ("outside".to_string(), vec!["Project".to_string(), "Staging".to_string()]),
        ])),
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(
        Arc::new(backend),
        McpScope { connection_ids: vec!["scoped".to_string()], ..Default::default() },
        false,
    );
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let listed =
        client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("list connections");
    let listed_text = listed.content[0].as_text().expect("list result").text.clone();
    assert!(listed_text.contains("| scoped | shared-db | Project / Production |"));
    assert!(!listed_text.contains("outside"));
    assert!(!listed_text.contains("Project / Staging"));

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}
