use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use dbx_core::storage::Storage;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn live_postgres_config(id: &str, database: &str) -> ConnectionConfig {
    let host = std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").expect("DBX_LIVE_POSTGRES_EXPORT_HOST");
    let port =
        std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").ok().and_then(|value| value.parse::<u16>().ok()).unwrap_or(5432);
    let username = std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").expect("DBX_LIVE_POSTGRES_EXPORT_USER");
    let password = std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").unwrap_or_default();

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

fn export_request(export_id: String, connection_id: &str, database: &str, file_path: String) -> DatabaseExportRequest {
    DatabaseExportRequest {
        export_id,
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: "public".to_string(),
        file_path,
        selected_tables: Vec::new(),
        selected_objects: None,
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: true,
        include_objects: true,
        include_create_database: false,
        drop_table_if_exists: true,
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
        row_limit_per_table: None,
        row_limit_sort_column: None,
        row_limit_sort_descending: false,
    }
}

/// Restoring into a database that already has the view objects must work even
/// when the view definitions changed shape: the export drops the dependent
/// views before the tables (`pg_dump --clean` ordering) instead of relying on a
/// `DROP TABLE ... CASCADE` that silently removes them.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_restores_over_changed_views() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgview_src_{}", &suffix[..12]);
    let target_database = format!("dbx_pgview_dst_{}", &suffix[..12]);
    let admin_connection_id = format!("pgview-admin-{suffix}");
    let source_connection_id = format!("pgview-source-{suffix}");
    let target_connection_id = format!("pgview-target-{suffix}");
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
        "CREATE TABLE public.items (id integer PRIMARY KEY, name text NOT NULL, price numeric(10,2) NOT NULL)",
        "CREATE VIEW public.item_view AS SELECT id, name FROM public.items",
        "CREATE MATERIALIZED VIEW public.item_mv AS SELECT id, price FROM public.items",
        "INSERT INTO public.items VALUES (1, 'bolt', 2.50), (2, 'nut', 1.25)",
        "REFRESH MATERIALIZED VIEW public.item_mv",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }
    // The restore target keeps an older shape of the same objects: the view has
    // one column more than the source, which makes `CREATE OR REPLACE VIEW` fail
    // with `cannot drop columns from view`, and the materialized view already
    // exists, which makes a plain `CREATE MATERIALIZED VIEW` fail outright.
    for statement in [
        "CREATE TABLE public.items (id integer PRIMARY KEY, name text NOT NULL, price numeric(10,2) NOT NULL)",
        "CREATE VIEW public.item_view AS SELECT id, name, price FROM public.items",
        "CREATE MATERIALIZED VIEW public.item_mv AS SELECT id FROM public.items",
        "INSERT INTO public.items VALUES (99, 'stale', 9.99)",
    ] {
        Box::pin(execute_sql_statement(&state, &target_connection_id, &target_database, statement, None, None))
            .await
            .expect("create target fixture");
    }

    let export_path = dir.path().join("postgres-dependent-views.sql");
    export_database_sql_core(
        &state,
        &export_request(
            format!("pgview-export-{suffix}"),
            &source_connection_id,
            &source_database,
            export_path.display().to_string(),
        ),
        |_| {},
    )
    .await
    .expect("export PostgreSQL schema with dependent views");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    let view_drop = exported.find("DROP VIEW IF EXISTS \"public\".\"item_view\" CASCADE;").unwrap_or_else(|| {
        panic!("export must drop the dependent view before touching its table:\n{exported}");
    });
    let matview_drop = exported
        .find("DROP MATERIALIZED VIEW IF EXISTS \"public\".\"item_mv\" CASCADE;")
        .unwrap_or_else(|| panic!("export must drop the dependent materialized view:\n{exported}"));
    let table_drop = exported
        .find("DROP TABLE IF EXISTS \"public\".\"items\";")
        .unwrap_or_else(|| panic!("table drop must not need CASCADE once views are dropped first:\n{exported}"));
    assert!(view_drop < table_drop, "views must be dropped before tables:\n{exported}");
    assert!(matview_drop < table_drop, "materialized views must be dropped before tables:\n{exported}");
    assert!(
        !exported.contains("DROP TABLE IF EXISTS \"public\".\"items\" CASCADE;"),
        "the table drop must not carry CASCADE:\n{exported}"
    );

    execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("pgview-import-{suffix}"),
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
    .await
    .expect("restore PostgreSQL export over existing views");

    let restored = Box::pin(execute_sql_statement(
        &state,
        &target_connection_id,
        &target_database,
        "SELECT
           (SELECT count(*) FROM public.items),
           (SELECT count(*) FROM public.item_view),
           (SELECT count(*) FROM public.item_mv),
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'item_view')",
        None,
        None,
    ))
    .await
    .expect("query restored views");
    assert_eq!(
        restored.rows,
        vec![vec![serde_json::json!(2), serde_json::json!(2), serde_json::json!(2), serde_json::json!(2),]]
    );

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

