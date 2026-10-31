//! PostGIS database exports must survive the actual SQL-file restore path.
//! Requires DBX_LIVE_POSTGIS_HOST/PORT/USER/PASSWORD. Uses uniquely named databases
//! and retains them and evidence files for inspection; run only on a disposable server.
use dbx_core::connection::AppState;
use dbx_core::database_export::{
    begin_database_backup_snapshot_core, export_database_sql_core, DatabaseExportRequest, SqlInsertDialect,
};
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::{execute_sql_statement, rollback_manual_transaction};
use dbx_core::sql::SqlFileRequest;
use std::sync::Arc;

fn config(id: &str, database: &str) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({
        "id": id, "name": id, "db_type": DatabaseType::Postgres,
        "host": std::env::var("DBX_LIVE_POSTGIS_HOST").expect("DBX_LIVE_POSTGIS_HOST"),
        "port": std::env::var("DBX_LIVE_POSTGIS_PORT").unwrap_or_else(|_| "5432".into()).parse::<u16>().unwrap(),
        "username": std::env::var("DBX_LIVE_POSTGIS_USER").expect("DBX_LIVE_POSTGIS_USER"),
        "password": std::env::var("DBX_LIVE_POSTGIS_PASSWORD").unwrap_or_default(),
        "database": database, "ssl": false, "connect_timeout_secs": 10,
        "query_timeout_secs": 30, "idle_timeout_secs": 60, "keepalive_interval_secs": 0
    }))
    .unwrap()
}

#[tokio::test]
#[ignore = "requires a disposable PostGIS server"]
async fn postgres_database_export_preserves_geometry_paged() {
    round_trip(false, SqlInsertDialect::Source, "public").await;
}

#[tokio::test]
#[ignore = "requires a disposable PostGIS server"]
async fn postgres_database_export_preserves_geometry_snapshot() {
    round_trip(true, SqlInsertDialect::Source, "public").await;
}

#[tokio::test]
#[ignore = "requires a disposable PostGIS server"]
async fn postgres_database_export_standard_sql_preserves_geometry() {
    round_trip(false, SqlInsertDialect::Standard, "public").await;
}

#[tokio::test]
#[ignore = "requires a disposable PostGIS server"]
async fn postgres_database_export_preserves_geometry_with_nonpublic_extension() {
    round_trip(true, SqlInsertDialect::Source, "spatial").await;
}

