//! Cross-dialect transfer probes: SQLite source -> SQL Server target.
//!
//! SQLite's `INTEGER` affinity is a 64-bit signed integer, while the transfer
//! type mapper used to send any `int`-family source type to SQL Server `INT`
//! (32-bit). A user report shows the resulting T-SQL error verbatim:
//! `转换 nvarchar 值 '2098620070434758658' 时溢出了整数列。` (code 248).

use dbx_core::connection::AppState;
use dbx_core::models::connection::{ConnectionConfig, DatabaseType};
use dbx_core::transfer::{
    transfer_table, TransferContent, TransferMode, TransferOwnershipPolicy, TransferRequest, TransferTableNameCase,
};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

fn sqlite_config(id: &str, path: &str) -> ConnectionConfig {
    ConnectionConfig {
        oracle_oci_nls_lang: None,
        oracle_oci_tns_admin: None,
        docs_notes_path: None,
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
        db_type: DatabaseType::Sqlite,
        driver_profile: None,
        driver_label: None,
        url_params: None,
        agent_java_options: Vec::new(),
        host: path.to_string(),
        port: 0,
        username: String::new(),
        password: String::new(),
        database: None,
        default_schema: None,
        visible_databases: None,
        visible_database_patterns: None,
        visible_schemas: None,
        attached_databases: Vec::new(),
        init_script: None,
        color: None,
        transport_layers: Vec::new(),
        connect_timeout_secs: 15,
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
        redis_key_templates: Vec::new(),
        redis_key_filter: None,
        redis_key_grouping: None,
        etcd_endpoints: String::new(),
        gbase_server: String::new(),
        informix_server: String::new(),
        external_config: None,
        plugin_id: None,
        plugin_connection_provider: None,
        plugin_connection_type: None,
        connection_secrets: Default::default(),
        jdbc_driver_class: None,
        jdbc_driver_paths: Vec::new(),
        one_time: false,
        save_password: true,
        read_only: false,
        is_production: false,
        production_databases: vec![],
        show_system_schemas: false,
        sidebar_auto_load_all_tables: false,
        database_info: None,
    }
}

fn sqlserver_config(id: &str, database: &str) -> ConnectionConfig {
    let mut config = sqlite_config(id, "");
    config.db_type = DatabaseType::SqlServer;
    config.host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    config.port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    config.username = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    config.password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    config.database = Some(database.to_string());
    config
}

async fn sqlserver_connect(database: &str) -> dbx_core::db::sqlserver::SqlServerClient {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(database), None, Duration::from_secs(20))
        .await
        .expect("connect SQL Server")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at SQL Server"]
async fn live_sqlite_to_sqlserver_keeps_sixty_four_bit_integer_values() {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let target_db = format!("dbx_sqlite_int_dst_{}", &suffix[..12]);
    let sqlite_connection_id = format!("live-sqlite-source-{suffix}");
    let sqlserver_connection_id = format!("live-sqlserver-target-{suffix}");
    let table = "daq_standard_setting";

    let mut master = sqlserver_connect("master").await;
    dbx_core::db::sqlserver::execute_batch(&mut master, &format!("CREATE DATABASE [{target_db}];"))
        .await
        .expect("create target database");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlite-int-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create temp directory");
    let sqlite_path = dir.join("source.sqlite");
    let sqlite_path = sqlite_path.to_string_lossy().into_owned();

    let sqlite_pool =
        dbx_core::db::sqlite::connect_path_create_if_missing(&sqlite_path).await.expect("open sqlite source");
    dbx_core::db::sqlite::execute_query(
        &sqlite_pool,
        &format!(
            "CREATE TABLE {table} (id INTEGER NOT NULL PRIMARY KEY, amount INTEGER NOT NULL, label TEXT); \
             INSERT INTO {table} (id, amount, label) VALUES (1, 2098620070434758658, 'snowflake');"
        ),
    )
    .await
    .expect("seed sqlite source table");

    let storage = dbx_core::persistence::test_storage::open(&dir.join("storage.db")).await.expect("open storage");
    let state = Arc::new(AppState::new(storage));
    state
        .configs
        .write()
        .await
        .insert(sqlite_connection_id.clone(), sqlite_config(&sqlite_connection_id, &sqlite_path));
    state
        .configs
        .write()
        .await
        .insert(sqlserver_connection_id.clone(), sqlserver_config(&sqlserver_connection_id, &target_db));
    let source_pool_key =
        state.get_or_create_pool(&sqlite_connection_id, Some("main")).await.expect("sqlite source pool");
    let target_pool_key =
        state.get_or_create_pool(&sqlserver_connection_id, Some(&target_db)).await.expect("target pool");

    let request = TransferRequest {
        transfer_id: format!("live-sqlite-int-{suffix}"),
        source_connection_id: sqlite_connection_id.clone(),
        source_database: "main".to_string(),
        source_schema: "main".to_string(),
        source_catalog: None,
        target_connection_id: sqlserver_connection_id.clone(),
        target_database: target_db.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
        tables: vec![table.to_string()],
        create_table: true,
        drop_target_before_create: false,
        drop_target_confirmed: false,
        content: TransferContent::default(),
        objects: Vec::new(),
        mode: TransferMode::Append,
        target_table_name_case: TransferTableNameCase::Preserve,
        quote_target_column_names: true,
        ownership_policy: TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };

    let test_result = async {
        let transferred = transfer_table(
            &state,
            &request,
            table,
            0,
            &DatabaseType::Sqlite,
            &DatabaseType::SqlServer,
            &source_pool_key,
            &target_pool_key,
            &HashMap::new(),
            &mut Vec::new(),
            None,
            |_| {},
        )
        .await?;
        assert_eq!(transferred, 1);

        let mut target_client = sqlserver_connect(&target_db).await;
        let rows = dbx_core::db::sqlserver::execute_query(
            &mut target_client,
            &format!("SELECT id, amount, label FROM dbo.[{table}]"),
        )
        .await
        .map_err(|error| format!("read transferred rows: {error}"))?;
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0][1].as_str(), Some("2098620070434758658"));
        Ok::<_, String>(())
    }
    .await;

    let cleanup = dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("ALTER DATABASE [{target_db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{target_db}];"),
    )
    .await;
    let _ = std::fs::remove_dir_all(dir);
    cleanup.expect("drop target database");
    test_result.expect("SQLite INTEGER values must survive a transfer into SQL Server");
}
