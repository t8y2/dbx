use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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
    app: AppHandle,
    request: PluginMarketplaceInstallRequest,
) -> Result<PluginInstallResponse, String> {
    let marketplace =
        PluginMarketplace::new(state.plugins.root_dir().to_path_buf(), state.plugins.app_version().to_string())?
            .with_lifecycle(state.plugins.lifecycle());
    let result = marketplace.install(request).await?;
    stop_replaced_plugin_runtime(&state, &result.plugin).await?;
    emit_plugin_runtime_replaced(&app, &result.plugin);
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

/// Event name for host observation events delivered to plugin UIs.
pub const HOST_OBSERVATION_EVENT: &str = "dbx-host-observation";
/// Event name signalling that the bus dropped events before delivery.
pub const HOST_OBSERVATION_GAP_EVENT: &str = "dbx-host-observation-gap";
/// Method name used when forwarding host observations to sidecar backends.
pub const HOST_OBSERVATION_SIDECAR_METHOD: &str = "host/observation";

/// Wire the host observation bus to both plugin run surfaces.
///
/// * UI: every event goes out as `dbx-host-observation`; each plugin bridge
///   filters by the `host.observe:*` permissions of its own manifest, so the
///   permission boundary lives in one place (pluginHostBridge.ts).
/// * Sidecar: events are pushed as `host/observation` notifications to
///   already-running sessions that declared the matching permission. High
///   frequency delta streams stay UI-only (see
///   `HostObservationEvent::is_delivered_to_sidecar`).
/// * Back-pressure: the bus is a bounded broadcast channel, so a lagging
///   consumer is disconnected with a `Lagged(n)` error instead of blocking
///   publishers. Both bridges turn that into an explicit gap signal
///   (`dbx-host-observation-gap`, `host/observation_gap`) rather than leaving
///   consumers to infer drops from `id` gaps, which permission filtering and
///   concurrent publishers make meaningless.
pub fn install_host_observation_bridge(app: &tauri::AppHandle, state: Arc<AppState>) {
    let app_handle = app.clone();
    let mut observations = state.host_observations.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match observations.recv().await {
                Ok(event) => {
                    let _ = app_handle.emit(HOST_OBSERVATION_EVENT, event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("Desktop host observation bridge skipped {skipped} events");
                    let _ = app_handle.emit(HOST_OBSERVATION_GAP_EVENT, serde_json::json!({ "skipped": skipped }));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let plugin_host = state.plugin_host.clone();
    let mut observations = state.host_observations.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match observations.recv().await {
                Ok(event) => {
                    if !event.is_delivered_to_sidecar() {
                        continue;
                    }
                    let Some(permission) =
                        dbx_core::models::observability::HostObservationEvent::permission_for_kind(&event.kind)
                    else {
                        continue;
                    };
                    let Ok(params) = serde_json::to_value(&event) else {
                        continue;
                    };
                    plugin_host.broadcast_observation(permission, HOST_OBSERVATION_SIDECAR_METHOD, params);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("Desktop host observation sidecar bridge skipped {skipped} events");
                    plugin_host.broadcast_observation_gap(skipped);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Register a plugin workbench as a host observation observer.
///
/// Interest is what gates payload construction upstream (see
/// `HostObservationBus::is_enabled`): the shell bridges stay subscribed for the
/// whole process, so their receivers cannot express "nobody is watching".
/// `owner_id` is per workbench mount so several tabs of one plugin are
/// refcounted independently; the permissions come from the installed manifest,
/// never from the caller.
///
/// The owner id is scoped by the calling webview's label. A renderer can vanish
/// without running its unmount path (window teardown, WebView2 renderer crash
/// and reload), so the shell releases the whole `<label>/` scope on page load
/// and window destruction instead of trusting the frontend cleanup.
#[tauri::command]
pub async fn set_plugin_observation_interest(
    state: State<'_, Arc<AppState>>,
    webview: tauri::Webview,
    owner_id: String,
    plugin_id: String,
) -> Result<(), String> {
    let owner_id = observation_interest_owner(webview.label(), &owner_id);
    let registry = state.plugins.clone();
    let permissions = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, String>(registry.find_plugin(&plugin_id)?.map(|plugin| plugin.manifest.permissions))
    })
    .await
    .map_err(|error| error.to_string())??;
    match permissions {
        Some(permissions) => {
            state.host_observations.interest().acquire(&owner_id, &permissions);
        }
        // Uninstalled between mount and registration: nothing to observe.
        None => state.host_observations.interest().release(&owner_id),
    }
    Ok(())
}

/// Drop a workbench's observation interest (`set_plugin_observation_interest`'s
/// counterpart). Unknown owners are a no-op.
#[tauri::command]
pub async fn clear_plugin_observation_interest(
    state: State<'_, Arc<AppState>>,
    webview: tauri::Webview,
    owner_id: String,
) -> Result<(), String> {
    state.host_observations.interest().release(&observation_interest_owner(webview.label(), &owner_id));
    Ok(())
}

/// Owner id namespace for one webview. `release_webview_observation_interest`
/// drops everything under it, so a destroyed renderer cannot leave interest
/// behind and keep payload construction enabled forever.
pub fn observation_interest_owner(webview_label: &str, owner_id: &str) -> String {
    format!("{webview_label}/{owner_id}")
}

/// Release every workbench interest registered by `webview_label`.
///
/// Called from renderer teardown paths that cannot run the frontend's unmount
/// handler (webview destruction, renderer crash reload). Returns the number of
/// owners released (0 is the common, harmless case).
pub fn release_webview_observation_interest(state: &AppState, webview_label: &str) -> usize {
    let prefix = format!("{webview_label}/");
    state.host_observations.interest().release_prefix(&prefix)
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
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    path: String,
    allow_unsigned: bool,
) -> Result<PluginInstallResponse, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    let policy = if allow_unsigned { PluginInstallPolicy::LocalDevelopment } else { PluginInstallPolicy::LocalSigned };
    let path = std::path::PathBuf::from(path);
    let lifecycle = state.plugins.lifecycle();
    let result = tauri::async_runtime::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.with_lifecycle(lifecycle).install_file(&path, policy)
    })
    .await
    .map_err(|error| error.to_string())??;
    stop_replaced_plugin_runtime(&state, &result.plugin).await?;
    emit_plugin_runtime_replaced(&app, &result.plugin);
    Ok(result.response())
}

#[tauri::command]
pub async fn install_plugin_package_from_url(
    state: State<'_, Arc<AppState>>,
    url: String,
    allow_unsigned: bool,
    app: AppHandle,
) -> Result<PluginInstallResponse, String> {
    let marketplace =
        PluginMarketplace::new(state.plugins.root_dir().to_path_buf(), state.plugins.app_version().to_string())?
            .with_lifecycle(state.plugins.lifecycle());
    let policy = if allow_unsigned { PluginInstallPolicy::LocalDevelopment } else { PluginInstallPolicy::LocalSigned };
    let progress_app = app.clone();
    let result = marketplace
        .install_url_package(&url, policy, move |downloaded, total| {
            let _ = progress_app.emit(
                "plugin-url-download-progress",
                serde_json::json!({
                    "downloaded": downloaded,
                    "total": total,
                }),
            );
        })
        .await?;
    stop_replaced_plugin_runtime(&state, &result.plugin).await?;
    emit_plugin_runtime_replaced(&app, &result.plugin);
    Ok(result.response())
}

#[tauri::command]
pub async fn rollback_plugin(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    plugin_id: String,
) -> Result<PluginRollbackResponse, String> {
    let root_dir = state.plugins.root_dir().to_path_buf();
    let app_version = state.plugins.app_version().to_string();
    let lifecycle = state.plugins.lifecycle();
    let result = tauri::async_runtime::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.with_lifecycle(lifecycle).rollback(&plugin_id)
    })
    .await
    .map_err(|error| error.to_string())??;
    stop_replaced_plugin_runtime(&state, &result.plugin).await?;
    emit_plugin_runtime_replaced(&app, &result.plugin);
    Ok(result.response())
}

