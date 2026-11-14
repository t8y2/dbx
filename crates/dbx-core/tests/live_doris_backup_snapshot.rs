//! Live regression for Doris backup/export snapshots.
//!
//! Doris parses `BEGIN` with its own ANTLR grammar: `START TRANSACTION WITH
//! CONSISTENT SNAPSHOT, READ ONLY` and `START TRANSACTION READ ONLY` are
//! rejected with ER_UNKNOWN_ERROR 1105 (`mismatched input ',' ...`), and
//! `SET TRANSACTION READ ONLY` silently does nothing. Before this regression
//! test the database export aborted with
//! `导出失败: START TRANSACTION failed: Server error: 'ERROR 1105 (HY000): ...'`.
//!
//! Requires a live Doris reachable through `DBX_LIVE_DORIS_*` env vars:
//! `DBX_LIVE_DORIS_HOST`, `DBX_LIVE_DORIS_PORT` (default 9030),
//! `DBX_LIVE_DORIS_USER`, `DBX_LIVE_DORIS_PASSWORD`, `DBX_LIVE_DORIS_DATABASE`.

use dbx_core::connection::AppState;
use dbx_core::database_export::{begin_database_backup_snapshot_core, export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{
    begin_database_backup_snapshot, execute_in_manual_transaction, execute_sql_statement, rollback_manual_transaction,
};
use dbx_core::storage::Storage;
use std::sync::Arc;

fn live_doris_config() -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": format!("live-doris-{}", uuid::Uuid::new_v4().simple()),
        "name": "Doris backup snapshot regression",
        "db_type": DatabaseType::Mysql,
        "driver_profile": "doris",
        "host": std::env::var("DBX_LIVE_DORIS_HOST").expect("DBX_LIVE_DORIS_HOST"),
        "port": std::env::var("DBX_LIVE_DORIS_PORT")
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(9030),
        "username": std::env::var("DBX_LIVE_DORIS_USER").expect("DBX_LIVE_DORIS_USER"),
        "password": std::env::var("DBX_LIVE_DORIS_PASSWORD").expect("DBX_LIVE_DORIS_PASSWORD"),
        "database": std::env::var("DBX_LIVE_DORIS_DATABASE").expect("DBX_LIVE_DORIS_DATABASE"),
        // This Doris test server sits ~100ms away and needs several seconds to
        // open a fresh session, so the create stage needs more than a 10s budget.
        "connect_timeout_secs": 60,
        "query_timeout_secs": 120,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live Doris connection config")
}

async fn setup() -> (Arc<AppState>, std::path::PathBuf, ConnectionConfig, String) {
    let config = live_doris_config();
    let storage_path =
        std::env::temp_dir().join(format!("dbx-live-doris-snapshot-{}.db", uuid::Uuid::new_v4().simple()));
    let state = Arc::new(AppState::new(Storage::open(&storage_path).await.expect("temporary storage")));
    let database = config.database.clone().expect("database");
    let table_name = format!("dbx_doris_snapshot_{}", uuid::Uuid::new_v4().simple());
    state.configs.write().await.insert(config.id.clone(), config.clone());
    execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("CREATE TABLE {table_name} (id INT, label VARCHAR(16)) DUPLICATE KEY(id) DISTRIBUTED BY HASH(id) BUCKETS 1 PROPERTIES('replication_num' = '1')"),
        None,
        None,
    )
    .await
    .expect("create isolated Doris regression table");
    execute_sql_statement(
        &state,
        &config.id,
        &database,
        &format!("INSERT INTO {table_name} (id, label) VALUES (1, 'a'), (2, 'b')"),
        None,
        None,
    )
    .await
    .expect("seed Doris regression table");
    (state, storage_path, config, table_name)
}

async fn cleanup(state: &AppState, config: &ConnectionConfig, table_name: &str, storage_path: std::path::PathBuf) {
    let _ = execute_sql_statement(
        state,
        &config.id,
        config.database.as_deref().expect("database"),
        &format!("DROP TABLE IF EXISTS {table_name}"),
        None,
        None,
    )
    .await;
    let _ = std::fs::remove_file(storage_path);
}

