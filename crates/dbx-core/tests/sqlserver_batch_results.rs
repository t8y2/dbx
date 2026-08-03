use dbx_core::db::sqlserver;
use std::time::Duration;

async fn connect_sqlserver() -> sqlserver::SqlServerClient {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    sqlserver::connect_with_port_explicit(&host, port, true, &user, &password, Some("master"), Duration::from_secs(15))
        .await
        .expect("connect to SQL Server")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_query_keeps_result_set_after_batch_setup_statements() {
    let mut client = connect_sqlserver().await;

    let sql = "SET NOCOUNT OFF; \
               DECLARE @rows TABLE (id INT, label NVARCHAR(20)); \
               INSERT INTO @rows VALUES (1, N'first'), (2, N'second'); \
               SELECT id, label FROM @rows ORDER BY id;";
    let result = sqlserver::execute_query_with_max_rows(&mut client, sql, Some(100))
        .await
        .expect("execute result-returning batch");

    assert_eq!(result.columns, vec!["id", "label"]);
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0][0].as_i64(), Some(1));
    assert_eq!(result.rows[1][1].as_str(), Some("second"));
    assert!(!result.truncated);

    let limited = sqlserver::execute_query_with_max_rows(&mut client, sql, Some(1))
        .await
        .expect("execute limited result-returning batch");
    assert_eq!(limited.rows.len(), 1);
    assert!(limited.truncated);
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_insert_select_reports_affected_rows() {
    let mut client = connect_sqlserver().await;
    let sql = "DECLARE @target TABLE (id INT); \
               INSERT INTO @target(id) SELECT id FROM (VALUES (1), (2), (3)) AS source(id);";

    let result = sqlserver::execute_query(&mut client, sql).await.expect("execute INSERT SELECT batch");

    assert_eq!(result.affected_rows, 3);
    assert!(result.columns.is_empty());
    assert!(result.rows.is_empty());
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_single_result_query_drains_later_results() {
    let mut client = connect_sqlserver().await;
    let sql = "SELECT CAST(1 AS INT) AS retained; \
               SELECT TOP (10000) object_id AS discarded FROM sys.all_objects ORDER BY object_id;";

    let result =
        sqlserver::execute_query_with_max_rows(&mut client, sql, Some(1)).await.expect("execute multi-result query");

    assert_eq!(result.columns, vec!["retained"]);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0].as_i64(), Some(1));
    assert!(!result.truncated);

    let follow_up = sqlserver::execute_query(&mut client, "SELECT CAST(2 AS INT) AS value")
        .await
        .expect("execute query after draining later results");
    assert_eq!(follow_up.rows[0][0].as_i64(), Some(2));
}
