use std::time::Duration;

fn scalar_string(value: &serde_json::Value) -> &str {
    value.as_str().expect("query result should be a string")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn live_postgres_schema_queries_can_recover_after_transaction_abort() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = dbx_core::db::postgres::connect(&url, Duration::from_secs(5)).await.expect("connect");
    let schema = format!("dbx_tx_recovery_{}", uuid::Uuid::new_v4().simple());

    dbx_core::db::postgres::execute_batch(
        &pool,
        &[
            format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
            format!("CREATE SCHEMA \"{schema}\""),
            format!("CREATE TABLE \"{schema}\".\"tx_probe\" (value integer NOT NULL)"),
            format!("INSERT INTO \"{schema}\".\"tx_probe\" (value) VALUES (1)"),
        ],
    )
    .await
    .expect("prepare schema");

    dbx_core::db::postgres::execute_query_with_schema(&pool, &schema, "BEGIN").await.expect("begin transaction");

    let failed =
        dbx_core::db::postgres::execute_query_with_schema(&pool, &schema, "UPDATE missing_tx_probe SET value = 2")
            .await
            .expect_err("invalid statement should fail");
    assert!(failed.contains("missing_tx_probe"));

    let aborted = dbx_core::db::postgres::execute_query_with_schema(&pool, &schema, "SELECT value FROM tx_probe")
        .await
        .expect_err("session should remain aborted before rollback");
    assert!(aborted.contains("current transaction is aborted"));

    dbx_core::db::postgres::execute_query_with_schema(&pool, &schema, "ROLLBACK")
        .await
        .expect("rollback should recover the session");

    let recovered = dbx_core::db::postgres::execute_query_with_schema(
        &pool,
        &schema,
        "SELECT current_schema(), value::text FROM tx_probe",
    )
    .await
    .expect("query should succeed after rollback");

    assert_eq!(recovered.rows.len(), 1);
    assert_eq!(scalar_string(&recovered.rows[0][0]), schema);
    assert_eq!(scalar_string(&recovered.rows[0][1]), "1");

    dbx_core::db::postgres::execute_batch(&pool, &[format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")])
        .await
        .expect("cleanup schema");
}
