use std::sync::Arc;

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

    async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
        Ok(true)
    }
}

struct PolicyBackend {
    policy: McpGlobalPolicy,
    connections: Vec<ConnectionConfig>,
}

#[async_trait]
impl DbxBackend for PolicyBackend {
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

    async fn remove_connection_for_mcp(&self, _connection_id: &str) -> Result<bool, String> {
        Ok(true)
    }
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

#[tokio::test]
async fn initializes_lists_tools_and_calls_a_tool() {
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(EmptyBackend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let tools = client.peer().list_tools(None).await.expect("list tools");
    let names = tools.tools.iter().map(|tool| tool.name.as_ref()).collect::<Vec<_>>();
    assert_eq!(names.len(), 10);
    assert!(names.contains(&"dbx_list_connections"));
    assert!(names.contains(&"dbx_execute_redis_command"));
    assert!(names.contains(&"dbx_execute_and_show"));

    let result = client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("call tool");
    let response = result.content[0].as_text().expect("text response");
    assert_eq!(response.text, "No connections configured in DBX.");

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
async fn enforces_global_connection_scope_and_read_only_policy() {
    let backend = PolicyBackend {
        policy: McpGlobalPolicy {
            read_only: true,
            allow_dangerous_sql: false,
            allowed_connection_ids: Some(vec!["allowed".to_string()]),
        },
        connections: vec![test_connection("allowed", "allowed-db"), test_connection("blocked", "blocked-db")],
    };
    let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.expect("initialize MCP client");

    let listed =
        client.peer().call_tool(CallToolRequestParams::new("dbx_list_connections")).await.expect("list connections");
    let listed_text = listed.content[0].as_text().expect("list result").text.clone();
    assert!(listed_text.contains("allowed-db"));
    assert!(!listed_text.contains("blocked-db"));

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
