use std::sync::Arc;

use dbx_core::{
    mcp_result_protection::McpResultProtectionPolicy,
    models::connection::ConnectionConfig,
    storage::{McpGlobalPolicy, Storage},
};
use dbx_mcp::{DbxBackend, DbxMcpServer, LocalBackend, McpScope};
use rmcp::{
    model::{CallToolRequestParams, CallToolResult},
    ServiceExt,
};
use serde_json::{json, Value};
use tempfile::{tempdir, TempDir};

const PHONE: &str = "13812345678";
const PASSWORD: &str = "synthetic-password-8361";
const TOKEN: &str = "synthetic-token-8361";

struct Fixture {
    _directory: TempDir,
    storage: Storage,
    connection: ConnectionConfig,
    backend: Arc<LocalBackend>,
}

fn protection(mode: &str) -> McpResultProtectionPolicy {
    serde_json::from_value(json!({
        "default": { "enabled": true, "mode": mode, "rules": [
            { "id": "phone", "columnPattern": "phone", "action": "partial", "keepPrefix": 3, "keepSuffix": 4 },
            { "id": "credentials", "columnPattern": "password|token", "action": "remove" }
        ] }
    }))
    .unwrap()
}

impl Fixture {
    async fn new() -> Self {
        let directory = tempdir().unwrap();
        let db_path = directory.path().join("dbx.db");
        let storage = Storage::open(&db_path).await.unwrap();
        std::fs::File::create(directory.path().join("data.sqlite")).unwrap();
        let connection: ConnectionConfig = serde_json::from_value(json!({
            "id": "protected-sqlite", "name": "Protected SQLite", "db_type": "sqlite",
            "host": directory.path().join("data.sqlite").to_string_lossy(), "port": 0, "username": "", "password": "",
            "database": "main", "ssl": false
        }))
        .unwrap();
        storage.save_connections(std::slice::from_ref(&connection)).await.unwrap();
        let backend = Arc::new(LocalBackend::open(&db_path).await.unwrap());
        let fixture = Self { _directory: directory, storage, connection, backend };
        fixture.sql("CREATE TABLE users (phone TEXT, password TEXT DEFAULT 'synthetic-default-8361', token TEXT, name TEXT, profile TEXT)").await;
        fixture.sql(&format!("INSERT INTO users VALUES ('{PHONE}', '{PASSWORD}', '{TOKEN}', 'Alice', '{{\"token\":\"{TOKEN}\",\"phone\":\"{PHONE}\"}}')")).await;
        fixture
    }

    async fn sql(&self, sql: &str) {
        self.backend
            .execute_query(&self.connection, self.connection.database.as_deref().unwrap(), sql, None, Some(15))
            .await
            .unwrap();
    }

    async fn set_policy(&self, result_protection: McpResultProtectionPolicy) {
        self.storage
            .save_mcp_global_policy(&McpGlobalPolicy { read_only: true, result_protection, ..Default::default() })
            .await
            .unwrap();
    }

    async fn call(&self, tool: &str, mut arguments: Value) -> CallToolResult {
        arguments.as_object_mut().unwrap().entry("connection_id").or_insert_with(|| json!(self.connection.id));
        let server = DbxMcpServer::with_runtime_options(self.backend.clone(), McpScope::default(), false);
        let (server_transport, client_transport) = tokio::io::duplex(64 * 1024);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let client = ().serve(client_transport).await.unwrap();
        let running_server = server_task.await.unwrap().unwrap();
        let result = client
            .peer()
            .call_tool(
                CallToolRequestParams::new(tool.to_owned()).with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        client.cancel().await.unwrap();
        running_server.cancel().await.unwrap();
        result
    }
}

fn assert_no_secrets(result: &CallToolResult) {
    let wire = serde_json::to_string(result).unwrap();
    for secret in [PHONE, PASSWORD, TOKEN, "synthetic-default-8361"] {
        assert!(!wire.contains(secret), "Response exposed a synthetic secret");
    }
}

#[tokio::test]
async fn strict_queries_mask_aliases_and_nested_json_in_both_channels() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("strict")).await;
    let result = fixture
        .call(
            "dbx_execute_query",
            json!({ "sql": "SELECT phone AS remark, password, token, name, profile FROM users" }),
        )
        .await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
    let structured = result.structured_content.as_ref().unwrap();
    assert_eq!(structured["columns"], json!(["remark", "name", "profile"]));
    assert_eq!(structured["rows"][0][0], "138***5678");
    assert!(result.content[0].as_text().unwrap().text.contains("138***5678"));
    assert!(result.content[0].as_text().unwrap().text.contains("Alice"));
}

#[tokio::test]
async fn every_batch_result_uses_the_same_policy() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("strict")).await;
    let result = fixture
        .call(
            "dbx_execute_batch",
            json!({ "sql": "SELECT phone AS remark, password FROM users; SELECT token, phone, name FROM users" }),
        )
        .await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
    let statements = result.structured_content.as_ref().unwrap().as_array().unwrap();
    assert_eq!(statements.len(), 2);
    assert_eq!(statements[0]["columns"], json!(["remark"]));
    assert_eq!(statements[1]["columns"], json!(["phone", "name"]));
    assert_eq!(statements[0]["rows"][0][0], "138***5678");
    assert_eq!(statements[1]["rows"][0][0], "138***5678");
    assert!(statements.iter().all(|result| result.get("error_message").is_none()));
}