/// Without `include_objects` the views are not recreated, so they must not be
/// dropped either: the export documents the collateral damage of
/// `DROP TABLE ... CASCADE` instead of silently deleting objects it cannot
/// restore.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_warns_when_dependent_views_are_not_exported() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgviewwarn_src_{}", &suffix[..12]);
    let admin_connection_id = format!("pgviewwarn-admin-{suffix}");
    let source_connection_id = format!("pgviewwarn-source-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("CREATE DATABASE \"{source_database}\""),
        None,
        None,
    ))
    .await
    .expect("create disposable PostgreSQL database");
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_postgres_config(&source_connection_id, &source_database));

    for statement in [
        "CREATE TABLE public.items (id integer PRIMARY KEY)",
        "CREATE VIEW public.item_view AS SELECT id FROM public.items",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-dependent-views-not-exported.sql");
    let mut request = export_request(
        format!("pgviewwarn-export-{suffix}"),
        &source_connection_id,
        &source_database,
        export_path.display().to_string(),
    );
    request.include_objects = false;
    export_database_sql_core(&state, &request, |_| {}).await.expect("export PostgreSQL schema without views");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    assert!(exported.contains("-- WARNING:"), "export must warn about dropped views:\n{exported}");
    assert!(
        exported.contains("--   view \"public\".\"item_view\""),
        "the warning must name the view that the table cascade removes:\n{exported}"
    );
    assert!(!exported.contains("DROP VIEW IF EXISTS"), "views outside the export must not be dropped:\n{exported}");
    assert!(
        exported.contains("DROP TABLE IF EXISTS \"public\".\"items\" CASCADE;"),
        "the table drop keeps CASCADE when nothing is precleaned:\n{exported}"
    );

    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("DROP DATABASE \"{source_database}\" WITH (FORCE)"),
        None,
        None,
    ))
    .await
    .expect("drop disposable PostgreSQL database");
}

/// A dependent view that is excluded from the export must not be dropped: there
/// is no definition in the file to recreate it with. The table drop keeps its
/// CASCADE, and the file names the view that the cascade removes.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_keeps_views_excluded_from_the_export() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgviewexcl_src_{}", &suffix[..12]);
    let admin_connection_id = format!("pgviewexcl-admin-{suffix}");
    let source_connection_id = format!("pgviewexcl-source-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("CREATE DATABASE \"{source_database}\""),
        None,
        None,
    ))
    .await
    .expect("create disposable PostgreSQL database");
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_postgres_config(&source_connection_id, &source_database));

    for statement in [
        "CREATE TABLE public.items (id integer PRIMARY KEY)",
        "CREATE VIEW public.item_view AS SELECT id FROM public.items",
        "CREATE VIEW public.audit_view AS SELECT id FROM public.items",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-excluded-view.sql");
    let mut request = export_request(
        format!("pgviewexcl-export-{suffix}"),
        &source_connection_id,
        &source_database,
        export_path.display().to_string(),
    );
    request.excluded_tables = vec!["audit_view".to_string()];
    export_database_sql_core(&state, &request, |_| {}).await.expect("export PostgreSQL schema with an excluded view");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    assert!(
        exported.contains("DROP VIEW IF EXISTS \"public\".\"item_view\" CASCADE;"),
        "the exported view must still be precleaned:\n{exported}"
    );
    assert!(
        !exported.contains("DROP VIEW IF EXISTS \"public\".\"audit_view\""),
        "an excluded view must not be dropped:\n{exported}"
    );
    assert!(
        exported.contains("--   view \"public\".\"audit_view\""),
        "the warning must name the excluded view:\n{exported}"
    );
    assert!(
        exported.contains("DROP TABLE IF EXISTS \"public\".\"items\" CASCADE;"),
        "the table drop keeps CASCADE while a dependent view stays unexported:\n{exported}"
    );

    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("DROP DATABASE \"{source_database}\" WITH (FORCE)"),
        None,
        None,
    ))
    .await
    .expect("drop disposable PostgreSQL database");
}

