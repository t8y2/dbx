//! Opt-in live regression for temp-table completion blocking on tempdb catalog
//! locks. A session that creates a temp table inside an open transaction keeps
//! that table's catalog rows locked, and a READ COMMITTED scan of
//! `tempdb.sys.all_objects` used to wait on them indefinitely.
use dbx_driver_sqlserver as native;
use native::types::{CompletionAssistantMatchMode, CompletionAssistantObjectKind, CompletionAssistantRequest};
use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_LIVE_SQLSERVER_HOST/PORT/USER/PASSWORD pointing at a SQL Server"]
async fn live_sqlserver_temp_table_completion_is_not_blocked_by_open_temp_table_transaction() {
    let host = std::env::var("DBX_LIVE_SQLSERVER_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port: u16 = std::env::var("DBX_LIVE_SQLSERVER_PORT").ok().and_then(|value| value.parse().ok()).unwrap_or(1433);
    let username = std::env::var("DBX_LIVE_SQLSERVER_USER").unwrap_or_else(|_| "sa".to_string());
    let password = std::env::var("DBX_LIVE_SQLSERVER_PASSWORD").expect("DBX_LIVE_SQLSERVER_PASSWORD");
    let connect = || native::connect(&host, port, &username, &password, Some("master"), None, Duration::from_secs(15));
    let mut holder = connect().await.expect("connect holder session");
    let mut metadata = connect().await.expect("connect metadata session");

    let table = format!("#dbx_eval_lock_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    native::execute_simple_batch_with_max_rows(
        &mut holder,
        &format!("BEGIN TRANSACTION; CREATE TABLE [{table}] (id int);"),
        Some(1),
    )
    .await
    .expect("open transaction that creates a temp table");

    let request = CompletionAssistantRequest {
        connection_id: "live".to_string(),
        database: "master".to_string(),
        schema: Some("dbo".to_string()),
        object_kinds: vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::View],
        mask: "#dbx_eval_lock".to_string(),
        case_sensitive: false,
        global_search: false,
        max_results: Some(200),
        search_in_comments: false,
        search_in_definitions: false,
        parent_schema: None,
        parent_name: None,
        match_mode: Some(CompletionAssistantMatchMode::Prefix),
    };
    let result =
        tokio::time::timeout(Duration::from_secs(10), native::completion_assistant_search(&mut metadata, &request))
            .await;

    native::execute_simple_batch_with_max_rows(&mut holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;", Some(1))
        .await
        .expect("roll back holder transaction");

    let response = result.expect("temp-table completion must not wait on tempdb catalog locks").expect("completion");
    let names: Vec<&str> = response.candidates.iter().map(|candidate| candidate.name.as_str()).collect();
    println!("candidates: {names:?}");
    assert!(names.contains(&table.as_str()), "expected {table} in {names:?}");
}