#[tokio::test]
async fn strict_mode_refuses_transformations_views_and_generated_columns() {
    let fixture = Fixture::new().await;
    fixture.sql("CREATE VIEW masked_origin AS SELECT phone AS remark FROM users").await;
    fixture.sql("CREATE TABLE generated_users (phone TEXT, remark TEXT GENERATED ALWAYS AS (phone) STORED)").await;
    fixture.sql(&format!("INSERT INTO generated_users (phone) VALUES ('{PHONE}')")).await;
    fixture.set_policy(protection("strict")).await;
    for sql in [
        "SELECT phone || '-suffix' AS remark FROM users",
        "SELECT json_extract(profile, '$.phone') AS remark FROM users",
        "SELECT remark FROM (SELECT phone AS remark FROM users)",
        "SELECT remark FROM masked_origin",
        "SELECT remark FROM generated_users",
        "SELECT * FROM generated_users",
    ] {
        let result = fixture.call("dbx_execute_query", json!({ "sql": sql })).await;
        assert_eq!(result.is_error, Some(true), "Strict mode accepted {sql}");
        assert!(result.structured_content.is_none());
        assert_no_secrets(&result);
    }
}

#[tokio::test]
async fn wildcard_queries_keep_columns_aligned() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("strict")).await;
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT * FROM users" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
    assert_eq!(result.structured_content.unwrap()["columns"], json!(["phone", "name", "profile"]));
}

#[tokio::test]
async fn errors_are_data_free_even_when_a_batch_continues() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("nameOnly")).await;
    let missing = "missing_synthetic_secret_8361";
    let result = fixture.call("dbx_execute_query", json!({ "sql": format!("SELECT * FROM {missing}") })).await;
    assert_eq!(result.is_error, Some(true));
    assert!(!serde_json::to_string(&result).unwrap().contains(missing));
    assert_no_secrets(&result);
    let result = fixture.call("dbx_execute_batch", json!({
        "sql": format!("SELECT phone FROM users; SELECT * FROM {missing}; SELECT token, name FROM users"), "continue_on_error": true
    })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
    assert!(!serde_json::to_string(&result).unwrap().contains(missing));
    let statements = result.structured_content.as_ref().unwrap().as_array().unwrap();
    assert_eq!(statements.len(), 3);
    assert_eq!(statements[1]["execution_error"], true);
    assert_eq!(statements[1]["rows"], json!([]));
    assert_eq!(statements[2]["rows"][0][0], "Alice");
}

#[tokio::test]
async fn schema_tools_omit_literal_defaults_and_policy_does_not_relax_read_only() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("strict")).await;
    for tool in ["dbx_describe_table", "dbx_get_schema_context"] {
        let result = fixture.call(tool, json!({ "table": "users", "tables": ["users"] })).await;
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert_no_secrets(&result);
        assert!(result.content[0].as_text().unwrap().text.contains("phone"));
    }
    let result = fixture.call("dbx_execute_query", json!({ "sql": "DELETE FROM users" })).await;
    assert_eq!(result.is_error, Some(true));
    fixture.set_policy(McpResultProtectionPolicy::default()).await;
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT phone FROM users" })).await;
    assert_ne!(result.is_error, Some(true));
    assert!(result.content[0].as_text().unwrap().text.contains(PHONE));
    assert!(result.structured_content.is_none());
}

#[tokio::test]
async fn invalid_policy_save_preserves_the_previous_protection() {
    let fixture = Fixture::new().await;
    fixture.set_policy(protection("strict")).await;
    let mut invalid = protection("strict");
    invalid.default.rules[0].column_pattern = Some("[invalid-private-pattern".to_string());
    let error = fixture
        .storage
        .save_mcp_global_policy(&McpGlobalPolicy { result_protection: invalid, ..Default::default() })
        .await
        .unwrap_err();
    assert!(!error.contains("invalid-private-pattern"));
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT phone FROM users" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
}

#[tokio::test]
async fn implicit_schema_rules_and_temporary_shadows_cannot_bypass_protection() {
    let fixture = Fixture::new().await;
    let mut policy = protection("strict");
    policy.default.rules[0].schema = Some("main".to_string());
    fixture.set_policy(policy).await;
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT phone AS remark FROM users" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);

    fixture.sql("ALTER TABLE main.users ADD COLUMN remark TEXT DEFAULT 'safe'").await;
    fixture.sql("CREATE TEMP VIEW users AS SELECT phone AS remark FROM main.users").await;
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT remark FROM users" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
    assert_eq!(result.structured_content.unwrap()["rows"][0][0], "safe");
}

