//! Encryption primitives for values persisted in `connection_secrets`.
//!
//! The database deliberately stores only an envelope (`dbxenc1...`) for new
//! values. Desktop builds keep the local key in the operating system
//! credential store (macOS Keychain, Windows Credential Manager, or Linux
//! Secret Service). `DBX_SECRET_KEY` and `DBX_SECRET_KEY_FILE` are supported
//! for headless deployments. A per-user key file remains as a compatibility
//! fallback for installations created before native credential storage was
//! enabled; on key-file-first platforms it may also be provisioned
//! automatically when no credential store is reachable. The key is always
//! outside the database and never enters a sync file.

use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;

const PREFIX: &str = "dbxenc1";
#[cfg(feature = "os-keyring")]
const KEYRING_SERVICE: &str = "com.dbx.app.secret-store.v1";
#[cfg(feature = "os-keyring")]
const KEYRING_USER: &str = "local-data-encryption-key";
// Secret Service attribute layout written by the keyring crate (the desktop
// writer): target is always present and defaults to "default"; entries from
// older keyring versions may lack it, so lookups fall back to the two-attribute
// search.
#[cfg(all(feature = "os-keyring", target_os = "linux"))]
const KEYRING_TARGET: &str = "default";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKeyPolicy {
    PlatformDefault,
    ManagedDataDir,
    ExternalOnly,
    #[cfg(any(test, feature = "test-support"))]
    TestDataDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKeySource {
    ExplicitFile,
    ExplicitEnv,
    ManagedDataDir,
    PlatformStore,
    Unavailable,
}

impl SecretKeySource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitFile => "explicit_file",
            Self::ExplicitEnv => "explicit_env",
            Self::ManagedDataDir => "managed_data_dir",
            Self::PlatformStore => "platform_store",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Clone, Copy)]
pub struct SecretKeyResolution {
    pub codec: SecretCodec,
    pub source: SecretKeySource,
}

#[derive(Clone, Copy)]
pub struct SecretCodec {
    key: [u8; 32],
}

impl SecretCodec {
    pub const fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    /// Build a codec from a high-entropy passphrase using Argon2id.
    pub fn from_passphrase(passphrase: &str) -> Result<Self, String> {
        if passphrase.is_empty() {
            return Err("secret key cannot be empty".to_string());
        }
        let mut key = [0u8; 32];
        let params = Params::new(19 * 1024, 2, 1, Some(32)).map_err(|e| e.to_string())?;
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(passphrase.as_bytes(), b"dbx-local-secret-store-v1", &mut key)
            .map_err(|e| e.to_string())?;
        Ok(Self::new(key))
    }

    /// Resolve the configured key without exposing key material in errors.
    /// `allow_create` is intentionally explicit so status checks remain read-only.
    pub fn resolve(
        policy: SecretKeyPolicy,
        data_dir: &std::path::Path,
        allow_create: bool,
    ) -> Result<SecretKeyResolution, String> {
        Self::resolve_with_env(policy, data_dir, allow_create, |name| std::env::var_os(name))
    }

    /// [`Self::resolve`] with the environment lookup injected. `DBX_SECRET_KEY`
    /// and `DBX_SECRET_KEY_FILE` are process global, so tests drive the explicit
    /// key branches through here instead of mutating the environment: a mutation
    /// in flight would silently change the key every other test in the same
    /// binary resolves, and the tests that encrypt with one key would fail to
    /// decrypt once it is restored.
    fn resolve_with_env<F>(
        policy: SecretKeyPolicy,
        data_dir: &std::path::Path,
        allow_create: bool,
        env_lookup: F,
    ) -> Result<SecretKeyResolution, String>
    where
        F: Fn(&str) -> Option<std::ffi::OsString>,
    {
        #[cfg(any(test, feature = "test-support"))]
        if matches!(policy, SecretKeyPolicy::TestDataDir) {
            return Self::resolve_managed_data_dir(data_dir, allow_create);
        }
        if let Some(path) = env_lookup("DBX_SECRET_KEY_FILE") {
            let path = std::path::PathBuf::from(path);
            let codec = Self::read_key_file(&path, false)?;
            return Ok(SecretKeyResolution { codec, source: SecretKeySource::ExplicitFile });
        }
        if let Some(value) = env_lookup("DBX_SECRET_KEY") {
            let value = value.to_str().ok_or_else(|| "SECRET_KEY_INVALID".to_string())?;
            let codec = Self::from_key_material(value.trim()).map_err(|_| "SECRET_KEY_INVALID".to_string())?;
            return Ok(SecretKeyResolution { codec, source: SecretKeySource::ExplicitEnv });
        }

        match policy {
            SecretKeyPolicy::ManagedDataDir => Self::resolve_managed_data_dir(data_dir, allow_create),
            SecretKeyPolicy::ExternalOnly => Err("MISSING_EXTERNAL_KEY".to_string()),
            #[cfg(any(test, feature = "test-support"))]
            SecretKeyPolicy::TestDataDir => Self::resolve_managed_data_dir(data_dir, allow_create),
            SecretKeyPolicy::PlatformDefault => {
                Self::resolve_platform_default(default_key_path(), allow_create, platform_keyring_codec)
            }
        }
    }

