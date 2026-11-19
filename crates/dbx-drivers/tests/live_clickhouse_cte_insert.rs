use dbx_drivers::db::clickhouse_driver::{execute_query, execute_query_with_max_rows, ChClient};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_CLICKHOUSE_* env vars pointing at a disposable ClickHouse 25.8.24 HTTP database with DDL/write access"]
async fn live_clickhouse_cte_insert_accepts_command_response() {
    let host = std::env::var("DBX_LIVE_CLICKHOUSE_HOST").expect("DBX_LIVE_CLICKHOUSE_HOST");
    let port = std::env::var("DBX_LIVE_CLICKHOUSE_PORT").expect("DBX_LIVE_CLICKHOUSE_PORT");
    let user = std::env::var("DBX_LIVE_CLICKHOUSE_USER").expect("DBX_LIVE_CLICKHOUSE_USER");
    let password = std::env::var("DBX_LIVE_CLICKHOUSE_PASSWORD").expect("DBX_LIVE_CLICKHOUSE_PASSWORD");
    let database = std::env::var("DBX_LIVE_CLICKHOUSE_DATABASE").expect("DBX_LIVE_CLICKHOUSE_DATABASE");
    let client = ChClient::new(&format!("http://{host}:{port}"), Some(user), Some(password), Duration::from_secs(30));
    let table = format!("dbx_issue_13303_{}", uuid::Uuid::new_v4().simple());
    execute_query(
        &client,
        &database,
        &format!(
            "CREATE TABLE {table} (`timestamp` DateTime64(9, 'UTC'), eid UInt64,) \
             ENGINE = MergeTree() PARTITION BY toYYYYMMDD(timestamp) ORDER BY (timestamp)"
        ),
    )
    .await
    .expect("create isolated issue #13303 table");
    execute_query(&client, &database, &format!("INSERT INTO {table} VALUES ('2026-10-23 00:00:00.123456789', 42)"))
        .await
        .expect("seed one row with DateTime64(9) precision");
    let original_sql = format!(
        "WITH a AS (SELECT timestamp, eid FROM {table}), \
         b AS (SELECT timestamp, eid FROM {table}) \
         INSERT INTO {table} (`timestamp`, eid) \
         VALUES (SELECT a.`timestamp`, b.eid FROM a LEFT JOIN b ON a.eid = b.eid)"
    );
    let original_result = execute_query_with_max_rows(&client, &database, &original_sql, Some(1)).await;
    // The report's VALUES (SELECT ...) form is rejected by ClickHouse 25.8.24.21.
    // Use its valid INSERT ... SELECT equivalent to isolate the driver's response handling.
    let sql = format!(
        "WITH a AS (SELECT timestamp, eid FROM {table}), \
         b AS (SELECT timestamp, eid FROM {table}) \
         INSERT INTO {table} (`timestamp`, eid) \
         SELECT a.`timestamp`, b.eid FROM a LEFT JOIN b ON a.eid = b.eid"
    );
    let result = execute_query_with_max_rows(&client, &database, &sql, Some(1)).await;
    let count = execute_query(&client, &database, &format!("SELECT count() AS n FROM {table}")).await;
    let selected = execute_query_with_max_rows(
        &client,
        &database,
        &format!("WITH a AS (SELECT eid FROM {table}) SELECT eid FROM a"),
        Some(1),
    )
    .await;
    let cleanup = execute_query(&client, &database, &format!("DROP TABLE {table} SYNC")).await;
    cleanup.expect("drop isolated issue #13303 table");
    let original_error = original_result.expect_err("invalid VALUES subquery must remain an error");
    assert!(original_error.contains("Code: 62"), "{original_error}");
    let result = result.unwrap_or_else(|error| {
        panic!(
            "issue #13303 CTE INSERT failed: {error}; rows after execution: {:?}",
            count.as_ref().map(|result| &result.rows)
        )
    });
    assert!(result.columns.is_empty());
    assert!(result.rows.is_empty());
    assert!(!result.truncated);
    let count = count.unwrap();
    let count = &count.rows[0][0];
    assert_eq!(count.as_u64().or_else(|| count.as_str()?.parse().ok()), Some(2));
    let selected = selected.unwrap();
    assert_eq!(selected.columns, vec!["eid"]);
    assert_eq!(selected.rows.len(), 1);
    assert!(selected.truncated);
}
