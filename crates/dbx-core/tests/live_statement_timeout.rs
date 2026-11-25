//! Live verification that statement timeouts are scoped, not global.
//!
//! Requires a MySQL 8.x instance with a scratch database:
//!
//! ```text
//! export DBX_LIVE_TIMEOUT_MYSQL_HOST=127.0.0.1
//! export DBX_LIVE_TIMEOUT_MYSQL_PORT=3306
//! export DBX_LIVE_TIMEOUT_MYSQL_USER=root
//! export DBX_LIVE_TIMEOUT_MYSQL_PASSWORD=secret
//! export DBX_LIVE_TIMEOUT_MYSQL_DATABASE=dbx_timeout_test
//! cargo test -p dbx-core --test live_statement_timeout -- --ignored --nocapture
//! ```
//!
//! The read budget is deliberately set to one second and the statements sleep
//! for longer, so a timeout that fires means the statement was cancelled.

use std::time::Duration;

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_sql_statement_with_options_typed, QueryExecutionOptions};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"))
}

fn live_config(id: &str, read_timeout_secs: u64, write_timeout_secs: u64) -> ConnectionConfig {
    let port =
        std::env::var("DBX_LIVE_TIMEOUT_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": env("DBX_LIVE_TIMEOUT_MYSQL_HOST"),
        "port": port,
        "username": env("DBX_LIVE_TIMEOUT_MYSQL_USER"),
        "password": std::env::var("DBX_LIVE_TIMEOUT_MYSQL_PASSWORD").unwrap_or_default(),
        "database": env("DBX_LIVE_TIMEOUT_MYSQL_DATABASE"),
        "connect_timeout_secs": 10,
        "query_timeout_secs": read_timeout_secs,
        "write_timeout_secs": write_timeout_secs,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL config should deserialize")
}

async fn app_state_with(config: ConnectionConfig) -> AppState {
    let db_path = std::env::temp_dir().join(format!("dbx-live-timeout-{}.db", uuid::Uuid::new_v4().simple()));
    let storage = dbx_core::persistence::test_storage::open(&db_path).await.expect("open temp storage");
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);
    state
}

