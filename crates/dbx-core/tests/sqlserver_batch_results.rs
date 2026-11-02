use dbx_core::db::sqlserver;
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_result_sql::{build_paginated_query_sql, PaginatedQuerySqlOptions};
use std::time::Duration;

async fn connect_sqlserver() -> sqlserver::SqlServerClient {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());
    sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some(&database),
        None,
        Duration::from_secs(15),
    )
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
async fn sqlserver_transaction_batch_reports_affected_rows() {
    let mut client = connect_sqlserver().await;
    sqlserver::execute_simple_batch_with_max_rows(
        &mut client,
        "CREATE TABLE #dbx_transaction_rows (id INT NOT NULL PRIMARY KEY, value INT NOT NULL); \
         INSERT INTO #dbx_transaction_rows (id, value) VALUES (1, 0), (2, 0), (3, 0), (4, 0);",
        None,
    )
    .await
    .expect("create transaction row-count fixture");

    let plain = sqlserver::execute_query(
        &mut client,
        "UPDATE #dbx_transaction_rows SET value = value + 1 WHERE id IN (1, 2, 3);",
    )
    .await
    .expect("execute plain UPDATE");
    assert_eq!(plain.affected_rows, 3);

    let committed = sqlserver::execute_query(
        &mut client,
        "BEGIN TRANSACTION; \
         UPDATE #dbx_transaction_rows SET value = value + 1 WHERE id IN (1, 2, 3); \
         COMMIT TRANSACTION;",
    )
    .await
    .expect("execute committed transaction UPDATE");
    assert_eq!(committed.affected_rows, 3);

    let persisted =
        sqlserver::execute_query(&mut client, "SELECT SUM(value) AS total_value FROM #dbx_transaction_rows;")
            .await
            .expect("read committed transaction values");
    assert_eq!(persisted.rows[0][0].as_i64(), Some(6));

    let multiple = sqlserver::execute_query(
        &mut client,
        "BEGIN TRANSACTION; \
         UPDATE #dbx_transaction_rows SET value = value + 1 WHERE id IN (1, 2); \
         DELETE FROM #dbx_transaction_rows WHERE id = 4; \
         COMMIT TRANSACTION;",
    )
    .await
    .expect("execute multiple DML statements in a committed transaction");
    assert_eq!(multiple.affected_rows, 3);
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_driver_execute_reports_balanced_transaction_rows() {
    let mut client = connect_sqlserver().await;
    client
        .simple_query(
            "CREATE TABLE #dbx_driver_transaction_rows (id INT NOT NULL PRIMARY KEY, value INT NOT NULL); \
             INSERT INTO #dbx_driver_transaction_rows (id, value) VALUES (1, 0), (2, 0), (3, 0), (4, 0);",
        )
        .await
        .expect("create driver transaction row-count fixture")
        .into_results()
        .await
        .expect("drain fixture setup results");

    let result = client
        .execute(
            "BEGIN TRANSACTION; \
             UPDATE #dbx_driver_transaction_rows SET value = value + 1 WHERE id IN (1, 2, 3); \
             COMMIT TRANSACTION;",
            &[],
        )
        .await
        .expect("execute balanced transaction through RPC");

    assert_eq!(result.rows_affected().iter().sum::<u64>(), 3);
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

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_duplicate_join_columns_page_without_leaking_rowcount() {
    let mut client = connect_sqlserver().await;
    sqlserver::execute_simple_batch_with_max_rows(
        &mut client,
        "CREATE TABLE #dbx_page_detail (id INT NOT NULL PRIMARY KEY, parent_id INT NOT NULL); \
         CREATE TABLE #dbx_page_main (id INT NOT NULL PRIMARY KEY, label NVARCHAR(20) NOT NULL); \
         WITH numbers AS ( \
           SELECT TOP (1200) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS value \
           FROM sys.all_objects a CROSS JOIN sys.all_objects b \
         ) \
         INSERT INTO #dbx_page_main (id, label) SELECT value, CONCAT(N'label-', value) FROM numbers; \
         INSERT INTO #dbx_page_detail (id, parent_id) SELECT id, id FROM #dbx_page_main;",
        None,
    )
    .await
    .expect("create pagination fixtures");

    let reported_query = "SELECT * FROM #dbx_page_detail d LEFT JOIN #dbx_page_main m ON m.id = d.parent_id";
    let reported_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql: reported_query.to_string(),
        database_type: Some(DatabaseType::SqlServer),
        limit: 500,
        offset: 500,
    });
    let reported_results = sqlserver::execute_batch_with_max_rows(
        &mut client,
        reported_page.sql.as_deref().expect("build reported pagination SQL"),
        Some(500),
    )
    .await
    .expect("execute reported duplicate-column page");
    assert_eq!(reported_results.first().expect("reported page result").rows.len(), 500);

    let query = format!("{reported_query} ORDER BY d.id");
    let page = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql: query,
        database_type: Some(DatabaseType::SqlServer),
        limit: 500,
        offset: 500,
    });
    let page_sql = page.sql.expect("build duplicate-column pagination SQL");
    let results = sqlserver::execute_batch_with_max_rows(&mut client, &page_sql, Some(500))
        .await
        .expect("execute duplicate-column page");
    let result = results.first().expect("page result");

    assert_eq!(result.rows.len(), 500);
    assert_eq!(result.rows.first().and_then(|row| row[0].as_i64()), Some(501));
    assert_eq!(result.rows.last().and_then(|row| row[0].as_i64()), Some(1000));

    let failing_page = build_paginated_query_sql(PaginatedQuerySqlOptions {
        original_sql:
            "SELECT * FROM #dbx_page_detail d LEFT JOIN #dbx_missing_page_table m ON m.id = d.parent_id ORDER BY d.id"
                .to_string(),
        database_type: Some(DatabaseType::SqlServer),
        limit: 1,
        offset: 1,
    });
    let error = sqlserver::execute_batch_with_max_rows(
        &mut client,
        failing_page.sql.as_deref().expect("build failing pagination SQL"),
        Some(1),
    )
    .await
    .expect_err("missing joined table should fail");
    assert!(error.to_ascii_lowercase().contains("dbx_missing_page_table"));

    let follow_up =
        sqlserver::execute_query(&mut client, "SELECT value FROM (VALUES (1), (2)) rows(value) ORDER BY value")
            .await
            .expect("execute query after ROWCOUNT page");
    assert_eq!(follow_up.rows.len(), 2);
}

