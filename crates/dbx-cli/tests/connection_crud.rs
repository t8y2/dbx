//! Smoke the actual CLI executable against isolated, desktop-compatible SQLite storage.
use dbx_core::{
    persistence::{secret_codec::managed_key_path, test_storage},
    storage::McpGlobalPolicy,
};
use serde_json::{json, Value};
use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

fn invoke(directory: &std::path::Path, args: &[&str], input: Option<Value>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_dbx"));
    command
        .args(args)
        .current_dir(directory)
        .env("HOME", directory)
        .env("XDG_DATA_HOME", directory)
        .env("DBX_DATA_DIR", directory)
        .env("DBX_SECRET_KEY_FILE", managed_key_path(directory))
        .env_remove("DBX_SECRET_KEY")
        .env_remove("DBX_WEB_URL")
        .env_remove("DBX_WEB_PASSWORD")
        .env_remove("DBX_MCP_ALLOW_WRITES")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_ID")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_IDS")
        .env_remove("DBX_MCP_SCOPE_CONNECTION_NAME")
        .env_remove("DBX_MCP_SCOPE_DATABASE")
        .env_remove("DBX_MCP_SCOPE_SCHEMA")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().unwrap();
    if let Some(value) = input {
        child.stdin.take().unwrap().write_all(value.to_string().as_bytes()).unwrap();
    }
    child.wait_with_output().unwrap()
}

#[tokio::test]
async fn native_cli_connection_crud_smoke() {
    let directory = tempfile::tempdir().unwrap();
    let storage = test_storage::open(&directory.path().join("dbx.db")).await.unwrap();
    storage.save_mcp_global_policy(&McpGlobalPolicy { read_only: false, ..Default::default() }).await.unwrap();
    let database_path = directory.path().join("business-database.sqlite");
    let added = invoke(
        directory.path(),
        &["connections", "add", "--file", "-", "--json"],
        Some(json!({
            "name":"native-fixture", "db_type":"sqlite", "host":database_path, "port":0, "password":"native-fixture-secret", "read_only":true
        })),
    );
    assert!(added.status.success(), "{}", String::from_utf8_lossy(&added.stderr));
    assert!(!String::from_utf8_lossy(&added.stdout).contains("native-fixture-secret"));
    let added: Value = serde_json::from_slice(&added.stdout).unwrap();
    let id = added["id"].as_str().unwrap();
    let changed = invoke(
        directory.path(),
        &["connections", "update", id, "--file", "-", "--json"],
        Some(json!({"read_only":false})),
    );
    assert!(changed.status.success(), "{}", String::from_utf8_lossy(&changed.stderr));
    assert_eq!(storage.load_connections().await.unwrap()[0].password, "native-fixture-secret");
    let got = invoke(directory.path(), &["connections", "get", id, "--json"], None);
    assert!(got.status.success());
    assert_eq!(serde_json::from_slice::<Value>(&got.stdout).unwrap()["read_only"], false);
    let listed = invoke(directory.path(), &["connections", "list", "--json"], None);
    assert!(listed.status.success());
    assert!(!String::from_utf8_lossy(&listed.stdout).contains("native-fixture-secret"));
    let unconfirmed = invoke(directory.path(), &["connections", "remove", id, "--json"], None);
    assert!(!unconfirmed.status.success());
    assert!(String::from_utf8_lossy(&unconfirmed.stderr).contains("CONFIRMATION_REQUIRED"));
    let removed = invoke(directory.path(), &["connections", "remove", id, "--yes", "--json"], None);
    assert!(removed.status.success(), "{}", String::from_utf8_lossy(&removed.stderr));
    assert!(storage.load_connections().await.unwrap().is_empty());
    assert!(!database_path.exists(), "configuration operations must not create the database");
}
