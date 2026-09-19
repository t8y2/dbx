//! Native MySQL 5.7 contention evidence for MCP fixed-session transactions.
//!
//! This ignored test drives the public MCP tools through the production
//! `LocalBackend`. It creates an isolated temporary DBX storage file containing
//! only the candidate connection supplied by environment variables; it never
//! opens or copies the installed application's `dbx.db`.
//!
//! Preferred private environment variable:
//!
//! ```text
//! DBX_TXN_MYSQL_CONNECTION_JSON
//! ```
//!
//! Its value is one already-authorized native MySQL `ConnectionConfig` JSON,
//! including the existing TLS/tunnel settings. An optional
//! `DBX_TXN_MYSQL_FIXTURE_CONNECTION_JSON` may supply a separately authorized
//! fixture configuration; otherwise the candidate configuration is cloned into
//! a distinct logical fixture channel. No account creation or permission
//! widening is performed. The candidate needs SELECT/INSERT/UPDATE/DELETE/
//! REPLACE; the fixture channel must already be allowed to CREATE/DROP only the
//! exact uniquely prefixed table used by this run. Secrets, endpoint details,
//! and the database name are never printed.
//! A runner that has already verified the saved connection is direct plaintext
//! may instead set `DBX_TXN_MYSQL_DIRECT_PLAINTEXT=1` plus the HOST/PORT/
//! DATABASE/USER/PASSWORD fields and optional `DBX_TXN_MYSQL_DRIVER_PROFILE`.

use std::{sync::Arc, time::Duration};

use dbx_core::{models::connection::ConnectionConfig, storage::McpGlobalPolicy, storage::Storage};
use dbx_mcp::{DbxMcpServer, LocalBackend, McpScope};
use rmcp::{
    model::{CallToolRequest, CallToolRequestParams, ClientRequest},
    service::PeerRequestOptions,
    ServiceExt,
};
use serde_json::{json, Map, Value};

fn required_env(name: &str) -> Result<String, String> {
    std::env::var(name).map_err(|_| format!("set {name} through the private live-test environment"))
}

fn candidate_connection_from_env() -> Result<ConnectionConfig, String> {
    if let Ok(value) = std::env::var("DBX_TXN_MYSQL_CONNECTION_JSON") {
        return serde_json::from_str(&value)
            .map_err(|error| format!("DBX_TXN_MYSQL_CONNECTION_JSON is not a valid ConnectionConfig JSON: {error}"));
    }
    if std::env::var("DBX_TXN_MYSQL_DIRECT_PLAINTEXT").as_deref() != Ok("1") {
        return Err(
            "field-based credentials require DBX_TXN_MYSQL_DIRECT_PLAINTEXT=1 after the runner verifies that the authorized saved connection uses no TLS, certificate, tunnel, plugin, JDBC, or URL parameters"
                .to_string(),
        );
    }
    let profile = std::env::var("DBX_TXN_MYSQL_DRIVER_PROFILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    serde_json::from_value(json!({
        "id": "mcp-session-transaction-live",
        "name": "mcp-session-transaction-live",
        "db_type": "mysql",
        "driver_profile": profile,
        "host": required_env("DBX_TXN_MYSQL_HOST")?,
        "port": required_env("DBX_TXN_MYSQL_PORT")?.parse::<u16>().map_err(|_| "DBX_TXN_MYSQL_PORT must be numeric".to_string())?,
        "username": required_env("DBX_TXN_MYSQL_USER")?,
        "password": required_env("DBX_TXN_MYSQL_PASSWORD")?,
        "database": required_env("DBX_TXN_MYSQL_DATABASE")?,
        "ssl": false
    }))
    .map_err(|error| format!("build direct-plaintext candidate connection: {error}"))
}

fn is_builtin_native_mysql(connection: &ConnectionConfig) -> bool {
    connection.db_type == dbx_core::models::connection::DatabaseType::Mysql
        && connection.driver_profile.as_deref().is_none_or(|profile| {
            let profile = profile.trim();
            profile.is_empty() || profile.eq_ignore_ascii_case("mysql")
        })
}

