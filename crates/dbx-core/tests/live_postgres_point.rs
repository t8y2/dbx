use std::time::Duration;

use dbx_core::db::postgres;

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a writable PostgreSQL database"]
async fn postgres_point_columns_match_their_text_representation() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(5)).await.expect("connect postgres");
    let schema = format!("dbx_point_{}", std::process::id());
    let schema_ident = format!("\"{}\"", schema.replace('"', "\"\""));
    let table = format!("{schema_ident}.cities");

    let _ = postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE")).await;
    postgres::execute_query(&pool, &format!("CREATE SCHEMA {schema_ident}")).await.expect("create schema");
    postgres::execute_query(&pool, &format!("CREATE TABLE {table} (name text NOT NULL, location point)"))
        .await
        .expect("create table");
    postgres::execute_query(
        &pool,
        &format!("INSERT INTO {table} VALUES ('San Francisco', '(-194.0, 53.0)'), ('Unknown', NULL)"),
    )
    .await
    .expect("insert rows");

    let result = postgres::execute_query(
        &pool,
        &format!("SELECT name, location, location::text AS location_text FROM {table} ORDER BY name"),
    )
    .await
    .expect("select point rows");

    postgres::execute_query(&pool, &format!("DROP SCHEMA IF EXISTS {schema_ident} CASCADE"))
        .await
        .expect("drop schema");

    assert_eq!(result.column_types, vec!["text", "point", "text"]);
    assert_eq!(result.rows.len(), 2);
    assert_eq!(result.rows[0][1], serde_json::json!("(-194,53)"));
    assert_eq!(result.rows[0][1], result.rows[0][2]);
    assert_eq!(result.rows[1][1], serde_json::Value::Null);
    assert_eq!(result.rows[1][2], serde_json::Value::Null);
}
