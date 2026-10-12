use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

use crate::commands::connection::AppState;

pub use dbx_core::dameng_dump::{resolve_damp_tool_path, DamengDumpKindArg, DamengDumpProgress, DamengDumpTaskRequest};

fn emit_progress(app: &AppHandle, progress: DamengDumpProgress) {
    let _ = app.emit("dameng-dump-progress", progress);
}

/// Start one native dexp/dimp run. The core emits a `Running` progress at
/// start and exactly one terminal event (`Done`/`Error`/`Cancelled`) before
/// returning, so this wrapper never synthesizes progress of its own.
#[tauri::command]
pub async fn start_dameng_dump(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    request: DamengDumpTaskRequest,
) -> Result<(), String> {
    let state = state.inner().clone();
    let task_id = request.task_id.clone();
    dbx_core::export_runtime::spawn_export_task(async move {
        let _ = dbx_core::dameng_dump::run_dameng_dump_task(&state, &request, |progress| emit_progress(&app, progress))
            .await;
        dbx_core::dameng_dump::finish_dameng_dump_task(&task_id).await;
    });
    Ok(())
}

#[tauri::command]
pub async fn cancel_dameng_dump(task_id: String) -> Result<(), String> {
    dbx_core::database_export::set_export_cancelled(&task_id).await;
    Ok(())
}

/// Resolve the `dexp`/`dimp` executable inside the user-configured client bin
/// directory, so the settings UI can show a precise "tool not found" state
/// without starting a dump.
#[tauri::command]
pub async fn resolve_dameng_dump_tool(bin_dir: String, kind: DamengDumpKindArg) -> Result<String, String> {
    resolve_damp_tool_path(&bin_dir, kind.into()).map(|path| path.to_string_lossy().into_owned())
}
