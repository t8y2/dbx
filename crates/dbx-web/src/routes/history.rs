use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use dbx_core::history::{HistoryConnectionOption, HistoryEntry, HistorySearchRequest, HistorySearchResult};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub activity_kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveHistoryRequest {
    pub entry: HistoryEntry,
}

pub async fn save_history(
    State(state): State<Arc<WebState>>,
    Json(body): Json<SaveHistoryRequest>,
) -> Result<Json<()>, AppError> {
    state.app.storage.save_history_entry(&body.entry).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn load_history(
    State(state): State<Arc<WebState>>,
    Query(q): Query<HistoryQuery>,
) -> Result<Json<Vec<HistoryEntry>>, AppError> {
    let limit = q.limit.unwrap_or(100);
    let offset = q.offset.unwrap_or(0);
    let entries =
        state.app.storage.load_history_entries(limit, offset, q.activity_kind).await.map_err(AppError::from)?;
    Ok(Json(entries))
}

pub async fn search_history(
    State(state): State<Arc<WebState>>,
    Json(request): Json<HistorySearchRequest>,
) -> Result<Json<HistorySearchResult>, AppError> {
    state.app.storage.search_history_entries(request).await.map(Json).map_err(AppError::from)
}

pub async fn load_history_connection_options(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<HistoryConnectionOption>>, AppError> {
    state.app.storage.load_history_connection_options().await.map(Json).map_err(AppError::from)
}

pub async fn clear_history(State(state): State<Arc<WebState>>) -> Result<Json<()>, AppError> {
    state.app.storage.clear_history().await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn delete_history_entry(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_history_entry(&id).await.map_err(AppError::from)?;
    Ok(Json(()))
}
