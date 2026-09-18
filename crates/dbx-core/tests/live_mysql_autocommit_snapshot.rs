//! Regression coverage for #9479: a single-statement `BEGIN` typed in an
//! auto-commit tab must not pin that tab's read snapshot.
//!
//! Run against a writable MySQL database:
//! `DBX_LIVE_AUTOCOMMIT_MYSQL_HOST=... DBX_LIVE_AUTOCOMMIT_MYSQL_USER=... \
//!  DBX_LIVE_AUTOCOMMIT_MYSQL_PASSWORD=... DBX_LIVE_AUTOCOMMIT_MYSQL_DATABASE=... \
//!  cargo test -p dbx-core --test live_mysql_autocommit_snapshot -- --ignored`

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_sql_statement, execute_sql_statement_with_options, QueryExecutionOptions};
use dbx_core::storage::Storage;
use std::sync::Arc;

fn live_config(prefix: &str) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": format!("autocommit-snapshot-{}", uuid::Uuid::new_v4().simple()),
        "name": "MySQL auto-commit snapshot regression",
        "db_type": DatabaseType::Mysql,
        "host": std::env::var(format!("{prefix}_HOST")).expect("live database host"),
        "port": std::env::var(format!("{prefix}_PORT")).ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(3306),
        "username": std::env::var(format!("{prefix}_USER")).expect("live database user"),
        "password": std::env::var(format!("{prefix}_PASSWORD")).expect("live database password"),
        "database": std::env::var(format!("{prefix}_DATABASE")).expect("live database name"),
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live connection configuration")
}

async fn setup(config: &ConnectionConfig) -> (Arc<AppState>, std::path::PathBuf, String) {
    let storage_path =
        std::env::temp_dir().join(format!("dbx-autocommit-snapshot-{}.db", uuid::Uuid::new_v4().simple()));
    let state = Arc::new(AppState::new(Storage::open(&storage_path).await.expect("temporary storage")));
    let table_name = format!("dbx_issue_9479_{}", uuid::Uuid::new_v4().simple());
    let database = config.database.clone().expect("database");
    state.configs.write().await.insert(config.id.clone(), config.clone());
    execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("CREATE TABLE {table_name} (id INTEGER PRIMARY KEY)"),
        None,
        None,
    )
    .await
    .expect("create isolated regression table");
    execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("INSERT INTO {table_name} (id) VALUES (1)"),
        None,
        None,
    )
    .await
    .expect("seed regression table");
    (state, storage_path, table_name)
}

fn assert_row_count(rows: &[Vec<serde_json::Value>], expected: i64) {
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 1);
    let count = rows[0][0].as_i64().or_else(|| rows[0][0].as_str().and_then(|value| value.parse().ok()));
    assert_eq!(count, Some(expected));
}

/// Runs one statement on the tab-scoped client session that pools a single
/// connection across executions, exactly like a query editor tab.
async fn run_in_tab(
    state: &AppState,
    config: &ConnectionConfig,
    database: &str,
    client_session_id: &str,
    sql: &str,
) -> dbx_core::db::QueryResult {
    execute_sql_statement_with_options(
        state,
        &config.id,
        database,
        sql,
        None,
        None,
        QueryExecutionOptions { client_session_id: Some(client_session_id.to_string()), ..Default::default() },
    )
    .await
    .expect("execute statement in tab client session")
}

async fn cleanup(state: &AppState, config: &ConnectionConfig, table_name: &str, storage_path: std::path::PathBuf) {
    execute_sql_statement(
        state,
        &config.id,
        config.database.as_deref().expect("database"),
        &format!("DROP TABLE {table_name}"),
        None,
        None,
    )
    .await
    .expect("drop isolated regression table");
    let _ = std::fs::remove_file(storage_path);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at a writable MySQL database"]
async fn live_mysql_single_statement_begin_does_not_pin_the_tab_snapshot() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup(&config).await;
    let client_session_id = format!("query-tab-{}", uuid::Uuid::new_v4().simple());
    let count_sql = format!("SELECT COUNT(*) AS row_count FROM {table_name}");

    // A user typing BEGIN as its own statement in an auto-commit tab used to
    // leave the transaction open on the tab connection.
    run_in_tab(&state, &config, &database, &client_session_id, "BEGIN").await;
    let first = run_in_tab(&state, &config, &database, &client_session_id, &count_sql).await;
    assert_row_count(&first.rows, 1);

    // Another connection commits a row while the tab keeps its own connection.
    execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("INSERT INTO {table_name} (id) VALUES (2)"),
        None,
        None,
    )
    .await
    .expect("external committed write");

    // The tab must observe the committed row instead of its pinned snapshot.
    let second = run_in_tab(&state, &config, &database, &client_session_id, &count_sql).await;
    assert_row_count(&second.rows, 2);

    cleanup(&state, &config, &table_name, storage_path).await;
}
