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

use crate::ai::AiConfig;
use crate::connection_secrets::{
    MQ_AUTH_API_KEY_VALUE_KEY, MQ_AUTH_CLIENT_SECRET_KEY, MQ_AUTH_PASSWORD_KEY, MQ_AUTH_TOKEN_KEY,
    MQ_TOKEN_SIGNING_KEY, NACOS_AUTH_PASSWORD_KEY,
};
use crate::models::connection::{ConnectionConfig, DatabaseType, TransportLayerConfig};
use crate::saved_sql::SavedSqlLibrary;
use crate::storage::{DesktopSettings, Storage};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
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
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetTokenStatus {
    pub has_saved_token: bool,
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
pub struct SensitiveSyncPayload {
    pub connection_secrets: Vec<ConnectionSecretSnapshot>,
    pub ai_config: Option<AiConfig>,
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
    let sensitive_payload = match (&snapshot.encrypted_secrets, normalized_passphrase(options.secrets_passphrase)) {
        (Some(blob), Some(passphrase)) => Some(decrypt_sensitive_payload(blob, passphrase)?),
        _ => None,
    };

    let mut connections = snapshot.connections.clone();
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
        Self { http: Client::new(), config }
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
        Self { http: Client::new(), config }
    }

    pub async fn test(&self) -> Result<(), String> {
        self.require_token()?;
        let url = match (self.config.provider, normalized_snippet_id(self.config.snippet_id.as_deref())) {
            (SnippetProvider::GitHub, Some(id)) => format!("{GITHUB_API_BASE}/gists/{id}"),
            (SnippetProvider::GitHub, None) => format!("{GITHUB_API_BASE}/user"),
            (SnippetProvider::Gitee, Some(id)) => format!("{GITEE_API_BASE}/gists/{id}"),
            (SnippetProvider::Gitee, None) => format!("{GITEE_API_BASE}/user"),
        };
        let response = self.request(Method::GET, &url)?.send().await.map_err(|e| e.to_string())?;
        ensure_snippet_success(response.status(), "test")
    }

    pub async fn put_snapshot(&self, snapshot: &SyncSnapshot) -> Result<SnippetSyncSummary, String> {
        self.require_token()?;
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(|e| e.to_string())?;
        let content = String::from_utf8(bytes.clone()).map_err(|e| e.to_string())?;
        let existing_id = normalized_snippet_id(self.config.snippet_id.as_deref());
        let (method, url) = match (self.config.provider, existing_id) {
            (SnippetProvider::GitHub, Some(id)) => (Method::PATCH, format!("{GITHUB_API_BASE}/gists/{id}")),
            (SnippetProvider::GitHub, None) => (Method::POST, format!("{GITHUB_API_BASE}/gists")),
            (SnippetProvider::Gitee, Some(id)) => (Method::PATCH, format!("{GITEE_API_BASE}/gists/{id}")),
            (SnippetProvider::Gitee, None) => (Method::POST, format!("{GITEE_API_BASE}/gists")),
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
            .or_else(|| existing_id.map(str::to_string))
            .ok_or_else(|| "Snippet API response did not include an id".to_string())?;
        Ok(SnippetSyncSummary {
            provider: self.config.provider,
            snippet_id,
            bytes: bytes.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        })
    }

    pub async fn get_snapshot(&self) -> Result<(SyncSnapshot, SnippetSyncSummary), String> {
        self.require_token()?;
        let snippet_id = normalized_snippet_id(self.config.snippet_id.as_deref())
            .ok_or_else(|| "Snippet id is required for download".to_string())?;
        let url = match self.config.provider {
            SnippetProvider::GitHub => format!("{GITHUB_API_BASE}/gists/{snippet_id}"),
            SnippetProvider::Gitee => format!("{GITEE_API_BASE}/gists/{snippet_id}"),
        };
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
        let snapshot: SyncSnapshot = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        let summary = SnippetSyncSummary {
            provider: self.config.provider,
            snippet_id: snippet_id.to_string(),
            bytes: content.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        };
        Ok((snapshot, summary))
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
    scrub_mq_external_config_secrets(config);
    scrub_nacos_auth_secrets(config);
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
        ai_config: storage.load_ai_config().await?,
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
    let Some(auth) = config
        .external_config
        .as_ref()
        .and_then(|external_config| external_config.get("auth"))
        .and_then(serde_json::Value::as_object)
    else {
        return;
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") {
        push_json_secret(secrets, &config.id, NACOS_AUTH_PASSWORD_KEY, auth, "password");
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
    let Some(auth) = config
        .external_config
        .as_mut()
        .and_then(|external_config| external_config.get_mut("auth"))
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    if auth.get("kind").and_then(serde_json::Value::as_str) == Some("usernamePassword") && auth.contains_key("password")
    {
        scrub_json_secret(auth, "password");
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
    if let Some(ai_config) = &payload.ai_config {
        storage.save_ai_config(ai_config).await?;
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
        apply_sync_snapshot, build_sync_snapshot, build_sync_snapshot_with_saved_secrets, decrypt_sensitive_payload,
        encrypt_sensitive_payload, forget_webdav_sync_secrets_passphrase, gitee_snippet_payload,
        normalized_remote_path, parent_collection_paths, resolve_webdav_sync_secrets_passphrase,
        save_webdav_sync_secrets_preference, scrub_connection_secrets, snippet_file_content, snippet_response_id,
        webdav_sync_secrets_status, ApplySnapshotOptions, ConnectionSecretSnapshot, SensitiveSyncPayload,
    };
    use crate::connection_secrets::NACOS_AUTH_PASSWORD_KEY;
    use crate::models::connection::{
        default_redis_key_separator, ConnectionConfig, DatabaseType, SshTunnelConfig, TransportLayerConfig,
    };
    use crate::storage::Storage;

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("dbx-cloud-sync-{name}-{}.db", uuid::Uuid::new_v4()))
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
            id: id.to_string(),
            name: "Postgres".to_string(),
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
            visible_databases: None,
            visible_schemas: None,
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
        }
    }

    fn nacos_connection(id: &str, password: &str) -> ConnectionConfig {
        ConnectionConfig {
            id: id.to_string(),
            name: "Nacos".to_string(),
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
            visible_databases: None,
            visible_schemas: None,
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
            id: "id".to_string(),
            name: "name".to_string(),
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
            visible_databases: None,
            visible_schemas: None,
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
            ai_config: None,
        };
        let encrypted = encrypt_sensitive_payload(&payload, "sync-pass").unwrap();
        assert!(decrypt_sensitive_payload(&encrypted, "wrong-pass").is_err());
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
        apply_sync_snapshot(&target, &snapshot, ApplySnapshotOptions { secrets_passphrase: Some("sync-pass") })
            .await
            .unwrap();
        assert_eq!(target.load_tunnel_profiles().await.unwrap(), vec![profile]);
    }
}