#[tokio::test]
async fn duplicated_connections_preserve_result_protection_overrides() {
    let fixture = Fixture::new().await;
    let policy: McpResultProtectionPolicy = serde_json::from_value(json!({
        "overrides": [{ "connectionId": fixture.connection.id, "settings": protection("strict").default }]
    }))
    .unwrap();
    fixture
        .storage
        .save_mcp_global_policy(&McpGlobalPolicy { result_protection: policy, ..Default::default() })
        .await
        .unwrap();
    let result = fixture.call("dbx_duplicate_connection", json!({ "new_name": "Protected copy" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    let connections = fixture.storage.load_connections().await.unwrap();
    let copy = connections.iter().find(|connection| connection.id != fixture.connection.id).unwrap();
    let result =
        fixture.call("dbx_execute_query", json!({ "connection_id": copy.id, "sql": "SELECT phone FROM users" })).await;
    assert_ne!(result.is_error, Some(true), "{result:?}");
    assert_no_secrets(&result);
}

#[tokio::test]
async fn database_overrides_cannot_be_bypassed_with_sqlite_database_arguments() {
    let fixture = Fixture::new().await;
    let policy = serde_json::from_value(json!({
        "overrides": [{
            "connectionId": fixture.connection.id, "database": "main", "settings": protection("strict").default
        }]
    }))
    .unwrap();
    fixture.set_policy(policy).await;
    for tool in ["dbx_execute_query", "dbx_execute_batch"] {
        for database in ["main", "MAIN", "other"] {
            let result = fixture.call(tool, json!({ "database": database, "sql": "SELECT phone FROM users" })).await;
            if database == "other" {
                assert_eq!(result.is_error, Some(true), "A database argument cannot retarget a SQLite file");
            } else {
                assert_ne!(result.is_error, Some(true), "{result:?}");
            }
            assert_no_secrets(&result);
        }
    }
}

#[tokio::test]
async fn sqlite_schema_arguments_cannot_select_another_database_policy() {
    let fixture = Fixture::new().await;
    fixture.sql("ATTACH DATABASE ':memory:' AS archive").await;
    fixture.sql(&format!("CREATE TABLE archive.users (phone TEXT DEFAULT '{PHONE}')")).await;
    fixture.sql("INSERT INTO archive.users DEFAULT VALUES").await;
    let mut policy = protection("strict");
    policy.overrides.push(
        serde_json::from_value(json!({
            "connectionId": fixture.connection.id, "database": "main", "settings": { "enabled": false }
        }))
        .unwrap(),
    );
    fixture.set_policy(policy).await;
    for (tool, arguments) in [
        ("dbx_execute_query", json!({ "database": "archive", "sql": "SELECT phone FROM users" })),
        ("dbx_execute_query", json!({ "database": "main", "sql": "SELECT phone FROM archive.users" })),
        ("dbx_execute_batch", json!({ "database": "main", "sql": "SELECT phone FROM archive.users" })),
        ("dbx_describe_table", json!({ "database": "main", "schema": "archive", "table": "users" })),
        ("dbx_get_schema_context", json!({ "database": "main", "schema": "archive", "tables": ["users"] })),
    ] {
        let result = fixture.call(tool, arguments).await;
        assert_eq!(result.is_error, Some(true), "{tool}: {result:?}");
        assert_no_secrets(&result);
    }
}

#[tokio::test]
async fn sqlite_database_overrides_reject_implicit_attached_table_lookup() {
    let fixture = Fixture::new().await;
    fixture.sql("ATTACH DATABASE ':memory:' AS archive").await;
    fixture.sql("CREATE TABLE archive.archive_users AS SELECT * FROM main.users").await;
    let mut policy = protection("strict");
    policy.overrides.push(
        serde_json::from_value(json!({
            "connectionId": fixture.connection.id, "database": "main", "settings": { "enabled": false }
        }))
        .unwrap(),
    );
    fixture.set_policy(policy).await;
    for tool in ["dbx_execute_query", "dbx_execute_batch"] {
        let result = fixture.call(tool, json!({ "database": "main", "sql": "SELECT phone FROM archive_users" })).await;
        assert_eq!(result.is_error, Some(true), "{tool}: {result:?}");
        assert_no_secrets(&result);
    }
}

#[test]
fn protected_queries_preserve_confirmed_sql_binding() {
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "protected_confirmation_worker", "--ignored", "--nocapture"])
        .env("DBX_MCP_CONFIRMED_WRITE_SQL", "UPDATE users SET name = 'Approved' WHERE name = 'Alice'")
        .status()
        .unwrap();
    assert!(status.success());
}

#[tokio::test]
#[ignore = "invoked in a subprocess with an isolated confirmed-SQL environment"]
async fn protected_confirmation_worker() {
    let fixture = Fixture::new().await;
    fixture
        .storage
        .save_mcp_global_policy(&McpGlobalPolicy { result_protection: protection("nameOnly"), ..Default::default() })
        .await
        .unwrap();
    let result = fixture
        .call("dbx_execute_query", json!({ "sql": "UPDATE users SET name = 'Not approved' WHERE name = 'Alice'" }))
        .await;
    assert_eq!(result.is_error, Some(true), "{result:?}");
    let result = fixture.call("dbx_execute_query", json!({ "sql": "SELECT name FROM users" })).await;
    assert_eq!(result.structured_content.unwrap()["rows"][0][0], "Alice");
}
