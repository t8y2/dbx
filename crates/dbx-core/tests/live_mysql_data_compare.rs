use dbx_core::connection::AppState;
use dbx_core::data_compare::{
    prepare_data_compare_from_tables, prepare_data_compare_missing_target, DataCompareFromTablesOptions,
    DataCompareMissingTargetOptions,
};
use dbx_core::db::mysql;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_MYSQL_TRANSFER_HOST").expect("DBX_LIVE_MYSQL_TRANSFER_HOST");
    let port =
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_MYSQL_TRANSFER_USER").unwrap_or_else(|_| "root".to_string());
    let password = std::env::var("DBX_LIVE_MYSQL_TRANSFER_PASSWORD").expect("DBX_LIVE_MYSQL_TRANSFER_PASSWORD");

    serde_json::from_value(json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": null,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 300,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live MySQL compare config should deserialize")
}

fn mysql_url(config: &ConnectionConfig) -> String {
    format!("mysql://{}:{}@{}:{}", config.username, config.password, config.host, config.port)
}

async fn live_state() -> Arc<AppState> {
    let task_tmp = std::path::PathBuf::from(
        std::env::var("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR").expect("DBX_LIVE_MYSQL_TRANSFER_TMP_DIR"),
    );
    let dir = task_tmp.join(format!("data-compare-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    Arc::new(AppState::new(storage))
}

fn big_source_table_ddl(database: &str, table: &str, rows: u64) -> String {
    format!(
        "CREATE DATABASE IF NOT EXISTS {database};\
         SET SESSION cte_max_recursion_depth={};  \
         CREATE TABLE {database}.{table} (\
           id INT NOT NULL PRIMARY KEY, payload VARCHAR(120), amount DECIMAL(12,2)\
         );\
         INSERT INTO {database}.{table} (id, payload, amount)\
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < {rows})\
         SELECT n, CONCAT('row-', n), n * 1.5 FROM seq",
        rows + 1
    )
}

/// A source-only table must not drag the whole table into memory (and across the IPC
/// boundary) when the user compares it against a database that has no such table.
#[test]
#[ignore = "requires a disposable MySQL endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
fn live_mysql_data_compare_missing_target_is_bounded() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_live_mysql_data_compare_missing_target_is_bounded());
}

async fn run_live_mysql_data_compare_missing_target_is_bounded() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("compare-conn-{}", &suffix[..12]);
    let source_database = format!("dbx_cmp_src_{}", &suffix[..12]);
    let target_database = format!("dbx_cmp_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    let rows: u64 = 300_000;
    mysql::execute_query(&setup_pool, &big_source_table_ddl(&source_database, "big_source_only", rows), false)
        .await
        .unwrap();
    mysql::execute_query(&setup_pool, &format!("CREATE DATABASE {target_database}"), false).await.unwrap();

    let state = live_state().await;
    state.configs.write().await.insert(connection_id.clone(), config);

    let started = Instant::now();
    let preparation = prepare_data_compare_missing_target(
        &state,
        DataCompareMissingTargetOptions {
            source_connection_id: connection_id.clone(),
            source_database: source_database.clone(),
            source_schema: source_database.clone(),
            source_table: "big_source_only".to_string(),
            target_connection_id: connection_id.clone(),
            target_database: target_database.clone(),
            target_schema: target_database.clone(),
            target_table: "big_source_only".to_string(),
            key_columns: vec!["id".to_string()],
            fetch_batch_size: None,
            degradation_threshold: None,
        },
    )
    .await
    .unwrap();
    let elapsed = started.elapsed();

    println!(
        "missing-target compare: rows={} added={} truncated={} level={:?} sql_bytes={} elapsed={:?}",
        preparation.source_row_count,
        preparation.result.added.len(),
        preparation.source_truncated,
        preparation.degradation_level,
        preparation.sync_sql.len(),
        elapsed
    );

    assert_eq!(
        preparation.result.added.len(),
        100_000,
        "compare must stop at the full-compare row budget instead of materialising all {rows} rows"
    );
    assert!(preparation.source_truncated, "capped compare must flag source_truncated");
    assert!(preparation.result.added.len() < rows as usize, "the capped plan must be smaller than the table");
    assert!(elapsed < Duration::from_secs(30), "capped compare took {elapsed:?}");
}