async fn round_trip(snapshot: bool, dialect: SqlInsertDialect, extension_schema: &str) {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source = format!("dbx13779_src_{}", &suffix[..10]);
    let target = format!("dbx13779_dst_{}", &suffix[..10]);
    let mode = if snapshot { "snapshot" } else { "paged" };
    let root =
        std::env::var_os("DBX_POSTGIS_EVIDENCE_DIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = root.join(format!("postgis-{mode}-{}", &suffix[..10]));
    std::fs::create_dir_all(&dir).unwrap();
    let state =
        Arc::new(AppState::new(dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.unwrap()));
    state.configs.write().await.insert("admin".into(), config("admin", "postgres"));
    for db in [&source, &target] {
        execute_sql_statement(&state, "admin", "postgres", &format!("CREATE DATABASE \"{db}\""), None, None)
            .await
            .unwrap();
        state.configs.write().await.insert(db.clone(), config(db, db));
        if extension_schema != "public" {
            execute_sql_statement(&state, db, db, &format!("CREATE SCHEMA {extension_schema}"), None, None)
                .await
                .unwrap();
        }
        execute_sql_statement(
            &state,
            db,
            db,
            &format!("CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA {extension_schema}"),
            None,
            None,
        )
        .await
        .unwrap();
    }
    eprintln!("PostGIS fixture: mode={mode} source={source} target={target} evidence={}", dir.display());
    std::fs::write(dir.join("databases.txt"), format!("source={source}\ntarget={target}\n")).unwrap();
    for sql in [
        "CREATE TABLE public.lines (id int PRIMARY KEY, label text, geom geometry(LineStringZ,4326))",
        "INSERT INTO public.lines VALUES (1,'high precision',ST_GeomFromEWKT('SRID=4326;LINESTRING Z(40434711.097604826 3552467.696142269 -28.283588989257815,40434715.98553732 3552466.91647378 -27.51132976)')),(2,'null',NULL),(3,'empty',ST_GeomFromEWKT('SRID=4326;LINESTRING Z EMPTY'))",
        "CREATE TABLE public.mixed (id int PRIMARY KEY, geom geometry)",
        "INSERT INTO public.mixed VALUES (1,ST_GeomFromEWKT('SRID=4326;POINT(1.1234567890123457 2)')),(2,ST_GeomFromEWKT('SRID=3857;POINT(3 4)')),(3,ST_GeomFromEWKT('POINT(5 6)')),(4,ST_GeomFromEWKT('SRID=4326;POINT M(1 2 3)')),(5,ST_GeomFromEWKT('SRID=4326;POINT ZM(1 2 3 4)')),(6,ST_GeomFromEWKT('SRID=4326;CIRCULARSTRING(0 0,1 1,2 0)')),(7,NULL)",
        "CREATE TABLE public.offset_rows AS SELECT * FROM public.mixed",
        "CREATE TABLE public.spatial_keys (id int, geom geometry(Point,4326) PRIMARY KEY)",
        "INSERT INTO public.spatial_keys VALUES (1,ST_GeomFromEWKT('SRID=4326;POINT(1 2)')),(2,ST_GeomFromEWKT('SRID=4326;POINT(3 4)')),(3,ST_GeomFromEWKT('SRID=4326;POINT(5 6)'))",
        "CREATE TABLE public.places (id int PRIMARY KEY, geom geography(Point,4326))",
        "INSERT INTO public.places VALUES (1,ST_GeomFromEWKT('SRID=4326;POINT(116 39)')::geography),(2,NULL)",
    ] {
        let sql = qualify_postgis(sql, extension_schema);
        execute_sql_statement(&state, &source, &source, &sql, None, None).await.expect("fixture");
    }
    for table in ["lines", "mixed", "offset_rows", "places", "spatial_keys"] {
        let expected =
            execute_sql_statement(&state, &source, &source, &comparison_sql(table, extension_schema), None, None)
                .await
                .unwrap();
        std::fs::write(dir.join(format!("{table}-expected.json")), serde_json::to_vec_pretty(&expected.rows).unwrap())
            .unwrap();
    }
    let session = if snapshot {
        Some(begin_database_backup_snapshot_core(&state, &source, &source).await.unwrap())
    } else {
        None
    };
    let path = dir.join("export.sql");
    tokio::time::timeout(
        std::time::Duration::from_secs(30),
        export_database_sql_core(
            &state,
            &DatabaseExportRequest {
                export_id: format!("postgis-{suffix}"),
                connection_id: source.clone(),
                database: source.clone(),
                schema: "public".into(),
                file_path: path.display().to_string(),
                selected_tables: vec![
                    "lines".into(),
                    "mixed".into(),
                    "offset_rows".into(),
                    "places".into(),
                    "spatial_keys".into(),
                ],
                excluded_tables: vec![],
                include_structure: true,
                include_data: true,
                include_objects: false,
                include_create_database: false,
                drop_table_if_exists: false,
                omit_auto_increment: false,
                preserve_original_language: false,
                fail_on_error: true,
                prevent_overwrite: true,
                output_compression: Default::default(),
                insert_dialect: dialect,
                insert_mode: Default::default(),
                snapshot_session_id: session.as_ref().map(|s| s.session_id.clone()),
                batch_size: 2,
                split_max_mb: None,
            },
            |_| {},
        ),
    )
    .await
    .expect("export must terminate across spatial keyset pages")
    .expect("export real database SQL");
    if let Some(session) = session {
        rollback_manual_transaction(&state, &session.session_id).await.unwrap();
    }
    let restore = dbx_core::sql_file_import::execute_sql_file_path(
        &state,
        &SqlFileRequest {
            txn_session_id: None,
            execution_id: format!("restore-{suffix}"),
            connection_id: target.clone(),
            database: target.clone(),
            schema: Some("public".into()),
            file_path: path.display().to_string(),
            continue_on_error: false,
            selected_tables: None,
            part_cooldown_ms: 0,
            skip_relational_constraints: false,
            failure_log_enabled: true,
            resolve_includes: false,
            encoding: Default::default(),
        },
        &path,
        tokio_util::sync::CancellationToken::new(),
        std::time::Instant::now(),
        |_| {},
    )
    .await;
    std::fs::write(dir.join("restore.txt"), format!("{restore:?}")).unwrap();
    assert!(restore.is_ok(), "actual exported SQL restore failed: {restore:?}");
    for table in ["lines", "mixed", "offset_rows", "places", "spatial_keys"] {
        let sql = comparison_sql(table, extension_schema);
        let expected = execute_sql_statement(&state, &source, &source, &sql, None, None).await.unwrap();
        let actual = execute_sql_statement(&state, &target, &target, &sql, None, None).await.unwrap();
        std::fs::write(dir.join(format!("{table}-expected.json")), serde_json::to_vec_pretty(&expected.rows).unwrap())
            .unwrap();
        std::fs::write(dir.join(format!("{table}-actual.json")), serde_json::to_vec_pretty(&actual.rows).unwrap())
            .unwrap();
        assert_eq!(expected.rows, actual.rows, "lossless restore of {table} in {mode}");
    }
}

fn comparison_sql(table: &str, extension_schema: &str) -> String {
    let label = if table == "lines" { ", label" } else { "" };
    qualify_postgis(&format!("SELECT id{label}, geom IS NULL, ST_SRID(geom::geometry), ST_NDims(geom::geometry), ST_IsEmpty(geom::geometry), encode(ST_AsEWKB(geom::geometry,'NDR'),'hex') FROM public.{table} ORDER BY id"), extension_schema)
}

fn qualify_postgis(sql: &str, schema: &str) -> String {
    sql.replace("geometry", &format!("{schema}.geometry"))
        .replace("geography", &format!("{schema}.geography"))
        .replace("ST_", &format!("{schema}.ST_"))
}
