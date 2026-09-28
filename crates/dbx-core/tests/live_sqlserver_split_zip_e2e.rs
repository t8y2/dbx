// E2E test executed manually against a real local SQL Server 2025 container
// (`database-mssql-1`, database `default`) already loaded with a production-shaped
// dataset (50 tables / 52 foreign keys), as part of task #01a0db6e-2276.
//
// Flow: export database `default` (with `split_max_mb` set, i.e. the split-ZIP
// contract under review) -> verify manifest/parts -> re-import the resulting ZIP
// via `execute_sql_file_paths` with `skip_relational_constraints = true` ("Skip
// relationship") into a fresh scratch database, exactly like the desktop app does.
//
// Run manually with:
//   DBX_LIVE_SQLSERVER_PASSWORD='MSSQLStrongPassword123!' \
//   cargo test -p dbx-core --test live_sqlserver_split_zip_e2e -- --nocapture --test-threads=1

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportOutputCompression, DatabaseExportRequest};
use dbx_core::models::connection::DatabaseType;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_paths;
use std::sync::Arc;
use std::time::Instant;
use tokio_util::sync::CancellationToken;

fn live_sqlserver_config(id: &str, database: &str) -> dbx_core::models::connection::ConnectionConfig {
    dbx_core::models::connection::ConnectionConfig {
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::SqlServer,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        username: std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        password: std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        database: Some(database.to_string()),
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 10,
        query_timeout_secs: 30,
        idle_timeout_secs: 60,
        keepalive_interval_secs: 0,
        ssl: false,
        ca_cert_path: String::new(),
        client_cert_path: String::new(),
        client_key_path: String::new(),
        sysdba: false,
        oracle_connection_type: None,
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
        show_system_schemas: false,
        database_info: None,
        sidebar_auto_load_all_tables: false,
    }
}

async fn live_sqlserver_state(connection_id: &str, database: &str, suffix: &str) -> (AppState, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-splitzip-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create live test directory");
    let storage =
        dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.expect("open live test storage");
    let state = AppState::new(storage);
    let config = live_sqlserver_config(connection_id, database);
    state.configs.write().await.insert(connection_id.to_string(), config);
    (state, dir)
}