    fn resolve_managed_data_dir(data_dir: &std::path::Path, allow_create: bool) -> Result<SecretKeyResolution, String> {
        let path = managed_key_path(data_dir);
        match path.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_symlink() => Err("KEY_FILE_UNAVAILABLE".to_string()),
            Ok(_) => {
                if allow_create {
                    secure_managed_key_permissions(&path)?;
                }
                let codec = read_key_file_with_retry(&path, true)?;
                Ok(SecretKeyResolution { codec, source: SecretKeySource::ManagedDataDir })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_create => {
                let codec = create_managed_key(&path)?;
                Ok(SecretKeyResolution { codec, source: SecretKeySource::ManagedDataDir })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err("MISSING_MANAGED_KEY".to_string()),
            Err(_) => Err("KEY_FILE_UNAVAILABLE".to_string()),
        }
    }

    fn resolve_platform_default<F>(
        compatibility_path: Option<std::path::PathBuf>,
        allow_create: bool,
        platform_provider: F,
    ) -> Result<SecretKeyResolution, String>
    where
        F: FnOnce(bool) -> Result<Option<SecretCodec>, String>,
    {
        let compatibility_error = if let Some(path) = compatibility_path.as_ref().filter(|path| path.exists()) {
            // Another process may have just created this file and not finished
            // writing it yet; retry briefly before treating it as corrupt.
            match read_key_file_with_retry(path, false) {
                Ok(codec) => return Ok(SecretKeyResolution { codec, source: SecretKeySource::ManagedDataDir }),
                Err(error) => Some(error),
            }
        } else {
            None
        };
        // A keychain item that exists but cannot be read must not silently
        // fall through to provisioning a brand-new key, which would strand the
        // existing ciphertext behind the wrong key.
        match platform_provider(allow_create) {
            Ok(Some(codec)) => return Ok(SecretKeyResolution { codec, source: SecretKeySource::PlatformStore }),
            Ok(None) => {}
            Err(detail) => return Err(detail),
        }
        if let Some(error) = compatibility_error {
            return Err(error);
        }
        // Auto-provisioning the per-user fallback key is reserved for
        // key-file platforms (Linux without a reachable Secret Service). On
        // macOS and Windows the OS credential store is canonical: when the
        // platform provider is absent (keyring feature compiled out, e.g.
        // `--no-default-features` runs), writing a competing global key file
        // next to real installations would strand them behind the wrong key,
        // because this file outranks the keychain on every later launch.
        // Test builds are exempt so unit tests keep working without the
        // native backend; `default_key_path` sandboxes their key to the
        // system temp directory in that case.
        #[cfg(any(not(any(target_os = "macos", target_os = "windows")), test))]
        if allow_create {
            if let Some(path) = compatibility_path {
                let codec = create_key_file(&path, false)?;
                return Ok(SecretKeyResolution { codec, source: SecretKeySource::ManagedDataDir });
            }
        }
        Err("KEY_PROVIDER_UNAVAILABLE".to_string())
    }

    /// Read an explicitly configured key, then an existing compatibility key
    /// file, then the platform credential store. The file is checked before
    /// creating a new keyring entry so upgrades cannot strand an existing
    /// database behind a newly generated device key.
    pub fn from_env_or_default() -> Result<Self, String> {
        Self::resolve(SecretKeyPolicy::PlatformDefault, std::path::Path::new("."), true).map(|resolved| resolved.codec)
    }

    /// Inspect existing key material without creating files or keyring entries.
    /// Headless migration must use an explicitly configured persistent key.
    pub fn from_existing_provider(require_external: bool) -> Result<Self, String> {
        let policy = if require_external { SecretKeyPolicy::ExternalOnly } else { SecretKeyPolicy::PlatformDefault };
        Self::resolve(policy, std::path::Path::new("."), false).map(|resolved| resolved.codec)
    }

    /// Provision only after a read-only probe found no usable provider. This
    /// is called by the desktop migration wizard only for plaintext-only
    /// legacy data; headless callers never use it. If the platform keyring is
    /// unavailable, the documented per-user key-file fallback keeps Linux
    /// desktop upgrades recoverable without putting a key in SQLite.
    pub fn provision_for_migration() -> Result<Self, String> {
        Self::resolve(SecretKeyPolicy::PlatformDefault, std::path::Path::new("."), true).map(|resolved| resolved.codec)
    }

    fn read_key_file(path: &std::path::Path, reject_symlink: bool) -> Result<Self, String> {
        let metadata = if reject_symlink { path.symlink_metadata() } else { path.metadata() }
            .map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
        if (reject_symlink && metadata.file_type().is_symlink()) || !metadata.is_file() {
            return Err("KEY_FILE_UNAVAILABLE".to_string());
        }
        let value = std::fs::read_to_string(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                "SECRET_KEY_INVALID"
            } else {
                "KEY_FILE_UNAVAILABLE"
            }
        })?;
        Self::from_key_material(value.trim()).map_err(|_| "SECRET_KEY_INVALID".to_string())
    }

    fn from_key_material(value: &str) -> Result<Self, String> {
        if let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value) {
            if bytes.len() == 32 {
                return bytes.try_into().map(Self::new).map_err(|_| "invalid key".into());
            }
        }
        if value.is_ascii() && value.len() == 64 {
            let mut out = [0u8; 32];
            for (i, slot) in out.iter_mut().enumerate() {
                *slot = u8::from_str_radix(&value[i * 2..i * 2 + 2], 16).map_err(|_| "invalid hex key")?;
            }
            return Ok(Self::new(out));
        }
        Self::from_passphrase(value)
    }

    pub fn encrypt(&self, namespace: &str, key: &str, plaintext: &str) -> Result<String, String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|e| e.to_string())?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload { msg: plaintext.as_bytes(), aad: aad(namespace, key).as_bytes() },
            )
            .map_err(|_| "secret encryption failed".to_string())?;
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        Ok(format!("{PREFIX}.{}.{}", b64.encode(nonce), b64.encode(ciphertext)))
    }

    pub fn decrypt(&self, namespace: &str, key: &str, envelope: &str) -> Result<String, String> {
        let mut parts = envelope.split('.');
        if parts.next() != Some(PREFIX) {
            return Err("unsupported secret envelope".to_string());
        }
        let nonce = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts.next().ok_or("invalid secret envelope")?)
            .map_err(|_| "invalid secret nonce".to_string())?;
        let ciphertext = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(parts.next().ok_or("invalid secret envelope")?)
            .map_err(|_| "invalid secret ciphertext".to_string())?;
        if parts.next().is_some() || nonce.len() != 12 {
            return Err("invalid secret envelope".to_string());
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|e| e.to_string())?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                aes_gcm::aead::Payload { msg: &ciphertext, aad: aad(namespace, key).as_bytes() },
            )
            .map_err(|_| "secret decryption failed".to_string())?;
        String::from_utf8(plaintext).map_err(|_| "secret is not valid UTF-8".to_string())
    }
}

