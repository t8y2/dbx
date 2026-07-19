use std::sync::Arc;

use async_trait::async_trait;
use dbx_core::{agent_events::ToolResult, agent_tools::AgentSqlPermissions, models::connection::ConnectionConfig};
use dbx_mcp::{DbxBackend, DbxMcpServer, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::Value;

struct EmptyBackend;

#[async_trait]
impl DbxBackend for EmptyBackend {
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

    async fn save_connections(&self, _connections: &[ConnectionConfig]) -> Result<(), String> {
        Ok(())
    }
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
