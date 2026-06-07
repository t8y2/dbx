use std::sync::Arc;

use dbx_core::cloud_sync::{
    apply_sync_snapshot, build_sync_snapshot, forget_webdav_password, resolve_webdav_password, save_webdav_password,
    webdav_saved_password_status, ApplySnapshotOptions, ApplySnapshotSummary, WebDavClient, WebDavConfig,
    WebDavPasswordStatus, WebDavSyncSummary,
};
use dbx_core::storage::DesktopSettings;
use serde::{Deserialize, Serialize};
use tauri::State;

use dbx_core::connection::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavDownloadResult {
    pub summary: WebDavSyncSummary,
    pub editor_settings: Option<serde_json::Value>,
    pub desktop_settings: DesktopSettings,
    pub apply_summary: ApplySnapshotSummary,
}

#[tauri::command]
pub async fn webdav_sync_test(state: State<'_, Arc<AppState>>, mut config: WebDavConfig) -> Result<(), String> {
    resolve_webdav_password(&state.storage, &mut config).await?;
    WebDavClient::new(config).test().await
}

#[tauri::command]
pub async fn webdav_password_status(
    state: State<'_, Arc<AppState>>,
    config: WebDavConfig,
) -> Result<WebDavPasswordStatus, String> {
    webdav_saved_password_status(&state.storage, &config).await
}

#[tauri::command]
pub async fn save_webdav_saved_password(
    state: State<'_, Arc<AppState>>,
    config: WebDavConfig,
    password: String,
) -> Result<(), String> {
    save_webdav_password(&state.storage, &config, &password).await
}

#[tauri::command]
pub async fn forget_webdav_saved_password(state: State<'_, Arc<AppState>>, config: WebDavConfig) -> Result<(), String> {
    forget_webdav_password(&state.storage, &config).await
}

#[tauri::command]
pub async fn webdav_sync_upload(
    state: State<'_, Arc<AppState>>,
    mut config: WebDavConfig,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<String>,
) -> Result<WebDavSyncSummary, String> {
    resolve_webdav_password(&state.storage, &mut config).await?;
    let snapshot =
        build_sync_snapshot(&state.storage, env!("CARGO_PKG_VERSION"), editor_settings, secrets_passphrase.as_deref())
            .await?;
    WebDavClient::new(config).put_snapshot(&snapshot).await
}

#[tauri::command]
pub async fn webdav_sync_download(
    state: State<'_, Arc<AppState>>,
    mut config: WebDavConfig,
    secrets_passphrase: Option<String>,
) -> Result<WebDavDownloadResult, String> {
    resolve_webdav_password(&state.storage, &mut config).await?;
    let (snapshot, summary) = WebDavClient::new(config).get_snapshot().await?;
    let apply_summary = apply_sync_snapshot(
        &state.storage,
        &snapshot,
        ApplySnapshotOptions { secrets_passphrase: secrets_passphrase.as_deref() },
    )
    .await?;
    Ok(WebDavDownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    })
}
