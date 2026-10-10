use dbx_core::{
    connection::AppState,
    schema::oracle_jobs::{oracle_jobs_core, OracleJobsRequest},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn oracle_jobs(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    request: OracleJobsRequest,
) -> Result<serde_json::Value, String> {
    oracle_jobs_core(&state, &connection_id, &database, request).await
}