/// The desktop grid only ever shows `max_rows` rows. Reading the rest of the
/// TDS stream costs ~10-15us per discarded row, which is what turns a
/// few-hundred-ms query into a 10s+ stall when the executed SQL is unbounded.
/// The stopping path must return the same bounded result but leave the client
/// flagged for pool replacement instead of draining the whole result.
#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_stops_reading_after_row_limit_and_flags_the_connection() {
    let mut client = connect_sqlserver().await;

    // A huge streaming result that needs no fixture tables: every SQL Server
    // has sys.all_columns, and the cross join keeps producing rows forever.
    let sql = "SELECT a.object_id, b.object_id FROM sys.all_columns a CROSS JOIN sys.all_columns b";

    let started = std::time::Instant::now();
    let result = sqlserver::execute_query_with_max_rows_stopping(&mut client, sql, Some(100))
        .await
        .expect("execute stopping query");
    let elapsed = started.elapsed();

    assert_eq!(result.rows.len(), 100);
    assert!(result.truncated, "the row limit must still be reported as truncation");
    assert!(client.take_abandoned_after_row_limit(), "the client must be flagged for pool replacement");
    assert!(!client.take_abandoned_after_row_limit(), "the flag must be one-shot");
    assert!(elapsed < Duration::from_secs(30), "stopping must not drain the result: {elapsed:?}");

    // The abandoned client is never reused. A replacement connection (what the
    // pool creates after removing the abandoned one) must work normally.
    let mut replacement = connect_sqlserver().await;
    let health = sqlserver::execute_query_with_max_rows(&mut replacement, "SELECT 1 AS ok", Some(10))
        .await
        .expect("replacement connection query");
    assert_eq!(health.rows.len(), 1);

    // A result that fits under the limit keeps the connection usable.
    let mut small = connect_sqlserver().await;
    let small_result = sqlserver::execute_query_with_max_rows_stopping(&mut small, "SELECT 1 AS ok", Some(10))
        .await
        .expect("execute small stopping query");
    assert_eq!(small_result.rows.len(), 1);
    assert!(!small_result.truncated);
    assert!(!small.take_abandoned_after_row_limit());
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_stopping_path_finishes_stored_procedure_side_effects() {
    let mut client = connect_sqlserver().await;
    sqlserver::execute_query(
        &mut client,
        "CREATE TABLE #dbx_row_limit_marker (value INT); INSERT INTO #dbx_row_limit_marker VALUES (0);",
    )
    .await
    .unwrap();
    sqlserver::execute_query(
        &mut client,
        "CREATE PROCEDURE #dbx_row_limit_proc AS BEGIN SET NOCOUNT ON; \
         SELECT TOP (100000) a.object_id FROM sys.all_columns a CROSS JOIN sys.all_columns b; \
         UPDATE #dbx_row_limit_marker SET value = 1; END;",
    )
    .await
    .unwrap();

    let result = sqlserver::execute_query_with_max_rows_stopping(&mut client, "EXEC #dbx_row_limit_proc", Some(1))
        .await
        .unwrap();
    assert_eq!(result.rows.len(), 1);
    assert!(result.truncated);
    assert!(!client.take_abandoned_after_row_limit(), "a procedure must finish before returning");
    let marker = sqlserver::execute_query(&mut client, "SELECT value FROM #dbx_row_limit_marker").await.unwrap();
    assert_eq!(marker.rows[0][0].as_i64(), Some(1));
}