#[cfg(all(feature = "os-keyring", any(target_os = "macos", target_os = "windows")))]
fn platform_keyring_codec(allow_create: bool) -> Result<Option<SecretCodec>, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("keyring entry unavailable: {error}"))?;
    match entry.get_password() {
        Ok(value) => return Ok(SecretCodec::from_key_material(value.trim()).ok()),
        Err(keyring::Error::NoEntry) => {}
        // Distinguish a present-but-unreadable keychain item (ACL denial,
        // locked keychain) from a missing one: callers surface this class in
        // diagnostics instead of the generic provider-unavailable code.
        Err(error) => return Err(format!("KEYRING_ACCESS_FAILED: {error}")),
    }
    if !allow_create {
        return Ok(None);
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
    entry.set_password(&encoded).map_err(|error| format!("KEYRING_WRITE_FAILED: {error}"))?;
    Ok(Some(SecretCodec::new(key)))
}

#[cfg(all(feature = "os-keyring", target_os = "linux"))]
fn platform_keyring_codec(allow_create: bool) -> Result<Option<SecretCodec>, String> {
    run_secret_service_operation(move || secret_service_keyring_codec(allow_create))
}

#[cfg(any(test, all(feature = "os-keyring", target_os = "linux")))]
fn run_secret_service_operation<F>(operation: F) -> Result<Option<SecretCodec>, String>
where
    F: FnOnce() -> Result<Option<SecretCodec>, String> + Send + 'static,
{
    let worker = std::thread::Builder::new()
        .name("dbx-secret-service".to_string())
        .spawn(operation)
        .map_err(|_| "KEYRING_ACCESS_FAILED: secret service worker unavailable".to_string())?;
    worker.join().map_err(|_| "KEYRING_ACCESS_FAILED: secret service worker failed".to_string())?
}