/// DBX export/backup paths interleave async I/O with synchronous formatting and
/// buffered writes; `tokio::test`'s default worker stack overflows for them, so
/// run the export on a dedicated large-stack runtime worker.
fn blocking_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_stack_size(16 * 1024 * 1024)
        .enable_all()
        .build()
        .expect("dedicated export test runtime")
}

#[test]
#[ignore = "requires DBX_LIVE_DORIS_* env vars pointing at a live Doris"]
fn live_doris_backup_snapshot_opens_without_parser_error() {
    blocking_runtime().block_on(live_doris_backup_snapshot_opens_without_parser_error_inner());
}

async fn live_doris_backup_snapshot_opens_without_parser_error_inner() {
    let (state, storage_path, config, table_name) = setup().await;
    let database = config.database.clone().expect("database");

    let snapshot = begin_database_backup_snapshot(&state, &config.id, &database)
        .await
        .expect("Doris consistent snapshot must open without a START TRANSACTION parser error");

    let result = execute_in_manual_transaction(
        &state,
        &snapshot,
        &format!("SELECT COUNT(*) AS row_count FROM {table_name}"),
        &database,
        None,
        Some(30),
    )
    .await
    .expect("read through the Doris snapshot");
    assert_eq!(result[0].rows.len(), 1);

    rollback_manual_transaction(&state, &snapshot).await.expect("rollback Doris snapshot");
    cleanup(&state, &config, &table_name, storage_path).await;
}

#[test]
#[ignore = "requires DBX_LIVE_DORIS_* env vars pointing at a live Doris"]
fn live_doris_database_export_writes_all_rows() {
    blocking_runtime().block_on(live_doris_database_export_writes_all_rows_inner());
}

async fn live_doris_database_export_writes_all_rows_inner() {
    let (state, storage_path, config, table_name) = setup().await;
    let database = config.database.clone().expect("database");
    let export_path = std::env::temp_dir().join(format!("dbx-live-doris-export-{}.sql", uuid::Uuid::new_v4().simple()));

    let snapshot =
        begin_database_backup_snapshot_core(&state, &config.id, &database).await.expect("Doris export snapshot");
    let request = DatabaseExportRequest {
        export_id: format!("doris-export-{}", uuid::Uuid::new_v4().simple()),
        connection_id: config.id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: export_path.to_string_lossy().to_string(),
        selected_tables: vec![table_name.clone()],
        selected_objects: None,
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: false,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        omit_database_qualifier: false,
        preserve_original_language: false,
        fail_on_error: true,
        prevent_overwrite: true,
        output_compression: Default::default(),
        insert_dialect: Default::default(),
        insert_mode: Default::default(),
        snapshot_session_id: Some(snapshot.session_id.clone()),
        batch_size: 100,
        split_max_mb: None,
    };
    // Mirrors production: the Tauri command parks the export body on a
    // dedicated large-stack blocking thread (data/export_runtime.rs) because the
    // row formatter needs more stack than an async worker provides.
    let state_for_export = state.clone();
    tokio::task::spawn_blocking(move || {
        tokio::runtime::Handle::current().block_on(export_database_sql_core(
            &state_for_export,
            &request,
            |_progress| {},
        ))
    })
    .await
    .expect("export task join")
    .expect("Doris database export must not fail on START TRANSACTION");

    let sql = std::fs::read_to_string(&export_path).expect("read exported SQL");
    assert!(sql.contains(&table_name), "export must contain the table DDL");
    assert!(sql.contains("INSERT INTO"), "export must contain row data");

    rollback_manual_transaction(&state, &snapshot.session_id).await.expect("rollback Doris export snapshot");
    let _ = std::fs::remove_file(&export_path);
    cleanup(&state, &config, &table_name, storage_path).await;
}
