//! MCP wire-level bundle imports use isolated storage and synthetic protected files.
use dbx_core::{
    connection::AppState,
    persistence::test_storage,
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

fn fixture() -> Value {
    json!({"connections":[{"id":"source", "name":"MCP import", "db_type":"sqlite",
        "host":":memory:", "port":0, "username":"", "password":"mcp-import-secret", "database":null,
        "connection_string":"mcp-import-dsn-secret", "read_only":true,
        "transport_layers":[{"type":"ssh", "id":"ssh", "host":"fixture.invalid", "password":"mcp-ssh-secret"}]}]})
}

fn protected_file(directory: &Path, content: &[u8]) -> PathBuf {
    let path = directory.join("connections.json");
    std::fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    path
}

fn server(storage: Storage, directory: &Path, scope: McpScope, web_mode: bool) -> DbxMcpServer {
    let backend = LocalBackend::from_app_state(
        Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
            storage,
            directory.join("plugins"),
            directory.join("agents"),
            "",
        )),
        directory.to_path_buf(),
    );
    DbxMcpServer::with_runtime_options(Arc::new(backend), scope, web_mode)
}

fn output(result: &CallToolResult) -> String {
    let result = serde_json::to_string(result).unwrap();
    for secret in [
        "mcp-import-secret",
        "mcp-import-dsn-secret",
        "mcp-ssh-secret",
        "synthetic-import-passphrase",
        "synthetic-encrypted-password",
        "incorrect-passphrase",
    ] {
        assert!(!result.contains(secret), "MCP response exposed fixture credentials");
    }
    result
}

macro_rules! call {
    ($client:expr, $arguments:expr) => {
        $client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_import_connections")
                    .with_arguments($arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap()
    };
}

#[tokio::test]
async fn mcp_import_preview_confirmation_and_idempotent_apply_are_secret_safe() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), fixture().to_string().as_bytes());
    let server = server(storage.clone(), directory.path(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    let tools = client.peer().list_all_tools().await.unwrap();
    assert!(tools.iter().any(|tool| tool.name == "dbx_import_connections"));
    let preview = call!(client, json!({"file_path":file}));
    assert_ne!(preview.is_error, Some(true), "{}", output(&preview));
    output(&preview);
    assert_eq!(preview.structured_content.as_ref().unwrap()["dry_run"], true);
    assert_eq!(preview.structured_content.as_ref().unwrap()["imported_count"], 1);
    assert!(storage.load_connections().await.unwrap().is_empty());
    let imported = call!(client, json!({"file_path":file, "confirmed":true}));
    assert_ne!(imported.is_error, Some(true), "{}", output(&imported));
    output(&imported);
    assert_eq!(imported.structured_content.as_ref().unwrap()["dry_run"], false);
    let saved = storage.load_connections().await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].password, "mcp-import-secret");
    assert!(saved[0].read_only);
    let repeated = call!(client, json!({"file_path":file, "confirmed":true}));
    assert_ne!(repeated.is_error, Some(true), "{}", output(&repeated));
    output(&repeated);
    assert_eq!(repeated.structured_content.as_ref().unwrap()["imported_count"], 0);
    assert_eq!(repeated.structured_content.as_ref().unwrap()["skipped_count"], 1);
    assert_eq!(storage.load_connections().await.unwrap(), saved);
    client.cancel().await.unwrap();
    server_task.abort();
}

#[tokio::test]
async fn mcp_import_rechecks_policy_between_preview_and_confirmation() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), fixture().to_string().as_bytes());
    let server = server(storage.clone(), directory.path(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    let preview = call!(client, json!({"file_path":file}));
    assert_ne!(preview.is_error, Some(true), "{}", output(&preview));
    output(&preview);
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: true, ..Default::default() }).await.unwrap();
    let preview = call!(client, json!({"file_path":file}));
    assert_ne!(preview.is_error, Some(true), "{}", output(&preview));
    output(&preview);
    let blocked = call!(client, json!({"file_path":file, "confirmed":true}));
    assert_eq!(blocked.is_error, Some(true));
    assert!(output(&blocked).contains("MCP_READ_ONLY"));
    assert!(storage.load_connections().await.unwrap().is_empty());
    client.cancel().await.unwrap();
    server_task.abort();
}