#[cfg(all(feature = "os-keyring", target_os = "linux"))]
fn secret_service_keyring_codec(allow_create: bool) -> Result<Option<SecretCodec>, String> {
    use secret_service::{blocking::SecretService, EncryptionType};
    use std::collections::HashMap;

    // A missing session bus (headless server/container) means the provider is
    // absent rather than broken; return None so callers fall back to the
    // managed .dbx/secret.key file exactly as before.
    let service = match SecretService::connect(EncryptionType::Dh) {
        Ok(service) => service,
        Err(_) => return Ok(None),
    };
    let collection = match service.get_default_collection() {
        Ok(collection) => collection,
        Err(_) => return Ok(None),
    };
    let mut attributes = HashMap::new();
    attributes.insert("target", KEYRING_TARGET);
    attributes.insert("service", KEYRING_SERVICE);
    attributes.insert("username", KEYRING_USER);
    let mut found = collection
        .search_items(attributes)
        .map_err(|error| format!("KEYRING_ACCESS_FAILED: secret search failed: {error}"))?;
    if found.is_empty() {
        let mut legacy = HashMap::new();
        legacy.insert("service", KEYRING_SERVICE);
        legacy.insert("username", KEYRING_USER);
        found = collection
            .search_items(legacy)
            .map_err(|error| format!("KEYRING_ACCESS_FAILED: secret search failed: {error}"))?;
    }
    let item = found.into_iter().next();
    match item {
        Some(item) => {
            let secret =
                item.get_secret().map_err(|error| format!("KEYRING_ACCESS_FAILED: secret read failed: {error}"))?;
            let material = String::from_utf8(secret).map_err(|_| "SECRET_KEY_INVALID".to_string())?;
            Ok(SecretCodec::from_key_material(material.trim()).ok())
        }
        None if allow_create => {
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
            let mut created = HashMap::new();
            created.insert("target", KEYRING_TARGET);
            created.insert("service", KEYRING_SERVICE);
            created.insert("username", KEYRING_USER);
            collection
                .create_item("DBX secret-store key", created, encoded.as_bytes(), true, "text/plain")
                .map_err(|error| format!("KEYRING_WRITE_FAILED: {error}"))?;
            Ok(Some(SecretCodec::new(key)))
        }
        None => Ok(None),
    }
}

#[cfg(not(feature = "os-keyring"))]
fn platform_keyring_codec(_allow_create: bool) -> Result<Option<SecretCodec>, String> {
    // Cross/server builds compile without the OS keyring backend; the managed
    // .dbx/secret.key file remains the key material source.
    Ok(None)
}

fn create_managed_key(path: &std::path::Path) -> Result<SecretCodec, String> {
    let parent = path.parent().ok_or_else(|| "KEY_FILE_UNAVAILABLE".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
    }
    create_key_file(path, true)
}

fn secure_managed_key_permissions(path: &std::path::Path) -> Result<(), String> {
    if path.symlink_metadata().map_or(true, |metadata| metadata.file_type().is_symlink() || !metadata.is_file()) {
        return Err("KEY_FILE_UNAVAILABLE".to_string());
    }
    let parent = path.parent().ok_or_else(|| "KEY_FILE_UNAVAILABLE".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
    }
    Ok(())
}

