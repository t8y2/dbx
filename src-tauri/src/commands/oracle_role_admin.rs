use dbx_core::{
    connection::AppState,
    schema::oracle_role_admin::{oracle_role_admin_core, OracleRoleRequest},
};
use std::sync::Arc;
use tauri::State;
#[tauri::command]
pub async fn oracle_role_admin(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    request: OracleRoleRequest,
) -> Result<serde_json::Value, String> {
    oracle_role_admin_core(&state, &connection_id, &database, request).await
}