/// The user-facing scenario: two databases on one connection, small tables, with real
/// differences in both directions.
#[test]
#[ignore = "requires a disposable MySQL endpoint via DBX_LIVE_MYSQL_TRANSFER_* variables"]
fn live_mysql_data_compare_two_databases_with_differences() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(run_live_mysql_data_compare_two_databases_with_differences());
}

async fn run_live_mysql_data_compare_two_databases_with_differences() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("compare-conn-{}", &suffix[..12]);
    let source_database = format!("dbx_cmp2_src_{}", &suffix[..12]);
    let target_database = format!("dbx_cmp2_dst_{}", &suffix[..12]);
    let config = live_mysql_config(&connection_id);
    let setup_pool = mysql::connect(&mysql_url(&config), Duration::from_secs(10)).await.unwrap();

    mysql::execute_query(
        &setup_pool,
        &format!(
            "CREATE DATABASE {source_database};\
             CREATE DATABASE {target_database};\
             CREATE TABLE {source_database}.items (id INT NOT NULL PRIMARY KEY, name VARCHAR(60), qty INT);\
             CREATE TABLE {target_database}.items (id INT NOT NULL PRIMARY KEY, name VARCHAR(60), qty INT);\
             SET SESSION cte_max_recursion_depth=4000;\
             INSERT INTO {source_database}.items (id, name, qty)\
               WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 2000)\
               SELECT n, CONCAT('name-', n), n FROM seq;\
             INSERT INTO {target_database}.items (id, name, qty)\
               WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1500)\
               SELECT n, CONCAT('name-', n * 2), n FROM seq"
        ),
        false,
    )
    .await
    .unwrap();

    let state = live_state().await;
    state.configs.write().await.insert(connection_id.clone(), config);

    let started = Instant::now();
    let preparation = prepare_data_compare_from_tables(
        &state,
        DataCompareFromTablesOptions {
            source_connection_id: connection_id.clone(),
            source_database: source_database.clone(),
            source_schema: source_database.clone(),
            source_table: "items".to_string(),
            target_connection_id: connection_id.clone(),
            target_database: target_database.clone(),
            target_schema: target_database.clone(),
            target_table: "items".to_string(),
            columns: vec!["id".to_string(), "name".to_string(), "qty".to_string()],
            key_columns: vec!["id".to_string()],
            source_columns: None,
            fetch_batch_size: None,
            degradation_threshold: None,
            sampling_strategy: None,
            enable_checksum: None,
        },
    )
    .await
    .unwrap();
    let elapsed = started.elapsed();

    println!(
        "two-database compare: source_rows={} target_rows={} added={} removed={} modified={} statements={} sql_bytes={} elapsed={:?}",
        preparation.source_row_count,
        preparation.target_row_count,
        preparation.result.added.len(),
        preparation.result.removed.len(),
        preparation.result.modified.len(),
        preparation.sync_statements.len(),
        preparation.sync_sql.len(),
        elapsed
    );

    assert_eq!(preparation.source_row_count, 2000);
    assert_eq!(preparation.target_row_count, 1500);
    assert_eq!(preparation.result.added.len(), 500, "rows 1501..2000 exist only on the source");
    assert_eq!(preparation.result.removed.len(), 0, "the target has no extra rows");
    assert!(!preparation.source_truncated && !preparation.target_truncated, "small compares are not truncated");
    assert_eq!(preparation.result.modified.len(), 1500, "every shared row changed its name");
    assert!(elapsed < Duration::from_secs(30), "compare took {elapsed:?}");
}
