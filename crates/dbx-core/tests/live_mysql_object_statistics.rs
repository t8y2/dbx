//! Live regression coverage for the MySQL object-browser row counts: MySQL 8
//! caches `information_schema.TABLES` statistics per session for
//! `information_schema_stats_expiry` seconds (86400 by default), so a table
//! that was read while still empty kept reporting `TABLE_ROWS = 0` long after
//! rows were inserted, and the sidebar/对象浏览器 showed the stale count
//! (#9736). The statistics path must clear that cache before reading.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;

fn live_mysql_config(connection_id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MYSQL_HOST").expect("DBX_LIVE_MYSQL_HOST");
    let port: u16 =
        std::env::var("DBX_LIVE_MYSQL_PORT").expect("DBX_LIVE_MYSQL_PORT").parse().expect("valid DBX_LIVE_MYSQL_PORT");
    let username = std::env::var("DBX_LIVE_MYSQL_USER").expect("DBX_LIVE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_MYSQL_PASSWORD").expect("DBX_LIVE_MYSQL_PASSWORD");

    serde_json::from_value::<ConnectionConfig>(serde_json::json!({
        "id": connection_id,
        "name": connection_id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "connect_timeout_secs": 15,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL config should deserialize")
}

async fn estimated_rows_for(state: &AppState, connection_id: &str, database: &str, table: &str) -> Option<i64> {
    let statistics = dbx_core::schema::list_object_statistics_core(state, connection_id, database, "")
        .await
        .expect("object statistics for a live MySQL schema");
    statistics.iter().find(|entry| entry.name == table).and_then(|entry| entry.estimated_rows)
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable MySQL 8 server"]
async fn live_mysql_object_statistics_refresh_after_writes() {
    let database = std::env::var("DBX_LIVE_MYSQL_DATABASE").expect("DBX_LIVE_MYSQL_DATABASE");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-object-statistics-{suffix}");
    let table = format!("dbx_stats_fresh_{}", &suffix[..12]);
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-object-statistics-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id, &database));

    execute_sql_statement(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS `{table}`"), None, None)
        .await
        .expect("clean the live statistics fixture table");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("CREATE TABLE `{table}` (id INT PRIMARY KEY AUTO_INCREMENT, label VARCHAR(32) NOT NULL)"),
        None,
        None,
    )
    .await
    .expect("create the live statistics fixture table");

    // The desktop app reads the table list statistics right after opening a
    // database, which is what fills MySQL's session-scoped statistics cache.
    assert_eq!(
        estimated_rows_for(&state, &connection_id, &database, &table).await,
        Some(0),
        "an empty table reports zero rows before the writes"
    );

    let values = (1..=7).map(|id| format!("({id}, 'row-{id}')")).collect::<Vec<_>>().join(", ");
    execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("INSERT INTO `{table}` (id, label) VALUES {values}"),
        None,
        None,
    )
    .await
    .expect("insert the live statistics rows");

    let refreshed = estimated_rows_for(&state, &connection_id, &database, &table).await;
    let cleanup = execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &format!("DROP TABLE IF EXISTS `{table}`"),
        None,
        None,
    )
    .await;

    assert_eq!(refreshed, Some(7), "the cached row count must be refreshed after the inserts");
    cleanup.expect("drop the live statistics fixture table");
}
