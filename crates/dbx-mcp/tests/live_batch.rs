//! Live regression for `dbx_execute_batch` transaction semantics against real
//! MySQL and PostgreSQL servers (reviewer evidence for issue #7548).
//!
//! Credentials come ONLY from environment variables — never committed:
//!
//! ```text
//! DBX_LIVE_MYSQL_HOST / DBX_LIVE_MYSQL_PORT / DBX_LIVE_MYSQL_USER
//! DBX_LIVE_MYSQL_PASSWORD / DBX_LIVE_MYSQL_DATABASE
//! DBX_LIVE_PG_HOST / DBX_LIVE_PG_PORT / DBX_LIVE_PG_USER
//! DBX_LIVE_PG_PASSWORD / DBX_LIVE_PG_DATABASE
//! ```
//!
//! Run with:
//! ```text
//! DBX_LIVE_MYSQL_*=... DBX_LIVE_PG_*=... cargo test -p dbx-mcp --test live_batch -- --ignored --nocapture
//! ```
//!
//! What this proves:
//! * MySQL-family DDL scripts with `use_transaction=true` are rejected
//!   (`TRANSACTION_WITH_DDL_UNSUPPORTED`) before touching the database, because
//!   MySQL DDL implicitly commits and cannot be rolled back. Nothing is left
//!   behind.
//! * MySQL pure-DML `use_transaction` batches actually run in a transaction: a
//!   mid-batch failure rolls the whole batch back (0 rows persist).
//! * PostgreSQL DDL is transactional: a `CREATE TABLE` followed by a failing
//!   statement rolls back the DDL too (the table does not exist afterward),
//!   which is exactly the contrast that motivated the MySQL guard.

use std::sync::Arc;

use dbx_core::{models::connection::ConnectionConfig, storage::McpGlobalPolicy, storage::Storage};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde_json::{json, Map};

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} to run the live batch tests"))
}

/// Build the MySQL connection config and database name from `DBX_LIVE_MYSQL_*`.
/// Each engine is independent so a test can run with only its own env set.
fn mysql_env() -> (ConnectionConfig, String) {
    build_env("DBX_LIVE_MYSQL", "live-mysql", "mysql")
}

/// Build the PostgreSQL connection config and database name from `DBX_LIVE_PG_*`.
fn postgres_env() -> (ConnectionConfig, String) {
    build_env("DBX_LIVE_PG", "live-postgres", "postgres")
}

fn build_env(prefix: &str, id: &str, db_type: &str) -> (ConnectionConfig, String) {
    let config = serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": db_type,
        "host": required_env(&format!("{prefix}_HOST")),
        "port": required_env(&format!("{prefix}_PORT")).parse::<u16>().expect("numeric port"),
        "username": required_env(&format!("{prefix}_USER")),
        "password": required_env(&format!("{prefix}_PASSWORD")),
        "database": required_env(&format!("{prefix}_DATABASE")),
        "ssl": false,
    }))
    .expect("build live connection config");
    (config, required_env(&format!("{prefix}_DATABASE")))
}

fn full_access_policy() -> McpGlobalPolicy {
    McpGlobalPolicy {
        read_only: false,
        allow_dangerous_sql: true,
        allowed_connection_ids: None,
        allowed_tool_names: None,
        connection_policies: vec![],
        query_timeout_secs: None,
    }
}

/// Like `full_access_policy()` but with a 1s global MCP query timeout, used to
/// prove that `use_transaction` batches honor the MCP query-timeout policy.
fn short_timeout_policy() -> McpGlobalPolicy {
    McpGlobalPolicy {
        read_only: false,
        allow_dangerous_sql: true,
        allowed_connection_ids: None,
        allowed_tool_names: None,
        connection_policies: vec![],
        query_timeout_secs: Some(1),
    }
}

/// Boot a real `DbxMcpServer` over a live LocalBackend seeded from a temp
/// storage db. Returns `(client, server_task, temp_dir)`; `temp_dir` must stay
/// alive for the test so the sqlite file is not deleted mid-run.
macro_rules! boot_live_server {
    ($connections:expr, $policy:expr) => {{
        let dir = tempfile::tempdir().expect("temp dir");
        let storage = Storage::open(&dir.path().join("dbx.db")).await.expect("open storage");
        for config in $connections {
            storage.add_connection_for_mcp(config.clone()).await.expect("add connection");
        }
        storage.save_mcp_global_policy(&$policy).await.expect("save policy");
        drop(storage);
        let backend = Arc::new(LocalBackend::open(&dir.path().join("dbx.db")).await.expect("open LocalBackend"));
        let server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
        let (server_transport, client_transport) = tokio::io::duplex(16 * 1024);
        let server_task = tokio::spawn(async move { server.serve(server_transport).await });
        let client = ().serve(client_transport).await.expect("initialize MCP client");
        (client, server_task, dir)
    }};
}

