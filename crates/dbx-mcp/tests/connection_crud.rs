//! MCP wire-level configuration CRUD. No database servers or user configuration are touched.
use std::sync::Arc;

use dbx_core::{connection::AppState, persistence::test_storage, storage::McpGlobalPolicy};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::json;

fn output(result: &CallToolResult) -> String {
    serde_json::to_string(result).unwrap()
}

#[tokio::test]
async fn mcp_connection_crud_round_trip_preserves_credentials_and_rechecks_policy() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let backend = LocalBackend::from_app_state(
        Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage.clone(),
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "",
        )),
        directory.path().to_path_buf(),
    );
    let server = DbxMcpServer::with_runtime_options(Arc::new(backend), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    macro_rules! call {
        ($tool:expr, $arguments:expr) => {
            client
                .peer()
                .call_tool(CallToolRequestParams::new($tool).with_arguments($arguments.as_object().unwrap().clone()))
                .await
                .unwrap()
        };
    }
    let tools = client.peer().list_all_tools().await.unwrap();
    for name in ["dbx_get_connection", "dbx_update_connection"] {
        assert!(tools.iter().any(|tool| tool.name == name));
    }
    let added = call!(
        "dbx_add_connection",
        json!({"name":"Fixture", "db_type":"sqlite", "host":":memory:", "port":0, "password":"mcp-fixture-secret", "read_only":true})
    );
    assert_ne!(added.is_error, Some(true), "{}", output(&added));
    assert!(!output(&added).contains("mcp-fixture-secret"));
    let config = storage.load_connections().await.unwrap().pop().unwrap();
    assert!(config.read_only);
    assert_eq!(config.password, "mcp-fixture-secret");
    let id = config.id;
    let updated = call!(
        "dbx_update_connection",
        json!({"connection_id":id, "changes":{"read_only":false, "name":"Renamed", "database":null}})
    );
    assert_ne!(updated.is_error, Some(true), "{}", output(&updated));
    assert_eq!(updated.structured_content.as_ref().unwrap()["read_only"], false);
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "mcp-fixture-secret");
    let got = call!("dbx_get_connection", json!({"connection_name":"Renamed"}));
    assert_ne!(got.is_error, Some(true));
    assert_eq!(got.structured_content.as_ref().unwrap()["id"], id);
    assert!(!output(&got).contains("mcp-fixture-secret"));
    let listed = call!("dbx_list_connections", json!({}));
    assert!(!output(&listed).contains("mcp-fixture-secret"));
    let invalid = call!("dbx_update_connection", json!({"connection_id":id, "changes":{"password":null}}));
    assert_eq!(invalid.is_error, Some(true));
    let missing = call!("dbx_get_connection", json!({"connection_id":"missing"}));
    assert_eq!(missing.is_error, Some(true));
    let unconfirmed = call!("dbx_remove_connection", json!({"connection_id":id}));
    assert!(output(&unconfirmed).contains("CONFIRMATION_REQUIRED"));
    assert_eq!(storage.load_connections().await.unwrap().len(), 1);
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..Default::default() }).await.unwrap();
    for (tool, arguments) in [
        ("dbx_update_connection", json!({"connection_id":id, "changes":{"read_only":false}})),
        ("dbx_remove_connection", json!({"connection_id":id, "confirmed":true})),
        ("dbx_add_connection", json!({"name":"Blocked", "db_type":"sqlite", "host":":memory:", "port":0})),
    ] {
        let blocked = call!(tool, arguments);
        assert_eq!(blocked.is_error, Some(true));
        assert!(output(&blocked).contains("MCP_READ_ONLY"));
    }
    storage
        .save_mcp_global_policy(&McpGlobalPolicy {
            read_only: false,
            allowed_connection_ids: Some(vec!["other".into()]),
            ..Default::default()
        })
        .await
        .unwrap();
    let out_of_scope = call!("dbx_update_connection", json!({"connection_id":id, "changes":{"read_only":false}}));
    assert!(output(&out_of_scope).contains("CONNECTION_OUT_OF_SCOPE"));
    let hidden = call!("dbx_get_connection", json!({"connection_id":id}));
    assert_eq!(hidden.is_error, Some(true));
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let clear = call!("dbx_update_connection", json!({"connection_id":id, "changes":{"password":""}}));
    assert_ne!(clear.is_error, Some(true));
    assert!(storage.load_connections().await.unwrap()[0].password.is_empty());
    let removed = call!("dbx_remove_connection", json!({"connection_id":id, "confirmed":true}));
    assert_ne!(removed.is_error, Some(true));
    assert!(storage.load_connections().await.unwrap().is_empty());
    client.cancel().await.unwrap();
    server_task.abort();
}

#[tokio::test]
async fn scoped_mcp_does_not_advertise_connection_update() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    let backend = LocalBackend::from_app_state(
        Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.path().join("plugins"),
            directory.path().join("agents"),
            "",
        )),
        directory.path().to_path_buf(),
    );
    let server = DbxMcpServer::with_runtime_options(
        Arc::new(backend),
        McpScope { connection_ids: vec!["scoped".into()], ..Default::default() },
        false,
    );
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    let tools = client.peer().list_all_tools().await.unwrap();
    assert!(!tools.iter().any(|tool| tool.name == "dbx_update_connection"));
    client.cancel().await.unwrap();
    server_task.abort();
}
