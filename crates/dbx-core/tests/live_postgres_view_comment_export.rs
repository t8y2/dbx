#![recursion_limit = "256"]

//! Real PostgreSQL view-comment round trips through DBX export and SQL-file import.
//! These tests create uniquely named databases and retain them for explicit cleanup.
use dbx_core::connection::AppState;
use dbx_core::database_export::{
    export_database_sql_core, DatabaseExportRequest, DatabaseExportSelectedObject, ExportStatus,
};
use dbx_core::db::ObjectSourceKind;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::schema::{get_object_source_core, get_table_display_ddl_core};
use dbx_core::sql::SqlFileRequest;
use dbx_core::sql_file_import::execute_sql_file_path;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

fn config(id: &str, database: &str) -> ConnectionConfig {
    serde_json::from_value(json!({
        "id": id, "name": id, "db_type": DatabaseType::Postgres,
        "host": std::env::var("DBX_LIVE_POSTGRES_EXPORT_HOST").expect("host environment variable"),
        "port": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PORT").expect("port environment variable")
            .parse::<u16>().expect("numeric port"),
        "username": std::env::var("DBX_LIVE_POSTGRES_EXPORT_USER").expect("user environment variable"),
        "password": std::env::var("DBX_LIVE_POSTGRES_EXPORT_PASSWORD").expect("password environment variable"),
        "database": database, "ssl": false,
        "url_params": std::env::var("DBX_LIVE_POSTGRES_EXPORT_URL_PARAMS").ok(),
        "connect_timeout_secs": 10,
        "query_timeout_secs": 30, "idle_timeout_secs": 60, "keepalive_interval_secs": 0
    }))
    .expect("PostgreSQL configuration")
}

fn redact(text: &str) -> String {
    let mut result = text.to_owned();
    for key in ["DBX_LIVE_POSTGRES_EXPORT_PASSWORD", "DBX_LIVE_POSTGRES_EXPORT_HOST", "DBX_LIVE_POSTGRES_EXPORT_USER"] {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                result = result.replace(&value, "[redacted]");
            }
        }
    }
    result
}

fn save_json(dir: &Path, name: &str, value: &Value) {
    std::fs::write(dir.join(name), redact(&serde_json::to_string_pretty(value).unwrap())).expect("save evidence");
}

async fn query(state: &AppState, id: &str, database: &str, sql: &str) -> Vec<Vec<Value>> {
    Box::pin(execute_sql_statement(state, id, database, sql, None, None))
        .await
        .map(|result| result.rows)
        .map_err(|error| redact(&error))
        .expect("execute fixture/query")
}

async fn replay(state: &AppState, id: &str, database: &str, path: &Path) -> Result<(), String> {
    Box::pin(execute_sql_file_path(
        state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: uuid::Uuid::new_v4().to_string(),
            connection_id: id.to_owned(),
            database: database.to_owned(),
            schema: None,
            file_path: path.display().to_string(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
            failure_log_enabled: false,
            resolve_includes: false,
            encoding: Default::default(),
        },
        path,
        CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    ))
    .await
    .map_err(|error| redact(&error))
}

