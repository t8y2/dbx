//! Live regression coverage for issue #10575: a PostgreSQL database export
//! (`.sql`/`.sql.gz` backup) must restore into an empty database even when the
//! schema's foreign key graph contains a cycle — a topology that no table
//! creation order can satisfy.
//!
//! The export writes foreign keys as deferred `ALTER TABLE ... ADD CONSTRAINT`
//! statements after every table and row (pg_dump's post-data position), so the
//! script replays in file order regardless of dependency direction.
//!
//! Run against a disposable/local endpoint:
//!   DBX_LIVE_POSTGRES_EXPORT_HOST=127.0.0.1 \
//!   DBX_LIVE_POSTGRES_EXPORT_PORT=5432 \
//!   DBX_LIVE_POSTGRES_EXPORT_USER=... \
//!   DBX_LIVE_POSTGRES_EXPORT_PASSWORD=... \
//!   cargo test -p dbx-core --no-default-features --features sqlite-bundled,duckdb-sidecar \
//!     --test live_postgres_export_deferred_foreign_keys -- --include-ignored

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::sql::SqlFileRequest;
use std::sync::Arc;

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

#[tokio::test]
#[ignore = "requires a live PostgreSQL endpoint"]
async fn live_postgres_export_with_foreign_key_cycle_restores_into_empty_database() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_fk_export_src_{}", &suffix[..10]);
    let target_database = format!("dbx_fk_export_dst_{}", &suffix[..10]);
    let admin_connection_id = format!("pg-fk-export-admin-{suffix}");
    let source_connection_id = format!("pg-fk-export-source-{suffix}");
    let target_connection_id = format!("pg-fk-export-target-{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-fk-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));

    for database in [&source_database, &target_database] {
        execute_sql_statement(
            &state,
            &admin_connection_id,
            "postgres",
            &format!("CREATE DATABASE \"{database}\""),
            None,
            None,
        )
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

    // A parent/child pair, a three-level dependency chain, and a mutual
    // foreign key cycle — the cycle is what no creation order can satisfy.
    // The cycle columns stay nullable so the source rows can be inserted one
    // at a time; the update closes the cycle afterwards.
    for statement in [
        "CREATE TABLE public.parent_entities (id integer PRIMARY KEY)",
        "CREATE TABLE public.child_versions (id integer PRIMARY KEY, parent_id integer NOT NULL, \
         CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES public.parent_entities(id))",
        "CREATE TABLE public.base_c (id integer PRIMARY KEY)",
        "CREATE TABLE public.parent_a (id integer PRIMARY KEY, base_id integer NOT NULL REFERENCES public.base_c(id))",
        "CREATE TABLE public.child_a (id integer PRIMARY KEY, parent_id integer NOT NULL REFERENCES public.parent_a(id))",
        "CREATE TABLE public.cyc_x (id integer PRIMARY KEY, peer_id integer)",
        "CREATE TABLE public.cyc_y (id integer PRIMARY KEY, peer_id integer)",
        "ALTER TABLE public.cyc_x ADD CONSTRAINT cyc_x_y_fk FOREIGN KEY (peer_id) REFERENCES public.cyc_y(id)",
        "ALTER TABLE public.cyc_y ADD CONSTRAINT cyc_y_x_fk FOREIGN KEY (peer_id) REFERENCES public.cyc_x(id)",
        "INSERT INTO public.parent_entities VALUES (1), (2)",
        "INSERT INTO public.child_versions VALUES (10, 1)",
        "INSERT INTO public.base_c VALUES (100)",
        "INSERT INTO public.parent_a VALUES (200, 100)",
        "INSERT INTO public.child_a VALUES (300, 200)",
        "INSERT INTO public.cyc_x VALUES (1000, NULL)",
        "INSERT INTO public.cyc_y VALUES (2000, 1000)",
        "UPDATE public.cyc_x SET peer_id = 2000 WHERE id = 1000",
    ] {
        execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None)
            .await
            .expect("create source fixture");
    }

    let export_path = dir.join("backup.sql");
    export_database_sql_core(
        &state,
        &DatabaseExportRequest {
            export_id: format!("pg-fk-export-{suffix}"),
            connection_id: source_connection_id.clone(),
            database: source_database.clone(),
            schema: "public".to_string(),
            file_path: export_path.display().to_string(),
            selected_tables: Vec::new(),
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data: true,
            include_objects: false,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
            fail_on_error: true,
            prevent_overwrite: false,
            output_compression: Default::default(),
            insert_dialect: Default::default(),
            snapshot_session_id: None,
            batch_size: 1000,
            split_max_mb: None,
        },
        |_| {},
    )
    .await
    .expect("export PostgreSQL database with a foreign key cycle");

    let exported = std::fs::read_to_string(&export_path).expect("read exported SQL");

    // No foreign key may stay inline in a CREATE TABLE body: every constraint
    // line must be one of the deferred ALTER statements written at the end.
    for line in exported.lines().filter(|line| line.to_ascii_uppercase().contains("FOREIGN KEY")) {
        assert!(
            line.trim_start().to_ascii_uppercase().starts_with("ALTER TABLE "),
            "inline foreign key left in export: {line}\n\n{exported}"
        );
    }
    for expected in [
        "ALTER TABLE \"public\".\"child_versions\" ADD CONSTRAINT \"fk_child_parent\" FOREIGN KEY (\"parent_id\") REFERENCES \"public\".\"parent_entities\"(\"id\");",
        "ALTER TABLE \"public\".\"cyc_x\" ADD CONSTRAINT \"cyc_x_y_fk\" FOREIGN KEY (\"peer_id\") REFERENCES \"public\".\"cyc_y\"(\"id\");",
        "ALTER TABLE \"public\".\"cyc_y\" ADD CONSTRAINT \"cyc_y_x_fk\" FOREIGN KEY (\"peer_id\") REFERENCES \"public\".\"cyc_x\"(\"id\");",
    ] {
        assert!(exported.contains(expected), "missing deferred foreign key: {expected}\n\n{exported}");
    }
    // Deferred statements must come after every CREATE TABLE, i.e. after all
    // data as well, so replay never depends on table or row order.
    let last_create = exported.rfind("CREATE TABLE ").expect("export contains CREATE TABLE");
    let first_foreign_key_alter =
        exported.find("ALTER TABLE").expect("export contains deferred ALTER TABLE statements");
    assert!(last_create < first_foreign_key_alter, "foreign keys must be deferred after all tables:\n{exported}");

    // The actual regression: replay the backup into an empty database.
    let restore = dbx_core::sql_file_import::execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("pg-fk-export-restore-{suffix}"),
            connection_id: target_connection_id.clone(),
            database: target_database.clone(),
            schema: Some("public".to_string()),
            file_path: export_path.display().to_string(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
        },
        &export_path,
        tokio_util::sync::CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await;
    assert!(restore.is_ok(), "restoring the exported backup failed: {:?}", restore.err());

    let fk_count = execute_sql_statement(
        &state,
        &target_connection_id,
        &target_database,
        "SELECT count(*) FROM information_schema.table_constraints \
         WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public'",
        None,
        None,
    )
    .await
    .expect("count restored foreign keys");
    assert_eq!(fk_count.rows, vec![vec![serde_json::json!(5)]]);

    let child_rows = execute_sql_statement(
        &state,
        &target_connection_id,
        &target_database,
        "SELECT count(*) FROM public.child_a",
        None,
        None,
    )
    .await
    .expect("count restored child rows");
    assert_eq!(child_rows.rows, vec![vec![serde_json::json!(1)]]);

    for database in [&source_database, &target_database] {
        let _ = execute_sql_statement(
            &state,
            &admin_connection_id,
            "postgres",
            &format!("DROP DATABASE \"{database}\" WITH (FORCE)"),
            None,
            None,
        )
        .await;
    }
    drop(state);
    let _ = std::fs::remove_dir_all(&dir);
}
