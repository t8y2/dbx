//! Index-metadata regression for legacy MySQL releases. Run against MySQL 5.7
//! (has INDEX_COMMENT, lacks EXPRESSION) or 5.0/5.1 (lacks both) with
//! `DBX_LIVE_MYSQL_INDEXES_URL`, then
//! `cargo test -p dbx-driver-mysql --test live_mysql_indexes_legacy_versions -- --ignored --nocapture`.
//! SELECT-only: the test reads INFORMATION_SCHEMA and creates no fixtures.
use dbx_driver_mysql::mysql;
use mysql_async::prelude::Queryable;
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_INDEXES_URL pointing at a MySQL 5.x server; SELECT only"]
async fn list_indexes_survives_legacy_statistics_columns() {
    let url = std::env::var("DBX_LIVE_MYSQL_INDEXES_URL").expect("set DBX_LIVE_MYSQL_INDEXES_URL");
    let pool = mysql::connect(&url, Duration::from_secs(15)).await.unwrap();

    let mut version = mysql::get_conn_with_health_check(&pool).await.unwrap();
    let version_rows: Vec<mysql_async::Row> = version.exec("SELECT VERSION()", ()).await.unwrap();
    let server_version: String = version_rows.first().and_then(|row| row.get(0)).unwrap_or_default();
    println!("server version: {server_version}");

    let indexes = mysql::list_indexes(&pool, "mysql", "db").await.unwrap();
    println!("mysql.db indexes: {}", indexes.len());
    assert!(!indexes.is_empty(), "mysql.db must expose indexes for its system tables");

    let primary = indexes.iter().find(|index| index.is_primary).expect("system tables carry primary keys");
    assert!(!primary.columns.is_empty(), "primary key must report key columns");
    // 5.7+ carries INDEX_COMMENT as a column; 5.0/5.1 does not, so comments may
    // legitimately be empty there — the contract is that the query itself
    // succeeds instead of failing with ER_BAD_FIELD_ERROR.
}
