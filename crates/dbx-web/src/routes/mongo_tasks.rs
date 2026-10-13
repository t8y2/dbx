use std::sync::Arc;
use axum::{extract::State, Json};
use dbx_core::mongo_tasks::{MongoTaskCommand, MongoTaskService};
use crate::{error::AppError, state::WebState};

pub fn service(state: &WebState) -> MongoTaskService { MongoTaskService::new(state.app.clone(), &state.data_dir) }

pub async fn command(State(state): State<Arc<WebState>>, Json(command): Json<MongoTaskCommand>) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(service(&state).command(command).await?))
}
