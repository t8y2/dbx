use dbx_core::db::sqlserver;
use std::time::Duration;

async fn connect_sqlserver() -> sqlserver::SqlServerClient {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_TEST_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());
    sqlserver::connect_with_port_explicit(&host, port, true, &user, &password, Some(&database), Duration::from_secs(15))
        .await
        .expect("connect to SQL Server")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_dbcc_messages_do_not_replace_results_or_errors() {
    let mut client = connect_sqlserver().await;

    let table = "dbo.dbx_issue_3583_messages";
    let setup = format!(
        "IF OBJECT_ID('{table}', 'U') IS NOT NULL DROP TABLE {table}; \
         CREATE TABLE {table} (id BIGINT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(20)); \
         INSERT INTO {table} (name) VALUES (N'test');"
    );
    sqlserver::execute_batch(&mut client, &setup).await.expect("create DBCC fixture");

    let dbcc = sqlserver::execute_query(&mut client, &format!("DBCC CHECKIDENT ('{table}', RESEED)",))
        .await
        .expect("execute DBCC CHECKIDENT");
    assert_eq!(dbcc.columns, vec!["Message"]);
    assert!(dbcc.rows.len() >= 2, "expected SQL Server identity and completion messages: {dbcc:?}");
    assert!(dbcc.rows.iter().any(|row| row[0].as_str().is_some_and(|message| message.contains("identity"))));

    let select = sqlserver::execute_query(&mut client, &format!("SELECT id, name FROM {table}"))
        .await
        .expect("ordinary SELECT remains available");
    assert_eq!(select.columns, vec!["id", "name"]);
    assert_eq!(select.rows.len(), 1);

    let multi = sqlserver::execute_batch(&mut client, "SELECT 1 AS first; SELECT 2 AS second")
        .await
        .expect("multiple result sets remain available");
    assert_eq!(multi.len(), 2);
    assert_eq!(multi[0].columns, vec!["first"]);
    assert_eq!(multi[1].columns, vec!["second"]);

    let dml = sqlserver::execute_query(&mut client, &format!("UPDATE {table} SET name = N'updated'"))
        .await
        .expect("ordinary DML remains available");
    assert_eq!(dml.affected_rows, 1);
    assert!(dml.columns.is_empty());

    sqlserver::execute_query(&mut client, &format!("DROP TABLE {table}")).await.expect("clean up DBCC fixture");

    let use_database =
        sqlserver::execute_query(&mut client, "USE master").await.expect("execute database context change");
    assert_eq!(use_database.columns, vec!["Message"]);
    assert!(
        use_database.rows.iter().all(|row| !row[0]
            .as_str()
            .is_some_and(|message| message.starts_with("Database change")
                || message.starts_with("SQL collation")
                || message.starts_with("Packet size change"))),
        "internal TDS environment changes must not leak into server messages: {use_database:?}"
    );

    let error = sqlserver::execute_query(&mut client, "SELECT * FROM dbo.dbx_issue_3583_missing")
        .await
        .expect_err("real SQL Server errors must remain failures");
    assert!(!error.trim().is_empty());
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_print_messages_keep_tds_order_around_results_and_counts() {
    let mut client = connect_sqlserver().await;

    let result_order = sqlserver::execute_batch(
        &mut client,
        "SET NOCOUNT ON; \
         PRINT N'before'; \
         SELECT CAST(1 AS int) AS first; \
         PRINT N'between'; \
         SELECT CAST(2 AS int) AS second; \
         PRINT N'after one'; \
         PRINT N'after two';",
    )
    .await
    .expect("execute PRINT and result-set batch");

    assert_eq!(result_order.len(), 5, "unexpected ordered results: {result_order:?}");
    assert_eq!(result_order[0].columns, vec!["Message"]);
    assert_eq!(result_order[0].rows, vec![vec![serde_json::json!("before")]]);
    assert_eq!(result_order[1].columns, vec!["first"]);
    assert_eq!(result_order[2].rows, vec![vec![serde_json::json!("between")]]);
    assert_eq!(result_order[3].columns, vec!["second"]);
    assert_eq!(result_order[4].rows, vec![vec![serde_json::json!("after one")], vec![serde_json::json!("after two")]]);

    sqlserver::execute_simple_batch_with_max_rows(
        &mut client,
        "SET NOCOUNT ON; \
         CREATE TABLE #dbx_print_order (id int NOT NULL PRIMARY KEY, value int NOT NULL); \
         INSERT INTO #dbx_print_order VALUES (1, 0), (2, 0); \
         SET NOCOUNT OFF;",
        None,
    )
    .await
    .expect("create PRINT ordering fixture");
    let count_order = sqlserver::execute_batch(
        &mut client,
        "PRINT N'before update'; \
         UPDATE #dbx_print_order SET value = value + 1; \
         PRINT N'after update';",
    )
    .await
    .expect("execute PRINT and update-count batch");

    assert_eq!(count_order.len(), 3, "unexpected message/count order: {count_order:?}");
    assert_eq!(count_order[0].rows, vec![vec![serde_json::json!("before update")]]);
    assert_eq!(count_order[1].affected_rows, 2);
    assert_eq!(count_order[2].rows, vec![vec![serde_json::json!("after update")]]);
}

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_default_no_count_keeps_select_and_dml_result_shape() {
    let mut client = connect_sqlserver().await;

    let single = sqlserver::execute_batch(&mut client, "SELECT CAST(1 AS int) AS selected")
        .await
        .expect("execute one SELECT with NOCOUNT OFF");
    assert_eq!(single.len(), 1, "SELECT count must not become a separate result: {single:?}");
    assert_eq!(single[0].columns, vec!["selected"]);

    let multiple =
        sqlserver::execute_batch(&mut client, "SELECT CAST(1 AS int) AS first; SELECT CAST(2 AS int) AS second;")
            .await
            .expect("execute multiple SELECT statements with NOCOUNT OFF");
    assert_eq!(multiple.len(), 2, "SELECT counts must not become separate results: {multiple:?}");
    assert_eq!(multiple[0].columns, vec!["first"]);
    assert_eq!(multiple[1].columns, vec!["second"]);

    sqlserver::execute_simple_batch_with_max_rows(
        &mut client,
        "SET NOCOUNT ON; \
         CREATE TABLE #dbx_select_dml_order (id int NOT NULL PRIMARY KEY, value int NOT NULL); \
         INSERT INTO #dbx_select_dml_order VALUES (1, 0), (2, 0); \
         SET NOCOUNT OFF;",
        None,
    )
    .await
    .expect("create SELECT and DML ordering fixture");
    let mixed = sqlserver::execute_batch(
        &mut client,
        "SELECT CAST(1 AS int) AS first; \
         UPDATE #dbx_select_dml_order SET value = value + 1; \
         SELECT CAST(2 AS int) AS second; \
         DELETE FROM #dbx_select_dml_order;",
    )
    .await
    .expect("execute SELECT and DML batch with NOCOUNT OFF");

    assert_eq!(mixed.len(), 4, "unexpected SELECT and DML result order: {mixed:?}");
    assert_eq!(mixed[0].columns, vec!["first"]);
    assert_eq!(mixed[1].affected_rows, 2);
    assert_eq!(mixed[2].columns, vec!["second"]);
    assert_eq!(mixed[3].affected_rows, 2);
}
