use std::sync::Arc;

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use async_trait::async_trait;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::models::connection::ConnectionConfig;
use crate::storage::Storage;

// ============================================================================
// 8.2: State Backend Plugin System
// ============================================================================

#[async_trait]
pub trait StateBackend: Send + Sync {
    async fn save(&self, key: &str, value: &[u8]) -> Result<(), String>;
    async fn save_with_content_type(&self, key: &str, value: &[u8], content_type: &str) -> Result<(), String>;
    async fn load(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    async fn delete(&self, key: &str) -> Result<(), String>;
    async fn exists(&self, key: &str) -> Result<bool, String>;

    async fn compare_and_swap(&self, key: &str, old: Option<&[u8]>, new: &[u8]) -> Result<bool, String> {
        let _ = (key, old, new);
        Err("CAS not supported by this backend".to_string())
    }
}

// ============================================================================
// LocalBackend: SQLite-backed via existing Storage
// ============================================================================

pub struct LocalBackend {
    storage: Arc<Storage>,
}

impl LocalBackend {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }
}

#[async_trait]
impl StateBackend for LocalBackend {
    async fn save(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.storage.save_state(key, value, "application/octet-stream").await
    }

    async fn save_with_content_type(&self, key: &str, value: &[u8], content_type: &str) -> Result<(), String> {
        self.storage.save_state(key, value, content_type).await
    }

    async fn load(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        self.storage.load_state(key).await.map(|opt| opt.map(|(data, _)| data))
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        self.storage.delete_state(key).await
    }

    async fn exists(&self, key: &str) -> Result<bool, String> {
        self.storage.state_exists(key).await
    }

    async fn compare_and_swap(&self, key: &str, old: Option<&[u8]>, new: &[u8]) -> Result<bool, String> {
        let expected_version = match old {
            Some(data) => {
                let entry: StateEntry =
                    serde_json::from_slice(data).map_err(|e| format!("CAS deserialize error: {e}"))?;
                Some(entry.version)
            }
            None => None,
        };
        self.storage.compare_and_swap_state(key, expected_version, new, "application/json").await
    }
}

// ============================================================================
// RedisBackend
// ============================================================================

pub struct RedisBackend {
    client: redis::Client,
    prefix: String,
}

impl RedisBackend {
    pub fn new(redis_url: &str, prefix: &str) -> Result<Self, String> {
        let client = redis::Client::open(redis_url).map_err(|e| format!("redis connect error: {e}"))?;
        Ok(Self { client, prefix: prefix.to_string() })
    }

    fn prefixed(&self, key: &str) -> String {
        format!("{}:{}", self.prefix, key)
    }
}

#[async_trait]
impl StateBackend for RedisBackend {
    async fn save(&self, key: &str, value: &[u8]) -> Result<(), String> {
        let mut conn =
            self.client.get_multiplexed_async_connection().await.map_err(|e| format!("redis connection error: {e}"))?;
        let prefixed = self.prefixed(key);
        redis::cmd("SET")
            .arg(&[prefixed.as_bytes(), value])
            .query_async::<()>(&mut conn)
            .await
            .map_err(|e| format!("redis set error: {e}"))
    }

    async fn save_with_content_type(&self, key: &str, value: &[u8], _content_type: &str) -> Result<(), String> {
        self.save(key, value).await
    }

    async fn load(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let mut conn =
            self.client.get_multiplexed_async_connection().await.map_err(|e| format!("redis connection error: {e}"))?;
        let prefixed = self.prefixed(key);
        let result: Option<Vec<u8>> = redis::cmd("GET")
            .arg(&[prefixed.as_bytes()])
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("redis get error: {e}"))?;
        Ok(result)
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let mut conn =
            self.client.get_multiplexed_async_connection().await.map_err(|e| format!("redis connection error: {e}"))?;
        let prefixed = self.prefixed(key);
        redis::cmd("DEL")
            .arg(&[prefixed.as_bytes()])
            .query_async::<()>(&mut conn)
            .await
            .map_err(|e| format!("redis del error: {e}"))
    }

    async fn exists(&self, key: &str) -> Result<bool, String> {
        let mut conn =
            self.client.get_multiplexed_async_connection().await.map_err(|e| format!("redis connection error: {e}"))?;
        let prefixed = self.prefixed(key);
        let count: i64 = redis::cmd("EXISTS")
            .arg(&[prefixed.as_bytes()])
            .query_async(&mut conn)
            .await
            .map_err(|e| format!("redis exists error: {e}"))?;
        Ok(count > 0)
    }
}

// ============================================================================
// DBBackend: Generic SQL database backend
// ============================================================================

pub struct DBBackend {
    pool: deadpool_postgres::Pool,
    schema_table: String,
}

impl DBBackend {
    pub fn new(pool: deadpool_postgres::Pool, schema_table: &str) -> Self {
        assert!(!schema_table.is_empty(), "schema_table must not be empty");
        assert!(!schema_table.starts_with(|c: char| c.is_ascii_digit()), "schema_table must not start with a digit");
        assert!(
            schema_table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
            "schema_table contains invalid characters: {schema_table:?}"
        );
        Self { pool, schema_table: schema_table.to_string() }
    }

    pub async fn ensure_table(&self) -> Result<(), String> {
        let client = self.pool.get().await.map_err(|e| format!("db pool error: {e}"))?;
        let stmt = format!(
            "CREATE TABLE IF NOT EXISTS {} (
                key TEXT PRIMARY KEY,
                payload BYTEA NOT NULL,
                version BIGINT NOT NULL DEFAULT 1,
                content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )",
            self.schema_table
        );
        client.batch_execute(&stmt).await.map_err(|e| format!("db create table error: {e}"))
    }
}