/// Unique table names so repeated runs (and the two engines) never collide.
/// The tests intentionally leave tables behind on the live server, so a UUID
/// (rather than a per-process counter) also protects against PID reuse after a
/// crashed earlier run left a same-named table behind.
fn unique_table(prefix: &str) -> String {
    format!("mcp_live_{prefix}_{}", uuid::Uuid::new_v4().simple())
}

fn arguments(object: serde_json::Value) -> Map<String, serde_json::Value> {
    object.as_object().cloned().unwrap_or_else(Map::new)
}

/// Call `dbx_execute_query` on the live server; returns `(is_error, text)`.
macro_rules! query {
    ($client:expr, $connection_id:expr, $database:expr, $sql:expr) => {{
        let result = $client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                    "connection_id": $connection_id,
                    "database": $database,
                    "sql": $sql,
                }))),
            )
            .await
            .expect("call dbx_execute_query");
        let text = result
            .content
            .iter()
            .filter_map(|block| block.as_text().map(|t| t.text.clone()))
            .collect::<Vec<_>>()
            .join("\n");
        (result.is_error == Some(true), text)
    }};
}

/// Call `dbx_execute_batch` on the live server; returns `(is_error, text)`.
macro_rules! batch {
    ($client:expr, $connection_id:expr, $database:expr, $sql:expr, $use_transaction:expr) => {{
        let result = $client
            .peer()
            .call_tool(
                CallToolRequestParams::new("dbx_execute_batch").with_arguments(arguments(json!({
                    "connection_id": $connection_id,
                    "database": $database,
                    "sql": $sql,
                    "use_transaction": $use_transaction,
                }))),
            )
            .await
            .expect("call dbx_execute_batch");
        let text = result
            .content
            .iter()
            .filter_map(|block| block.as_text().map(|t| t.text.clone()))
            .collect::<Vec<_>>()
            .join("\n");
        (result.is_error == Some(true), text)
    }};
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_* and DBX_LIVE_PG_* env pointing at reachable MySQL 5.7 / PostgreSQL"]
async fn mysql_batch_rejects_ddl_transaction_and_rolls_back_failed_dml() {
    let (mysql, mysql_database) = mysql_env();
    let (client, server_task, _dir) = boot_live_server!([mysql], full_access_policy());
    let db = mysql_database.as_str();

    // 1) DDL + use_transaction is rejected BEFORE execution, and no partial DDL
    //    is left behind (MySQL DDL implicitly commits; a table must not exist).
    let ddl_table = unique_table("mysql_ddl");
    let (is_error, text) = batch!(
        &client,
        "live-mysql",
        db,
        format!("CREATE TABLE {ddl_table} (id INT); INSERT INTO {ddl_table} VALUES (1)"),
        true
    );
    assert!(is_error, "DDL+transaction must be rejected, got: {text}");
    assert!(
        text.contains("TRANSACTION_WITH_DDL_UNSUPPORTED"),
        "expected TRANSACTION_WITH_DDL_UNSUPPORTED, got: {text}"
    );
    let (select_error, select_text) = query!(&client, "live-mysql", db, format!("SELECT * FROM {ddl_table}"));
    assert!(select_error, "DDL table must not exist after the rejected batch, got: {select_text}");

    // 2) Pure-DML transaction batch succeeds and returns a merged outcome.
    let ok_table = unique_table("mysql_dml_ok");
    let (create_error, create_text) = query!(&client, "live-mysql", db, format!("CREATE TABLE {ok_table} (n INT)"));
    assert!(!create_error, "setup CREATE TABLE failed: {create_text}");
    let (is_error, text) = batch!(
        &client,
        "live-mysql",
        db,
        format!("INSERT INTO {ok_table} (n) VALUES (1); INSERT INTO {ok_table} (n) VALUES (2)"),
        true
    );
    assert!(!is_error, "DML transaction batch failed: {text}");
    assert!(text.contains("Transaction outcome"), "expected a merged transaction outcome, got: {text}");
    let (_, count_text) = query!(&client, "live-mysql", db, format!("SELECT COUNT(*) AS c FROM {ok_table}"));
    assert!(count_text.contains("c") && count_text.contains("2"), "expected 2 persisted rows, got: {count_text}");

    // 3) A mid-batch DML failure rolls the whole transaction back (0 rows).
    let fail_table = unique_table("mysql_dml_fail");
    let (create_error, create_text) = query!(&client, "live-mysql", db, format!("CREATE TABLE {fail_table} (n INT)"));
    assert!(!create_error, "setup CREATE TABLE failed: {create_text}");
    let (is_error, text) = batch!(
        &client,
        "live-mysql",
        db,
        format!(
            "INSERT INTO {fail_table} (n) VALUES (1); INSERT INTO {fail_table} (n) VALUES (2); INSERT INTO {fail_table}_missing (n) VALUES (3)"
        ),
        true
    );
    assert!(is_error, "expected the failing DML transaction batch to error, got: {text}");
    assert!(text.contains("DBX_BATCH_EXECUTION_ERROR"), "expected execution error, got: {text}");
    let (_, count_text) = query!(&client, "live-mysql", db, format!("SELECT COUNT(*) AS c FROM {fail_table}"));
    assert!(
        count_text.contains("c") && count_text.contains("0"),
        "expected the whole batch to roll back (0 rows), got: {count_text}"
    );

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_* and DBX_LIVE_PG_* env pointing at reachable MySQL 5.7 / PostgreSQL"]
async fn postgres_transaction_batch_respects_mcp_query_timeout() {
    let (postgres, postgres_database) = postgres_env();
    let (client, server_task, _dir) = boot_live_server!([postgres], short_timeout_policy());
    let db = postgres_database.as_str();

    // A use_transaction batch must honor the MCP global query-timeout policy:
    // pg_sleep(3) exceeds the 1s policy, so the whole transactional batch errors
    // instead of returning a successful merged outcome. Regression for the P1
    // where the transaction path ignored options.timeout_secs and ran unbounded.
    let (is_error, text) = batch!(&client, "live-postgres", db, "SELECT pg_sleep(3); SELECT 1", true);
    assert!(is_error, "expected the PostgreSQL transaction batch to time out, got: {text}");
    assert!(
        text.contains("DBX_BATCH_EXECUTION_ERROR") || text.contains("Query timed out"),
        "expected a timeout surfaced as an execution error, got: {text}"
    );
    assert!(!text.contains("Transaction outcome"), "the batch must NOT be a successful merged outcome, got: {text}");

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_* and DBX_LIVE_PG_* env pointing at reachable MySQL 5.7 / PostgreSQL"]
async fn mysql_transaction_batch_respects_mcp_query_timeout() {
    let (mysql, mysql_database) = mysql_env();
    let (client, server_task, _dir) = boot_live_server!([mysql], short_timeout_policy());
    let db = mysql_database.as_str();

    // Same shape as the PostgreSQL timeout test: SLEEP(3) exceeds the 1s MCP
    // policy, so the transactional batch errors instead of a merged outcome.
    // (Whether the driver also aborts the server-side SLEEP is an observation;
    // the requirement here is that the error surfaces to the caller.)
    let (is_error, text) = batch!(&client, "live-mysql", db, "SELECT SLEEP(3); SELECT 1", true);
    assert!(is_error, "expected the MySQL transaction batch to time out, got: {text}");
    assert!(
        text.contains("DBX_BATCH_EXECUTION_ERROR") || text.contains("Query timed out"),
        "expected a timeout surfaced as an execution error, got: {text}"
    );
    assert!(!text.contains("Transaction outcome"), "the batch must NOT be a successful merged outcome, got: {text}");

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_* and DBX_LIVE_PG_* env pointing at reachable MySQL 5.7 / PostgreSQL"]
async fn postgres_batch_runs_ddl_inside_a_rollbackable_transaction() {
    let (postgres, postgres_database) = postgres_env();
    let (client, server_task, _dir) = boot_live_server!([postgres], full_access_policy());
    let db = postgres_database.as_str();

    // PostgreSQL DDL is transactional: a CREATE TABLE + INSERT in one
    // use_transaction batch succeeds and the table persists.
    let ok_table = unique_table("pg_ddl_ok");
    let (is_error, text) = batch!(
        &client,
        "live-postgres",
        db,
        format!("CREATE TABLE {ok_table} (id INT); INSERT INTO {ok_table} VALUES (1)"),
        true
    );
    assert!(!is_error, "PostgreSQL DDL transaction batch failed: {text}");
    assert!(text.contains("Transaction outcome"), "expected a merged transaction outcome, got: {text}");
    let (_, count_text) = query!(&client, "live-postgres", db, format!("SELECT COUNT(*) AS c FROM {ok_table}"));
    assert!(
        count_text.contains("c") && count_text.contains("1"),
        "expected the CREATE TABLE to persist (1 row), got: {count_text}"
    );

    // PostgreSQL DDL rolls back: CREATE TABLE + failing statement leaves no
    // table behind — the exact contrast to MySQL's implicit-commit DDL.
    let fail_table = unique_table("pg_ddl_fail");
    let missing = unique_table("pg_missing");
    let (is_error, text) = batch!(
        &client,
        "live-postgres",
        db,
        format!("CREATE TABLE {fail_table} (id INT); INSERT INTO {missing} VALUES (1)"),
        true
    );
    assert!(is_error, "expected the failing PostgreSQL transaction batch to error, got: {text}");
    assert!(text.contains("DBX_BATCH_EXECUTION_ERROR"), "expected execution error, got: {text}");
    let (select_error, select_text) = query!(&client, "live-postgres", db, format!("SELECT * FROM {fail_table}"));
    assert!(
        select_error,
        "PostgreSQL CREATE TABLE must roll back with the failed batch, table still exists: {select_text}"
    );

    client.cancel().await.expect("close MCP client");
    server_task.abort();
}
