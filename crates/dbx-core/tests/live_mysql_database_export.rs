use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, record_export_destination_identity, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use dbx_core::storage::Storage;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn exported_view_position(sql: &str, view_name: &str) -> Option<usize> {
    regex::Regex::new(&format!(r"(?is)\bCREATE\b[^;]*\bVIEW\s+(?:`[^`]+`\.)?`{}`\s+AS\b", regex::escape(view_name)))
        .unwrap()
        .find(sql)
        .map(|matched| matched.start())
}

fn live_mysql_config(id: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_HOST").expect("DBX_LIVE_SQL_FILE_MYSQL_HOST");
    let port =
        std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(3306);
    let username = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_USER").expect("DBX_LIVE_SQL_FILE_MYSQL_USER");
    let password = std::env::var("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD").expect("DBX_LIVE_SQL_FILE_MYSQL_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Mysql,
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
    .expect("live MySQL export config should deserialize")
}

#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_restores_dependent_views() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-{suffix}");
    let database = format!("dbx_export_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`base_table` (id INT PRIMARY KEY, location POINT)"),
        format!("INSERT INTO `{database}`.`base_table` VALUES (7, ST_GeomFromText('POINT(1 2)', 4326))"),
        format!("CREATE VIEW `{database}`.`z_view` AS SELECT id FROM `{database}`.`base_table`"),
        format!("CREATE VIEW `{database}`.`a_view` AS SELECT id FROM `{database}`.`z_view`"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    let file_path = dir.join("export.sql");
    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: true,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };
    let test_result = async {
        export_database_sql_core(&state, &export_request, |_| {}).await?;
        let exported = std::fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
        if !exported.contains("ST_GeomFromWKB(") {
            return Err("MySQL geometry export did not use ST_GeomFromWKB".to_string());
        }
        let referenced_view = exported_view_position(&exported, "z_view")
            .ok_or_else(|| "exported z_view DDL was not found".to_string())?;
        let dependent_view = exported_view_position(&exported, "a_view")
            .ok_or_else(|| "exported a_view DDL was not found".to_string())?;

        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await?;
        let import_request = SqlFileRequest {
            execution_id: format!("live-mysql-import-{suffix}"),
            connection_id: connection_id.clone(),
            database: String::new(),
            file_path: file_path.to_string_lossy().to_string(),
            continue_on_error: false,
        };
        execute_sql_file_path(
            &state,
            &import_request,
            &file_path,
            CancellationToken::new(),
            std::time::Instant::now(),
            |_| {},
        )
        .await?;

        let result =
            execute_sql_statement(&state, &connection_id, &database, "SELECT id FROM a_view", None, None).await?;
        let spatial_result = execute_sql_statement(
            &state,
            &connection_id,
            &database,
            "SELECT ST_SRID(location), ST_Equals(location, ST_GeomFromText('POINT(1 2)', 4326)) FROM base_table",
            None,
            None,
        )
        .await?;
        Ok::<_, String>((referenced_view, dependent_view, result, spatial_result))
    }
    .await;
    let cleanup =
        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await;

    cleanup.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    let (referenced_view, dependent_view, result, spatial_result) = test_result.unwrap();
    assert!(referenced_view < dependent_view);
    assert_eq!(result.rows, vec![vec![serde_json::json!("7")]]);
    assert_eq!(spatial_result.rows, vec![vec![serde_json::json!(4326), serde_json::json!(1)]]);
}

/// Regression coverage for #6882. A whole-database export prefetches MySQL
/// metadata concurrently, so late health checks for an older pool generation
/// must not remove a replacement pool from routing. Empty tables must still
/// contribute their DDL even though they naturally produce no INSERT rows.
#[test]
#[ignore = "requires a disposable MySQL endpoint"]
fn live_mysql_database_export_handles_many_tables_including_empty_tables() {
    let handle = std::thread::Builder::new()
        .name("live-mysql-export-many-tables".to_string())
        // Tokio worker threads use a 2 MiB stack by default. Keep this test at
        // that production-sized boundary so large metadata futures cannot
        // silently rely on the oversized stacks used by older export tests.
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("build live MySQL export runtime")
                .block_on(run_live_mysql_database_export_handles_many_tables_including_empty_tables());
        })
        .expect("spawn live MySQL export thread");
    if let Err(panic) = handle.join() {
        std::panic::resume_unwind(panic);
    }
}

