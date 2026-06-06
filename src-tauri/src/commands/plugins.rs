use std::sync::Arc;
use tauri::State;

use dbx_core::jdbc::{self, JdbcDriverInfo, JdbcPluginStatus};
use dbx_core::plugins::InstalledPlugin;

use super::connection::AppState;

#[tauri::command]
pub async fn list_plugins(state: State<'_, Arc<AppState>>) -> Result<Vec<InstalledPlugin>, String> {
    state.plugins.list_installed()
}

#[tauri::command]
pub async fn jdbc_plugin_status(state: State<'_, Arc<AppState>>) -> Result<JdbcPluginStatus, String> {
    jdbc::get_jdbc_plugin_status(state.plugins.root_dir()).await
}

#[tauri::command]
pub async fn install_jdbc_plugin(state: State<'_, Arc<AppState>>) -> Result<JdbcPluginStatus, String> {
    jdbc::install_jdbc_plugin(state.plugins.root_dir()).await
}

#[tauri::command]
pub async fn install_jdbc_plugin_local(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<JdbcPluginStatus, String> {
    jdbc::install_jdbc_plugin_from_file(state.plugins.root_dir(), &path).await
}

#[tauri::command]
pub async fn uninstall_jdbc_plugin(state: State<'_, Arc<AppState>>) -> Result<JdbcPluginStatus, String> {
    jdbc::uninstall_jdbc_plugin(state.plugins.root_dir())
}

#[tauri::command]
pub async fn list_jdbc_drivers(state: State<'_, Arc<AppState>>) -> Result<Vec<JdbcDriverInfo>, String> {
    jdbc::list_jdbc_drivers(state.plugins.root_dir())
}

#[tauri::command]
pub async fn import_jdbc_drivers(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<Vec<JdbcDriverInfo>, String> {
    jdbc::import_jdbc_drivers(state.plugins.root_dir(), &paths)
}

#[tauri::command]
pub async fn delete_jdbc_driver(state: State<'_, Arc<AppState>>, path: String) -> Result<Vec<JdbcDriverInfo>, String> {
    jdbc::delete_jdbc_driver(state.plugins.root_dir(), &path)
}
