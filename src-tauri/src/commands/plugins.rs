use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{Emitter, State};

use dbx_core::agent_service::AgentProgressEvent;
use dbx_core::jdbc::{
    self, JdbcDriverInfo, JdbcLocalBundleInfo, JdbcMavenBundleInfo, JdbcMavenInstallRequest, JdbcPluginStatus,
};
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugins::{
    ActivePluginSession, InstalledPlugin, InstalledPluginInfo, PluginConnectionActionResult,
    PluginFilesystemListResult, PluginFilesystemMutationResult, PluginFilesystemReadResult, PluginInstallPolicy,
    PluginInstallResponse, PluginMarketplace, PluginMarketplaceInstallRequest, PluginPackageInstaller,
    PluginRepository, PluginRepositoryCatalogResult, PluginRollbackResponse, PluginTrustStore, PluginTrustedKey,
    PluginUiAsset,
};

use super::connection::AppState;

#[tauri::command]
pub async fn list_plugins(state: State<'_, Arc<AppState>>) -> Result<Vec<InstalledPluginInfo>, String> {
    let registry = state.plugins.clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.list_installed().map(|plugins| plugins.into_iter().map(|plugin| plugin.info()).collect())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn list_plugin_trusted_keys(state: State<'_, Arc<AppState>>) -> Result<Vec<PluginTrustedKey>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || PluginTrustStore::list_base64_keys(&root_dir))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_plugin_trusted_key(
    state: State<'_, Arc<AppState>>,
    key_id: String,
    public_key: String,
) -> Result<Vec<PluginTrustedKey>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        PluginTrustStore::save_base64_key(&root_dir, &key_id, &public_key)?;
        PluginTrustStore::list_base64_keys(&root_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_plugin_trusted_key(
    state: State<'_, Arc<AppState>>,
    key_id: String,
) -> Result<Vec<PluginTrustedKey>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        PluginTrustStore::remove_key(&root_dir, &key_id)?;
        PluginTrustStore::list_base64_keys(&root_dir)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_plugin_repositories(state: State<'_, Arc<AppState>>) -> Result<Vec<PluginRepository>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    tauri::async_runtime::spawn_blocking(move || PluginMarketplace::new(root_dir, app_version)?.repositories().list())
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_plugin_repository(
    state: State<'_, Arc<AppState>>,
    repository: PluginRepository,
) -> Result<Vec<PluginRepository>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        PluginMarketplace::new(root_dir, app_version)?.repositories().save(repository)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_plugin_repository(
    state: State<'_, Arc<AppState>>,
    repository_id: String,
) -> Result<Vec<PluginRepository>, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        PluginMarketplace::new(root_dir, app_version)?.repositories().remove(&repository_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn fetch_plugin_marketplace_catalogs(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<PluginRepositoryCatalogResult>, String> {
    let marketplace =
        PluginMarketplace::new(state.plugins.root_dir().to_path_buf(), state.plugins.app_version().to_string())?;
    Ok(marketplace.fetch_catalogs().await)
}

#[tauri::command]
pub async fn install_marketplace_plugin(
    state: State<'_, Arc<AppState>>,
    request: PluginMarketplaceInstallRequest,
) -> Result<PluginInstallResponse, String> {
    let marketplace =
        PluginMarketplace::new(state.plugins.root_dir().to_path_buf(), state.plugins.app_version().to_string())?;
    let result = marketplace.install(request).await?;
    stop_replaced_plugin_runtime(&state, &result.plugin).await;
    Ok(result.response())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUiAssetPayload {
    content_type: String,
    data_base64: String,
    etag: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginBinaryEventPayload {
    plugin_id: String,
    channel: String,
    data_base64: String,
}

pub fn install_plugin_event_bridge(app: &tauri::AppHandle, state: Arc<AppState>) {
    let app_handle = app.clone();
    let mut events = state.plugin_host.subscribe_events();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let _ = app_handle.emit("dbx-plugin-event", event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("Desktop plugin event bridge skipped {skipped} events");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let app_handle = app.clone();
    let mut binary = state.plugin_host.subscribe_binary();
    tauri::async_runtime::spawn(async move {
        loop {
            match binary.recv().await {
                Ok(message) => {
                    let payload = PluginBinaryEventPayload {
                        plugin_id: message.plugin_id,
                        channel: message.channel,
                        data_base64: base64::engine::general_purpose::STANDARD.encode(message.data),
                    };
                    let _ = app_handle.emit("dbx-plugin-binary", payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("Desktop plugin binary bridge skipped {skipped} messages");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[tauri::command]
pub async fn install_plugin_package(
    state: State<'_, Arc<AppState>>,
    path: String,
    allow_unsigned: bool,
) -> Result<PluginInstallResponse, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    let policy = if allow_unsigned { PluginInstallPolicy::LocalDevelopment } else { PluginInstallPolicy::LocalSigned };
    let path = std::path::PathBuf::from(path);
    let result = tauri::async_runtime::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.install_file(&path, policy)
    })
    .await
    .map_err(|error| error.to_string())??;
    stop_replaced_plugin_runtime(&state, &result.plugin).await;
    Ok(result.response())
}

#[tauri::command]
pub async fn rollback_plugin(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> Result<PluginRollbackResponse, String> {
    state.remove_plugin_connection_pools(&plugin_id).await;
    state.plugin_host.stop(&plugin_id).await;
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.rollback(&plugin_id)
    })
    .await
    .map_err(|error| error.to_string())??;
    stop_external_driver_pools(&state, &result.plugin).await;
    Ok(result.response())
}

#[tauri::command]
pub async fn uninstall_plugin(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> Result<Vec<InstalledPluginInfo>, String> {
    let dependent_connections = state
        .storage
        .load_connections()
        .await?
        .into_iter()
        .filter(|connection| {
            connection.db_type == dbx_core::models::connection::DatabaseType::Plugin
                && connection.plugin_id.as_deref() == Some(plugin_id.as_str())
        })
        .map(|connection| connection.name)
        .collect::<Vec<_>>();
    if !dependent_connections.is_empty() {
        return Err(format!(
            "Cannot uninstall plugin '{plugin_id}' while these connections still use it: {}",
            dependent_connections.join(", ")
        ));
    }
    let plugin = state.plugins.find_plugin(&plugin_id)?;
    state.remove_plugin_connection_pools(&plugin_id).await;
    state.plugin_host.stop(&plugin_id).await;
    if let Some(plugin) = &plugin {
        stop_external_driver_pools(&state, plugin).await;
    }
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.uninstall(&plugin_id)
    })
    .await
    .map_err(|error| error.to_string())??;
    list_plugins(state).await
}

#[tauri::command]
pub async fn activate_plugin(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> Result<Vec<ActivePluginSession>, String> {
    state.plugin_host.activate(&plugin_id).await?;
    Ok(state.plugin_host.list_active().await)
}

#[tauri::command]
pub async fn list_active_plugins(state: State<'_, Arc<AppState>>) -> Result<Vec<ActivePluginSession>, String> {
    Ok(state.plugin_host.list_active().await)
}

#[tauri::command]
pub async fn stop_plugin(state: State<'_, Arc<AppState>>, plugin_id: String) -> Result<(), String> {
    state.plugin_host.stop(&plugin_id).await;
    Ok(())
}

#[tauri::command]
pub async fn invoke_plugin(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    method: String,
    params: serde_json::Value,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let timeout = timeout_ms.map(|milliseconds| Duration::from_millis(milliseconds.clamp(1, 120_000)));
    state.plugin_host.invoke(&plugin_id, &method, params, None, timeout).await
}

#[tauri::command]
pub async fn invoke_plugin_connection_action(
    state: State<'_, Arc<AppState>>,
    config: ConnectionConfig,
    action_id: String,
) -> Result<PluginConnectionActionResult, String> {
    state.invoke_plugin_connection_action(config, &action_id).await
}

#[tauri::command]
pub async fn notify_plugin(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    method: String,
    params: serde_json::Value,
) -> Result<(), String> {
    state.plugin_host.notify(&plugin_id, &method, params, None).await
}

#[tauri::command]
pub async fn send_plugin_binary(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    channel: String,
    data_base64: String,
) -> Result<(), String> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|error| format!("Invalid plugin binary payload: {error}"))?;
    state.plugin_host.send_binary(&plugin_id, &channel, &data, None).await
}

#[tauri::command]
pub async fn list_plugin_filesystem_entries(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
) -> Result<PluginFilesystemListResult, String> {
    state
        .plugin_host
        .list_filesystem_entries(
            &plugin_id,
            &provider_id,
            connection_id.as_deref(),
            uri.as_deref(),
            cursor.as_deref(),
            limit,
        )
        .await
}

#[tauri::command]
pub async fn read_plugin_filesystem_file(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    max_bytes: Option<u64>,
) -> Result<PluginFilesystemReadResult, String> {
    state.plugin_host.read_filesystem_file(&plugin_id, &provider_id, connection_id.as_deref(), &uri, max_bytes).await
}

#[tauri::command]
pub async fn write_plugin_filesystem_file(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    data_base64: String,
    create: bool,
    overwrite: bool,
    etag: Option<String>,
) -> Result<PluginFilesystemMutationResult, String> {
    state
        .plugin_host
        .write_filesystem_file(
            &plugin_id,
            &provider_id,
            connection_id.as_deref(),
            &uri,
            &data_base64,
            create,
            overwrite,
            etag.as_deref(),
        )
        .await
}

#[tauri::command]
pub async fn create_plugin_filesystem_directory(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
) -> Result<PluginFilesystemMutationResult, String> {
    state.plugin_host.create_filesystem_directory(&plugin_id, &provider_id, connection_id.as_deref(), &uri).await
}

#[tauri::command]
pub async fn delete_plugin_filesystem_entry(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    recursive: bool,
) -> Result<PluginFilesystemMutationResult, String> {
    state.plugin_host.delete_filesystem_entry(&plugin_id, &provider_id, connection_id.as_deref(), &uri, recursive).await
}

#[tauri::command]
pub async fn rename_plugin_filesystem_entry(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    source_uri: String,
    target_uri: String,
    overwrite: bool,
) -> Result<PluginFilesystemMutationResult, String> {
    state
        .plugin_host
        .rename_filesystem_entry(
            &plugin_id,
            &provider_id,
            connection_id.as_deref(),
            &source_uri,
            &target_uri,
            overwrite,
        )
        .await
}

#[tauri::command]
pub async fn read_plugin_ui_entry(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> Result<PluginUiAssetPayload, String> {
    let registry = state.plugins.clone();
    let asset = tauri::async_runtime::spawn_blocking(move || registry.read_ui_entry(&plugin_id))
        .await
        .map_err(|error| error.to_string())??;
    Ok(asset_payload(asset))
}

#[tauri::command]
pub async fn read_plugin_asset(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    path: String,
) -> Result<PluginUiAssetPayload, String> {
    let registry = state.plugins.clone();
    let asset = tauri::async_runtime::spawn_blocking(move || registry.read_asset(&plugin_id, &path))
        .await
        .map_err(|error| error.to_string())??;
    Ok(asset_payload(asset))
}

#[tauri::command]
pub async fn read_plugin_ui_asset(
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
    path: String,
) -> Result<PluginUiAssetPayload, String> {
    let registry = state.plugins.clone();
    let asset = tauri::async_runtime::spawn_blocking(move || registry.read_ui_asset(&plugin_id, &path))
        .await
        .map_err(|error| error.to_string())??;
    Ok(asset_payload(asset))
}

fn asset_payload(asset: PluginUiAsset) -> PluginUiAssetPayload {
    PluginUiAssetPayload {
        content_type: asset.content_type,
        data_base64: base64::engine::general_purpose::STANDARD.encode(asset.bytes),
        etag: asset.etag,
    }
}

async fn stop_replaced_plugin_runtime(state: &Arc<AppState>, plugin: &InstalledPlugin) {
    state.remove_plugin_connection_pools(&plugin.manifest.id).await;
    stop_external_driver_pools(state, plugin).await;
    state.plugin_host.stop(&plugin.manifest.id).await;
}

async fn stop_external_driver_pools(state: &Arc<AppState>, plugin: &InstalledPlugin) {
    for driver in &plugin.manifest.drivers {
        let driver_id = driver.database_type.as_deref().unwrap_or(&driver.id);
        state.remove_external_driver_pools(driver_id).await;
    }
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
