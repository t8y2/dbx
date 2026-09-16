use std::time::Duration;

use dbx_core::db::postgres;

fn postgres_url_with_search_path() -> String {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    format!(
        "postgres://{user}:{password}@{host}:{port}/{database}?options=-c%20search_path%3Ddbx_7212_dev%2Cdbx_7212_ext%2Cpublic"
    )
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* pointing at a writable PostgreSQL database"]
async fn selected_schema_keeps_the_configured_postgres_search_path() {
    let pool = postgres::connect(&postgres_url_with_search_path(), Duration::from_secs(10))
        .await
        .expect("connect to PostgreSQL");
    let client = pool.get().await.expect("checkout setup connection");
    client
        .batch_execute("CREATE SCHEMA IF NOT EXISTS dbx_7212_dev; CREATE SCHEMA IF NOT EXISTS dbx_7212_ext;")
        .await
        .expect("create search_path schemas");
    drop(client);

    let result = postgres::execute_query_with_schema(&pool, "dbx_7212_dev", "SHOW search_path")
        .await
        .expect("show search_path through DBX query execution");
    assert_eq!(
        result.rows.first().and_then(|row| row.first()).and_then(|value| value.as_str()),
        Some("dbx_7212_dev,dbx_7212_ext,public")
    );

    let client = pool.get().await.expect("checkout cleanup connection");
    client
        .batch_execute("DROP SCHEMA dbx_7212_dev; DROP SCHEMA dbx_7212_ext;")
        .await
        .expect("drop search_path schemas");
    drop(client);
    pool.close();
}
