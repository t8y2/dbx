use std::sync::Arc;
use tauri::{Emitter, State};

use dbx_core::agent_service::AgentProgressEvent;
use dbx_core::jdbc::{
    self, JdbcDriverInfo, JdbcLocalBundleInfo, JdbcMavenBundleInfo, JdbcMavenInstallRequest, JdbcPluginStatus,
};
use dbx_core::plugins::InstalledPlugin;

use super::connection::AppState;

#[tauri::command]
pub async fn list_plugins(state: State<'_, Arc<AppState>>) -> Result<Vec<InstalledPlugin>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || dbx_core::plugins::PluginRegistry::new(root_dir).list_installed())
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn jdbc_plugin_status(state: State<'_, Arc<AppState>>) -> Result<JdbcPluginStatus, String> {
    jdbc::get_jdbc_plugin_status(state.plugins.root_dir()).await
}

#[tauri::command]
pub async fn install_jdbc_plugin(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<JdbcPluginStatus, String> {
    let app_handle = app.clone();
    state.remove_external_driver_pools("jdbc").await;
    jdbc::install_jdbc_plugin_with_progress(state.plugins.root_dir(), move |event| {
        emit_agent_progress(&app_handle, event);
    })
    .await
}

#[tauri::command]
pub async fn install_jdbc_plugin_local(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<JdbcPluginStatus, String> {
    state.remove_external_driver_pools("jdbc").await;
    jdbc::install_jdbc_plugin_from_file(state.plugins.root_dir(), &path).await
}

#[tauri::command]
pub async fn uninstall_jdbc_plugin(state: State<'_, Arc<AppState>>) -> Result<JdbcPluginStatus, String> {
    state.remove_external_driver_pools("jdbc").await;
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::uninstall_jdbc_plugin(&root_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn list_jdbc_drivers(state: State<'_, Arc<AppState>>) -> Result<Vec<JdbcDriverInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::list_jdbc_drivers(&root_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn list_jdbc_maven_bundles(state: State<'_, Arc<AppState>>) -> Result<Vec<JdbcMavenBundleInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::list_jdbc_maven_bundles(&root_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn list_jdbc_local_bundles(state: State<'_, Arc<AppState>>) -> Result<Vec<JdbcLocalBundleInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::list_jdbc_local_bundles(&root_dir))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn install_jdbc_driver_from_maven(
    state: State<'_, Arc<AppState>>,
    request: JdbcMavenInstallRequest,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let env = state.external_driver_runtime_env("jdbc")?;
    jdbc::install_jdbc_driver_from_maven(state.plugins.root_dir(), request, env).await
}

#[tauri::command]
pub async fn install_prestosql_jdbc_driver(state: State<'_, Arc<AppState>>) -> Result<Vec<JdbcDriverInfo>, String> {
    jdbc::install_prestosql_jdbc_driver(state.plugins.root_dir()).await
}

#[tauri::command]
pub async fn import_jdbc_drivers(
    state: State<'_, Arc<AppState>>,
    paths: Vec<String>,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::import_jdbc_drivers(&root_dir, &paths))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn delete_jdbc_driver(state: State<'_, Arc<AppState>>, path: String) -> Result<Vec<JdbcDriverInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::delete_jdbc_driver(&root_dir, &path))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn delete_jdbc_maven_bundle(
    state: State<'_, Arc<AppState>>,
    bundle_id: String,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::delete_jdbc_maven_bundle(&root_dir, &bundle_id))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn delete_jdbc_local_bundle(
    state: State<'_, Arc<AppState>>,
    bundle_id: String,
) -> Result<Vec<JdbcDriverInfo>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || jdbc::delete_jdbc_local_bundle(&root_dir, &bundle_id))
        .await
        .map_err(|err| err.to_string())?
}

fn emit_agent_progress(app: &tauri::AppHandle, event: AgentProgressEvent) {
    let _ = app.emit("agent-install-progress", event);
}
