//! Desktop boundary for the shared debugger, adapted from Ziyu Yang's commands.
//! Access identity is established here, never supplied by the frontend.

use std::sync::Arc;

use dbx_core::query::pl_debug::{
    self, PlDebugAccess, PlDebugCompile, PlDebugCompileRef, PlDebugInspect, PlDebugOperation, PlDebugRead,
    PlDebugReceipt, PlDebugSessionRef, PlDebugStart,
};
use serde_json::Value;
use tauri::State;
use uuid::Uuid;

use crate::commands::connection::AppState;

#[tauri::command]
pub async fn pl_debug_bootstrap(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    Ok(pl_debug::pl_debug_bootstrap_core(&state))
}

#[tauri::command]
pub async fn pl_debug_inspect(state: State<'_, Arc<AppState>>, request: PlDebugInspect) -> Result<Value, String> {
    pl_debug::pl_debug_inspect_dispatch_core(&state, &PlDebugAccess::desktop(), request).await
}

#[tauri::command]
pub async fn pl_debug_compile(state: State<'_, Arc<AppState>>, request: PlDebugCompile) -> Result<Value, String> {
    let access = PlDebugAccess::desktop();
    let admission = pl_debug::pl_debug_prepare_compile_core(&state, &access, request)
        .await
        .map_err(pl_debug::PlDebugSubmissionError::into_boundary_string)?;
    pl_debug::pl_debug_submit_compile_core(&state, &access, admission)
        .map_err(pl_debug::PlDebugSubmissionError::into_boundary_string)
}

#[tauri::command]
pub fn pl_debug_compile_status(state: State<'_, Arc<AppState>>, reference: PlDebugCompileRef) -> Result<Value, String> {
    pl_debug::pl_debug_compile_status_core(&state, &PlDebugAccess::desktop(), reference)
}

#[tauri::command]
pub async fn pl_debug_list(
    state: State<'_, Arc<AppState>>,
    server_epoch: Uuid,
    connection_id: String,
) -> Result<Vec<Value>, String> {
    pl_debug::pl_debug_list_core(&state, &PlDebugAccess::desktop(), server_epoch, &connection_id)
}

#[tauri::command]
pub async fn pl_debug_start(state: State<'_, Arc<AppState>>, request: PlDebugStart) -> Result<PlDebugReceipt, String> {
    pl_debug::pl_debug_start_submission_core(&state, &PlDebugAccess::desktop(), request)
        .map_err(pl_debug::PlDebugSubmissionError::into_boundary_string)
}

#[tauri::command]
pub async fn pl_debug_status(
    state: State<'_, Arc<AppState>>,
    reference: PlDebugSessionRef,
    refresh: bool,
) -> Result<Value, String> {
    pl_debug::pl_debug_status_core(&state, &PlDebugAccess::desktop(), &reference, refresh).await
}

#[tauri::command]
pub async fn pl_debug_heartbeat(
    state: State<'_, Arc<AppState>>,
    reference: PlDebugSessionRef,
) -> Result<Value, String> {
    pl_debug::pl_debug_heartbeat_core(&state, &PlDebugAccess::desktop(), &reference).await
}

#[tauri::command]
pub async fn pl_debug_operation(
    state: State<'_, Arc<AppState>>,
    reference: PlDebugSessionRef,
    operation_id: String,
) -> Result<PlDebugReceipt, String> {
    pl_debug::pl_debug_operation_core(&state, &PlDebugAccess::desktop(), &reference, &operation_id)
}

#[tauri::command]
pub async fn pl_debug_operate(
    state: State<'_, Arc<AppState>>,
    request: PlDebugOperation,
) -> Result<PlDebugReceipt, String> {
    pl_debug::pl_debug_operate_submission_core(&state, &PlDebugAccess::desktop(), request)
        .await
        .map_err(pl_debug::PlDebugSubmissionError::into_boundary_string)
}

#[tauri::command]
pub async fn pl_debug_read(state: State<'_, Arc<AppState>>, request: PlDebugRead) -> Result<Value, String> {
    pl_debug::pl_debug_read_core(&state, &PlDebugAccess::desktop(), request).await
}
