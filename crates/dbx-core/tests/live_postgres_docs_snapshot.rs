// Gating and connection setup copied from live_postgres_query_result_export.rs.

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
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
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
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
        redis_database_aliases: Default::default(),
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
        show_system_schemas: false,
        database_info: None,
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_POSTGRES_HOST/PORT/USER/PASSWORD/DATABASE pointing at a live db"]
async fn collects_a_snapshot_and_serializes_valid_dbml() {
    let host = std::env::var("DBX_LIVE_POSTGRES_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_POSTGRES_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(5432);
    let user = std::env::var("DBX_LIVE_POSTGRES_USER").unwrap_or_else(|_| "postgres".to_string());
    let password = std::env::var("DBX_LIVE_POSTGRES_PASSWORD").unwrap_or_default();
    let database = std::env::var("DBX_LIVE_POSTGRES_DATABASE").unwrap_or_else(|_| "postgres".to_string());

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-postgres-docs-snapshot-{}", &suffix[..8]);
    let config = live_postgres_config(&connection_id, &host, port, &user, &password, &database);

    let dir = std::env::temp_dir().join(format!("dbx-live-postgres-docs-snapshot-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    state.configs.write().await.insert(config.id.clone(), config.clone());

    let options = dbx_core::docs::CollectOptions {
        database: database.clone(),
        schemas: vec!["public".to_string()],
        tables: vec![],
        project_name: "live-test".to_string(),
    };

    let snapshot = dbx_core::docs::collect_snapshot(
        &state,
        &config,
        &options,
        &|_progress| {},
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await;

    let _ = std::fs::remove_dir_all(&dir);

    let snapshot = snapshot.expect("collect");

    assert_eq!(snapshot.format_version, 1);
    assert!(!snapshot.tables.is_empty(), "expected at least one table");

    let dbml = dbx_core::docs::to_dbml(&snapshot);
    println!("{}", dbml.text);

    assert!(dbml.text.starts_with("Project "), "got:\n{}", dbml.text);

    for table in &snapshot.tables {
        assert!(
            dbml.text.contains(&format!("Table {}", table.name))
                || dbml.text.contains(&format!("Table {}.{}", table.schema.clone().unwrap_or_default(), table.name)),
            "table {} missing from DBML",
            table.name
        );
    }

    // Braces must balance, or the DBML is unparseable.
    let opens = dbml.text.matches('{').count();
    let closes = dbml.text.matches('}').count();
    assert_eq!(opens, closes, "unbalanced braces in:\n{}", dbml.text);

    assert!(dbml.text.ends_with('\n'), "DBML document should end with a newline:\n{}", dbml.text);
}
