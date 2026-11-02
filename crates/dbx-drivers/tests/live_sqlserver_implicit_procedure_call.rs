use dbx_drivers::db::sqlserver;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD for a remote SQL Server"]
async fn live_sqlserver_implicit_procedure_call_returns_result_sets() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").expect("DBX_LIVE_SQLSERVER_HOST");
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").expect("DBX_LIVE_SQLSERVER_PORT").parse().unwrap();
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").expect("DBX_LIVE_SQLSERVER_USER");
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let mut client = sqlserver::connect_with_port_explicit(
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
    .expect("connect to remote SQL Server");

    let table = "dbo.dbx_eval_implicit_call";
    let procedure = "dbo.dbx_eval_implicit_call_list";
    let create_procedure = format!(
        "CREATE PROCEDURE {procedure} AS\nSET NOCOUNT ON\nSELECT id FROM {table} ORDER BY id\nSELECT 42 AS answer"
    );
    let cleanup = format!(
        "IF OBJECT_ID('{procedure}') IS NOT NULL DROP PROCEDURE {procedure}; \
         IF OBJECT_ID('{table}') IS NOT NULL DROP TABLE {table};"
    );
    let setup = format!("CREATE TABLE {table} (id INT); INSERT INTO {table} VALUES (1), (2);");
    sqlserver::execute_simple_batch_with_max_rows(&mut client, &cleanup, None).await.unwrap();
    sqlserver::execute_simple_batch_with_max_rows(&mut client, &setup, None).await.unwrap();
    sqlserver::execute_simple_batch_with_max_rows(&mut client, &create_procedure, None).await.unwrap();

    for sql in [
        procedure.to_string(),
        "[dbo].[dbx_eval_implicit_call_list];".to_string(),
        format!("-- leading comment\n{procedure}"),
        format!("EXEC {procedure}"),
    ] {
        let batches = sqlserver::execute_batch_with_max_rows(&mut client, &sql, Some(100)).await.unwrap();
        assert_eq!(batches.len(), 2, "{sql}");
        assert_eq!(batches[0].columns, ["id"], "{sql}");
        assert_eq!(batches[0].rows.len(), 2, "{sql}");
        assert_eq!(batches[1].columns, ["answer"], "{sql}");

        let first = sqlserver::execute_query_with_max_rows(&mut client, &sql, Some(100)).await.unwrap();
        assert_eq!(first.columns, ["id"], "{sql}");
        assert_eq!(first.rows.len(), 2, "{sql}");
    }

    // A write still reports its affected rows through the unchanged execute path.
    let update = sqlserver::execute_query(&mut client, &format!("UPDATE {table} SET id = id + 10")).await.unwrap();
    assert_eq!(update.affected_rows, 2);

    sqlserver::execute_simple_batch_with_max_rows(&mut client, &cleanup, None).await.unwrap();
}