#[async_trait]
impl StateBackend for DBBackend {
    async fn save(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.save_with_content_type(key, value, "application/octet-stream").await
    }

    async fn save_with_content_type(&self, key: &str, value: &[u8], content_type: &str) -> Result<(), String> {
        let client = self.pool.get().await.map_err(|e| format!("db pool error: {e}"))?;
        let stmt = format!(
            "INSERT INTO {} (key, payload, content_type) VALUES ($1, $2, $3) \
             ON CONFLICT (key) DO UPDATE SET payload = $2, content_type = $3, \
             version = {}.version + 1, updated_at = NOW()",
            self.schema_table, self.schema_table
        );
        client
            .execute(&stmt, &[&key.to_string(), &value.to_vec(), &content_type.to_string()])
            .await
            .map_err(|e| format!("db upsert error: {e}"))?;
        Ok(())
    }

    async fn load(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let client = self.pool.get().await.map_err(|e| format!("db pool error: {e}"))?;
        let stmt = format!("SELECT payload FROM {} WHERE key = $1", self.schema_table);
        let rows = client.query(&stmt, &[&key.to_string()]).await.map_err(|e| format!("db query error: {e}"))?;
        Ok(rows.first().map(|row| row.get::<_, Vec<u8>>(0)))
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let client = self.pool.get().await.map_err(|e| format!("db pool error: {e}"))?;
        let stmt = format!("DELETE FROM {} WHERE key = $1", self.schema_table);
        client.execute(&stmt, &[&key.to_string()]).await.map_err(|e| format!("db delete error: {e}"))?;
        Ok(())
    }

    async fn exists(&self, key: &str) -> Result<bool, String> {
        let client = self.pool.get().await.map_err(|e| format!("db pool error: {e}"))?;
        let stmt = format!("SELECT COUNT(*) FROM {} WHERE key = $1", self.schema_table);
        let count: i64 =
            client.query_one(&stmt, &[&key.to_string()]).await.map_err(|e| format!("db exists error: {e}"))?.get(0);
        Ok(count > 0)
    }
}

// Secret string that zeros memory on drop to minimize secret retention
pub struct SecretStr {
    inner: Vec<u8>,
}

impl SecretStr {
    pub fn new(s: &str) -> Self {
        Self { inner: s.as_bytes().to_vec() }
    }

    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.inner).expect("SecretStr must be valid UTF-8")
    }
}

impl std::fmt::Display for SecretStr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.as_str().fmt(f)
    }
}

impl Drop for SecretStr {
    fn drop(&mut self) {
        for byte in &mut self.inner {
            *byte = 0;
        }
    }
}

// ============================================================================
// S3Backend
// ============================================================================

#[allow(dead_code)]
pub struct S3Backend {
    client: reqwest::Client,
    bucket: String,
    region: String,
    access_key: SecretStr,
    secret_key: SecretStr,
    endpoint: String,
    prefix: String,
}

impl S3Backend {
    pub fn new(
        bucket: &str,
        region: &str,
        access_key: &str,
        secret_key: &str,
        endpoint: Option<&str>,
        prefix: &str,
    ) -> Self {
        let endpoint = endpoint
            .filter(|s| !s.is_empty())
            .unwrap_or(&format!("https://{bucket}.s3.{region}.amazonaws.com"))
            .to_string();
        Self {
            client: reqwest::Client::new(),
            bucket: bucket.to_string(),
            region: region.to_string(),
            access_key: SecretStr::new(access_key),
            secret_key: SecretStr::new(secret_key),
            endpoint,
            prefix: prefix.to_string(),
        }
    }

    fn object_key(&self, key: &str) -> String {
        if self.prefix.is_empty() {
            key.to_string()
        } else {
            format!("{}/{}", self.prefix, key)
        }
    }

