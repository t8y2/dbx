use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, execute_in_manual_transaction, execute_sql_statement, rollback_manual_transaction,
};
use dbx_core::query_result_export::{export_query_result_core, QueryResultExportRequest};
use std::sync::Arc;

// More rows than one export page, so the export cannot be served by a single page.
const ROWS: usize = 650;

fn live_oracle_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_ORACLE_HOST").expect("DBX_LIVE_ORACLE_HOST");
    let port = std::env::var("DBX_LIVE_ORACLE_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(1521);
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").expect("DBX_LIVE_ORACLE_SERVICE");
    let username = std::env::var("DBX_LIVE_ORACLE_USER").expect("DBX_LIVE_ORACLE_USER");
    let password = std::env::var("DBX_LIVE_ORACLE_PASSWORD").expect("DBX_LIVE_ORACLE_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Oracle,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": service,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 60,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Oracle export config should deserialize")
}

fn export_request(
    connection_id: &str,
    database: &str,
    sql: &str,
    file_path: &str,
    page_size: usize,
    client_session_id: &str,
    txn_session_id: Option<&str>,
) -> QueryResultExportRequest {
    serde_json::from_value(serde_json::json!({
        "exportId": uuid::Uuid::new_v4().to_string(),
        "connectionId": connection_id,
        "database": database,
        "sql": sql,
        "queryBaseSql": sql,
        "databaseType": DatabaseType::Oracle,
        "useAgentCursor": true,
        "filePath": file_path,
        "format": "csv",
        "pageSize": page_size,
        "clientSessionId": client_session_id,
        "txnSessionId": txn_session_id,
    }))
    .expect("export request should deserialize")
}

fn csv_data_row_count(path: &std::path::Path) -> usize {
    std::fs::read_to_string(path).unwrap().lines().skip(1).filter(|line| !line.trim().is_empty()).count()
}

fn csv_rows_with_value(path: &std::path::Path, value: &str) -> usize {
    let text = std::fs::read_to_string(path).unwrap();
    text.lines()
        .skip(1)
        .filter(|line| line.trim_end().rsplit(',').next().is_some_and(|field| field.trim_matches('"') == value))
        .count()
}

async fn committed_rows_with_v1(state: &AppState, connection_id: &str, database: &str, table: &str) -> String {
    let result = execute_sql_statement(
        state,
        connection_id,
        database,
        &format!("SELECT COUNT(*) FROM {table} WHERE V = 1"),
        None,
        None,
    )
    .await
    .unwrap();
    result.rows[0][0].as_str().map(str::to_string).unwrap_or_else(|| result.rows[0][0].to_string())
}

async fn seed_table(state: &AppState, connection_id: &str, database: &str, table: &str) {
    let _ =
        execute_sql_statement(state, connection_id, database, &format!("DROP TABLE {table} PURGE"), None, None).await;
    execute_sql_statement(
        state,
        connection_id,
        database,
        &format!("CREATE TABLE {table} (ID NUMBER PRIMARY KEY, V NUMBER NOT NULL)"),
        None,
        None,
    )
    .await
    .unwrap();
    // Oracle 11g has no `VALUES` table constructor or `generate_series`; CONNECT BY
    // generates the synthetic 650-row fixture in one statement.
    execute_sql_statement(
        state,
        connection_id,
        database,
        &format!("INSERT INTO {table} (ID, V) SELECT LEVEL, 0 FROM DUAL CONNECT BY LEVEL <= {ROWS}"),
        None,
        None,
    )
    .await
    .unwrap();
}

async fn live_state(id: &str) -> (Arc<AppState>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("dbx-live-oracle-export-txn-{id}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    (Arc::new(AppState::new(storage)), dir)
}

fn unique_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_uppercase()
}

#[tokio::test]
#[ignore = "requires a disposable Oracle 11g/18c+ endpoint (DBX_LIVE_ORACLE_*)"]
async fn live_oracle_query_result_export_pages_through_open_manual_transaction() {
    let suffix = unique_id();
    let connection_id = format!("live-oracle-export-txn-{suffix}");
    let table = format!("DBX_EXPORT_TXN_{suffix}");
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").unwrap();
    let (state, dir) = live_state(&suffix).await;
    state.configs.write().await.insert(connection_id.clone(), live_oracle_config(&connection_id));
    seed_table(&state, &connection_id, &service, &table).await;

    let txn = begin_manual_transaction(&state, &connection_id, &service, None, None).await.unwrap();
    execute_in_manual_transaction(&state, &txn, &format!("UPDATE {table} SET V = 1"), &service, None, None)
        .await
        .unwrap();

    // The user-reported statement shape: an existing ROWNUM predicate makes the
    // Oracle ROWNUM wrapper unsafe, so the export needs the Agent cursor. With a
    // page size below the ROWNUM bound it must stream several cursor pages.
    let sql = format!("SELECT ID, V FROM {table} WHERE ROWNUM < 2000");
    let with_txn_path = dir.join("with-txn.csv");
    let request = export_request(
        &connection_id,
        &service,
        &sql,
        with_txn_path.to_str().unwrap(),
        100,
        &format!("tab:export:{suffix}-a"),
        Some(&txn),
    );
    let with_txn_result = export_query_result_core(&state, &request, None, |_| {}).await;

    let without_txn_path = dir.join("without-txn.csv");
    let request = export_request(
        &connection_id,
        &service,
        &sql,
        without_txn_path.to_str().unwrap(),
        100,
        &format!("tab:export:{suffix}-b"),
        None,
    );
    let without_txn_result = export_query_result_core(&state, &request, None, |_| {}).await;

    // The export must leave the transaction open: rolling it back discards the update.
    let rollback_result = rollback_manual_transaction(&state, &txn).await;
    let committed_after_rollback = committed_rows_with_v1(&state, &connection_id, &service, &table).await;

    let with_txn_rows = csv_data_row_count(&with_txn_path);
    let without_txn_rows = csv_data_row_count(&without_txn_path);
    let with_txn_updated = csv_rows_with_value(&with_txn_path, "1");
    let without_txn_updated = csv_rows_with_value(&without_txn_path, "1");
    let _ =
        execute_sql_statement(&state, &connection_id, &service, &format!("DROP TABLE {table} PURGE"), None, None).await;
    let _ = std::fs::remove_dir_all(&dir);

    with_txn_result.unwrap();
    without_txn_result.unwrap();
    rollback_result.unwrap();
    assert_eq!(with_txn_rows, ROWS, "export inside the transaction should export every row");
    assert_eq!(with_txn_updated, ROWS, "export inside the transaction should see its uncommitted update");
    assert_eq!(without_txn_rows, ROWS, "export without the transaction should still export every row");
    assert_eq!(without_txn_updated, 0, "export without the transaction reads committed data only");
    assert_eq!(committed_after_rollback, "0", "export must not commit the manual transaction");
}

#[tokio::test]
#[ignore = "requires a disposable Oracle 11g/18c+ endpoint (DBX_LIVE_ORACLE_*)"]
async fn live_oracle_rownum_bounded_export_runs_once_inside_manual_transaction() {
    let suffix = unique_id();
    let connection_id = format!("live-oracle-export-txn-{suffix}");
    let table = format!("DBX_EXPORT_TXN_{suffix}");
    let service = std::env::var("DBX_LIVE_ORACLE_SERVICE").unwrap();
    let (state, dir) = live_state(&suffix).await;
    state.configs.write().await.insert(connection_id.clone(), live_oracle_config(&connection_id));
    seed_table(&state, &connection_id, &service, &table).await;

    let txn = begin_manual_transaction(&state, &connection_id, &service, None, None).await.unwrap();
    execute_in_manual_transaction(&state, &txn, &format!("UPDATE {table} SET V = 1"), &service, None, None)
        .await
        .unwrap();

    // Default export page size (2000) is above the ROWNUM bound (1999), so the
    // export can run as one bounded statement instead of paging a cursor.
    let sql = format!("SELECT ID, V FROM {table} WHERE ROWNUM < 2000");
    let path = dir.join("bounded.csv");
    let request = export_request(
        &connection_id,
        &service,
        &sql,
        path.to_str().unwrap(),
        2000,
        &format!("tab:export:{suffix}-c"),
        Some(&txn),
    );
    let result = export_query_result_core(&state, &request, None, |_| {}).await;

    let rollback_result = rollback_manual_transaction(&state, &txn).await;
    let rows = csv_data_row_count(&path);
    let updated = csv_rows_with_value(&path, "1");
    let _ =
        execute_sql_statement(&state, &connection_id, &service, &format!("DROP TABLE {table} PURGE"), None, None).await;
    let _ = std::fs::remove_dir_all(&dir);

    result.unwrap();
    rollback_result.unwrap();
    assert_eq!(rows, ROWS, "ROWNUM-bounded export should export every row");
    assert_eq!(updated, ROWS, "ROWNUM-bounded export should see the transaction's uncommitted update");
}