fn arguments(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn structured(result: &rmcp::model::CallToolResult) -> Result<&Value, String> {
    result.structured_content.as_ref().ok_or_else(|| "tool response omitted structured content".to_string())
}

fn expect_success(result: &rmcp::model::CallToolResult, operation: &str) -> Result<(), String> {
    if result.is_error == Some(true) {
        Err(format!("{operation} failed (database details redacted)"))
    } else {
        Ok(())
    }
}

fn expect_state(result: &rmcp::model::CallToolResult, state: &str) -> Result<(), String> {
    let actual = structured(result)?.get("transaction_state").and_then(Value::as_str);
    if actual == Some(state) {
        Ok(())
    } else {
        Err(format!("expected transaction_state={state}, got {actual:?}"))
    }
}

fn result_cell(result: &rmcp::model::CallToolResult, row: usize, column: usize) -> Result<&Value, String> {
    structured(result)?
        .pointer(&format!("/result/rows/{row}/{column}"))
        .ok_or_else(|| format!("missing result cell {row}/{column}"))
}

macro_rules! call_tool {
    ($peer:expr, $name:literal, $arguments:expr) => {
        $peer
            .call_tool(CallToolRequestParams::new($name).with_arguments(arguments($arguments)))
            .await
            .map_err(|error| format!("{} transport failure: {error}", $name))
    };
}

async fn run_contention_trace(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    database: &str,
    table: &str,
) -> Result<(), String> {
    let peer = client.peer();
    let connection = "mcp-session-transaction-live";
    let open_a = call_tool!(
        peer,
        "dbx_open_session",
        json!({"connection_id": connection, "database": database, "enable_transactions": true})
    )?;
    let open_b = call_tool!(
        peer,
        "dbx_open_session",
        json!({"connection_id": connection, "database": database, "enable_transactions": true})
    )?;
    expect_success(&open_a, "open A")?;
    expect_success(&open_b, "open B")?;
    expect_state(&open_a, "idle")?;
    expect_state(&open_b, "idle")?;
    let session_a =
        structured(&open_a)?["session_id"].as_str().ok_or_else(|| "open A omitted session_id".to_string())?.to_string();
    let session_b =
        structured(&open_b)?["session_id"].as_str().ok_or_else(|| "open B omitted session_id".to_string())?.to_string();

    let id_a_before = call_tool!(
        peer,
        "dbx_execute_query",
        json!({"connection_id": connection, "database": database, "session_id": session_a, "sql": "SELECT CONNECTION_ID() AS connection_id"})
    )?;
    let id_b_before = call_tool!(
        peer,
        "dbx_execute_query",
        json!({"connection_id": connection, "database": database, "session_id": session_b, "sql": "SELECT CONNECTION_ID() AS connection_id"})
    )?;
    let id_a_before = result_cell(&id_a_before, 0, 0)?.to_string();
    let id_b_before = result_cell(&id_b_before, 0, 0)?.to_string();
    if id_a_before == id_b_before {
        return Err("A and B unexpectedly share one physical MySQL connection".to_string());
    }

    let begin_b = call_tool!(peer, "dbx_begin_transaction", json!({"session_id": session_b}))?;
    expect_success(&begin_b, "B.begin")?;
    expect_state(&begin_b, "active")?;
    let b_absent = call_tool!(
        peer,
        "dbx_execute_query",
        json!({
            "connection_id": connection,
            "database": database,
            "session_id": session_b,
            "sql": format!("SELECT payload FROM {table} WHERE id = 1")
        })
    )?;
    expect_success(&b_absent, "B initial snapshot read")?;
    expect_state(&b_absent, "active")?;
    let rows = structured(&b_absent)?
        .pointer("/result/rows")
        .and_then(Value::as_array)
        .ok_or_else(|| "B initial read omitted rows".to_string())?;
    if !rows.is_empty() {
        return Err("B initial snapshot unexpectedly found the fixture key".to_string());
    }

    let begin_a = call_tool!(peer, "dbx_begin_transaction", json!({"session_id": session_a}))?;
    expect_success(&begin_a, "A.begin")?;
    expect_state(&begin_a, "active")?;
    let a_insert = call_tool!(
        peer,
        "dbx_execute_query",
        json!({
            "connection_id": connection,
            "database": database,
            "session_id": session_a,
            "sql": format!("INSERT INTO {table}(id, payload) VALUES (1, 'exact_winner')")
        })
    )?;
    expect_success(&a_insert, "A.insert")?;
    expect_state(&a_insert, "active")?;

    let pending_peer = peer.clone();
    let pending_database = database.to_string();
    let pending_table = table.to_string();
    let pending_session = session_b.clone();
    let mut b_insert = tokio::spawn(async move {
        pending_peer
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                "connection_id": connection,
                "database": pending_database,
                "session_id": pending_session,
                "sql": format!("INSERT INTO {pending_table}(id, payload) VALUES (1, 'loser')")
            }))))
            .await
    });
    if tokio::time::timeout(Duration::from_millis(300), &mut b_insert).await.is_ok() {
        return Err("B.insert completed before A.commit; contention was not established".to_string());
    }

    let commit_a = call_tool!(peer, "dbx_commit_transaction", json!({"session_id": session_a}))?;
    expect_success(&commit_a, "A.commit")?;
    expect_state(&commit_a, "idle")?;
    if structured(&commit_a)?["transaction_outcome"] != "committed" {
        return Err("A.commit did not report committed".to_string());
    }
    let b_duplicate = tokio::time::timeout(Duration::from_secs(5), b_insert)
        .await
        .map_err(|_| "B.insert did not finish after A.commit".to_string())?
        .map_err(|error| format!("B.insert task failed: {error}"))?
        .map_err(|error| format!("B.insert transport failed: {error}"))?;
    if b_duplicate.is_error != Some(true) {
        return Err("B.insert unexpectedly succeeded".to_string());
    }
    expect_state(&b_duplicate, "active")?;
    if structured(&b_duplicate)?["mysql_code"] != 1062 {
        return Err("B.insert did not preserve MySQL 1062".to_string());
    }

    let b_winner = call_tool!(
        peer,
        "dbx_execute_query",
        json!({
            "connection_id": connection,
            "database": database,
            "session_id": session_b,
            "sql": format!("SELECT payload FROM {table} WHERE id = 1 FOR UPDATE")
        })
    )?;
    expect_success(&b_winner, "B locking read")?;
    expect_state(&b_winner, "active")?;
    if result_cell(&b_winner, 0, 0)?.as_str() != Some("exact_winner") {
        return Err("B locking read did not return A's exact winner".to_string());
    }

    let id_a_after = call_tool!(
        peer,
        "dbx_execute_query",
        json!({"connection_id": connection, "database": database, "session_id": session_a, "sql": "SELECT CONNECTION_ID() AS connection_id"})
    )?;
    let id_b_during = call_tool!(
        peer,
        "dbx_execute_query",
        json!({"connection_id": connection, "database": database, "session_id": session_b, "sql": "SELECT CONNECTION_ID() AS connection_id"})
    )?;
    if result_cell(&id_a_after, 0, 0)?.to_string() != id_a_before {
        return Err("A physical connection identity changed".to_string());
    }
    if result_cell(&id_b_during, 0, 0)?.to_string() != id_b_before {
        return Err("B physical connection identity changed".to_string());
    }

    let rollback_b = call_tool!(peer, "dbx_rollback_transaction", json!({"session_id": session_b}))?;
    expect_success(&rollback_b, "B.rollback")?;
    expect_state(&rollback_b, "idle")?;
    if structured(&rollback_b)?["transaction_outcome"] != "rolled_back" {
        return Err("B.rollback did not report rolled_back".to_string());
    }
    let close_a = call_tool!(peer, "dbx_close_session", json!({"session_id": session_a}))?;
    let close_b = call_tool!(peer, "dbx_close_session", json!({"session_id": session_b}))?;
    expect_success(&close_a, "close A")?;
    expect_success(&close_b, "close B")?;
    Ok(())
}

