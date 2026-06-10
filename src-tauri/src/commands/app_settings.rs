use std::{path::PathBuf, sync::Arc};

use dbx_core::storage::DesktopSettings;
use tauri::{AppHandle, Manager, State};

use super::connection::AppState;
use crate::{apply_debug_log_level, apply_desktop_settings};

#[tauri::command]
pub async fn load_desktop_settings(state: State<'_, Arc<AppState>>) -> Result<DesktopSettings, String> {
    state.storage.load_desktop_settings().await
}

#[tauri::command]
pub async fn save_desktop_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    settings: DesktopSettings,
) -> Result<(), String> {
    state.storage.save_desktop_settings(&settings).await?;
    apply_debug_log_level(settings.debug_logging_enabled);
    if let Err(err) = apply_desktop_settings(&app, &settings) {
        eprintln!("Failed to apply desktop settings: {err}");
    }
    Ok(())
}

#[tauri::command]
pub async fn load_pinned_tree_node_ids(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    state.storage.load_pinned_tree_node_ids().await
}

#[tauri::command]
pub async fn save_pinned_tree_node_ids(state: State<'_, Arc<AppState>>, ids: Vec<String>) -> Result<(), String> {
    state.storage.save_pinned_tree_node_ids(&ids).await
}

#[tauri::command]
pub async fn load_native_debug_logs(app: AppHandle) -> Result<String, String> {
    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || load_native_debug_logs_from_dir(log_dir))
        .await
        .map_err(|err| err.to_string())?
}

fn load_native_debug_logs_from_dir(log_dir: PathBuf) -> Result<String, String> {
    const MAX_FILES: usize = 6;
    const MAX_FILE_BYTES: u64 = 512 * 1024;
    if !log_dir.exists() {
        return Ok(format!("Native log dir does not exist yet: {}", log_dir.display()));
    }
    let mut files = std::fs::read_dir(&log_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let modified = metadata.modified().ok()?;
            Some((path, modified, metadata.len()))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified, _)| *modified);
    files.reverse();

    let mut output = String::new();
    output.push_str(&format!("Native log dir: {}\n", log_dir.display()));
    for (path, _, len) in files.into_iter().take(MAX_FILES) {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("unknown");
        output.push_str(&format!("\n===== {name} =====\n"));
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let start = if len > MAX_FILE_BYTES { bytes.len().saturating_sub(MAX_FILE_BYTES as usize) } else { 0 };
        if start > 0 {
            output.push_str("[truncated to last 512 KiB]\n");
        }
        output.push_str(&String::from_utf8_lossy(&bytes[start..]));
        output.push('\n');
    }
    Ok(output)
}
