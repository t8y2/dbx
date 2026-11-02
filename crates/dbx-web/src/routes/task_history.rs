use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::Json;
use dbx_core::persistence::task_history::{
    TaskRunCursor, TaskRunDetail, TaskRunItemsPage, TaskRunItemsQuery, TaskRunListQuery, TaskRunPage, TaskRunStatus,
    TaskType,
};
use serde::Deserialize;

use crate::error::AppError;
use crate::state::WebState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunListParams {
    pub limit: Option<usize>,
    pub cursor_created_at: Option<String>,
    pub cursor_run_id: Option<String>,
    pub task_type: Option<TaskType>,
    pub status: Option<TaskRunStatus>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunItemsParams {
    pub limit: Option<usize>,
    pub after_item_index: Option<i64>,
}

pub async fn list_task_runs(
    State(state): State<Arc<WebState>>,
    Query(params): Query<TaskRunListParams>,
) -> Result<Json<TaskRunPage>, AppError> {
    let cursor = match (params.cursor_created_at, params.cursor_run_id) {
        (Some(created_at), Some(run_id)) => Some(TaskRunCursor { created_at, run_id }),
        (None, None) => None,
        _ => return Err(AppError::bad_request("Both cursorCreatedAt and cursorRunId are required.")),
    };
    let query = TaskRunListQuery { limit: params.limit, cursor, task_type: params.task_type, status: params.status };
    state.app.storage.list_task_runs(query).await.map(Json).map_err(|error| AppError::internal(error.code()))
}

pub async fn get_task_run(
    State(state): State<Arc<WebState>>,
    Path(run_id): Path<String>,
) -> Result<Json<TaskRunDetail>, AppError> {
    state
        .app
        .storage
        .get_task_run_detail(&run_id)
        .await
        .map_err(|error| AppError::internal(error.code()))?
        .map(Json)
        .ok_or_else(|| AppError::not_found("TASK_RUN_NOT_FOUND"))
}

pub async fn list_task_run_items(
    State(state): State<Arc<WebState>>,
    Path(run_id): Path<String>,
    Query(params): Query<TaskRunItemsParams>,
) -> Result<Json<TaskRunItemsPage>, AppError> {
    if state.app.storage.get_task_run_detail(&run_id).await.map_err(|error| AppError::internal(error.code()))?.is_none()
    {
        return Err(AppError::not_found("TASK_RUN_NOT_FOUND"));
    }
    let query = TaskRunItemsQuery { limit: params.limit, after_item_index: params.after_item_index };
    state
        .app
        .storage
        .list_task_run_items(&run_id, query)
        .await
        .map(Json)
        .map_err(|error| AppError::internal(error.code()))
}