async fn run_native_cleanup_traces(
    candidate: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    fixture: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    database: &str,
    table: &str,
) -> Result<(), String> {
    let connection = "mcp-session-transaction-live";
    let fixture_connection = "mcp-session-transaction-fixture";

    let seed_close = call_tool!(
        fixture.peer(),
        "dbx_execute_query",
        json!({
            "connection_id": fixture_connection,
            "database": database,
            "sql": format!("INSERT INTO {table}(id, payload) VALUES (2, 'close_original')")
        })
    )?;
    expect_success(&seed_close, "seed close fixture row")?;
    let opened = call_tool!(
        candidate.peer(),
        "dbx_open_session",
        json!({"connection_id": connection, "database": database, "enable_transactions": true})
    )?;
    expect_success(&opened, "open close-test session")?;
    let session = structured(&opened)?["session_id"]
        .as_str()
        .ok_or_else(|| "close-test open omitted session_id".to_string())?
        .to_string();
    expect_success(
        &call_tool!(candidate.peer(), "dbx_begin_transaction", json!({"session_id": session}))?,
        "begin close-test transaction",
    )?;
    expect_success(
        &call_tool!(
            candidate.peer(),
            "dbx_execute_query",
            json!({
                "connection_id": connection,
                "database": database,
                "session_id": session,
                "sql": format!("UPDATE {table} SET payload = 'uncommitted_close' WHERE id = 2")
            })
        )?,
        "hold close-test row lock",
    )?;
    let fixture_peer = fixture.peer().clone();
    let fixture_database = database.to_string();
    let fixture_table = table.to_string();
    let mut blocked_update = tokio::spawn(async move {
        fixture_peer
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                "connection_id": fixture_connection,
                "database": fixture_database,
                "sql": format!("UPDATE {fixture_table} SET payload = 'close_released' WHERE id = 2")
            }))))
            .await
    });
    if tokio::time::timeout(Duration::from_millis(300), &mut blocked_update).await.is_ok() {
        return Err("fixture update did not block on the close-test transaction".to_string());
    }
    let close = call_tool!(candidate.peer(), "dbx_close_session", json!({"session_id": session}))?;
    expect_success(&close, "close active transaction session")?;
    let released = tokio::time::timeout(Duration::from_secs(10), blocked_update)
        .await
        .map_err(|_| "row lock was not released after dbx_close_session".to_string())?
        .map_err(|error| format!("close-test fixture task failed: {error}"))?
        .map_err(|error| format!("close-test fixture transport failed: {error}"))?;
    expect_success(&released, "fixture update after close")?;

    let seed_cancel = call_tool!(
        fixture.peer(),
        "dbx_execute_query",
        json!({
            "connection_id": fixture_connection,
            "database": database,
            "sql": format!("INSERT INTO {table}(id, payload) VALUES (3, 'cancel_original')")
        })
    )?;
    expect_success(&seed_cancel, "seed cancellation fixture row")?;
    let opened = call_tool!(
        candidate.peer(),
        "dbx_open_session",
        json!({"connection_id": connection, "database": database, "enable_transactions": true})
    )?;
    expect_success(&opened, "open cancellation-test session")?;
    let session = structured(&opened)?["session_id"]
        .as_str()
        .ok_or_else(|| "cancellation-test open omitted session_id".to_string())?
        .to_string();
    expect_success(
        &call_tool!(candidate.peer(), "dbx_begin_transaction", json!({"session_id": session}))?,
        "begin cancellation-test transaction",
    )?;
    let request = ClientRequest::CallToolRequest(CallToolRequest::new(
        CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
            "connection_id": connection,
            "database": database,
            "session_id": session,
            "sql": format!("SELECT SLEEP(30), payload FROM {table} WHERE id = 3 FOR UPDATE")
        }))),
    ));
    let request = candidate
        .peer()
        .send_cancellable_request(request, PeerRequestOptions::no_options())
        .await
        .map_err(|error| format!("send cancellable locking query: {error}"))?;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let fixture_peer = fixture.peer().clone();
    let fixture_database = database.to_string();
    let fixture_table = table.to_string();
    let mut blocked_update = tokio::spawn(async move {
        fixture_peer
            .call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(json!({
                "connection_id": fixture_connection,
                "database": fixture_database,
                "sql": format!("UPDATE {fixture_table} SET payload = 'cancel_released' WHERE id = 3")
            }))))
            .await
    });
    if tokio::time::timeout(Duration::from_millis(300), &mut blocked_update).await.is_ok() {
        return Err("fixture update did not block on the cancellable locking query".to_string());
    }
    request
        .cancel(Some("native cancellation lock-release probe".to_string()))
        .await
        .map_err(|error| format!("cancel locking query: {error}"))?;
    let released = tokio::time::timeout(Duration::from_secs(10), blocked_update)
        .await
        .map_err(|_| "row lock was not released after MCP cancellation".to_string())?
        .map_err(|error| format!("cancellation fixture task failed: {error}"))?
        .map_err(|error| format!("cancellation fixture transport failed: {error}"))?;
    expect_success(&released, "fixture update after cancellation")?;
    let close = call_tool!(candidate.peer(), "dbx_close_session", json!({"session_id": session}))?;
    expect_success(&close, "close terminal cancellation-test session")?;
    Ok(())
}

