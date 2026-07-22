use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::storage::Storage;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn live_sqlserver_config(id: &str, database: &str) -> dbx_core::models::connection::ConnectionConfig {
    dbx_core::models::connection::ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        db_type: DatabaseType::SqlServer,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        username: std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        password: std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
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
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlserver_xlsx_export_can_outlive_query_timeout_while_rows_keep_arriving() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-xlsx-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-sqlserver-xlsx-export";
    let pool_key = format!("{connection_id}:{database}");
    state.configs.write().await.insert(connection_id.to_string(), live_sqlserver_config(connection_id, &database));
    state.connections.write().await.insert(pool_key, PoolKind::SqlServer(Arc::new(tokio::sync::Mutex::new(client))));

    let file_path = dir.join("result.xlsx");
    let sql = "WITH numbers AS (\
        SELECT TOP (130000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS id \
        FROM sys.all_objects AS first_source CROSS JOIN sys.all_objects AS second_source\
    ) SELECT id, REPLICATE(N'x', 64) AS payload FROM numbers ORDER BY id";
    let request = QueryResultExportRequest {
        export_id: format!("live-sqlserver-xlsx-{suffix}"),
        connection_id: connection_id.to_string(),
        database: database.clone(),
        schema: Some("dbo".to_string()),
        sql: sql.to_string(),
        query_base_sql: sql.to_string(),
        setup_sql: Vec::new(),
        database_type: DatabaseType::SqlServer,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "xlsx".to_string(),
        include_sql_sheet: false,
        page_size: 5000,
        row_limit: Some(200_000),
        total_rows: Some(130_000),
        timeout_secs: Some(1),
        keyset_optimization_enabled: true,
        client_session_id: None,
        execution_id: Some(format!("live-sqlserver-xlsx-{suffix}")),
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

    result.expect("stream 130,000 rows to XLSX");
    assert!(elapsed > Duration::from_secs(1), "export should outlive configured timeout: {elapsed:?}");
    assert_eq!(rows_exported.load(Ordering::Relaxed), 130_000);
    assert!(done_seen.load(Ordering::Relaxed));
    assert!(std::fs::metadata(&file_path).unwrap().len() > 1_000_000);

    let _ = std::fs::remove_dir_all(dir);
}
