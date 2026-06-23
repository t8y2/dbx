use std::time::Duration;

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
    let schema = format!("dbx_completion_{suffix}");
    let prefix = format!("needle_{suffix}");
    let table = format!("{prefix}_table");
    let setup = format!(
        "CREATE SCHEMA [{schema}]; CREATE TABLE [{schema}].[{table}] (id INT NOT NULL, display_name NVARCHAR(64) NULL);"
    );
    dbx_core::db::sqlserver::execute_query(&mut client, &setup).await.expect("create live test objects");

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

    let cleanup = format!("DROP TABLE [{schema}].[{table}]; DROP SCHEMA [{schema}];");
    let _ = dbx_core::db::sqlserver::execute_query(&mut client, &cleanup).await;
}
