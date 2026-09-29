//! Read-only tests against explicitly configured disposable fixtures.
//! Doris is related-engine evidence, not an exact SelectDB 3.0.11 reproduction.
use dbx_drivers::db::mysql;
use dbx_drivers::types::{CompletionAssistantObjectKind, CompletionAssistantRequest};
use serde_json::json;
use std::time::Duration;

fn request(database: &str, mask: &str, kinds: &[&str], limit: usize) -> CompletionAssistantRequest {
    serde_json::from_value(json!({
        "connection_id": "live-routine-completion", "database": database, "schema": database,
        "object_kinds": kinds, "mask": mask, "max_results": limit, "match_mode": "prefix"
    }))
    .unwrap()
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_DORIS_ROUTINES_URL and DATABASE with probe_table fixture on Doris lacking ROUTINES.DATA_TYPE"]
async fn live_doris_routine_completion_preserves_mixed_table_results() {
    let url = std::env::var("DBX_LIVE_DORIS_ROUTINES_URL").expect("DBX_LIVE_DORIS_ROUTINES_URL");
    let database = std::env::var("DBX_LIVE_DORIS_ROUTINES_DATABASE").expect("DBX_LIVE_DORIS_ROUTINES_DATABASE");
    // Doris does not accept MySQL-specific session initialization (for example
    // GROUP_CONCAT setup); test the shared metadata query over its bare protocol.
    let pool = mysql::connect_bare(&url, Duration::from_secs(15)).await.unwrap();
    let baseline = mysql::execute_query(&pool, "SELECT DATA_TYPE FROM information_schema.ROUTINES", false)
        .await
        .expect_err("fixture must lack DATA_TYPE to exercise the compatibility path");
    assert!(baseline.contains("Unknown column 'DATA_TYPE'"), "{baseline}");
    let mut query = request(&database, "probe", &["table", "function"], 200);
    let mixed = mysql::completion_assistant_search(&pool, &query).await.unwrap();
    assert!(mixed.fallback_used);
    assert!(!mixed.incomplete);
    assert!(mixed.candidates.iter().any(|candidate| candidate.name == "probe_table"));
    query.object_kinds = vec![CompletionAssistantObjectKind::Function];
    let routines = mysql::completion_assistant_search(&pool, &query).await.unwrap();
    assert!(routines.fallback_used);
    assert!(routines.candidates.is_empty());
    query.object_kinds = vec![CompletionAssistantObjectKind::Table, CompletionAssistantObjectKind::Function];
    query.max_results = Some(1);
    let limited = mysql::completion_assistant_search(&pool, &query).await.unwrap();
    assert_eq!(limited.candidates.len(), 1);
    assert!(limited.incomplete);
    assert!(!limited.fallback_used, "filled table limit must skip routine query");
    let schemas =
        mysql::completion_assistant_search(&pool, &request(&database, &database, &["schema"], 200)).await.unwrap();
    assert!(schemas.candidates.iter().any(|candidate| candidate.name == database));
    assert!(!schemas.fallback_used, "this Doris fixture accepts explicit ESCAPE");
    let mut columns = request(&database, "id", &["column"], 200);
    columns.parent_name = Some("probe_table".into());
    let columns = mysql::completion_assistant_search(&pool, &columns).await.unwrap();
    assert!(columns.candidates.iter().any(|candidate| candidate.name == "id"));
    assert!(!columns.fallback_used);
    pool.disconnect().await.unwrap();
}

#[tokio::test]
#[ignore = "requires DBX_LIVE_MYSQL_ROUTINES_URL and DATABASE with dbx_probe_fn(INT) RETURNS INT fixture"]
async fn live_mysql_routine_completion_keeps_primary_base_type() {
    let url = std::env::var("DBX_LIVE_MYSQL_ROUTINES_URL").expect("DBX_LIVE_MYSQL_ROUTINES_URL");
    let database = std::env::var("DBX_LIVE_MYSQL_ROUTINES_DATABASE").expect("DBX_LIVE_MYSQL_ROUTINES_DATABASE");
    let pool = mysql::connect(&url, Duration::from_secs(15)).await.unwrap();
    let query = request(&database, "dbx_probe_", &["function"], 200);
    let response = mysql::completion_assistant_search(&pool, &query).await.unwrap();
    assert!(!response.fallback_used);
    let function = response.candidates.iter().find(|candidate| candidate.name == "dbx_probe_fn").unwrap();
    assert_eq!(function.data_type.as_deref(), Some("int"));
    assert_eq!(function.schema.as_deref(), Some(database.as_str()));
    let mixed =
        mysql::completion_assistant_search(&pool, &request(&database, "%", &["schema", "table", "function"], 1000))
            .await
            .unwrap();
    assert!(!mixed.fallback_used);
    assert!(mixed.candidates.iter().any(|candidate| candidate.name == database));
    assert!(mixed.candidates.iter().any(|candidate| candidate.name == "dbx_probe_fn"));
    pool.disconnect().await.unwrap();
}
