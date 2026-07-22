use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::storage::Storage;
use dbx_core::table_import::parse_xlsx_file;

fn live_clickhouse_config(
    id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::ClickHouse,
        "host": host,
        "port": port,
        "username": user,
        "password": password,
        "database": database,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live ClickHouse config should deserialize")
}

fn json_cell_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(value) => value.clone(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_cell_i64(value: &serde_json::Value) -> i64 {
    if let Some(value) = value.as_i64() {
        return value;
    }
    if let Some(value) = value.as_u64() {
        return i64::try_from(value).expect("u64 id fits in i64");
    }
    let text = json_cell_text(value);
    text.parse::<i64>().or_else(|_| text.parse::<f64>().map(|value| value as i64)).expect("numeric id")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_CLICKHOUSE_* env vars pointing at a ClickHouse HTTP endpoint"]
async fn live_clickhouse_query_result_export_xlsx_streams_random_order_query_once() {
    let host = std::env::var("DBX_LIVE_CLICKHOUSE_HOST").expect("DBX_LIVE_CLICKHOUSE_HOST");
    let port = std::env::var("DBX_LIVE_CLICKHOUSE_PORT").expect("DBX_LIVE_CLICKHOUSE_PORT").parse::<u16>().unwrap();
    let user = std::env::var("DBX_LIVE_CLICKHOUSE_USER").expect("DBX_LIVE_CLICKHOUSE_USER");
    let password = std::env::var("DBX_LIVE_CLICKHOUSE_PASSWORD").expect("DBX_LIVE_CLICKHOUSE_PASSWORD");
    let database = std::env::var("DBX_LIVE_CLICKHOUSE_DATABASE").expect("DBX_LIVE_CLICKHOUSE_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-clickhouse-query-export-{suffix}");
    let config = live_clickhouse_config(&connection_id, &host, port, &user, &password, &database);
    let dir = std::env::temp_dir().join(format!("dbx-live-clickhouse-query-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);

    let file_path = dir.join("result.xlsx");
    let sql = "
        SELECT
            number + 1 AS id,
            concat('row-', toString(number + 1)) AS label
        FROM numbers(2050)
        ORDER BY rand()
    "
    .to_string();
    let request = QueryResultExportRequest {
        export_id: format!("live-clickhouse-query-export-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: None,
        sql: sql.clone(),
        query_base_sql: sql,
        setup_sql: Vec::new(),
        database_type: DatabaseType::ClickHouse,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "xlsx".to_string(),
        include_sql_sheet: false,
        page_size: 100,
        row_limit: None,
        total_rows: Some(2050),
        timeout_secs: Some(30),
        keyset_optimization_enabled: false,
        client_session_id: None,
        execution_id: Some(format!("live-clickhouse-query-export-{suffix}")),
        date_time_format: None,
    };
    let done_seen = AtomicBool::new(false);
    let result = export_query_result_core(&state, &request, None, |progress| {
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;

    result.expect("export ClickHouse query result to XLSX without per-page re-execution");
    assert!(done_seen.load(Ordering::Relaxed));

    let parsed = parse_xlsx_file(&file_path.to_string_lossy(), 3000).expect("parse exported XLSX");
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(parsed.columns, vec!["id", "label"]);
    assert_eq!(parsed.total_rows, 2050);
    assert_eq!(parsed.rows.len(), 2050);

    let exported_ids = parsed.rows.iter().map(|row| json_cell_i64(&row[0])).collect::<BTreeSet<_>>();
    let expected_ids = (1..=2050).collect::<BTreeSet<_>>();
    assert_eq!(exported_ids, expected_ids);
}
