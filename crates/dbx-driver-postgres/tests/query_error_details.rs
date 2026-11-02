//! Run against the disposable database with DBX_TEST_POSTGRES_URL set.

use std::time::Duration;

use dbx_driver_postgres::{
    connect, execute_postgres_infra_statement, execute_query, execute_query_on_client_unnamed,
    execute_query_with_schema, sql_error_position, stream_query_rows,
};

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a disposable PostgreSQL database"]
async fn native_query_errors_keep_server_message_sqlstate_and_position() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = connect(&url, Duration::from_secs(10)).await.expect("connect fixture database");
    let cases = [
        ("SELECT *\nFROM dbx_issue_13837_missing_table", "dbx_issue_13837_missing_table", "42P01"),
        ("SELECT * FROMM dbx_issue_13837_missing_table", "FROMM", "42601"),
        ("SELECT dbx_missing_column FROM (SELECT 1 AS value) AS t", "dbx_missing_column", "42703"),
        ("INSERT INTO dbx_issue_13837_missing_table VALUES (1)", "dbx_issue_13837_missing_table", "42P01"),
    ];
    for (sql, token, code) in cases {
        for schema in [None, Some("public")] {
            let error = match schema {
                Some(schema) => execute_query_with_schema(&pool, schema, sql).await,
                None => execute_query(&pool, sql).await,
            }
            .expect_err("SQL must fail");
            let (message, position) = sql_error_position::take_message_position(&error, sql);
            assert!(message.contains(token), "server message missing: {message}");
            assert!(message.contains(&format!("SQLSTATE {code}")), "server code missing: {message}");
            assert!(!message.contains(sql_error_position::SQL_ERROR_POSITION_MARKER));
            let offset = sql[..sql.find(token).unwrap()].chars().count() as u32;
            assert_eq!(position.map(|position| position.offset), Some(offset), "{error}");
        }
    }
    // Failed statements must not prevent the next query on the connection.
    assert_eq!(execute_query(&pool, "SELECT 1").await.unwrap().rows[0][0], 1);
    let client = pool.get().await.unwrap();
    let sql = "SELECT * FROM dbx_issue_13837_missing_table";
    let error = execute_query_on_client_unnamed(&client, sql, 100).await.expect_err("unnamed query must fail");
    assert!(error.contains("SQLSTATE 42P01"), "{error}");
    let error = execute_postgres_infra_statement(&client, sql, Duration::from_secs(10), "fixture")
        .await
        .expect_err("infrastructure query must fail");
    assert!(error.contains("dbx_issue_13837_missing_table"), "{error}");
    assert!(error.contains("SQLSTATE 42P01"), "{error}");
    assert!(!error.contains(sql_error_position::SQL_ERROR_POSITION_MARKER), "{error}");
    drop(client);
    let error = stream_query_rows(&pool, sql, None, &std::sync::atomic::AtomicBool::new(false), |_| Ok(()))
        .await
        .expect_err("streaming query must fail");
    assert!(error.contains("SQLSTATE 42P01"), "{error}");
    pool.close();
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a disposable PostgreSQL database"]
async fn native_query_errors_without_cursor_keep_detail_and_hint() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = connect(&url, Duration::from_secs(10)).await.expect("connect fixture database");
    let sql = "DO $$ BEGIN RAISE EXCEPTION USING MESSAGE = 'dbx diagnostic fixture', \
               ERRCODE = '22023', DETAIL = 'invalid fixture value', HINT = 'choose a valid value'; END $$";
    let error = execute_query(&pool, sql).await.expect_err("raised exception");
    assert!(error.contains("ERROR: dbx diagnostic fixture"), "{error}");
    assert!(error.contains("SQLSTATE 22023"), "{error}");
    assert!(error.contains("DETAIL: invalid fixture value"), "{error}");
    assert!(error.contains("HINT: choose a valid value"), "{error}");
    assert!(!error.contains(sql_error_position::SQL_ERROR_POSITION_MARKER), "{error}");
    pool.close();
}