    fn auth_header(&self, method: &reqwest::Method, path: &str, body: &[u8]) -> Result<String, String> {
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = &amz_date[..8];
        let content_sha256 = hex(Sha256::digest(body));

        let canonical_uri = format!("/{}", path);
        let canonical_querystring = "";
        let canonical_headers =
            format!("host:{}\nx-amz-content-sha256:{content_sha256}\nx-amz-date:{amz_date}\n", self.build_host());
        let signed_headers = "host;x-amz-content-sha256;x-amz-date";
        let canonical_request = format!("{method}\n{canonical_uri}\n{canonical_querystring}\n{canonical_headers}\n{signed_headers}\n{content_sha256}");

        let algorithm = "AWS4-HMAC-SHA256";
        let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string_to_sign = format!(
            "{algorithm}\n{amz_date}\n{credential_scope}\n{}",
            hex(Sha256::digest(canonical_request.as_bytes()))
        );

        let signing_key = self.signing_key(date_stamp)?;
        let signature = hex(hmac_sha256(&signing_key, string_to_sign.as_bytes()));
        Ok(format!(
            "{algorithm} Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        ))
    }

    fn build_host(&self) -> String {
        let url = &self.endpoint;
        url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_string()
    }

    fn signing_key(&self, date_stamp: &str) -> Result<Vec<u8>, String> {
        let k_secret = format!("AWS4{}", self.secret_key);
        let k_date = hmac_sha256(k_secret.as_bytes(), date_stamp.as_bytes());
        let k_region = hmac_sha256(&k_date, self.region.as_bytes());
        let k_service = hmac_sha256(&k_region, b"s3");
        Ok(hmac_sha256(&k_service, b"aws4_request").to_vec())
    }
}

#[async_trait]
impl StateBackend for S3Backend {
    async fn save(&self, key: &str, value: &[u8]) -> Result<(), String> {
        self.save_with_content_type(key, value, "application/octet-stream").await
    }

    async fn save_with_content_type(&self, key: &str, value: &[u8], content_type: &str) -> Result<(), String> {
        let object_key = self.object_key(key);
        let url = format!("{}/{}", self.endpoint.trim_end_matches('/'), object_key);
        let method = reqwest::Method::PUT;
        let auth = self.auth_header(&method, &object_key, value)?;
        let content_sha256 = hex(Sha256::digest(value));

        let resp = self
            .client
            .put(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", &content_sha256)
            .header("x-amz-date", &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .header("Content-Type", content_type)
            .body(value.to_vec())
            .send()
            .await
            .map_err(|e| format!("s3 put error: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_else(|e| format!("<body read error: {e}>"));
            return Err(format!("s3 put failed: {status} {body}"));
        }
        Ok(())
    }

    async fn load(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let object_key = self.object_key(key);
        let url = format!("{}/{}", self.endpoint.trim_end_matches('/'), object_key);
        let method = reqwest::Method::GET;
        let auth = self.auth_header(&method, &object_key, b"")?;

        let resp = self
            .client
            .get(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", hex(Sha256::digest(b"")))
            .header("x-amz-date", &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .send()
            .await
            .map_err(|e| format!("s3 get error: {e}"))?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_else(|e| format!("<body read error: {e}>"));
            return Err(format!("s3 get failed: {status} {body}"));
        }
        let bytes = resp.bytes().await.map_err(|e| format!("s3 read error: {e}"))?;
        Ok(Some(bytes.to_vec()))
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let object_key = self.object_key(key);
        let url = format!("{}/{}", self.endpoint.trim_end_matches('/'), object_key);
        let method = reqwest::Method::DELETE;
        let auth = self.auth_header(&method, &object_key, b"")?;

        let resp = self
            .client
            .delete(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", hex(Sha256::digest(b"")))
            .header("x-amz-date", &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .send()
            .await
            .map_err(|e| format!("s3 delete error: {e}"))?;

        if !resp.status().is_success() && resp.status() != reqwest::StatusCode::NOT_FOUND {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_else(|e| format!("<body read error: {e}>"));
            return Err(format!("s3 delete failed: {status} {body}"));
        }
        Ok(())
    }

    async fn exists(&self, key: &str) -> Result<bool, String> {
        let object_key = self.object_key(key);
        let url = format!("{}/{}", self.endpoint.trim_end_matches('/'), object_key);
        let method = reqwest::Method::HEAD;
        let auth = self.auth_header(&method, &object_key, b"")?;

        let resp = self
            .client
            .head(&url)
            .header("Authorization", &auth)
            .header("x-amz-content-sha256", hex(Sha256::digest(b"")))
            .header("x-amz-date", &chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string())
            .send()
            .await
            .map_err(|e| format!("s3 head error: {e}"))?;

        Ok(resp.status().is_success())
    }
}

// ============================================================================
// 8.3: EncryptedPayload — AES-256-GCM + Argon2id + HMAC-SHA256 signing
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EncryptedPayload {
    pub version: u8,
    pub kdf: String,
    pub cipher: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

impl EncryptedPayload {
    pub fn encrypt(plaintext: &[u8], passphrase: &str) -> Result<Self, String> {
        let mut salt = [0u8; 16];
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut salt);
        OsRng.fill_bytes(&mut nonce);
        let key = derive_key(passphrase, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), plaintext).map_err(|e| e.to_string())?;
        Ok(Self {
            version: 1,
            kdf: "argon2id".to_string(),
            cipher: "aes-256-gcm".to_string(),
            salt: base64_engine().encode(salt),
            nonce: base64_engine().encode(nonce),
            ciphertext: base64_engine().encode(ciphertext),
            signature: None,
        })
    }

    pub fn decrypt(&self, passphrase: &str) -> Result<Vec<u8>, String> {
        if self.version != 1 || self.kdf != "argon2id" || self.cipher != "aes-256-gcm" {
            return Err("Unsupported encrypted payload format".to_string());
        }
        let salt = base64_engine().decode(&self.salt).map_err(|e| e.to_string())?;
        let nonce = base64_engine().decode(&self.nonce).map_err(|e| e.to_string())?;
        let ciphertext = base64_engine().decode(&self.ciphertext).map_err(|e| e.to_string())?;
        if nonce.len() != 12 {
            return Err("Invalid nonce length".to_string());
        }
        let key = derive_key(passphrase, &salt)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        cipher.decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref()).map_err(|_| "Decryption failed".to_string())
    }

    pub fn sign(&mut self, signing_key: &[u8]) {
        let payload = self.signing_payload();
        let sig = hmac_sha256(signing_key, payload.as_bytes());
        self.signature = Some(base64_engine().encode(sig));
    }

    pub fn verify(&self, signing_key: &[u8]) -> bool {
        let Some(sig_b64) = &self.signature else {
            return false;
        };
        let Ok(expected_sig) = base64_engine().decode(sig_b64) else {
            return false;
        };
        let payload = self.signing_payload();
        let computed = hmac_sha256(signing_key, payload.as_bytes());
        constant_time_eq(&expected_sig, &computed)
    }

    fn signing_payload(&self) -> String {
        format!("{}.{}.{}.{}.{}.{}", self.version, self.kdf, self.cipher, self.salt, self.nonce, self.ciphertext)
    }
}

// Argon2id KDF parameters (used as key derivation for encryption, not password hashing).
// The memory cost (19 MiB) and iteration count (2) are adequate for a KDF running in a
// desktop context where the derived key only exists ephemerally in memory.
const KDF_MEMORY_COST: u32 = 19 * 1024;
const KDF_ITERATIONS: u32 = 2;
const KDF_PARALLELISM: u32 = 1;

fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let params = Params::new(KDF_MEMORY_COST, KDF_ITERATIONS, KDF_PARALLELISM, Some(32)).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; 32];
    argon2.hash_password_into(passphrase.as_bytes(), salt, &mut key).map_err(|e| e.to_string())?;
    Ok(key)
}

fn base64_engine() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    const BLOCK_SIZE: usize = 64;
    let mut k = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hash = Sha256::digest(key);
        k[..32].copy_from_slice(&hash);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::digest([&ipad[..], data].concat());
    let result = Sha256::digest([&opad[..], &inner[..]].concat());
    result.into()
}

fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut result = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        result |= x ^ y;
    }
    result == 0
}

// ============================================================================
// 8.4: State Machine with CAS Optimistic Locking (extended Phase 15)
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateTransition {
    Created,
    Running,
    Paused,
    OscSyncing,
    Completed,
    Failed,
    Cancelled,
    RollingBack,
    FullyRolledBack,
    PartiallyRolledBack,
    RecoveryRequired,
}

impl StateTransition {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::OscSyncing => "osc_syncing",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::RollingBack => "rolling_back",
            Self::FullyRolledBack => "fully_rolled_back",
            Self::PartiallyRolledBack => "partially_rolled_back",
            Self::RecoveryRequired => "recovery_required",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "created" => Some(Self::Created),
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "osc_syncing" => Some(Self::OscSyncing),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            "rolling_back" => Some(Self::RollingBack),
            "fully_rolled_back" => Some(Self::FullyRolledBack),
            "partially_rolled_back" => Some(Self::PartiallyRolledBack),
            "recovery_required" => Some(Self::RecoveryRequired),
            _ => None,
        }
    }
}

