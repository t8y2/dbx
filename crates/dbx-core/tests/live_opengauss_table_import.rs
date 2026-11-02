#![recursion_limit = "256"]
//! Live openGauss verification of the table-data import pipeline.
//!
//! This drives the exact backend entry point the desktop import wizard uses
//! (`dbx_core::table_import::import_table_file_core`) against a real openGauss
//! server, so enabling `tableImport` in the openGauss capability manifest can be
//! backed by an end-to-end run rather than a flag-only change.
//!
//! Requires an openGauss account that may create/drop tables in `public`:
//!
//! ```text
//! RUST_MIN_STACK=33554432 \
//! DBX_LIVE_OPENGAUSS_HOST=... DBX_LIVE_OPENGAUSS_PORT=... \
//! DBX_LIVE_OPENGAUSS_USER=... DBX_LIVE_OPENGAUSS_PASSWORD=... \
//! DBX_LIVE_OPENGAUSS_DATABASE=... \
//! cargo test -p dbx-core --no-default-features --features sqlite-bundled \
//!   --test live_opengauss_table_import -- --ignored --nocapture
//! ```
//!
//! `RUST_MIN_STACK` is needed because the import future is large enough to
//! overflow the default 2 MiB test-thread stack in debug builds.
//!
//! The tables created here are prefixed with `dbx_import_it_` and dropped again
//! on a best-effort basis.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::table_import::{
    import_table_file_core, preview_table_import_file_with_request, TableImportColumnMapping, TableImportMode,
    TableImportParseOptions, TableImportPreviewRequest, TableImportProgress, TableImportRequest,
    TableImportSourceFormat, TableImportSummary,
};

const SCHEMA: &str = "public";

fn required_env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set for live openGauss tests"))
}

fn live_connection_config(id: &str, database: &str) -> ConnectionConfig {
    ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::OpenGauss,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: required_env("DBX_LIVE_OPENGAUSS_HOST"),
        port: required_env("DBX_LIVE_OPENGAUSS_PORT").parse().expect("DBX_LIVE_OPENGAUSS_PORT must be a u16"),
        username: required_env("DBX_LIVE_OPENGAUSS_USER"),
        password: required_env("DBX_LIVE_OPENGAUSS_PASSWORD"),
        database: Some(database.to_string()),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        show_system_schemas: false,
        sidebar_auto_load_all_tables: false,
        show_database_links: None,
        show_native_jobs: None,
        show_user_admin: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        docs_notes_path: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 10,
        query_timeout_secs: 60,
        idle_timeout_secs: 60,
        manual_transaction_timeout_secs: 300,
        idle_disconnect_secs: 0,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
        oracle_oci_nls_lang: None,
        oracle_oci_tns_admin: None,
        connection_string: None,
        redis_connection_mode: None,
        redis_sentinel_master: String::new(),
        redis_sentinel_nodes: String::new(),
        redis_sentinel_username: String::new(),
        redis_sentinel_password: String::new(),
        redis_sentinel_tls: false,
        redis_cluster_nodes: String::new(),
        redis_key_separator: dbx_core::models::connection::default_redis_key_separator(),
        redis_scan_page_size: None,
        redis_database_aliases: Default::default(),
        redis_key_templates: Vec::new(),
        redis_key_filter: None,
        redis_key_grouping: None,
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        plugin_id: None,
        plugin_connection_provider: None,
        plugin_connection_type: None,
        connection_secrets: Default::default(),
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        production_badge_scope: None,
        database_info: None,
    }
}

fn never_cancelled<'a>(_: &'a str) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
    Box::pin(async { false })
}

fn database_name() -> String {
    required_env("DBX_LIVE_OPENGAUSS_DATABASE")
}

async fn live_state() -> (Arc<AppState>, tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("create temp storage directory");
    let storage =
        dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    let connection_id = "live-opengauss-import".to_string();
    let database = database_name();
    state.configs.write().await.insert(connection_id.clone(), live_connection_config(&connection_id, &database));
    state.get_or_create_pool(&connection_id, Some(&database)).await.expect("connect to the live openGauss server");
    (state, dir, connection_id)
}

async fn run_sql(state: &AppState, connection_id: &str, database: &str, sql: &str) -> dbx_core::types::QueryResult {
    execute_sql_statement(state, connection_id, database, sql, Some(SCHEMA), None)
        .await
        .unwrap_or_else(|error| panic!("SQL failed: {error}\nSQL: {sql}"))
}

fn csv_mappings(columns: &[String]) -> Vec<TableImportColumnMapping> {
    columns
        .iter()
        .map(|column| TableImportColumnMapping {
            source_column: column.clone(),
            target_column: column.clone(),
            target_data_type: None,
            generator: None,
        })
        .collect()
}