#[tokio::test]
#[ignore = "manual E2E against a real local SQL Server instance -- see file header"]
async fn manual_e2e_sqlserver_default_split_zip_export_then_import_skip_relationship() {
    let export_connection_id = "e2e-mssql-export";
    let import_connection_id = "e2e-mssql-import";
    let source_database = "default";
    // Import target is a separate scratch database, NOT the just-emptied
    // `default`, per the task's own guidance to isolate the destructive
    // re-import from the production-shaped database whenever possible.
    let import_database = "dbx_e2e_split_zip_restore";

    let (export_state, work_dir) = live_sqlserver_state(export_connection_id, source_database, "export").await;
    let export_state = Arc::new(export_state);

    let zip_path = work_dir.join("default-export.zip");
    let export_request = DatabaseExportRequest {
        export_id: format!("e2e-export-{}", uuid::Uuid::new_v4()),
        connection_id: export_connection_id.to_string(),
        database: source_database.to_string(),
        schema: String::new(),
        file_path: zip_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: false,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        prevent_overwrite: false,
        output_compression: DatabaseExportOutputCompression::None,
        snapshot_session_id: None,
        batch_size: 1000,
        split_max_mb: Some(1),
        insert_dialect: Default::default(),
    };

    let progress_log = std::sync::Mutex::new(Vec::new());
    let export_result = export_database_sql_core(&export_state, &export_request, |progress| {
        progress_log.lock().unwrap().push(format!("{progress:?}"));
    })
    .await;

    eprintln!("=== EXPORT PROGRESS LOG ===");
    for line in progress_log.lock().unwrap().iter() {
        eprintln!("{line}");
    }
    eprintln!("=== EXPORT RESULT ===\n{export_result:?}");
    export_result.expect("split-ZIP database export should succeed");

    assert!(zip_path.exists(), "expected export ZIP at {}", zip_path.display());
    let zip_metadata = std::fs::metadata(&zip_path).expect("stat export zip");
    eprintln!("Export ZIP size: {} bytes", zip_metadata.len());

    // --- Verify manifest.json + parts against the dbx-sql-export-parts-v1 contract ---
    let file = std::fs::File::open(&zip_path).expect("open export zip");
    let mut archive = zip::ZipArchive::new(file).expect("read export zip as a zip archive");
    let mut entry_names: Vec<String> =
        (0..archive.len()).map(|index| archive.by_index(index).expect("zip entry").name().to_string()).collect();
    entry_names.sort();
    eprintln!("=== ZIP ENTRIES ===\n{entry_names:#?}");
    assert!(entry_names.contains(&"manifest.json".to_string()), "manifest.json entry must be present");
    let sql_part_count = entry_names.iter().filter(|name| name.ends_with(".sql")).count();
    assert!(sql_part_count >= 1, "at least one .sql part expected");

    let manifest_bytes = {
        let mut entry = archive.by_name("manifest.json").expect("manifest.json entry");
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes).expect("read manifest.json");
        bytes
    };
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).expect("parse manifest.json");
    eprintln!("=== MANIFEST ===\n{}", serde_json::to_string_pretty(&manifest).unwrap());
    assert_eq!(manifest["format"], "dbx-sql-export-parts-v1", "manifest format must match the documented contract");
    let manifest_parts = manifest["parts"].as_array().expect("manifest.parts array").len();
    assert_eq!(manifest_parts, sql_part_count, "manifest part count must match actual .sql entries in the zip");

    // --- Prepare a clean scratch database on the same SQL Server instance for import ---
    let (import_state, _import_work_dir) =
        live_sqlserver_state(import_connection_id, "master", "import-bootstrap").await;
    let bootstrap_pool = import_state
        .get_or_create_pool(import_connection_id, Some("master"))
        .await
        .expect("connect to master to bootstrap scratch database");
    let drop_sql = format!(
        "IF DB_ID(N'{import_database}') IS NOT NULL BEGIN ALTER DATABASE [{import_database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{import_database}]; END"
    );
    dbx_core::query::execute_sql_statement(&import_state, import_connection_id, "master", &drop_sql, None, None)
        .await
        .expect("drop pre-existing scratch database if present");
    let create_sql = format!("CREATE DATABASE [{import_database}]");
    dbx_core::query::execute_sql_statement(&import_state, import_connection_id, "master", &create_sql, None, None)
        .await
        .expect("create scratch database for import");
    let _ = bootstrap_pool;

    // --- Extract the ZIP the same way the app does before feeding SQL files to the importer ---
    let extraction_dir = work_dir.join("extracted-parts");
    let package = dbx_core::sql_file_zip_package::extract_sql_file_zip_package(&zip_path, &extraction_dir)
        .expect("extract split-ZIP package using the shared sql_file_zip_package contract");
    let extracted_paths = dbx_core::sql_file_zip_package::extracted_sql_zip_paths(&extraction_dir, &package);
    eprintln!("=== EXTRACTED PART PATHS ===\n{extracted_paths:#?}");
    assert_eq!(extracted_paths.len(), sql_part_count, "extracted part count must match the zip's .sql entries");

    let (reimport_state, _reimport_work_dir) =
        live_sqlserver_state(import_connection_id, import_database, "import-exec").await;
    let import_request = SqlFileRequest {
        execution_id: format!("e2e-import-{}", uuid::Uuid::new_v4()),
        connection_id: import_connection_id.to_string(),
        database: import_database.to_string(),
        file_path: extracted_paths[0].to_string_lossy().to_string(),
        continue_on_error: false,
        txn_session_id: None,
        selected_tables: None,
        part_cooldown_ms: 0,
        // This is the "Skip relationship" option from the task: SQL Server
        // constraint bypass runs `ALTER TABLE ... NOCHECK CONSTRAINT ALL`
        // before the import and `WITH NOCHECK CHECK CONSTRAINT ALL` after.
        skip_relational_constraints: true,
    };

    let file_path_refs: Vec<&std::path::Path> = extracted_paths.iter().map(|path| path.as_path()).collect();
    let import_progress_log = std::sync::Mutex::new(Vec::new());
    let started_at = Instant::now();
    let import_result = execute_sql_file_paths(
        &reimport_state,
        &import_request,
        &file_path_refs,
        CancellationToken::new(),
        started_at,
        |progress| import_progress_log.lock().unwrap().push(format!("{progress:?}")),
    )
    .await;

    eprintln!("=== IMPORT PROGRESS LOG ===");
    for line in import_progress_log.lock().unwrap().iter() {
        eprintln!("{line}");
    }
    eprintln!("=== IMPORT RESULT ===\n{import_result:?}");

    // Intentionally do not assert success here: the whole point of this manual
    // E2E run is to surface whatever real error the split-ZIP + skip-relationship
    // path produces (or confirm it succeeds), and report it verbatim, per the
    // task's explicit instruction not to fabricate outcomes.
    match &import_result {
        Ok(()) => eprintln!("IMPORT SUCCEEDED"),
        Err(error) => eprintln!("IMPORT FAILED WITH ERROR: {error}"),
    }

    // --- Post-import verification: table/row counts on the scratch database ---
    let verify_sql = "SELECT COUNT(*) AS tbl_count FROM sys.tables WHERE is_ms_shipped = 0";
    match dbx_core::query::execute_sql_statement(
        &reimport_state,
        import_connection_id,
        import_database,
        verify_sql,
        None,
        None,
    )
    .await
    {
        Ok(result) => eprintln!("=== POST-IMPORT TABLE COUNT ===\n{result:?}"),
        Err(error) => eprintln!("=== POST-IMPORT VERIFY QUERY FAILED ===\n{error}"),
    }
}