/// Foreign keys reference their parent table, so a CASCADE-less `DROP TABLE` of
/// the parent fails with `2BP01` unless the children are dropped first. The
/// export orders the drops children-first whenever it precleans views.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_restores_tables_with_foreign_keys_and_views() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgfk_src_{}", &suffix[..12]);
    let target_database = format!("dbx_pgfk_dst_{}", &suffix[..12]);
    let admin_connection_id = format!("pgfk-admin-{suffix}");
    let source_connection_id = format!("pgfk-source-{suffix}");
    let target_connection_id = format!("pgfk-target-{suffix}");
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
        "CREATE TABLE public.parents (id integer PRIMARY KEY, name text NOT NULL)",
        "CREATE TABLE public.children (id integer PRIMARY KEY, parent_id integer REFERENCES public.parents(id), note text)",
        "CREATE VIEW public.parent_view AS SELECT id, name FROM public.parents",
        "INSERT INTO public.parents VALUES (1, 'root')",
        "INSERT INTO public.children VALUES (10, 1, 'child')",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }
    // The target still has both tables with their foreign key, plus an older
    // shape of the view.
    for statement in [
        "CREATE TABLE public.parents (id integer PRIMARY KEY, name text NOT NULL)",
        "CREATE TABLE public.children (id integer PRIMARY KEY, parent_id integer REFERENCES public.parents(id), note text)",
        "CREATE VIEW public.parent_view AS SELECT id, name, 'stale'::text AS stale FROM public.parents",
    ] {
        Box::pin(execute_sql_statement(&state, &target_connection_id, &target_database, statement, None, None))
            .await
            .expect("create target fixture");
    }

    let export_path = dir.path().join("postgres-foreign-keys.sql");
    export_database_sql_core(
        &state,
        &export_request(
            format!("pgfk-export-{suffix}"),
            &source_connection_id,
            &source_database,
            export_path.display().to_string(),
        ),
        |_| {},
    )
    .await
    .expect("export PostgreSQL schema with foreign keys and views");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    // Children are dropped before their parent: the parent drop has no CASCADE.
    let child_drop = exported
        .find("DROP TABLE IF EXISTS \"public\".\"children\";")
        .unwrap_or_else(|| panic!("children must be dropped without CASCADE:\n{exported}"));
    let parent_drop = exported
        .find("DROP TABLE IF EXISTS \"public\".\"parents\";")
        .unwrap_or_else(|| panic!("parents must be dropped without CASCADE:\n{exported}"));
    assert!(child_drop < parent_drop, "children must be dropped before their parent:\n{exported}");

    execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("pgfk-import-{suffix}"),
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
    .await
    .expect("restore PostgreSQL export with foreign keys");

    let restored = Box::pin(execute_sql_statement(
        &state,
        &target_connection_id,
        &target_database,
        "SELECT
           (SELECT count(*) FROM public.parents),
           (SELECT count(*) FROM public.children),
           (SELECT count(*) FROM public.parent_view),
           (SELECT count(*) FROM information_schema.table_constraints
             WHERE table_schema = 'public' AND table_name = 'children' AND constraint_type = 'FOREIGN KEY')",
        None,
        None,
    ))
    .await
    .expect("query restored foreign keys");
    assert_eq!(
        restored.rows,
        vec![vec![serde_json::json!(1), serde_json::json!(1), serde_json::json!(1), serde_json::json!(1)]]
    );
}

