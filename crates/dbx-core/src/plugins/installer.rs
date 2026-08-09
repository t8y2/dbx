use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use chrono::Utc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{InstalledPlugin, InstalledPluginInfo, PluginManifest};

pub const DBXP_EXTENSION: &str = "dbxp";
pub const PLUGIN_CHECKSUMS_FILE: &str = "checksums.json";
pub const PLUGIN_SIGNATURE_FILE: &str = "signature.json";

pub const MAX_PLUGIN_PACKAGE_BYTES: usize = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const INSTALL_LOCK_FILE: &str = ".install.lock";
const VERSIONS_DIR: &str = "versions";
const ACTIVATIONS_DIR: &str = "activations";
const TRUST_DIR: &str = ".trust";
const TRUST_KEYS_FILE: &str = "keys.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PluginInstallPolicy {
    LocalSigned,
    LocalDevelopment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PluginSignatureStatus {
    Trusted { key_id: String },
    Unsigned,
}

#[derive(Debug, Clone)]
pub struct PluginInstallResult {
    pub plugin: InstalledPlugin,
    pub previous_version: Option<String>,
    pub package_sha256: String,
    pub signature: PluginSignatureStatus,
}

#[derive(Debug, Clone)]
pub struct PluginRollbackResult {
    pub plugin: InstalledPlugin,
    pub previous_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResponse {
    pub plugin: InstalledPluginInfo,
    pub previous_version: Option<String>,
    pub package_sha256: String,
    pub signature: PluginSignatureStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRollbackResponse {
    pub plugin: InstalledPluginInfo,
    pub previous_version: String,
}

impl PluginInstallResult {
    pub fn response(&self) -> PluginInstallResponse {
        PluginInstallResponse {
            plugin: self.plugin.info(),
            previous_version: self.previous_version.clone(),
            package_sha256: self.package_sha256.clone(),
            signature: self.signature.clone(),
        }
    }
}

impl PluginRollbackResult {
    pub fn response(&self) -> PluginRollbackResponse {
        PluginRollbackResponse { plugin: self.plugin.info(), previous_version: self.previous_version.clone() }
    }
}

#[derive(Debug, Clone, Default)]
pub struct PluginTrustStore {
    keys: BTreeMap<String, VerifyingKey>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginTrustedKey {
    pub key_id: String,
    pub public_key: String,
}

#[derive(Debug, Deserialize, Serialize, Default)]
struct PluginTrustDocument {
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct PluginPackageChecksums {
    algorithm: String,
    files: BTreeMap<String, String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PluginPackageSignature {
    algorithm: String,
    key_id: String,
    signature: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginActivationRecord {
    sequence: u64,
    version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_version: Option<String>,
    package_sha256: String,
    activated_at: String,
}

pub struct PluginPackageInstaller {
    root_dir: PathBuf,
    app_version: String,
    trust_store: Arc<PluginTrustStore>,
}

#[derive(Debug, Clone)]
pub(super) struct PluginPackageExpectation {
    pub id: String,
    pub version: String,
    pub publisher: String,
    pub permissions: BTreeSet<String>,
    pub signing_key_id: String,
}

impl PluginTrustStore {
    pub fn load(root_dir: &Path) -> Result<Self, String> {
        let document = read_trust_document(root_dir)?;
        Self::from_base64_keys(document.keys)
    }

    pub fn list_base64_keys(root_dir: &Path) -> Result<Vec<PluginTrustedKey>, String> {
        let document = read_trust_document(root_dir)?;
        Self::from_base64_keys(document.keys.clone())?;
        Ok(document
            .keys
            .into_iter()
            .map(|(key_id, public_key)| PluginTrustedKey { key_id, public_key: public_key.trim().to_string() })
            .collect())
    }

    pub fn from_base64_keys(keys: BTreeMap<String, String>) -> Result<Self, String> {
        let mut parsed = BTreeMap::new();
        for (key_id, encoded) in keys {
            validate_key_id(&key_id)?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded.trim())
                .map_err(|error| format!("Invalid trusted plugin key '{key_id}': {error}"))?;
            let bytes: [u8; 32] =
                bytes.try_into().map_err(|_| format!("Trusted plugin key '{key_id}' must contain 32 bytes"))?;
            let key = VerifyingKey::from_bytes(&bytes)
                .map_err(|error| format!("Invalid trusted plugin key '{key_id}': {error}"))?;
            parsed.insert(key_id, key);
        }
        Ok(Self { keys: parsed })
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    pub fn save_base64_key(root_dir: &Path, key_id: &str, public_key: &str) -> Result<(), String> {
        validate_key_id(key_id)?;
        let lock = open_install_lock(root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = (|| {
            let path = plugin_trust_keys_path(root_dir);
            let mut document = read_trust_document(root_dir)?;
            let public_key = public_key.trim();
            if document.keys.get(key_id).is_some_and(|existing| existing.trim() != public_key) {
                return Err(format!(
                    "Trusted plugin key '{key_id}' already exists with a different public key; remove it before rotating"
                ));
            }
            let mut candidate = document.keys.clone();
            candidate.insert(key_id.to_string(), public_key.to_string());
            Self::from_base64_keys(candidate)?;
            document.keys.insert(key_id.to_string(), public_key.to_string());
            write_json_atomically(&path, &document)
        })();
        let _ = FileExt::unlock(&lock);
        result
    }

    pub fn remove_key(root_dir: &Path, key_id: &str) -> Result<(), String> {
        validate_key_id(key_id)?;
        let lock = open_install_lock(root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = (|| {
            let path = plugin_trust_keys_path(root_dir);
            let mut document = read_trust_document(root_dir)?;
            document.keys.remove(key_id);
            write_json_atomically(&path, &document)
        })();
        let _ = FileExt::unlock(&lock);
        result
    }

    fn verify(&self, signature: &PluginPackageSignature, payload: &[u8]) -> Result<PluginSignatureStatus, String> {
        if signature.algorithm != "ed25519" {
            return Err(format!("Unsupported plugin signature algorithm '{}'", signature.algorithm));
        }
        let key = self
            .keys
            .get(&signature.key_id)
            .ok_or_else(|| format!("Plugin package is signed by untrusted key '{}'", signature.key_id))?;
        let key_id = signature.key_id.clone();
        let signature_bytes = base64::engine::general_purpose::STANDARD
            .decode(signature.signature.trim())
            .map_err(|error| format!("Invalid plugin package signature: {error}"))?;
        let signature = Signature::from_slice(&signature_bytes)
            .map_err(|error| format!("Invalid plugin package signature: {error}"))?;
        key.verify(payload, &signature).map_err(|_| "Plugin package signature verification failed".to_string())?;
        Ok(PluginSignatureStatus::Trusted { key_id })
    }
}

fn plugin_trust_keys_path(root_dir: &Path) -> PathBuf {
    root_dir.join(TRUST_DIR).join(TRUST_KEYS_FILE)
}

fn read_trust_document(root_dir: &Path) -> Result<PluginTrustDocument, String> {
    let path = plugin_trust_keys_path(root_dir);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(PluginTrustDocument::default()),
        Err(error) => return Err(format!("Failed to read plugin trust store {}: {error}", path.display())),
    };
    serde_json::from_slice(&raw)
        .map_err(|error| format!("Failed to parse plugin trust store {}: {error}", path.display()))
}

impl PluginPackageInstaller {
    pub fn new(root_dir: PathBuf, app_version: impl Into<String>) -> Result<Self, String> {
        let trust_store = PluginTrustStore::load(&root_dir)?;
        Ok(Self { root_dir, app_version: app_version.into(), trust_store: Arc::new(trust_store) })
    }

    pub fn with_trust_store(root_dir: PathBuf, app_version: impl Into<String>, trust_store: PluginTrustStore) -> Self {
        Self { root_dir, app_version: app_version.into(), trust_store: Arc::new(trust_store) }
    }

    pub fn install_file(
        &self,
        package_path: &Path,
        policy: PluginInstallPolicy,
    ) -> Result<PluginInstallResult, String> {
        if package_path.extension().and_then(|extension| extension.to_str()) != Some(DBXP_EXTENSION) {
            return Err(format!("Plugin package must use the .{DBXP_EXTENSION} extension"));
        }
        let metadata = std::fs::metadata(package_path)
            .map_err(|error| format!("Failed to inspect plugin package {}: {error}", package_path.display()))?;
        if metadata.len() > MAX_PLUGIN_PACKAGE_BYTES as u64 {
            return Err(format!("Plugin package exceeds {MAX_PLUGIN_PACKAGE_BYTES} bytes"));
        }
        let bytes = std::fs::read(package_path)
            .map_err(|error| format!("Failed to read plugin package {}: {error}", package_path.display()))?;
        self.install_bytes(&bytes, policy)
    }

    pub fn install_bytes(&self, package: &[u8], policy: PluginInstallPolicy) -> Result<PluginInstallResult, String> {
        self.install_bytes_with_expectation(package, policy, None)
    }

    pub(super) fn install_marketplace_bytes(
        &self,
        package: &[u8],
        expectation: &PluginPackageExpectation,
    ) -> Result<PluginInstallResult, String> {
        self.install_bytes_with_expectation(package, PluginInstallPolicy::LocalSigned, Some(expectation))
    }

    fn install_bytes_with_expectation(
        &self,
        package: &[u8],
        policy: PluginInstallPolicy,
        expectation: Option<&PluginPackageExpectation>,
    ) -> Result<PluginInstallResult, String> {
        if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
            return Err(format!("Plugin package exceeds {MAX_PLUGIN_PACKAGE_BYTES} bytes"));
        }
        std::fs::create_dir_all(&self.root_dir).map_err(|error| error.to_string())?;
        let lock = open_install_lock(&self.root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = self.install_bytes_locked(package, policy, expectation);
        let _ = FileExt::unlock(&lock);
        result
    }

    pub fn rollback(&self, plugin_id: &str) -> Result<PluginRollbackResult, String> {
        validate_plugin_id(plugin_id)?;
        std::fs::create_dir_all(&self.root_dir).map_err(|error| error.to_string())?;
        let lock = open_install_lock(&self.root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = self.rollback_locked(plugin_id);
        let _ = FileExt::unlock(&lock);
        result
    }

    pub fn uninstall(&self, plugin_id: &str) -> Result<(), String> {
        validate_plugin_id(plugin_id)?;
        let lock = open_install_lock(&self.root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let plugin_dir = self.root_dir.join(plugin_id);
        let result = match std::fs::remove_dir_all(&plugin_dir) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to uninstall plugin '{plugin_id}': {error}")),
        };
        let _ = FileExt::unlock(&lock);
        result
    }

    fn install_bytes_locked(
        &self,
        package: &[u8],
        policy: PluginInstallPolicy,
        expectation: Option<&PluginPackageExpectation>,
    ) -> Result<PluginInstallResult, String> {
        let package_sha256 = sha256_hex(package);
        let staging = tempfile::Builder::new()
            .prefix(".dbxp-staging-")
            .tempdir_in(&self.root_dir)
            .map_err(|error| format!("Failed to create plugin staging directory: {error}"))?;
        let package_dir = staging.path().join("package");
        std::fs::create_dir(&package_dir).map_err(|error| error.to_string())?;
        let extracted = extract_package(package, &package_dir)?;
        let checksums_path = package_dir.join(PLUGIN_CHECKSUMS_FILE);
        let checksums_raw = std::fs::read(&checksums_path)
            .map_err(|error| format!("Plugin package is missing {PLUGIN_CHECKSUMS_FILE}: {error}"))?;
        verify_package_checksums(&package_dir, &extracted, &checksums_raw)?;
        let signature = verify_package_signature(&package_dir, &checksums_raw, policy, &self.trust_store)?;

        let manifest_path = package_dir.join("manifest.json");
        let manifest_raw = std::fs::read(&manifest_path)
            .map_err(|error| format!("Plugin package is missing manifest.json: {error}"))?;
        let manifest: PluginManifest = serde_json::from_slice(&manifest_raw)
            .map_err(|error| format!("Failed to parse plugin manifest: {error}"))?;
        if manifest.manifest_version == 0 {
            return Err(".dbxp packages must use plugin manifest version 1 or newer".to_string());
        }
        validate_plugin_id(&manifest.id)?;
        let version = Version::parse(&manifest.version)
            .map_err(|error| format!("Plugin version '{}' is invalid: {error}", manifest.version))?;
        let compatibility = manifest.compatibility(&package_dir, &self.app_version);
        if !compatibility.compatible {
            return Err(format!("Plugin '{}' is incompatible: {}", manifest.id, compatibility.errors.join("; ")));
        }
        if let Some(expectation) = expectation {
            validate_package_expectation(&manifest, &signature, expectation)?;
        }
        make_backend_executable(&compatibility.backend_executable)?;

        let container_dir = self.root_dir.join(&manifest.id);
        migrate_legacy_container(&container_dir)?;
        let versions_dir = container_dir.join(VERSIONS_DIR);
        let activations_dir = container_dir.join(ACTIVATIONS_DIR);
        std::fs::create_dir_all(&versions_dir).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&activations_dir).map_err(|error| error.to_string())?;
        let version_dir = versions_dir.join(version.to_string());
        if version_dir.exists() {
            return Err(format!("Plugin '{}' version {} is already installed", manifest.id, version));
        }
        let current = read_latest_activation(&container_dir)?;
        let previous_version = current.as_ref().map(|record| record.version.clone());
        std::fs::rename(&package_dir, &version_dir)
            .map_err(|error| format!("Failed to store plugin '{}' version {}: {error}", manifest.id, version))?;

        let activation = PluginActivationRecord {
            sequence: current.as_ref().map_or(1, |record| record.sequence.saturating_add(1)),
            version: version.to_string(),
            previous_version: previous_version.clone(),
            package_sha256: package_sha256.clone(),
            activated_at: Utc::now().to_rfc3339(),
        };
        if let Err(error) = write_activation_record(&container_dir, &activation) {
            let _ = std::fs::remove_dir_all(&version_dir);
            return Err(error);
        }
        if let Err(error) = prune_plugin_history(&container_dir, &activation) {
            log::warn!("Failed to prune plugin '{}' install history: {error}", manifest.id);
        }
        let plugin = InstalledPlugin::new(manifest, version_dir, &self.app_version);
        Ok(PluginInstallResult { plugin, previous_version, package_sha256, signature })
    }

    fn rollback_locked(&self, plugin_id: &str) -> Result<PluginRollbackResult, String> {
        let container_dir = self.root_dir.join(plugin_id);
        let current = read_latest_activation(&container_dir)?
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not have an active version"))?;
        let previous_version = current
            .previous_version
            .clone()
            .ok_or_else(|| format!("Plugin '{plugin_id}' does not have a rollback version"))?;
        let version_dir = container_dir.join(VERSIONS_DIR).join(&previous_version);
        let manifest_path = version_dir.join("manifest.json");
        let manifest: PluginManifest = serde_json::from_slice(
            &std::fs::read(&manifest_path)
                .map_err(|error| format!("Rollback version {previous_version} is incomplete: {error}"))?,
        )
        .map_err(|error| format!("Rollback manifest is invalid: {error}"))?;
        if manifest.id != plugin_id || manifest.version != previous_version {
            return Err(format!("Rollback version {previous_version} does not match plugin '{plugin_id}'"));
        }
        let plugin = InstalledPlugin::new(manifest, version_dir, &self.app_version);
        if !plugin.compatibility.compatible {
            return Err(format!(
                "Rollback version {previous_version} is incompatible: {}",
                plugin.compatibility.errors.join("; ")
            ));
        }
        let target_record = read_latest_activation_for_version(&container_dir, &previous_version)?;
        let activation = PluginActivationRecord {
            sequence: current.sequence.saturating_add(1),
            version: previous_version.clone(),
            previous_version: Some(current.version),
            package_sha256: target_record
                .map_or_else(|| "legacy-unmanaged".to_string(), |record| record.package_sha256),
            activated_at: Utc::now().to_rfc3339(),
        };
        write_activation_record(&container_dir, &activation)?;
        if let Err(error) = prune_plugin_history(&container_dir, &activation) {
            log::warn!("Failed to prune plugin '{plugin_id}' rollback history: {error}");
        }
        Ok(PluginRollbackResult { plugin, previous_version })
    }
}

pub(super) fn resolve_active_plugin_dir(container_dir: &Path) -> Result<Option<PathBuf>, String> {
    if container_dir.join("manifest.json").is_file() {
        return Ok(Some(container_dir.to_path_buf()));
    }
    let Some(activation) = read_latest_activation(container_dir)? else {
        return Ok(None);
    };
    Version::parse(&activation.version)
        .map_err(|error| format!("Plugin activation has invalid version '{}': {error}", activation.version))?;
    let path = container_dir.join(VERSIONS_DIR).join(&activation.version);
    if !path.join("manifest.json").is_file() {
        return Err(format!("Active plugin version is incomplete: {}", path.display()));
    }
    Ok(Some(path))
}

fn extract_package(package: &[u8], destination: &Path) -> Result<HashSet<String>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(package)).map_err(|error| format!("Invalid .dbxp archive: {error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!("Plugin package contains more than {MAX_ARCHIVE_ENTRIES} entries"));
    }
    let mut extracted = HashSet::new();
    let mut normalized_names = HashSet::new();
    let mut total_size = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let enclosed =
            entry.enclosed_name().ok_or_else(|| format!("Plugin package contains unsafe path '{}'", entry.name()))?;
        validate_package_path(&enclosed)?;
        let path_key = path_key(&enclosed)?;
        let normalized = path_key.to_ascii_lowercase();
        if !normalized_names.insert(normalized) {
            return Err(format!("Plugin package contains duplicate path '{path_key}'"));
        }
        if entry.is_dir() {
            std::fs::create_dir_all(destination.join(&enclosed)).map_err(|error| error.to_string())?;
            continue;
        }
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            return Err(format!("Plugin package cannot contain symbolic link '{path_key}'"));
        }
        if entry.size() > MAX_FILE_BYTES {
            return Err(format!("Plugin package file '{path_key}' exceeds {MAX_FILE_BYTES} bytes"));
        }
        total_size = total_size.checked_add(entry.size()).ok_or("Plugin package uncompressed size overflow")?;
        if total_size > MAX_UNCOMPRESSED_BYTES {
            return Err(format!("Plugin package expands beyond {MAX_UNCOMPRESSED_BYTES} bytes"));
        }
        let output = destination.join(&enclosed);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut target = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| format!("Failed to extract '{path_key}': {error}"))?;
        let copied = std::io::copy(&mut entry.by_ref().take(MAX_FILE_BYTES + 1), &mut target)
            .map_err(|error| format!("Failed to extract '{path_key}': {error}"))?;
        if copied > MAX_FILE_BYTES {
            return Err(format!("Plugin package file '{path_key}' exceeds {MAX_FILE_BYTES} bytes"));
        }
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;

            std::fs::set_permissions(&output, std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(|error| error.to_string())?;
        }
        extracted.insert(path_key);
    }
    Ok(extracted)
}

fn verify_package_checksums(destination: &Path, extracted: &HashSet<String>, raw: &[u8]) -> Result<(), String> {
    let checksums: PluginPackageChecksums =
        serde_json::from_slice(raw).map_err(|error| format!("Failed to parse {PLUGIN_CHECKSUMS_FILE}: {error}"))?;
    if checksums.algorithm != "sha256" {
        return Err(format!("Unsupported plugin checksum algorithm '{}'", checksums.algorithm));
    }
    let expected_files = extracted
        .iter()
        .filter(|path| path.as_str() != PLUGIN_CHECKSUMS_FILE && path.as_str() != PLUGIN_SIGNATURE_FILE)
        .cloned()
        .collect::<HashSet<_>>();
    let declared_files = checksums.files.keys().cloned().collect::<HashSet<_>>();
    if expected_files != declared_files {
        let missing = expected_files.difference(&declared_files).cloned().collect::<Vec<_>>();
        let extra = declared_files.difference(&expected_files).cloned().collect::<Vec<_>>();
        return Err(format!("Plugin checksums do not cover the package exactly; missing={missing:?}, extra={extra:?}"));
    }
    for (relative, expected) in checksums.files {
        let path = safe_checksum_path(destination, &relative)?;
        let actual = sha256_file(&path)?;
        if !expected.eq_ignore_ascii_case(&actual) {
            return Err(format!("Plugin checksum mismatch for '{relative}'"));
        }
    }
    Ok(())
}

fn verify_package_signature(
    destination: &Path,
    checksums: &[u8],
    policy: PluginInstallPolicy,
    trust_store: &PluginTrustStore,
) -> Result<PluginSignatureStatus, String> {
    let signature_path = destination.join(PLUGIN_SIGNATURE_FILE);
    match std::fs::read(&signature_path) {
        Ok(raw) => {
            let signature: PluginPackageSignature = serde_json::from_slice(&raw)
                .map_err(|error| format!("Failed to parse {PLUGIN_SIGNATURE_FILE}: {error}"))?;
            trust_store.verify(&signature, checksums)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match policy {
            PluginInstallPolicy::LocalDevelopment => Ok(PluginSignatureStatus::Unsigned),
            PluginInstallPolicy::LocalSigned => Err("Plugin package must have a trusted Ed25519 signature".to_string()),
        },
        Err(error) => Err(error.to_string()),
    }
}

fn validate_package_expectation(
    manifest: &PluginManifest,
    signature: &PluginSignatureStatus,
    expectation: &PluginPackageExpectation,
) -> Result<(), String> {
    if manifest.id != expectation.id {
        return Err(format!("Marketplace package id '{}' does not match catalog id '{}'", manifest.id, expectation.id));
    }
    if manifest.version != expectation.version {
        return Err(format!(
            "Marketplace package version '{}' does not match catalog version '{}'",
            manifest.version, expectation.version
        ));
    }
    if manifest.publisher != expectation.publisher {
        return Err(format!(
            "Marketplace package publisher '{}' does not match catalog publisher '{}'",
            manifest.publisher, expectation.publisher
        ));
    }
    let permissions = manifest.permissions.iter().cloned().collect::<BTreeSet<_>>();
    if permissions != expectation.permissions {
        return Err(format!(
            "Marketplace package permissions {:?} do not match catalog permissions {:?}",
            permissions, expectation.permissions
        ));
    }
    let PluginSignatureStatus::Trusted { key_id } = signature else {
        return Err("Marketplace package must have a trusted signature".to_string());
    };
    if key_id != &expectation.signing_key_id {
        return Err(format!(
            "Marketplace package repository signing key '{}' does not match repository key '{}' declared by the catalog",
            key_id, expectation.signing_key_id
        ));
    }
    Ok(())
}

fn read_latest_activation(container_dir: &Path) -> Result<Option<PluginActivationRecord>, String> {
    let activations_dir = container_dir.join(ACTIVATIONS_DIR);
    let entries = match std::fs::read_dir(&activations_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut latest: Option<PluginActivationRecord> = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() || !is_activation_record_file(&entry.path())
        {
            continue;
        }
        let raw = std::fs::read(entry.path()).map_err(|error| error.to_string())?;
        let record: PluginActivationRecord = serde_json::from_slice(&raw)
            .map_err(|error| format!("Invalid plugin activation {}: {error}", entry.path().display()))?;
        if latest.as_ref().is_none_or(|current| record.sequence > current.sequence) {
            latest = Some(record);
        }
    }
    Ok(latest)
}

fn read_latest_activation_for_version(
    container_dir: &Path,
    version: &str,
) -> Result<Option<PluginActivationRecord>, String> {
    let activations_dir = container_dir.join(ACTIVATIONS_DIR);
    let entries = match std::fs::read_dir(&activations_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut latest: Option<PluginActivationRecord> = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() || !is_activation_record_file(&entry.path())
        {
            continue;
        }
        let record: PluginActivationRecord =
            serde_json::from_slice(&std::fs::read(entry.path()).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Invalid plugin activation {}: {error}", entry.path().display()))?;
        if record.version == version && latest.as_ref().is_none_or(|current| record.sequence > current.sequence) {
            latest = Some(record);
        }
    }
    Ok(latest)
}

fn prune_plugin_history(container_dir: &Path, current: &PluginActivationRecord) -> Result<(), String> {
    let retained_versions =
        std::iter::once(current.version.as_str()).chain(current.previous_version.as_deref()).collect::<HashSet<_>>();
    let versions_dir = container_dir.join(VERSIONS_DIR);
    if let Ok(entries) = std::fs::read_dir(&versions_dir) {
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry.file_type().map_err(|error| error.to_string())?.is_dir() {
                continue;
            }
            let version = entry.file_name();
            let version = version.to_string_lossy();
            if !retained_versions.contains(version.as_ref()) {
                std::fs::remove_dir_all(entry.path()).map_err(|error| error.to_string())?;
            }
        }
        sync_directory(&versions_dir)?;
    }

    let activations_dir = container_dir.join(ACTIVATIONS_DIR);
    let entries = match std::fs::read_dir(&activations_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut records = Vec::new();
    let mut latest_sequences = BTreeMap::<String, u64>::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry.file_type().map_err(|error| error.to_string())?.is_file() || !is_activation_record_file(&entry.path())
        {
            continue;
        }
        let record: PluginActivationRecord =
            serde_json::from_slice(&std::fs::read(entry.path()).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Invalid plugin activation {}: {error}", entry.path().display()))?;
        if retained_versions.contains(record.version.as_str()) {
            latest_sequences
                .entry(record.version.clone())
                .and_modify(|sequence| *sequence = (*sequence).max(record.sequence))
                .or_insert(record.sequence);
        }
        records.push((entry.path(), record));
    }
    for (path, record) in records {
        let keep = retained_versions.contains(record.version.as_str())
            && latest_sequences.get(&record.version).is_some_and(|sequence| *sequence == record.sequence);
        if !keep {
            std::fs::remove_file(path).map_err(|error| error.to_string())?;
        }
    }
    sync_directory(&activations_dir)
}

fn is_activation_record_file(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".json") else {
        return false;
    };
    let Some((sequence, unique)) = stem.split_once('-') else {
        return false;
    };
    sequence.len() == 20 && sequence.bytes().all(|byte| byte.is_ascii_digit()) && !unique.is_empty()
}

fn migrate_legacy_container(container_dir: &Path) -> Result<(), String> {
    let manifest_path = container_dir.join("manifest.json");
    if !manifest_path.is_file() {
        return Ok(());
    }
    let manifest: PluginManifest = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|error| format!("Failed to read legacy plugin {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Failed to parse legacy plugin {}: {error}", manifest_path.display()))?;
    let storage_version = Version::parse(&manifest.version)
        .map(|version| version.to_string())
        .unwrap_or_else(|_| format!("0.0.0-legacy.{}", &sha256_hex(manifest.version.as_bytes())[..12]));
    let parent = container_dir.parent().ok_or("Plugin container has no parent")?;
    let temporary = parent.join(format!(".legacy-{}-{}", manifest.id, uuid::Uuid::new_v4()));
    std::fs::rename(container_dir, &temporary)
        .map_err(|error| format!("Failed to stage legacy plugin '{}': {error}", manifest.id))?;
    let versions_dir = container_dir.join(VERSIONS_DIR);
    let activations_dir = container_dir.join(ACTIVATIONS_DIR);
    let version_dir = versions_dir.join(&storage_version);
    let migration = (|| {
        std::fs::create_dir_all(&versions_dir).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&activations_dir).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, &version_dir).map_err(|error| error.to_string())?;
        write_activation_record(
            container_dir,
            &PluginActivationRecord {
                sequence: 1,
                version: storage_version,
                previous_version: None,
                package_sha256: "legacy-unmanaged".to_string(),
                activated_at: Utc::now().to_rfc3339(),
            },
        )
    })();
    if let Err(error) = migration {
        let _ = std::fs::remove_dir_all(container_dir);
        let _ = std::fs::rename(&temporary, container_dir);
        return Err(format!("Failed to migrate legacy plugin '{}': {error}", manifest.id));
    }
    Ok(())
}

fn write_activation_record(container_dir: &Path, activation: &PluginActivationRecord) -> Result<(), String> {
    let activations_dir = container_dir.join(ACTIVATIONS_DIR);
    std::fs::create_dir_all(&activations_dir).map_err(|error| error.to_string())?;
    let filename = format!("{:020}-{}.json", activation.sequence, uuid::Uuid::new_v4());
    let final_path = activations_dir.join(filename);
    let temporary_path = activations_dir.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(activation).map_err(|error| error.to_string())?;
    let mut file =
        OpenOptions::new().write(true).create_new(true).open(&temporary_path).map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string())?;
    sync_directory(&activations_dir)?;
    Ok(())
}