const ALLOWED_TRANSITIONS: &[(StateTransition, &[StateTransition])] = &[
    (StateTransition::Created, &[StateTransition::Running, StateTransition::Cancelled]),
    (
        StateTransition::Running,
        &[StateTransition::Paused, StateTransition::OscSyncing, StateTransition::Completed, StateTransition::Failed],
    ),
    (StateTransition::Paused, &[StateTransition::Running, StateTransition::Cancelled]),
    (StateTransition::OscSyncing, &[StateTransition::Completed, StateTransition::Failed]),
    (StateTransition::Completed, &[StateTransition::RollingBack, StateTransition::FullyRolledBack]),
    (
        StateTransition::Failed,
        &[
            StateTransition::Running,
            StateTransition::Cancelled,
            StateTransition::RollingBack,
            StateTransition::RecoveryRequired,
        ],
    ),
    (StateTransition::Cancelled, &[]),
    (
        StateTransition::RollingBack,
        &[StateTransition::FullyRolledBack, StateTransition::PartiallyRolledBack, StateTransition::RecoveryRequired],
    ),
    (StateTransition::FullyRolledBack, &[]),
    (StateTransition::PartiallyRolledBack, &[StateTransition::RecoveryRequired]),
    (StateTransition::RecoveryRequired, &[]),
];