#[tokio::test]
#[ignore = "requires an authorized native MySQL ConnectionConfig in DBX_TXN_MYSQL_CONNECTION_JSON"]
async fn native_mysql_fixed_sessions_preserve_identity_and_real_contention() {
    async fn run() -> Result<(), String> {
        let mut candidate = candidate_connection_from_env()?;
        let mut fixture = match std::env::var("DBX_TXN_MYSQL_FIXTURE_CONNECTION_JSON") {
            Ok(value) => serde_json::from_str::<ConnectionConfig>(&value)
                .map_err(|error| format!("DBX_TXN_MYSQL_FIXTURE_CONNECTION_JSON is invalid: {error}"))?,
            Err(std::env::VarError::NotPresent) => candidate.clone(),
            Err(error) => return Err(format!("cannot read fixture connection environment: {error}")),
        };
        if !is_builtin_native_mysql(&candidate) {
            return Err(
                "candidate must use the native MySQL route (empty profile or the built-in mysql profile)".to_string()
            );
        }
        if !is_builtin_native_mysql(&fixture) {
            return Err("fixture channel must use the native MySQL route".to_string());
        }
        let database = candidate
            .database
            .as_deref()
            .map(str::trim)
            .filter(|database| !database.is_empty())
            .ok_or_else(|| "candidate must name one non-empty authorized test database".to_string())?
            .to_string();
        if fixture.database.as_deref().map(str::trim) != Some(database.as_str()) {
            return Err(
                "candidate and fixture channels must name the same non-empty authorized test database".to_string()
            );
        }
        candidate.id = "mcp-session-transaction-live".to_string();
        candidate.name = candidate.id.clone();
        fixture.id = "mcp-session-transaction-fixture".to_string();
        fixture.name = fixture.id.clone();

        let directory = tempfile::tempdir().map_err(|error| format!("create isolated storage directory: {error}"))?;
        let db_path = directory.path().join("dbx.db");
        let storage = Storage::open(&db_path).await.map_err(|error| format!("open isolated storage: {error}"))?;
        storage
            .add_connection_for_mcp(candidate)
            .await
            .map_err(|_| "seed candidate connection failed (details redacted)".to_string())?;
        storage
            .add_connection_for_mcp(fixture)
            .await
            .map_err(|_| "seed fixture connection failed (details redacted)".to_string())?;
        storage
            .save_mcp_global_policy(&McpGlobalPolicy {
                read_only: false,
                allow_dangerous_sql: true,
                allowed_connection_ids: Some(vec![
                    "mcp-session-transaction-live".to_string(),
                    "mcp-session-transaction-fixture".to_string(),
                ]),
                ..Default::default()
            })
            .await
            .map_err(|error| format!("seed isolated policy: {error}"))?;
        drop(storage);

        let backend = Arc::new(
            LocalBackend::open(&db_path)
                .await
                .map_err(|_| "open candidate LocalBackend failed (details redacted)".to_string())?,
        );
        let candidate_server = DbxMcpServer::with_runtime_options(backend.clone(), McpScope::default(), false);
        let fixture_server = DbxMcpServer::with_runtime_options(backend, McpScope::default(), false);
        let (candidate_server_transport, candidate_client_transport) = tokio::io::duplex(64 * 1024);
        let (fixture_server_transport, fixture_client_transport) = tokio::io::duplex(64 * 1024);
        let candidate_server_task =
            tokio::spawn(async move { candidate_server.serve(candidate_server_transport).await });
        let fixture_server_task = tokio::spawn(async move { fixture_server.serve(fixture_server_transport).await });
        let mut candidate_client =
            ().serve(candidate_client_transport)
                .await
                .map_err(|error| format!("initialize candidate MCP client: {error}"))?;
        let mut fixture_client =
            ().serve(fixture_client_transport)
                .await
                .map_err(|error| format!("initialize fixture MCP client: {error}"))?;
        let mut candidate_service = candidate_server_task
            .await
            .map_err(|error| format!("candidate server task failed: {error}"))?
            .map_err(|error| format!("initialize candidate MCP server: {error}"))?;
        let mut fixture_service = fixture_server_task
            .await
            .map_err(|error| format!("fixture server task failed: {error}"))?
            .map_err(|error| format!("initialize fixture MCP server: {error}"))?;

        let fixture_open = tokio::time::timeout(
            Duration::from_secs(10),
            fixture_client.peer().call_tool(CallToolRequestParams::new("dbx_open_session").with_arguments(arguments(
                json!({
                    "connection_id": "mcp-session-transaction-fixture",
                    "database": database,
                    "enable_transactions": true
                }),
            ))),
        )
        .await
        .map_err(|_| "fixture capability probe timed out".to_string())?
        .map_err(|error| format!("fixture capability probe transport failed: {error}"))?;
        expect_success(&fixture_open, "fixture capability session open")?;
        let fixture_session = structured(&fixture_open)?["session_id"]
            .as_str()
            .ok_or_else(|| "fixture session omitted session_id".to_string())?
            .to_string();
        let capability = call_tool!(
            fixture_client.peer(),
            "dbx_execute_query",
            json!({
                "connection_id": "mcp-session-transaction-fixture",
                "database": database,
                "session_id": fixture_session,
                "sql": "SELECT VERSION(), @@tx_isolation"
            })
        )?;
        expect_success(&capability, "read MySQL version/isolation")?;
        let version = result_cell(&capability, 0, 0)?.as_str().unwrap_or_default();
        let isolation = result_cell(&capability, 0, 1)?.as_str().unwrap_or_default();
        if !version.starts_with("5.7.") || !isolation.eq_ignore_ascii_case("REPEATABLE-READ") {
            return Err("live gate requires MySQL 5.7 with REPEATABLE READ".to_string());
        }
        let fixture_close =
            call_tool!(fixture_client.peer(), "dbx_close_session", json!({"session_id": fixture_session}))?;
        expect_success(&fixture_close, "close fixture capability session")?;

        let table = format!("dbx_mcp_txn_{}", uuid::Uuid::new_v4().simple());
        let create = tokio::time::timeout(
            Duration::from_secs(10),
            fixture_client.peer().call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(arguments(
                json!({
                    "connection_id": "mcp-session-transaction-fixture",
                    "database": database,
                    "sql": format!(
                        "CREATE TABLE {table} (id BIGINT PRIMARY KEY, payload VARCHAR(255) NOT NULL) ENGINE=InnoDB"
                    )
                }),
            ))),
        )
        .await
        .map_err(|_| "fixture CREATE timed out".to_string())?
        .map_err(|error| format!("fixture CREATE transport failed: {error}"))?;
        expect_success(&create, "create unique InnoDB fixture")?;
        eprintln!("DBX transaction fixture token: {table}");

        // From this point every path, including scenario timeout/failure, enters
        // the bounded teardown and exact-name DROP below.
        let scenario = match tokio::time::timeout(Duration::from_secs(90), async {
            run_contention_trace(&candidate_client, &database, &table).await?;
            run_native_cleanup_traces(&candidate_client, &fixture_client, &database, &table).await
        })
        .await
        {
            Ok(result) => result,
            Err(_) => Err("native transaction scenarios exceeded 90 seconds".to_string()),
        };

        let cleanup = tokio::time::timeout(Duration::from_secs(35), async {
            let _ = candidate_client.close_with_timeout(Duration::from_secs(12)).await;
            let _ = candidate_service.close_with_timeout(Duration::from_secs(12)).await;
            drop(candidate_client);
            drop(candidate_service);

            let drop_result = tokio::time::timeout(
                Duration::from_secs(15),
                fixture_client.peer().call_tool(CallToolRequestParams::new("dbx_execute_query").with_arguments(
                    arguments(json!({
                        "connection_id": "mcp-session-transaction-fixture",
                        "database": database,
                        "sql": format!("DROP TABLE {table}")
                    })),
                )),
            )
            .await
            .map_err(|_| "fixture DROP timed out".to_string())?
            .map_err(|error| format!("fixture DROP transport failed: {error}"))?;
            expect_success(&drop_result, "drop exact fixture table")?;
            let _ = fixture_client.close_with_timeout(Duration::from_secs(5)).await;
            let _ = fixture_service.close_with_timeout(Duration::from_secs(5)).await;
            Result::<(), String>::Ok(())
        })
        .await
        .map_err(|_| format!("bounded cleanup timed out; attributable fixture token: {table}"))?;

        if let Err(error) = cleanup {
            return Err(format!("{error}; attributable fixture token: {table}"));
        }
        scenario
    }

    run().await.expect("native fixed-session contention gate");
}
