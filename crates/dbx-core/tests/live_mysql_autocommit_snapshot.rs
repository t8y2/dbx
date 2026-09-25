//! Regression coverage for #9479: a single-statement `BEGIN` typed in an
//! auto-commit tab must not pin that tab's read snapshot.
//!
//! Run against a writable MySQL database:
//! `DBX_LIVE_AUTOCOMMIT_MYSQL_HOST=... DBX_LIVE_AUTOCOMMIT_MYSQL_USER=... \
//!  DBX_LIVE_AUTOCOMMIT_MYSQL_PASSWORD=... DBX_LIVE_AUTOCOMMIT_MYSQL_DATABASE=... \
//!  cargo test -p dbx-core --test live_mysql_autocommit_snapshot -- --ignored`

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    execute_multi_core_with_options_for_client_typed, execute_sql_statement, execute_sql_statement_with_options,
    ExecuteMultiResult, QueryExecutionOptions,
};
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
    let state = Arc::new(AppState::new(
        dbx_core::persistence::test_storage::open(&storage_path).await.expect("temporary storage"),
    ));
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

/// Same as [`run_in_tab`] for a tab that opted into keeping explicit user
/// transactions open (`editor` setting `keepExplicitTransactionInAutoCommit`).
async fn run_in_tab_keeping_transactions(
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
        QueryExecutionOptions {
            client_session_id: Some(client_session_id.to_string()),
            preserve_explicit_transaction: true,
            ..Default::default()
        },
    )
    .await
    .expect("execute statement in tab client session")
}

/// Creates an isolated `(id, v)` probe table for the explicit-transaction
/// cases, seeded with `(1, 0)`.
async fn setup_probe(config: &ConnectionConfig, tag: &str) -> (Arc<AppState>, std::path::PathBuf, String) {
    let storage_path = std::env::temp_dir().join(format!("{tag}-{}.db", uuid::Uuid::new_v4().simple()));
    let state = Arc::new(AppState::new(
        dbx_core::persistence::test_storage::open(&storage_path).await.expect("temporary storage"),
    ));
    let table_name = format!("dbx_issue_9749_{}", uuid::Uuid::new_v4().simple());
    let database = config.database.clone().expect("database");
    state.configs.write().await.insert(config.id.clone(), config.clone());
    for sql in [
        format!("CREATE TABLE {table_name} (id INTEGER PRIMARY KEY, v INTEGER NOT NULL) ENGINE=InnoDB"),
        format!("INSERT INTO {table_name} (id, v) VALUES (1, 0)"),
    ] {
        execute_sql_statement(&state, &config.id, &database, &sql, None, None).await.expect("prepare probe table");
    }
    (state, storage_path, table_name)
}

/// Runs a batch on the tab-scoped client session through the same multi-result
/// route the SQL editor uses, so the auto-commit settlement runs exactly like
/// in the app.
async fn run_batch_in_tab(
    state: &AppState,
    config: &ConnectionConfig,
    database: &str,
    client_session_id: &str,
    sql: &str,
    preserve_explicit_transaction: bool,
) -> Vec<ExecuteMultiResult> {
    execute_multi_core_with_options_for_client_typed(
        state,
        &config.id,
        database,
        sql,
        None,
        None,
        QueryExecutionOptions {
            client_session_id: Some(client_session_id.to_string()),
            preserve_explicit_transaction,
            ..Default::default()
        },
    )
    .await
    .expect("execute batch in tab client session")
}

fn last_result(results: &[ExecuteMultiResult]) -> &ExecuteMultiResult {
    results.last().expect("batch returns at least one result")
}

/// Reads `v` through a separate auto-commit connection, so uncommitted changes
/// on the tab connection stay invisible.
async fn committed_value(state: &AppState, config: &ConnectionConfig, database: &str, table: &str) -> i64 {
    let result =
        execute_sql_statement(state, &config.id, database, &format!("SELECT v FROM {table} WHERE id = 1"), None, None)
            .await
            .expect("read committed value");
    assert_eq!(result.rows.len(), 1);
    result.rows[0][0]
        .as_i64()
        .or_else(|| result.rows[0][0].as_str().and_then(|value| value.parse().ok()))
        .expect("integer probe value")
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

/// #9749 case A: `START TRANSACTION` and `UPDATE` in one execution, `COMMIT` in
/// the next one. The change must survive the execution boundary and become
/// visible to other connections only after the `COMMIT`.
#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at a writable MySQL database"]
async fn live_mysql_kept_explicit_transaction_commits_across_executions() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup_probe(&config, "dbx-issue-9749-commit").await;
    let client_session_id = format!("query-tab-{}", uuid::Uuid::new_v4().simple());
    let update = format!("UPDATE {table_name} SET v = 1 WHERE id = 1");

    let first = run_batch_in_tab(
        &state,
        &config,
        &database,
        &client_session_id,
        &format!("START TRANSACTION;\n{update}"),
        true,
    )
    .await;
    assert_eq!(
        last_result(&first).auto_commit_open_transaction,
        Some(true),
        "the tab must keep the explicit transaction open"
    );
    assert!(!last_result(&first).auto_commit_explicit_transaction_rolled_back);
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 0, "the change is uncommitted");

    let commit = run_batch_in_tab(&state, &config, &database, &client_session_id, "COMMIT", true).await;
    assert_eq!(last_result(&commit).auto_commit_open_transaction, Some(false), "COMMIT ends the kept transaction");
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 1, "COMMIT persists the change");

    // Acceptance 5: after the COMMIT the tab auto-commits again.
    run_batch_in_tab(
        &state,
        &config,
        &database,
        &client_session_id,
        &format!("UPDATE {table_name} SET v = 5 WHERE id = 1"),
        true,
    )
    .await;
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 5, "plain UPDATE auto-commits again");

    cleanup(&state, &config, &table_name, storage_path).await;
}