#[tauri::command]
pub async fn uninstall_plugin(
    state: State<'_, Arc<AppState>>,
    file_state: State<'_, crate::commands::plugin_file::PluginFileState>,
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
    if let Some(plugin) = &plugin {
        stop_external_driver_pools(&state, plugin).await;
    }
    // Stops the runtime and uninstalls the store under one lifecycle update lease, so a plugin
    // call cannot re-activate the sidecar (and re-lock its container) in between.
    state.plugin_host.uninstall_plugin(&plugin_id).await?;
    // Past every validation and the runtime teardown: retire the plugin's
    // remaining file handles and drop entries — nothing else will close them.
    // (Before this point an Err return must leave a still-installed plugin's
    // workbenches fully functional.)
    crate::commands::plugin_file::close_all_plugin_files(&file_state, &plugin_id);
    // A reinstall must ask for AI tool access and data grants again.
    if let Err(error) = state.storage.forget_plugin_permissions(&plugin_id).await {
        log::warn!("Failed to clear permissions of uninstalled plugin {plugin_id}: {error}");
    }
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
pub async fn stop_plugin(
    state: State<'_, Arc<AppState>>,
    file_state: State<'_, crate::commands::plugin_file::PluginFileState>,
    plugin_id: String,
) -> Result<(), String> {
    // The plugin's workbenches are going away with its runtime; without this
    // sweep, handles it never closed would pin the shared registry quota.
    crate::commands::plugin_file::close_all_plugin_files(&file_state, &plugin_id);
    state.plugin_host.stop(&plugin_id).await?;
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

/// Notifies the webview that a plugin's runtime was replaced by an
/// install/rollback, so already-open workbench tabs can reload the new UI
/// instead of showing the stale version until manually reopened.
fn emit_plugin_runtime_replaced(app: &AppHandle, plugin: &InstalledPlugin) {
    let _ = app.emit(
        "plugin-runtime-replaced",
        serde_json::json!({
            "pluginId": plugin.manifest.id,
            "version": plugin.manifest.version,
        }),
    );
}

async fn stop_replaced_plugin_runtime(state: &Arc<AppState>, plugin: &InstalledPlugin) -> Result<(), String> {
    state.remove_plugin_connection_pools(&plugin.manifest.id).await;
    stop_external_driver_pools(state, plugin).await;
    state.plugin_host.stop(&plugin.manifest.id).await
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
