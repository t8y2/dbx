use std::time::Duration;

use dbx_core::db::clickhouse_driver::{
    execute_query_with_max_rows, stream_query_with_max_rows, ChClient, ClickHouseQueryStreamItem,
};

#[tokio::test]
#[ignore = "requires DBX_LIVE_CLICKHOUSE_* env vars pointing at a readonly=1 ClickHouse HTTP user"]
async fn live_clickhouse_readonly_user_uses_client_side_result_limits() {
    let host = std::env::var("DBX_LIVE_CLICKHOUSE_HOST").expect("DBX_LIVE_CLICKHOUSE_HOST");
    let port = std::env::var("DBX_LIVE_CLICKHOUSE_PORT").expect("DBX_LIVE_CLICKHOUSE_PORT");
    let user = std::env::var("DBX_LIVE_CLICKHOUSE_USER").expect("DBX_LIVE_CLICKHOUSE_USER");
    let password = std::env::var("DBX_LIVE_CLICKHOUSE_PASSWORD").expect("DBX_LIVE_CLICKHOUSE_PASSWORD");
    let database = std::env::var("DBX_LIVE_CLICKHOUSE_DATABASE").expect("DBX_LIVE_CLICKHOUSE_DATABASE");
    let client = ChClient::new(&format!("http://{host}:{port}"), Some(user), Some(password), Duration::from_secs(30));

    let result = execute_query_with_max_rows(&client, &database, "SELECT number FROM numbers(10)", Some(2))
        .await
        .expect("readonly ClickHouse query should fall back to client-side limiting");
    assert_eq!(result.columns, vec!["number"]);
    assert_eq!(result.column_types, vec!["UInt64"]);
    assert_eq!(result.rows, vec![vec![serde_json::json!(0)], vec![serde_json::json!(1)]]);
    assert!(result.truncated);

    let mut columns = Vec::new();
    let mut rows = Vec::new();
    stream_query_with_max_rows(&client, &database, "SELECT number FROM numbers(10)", Some(2), None, |item| {
        match item {
            ClickHouseQueryStreamItem::Columns { columns: names, column_types } => {
                columns = names.into_iter().zip(column_types).collect();
            }
            ClickHouseQueryStreamItem::Row(row) => rows.push(row),
        }
        Ok(())
    })
    .await
    .expect("readonly ClickHouse stream should fall back to client-side limiting");
    assert_eq!(columns, vec![("number".to_string(), "UInt64".to_string())]);
    assert_eq!(rows, vec![vec![serde_json::json!(0)], vec![serde_json::json!(1)]]);
}