/// #9749 case B: `START TRANSACTION`, `UPDATE` and `ROLLBACK` each executed on
/// their own. The `ROLLBACK` must undo the change, which requires the UPDATE to
/// still run inside the transaction the first execution opened.
#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at a writable MySQL database"]
async fn live_mysql_kept_explicit_transaction_rolls_back_across_executions() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup_probe(&config, "dbx-issue-9749-rollback").await;
    let client_session_id = format!("query-tab-{}", uuid::Uuid::new_v4().simple());
    let update = format!("UPDATE {table_name} SET v = 2 WHERE id = 1");

    let start = run_batch_in_tab(&state, &config, &database, &client_session_id, "START TRANSACTION", true).await;
    assert_eq!(last_result(&start).auto_commit_open_transaction, Some(true));

    let updated = run_batch_in_tab(&state, &config, &database, &client_session_id, &update, true).await;
    assert_eq!(
        last_result(&updated).auto_commit_open_transaction,
        Some(true),
        "a follow-up execution must not end the transaction the tab kept"
    );
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 0, "the change is uncommitted");

    let rollback = run_batch_in_tab(&state, &config, &database, &client_session_id, "ROLLBACK", true).await;
    assert_eq!(last_result(&rollback).auto_commit_open_transaction, Some(false));
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 0, "ROLLBACK undoes the change");

    run_batch_in_tab(
        &state,
        &config,
        &database,
        &client_session_id,
        &format!("UPDATE {table_name} SET v = 7 WHERE id = 1"),
        true,
    )
    .await;
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 7, "plain UPDATE auto-commits again");

    cleanup(&state, &config, &table_name, storage_path).await;
}

/// Without the opt-in the historical cleanup stays in place — it now reports
/// the rollback so the UI can tell the user instead of losing it silently.
#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at a writable MySQL database"]
async fn live_mysql_default_auto_commit_still_rolls_back_explicit_transactions() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup_probe(&config, "dbx-issue-9749-default").await;
    let client_session_id = format!("query-tab-{}", uuid::Uuid::new_v4().simple());
    let update = format!("UPDATE {table_name} SET v = 1 WHERE id = 1");

    let first = run_batch_in_tab(
        &state,
        &config,
        &database,
        &client_session_id,
        &format!("START TRANSACTION;\n{update}"),
        false,
    )
    .await;
    assert_eq!(last_result(&first).auto_commit_open_transaction, Some(false));
    assert!(
        last_result(&first).auto_commit_explicit_transaction_rolled_back,
        "the cleanup of a user transaction must be reported"
    );

    let commit = run_batch_in_tab(&state, &config, &database, &client_session_id, "COMMIT", false).await;
    assert!(!last_result(&commit).auto_commit_explicit_transaction_rolled_back);
    assert_eq!(committed_value(&state, &config, &database, &table_name).await, 0, "the change was rolled back");

    cleanup(&state, &config, &table_name, storage_path).await;
}

/// The opt-in also keeps a transaction opened by a single-statement `BEGIN`,
/// which is its documented trade-off: the tab then reads the snapshot the user
/// asked for, and the snapshot is released by `COMMIT`.
#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at a writable MySQL database"]
async fn live_mysql_opted_in_single_statement_begin_keeps_its_snapshot() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup(&config).await;
    let client_session_id = format!("query-tab-{}", uuid::Uuid::new_v4().simple());
    let count_sql = format!("SELECT COUNT(*) AS row_count FROM {table_name}");

    run_in_tab_keeping_transactions(&state, &config, &database, &client_session_id, "BEGIN").await;
    let first = run_in_tab_keeping_transactions(&state, &config, &database, &client_session_id, &count_sql).await;
    assert_row_count(&first.rows, 1);

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

    let second = run_in_tab_keeping_transactions(&state, &config, &database, &client_session_id, &count_sql).await;
    assert_row_count(&second.rows, 1);

    run_in_tab_keeping_transactions(&state, &config, &database, &client_session_id, "COMMIT").await;
    let third = run_in_tab_keeping_transactions(&state, &config, &database, &client_session_id, &count_sql).await;
    assert_row_count(&third.rows, 2);

    cleanup(&state, &config, &table_name, storage_path).await;
}
