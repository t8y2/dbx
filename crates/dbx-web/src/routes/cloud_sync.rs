use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use dbx_core::cloud_sync::{
    apply_sync_snapshot, build_sync_snapshot, build_sync_snapshot_with_saved_secrets, finalize_snippet_migration,
    forget_snippet_token, forget_webdav_password,
    forget_webdav_sync_secrets_passphrase as core_forget_webdav_sync_secrets_passphrase, resolve_snippet_token,
    resolve_webdav_password, resolve_webdav_sync_secrets_passphrase, retry_pending_snippet_cleanup,
    save_snippet_sync_id as core_save_snippet_sync_id, save_snippet_token, save_webdav_password,
    save_webdav_sync_secrets_preference as core_save_webdav_sync_secrets_preference, snippet_saved_token_status,
    snippet_sync_settings as core_snippet_sync_settings, webdav_saved_password_status,
    webdav_sync_secrets_status as core_webdav_sync_secrets_status, ApplySnapshotOptions, ApplySnapshotSummary,
    SnippetProvider, SnippetSyncClient, SnippetSyncConfig, SnippetSyncSettings, SnippetSyncSummary, SnippetTokenStatus,
    WebDavClient, WebDavConfig, WebDavPasswordStatus, WebDavSyncSecretsStatus, WebDavSyncSummary,
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
    pub snippet_passphrase: Option<String>,
    #[serde(default)]
    pub include_secrets: bool,
    pub secrets_passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDownloadRequest {
    pub config: SnippetSyncConfig,
    pub snippet_passphrase: Option<String>,
    #[serde(default)]
    pub restore_secrets: bool,
    pub secrets_passphrase: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSyncSettingsRequest {
    pub provider: SnippetProvider,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSnippetSyncIdRequest {
    pub provider: SnippetProvider,
    pub snippet_id: Option<String>,
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
        ApplySnapshotOptions {
            secrets_passphrase: explicit_passphrase.or(saved_passphrase.as_deref()),
            restore_secrets: true,
        },
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

pub async fn snippet_sync_settings(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SnippetSyncSettingsRequest>,
) -> Result<Json<SnippetSyncSettings>, AppError> {
    core_snippet_sync_settings(&state.app.storage, req.provider).await.map(Json).map_err(AppError::from)
}

pub async fn save_snippet_sync_id(
    State(state): State<Arc<WebState>>,
    Json(req): Json<SaveSnippetSyncIdRequest>,
) -> Result<Json<()>, AppError> {
    core_save_snippet_sync_id(&state.app.storage, req.provider, req.snippet_id.as_deref())
        .await
        .map_err(AppError::from)?;
    Ok(Json(()))
}

pub async fn retry_snippet_legacy_cleanup(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetConfigRequest>,
) -> Result<Json<SnippetSyncSettings>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let provider = req.config.provider;
    let client = SnippetSyncClient::new(req.config);
    retry_pending_snippet_cleanup(&state.app.storage, provider, &client).await.map(Json).map_err(AppError::from)
}

pub async fn snippet_sync_upload(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetUploadRequest>,
) -> Result<Json<SnippetSyncSummary>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let secrets_passphrase = if req.include_secrets {
        Some(
            req.secrets_passphrase
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::from("A sync password is required when including synced secrets."))?,
        )
    } else {
        None
    };
    let snapshot =
        build_sync_snapshot(&state.app.storage, env!("CARGO_PKG_VERSION"), req.editor_settings, secrets_passphrase)
            .await
            .map_err(AppError::from)?;
    let client = SnippetSyncClient::new(req.config);
    let mut summary = client
        .put_snapshot(&snapshot, req.snippet_passphrase.as_deref(), secrets_passphrase)
        .await
        .map_err(AppError::from)?;
    finalize_snippet_migration(&state.app.storage, &client, &mut summary).await.map_err(AppError::from)?;
    Ok(Json(summary))
}

pub async fn snippet_sync_download(
    State(state): State<Arc<WebState>>,
    Json(mut req): Json<SnippetDownloadRequest>,
) -> Result<Json<SnippetDownloadResult>, AppError> {
    resolve_snippet_token(&state.app.storage, &mut req.config).await.map_err(AppError::from)?;
    let (snapshot, summary) = SnippetSyncClient::new(req.config)
        .get_snapshot(req.snippet_passphrase.as_deref())
        .await
        .map_err(AppError::from)?;
    let apply_summary = apply_sync_snapshot(
        &state.app.storage,
        &snapshot,
        ApplySnapshotOptions {
            secrets_passphrase: req.secrets_passphrase.as_deref(),
            restore_secrets: req.restore_secrets,
        },
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

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::extract::State;
    use axum::Json;
    use dbx_core::cloud_sync::SnippetProvider;
    use dbx_core::connection::AppState;
    use dbx_core::storage::Storage;

    use crate::state::WebState;

    #[tokio::test]
    async fn snippet_settings_surfaces_pending_cleanup_after_restart() {
        let dir = std::env::temp_dir().join(format!("dbx-web-snippet-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("storage.db");
        let storage = Storage::open(&db).await.unwrap();
        storage.save_snippet_migration_state("github", "replacement-id", "legacy-id", "content-hash").await.unwrap();
        drop(storage);

        let storage = Storage::open(&db).await.unwrap();
        let app = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let state = Arc::new(WebState::for_tests(app, dir.clone()));
        let Json(settings) = super::snippet_sync_settings(
            State(state),
            Json(super::SnippetSyncSettingsRequest { provider: SnippetProvider::GitHub }),
        )
        .await
        .unwrap();

        assert_eq!(settings.snippet_id.as_deref(), Some("replacement-id"));
        assert_eq!(settings.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        std::fs::remove_dir_all(dir).ok();
    }
}
