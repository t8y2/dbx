//! Live regression coverage for issue #12156: a PostgreSQL database export
//! must restore into an empty database when an index calls a user-defined
//! `IMMUTABLE` function, while functions that depend on a table (a row-type
//! return or a SQL body that reads the table) still replay after it.
//!
//! Run against a disposable/local endpoint:
//!   DBX_LIVE_POSTGRES_EXPORT_HOST=127.0.0.1 \
//!   DBX_LIVE_POSTGRES_EXPORT_PORT=5432 \
//!   DBX_LIVE_POSTGRES_EXPORT_USER=... \
//!   DBX_LIVE_POSTGRES_EXPORT_PASSWORD=... \
//!   cargo test -p dbx-core --no-default-features --features sqlite-bundled,duckdb-sidecar \
//!     --test live_postgres_export_function_order -- --include-ignored

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
async fn live_postgres_export_restores_tables_that_depend_on_functions() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_database = format!("dbx_eval_fn_src_{}", &suffix[..10]);
    let target_database = format!("dbx_eval_fn_dst_{}", &suffix[..10]);
    let admin_connection_id = format!("pg-fn-export-admin-{suffix}");
    let source_connection_id = format!("pg-fn-export-source-{suffix}");
    let target_connection_id = format!("pg-fn-export-target-{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-fn-export-{suffix}"));
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

    // The expression and partial indexes are the reported case.
    // `items_with_label` goes the other way: it returns the table's row type,
    // so it can only be created after the table, and `count_items` is a SQL
    // function whose body reads the table.
    for statement in [
        "CREATE FUNCTION public.immutable_array_to_string(text[]) RETURNS text \
         LANGUAGE sql IMMUTABLE AS $$ SELECT array_to_string($1, ',') $$",
        "CREATE TABLE public.tagged_items (id integer PRIMARY KEY, labels text[] NOT NULL)",
        "CREATE INDEX tagged_items_labels_idx ON public.tagged_items (public.immutable_array_to_string(labels))",
        "COMMENT ON INDEX public.tagged_items_labels_idx IS 'joined labels'",
        "CREATE UNIQUE INDEX tagged_items_single_label_idx ON public.tagged_items (id) \
         WHERE public.immutable_array_to_string(labels) NOT LIKE '%,%'",
        "CREATE FUNCTION public.items_with_label(text) RETURNS SETOF public.tagged_items \
         LANGUAGE sql STABLE AS $$ SELECT * FROM public.tagged_items WHERE $1 = ANY (labels) $$",
        "CREATE FUNCTION public.count_items() RETURNS bigint \
         LANGUAGE sql STABLE AS $$ SELECT count(*) FROM public.tagged_items $$",
        "INSERT INTO public.tagged_items (id, labels) VALUES (1, ARRAY['a', 'b']), (2, ARRAY['c'])",
    ] {
        execute_sql_statement(&state, &source_connection_id, &source_database, statement, None, None)
            .await
            .expect("create source fixture");
    }

    let export_path = dir.join("backup.sql");
    export_database_sql_core(
        &state,
        &DatabaseExportRequest {
            export_id: format!("pg-fn-export-{suffix}"),
            connection_id: source_connection_id.clone(),
            database: source_database.clone(),
            schema: "public".to_string(),
            file_path: export_path.display().to_string(),
            selected_tables: Vec::new(),
            excluded_tables: Vec::new(),
            include_structure: true,
            include_data: true,
            include_objects: true,
            include_create_database: false,
            drop_table_if_exists: false,
            omit_auto_increment: false,
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
    .expect("export PostgreSQL database with function-dependent tables");

    let exported = std::fs::read_to_string(&export_path).expect("read exported SQL");
    // Index statements must follow the functions they call.
    let function_position = exported.find("FUNCTION public.immutable_array_to_string");
    let index_position = exported.find("CREATE INDEX \"tagged_items_labels_idx\"");

    let restore = dbx_core::sql_file_import::execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("pg-fn-export-restore-{suffix}"),
            connection_id: target_connection_id.clone(),
            database: target_database.clone(),
            schema: Some("public".to_string()),
            file_path: export_path.display().to_string(),
            encoding: Default::default(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
            failure_log_enabled: true,
            resolve_includes: false,
        },
        &export_path,
        tokio_util::sync::CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await;

    let mut catalog = Vec::new();
    for sql in [
        "SELECT indexdef, obj_description(format('public.%I', indexname)::regclass, 'pg_class') \
         FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tagged_items' ORDER BY indexname",
        "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
         WHERE n.nspname = 'public' ORDER BY p.proname",
        "SELECT id, public.immutable_array_to_string(labels) FROM public.tagged_items ORDER BY id",
        "SELECT public.count_items()",
        "SELECT count(*) FROM public.items_with_label('b')",
    ] {
        catalog.push(
            execute_sql_statement(&state, &target_connection_id, &target_database, sql, None, None)
                .await
                .map(|result| result.rows),
        );
    }

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

    assert!(restore.is_ok(), "restoring the exported backup failed: {:?}\n\n{exported}", restore.err());
    let function_position = function_position.expect("export contains the index function");
    let index_position = index_position.expect("export contains the index");
    assert!(function_position < index_position, "index exported before its function:\n{exported}");
    let catalog = catalog.into_iter().collect::<Result<Vec<_>, _>>().expect("query restored catalog");
    assert_eq!(
        catalog[0],
        vec![
            vec![
                serde_json::json!(
                    "CREATE INDEX tagged_items_labels_idx ON public.tagged_items USING btree (immutable_array_to_string(labels))"
                ),
                serde_json::json!("joined labels"),
            ],
            vec![serde_json::json!("CREATE UNIQUE INDEX tagged_items_pkey ON public.tagged_items USING btree (id)"), serde_json::Value::Null],
            vec![
                serde_json::json!(
                    "CREATE UNIQUE INDEX tagged_items_single_label_idx ON public.tagged_items USING btree (id) WHERE (immutable_array_to_string(labels) !~~ '%,%'::text)"
                ),
                serde_json::Value::Null,
            ],
        ]
    );
    assert_eq!(
        catalog[1],
        vec![
            vec![serde_json::json!("count_items")],
            vec![serde_json::json!("immutable_array_to_string")],
            vec![serde_json::json!("items_with_label")],
        ]
    );
    assert_eq!(
        catalog[2],
        vec![vec![serde_json::json!(1), serde_json::json!("a,b")], vec![serde_json::json!(2), serde_json::json!("c")]]
    );
    assert_eq!(catalog[3], vec![vec![serde_json::json!(2)]]);
    assert_eq!(catalog[4], vec![vec![serde_json::json!(1)]]);
}
