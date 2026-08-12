use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng},
    Aes256Gcm, KeyInit, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as BASE64, engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use reqwest::{header, Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};

use crate::ai::AiConfigItem;
use crate::connection_secrets::{
    MQ_AUTH_API_KEY_VALUE_KEY, MQ_AUTH_CLIENT_SECRET_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_TOKEN_KEY,
    MQ_TOKEN_SIGNING_KEY, NACOS_AUTH_PASSWORD_KEY, NACOS_RNACOS_CONSOLE_PASSWORD_KEY,
};
use crate::models::connection::{ConnectionConfig, DatabaseType, TransportLayerConfig};
use crate::saved_sql::SavedSqlLibrary;
use crate::storage::{DesktopSettings, SnippetPendingCleanup, Storage};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const ENCRYPTED_SNIPPET_SNAPSHOT_FORMAT: &str = "dbx-encrypted-sync-snapshot";
const ENCRYPTED_SNIPPET_SNAPSHOT_VERSION: u32 = 1;
const DEFAULT_REMOTE_PATH: &str = "DBX/sync/snapshot.json";
const DEFAULT_SNIPPET_FILE_NAME: &str = "dbx-sync.json";
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITEE_API_BASE: &str = "https://gitee.com/api/v5";
const SECRET_KEYS: &[&str] = &[
    "password",
    "ssh_password",
    "ssh_key_passphrase",
    "proxy_password",
    "redis_sentinel_password",
    "connection_string",
    "init_script",
    MQ_AUTH_TOKEN_KEY,
    MQ_AUTH_PASSWORD_KEY,
    MQ_AUTH_API_KEY_VALUE_KEY,
    MQ_AUTH_CLIENT_SECRET_KEY,
    MQ_TOKEN_SIGNING_KEY,
    NACOS_AUTH_PASSWORD_KEY,
    NACOS_RNACOS_CONSOLE_PASSWORD_KEY,
];
const SSH_TUNNEL_SECRET_PREFIX: &str = "ssh_tunnels.";
const TRANSPORT_LAYER_SECRET_PREFIX: &str = "transport_layers.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavConfig {
    pub endpoint: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub remote_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SnippetProvider {
    #[serde(rename = "github", alias = "git_hub")]
    GitHub,
    #[serde(rename = "gitee")]
    Gitee,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSyncConfig {
    pub provider: SnippetProvider,
    pub token: Option<String>,
    pub snippet_id: Option<String>,
    /// Explicitly requested one-time migration for a legacy plaintext snippet.
    /// The remote plaintext snippet is only deleted after a new encrypted one
    /// has been created successfully.
    #[serde(default)]
    pub replace_legacy_snippet: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetTokenStatus {
    pub has_saved_token: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSyncSettings {
    pub snippet_id: Option<String>,
    #[serde(default)]
    pub legacy_cleanup_required_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavPasswordStatus {
    pub has_saved_password: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSecretsStatus {
    pub enabled: bool,
    pub has_saved_passphrase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub connections: Vec<ConnectionConfig>,
    /// Explicit MQTT subscription metadata. `None` means this is a legacy
    /// snapshot that predates MQTT subscription sync and must not clear local
    /// subscriptions when applied.
    #[serde(default)]
    pub mqtt_subscriptions: Option<Vec<MqttSubscriptionSyncEntry>>,
    /// Shared tunnel profiles (secrets scrubbed). `None` means the snapshot
    /// predates tunnel profiles — applying it leaves local profiles alone.
    #[serde(default)]
    pub tunnel_profiles: Option<Vec<TransportLayerConfig>>,
    pub sidebar_layout: Option<serde_json::Value>,
    pub pinned_tree_node_ids: Vec<String>,
    pub saved_sql: SavedSqlLibrary,
    pub desktop_settings: DesktopSettings,
    pub editor_settings: Option<serde_json::Value>,
    pub encrypted_secrets: Option<EncryptedSecretsBlob>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttSubscriptionSyncEntry {
    pub connection_id: String,
    pub subscriptions: Vec<MqttSubscriptionSyncTopic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MqttSubscriptionSyncTopic {
    pub topic: String,
    #[serde(default = "default_sync_qos")]
    pub qos: String,
    #[serde(default)]
    pub no_local: bool,
    #[serde(default = "default_sync_enabled")]
    pub enabled: bool,
}

fn default_sync_qos() -> String {
    "atmostonce".to_string()
}

fn default_sync_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedSecretsBlob {
    pub version: u32,
    pub kdf: String,
    pub cipher: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedSnippetSnapshot {
    format: String,
    version: u32,
    payload: EncryptedSecretsBlob,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SensitiveSyncPayload {
    pub connection_secrets: Vec<ConnectionSecretSnapshot>,
    // None = legacy snapshot (fall through to ai_config migration),
    // Some(vec) = explicit state (empty vec means all configs were deleted)
    pub ai_configs: Option<Vec<AiConfigItem>>,
    /// Legacy field, used only for deserializing old data; not serialized
    #[serde(default, skip_serializing)]
    pub ai_config: Option<crate::ai::AiConfig>,
    /// Full tunnel profiles including their secrets.
    #[serde(default)]
    pub tunnel_profiles: Option<Vec<TransportLayerConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSecretSnapshot {
    pub connection_id: String,
    pub key: String,
    pub secret: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct ApplySnapshotOptions<'a> {
    pub secrets_passphrase: Option<&'a str>,
    /// Whether encrypted secrets in the remote snapshot may replace local
    /// secrets. Metadata is always applied, but callers can explicitly keep
    /// device-local credentials while restoring the rest of a snapshot.
    pub restore_secrets: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplySnapshotSummary {
    pub encrypted_secrets_present: bool,
    pub secrets_applied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavSyncSummary {
    pub remote_path: String,
    pub bytes: usize,
    pub exported_at: Option<String>,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetSyncSummary {
    pub provider: SnippetProvider,
    pub snippet_id: String,
    pub bytes: usize,
    pub exported_at: Option<String>,
    pub app_version: Option<String>,
    /// A new encrypted snippet was created, but the old plaintext snippet
    /// could not be removed. The caller must surface this id for manual cleanup.
    #[serde(default)]
    pub legacy_cleanup_required_id: Option<String>,
    /// Internal guard for a later legacy cleanup. It is deliberately omitted
    /// from the API response so remote snapshot content never leaves the
    /// process through a status payload.
    #[serde(skip)]
    legacy_cleanup_expected_content_hash: Option<String>,
}

pub async fn build_sync_snapshot(
    storage: &Storage,
    app_version: impl Into<String>,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<&str>,
) -> Result<SyncSnapshot, String> {
    let mut connections = storage.load_connections().await?;
    let mut tunnel_profiles = storage.load_tunnel_profiles().await?;
    let encrypted_secrets = match normalized_passphrase(secrets_passphrase) {
        Some(passphrase) => Some(encrypt_sensitive_payload(
            &build_sensitive_payload(storage, &connections, &tunnel_profiles).await?,
            passphrase,
        )?),
        None => None,
    };
    let mqtt_subscriptions = Some(extract_mqtt_subscriptions(&connections)?);
    for config in &mut connections {
        scrub_connection_secrets(config);
    }
    for profile in &mut tunnel_profiles {
        profile.scrub_secrets();
    }

    Ok(SyncSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        app_version: app_version.into(),
        connections,
        mqtt_subscriptions,
        tunnel_profiles: Some(tunnel_profiles),
        sidebar_layout: storage.load_sidebar_layout().await?,
        pinned_tree_node_ids: storage.load_pinned_tree_node_ids().await?,
        saved_sql: storage.load_saved_sql_library().await?,
        desktop_settings: storage.load_desktop_settings().await?,
        editor_settings,
        encrypted_secrets,
    })
}

pub async fn build_sync_snapshot_with_saved_secrets(
    storage: &Storage,
    app_version: impl Into<String>,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<&str>,
) -> Result<SyncSnapshot, String> {
    match normalized_passphrase(secrets_passphrase) {
        Some(passphrase) => build_sync_snapshot(storage, app_version, editor_settings, Some(passphrase)).await,
        None => {
            let saved_passphrase = resolve_webdav_sync_secrets_passphrase(storage).await?;
            build_sync_snapshot(storage, app_version, editor_settings, saved_passphrase.as_deref()).await
        }
    }
}

pub async fn apply_sync_snapshot(
    storage: &Storage,
    snapshot: &SyncSnapshot,
    options: ApplySnapshotOptions<'_>,
) -> Result<ApplySnapshotSummary, String> {
    if snapshot.schema_version != SNAPSHOT_SCHEMA_VERSION {
        return Err(format!("Unsupported sync snapshot schema version: {}", snapshot.schema_version));
    }

    let encrypted_secrets_present = snapshot.encrypted_secrets.is_some();
    let sensitive_payload =
        match (options.restore_secrets, &snapshot.encrypted_secrets, normalized_passphrase(options.secrets_passphrase))
        {
            (true, Some(blob), Some(passphrase)) => Some(decrypt_sensitive_payload(blob, passphrase)?),
            // Restore intent is explicit. Do not silently leave a user with a
            // partial restore when the remote snapshot contains secrets.
            (true, Some(_), None) => return Err("A sync password is required to restore synced secrets.".to_string()),
            _ => None,
        };

    let mut connections = snapshot.connections.clone();
    if let Some(mqtt_subscriptions) = &snapshot.mqtt_subscriptions {
        apply_mqtt_subscriptions(&mut connections, mqtt_subscriptions)?;
    } else {
        // Snapshots created before MQTT subscription sync may still contain a
        // stale `savedTopics` value inside `externalConfig`. Preserve the
        // current device value instead of allowing that legacy metadata to
        // overwrite local subscriptions during restore.
        preserve_local_mqtt_subscriptions_for_legacy_snapshot(storage, &mut connections).await?;
    }
    for config in &mut connections {
        scrub_connection_secrets(config);
    }

    storage.save_connection_metadata_preserving_secrets(&connections).await?;
    if let Some(profiles) = &snapshot.tunnel_profiles {
        storage.save_tunnel_profiles_preserving_secrets(profiles).await?;
    }
    if let Some(layout) = &snapshot.sidebar_layout {
        storage.save_sidebar_layout(layout).await?;
    }
    storage.save_pinned_tree_node_ids(&snapshot.pinned_tree_node_ids).await?;
    storage.replace_saved_sql_library(&snapshot.saved_sql).await?;
    storage.save_desktop_settings(&snapshot.desktop_settings).await?;
    if let Some(payload) = &sensitive_payload {
        clear_connection_secrets(storage, &connections).await?;
        apply_sensitive_payload(storage, payload).await?;
    }
    Ok(ApplySnapshotSummary { encrypted_secrets_present, secrets_applied: sensitive_payload.is_some() })
}

pub struct WebDavClient {
    http: Client,
    config: WebDavConfig,
}

pub struct SnippetSyncClient {
    http: Client,
    config: SnippetSyncConfig,
    api_base: String,
}

pub async fn webdav_saved_password_status(
    storage: &Storage,
    config: &WebDavConfig,
) -> Result<WebDavPasswordStatus, String> {
    let account = webdav_password_account(config);
    Ok(WebDavPasswordStatus { has_saved_password: storage.load_webdav_password_blob(&account).await?.is_some() })
}

pub async fn save_webdav_password(storage: &Storage, config: &WebDavConfig, password: &str) -> Result<(), String> {
    let secret = storage.load_or_create_local_device_secret().await?;
    let blob = encrypt_text_with_secret(password, &secret)?;
    let value = serde_json::to_value(blob).map_err(|e| e.to_string())?;
    storage.save_webdav_password_blob(&webdav_password_account(config), &value).await
}

pub async fn forget_webdav_password(storage: &Storage, config: &WebDavConfig) -> Result<(), String> {
    storage.delete_webdav_password_blob(&webdav_password_account(config)).await
}

pub async fn resolve_webdav_password(storage: &Storage, config: &mut WebDavConfig) -> Result<(), String> {
    if config.password.as_deref().is_some_and(|password| !password.is_empty()) {
        return Ok(());
    }
    let Some(value) = storage.load_webdav_password_blob(&webdav_password_account(config)).await? else {
        return Ok(());
    };
    let blob: EncryptedSecretsBlob = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let secret = storage.load_or_create_local_device_secret().await?;
    config.password = Some(decrypt_text_with_secret(&blob, &secret)?);
    Ok(())
}

pub async fn snippet_saved_token_status(
    storage: &Storage,
    config: &SnippetSyncConfig,
) -> Result<SnippetTokenStatus, String> {
    let account = snippet_token_account(config.provider);
    Ok(SnippetTokenStatus { has_saved_token: storage.load_webdav_password_blob(&account).await?.is_some() })
}

pub async fn save_snippet_token(storage: &Storage, config: &SnippetSyncConfig, token: &str) -> Result<(), String> {
    let secret = storage.load_or_create_local_device_secret().await?;
    let blob = encrypt_text_with_secret(token, &secret)?;
    let value = serde_json::to_value(blob).map_err(|e| e.to_string())?;
    storage.save_webdav_password_blob(&snippet_token_account(config.provider), &value).await
}

pub async fn forget_snippet_token(storage: &Storage, config: &SnippetSyncConfig) -> Result<(), String> {
    storage.delete_webdav_password_blob(&snippet_token_account(config.provider)).await
}

pub async fn snippet_sync_settings(
    storage: &Storage,
    provider: SnippetProvider,
) -> Result<SnippetSyncSettings, String> {
    let state = storage.load_snippet_sync_state(snippet_provider_storage_key(provider)).await?;
    Ok(SnippetSyncSettings {
        snippet_id: state.snippet_id,
        legacy_cleanup_required_id: state.pending_cleanup.map(|cleanup| cleanup.snippet_id),
    })
}

pub async fn save_snippet_sync_id(
    storage: &Storage,
    provider: SnippetProvider,
    snippet_id: Option<&str>,
) -> Result<(), String> {
    storage.save_snippet_sync_id(snippet_provider_storage_key(provider), snippet_id).await
}

pub async fn finalize_snippet_migration(
    storage: &Storage,
    client: &SnippetSyncClient,
    summary: &mut SnippetSyncSummary,
) -> Result<(), String> {
    let Some(pending_cleanup) = snippet_pending_cleanup(summary)? else {
        return Ok(());
    };
    let provider_key = snippet_provider_storage_key(summary.provider);
    storage
        .save_snippet_migration_state(
            provider_key,
            &summary.snippet_id,
            &pending_cleanup.snippet_id,
            &pending_cleanup.expected_content_hash,
        )
        .await?;
    if client.delete_legacy_snippet_if_unchanged(&pending_cleanup).await.unwrap_or(false)
        && storage.clear_snippet_pending_cleanup_if_matches(provider_key, &pending_cleanup).await?
    {
        summary.legacy_cleanup_required_id = None;
        summary.legacy_cleanup_expected_content_hash = None;
    }
    Ok(())
}

pub async fn retry_pending_snippet_cleanup(
    storage: &Storage,
    provider: SnippetProvider,
    client: &SnippetSyncClient,
) -> Result<SnippetSyncSettings, String> {
    let provider_key = snippet_provider_storage_key(provider);
    let state = storage.load_snippet_sync_state(provider_key).await?;
    if let Some(pending_cleanup) = state.pending_cleanup {
        if client.delete_legacy_snippet_if_unchanged(&pending_cleanup).await? {
            storage.clear_snippet_pending_cleanup_if_matches(provider_key, &pending_cleanup).await?;
        }
    }
    snippet_sync_settings(storage, provider).await
}

pub async fn resolve_snippet_token(storage: &Storage, config: &mut SnippetSyncConfig) -> Result<(), String> {
    if config.token.as_deref().is_some_and(|token| !token.trim().is_empty()) {
        return Ok(());
    }
    let Some(value) = storage.load_webdav_password_blob(&snippet_token_account(config.provider)).await? else {
        return Ok(());
    };
    let blob: EncryptedSecretsBlob = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let secret = storage.load_or_create_local_device_secret().await?;
    config.token = Some(decrypt_text_with_secret(&blob, &secret)?);
    Ok(())
}

pub async fn webdav_sync_secrets_status(storage: &Storage) -> Result<WebDavSyncSecretsStatus, String> {
    Ok(WebDavSyncSecretsStatus {
        enabled: storage.load_webdav_sync_secrets_enabled().await?,
        has_saved_passphrase: storage.load_webdav_sync_secrets_passphrase_blob().await?.is_some(),
    })
}

pub async fn save_webdav_sync_secrets_preference(
    storage: &Storage,
    enabled: bool,
    passphrase: Option<&str>,
) -> Result<(), String> {
    let normalized = normalized_passphrase(passphrase);
    let blob = match normalized {
        Some(passphrase) => {
            let secret = storage.load_or_create_local_device_secret().await?;
            let blob = encrypt_text_with_secret(passphrase, &secret)?;
            Some(serde_json::to_value(blob).map_err(|e| e.to_string())?)
        }
        None => None,
    };
    storage.save_webdav_sync_secrets_preference(enabled, blob.as_ref()).await
}

pub async fn forget_webdav_sync_secrets_passphrase(storage: &Storage) -> Result<(), String> {
    storage.delete_webdav_sync_secrets_passphrase_blob().await
}

pub async fn resolve_webdav_sync_secrets_passphrase(storage: &Storage) -> Result<Option<String>, String> {
    if !storage.load_webdav_sync_secrets_enabled().await? {
        return Ok(None);
    }
    let Some(value) = storage.load_webdav_sync_secrets_passphrase_blob().await? else {
        return Ok(None);
    };
    let blob: EncryptedSecretsBlob = serde_json::from_value(value).map_err(|e| e.to_string())?;
    let secret = storage.load_or_create_local_device_secret().await?;
    decrypt_text_with_secret(&blob, &secret).map(Some)
}

impl WebDavClient {
    pub fn new(config: WebDavConfig) -> Self {
        let builder = Client::builder();
        let builder =
            if webdav_endpoint_uses_direct_connection(&config.endpoint) { builder.no_proxy() } else { builder };
        let http = builder.build().expect("failed to build WebDAV HTTP client");
        Self { http, config }
    }

    pub fn remote_path(&self) -> String {
        normalized_remote_path(self.config.remote_path.as_deref())
    }

    pub async fn test(&self) -> Result<(), String> {
        let method = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
        let response = self.request(method, "")?.header("Depth", "0").send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        if status.is_success() {
            Ok(())
        } else {
            Err(format!("WebDAV test failed with HTTP {status}"))
        }
    }

    pub async fn put_snapshot(&self, snapshot: &SyncSnapshot) -> Result<WebDavSyncSummary, String> {
        let remote_path = self.remote_path();
        self.ensure_parent_collections(&remote_path).await?;
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
        let response = self
            .request(Method::PUT, &remote_path)?
            .header(header::CONTENT_TYPE, "application/json")
            .body(bytes.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("WebDAV upload failed with HTTP {status}"));
        }
        Ok(WebDavSyncSummary {
            remote_path,
            bytes: bytes.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        })
    }

    pub async fn get_snapshot(&self) -> Result<(SyncSnapshot, WebDavSyncSummary), String> {
        let remote_path = self.remote_path();
        let response = self.request(Method::GET, &remote_path)?.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("WebDAV download failed with HTTP {status}"));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        let snapshot: SyncSnapshot = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        let summary = WebDavSyncSummary {
            remote_path,
            bytes: bytes.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        };
        Ok((snapshot, summary))
    }

    async fn ensure_parent_collections(&self, remote_path: &str) -> Result<(), String> {
        let method = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;
        for parent in parent_collection_paths(remote_path) {
            let response = self.request(method.clone(), &parent)?.send().await.map_err(|e| e.to_string())?;
            let status = response.status();
            if status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED {
                continue;
            }
            return Err(format!("Failed to create WebDAV collection '{parent}' with HTTP {status}"));
        }
        Ok(())
    }

    fn request(&self, method: Method, remote_path: &str) -> Result<reqwest::RequestBuilder, String> {
        let url = self.remote_url(remote_path)?;
        let mut request = self.http.request(method, url);
        if let Some(username) = self.config.username.as_deref().filter(|value| !value.is_empty()) {
            request = request.basic_auth(username, self.config.password.clone());
        }
        Ok(request)
    }

    fn remote_url(&self, remote_path: &str) -> Result<Url, String> {
        let endpoint = self.config.endpoint.trim();
        if endpoint.is_empty() {
            return Err("WebDAV endpoint is required".to_string());
        }
        let base = if endpoint.ends_with('/') { endpoint.to_string() } else { format!("{endpoint}/") };
        let base = Url::parse(&base).map_err(|e| e.to_string())?;
        base.join(remote_path.trim_start_matches('/')).map_err(|e| e.to_string())
    }
}

impl SnippetSyncClient {
    pub fn new(config: SnippetSyncConfig) -> Self {
        let api_base = match config.provider {
            SnippetProvider::GitHub => GITHUB_API_BASE,
            SnippetProvider::Gitee => GITEE_API_BASE,
        };
        Self { http: Client::new(), config, api_base: api_base.to_string() }
    }

    #[cfg(test)]
    fn with_api_base(config: SnippetSyncConfig, api_base: String) -> Self {
        Self { http: Client::new(), config, api_base }
    }

    pub async fn test(&self) -> Result<(), String> {
        self.require_token()?;
        let url = match (self.config.provider, normalized_snippet_id(self.config.snippet_id.as_deref())) {
            (_, Some(id)) => format!("{}/gists/{id}", self.api_base),
            (_, None) => format!("{}/user", self.api_base),
        };
        let response = self.request(Method::GET, &url)?.send().await.map_err(|e| e.to_string())?;
        ensure_snippet_success(response.status(), "test")
    }

    pub async fn put_snapshot(
        &self,
        snapshot: &SyncSnapshot,
        snippet_passphrase: Option<&str>,
        secrets_passphrase: Option<&str>,
    ) -> Result<SnippetSyncSummary, String> {
        self.require_token()?;
        let passphrase = required_snippet_passphrase(snippet_passphrase)?;
        let existing_id = normalized_snippet_id(self.config.snippet_id.as_deref());
        let legacy_snapshot = if let Some(id) = existing_id {
            let existing_content = self.load_snippet_content(id).await?;
            if !is_encrypted_snippet_snapshot(&existing_content) {
                // Never delete an arbitrary snippet merely because it is not an
                // encrypted DBX envelope. It must first prove to be a legacy DBX
                // snapshot, and the caller must explicitly request migration.
                if !is_legacy_dbx_snapshot(&existing_content) {
                    return Err("The selected snippet is not a DBX sync snapshot; refusing to replace or delete it."
                        .to_string());
                }
                if !self.config.replace_legacy_snippet {
                    return Err(
                        "This snippet contains a legacy unencrypted DBX snapshot. Use the secure migration action to create an encrypted replacement and delete the legacy snippet only after the new one is created."
                            .to_string(),
                    );
                }
                let legacy_snapshot = parse_legacy_dbx_snapshot(&existing_content)?;
                Some((
                    id,
                    prepare_legacy_snippet_snapshot(legacy_snapshot, secrets_passphrase)?,
                    content_hash(&existing_content),
                ))
            } else {
                if self.config.replace_legacy_snippet {
                    return Err("The selected snippet is already encrypted; use the normal upload action.".to_string());
                }
                // Refuse a PATCH unless the supplied snippet encryption
                // password decrypts the currently stored envelope. Otherwise
                // an accidental password change would silently lock out the
                // user's other devices.
                parse_snippet_snapshot(&existing_content, Some(passphrase))?;
                None
            }
        } else {
            None
        };
        // Migration encrypts the already-read remote snapshot rather than the
        // caller's current local state. Otherwise a stale second device could
        // erase the only copy of newer remote settings or saved SQL.
        let snapshot_to_upload =
            snapshot_for_snippet_upload(snapshot, legacy_snapshot.as_ref().map(|(_, snapshot, _)| snapshot));
        let encrypted = encrypt_snippet_snapshot(snapshot_to_upload, passphrase)?;
        let bytes = serde_json::to_vec_pretty(&encrypted).map_err(|e| e.to_string())?;
        let content = String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?;
        // A migration must create a separate snippet. Updating the legacy
        // snippet would retain its plaintext revision history on the provider.
        let update_id = if legacy_snapshot.is_some() { None } else { existing_id };
        let (method, url) = match (self.config.provider, update_id) {
            (_, Some(id)) => (Method::PATCH, format!("{}/gists/{id}", self.api_base)),
            (_, None) => (Method::POST, format!("{}/gists", self.api_base)),
        };

        let response = match self.config.provider {
            SnippetProvider::GitHub => {
                let payload = serde_json::json!({
                    "description": "DBX encrypted configuration sync",
                    "public": false,
                    "files": { DEFAULT_SNIPPET_FILE_NAME: { "content": content } }
                });
                self.request(method, &url)?.json(&payload).send().await
            }
            SnippetProvider::Gitee => {
                let payload = gitee_snippet_payload(content);
                // Gitee validates `files` as a nested object; form encoding turns it into a string and is rejected.
                self.request(method, &url)?.json(&payload).send().await
            }
        }
        .map_err(|e| e.to_string())?;
        let status = response.status();
        let response_body = response.text().await.map_err(|e| e.to_string())?;
        ensure_snippet_response_success(status, "upload", &response_body)?;
        let value: serde_json::Value = serde_json::from_str(&response_body).map_err(|e| e.to_string())?;
        let snippet_id = snippet_response_id(&value)
            .or_else(|| update_id.map(str::to_string))
            .ok_or_else(|| "Snippet API response did not include an id".to_string())?;
        // The command layer persists the replacement id before calling
        // `delete_legacy_snippet`. If the app stops before persistence, the
        // old plaintext snippet remains available instead of leaving users
        // without a pointer to either remote snippet.
        let exported_at = Some(snapshot_to_upload.exported_at.clone());
        let app_version = Some(snapshot_to_upload.app_version.clone());
        let legacy_cleanup_required_id = legacy_snapshot.as_ref().map(|(id, _, _)| (*id).to_string());
        Ok(SnippetSyncSummary {
            provider: self.config.provider,
            snippet_id,
            bytes: bytes.len(),
            exported_at,
            app_version,
            legacy_cleanup_required_id,
            legacy_cleanup_expected_content_hash: legacy_snapshot.map(|(_, _, hash)| hash),
        })
    }

    pub async fn get_snapshot(
        &self,
        secrets_passphrase: Option<&str>,
    ) -> Result<(SyncSnapshot, SnippetSyncSummary), String> {
        self.require_token()?;
        let snippet_id = normalized_snippet_id(self.config.snippet_id.as_deref())
            .ok_or_else(|| "Snippet id is required for download".to_string())?;
        let content = self.load_snippet_content(snippet_id).await?;
        let snapshot = parse_snippet_snapshot(&content, secrets_passphrase)?;
        let summary = SnippetSyncSummary {
            provider: self.config.provider,
            snippet_id: snippet_id.to_string(),
            bytes: content.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
            legacy_cleanup_required_id: None,
            legacy_cleanup_expected_content_hash: None,
        };
        Ok((snapshot, summary))
    }

    async fn load_snippet_content(&self, snippet_id: &str) -> Result<String, String> {
        let url = format!("{}/gists/{snippet_id}", self.api_base);
        let response = self.request(Method::GET, &url)?.send().await.map_err(|e| e.to_string())?;
        let status = response.status();
        let response_body = response.text().await.map_err(|e| e.to_string())?;
        ensure_snippet_response_success(status, "download", &response_body)?;
        let value: serde_json::Value = serde_json::from_str(&response_body).map_err(|e| e.to_string())?;
        let (content, raw_url) = snippet_file_content(&value, DEFAULT_SNIPPET_FILE_NAME)?;
        let content = match content {
            Some(content) => content,
            None => {
                let raw_url = raw_url.ok_or_else(|| "Snippet file content is unavailable".to_string())?;
                let response = self.request(Method::GET, &raw_url)?.send().await.map_err(|e| e.to_string())?;
                ensure_snippet_success(response.status(), "raw download")?;
                response.text().await.map_err(|e| e.to_string())?
            }
        };
        Ok(content)
    }

    pub async fn delete_legacy_snippet_if_unchanged(
        &self,
        pending_cleanup: &SnippetPendingCleanup,
    ) -> Result<bool, String> {
        // Neither provider documents a conditional DELETE for snippets. Read
        // again after creating the replacement and refuse cleanup when another
        // device has changed the legacy content in the meantime.
        if content_hash(&self.load_snippet_content(&pending_cleanup.snippet_id).await?)
            != pending_cleanup.expected_content_hash
        {
            return Ok(false);
        }
        let url = format!("{}/gists/{}", self.api_base, pending_cleanup.snippet_id);
        let response = self.request(Method::DELETE, &url)?.send().await.map_err(|e| e.to_string())?;
        // If the provider reports that the old snippet is already absent, the
        // cleanup goal is satisfied and the newly created encrypted snippet is
        // still safe to use.
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(true);
        }
        ensure_snippet_success(response.status(), "delete legacy snippet")?;
        Ok(true)
    }

    fn require_token(&self) -> Result<&str, String> {
        self.config
            .token
            .as_deref()
            .map(str::trim)
            .filter(|token| !token.is_empty())
            .ok_or_else(|| "Access token is required".to_string())
    }

    fn request(&self, method: Method, url: &str) -> Result<reqwest::RequestBuilder, String> {
        let token = self.require_token()?;
        let request = self.http.request(method, url);
        Ok(match self.config.provider {
            SnippetProvider::GitHub => request
                .header(header::ACCEPT, "application/vnd.github+json")
                .header(header::USER_AGENT, "DBX")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .bearer_auth(token),
            // Gitee API v5 documents access_token as a request parameter rather than an Authorization header.
            SnippetProvider::Gitee => request.query(&[("access_token", token)]),
        })
    }
}

fn extract_mqtt_subscriptions(connections: &[ConnectionConfig]) -> Result<Vec<MqttSubscriptionSyncEntry>, String> {
    connections
        .iter()
        .filter(|config| config.db_type == DatabaseType::Mqtt)
        .map(|config| {
            let subscriptions = config
                .external_config
                .as_ref()
                .and_then(|external| external.get("savedTopics"))
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
            let subscriptions: Vec<MqttSubscriptionSyncTopic> = serde_json::from_value(subscriptions)
                .map_err(|error| format!("Invalid MQTT subscriptions for connection {}: {error}", config.id))?;
            validate_mqtt_subscriptions(config, &subscriptions)?;
            Ok(MqttSubscriptionSyncEntry { connection_id: config.id.clone(), subscriptions })
        })
        .collect()
}

fn apply_mqtt_subscriptions(
    connections: &mut [ConnectionConfig],
    entries: &[MqttSubscriptionSyncEntry],
) -> Result<(), String> {
    let mut seen_connections = HashSet::new();
    for entry in entries {
        if !seen_connections.insert(entry.connection_id.clone()) {
            return Err(format!("重复的 MQTT 同步连接 ID: {}", entry.connection_id));
        }
        let config = connections
            .iter_mut()
            .find(|config| config.id == entry.connection_id)
            .ok_or_else(|| format!("MQTT 同步配置引用了不存在的连接: {}", entry.connection_id))?;
        if config.db_type != DatabaseType::Mqtt {
            return Err(format!("同步连接 {} 不是 MQTT 连接", entry.connection_id));
        }
        validate_mqtt_subscriptions(config, &entry.subscriptions)?;
        let mut external = config.external_config.take().unwrap_or_else(|| serde_json::json!({}));
        let object = external
            .as_object_mut()
            .ok_or_else(|| format!("MQTT 连接 {} 的 externalConfig 必须是 JSON 对象", entry.connection_id))?;
        object
            .insert("savedTopics".to_string(), serde_json::to_value(&entry.subscriptions).map_err(|e| e.to_string())?);
        config.external_config = Some(external);
    }
    Ok(())
}

async fn preserve_local_mqtt_subscriptions_for_legacy_snapshot(
    storage: &Storage,
    connections: &mut [ConnectionConfig],
) -> Result<(), String> {
    let local_connections = storage.load_connections().await?;
    for config in connections.iter_mut().filter(|config| config.db_type == DatabaseType::Mqtt) {
        let Some(local_config) = local_connections.iter().find(|local| local.id == config.id) else {
            continue;
        };
        let Some(local_saved_topics) =
            local_config.external_config.as_ref().and_then(|external| external.get("savedTopics")).cloned()
        else {
            continue;
        };
        let mut external = config.external_config.take().unwrap_or_else(|| serde_json::json!({}));
        if let Some(object) = external.as_object_mut() {
            object.insert("savedTopics".to_string(), local_saved_topics);
            config.external_config = Some(external);
        } else {
            config.external_config = Some(serde_json::json!({ "savedTopics": local_saved_topics }));
        }
    }
    Ok(())
}

fn validate_mqtt_subscriptions(
    config: &ConnectionConfig,
    subscriptions: &[MqttSubscriptionSyncTopic],
) -> Result<(), String> {
    let protocol = config
        .external_config
        .as_ref()
        .and_then(|external| external.get("protocolVersion"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("v5");
    let mut topics = HashSet::new();
    for subscription in subscriptions {
        if !valid_mqtt_filter(&subscription.topic) {
            return Err(format!("MQTT 连接 {} 包含无效 Topic Filter: {}", config.id, subscription.topic));
        }
        if !topics.insert(subscription.topic.clone()) {
            return Err(format!("MQTT 连接 {} 包含重复 Topic Filter: {}", config.id, subscription.topic));
        }
        if !matches!(subscription.qos.as_str(), "atmostonce" | "atleastonce" | "exactlyonce") {
            return Err(format!("MQTT 连接 {} 包含无效 QoS: {}", config.id, subscription.qos));
        }
        if subscription.no_local && protocol != "v5" {
            return Err(format!("MQTT 连接 {} 使用了 MQTT 3.x 不支持的 No Local", config.id));
        }
    }
    Ok(())
}

fn valid_mqtt_filter(topic: &str) -> bool {
    if topic.is_empty() || topic.chars().any(char::is_whitespace) {
        return false;
    }
    let segments: Vec<&str> = topic.split('/').collect();
    segments.iter().enumerate().all(|(index, segment)| {
        if *segment == "#" {
            return index == segments.len() - 1;
        }
        !segment.contains('#') && (!segment.contains('+') || *segment == "+")
    })
}

fn scrub_connection_secrets(config: &mut ConnectionConfig) {
    config.password.clear();
    for layer in &mut config.transport_layers {
        match layer {
            TransportLayerConfig::Ssh(ssh) => {
                ssh.password.clear();
                ssh.key_passphrase.clear();
            }
            TransportLayerConfig::Proxy(proxy) => {
                proxy.password.clear();
            }
            TransportLayerConfig::HttpTunnel(http) => {
                http.token.clear();
            }
        }
    }
    config.redis_sentinel_password.clear();
    config.connection_string = None;
    config.init_script = None;
    scrub_mqtt_auth_secrets(config);
    scrub_mq_external_config_secrets(config);
    scrub_nacos_auth_secrets(config);
}

fn scrub_mqtt_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Mqtt {
        return;
    }
    let Some(auth) = config.external_config.as_mut().and_then(|external| external.get_mut("auth")) else {
        return;
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("password") {
        if let Some(object) = auth.as_object_mut() {
            object.insert("password".to_string(), serde_json::Value::String(String::new()));
        }
    }
}

fn webdav_password_account(config: &WebDavConfig) -> String {
    let mut hasher = Sha256::new();
    hasher.update(config.endpoint.trim().as_bytes());
    hasher.update(b"\n");
    hasher.update(config.username.as_deref().unwrap_or("").trim().as_bytes());
    URL_SAFE_NO_PAD.encode(hasher.finalize())
}

async fn build_sensitive_payload(
    storage: &Storage,
    connections: &[ConnectionConfig],
    tunnel_profiles: &[TransportLayerConfig],
) -> Result<SensitiveSyncPayload, String> {
    let mut connection_secrets = Vec::new();
    for config in connections {
        push_secret(&mut connection_secrets, &config.id, "password", &config.password);
        push_secret(&mut connection_secrets, &config.id, "init_script", config.init_script.as_deref().unwrap_or(""));
        for (index, layer) in config.transport_layers.iter().enumerate() {
            match layer {
                TransportLayerConfig::Ssh(ssh) => {
                    push_secret(
                        &mut connection_secrets,
                        &config.id,
                        &transport_layer_ssh_password_key(index, layer),
                        &ssh.password,
                    );
                    push_secret(
                        &mut connection_secrets,
                        &config.id,
                        &transport_layer_ssh_key_passphrase_key(index, layer),
                        &ssh.key_passphrase,
                    );
                }
                TransportLayerConfig::Proxy(proxy) => {
                    push_secret(
                        &mut connection_secrets,
                        &config.id,
                        &transport_layer_proxy_password_key(index, layer),
                        &proxy.password,
                    );
                }
                TransportLayerConfig::HttpTunnel(http) => {
                    push_secret(
                        &mut connection_secrets,
                        &config.id,
                        &transport_layer_http_tunnel_token_key(index, layer),
                        &http.token,
                    );
                }
            }
        }
        push_secret(&mut connection_secrets, &config.id, "redis_sentinel_password", &config.redis_sentinel_password);
        if let Some(connection_string) = &config.connection_string {
            push_secret(&mut connection_secrets, &config.id, "connection_string", connection_string);
        }
        push_mq_external_config_secrets(&mut connection_secrets, config);
        push_nacos_external_config_secrets(&mut connection_secrets, config);
    }

    Ok(SensitiveSyncPayload {
        connection_secrets,
        ai_configs: Some(storage.load_ai_configs().await.unwrap_or_default()),
        ai_config: None,
        tunnel_profiles: Some(tunnel_profiles.to_vec()),
    })
}

fn push_mq_external_config_secrets(secrets: &mut Vec<ConnectionSecretSnapshot>, config: &ConnectionConfig) {
    let Some(external_config) = config.external_config.as_ref() else {
        return;
    };
    if let Some(auth) = external_config.get("auth").and_then(serde_json::Value::as_object) {
        match auth.get("kind").and_then(serde_json::Value::as_str) {
            Some("token") => push_json_secret(secrets, &config.id, MQ_AUTH_TOKEN_KEY, auth, "token"),
            Some("basic") => push_json_secret(secrets, &config.id, MQ_AUTH_PASSWORD_KEY, auth, "password"),
            Some("apiKey") | Some("api_key") | Some("apikey") => {
                push_json_secret(secrets, &config.id, MQ_AUTH_API_KEY_VALUE_KEY, auth, "value")
            }
            Some("oauth2") => push_json_secret(secrets, &config.id, MQ_AUTH_CLIENT_SECRET_KEY, auth, "clientSecret"),
            _ => {}
        }
    }
    if let Some(signing) = external_config.get("tokenSigning").and_then(serde_json::Value::as_object) {
        push_json_secret(secrets, &config.id, MQ_TOKEN_SIGNING_KEY, signing, "key");
    }
}

fn scrub_mq_external_config_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::MessageQueue {
        return;
    }
    let Some(external_config) = config.external_config.as_mut() else {
        return;
    };
    if let Some(auth) = external_config.get_mut("auth").and_then(serde_json::Value::as_object_mut) {
        match auth.get("kind").and_then(serde_json::Value::as_str) {
            Some("token") => scrub_json_secret(auth, "token"),
            Some("basic") => scrub_json_secret(auth, "password"),
            Some("apiKey") | Some("api_key") | Some("apikey") => scrub_json_secret(auth, "value"),
            Some("oauth2") => scrub_json_secret(auth, "clientSecret"),
            _ => {}
        }
    }
    if let Some(signing) = external_config.get_mut("tokenSigning").and_then(serde_json::Value::as_object_mut) {
        scrub_json_secret(signing, "key");
    }
}

fn push_nacos_external_config_secrets(secrets: &mut Vec<ConnectionSecretSnapshot>, config: &ConnectionConfig) {
    if config.db_type != DatabaseType::Nacos {
        return;
    }
    if let Some(auth) = config
        .external_config
        .as_ref()
        .and_then(|external_config| external_config.get("auth"))
        .and_then(serde_json::Value::as_object)
    {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            push_json_secret(secrets, &config.id, NACOS_AUTH_PASSWORD_KEY, auth, "password");
        }
    }
    if let Some(auth) = config
        .external_config
        .as_ref()
        .and_then(|external_config| external_config.get("rnacosConsoleAuth"))
        .and_then(serde_json::Value::as_object)
    {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            push_json_secret(secrets, &config.id, NACOS_RNACOS_CONSOLE_PASSWORD_KEY, auth, "password");
        }
    }
}

fn push_json_secret(
    secrets: &mut Vec<ConnectionSecretSnapshot>,
    connection_id: &str,
    key: &str,
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
) {
    if let Some(secret) = object.get(field).and_then(serde_json::Value::as_str) {
        push_secret(secrets, connection_id, key, secret);
    }
}

fn push_secret(secrets: &mut Vec<ConnectionSecretSnapshot>, connection_id: &str, key: &str, secret: &str) {
    if secret.is_empty() {
        return;
    }
    secrets.push(ConnectionSecretSnapshot {
        connection_id: connection_id.to_string(),
        key: key.to_string(),
        secret: secret.to_string(),
    });
}

fn scrub_nacos_auth_secrets(config: &mut ConnectionConfig) {
    if config.db_type != DatabaseType::Nacos {
        return;
    }
    if let Some(auth) = config
        .external_config
        .as_mut()
        .and_then(|external_config| external_config.get_mut("auth"))
        .and_then(serde_json::Value::as_object_mut)
    {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            scrub_json_secret(auth, "password");
        }
    }
    if let Some(auth) = config
        .external_config
        .as_mut()
        .and_then(|external_config| external_config.get_mut("rnacosConsoleAuth"))
        .and_then(serde_json::Value::as_object_mut)
    {
        if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
            scrub_json_secret(auth, "password");
        }
    }
}

fn scrub_json_secret(object: &mut serde_json::Map<String, serde_json::Value>, field: &str) {
    if object.contains_key(field) {
        object.insert(field.to_string(), serde_json::Value::String(String::new()));
    }
}

async fn apply_sensitive_payload(storage: &Storage, payload: &SensitiveSyncPayload) -> Result<(), String> {
    for secret in &payload.connection_secrets {
        if !SECRET_KEYS.contains(&secret.key.as_str())
            && !secret.key.starts_with(SSH_TUNNEL_SECRET_PREFIX)
            && !secret.key.starts_with(TRANSPORT_LAYER_SECRET_PREFIX)
        {
            continue;
        }
        storage.set_secret(&secret.connection_id, &secret.key, &secret.secret).await?;
    }
    if let Some(configs) = &payload.ai_configs {
        // New format: save directly (empty = all configs were deleted)
        storage.save_ai_configs(configs).await?;
    } else if let Some(old_config) = &payload.ai_config {
        // A legacy snapshot still represents the complete AI configuration state.
        // Replace local configs just like the new list format so a generated ID
        // cannot conflict with an existing config that has the same name.
        let provider_name = old_config.provider.as_str().to_string();
        let item = AiConfigItem {
            id: AiConfigItem::new_id(),
            name: provider_name,
            is_default: true,
            config: old_config.clone(),
        };
        storage.save_ai_configs(&[item]).await?;
    }
    if let Some(profiles) = &payload.tunnel_profiles {
        storage.save_tunnel_profiles(profiles).await?;
    }
    Ok(())
}

async fn clear_connection_secrets(storage: &Storage, connections: &[ConnectionConfig]) -> Result<(), String> {
    for config in connections {
        for key in SECRET_KEYS {
            storage.delete_secret(&config.id, key).await?;
        }
        for (index, layer) in config.transport_layers.iter().enumerate() {
            match layer {
                TransportLayerConfig::Ssh(_) => {
                    storage.delete_secret(&config.id, &transport_layer_ssh_password_key(index, layer)).await?;
                    storage.delete_secret(&config.id, &transport_layer_ssh_key_passphrase_key(index, layer)).await?;
                }
                TransportLayerConfig::Proxy(_) => {
                    storage.delete_secret(&config.id, &transport_layer_proxy_password_key(index, layer)).await?;
                }
                TransportLayerConfig::HttpTunnel(_) => {
                    storage.delete_secret(&config.id, &transport_layer_http_tunnel_token_key(index, layer)).await?;
                }
            }
        }
    }
    Ok(())
}

fn transport_layer_secret_segment(index: usize, layer: &TransportLayerConfig) -> String {
    let id = layer.id().trim();
    if id.is_empty() {
        index.to_string()
    } else {
        id.to_string()
    }
}

fn transport_layer_ssh_password_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.ssh_password", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_ssh_key_passphrase_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.ssh_key_passphrase", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_proxy_password_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.proxy_password", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn transport_layer_http_tunnel_token_key(index: usize, layer: &TransportLayerConfig) -> String {
    format!("{}{}.http_tunnel_token", TRANSPORT_LAYER_SECRET_PREFIX, transport_layer_secret_segment(index, layer))
}

fn encrypt_sensitive_payload(payload: &SensitiveSyncPayload, passphrase: &str) -> Result<EncryptedSecretsBlob, String> {
    let plaintext = serde_json::to_vec(payload).map_err(|e| e.to_string())?;
    encrypt_bytes_with_secret(&plaintext, passphrase)
}

fn decrypt_sensitive_payload(blob: &EncryptedSecretsBlob, passphrase: &str) -> Result<SensitiveSyncPayload, String> {
    let plaintext = decrypt_bytes_with_secret(blob, passphrase)
        .map_err(|_| "Failed to decrypt synced secrets. Check the sync password.".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|e| e.to_string())
}

fn encrypt_snippet_snapshot(snapshot: &SyncSnapshot, passphrase: &str) -> Result<EncryptedSnippetSnapshot, String> {
    let plaintext = serde_json::to_vec(snapshot).map_err(|e| e.to_string())?;
    Ok(EncryptedSnippetSnapshot {
        format: ENCRYPTED_SNIPPET_SNAPSHOT_FORMAT.to_string(),
        version: ENCRYPTED_SNIPPET_SNAPSHOT_VERSION,
        payload: encrypt_bytes_with_secret(&plaintext, passphrase)?,
    })
}

fn parse_snippet_snapshot(content: &str, secrets_passphrase: Option<&str>) -> Result<SyncSnapshot, String> {
    if is_encrypted_snippet_snapshot(content) {
        let envelope: EncryptedSnippetSnapshot = serde_json::from_str(content).map_err(|e| e.to_string())?;
        if envelope.format != ENCRYPTED_SNIPPET_SNAPSHOT_FORMAT
            || envelope.version != ENCRYPTED_SNIPPET_SNAPSHOT_VERSION
        {
            return Err("Unsupported encrypted sync snapshot format".to_string());
        }
        let passphrase = required_snippet_passphrase(secrets_passphrase)?;
        let plaintext = decrypt_bytes_with_secret(&envelope.payload, passphrase)
            .map_err(|_| "Failed to decrypt the synced snapshot. Check the snippet encryption password.".to_string())?;
        return serde_json::from_slice(&plaintext).map_err(|e| e.to_string());
    }
    serde_json::from_str(content).map_err(|e| e.to_string())
}

fn is_encrypted_snippet_snapshot(content: &str) -> bool {
    serde_json::from_str::<EncryptedSnippetSnapshot>(content)
        .ok()
        .is_some_and(|envelope| envelope.format == ENCRYPTED_SNIPPET_SNAPSHOT_FORMAT)
}

/// Keep the migration guard deliberately more tolerant than deserializing the
/// current `SyncSnapshot`: older DBX releases may not contain fields added
/// since their snapshot was written. At the same time, require the stable DBX
/// snapshot markers before a destructive remote delete is allowed.
fn is_legacy_dbx_snapshot(content: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(content).ok().is_some_and(|snapshot| {
        snapshot.get("schemaVersion").and_then(serde_json::Value::as_u64).is_some()
            && snapshot.get("exportedAt").and_then(serde_json::Value::as_str).is_some()
            && snapshot.get("appVersion").and_then(serde_json::Value::as_str).is_some()
            && snapshot.get("connections").is_some_and(serde_json::Value::is_array)
            && snapshot.get("savedSql").is_some_and(serde_json::Value::is_object)
            && snapshot.get("desktopSettings").is_some_and(serde_json::Value::is_object)
    })
}

fn parse_legacy_dbx_snapshot(content: &str) -> Result<SyncSnapshot, String> {
    if !is_legacy_dbx_snapshot(content) {
        return Err("The selected snippet is not a DBX sync snapshot; refusing to replace or delete it.".to_string());
    }
    serde_json::from_str(content).map_err(|_| {
        "The legacy DBX snapshot is incompatible with this version, so it will not be replaced or deleted.".to_string()
    })
}

fn prepare_legacy_snippet_snapshot(
    mut snapshot: SyncSnapshot,
    secrets_passphrase: Option<&str>,
) -> Result<SyncSnapshot, String> {
    if let Some(encrypted_secrets) = snapshot.encrypted_secrets.as_ref() {
        // The legacy snapshot can contain an independently encrypted secrets
        // payload. Verify it with its own password before deleting the only
        // legacy copy; the outer snippet password is intentionally separate.
        let passphrase = required_sync_passphrase(secrets_passphrase)?;
        let secrets = decrypt_sensitive_payload(encrypted_secrets, passphrase).map_err(|_| {
            "The legacy snapshot contains encrypted secrets that cannot be verified with this sync password, so it will not be replaced or deleted."
                .to_string()
        })?;
        snapshot.encrypted_secrets = Some(encrypt_sensitive_payload(&secrets, passphrase)?);
    }
    Ok(snapshot)
}

fn snapshot_for_snippet_upload<'a>(
    local_snapshot: &'a SyncSnapshot,
    legacy_snapshot: Option<&'a SyncSnapshot>,
) -> &'a SyncSnapshot {
    legacy_snapshot.unwrap_or(local_snapshot)
}

fn encrypt_text_with_secret(value: &str, secret: &str) -> Result<EncryptedSecretsBlob, String> {
    encrypt_bytes_with_secret(value.as_bytes(), secret)
}

fn decrypt_text_with_secret(blob: &EncryptedSecretsBlob, secret: &str) -> Result<String, String> {
    let plaintext = decrypt_bytes_with_secret(blob, secret)?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

fn encrypt_bytes_with_secret(plaintext: &[u8], secret: &str) -> Result<EncryptedSecretsBlob, String> {
    let mut salt = [0u8; 16];
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let key = derive_secret_key(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).map_err(|e| e.to_string())?;
    Ok(EncryptedSecretsBlob {
        version: 1,
        kdf: "argon2id".to_string(),
        cipher: "aes-256-gcm".to_string(),
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn decrypt_bytes_with_secret(blob: &EncryptedSecretsBlob, secret: &str) -> Result<Vec<u8>, String> {
    if blob.version != 1 || blob.kdf != "argon2id" || blob.cipher != "aes-256-gcm" {
        return Err("Unsupported encrypted secrets format".to_string());
    }
    let salt = BASE64.decode(&blob.salt).map_err(|e| e.to_string())?;
    let nonce = BASE64.decode(&blob.nonce).map_err(|e| e.to_string())?;
    let ciphertext = BASE64.decode(&blob.ciphertext).map_err(|e| e.to_string())?;
    if nonce.len() != 12 {
        return Err("Invalid encrypted secrets nonce".to_string());
    }
    let key = derive_secret_key(secret, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "Failed to decrypt saved secret.".to_string())
}

fn derive_secret_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(19 * 1024, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2.hash_password_into(passphrase.as_bytes(), salt, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}

fn normalized_passphrase(passphrase: Option<&str>) -> Option<&str> {
    passphrase.map(str::trim).filter(|value| !value.is_empty())
}

fn normalized_snippet_id(snippet_id: Option<&str>) -> Option<&str> {
    snippet_id.map(str::trim).filter(|value| !value.is_empty())
}

fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn snippet_pending_cleanup(summary: &SnippetSyncSummary) -> Result<Option<SnippetPendingCleanup>, String> {
    match (summary.legacy_cleanup_required_id.as_deref(), summary.legacy_cleanup_expected_content_hash.as_deref()) {
        (None, None) => Ok(None),
        (Some(snippet_id), Some(expected_content_hash)) => Ok(Some(SnippetPendingCleanup {
            snippet_id: snippet_id.to_string(),
            expected_content_hash: expected_content_hash.to_string(),
        })),
        _ => Err("Legacy snippet cleanup is missing its persisted verification state.".to_string()),
    }
}

fn required_snippet_passphrase(passphrase: Option<&str>) -> Result<&str, String> {
    normalized_passphrase(passphrase)
        .ok_or_else(|| "A snippet encryption password is required for GitHub and Gitee sync.".to_string())
}

fn required_sync_passphrase(passphrase: Option<&str>) -> Result<&str, String> {
    normalized_passphrase(passphrase)
        .ok_or_else(|| "A sync password is required for GitHub and Gitee snippet sync.".to_string())
}

fn snippet_provider_storage_key(provider: SnippetProvider) -> &'static str {
    match provider {
        SnippetProvider::GitHub => "github",
        SnippetProvider::Gitee => "gitee",
    }
}

fn snippet_token_account(provider: SnippetProvider) -> String {
    match provider {
        SnippetProvider::GitHub => "snippet-token:github".to_string(),
        SnippetProvider::Gitee => "snippet-token:gitee".to_string(),
    }
}

fn ensure_snippet_success(status: StatusCode, operation: &str) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("Snippet {operation} failed with HTTP {status}"))
    }
}

fn ensure_snippet_response_success(status: StatusCode, operation: &str, response_body: &str) -> Result<(), String> {
    if status.is_success() {
        return Ok(());
    }
    let message = serde_json::from_str::<serde_json::Value>(response_body)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error_description"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| response_body.trim().chars().take(300).collect());
    if message.is_empty() {
        Err(format!("Snippet {operation} failed with HTTP {status}"))
    } else {
        Err(format!("Snippet {operation} failed with HTTP {status}: {message}"))
    }
}

fn snippet_response_id(value: &serde_json::Value) -> Option<String> {
    if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
        return Some(id.to_string());
    }
    // Some Gitee endpoints historically document an array response despite returning one created snippet.
    value.as_array()?.first()?.get("id")?.as_str().map(str::to_string)
}

fn gitee_snippet_payload(content: String) -> serde_json::Value {
    serde_json::json!({
        "description": "DBX configuration sync",
        "public": false,
        "files": { DEFAULT_SNIPPET_FILE_NAME: { "content": content } }
    })
}

fn snippet_file_content(
    value: &serde_json::Value,
    file_name: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let files = value.get("files").ok_or_else(|| "Snippet response did not include files".to_string())?;
    let files = if let Some(value) = files.as_str() {
        serde_json::from_str::<serde_json::Value>(value).map_err(|e| e.to_string())?
    } else {
        files.clone()
    };
    let file = files
        .get(file_name)
        .or_else(|| files.as_object().and_then(|files| files.values().next()))
        .ok_or_else(|| format!("Snippet does not contain {file_name}"))?;
    let truncated = file.get("truncated").and_then(serde_json::Value::as_bool).unwrap_or(false);
    let content =
        if truncated { None } else { file.get("content").and_then(serde_json::Value::as_str).map(str::to_string) };
    let raw_url = file.get("raw_url").and_then(serde_json::Value::as_str).map(str::to_string);
    Ok((content, raw_url))
}

fn normalized_remote_path(value: Option<&str>) -> String {
    let value = value.unwrap_or(DEFAULT_REMOTE_PATH).trim().replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            // Keep the WebDAV target inside the configured endpoint when users paste OS paths.
            parts.pop();
            continue;
        }
        parts.push(part);
    }

    if parts.is_empty() {
        DEFAULT_REMOTE_PATH.to_string()
    } else {
        parts.join("/")
    }
}

fn webdav_endpoint_uses_direct_connection(endpoint: &str) -> bool {
    let Ok(url) = Url::parse(endpoint.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.strip_prefix('[').and_then(|host| host.strip_suffix(']')).unwrap_or(host);
    if host.rsplit('.').next().is_some_and(|label| label.eq_ignore_ascii_case("localhost")) {
        return true;
    }
    host.parse::<IpAddr>().is_ok_and(webdav_ip_uses_direct_connection)
}

fn webdav_ip_uses_direct_connection(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => webdav_ipv4_uses_direct_connection(address),
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || address.to_ipv4_mapped().is_some_and(webdav_ipv4_uses_direct_connection)
        }
    }
}

