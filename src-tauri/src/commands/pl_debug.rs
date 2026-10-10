use std::sync::Arc;
use tauri::State;

use crate::commands::connection::AppState;
use dbx_core::query::pl_debug;

// ---------------------------------------------------------------------------
// PL/SQL debugging commands (OceanBase Oracle mode).
//
// Every command is a thin wrapper around dbx_core::query::pl_debug so the
// desktop and web backends share one implementation. Continuation commands
// (resume/step/abort) intentionally block until the debuggee stops again; the
// frontend keeps the button busy while awaiting them.
//
// Every command returns the agent's response body
// (`{ok, result, message, snapshot}`) unchanged; extra fields added by the
// agent (for example the `frames` array of `pl_debug_get_stack`) are forwarded
// as-is because the whole payload travels as `serde_json::Value`.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pl_debug_probe(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_probe_core(&state, &connection_id).await
}

#[tauri::command]
pub async fn pl_debug_start(
    state: State<'_, Arc<AppState>>,
    connection_id: String,
    database: String,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_start_core(&state, &connection_id, &database, request).await
}

#[tauri::command]
pub async fn pl_debug_set_breakpoints(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    breakpoints: serde_json::Value,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_set_breakpoints_core(&state, &debug_id, breakpoints).await
}

#[tauri::command]
pub async fn pl_debug_delete_breakpoints(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    breakpoints: serde_json::Value,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_delete_breakpoints_core(&state, &debug_id, breakpoints).await
}

#[tauri::command]
pub async fn pl_debug_list_breakpoints(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_list_breakpoints_core(&state, &debug_id).await
}

/// Enables or disables one existing breakpoint in place. The response body
/// carries `serverSupported`, which the frontend uses to decide between the
/// server-side toggle and its delete + re-set fallback.
#[tauri::command]
pub async fn pl_debug_set_breakpoint_enabled(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    breakpoint_number: i64,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_set_breakpoint_enabled_core(&state, &debug_id, breakpoint_number, enabled).await
}

#[tauri::command]
pub async fn pl_debug_resume(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_resume_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_resume_ignore_breakpoints(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_resume_ignore_breakpoints_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_set_value(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    name: String,
    frame: Option<i64>,
    index: Option<i64>,
    value: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_set_value_core(&state, &debug_id, &name, frame.unwrap_or(0), index.unwrap_or(0), &value).await
}

#[tauri::command]
pub async fn pl_debug_set_exception_breakpoint(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_set_exception_breakpoint_core(&state, &debug_id, enabled).await
}

#[tauri::command]
pub async fn pl_debug_step_over(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_step_over_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_step_in(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_step_in_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_step_out(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_step_out_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_abort(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_abort_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_get_variables(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
    frame: Option<i64>,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_get_variables_core(&state, &debug_id, frame).await
}

#[tauri::command]
pub async fn pl_debug_get_stack(
    state: State<'_, Arc<AppState>>,
    debug_id: String,
) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_get_stack_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_get_log(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<serde_json::Value, String> {
    pl_debug::pl_debug_get_log_core(&state, &debug_id).await
}

#[tauri::command]
pub async fn pl_debug_close(state: State<'_, Arc<AppState>>, debug_id: String) -> Result<(), String> {
    pl_debug::pl_debug_close_core(&state, &debug_id).await
}
