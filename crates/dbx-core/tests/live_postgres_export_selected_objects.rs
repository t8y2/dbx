//! Live regression coverage for issue #13940: "export selected" in the object
//! browser must export exactly the picked objects. A table and a function may
//! share a name in PostgreSQL, and a function may be overloaded, so the
//! selection is matched by type and signature, not by name.
//!
//! Run against a disposable/local endpoint:
//!   DBX_LIVE_POSTGRES_EXPORT_HOST=127.0.0.1 \
//!   DBX_LIVE_POSTGRES_EXPORT_PORT=5432 \
//!   DBX_LIVE_POSTGRES_EXPORT_USER=... \
//!   DBX_LIVE_POSTGRES_EXPORT_PASSWORD=... \
//!   cargo test -p dbx-core --no-default-features --features sqlite-bundled \
//!     --test live_postgres_export_selected_objects -- --include-ignored

use dbx_core::connection::AppState;
use dbx_core::database_export::{export_database_sql_core, DatabaseExportRequest, DatabaseExportSelectedObject};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
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

fn export_request(
    connection_id: &str,
    database: &str,
    file_path: &std::path::Path,
    selected_tables: Vec<String>,
    selected_objects: Option<Vec<DatabaseExportSelectedObject>>,
    include_structure: bool,
) -> DatabaseExportRequest {
    DatabaseExportRequest {
        export_id: format!("pg-selected-export-{}", uuid::Uuid::new_v4().simple()),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: "public".to_string(),
        file_path: file_path.display().to_string(),
        selected_tables,
        selected_objects,
        excluded_tables: Vec::new(),
        include_structure,
        include_data: false,
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
    }
}

fn picked(object_type: &str, name: &str, signature: Option<&str>) -> DatabaseExportSelectedObject {
    DatabaseExportSelectedObject {
        object_type: object_type.to_string(),
        name: name.to_string(),
        signature: signature.map(str::to_string),
    }
}

#[tokio::test]
#[ignore = "requires a live PostgreSQL endpoint"]
async fn live_postgres_export_selected_objects_matches_type_and_signature() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let database = format!("dbx_eval_sel_{}", &suffix[..10]);
    let admin_connection_id = format!("pg-selected-admin-{suffix}");
    let connection_id = format!("pg-selected-source-{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-selected-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(admin_connection_id.clone(), live_postgres_config(&admin_connection_id, "postgres"));
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
    state.configs.write().await.insert(connection_id.clone(), live_postgres_config(&connection_id, &database));

    for statement in [
        "CREATE TABLE public.orders (id integer PRIMARY KEY)",
        "CREATE FUNCTION public.orders(p_id integer) RETURNS integer LANGUAGE sql AS $$ SELECT p_id $$",
        "CREATE FUNCTION public.orders(p_id integer, p_note text) RETURNS text LANGUAGE sql AS $$ SELECT p_note $$",
        "CREATE TABLE public.audit (id integer PRIMARY KEY)",
        "CREATE SEQUENCE public.invoice_seq",
        "CREATE SEQUENCE public.other_seq",
    ] {
        execute_sql_statement(&state, &connection_id, &database, statement, None, None).await.expect("create fixture");
    }

    // The object browser sends the signature it listed, so use the listed one.
    let objects =
        dbx_core::schema::list_objects_core(&state, &connection_id, &database, "public", None, None, None, None, None)
            .await
            .expect("list fixture objects");
    let one_argument_signature = objects
        .iter()
        .filter(|object| object.name == "orders" && object.object_type.to_uppercase().contains("FUNCTION"))
        .filter_map(|object| object.signature.clone())
        .find(|signature| !signature.contains(','))
        .expect("listed signature of orders(integer)");

    let cases = [
        ("table only", Vec::new(), Some(vec![picked("TABLE", "orders", None)]), true),
        ("one overload", Vec::new(), Some(vec![picked("FUNCTION", "orders", Some(&one_argument_signature))]), true),
        ("table names", vec!["orders".to_string()], None, true),
        // Objects only: a picked standalone sequence does not need the table structure.
        ("one sequence", Vec::new(), Some(vec![picked("SEQUENCE", "invoice_seq", None)]), false),
    ];
    let mut exports = Vec::new();
    for (name, selected_tables, selected_objects, include_structure) in cases {
        let path = dir.join(format!("{}.sql", name.replace(' ', "-")));
        let result = export_database_sql_core(
            &state,
            &export_request(&connection_id, &database, &path, selected_tables, selected_objects, include_structure),
            |_| {},
        )
        .await;
        exports.push((name, result.map(|_| std::fs::read_to_string(&path).expect("read export"))));
    }
    let empty_path = dir.join("empty.sql");
    let empty = export_database_sql_core(
        &state,
        &export_request(&connection_id, &database, &empty_path, Vec::new(), Some(Vec::new()), true),
        |_| {},
    )
    .await;

    let _ = execute_sql_statement(
        &state,
        &admin_connection_id,
        "postgres",
        &format!("DROP DATABASE \"{database}\" WITH (FORCE)"),
        None,
        None,
    )
    .await;
    drop(state);
    let _ = std::fs::remove_dir_all(&dir);

    let function_definitions = |sql: &str| sql.matches("FUNCTION public.orders(").count();
    let creates_table = |sql: &str, table: &str| {
        sql.lines().any(|line| line.starts_with("CREATE TABLE") && line.contains(&format!("\"{table}\"")))
    };
    for (name, export) in exports {
        let sql = export.unwrap_or_else(|error| panic!("{name}: export failed: {error}"));
        match name {
            "table only" | "table names" => {
                assert!(creates_table(&sql, "orders"), "{name}: table missing\n{sql}");
                assert!(!creates_table(&sql, "audit"), "{name}: unselected table exported\n{sql}");
                assert_eq!(function_definitions(&sql), 0, "{name}: same-name function exported\n{sql}");
                assert!(!sql.contains("invoice_seq"), "{name}: standalone sequence exported\n{sql}");
            }
            "one overload" => {
                assert!(!creates_table(&sql, "orders"), "{name}: same-name table exported\n{sql}");
                assert_eq!(function_definitions(&sql), 1, "{name}: expected exactly one overload\n{sql}");
                assert!(sql.contains("p_id integer)"), "{name}: wrong overload\n{sql}");
            }
            "one sequence" => {
                assert!(
                    sql.contains("CREATE SEQUENCE") && sql.contains("invoice_seq"),
                    "{name}: sequence missing\n{sql}"
                );
                assert!(!sql.contains("other_seq"), "{name}: unpicked sequence exported\n{sql}");
                assert!(!sql.contains("CREATE TABLE"), "{name}: table exported\n{sql}");
            }
            _ => unreachable!(),
        }
    }
    assert_eq!(empty.unwrap_err(), "No objects are selected for export");
    assert!(!empty_path.exists());
}