async fn run(
    state: &AppState,
    connection_id: &str,
    database: &str,
    sql: &str,
) -> Result<dbx_core::db::QueryResult, String> {
    execute_sql_statement_with_options_typed(
        state,
        connection_id,
        database,
        sql,
        None,
        None,
        QueryExecutionOptions::default(),
    )
    .await
    .map_err(|error| error.to_string())
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_TIMEOUT_MYSQL_* env vars pointing at a scratch MySQL database"]
async fn reads_are_cancelled_but_writes_and_ddl_are_not() {
    let database = env("DBX_LIVE_TIMEOUT_MYSQL_DATABASE");
    let state = app_state_with(live_config("timeout-live", 1, 0)).await;

    run(&state, "timeout-live", &database, "DROP TABLE IF EXISTS dbx_timeout_probe").await.expect("drop probe table");
    run(&state, "timeout-live", &database, "DROP TABLE IF EXISTS dbx_timeout_probe_copy")
        .await
        .expect("drop probe copy");
    run(
        &state,
        "timeout-live",
        &database,
        "CREATE TABLE dbx_timeout_probe (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(20))",
    )
    .await
    .expect("create probe table");

    // 1. A read must still be cancelled by the one second budget.
    let read_error = run(&state, "timeout-live", &database, "SELECT SLEEP(3)").await.expect_err("read should time out");
    assert!(read_error.contains("timed out"), "unexpected read error: {read_error}");

    // 2. A write must run to completion under the same budget.
    let insert = run(&state, "timeout-live", &database, "INSERT INTO dbx_timeout_probe (note) VALUES (SLEEP(2))")
        .await
        .expect("write must not be cancelled by the read budget");
    assert_eq!(insert.affected_rows, 1);

    // 3. A schema change must run to completion even though the script itself sleeps.
    run(&state, "timeout-live", &database, "CREATE TABLE dbx_timeout_probe_copy AS SELECT SLEEP(2) AS v")
        .await
        .expect("schema change must not be cancelled by the read budget");

    let count =
        run(&state, "timeout-live", &database, "SELECT COUNT(*) FROM dbx_timeout_probe").await.expect("count rows");
    assert_eq!(
        count.rows.first().and_then(|row| row.first()).and_then(|cell| cell.as_str()).map(str::to_owned),
        Some("1".to_string())
    );

    run(&state, "timeout-live", &database, "DROP TABLE IF EXISTS dbx_timeout_probe_copy").await.expect("drop copy");
    run(&state, "timeout-live", &database, "DROP TABLE IF EXISTS dbx_timeout_probe").await.expect("drop probe");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_TIMEOUT_MYSQL_* env vars pointing at a scratch MySQL database"]
async fn an_explicit_write_limit_stops_waiting_without_cancelling() {
    let database = env("DBX_LIVE_TIMEOUT_MYSQL_DATABASE");
    let state = app_state_with(live_config("timeout-live-write", 30, 1)).await;

    run(&state, "timeout-live-write", &database, "DROP TABLE IF EXISTS dbx_timeout_detach").await.expect("drop table");
    run(
        &state,
        "timeout-live-write",
        &database,
        "CREATE TABLE dbx_timeout_detach (id INT AUTO_INCREMENT PRIMARY KEY, note VARCHAR(20))",
    )
    .await
    .expect("create table");

    // The core budget is unlimited for writes, so this call itself does not
    // return a timeout: detachment happens in the entry points that own the
    // client wait (Tauri/web/CLI). What matters here is that no cancel is sent.
    let started = std::time::Instant::now();
    let insert =
        run(&state, "timeout-live-write", &database, "INSERT INTO dbx_timeout_detach (note) VALUES (SLEEP(3))")
            .await
            .expect("write must complete even past write_timeout_secs");
    assert_eq!(insert.affected_rows, 1);
    assert!(started.elapsed() >= Duration::from_secs(3));

    let count =
        run(&state, "timeout-live-write", &database, "SELECT COUNT(*) FROM dbx_timeout_detach").await.expect("count");
    assert_eq!(
        count.rows.first().and_then(|row| row.first()).and_then(|cell| cell.as_str()).map(str::to_owned),
        Some("1".to_string())
    );

    run(&state, "timeout-live-write", &database, "DROP TABLE IF EXISTS dbx_timeout_detach").await.expect("drop table");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_TIMEOUT_MYSQL_* env vars pointing at a scratch MySQL database"]
async fn transactional_batch_commits_slow_writes_past_the_read_budget() {
    let database = env("DBX_LIVE_TIMEOUT_MYSQL_DATABASE");
    let state = app_state_with(live_config("batch-timeout", 1, 1)).await;
    let table = format!("dbx_timeout_{}", uuid::Uuid::new_v4().simple());
    run(&state, "batch-timeout", &database, &format!("CREATE TABLE {table} (n INT)")).await.unwrap();
    let sql = format!("INSERT INTO {table} VALUES (SLEEP(2)); INSERT INTO {table} VALUES (1);");
    let result = dbx_core::query::execute_multi_core_with_options_for_client(
        &state,
        "batch-timeout",
        &database,
        &sql,
        None,
        None,
        QueryExecutionOptions { use_transaction: Some(true), timeout_secs: Some(1), ..Default::default() },
    )
    .await;
    let count = run(&state, "batch-timeout", &database, &format!("SELECT COUNT(*) FROM {table}")).await.unwrap();
    run(&state, "batch-timeout", &database, &format!("DROP TABLE {table}")).await.unwrap();
    let results = result.unwrap();
    assert_eq!(results.len(), 1);
    assert!(!results[0].execution_error);
    assert_eq!(count.rows, vec![vec![serde_json::json!("2")]]);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_TIMEOUT_H2_JAR and DBX_LIVE_TIMEOUT_JAVA"]
async fn jdbc_write_keeps_running_past_the_read_budget() {
    let dir = tempfile::tempdir().unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.path().join("dbx.db")).await.unwrap();
    let state = AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        "0.6.72",
    );
    dbx_core::agent_service::import_agent_jar(
        &state.agent_manager,
        "h2",
        std::path::Path::new(&env("DBX_LIVE_TIMEOUT_H2_JAR")),
    )
    .await
    .unwrap();
    state
        .agent_manager
        .mutate_state(|manager| {
            manager.java_runtime = dbx_core::agent_manager::JavaRuntimeConfig {
                mode: dbx_core::agent_manager::JavaRuntimeMode::Custom,
                custom_java_path: Some(env("DBX_LIVE_TIMEOUT_JAVA")),
            };
        })
        .unwrap();
    let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
        "id": "timeout-h2", "name": "timeout-h2", "db_type": "h2",
        "host": "localhost", "port": 9092, "username": "sa", "password": "",
        "connection_string": "jdbc:h2:mem:dbx_timeout;DB_CLOSE_DELAY=-1",
        "connect_timeout_secs": 10, "query_timeout_secs": 1, "write_timeout_secs": 1,
        "keepalive_interval_secs": 0,
    }))
    .unwrap();
    state.configs.write().await.insert(config.id.clone(), config.clone());
    for sql in ["CREATE TABLE timeout_probe (n INT)", "CREATE ALIAS DBX_SLEEP FOR 'java.lang.Thread.sleep(long)'"] {
        run(&state, &config.id, "", sql).await.unwrap();
    }
    let started = std::time::Instant::now();
    let result = execute_sql_statement_with_options_typed(
        &state,
        &config.id,
        "",
        "INSERT INTO timeout_probe SELECT 1 WHERE DBX_SLEEP(2000) IS NULL",
        None,
        None,
        QueryExecutionOptions { timeout_secs: Some(1), ..Default::default() },
    )
    .await
    .unwrap();
    assert_eq!(result.affected_rows, 1);
    assert!(started.elapsed() >= Duration::from_secs(2));
    let count = run(&state, &config.id, "", "SELECT COUNT(*) FROM timeout_probe").await.unwrap();
    assert_eq!(count.rows[0][0].as_i64(), Some(1));
}
