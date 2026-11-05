use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use std::sync::Arc;
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

/// #14178: views that read other views must be created after them, whatever their names.
/// The fixture names every view so that alphabetical order is the reverse of dependency order.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_creates_views_after_the_views_they_read() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_issue14178_src_{}", &suffix[..12]);
    let target_database = format!("dbx_issue14178_dst_{}", &suffix[..12]);
    let admin_connection_id = format!("postgres-view-order-admin-{suffix}");
    let source_connection_id = format!("postgres-view-order-source-{suffix}");
    let target_connection_id = format!("postgres-view-order-target-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage =
        dbx_core::persistence::test_storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        dir.path().join("plugins"),
        dir.path().join("agents"),
        env!("CARGO_PKG_VERSION"),
    ));
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
        "CREATE TABLE public.items (id integer PRIMARY KEY, amount integer NOT NULL)",
        "INSERT INTO public.items VALUES (1, 10), (2, 20), (3, -5)",
        "CREATE VIEW public.v_z_base AS SELECT id, amount FROM public.items WHERE amount > 0",
        "CREATE VIEW public.v_m_middle AS SELECT id, amount * 2 AS doubled FROM public.v_z_base",
        "CREATE VIEW public.v_a_top AS SELECT sum(doubled) AS total FROM public.v_m_middle",
        "CREATE MATERIALIZED VIEW public.v_b_snapshot AS SELECT total FROM public.v_a_top",
        "CREATE VIEW public.v_0_report AS \
           SELECT s.total, b.id FROM public.v_b_snapshot s CROSS JOIN public.v_z_base b",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-view-order.sql");
    export_database_sql_core(
        &state,
        &DatabaseExportRequest {
            export_id: format!("postgres-view-order-export-{suffix}"),
            connection_id: source_connection_id.clone(),
            database: source_database.clone(),
            schema: "public".to_string(),
            file_path: export_path.display().to_string(),
            selected_tables: Vec::new(),
            selected_objects: None,
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data: true,
            include_objects: true,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            omit_database_qualifier: false,
            preserve_original_language: false,
            fail_on_error: true,
            prevent_overwrite: false,
            output_compression: Default::default(),
            insert_dialect: Default::default(),
            insert_mode: Default::default(),
            snapshot_session_id: None,
            batch_size: 1000,
            split_max_mb: None,
        },
        |_| {},
    )
    .await
    .expect("export PostgreSQL schema");

    let restore = execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("postgres-view-order-import-{suffix}"),
            connection_id: target_connection_id.clone(),
            database: target_database.clone(),
            schema: None,
            file_path: export_path.display().to_string(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
            failure_log_enabled: true,
            resolve_includes: false,
            encoding: Default::default(),
        },
        &export_path,
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await;

    let restored = match restore {
        Ok(_) => Box::pin(execute_sql_statement(
            &state,
            &target_connection_id,
            &target_database,
            "SELECT (SELECT total::text FROM public.v_a_top), \
                    (SELECT count(*) FROM public.v_0_report)",
            None,
            None,
        ))
        .await
        .map(|result| result.rows),
        Err(error) => Err(error),
    };

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

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    let restored = restored.unwrap_or_else(|error| panic!("restore exported views: {error}\n{exported}"));
    assert_eq!(restored, vec![vec![serde_json::json!("60"), serde_json::json!(2)]]);
}