fn webdav_ipv4_uses_direct_connection(address: Ipv4Addr) -> bool {
    let [first, second, _, _] = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_unspecified()
        || (first == 100 && (64..=127).contains(&second))
}

fn parent_collection_paths(remote_path: &str) -> Vec<String> {
    let parts = remote_path.trim_matches('/').split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
    if parts.len() <= 1 {
        return Vec::new();
    }

    let mut paths = Vec::with_capacity(parts.len() - 1);
    for index in 1..parts.len() {
        paths.push(parts[..index].join("/"));
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::{
        apply_sensitive_payload, apply_sync_snapshot, build_sync_snapshot, build_sync_snapshot_with_saved_secrets,
        decrypt_sensitive_payload, encrypt_sensitive_payload, encrypt_snippet_snapshot, finalize_snippet_migration,
        forget_webdav_sync_secrets_passphrase, gitee_snippet_payload, is_legacy_dbx_snapshot, normalized_remote_path,
        parent_collection_paths, parse_legacy_dbx_snapshot, parse_snippet_snapshot, prepare_legacy_snippet_snapshot,
        resolve_webdav_sync_secrets_passphrase, retry_pending_snippet_cleanup, save_snippet_sync_id,
        save_webdav_sync_secrets_preference, scrub_connection_secrets, snapshot_for_snippet_upload,
        snippet_file_content, snippet_response_id, snippet_sync_settings, webdav_endpoint_uses_direct_connection,
        webdav_sync_secrets_status, ApplySnapshotOptions, ConnectionSecretSnapshot, SensitiveSyncPayload,
        SnippetProvider, SnippetSyncClient, SnippetSyncConfig, DEFAULT_SNIPPET_FILE_NAME,
    };
    use crate::ai::{AiApiStyle, AiAuthMethod, AiConfig, AiConfigItem};
    use crate::connection_secrets::NACOS_AUTH_PASSWORD_KEY;
    use crate::models::connection::{
        default_redis_key_separator, ConnectionConfig, DatabaseType, SshTunnelConfig, TransportLayerConfig,
    };
    use crate::storage::Storage;

    fn make_test_config(name: &str, is_default: bool) -> AiConfigItem {
        AiConfigItem {
            id: format!("cfg-{name}"),
            name: name.to_string(),
            is_default,
            config: AiConfig {
                provider: crate::ai::AiProvider::Openai,
                api_key: String::new(),
                auth_method: AiAuthMethod::Bearer,
                endpoint: "https://api.openai.com/v1".to_string(),
                model: "gpt-4o-mini".to_string(),
                models: vec![],
                api_style: AiApiStyle::Completions,
                proxy_enabled: false,
                proxy_url: String::new(),
                enable_thinking: true,
                reasoning_level: crate::ai::AiReasoningLevel::Default,
                runtime_effort: None,
                context_window: None,
                max_retries: None,
                codex_cli_path: None,
                codex_cli_env: Default::default(),
                claude_code_cli_path: None,
                claude_code_cli_env: Default::default(),
                pi_agent_cli_path: None,
                pi_agent_cli_env: Default::default(),
                opencode_cli_path: None,
                opencode_cli_env: Default::default(),
                cursor_cli_path: None,
                cursor_cli_env: Default::default(),
                grok_cli_path: None,
                grok_cli_env: Default::default(),
                codebuddy_cli_path: None,
                codebuddy_cli_env: Default::default(),
                qoder_cli_path: None,
                qoder_cli_env: Default::default(),
            },
        }
    }

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dbx-cloud-sync-{name}-{}.db", uuid::Uuid::new_v4()))
    }

    async fn spawn_snippet_server(responses: Vec<String>) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut methods = Vec::new();
            for body in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0_u8; 4096];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = socket.read(&mut chunk).await.unwrap();
                    assert!(read > 0, "request ended before headers were complete");
                    request.extend_from_slice(&chunk[..read]);
                }
                let request = String::from_utf8(request).unwrap();
                methods.push(request.lines().next().unwrap().to_string());
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
            methods
        });
        (format!("http://{address}"), server)
    }

    fn github_snippet_response(content: &str) -> String {
        serde_json::json!({
            "files": { DEFAULT_SNIPPET_FILE_NAME: { "content": content } }
        })
        .to_string()
    }

    #[test]
    fn gitee_snippet_payload_keeps_files_as_nested_object() {
        let payload = gitee_snippet_payload("snapshot".to_string());

        assert_eq!(payload["files"]["dbx-sync.json"]["content"], "snapshot");
        assert!(payload["files"].is_object());
        assert_eq!(payload["public"], false);
    }

    fn postgres_connection(id: &str, password: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: "Postgres".to_string(),
            note: String::new(),
            db_type: DatabaseType::Postgres,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 5432,
            username: "app".to_string(),
            password: password.to_string(),
            database: Some("app_db".to_string()),
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn nacos_connection(id: &str, password: &str) -> ConnectionConfig {
        ConnectionConfig {
            docs_notes_path: None,
            id: id.to_string(),
            name: "Nacos".to_string(),
            note: String::new(),
            db_type: DatabaseType::Nacos,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "127.0.0.1".to_string(),
            port: 8848,
            username: "nacos".to_string(),
            password: String::new(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: None,
            color: None,
            transport_layers: Vec::new(),
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: None,
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: String::new(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: Some(serde_json::json!({
                "namespace": "public",
                "group": "DEFAULT_GROUP",
                "auth": {
                    "kind": "usernamePassword",
                    "username": "nacos",
                    "password": password
                }
            })),
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        }
    }

    fn nacos_auth_password(config: &ConnectionConfig) -> Option<&str> {
        config.external_config.as_ref()?.get("auth")?.get("password")?.as_str()
    }

    #[test]
    fn normalizes_empty_remote_path_to_default() {
        assert_eq!(normalized_remote_path(None), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("")), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("///\\\\//")), "DBX/sync/snapshot.json");
    }

    #[test]
    fn normalizes_remote_path_separators() {
        assert_eq!(normalized_remote_path(Some("/custom/snapshot.json")), "custom/snapshot.json");
        assert_eq!(normalized_remote_path(Some(r"\DBX\sync\snapshot.json")), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("///DBX//sync/./snapshot.json")), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("DBX/sync/../snapshot.json")), "DBX/snapshot.json");
    }

    #[test]
    fn bypasses_proxy_for_local_webdav_endpoints() {
        for endpoint in [
            "http://172.27.31.29:8088/dbx/",
            "https://10.0.0.8/webdav",
            "http://192.168.1.9/",
            "http://100.64.0.1/",
            "http://127.0.0.1:8080/",
            "http://169.254.1.2/",
            "http://localhost:8080/",
            "http://dbx.localhost/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:172.27.31.29]/",
        ] {
            assert!(webdav_endpoint_uses_direct_connection(endpoint), "expected direct WebDAV connection: {endpoint}");
        }
    }

    #[test]
    fn preserves_proxy_for_public_webdav_endpoints() {
        for endpoint in [
            "https://dav.example.com/remote.php/dav/files/user/",
            "http://8.8.8.8/webdav/",
            "http://[2606:4700:4700::1111]/webdav/",
            "not a URL",
        ] {
            assert!(
                !webdav_endpoint_uses_direct_connection(endpoint),
                "expected configured proxy behavior: {endpoint}"
            );
        }
    }

    #[test]
    fn returns_parent_collection_paths_from_leaf() {
        assert_eq!(parent_collection_paths("dbx/sync/snapshot.json"), vec!["dbx".to_string(), "dbx/sync".to_string()]);
        assert_eq!(
            parent_collection_paths(&normalized_remote_path(Some(r"\DBX\sync\snapshot.json"))),
            vec!["DBX".to_string(), "DBX/sync".to_string()]
        );
    }

    #[test]
    fn scrubs_connection_secret_fields() {
        let mut config = ConnectionConfig {
            docs_notes_path: None,
            id: "id".to_string(),
            name: "name".to_string(),
            note: String::new(),
            db_type: DatabaseType::Postgres,
            driver_profile: None,
            driver_label: None,
            url_params: None,
            agent_java_options: Vec::new(),
            host: "localhost".to_string(),
            port: 5432,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: None,
            default_schema: None,
            visible_databases: None,
            visible_schemas: None,
            show_system_schemas: false,
            attached_databases: Vec::new(),
            init_script: Some("CREATE SECRET (TYPE quack, TOKEN 'token-value');".to_string()),
            color: None,
            transport_layers: vec![
                TransportLayerConfig::Ssh(crate::models::connection::SshTunnelConfig {
                    profile_id: String::new(),
                    id: "hop-1".to_string(),
                    name: String::new(),
                    enabled: true,
                    host: "bastion".to_string(),
                    port: 22,
                    user: "user".to_string(),
                    password: "hop-password".to_string(),
                    key_path: String::new(),
                    key_passphrase: "hop-passphrase".to_string(),
                    connect_timeout_secs: 5,
                    expose_lan: false,
                    use_ssh_agent: false,
                    ssh_agent_sock_path: String::new(),
                    auth_method: "password".to_string(),
                    allow_exec_channel_proxy: false,
                }),
                TransportLayerConfig::HttpTunnel(crate::models::connection::HttpTunnelConfig {
                    profile_id: String::new(),
                    id: "http".to_string(),
                    name: String::new(),
                    enabled: true,
                    url: "https://dbx.example.com/dbx_tunnel.php".to_string(),
                    token: "tunnel-token".to_string(),
                    connect_timeout_secs: 10,
                }),
            ],
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
            keepalive_interval_secs: 0,
            ssl: false,
            ca_cert_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
            sysdba: false,
            oracle_connection_type: None,
            connection_string: Some("postgres://secret".to_string()),
            redis_connection_mode: None,
            redis_sentinel_master: String::new(),
            redis_sentinel_nodes: String::new(),
            redis_sentinel_username: String::new(),
            redis_sentinel_password: "sentinel".to_string(),
            redis_sentinel_tls: false,
            redis_cluster_nodes: String::new(),
            redis_key_separator: default_redis_key_separator(),
            redis_scan_page_size: None,
            redis_database_aliases: Default::default(),
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            informix_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
            is_production: false,
            production_databases: vec![],
            database_info: None,
        };
        scrub_connection_secrets(&mut config);
        assert!(config.password.is_empty());
        match &config.transport_layers[0] {
            TransportLayerConfig::Ssh(ssh) => {
                assert!(ssh.password.is_empty());
                assert!(ssh.key_passphrase.is_empty());
            }
            _ => panic!("expected ssh layer"),
        }
        match &config.transport_layers[1] {
            TransportLayerConfig::HttpTunnel(http) => assert!(http.token.is_empty()),
            _ => panic!("expected http tunnel layer"),
        }
        assert!(config.redis_sentinel_password.is_empty());
        assert!(config.connection_string.is_none());
        assert!(config.init_script.is_none());
        let public_json = serde_json::to_string(&config).unwrap();
        assert!(!public_json.contains("token-value"));
        assert!(super::SECRET_KEYS.contains(&"init_script"));
    }

    #[test]
    fn encrypted_sensitive_payload_round_trips() {
        let payload = SensitiveSyncPayload {
            tunnel_profiles: None,
            connection_secrets: vec![
                ConnectionSecretSnapshot {
                    connection_id: "c1".to_string(),
                    key: "password".to_string(),
                    secret: "secret".to_string(),
                },
                ConnectionSecretSnapshot {
                    connection_id: "c1".to_string(),
                    key: "transport_layers.hop-1.ssh_password".to_string(),
                    secret: "hop-secret".to_string(),
                },
            ],
            ai_configs: None,
            ai_config: None,
        };
        let encrypted = encrypt_sensitive_payload(&payload, "sync-pass").unwrap();
        assert_ne!(encrypted.ciphertext, "secret");
        let decrypted = decrypt_sensitive_payload(&encrypted, "sync-pass").unwrap();
        assert_eq!(decrypted.connection_secrets[0].secret, "secret");
        assert_eq!(decrypted.connection_secrets[1].secret, "hop-secret");
    }

    #[test]
    fn encrypted_sensitive_payload_rejects_wrong_passphrase() {
        let payload = SensitiveSyncPayload {
            tunnel_profiles: None,
            connection_secrets: vec![ConnectionSecretSnapshot {
                connection_id: "c1".to_string(),
                key: "password".to_string(),
                secret: "secret".to_string(),
            }],
            ai_configs: None,
            ai_config: None,
        };
        let encrypted = encrypt_sensitive_payload(&payload, "sync-pass").unwrap();
        assert!(decrypt_sensitive_payload(&encrypted, "wrong-pass").is_err());
    }

    #[tokio::test]
    async fn encrypted_snippet_snapshot_hides_and_restores_the_full_snapshot() {
        let storage = Storage::open(&temp_db_path("encrypted-snippet-snapshot")).await.unwrap();
        storage.save_connections(&[postgres_connection("pg", "db-secret")]).await.unwrap();
        let snapshot = build_sync_snapshot(&storage, "test-version", None, Some("sync-pass")).await.unwrap();

        let encrypted = encrypt_snippet_snapshot(&snapshot, "sync-pass").unwrap();
        let content = serde_json::to_string(&encrypted).unwrap();
        assert!(!content.contains("127.0.0.1"));
        assert!(!content.contains("app_db"));
        assert!(!content.contains("db-secret"));

        let restored = parse_snippet_snapshot(&content, Some("sync-pass")).unwrap();
        assert_eq!(restored.connections[0].database.as_deref(), Some("app_db"));
        assert!(parse_snippet_snapshot(&content, Some("wrong-pass")).is_err());
        assert!(parse_snippet_snapshot(&content, None).is_err());
    }

    #[tokio::test]
    async fn encrypted_snippet_can_exclude_secrets_and_keep_local_credentials_on_restore() {
        let source = Storage::open(&temp_db_path("snippet-without-secrets-source")).await.unwrap();
        source.save_connections(&[postgres_connection("pg", "remote-secret")]).await.unwrap();
        let snapshot = build_sync_snapshot(&source, "test-version", None, None).await.unwrap();
        assert!(snapshot.encrypted_secrets.is_none());

        let encrypted = encrypt_snippet_snapshot(&snapshot, "snippet-password").unwrap();
        let restored =
            parse_snippet_snapshot(&serde_json::to_string(&encrypted).unwrap(), Some("snippet-password")).unwrap();
        let target = Storage::open(&temp_db_path("snippet-without-secrets-target")).await.unwrap();
        target.save_connections(&[postgres_connection("pg", "local-secret")]).await.unwrap();

        let summary = apply_sync_snapshot(
            &target,
            &restored,
            ApplySnapshotOptions { secrets_passphrase: None, restore_secrets: false },
        )
        .await
        .unwrap();
        assert!(!summary.encrypted_secrets_present);
        assert!(!summary.secrets_applied);
        assert_eq!(target.load_connections().await.unwrap()[0].password, "local-secret");
    }

    #[tokio::test]
    async fn skipping_snippet_secret_restore_keeps_local_credentials() {
        let source = Storage::open(&temp_db_path("snippet-skip-secrets-source")).await.unwrap();
        source.save_connections(&[postgres_connection("pg", "remote-secret")]).await.unwrap();
        let snapshot = build_sync_snapshot(&source, "test-version", None, Some("secrets-password")).await.unwrap();
        assert!(snapshot.encrypted_secrets.is_some());

        let encrypted = encrypt_snippet_snapshot(&snapshot, "snippet-password").unwrap();
        let restored =
            parse_snippet_snapshot(&serde_json::to_string(&encrypted).unwrap(), Some("snippet-password")).unwrap();
        let target = Storage::open(&temp_db_path("snippet-skip-secrets-target")).await.unwrap();
        target.save_connections(&[postgres_connection("pg", "local-secret")]).await.unwrap();

        let summary = apply_sync_snapshot(
            &target,
            &restored,
            ApplySnapshotOptions { secrets_passphrase: None, restore_secrets: false },
        )
        .await
        .unwrap();
        assert!(summary.encrypted_secrets_present);
        assert!(!summary.secrets_applied);
        assert_eq!(target.load_connections().await.unwrap()[0].password, "local-secret");
    }

    #[tokio::test]
    async fn existing_encrypted_snippet_rejects_wrong_password_without_patch() {
        let storage = Storage::open(&temp_db_path("snippet-password-guard")).await.unwrap();
        let snapshot = build_sync_snapshot(&storage, "test-version", None, None).await.unwrap();
        let encrypted = encrypt_snippet_snapshot(&snapshot, "correct-password").unwrap();
        let (base, server) =
            spawn_snippet_server(vec![github_snippet_response(&serde_json::to_string(&encrypted).unwrap())]).await;
        let client = SnippetSyncClient::with_api_base(
            SnippetSyncConfig {
                provider: SnippetProvider::GitHub,
                token: Some("test-token".to_string()),
                snippet_id: Some("existing-id".to_string()),
                replace_legacy_snippet: false,
            },
            base,
        );

        assert!(client.put_snapshot(&snapshot, Some("wrong-password"), None).await.is_err());
        assert_eq!(server.await.unwrap(), vec!["GET /gists/existing-id HTTP/1.1"]);
    }

    #[tokio::test]
    async fn existing_encrypted_snippet_accepts_correct_password_before_patch() {
        let storage = Storage::open(&temp_db_path("snippet-password-update")).await.unwrap();
        let snapshot = build_sync_snapshot(&storage, "test-version", None, None).await.unwrap();
        let encrypted = encrypt_snippet_snapshot(&snapshot, "correct-password").unwrap();
        let (base, server) = spawn_snippet_server(vec![
            github_snippet_response(&serde_json::to_string(&encrypted).unwrap()),
            serde_json::json!({ "id": "existing-id" }).to_string(),
        ])
        .await;
        let client = SnippetSyncClient::with_api_base(
            SnippetSyncConfig {
                provider: SnippetProvider::GitHub,
                token: Some("test-token".to_string()),
                snippet_id: Some("existing-id".to_string()),
                replace_legacy_snippet: false,
            },
            base,
        );

        client.put_snapshot(&snapshot, Some("correct-password"), None).await.unwrap();
        assert_eq!(server.await.unwrap(), vec!["GET /gists/existing-id HTTP/1.1", "PATCH /gists/existing-id HTTP/1.1"]);
    }

    #[tokio::test]
    async fn legacy_migration_skips_delete_when_remote_content_changes() {
        let storage = Storage::open(&temp_db_path("legacy-snippet-change-guard")).await.unwrap();
        let snapshot = build_sync_snapshot(&storage, "test-version", None, None).await.unwrap();
        let legacy_content = serde_json::to_string(&snapshot).unwrap();
        let changed_content =
            serde_json::to_string(&build_sync_snapshot(&storage, "newer-version", None, None).await.unwrap()).unwrap();
        let (base, server) = spawn_snippet_server(vec![
            github_snippet_response(&legacy_content),
            serde_json::json!({ "id": "new-id" }).to_string(),
            github_snippet_response(&changed_content),
        ])
        .await;
        let client = SnippetSyncClient::with_api_base(
            SnippetSyncConfig {
                provider: SnippetProvider::GitHub,
                token: Some("test-token".to_string()),
                snippet_id: Some("legacy-id".to_string()),
                replace_legacy_snippet: true,
            },
            base,
        );

        let mut summary = client.put_snapshot(&snapshot, Some("snippet-password"), None).await.unwrap();
        assert_eq!(summary.snippet_id, "new-id");
        assert_eq!(summary.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        finalize_snippet_migration(&storage, &client, &mut summary).await.unwrap();
        assert_eq!(summary.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        let settings = snippet_sync_settings(&storage, SnippetProvider::GitHub).await.unwrap();
        assert_eq!(settings.snippet_id.as_deref(), Some("new-id"));
        assert_eq!(settings.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        assert_eq!(
            server.await.unwrap(),
            vec!["GET /gists/legacy-id HTTP/1.1", "POST /gists HTTP/1.1", "GET /gists/legacy-id HTTP/1.1",]
        );
    }

    #[tokio::test]
    async fn pending_legacy_cleanup_survives_response_loss_and_retries_after_restart() {
        let db = temp_db_path("legacy-snippet-cleanup-retry");
        let storage = Storage::open(&db).await.unwrap();
        let snapshot = build_sync_snapshot(&storage, "test-version", None, None).await.unwrap();
        let legacy_content = serde_json::to_string(&snapshot).unwrap();
        let (base, server) = spawn_snippet_server(vec![
            github_snippet_response(&legacy_content),
            serde_json::json!({ "id": "new-id" }).to_string(),
        ])
        .await;
        let client = SnippetSyncClient::with_api_base(
            SnippetSyncConfig {
                provider: SnippetProvider::GitHub,
                token: Some("test-token".to_string()),
                snippet_id: Some("legacy-id".to_string()),
                replace_legacy_snippet: true,
            },
            base,
        );
        let mut summary = client.put_snapshot(&snapshot, Some("snippet-password"), None).await.unwrap();

        finalize_snippet_migration(&storage, &client, &mut summary).await.unwrap();
        assert_eq!(summary.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));
        assert_eq!(server.await.unwrap(), vec!["GET /gists/legacy-id HTTP/1.1", "POST /gists HTTP/1.1"]);
        drop(storage);

        let storage = Storage::open(&db).await.unwrap();
        let settings = snippet_sync_settings(&storage, SnippetProvider::GitHub).await.unwrap();
        assert_eq!(settings.snippet_id.as_deref(), Some("new-id"));
        assert_eq!(settings.legacy_cleanup_required_id.as_deref(), Some("legacy-id"));

        let (retry_base, retry_server) =
            spawn_snippet_server(vec![github_snippet_response(&legacy_content), "{}".to_string()]).await;
        let retry_client = SnippetSyncClient::with_api_base(
            SnippetSyncConfig {
                provider: SnippetProvider::GitHub,
                token: Some("test-token".to_string()),
                snippet_id: Some("new-id".to_string()),
                replace_legacy_snippet: false,
            },
            retry_base,
        );
        let settings = retry_pending_snippet_cleanup(&storage, SnippetProvider::GitHub, &retry_client).await.unwrap();
        assert_eq!(settings.snippet_id.as_deref(), Some("new-id"));
        assert_eq!(settings.legacy_cleanup_required_id, None);
        assert_eq!(
            retry_server.await.unwrap(),
            vec!["GET /gists/legacy-id HTTP/1.1", "DELETE /gists/legacy-id HTTP/1.1"]
        );
    }

    #[tokio::test]
    async fn legacy_snippet_migration_preserves_remote_snapshot() {
        let storage = Storage::open(&temp_db_path("legacy-snippet-migration-guard")).await.unwrap();
        let local_snapshot = build_sync_snapshot(&storage, "local-version", None, None).await.unwrap();
        let remote_snapshot = build_sync_snapshot(&storage, "remote-version", None, None).await.unwrap();
        let mut legacy = serde_json::to_value(remote_snapshot).unwrap();
        // This field did not exist in snapshots written by older DBX versions.
        legacy.as_object_mut().unwrap().remove("tunnelProfiles");

        let content = serde_json::to_string(&legacy).unwrap();
        assert!(is_legacy_dbx_snapshot(&content));
        let parsed_legacy = parse_legacy_dbx_snapshot(&content).unwrap();
        let selected = snapshot_for_snippet_upload(&local_snapshot, Some(&parsed_legacy));
        assert_eq!(selected.app_version, "remote-version");

        let encrypted = encrypt_snippet_snapshot(selected, "sync-pass").unwrap();
        let restored = parse_snippet_snapshot(&serde_json::to_string(&encrypted).unwrap(), Some("sync-pass")).unwrap();
        assert_eq!(restored.app_version, "remote-version");
        assert!(!is_legacy_dbx_snapshot(r#"{"schemaVersion":1,"connections":[]}"#));
        assert!(parse_legacy_dbx_snapshot(r#"{"schemaVersion":1,"connections":[]}"#).is_err());
    }

    #[tokio::test]
    async fn legacy_snippet_migration_refuses_unverifiable_encrypted_secrets() {
        let storage = Storage::open(&temp_db_path("legacy-snippet-migration-secrets")).await.unwrap();
        storage.save_connections(&[postgres_connection("pg", "db-secret")]).await.unwrap();
        let remote_snapshot = build_sync_snapshot(&storage, "remote-version", None, Some("remote-pass")).await.unwrap();
        let content = serde_json::to_string(&remote_snapshot).unwrap();

        let legacy = parse_legacy_dbx_snapshot(&content).unwrap();
        assert!(prepare_legacy_snippet_snapshot(legacy.clone(), Some("wrong-pass")).is_err());
        let prepared = prepare_legacy_snippet_snapshot(legacy, Some("remote-pass")).unwrap();
        let secrets = decrypt_sensitive_payload(prepared.encrypted_secrets.as_ref().unwrap(), "remote-pass").unwrap();
        assert!(secrets.connection_secrets.iter().any(|secret| secret.secret == "db-secret"));
    }

    #[test]
    fn legacy_snippet_sync_requests_default_to_no_remote_deletion() {
        let config: SnippetSyncConfig = serde_json::from_value(serde_json::json!({
            "provider": "github",
            "token": "token",
            "snippetId": "legacy-id"
        }))
        .unwrap();

        assert!(!config.replace_legacy_snippet);
    }

    #[tokio::test]
    async fn snippet_sync_id_is_persisted_per_provider() {
        let storage = Storage::open(&temp_db_path("snippet-sync-id")).await.unwrap();

        save_snippet_sync_id(&storage, SnippetProvider::GitHub, Some("github-id")).await.unwrap();
        save_snippet_sync_id(&storage, SnippetProvider::Gitee, Some("gitee-id")).await.unwrap();
        assert_eq!(
            snippet_sync_settings(&storage, SnippetProvider::GitHub).await.unwrap().snippet_id.as_deref(),
            Some("github-id")
        );
        assert_eq!(
            snippet_sync_settings(&storage, SnippetProvider::GitHub).await.unwrap().legacy_cleanup_required_id,
            None
        );
        assert_eq!(
            snippet_sync_settings(&storage, SnippetProvider::Gitee).await.unwrap().snippet_id.as_deref(),
            Some("gitee-id")
        );

        save_snippet_sync_id(&storage, SnippetProvider::GitHub, None).await.unwrap();
        assert_eq!(snippet_sync_settings(&storage, SnippetProvider::GitHub).await.unwrap().snippet_id, None);
        assert_eq!(
            snippet_sync_settings(&storage, SnippetProvider::Gitee).await.unwrap().snippet_id.as_deref(),
            Some("gitee-id")
        );
    }

    #[test]
    fn snippet_response_id_supports_github_object_and_gitee_array() {
        assert_eq!(snippet_response_id(&serde_json::json!({ "id": "github-id" })).as_deref(), Some("github-id"));
        assert_eq!(snippet_response_id(&serde_json::json!([{ "id": "gitee-id" }])).as_deref(), Some("gitee-id"));
    }

    #[test]
    fn snippet_provider_uses_frontend_wire_values() {
        assert_eq!(serde_json::to_string(&super::SnippetProvider::GitHub).unwrap(), "\"github\"");
        assert_eq!(
            serde_json::from_str::<super::SnippetProvider>("\"github\"").unwrap(),
            super::SnippetProvider::GitHub
        );
        assert_eq!(
            serde_json::from_str::<super::SnippetProvider>("\"git_hub\"").unwrap(),
            super::SnippetProvider::GitHub
        );
        assert_eq!(serde_json::to_string(&super::SnippetProvider::Gitee).unwrap(), "\"gitee\"");
    }

    #[test]
    fn snippet_file_content_uses_raw_url_for_truncated_github_files() {
        let value = serde_json::json!({
            "files": {
                "dbx-sync.json": {
                    "content": "truncated",
                    "truncated": true,
                    "raw_url": "https://example.com/raw"
                }
            }
        });
        assert_eq!(
            snippet_file_content(&value, "dbx-sync.json").unwrap(),
            (None, Some("https://example.com/raw".to_string()))
        );
    }

    #[test]
    fn snippet_file_content_parses_gitee_string_files() {
        let files = serde_json::json!({ "dbx-sync.json": { "content": "{}" } }).to_string();
        let value = serde_json::json!({ "files": files });
        assert_eq!(snippet_file_content(&value, "dbx-sync.json").unwrap(), (Some("{}".to_string()), None));
    }

    #[tokio::test]
    async fn webdav_sync_secrets_preference_round_trips_and_clears_passphrase() {
        let storage = Storage::open(&temp_db_path("sync-secrets-preference")).await.unwrap();

        let status = webdav_sync_secrets_status(&storage).await.unwrap();
        assert!(!status.enabled);
        assert!(!status.has_saved_passphrase);
        assert_eq!(resolve_webdav_sync_secrets_passphrase(&storage).await.unwrap(), None);

        save_webdav_sync_secrets_preference(&storage, true, Some("sync-pass")).await.unwrap();

        let status = webdav_sync_secrets_status(&storage).await.unwrap();
        assert!(status.enabled);
        assert!(status.has_saved_passphrase);
        assert_eq!(resolve_webdav_sync_secrets_passphrase(&storage).await.unwrap().as_deref(), Some("sync-pass"));

        forget_webdav_sync_secrets_passphrase(&storage).await.unwrap();
        let status = webdav_sync_secrets_status(&storage).await.unwrap();
        assert!(status.enabled);
        assert!(!status.has_saved_passphrase);
        assert_eq!(resolve_webdav_sync_secrets_passphrase(&storage).await.unwrap(), None);
    }

    #[tokio::test]
    async fn saved_sync_passphrase_encrypts_snapshot_secrets_without_exposing_connection_passwords() {
        let storage = Storage::open(&temp_db_path("saved-sync-snapshot")).await.unwrap();
        storage.save_connections(&[postgres_connection("pg", "db-secret")]).await.unwrap();

        let plain_snapshot =
            build_sync_snapshot_with_saved_secrets(&storage, "test-version", None, None).await.unwrap();
        assert!(plain_snapshot.encrypted_secrets.is_none());
        assert_eq!(plain_snapshot.connections[0].password, "");

        save_webdav_sync_secrets_preference(&storage, true, Some("sync-pass")).await.unwrap();
        let encrypted_snapshot =
            build_sync_snapshot_with_saved_secrets(&storage, "test-version", None, None).await.unwrap();

        assert_eq!(encrypted_snapshot.connections[0].password, "");
        let encrypted = encrypted_snapshot.encrypted_secrets.as_ref().expect("encrypted secrets");
        let decrypted = decrypt_sensitive_payload(encrypted, "sync-pass").unwrap();
        assert!(decrypted.connection_secrets.iter().any(|secret| {
            secret.connection_id == "pg" && secret.key == "password" && secret.secret == "db-secret"
        }));
    }

    #[tokio::test]
    async fn saved_sync_passphrase_encrypts_nacos_auth_password_without_exposing_it() {
        let storage = Storage::open(&temp_db_path("saved-sync-nacos-snapshot")).await.unwrap();
        storage.save_connections(&[nacos_connection("nacos", "nacos-secret")]).await.unwrap();

        save_webdav_sync_secrets_preference(&storage, true, Some("sync-pass")).await.unwrap();
        let encrypted_snapshot =
            build_sync_snapshot_with_saved_secrets(&storage, "test-version", None, None).await.unwrap();

        assert_eq!(nacos_auth_password(&encrypted_snapshot.connections[0]), Some(""));
        let public_json = serde_json::to_string(&encrypted_snapshot.connections).unwrap();
        assert!(!public_json.contains("nacos-secret"));
        let encrypted = encrypted_snapshot.encrypted_secrets.as_ref().expect("encrypted secrets");
        let decrypted = decrypt_sensitive_payload(encrypted, "sync-pass").unwrap();
        assert!(decrypted.connection_secrets.iter().any(|secret| {
            secret.connection_id == "nacos" && secret.key == NACOS_AUTH_PASSWORD_KEY && secret.secret == "nacos-secret"
        }));
    }

    #[tokio::test]
    async fn sync_snapshot_round_trips_tunnel_profiles() {
        let storage = Storage::open(&temp_db_path("tunnel-profiles-src")).await.unwrap();
        let profile = TransportLayerConfig::Ssh(SshTunnelConfig {
            id: "profile-1".to_string(),
            name: "Bastion".to_string(),
            enabled: true,
            host: "bastion.example.com".to_string(),
            port: 22,
            user: "deploy".to_string(),
            password: "tunnel-secret".to_string(),
            key_path: String::new(),
            key_passphrase: String::new(),
            connect_timeout_secs: 5,
            expose_lan: false,
            use_ssh_agent: false,
            ssh_agent_sock_path: String::new(),
            auth_method: "password".to_string(),
            allow_exec_channel_proxy: false,
            profile_id: String::new(),
        });
        storage.save_tunnel_profiles(std::slice::from_ref(&profile)).await.unwrap();

        let snapshot = build_sync_snapshot(&storage, "test-version", None, Some("sync-pass")).await.unwrap();

        // The plain snapshot carries the profiles with secrets scrubbed.
        let public_profiles = snapshot.tunnel_profiles.as_ref().expect("tunnel profiles in snapshot");
        let public_json = serde_json::to_string(public_profiles).unwrap();
        assert!(!public_json.contains("tunnel-secret"));

        // Applying with the passphrase restores the full profile on the target.
        let target = Storage::open(&temp_db_path("tunnel-profiles-dst")).await.unwrap();
        apply_sync_snapshot(
            &target,
            &snapshot,
            ApplySnapshotOptions { secrets_passphrase: Some("sync-pass"), restore_secrets: true },
        )
        .await
        .unwrap();
        assert_eq!(target.load_tunnel_profiles().await.unwrap(), vec![profile]);
    }

    // ---- AI configs sync tests ----

    #[tokio::test]
    async fn sensitive_payload_ai_configs_none_falls_through_to_legacy() {
        let storage = Storage::open(&temp_db_path("ai-cfg-none")).await.unwrap();

        // No ai_configs in payload — fall through to ai_config (legacy) branch
        let payload = SensitiveSyncPayload {
            connection_secrets: vec![],
            ai_configs: None,
            ai_config: None,
            tunnel_profiles: None,
        };
        apply_sensitive_payload(&storage, &payload).await.unwrap();
        let loaded = storage.load_ai_configs().await.unwrap();
        assert!(loaded.is_empty(), "None → no configs written");
    }

    #[tokio::test]
    async fn sensitive_payload_ai_configs_empty_clears_table() {
        let storage = Storage::open(&temp_db_path("ai-cfg-empty")).await.unwrap();

        // Pre-populate with a config
        let cfg = make_test_config("to-be-cleared", true);
        storage.save_ai_config_item(&cfg).await.unwrap();

        // Some([]) — explicit clear
        let payload = SensitiveSyncPayload {
            connection_secrets: vec![],
            ai_configs: Some(vec![]),
            ai_config: None,
            tunnel_profiles: None,
        };
        apply_sensitive_payload(&storage, &payload).await.unwrap();
        let loaded = storage.load_ai_configs().await.unwrap();
        assert!(loaded.is_empty(), "Some([]) → table cleared");
    }

    #[tokio::test]
    async fn sensitive_payload_ai_configs_some_saves_configs() {
        let storage = Storage::open(&temp_db_path("ai-cfg-some")).await.unwrap();

        let mut cfg = make_test_config("synced", true);
        cfg.config.provider = crate::ai::AiProvider::OpenCodeCli;
        cfg.config.model = "openai/gpt-5.4-mini".to_string();
        cfg.config.opencode_cli_path = Some("/opt/homebrew/bin/opencode".to_string());
        cfg.config.opencode_cli_env.insert("HTTPS_PROXY".to_string(), "http://127.0.0.1:7890".to_string());
        let mut cursor_cfg = make_test_config("cursor-synced", false);
        cursor_cfg.config.provider = crate::ai::AiProvider::CursorCli;
        cursor_cfg.config.model = "composer-2.5".to_string();
        cursor_cfg.config.cursor_cli_path = Some("~/.local/bin/agent".to_string());
        cursor_cfg.config.cursor_cli_env.insert("NO_PROXY".to_string(), "localhost".to_string());
        let payload = SensitiveSyncPayload {
            connection_secrets: vec![],
            ai_configs: Some(vec![cfg, cursor_cfg]),
            ai_config: None,
            tunnel_profiles: None,
        };
        apply_sensitive_payload(&storage, &payload).await.unwrap();
        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 2);
        let opencode = loaded.iter().find(|item| item.name == "synced").unwrap();
        assert!(matches!(opencode.config.provider, crate::ai::AiProvider::OpenCodeCli));
        assert_eq!(opencode.config.model, "openai/gpt-5.4-mini");
        assert_eq!(opencode.config.opencode_cli_path.as_deref(), Some("/opt/homebrew/bin/opencode"));
        assert_eq!(
            opencode.config.opencode_cli_env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        let cursor = loaded.iter().find(|item| item.name == "cursor-synced").unwrap();
        assert!(matches!(cursor.config.provider, crate::ai::AiProvider::CursorCli));
        assert_eq!(cursor.config.model, "composer-2.5");
        assert_eq!(cursor.config.cursor_cli_path.as_deref(), Some("~/.local/bin/agent"));
        assert_eq!(cursor.config.cursor_cli_env.get("NO_PROXY").map(String::as_str), Some("localhost"));
    }

    #[tokio::test]
    async fn sensitive_payload_legacy_ai_config_replaces_local_configs_with_same_name() {
        let storage = Storage::open(&temp_db_path("ai-cfg-legacy-replace")).await.unwrap();
        storage.save_ai_config_item(&make_test_config("openai", true)).await.unwrap();
        storage.save_ai_config_item(&make_test_config("local-only", false)).await.unwrap();

        let mut legacy_config = make_test_config("unused", true).config;
        legacy_config.model = "snapshot-model".to_string();
        let payload = SensitiveSyncPayload {
            connection_secrets: vec![],
            ai_configs: None,
            ai_config: Some(legacy_config),
            tunnel_profiles: None,
        };

        apply_sensitive_payload(&storage, &payload).await.unwrap();
        // Reapplying the same old snapshot must not collide with the generated ID.
        apply_sensitive_payload(&storage, &payload).await.unwrap();

        let loaded = storage.load_ai_configs().await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "openai");
        assert_eq!(loaded[0].config.model, "snapshot-model");
        assert!(loaded[0].is_default);
    }
}
