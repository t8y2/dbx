use crate::{error::AppError, state::WebState};
use axum::{extract::State, Json};
use dbx_core::schema::oracle_user_admin::{oracle_user_admin_core, OracleUserRequest};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct Request {
    connection_id: String,
    database: String,
    request: OracleUserRequest,
}
pub async fn oracle_user_admin(
    State(state): State<Arc<WebState>>,
    Json(input): Json<Request>,
) -> Result<Json<serde_json::Value>, AppError> {
    oracle_user_admin_core(&state.app, &input.connection_id, &input.database, input.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}
