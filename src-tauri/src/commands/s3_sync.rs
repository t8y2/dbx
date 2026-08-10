use std::sync::Arc;

use dbx_core::cloud_sync::{
    apply_sync_snapshot, build_sync_snapshot_with_saved_secrets, forget_s3_credentials, resolve_s3_credentials,
    resolve_webdav_sync_secrets_passphrase, s3_saved_credentials_status, save_s3_credentials, ApplySnapshotOptions,
    ApplySnapshotSummary, S3CredentialsStatus, S3SyncClient, S3SyncConfig, S3SyncSummary,
};
use dbx_core::connection::AppState;
use dbx_core::storage::DesktopSettings;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3DownloadResult {
    pub summary: S3SyncSummary,
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[tauri::command]
pub async fn s3_sync_test(state: State<'_, Arc<AppState>>, mut config: S3SyncConfig) -> Result<(), String> {
    resolve_s3_credentials(&state.storage, &mut config).await?;
    S3SyncClient::new(config)?.test().await
}

#[tauri::command]
pub async fn s3_credentials_status(
    state: State<'_, Arc<AppState>>,
    config: S3SyncConfig,
) -> Result<S3CredentialsStatus, String> {
    s3_saved_credentials_status(&state.storage, &config).await
}

#[tauri::command]
pub async fn save_s3_saved_credentials(
    state: State<'_, Arc<AppState>>,
    config: S3SyncConfig,
    secret_access_key: String,
    session_token: Option<String>,
) -> Result<(), String> {
    save_s3_credentials(&state.storage, &config, &secret_access_key, session_token.as_deref()).await
}

#[tauri::command]
pub async fn forget_s3_saved_credentials(state: State<'_, Arc<AppState>>, config: S3SyncConfig) -> Result<(), String> {
    forget_s3_credentials(&state.storage, &config).await
}

#[tauri::command]
pub async fn s3_sync_upload(
    state: State<'_, Arc<AppState>>,
    mut config: S3SyncConfig,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<String>,
) -> Result<S3SyncSummary, String> {
    resolve_s3_credentials(&state.storage, &mut config).await?;
    let snapshot = build_sync_snapshot_with_saved_secrets(
        &state.storage,
        env!("CARGO_PKG_VERSION"),
        editor_settings,
        secrets_passphrase.as_deref(),
    )
    .await?;
    S3SyncClient::new(config)?.put_snapshot(&snapshot).await
}

#[tauri::command]
pub async fn s3_sync_download(
    state: State<'_, Arc<AppState>>,
    mut config: S3SyncConfig,
    secrets_passphrase: Option<String>,
) -> Result<S3DownloadResult, String> {
    resolve_s3_credentials(&state.storage, &mut config).await?;
    let (snapshot, summary) = S3SyncClient::new(config)?.get_snapshot().await?;
    let explicit_passphrase = secrets_passphrase.as_deref().map(str::trim).filter(|value| !value.is_empty());
    let saved_passphrase = if explicit_passphrase.is_some() {
        None
    } else {
        resolve_webdav_sync_secrets_passphrase(&state.storage).await?
    };
    let apply_summary = apply_sync_snapshot(
        &state.storage,
        &snapshot,
        ApplySnapshotOptions {
            secrets_passphrase: explicit_passphrase.or(saved_passphrase.as_deref()),
            restore_secrets: true,
        },
    )
    .await?;
    Ok(S3DownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    })
}