async fn run_live_mysql_database_export_handles_many_tables_including_empty_tables() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-many-tables-{suffix}");
    let database = format!("dbx_export_many_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-many-tables-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    execute_sql_statement(&state, &connection_id, "", &format!("CREATE DATABASE `{database}`"), None, None)
        .await
        .unwrap();
    for index in 1..=80 {
        let table = format!("export_probe_{index:03}");
        let create = format!(
            "CREATE TABLE `{database}`.`{table}` (\
             id INT PRIMARY KEY, parent_id INT NULL, name VARCHAR(120) NOT NULL, note TEXT, \
             created_at DATETIME, amount DECIMAL(12, 2), active BOOLEAN, metadata JSON, \
             INDEX idx_parent (parent_id))"
        );
        execute_sql_statement(&state, &connection_id, "", &create, None, None).await.unwrap();
        if index % 5 != 0 {
            let insert = format!(
                "INSERT INTO `{database}`.`{table}` \
                 (id, parent_id, name, note, created_at, amount, active, metadata) \
                 VALUES ({index}, NULL, 'row-{index:03}', 'batch export probe', \
                 '2026-08-25 12:00:00', 12.34, TRUE, '{{\"index\": {index}}}')"
            );
            execute_sql_statement(&state, &connection_id, "", &insert, None, None).await.unwrap();
        }
    }
    let test_result = async {
        for attempt in 1..=5 {
            let file_path = dir.join(format!("export-{attempt}.sql"));
            let request = DatabaseExportRequest {
                export_id: format!("live-mysql-export-many-tables-{suffix}-{attempt}"),
                connection_id: connection_id.clone(),
                database: database.clone(),
                schema: database.clone(),
                file_path: file_path.to_string_lossy().to_string(),
                selected_tables: Vec::new(),
                excluded_tables: Vec::new(),
                include_structure: true,
                include_data: true,
                include_objects: false,
                include_create_database: false,
                drop_table_if_exists: false,
                omit_auto_increment: false,
                fail_on_error: false,
                snapshot_session_id: None,
                batch_size: 1000,
            };

            export_database_sql_core(&state, &request, |_| {}).await?;
            let exported = std::fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
            if exported.contains("-- ERROR") || exported.contains("Agent runtime is unavailable") {
                return Err(format!("attempt {attempt} contained an inline export error:\n{exported}"));
            }
            for index in 1..=80 {
                let table = format!("export_probe_{index:03}");
                let create = format!("CREATE TABLE `{table}`");
                if !exported.contains(&create) {
                    return Err(format!("attempt {attempt} did not export DDL for {table}"));
                }
                if index % 5 == 0 {
                    let qualified_insert = format!("INSERT INTO `{database}`.`{table}`");
                    let unqualified_insert = format!("INSERT INTO `{table}`");
                    if exported.contains(&qualified_insert) || exported.contains(&unqualified_insert) {
                        return Err(format!("attempt {attempt} unexpectedly exported rows for empty table {table}"));
                    }
                } else if !exported.contains(&format!("'row-{index:03}'")) {
                    return Err(format!("attempt {attempt} did not export the seeded row for {table}"));
                }
            }
        }
        Ok::<_, String>(())
    }
    .await;

    let cleanup =
        execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None).await;
    cleanup.unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    test_result.unwrap();
}

/// Regression test for #6109 ("backup always errors"): the very first export
/// to a destination directory that has never been configured or used before
/// (a normal, not-yet-created local folder -- e.g. the user just typed a new
/// path into the schedule editor and saved it) must create it rather than
/// failing on every run with a raw std::fs::File::create OS error.
///
/// This must NOT be confused with a destination directory that previously
/// existed -- either because it produced a successful export before, or
/// because it was recorded at configuration time via
/// `record_export_destination_identity` -- and has since disappeared (e.g.
/// an unmounted external/network drive). See
/// `live_mysql_database_export_refuses_to_recreate_a_destination_that_disappeared`
/// and `live_mysql_database_export_refuses_a_destination_that_vanished_before_its_first_run`
/// below, and the #6327 discussion, for why those cases are refused instead.
#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_creates_missing_destination_directory() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-missing-dir-{suffix}");
    let database = format!("dbx_export_missing_dir_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-missing-dir-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`widgets` (id INT PRIMARY KEY, name VARCHAR(50))"),
        format!("INSERT INTO `{database}`.`widgets` VALUES (1, 'alpha')"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    // Destination directory deliberately never created and never recorded --
    // simulates a brand-new local folder the user just typed into the
    // schedule editor, not a mount that used to exist.
    let missing_destination_dir = dir.join("brand-new-local-folder");
    let file_path = missing_destination_dir.join("export.sql");
    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-missing-dir-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: true,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    let result = export_database_sql_core(&state, &export_request, |_| {}).await;

    execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None)
        .await
        .unwrap();

    result.expect("export should succeed even when the destination directory is missing");
    assert!(missing_destination_dir.exists(), "destination directory should have been auto-created");
    let exported = std::fs::read_to_string(&file_path).unwrap();
    assert!(exported.contains("'alpha'"), "exported SQL should contain the seeded row");

    std::fs::remove_dir_all(dir).unwrap();
}

