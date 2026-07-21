use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dbx_core::connection::AppState;
use dbx_core::db::postgres;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::query::execute_sql_statement;
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::storage::Storage;

fn live_postgres_config(
    id: &str,
    host: &str,
    port: u16,
    user: &str,
    password: &str,
    database: &str,
) -> ConnectionConfig {
    ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        db_type: DatabaseType::Postgres,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: host.to_string(),
        port,
        username: user.to_string(),
        password: password.to_string(),
        database: Some(database.to_string()),
        visible_databases: None,
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
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        database_info: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a writable PostgreSQL database"]
async fn live_postgres_query_result_export_uses_single_streamed_query() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let url = format!("postgresql://{user}:{password}@{host}:{port}/{database}");
    let setup_pool = postgres::connect(&url, Duration::from_secs(10)).await.expect("connect PostgreSQL");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_query_export_{}", &suffix[..8]);
    let setup = vec![
        format!("CREATE SCHEMA \"{schema}\""),
        format!(
            "CREATE OR REPLACE FUNCTION \"{schema}\".assert_no_limit_offset() RETURNS integer LANGUAGE plpgsql AS $$ \
             DECLARE q text; \
             BEGIN \
               SELECT query INTO q FROM pg_stat_activity WHERE pid = pg_backend_pid(); \
               IF q ~* '\\m(limit|offset)\\M' THEN \
                 RAISE EXCEPTION 'query was paginated: %', q; \
               END IF; \
               RETURN 1; \
             END; \
             $$"
        ),
    ];
    let cleanup = vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")];
    let _ = postgres::execute_batch(&setup_pool, &cleanup).await;
    postgres::execute_batch(&setup_pool, &setup).await.expect("create live test schema");

    let dir = std::env::temp_dir().join(format!("dbx-live-postgres-query-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-postgres-query-export";
    let config = live_postgres_config(connection_id, &host, port, &user, &password, &database);
    state.configs.write().await.insert(config.id.clone(), config);

    let file_path = dir.join("result.csv");
    let sql =
        format!("SELECT i, \"{schema}\".assert_no_limit_offset() AS marker FROM generate_series(1, 2050) AS s(i)");
    let request = QueryResultExportRequest {
        export_id: format!("live-postgres-query-export-{suffix}"),
        connection_id: connection_id.to_string(),
        database: database.clone(),
        schema: Some(schema.clone()),
        sql: sql.clone(),
        query_base_sql: sql,
        database_type: DatabaseType::Postgres,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "csv".to_string(),
        include_sql_sheet: false,
        page_size: 100,
        row_limit: None,
        total_rows: None,
        timeout_secs: Some(30),
        keyset_optimization_enabled: true,
        client_session_id: None,
        execution_id: Some(format!("live-postgres-query-export-{suffix}")),
        date_time_format: None,
    };
    let done_seen = AtomicBool::new(false);
    let result = export_query_result_core(&state, &request, None, |progress| {
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;

    let cleanup_result = postgres::execute_batch(&setup_pool, &cleanup).await;
    let csv = std::fs::read_to_string(&file_path).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);

    result.expect("export query result");
    cleanup_result.expect("cleanup live test schema");
    assert!(done_seen.load(Ordering::Relaxed));
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("\"i\",\"marker\""), "csv={csv:?}");
    assert!(csv.contains("\"1\",\"1\""));
    assert!(csv.contains("\"2050\",\"1\""));
    assert_eq!(csv.lines().count(), 2051, "unexpected csv row count");
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* env vars for a 650,000-row XLSX export"]
async fn live_postgres_xlsx_export_can_outlive_query_timeout_while_rows_keep_arriving() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-postgres-query-export-timeout-{suffix}");
    let config = live_postgres_config(&connection_id, &host, port, &user, &password, &database);
    let dir = std::env::temp_dir().join(format!("dbx-live-postgres-query-export-timeout-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);

    let file_path = dir.join("result.xlsx");
    let sql = "SELECT i AS id, repeat('x', 64) AS payload FROM generate_series(1, 650000) AS source(i)";
    let request = QueryResultExportRequest {
        export_id: format!("live-postgres-query-export-timeout-{suffix}"),
        connection_id,
        database,
        schema: Some("public".to_string()),
        sql: sql.to_string(),
        query_base_sql: sql.to_string(),
        database_type: DatabaseType::Postgres,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "xlsx".to_string(),
        include_sql_sheet: false,
        page_size: 10_000,
        row_limit: None,
        total_rows: Some(650_000),
        timeout_secs: Some(1),
        keyset_optimization_enabled: false,
        client_session_id: None,
        execution_id: Some(format!("live-postgres-query-export-timeout-{suffix}")),
        date_time_format: None,
    };
    let rows_exported = AtomicU64::new(0);
    let done_seen = AtomicBool::new(false);
    let started_at = Instant::now();
    let result = export_query_result_core(&state, &request, None, |progress| {
        rows_exported.store(progress.rows_exported, Ordering::Relaxed);
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;
    let elapsed = started_at.elapsed();
    let file_len = std::fs::metadata(&file_path).map(|metadata| metadata.len()).unwrap_or(0);
    let _ = std::fs::remove_dir_all(dir);

    result.expect("stream 650,000 PostgreSQL rows to XLSX");
    assert!(elapsed > Duration::from_secs(1), "export should outlive configured timeout: {elapsed:?}");
    assert_eq!(rows_exported.load(Ordering::Relaxed), 650_000);
    assert!(done_seen.load(Ordering::Relaxed));
    assert!(file_len > 1_000_000);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_* env vars"]
async fn live_postgres_stream_still_times_out_without_progress_and_recovers() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-postgres-query-export-stall-{suffix}");
    let config = live_postgres_config(&connection_id, &host, port, &user, &password, &database);
    let dir = std::env::temp_dir().join(format!("dbx-live-postgres-query-export-stall-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config);

    let file_path = dir.join("result.csv");
    let sql = "SELECT pg_sleep(5), 1 AS id";
    let request = QueryResultExportRequest {
        export_id: format!("live-postgres-query-export-stall-{suffix}"),
        connection_id: connection_id.clone(),
        database: database.clone(),
        schema: Some("public".to_string()),
        sql: sql.to_string(),
        query_base_sql: sql.to_string(),
        database_type: DatabaseType::Postgres,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "csv".to_string(),
        include_sql_sheet: false,
        page_size: 100,
        row_limit: None,
        total_rows: Some(1),
        timeout_secs: Some(1),
        keyset_optimization_enabled: false,
        client_session_id: None,
        execution_id: Some(format!("live-postgres-query-export-stall-{suffix}")),
        date_time_format: None,
    };
    let started_at = Instant::now();
    let result = export_query_result_core(&state, &request, None, |_| {}).await;
    let elapsed = started_at.elapsed();
    let recovery = execute_sql_statement(&state, &connection_id, &database, "SELECT 1 AS id", None, None).await;
    let _ = std::fs::remove_dir_all(dir);

    assert_eq!(result, Err("Query timed out after 1 seconds".to_string()));
    assert!(elapsed < Duration::from_secs(5), "stalled query was not cancelled promptly: {elapsed:?}");
    assert_eq!(recovery.expect("PostgreSQL connection should recover after export timeout").rows.len(), 1);
}
