use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest, ExportStatus};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use dbx_core::storage::Storage;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

fn live_postgres_config(id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").expect("DBX_LIVE_POSTGRES_EXPORT_HOST");
    let port =
        std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(5432);
    let username = std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").expect("DBX_LIVE_POSTGRES_EXPORT_USER");
    let password = std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").expect("DBX_LIVE_POSTGRES_EXPORT_PASSWORD");

    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": id,
        "db_type": DatabaseType::Postgres,
        "host": host,
        "port": port,
        "username": username,
        "password": password,
        "database": database,
        "ssl": false,
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30,
        "idle_timeout_secs": 60,
        "keepalive_interval_secs": 0
    }))
    .expect("live PostgreSQL export config should deserialize")
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_all_schema_export_restores_one_sql_file() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_issue8336_src_{}", &suffix[..12]);
    let target_database = format!("dbx_issue8336_dst_{}", &suffix[..12]);
    let expected_export_database = source_database.clone();
    let admin_connection_id = format!("postgres-all-schema-admin-{suffix}");
    let source_connection_id = format!("postgres-all-schema-source-{suffix}");
    let target_connection_id = format!("postgres-all-schema-target-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
    for database in [&source_database, &target_database] {
        Box::pin(execute_sql_statement(
            &state,
            &admin_connection_id,
            "postgres",
            &format!("CREATE DATABASE \"{database}\""),
            None,
            None,
        ))
        .await
        .expect("create disposable PostgreSQL database");
    }
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_postgres_config(&source_connection_id, &source_database));
    state
        .configs
        .write()
        .await
        .insert(target_connection_id.clone(), live_postgres_config(&target_connection_id, &target_database));

    for statement in [
        "CREATE SCHEMA inventory",
        "CREATE SCHEMA reporting",
        "CREATE TABLE public.accounts (id integer PRIMARY KEY, name text NOT NULL)",
        "CREATE TABLE inventory.products (id integer PRIMARY KEY, sku text NOT NULL)",
        "CREATE TABLE reporting.daily_totals (day date PRIMARY KEY, amount numeric(12,2) NOT NULL)",
        "CREATE VIEW reporting.positive_totals AS SELECT day, amount FROM reporting.daily_totals WHERE amount > 0",
        "INSERT INTO public.accounts VALUES (1, 'Alice'), (2, 'Bob')",
        "INSERT INTO inventory.products VALUES (10, 'SKU-10')",
        "INSERT INTO reporting.daily_totals VALUES ('2026-09-07', 42.50)",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-all-schemas.sql");
    let progress = Arc::new(Mutex::new(Vec::new()));
    let progress_sink = progress.clone();
    export_database_sql_core(
        &state,
        &DatabaseExportRequest {
            export_id: format!("postgres-all-schema-export-{suffix}"),
            connection_id: source_connection_id,
            database: source_database.clone(),
            schema: String::new(),
            file_path: export_path.display().to_string(),
            selected_tables: Vec::new(),
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data: true,
            include_objects: true,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            fail_on_error: true,
            output_compression: Default::default(),
            snapshot_session_id: None,
            batch_size: 1000,
        },
        move |event| progress_sink.lock().expect("progress mutex poisoned").push(event),
    )
    .await
    .expect("export every PostgreSQL schema");

    let exported = std::fs::read_to_string(&export_path).expect("read combined export");
    for expected in [
        "CREATE SCHEMA IF NOT EXISTS \"public\";",
        "CREATE SCHEMA IF NOT EXISTS \"inventory\";",
        "CREATE SCHEMA IF NOT EXISTS \"reporting\";",
        "CREATE TABLE \"public\".\"accounts\"",
        "CREATE TABLE \"inventory\".\"products\"",
        "CREATE TABLE \"reporting\".\"daily_totals\"",
        "positive_totals",
    ] {
        assert!(exported.contains(expected), "missing {expected} in combined export:\n{exported}");
    }
    assert_eq!(exported.matches("-- Schema export:").count(), 3, "unexpected schema sections:\n{exported}");
    assert!(
        progress.lock().expect("progress mutex poisoned").iter().any(|event| {
            matches!(event.status, ExportStatus::Done) && event.current_object == expected_export_database
        }),
        "combined export must emit a terminal Done event"
    );

    execute_sql_file_path(
        &state,
        &SqlFileRequest {
            execution_id: format!("postgres-all-schema-import-{suffix}"),
            connection_id: target_connection_id.clone(),
            database: target_database.clone(),
            file_path: export_path.display().to_string(),
            continue_on_error: false,
        },
        &export_path,
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await
    .expect("restore combined PostgreSQL export");

    let restored = Box::pin(execute_sql_statement(
        &state,
        &target_connection_id,
        &target_database,
        "SELECT
           (SELECT count(*) FROM public.accounts),
           (SELECT count(*) FROM inventory.products),
           (SELECT amount::text FROM reporting.positive_totals WHERE day = DATE '2026-09-07')",
        None,
        None,
    ))
    .await
    .expect("query restored schemas");
    assert_eq!(restored.rows, vec![vec![serde_json::json!(2), serde_json::json!(1), serde_json::json!("42.50")]]);

    for database in [&source_database, &target_database] {
        Box::pin(execute_sql_statement(
            &state,
            &admin_connection_id,
            "postgres",
            &format!("DROP DATABASE \"{database}\" WITH (FORCE)"),
            None,
            None,
        ))
        .await
        .expect("drop disposable PostgreSQL database");
    }
}
