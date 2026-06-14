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
use crate::models::connection::{ConnectionConfig, TransportLayerConfig};
use crate::saved_sql::SavedSqlLibrary;
use crate::storage::{DesktopSettings, Storage};

const SNAPSHOT_SCHEMA_VERSION: u32 = 1;
const DEFAULT_REMOTE_PATH: &str = "DBX/sync/snapshot.json";
const SECRET_KEYS: &[&str] = &[
    "password",
    "ssh_password",
    "ssh_key_passphrase",
    "proxy_password",
    "redis_sentinel_password",
    "connection_string",
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavPasswordStatus {
    pub has_saved_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSnapshot {
    pub schema_version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub connections: Vec<ConnectionConfig>,
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

pub async fn build_sync_snapshot(
    storage: &Storage,
    app_version: impl Into<String>,
    editor_settings: Option<serde_json::Value>,
    secrets_passphrase: Option<&str>,
) -> Result<SyncSnapshot, String> {
    let mut connections = storage.load_connections().await?;
    let encrypted_secrets = match normalized_passphrase(secrets_passphrase) {
        Some(passphrase) => {
            Some(encrypt_sensitive_payload(&build_sensitive_payload(storage, &connections).await?, passphrase)?)
        }
        None => None,
    };
    for config in &mut connections {
        scrub_connection_secrets(config);
    }

    Ok(SyncSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        exported_at: Utc::now().to_rfc3339(),
        app_version: app_version.into(),
        connections,
        sidebar_layout: storage.load_sidebar_layout().await?,
        pinned_tree_node_ids: storage.load_pinned_tree_node_ids().await?,
        saved_sql: storage.load_saved_sql_library().await?,
        desktop_settings: storage.load_desktop_settings().await?,
        editor_settings,
        encrypted_secrets,
    })
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
        }
    }
    config.redis_sentinel_password.clear();
    config.connection_string = None;
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
) -> Result<SensitiveSyncPayload, String> {
    let mut connection_secrets = Vec::new();
    for config in connections {
        push_secret(&mut connection_secrets, &config.id, "password", &config.password);
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
            }
        }
        push_secret(&mut connection_secrets, &config.id, "redis_sentinel_password", &config.redis_sentinel_password);
        if let Some(connection_string) = &config.connection_string {
            push_secret(&mut connection_secrets, &config.id, "connection_string", connection_string);
        }
    }

    Ok(SensitiveSyncPayload { connection_secrets, ai_config: storage.load_ai_config().await? })
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

fn normalized_remote_path(value: Option<&str>) -> String {
    let value = value.unwrap_or(DEFAULT_REMOTE_PATH).trim().trim_start_matches('/');
    if value.is_empty() {
        DEFAULT_REMOTE_PATH.to_string()
    } else {
        value.to_string()
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
        decrypt_sensitive_payload, encrypt_sensitive_payload, normalized_remote_path, parent_collection_paths,
        scrub_connection_secrets, ConnectionSecretSnapshot, SensitiveSyncPayload,
    };
    use crate::models::connection::{
        default_redis_key_separator, ConnectionConfig, DatabaseType, TransportLayerConfig,
    };

    #[test]
    fn normalizes_empty_remote_path_to_default() {
        assert_eq!(normalized_remote_path(None), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("")), "DBX/sync/snapshot.json");
        assert_eq!(normalized_remote_path(Some("/custom/snapshot.json")), "custom/snapshot.json");
    }

    #[test]
    fn returns_parent_collection_paths_from_leaf() {
        assert_eq!(parent_collection_paths("dbx/sync/snapshot.json"), vec!["dbx".to_string(), "dbx/sync".to_string()]);
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
            host: "localhost".to_string(),
            port: 5432,
            username: "user".to_string(),
            password: "secret".to_string(),
            database: None,
            visible_databases: None,
            attached_databases: Vec::new(),
            color: None,
            transport_layers: vec![TransportLayerConfig::Ssh(crate::models::connection::SshTunnelConfig {
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
            })],
            connect_timeout_secs: 5,
            query_timeout_secs: 30,
            idle_timeout_secs: 60,
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
            etcd_endpoints: String::new(),
            gbase_server: String::new(),
            external_config: None,
            jdbc_driver_class: None,
            jdbc_driver_paths: Vec::new(),
            one_time: false,
            read_only: false,
        };
        scrub_connection_secrets(&mut config);
        assert!(config.password.is_empty());
        match &config.transport_layers[0] {
            TransportLayerConfig::Ssh(ssh) => {
                assert!(ssh.password.is_empty());
                assert!(ssh.key_passphrase.is_empty());
            }
            TransportLayerConfig::Proxy(_) => panic!("expected ssh layer"),
        }
        assert!(config.redis_sentinel_password.is_empty());
        assert!(config.connection_string.is_none());
    }

    #[test]
    fn encrypted_sensitive_payload_round_trips() {
        let payload = SensitiveSyncPayload {
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
}
