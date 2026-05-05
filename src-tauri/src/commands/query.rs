use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::db;
use dbx_core::sql::split_sql_statements;

// Re-export core functions for use by other modules (e.g., sql_file.rs)
pub use dbx_core::query::execute_sql_statement;

#[tauri::command]
pub async fn execute_query(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    execution_id: Option<String>,
) -> Result<db::QueryResult, String> {
    let registered_query = execution_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| state.running_queries.register(id.clone()));
    let cancel_token = registered_query.as_ref().map(|query| query.token());

    dbx_core::query::execute_sql_statement(
        &state,
        &connection_id,
        &database,
        &sql,
        cancel_token,
    )
    .await
}

#[tauri::command]
pub async fn execute_multi(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
    execution_id: Option<String>,
) -> Result<Vec<db::QueryResult>, String> {
    let registered_query = execution_id
        .as_ref()
        .filter(|id| !id.trim().is_empty())
        .map(|id| state.running_queries.register(id.clone()));
    let cancel_token = registered_query.as_ref().map(|query| query.token());

    dbx_core::query::execute_multi_core(
        &state,
        &connection_id,
        &database,
        &sql,
        cancel_token,
    )
    .await
}

#[tauri::command]
pub async fn cancel_query(
    state: State<'_, Arc<AppState>>,
    execution_id: String,
) -> Result<bool, String> {
    Ok(state.running_queries.cancel(&execution_id))
}

#[tauri::command]
pub async fn execute_batch(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    statements: Vec<String>,
) -> Result<db::QueryResult, String> {
    dbx_core::query::execute_statements(&state, &connection_id, &database, &statements).await
}

#[tauri::command]
pub async fn execute_script(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    sql: String,
) -> Result<db::QueryResult, String> {
    dbx_core::query::execute_statements(&state, &connection_id, &database, &split_sql_statements(&sql)).await
}