#[tokio::test]
async fn mcp_import_rejects_malformed_or_encrypted_input_without_echoing_values() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let server = server(storage.clone(), directory.path(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    for bytes in [
        b"{mcp-import-secret}".to_vec(),
        json!({"format":"dbx-encrypted", "version":1, "data":"mcp-import-secret"}).to_string().into_bytes(),
    ] {
        let file = protected_file(directory.path(), &bytes);
        let result = call!(client, json!({"file_path":file, "confirmed":true}));
        assert_eq!(result.is_error, Some(true));
        output(&result);
        assert!(storage.load_connections().await.unwrap().is_empty());
    }
    let stdin = call!(client, json!({"file_path":"-", "confirmed":true}));
    assert_eq!(stdin.is_error, Some(true));
    client.cancel().await.unwrap();
    server_task.abort();
}

#[cfg(unix)]
#[tokio::test]
async fn mcp_import_rejects_group_readable_file() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(directory.path(), fixture().to_string().as_bytes());
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
    let server = server(storage.clone(), directory.path(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    for confirmed in [false, true] {
        let result = call!(client, json!({"file_path":file, "confirmed":confirmed}));
        assert_eq!(result.is_error, Some(true));
        assert!(output(&result).contains("INSECURE_INPUT"));
    }
    assert!(storage.load_connections().await.unwrap().is_empty());
    client.cancel().await.unwrap();
    server_task.abort();
}

#[tokio::test]
async fn mcp_import_is_unavailable_in_web_mode_or_scoped_sessions() {
    for (scope, web_mode) in [
        (McpScope::default(), true),
        (McpScope { connection_ids: vec!["scoped".into()], ..Default::default() }, false),
        (McpScope { database: Some("scoped".into()), ..Default::default() }, false),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
        storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
        let file = protected_file(directory.path(), fixture().to_string().as_bytes());
        let server = server(storage.clone(), directory.path(), scope, web_mode);
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let client = ().serve(client_transport).await.unwrap();
        let tools = client.peer().list_all_tools().await.unwrap();
        assert!(!tools.iter().any(|tool| tool.name == "dbx_import_connections"));
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_import_connections")
                    .with_arguments(json!({"file_path":file, "confirmed":true}).as_object().unwrap().clone()),
            )
            .await;
        assert!(result.is_err() || result.unwrap().is_error == Some(true));
        assert!(storage.load_connections().await.unwrap().is_empty());
        client.cancel().await.unwrap();
        server_task.abort();
    }
}

#[tokio::test]
async fn mcp_import_encrypted_bundle_uses_only_passphrase_file_paths() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let file = protected_file(
        directory.path(),
        include_bytes!("../../dbx-core/tests/fixtures/connection_import_encrypted.json"),
    );
    let passphrase_dir = tempfile::tempdir().unwrap();
    let passphrase = protected_file(passphrase_dir.path(), b"incorrect-passphrase");
    let server = server(storage.clone(), directory.path(), McpScope::default(), false);
    let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
    let server_task = tokio::spawn(async move { server.serve(server_transport).await });
    let client = ().serve(client_transport).await.unwrap();
    let missing = call!(client, json!({"file_path":file}));
    assert_eq!(missing.is_error, Some(true));
    assert!(output(&missing).contains("IMPORT_PASSPHRASE_REQUIRED"));
    let wrong = call!(client, json!({"file_path":file, "passphrase_file":passphrase, "confirmed":true}));
    assert_eq!(wrong.is_error, Some(true));
    assert!(output(&wrong).contains("IMPORT_DECRYPT_FAILED"));
    assert!(storage.load_connections().await.unwrap().is_empty());
    protected_file(passphrase_dir.path(), b"synthetic-import-passphrase\n");
    let preview = call!(client, json!({"file_path":file, "passphrase_file":passphrase}));
    assert_ne!(preview.is_error, Some(true), "{}", output(&preview));
    output(&preview);
    assert_eq!(preview.structured_content.as_ref().unwrap()["dry_run"], true);
    assert!(storage.load_connections().await.unwrap().is_empty());
    let applied = call!(client, json!({"file_path":file, "passphrase_file":passphrase, "confirmed":true}));
    assert_ne!(applied.is_error, Some(true), "{}", output(&applied));
    output(&applied);
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "synthetic-encrypted-password");
    client.cancel().await.unwrap();
    server_task.abort();
}
