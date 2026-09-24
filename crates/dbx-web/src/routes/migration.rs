use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use dbx_core::storage::{MigrationPreflight, MigrationReport};
use serde_json::json;
use std::sync::Arc;

use crate::state::WebState;

pub async fn status(
    State(state): State<Arc<WebState>>,
) -> Result<Json<MigrationPreflight>, (StatusCode, Json<serde_json::Value>)> {
    state.app.storage.inspect_data_migration().await.map(Json).map_err(error_response)
}

pub async fn start(
    State(state): State<Arc<WebState>>,
) -> Result<Json<MigrationReport>, (StatusCode, Json<serde_json::Value>)> {
    state.migration_ready.store(false, std::sync::atomic::Ordering::Release);
    match state.app.storage.start_data_migration().await {
        Ok(report) => {
            let ready =
                state.app.storage.inspect_data_migration().await.map(|status| status.is_ready()).unwrap_or(false);
            state.migration_ready.store(ready, std::sync::atomic::Ordering::Release);
            Ok(Json(report))
        }
        Err(error) => {
            state.migration_ready.store(false, std::sync::atomic::Ordering::Release);
            Err(error_response(error))
        }
    }
}

pub async fn retry(
    State(state): State<Arc<WebState>>,
) -> Result<Json<MigrationReport>, (StatusCode, Json<serde_json::Value>)> {
    start(State(state)).await
}

pub async fn cleanup_backups(
    State(state): State<Arc<WebState>>,
) -> Result<impl IntoResponse, (StatusCode, Json<serde_json::Value>)> {
    state.app.storage.cleanup_migration_backups().await.map_err(error_response)?;
    Ok(StatusCode::NO_CONTENT)
}

fn error_response(error: String) -> (StatusCode, Json<serde_json::Value>) {
    (StatusCode::BAD_REQUEST, Json(json!({"error": error})))
}