/// Regression test for the #6327 review of the #6109 fix: once a destination
/// directory has produced a successful export, its later disappearance (e.g.
/// an external/network drive that got unmounted between scheduled runs) must
/// make the next export fail with a clear error instead of silently
/// recreating the directory -- which, for a vanished mount, would resurrect
/// it on the local root filesystem and write the backup to the wrong disk.
#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_refuses_to_recreate_a_destination_that_disappeared() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-vanished-dir-{suffix}");
    let database = format!("dbx_export_vanished_dir_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-vanished-dir-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`widgets` (id INT PRIMARY KEY, name VARCHAR(50))"),
        format!("INSERT INTO `{database}`.`widgets` VALUES (1, 'alpha')"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    // Simulates a backup destination on an external/network drive that is
    // currently connected and gets used successfully once.
    let destination_dir = dir.join("mounted-drive-destination");
    let file_path = destination_dir.join("export.sql");
    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-vanished-dir-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: true,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    export_database_sql_core(&state, &export_request, |_| {}).await.expect("first export should succeed");
    assert!(destination_dir.exists());

    // Simulates the drive being disconnected/unmounted before the next run:
    // the whole destination directory is gone, not just emptied.
    std::fs::remove_dir_all(&destination_dir).unwrap();
    assert!(!destination_dir.exists());

    let result = export_database_sql_core(&state, &export_request, |_| {}).await;

    execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None)
        .await
        .unwrap();

    assert!(result.is_err(), "export must not silently recreate a destination that previously existed");
    assert!(!destination_dir.exists(), "the backup directory must not be resurrected on the wrong filesystem");

    std::fs::remove_dir_all(dir).unwrap();
}

/// Regression test for review feedback on #6327: scheduled plans live in the
/// frontend and may not run for hours after being saved. Recording a
/// destination's identity only after a *successful* export (as in
/// `live_mysql_database_export_refuses_to_recreate_a_destination_that_disappeared`
/// above) means a mount that was connected when the schedule was configured,
/// but disappears before its very first scheduled run, is indistinguishable
/// from a brand-new local folder and gets silently recreated on the wrong
/// filesystem. `record_export_destination_identity` -- called from the
/// schedule editor when the schedule is saved, before any export ever runs
/// -- closes that gap. This exercises the same "recorded, then vanished"
/// scenario through the public export API end-to-end, but with the identity
/// recorded eagerly (simulating schedule configuration) instead of via a
/// prior successful run.
#[tokio::test]
#[ignore = "requires a disposable MySQL endpoint"]
async fn live_mysql_database_export_refuses_a_destination_that_vanished_before_its_first_run() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-mysql-export-preconfigured-vanished-dir-{suffix}");
    // MySQL identifiers are capped at 64 characters -- keep this well under
    // that even with the 32-character uuid suffix.
    let database = format!("dbx_export_precfg_vanished_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-mysql-export-preconfigured-vanished-dir-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state.configs.write().await.insert(connection_id.clone(), live_mysql_config(&connection_id));

    for sql in [
        format!("DROP DATABASE IF EXISTS `{database}`"),
        format!("CREATE DATABASE `{database}`"),
        format!("CREATE TABLE `{database}`.`widgets` (id INT PRIMARY KEY, name VARCHAR(50))"),
        format!("INSERT INTO `{database}`.`widgets` VALUES (1, 'alpha')"),
    ] {
        execute_sql_statement(&state, &connection_id, "", &sql, None, None).await.unwrap();
    }

    // Simulates the user picking an already-mounted external/network drive
    // in the schedule editor and saving the schedule. The directory exists
    // at configuration time, but no export has run against it yet.
    let destination_dir = dir.join("preconfigured-mounted-drive-destination");
    let file_path = destination_dir.join("export.sql");
    std::fs::create_dir_all(&destination_dir).unwrap();
    record_export_destination_identity(&state, &destination_dir)
        .await
        .expect("configuring the schedule should succeed");

    let export_request = DatabaseExportRequest {
        export_id: format!("live-mysql-export-preconfigured-vanished-dir-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: database.clone(),
        file_path: file_path.to_string_lossy().to_string(),
        selected_tables: Vec::new(),
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: true,
        drop_table_if_exists: true,
        omit_auto_increment: false,
        fail_on_error: true,
        snapshot_session_id: None,
        batch_size: 1000,
    };

    // The mount disappears before the scheduler ever runs this schedule for
    // the first time.
    std::fs::remove_dir_all(&destination_dir).unwrap();
    assert!(!destination_dir.exists());

    let result = export_database_sql_core(&state, &export_request, |_| {}).await;

    execute_sql_statement(&state, &connection_id, "", &format!("DROP DATABASE `{database}`"), None, None)
        .await
        .unwrap();

    assert!(result.is_err(), "a mount that was recorded at configuration time must not be silently recreated");
    assert!(!destination_dir.exists(), "the backup directory must not be resurrected on the wrong filesystem");
    assert!(!file_path.exists(), "no backup should have been written to the resurrected directory");

    std::fs::remove_dir_all(dir).unwrap();
}
