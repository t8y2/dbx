use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use async_stream::stream;
use axum::body::Body;
use axum::extract::{Multipart, Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ETAG};
use axum::http::{HeaderName, HeaderValue, Response};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::Json;
use base64::Engine;
use dbx_core::models::connection::ConnectionConfig;
use dbx_core::plugins::{
    ActivePluginSession, InstalledPlugin, InstalledPluginInfo, PluginConnectionActionResult,
    PluginFilesystemListResult, PluginFilesystemMutationResult, PluginFilesystemReadResult, PluginInstallPolicy,
    PluginInstallResponse, PluginMarketplace, PluginMarketplaceInstallRequest, PluginPackageInstaller,
    PluginRepository, PluginRepositoryCatalogResult, PluginRollbackResponse, PluginTrustStore, PluginTrustedKey,
    PluginUiAsset,
};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

const MAX_PLUGIN_UPLOAD_BYTES: usize = 512 * 1024 * 1024;

#[derive(Debug, Deserialize, Default)]
pub struct PluginInstallQuery {
    #[serde(default)]
    allow_unsigned: bool,
}

#[derive(Debug, Deserialize)]
pub struct PluginIdRequest {
    plugin_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrustedKeyRequest {
    key_id: String,
    public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrustedKeyIdRequest {
    key_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRepositoryIdRequest {
    repository_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInvokeRequest {
    plugin_id: String,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConnectionActionRequest {
    config: ConnectionConfig,
    action_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginNotifyRequest {
    plugin_id: String,
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBinaryRequest {
    plugin_id: String,
    channel: String,
    data_base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemListRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemReadRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    max_bytes: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemWriteRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    data_base64: String,
    #[serde(default)]
    create: bool,
    #[serde(default)]
    overwrite: bool,
    etag: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemDirectoryRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemDeleteRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    uri: String,
    #[serde(default)]
    recursive: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFilesystemRenameRequest {
    plugin_id: String,
    provider_id: String,
    connection_id: Option<String>,
    source_uri: String,
    target_uri: String,
    #[serde(default)]
    overwrite: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
enum PluginStreamMessage {
    Event { plugin_id: String, method: String, params: serde_json::Value },
    Binary { plugin_id: String, channel: String, data_base64: String },
    Lagged { skipped: u64 },
}

pub async fn list_plugins(State(state): State<Arc<WebState>>) -> Result<Json<Vec<InstalledPluginInfo>>, AppError> {
    state
        .app
        .plugins
        .list_installed()
        .map(|plugins| Json(plugins.into_iter().map(|plugin| plugin.info()).collect()))
        .map_err(AppError::from)
}

pub async fn list_plugin_trusted_keys(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<PluginTrustedKey>>, AppError> {
    PluginTrustStore::list_base64_keys(state.app.plugins.root_dir()).map(Json).map_err(AppError::from)
}

pub async fn list_plugin_repositories(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<PluginRepository>>, AppError> {
    let marketplace =
        PluginMarketplace::new(state.app.plugins.root_dir().to_path_buf(), state.app.plugins.app_version().to_string())
            .map_err(AppError::from)?;
    marketplace.repositories().list().map(Json).map_err(AppError::from)
}

pub async fn save_plugin_repository(
    State(state): State<Arc<WebState>>,
    Json(repository): Json<PluginRepository>,
) -> Result<Json<Vec<PluginRepository>>, AppError> {
    let marketplace =
        PluginMarketplace::new(state.app.plugins.root_dir().to_path_buf(), state.app.plugins.app_version().to_string())
            .map_err(AppError::from)?;
    marketplace.repositories().save(repository).map(Json).map_err(AppError::bad_request)
}

pub async fn remove_plugin_repository(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginRepositoryIdRequest>,
) -> Result<Json<Vec<PluginRepository>>, AppError> {
    let marketplace =
        PluginMarketplace::new(state.app.plugins.root_dir().to_path_buf(), state.app.plugins.app_version().to_string())
            .map_err(AppError::from)?;
    marketplace.repositories().remove(&request.repository_id).map(Json).map_err(AppError::bad_request)
}

pub async fn fetch_plugin_marketplace_catalogs(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<PluginRepositoryCatalogResult>>, AppError> {
    let marketplace =
        PluginMarketplace::new(state.app.plugins.root_dir().to_path_buf(), state.app.plugins.app_version().to_string())
            .map_err(AppError::from)?;
    Ok(Json(marketplace.fetch_catalogs().await))
}

pub async fn install_marketplace_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginMarketplaceInstallRequest>,
) -> Result<Json<PluginInstallResponse>, AppError> {
    let marketplace =
        PluginMarketplace::new(state.app.plugins.root_dir().to_path_buf(), state.app.plugins.app_version().to_string())
            .map_err(AppError::from)?;
    let result = marketplace.install(request).await.map_err(AppError::bad_request)?;
    state.app.remove_plugin_connection_pools(&result.plugin.manifest.id).await;
    stop_external_driver_pools(&state, &result.plugin).await;
    state.app.plugin_host.stop(&result.plugin.manifest.id).await;
    Ok(Json(result.response()))
}

pub async fn save_plugin_trusted_key(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginTrustedKeyRequest>,
) -> Result<Json<Vec<PluginTrustedKey>>, AppError> {
    let root_dir = state.app.plugins.root_dir().to_path_buf();
    tokio::task::spawn_blocking(move || {
        PluginTrustStore::save_base64_key(&root_dir, &request.key_id, &request.public_key)?;
        PluginTrustStore::list_base64_keys(&root_dir)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map(Json)
    .map_err(AppError::bad_request)
}

pub async fn remove_plugin_trusted_key(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginTrustedKeyIdRequest>,
) -> Result<Json<Vec<PluginTrustedKey>>, AppError> {
    let root_dir = state.app.plugins.root_dir().to_path_buf();
    tokio::task::spawn_blocking(move || {
        PluginTrustStore::remove_key(&root_dir, &request.key_id)?;
        PluginTrustStore::list_base64_keys(&root_dir)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map(Json)
    .map_err(AppError::bad_request)
}

pub async fn install_plugin(
    State(state): State<Arc<WebState>>,
    Query(query): Query<PluginInstallQuery>,
    mut multipart: Multipart,
) -> Result<Json<PluginInstallResponse>, AppError> {
    let mut package = None;
    while let Some(field) = multipart.next_field().await.map_err(|error| AppError::bad_request(error.to_string()))? {
        if field.name() != Some("file") {
            continue;
        }
        let bytes = field.bytes().await.map_err(|error| AppError::bad_request(error.to_string()))?;
        if bytes.len() > MAX_PLUGIN_UPLOAD_BYTES {
            return Err(AppError::bad_request("Plugin package is too large"));
        }
        package = Some(bytes.to_vec());
        break;
    }
    let package = package.ok_or_else(|| AppError::bad_request("Missing plugin package field 'file'"))?;
    let policy =
        if query.allow_unsigned { PluginInstallPolicy::LocalDevelopment } else { PluginInstallPolicy::LocalSigned };
    let root_dir = state.app.plugins.root_dir().to_path_buf();
    let app_version = state.app.plugins.app_version().to_string();
    let result = tokio::task::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.install_bytes(&package, policy)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map_err(AppError::bad_request)?;
    state.app.remove_plugin_connection_pools(&result.plugin.manifest.id).await;
    stop_external_driver_pools(&state, &result.plugin).await;
    state.app.plugin_host.stop(&result.plugin.manifest.id).await;
    Ok(Json(result.response()))
}

pub async fn rollback_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginIdRequest>,
) -> Result<Json<PluginRollbackResponse>, AppError> {
    state.app.remove_plugin_connection_pools(&request.plugin_id).await;
    state.app.plugin_host.stop(&request.plugin_id).await;
    let root_dir = state.app.plugins.root_dir().to_path_buf();
    let app_version = state.app.plugins.app_version().to_string();
    let result = tokio::task::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.rollback(&request.plugin_id)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map_err(AppError::bad_request)?;
    stop_external_driver_pools(&state, &result.plugin).await;
    Ok(Json(result.response()))
}

pub async fn uninstall_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginIdRequest>,
) -> Result<Json<Vec<InstalledPluginInfo>>, AppError> {
    let dependent_connections = state
        .app
        .storage
        .load_connections()
        .await
        .map_err(AppError::from)?
        .into_iter()
        .filter(|connection| {
            connection.db_type == dbx_core::models::connection::DatabaseType::Plugin
                && connection.plugin_id.as_deref() == Some(request.plugin_id.as_str())
        })
        .map(|connection| connection.name)
        .collect::<Vec<_>>();
    if !dependent_connections.is_empty() {
        return Err(AppError::bad_request(format!(
            "Cannot uninstall plugin '{}' while these connections still use it: {}",
            request.plugin_id,
            dependent_connections.join(", ")
        )));
    }
    let plugin = state.app.plugins.find_plugin(&request.plugin_id).map_err(AppError::from)?;
    state.app.remove_plugin_connection_pools(&request.plugin_id).await;
    state.app.plugin_host.stop(&request.plugin_id).await;
    if let Some(plugin) = &plugin {
        stop_external_driver_pools(&state, plugin).await;
    }
    let root_dir = state.app.plugins.root_dir().to_path_buf();
    let app_version = state.app.plugins.app_version().to_string();
    tokio::task::spawn_blocking(move || {
        PluginPackageInstaller::new(root_dir, app_version)?.uninstall(&request.plugin_id)
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))?
    .map_err(AppError::bad_request)?;
    list_plugins(State(state)).await
}

pub async fn activate_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginIdRequest>,
) -> Result<Json<Vec<ActivePluginSession>>, AppError> {
    state.app.plugin_host.activate(&request.plugin_id).await.map_err(AppError::bad_request)?;
    Ok(Json(state.app.plugin_host.list_active().await))
}

pub async fn list_active_plugins(
    State(state): State<Arc<WebState>>,
) -> Result<Json<Vec<ActivePluginSession>>, AppError> {
    Ok(Json(state.app.plugin_host.list_active().await))
}

pub async fn stop_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginIdRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    state.app.plugin_host.stop(&request.plugin_id).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn invoke_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginInvokeRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let timeout = request.timeout_ms.map(|milliseconds| Duration::from_millis(milliseconds.clamp(1, 120_000)));
    state
        .app
        .plugin_host
        .invoke(&request.plugin_id, &request.method, request.params, None, timeout)
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn invoke_plugin_connection_action(
    State(state): State<Arc<WebState>>,
    Json(body): Json<PluginConnectionActionRequest>,
) -> Result<Json<PluginConnectionActionResult>, AppError> {
    state.app.invoke_plugin_connection_action(body.config, &body.action_id).await.map(Json).map_err(AppError::from)
}

pub async fn notify_plugin(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginNotifyRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .app
        .plugin_host
        .notify(&request.plugin_id, &request.method, request.params, None)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn send_plugin_binary(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginBinaryRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(request.data_base64)
        .map_err(|error| AppError::bad_request(format!("Invalid plugin binary payload: {error}")))?;
    state
        .app
        .plugin_host
        .send_binary(&request.plugin_id, &request.channel, &data, None)
        .await
        .map_err(AppError::bad_request)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

pub async fn list_plugin_filesystem_entries(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemListRequest>,
) -> Result<Json<PluginFilesystemListResult>, AppError> {
    state
        .app
        .plugin_host
        .list_filesystem_entries(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            request.uri.as_deref(),
            request.cursor.as_deref(),
            request.limit,
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn read_plugin_filesystem_file(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemReadRequest>,
) -> Result<Json<PluginFilesystemReadResult>, AppError> {
    state
        .app
        .plugin_host
        .read_filesystem_file(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            &request.uri,
            request.max_bytes,
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn write_plugin_filesystem_file(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemWriteRequest>,
) -> Result<Json<PluginFilesystemMutationResult>, AppError> {
    state
        .app
        .plugin_host
        .write_filesystem_file(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            &request.uri,
            &request.data_base64,
            request.create,
            request.overwrite,
            request.etag.as_deref(),
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn create_plugin_filesystem_directory(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemDirectoryRequest>,
) -> Result<Json<PluginFilesystemMutationResult>, AppError> {
    state
        .app
        .plugin_host
        .create_filesystem_directory(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            &request.uri,
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn delete_plugin_filesystem_entry(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemDeleteRequest>,
) -> Result<Json<PluginFilesystemMutationResult>, AppError> {
    state
        .app
        .plugin_host
        .delete_filesystem_entry(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            &request.uri,
            request.recursive,
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn rename_plugin_filesystem_entry(
    State(state): State<Arc<WebState>>,
    Json(request): Json<PluginFilesystemRenameRequest>,
) -> Result<Json<PluginFilesystemMutationResult>, AppError> {
    state
        .app
        .plugin_host
        .rename_filesystem_entry(
            &request.plugin_id,
            &request.provider_id,
            request.connection_id.as_deref(),
            &request.source_uri,
            &request.target_uri,
            request.overwrite,
        )
        .await
        .map(Json)
        .map_err(AppError::bad_request)
}

pub async fn plugin_events(
    State(state): State<Arc<WebState>>,
) -> Sse<impl futures::Stream<Item = Result<Event, Infallible>>> {
    let mut events = state.app.plugin_host.subscribe_events();
    let mut binary = state.app.plugin_host.subscribe_binary();
    let stream = stream! {
        loop {
            let message = tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => PluginStreamMessage::Event { plugin_id: event.plugin_id, method: event.method, params: event.params },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => PluginStreamMessage::Lagged { skipped },
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
                message = binary.recv() => match message {
                    Ok(message) => PluginStreamMessage::Binary {
                        plugin_id: message.plugin_id,
                        channel: message.channel,
                        data_base64: base64::engine::general_purpose::STANDARD.encode(message.data),
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => PluginStreamMessage::Lagged { skipped },
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                },
            };
            if let Ok(data) = serde_json::to_string(&message) {
                yield Ok(Event::default().data(data));
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::default())
}

pub async fn plugin_ui_entry(
    State(state): State<Arc<WebState>>,
    Path(plugin_id): Path<String>,
) -> Result<Response<Body>, AppError> {
    let asset = state.app.plugins.read_ui_entry(&plugin_id).map_err(AppError::bad_request)?;
    asset_response(asset)
}

pub async fn plugin_asset(
    State(state): State<Arc<WebState>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Result<Response<Body>, AppError> {
    let asset = state.app.plugins.read_asset(&plugin_id, &path).map_err(AppError::bad_request)?;
    asset_response(asset)
}

pub async fn plugin_ui_asset(
    State(state): State<Arc<WebState>>,
    Path((plugin_id, path)): Path<(String, String)>,
) -> Result<Response<Body>, AppError> {
    let asset = state.app.plugins.read_ui_asset(&plugin_id, &path).map_err(AppError::bad_request)?;
    asset_response(asset)
}

fn asset_response(asset: PluginUiAsset) -> Result<Response<Body>, AppError> {
    let is_html = asset.content_type.starts_with("text/html");
    let mut response = Response::new(Body::from(asset.bytes));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&asset.content_type).map_err(|error| AppError::internal(error.to_string()))?,
    );
    response
        .headers_mut()
        .insert(ETAG, HeaderValue::from_str(&asset.etag).map_err(|error| AppError::internal(error.to_string()))?);
    response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
        .headers_mut()
        .insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    if is_html {
        response.headers_mut().insert(
            CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-ancestors 'self'",
            ),
        );
    }
    Ok(response)
}

async fn stop_external_driver_pools(state: &Arc<WebState>, plugin: &InstalledPlugin) {
    for driver in &plugin.manifest.drivers {
        let driver_id = driver.database_type.as_deref().unwrap_or(&driver.id);
        state.app.remove_external_driver_pools(driver_id).await;
    }
}
