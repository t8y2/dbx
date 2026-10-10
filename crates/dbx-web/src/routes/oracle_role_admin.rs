use crate::{error::AppError, state::WebState};
use axum::{extract::State, Json};
use dbx_core::schema::oracle_role_admin::{oracle_role_admin_core, OracleRoleRequest};
use serde::Deserialize;
use std::sync::Arc;
#[derive(Deserialize)]
pub struct Request {
    connection_id: String,
    database: String,
    request: OracleRoleRequest,
}
pub async fn oracle_role_admin(
    State(state): State<Arc<WebState>>,
    Json(input): Json<Request>,
) -> Result<Json<serde_json::Value>, AppError> {
    oracle_role_admin_core(&state.app, &input.connection_id, &input.database, input.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}
