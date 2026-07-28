use dbx_core::db::sqlserver;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_long_varchar_results_are_complete_and_use_sql_type_names() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let mut client = sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        Duration::from_secs(15),
    )
    .await
    .expect("connect to SQL Server");

    let result = sqlserver::execute_query(
        &mut client,
        "SELECT CAST(REPLICATE('A', 250) + REPLICATE('B', 250) AS VARCHAR(500)) AS long_value \
         UNION ALL \
         SELECT CAST(REPLICATE('C', 500) AS VARCHAR(500))",
    )
    .await
    .expect("query VARCHAR(500) values");

    assert_eq!(result.columns, vec!["long_value"]);
    assert_eq!(result.column_types, vec!["varchar"]);
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0][0].as_str().map(str::len), Some(500));
    assert_eq!(result.rows[0][0], serde_json::json!(format!("{}{}", "A".repeat(250), "B".repeat(250))));
    assert_eq!(result.rows[1][0], serde_json::json!("C".repeat(500)));
}
