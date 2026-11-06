//! #9108: the MCP surface must not reach DBX's configuration database through a
//! connection that was saved outside the MCP mutation path (for example in the
//! desktop UI). Resolution and listings re-check every saved configuration, not
//! just the ones an agent created.

use dbx_core::{
    models::connection::ConnectionConfig,
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::json;
use std::sync::Arc;

fn connection(id: &str, host: &std::path::Path, attached: Option<&std::path::Path>) -> ConnectionConfig {
    let mut value = json!({
        "id": id,
        "name": id,
        "db_type": "sqlite",
        "host": host,
        "port": 0,
        "username": "",
        "password": "",
        "database": "main",
    });
    if let Some(attached) = attached {
        value["attached_databases"] = json!([{ "name": "cfg", "path": attached }]);
    }
    serde_json::from_value(value).expect("sqlite connection config")
}

fn result_text(result: &rmcp::model::CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|block| block.as_text().map(|text| text.text.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

#[tokio::test]
async fn saved_connections_cannot_reach_the_config_database() {
    let directory = tempfile::tempdir().unwrap();
    let config_db = directory.path().join("dbx.db");
    let sibling = directory.path().join("sibling.db");
    dbx_core::db::sqlite::connect_path_create_if_missing(sibling.to_str().unwrap()).await.unwrap();

    let storage = Storage::open(&config_db).await.unwrap();
    // Saved through the desktop path, so the MCP mutation guard never sees them.
    storage
        .save_connections(&[
            connection("protected", &config_db, None),
            connection("attached", &sibling, Some(&config_db)),
            connection("allowed", &sibling, None),
        ])
        .await
        .unwrap();
    storage
        .save_mcp_global_policy(&McpGlobalPolicy { read_only: false, allow_dangerous_sql: true, ..Default::default() })
        .await
        .unwrap();

    let backend = Arc::new(LocalBackend::open(&config_db).await.unwrap());
    let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(32 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();

    // Listings must not advertise either protected configuration.
    let listed = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("dbx_list_connections").with_arguments(json!({}).as_object().unwrap().clone()),
        )
        .await
        .unwrap();
    let listed_text = result_text(&listed);
    assert!(listed_text.contains("allowed"), "{listed_text}");
    assert!(!listed_text.contains("protected"), "{listed_text}");
    assert!(!listed_text.contains("attached"), "{listed_text}");

    for id in ["protected", "attached"] {
        let denied = client
            .peer()
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
                json!({ "connection_id": id, "database": "main", "sql": "SELECT 1" }).as_object().unwrap().clone(),
            ))
            .await
            .unwrap();
        let denied_text = result_text(&denied);
        assert_eq!(denied.is_error, Some(true), "{id}: {denied_text}");
        assert!(denied_text.contains("CONFIG_DB_PATH_FORBIDDEN"), "{id}: {denied_text}");
    }

    // Name-based resolution must refuse it too (agents may only know the name).
    let by_name = client
        .peer()
        .call_tool(
            CallToolRequestParams::new("dbx_execute_query").with_arguments(
                json!({ "connection_name": "protected", "database": "main", "sql": "SELECT 1" })
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        )
        .await
        .unwrap();
    let by_name_text = result_text(&by_name);
    assert_eq!(by_name.is_error, Some(true), "{by_name_text}");
    assert!(by_name_text.contains("CONFIG_DB_PATH_FORBIDDEN"), "{by_name_text}");

    // A sibling SQLite database keeps working.
    let allowed = client
        .peer()
        .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
            json!({ "connection_id": "allowed", "database": "main", "sql": "SELECT 1" }).as_object().unwrap().clone(),
        ))
        .await
        .unwrap();
    assert_ne!(allowed.is_error, Some(true), "{:?}", result_text(&allowed));

    client.cancel().await.unwrap();
    server_task.await.unwrap().unwrap().cancel().await.unwrap();
}
