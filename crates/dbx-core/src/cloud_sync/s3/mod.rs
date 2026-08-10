mod reqwest_sigv4;
mod transport;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::Arc;

use self::reqwest_sigv4::ReqwestSigV4Transport;
use self::transport::S3ObjectTransport;
use super::{decrypt_text_with_secret, encrypt_text_with_secret, EncryptedSecretsBlob, SyncSnapshot};
use crate::storage::Storage;

const DEFAULT_S3_REGION: &str = "us-east-1";
pub const DEFAULT_S3_OBJECT_KEY: &str = "DBX/sync/snapshot.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum S3AddressingStyle {
    Path,
    VirtualHosted,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncConfig {
    pub endpoint: Option<String>,
    #[serde(default)]
    pub region: String,
    pub bucket: String,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
    pub object_key: Option<String>,
    pub addressing_style: Option<S3AddressingStyle>,
}

impl S3SyncConfig {
    pub fn normalized_endpoint(&self) -> Option<String> {
        self.endpoint.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
    }

    pub fn normalized_region(&self) -> String {
        let region = self.region.trim();
        if region.is_empty() {
            DEFAULT_S3_REGION.to_string()
        } else {
            region.to_string()
        }
    }

    pub fn normalized_object_key(&self) -> String {
        let key = self.object_key.as_deref().unwrap_or(DEFAULT_S3_OBJECT_KEY).trim().trim_start_matches('/');
        if key.is_empty() {
            DEFAULT_S3_OBJECT_KEY.to_string()
        } else {
            key.to_string()
        }
    }

    pub fn normalized_session_token(&self) -> Option<String> {
        self.session_token.as_deref().map(str::trim).filter(|value| !value.is_empty()).map(str::to_string)
    }

