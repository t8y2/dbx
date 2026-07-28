use dbx_core::db::sqlserver;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_TEST_SQLSERVER_HOST and DBX_TEST_SQLSERVER_PASSWORD"]
async fn sqlserver_dbcc_messages_do_not_replace_results_or_errors() {
    let host = std::env::var("DBX_TEST_SQLSERVER_HOST").expect("DBX_TEST_SQLSERVER_HOST");
    let port = std::env::var("DBX_TEST_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_TEST_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_TEST_SQLSERVER_PASSWORD").expect("DBX_TEST_SQLSERVER_PASSWORD");
    let mut client = sqlserver::connect_with_port_explicit(
        &host,
        port,
        true,
        &user,
        &password,
        Some("master"),
        Duration::from_secs(15),
    )
    .await
    .expect("connect to SQL Server");

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

    sqlserver::execute_query(&mut client, &format!("DROP TABLE {table}")).await.expect("clean up DBCC fixture");
}