fn create_key_file(path: &std::path::Path, managed: bool) -> Result<SecretCodec, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "KEY_FILE_UNAVAILABLE".to_string())?;
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key);
    let write_result = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path).and_then(|mut file| {
                std::io::Write::write_all(&mut file, encoded.as_bytes())?;
                file.sync_all()
            })
        }
        #[cfg(not(unix))]
        {
            std::fs::OpenOptions::new().write(true).create_new(true).open(path).and_then(|mut file| {
                std::io::Write::write_all(&mut file, encoded.as_bytes())?;
                file.sync_all()
            })
        }
    };
    if write_result.is_ok() {
        return SecretCodec::read_key_file(path, managed);
    }
    match path.symlink_metadata() {
        Ok(metadata) if managed && metadata.file_type().is_symlink() => Err("KEY_FILE_UNAVAILABLE".to_string()),
        // The winner of the `create_new` race may still be mid-write, so read
        // through the same retry loop the managed key path uses.
        Ok(_) => read_key_file_with_retry(path, managed),
        Err(_) => Err("KEY_FILE_UNAVAILABLE".to_string()),
    }
}

pub fn managed_key_path(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join(".dbx").join("secret.key")
}

/// Every file that can supply key material on its own, in resolution order.
/// Callers that cache a resolved codec can digest these paths to notice a key
/// file that was added, replaced, or removed afterwards.
pub fn key_file_candidates(data_dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("DBX_SECRET_KEY_FILE") {
        paths.push(std::path::PathBuf::from(path));
    }
    if let Some(path) = default_key_path() {
        paths.push(path);
    }
    paths.push(managed_key_path(data_dir));
    paths
}