fn ident(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn literal(value: &str) -> String {
    format!("E'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}

const COMMENT_QUERY: &str = "SELECT n.nspname, c.relname, c.relkind::text, \
    pg_catalog.obj_description(c.oid, 'pg_class'), a.attname, \
    pg_catalog.col_description(c.oid, a.attnum) \
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
    WHERE n.nspname IN ('public', 'a_comments', 'z_comments') AND c.relkind IN ('v', 'm') \
    ORDER BY n.nspname, c.relname, a.attnum";

#[tokio::test]
#[ignore = "requires an approved PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_single_schema_view_comments_round_trip() {
    Box::pin(round_trip(false)).await;
}

#[tokio::test]
#[ignore = "requires an approved PostgreSQL account with CREATEDB; retains task databases"]
async fn live_postgres_cross_schema_view_comments_round_trip() {
    Box::pin(round_trip(true)).await;
}

async fn round_trip(cross_schema: bool) {
    let mode = if cross_schema { "cross-schema" } else { "single-schema" };
    let suffix = uuid::Uuid::new_v4().simple().to_string()[..12].to_owned();
    let root = std::env::var_os("DBX_REPRO_EVIDENCE_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = root.join(format!("view-comments-{mode}-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let scratch = tempfile::tempdir().expect("isolated application data");
    let storage = dbx_core::persistence::test_storage::open(&scratch.path().join("storage.db")).await.unwrap();
    let state = Arc::new(AppState::new_with_plugin_and_agent_dir_and_app_version(
        storage,
        scratch.path().join("plugins"),
        scratch.path().join("agents"),
        env!("CARGO_PKG_VERSION"),
    ));
    let admin = std::env::var("DBX_LIVE_POSTGRES_EXPORT_DATABASE").unwrap_or_else(|_| "postgres".into());
    state.configs.write().await.insert("admin".into(), config("admin", &admin));
    let probe = query(
        &state,
        "admin",
        &admin,
        "SELECT version(), (SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname = current_user)",
    )
    .await;
    save_json(&dir, "version.json", &json!(probe));
    assert_eq!(probe[0][1], json!(true), "CREATEDB required; no databases created");
    let mut databases = Vec::new();
    for role in ["source", "export", "display", "selected"] {
        let database = format!("dbx_view_comments_{role}_{suffix}");
        save_json(&dir, "resources.json", &json!({"created": databases, "creating": database}));
        query(&state, "admin", &admin, &format!("CREATE DATABASE {}", ident(&database))).await;
        if cross_schema {
            query(
                &state,
                "admin",
                &admin,
                &format!("ALTER DATABASE {} SET standard_conforming_strings = off", ident(&database)),
            )
            .await;
        }
        databases.push(database.clone());
        state.configs.write().await.insert(role.into(), config(role, &database));
        save_json(&dir, "resources.json", &json!({"created": databases, "cleanup": "not performed"}));
    }
    let source_database = &databases[0];
    let export_database = &databases[1];
    let display_database = &databases[2];
    let (earlier, later) = if cross_schema { ("a_comments", "z_comments") } else { ("public", "public") };
    let schemas = if cross_schema { vec![earlier, later] } else { vec!["public"] };
    let mut fixture = Vec::new();
    for schema in &schemas {
        if *schema != "public" {
            fixture.push(format!("CREATE SCHEMA {}", ident(schema)));
        }
    }
    // A backward schema dependency triggers the real all-schema view phase copier.
    let mut views = vec![
        (later, "z_base", ObjectSourceKind::View),
        (earlier, "v.\"quoted", ObjectSourceKind::View),
        (later, "materialized", ObjectSourceKind::MaterializedView),
        (earlier, "no_comments", ObjectSourceKind::View),
    ];
    fixture.push(format!(
        "CREATE VIEW {}.z_base AS SELECT 7 AS id, 'value'::text AS {}",
        ident(later),
        ident("Mixed\"Column")
    ));
    fixture.push(format!(
        "CREATE VIEW {}.{} AS SELECT * FROM {}.z_base",
        ident(earlier),
        ident(views[1].1),
        ident(later)
    ));
    fixture.push(format!(
        "CREATE MATERIALIZED VIEW {}.materialized AS SELECT * FROM {}.{} {}",
        ident(later),
        ident(earlier),
        ident(views[1].1),
        if cross_schema { "WITH NO DATA" } else { "WITH DATA" }
    ));
    fixture.push(format!("CREATE VIEW {}.no_comments AS SELECT * FROM {}.materialized", ident(earlier), ident(later)));
    let view_comment = "  中文 O'Reilly; \\path\\n\nsecond line  ";
    let column_comment = "  字段'注释; \\column\nnext  ";
    for (index, (schema, name, kind)) in views.iter().enumerate().take(3) {
        let kind = if *kind == ObjectSourceKind::MaterializedView { "MATERIALIZED VIEW" } else { "VIEW" };
        let reference = format!("{}.{}", ident(schema), ident(name));
        fixture.push(format!("COMMENT ON {kind} {reference} IS {}", literal(view_comment)));
        fixture.push(format!("COMMENT ON COLUMN {reference}.id IS {}", literal(column_comment)));
        // A whitespace-only comment must not be trimmed away; NULL remains absent.
        if index == 0 {
            fixture.push(format!("COMMENT ON COLUMN {reference}.{} IS {}", ident("Mixed\"Column"), literal(" \t\n ")));
        }
    }
    if cross_schema {
        views.push((earlier, "z_base", ObjectSourceKind::View));
        fixture.push(format!("CREATE VIEW {}.z_base AS SELECT 42 AS id", ident(earlier)));
        fixture.push(format!("COMMENT ON VIEW {}.z_base IS 'different schema comment'", ident(earlier)));
        fixture.push(format!("COMMENT ON COLUMN {}.z_base.id IS 'different column comment'", ident(earlier)));
    }
    // Explicitly removed comments stay NULL rather than becoming invented empty comments.
    fixture.push(format!("COMMENT ON VIEW {}.no_comments IS ''", ident(earlier)));
    std::fs::write(dir.join("fixture.sql"), format!("{};\n", fixture.join(";\n"))).unwrap();
    for statement in &fixture {
        query(&state, "source", source_database, statement).await;
    }
    let expected = query(&state, "source", source_database, COMMENT_QUERY).await;
    save_json(
        &dir,
        "string-mode.json",
        &json!(query(&state, "source", source_database, "SHOW standard_conforming_strings").await),
    );
    save_json(&dir, "source-comments.json", &json!(expected));
    let path = dir.join("database-export.sql");
    let request = DatabaseExportRequest {
        export_id: format!("view-comments-{suffix}"),
        connection_id: "source".into(),
        database: source_database.clone(),
        schema: if cross_schema { String::new() } else { "public".into() },
        file_path: path.display().to_string(),
        selected_tables: Vec::new(),
        selected_objects: None,
        excluded_tables: Vec::new(),
        include_structure: true,
        include_data: false,
        include_objects: true,
        include_create_database: false,
        drop_table_if_exists: false,
        omit_auto_increment: false,
        omit_database_qualifier: false,
        preserve_original_language: false,
        fail_on_error: true,
        prevent_overwrite: true,
        output_compression: Default::default(),
        insert_dialect: Default::default(),
        insert_mode: Default::default(),
        snapshot_session_id: None,
        batch_size: 100,
        split_max_mb: None,
    };
    let progress = Mutex::new(Vec::new());
    let exported = Box::pin(export_database_sql_core(&state, &request, |event| progress.lock().unwrap().push(event)))
        .await
        .map_err(|error| redact(&error));
    save_json(&dir, "database-export.json", &json!({"result": exported, "progress": progress.lock().unwrap().clone()}));
    exported.expect("DBX database export");
    assert!(progress
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event.status, ExportStatus::Done) && event.error_count == 0));
    let export_restore = replay(&state, "export", export_database, &path).await;
    save_json(&dir, "export-replay.json", &json!({"result": export_restore}));
    export_restore.expect("replay original DBX database export without rewriting");
    let export_actual = query(&state, "export", export_database, COMMENT_QUERY).await;
    save_json(&dir, "export-comments.json", &json!(export_actual));

    let selected_path = dir.join("selected-export.sql");
    let mut selected_request = request.clone();
    selected_request.export_id.push_str("-selected");
    selected_request.schema = later.into();
    selected_request.file_path = selected_path.display().to_string();
    selected_request.selected_objects =
        Some(vec![DatabaseExportSelectedObject { object_type: "VIEW".into(), name: "z_base".into(), signature: None }]);
    Box::pin(export_database_sql_core(&state, &selected_request, |_| {}))
        .await
        .map_err(|e| redact(&e))
        .expect("selected view export");
    if later != "public" {
        query(&state, "selected", &databases[3], &format!("CREATE SCHEMA {}", ident(later))).await;
    }
    replay(&state, "selected", &databases[3], &selected_path).await.expect("selected view replay");
    let selected_actual = query(&state, "selected", &databases[3], COMMENT_QUERY).await;
    let selected_expected: Vec<_> =
        expected.iter().filter(|row| row[0] == json!(later) && row[1] == json!("z_base")).cloned().collect();
    save_json(&dir, "selected-comments.json", &json!(selected_actual));
    assert_eq!(selected_actual, selected_expected, "selection retains only the requested view and its comments");
    let populated_query = "SELECT n.nspname, c.relname, c.relispopulated FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'm' ORDER BY n.nspname, c.relname";
    assert_eq!(
        query(&state, "source", source_database, populated_query).await,
        query(&state, "export", export_database, populated_query).await
    );

    let mut display_sql = String::new();
    for schema in &schemas {
        if *schema != "public" {
            display_sql.push_str(&format!("CREATE SCHEMA {};\n", ident(schema)));
        }
    }
    for (schema, name, kind) in &views {
        let source =
            Box::pin(get_object_source_core(&state, "source", source_database, schema, name, kind.clone(), None, None))
                .await
                .map_err(|error| redact(&error))
                .expect("object editor source");
        assert!(!source.source.contains("COMMENT ON"), "object editor source must stay definition-only");
        let ddl =
            Box::pin(get_table_display_ddl_core(&state, "source", source_database, schema, name, Some(kind.clone())))
                .await
                .map_err(|error| redact(&error))
                .expect("display DDL");
        display_sql.push_str(&ddl);
        display_sql.push_str(";\n");
    }
    let display_path = dir.join("display-ddl.sql");
    std::fs::write(&display_path, display_sql).unwrap();
    let display_restore = replay(&state, "display", display_database, &display_path).await;
    save_json(&dir, "display-replay.json", &json!({"result": display_restore}));
    display_restore.expect("replay DBX display DDL");
    let display_actual = query(&state, "display", display_database, COMMENT_QUERY).await;
    save_json(&dir, "display-comments.json", &json!(display_actual));
    save_json(
        &dir,
        "outcome.json",
        &json!({"export_matches": export_actual == expected, "display_matches": display_actual == expected}),
    );
    assert_eq!(
        export_actual,
        expected,
        "original DBX export must retain view and column comments; evidence={}",
        dir.display()
    );
    assert_eq!(display_actual, expected, "DBX display DDL must retain view and column comments");
    if std::env::var("DBX_LIVE_POSTGRES_COMMENT_PERMISSION_TEST").as_deref() == Ok("1") {
        Box::pin(permission_errors(&state, source_database, later, &selected_request, &dir)).await;
    }
}

// Opt-in for an isolated local superuser fixture only. The catalog ACL change is
// confined to the database this test just created, not template or shared databases.
async fn permission_errors(
    state: &Arc<AppState>,
    database: &str,
    schema: &str,
    request: &DatabaseExportRequest,
    dir: &Path,
) {
    query(state, "source", database, "REVOKE EXECUTE ON FUNCTION pg_catalog.col_description(oid, integer) FROM PUBLIC")
        .await;
    let mut restricted = config("restricted", database);
    let params = restricted.url_params.take().unwrap_or_default();
    restricted.url_params = Some(format!("{params}&options=-c%20role%3Dpg_read_all_data"));
    state.configs.write().await.insert("restricted".into(), restricted);
    let source = Box::pin(get_object_source_core(
        state,
        "restricted",
        database,
        schema,
        "z_base",
        ObjectSourceKind::View,
        None,
        None,
    ))
    .await
    .map_err(|e| redact(&e));
    source.expect("view definition remains readable despite inaccessible column comments");
    let ddl = Box::pin(get_table_display_ddl_core(
        state,
        "restricted",
        database,
        schema,
        "z_base",
        Some(ObjectSourceKind::View),
    ))
    .await
    .map_err(|e| redact(&e));
    let error = ddl.expect_err("display DDL must propagate comment metadata error");
    assert!(error.contains("permission denied"), "unexpected error: {error}");
    save_json(dir, "permission-display.json", &json!({"error": error}));
    for strict in [true, false] {
        let mut request = request.clone();
        request.connection_id = "restricted".into();
        request.export_id.push_str(if strict { "-strict" } else { "-lenient" });
        request.file_path =
            dir.join(if strict { "permission-strict.sql" } else { "permission-lenient.sql" }).display().to_string();
        request.fail_on_error = strict;
        let progress = Mutex::new(Vec::new());
        let result = Box::pin(export_database_sql_core(state, &request, |event| progress.lock().unwrap().push(event)))
            .await
            .map_err(|e| redact(&e));
        save_json(
            dir,
            if strict { "permission-strict.json" } else { "permission-lenient.json" },
            &json!({"result": result, "progress": progress.lock().unwrap().clone()}),
        );
        if strict {
            let error = result.expect_err("strict export must reject unreadable comments");
            assert!(
                error.contains("reading comments for view z_base") && error.contains("permission denied"),
                "unexpected error: {error}"
            );
        } else {
            result.expect("lenient export completes with explicit error");
            assert!(progress.lock().unwrap().iter().any(|event| matches!(event.status, ExportStatus::Done)
                && event.error_count == 1
                && event
                    .error_summary
                    .as_ref()
                    .is_some_and(|summary| summary.contains("reading comments for view z_base"))));
            let sql = std::fs::read_to_string(&request.file_path).unwrap();
            assert!(sql.contains("-- ERROR reading comments for view z_base"));
            assert!(sql.contains("CREATE OR REPLACE VIEW"));
        }
    }
}
