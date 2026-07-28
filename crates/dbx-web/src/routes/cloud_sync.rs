use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::cloud_sync::{
    apply_sync_snapshot, build_sync_snapshot_with_saved_secrets, forget_snippet_token, forget_webdav_password,
    forget_webdav_sync_secrets_passphrase as core_forget_webdav_sync_secrets_passphrase, resolve_snippet_token,
    resolve_webdav_password, resolve_webdav_sync_secrets_passphrase, save_snippet_token, save_webdav_password,
    save_webdav_sync_secrets_preference as core_save_webdav_sync_secrets_preference, snippet_saved_token_status,
    webdav_saved_password_status, webdav_sync_secrets_status as core_webdav_sync_secrets_status, ApplySnapshotOptions,
    ApplySnapshotSummary, SnippetSyncClient, SnippetSyncConfig, SnippetSyncSummary, SnippetTokenStatus, WebDavClient,
    WebDavConfig, WebDavPasswordStatus, WebDavSyncSecretsStatus, WebDavSyncSummary,
};
use dbx_core::storage::DesktopSettings;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavDownloadResult {
    pub summary: WebDavSyncSummary,
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDownloadResult {
    pub summary: SnippetSyncSummary,
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfigRequest {
    pub config: WebDavConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWebDavPasswordRequest {
    pub config: WebDavConfig,
    pub password: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavUploadRequest {
    pub config: WebDavConfig,
    pub editor_settings: Option<serde_json::Value>,
    pub secrets_passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavDownloadRequest {
    pub config: WebDavConfig,
    pub secrets_passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSecretsPreferenceRequest {
    pub enabled: bool,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetConfigRequest {
    pub config: SnippetSyncConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetTokenRequest {
    pub config: SnippetSyncConfig,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetUploadRequest {
    pub config: SnippetSyncConfig,
    pub editor_settings: Option<serde_json::Value>,
    pub secrets_passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDownloadRequest {
    pub config: SnippetSyncConfig,
    pub secrets_passphrase: Option<String>,
}

pub async fn webdav_sync_test(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<WebDavConfigRequest>,
) -> Result<Json<()>, AppError> {
    resolve_webdav_password(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    WebDavClient::new(req.config).test().await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn webdav_password_status(
    State(state): State<Arc<WebState>>,
    Json(req): Json<WebDavConfigRequest>,
) -> Result<Json<WebDavPasswordStatus>, AppError> {
    webdav_saved_password_status(&state.app.storage, &req.config).await.map(Json).map_err(AppError::from)
}

pub async fn save_webdav_saved_password(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SaveWebDavPasswordRequest>,
) -> Result<Json<()>, AppError> {
    save_webdav_password(&state.app.storage, &req.config, &req.password).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn forget_webdav_saved_password(
    State(state): State<Arc<WebState>>,
    Json(req): Json<WebDavConfigRequest>,
) -> Result<Json<()>, AppError> {
    forget_webdav_password(&state.app.storage, &req.config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn webdav_sync_secrets_status(
    State(state): State<Arc<WebState>>,
) -> Result<Json<WebDavSyncSecretsStatus>, AppError> {
    core_webdav_sync_secrets_status(&state.app.storage).await.map(Json).map_err(AppError::from)
}

pub async fn save_webdav_sync_secrets_preference(
    State(state): State<Arc<WebState>>,
    Json(req): Json<WebDavSyncSecretsPreferenceRequest>,
) -> Result<Json<()>, AppError> {
    core_save_webdav_sync_secrets_preference(&state.app.storage, req.enabled, req.passphrase.as_deref())
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn forget_webdav_sync_secrets_passphrase(State(state): State<Arc<WebState>>) -> Result<Json<()>, AppError> {
    core_forget_webdav_sync_secrets_passphrase(&state.app.storage).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn webdav_sync_upload(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<WebDavUploadRequest>,
) -> Result<Json<WebDavSyncSummary>, AppError> {
    resolve_webdav_password(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let snapshot = build_sync_snapshot_with_saved_secrets(
        &state.app.storage,
        env!("CARGO_PKG_VERSION"),
        req.editor_settings,
        req.secrets_passphrase.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    WebDavClient::new(req.config).put_snapshot(&snapshot).await.map(Json).map_err(AppError::from)
}

pub async fn webdav_sync_download(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<WebDavDownloadRequest>,
) -> Result<Json<WebDavDownloadResult>, AppError> {
    resolve_webdav_password(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let (snapshot, summary) = WebDavClient::new(req.config).get_snapshot().await.map_err(AppError::from)?;
    let explicit_passphrase = req.secrets_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let saved_passphrase = if explicit_passphrase.is_some() {
        None
    } else {
        resolve_webdav_sync_secrets_passphrase(&state.app.storage).await.map_err(AppError::from)?
    };
    let apply_summary = apply_sync_snapshot(
        &state.app.storage,
        &snapshot,
        ApplySnapshotOptions { secrets_passphrase: explicit_passphrase.or(saved_passphrase.as_deref()) },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(WebDavDownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    }))
}

pub async fn snippet_sync_test(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetConfigRequest>,
) -> Result<Json<()>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    SnippetSyncClient::new(req.config).test().await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn snippet_token_status(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SnippetConfigRequest>,
) -> Result<Json<SnippetTokenStatus>, AppError> {
    snippet_saved_token_status(&state.app.storage, &req.config).await.map(Json).map_err(AppError::from)
}

pub async fn save_snippet_saved_token(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SaveSnippetTokenRequest>,
) -> Result<Json<()>, AppError> {
    save_snippet_token(&state.app.storage, &req.config, &req.token).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn forget_snippet_saved_token(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SnippetConfigRequest>,
) -> Result<Json<()>, AppError> {
    forget_snippet_token(&state.app.storage, &req.config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn snippet_sync_upload(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetUploadRequest>,
) -> Result<Json<SnippetSyncSummary>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let snapshot = build_sync_snapshot_with_saved_secrets(
        &state.app.storage,
        env!("CARGO_PKG_VERSION"),
        req.editor_settings,
        req.secrets_passphrase.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    SnippetSyncClient::new(req.config).put_snapshot(&snapshot).await.map(Json).map_err(AppError::from)
}

pub async fn snippet_sync_download(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetDownloadRequest>,
) -> Result<Json<SnippetDownloadResult>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let (snapshot, summary) = SnippetSyncClient::new(req.config).get_snapshot().await.map_err(AppError::from)?;
    let explicit_passphrase = req.secrets_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let saved_passphrase = if explicit_passphrase.is_some() {
        None
    } else {
        resolve_webdav_sync_secrets_passphrase(&state.app.storage).await.map_err(AppError::from)?
    };
    let apply_summary = apply_sync_snapshot(
        &state.app.storage,
        &snapshot,
        ApplySnapshotOptions { secrets_passphrase: explicit_passphrase.or(saved_passphrase.as_deref()) },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(SnippetDownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    }))
}
