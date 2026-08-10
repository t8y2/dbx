use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::cloud_sync::{
    apply_sync_snapshot, build_sync_snapshot_with_saved_secrets, forget_s3_credentials, resolve_s3_credentials,
    resolve_webdav_sync_secrets_passphrase, s3_saved_credentials_status, save_s3_credentials, ApplySnapshotOptions,
    ApplySnapshotSummary, S3CredentialsStatus, S3SyncClient, S3SyncConfig, S3SyncSummary,
};
use dbx_core::storage::DesktopSettings;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::WebState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3DownloadResult {
    pub summary: S3SyncSummary,
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3ConfigRequest {
    pub config: S3SyncConfig,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveS3CredentialsRequest {
    pub config: S3SyncConfig,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3UploadRequest {
    pub config: S3SyncConfig,
    pub editor_settings: Option<serde_json::Value>,
    pub secrets_passphrase: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3DownloadRequest {
    pub config: S3SyncConfig,
    pub secrets_passphrase: Option<String>,
}

pub async fn s3_sync_test(
    State(state): State<Arc<WebState>>,
    Json(mut request): Json<S3ConfigRequest>,
) -> Result<Json<()>, AppError> {
    resolve_s3_credentials(&state.app.storage, &mut request.config).await.map_err(AppError::from)?;
    S3SyncClient::new(request.config)?.test().await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn s3_credentials_status(
    State(state): State<Arc<WebState>>,
    Json(request): Json<S3ConfigRequest>,
) -> Result<Json<S3CredentialsStatus>, AppError> {
    s3_saved_credentials_status(&state.app.storage, &request.config).await.map(Json).map_err(AppError::from)
}

pub async fn save_s3_saved_credentials(
    State(state): State<Arc<WebState>>,
    Json(request): Json<SaveS3CredentialsRequest>,
) -> Result<Json<()>, AppError> {
    save_s3_credentials(
        &state.app.storage,
        &request.config,
        &request.secret_access_key,
        request.session_token.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn forget_s3_saved_credentials(
    State(state): State<Arc<WebState>>,
    Json(request): Json<S3ConfigRequest>,
) -> Result<Json<()>, AppError> {
    forget_s3_credentials(&state.app.storage, &request.config).await.map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn s3_sync_upload(
    State(state): State<Arc<WebState>>,
    Json(mut request): Json<S3UploadRequest>,
) -> Result<Json<S3SyncSummary>, AppError> {
    resolve_s3_credentials(&state.app.storage, &mut request.config).await.map_err(AppError::from)?;
    let snapshot = build_sync_snapshot_with_saved_secrets(
        &state.app.storage,
        env!("CARGO_PKG_VERSION"),
        request.editor_settings,
        request.secrets_passphrase.as_deref(),
    )
    .await
    .map_err(AppError::from)?;
    S3SyncClient::new(request.config)?.put_snapshot(&snapshot).await.map(Json).map_err(AppError::from)
}

pub async fn s3_sync_download(
    State(state): State<Arc<WebState>>,
    Json(mut request): Json<S3DownloadRequest>,
) -> Result<Json<S3DownloadResult>, AppError> {
    resolve_s3_credentials(&state.app.storage, &mut request.config).await.map_err(AppError::from)?;
    let (snapshot, summary) = S3SyncClient::new(request.config)?.get_snapshot().await.map_err(AppError::from)?;
    let explicit_passphrase = request.secrets_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let saved_passphrase = if explicit_passphrase.is_some() {
        None
    } else {
        resolve_webdav_sync_secrets_passphrase(&state.app.storage).await.map_err(AppError::from)?
    };
    let apply_summary = apply_sync_snapshot(
        &state.app.storage,
        &snapshot,
        ApplySnapshotOptions {
            secrets_passphrase: explicit_passphrase.or(saved_passphrase.as_deref()),
            restore_secrets: true,
        },
    )
    .await
    .map_err(AppError::from)?;
    Ok(Json(S3DownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    }))
}
