use dbx_core::connection::{AppState, PoolKind};
use dbx_core::models::connection::DatabaseType;
use dbx_core::query_result_export::{export_query_result_core, ExportStatus, QueryResultExportRequest};
use dbx_core::storage::Storage;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_execute_query_creates_schema() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), Duration::from_secs(10))
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
async fn live_sqlserver_stream_first_result_set_exports_cte_query_rows() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), Duration::from_secs(10))
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
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), Duration::from_secs(10))
            .await
            .expect("connect SQL Server");
    let export_client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), Duration::from_secs(10))
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
#[ignore = "requires DBX_LIVE_SQLSERVER_URL or DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a writable SQL Server database"]
async fn live_sqlserver_completion_assistant_searches_metadata_before_limiting() {
    let database = std::env::var("DBX_LIVE_SQLSERVER_DATABASE").unwrap_or_else(|_| "tempdb".to_string());
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let user = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let mut client =
        dbx_core::db::sqlserver::connect(&host, port, &user, &password, Some(&database), Duration::from_secs(10))
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