/// A view in another schema still blocks a CASCADE-less `DROP TABLE`, and this
/// export cannot recreate it. The table drop must keep its CASCADE and the file
/// must say which view it removes.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_keeps_cascade_for_cross_schema_dependent_views() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgxview_src_{}", &suffix[..12]);
    let admin_connection_id = format!("pgxview-admin-{suffix}");
    let source_connection_id = format!("pgxview-source-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("CREATE DATABASE \"{source_database}\""),
        None,
        None,
    ))
    .await
    .expect("create disposable PostgreSQL database");
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_postgres_config(&source_connection_id, &source_database));

    for statement in [
        "CREATE SCHEMA reporting",
        "CREATE TABLE public.items (id integer PRIMARY KEY)",
        "CREATE VIEW reporting.item_view AS SELECT id FROM public.items",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-cross-schema-view.sql");
    export_database_sql_core(
        &state,
        &export_request(
            format!("pgxview-export-{suffix}"),
            &source_connection_id,
            &source_database,
            export_path.display().to_string(),
        ),
        |_| {},
    )
    .await
    .expect("export PostgreSQL schema with a cross-schema dependent view");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    assert!(
        exported.contains("--   view \"reporting\".\"item_view\""),
        "the note must name the cross-schema view:\n{exported}"
    );
    assert!(
        exported.contains("DROP TABLE IF EXISTS \"public\".\"items\" CASCADE;"),
        "a cross-schema dependent view must keep the table cascade:\n{exported}"
    );
    assert!(
        !exported.contains("DROP VIEW IF EXISTS \"reporting\".\"item_view\""),
        "views outside the exported schema must not be dropped:\n{exported}"
    );

    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("DROP DATABASE \"{source_database}\" WITH (FORCE)"),
        None,
        None,
    ))
    .await
    .expect("drop disposable PostgreSQL database");
}

/// A view that reads another view inherits the dependency: excluding it must
/// produce a warning and keep the table cascade instead of letting
/// `DROP VIEW ... CASCADE` remove it silently.
#[tokio::test]
#[ignore = "requires a live PostgreSQL account with CREATE DATABASE privilege"]
async fn live_postgres_export_warns_about_view_chains_outside_the_export() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_pgchain_src_{}", &suffix[..12]);
    let admin_connection_id = format!("pgchain-admin-{suffix}");
    let source_connection_id = format!("pgchain-source-{suffix}");
    let dir = tempfile::tempdir().expect("create export temp directory");
    let storage = Storage::open(&dir.path().join("storage.db")).await.expect("open temp storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("CREATE DATABASE \"{source_database}\""),
        None,
        None,
    ))
    .await
    .expect("create disposable PostgreSQL database");
    state
        .configs
        .write()
        .await
        .insert(source_connection_id.clone(), live_postgres_config(&source_connection_id, &source_database));

    for statement in [
        "CREATE TABLE public.items (id integer PRIMARY KEY)",
        "CREATE VIEW public.item_view AS SELECT id FROM public.items",
        "CREATE VIEW public.item_view_chain AS SELECT id FROM public.item_view",
    ] {
        Box::pin(execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None))
            .await
            .expect("create source fixture");
    }

    let export_path = dir.path().join("postgres-view-chain.sql");
    let mut request = export_request(
        format!("pgchain-export-{suffix}"),
        &source_connection_id,
        &source_database,
        export_path.display().to_string(),
    );
    request.excluded_tables = vec!["item_view_chain".to_string()];
    export_database_sql_core(&state, &request, |_| {}).await.expect("export PostgreSQL schema with a view chain");

    let exported = std::fs::read_to_string(&export_path).expect("read export");
    assert!(
        exported.contains("--   view \"public\".\"item_view_chain\""),
        "the warning must name the excluded chained view:\n{exported}"
    );
    assert!(
        exported.contains("DROP TABLE IF EXISTS \"public\".\"items\" CASCADE;"),
        "the table drop must keep CASCADE while a chained view stays unexported:\n{exported}"
    );

    Box::pin(execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("DROP DATABASE \"{source_database}\" WITH (FORCE)"),
        None,
        None,
    ))
    .await
    .expect("drop disposable PostgreSQL database");
}