pub fn is_valid_transition(from: &StateTransition, to: &StateTransition) -> bool {
    ALLOWED_TRANSITIONS.iter().any(|(state, allowed)| state == from && allowed.contains(to))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateEntry {
    pub key: String,
    pub current_state: String,
    pub version: u64,
    pub metadata: serde_json::Value,
}

const STATE_KEY_PREFIX: &str = "state:";

pub struct StateMachine {
    backend: Arc<dyn StateBackend>,
}

impl StateMachine {
    pub fn new(backend: Arc<dyn StateBackend>) -> Self {
        Self { backend }
    }

    pub async fn create_state(&self, key: &str, metadata: serde_json::Value) -> Result<StateEntry, String> {
        let entry = StateEntry {
            key: key.to_string(),
            current_state: StateTransition::Created.as_str().to_string(),
            version: 1,
            metadata,
        };
        let data = serde_json::to_vec(&entry).map_err(|e| e.to_string())?;
        self.backend.save(&format!("{STATE_KEY_PREFIX}{key}"), &data).await?;
        Ok(entry)
    }

    pub async fn transition(&self, key: &str, to: StateTransition) -> Result<StateEntry, String> {
        let state_key = format!("{STATE_KEY_PREFIX}{key}");
        let max_retries = 3;

        for attempt in 0..=max_retries {
            let raw = self.backend.load(&state_key).await?;
            let mut entry: StateEntry = match raw {
                Some(data) => serde_json::from_slice(&data).map_err(|e| e.to_string())?,
                None => return Err(format!("State not found: {key}")),
            };

            let current = StateTransition::from_str(&entry.current_state)
                .ok_or_else(|| format!("Invalid current state: {}", entry.current_state))?;

            if !is_valid_transition(&current, &to) {
                return Err(format!("Invalid transition: {} -> {}", current.as_str(), to.as_str()));
            }

            let expected_version = entry.version;
            entry.current_state = to.as_str().to_string();
            entry.version += 1;

            let success = self.compare_and_swap_state(key, expected_version, &entry).await?;
            if success {
                return Ok(entry);
            }

            if attempt < max_retries {
                log::warn!(
                    "CAS conflict for state key '{}' at version {}, retrying {}/{}",
                    key,
                    expected_version,
                    attempt + 1,
                    max_retries
                );
            }
        }

        Err(format!("CAS failed after {} retries for state key: {}", max_retries, key))
    }

    pub async fn get_state(&self, key: &str) -> Result<Option<StateEntry>, String> {
        let state_key = format!("{STATE_KEY_PREFIX}{key}");
        let raw = self.backend.load(&state_key).await?;
        match raw {
            Some(data) => {
                let entry: StateEntry = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
                Ok(Some(entry))
            }
            None => Ok(None),
        }
    }

    pub async fn compare_and_swap_state(
        &self,
        key: &str,
        expected_version: u64,
        new_state: &StateEntry,
    ) -> Result<bool, String> {
        let state_key = format!("{STATE_KEY_PREFIX}{key}");

        let old_entry = StateEntry {
            key: key.to_string(),
            current_state: String::new(),
            version: expected_version,
            metadata: serde_json::Value::Null,
        };
        let old_data = serde_json::to_vec(&old_entry).map_err(|e| e.to_string())?;
        let new_data = serde_json::to_vec(new_state).map_err(|e| e.to_string())?;

        self.backend.compare_and_swap(&state_key, Some(&old_data), &new_data).await
    }

    pub async fn delete_state(&self, key: &str) -> Result<(), String> {
        self.backend.delete(&format!("{STATE_KEY_PREFIX}{key}")).await
    }
}

// ============================================================================
// 8.5: Desensitization Rule Engine
// ============================================================================

#[derive(Debug, Clone)]
pub enum DesensitizeRule {
    /// Replace matching pattern with asterisks
    Pattern { name: String, pattern: String, replacement: String, preserve_prefix: usize },
    /// Show first N chars, mask the rest
    PrefixKeep { name: String, keep: usize },
    /// Show last N chars, mask the rest
    SuffixKeep { name: String, keep: usize },
    /// Custom function (regex replace)
    Regex { name: String, pattern: regex::Regex, replacement: String },
}

impl DesensitizeRule {
    pub fn name(&self) -> &str {
        match self {
            Self::Pattern { name, .. }
            | Self::PrefixKeep { name, .. }
            | Self::SuffixKeep { name, .. }
            | Self::Regex { name, .. } => name,
        }
    }

    pub fn apply(&self, value: &str) -> String {
        match self {
            Self::Pattern { pattern, replacement, preserve_prefix, .. } => {
                if *preserve_prefix > 0 && value.len() > *preserve_prefix {
                    let prefix = &value[..*preserve_prefix];
                    let rest: String = value.chars().skip(*preserve_prefix).map(|_| '*').collect();
                    format!("{prefix}{rest}")
                } else if value == pattern {
                    replacement.clone()
                } else if value.contains(pattern) {
                    value.replace(pattern, replacement)
                } else {
                    value.chars().map(|_| '*').collect()
                }
            }
            Self::PrefixKeep { keep, .. } => {
                if value.len() <= *keep {
                    value.to_string()
                } else {
                    let visible: String = value.chars().take(*keep).collect();
                    let rest: String = value.chars().skip(*keep).map(|_| '*').collect();
                    format!("{visible}{rest}")
                }
            }
            Self::SuffixKeep { keep, .. } => {
                if value.len() <= *keep {
                    value.to_string()
                } else {
                    let visible: String =
                        value.chars().rev().take(*keep).collect::<Vec<_>>().into_iter().rev().collect();
                    let rest: String =
                        value.chars().rev().skip(*keep).map(|_| '*').collect::<Vec<_>>().into_iter().rev().collect();
                    format!("{rest}{visible}")
                }
            }
            Self::Regex { pattern, replacement, .. } => pattern.replace_all(value, replacement.as_str()).to_string(),
        }
    }
}

pub struct DesensitizationEngine {
    rules: Vec<DesensitizeRule>,
}

impl DesensitizationEngine {
    pub fn new() -> Self {
        Self { rules: Vec::new() }
    }

    pub fn add_rule(&mut self, rule: DesensitizeRule) -> &mut Self {
        self.rules.push(rule);
        self
    }

    pub fn apply(&self, key: &str, value: &str) -> String {
        for rule in &self.rules {
            if key.contains(rule.name()) || rule.name() == "*" {
                return rule.apply(value);
            }
        }
        value.to_string()
    }

    pub fn apply_to_json(&self, json: &mut serde_json::Value) {
        match json {
            serde_json::Value::Object(map) => {
                for (key, value) in map.iter_mut() {
                    if let serde_json::Value::String(s) = value {
                        let desensitized = self.apply(key, s);
                        *value = serde_json::Value::String(desensitized);
                    } else {
                        self.apply_to_json(value);
                    }
                }
            }
            serde_json::Value::Array(arr) => {
                for item in arr.iter_mut() {
                    self.apply_to_json(item);
                }
            }
            _ => {}
        }
    }

    pub fn default_connection_rules() -> Self {
        let mut engine = Self::new();
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "password".to_string(), keep: 2 });
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "secret".to_string(), keep: 4 });
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "token".to_string(), keep: 4 });
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "connection_string".to_string(), keep: 8 });
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "key".to_string(), keep: 4 });
        engine.add_rule(DesensitizeRule::PrefixKeep { name: "passphrase".to_string(), keep: 2 });
        engine
    }

    pub fn desensitize_connection_config(&self, config: &ConnectionConfig) -> serde_json::Value {
        let mut json = serde_json::to_value(config.clone()).unwrap_or_default();
        self.apply_to_json(&mut json);
        json
    }
}

