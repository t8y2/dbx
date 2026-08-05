use std::sync::Arc;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDownloadResult {
    pub summary: SnippetSyncSummary,
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
pub async fn webdav_sync_secrets_status(state: State<'_, Arc<AppState>>) -> Result<WebDavSyncSecretsStatus, String> {
    core_webdav_sync_secrets_status(&state.storage).await
}

#[tauri::command]
pub async fn save_webdav_sync_secrets_preference(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
    passphrase: Option<String>,
) -> Result<(), String> {
    core_save_webdav_sync_secrets_preference(&state.storage, enabled, passphrase.as_deref()).await
}

#[tauri::command]
pub async fn forget_webdav_sync_secrets_passphrase(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    core_forget_webdav_sync_secrets_passphrase(&state.storage).await
}

#[tauri::command]
pub async fn webdav_sync_upload(
    state: State<'_, Arc<AppState>>,
    mut config: WebDavConfig,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<String>,
) -> Result<WebDavSyncSummary, String> {
    resolve_webdav_password(&state.storage, &mut config).await?;
    let snapshot = build_sync_snapshot_with_saved_secrets(
        &state.storage,
        env!("CARGO_PKG_VERSION"),
        editor_settings,
        secrets_passphrase.as_deref(),
    )
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
    Ok(WebDavDownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    })
}

#[tauri::command]
pub async fn snippet_sync_test(state: State<'_, Arc<AppState>>, mut config: SnippetSyncConfig) -> Result<(), String> {
    resolve_snippet_token(&state.storage, &mut config).await?;
    SnippetSyncClient::new(config).test().await
}

#[tauri::command]
pub async fn snippet_token_status(
    state: State<'_, Arc<AppState>>,
    config: SnippetSyncConfig,
) -> Result<SnippetTokenStatus, String> {
    snippet_saved_token_status(&state.storage, &config).await
}

#[tauri::command]
pub async fn save_snippet_saved_token(
    state: State<'_, Arc<AppState>>,
    config: SnippetSyncConfig,
    token: String,
) -> Result<(), String> {
    save_snippet_token(&state.storage, &config, &token).await
}

#[tauri::command]
pub async fn forget_snippet_saved_token(
    state: State<'_, Arc<AppState>>,
    config: SnippetSyncConfig,
) -> Result<(), String> {
    forget_snippet_token(&state.storage, &config).await
}

#[tauri::command]
pub async fn snippet_sync_settings(
    state: State<'_, Arc<AppState>>,
    provider: SnippetProvider,
) -> Result<SnippetSyncSettings, String> {
    core_snippet_sync_settings(&state.storage, provider).await
}

#[tauri::command]
pub async fn save_snippet_sync_id(
    state: State<'_, Arc<AppState>>,
    provider: SnippetProvider,
    snippet_id: Option<String>,
) -> Result<(), String> {
    core_save_snippet_sync_id(&state.storage, provider, snippet_id.as_deref()).await
}

#[tauri::command]
pub async fn retry_snippet_legacy_cleanup(
    state: State<'_, Arc<AppState>>,
    mut config: SnippetSyncConfig,
) -> Result<SnippetSyncSettings, String> {
    resolve_snippet_token(&state.storage, &mut config).await?;
    let provider = config.provider;
    let client = SnippetSyncClient::new(config);
    retry_pending_snippet_cleanup(&state.storage, provider, &client).await
}

#[tauri::command]
pub async fn snippet_sync_upload(
    state: State<'_, Arc<AppState>>,
    mut config: SnippetSyncConfig,
    editor_settings: Option<serde_json::Value>,
    snippet_passphrase: Option<String>,
    include_secrets: bool,
    secrets_passphrase: Option<String>,
) -> Result<SnippetSyncSummary, String> {
    resolve_snippet_token(&state.storage, &mut config).await?;
    let secrets_passphrase = if include_secrets {
        Some(
            secrets_passphrase
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "A sync password is required when including synced secrets.".to_string())?,
        )
    } else {
        None
    };
    let snapshot =
        build_sync_snapshot(&state.storage, env!("CARGO_PKG_VERSION"), editor_settings, secrets_passphrase).await?;
    let client = SnippetSyncClient::new(config);
    let mut summary = client.put_snapshot(&snapshot, snippet_passphrase.as_deref(), secrets_passphrase).await?;
    finalize_snippet_migration(&state.storage, &client, &mut summary).await?;
    Ok(summary)
}

#[tauri::command]
pub async fn snippet_sync_download(
    state: State<'_, Arc<AppState>>,
    mut config: SnippetSyncConfig,
    snippet_passphrase: Option<String>,
    restore_secrets: bool,
    secrets_passphrase: Option<String>,
) -> Result<SnippetDownloadResult, String> {
    resolve_snippet_token(&state.storage, &mut config).await?;
    let (snapshot, summary) = SnippetSyncClient::new(config).get_snapshot(snippet_passphrase.as_deref()).await?;
    let apply_summary = apply_sync_snapshot(
        &state.storage,
        &snapshot,
        ApplySnapshotOptions { secrets_passphrase: secrets_passphrase.as_deref(), restore_secrets },
    )
    .await?;
    Ok(SnippetDownloadResult {
        summary,
        editor_settings: snapshot.editor_settings,
        desktop_settings: snapshot.desktop_settings,
        apply_summary,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use dbx_core::cloud_sync::SnippetProvider;
    use dbx_core::storage::Storage;
    use tauri::Manager;

    use super::AppState;

    #[tokio::test]
    async fn snippet_settings_surfaces_pending_cleanup_after_restart() {
        let dir = std::env::temp_dir().join(format!("dbx-tauri-snippet-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("storage.db");
        let storage = Storage::open(&db).await.unwrap();
        storage.save_snippet_migration_state("github", "replacement-id", "legacy-id", "content-hash").await.unwrap();
        drop(storage);

        let storage = Storage::open(&db).await.unwrap();
        let app_state = Arc::new(AppState::new_with_plugin_dir(storage, dir.join("plugins")));
        let app = tauri::test::mock_app();
        app.manage(app_state);
        let state: tauri::State<'_, Arc<AppState>> = app.state();
        let settings = super::snippet_sync_settings(state, SnippetProvider::GitHub).await.unwrap();

        assert_eq!(settings.snippet_id.as_deref(), Some("replacement-id"));
        assert_eq!(settings.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        drop(app);
        std::fs::remove_dir_all(dir).ok();
    }
}
