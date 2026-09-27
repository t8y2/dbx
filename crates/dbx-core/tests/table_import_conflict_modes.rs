//! 表导入 upsert / skip-existing 模式的端到端回归：真实 CSV 文件 + 真实 SQLite 库，
//! 走完整的 import_table_file_core 管线（主键解析 → 流式解析 → 冲突 SQL → 执行）。

use std::sync::Arc;

use dbx_core::connection::{AppState, PoolKind};
use dbx_core::db::sqlite;
use dbx_core::models::connection::DatabaseType;
use dbx_core::table_import::{
    import_table_file_core, TableImportColumnMapping, TableImportMode, TableImportParseOptions, TableImportRequest,
    TableImportSourceFormat, TableImportStatus,
};

async fn app_state_with_sqlite(test_name: &str, target_path: &str) -> Arc<AppState> {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-{test_name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    let sqlite = sqlite::connect_path_create_if_missing(target_path).await.unwrap();
    let pool_key = format!("{test_name}:session:import");
    state
        .update_connection_pools(|connections| {
            connections.insert(pool_key, PoolKind::Sqlite(sqlite.clone()));
        })
        .await;
    state
}

fn write_csv(path: &std::path::Path, contents: &str) {
    std::fs::write(path, contents).unwrap();
}

fn never_cancelled(_: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + '_>> {
    Box::pin(async { false })
}

fn import_request(import_id: &str, csv_path: &std::path::Path, mode: TableImportMode) -> TableImportRequest {
    TableImportRequest {
        import_id: import_id.to_string(),
        connection_id: "unused-for-sqlite-pool".to_string(),
        database: String::new(),
        schema: String::new(),
        table: "items".to_string(),
        file_path: csv_path.to_string_lossy().to_string(),
        source_ref: None,
        source_format: Some(TableImportSourceFormat::Csv),
        parse_options: TableImportParseOptions::default(),
        mappings: vec![
            TableImportColumnMapping {
                source_column: "id".to_string(),
                target_column: "id".to_string(),
                target_data_type: None,
            },
            TableImportColumnMapping {
                source_column: "name".to_string(),
                target_column: "name".to_string(),
                target_data_type: None,
            },
        ],
        mode,
        create_table: false,
        batch_size: 500,
        date_time_format: None,
        prepared_source: None,
        retain_source: false,
        skip_duplicate_rows: false,
    }
}

async fn stored_items(sqlite: &sqlite::SqliteHandle) -> Vec<(i64, String)> {
    sqlite::execute_query(sqlite, "SELECT id, name FROM items ORDER BY id")
        .await
        .unwrap()
        .rows
        .into_iter()
        .map(|row| (row[0].as_i64().unwrap(), row[1].as_str().unwrap().to_string()))
        .collect()
}

#[tokio::test]
async fn upsert_mode_updates_conflicting_rows_through_the_full_pipeline() {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-upsert-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target_path = dir.join("target.db").to_string_lossy().to_string();
    let state = app_state_with_sqlite("upsert", &target_path).await;
    let sqlite = sqlite::connect_path_create_if_missing(&target_path).await.unwrap();
    sqlite::execute_query(&sqlite, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
    sqlite::execute_query(&sqlite, "INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b')").await.unwrap();

    let csv = dir.join("upsert.csv");
    write_csv(&csv, "id,name\n2,B2\n3,c\n");

    let request = import_request("upsert-e2e", &csv, TableImportMode::Upsert);
    let summary = import_table_file_core(
        &state,
        &request,
        &DatabaseType::Sqlite,
        "upsert:session:import",
        &never_cancelled,
        |_progress| {},
    )
    .await
    .expect("upsert import should succeed");

    assert_eq!(summary.rows_imported, 2);
    assert_eq!(stored_items(&sqlite).await, vec![(1, "a".to_string()), (2, "B2".to_string()), (3, "c".to_string())]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn skip_existing_mode_preserves_conflicting_rows_through_the_full_pipeline() {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-skip-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target_path = dir.join("target.db").to_string_lossy().to_string();
    let state = app_state_with_sqlite("skip", &target_path).await;
    let sqlite = sqlite::connect_path_create_if_missing(&target_path).await.unwrap();
    sqlite::execute_query(&sqlite, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();
    sqlite::execute_query(&sqlite, "INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b')").await.unwrap();

    let csv = dir.join("skip.csv");
    write_csv(&csv, "id,name\n2,ignored\n3,c\n");

    let request = import_request("skip-e2e", &csv, TableImportMode::SkipExisting);
    let summary = import_table_file_core(
        &state,
        &request,
        &DatabaseType::Sqlite,
        "skip:session:import",
        &never_cancelled,
        |_progress| {},
    )
    .await
    .expect("skip-existing import should succeed");

    // SQLite imports run inside the append commit window, which reports
    // submitted rows rather than the driver's affected count.
    assert_eq!(summary.rows_imported, 2);
    assert_eq!(stored_items(&sqlite).await, vec![(1, "a".to_string()), (2, "b".to_string()), (3, "c".to_string())]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn upsert_mode_without_a_primary_key_fails_with_a_clear_error() {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-nopk-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target_path = dir.join("target.db").to_string_lossy().to_string();
    let state = app_state_with_sqlite("nopk", &target_path).await;
    let sqlite = sqlite::connect_path_create_if_missing(&target_path).await.unwrap();
    sqlite::execute_query(&sqlite, "CREATE TABLE items (id INTEGER, name TEXT)").await.unwrap();

    let csv = dir.join("nopk.csv");
    write_csv(&csv, "id,name\n1,a\n");

    let request = import_request("nopk-e2e", &csv, TableImportMode::Upsert);
    let error = import_table_file_core(
        &state,
        &request,
        &DatabaseType::Sqlite,
        "nopk:session:import",
        &never_cancelled,
        |_progress| {},
    )
    .await
    .expect_err("upsert into a table without a primary key must fail");

    assert!(error.contains("no primary key"), "error: {error}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn upsert_mode_requires_primary_key_columns_to_be_mapped() {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-unmapped-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target_path = dir.join("target.db").to_string_lossy().to_string();
    let state = app_state_with_sqlite("unmapped", &target_path).await;
    let sqlite = sqlite::connect_path_create_if_missing(&target_path).await.unwrap();
    sqlite::execute_query(&sqlite, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();

    let csv = dir.join("unmapped.csv");
    write_csv(&csv, "name\nonly-name\n");

    let mut request = import_request("unmapped-e2e", &csv, TableImportMode::Upsert);
    request.mappings = vec![TableImportColumnMapping {
        source_column: "name".to_string(),
        target_column: "name".to_string(),
        target_data_type: None,
    }];
    let error = import_table_file_core(
        &state,
        &request,
        &DatabaseType::Sqlite,
        "unmapped:session:import",
        &never_cancelled,
        |_progress| {},
    )
    .await
    .expect_err("upsert without mapped primary key columns must fail");

    assert!(error.contains("primary key columns to be mapped"), "error: {error}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn progress_events_report_done_status_for_conflict_modes() {
    let dir = std::env::temp_dir().join(format!("dbx-import-conflict-progress-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let target_path = dir.join("target.db").to_string_lossy().to_string();
    let state = app_state_with_sqlite("progress", &target_path).await;
    let sqlite = sqlite::connect_path_create_if_missing(&target_path).await.unwrap();
    sqlite::execute_query(&sqlite, "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)").await.unwrap();

    let csv = dir.join("progress.csv");
    write_csv(&csv, "id,name\n1,kept\n2,added\n");

    let request = import_request("progress-e2e", &csv, TableImportMode::SkipExisting);
    let statuses = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = statuses.clone();
    let summary = import_table_file_core(
        &state,
        &request,
        &DatabaseType::Sqlite,
        "progress:session:import",
        &never_cancelled,
        move |progress| {
            sink.lock().unwrap().push(progress.status);
        },
    )
    .await
    .expect("skip-existing import should succeed");

    // Submitted-row counting through the SQLite append commit window (see above).
    assert_eq!(summary.rows_imported, 2);
    assert_eq!(stored_items(&sqlite).await, vec![(1, "kept".to_string()), (2, "added".to_string())]);
    assert!(statuses.lock().unwrap().contains(&TableImportStatus::Done));
    let _ = std::fs::remove_dir_all(&dir);
}