impl Default for DesensitizationEngine {
    fn default() -> Self {
        Self::default_connection_rules()
    }
}

// ============================================================================
// 8.6: Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("dbx-state-persistence-{name}-{}-{stamp}.db", std::process::id()))
    }

    async fn create_local_backend() -> LocalBackend {
        let path = temp_db_path("local-backend");
        let storage = Arc::new(Storage::open(&path).await.unwrap());
        LocalBackend::new(storage)
    }

    // --- StateBackend CRUD Tests (LocalBackend) ---

    #[tokio::test]
    async fn local_backend_save_and_load() {
        let backend = create_local_backend().await;
        backend.save("test-key", b"hello world").await.unwrap();
        let result = backend.load("test-key").await.unwrap().unwrap();
        assert_eq!(result, b"hello world");
    }

    #[tokio::test]
    async fn local_backend_load_nonexistent() {
        let backend = create_local_backend().await;
        let result = backend.load("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn local_backend_delete() {
        let backend = create_local_backend().await;
        backend.save("delete-key", b"to-delete").await.unwrap();
        assert!(backend.exists("delete-key").await.unwrap());
        backend.delete("delete-key").await.unwrap();
        assert!(!backend.exists("delete-key").await.unwrap());
    }

    #[tokio::test]
    async fn local_backend_overwrite() {
        let backend = create_local_backend().await;
        backend.save("overwrite-key", b"first").await.unwrap();
        backend.save("overwrite-key", b"second").await.unwrap();
        let result = backend.load("overwrite-key").await.unwrap().unwrap();
        assert_eq!(result, b"second");
    }

    #[tokio::test]
    async fn local_backend_binary_data() {
        let backend = create_local_backend().await;
        let binary = vec![0u8, 255, 128, 64, 32, 16, 8, 4, 2, 1];
        backend.save("binary-key", &binary).await.unwrap();
        let result = backend.load("binary-key").await.unwrap().unwrap();
        assert_eq!(result, binary);
    }

    // --- EncryptedPayload Tests ---

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let payload = EncryptedPayload::encrypt(b"sensitive data", "strong-passphrase").unwrap();
        let decrypted = payload.decrypt("strong-passphrase").unwrap();
        assert_eq!(decrypted, b"sensitive data");
    }

    #[test]
    fn encrypt_decrypt_wrong_passphrase_fails() {
        let payload = EncryptedPayload::encrypt(b"sensitive data", "correct-passphrase").unwrap();
        let result = payload.decrypt("wrong-passphrase");
        assert!(result.is_err());
    }

    #[test]
    fn encrypt_decrypt_empty_data() {
        let payload = EncryptedPayload::encrypt(b"", "passphrase").unwrap();
        let decrypted = payload.decrypt("passphrase").unwrap();
        assert!(decrypted.is_empty());
    }

    #[test]
    fn encrypt_decrypt_large_data() {
        let large = vec![0xABu8; 65536];
        let payload = EncryptedPayload::encrypt(&large, "strong-passphrase").unwrap();
        let decrypted = payload.decrypt("strong-passphrase").unwrap();
        assert_eq!(decrypted, large);
    }

    #[test]
    fn unique_nonce_per_encryption() {
        let p1 = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        let p2 = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        assert_ne!(p1.nonce, p2.nonce);
    }

    #[test]
    fn sign_and_verify() {
        let mut payload = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        let signing_key = b"my-signing-key-32-bytes-long!!!";
        payload.sign(signing_key);
        assert!(payload.verify(signing_key));
    }

    #[test]
    fn verify_wrong_key_fails() {
        let mut payload = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        payload.sign(b"correct-key");
        assert!(!payload.verify(b"wrong-key"));
    }

    #[test]
    fn verify_no_signature_fails() {
        let payload = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        assert!(!payload.verify(b"any-key"));
    }

    #[test]
    fn sign_tamper_ciphertext_fails_verification() {
        let mut payload = EncryptedPayload::encrypt(b"data", "pwd").unwrap();
        let signing_key = b"my-signing-key";
        payload.sign(signing_key);

        let mut tampered = payload.clone();
        tampered.ciphertext = base64_engine().encode(b"tampered-data");
        assert!(!tampered.verify(signing_key));
    }

    // --- HMAC-SHA256 Tests ---

    #[test]
    fn hmac_sha256_consistency() {
        let result1 = hmac_sha256(b"key", b"data");
        let result2 = hmac_sha256(b"key", b"data");
        assert_eq!(result1, result2);
    }

    #[test]
    fn hmac_sha256_different_keys_different_results() {
        let r1 = hmac_sha256(b"key1", b"data");
        let r2 = hmac_sha256(b"key2", b"data");
        assert_ne!(r1, r2);
    }

    #[test]
    fn hmac_sha256_long_key() {
        let long_key = vec![0xABu8; 128];
        let _result = hmac_sha256(&long_key, b"data");
    }

    // --- State Machine Tests ---

    #[tokio::test]
    async fn state_machine_create_and_get() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        let entry = sm.create_state("job-1", serde_json::json!({"priority": "high"})).await.unwrap();
        assert_eq!(entry.current_state, "created");
        assert_eq!(entry.version, 1);

        let loaded = sm.get_state("job-1").await.unwrap().unwrap();
        assert_eq!(loaded.current_state, "created");
        assert_eq!(loaded.metadata, serde_json::json!({"priority": "high"}));
    }

    #[tokio::test]
    async fn state_machine_transition_created_to_running() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        sm.create_state("job-2", serde_json::json!({})).await.unwrap();
        let entry = sm.transition("job-2", StateTransition::Running).await.unwrap();
        assert_eq!(entry.current_state, "running");
        assert_eq!(entry.version, 2);
    }

    #[tokio::test]
    async fn state_machine_invalid_transition_fails() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        sm.create_state("job-3", serde_json::json!({})).await.unwrap();
        let result = sm.transition("job-3", StateTransition::Completed).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn state_machine_full_lifecycle() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        sm.create_state("job-4", serde_json::json!({})).await.unwrap();
        sm.transition("job-4", StateTransition::Running).await.unwrap();
        sm.transition("job-4", StateTransition::Completed).await.unwrap();
        let entry = sm.get_state("job-4").await.unwrap().unwrap();
        assert_eq!(entry.current_state, "completed");
    }

    #[tokio::test]
    async fn state_machine_pause_resume() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        sm.create_state("job-5", serde_json::json!({})).await.unwrap();
        sm.transition("job-5", StateTransition::Running).await.unwrap();
        sm.transition("job-5", StateTransition::Paused).await.unwrap();
        let entry = sm.get_state("job-5").await.unwrap().unwrap();
        assert_eq!(entry.current_state, "paused");
        sm.transition("job-5", StateTransition::Running).await.unwrap();
        let entry = sm.get_state("job-5").await.unwrap().unwrap();
        assert_eq!(entry.current_state, "running");
    }

    #[tokio::test]
    async fn state_machine_delete() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        sm.create_state("job-6", serde_json::json!({})).await.unwrap();
        assert!(sm.get_state("job-6").await.unwrap().is_some());
        sm.delete_state("job-6").await.unwrap();
        assert!(sm.get_state("job-6").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn state_machine_cas_success() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        let entry = sm.create_state("cas-key", serde_json::json!({})).await.unwrap();
        let mut new_entry = entry.clone();
        new_entry.current_state = StateTransition::Running.as_str().to_string();
        new_entry.version += 1;
        let success = sm.compare_and_swap_state("cas-key", 1, &new_entry).await.unwrap();
        assert!(success);
        let loaded = sm.get_state("cas-key").await.unwrap().unwrap();
        assert_eq!(loaded.current_state, "running");
        assert_eq!(loaded.version, 2);
    }

    #[tokio::test]
    async fn state_machine_cas_failure() {
        let backend = Arc::new(create_local_backend().await);
        let sm = StateMachine::new(backend);
        let entry = sm.create_state("cas-fail", serde_json::json!({})).await.unwrap();
        let mut new_entry = entry.clone();
        new_entry.current_state = StateTransition::Running.as_str().to_string();
        new_entry.version += 1;
        let success = sm.compare_and_swap_state("cas-fail", 999, &new_entry).await.unwrap();
        assert!(!success);
    }

    // --- is_valid_transition Tests ---

    #[test]
    fn valid_transitions_are_correct() {
        assert!(is_valid_transition(&StateTransition::Created, &StateTransition::Running));
        assert!(is_valid_transition(&StateTransition::Created, &StateTransition::Cancelled));
        assert!(is_valid_transition(&StateTransition::Running, &StateTransition::Paused));
        assert!(is_valid_transition(&StateTransition::Running, &StateTransition::Completed));
        assert!(is_valid_transition(&StateTransition::Running, &StateTransition::Failed));
        assert!(is_valid_transition(&StateTransition::Paused, &StateTransition::Running));
        assert!(is_valid_transition(&StateTransition::Paused, &StateTransition::Cancelled));
        assert!(is_valid_transition(&StateTransition::Completed, &StateTransition::FullyRolledBack));
        assert!(is_valid_transition(&StateTransition::Failed, &StateTransition::Running));
        assert!(is_valid_transition(&StateTransition::Failed, &StateTransition::Cancelled));
    }

    #[test]
    fn invalid_transitions_are_rejected() {
        assert!(!is_valid_transition(&StateTransition::Created, &StateTransition::Completed));
        assert!(!is_valid_transition(&StateTransition::Running, &StateTransition::Created));
        assert!(!is_valid_transition(&StateTransition::Completed, &StateTransition::Running));
        assert!(!is_valid_transition(&StateTransition::Cancelled, &StateTransition::Running));
        assert!(!is_valid_transition(&StateTransition::FullyRolledBack, &StateTransition::Created));
        assert!(!is_valid_transition(&StateTransition::PartiallyRolledBack, &StateTransition::Running));
    }

    // --- Desensitization Engine Tests ---

    #[test]
    fn desensitize_password_prefix_keep() {
        let engine = DesensitizationEngine::default_connection_rules();
        let result = engine.apply("password", "mySecretP@ss!");
        assert_eq!(result, "my***********");
    }

    #[test]
    fn desensitize_token_prefix_keep() {
        let engine = DesensitizationEngine::default_connection_rules();
        let result = engine.apply("token", "eyJhbGciOiJIUzI1NiJ9");
        assert_eq!(result, "eyJh****************");
    }

    #[test]
    fn desensitize_short_password() {
        let engine = DesensitizationEngine::default_connection_rules();
        let result = engine.apply("password", "ab");
        assert_eq!(result, "ab");
    }

    #[test]
    fn desensitize_unknown_field() {
        let engine = DesensitizationEngine::default_connection_rules();
        let result = engine.apply("username", "admin");
        assert_eq!(result, "admin");
    }

    #[test]
    fn desensitize_json_object() {
        let engine = DesensitizationEngine::default_connection_rules();
        let mut json = serde_json::json!({
            "password": "super-secret",
            "username": "admin",
            "token": "abcdef123456",
            "host": "localhost"
        });
        engine.apply_to_json(&mut json);
        assert_eq!(json["password"], "su**********");
        assert_eq!(json["username"], "admin");
        assert_eq!(json["token"], "abcd********");
        assert_eq!(json["host"], "localhost");
    }

    #[test]
    fn desensitize_nested_json() {
        let engine = DesensitizationEngine::default_connection_rules();
        let mut json = serde_json::json!({
            "connection": {
                "password": "nested-secret",
                "details": {
                    "api_key": "key-12345"
                }
            }
        });
        engine.apply_to_json(&mut json);
        assert_eq!(json["connection"]["password"], "ne***********");
        assert_eq!(json["connection"]["details"]["api_key"], "key-*****");
    }

    #[test]
    fn desensitize_prefix_keep_rule() {
        let rule = DesensitizeRule::PrefixKeep { name: "test".to_string(), keep: 3 };
        assert_eq!(rule.apply("abcdef"), "abc***");
        assert_eq!(rule.apply("ab"), "ab");
    }

    #[test]
    fn desensitize_suffix_keep_rule() {
        let rule = DesensitizeRule::SuffixKeep { name: "test".to_string(), keep: 3 };
        assert_eq!(rule.apply("abcdef"), "***def");
        assert_eq!(rule.apply("ab"), "ab");
    }

    #[test]
    fn desensitize_regex_rule() {
        let pattern = regex::Regex::new(r"\d{4}-\d{4}-\d{4}-\d{4}").unwrap();
        let rule = DesensitizeRule::Regex {
            name: "card".to_string(),
            pattern,
            replacement: "****-****-****-****".to_string(),
        };
        assert_eq!(rule.apply("My card: 1234-5678-9012-3456"), "My card: ****-****-****-****");
    }

    #[test]
    fn desensitize_via_json_value() {
        let engine = DesensitizationEngine::default_connection_rules();
        let mut json = serde_json::json!({
            "password": "mySecretPass123",
            "username": "root",
            "host": "localhost"
        });
        engine.apply_to_json(&mut json);
        assert_eq!(json["password"], "my*************");
        assert_eq!(json["username"], "root");
        assert_eq!(json["host"], "localhost");
    }

    // --- StateBackend S3 Constructor Test (no network) ---

    #[test]
    fn s3_backend_constructor() {
        let backend = S3Backend::new("my-bucket", "us-east-1", "AKID", "secret", None, "dbx/state");
        assert_eq!(backend.object_key("test"), "dbx/state/test");
    }

    #[test]
    fn s3_backend_no_prefix() {
        let backend = S3Backend::new("my-bucket", "us-east-1", "AKID", "secret", Some("https://s3.custom.com"), "");
        assert_eq!(backend.object_key("test"), "test");
    }

    // --- Storage CAS Tests ---

    #[tokio::test]
    async fn storage_compare_and_swap_new_key() {
        let path = temp_db_path("cas-new-key");
        let storage = Arc::new(Storage::open(&path).await.unwrap());
        let success = storage.compare_and_swap_state("cas-new", None, b"data", "text/plain").await.unwrap();
        assert!(success);
        let (data, _) = storage.load_state("cas-new").await.unwrap().unwrap();
        assert_eq!(data, b"data");
    }

    #[tokio::test]
    async fn storage_compare_and_swap_exact_version() {
        let path = temp_db_path("cas-exact");
        let storage = Arc::new(Storage::open(&path).await.unwrap());
        storage.save_state("cas-key", b"v1", "text/plain").await.unwrap();
        let version = storage.get_state_version("cas-key").await.unwrap().unwrap();
        assert_eq!(version, 1);

        let success = storage.compare_and_swap_state("cas-key", Some(1), b"v2", "text/plain").await.unwrap();
        assert!(success);
        let (data, _) = storage.load_state("cas-key").await.unwrap().unwrap();
        assert_eq!(data, b"v2");
    }

    #[tokio::test]
    async fn storage_compare_and_swap_wrong_version() {
        let path = temp_db_path("cas-wrong-ver");
        let storage = Arc::new(Storage::open(&path).await.unwrap());
        storage.save_state("cas-key", b"v1", "text/plain").await.unwrap();
        let success = storage.compare_and_swap_state("cas-key", Some(999), b"v2", "text/plain").await.unwrap();
        assert!(!success);
        let (data, _) = storage.load_state("cas-key").await.unwrap().unwrap();
        assert_eq!(data, b"v1");
    }

    // --- Hex helper test ---

    #[test]
    fn hex_encoding() {
        assert_eq!(hex([0x00, 0xFF, 0xAB]), "00ffab");
        assert_eq!(hex([] as [u8; 0]), "");
    }

    // --- Constant time eq test ---

    #[test]
    fn constant_time_eq_works() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
    }
}
