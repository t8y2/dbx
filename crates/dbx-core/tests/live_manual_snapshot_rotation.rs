use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_database_backup_snapshot, begin_manual_transaction, commit_manual_transaction, execute_in_manual_transaction,
    execute_in_manual_transaction_with_options, execute_sql_statement, rollback_manual_transaction,
    ManualTransactionExecutionOptions,
};
use std::sync::Arc;

fn live_config(prefix: &str, database_type: DatabaseType, default_port: u16) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": format!("snapshot-rotation-{}", uuid::Uuid::new_v4().simple()),
        "name": "Snapshot rotation regression",
        "db_type": database_type,
        "host": std::env::var(format!("{prefix}_HOST")).expect("live database host"),
        "port": std::env::var(format!("{prefix}_PORT")).ok().and_then(|port| port.parse::<u16>().ok()).unwrap_or(default_port),
        "username": std::env::var(format!("{prefix}_USER")).expect("live database user"),
        "password": std::env::var(format!("{prefix}_PASSWORD")).expect("live database password"),
        "database": std::env::var(format!("{prefix}_DATABASE")).expect("live database name"),
        "connect_timeout_secs": 5,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0,
        "url_params": std::env::var(format!("{prefix}_URL_PARAMS")).ok()
    }))
    .expect("live connection configuration")
}

async fn setup(config: ConnectionConfig) -> (Arc<AppState>, std::path::PathBuf, String) {
    let storage_path = std::env::temp_dir().join(format!("dbx-snapshot-rotation-{}.db", uuid::Uuid::new_v4().simple()));
    let state = Arc::new(AppState::new(
        dbx_core::persistence::test_storage::open(&storage_path).await.expect("temporary storage"),
    ));
    let table_name = format!("dbx_pr9434_{}", uuid::Uuid::new_v4().simple());
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

async fn assert_transaction_row_count(
    state: &AppState,
    transaction: &str,
    database: &str,
    table_name: &str,
    expected: i64,
) {
    let sql = format!("SELECT COUNT(*) AS row_count FROM {table_name}");
    let result = execute_in_manual_transaction_with_options(
        state,
        transaction,
        &sql,
        database,
        None,
        ManualTransactionExecutionOptions {
            max_rows: Some(10),
            classification_sql: Some(sql.clone()),
            ..Default::default()
        },
    )
    .await
    .expect("read transaction rows");
    assert!(result[0].manual_transaction_proven_read_only);
    assert_row_count(&result[0].result.rows, expected);
}

fn assert_row_count(rows: &[Vec<serde_json::Value>], expected: i64) {
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 1);
    let count = rows[0][0].as_i64().or_else(|| rows[0][0].as_str().and_then(|value| value.parse().ok()));
    assert_eq!(count, Some(expected));
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
#[ignore = "requires DBX_LIVE_MANUAL_TXN_MYSQL_* on the remote test server"]
async fn live_mysql_clean_manual_reads_refresh_snapshot_after_external_write() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_MYSQL", DatabaseType::Mysql, 3306);
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup(config.clone()).await;
    let transaction =
        begin_manual_transaction(&state, &config.id, &database, None, None).await.expect("begin transaction");
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 1).await;
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
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 2).await;
    rollback_manual_transaction(&state, &transaction).await.expect("rollback read-only transaction");
    cleanup(&state, &config, &table_name, storage_path).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_MYSQL_* on the remote test server"]
async fn live_mysql_explicit_backup_snapshot_stays_repeatable() {
    let config = live_config("DBX_LIVE_MANUAL_TXN_MYSQL", DatabaseType::Mysql, 3306);
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup(config.clone()).await;
    let transaction =
        begin_database_backup_snapshot(&state, &config.id, &database).await.expect("begin consistent snapshot");
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 1).await;
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
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 1).await;
    rollback_manual_transaction(&state, &transaction).await.expect("rollback backup snapshot");
    cleanup(&state, &config, &table_name, storage_path).await;
}

async fn verify_write_then_read_survives_commit(config: ConnectionConfig) {
    let database = config.database.clone().expect("database");
    let (state, storage_path, table_name) = setup(config.clone()).await;
    let transaction =
        begin_manual_transaction(&state, &config.id, &database, None, None).await.expect("begin transaction");
    execute_in_manual_transaction(
        &state,
        &transaction,
        &format!("INSERT INTO {table_name} (id) VALUES (2)"),
        &database,
        None,
        Some(10),
    )
    .await
    .expect("uncommitted write");
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 2).await;
    assert_transaction_row_count(&state, &transaction, &database, &table_name, 2).await;
    commit_manual_transaction(&state, &transaction).await.expect("commit must retain prior write");
    let result = execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("SELECT COUNT(*) AS row_count FROM {table_name}"),
        None,
        None,
    )
    .await
    .expect("read committed rows");
    assert_row_count(&result.rows, 2);
    cleanup(&state, &config, &table_name, storage_path).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_MYSQL_* on the remote test server"]
async fn live_mysql_write_then_reads_preserve_commit() {
    verify_write_then_read_survives_commit(live_config("DBX_LIVE_MANUAL_TXN_MYSQL", DatabaseType::Mysql, 3306)).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MANUAL_TXN_POSTGRES_* on the remote test server"]
async fn live_postgres_write_then_reads_preserve_commit() {
    verify_write_then_read_survives_commit(live_config("DBX_LIVE_MANUAL_TXN_POSTGRES", DatabaseType::Postgres, 5432))
        .await;
}