fn write_json_atomically<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("Plugin trust store path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let mut file =
        OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, path).map_err(|error| error.to_string())?;
    sync_directory(parent)
}

fn open_install_lock(root_dir: &Path) -> Result<File, String> {
    std::fs::create_dir_all(root_dir).map_err(|error| error.to_string())?;
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(root_dir.join(INSTALL_LOCK_FILE))
        .map_err(|error| error.to_string())
}

fn make_backend_executable(path: &Option<PathBuf>) -> Result<(), String> {
    #[cfg(unix)]
    if let Some(path) = path {
        use std::os::unix::fs::PermissionsExt;

        let mut permissions = std::fs::metadata(path).map_err(|error| error.to_string())?.permissions();
        permissions.set_mode(permissions.mode() | 0o700);
        std::fs::set_permissions(path, permissions).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn safe_checksum_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    validate_package_path(path)?;
    Ok(root.join(path))
}

fn validate_package_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("Plugin package paths must be non-empty and relative".to_string());
    }
    if path.components().any(|component| !matches!(component, Component::Normal(_))) {
        return Err(format!("Plugin package contains unsafe path '{}'", path.display()));
    }
    Ok(())
}

fn path_key(path: &Path) -> Result<String, String> {
    validate_package_path(path)?;
    path.components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .map(str::to_string)
                .ok_or_else(|| format!("Plugin package path is not UTF-8: {}", path.display())),
            _ => unreachable!(),
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}

fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty() || plugin_id.len() > 128 {
        return Err("Plugin id must be between 1 and 128 bytes".to_string());
    }
    let mut chars = plugin_id.chars();
    if !matches!(chars.next(), Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit())
        || !chars.all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || matches!(character, '.' | '-' | '_')
        })
    {
        return Err("Plugin id must contain only lowercase letters, digits, '.', '-' or '_'".to_string());
    }
    Ok(())
}

pub(super) fn validate_key_id(key_id: &str) -> Result<(), String> {
    if key_id.is_empty()
        || key_id.len() > 128
        || !key_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_' | ':'))
    {
        return Err("Plugin signing key id contains unsupported characters".to_string());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(hex_digest(digest.finalize()))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    bytes.as_ref().iter().fold(String::with_capacity(64), |mut output, byte| {
        let _ = write!(output, "{byte:02x}");
        output
    })
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path).and_then(|directory| directory.sync_all()).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};
    use std::io::{Cursor, Write};

    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use zip::write::SimpleFileOptions;

    use super::{
        is_activation_record_file, sha256_hex, validate_package_expectation, PluginInstallPolicy,
        PluginPackageExpectation, PluginPackageInstaller, PluginSignatureStatus, PluginTrustStore, ACTIVATIONS_DIR,
        PLUGIN_CHECKSUMS_FILE, PLUGIN_SIGNATURE_FILE, VERSIONS_DIR,
    };
    use crate::plugins::{PluginManifest, PluginRegistry};

    #[test]
    fn installs_versioned_package_and_rolls_back_atomically() {
        let root = tempfile::tempdir().unwrap();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        let first = package("1.0.0", None, false);
        let second = package("1.1.0", None, false);
        installer.install_bytes(&first, PluginInstallPolicy::LocalDevelopment).unwrap();
        let installed = installer.install_bytes(&second, PluginInstallPolicy::LocalDevelopment).unwrap();
        assert_eq!(installed.previous_version.as_deref(), Some("1.0.0"));

        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.1.0");

        let rollback = installer.rollback("sample.hello").unwrap();
        assert_eq!(rollback.previous_version, "1.0.0");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn retains_only_active_and_rollback_versions() {
        let root = tempfile::tempdir().unwrap();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        for version in ["1.0.0", "1.1.0", "1.2.0"] {
            installer.install_bytes(&package(version, None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        }

        let container = root.path().join("sample.hello");
        let mut versions = std::fs::read_dir(container.join(VERSIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        versions.sort();
        assert_eq!(versions, ["1.1.0", "1.2.0"]);
        assert_eq!(
            std::fs::read_dir(container.join(ACTIVATIONS_DIR))
                .unwrap()
                .filter(|entry| entry.as_ref().is_ok_and(|entry| is_activation_record_file(&entry.path())))
                .count(),
            2
        );

        let rollback = installer.rollback("sample.hello").unwrap();
        assert_eq!(rollback.plugin.manifest.version, "1.1.0");
        assert_eq!(rollback.previous_version, "1.1.0");
    }

    #[test]
    fn ignores_interrupted_activation_temp_files() {
        let root = tempfile::tempdir().unwrap();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        installer.install_bytes(&package("1.0.0", None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        let activations = root.path().join("sample.hello").join("activations");
        std::fs::write(activations.join(".interrupted.tmp"), b"{").unwrap();
        std::fs::write(activations.join("README.txt"), b"not an activation").unwrap();

        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");

        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn installing_v1_migrates_legacy_flat_plugin_and_preserves_rollback() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("sample.hello");
        std::fs::create_dir_all(legacy.join("bin")).unwrap();
        std::fs::write(legacy.join("bin/plugin"), b"legacy").unwrap();
        std::fs::write(
            legacy.join("manifest.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "sample.hello",
                "name": "Hello legacy",
                "version": "0.9.0",
                "protocol_version": 1,
                "executable": "bin/plugin",
                "drivers": []
            }))
            .unwrap(),
        )
        .unwrap();

        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        let installed =
            installer.install_bytes(&package("1.0.0", None, false), PluginInstallPolicy::LocalDevelopment).unwrap();

        assert_eq!(installed.previous_version.as_deref(), Some("0.9.0"));
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");

        let rollback = installer.rollback("sample.hello").unwrap();
        assert_eq!(rollback.previous_version, "0.9.0");
        let legacy_plugin = registry.find_plugin("sample.hello").unwrap().unwrap();
        assert_eq!(legacy_plugin.manifest.version, "0.9.0");
        assert_eq!(std::fs::read(legacy_plugin.path.join("bin/plugin")).unwrap(), b"legacy");
    }

    #[test]
    fn strict_policy_requires_and_verifies_trusted_signature() {
        let root = tempfile::tempdir().unwrap();
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let mut keys = BTreeMap::new();
        keys.insert(
            "sample-key".to_string(),
            base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes()),
        );
        let trust = PluginTrustStore::from_base64_keys(keys).unwrap();
        let installer = PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", trust);
        let expectation = PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: "1.0.0".to_string(),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };
        let unsigned = package("1.0.0", None, false);
        assert!(installer.install_marketplace_bytes(&unsigned, &expectation).is_err());

        let signed = package("1.0.0", Some((&signing_key, "sample-key")), false);
        let result = installer.install_marketplace_bytes(&signed, &expectation).unwrap();
        assert_eq!(result.signature, PluginSignatureStatus::Trusted { key_id: "sample-key".to_string() });
    }

    #[test]
    fn marketplace_expectation_binds_manifest_and_signing_identity() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "manifest_version": 1,
            "id": "sample.hello",
            "name": "Hello",
            "version": "1.0.0",
            "publisher": "sample",
            "permissions": ["host.events"]
        }))
        .unwrap();
        let signature = PluginSignatureStatus::Trusted { key_id: "sample-key".to_string() };
        let expectation = PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: "1.0.0".to_string(),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        validate_package_expectation(&manifest, &signature, &expectation).unwrap();
        let mut mismatch = expectation.clone();
        mismatch.id = "sample.replaced".to_string();
        assert!(validate_package_expectation(&manifest, &signature, &mismatch).unwrap_err().contains("catalog id"));
        let mut mismatch = expectation.clone();
        mismatch.publisher = "attacker".to_string();
        assert!(validate_package_expectation(&manifest, &signature, &mismatch)
            .unwrap_err()
            .contains("catalog publisher"));
        let mut mismatch = expectation;
        mismatch.signing_key_id = "attacker-key".to_string();
        assert!(validate_package_expectation(&manifest, &signature, &mismatch).unwrap_err().contains("repository key"));
    }

    #[test]
    fn trusted_repository_keys_roundtrip_and_can_be_removed() {
        let root = tempfile::tempdir().unwrap();
        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());

        PluginTrustStore::save_base64_key(root.path(), "sample-repository", &public_key).unwrap();

        assert_eq!(
            PluginTrustStore::list_base64_keys(root.path()).unwrap(),
            vec![super::PluginTrustedKey { key_id: "sample-repository".to_string(), public_key: public_key.clone() }]
        );
        assert!(PluginTrustStore::load(root.path()).unwrap().keys.contains_key("sample-repository"));

        let replacement = base64::engine::general_purpose::STANDARD
            .encode(SigningKey::from_bytes(&[10u8; 32]).verifying_key().as_bytes());
        assert!(PluginTrustStore::save_base64_key(root.path(), "sample-repository", &replacement)
            .unwrap_err()
            .contains("remove it before rotating"));

        PluginTrustStore::remove_key(root.path(), "sample-repository").unwrap();

        assert!(PluginTrustStore::list_base64_keys(root.path()).unwrap().is_empty());
        assert!(!PluginTrustStore::load(root.path()).unwrap().keys.contains_key("sample-repository"));
    }

    #[test]
    fn rejects_checksum_mismatch_and_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        let tampered = package("1.0.0", None, true);
        assert!(installer.install_bytes(&tampered, PluginInstallPolicy::LocalDevelopment).is_err());

        let mut output = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            zip.start_file("../escape", SimpleFileOptions::default()).unwrap();
            zip.write_all(b"bad").unwrap();
            zip.finish().unwrap();
        }
        assert!(installer.install_bytes(output.get_ref(), PluginInstallPolicy::LocalDevelopment).is_err());
    }

    fn package(version: &str, signer: Option<(&SigningKey, &str)>, tamper: bool) -> Vec<u8> {
        let manifest = serde_json::json!({
            "manifest_version": 1,
            "id": "sample.hello",
            "name": "Hello",
            "version": version,
            "publisher": "sample",
            "engines": { "dbx": ">=0.5.0", "host_api": "^1.0" },
            "permissions": ["host.events"],
            "entrypoints": {
                "backend": {
                    "protocol_versions": [1],
                    "transport": "stdio-jsonl",
                    "executable": "bin/plugin"
                }
            }
        });
        let manifest = serde_json::to_vec_pretty(&manifest).unwrap();
        let backend = b"#!/bin/sh\nexit 0\n".to_vec();
        let mut files = BTreeMap::new();
        files.insert("manifest.json".to_string(), manifest.clone());
        files.insert("bin/plugin".to_string(), backend.clone());
        let checksum_files =
            files.iter().map(|(path, bytes)| (path.clone(), sha256_hex(bytes))).collect::<BTreeMap<_, _>>();
        let checksums = serde_json::to_vec_pretty(&serde_json::json!({
            "algorithm": "sha256",
            "files": checksum_files
        }))
        .unwrap();
        let signature = signer.map(|(key, key_id)| {
            serde_json::to_vec_pretty(&serde_json::json!({
                "algorithm": "ed25519",
                "key_id": key_id,
                "signature": base64::engine::general_purpose::STANDARD.encode(key.sign(&checksums).to_bytes())
            }))
            .unwrap()
        });

        let mut output = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            for (path, mut bytes) in files {
                if tamper && path == "manifest.json" {
                    bytes.push(b' ');
                }
                let options = if path == "bin/plugin" {
                    SimpleFileOptions::default().unix_permissions(0o755)
                } else {
                    SimpleFileOptions::default().unix_permissions(0o644)
                };
                zip.start_file(path, options).unwrap();
                zip.write_all(&bytes).unwrap();
            }
            zip.start_file(PLUGIN_CHECKSUMS_FILE, SimpleFileOptions::default()).unwrap();
            zip.write_all(&checksums).unwrap();
            if let Some(signature) = signature {
                zip.start_file(PLUGIN_SIGNATURE_FILE, SimpleFileOptions::default()).unwrap();
                zip.write_all(&signature).unwrap();
            }
            zip.finish().unwrap();
        }
        output.into_inner()
    }
}
