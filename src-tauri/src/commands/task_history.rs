use std::sync::Arc;

use tauri::State;

use super::connection::AppState;
use dbx_core::persistence::task_history::{
    TaskRunDetail, TaskRunItemsPage, TaskRunItemsQuery, TaskRunListQuery, TaskRunPage,
};

#[tauri::command]
pub async fn load_task_runs(state: State<'_, Arc<AppState>>, query: TaskRunListQuery) -> Result<TaskRunPage, String> {
    state.storage.list_task_runs(query).await.map_err(|error| error.code().to_string())
}

#[tauri::command]
pub async fn load_task_run(state: State<'_, Arc<AppState>>, run_id: String) -> Result<Option<TaskRunDetail>, String> {
    state.storage.get_task_run_detail(&run_id).await.map_err(|error| error.code().to_string())
}

#[tauri::command]
pub async fn load_task_run_items(
    state: State<'_, Arc<AppState>>,
    run_id: String,
    query: TaskRunItemsQuery,
) -> Result<TaskRunItemsPage, String> {
    state.storage.list_task_run_items(&run_id, query).await.map_err(|error| error.code().to_string())
}