fn base_request(connection_id: &str, database: &str, file_path: &str, table: &str) -> TableImportRequest {
    TableImportRequest {
        import_id: format!("live-import-{}", uuid::Uuid::new_v4()),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: SCHEMA.to_string(),
        table: table.to_string(),
        file_path: file_path.to_string(),
        source_ref: None,
        source_format: Some(TableImportSourceFormat::Csv),
        parse_options: TableImportParseOptions { has_header: Some(true), ..Default::default() },
        mappings: Vec::new(),
        mode: TableImportMode::Append,
        create_table: false,
        batch_size: 2,
        date_time_format: None,
        prepared_source: None,
        retain_source: false,
        conflict_policy: None,
        skip_duplicate_rows: false,
        continue_on_error: false,
    }
}

async fn import(state: &AppState, request: TableImportRequest) -> TableImportSummary {
    let mut phases = Vec::new();
    let result = import_table_file_core(
        state,
        &request,
        &DatabaseType::OpenGauss,
        &state.get_or_create_pool(&request.connection_id, Some(&request.database)).await.expect("pool"),
        never_cancelled,
        |progress: TableImportProgress| phases.push(progress.phase),
    )
    .await;
    match result {
        Ok(summary) => summary,
        Err(error) => panic!("table import failed: {error}\nphases={phases:?}"),
    }
}

fn cell<'a>(result: &'a dbx_core::types::QueryResult, row: usize, column: &str) -> &'a serde_json::Value {
    let index = result
        .columns
        .iter()
        .position(|name| name.eq_ignore_ascii_case(column))
        .unwrap_or_else(|| panic!("column {column} missing from {:?}", result.columns));
    &result.rows[row][index]
}

fn text_cell(result: &dbx_core::types::QueryResult, row: usize, column: &str) -> String {
    match cell(result, row, column) {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(value) => value.clone(),
        other => other.to_string(),
    }
}