fn read_key_file_with_retry(path: &std::path::Path, reject_symlink: bool) -> Result<SecretCodec, String> {
    let mut last_error = "KEY_FILE_UNAVAILABLE".to_string();
    for attempt in 0..20 {
        match SecretCodec::read_key_file(path, reject_symlink) {
            Ok(codec) => return Ok(codec),
            Err(error) => {
                let retryable = attempt < 19 && error == "SECRET_KEY_INVALID" && path.metadata().is_ok();
                last_error = error;
                if !retryable {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }
    // Surface what the file actually said: callers tell a corrupt key
    // (SECRET_KEY_INVALID) apart from an unreadable one, and retrying must not
    // blur that distinction once the retries are exhausted.
    Err(last_error)
}

fn default_key_path() -> Option<std::path::PathBuf> {
    // Unit tests must never read or create the developer's real per-user key
    // file; their auto-provisioned fallback lives in the system temp dir.
    #[cfg(test)]
    {
        Some(std::env::temp_dir().join("dbx-test-secret.key"))
    }
    #[cfg(not(test))]
    {
        #[cfg(target_os = "macos")]
        if let Ok(home) = std::env::var("HOME") {
            return Some(std::path::PathBuf::from(home).join("Library/Application Support/dbx/secret.key"));
        }
        if let Ok(config) = std::env::var("XDG_CONFIG_HOME") {
            return Some(std::path::PathBuf::from(config).join("dbx/secret.key"));
        }
        std::env::var_os("APPDATA").map(std::path::PathBuf::from).map(|path| path.join("dbx/secret.key")).or_else(
            || std::env::var_os("HOME").map(std::path::PathBuf::from).map(|path| path.join(".config/dbx/secret.key")),
        )
    }
}

fn aad(namespace: &str, key: &str) -> String {
    format!("dbx-secret-v1\0{namespace}\0{key}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn isolated_test_policy_never_reads_process_credentials() {
        let directory = tempfile::tempdir().unwrap();
        let resolved =
            super::SecretCodec::resolve_with_env(super::SecretKeyPolicy::TestDataDir, directory.path(), true, |_| {
                panic!("test storage must not inspect process credential overrides")
            })
            .unwrap();
        assert_eq!(resolved.source, super::SecretKeySource::ManagedDataDir);
        assert!(super::managed_key_path(directory.path()).is_file());
    }

    use super::{
        managed_key_path, read_key_file_with_retry, run_secret_service_operation, SecretCodec, SecretKeyPolicy,
        SecretKeySource,
    };
    use base64::Engine as _;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn assert_secret_service_runtime_isolated() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        let original = SecretCodec::new([7u8; 32]);
        let envelope = original.encrypt("connection", "password", "existing secret").unwrap();
        let resolved = SecretCodec::resolve_platform_default(Some(path.clone()), true, |_| {
            run_secret_service_operation(|| {
                let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
                runtime.block_on(async { Ok(Some(SecretCodec::new([7u8; 32]))) })
            })
        })
        .unwrap();
        assert_eq!(resolved.source, SecretKeySource::PlatformStore);
        assert_eq!(resolved.codec.decrypt("connection", "password", &envelope).unwrap(), "existing secret");
        assert!(!path.exists());
    }

    #[test]
    fn secret_service_worker_supports_synchronous_callers() {
        assert_secret_service_runtime_isolated();
    }

    #[tokio::test]
    async fn secret_service_worker_isolates_current_thread_runtime() {
        assert_secret_service_runtime_isolated();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn secret_service_worker_isolates_multi_thread_runtime() {
        assert_secret_service_runtime_isolated();
    }

    #[tokio::test]
    async fn secret_service_worker_preserves_missing_provider() {
        assert!(matches!(run_secret_service_operation(|| Ok(None)), Ok(None)));
    }

    #[tokio::test]
    async fn secret_service_worker_preserves_access_errors_without_creating_a_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        let result = SecretCodec::resolve_platform_default(Some(path.clone()), true, |_| {
            run_secret_service_operation(|| Err("KEYRING_ACCESS_FAILED: locked collection".to_string()))
        });
        assert!(matches!(result, Err(error) if error == "KEYRING_ACCESS_FAILED: locked collection"));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn secret_service_worker_panics_do_not_create_a_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        let result = SecretCodec::resolve_platform_default(Some(path.clone()), true, |_| {
            run_secret_service_operation(|| panic!("secret service failed"))
        });
        assert!(matches!(result, Err(error) if error == "KEYRING_ACCESS_FAILED: secret service worker failed"));
        assert!(!path.exists());
    }

    #[cfg(all(feature = "os-keyring", target_os = "linux"))]
    #[test]
    fn linux_keyring_missing_bus_is_safe_for_sync_and_async_callers() {
        let _guard = env_lock().lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let previous_bus = std::env::var_os("DBUS_SESSION_BUS_ADDRESS");
        std::env::set_var(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={}", directory.path().join("missing-bus").display()),
        );
        let mut results = vec![super::platform_keyring_codec(false)];
        for runtime in [
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap(),
            tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap(),
        ] {
            results.push(runtime.block_on(async { super::platform_keyring_codec(false) }));
        }
        restore_env("DBUS_SESSION_BUS_ADDRESS", previous_bus);
        for result in results {
            assert!(matches!(result, Ok(None)));
        }
    }

    #[test]
    fn roundtrip_binds_namespace_and_key() {
        let codec = SecretCodec::new([7u8; 32]);
        let envelope = codec.encrypt("connection-1", "password", "s3cret").unwrap();
        assert!(envelope.starts_with("dbxenc1."));
        assert_eq!(codec.decrypt("connection-1", "password", &envelope).unwrap(), "s3cret");
        assert!(codec.decrypt("connection-2", "password", &envelope).is_err());
        assert!(codec.decrypt("connection-1", "token", &envelope).is_err());
    }

    #[test]
    fn unicode_key_material_never_slices_inside_a_character() {
        // 64 bytes, with the second byte inside a three-byte character.
        let material = format!("{}a", "密".repeat(21));
        assert_eq!(material.len(), 64);
        let codec = SecretCodec::from_key_material(&material).unwrap();
        let encrypted = codec.encrypt("n", "k", "value").unwrap();
        assert_eq!(codec.decrypt("n", "k", &encrypted).unwrap(), "value");
    }

    #[test]
    fn tampering_is_rejected() {
        let codec = SecretCodec::new([3u8; 32]);
        let mut envelope = codec.encrypt("n", "k", "value").unwrap();
        envelope.push('x');
        assert!(codec.decrypt("n", "k", &envelope).is_err());
    }

    #[test]
    fn managed_key_is_created_idempotently_with_restricted_permissions() {
        let _guard = env_lock().lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let first = SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, dir.path(), true).unwrap();
        let second = SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, dir.path(), false).unwrap();
        assert_eq!(first.source, SecretKeySource::ManagedDataDir);
        assert_eq!(second.source, SecretKeySource::ManagedDataDir);
        let envelope = first.codec.encrypt("n", "k", "value").unwrap();
        assert_eq!(second.codec.decrypt("n", "k", &envelope).unwrap(), "value");
        assert!(managed_key_path(dir.path()).is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let key_dir = dir.path().join(".dbx");
            let key_path = managed_key_path(dir.path());
            assert_eq!(std::fs::metadata(&key_dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);

            std::fs::set_permissions(&key_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o644)).unwrap();
            SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, dir.path(), false).unwrap();
            assert_eq!(std::fs::metadata(&key_dir).unwrap().permissions().mode() & 0o777, 0o755);
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o644);
            SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, dir.path(), true).unwrap();
            assert_eq!(std::fs::metadata(&key_dir).unwrap().permissions().mode() & 0o777, 0o700);
            assert_eq!(std::fs::metadata(&key_path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn managed_key_creation_is_safe_for_concurrent_starters() {
        let _guard = env_lock().lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let paths = (0..8).map(|_| dir.path().to_path_buf()).collect::<Vec<_>>();
        let threads = paths
            .into_iter()
            .map(|path| {
                std::thread::spawn(move || SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, &path, true).unwrap())
            })
            .collect::<Vec<_>>();
        let resolutions = threads.into_iter().map(|thread| thread.join().unwrap()).collect::<Vec<_>>();
        let envelope = resolutions[0].codec.encrypt("n", "k", "value").unwrap();
        for resolution in resolutions {
            assert_eq!(resolution.codec.decrypt("n", "k", &envelope).unwrap(), "value");
        }
    }

    #[test]
    fn compatibility_key_still_being_written_by_a_concurrent_starter_is_retried() {
        // The shared compatibility path (`~/.config/dbx/secret.key`) is global, so
        // two starters can race: the `create_new` winner leaves an empty file on
        // disk for a moment. A reader that gives up immediately reports
        // SECRET_KEY_INVALID for a key that is fine a millisecond later.
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        std::fs::write(&path, "").unwrap();
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            let material = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
            std::fs::write(&writer_path, material).unwrap();
        });

        // allow_create=false covers the read-only probe every write goes through;
        // allow_create=true covers the losing side of the create_new race.
        for allow_create in [false, true] {
            let resolved =
                SecretCodec::resolve_platform_default(Some(path.clone()), allow_create, |_| Ok(None)).unwrap();
            assert_eq!(resolved.source, SecretKeySource::ManagedDataDir);
            let expected = SecretCodec::new([7u8; 32]);
            let envelope = expected.encrypt("n", "k", "value").unwrap();
            assert_eq!(resolved.codec.decrypt("n", "k", &envelope).unwrap(), "value");
        }
        writer.join().unwrap();
    }

    #[test]
    fn exhausted_key_file_retries_keep_the_original_error_code() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        std::fs::write(&path, "\n").unwrap();
        // A key file that stays corrupt must not be laundered into the generic
        // "unavailable" code: the migration preflight reports Invalid vs
        // Unavailable differently.
        assert!(matches!(read_key_file_with_retry(&path, false), Err(error) if error == "SECRET_KEY_INVALID"));
    }

    #[cfg(unix)]
    #[test]
    fn managed_key_symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let _guard = env_lock().lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.key");
        std::fs::write(&real, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4u8; 32])).unwrap();
        let key_path = managed_key_path(dir.path());
        std::fs::create_dir_all(key_path.parent().unwrap()).unwrap();
        symlink(&real, &key_path).unwrap();
        assert!(matches!(
            SecretCodec::resolve(SecretKeyPolicy::ManagedDataDir, dir.path(), false),
            Err(error) if error == "KEY_FILE_UNAVAILABLE"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn explicit_key_file_symlink_is_allowed() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.key");
        let link = dir.path().join("external.key");
        std::fs::write(&real, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([5u8; 32])).unwrap();
        symlink(&real, &link).unwrap();

        let resolved = SecretCodec::resolve_with_env(
            SecretKeyPolicy::ManagedDataDir,
            dir.path(),
            false,
            explicit_env(&[("DBX_SECRET_KEY_FILE", std::ffi::OsString::from(&link))]),
        )
        .unwrap();
        assert_eq!(resolved.source, SecretKeySource::ExplicitFile);
    }

    #[cfg(unix)]
    #[test]
    fn invalid_non_utf8_explicit_environment_key_does_not_fallback() {
        use std::os::unix::ffi::OsStringExt;
        let dir = tempfile::tempdir().unwrap();
        let invalid = std::ffi::OsString::from_vec(vec![0xff, 0xfe]);
        assert!(matches!(
            SecretCodec::resolve_with_env(
                SecretKeyPolicy::ManagedDataDir,
                dir.path(),
                true,
                explicit_env(&[("DBX_SECRET_KEY", invalid)])
            ),
            Err(error) if error == "SECRET_KEY_INVALID"
        ));
    }

    #[test]
    fn unavailable_platform_probe_does_not_create_a_fallback_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        let result = SecretCodec::resolve_platform_default(Some(path.clone()), false, |allow_create| {
            assert!(!allow_create);
            Ok(None)
        });
        assert!(matches!(result, Err(error) if error == "KEY_PROVIDER_UNAVAILABLE"));
        assert!(!path.exists());
    }

    #[test]
    fn unavailable_platform_creation_uses_a_stable_fallback_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        let created = SecretCodec::resolve_platform_default(Some(path.clone()), true, |allow_create| {
            assert!(allow_create);
            Ok(None)
        })
        .unwrap();
        let envelope = created.codec.encrypt("connection", "password", "secret").unwrap();
        let original = std::fs::read(&path).unwrap();
        let reopened = SecretCodec::resolve_platform_default(Some(path.clone()), true, |_| {
            panic!("an existing compatibility key must take precedence over the platform provider")
        })
        .unwrap();
        assert_eq!(reopened.source, SecretKeySource::ManagedDataDir);
        assert_eq!(reopened.codec.decrypt("connection", "password", &envelope).unwrap(), "secret");
        assert_eq!(std::fs::read(path).unwrap(), original);
    }

    #[test]
    fn unavailable_platform_provider_does_not_replace_a_corrupt_fallback_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("secret.key");
        std::fs::write(&path, "\n").unwrap();
        for allow_create in [false, true] {
            let result = SecretCodec::resolve_platform_default(Some(path.clone()), allow_create, |_| Ok(None));
            assert!(matches!(result, Err(error) if error == "SECRET_KEY_INVALID"));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "\n");
        }
    }

    #[test]
    fn platform_default_falls_back_after_corrupt_compatibility_file() {
        let dir = tempfile::tempdir().unwrap();
        let compatibility_path = dir.path().join("secret.key");
        std::fs::write(&compatibility_path, "\n").unwrap();

        let resolution = SecretCodec::resolve_platform_default(Some(compatibility_path), false, |_| {
            Ok(Some(SecretCodec::new([9u8; 32])))
        })
        .unwrap();

        assert_eq!(resolution.source, SecretKeySource::PlatformStore);
        let envelope = resolution.codec.encrypt("n", "k", "value").unwrap();
        assert_eq!(resolution.codec.decrypt("n", "k", &envelope).unwrap(), "value");
    }

    #[test]
    fn explicit_sources_follow_precedence_without_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("external.key");
        let env_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([2u8; 32]);
        let resolve = |allow_create: bool, entries: &[(&str, std::ffi::OsString)]| {
            let env = explicit_env(entries);
            SecretCodec::resolve_with_env(SecretKeyPolicy::ManagedDataDir, dir.path(), allow_create, env)
        };

        // Nothing explicit is configured, so the managed data-dir key is provisioned.
        resolve(true, &[]).unwrap();

        // A corrupt explicit file outranks a valid explicit key and must not fall back.
        std::fs::write(&file, "\n").unwrap();
        let both = [
            ("DBX_SECRET_KEY_FILE", std::ffi::OsString::from(&file)),
            ("DBX_SECRET_KEY", std::ffi::OsString::from(env_key.as_str())),
        ];
        assert!(matches!(resolve(false, &both), Err(error) if error == "SECRET_KEY_INVALID"));

        std::fs::write(&file, base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 32])).unwrap();
        assert_eq!(resolve(false, &both).unwrap().source, SecretKeySource::ExplicitFile);

        let key_only = [("DBX_SECRET_KEY", std::ffi::OsString::from(env_key.as_str()))];
        assert_eq!(resolve(false, &key_only).unwrap().source, SecretKeySource::ExplicitEnv);
    }

    /// Environment lookup for [`SecretCodec::resolve_with_env`] that never
    /// touches the process environment, so these tests cannot change the key
    /// another test in the same binary resolves while they run.
    fn explicit_env<'a>(
        entries: &'a [(&'a str, std::ffi::OsString)],
    ) -> impl Fn(&str) -> Option<std::ffi::OsString> + 'a {
        move |name| entries.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone())
    }
}
