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
    ExecuteMultiResult, QueryExecutionError, QueryExecutionOptions,
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
    try_run_batch_in_tab(state, config, database, client_session_id, sql, preserve_explicit_transaction, None)
        .await
        .expect("execute batch in tab client session")
}

// The complete execution future is large in debug builds. Erase its type here
// so multi-step scenarios fit the default Windows test-thread stack.
fn try_run_batch_in_tab<'a>(
    state: &'a AppState,
    config: &'a ConnectionConfig,
    database: &'a str,
    client_session_id: &'a str,
    sql: &'a str,
    preserve_explicit_transaction: bool,
    cancel: Option<tokio_util::sync::CancellationToken>,
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Vec<ExecuteMultiResult>, QueryExecutionError>> + Send + 'a>,
> {
    Box::pin(execute_multi_core_with_options_for_client_typed(
        state,
        &config.id,
        database,
        sql,
        None,
        cancel,
        QueryExecutionOptions {
            client_session_id: Some(client_session_id.to_string()),
            preserve_explicit_transaction,
            ..Default::default()
        },
    ))
}

fn last_result(results: &[ExecuteMultiResult]) -> &ExecuteMultiResult {
    results.last().expect("batch returns at least one result")
}

fn session_number(value: &serde_json::Value) -> u64 {
    value.as_u64().or_else(|| value.as_str().and_then(|value| value.parse().ok())).expect("numeric session value")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at an isolated writable MySQL database"]
async fn live_mysql_use_and_toolbar_database_selection_preserve_session_variables() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let original_database = config.database.clone().unwrap();
    let (state, storage_path, table) = setup_probe(&config, "mysql-session-state").await;
    for use_sql in [false, true] {
        for initialize_before_use in [false, true] {
            let session = format!("session-{}", uuid::Uuid::new_v4().simple());
            let mut database = original_database.as_str();
            let initialize = format!("SET @dbx_probe=12345; SET @dbx_init_cid=CONNECTION_ID(); CREATE TEMPORARY TABLE `{original_database}`.`{table}_temp` (v INT); INSERT INTO `{original_database}`.`{table}_temp` VALUES (9);");
            if initialize_before_use {
                run_batch_in_tab(&state, &config, database, &session, &initialize, true).await;
            }
            if use_sql {
                run_batch_in_tab(&state, &config, database, &session, "USE information_schema", true).await;
            }
            // The toolbar passes the new target on the next execution.
            database = "information_schema";
            if !initialize_before_use {
                run_batch_in_tab(&state, &config, database, &session, &initialize, true).await;
            }
            for _ in 0..3 {
                let read = run_in_tab(
                    &state,
                    &config,
                    database,
                    &session,
                    &format!("SELECT CONNECTION_ID(), DATABASE(), @dbx_init_cid, @dbx_probe, (SELECT v FROM `{original_database}`.`{table}_temp`)"),
                )
                .await;
                assert_eq!(read.rows[0][1].as_str(), Some("information_schema"));
                assert_eq!(session_number(&read.rows[0][0]), session_number(&read.rows[0][2]));
                assert_eq!(session_number(&read.rows[0][3]), 12345);
                assert_eq!(session_number(&read.rows[0][4]), 9);
            }
            let sibling = run_in_tab(&state, &config, database, &format!("{session}-other"), "SELECT @dbx_probe").await;
            assert!(sibling.rows[0][0].is_null(), "query tabs must stay isolated");
            state.close_client_session_pool(&config.id, Some(database), &session).await.unwrap();
        }
    }
    cleanup(&state, &config, &table, storage_path).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at an isolated writable MySQL database"]
async fn live_mysql_transactions_survive_database_switches_and_savepoints_across_executions() {
    for use_sql in [false, true] {
        for commit in [false, true] {
            let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
            let database = config.database.clone().unwrap();
            let (state, storage_path, table) = setup_probe(&config, "mysql-use-transaction").await;
            let session = "transaction-tab";
            let start = run_batch_in_tab(
                &state,
                &config,
                &database,
                session,
                "# explicit transaction\nSTART TRANSACTION",
                true,
            )
            .await;
            assert_eq!(last_result(&start).auto_commit_open_transaction, Some(true));
            let before =
                run_in_tab_keeping_transactions(&state, &config, &database, session, "SELECT CONNECTION_ID()").await;
            if use_sql {
                let switched =
                    run_batch_in_tab(&state, &config, &database, session, "USE information_schema", true).await;
                assert_eq!(last_result(&switched).auto_commit_open_transaction, Some(true));
            }
            let qualified_table = format!("`{database}`.`{table}`");
            let write = run_batch_in_tab(&state, &config, "information_schema", session,
                &format!("UPDATE {qualified_table} SET v=10 WHERE id=1; SAVEPOINT kept; UPDATE {qualified_table} SET v=20 WHERE id=1;"), true).await;
            assert_eq!(last_result(&write).auto_commit_open_transaction, Some(true));
            let partial_rollback =
                run_batch_in_tab(&state, &config, "information_schema", session, "ROLLBACK TO SAVEPOINT kept", true)
                    .await;
            assert_eq!(last_result(&partial_rollback).auto_commit_open_transaction, Some(true));
            let inside = run_in_tab_keeping_transactions(
                &state,
                &config,
                "information_schema",
                session,
                &format!("SELECT CONNECTION_ID(), v FROM {qualified_table} WHERE id=1"),
            )
            .await;
            assert_eq!(session_number(&before.rows[0][0]), session_number(&inside.rows[0][0]));
            assert_eq!(session_number(&inside.rows[0][1]), 10);
            assert_eq!(committed_value(&state, &config, &database, &table).await, 0);
            let ended = run_batch_in_tab(
                &state,
                &config,
                "information_schema",
                session,
                if commit { "/* finish */ COMMIT" } else { "ROLLBACK" },
                true,
            )
            .await;
            assert_eq!(last_result(&ended).auto_commit_open_transaction, Some(false));
            assert_eq!(committed_value(&state, &config, &database, &table).await, if commit { 10 } else { 0 });
            cleanup(&state, &config, &table, storage_path).await;
        }
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at an isolated writable MySQL database"]
async fn live_mysql_lost_session_cannot_commit_on_a_replacement_connection() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().unwrap();
    let (state, storage_path, table) = setup_probe(&config, "mysql-lost-session").await;
    let session = "lost-session-tab";
    run_batch_in_tab(&state, &config, &database, session, &format!("BEGIN; UPDATE {table} SET v=7 WHERE id=1"), true)
        .await;
    let before =
        run_in_tab_keeping_transactions(&state, &config, "information_schema", session, "SELECT CONNECTION_ID()").await;
    let connection_id = session_number(&before.rows[0][0]);
    execute_sql_statement(&state, &config.id, &database, &format!("KILL {connection_id}"), None, None).await.unwrap();
    let outcome = try_run_batch_in_tab(&state, &config, "information_schema", session, "COMMIT", true, None).await;
    let error = match outcome {
        Err(error) => error.to_string(),
        Ok(results) => {
            assert!(
                last_result(&results).execution_error,
                "a new connection must not report the old commit as successful"
            );
            serde_json::to_string(&last_result(&results).result.rows).unwrap()
        }
    };
    assert!(error.contains("MYSQL_CLIENT_SESSION_LOST"), "{error}");
    assert_eq!(committed_value(&state, &config, &database, &table).await, 0);
    let recovered = run_batch_in_tab(&state, &config, "information_schema", session, "SELECT DATABASE()", false).await;
    assert_eq!(last_result(&recovered).result.rows[0][0].as_str(), Some("information_schema"));
    let fresh = run_batch_in_tab(&state, &config, "information_schema", session, "BEGIN", false).await;
    assert_eq!(last_result(&fresh).auto_commit_open_transaction, Some(false));
    assert!(
        last_result(&fresh).auto_commit_explicit_transaction_rolled_back,
        "a lost session must not carry its preservation marker into a fresh transaction"
    );
    cleanup(&state, &config, &table, storage_path).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at an isolated writable MySQL database"]
async fn live_mysql_statement_error_and_implicit_commit_follow_server_transaction_state() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().unwrap();
    let (state, storage_path, table) = setup_probe(&config, "mysql-transaction-state").await;
    let session = "transaction-state-tab";
    run_batch_in_tab(&state, &config, &database, session, &format!("BEGIN; UPDATE {table} SET v=7 WHERE id=1"), true)
        .await;
    let single_error = try_run_batch_in_tab(
        &state,
        &config,
        &database,
        session,
        &format!("SELECT missing_column FROM {table}"),
        true,
        None,
    )
    .await;
    assert!(single_error.unwrap_err().to_string().contains("Unknown column"));
    let error = run_batch_in_tab(
        &state,
        &config,
        &database,
        session,
        &format!("SELECT missing_column FROM {table}; SELECT 1"),
        true,
    )
    .await;
    assert!(last_result(&error).execution_error);
    assert_eq!(last_result(&error).auto_commit_open_transaction, Some(true));
    assert_eq!(committed_value(&state, &config, &database, &table).await, 0);
    let implicit_commit =
        run_batch_in_tab(&state, &config, &database, session, &format!("CREATE TABLE {table}_ddl (id INT)"), true)
            .await;
    assert_eq!(last_result(&implicit_commit).auto_commit_open_transaction, Some(false));
    assert_eq!(committed_value(&state, &config, &database, &table).await, 7);
    let rollback = run_batch_in_tab(&state, &config, &database, session, "ROLLBACK", true).await;
    assert_eq!(last_result(&rollback).auto_commit_open_transaction, Some(false));
    assert_eq!(committed_value(&state, &config, &database, &table).await, 7);
    execute_sql_statement(&state, &config.id, &database, &format!("DROP TABLE {table}_ddl"), None, None).await.unwrap();
    cleanup(&state, &config, &table, storage_path).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_AUTOCOMMIT_MYSQL_* pointing at an isolated writable MySQL database"]
async fn live_mysql_cancel_cannot_commit_an_old_transaction_on_a_new_session() {
    let config = live_config("DBX_LIVE_AUTOCOMMIT_MYSQL");
    let database = config.database.clone().unwrap();
    let (state, storage_path, table) = setup_probe(&config, "mysql-cancel-transaction").await;
    let session = "cancelled-transaction-tab";
    run_batch_in_tab(&state, &config, &database, session, &format!("BEGIN; UPDATE {table} SET v=8 WHERE id=1"), true)
        .await;
    let before = run_in_tab_keeping_transactions(&state, &config, &database, session, "SELECT CONNECTION_ID()").await;
    let cancel = tokio_util::sync::CancellationToken::new();
    let execution =
        try_run_batch_in_tab(&state, &config, &database, session, "SELECT SLEEP(1)", true, Some(cancel.clone()));
    let cancellation = async {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        cancel.cancel();
    };
    let _ = tokio::join!(execution, cancellation);
    let after =
        try_run_batch_in_tab(&state, &config, &database, session, "SELECT CONNECTION_ID(); COMMIT", true, None).await;
    match after {
        Ok(results) if results.iter().all(|result| !result.execution_error) => {
            assert_eq!(
                session_number(&results[0].result.rows[0][0]),
                session_number(&before.rows[0][0]),
                "only the original physical session can commit the original transaction"
            );
            assert_eq!(committed_value(&state, &config, &database, &table).await, 8);
        }
        _ => assert_eq!(committed_value(&state, &config, &database, &table).await, 0),
    }
    cleanup(&state, &config, &table, storage_path).await;
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
