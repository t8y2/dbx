#![recursion_limit = "256"]
//! Live PostgreSQL verification of the SQL error-position plumbing.
//!
//! Requires a connectable PostgreSQL-family server pointed at by
//! `DBX_LIVE_POSTGRES_*` (same variables as the other `live_postgres_*` tests).
//! `DBX_LIVE_PG_FAMILY=opengauss` switches the full-funnel test to an openGauss
//! connection config, to prove the position is not gated on `DatabaseType::Postgres`.
//!
//! ```text
//! DBX_LIVE_POSTGRES_HOST=... DBX_LIVE_POSTGRES_PORT=... \
//! DBX_LIVE_POSTGRES_USER=... DBX_LIVE_POSTGRES_PASSWORD=... \
//! DBX_LIVE_POSTGRES_DATABASE=... \
//! cargo test -p dbx-core --no-default-features --test live_postgres_error_position -- --ignored
//! ```

use std::time::Duration;

use dbx_core::connection::AppState;
use dbx_core::db::postgres;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_multi_core_with_options_for_client_and_progress_typed, QueryExecutionOptions};
use dbx_core::sql_error_position::{encode_marker, take_message_position, SqlErrorPosition, SQL_ERROR_POSITION_MARKER};

fn live_env() -> (String, u16, String, String, String) {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    (host, port, user, password, database)
}

fn postgres_url() -> String {
    let (host, port, user, password, database) = live_env();
    format!("postgres://{}:{}@{host}:{port}/{database}", encode_userinfo(&user), encode_userinfo(&password))
}

/// Percent-encode the URL userinfo so secrets containing `@`/`:` survive parsing.
fn encode_userinfo(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '%' => encoded.push_str("%25"),
            '@' => encoded.push_str("%40"),
            ':' => encoded.push_str("%3A"),
            '/' => encoded.push_str("%2F"),
            other => encoded.push(other),
        }
    }
    encoded
}

fn live_db_type() -> DatabaseType {
    if std::env::var("DBX_LIVE_PG_FAMILY").is_ok_and(|value| value.eq_ignore_ascii_case("opengauss")) {
        DatabaseType::OpenGauss
    } else {
        DatabaseType::Postgres
    }
}

fn expected_position(sql: &str, offending: &str) -> SqlErrorPosition {
    let byte_index = sql.find(offending).unwrap();
    let offset = sql[..byte_index].chars().count() as u32;
    let line = sql[..byte_index].matches('\n').count() as u32 + 1;
    let line_start = sql[..byte_index].rfind('\n').map_or(0, |index| index + 1);
    let column = sql[line_start..byte_index].chars().count() as u32 + 1;
    SqlErrorPosition { line, column, offset }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a PostgreSQL-family database"]
async fn live_pg_error_positions_resolve_against_the_executed_statement() {
    let pool = postgres::connect(&postgres_url(), Duration::from_secs(10)).await.expect("connect");

    // (sql, offending token). The first case is the exact shape DBX sends for the
    // user's `select  * from no_such_table` after pagination appends LIMIT.
    let cases = [
        ("select  * from no_such_table LIMIT 100", "no_such_table"),
        ("SELECT *\nFROM no_such_table", "no_such_table"),
        ("SELECT no_such_col FROM (SELECT 1 AS x) AS t", "no_such_col"),
        ("INSERT INTO no_such_table VALUES (1)", "no_such_table"),
    ];

    for (sql, offending) in cases {
        let message = postgres::execute_query(&pool, sql).await.expect_err("statement must fail");
        assert!(message.contains(SQL_ERROR_POSITION_MARKER), "driver error must carry the marker: {message}");

        let (cleaned, position) = take_message_position(&message, sql);
        assert!(!cleaned.contains(SQL_ERROR_POSITION_MARKER), "marker must be stripped: {cleaned}");
        assert_eq!(position, Some(expected_position(sql, offending)), "position for `{sql}`");
    }

    let syntax_sql = "SELECT * FROMM no_such_table";
    let message = postgres::execute_query(&pool, syntax_sql).await.expect_err("syntax error");
    let (_, position) = take_message_position(&message, syntax_sql);
    assert_eq!(position, Some(expected_position(syntax_sql, "FROMM")), "syntax error should point at FROMM");

    pool.close();
}

/// Full backend funnel: AppState + connection config → `execute_multi_core` →
/// `BackendError`. This is where the old `pool_db_type == Postgres` gate lived, so
/// running it with `DBX_LIVE_PG_FAMILY=opengauss` guards the regression.
#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a PostgreSQL-family database"]
async fn live_pg_multi_core_reports_error_position_in_the_backend_envelope() {
    let (host, port, user, password, database) = live_env();
    let db_type = live_db_type();

    let dir = std::env::temp_dir().join(format!("dbx-live-pg-position-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-pg-position";
    state.configs.write().await.insert(
        connection_id.to_string(),
        live_connection_config(connection_id, db_type, &host, port, &user, &password, &database),
    );

    let sql = "select  * from no_such_table LIMIT 100";
    let result = execute_multi_core_with_options_for_client_and_progress_typed(
        &state,
        connection_id,
        &database,
        sql,
        None,
        None,
        QueryExecutionOptions { timeout_secs: Some(30), ..Default::default() },
        None,
    )
    .await;

    let backend_error = result.expect_err("single-statement failure must surface as an error").into_backend_error();
    assert_eq!(backend_error.code(), "DBX-JDBC-4001");
    assert_eq!(
        backend_error.error_position(),
        Some(expected_position(sql, "no_such_table")),
        "db_type={db_type:?} detail={:?}",
        backend_error.detail()
    );
    let detail = backend_error.detail().unwrap_or_default();
    assert!(!detail.contains(SQL_ERROR_POSITION_MARKER), "detail must not leak the marker: {detail}");
    assert!(detail.contains("no_such_table"), "detail should keep the native message: {detail}");

    let _ = std::fs::remove_dir_all(&dir);
}

/// A second case proving the multi-marker guard: a marker-containing error that
/// gets another marker merged in must not resolve to a wrong position.
#[test]
fn marker_guard_rejects_ambiguous_merged_errors() {
    let sql = "SELECT 1";
    let raw = format!("ERROR: boom{}{}", encode_marker(1), encode_marker(50));
    let (cleaned, position) = take_message_position(&raw, sql);
    assert!(position.is_none());
    assert_eq!(cleaned, "ERROR: boom");
}

fn live_connection_config(
    id: &str,
    db_type: DatabaseType,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectionConfig {
    ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: host.to_string(),
        port,
        username: user.to_string(),
        password: password.to_string(),
        database: Some(database.to_string()),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 10,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        redis_key_templates: Vec::new(),
        redis_key_grouping: None,
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        plugin_id: None,
        plugin_connection_provider: None,
        plugin_connection_type: None,
        connection_secrets: Default::default(),
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        show_system_schemas: false,
        database_info: None,
    }
}
