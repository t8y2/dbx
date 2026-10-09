use dbx_core::{
    connection::AppState,
    schema::oracle_user_admin::{oracle_user_admin_core, OracleUserRequest},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn oracle_user_admin(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    request: OracleUserRequest,
) -> Result<serde_json::Value, String> {
    oracle_user_admin_core(&state, &connection_id, &database, request).await
}
