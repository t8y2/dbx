use crate::{error::AppError, state::WebState};
use axum::{extract::State, Json};
use dbx_core::schema::oracle_jobs::{oracle_jobs_core, OracleJobsRequest};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct Request {
    connection_id: String,
    database: String,
    request: OracleJobsRequest,
}

pub async fn oracle_jobs(
    State(state): State<Arc<WebState>>,
    Json(input): Json<Request>,
) -> Result<Json<serde_json::Value>, AppError> {
    oracle_jobs_core(&state.app, &input.connection_id, &input.database, input.request)
        .await
        .map(Json)
        .map_err(AppError::from)
}