fn truthy_cell(result: &dbx_core::types::QueryResult, row: usize, column: &str) -> bool {
    match cell(result, row, column) {
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::String(value) => value.eq_ignore_ascii_case("true") || value == "t",
        _ => false,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_OPENGAUSS_* pointing at an openGauss account"]
async fn live_opengauss_reports_server_version() {
    let (state, _dir, connection_id) = live_state().await;
    let database = database_name();
    let result = run_sql(&state, &connection_id, &database, "SELECT version()").await;
    let version = text_cell(&result, 0, "version");
    assert!(version.to_lowercase().contains("opengauss"), "expected an openGauss server, got: {version}");
    eprintln!("live openGauss version: {version}");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_OPENGAUSS_* pointing at an openGauss account"]
async fn live_opengauss_csv_import_appends_rows_into_an_existing_table() {
    let (state, dir, connection_id) = live_state().await;
    let database = database_name();
    let table = format!("dbx_import_it_{}", uuid::Uuid::new_v4().simple());
    run_sql(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS \"{SCHEMA}\".\"{table}\"")).await;
    run_sql(
        &state,
        &connection_id,
        &database,
        &format!(
            "CREATE TABLE \"{SCHEMA}\".\"{table}\" (\
             id BIGINT PRIMARY KEY, name TEXT, amount DOUBLE PRECISION, active BOOLEAN, \
             created_at TIMESTAMP, note TEXT)"
        ),
    )
    .await;

    let csv_path = dir.path().join("append.csv");
    std::fs::write(
        &csv_path,
        concat!(
            "id,name,amount,active,created_at,note\n",
            "1,Ada,12.50,true,2026-01-02 03:04:05,hello\n",
            "2,张三,0,false,2026-02-03 04:05:06,\"a,b\"\n",
            "3,,,false,,\n",
            "4,O'Brien,99.99,true,2026-03-04 05:06:07,\"quote \"\"x\"\"\"\n",
        ),
    )
    .expect("write CSV fixture");

    let preview = preview_table_import_file_with_request(TableImportPreviewRequest {
        file_path: csv_path.display().to_string(),
        connection_id: Some(connection_id.clone()),
        database: Some(database.clone()),
        source_ref: None,
        source_format: Some(TableImportSourceFormat::Csv),
        parse_options: TableImportParseOptions { has_header: Some(true), ..Default::default() },
        preview_limit: Some(10),
    })
    .await
    .expect("preview the CSV file");
    assert_eq!(preview.columns, vec!["id", "name", "amount", "active", "created_at", "note"]);
    assert_eq!(preview.total_rows, 4, "preview row count");
    assert_eq!(preview.rows.len(), 4);
    assert_eq!(preview.rows[1][1], serde_json::json!("张三"));
    assert_eq!(preview.rows[1][5], serde_json::json!("a,b"));

    let mut request = base_request(&connection_id, &database, &csv_path.display().to_string(), &table);
    request.mappings = csv_mappings(&preview.columns);
    let summary = import(&state, request).await;
    assert_eq!(summary.rows_imported, 4, "all CSV rows should be written");

    let result = run_sql(
        &state,
        &connection_id,
        &database,
        &format!("SELECT id, name, amount, active, created_at, note FROM \"{SCHEMA}\".\"{table}\" ORDER BY id"),
    )
    .await;
    assert_eq!(result.rows.len(), 4, "row count after import");
    assert_eq!(text_cell(&result, 0, "name"), "Ada");
    assert_eq!(text_cell(&result, 0, "note"), "hello");
    assert_eq!(text_cell(&result, 1, "name"), "张三");
    assert_eq!(text_cell(&result, 1, "note"), "a,b");
    // The empty CSV cells are imported as NULL, not as empty strings.
    assert!(matches!(cell(&result, 2, "name"), serde_json::Value::Null), "empty name should be NULL");
    assert!(matches!(cell(&result, 2, "amount"), serde_json::Value::Null), "empty amount should be NULL");
    assert!(matches!(cell(&result, 2, "created_at"), serde_json::Value::Null), "empty timestamp should be NULL");
    assert_eq!(text_cell(&result, 3, "name"), "O'Brien");
    assert_eq!(text_cell(&result, 3, "note"), "quote \"x\"");
    assert!(truthy_cell(&result, 3, "active"), "boolean true should survive the import");
    let amount = text_cell(&result, 0, "amount");
    assert!(amount.parse::<f64>().is_ok_and(|value| (value - 12.5).abs() < f64::EPSILON), "amount={amount}");

    // Truncate mode is the other mode the wizard exposes: a second import must
    // replace the rows instead of appending to them.
    let truncate_path = dir.path().join("truncate.csv");
    std::fs::write(&truncate_path, "id,name,amount,active,created_at,note\n9,Grace,1.5,false,2026-04-05 06:07:08,\n")
        .expect("write truncate CSV fixture");
    let truncate_columns = ["id", "name", "amount", "active", "created_at", "note"].map(str::to_string);
    let mut truncate_request = base_request(&connection_id, &database, &truncate_path.display().to_string(), &table);
    truncate_request.mappings = csv_mappings(&truncate_columns);
    truncate_request.mode = TableImportMode::Truncate;
    let truncate_summary = import(&state, truncate_request).await;
    assert_eq!(truncate_summary.rows_imported, 1);
    let result = run_sql(&state, &connection_id, &database, &format!("SELECT id FROM \"{SCHEMA}\".\"{table}\"")).await;
    assert_eq!(result.rows.len(), 1, "truncate mode must replace the previous rows");

    let _ = run_sql(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS \"{SCHEMA}\".\"{table}\"")).await;
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_OPENGAUSS_* pointing at an openGauss account"]
async fn live_opengauss_csv_import_creates_the_target_table() {
    let (state, dir, connection_id) = live_state().await;
    let database = database_name();
    let table = format!("dbx_import_it_new_{}", uuid::Uuid::new_v4().simple());
    run_sql(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS \"{SCHEMA}\".\"{table}\"")).await;

    let csv_path = dir.path().join("create.csv");
    std::fs::write(
        &csv_path,
        concat!(
            "id,name,amount,active,created_at\n",
            "1,created-by-import,10.25,true,2026-05-06 07:08:09\n",
            "2,second,0,false,2026-06-07 08:09:10\n",
        ),
    )
    .expect("write create-table CSV fixture");

    let columns = ["id", "name", "amount", "active", "created_at"].map(str::to_string).to_vec();
    let mut request = base_request(&connection_id, &database, &csv_path.display().to_string(), &table);
    request.create_table = true;
    request.table = table.clone();
    request.mappings = csv_mappings(&columns);
    let summary = import(&state, request).await;
    assert_eq!(summary.rows_imported, 2);

    let result = run_sql(
        &state,
        &connection_id,
        &database,
        &format!("SELECT id, name, amount, active FROM \"{SCHEMA}\".\"{table}\" ORDER BY id"),
    )
    .await;
    assert_eq!(result.rows.len(), 2, "rows imported into the created table");
    assert_eq!(text_cell(&result, 0, "name"), "created-by-import");

    let _ = run_sql(&state, &connection_id, &database, &format!("DROP TABLE IF EXISTS \"{SCHEMA}\".\"{table}\"")).await;
}
