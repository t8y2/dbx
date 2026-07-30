use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::sql::{SqlFileRequest, SqlFileStatus};
use dbx_core::sql_file_import::execute_sql_file_content;
use dbx_core::storage::Storage;
use dbx_core::table_import::{
    build_import_insert_batches, import_table_file_core, parse_delimited_file_with_options, TableImportColumnMapping,
    TableImportMode, TableImportParseOptions, TableImportRequest, TableImportSourceFormat, TableImportStatus,
};
use dbx_core::table_structure_sql::{
    build_table_structure_change_sql, ColumnInfo, EditableStructureColumn, TableStructureSqlOptions,
};
use dbx_core::xlsx_export::{build_xlsx_workbook, XlsxWorksheetData};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

fn live_sqlserver_config(id: &str, database: &str) -> dbx_core::models::connection::ConnectionConfig {
    dbx_core::models::connection::ConnectionConfig {
        id: id.to_string(),
        name: id.to_string(),
        note: String::new(),
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

async fn live_sqlserver_import_state(
    connection_id: &str,
    database: &str,
    suffix: &str,
) -> (AppState, String, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-import-{suffix}"));
    std::fs::create_dir_all(&dir).expect("create live import directory");
    let storage = Storage::open(&dir.join("storage.db")).await.expect("open live import storage");
    let state = AppState::new(storage);
    let config = live_sqlserver_config(connection_id, database);
    state.configs.write().await.insert(connection_id.to_string(), config);
    let pool_key =
        state.get_or_create_pool(connection_id, Some(database)).await.expect("connect live SQL Server import pool");
    (state, pool_key, dir)
}

fn live_sqlserver_import_mapping(source: &str, target: &str) -> TableImportColumnMapping {
    TableImportColumnMapping {
        source_column: source.to_string(),
        target_column: target.to_string(),
        target_data_type: None,
    }
}

fn live_sqlserver_import_request(
    connection_id: &str,
    database: &str,
    table: &str,
    file_path: &std::path::Path,
    mappings: Vec<TableImportColumnMapping>,
    mode: TableImportMode,
) -> TableImportRequest {
    TableImportRequest {
        import_id: format!("live-sqlserver-import-{}", uuid::Uuid::new_v4().simple()),
        connection_id: connection_id.to_string(),
        database: database.to_string(),
        schema: "dbo".to_string(),
        table: table.to_string(),
        file_path: file_path.to_string_lossy().to_string(),
        source_ref: None,
        source_format: Some(TableImportSourceFormat::Csv),
        parse_options: TableImportParseOptions::default(),
        mappings,
        mode,
        create_table: false,
        batch_size: 500,
        date_time_format: None,
        prepared_source: None,
        retain_source: false,
    }
}

async fn run_live_sqlserver_import(
    state: &AppState,
    pool_key: &str,
    request: &TableImportRequest,
) -> Result<dbx_core::table_import::TableImportSummary, String> {
    import_table_file_core(state, request, &DatabaseType::SqlServer, pool_key, |_| Box::pin(async { false }), |_| {})
        .await
}

fn live_sqlserver_matrix_column_types() -> Vec<(String, String)> {
    [
        ("id", "int"),
        ("code", "nvarchar(40)"),
        ("nullable_text", "nvarchar(100)"),
        ("amount", "decimal(38,10)"),
        ("occurred_at", "datetime2(7)"),
        ("offset_at", "datetimeoffset(7)"),
        ("event_id", "uniqueidentifier"),
        ("document", "xml"),
        ("payload", "varbinary(max)"),
    ]
    .into_iter()
    .map(|(name, data_type)| (name.to_string(), data_type.to_string()))
    .collect()
}

fn live_sqlserver_matrix_mappings(include_identity: bool) -> Vec<TableImportColumnMapping> {
    let columns =
        ["id", "code", "nullable_text", "amount", "occurred_at", "offset_at", "event_id", "document", "payload"];
    columns
        .into_iter()
        .filter(|column| include_identity || *column != "id")
        .map(|column| live_sqlserver_import_mapping(column, column))
        .collect()
}

async fn run_live_sqlserver_generated_insert(
    client: &mut dbx_core::db::sqlserver::SqlServerClient,
    table: &str,
    file_path: &std::path::Path,
    parse_options: &TableImportParseOptions,
    include_identity: bool,
) -> Result<usize, String> {
    let parsed = parse_delimited_file_with_options(
        &file_path.to_string_lossy(),
        TableImportSourceFormat::Csv,
        parse_options,
        usize::MAX,
    )?;
    let batches = build_import_insert_batches(
        &parsed,
        &live_sqlserver_matrix_mappings(include_identity),
        &live_sqlserver_matrix_column_types(),
        table,
        "dbo",
        &DatabaseType::SqlServer,
        500,
    )?;
    if include_identity {
        let rows_imported = batches.iter().map(|batch| batch.row_count).sum();
        let statements = batches.into_iter().map(|batch| batch.sql).collect::<Vec<_>>().join(";\n");
        let sql =
            format!("SET IDENTITY_INSERT [dbo].[{table}] ON;\n{statements};\nSET IDENTITY_INSERT [dbo].[{table}] OFF");
        dbx_core::db::sqlserver::execute_batch(client, &sql).await?;
        return Ok(rows_imported);
    }
    let mut rows_imported = 0;
    for batch in batches {
        dbx_core::db::sqlserver::execute_batch(client, &batch.sql).await?;
        rows_imported += batch.row_count;
    }
    Ok(rows_imported)
}

fn live_sqlserver_matrix_table_ddl(table: &str, audit_table: &str) -> String {
    format!(
        "CREATE TABLE [dbo].[{table}] (\
         [id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY, \
         [code] NVARCHAR(40) NOT NULL UNIQUE, \
         [nullable_text] NVARCHAR(100) NULL, \
         [amount] DECIMAL(38,10) NOT NULL CHECK ([amount] > 0), \
         [occurred_at] DATETIME2(7) NOT NULL, \
         [offset_at] DATETIMEOFFSET(7) NOT NULL, \
         [event_id] UNIQUEIDENTIFIER NOT NULL, \
         [document] XML NULL, \
         [payload] VARBINARY(MAX) NULL, \
         [default_text] NVARCHAR(40) NOT NULL DEFAULT N'defaulted'); \
         CREATE TABLE [dbo].[{audit_table}] (\
         [target_id] INT NOT NULL, [code] NVARCHAR(40) NOT NULL, [default_text] NVARCHAR(40) NOT NULL);"
    )
}

fn live_sqlserver_matrix_trigger_ddl(table: &str, audit_table: &str, trigger: &str) -> String {
    format!(
        "CREATE TRIGGER [dbo].[{trigger}] ON [dbo].[{table}] AFTER INSERT AS \
         INSERT INTO [dbo].[{audit_table}] ([target_id], [code], [default_text]) \
         SELECT [id], [code], [default_text] FROM inserted;"
    )
}

async fn live_sqlserver_matrix_rows(
    client: &mut dbx_core::db::sqlserver::SqlServerClient,
    table: &str,
) -> dbx_core::db::QueryResult {
    dbx_core::db::sqlserver::execute_query(
        client,
        &format!(
            "SELECT CONVERT(VARCHAR(12), [id]), [code], \
             CASE WHEN [nullable_text] IS NULL THEN N'<NULL>' ELSE N'<' + [nullable_text] + N'>' END, \
             CONVERT(VARCHAR(50), [amount]), CONVERT(VARCHAR(33), [occurred_at], 126), \
             CONVERT(VARCHAR(48), [offset_at], 127), CONVERT(VARCHAR(36), [event_id]), \
             CASE WHEN [document] IS NULL THEN N'<NULL>' ELSE CONVERT(NVARCHAR(MAX), [document]) END, \
             CASE WHEN [payload] IS NULL THEN N'<NULL>' ELSE sys.fn_varbintohexstr([payload]) END, \
             [default_text] FROM [dbo].[{table}] ORDER BY [id]"
        ),
    )
    .await
    .expect("query SQL Server import matrix rows")
}

async fn live_sqlserver_table_count(client: &mut dbx_core::db::sqlserver::SqlServerClient, table: &str) -> i64 {
    let result = dbx_core::db::sqlserver::execute_query(client, &format!("SELECT COUNT_BIG(*) FROM [dbo].[{table}]"))
        .await
        .expect("count SQL Server matrix rows");
    result.rows[0][0].as_i64().expect("SQL Server COUNT_BIG result")
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_bulk_matches_generated_insert_type_and_constraint_matrix() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-matrix-{suffix}");
    let bulk_table = format!("dbx_bulk_matrix_{suffix}");
    let generated_table = format!("dbx_insert_matrix_{suffix}");
    let bulk_audit = format!("dbx_bulk_matrix_audit_{suffix}");
    let generated_audit = format!("dbx_insert_matrix_audit_{suffix}");
    let bulk_trigger = format!("dbx_bulk_matrix_trigger_{suffix}");
    let generated_trigger = format!("dbx_insert_matrix_trigger_{suffix}");
    let mut client = dbx_core::db::sqlserver::connect(
        &std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        &std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        &std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        Some(&database),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect SQL Server");
    for ddl in [
        live_sqlserver_matrix_table_ddl(&bulk_table, &bulk_audit),
        live_sqlserver_matrix_table_ddl(&generated_table, &generated_audit),
        live_sqlserver_matrix_trigger_ddl(&bulk_table, &bulk_audit, &bulk_trigger),
        live_sqlserver_matrix_trigger_ddl(&generated_table, &generated_audit, &generated_trigger),
    ] {
        dbx_core::db::sqlserver::execute_batch(&mut client, &ddl)
            .await
            .expect("create SQL Server import matrix objects");
    }

    let (state, pool_key, dir) = live_sqlserver_import_state(&connection_id, &database, &suffix).await;
    let default_options = TableImportParseOptions::default();
    let empty_string_options =
        TableImportParseOptions { empty_string_as_null: Some(false), ..TableImportParseOptions::default() };

    let null_csv = dir.join("matrix-null.csv");
    std::fs::write(
        &null_csv,
        "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
         auto-null,,12345678901234567890.1234567890,2026-07-27T12:34:56.1234567,2026-07-27T12:34:56.1234567+08:00,11111111-2222-3333-4444-555555555555,,\n",
    )
    .expect("write SQL Server NULL matrix CSV");
    let null_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &bulk_table,
        &null_csv,
        live_sqlserver_matrix_mappings(false),
        TableImportMode::Append,
    );
    let null_bulk = run_live_sqlserver_import(&state, &pool_key, &null_request)
        .await
        .expect("bulk import SQL Server NULL matrix row");
    let null_generated =
        run_live_sqlserver_generated_insert(&mut client, &generated_table, &null_csv, &default_options, false)
            .await
            .expect("generated INSERT SQL Server NULL matrix row");

    let empty_csv = dir.join("matrix-empty-string.csv");
    std::fs::write(
        &empty_csv,
        "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
         empty,,0.0000000001,2026-07-28T01:02:03.0000001,2026-07-28T01:02:03.0000001-05:30,aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee,<root><value>empty-text</value></root>,0x00FF10\n",
    )
    .expect("write SQL Server empty-string matrix CSV");
    let mut empty_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &bulk_table,
        &empty_csv,
        live_sqlserver_matrix_mappings(false),
        TableImportMode::Append,
    );
    empty_request.parse_options = empty_string_options.clone();
    let empty_bulk = run_live_sqlserver_import(&state, &pool_key, &empty_request)
        .await
        .expect("bulk import SQL Server empty-string matrix row");
    let empty_generated =
        run_live_sqlserver_generated_insert(&mut client, &generated_table, &empty_csv, &empty_string_options, false)
            .await
            .expect("generated INSERT SQL Server empty-string matrix row");

    let identity_csv = dir.join("matrix-explicit-identity.csv");
    std::fs::write(
        &identity_csv,
        "id,code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
         42,explicit,identity,9999999999999999999999999999.9999999999,2026-07-29T23:59:59.9999999,2026-07-29T23:59:59.9999999+13:45,01234567-89ab-cdef-0123-456789abcdef,<root><value>identity</value></root>,0xABCDEF\n",
    )
    .expect("write SQL Server explicit-identity matrix CSV");
    let identity_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &bulk_table,
        &identity_csv,
        live_sqlserver_matrix_mappings(true),
        TableImportMode::Append,
    );
    let identity_bulk = run_live_sqlserver_import(&state, &pool_key, &identity_request)
        .await
        .expect("bulk import SQL Server explicit-identity matrix row");
    let identity_generated =
        run_live_sqlserver_generated_insert(&mut client, &generated_table, &identity_csv, &default_options, true)
            .await
            .expect("generated INSERT SQL Server explicit-identity matrix row");

    let bulk_rows = live_sqlserver_matrix_rows(&mut client, &bulk_table).await;
    let generated_rows = live_sqlserver_matrix_rows(&mut client, &generated_table).await;
    let bulk_audit_rows = dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("SELECT [target_id], [code], [default_text] FROM [dbo].[{bulk_audit}] ORDER BY [target_id]"),
    )
    .await
    .expect("query SQL Server bulk audit rows");
    let generated_audit_rows = dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("SELECT [target_id], [code], [default_text] FROM [dbo].[{generated_audit}] ORDER BY [target_id]"),
    )
    .await
    .expect("query SQL Server generated INSERT audit rows");

    let invalid_cases = [
        (
            "unique",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             unique-first,value,1.0000000000,2026-08-01T00:00:00,2026-08-01T00:00:00+00:00,10000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             auto-null,value,2.0000000000,2026-08-01T00:00:01,2026-08-01T00:00:01+00:00,10000000-0000-0000-0000-000000000002,<ok/>,0x02\n",
        ),
        (
            "check",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             check-first,value,1.0000000000,2026-08-02T00:00:00,2026-08-02T00:00:00+00:00,20000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             check-invalid,value,-0.0000000001,2026-08-02T00:00:01,2026-08-02T00:00:01+00:00,20000000-0000-0000-0000-000000000002,<ok/>,0x02\n",
        ),
        (
            "not-null",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             not-null-first,value,1.0000000000,2026-08-03T00:00:00,2026-08-03T00:00:00+00:00,30000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             ,value,2.0000000000,2026-08-03T00:00:01,2026-08-03T00:00:01+00:00,30000000-0000-0000-0000-000000000002,<ok/>,0x02\n",
        ),
        (
            "decimal-overflow",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             decimal-first,value,1.0000000000,2026-08-04T00:00:00,2026-08-04T00:00:00+00:00,40000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             decimal-invalid,value,10000000000000000000000000000.0000000000,2026-08-04T00:00:01,2026-08-04T00:00:01+00:00,40000000-0000-0000-0000-000000000002,<ok/>,0x02\n",
        ),
        (
            "uuid",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             uuid-first,value,1.0000000000,2026-08-05T00:00:00,2026-08-05T00:00:00+00:00,50000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             uuid-invalid,value,2.0000000000,2026-08-05T00:00:01,2026-08-05T00:00:01+00:00,not-a-uuid,<ok/>,0x02\n",
        ),
        (
            "xml",
            "code,nullable_text,amount,occurred_at,offset_at,event_id,document,payload\n\
             xml-first,value,1.0000000000,2026-08-06T00:00:00,2026-08-06T00:00:00+00:00,60000000-0000-0000-0000-000000000001,<ok/>,0x01\n\
             xml-invalid,value,2.0000000000,2026-08-06T00:00:01,2026-08-06T00:00:01+00:00,60000000-0000-0000-0000-000000000002,<unclosed>,0x02\n",
        ),
    ];
    let stable_bulk_count = live_sqlserver_table_count(&mut client, &bulk_table).await;
    let stable_generated_count = live_sqlserver_table_count(&mut client, &generated_table).await;
    let mut rejection_results = Vec::new();
    for (case, csv) in invalid_cases {
        let path = dir.join(format!("matrix-invalid-{case}.csv"));
        std::fs::write(&path, csv).expect("write SQL Server invalid matrix CSV");
        let request = live_sqlserver_import_request(
            &connection_id,
            &database,
            &bulk_table,
            &path,
            live_sqlserver_matrix_mappings(false),
            TableImportMode::Append,
        );
        let bulk_result = run_live_sqlserver_import(&state, &pool_key, &request).await;
        let generated_result =
            run_live_sqlserver_generated_insert(&mut client, &generated_table, &path, &default_options, false).await;
        let bulk_count = live_sqlserver_table_count(&mut client, &bulk_table).await;
        let generated_count = live_sqlserver_table_count(&mut client, &generated_table).await;
        rejection_results.push((case, bulk_result, generated_result, bulk_count, generated_count));
    }
    let final_bulk_audit_count = live_sqlserver_table_count(&mut client, &bulk_audit).await;
    let final_generated_audit_count = live_sqlserver_table_count(&mut client, &generated_audit).await;

    let cleanup = format!(
        "DROP TRIGGER IF EXISTS [dbo].[{bulk_trigger}]; \
         DROP TRIGGER IF EXISTS [dbo].[{generated_trigger}]; \
         DROP TABLE IF EXISTS [dbo].[{bulk_audit}]; DROP TABLE IF EXISTS [dbo].[{generated_audit}]; \
         DROP TABLE IF EXISTS [dbo].[{bulk_table}]; DROP TABLE IF EXISTS [dbo].[{generated_table}];"
    );
    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &cleanup).await;
    state.remove_connection_pools_detached(&connection_id).await;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(null_bulk.rows_imported, null_generated);
    assert_eq!(empty_bulk.rows_imported, empty_generated);
    assert_eq!(identity_bulk.rows_imported, identity_generated);
    assert_eq!(bulk_rows.rows, generated_rows.rows, "Bulk and generated INSERT values differ");
    assert_eq!(bulk_rows.rows.len(), 3);
    assert_eq!(bulk_rows.rows[0][2], serde_json::json!("<NULL>"));
    assert_eq!(bulk_rows.rows[0][3], serde_json::json!("12345678901234567890.1234567890"));
    assert_eq!(bulk_rows.rows[0][5], serde_json::json!("2026-07-27T04:34:56.1234567Z"));
    assert_eq!(bulk_rows.rows[0][7], serde_json::json!("<NULL>"));
    assert_eq!(bulk_rows.rows[0][8], serde_json::json!("<NULL>"));
    assert_eq!(bulk_rows.rows[1][2], serde_json::json!("<>"));
    assert_eq!(bulk_rows.rows[1][3], serde_json::json!("0.0000000001"));
    assert_eq!(bulk_rows.rows[1][5], serde_json::json!("2026-07-28T06:32:03.0000001Z"));
    assert_eq!(bulk_rows.rows[1][8], serde_json::json!("0x00ff10"));
    assert_eq!(bulk_rows.rows[2][0], serde_json::json!("42"));
    assert_eq!(bulk_rows.rows[2][3], serde_json::json!("9999999999999999999999999999.9999999999"));
    assert_eq!(bulk_rows.rows[2][5], serde_json::json!("2026-07-29T10:14:59.9999999Z"));
    assert!(bulk_rows.rows.iter().all(|row| row[9] == serde_json::json!("defaulted")));
    assert_eq!(bulk_audit_rows.rows, generated_audit_rows.rows, "trigger side effects differ");
    assert_eq!(bulk_audit_rows.rows.len(), 3);
    assert_eq!(final_bulk_audit_count, 3, "Bulk constraint failures left trigger side effects");
    assert_eq!(final_generated_audit_count, 3, "generated INSERT failures left trigger side effects");
    for (case, bulk_result, generated_result, bulk_count, generated_count) in rejection_results {
        assert!(bulk_result.is_err(), "Bulk path unexpectedly accepted {case} case");
        assert!(generated_result.is_err(), "generated INSERT unexpectedly accepted {case} case");
        assert_eq!(bulk_count, stable_bulk_count, "Bulk path partially wrote {case} case");
        assert_eq!(generated_count, stable_generated_count, "generated INSERT partially wrote {case} case");
    }
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_bulk_imports_zero_fraction_xlsx_numbers_into_bigint() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-xlsx-integer-{suffix}");
    let table = format!("dbx_bulk_xlsx_integer_{suffix}");
    let mut client = dbx_core::db::sqlserver::connect(
        &std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        &std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        &std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        Some(&database),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect SQL Server");
    dbx_core::db::sqlserver::execute_batch(
        &mut client,
        &format!("CREATE TABLE [dbo].[{table}] ([id] BIGINT NOT NULL, [label] NVARCHAR(40) NOT NULL)"),
    )
    .await
    .expect("create SQL Server XLSX integer table");

    let (state, pool_key, dir) = live_sqlserver_import_state(&connection_id, &database, &suffix).await;
    let xlsx = build_xlsx_workbook(&XlsxWorksheetData {
        sheet_name: Some("Numbers".to_string()),
        columns: vec!["id".to_string(), "label".to_string()],
        column_types: Vec::new(),
        column_comments: Vec::new(),
        rows: vec![vec![serde_json::json!(1.0), serde_json::json!("xlsx")]],
        numeric_column_right_align: false,
    })
    .expect("build SQL Server XLSX integer fixture");
    let path = dir.join("zero-fraction-integer.xlsx");
    std::fs::write(&path, xlsx).expect("write SQL Server XLSX integer fixture");
    let mut request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &path,
        vec![live_sqlserver_import_mapping("id", "id"), live_sqlserver_import_mapping("label", "label")],
        TableImportMode::Append,
    );
    request.source_format = Some(TableImportSourceFormat::Excel);
    let result = run_live_sqlserver_import(&state, &pool_key, &request).await;
    let rows =
        dbx_core::db::sqlserver::execute_query(&mut client, &format!("SELECT [id], [label] FROM [dbo].[{table}]"))
            .await
            .expect("query SQL Server XLSX integer row");

    let _ = dbx_core::db::sqlserver::execute_batch(&mut client, &format!("DROP TABLE IF EXISTS [dbo].[{table}]")).await;
    state.remove_connection_pools_detached(&connection_id).await;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(result.expect("bulk import SQL Server XLSX integer row").rows_imported, 1);
    assert_eq!(rows.rows, vec![vec![serde_json::json!(1), serde_json::json!("xlsx")]]);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_table_import_bulk_preserves_target_semantics() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-import-{suffix}");
    let table = format!("dbx_bulk_target_{suffix}");
    let audit_table = format!("dbx_bulk_audit_{suffix}");
    let trigger = format!("dbx_bulk_trigger_{suffix}");
    let mut setup_client = dbx_core::db::sqlserver::connect(
        &std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        &std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        &std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        Some(&database),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect SQL Server");
    dbx_core::db::sqlserver::execute_batch(
        &mut setup_client,
        &format!(
            "CREATE TABLE [dbo].[{table}] (\
             [id] INT IDENTITY(1,1) NOT NULL PRIMARY KEY, \
             [code] NVARCHAR(40) NOT NULL UNIQUE, \
             [occurred_at] DATETIME2(7) NOT NULL, \
             [amount] DECIMAL(38,10) NOT NULL, \
             [name] NVARCHAR(100) NOT NULL, \
             [payload] VARBINARY(MAX) NULL, \
             [created_at] DATETIME2(7) NOT NULL DEFAULT SYSUTCDATETIME()); \
             CREATE TABLE [dbo].[{audit_table}] ([target_id] INT NOT NULL, [name] NVARCHAR(100) NOT NULL);"
        ),
    )
    .await
    .expect("create bulk target tables");
    dbx_core::db::sqlserver::execute_batch(
        &mut setup_client,
        &format!(
            "CREATE TRIGGER [dbo].[{trigger}] ON [dbo].[{table}] AFTER INSERT AS \
             INSERT INTO [dbo].[{audit_table}] ([target_id], [name]) SELECT [id], [name] FROM inserted"
        ),
    )
    .await
    .expect("create bulk target trigger");

    let (state, pool_key, dir) = live_sqlserver_import_state(&connection_id, &database, &suffix).await;
    let generated_identity_csv = dir.join("generated-identity.csv");
    std::fs::write(
        &generated_identity_csv,
        "code,occurred_at,amount,name,payload\nauto,2026-07-27T12:34:56.1234567,12345678901234567890.1234567890,\u{8d8a}\u{5357}\u{82b1},0x00FF10\n",
    )
    .expect("write generated identity CSV");
    let generated_identity_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &generated_identity_csv,
        ["code", "occurred_at", "amount", "name", "payload"]
            .into_iter()
            .map(|column| live_sqlserver_import_mapping(column, column))
            .collect(),
        TableImportMode::Append,
    );
    let generated_summary = run_live_sqlserver_import(&state, &pool_key, &generated_identity_request)
        .await
        .expect("bulk import with generated identity");

    let explicit_identity_csv = dir.join("explicit-identity.csv");
    std::fs::write(
        &explicit_identity_csv,
        "id,code,occurred_at,amount,name,payload\n42,explicit,2026-07-28T01:02:03.0000000,1.0000000000,Tieng Viet,0xABCDEF\n",
    )
    .expect("write explicit identity CSV");
    let explicit_identity_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &explicit_identity_csv,
        ["id", "code", "occurred_at", "amount", "name", "payload"]
            .into_iter()
            .map(|column| live_sqlserver_import_mapping(column, column))
            .collect(),
        TableImportMode::Append,
    );
    let explicit_summary = run_live_sqlserver_import(&state, &pool_key, &explicit_identity_request)
        .await
        .expect("bulk import with explicit identity");

    let plain_binary_csv = dir.join("plain-binary.csv");
    std::fs::write(
        &plain_binary_csv,
        "code,occurred_at,amount,name,payload\nplain,2026-07-28T02:03:04.0000000,2.0000000000,plain binary,plain\n",
    )
    .expect("write plain binary CSV");
    let plain_binary_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &plain_binary_csv,
        ["code", "occurred_at", "amount", "name", "payload"]
            .into_iter()
            .map(|column| live_sqlserver_import_mapping(column, column))
            .collect(),
        TableImportMode::Append,
    );
    let plain_binary_summary = run_live_sqlserver_import(&state, &pool_key, &plain_binary_request)
        .await
        .expect("SQL fallback import with plain-text varbinary input");

    let duplicate_csv = dir.join("duplicate.csv");
    std::fs::write(
        &duplicate_csv,
        "code,occurred_at,amount,name,payload\nauto,2026-07-29T00:00:00,2.0000000000,duplicate,0x01\n",
    )
    .expect("write duplicate CSV");
    let duplicate_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &duplicate_csv,
        ["code", "occurred_at", "amount", "name", "payload"]
            .into_iter()
            .map(|column| live_sqlserver_import_mapping(column, column))
            .collect(),
        TableImportMode::Append,
    );
    let duplicate_error = run_live_sqlserver_import(&state, &pool_key, &duplicate_request).await;

    let rows = dbx_core::db::sqlserver::execute_query(
        &mut setup_client,
        &format!(
            "SELECT CONVERT(VARCHAR(12), [id]), [code], CONVERT(VARCHAR(33), [occurred_at], 126), \
             CONVERT(VARCHAR(50), [amount]), [name], sys.fn_varbintohexstr([payload]), \
             CASE WHEN [created_at] IS NULL THEN N'missing' ELSE N'set' END, \
             CASE WHEN [code] = N'plain' THEN CONVERT(NVARCHAR(100), [payload]) END \
             FROM [dbo].[{table}] ORDER BY [id]"
        ),
    )
    .await
    .expect("verify bulk target rows");
    let audit_count = dbx_core::db::sqlserver::execute_query(
        &mut setup_client,
        &format!("SELECT COUNT(*) FROM [dbo].[{audit_table}]"),
    )
    .await
    .expect("verify trigger rows");
    let cleanup = format!(
        "DROP TRIGGER IF EXISTS [dbo].[{trigger}]; DROP TABLE IF EXISTS [dbo].[{audit_table}]; DROP TABLE IF EXISTS [dbo].[{table}];"
    );
    let _ = dbx_core::db::sqlserver::execute_batch(&mut setup_client, &cleanup).await;
    state.remove_connection_pools_detached(&connection_id).await;
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(generated_summary.rows_imported, 1);
    assert_eq!(explicit_summary.rows_imported, 1);
    assert_eq!(plain_binary_summary.rows_imported, 1);
    assert!(duplicate_error.is_err(), "unique constraint violation must fail the import");
    assert_eq!(rows.rows.len(), 3);
    assert_eq!(rows.rows[0][0], serde_json::json!("1"));
    assert_eq!(rows.rows[0][1], serde_json::json!("auto"));
    assert_eq!(rows.rows[0][2], serde_json::json!("2026-07-27T12:34:56.1234567"));
    assert_eq!(rows.rows[0][3], serde_json::json!("12345678901234567890.1234567890"));
    assert_eq!(rows.rows[0][4], serde_json::json!("\u{8d8a}\u{5357}\u{82b1}"));
    assert_eq!(rows.rows[0][5], serde_json::json!("0x00ff10"));
    assert_eq!(rows.rows[0][6], serde_json::json!("set"));
    assert_eq!(rows.rows[1][0], serde_json::json!("42"));
    assert_eq!(rows.rows[1][4], serde_json::json!("Tieng Viet"));
    assert_eq!(rows.rows[1][5], serde_json::json!("0xabcdef"));
    assert_eq!(rows.rows[2][1], serde_json::json!("plain"));
    assert_eq!(rows.rows[2][7], serde_json::json!("plain"));
    assert_eq!(audit_count.rows[0][0], serde_json::json!(3));
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_table_import_bulk_cancels_before_target_write_and_rolls_back_truncate() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let connection_id = format!("live-sqlserver-import-rollback-{suffix}");
    let table = format!("dbx_bulk_rollback_{suffix}");
    let mut setup_client = dbx_core::db::sqlserver::connect(
        &std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433),
        &std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string()),
        &std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD"),
        Some(&database),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect SQL Server");
    dbx_core::db::sqlserver::execute_batch(
        &mut setup_client,
        &format!(
            "CREATE TABLE [dbo].[{table}] ([id] INT NOT NULL PRIMARY KEY, [amount] DECIMAL(38,10) NOT NULL CHECK ([amount] > 0)); \
             INSERT INTO [dbo].[{table}] VALUES (999, 9.0000000000);"
        ),
    )
    .await
    .expect("create rollback target");
    let (state, pool_key, dir) = live_sqlserver_import_state(&connection_id, &database, &suffix).await;

    let invalid_csv = dir.join("invalid.csv");
    std::fs::write(&invalid_csv, "id,amount\n1,-1.0000000000\n").expect("write invalid CSV");
    let invalid_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &invalid_csv,
        vec![live_sqlserver_import_mapping("id", "id"), live_sqlserver_import_mapping("amount", "amount")],
        TableImportMode::Truncate,
    );
    let truncate_error = run_live_sqlserver_import(&state, &pool_key, &invalid_request).await;
    let rows_after_failed_truncate = dbx_core::db::sqlserver::execute_query(
        &mut setup_client,
        &format!("SELECT [id], CONVERT(VARCHAR(50), [amount]) FROM [dbo].[{table}]"),
    )
    .await
    .expect("verify truncate rollback");

    let valid_csv = dir.join("cancelled.csv");
    std::fs::write(&valid_csv, "id,amount\n1,1.0000000000\n").expect("write cancellation CSV");
    let cancel_request = live_sqlserver_import_request(
        &connection_id,
        &database,
        &table,
        &valid_csv,
        vec![live_sqlserver_import_mapping("id", "id"), live_sqlserver_import_mapping("amount", "amount")],
        TableImportMode::Truncate,
    );
    let cancellation_checks = Arc::new(AtomicUsize::new(0));
    let cancellation_checks_for_import = cancellation_checks.clone();
    let cancelled_progress = Arc::new(AtomicBool::new(false));
    let cancelled_progress_for_import = cancelled_progress.clone();
    let cancel_error = import_table_file_core(
        &state,
        &cancel_request,
        &DatabaseType::SqlServer,
        &pool_key,
        move |_| {
            let checks = cancellation_checks_for_import.clone();
            Box::pin(async move { checks.fetch_add(1, Ordering::SeqCst) >= 1 })
        },
        move |progress| {
            if progress.status == TableImportStatus::Cancelled {
                cancelled_progress_for_import.store(true, Ordering::SeqCst);
            }
        },
    )
    .await;
    let rows_after_cancel = dbx_core::db::sqlserver::execute_query(
        &mut setup_client,
        &format!("SELECT [id], CONVERT(VARCHAR(50), [amount]) FROM [dbo].[{table}]"),
    )
    .await
    .expect("verify cancellation leaves target unchanged");
    let _ = dbx_core::db::sqlserver::execute_batch(&mut setup_client, &format!("DROP TABLE IF EXISTS [dbo].[{table}]"))
        .await;
    state.remove_connection_pools_detached(&connection_id).await;
    let _ = std::fs::remove_dir_all(&dir);

    assert!(truncate_error.is_err(), "check constraint must fail the truncate import");
    assert_eq!(rows_after_failed_truncate.rows, vec![vec![serde_json::json!(999), serde_json::json!("9.0000000000")]]);
    assert_eq!(cancel_error.unwrap_err(), "Import cancelled");
    assert!(cancellation_checks.load(Ordering::SeqCst) >= 2);
    assert!(cancelled_progress.load(Ordering::SeqCst));
    assert_eq!(rows_after_cancel.rows, vec![vec![serde_json::json!(999), serde_json::json!("9.0000000000")]]);
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_column_metadata_marks_non_positional_insert_columns() {
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
    let computed_table = format!("dbx_insert_computed_{suffix}");
    let temporal_table = format!("dbx_insert_temporal_{suffix}");
    let history_table = format!("dbx_insert_history_{suffix}");
    let create_computed = format!(
        "CREATE TABLE dbo.[{computed_table}] (id int IDENTITY(1,1) NOT NULL, quantity int NOT NULL, doubled AS quantity * 2, note nvarchar(40) NOT NULL)"
    );
    let create_temporal = format!(
        "CREATE TABLE dbo.[{temporal_table}] (\
         id int IDENTITY(1,1) NOT NULL PRIMARY KEY, \
         note nvarchar(40) NOT NULL, \
         valid_from datetime2 GENERATED ALWAYS AS ROW START HIDDEN NOT NULL DEFAULT SYSUTCDATETIME(), \
         valid_to datetime2 GENERATED ALWAYS AS ROW END HIDDEN NOT NULL DEFAULT CONVERT(datetime2, '9999-12-31 23:59:59.9999999'), \
         PERIOD FOR SYSTEM_TIME (valid_from, valid_to)\
         ) WITH (SYSTEM_VERSIONING = ON (HISTORY_TABLE = dbo.[{history_table}]))"
    );

    dbx_core::db::sqlserver::execute_query(&mut client, &create_computed).await.expect("create computed table");
    dbx_core::db::sqlserver::execute_query(&mut client, &create_temporal).await.expect("create temporal table");
    dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("INSERT INTO dbo.[{computed_table}] VALUES (3, N'normal')"),
    )
    .await
    .expect("insert while omitting identity and computed columns");
    dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("INSERT INTO dbo.[{temporal_table}] VALUES (N'temporal')"),
    )
    .await
    .expect("insert while omitting identity and hidden temporal columns");

    let computed = dbx_core::db::sqlserver::get_column_metadata(&mut client, "dbo", &computed_table)
        .await
        .expect("read computed metadata");
    let temporal = dbx_core::db::sqlserver::get_column_metadata(&mut client, "dbo", &temporal_table)
        .await
        .expect("read temporal metadata");

    dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("ALTER TABLE dbo.[{temporal_table}] SET (SYSTEM_VERSIONING = OFF)"),
    )
    .await
    .expect("disable system versioning");
    dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("DROP TABLE dbo.[{temporal_table}], dbo.[{history_table}], dbo.[{computed_table}]"),
    )
    .await
    .expect("drop metadata probe tables");

    let identity = computed.iter().find(|metadata| metadata.column.name == "id").expect("identity column");
    let quantity = computed.iter().find(|metadata| metadata.column.name == "quantity").expect("normal column");
    let doubled = computed.iter().find(|metadata| metadata.column.name == "doubled").expect("computed column");
    let valid_from = temporal.iter().find(|metadata| metadata.column.name == "valid_from").expect("row start column");
    let valid_to = temporal.iter().find(|metadata| metadata.column.name == "valid_to").expect("row end column");

    assert!(identity.is_identity);
    assert!(!quantity.is_identity && !quantity.is_computed && !quantity.is_hidden);
    assert!(doubled.is_computed);
    assert!(valid_from.is_hidden && valid_from.generated_always_type == 1);
    assert!(valid_to.is_hidden && valid_to.generated_always_type == 2);
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
async fn live_sqlserver_explicit_transaction_batch_can_rollback() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server");

    let table = format!("dbx_txn_{}", uuid::Uuid::new_v4().simple());
    dbx_core::db::sqlserver::execute_query(
        &mut client,
        &format!("CREATE TABLE dbo.[{table}] (id INT PRIMARY KEY, name NVARCHAR(50)); INSERT INTO dbo.[{table}] VALUES (50, N'old');"),
    )
    .await
    .expect("create transaction test table");

    let execution = dbx_core::db::sqlserver::execute_batch(
        &mut client,
        &format!("BEGIN TRANSACTION\nUPDATE dbo.[{table}] SET name = N'changed' WHERE id = 50;"),
    )
    .await;
    let transaction_count =
        dbx_core::db::sqlserver::execute_query(&mut client, "SELECT @@TRANCOUNT AS transaction_count").await;
    let rollback = dbx_core::db::sqlserver::execute_batch(&mut client, "ROLLBACK TRANSACTION").await;
    let verify =
        dbx_core::db::sqlserver::execute_query(&mut client, &format!("SELECT name FROM dbo.[{table}] WHERE id = 50"))
            .await;
    let cleanup = dbx_core::db::sqlserver::execute_query(&mut client, &format!("DROP TABLE dbo.[{table}]")).await;

    execution.expect("execute explicit transaction batch without error 266");
    let transaction_count = transaction_count.expect("read transaction count");
    assert_eq!(transaction_count.rows, vec![vec![serde_json::json!(1)]]);
    rollback.expect("rollback explicit transaction");
    let verify = verify.expect("verify rolled-back value");
    assert_eq!(verify.rows, vec![vec![serde_json::json!("old")]]);
    cleanup.expect("drop transaction test table");
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
            dbx_core::db::sqlserver::SqlServerStreamItem::Columns { columns: stream_columns, .. } => {
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
        setup_sql: Vec::new(),
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
        date_time_format: None,
        export_table_name: None,
        export_column_types: None,
        column_comments: None,
        numeric_column_right_align: false,
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
        source_catalog: None,
        target_connection_id: "live-sqlserver-rowversion".to_string(),
        target_database: target_database.clone(),
        target_schema: "dbo".to_string(),
        target_catalog: None,
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

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server instance"]
async fn live_sqlserver_cross_database_metadata_and_query() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let default_database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "master".to_string());
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let database_a = format!("dbx_completion_a_{}", &suffix[..8]);
    let database_b = format!("dbx_completion_b_{}", &suffix[..8]);

    let mut master =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some("master"), None, Duration::from_secs(10))
            .await
            .expect("connect SQL Server master");
    dbx_core::db::sqlserver::execute_batch(
        &mut master,
        &format!("CREATE DATABASE [{database_a}]; CREATE DATABASE [{database_b}];"),
    )
    .await
    .expect("create completion databases");

    let mut client_a = dbx_core::db::sqlserver::connect(
        &host,
        port,
        &user,
        &password,
        Some(&database_a),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect database A");
    let mut client_b = dbx_core::db::sqlserver::connect(
        &host,
        port,
        &user,
        &password,
        Some(&database_b),
        None,
        Duration::from_secs(10),
    )
    .await
    .expect("connect database B");
    dbx_core::db::sqlserver::execute_batch(&mut client_a, "CREATE SCHEMA [IN]")
        .await
        .expect("create database A IN schema");
    dbx_core::db::sqlserver::execute_batch(&mut client_a, "CREATE SCHEMA [OUT]")
        .await
        .expect("create database A OUT schema");
    dbx_core::db::sqlserver::execute_batch(
        &mut client_a,
        "CREATE TABLE [IN].[orders_in] (id INT PRIMARY KEY); CREATE TABLE [OUT].[orders] (id INT PRIMARY KEY, source_marker NVARCHAR(20)); INSERT INTO [OUT].[orders] VALUES (1, N'A');",
    )
    .await
    .expect("create database A fixtures");
    dbx_core::db::sqlserver::execute_batch(&mut client_b, "CREATE SCHEMA [OUT]")
        .await
        .expect("create database B OUT schema");
    dbx_core::db::sqlserver::execute_batch(
        &mut client_b,
        "CREATE TABLE [OUT].[orders_out] (id INT PRIMARY KEY); CREATE TABLE [OUT].[orders] (id INT PRIMARY KEY, target_marker NVARCHAR(20)); INSERT INTO [OUT].[orders] VALUES (1, N'B');",
    )
    .await
    .expect("create database B fixtures");
    drop(client_a);
    drop(client_b);

    let dir = std::env::temp_dir().join(format!("dbx-live-sqlserver-cross-database-{suffix}"));
    std::fs::create_dir_all(&dir).unwrap();
    let storage = Storage::open(&dir.join("storage.db")).await.unwrap();
    let state = AppState::new(storage);
    let connection_id = "live-sqlserver-cross-database";
    let mut config = live_sqlserver_config(connection_id, &default_database);
    config.host = host;
    config.port = port;
    config.username = user;
    config.password = password;
    state.configs.write().await.insert(connection_id.to_string(), config);

    let tables_a = dbx_core::schema::list_tables_core(
        &state,
        connection_id,
        &database_a,
        "IN",
        Some("orders"),
        Some(20),
        None,
        None,
        None,
    )
    .await
    .expect("list database A tables");
    let tables_b = dbx_core::schema::list_tables_core(
        &state,
        connection_id,
        &database_b,
        "OUT",
        Some("orders"),
        Some(20),
        None,
        None,
        None,
    )
    .await
    .expect("list database B tables");
    assert!(tables_a.iter().any(|table| table.name == "orders_in"));
    assert!(tables_b.iter().any(|table| table.name == "orders_out"));

    let columns_a = dbx_core::schema::get_columns_core(&state, connection_id, &database_a, "OUT", "orders")
        .await
        .expect("load database A columns");
    let columns_b = dbx_core::schema::get_columns_core(&state, connection_id, &database_b, "OUT", "orders")
        .await
        .expect("load database B columns");
    assert!(columns_a.iter().any(|column| column.name == "source_marker"));
    assert!(!columns_a.iter().any(|column| column.name == "target_marker"));
    assert!(columns_b.iter().any(|column| column.name == "target_marker"));
    assert!(!columns_b.iter().any(|column| column.name == "source_marker"));

    let query = format!("SELECT a.source_marker, b.target_marker FROM [{database_a}].[OUT].[orders] a JOIN [{database_b}].[OUT].[orders] b ON a.id = b.id");
    let result =
        dbx_core::query::execute_sql_statement(&state, connection_id, &default_database, &query, Some("dbo"), None)
            .await
            .expect("execute cross-database join");
    assert_eq!(result.rows, vec![vec![serde_json::json!("A"), serde_json::json!("B")]]);

    state.remove_connection_pools_detached(connection_id).await;
    for database in [&database_a, &database_b] {
        let cleanup =
            format!("ALTER DATABASE [{database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{database}];");
        dbx_core::db::sqlserver::execute_batch(&mut master, &cleanup).await.expect("drop completion database");
    }
    let _ = std::fs::remove_dir_all(dir);
}
