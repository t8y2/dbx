use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::execute_sql_file_content;
use dbx_core::storage::Storage;
use dbx_core::table_structure_sql::{
    build_table_structure_change_sql, ColumnInfo, EditableStructureColumn, TableStructureSqlOptions,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

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
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_execute_query_creates_schema() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_schema_{suffix}");
    let create = format!("CREATE SCHEMA [{schema}];");
    let verify = format!("SELECT SCHEMA_ID(N'{schema}') AS schema_id;");
    let cleanup = format!("DROP SCHEMA [{schema}];");

    let result = dbx_core::db::sqlserver::execute_query(&mut client, &create).await;
    let verify_result = dbx_core::db::sqlserver::execute_query(&mut client, &verify).await;
    let schemas = dbx_core::db::sqlserver::list_schemas(&mut client).await;
    let _ = dbx_core::db::sqlserver::execute_query(&mut client, &cleanup).await;

    result.expect("create schema through execute_query");
    let verify_result = verify_result.expect("verify created schema");
    assert_eq!(verify_result.rows.len(), 1);
    assert!(verify_result.rows[0][0].as_i64().is_some(), "schema_id row={:?}", verify_result.rows[0]);
    assert!(schemas.expect("list schemas").contains(&schema));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_table_structure_default_changes_drop_existing_constraints() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = format!("dbx_default_{suffix}");
    let table = "products";
    let create_schema = format!("CREATE SCHEMA [{schema}];");
    let create_table = format!(
        "\
        CREATE TABLE [{schema}].[{table}] (\
            [sku] NVARCHAR(64) NULL CONSTRAINT [DF_{schema}_{table}_sku_old] DEFAULT N'old sku',\
            [active] BIT NOT NULL CONSTRAINT [DF_{schema}_{table}_active_old] DEFAULT 0\
        );"
    );
    dbx_core::db::sqlserver::execute_query(&mut client, &create_schema).await.expect("create live test schema");
    dbx_core::db::sqlserver::execute_query(&mut client, &create_table).await.expect("create table with defaults");

    let mut sku = structure_column("sku", "nvarchar(64)", true, "new sku", Some("'old sku'"));
    let mut active = structure_column("active", "bit", false, "1", Some("0"));
    sku.original_position = Some(0);
    active.original_position = Some(1);
    let result = build_table_structure_change_sql(TableStructureSqlOptions {
        database_type: Some(DatabaseType::SqlServer),
        schema: Some(schema.clone()),
        table_name: table.to_string(),
        columns: vec![sku, active],
        indexes: Vec::new(),
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        table_comment: None,
        original_table_comment: None,
    });
    assert_eq!(result.warnings, Vec::<String>::new());
    assert_eq!(result.statements.len(), 4);

    let execution_result = async {
        for statement in &result.statements {
            dbx_core::db::sqlserver::execute_query(&mut client, statement).await?;
        }
        Ok::<(), String>(())
    }
    .await;

    let verify_sql = format!(
        "\
        SELECT c.name, dc.definition \
        FROM sys.default_constraints AS dc \
        JOIN sys.columns AS c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id \
        WHERE dc.parent_object_id = OBJECT_ID(N'[{schema}].[{table}]') \
        ORDER BY c.name;"
    );
    let verify_result = dbx_core::db::sqlserver::execute_query(&mut client, &verify_sql).await;
    let cleanup = format!("DROP TABLE IF EXISTS [{schema}].[{table}]; DROP SCHEMA IF EXISTS [{schema}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;

    execution_result.expect("execute generated default constraint SQL");
    let verify_result = verify_result.expect("verify changed defaults");
    assert_eq!(verify_result.rows.len(), 2, "rows={:?}", verify_result.rows);
    assert_eq!(verify_result.rows[0][0], serde_json::json!("active"));
    assert_eq!(verify_result.rows[0][1], serde_json::json!("((1))"));
    assert_eq!(verify_result.rows[1][0], serde_json::json!("sku"));
    assert_eq!(verify_result.rows[1][1], serde_json::json!("('new sku')"));
}

fn structure_column(
    name: &str,
    data_type: &str,
    is_nullable: bool,
    default_value: &str,
    original_default: Option<&str>,
) -> EditableStructureColumn {
    EditableStructureColumn {
        id: name.to_string(),
        name: name.to_string(),
        data_type: data_type.to_string(),
        is_nullable,
        default_value: default_value.to_string(),
        comment: String::new(),
        is_primary_key: false,
        extra: None,
        original: Some(ColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            is_nullable,
            column_default: original_default.map(str::to_string),
            is_primary_key: false,
            extra: None,
            comment: None,
            ..Default::default()
        }),
        original_position: None,
        marked_for_drop: false,
        character_set: String::new(),
        collation: String::new(),
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_stream_first_result_set_exports_cte_query_rows() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbx_stream_export_{suffix}");
    let setup = format!(
        "\
        CREATE TABLE [dbo].[{table}] (id INT NOT NULL, name NVARCHAR(64) NULL);\
        INSERT INTO [dbo].[{table}] (id, name) VALUES (2, N'beta'), (1, N'alpha');"
    );
    dbx_core::db::sqlserver::execute_batch(&mut client, &setup).await.expect("create live test rows");

    let sql = format!(
        "\
        WITH ranked AS (\
            SELECT id, name, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM [dbo].[{table}]\
        )\
        SELECT id, name FROM ranked WHERE rn <= 2 ORDER BY id"
    );
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let result = dbx_core::db::sqlserver::stream_first_result_set(&mut client, &sql, None, None, |item| {
        match item {
            dbx_core::db::sqlserver::SqlServerStreamItem::Columns(stream_columns) => {
                columns = stream_columns.to_vec();
            }
            dbx_core::db::sqlserver::SqlServerStreamItem::Row(row) => {
                rows.push(row.to_vec());
            }
        }
        Ok(())
    })
    .await;

    let cleanup = format!("DROP TABLE [dbo].[{table}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;

    let summary = result.expect("stream first result set");
    assert_eq!(summary.columns, vec!["id".to_string(), "name".to_string()]);
    assert_eq!(summary.rows_exported, 2);
    assert_eq!(columns, summary.columns);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][0], serde_json::json!(1));
    assert_eq!(rows[0][1], serde_json::json!("alpha"));
    assert_eq!(rows[1][0], serde_json::json!(2));
    assert_eq!(rows[1][1], serde_json::json!("beta"));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_query_result_export_streams_cte_query_to_csv() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut setup_client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");
    let export_client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect export SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let table = format!("dbx_query_export_{suffix}");
    let setup = format!(
        "\
        CREATE TABLE [dbo].[{table}] (id INT NOT NULL, name NVARCHAR(64) NULL);\
        INSERT INTO [dbo].[{table}] (id, name) VALUES (2, N'beta'), (1, N'alpha');"
    );
    dbx_core::db::sqlserver::execute_batch(&mut setup_client, &setup).await.expect("create live test rows");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-export-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-sqlserver-export";
    let pool_key = format!("{connection_id}:{database}");
    state
        .connections
        .write()
        .await
        .insert(pool_key, PoolKind::SqlServer(std::sync::Arc::new(tokio::sync::Mutex::new(export_client))));

    let file_path = dir.join("result.csv");
    let sql = format!(
        "\
        WITH ranked AS (\
            SELECT id, name, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM [dbo].[{table}]\
        )\
        SELECT id, name FROM ranked WHERE rn <= 2 ORDER BY id"
    );
    let request = QueryResultExportRequest {
        export_id: format!("live-sqlserver-export-{suffix}"),
        connection_id: connection_id.to_string(),
        database: database.clone(),
        schema: Some("dbo".to_string()),
        sql: sql.clone(),
        query_base_sql: sql,
        database_type: DatabaseType::SqlServer,
        use_agent_cursor: false,
        file_path: file_path.to_string_lossy().to_string(),
        format: "csv".to_string(),
        include_sql_sheet: false,
        page_size: 1,
        row_limit: None,
        total_rows: None,
        timeout_secs: Some(10),
        keyset_optimization_enabled: true,
        client_session_id: None,
        execution_id: Some(format!("live-sqlserver-export-{suffix}")),
    };
    let done_seen = AtomicBool::new(false);
    let result = export_query_result_core(&state, &request, None, |progress| {
        if matches!(progress.status, ExportStatus::Done) {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await;

    let cleanup = format!("DROP TABLE [dbo].[{table}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut setup_client, &cleanup).await;
    let csv = std::fs::read_to_string(&file_path).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);

    result.expect("export query result");
    assert!(done_seen.load(Ordering::Relaxed));
    assert!(csv.starts_with('\u{feff}'));
    assert!(csv.contains("\"id\",\"name\""), "csv={csv:?}");
    assert!(csv.contains("\"1\",\"alpha\""));
    assert!(csv.contains("\"2\",\"beta\""));
    assert!(!csv.contains("\n\n"));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_sql_file_import_executes_go_batches() {
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
    let table = format!("dbx_sql_file_{suffix}");
    let procedure = format!("dbx_sql_file_proc_{suffix}");
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-file-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-sqlserver-file";
    let mut config = live_sqlserver_config(connection_id, &database);
    config.host = host;
    config.port = port;
    config.username = user;
    config.password = password;
    state.configs.write().await.insert(connection_id.to_string(), config);
    state.connections.write().await.insert(
        format!("{connection_id}:{database}"),
        PoolKind::SqlServer(std::sync::Arc::new(tokio::sync::Mutex::new(client))),
    );

    let script = format!(
        "CREATE TABLE [dbo].[{table}] (id INT NOT NULL);\n\
         GO\n\
         INSERT INTO [dbo].[{table}] (id) VALUES (1);\n\
         GO\n\
         CREATE PROCEDURE [dbo].[{procedure}] AS\n\
         BEGIN\n\
             SELECT COUNT(*) AS item_count FROM [dbo].[{table}];\n\
         END\n\
         GO"
    );
    let request = SqlFileRequest {
        execution_id: format!("live-sqlserver-file-{suffix}"),
        connection_id: connection_id.to_string(),
        database: database.clone(),
        file_path: "fixture.sql".to_string(),
        continue_on_error: false,
    };
    let done_seen = AtomicBool::new(false);

    execute_sql_file_content(&state, &request, &script, CancellationToken::new(), Instant::now(), |progress| {
        if progress.status == SqlFileStatus::Done {
            done_seen.store(true, Ordering::Relaxed);
        }
    })
    .await
    .expect("execute SQL Server file with GO batches");

    let pool_key = format!("{connection_id}:{database}");
    let connections = state.connections.read().await;
    let PoolKind::SqlServer(client) = connections.get(&pool_key).expect("SQL Server pool") else {
        panic!("expected SQL Server pool");
    };
    let mut client = client.lock().await;
    let rows = dbx_core::db::sqlserver::execute_query(&mut client, &format!("EXEC [dbo].[{procedure}]")).await;
    let cleanup = format!("DROP PROCEDURE [dbo].[{procedure}]; DROP TABLE [dbo].[{table}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;
    drop(client);
    drop(connections);
    let _ = std::fs::remove_dir_all(&dir);

    assert!(done_seen.load(Ordering::Relaxed));
    let rows = rows.expect("execute imported procedure");
    assert_eq!(rows.rows.first().and_then(|row| row.first()), Some(&serde_json::json!(1)));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_transfer_table_skips_rowversion_insert_column() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let target_database = std::env::var("DBX_LIVE_SQLSERVER_TARGET_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut setup_client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");
    let mut target_client = dbx_core::db::sqlserver::connect(
        &host,
        port,
        &user,
        &password,
        Some(&target_database),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect target SQL Server database");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let source_table = format!("dbx_rowversion_src_{suffix}");
    let target_table = source_table.to_uppercase();
    let cleanup_source = format!("DROP TABLE IF EXISTS [dbo].[{source_table}];");
    let cleanup_target = format!("DROP TABLE IF EXISTS [dbo].[{target_table}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut setup_client, &cleanup_source).await;
    let _ = dbx_core::db::sqlserver::execute_batch(&mut target_client, &cleanup_target).await;

    let setup = format!(
        "CREATE TABLE [dbo].[{source_table}] (id INT NOT NULL PRIMARY KEY, name NVARCHAR(64) NULL, TimeSpan timestamp NOT NULL);\
         INSERT INTO [dbo].[{source_table}] (id, name) VALUES (1, N'alpha'), (2, N'beta');"
    );
    dbx_core::db::sqlserver::execute_batch(&mut setup_client, &setup).await.expect("create rowversion source table");

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-rowversion-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let config = live_sqlserver_config("live-sqlserver-rowversion", &database);
    state.configs.write().await.insert(config.id.clone(), config);
    let source_pool_key =
        state.get_or_create_pool("live-sqlserver-rowversion", Some(&database)).await.expect("connect transfer pool");
    let target_pool_key = state
        .get_or_create_pool("live-sqlserver-rowversion", Some(&target_database))
        .await
        .expect("connect target transfer pool");
    let request = dbx_core::transfer::TransferRequest {
        transfer_id: format!("live-sqlserver-rowversion-{suffix}"),
        source_connection_id: "live-sqlserver-rowversion".to_string(),
        source_database: database.clone(),
        source_schema: "dbo".to_string(),
        target_connection_id: "live-sqlserver-rowversion".to_string(),
        target_database: target_database.clone(),
        target_schema: "dbo".to_string(),
        tables: vec![source_table.clone()],
        create_table: true,
        mode: dbx_core::transfer::TransferMode::Append,
        target_table_name_case: dbx_core::transfer::TransferTableNameCase::Upper,
        ownership_policy: dbx_core::transfer::TransferOwnershipPolicy::Preserve,
        batch_size: 100,
    };
    let result = dbx_core::transfer::transfer_table(
        &state,
        &request,
        &source_table,
        0,
        &DatabaseType::SqlServer,
        &DatabaseType::SqlServer,
        &source_pool_key,
        &target_pool_key,
        |_| {},
    )
    .await;
    let verify_sql =
        format!("SELECT COUNT(*) AS row_count, COUNT([TimeSpan]) AS rowversion_count FROM [dbo].[{target_table}];");
    let verify_result = dbx_core::db::sqlserver::execute_query(&mut target_client, &verify_sql).await;

    let _ = dbx_core::db::sqlserver::execute_batch(&mut target_client, &cleanup_target).await;
    let _ = dbx_core::db::sqlserver::execute_batch(&mut setup_client, &cleanup_source).await;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(result.expect("transfer rowversion table"), 2);
    let verify_result = verify_result.expect("verify target rowversion rows");
    assert_eq!(verify_result.rows[0][0], serde_json::json!(2));
    assert_eq!(verify_result.rows[0][1], serde_json::json!(2));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_URL or DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_completion_assistant_searches_metadata_before_limiting() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let schema = "dbo".to_string();
    let prefix = format!("needle_{suffix}");
    let table = format!("{prefix}_table");
    let setup = format!("CREATE TABLE [{schema}].[{table}] (id INT NOT NULL, display_name NVARCHAR(64) NULL);");
    dbx_core::db::sqlserver::execute_batch(&mut client, &setup).await.expect("create live test objects");

    let request = dbx_core::types::CompletionAssistantRequest {
        connection_id: "live-sqlserver".to_string(),
        database: database.clone(),
        schema: Some(schema.clone()),
        object_kinds: vec![dbx_core::types::CompletionAssistantObjectKind::Table],
        mask: prefix.clone(),
        case_sensitive: false,
        global_search: false,
        max_results: Some(5),
        search_in_comments: false,
        search_in_definitions: false,
        parent_schema: Some(schema.clone()),
        parent_name: None,
        match_mode: Some(dbx_core::types::CompletionAssistantMatchMode::Prefix),
    };

    let response = dbx_core::db::sqlserver::completion_assistant_search(&mut client, &request)
        .await
        .expect("completion assistant tables");
    assert!(response
        .candidates
        .iter()
        .any(|candidate| candidate.name == table && candidate.schema.as_deref() == Some(schema.as_str())));

    let column_response = dbx_core::db::sqlserver::completion_assistant_search(
        &mut client,
        &dbx_core::types::CompletionAssistantRequest {
            object_kinds: vec![dbx_core::types::CompletionAssistantObjectKind::Column],
            mask: "display".to_string(),
            parent_name: Some(table.clone()),
            ..request
        },
    )
    .await
    .expect("completion assistant columns");
    assert!(column_response
        .candidates
        .iter()
        .any(|candidate| candidate.name == "display_name" && candidate.parent_name.as_deref() == Some(table.as_str())));

    let cleanup = format!("DROP TABLE [{schema}].[{table}];");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;
}
