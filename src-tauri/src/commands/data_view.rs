use std::collections::HashMap;
use std::sync::Arc;

use tauri::State;

use dbx_core::connection::AppState;
use dbx_core::data_view::{
    execute_data_view, DataView, DataViewExecuteOptions, DataViewSummary, ExecuteDataViewResponse,
};
use dbx_core::data_view_params::DataViewParamValue;

#[tauri::command]
pub async fn list_data_views(state: State<'_, Arc<AppState>>) -> Result<Vec<DataViewSummary>, String> {
    state.storage.list_data_views().await
}

#[tauri::command]
pub async fn load_data_view(state: State<'_, Arc<AppState>>, id: String) -> Result<Option<DataView>, String> {
    state.storage.load_data_view(&id).await
}

#[tauri::command]
pub async fn save_data_view(state: State<'_, Arc<AppState>>, view: DataView) -> Result<DataView, String> {
    state.storage.save_data_view(&view).await?;
    Ok(view)
}

#[tauri::command]
pub async fn delete_data_view(state: State<'_, Arc<AppState>>, id: String) -> Result<(), String> {
    state.storage.delete_data_view(&id).await
}

#[tauri::command]
pub async fn execute_data_view_query(
    state: State<'_, Arc<AppState>>,
    id: String,
    variables: HashMap<String, DataViewParamValue>,
    max_rows: Option<usize>,
    timeout_secs: Option<u64>,
    client_session_id: Option<String>,
    query_ids: Option<Vec<String>>,
    allow_mutations: Option<bool>,
) -> Result<ExecuteDataViewResponse, String> {
    let view = state.storage.load_data_view(&id).await?.ok_or_else(|| "data view not found".to_string())?;
    let response = execute_data_view(
        &state,
        &view,
        &variables,
        &DataViewExecuteOptions {
            max_rows,
            timeout_secs,
            client_session_id,
            query_ids,
            allow_mutations: allow_mutations.unwrap_or(false),
        },
    )
    .await;
    Ok(response)
}