    pub fn effective_addressing_style(&self) -> S3AddressingStyle {
        self.addressing_style.unwrap_or_else(|| {
            if self.normalized_endpoint().is_some() {
                S3AddressingStyle::Path
            } else {
                S3AddressingStyle::VirtualHosted
            }
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3CredentialsStatus {
    pub has_saved_credentials: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3SyncSummary {
    pub bucket: String,
    pub object_key: String,
    pub bytes: usize,
    pub exported_at: Option<String>,
    pub app_version: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedS3Credentials {
    secret_access_key: String,
    session_token: Option<String>,
}

pub struct S3SyncClient {
    transport: Arc<dyn S3ObjectTransport>,
    bucket: String,
    object_key: String,
}

impl S3SyncClient {
    pub fn new(config: S3SyncConfig) -> Result<Self, String> {
        let bucket = required_config_value(&config.bucket, "S3 bucket")?;
        let object_key = config.normalized_object_key();
        let transport = ReqwestSigV4Transport::new(&config).map_err(|error| error.to_string())?;
        Ok(Self { transport: Arc::new(transport), bucket, object_key })
    }

    #[cfg(test)]
    fn with_transport(config: S3SyncConfig, transport: Arc<dyn S3ObjectTransport>) -> Result<Self, String> {
        Ok(Self {
            bucket: required_config_value(&config.bucket, "S3 bucket")?,
            object_key: config.normalized_object_key(),
            transport,
        })
    }

    pub async fn test(&self) -> Result<(), String> {
        self.transport.head_bucket().await.map_err(|error| error.to_string())
    }

    pub async fn put_snapshot(&self, snapshot: &SyncSnapshot) -> Result<S3SyncSummary, String> {
        let bytes = serde_json::to_vec_pretty(snapshot).map_err(|error| error.to_string())?;
        self.transport
            .put_object(&self.object_key, bytes.clone(), "application/json")
            .await
            .map_err(|error| error.to_string())?;
        Ok(S3SyncSummary {
            bucket: self.bucket.clone(),
            object_key: self.object_key.clone(),
            bytes: bytes.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        })
    }

    pub async fn get_snapshot(&self) -> Result<(SyncSnapshot, S3SyncSummary), String> {
        let bytes = self.transport.get_object(&self.object_key).await.map_err(|error| error.to_string())?;
        let snapshot: SyncSnapshot = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let summary = S3SyncSummary {
            bucket: self.bucket.clone(),
            object_key: self.object_key.clone(),
            bytes: bytes.len(),
            exported_at: Some(snapshot.exported_at.clone()),
            app_version: Some(snapshot.app_version.clone()),
        };
        Ok((snapshot, summary))
    }
}

pub async fn s3_saved_credentials_status(
    storage: &Storage,
    config: &S3SyncConfig,
) -> Result<S3CredentialsStatus, String> {
    Ok(S3CredentialsStatus {
        has_saved_credentials: storage.load_webdav_password_blob(&s3_credentials_account(config)?).await?.is_some(),
    })
}

pub async fn save_s3_credentials(
    storage: &Storage,
    config: &S3SyncConfig,
    secret_access_key: &str,
    session_token: Option<&str>,
) -> Result<(), String> {
    let credentials = SavedS3Credentials {
        secret_access_key: required_config_value(secret_access_key, "S3 secret access key")?,
        session_token: session_token.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string),
    };
    let plaintext = serde_json::to_string(&credentials).map_err(|error| error.to_string())?;
    let device_secret = storage.load_or_create_local_device_secret().await?;
    let blob = encrypt_text_with_secret(&plaintext, &device_secret)?;
    let value = serde_json::to_value(blob).map_err(|error| error.to_string())?;
    storage.save_webdav_password_blob(&s3_credentials_account(config)?, &value).await
}

pub async fn forget_s3_credentials(storage: &Storage, config: &S3SyncConfig) -> Result<(), String> {
    storage.delete_webdav_password_blob(&s3_credentials_account(config)?).await
}

pub async fn resolve_s3_credentials(storage: &Storage, config: &mut S3SyncConfig) -> Result<(), String> {
    required_config_value(config.access_key_id.as_deref().unwrap_or_default(), "S3 access key id")?;
    if config.secret_access_key.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        config.session_token = config.normalized_session_token();
        return Ok(());
    }
    let Some(value) = storage.load_webdav_password_blob(&s3_credentials_account(config)?).await? else {
        return Ok(());
    };
    let blob: EncryptedSecretsBlob = serde_json::from_value(value).map_err(|error| error.to_string())?;
    let device_secret = storage.load_or_create_local_device_secret().await?;
    let plaintext = decrypt_text_with_secret(&blob, &device_secret)?;
    let credentials: SavedS3Credentials = serde_json::from_str(&plaintext).map_err(|error| error.to_string())?;
    config.secret_access_key = Some(credentials.secret_access_key);
    config.session_token = credentials.session_token;
    Ok(())
}

fn s3_credentials_account(config: &S3SyncConfig) -> Result<String, String> {
    let access_key_id = required_config_value(config.access_key_id.as_deref().unwrap_or_default(), "S3 access key id")?;
    let bucket = required_config_value(&config.bucket, "S3 bucket")?;
    let mut hasher = Sha256::new();
    hasher.update(b"s3-credentials\n");
    hasher.update(config.normalized_endpoint().unwrap_or_default().as_bytes());
    hasher.update(b"\n");
    hasher.update(config.normalized_region().as_bytes());
    hasher.update(b"\n");
    hasher.update(bucket.as_bytes());
    hasher.update(b"\n");
    hasher.update(access_key_id.as_bytes());
    Ok(format!("s3-credentials:{}", URL_SAFE_NO_PAD.encode(hasher.finalize())))
}

fn required_config_value(value: &str, label: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::transport::{S3ObjectTransport, S3TransportError};
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeTransport {
        stored: Mutex<Option<(String, Vec<u8>, String)>>,
    }

    #[async_trait]
    impl S3ObjectTransport for FakeTransport {
        async fn head_bucket(&self) -> Result<(), S3TransportError> {
            Ok(())
        }

        async fn put_object(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<(), S3TransportError> {
            *self.stored.lock().unwrap() = Some((key.to_string(), body, content_type.to_string()));
            Ok(())
        }

        async fn get_object(&self, _key: &str) -> Result<Vec<u8>, S3TransportError> {
            self.stored
                .lock()
                .unwrap()
                .as_ref()
                .map(|(_, body, _)| body.clone())
                .ok_or_else(|| S3TransportError::NotFound("snapshot".to_string()))
        }
    }

    fn config() -> S3SyncConfig {
        S3SyncConfig {
            endpoint: Some("http://127.0.0.1:9000".to_string()),
            region: "us-east-1".to_string(),
            bucket: "dbx-sync".to_string(),
            access_key_id: Some("access".to_string()),
            secret_access_key: Some("secret".to_string()),
            session_token: None,
            object_key: None,
            addressing_style: None,
        }
    }

    #[test]
    fn config_defaults_are_compatible_with_custom_endpoints() {
        let config = config();
        assert_eq!(config.normalized_region(), "us-east-1");
        assert_eq!(config.normalized_object_key(), DEFAULT_S3_OBJECT_KEY);
        assert_eq!(config.effective_addressing_style(), S3AddressingStyle::Path);

        let mut aws = config;
        aws.endpoint = None;
        assert_eq!(aws.effective_addressing_style(), S3AddressingStyle::VirtualHosted);
    }

    #[tokio::test]
    async fn client_round_trips_snapshot_through_transport() {
        let temp_dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp_dir.path().join("dbx.db")).await.unwrap();
        let snapshot = crate::cloud_sync::build_sync_snapshot(
            &storage,
            "test-version",
            Some(serde_json::json!({ "fontSize": 14 })),
            None,
        )
        .await
        .unwrap();
        let transport = Arc::new(FakeTransport::default());
        let client = S3SyncClient::with_transport(config(), transport.clone()).unwrap();

        let upload_summary = client.put_snapshot(&snapshot).await.unwrap();
        assert_eq!(upload_summary.bucket, "dbx-sync");
        assert_eq!(upload_summary.object_key, DEFAULT_S3_OBJECT_KEY);
        assert_eq!(upload_summary.exported_at.as_deref(), Some(snapshot.exported_at.as_str()));

        let stored = transport.stored.lock().unwrap().clone().unwrap();
        assert_eq!(stored.0, DEFAULT_S3_OBJECT_KEY);
        assert_eq!(stored.2, "application/json");
        assert_eq!(stored.1.len(), upload_summary.bytes);

        let (downloaded, download_summary) = client.get_snapshot().await.unwrap();
        assert_eq!(download_summary.bytes, upload_summary.bytes);
        assert_eq!(downloaded.app_version, "test-version");
        assert_eq!(downloaded.editor_settings, Some(serde_json::json!({ "fontSize": 14 })));
    }

    struct FailingTransport;

    #[async_trait]
    impl S3ObjectTransport for FailingTransport {
        async fn head_bucket(&self) -> Result<(), S3TransportError> {
            Err(S3TransportError::Unauthorized("denied".to_string()))
        }

        async fn put_object(&self, _key: &str, _body: Vec<u8>, _content_type: &str) -> Result<(), S3TransportError> {
            Err(S3TransportError::Network("offline".to_string()))
        }

        async fn get_object(&self, _key: &str) -> Result<Vec<u8>, S3TransportError> {
            Err(S3TransportError::NotFound("snapshot".to_string()))
        }
    }

    #[tokio::test]
    async fn client_maps_transport_errors_without_exposing_transport_types() {
        let client = S3SyncClient::with_transport(config(), Arc::new(FailingTransport)).unwrap();
        assert_eq!(client.test().await.unwrap_err(), "S3 authentication or authorization failed: denied");
        assert_eq!(client.get_snapshot().await.unwrap_err(), "S3 resource not found: snapshot");
    }

    #[tokio::test]
    async fn credentials_round_trip_and_are_scoped_by_account() {
        let temp_dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(&temp_dir.path().join("dbx.db")).await.unwrap();
        let mut config = config();
        config.secret_access_key = None;
        save_s3_credentials(&storage, &config, "saved-secret", Some("session-token")).await.unwrap();
        assert!(s3_saved_credentials_status(&storage, &config).await.unwrap().has_saved_credentials);
        let saved_blob = storage
            .load_webdav_password_blob(&s3_credentials_account(&config).unwrap())
            .await
            .unwrap()
            .unwrap()
            .to_string();
        assert!(!saved_blob.contains("saved-secret"));
        assert!(!saved_blob.contains("session-token"));

        let mut other_account = config.clone();
        other_account.bucket = "other-bucket".to_string();
        assert!(!s3_saved_credentials_status(&storage, &other_account).await.unwrap().has_saved_credentials);

        resolve_s3_credentials(&storage, &mut config).await.unwrap();
        assert_eq!(config.secret_access_key.as_deref(), Some("saved-secret"));
        assert_eq!(config.session_token.as_deref(), Some("session-token"));

        forget_s3_credentials(&storage, &config).await.unwrap();
        assert!(!s3_saved_credentials_status(&storage, &config).await.unwrap().has_saved_credentials);
    }
}
