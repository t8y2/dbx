use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_manual_transaction, execute_in_manual_transaction, execute_sql_statement, rollback_manual_transaction,
};
use dbx_core::query_result_export::{export_query_result_core, QueryResultExportRequest};
use std::sync::Arc;

// More rows than one export page, so the export cannot be served by a single page.
const ROWS: usize = 650;

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_HOST").expect("DBX_LIVE_SQL_FILE_MYSQL_HOST");
    let port =
        std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_USER").expect("DBX_LIVE_SQL_FILE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD").expect("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL export config should deserialize")
}

fn export_request(
    connection_id: &str,
    database: &str,
    file_path: &str,
    client_session_id: &str,
    txn_session_id: Option<&str>,
) -> QueryResultExportRequest {
    let sql = "SELECT id, v FROM t ORDER BY id";
    serde_json::from_value(serde_json::json!({
        "exportId": uuid::Uuid::new_v4().to_string(),
        "connectionId": connection_id,
        "database": database,
        "sql": sql,
        "queryBaseSql": sql,
        "databaseType": DatabaseType::Mysql,
        "filePath": file_path,
        "format": "csv",
        "pageSize": 100,
        "clientSessionId": client_session_id,
        "txnSessionId": txn_session_id,
    }))
    .expect("export request should deserialize")
}

fn csv_rows_with_value(path: &std::path::Path, value: &str) -> usize {
    let text = std::fs::read_to_string(path).unwrap();
    text.lines()
        .skip(1)
        .filter(|line| line.trim_end().rsplit(',').next().is_some_and(|field| field.trim_matches('"') == value))
        .count()
}

async fn committed_rows_with_v1(state: &AppState, connection_id: &str, database: &str) -> String {
    let result =
        execute_sql_statement(state, connection_id, database, "SELECT COUNT(*) FROM t WHERE v = 1", None, None)
            .await
            .unwrap();
    result.rows[0][0].as_str().map(str::to_string).unwrap_or_else(|| result.rows[0][0].to_string())
}

#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_query_result_export_reads_through_open_manual_transaction() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-txn-{suffix}");
    let database = format!("dbx_eval_export_txn_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-txn-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    execute_sql_statement(&state, &connection_id, "", &format!("CREATE DATABASE `{database}`"), None, None)
        .await
        .unwrap();
    let values = (1..=ROWS).map(|id| format!("({id}, 0)")).collect::<Vec<_>>().join(",");
    for sql in
        ["CREATE TABLE t (id INT PRIMARY KEY, v INT NOT NULL)".to_string(), format!("INSERT INTO t VALUES {values}")]
    {
        execute_sql_statement(&state, &connection_id, &database, &sql, None, None).await.unwrap();
    }

    let txn = begin_manual_transaction(&state, &connection_id, &database, None, None).await.unwrap();
    execute_in_manual_transaction(&state, &txn, "UPDATE t SET v = 1", &database, None, None).await.unwrap();

    let with_txn_path = dir.join("with-txn.csv");
    let request = export_request(
        &connection_id,
        &database,
        with_txn_path.to_str().unwrap(),
        &format!("tab:export:{suffix}-a"),
        Some(&txn),
    );
    let with_txn_result = export_query_result_core(&state, &request, None, |_| {}).await;

    let without_txn_path = dir.join("without-txn.csv");
    let request = export_request(
        &connection_id,
        &database,
        without_txn_path.to_str().unwrap(),
        &format!("tab:export:{suffix}-b"),
        None,
    );
    let without_txn_result = export_query_result_core(&state, &request, None, |_| {}).await;

    // The export must leave the transaction open: rolling it back discards the update.
    let rollback_result = rollback_manual_transaction(&state, &txn).await;
    let committed_after_rollback = committed_rows_with_v1(&state, &connection_id, &database).await;

    let with_txn_updated = csv_rows_with_value(&with_txn_path, "1");
    let without_txn_updated = csv_rows_with_value(&without_txn_path, "1");
    execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None)
        .await
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);

    with_txn_result.unwrap();
    without_txn_result.unwrap();
    rollback_result.unwrap();
    assert_eq!(with_txn_updated, ROWS, "export inside the transaction should see its uncommitted update");
    assert_eq!(without_txn_updated, 0, "export without the transaction reads committed data only");
    assert_eq!(committed_after_rollback, "0", "export must not commit the manual transaction");
}
