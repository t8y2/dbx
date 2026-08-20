// Live regression coverage for Issue #6590: Doris query-result column comments
// are lost when the metadata lookup targets the tab/execution database instead
// of the database explicitly qualified in the SQL (`db.table` puts the database
// in the `schema` parameter for MySQL-family dialects).
//
// Run with:
//   DBX_TEST_DORIS_HOST=127.0.0.1 DBX_TEST_DORIS_PORT=9030 DBX_TEST_DORIS_USER=root \
//   DBX_TEST_DORIS_PASSWORD= cargo test -p dbx-core --test live_doris -- --ignored
use std::time::Duration;

use dbx_core::connection::{connect_bare_metadata_pool, AppState};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::schema::get_columns_core;
use dbx_core::storage::Storage;
use mysql_async::prelude::Queryable;

fn live_doris_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_TEST_DORIS_HOST").expect("DBX_TEST_DORIS_HOST");
    let port = std::env::var("DBX_TEST_DORIS_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(9030);
    let username = std::env::var("DBX_TEST_DORIS_USER").expect("DBX_TEST_DORIS_USER");
    let password = std::env::var("DBX_TEST_DORIS_PASSWORD").unwrap_or_default();

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Doris,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Doris config should deserialize")
}

#[tokio::test]
#[ignore = "requires DBX_TEST_DORIS_HOST/DBX_TEST_DORIS_PORT/DBX_TEST_DORIS_USER pointing at a writable Apache Doris 2.1.8 cluster"]
async fn doris_qualified_table_metadata_resolves_schema_database_with_comments() {
    let config = live_doris_config("doris-6590-live");
    let db_path = std::env::temp_dir().join(format!("dbx-doris-6590-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = Storage::open(&db_path).await.expect("open temp storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config.clone());

    // Setup: a table with two commented columns and one uncommented column.
    let pool = connect_bare_metadata_pool(&config, &config.host, config.port, Duration::from_secs(10), 3)
        .await
        .expect("connect bare Doris metadata pool");
    let mut conn = pool.get_conn().await.expect("get Doris connection");
    Queryable::query_drop(&mut conn, "CREATE DATABASE IF NOT EXISTS dbx6590_test")
        .await
        .expect("create Doris test database");
    Queryable::query_drop(
        &mut conn,
        "CREATE TABLE IF NOT EXISTS dbx6590_test.dbx_comment_test (\
             id BIGINT COMMENT '主键ID', \
             user_name VARCHAR(64) COMMENT '用户名称', \
             created_at DATETIME COMMENT '创建时间', \
             extra_field INT \
         ) DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 3 \
         PROPERTIES ('replication_num' = '1')",
    )
    .await
    .expect("create Doris test table");
    drop(conn);

    // The frontend sends the query-tab/execution database in `database` (empty
    // when the connection has no default database) and the database qualified
    // in the SQL in `schema`. The column lookup must resolve the effective
    // database from `schema` for MySQL-family dialects.
    let columns = get_columns_core(&state, "doris-6590-live", "", "dbx6590_test", "dbx_comment_test")
        .await
        .expect("qualified `db.table` metadata must resolve even with an empty execution database");
    assert_eq!(columns.len(), 4);
    assert_eq!(columns[0].name, "id");
    assert_eq!(columns[0].comment.as_deref(), Some("主键ID"));
    assert_eq!(columns[1].name, "user_name");
    assert_eq!(columns[1].comment.as_deref(), Some("用户名称"));
    assert_eq!(columns[2].name, "created_at");
    assert_eq!(columns[2].comment.as_deref(), Some("创建时间"));
    // Uncommented columns stay None — the grid must not render a placeholder.
    assert_eq!(columns[3].name, "extra_field");
    assert_eq!(columns[3].comment, None);
}
