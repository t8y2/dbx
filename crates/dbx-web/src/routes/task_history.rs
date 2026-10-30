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
    pub started_at_from: Option<String>,
    pub started_at_before: Option<String>,
    pub source_query: Option<String>,
    pub target_query: Option<String>,
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
    let query = TaskRunListQuery {
        limit: params.limit,
        cursor,
        task_type: params.task_type,
        status: params.status,
        started_at_from: params.started_at_from,
        started_at_before: params.started_at_before,
        source_query: params.source_query,
        target_query: params.target_query,
    };
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

#[cfg(test)]
mod tests {
    use super::TaskRunListParams;
    use dbx_core::persistence::task_history::TaskRunStatus;

    #[test]
    fn task_run_list_params_deserialize_filter_contract_and_keep_old_queries_valid() {
        let params: TaskRunListParams = serde_json::from_str(
            r#"{
                "limit": 25,
                "cursorCreatedAt": "2025-01-01T00:00:00.000Z",
                "cursorRunId": "run-1",
                "status": "partial_failed",
                "startedAtFrom": "2025-01-01T00:00:00.000Z",
                "startedAtBefore": "2025-01-02T00:00:00.000Z",
                "sourceQuery": "source-db",
                "targetQuery": "target-db"
            }"#,
        )
        .unwrap();

        assert_eq!(params.limit, Some(25));
        assert_eq!(params.cursor_created_at.as_deref(), Some("2025-01-01T00:00:00.000Z"));
        assert_eq!(params.cursor_run_id.as_deref(), Some("run-1"));
        assert_eq!(params.status, Some(TaskRunStatus::PartialFailed));
        assert_eq!(params.started_at_from.as_deref(), Some("2025-01-01T00:00:00.000Z"));
        assert_eq!(params.started_at_before.as_deref(), Some("2025-01-02T00:00:00.000Z"));
        assert_eq!(params.source_query.as_deref(), Some("source-db"));
        assert_eq!(params.target_query.as_deref(), Some("target-db"));

        let legacy: TaskRunListParams = serde_json::from_str("{}").unwrap();
        assert!(legacy.started_at_from.is_none());
        assert!(legacy.started_at_before.is_none());
        assert!(legacy.source_query.is_none());
        assert!(legacy.target_query.is_none());
    }
}
