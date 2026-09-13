use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;

use dbx_core::data_view::{self, DataView, DataViewExecuteOptions, DataViewSummary, ExecuteDataViewResponse};
use dbx_core::data_view_params::DataViewParamValue;

use crate::error::AppError;
use crate::state::WebState;

pub async fn list_data_views(State(state): State<Arc<WebState>>) -> Result<Json<Vec<DataViewSummary>>, AppError> {
    let views = state.app.storage.list_data_views().await.map_err(AppError::from)?;
    Ok(Json(views))
}

pub async fn load_data_view(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<Option<DataView>>, AppError> {
    let view = state.app.storage.load_data_view(&id).await.map_err(AppError::from)?;
    Ok(Json(view))
}

pub async fn save_data_view(
    State(state): State<Arc<WebState>>,
    Json(view): Json<DataView>,
) -> Result<Json<DataView>, AppError> {
    state.app.storage.save_data_view(&view).await.map_err(AppError::from)?;
    Ok(Json(view))
}

pub async fn delete_data_view(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
) -> Result<Json<()>, AppError> {
    state.app.storage.delete_data_view(&id).await.map_err(AppError::from)?;
    Ok(Json(()))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteDataViewRequest {
    #[serde(default)]
    pub variables: HashMap<String, DataViewParamValue>,
    pub max_rows: Option<usize>,
    pub timeout_secs: Option<u64>,
    pub client_session_id: Option<String>,
    pub query_ids: Option<Vec<String>>,
    #[serde(default)]
    pub allow_mutations: bool,
}

pub async fn execute_data_view(
    State(state): State<Arc<WebState>>,
    Path(id): Path<String>,
    Json(req): Json<ExecuteDataViewRequest>,
) -> Result<Json<ExecuteDataViewResponse>, AppError> {
    let view = state
        .app
        .storage
        .load_data_view(&id)
        .await
        .map_err(AppError::from)?
        .ok_or_else(|| AppError::not_found("data view not found"))?;

    let response = data_view::execute_data_view(
        &state.app,
        &view,
        &req.variables,
        &DataViewExecuteOptions {
            max_rows: req.max_rows,
            timeout_secs: req.timeout_secs,
            client_session_id: req.client_session_id,
            query_ids: req.query_ids,
            allow_mutations: req.allow_mutations,
        },
    )
    .await;

    Ok(Json(response))
}
