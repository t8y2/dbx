use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use chrono::Utc;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::lifecycle::PluginUsageGuard;
use super::{InstalledPlugin, InstalledPluginInfo, PluginLifecycle, PluginManifest};

pub const DBXP_EXTENSION: &str = "dbxp";
pub const PLUGIN_CHECKSUMS_FILE: &str = "checksums.json";
pub const PLUGIN_SIGNATURE_FILE: &str = "signature.json";

pub const MAX_PLUGIN_PACKAGE_BYTES: usize = 512 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const INSTALL_LOCK_FILE: &str = ".install.lock";
/// Where a logically uninstalled plugin container waits for its physical delete. The directory is
/// no plugin container of its own (no manifest, no activations), so installed plugin discovery
/// skips it, and `validate_plugin_id` rejects a leading dot, so no plugin id can collide with it.
pub(super) const PLUGIN_TRASH_DIR: &str = ".trash";
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
    _update_guard: Option<PluginUsageGuard>,
}

#[derive(Debug, Clone)]
pub struct PluginRollbackResult {
    pub plugin: InstalledPlugin,
    pub previous_version: String,
    _update_guard: Option<PluginUsageGuard>,
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

/// Where an installed plugin came from. Recorded with every activation so an update can detect a
/// changed repository / publisher / signing key instead of silently replacing the plugin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallProvenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_key_id: Option<String>,
    #[serde(default)]
    pub source: PluginInstallSource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PluginInstallSource {
    Marketplace,
    Url,
    File,
    #[default]
    Unknown,
}

/// The active installation of one plugin id: the semver activation version plus whatever
/// provenance was recorded when it was installed. Provenance is `None` for installs made before
/// provenance existed (and for legacy migrated containers); those stay unconstrained until the
/// next install records fresh provenance.
#[derive(Debug, Clone)]
pub(crate) struct PluginInstallIdentity {
    pub version: String,
    pub provenance: Option<PluginInstallProvenance>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provenance: Option<PluginInstallProvenance>,
}

pub struct PluginPackageInstaller {
    root_dir: PathBuf,
    app_version: String,
    trust_store: Arc<PluginTrustStore>,
    lifecycle: Option<PluginLifecycle>,
}

#[derive(Debug, Clone)]
pub(super) struct PluginPackageExpectation {
    pub id: String,
    pub version: String,
    pub repository_id: Option<String>,
    pub publisher: String,
    pub permissions: BTreeSet<String>,
    pub signing_key_id: String,
}

/// Read-only identity lookup for one plugin id under the store root: the activation version plus
/// the recorded provenance. Free function so the marketplace pre-flight can call it without
/// constructing an installer (which would load the user trust store as a side effect).
pub(crate) fn read_install_identity(root_dir: &Path, plugin_id: &str) -> Result<Option<PluginInstallIdentity>, String> {
    validate_plugin_id(plugin_id)?;
    let Some(record) = read_latest_activation(&root_dir.join(plugin_id))? else { return Ok(None) };
    Ok(Some(PluginInstallIdentity { version: record.version, provenance: record.provenance }))
}

/// Rejects an update whose repository / publisher / signing key differs from the recorded
/// provenance, or that would downgrade below the active version, unless `allow` is set (the
/// user confirmed the change in the UI). The marketplace pre-flight calls this before any
/// download; `install_bytes_locked` re-checks under the store lock.
pub(crate) fn ensure_update_continuity(
    provenance: &PluginInstallProvenance,
    active_version: &str,
    repository_id: Option<&str>,
    publisher: &str,
    signing_key_id: &str,
    candidate_version: &str,
    allow: bool,
) -> Result<(), String> {
    // Compare against the activation version (always semver); a legacy manifest version string
    // that fails to parse simply skips the downgrade check.
    if let (Ok(active), Ok(candidate)) = (Version::parse(active_version), Version::parse(candidate_version)) {
        if candidate < active && !allow {
            return Err(format!(
                "Plugin downgrade to version {candidate_version} is not allowed (installed {active_version})"
            ));
        }
    }
    let repository_changed =
        provenance.repository_id.as_deref().is_some_and(|recorded| Some(recorded) != repository_id);
    let publisher_changed = provenance.publisher.as_deref().is_some_and(|recorded| recorded != publisher);
    let key_changed = provenance.signing_key_id.as_deref().is_some_and(|recorded| recorded != signing_key_id);
    if (repository_changed || publisher_changed || key_changed) && !allow {
        return Err(
            "Plugin update source change requires confirmation: the offering repository, publisher, or signing key differs from the recorded install"
                .to_string(),
        );
    }
    Ok(())
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
        let trust_store = super::marketplace::package_install_trust_store(&root_dir)?;
        Ok(Self { root_dir, app_version: app_version.into(), trust_store: Arc::new(trust_store), lifecycle: None })
    }

    pub fn with_trust_store(root_dir: PathBuf, app_version: impl Into<String>, trust_store: PluginTrustStore) -> Self {
        Self { root_dir, app_version: app_version.into(), trust_store: Arc::new(trust_store), lifecycle: None }
    }

    pub fn with_lifecycle(mut self, lifecycle: PluginLifecycle) -> Self {
        self.lifecycle = Some(lifecycle);
        self
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
        self.install_bytes_with_expectation(package, policy, None, PluginInstallSource::File, false)
    }

    pub(super) fn install_marketplace_bytes(
        &self,
        package: &[u8],
        expectation: &PluginPackageExpectation,
        allow_source_change: bool,
    ) -> Result<PluginInstallResult, String> {
        self.install_bytes_with_expectation(
            package,
            PluginInstallPolicy::LocalSigned,
            Some(expectation),
            PluginInstallSource::Marketplace,
            allow_source_change,
        )
    }

    /// Shared entry point for every install path: `PluginPackageExpectation` (and therefore this
    /// signature) stays inside the `plugins` module, exactly like the expectation type.
    pub(super) fn install_bytes_with_expectation(
        &self,
        package: &[u8],
        policy: PluginInstallPolicy,
        expectation: Option<&PluginPackageExpectation>,
        source: PluginInstallSource,
        allow_source_change: bool,
    ) -> Result<PluginInstallResult, String> {
        if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
            return Err(format!("Plugin package exceeds {MAX_PLUGIN_PACKAGE_BYTES} bytes"));
        }
        std::fs::create_dir_all(&self.root_dir).map_err(|error| error.to_string())?;
        let lock = open_install_lock(&self.root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = self.install_bytes_locked(package, policy, expectation, source, allow_source_change);
        if result.is_ok() {
            // Opportunistic cleanup of tombstones an earlier uninstall could not delete yet.
            self.sweep_plugin_trash(&TRANSIENT_LOCK_RETRY_DELAYS, |path: &Path| std::fs::remove_dir_all(path));
        }
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

    /// Store-level logical uninstall: the official `plugins/<plugin_id>` container is renamed into
    /// `.trash` (that rename *is* the commit) and only then physically deleted. `remove_dir_all` is
    /// not atomic, so deleting the container in place could leave a partially deleted tree behind;
    /// a failed rename instead leaves the container exactly as it was and reports a clean failure.
    pub fn uninstall(&self, plugin_id: &str) -> Result<(), String> {
        self.uninstall_with_ops(
            plugin_id,
            &TRANSIENT_LOCK_RETRY_DELAYS,
            |src: &Path, dst: &Path| std::fs::rename(src, dst),
            |path: &Path| std::fs::remove_dir_all(path),
        )
    }

    /// The uninstall body, parameterised for tests: `delays` is the transient Windows lock retry
    /// window, and the two filesystem primitives are injected so error 5 / 32 failures can be
    /// reproduced deterministically on every platform instead of depending on a real scanner.
    fn uninstall_with_ops(
        &self,
        plugin_id: &str,
        delays: &[Duration],
        mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
        mut remove_dir_all: impl FnMut(&Path) -> std::io::Result<()>,
    ) -> Result<(), String> {
        validate_plugin_id(plugin_id)?;
        let lock = open_install_lock(&self.root_dir)?;
        lock.lock_exclusive().map_err(|error| format!("Failed to lock plugin store: {error}"))?;
        let result = (|| {
            let plugin_dir = self.root_dir.join(plugin_id);
            if plugin_dir.exists() {
                let trash_dir = self.root_dir.join(PLUGIN_TRASH_DIR);
                std::fs::create_dir_all(&trash_dir)
                    .map_err(|error| format!("Failed to prepare plugin trash '{}': {error}", trash_dir.display()))?;
                let tombstone = unique_plugin_tombstone(&trash_dir, plugin_id);
                // From here on the plugin is uninstalled: the container is out of the store root
                // and discovery does not see it any more. An antivirus scanner holding a freshly
                // extracted binary may fail this rename with error 5 / 32, hence the retry, and a
                // rename that keeps failing leaves the container untouched for a clean failure.
                retry_transient_lock(delays, || rename(&plugin_dir, &tombstone))
                    .map_err(|error| format!("Failed to uninstall plugin '{plugin_id}': {error}"))?;
            }
            self.sweep_plugin_trash(delays, &mut remove_dir_all);
            Ok(())
        })();
        let _ = FileExt::unlock(&lock);
        result
    }

    /// Best-effort physical delete of every `.trash` tombstone: the one the caller just committed
    /// plus leftovers from an earlier uninstall whose delete failed. Callers hold `.install.lock`,
    /// every entry in there is already logically uninstalled, and a tombstone that still cannot be
    /// removed only logs a warning — the plugin is uninstalled either way, and a later install or
    /// uninstall sweeps it again.
    fn sweep_plugin_trash(&self, delays: &[Duration], mut remove_dir_all: impl FnMut(&Path) -> std::io::Result<()>) {
        let trash_dir = self.root_dir.join(PLUGIN_TRASH_DIR);
        let entries = match std::fs::read_dir(&trash_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                log::warn!("Failed to scan plugin trash '{}': {error}", trash_dir.display());
                return;
            }
        };
        for entry in entries.flatten() {
            let tombstone = entry.path();
            let removed = retry_transient_lock(delays, || match remove_dir_all(&tombstone) {
                // Already gone (or not a directory): nothing left to clean up.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                result => result,
            });
            if let Err(error) = removed {
                log::warn!("Failed to remove plugin tombstone '{}': {error}", tombstone.display());
            }
        }
    }

    /// Recorded provenance of one container's active installation, if any.
    pub(super) fn read_container_provenance(container_dir: &Path) -> Result<Option<PluginInstallProvenance>, String> {
        Ok(read_latest_activation(container_dir)?.and_then(|record| record.provenance))
    }

    fn install_bytes_locked(
        &self,
        package: &[u8],
        policy: PluginInstallPolicy,
        expectation: Option<&PluginPackageExpectation>,
        source: PluginInstallSource,
        allow_source_change: bool,
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

        let update_guard = self.lifecycle.as_ref().map(|lifecycle| lifecycle.begin_update(&manifest.id)).transpose()?;
        let container_dir = self.root_dir.join(&manifest.id);
        migrate_legacy_container(&container_dir)?;
        let versions_dir = container_dir.join(VERSIONS_DIR);
        let activations_dir = container_dir.join(ACTIVATIONS_DIR);
        std::fs::create_dir_all(&versions_dir).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&activations_dir).map_err(|error| error.to_string())?;
        let version_string = version.to_string();
        let version_dir = versions_dir.join(&version_string);
        let current = read_latest_activation(&container_dir)?;
        // Update continuity (crate::plugins::installer::ensure_update_continuity): a marketplace
        // update whose recorded repository / publisher / signing key differs from the offering one,
        // or that would downgrade the active version, is rejected unless the user explicitly
        // confirmed. Installs without recorded provenance stay unconstrained until the next
        // install records fresh provenance.
        if let (Some(expectation), Some(record)) = (expectation, current.as_ref()) {
            if !matches!(policy, PluginInstallPolicy::LocalDevelopment) {
                if let Some(provenance) = &record.provenance {
                    ensure_update_continuity(
                        provenance,
                        &record.version,
                        expectation.repository_id.as_deref(),
                        &expectation.publisher,
                        &expectation.signing_key_id,
                        &version_string,
                        allow_source_change,
                    )?;
                }
            }
        }
        // Only the version the newest activation record resolves to *and* that is still a usable
        // install counts as "already installed". Directory existence alone is not enough: rollback
        // deliberately retains the version it replaces as the next rollback target, so an
        // installed-but-inactive directory has to stay replaceable, and a broken active directory
        // (missing or unparsable manifest) has to stay replaceable so Update can repair it.
        if !matches!(policy, PluginInstallPolicy::LocalDevelopment)
            && version_dir.exists()
            && current.as_ref().is_some_and(|record| record.version == version_string)
            && version_dir_is_usable(&version_dir, &manifest.id, &version_string)
        {
            return Err(format!("Plugin '{}' version {} is already installed", manifest.id, version));
        }
        let previous_version = current
            .as_ref()
            .and_then(|record| {
                if record.version == version_string {
                    record.previous_version.clone()
                } else {
                    Some(record.version.clone())
                }
            })
            // Never record a rollback target that cannot be rolled back to: `rollback_locked`
            // requires versions/<version>/manifest.json to have the matching identity.
            .filter(|previous| {
                previous != &version_string
                    && version_dir_is_usable(&versions_dir.join(previous), &manifest.id, previous)
            });
        let replaced_version_dir = if version_dir.exists() {
            let mut backup = versions_dir.join(format!(".{version_string}.replaced"));
            let mut suffix = 0u32;
            while backup.exists() {
                suffix = suffix.saturating_add(1);
                backup = versions_dir.join(format!(".{version_string}.replaced-{suffix}"));
            }
            std::fs::rename(&version_dir, &backup).map_err(|error| {
                format!("Failed to prepare plugin '{}' version {} replacement: {error}", manifest.id, version)
            })?;
            Some(backup)
        } else {
            None
        };
        if let Err(error) = rename_with_transient_lock_retry(&package_dir, &version_dir) {
            let mut message = format!("Failed to store plugin '{}' version {}: {error}", manifest.id, version);
            if let Some(backup) = &replaced_version_dir {
                if let Err(restore) = rename_with_transient_lock_retry(backup, &version_dir) {
                    message.push_str(&format!("; previous copy kept at {}: {restore}", backup.display()));
                }
            }
            return Err(message);
        }

        let provenance = match expectation {
            Some(expectation) => PluginInstallProvenance {
                repository_id: expectation.repository_id.clone(),
                publisher: Some(expectation.publisher.clone()),
                signing_key_id: Some(expectation.signing_key_id.clone()),
                source: PluginInstallSource::Marketplace,
            },
            None => {
                let previous = current.as_ref().and_then(|record| record.provenance.as_ref());
                PluginInstallProvenance {
                    // A file/URL replacement carries the recorded repository forward so a
                    // non-marketplace overwrite cannot silently erase a marketplace install's
                    // source identity; publisher and signing key record what is actually
                    // being installed now.
                    repository_id: previous.and_then(|provenance| provenance.repository_id.clone()),
                    publisher: Some(manifest.publisher.clone()),
                    signing_key_id: match &signature {
                        PluginSignatureStatus::Trusted { key_id } => Some(key_id.clone()),
                        PluginSignatureStatus::Unsigned => None,
                    },
                    source,
                }
            }
        };
        let activation = PluginActivationRecord {
            sequence: current.as_ref().map_or(1, |record| record.sequence.saturating_add(1)),
            version: version_string,
            previous_version: previous_version.clone(),
            package_sha256: package_sha256.clone(),
            activated_at: Utc::now().to_rfc3339(),
            provenance: Some(provenance),
        };
        if let Err(error) = write_activation_record(&container_dir, &activation) {
            let _ = std::fs::remove_dir_all(&version_dir);
            let mut message = error;
            if let Some(backup) = &replaced_version_dir {
                if let Err(restore) = rename_with_transient_lock_retry(backup, &version_dir) {
                    message.push_str(&format!("; previous copy kept at {}: {restore}", backup.display()));
                }
            }
            return Err(message);
        }
        if let Some(backup) = replaced_version_dir {
            if let Err(error) = std::fs::remove_dir_all(backup) {
                log::warn!("Failed to remove replaced plugin version backup: {error}");
            }
        }
        if let Err(error) = prune_plugin_history(&container_dir, &activation) {
            log::warn!("Failed to prune plugin '{}' install history: {error}", manifest.id);
        }
        let plugin = InstalledPlugin::new(manifest, version_dir, &self.app_version)
            .with_provenance(activation.provenance.clone());
        Ok(PluginInstallResult { plugin, previous_version, package_sha256, signature, _update_guard: update_guard })
    }

    fn rollback_locked(&self, plugin_id: &str) -> Result<PluginRollbackResult, String> {
        let update_guard = self.lifecycle.as_ref().map(|lifecycle| lifecycle.begin_update(plugin_id)).transpose()?;
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
        let plugin = plugin.with_provenance(target_record.as_ref().and_then(|record| record.provenance.clone()));
        let activation = PluginActivationRecord {
            sequence: current.sequence.saturating_add(1),
            version: previous_version.clone(),
            previous_version: Some(current.version),
            package_sha256: target_record
                .as_ref()
                .map_or_else(|| "legacy-unmanaged".to_string(), |record| record.package_sha256.clone()),
            activated_at: Utc::now().to_rfc3339(),
            // Roll the target version's own provenance forward: a rollback re-activates that
            // version, so its recorded source identity is the truthful one to keep guarding with.
            provenance: target_record.as_ref().and_then(|record| record.provenance.clone()),
        };
        write_activation_record(&container_dir, &activation)?;
        if let Err(error) = prune_plugin_history(&container_dir, &activation) {
            log::warn!("Failed to prune plugin '{plugin_id}' rollback history: {error}");
        }
        Ok(PluginRollbackResult { plugin, previous_version, _update_guard: update_guard })
    }
}

/// `migrate_legacy_container` stores a migrated flat container under a synthetic
/// `0.0.0-legacy.<hash>` directory name while the manifest inside keeps its original version string, so
/// for those directories the name carries no version identity to compare against. Treating them as
/// unusable would drop them from `previous_version` and let `prune_plugin_history` delete the only copy
/// of that version. The plugin id check still applies to them: only the version identity is synthetic.
const LEGACY_STORAGE_VERSION_PREFIX: &str = "0.0.0-legacy.";

fn is_legacy_storage_version(version: &str) -> bool {
    version
        .strip_prefix(LEGACY_STORAGE_VERSION_PREFIX)
        .is_some_and(|suffix| suffix.len() == 12 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// True when `versions/<version>` has the manifest identity that this store location advertises.
/// `rollback_locked` rejects a parsed manifest whose id or version differs, so the installer must
/// not retain it as an active install or as a rollback target either. Legacy containers are the one
/// exception: their directory name is synthetic, so only the plugin id is checked against them.
fn version_dir_is_usable(version_dir: &Path, plugin_id: &str, version: &str) -> bool {
    std::fs::read(version_dir.join("manifest.json")).is_ok_and(|raw| {
        serde_json::from_slice::<PluginManifest>(&raw).is_ok_and(|manifest| {
            manifest.id == plugin_id && (manifest.version == version || is_legacy_storage_version(version))
        })
    })
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
                provenance: None,
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
        .truncate(false)
        .open(root_dir.join(INSTALL_LOCK_FILE))
        .map_err(|error| error.to_string())
}

// Antivirus scanners briefly hold handles on freshly extracted plugin binaries, which fails
// directory renames with ERROR_ACCESS_DENIED (5) or ERROR_SHARING_VIOLATION (32); the scan
// normally finishes well inside this retry window.
const TRANSIENT_LOCK_RETRY_DELAYS: [Duration; 3] =
    [Duration::from_millis(200), Duration::from_millis(400), Duration::from_millis(800)];

fn rename_with_transient_lock_retry(src: &Path, dst: &Path) -> std::io::Result<()> {
    retry_transient_lock(&TRANSIENT_LOCK_RETRY_DELAYS, || std::fs::rename(src, dst))
}

fn retry_transient_lock<T>(
    delays: &[Duration],
    mut operation: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    for delay in delays {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if cfg!(windows) && is_windows_lock_error(&error) => std::thread::sleep(*delay),
            Err(error) => return Err(error),
        }
    }
    operation()
}

fn is_windows_lock_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32))
}

/// Tombstone path for one logical uninstall: `.trash/<plugin id>`, or `.trash/<plugin id>-<n>`, the
/// same suffix convention `install_bytes_locked` uses for replaced versions, when an earlier
/// tombstone of that plugin is still waiting for its physical delete.
fn unique_plugin_tombstone(trash_dir: &Path, plugin_id: &str) -> PathBuf {
    let mut candidate = trash_dir.join(plugin_id);
    let mut suffix = 0u32;
    while candidate.exists() {
        suffix = suffix.saturating_add(1);
        candidate = trash_dir.join(format!("{plugin_id}-{suffix}"));
    }
    candidate
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
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};
    use zip::write::SimpleFileOptions;

    use super::{
        is_activation_record_file, read_install_identity, retry_transient_lock, sha256_hex,
        validate_package_expectation, PluginInstallPolicy, PluginPackageExpectation, PluginPackageInstaller,
        PluginSignatureStatus, PluginTrustStore, ACTIVATIONS_DIR, INSTALL_LOCK_FILE, PLUGIN_CHECKSUMS_FILE,
        PLUGIN_SIGNATURE_FILE, PLUGIN_TRASH_DIR, VERSIONS_DIR,
    };
    use crate::plugins::{PluginManifest, PluginRegistry};

    #[test]
    fn runtime_updates_and_rollbacks_preserve_active_connections_and_versions() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        let lifecycle = registry.lifecycle();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default())
                .with_lifecycle(lifecycle.clone());
        let first = package("1.0.0", None, false);
        let second = package("1.1.0", None, false);
        installer.install_bytes(&first, PluginInstallPolicy::LocalDevelopment).unwrap();
        let connection = lifecycle.begin_connection("sample.hello", "My connection").unwrap();
        for bytes in [&first, &second] {
            let error = installer.install_bytes(bytes, PluginInstallPolicy::LocalDevelopment).unwrap_err();
            assert!(error.contains("My connection"));
            assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
        }
        assert!(!root.path().join("sample.hello/versions/1.1.0").exists());
        drop(connection);

        let unrelated = lifecycle.begin_connection("other.plugin", "Unrelated connection").unwrap();
        let installed = installer.install_bytes(&second, PluginInstallPolicy::LocalDevelopment).unwrap();
        assert!(lifecycle.begin_connection("sample.hello", "New connection").is_err());
        assert!(lifecycle.begin_operation("sample.hello").is_err());
        drop(installed);
        let connection = lifecycle.begin_connection("sample.hello", "My connection").unwrap();
        assert!(installer.rollback("sample.hello").unwrap_err().contains("My connection"));
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.1.0");
        drop(connection);
        let rollback = installer.rollback("sample.hello").unwrap();
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
        assert!(lifecycle.begin_operation("sample.hello").is_err());
        drop(rollback);
        assert!(lifecycle.begin_connection("sample.hello", "Reconnected").is_ok());
        drop(unrelated);
    }

    #[test]
    fn runtime_install_file_and_signed_packages_share_the_update_guard() {
        let root = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        let lifecycle = registry.lifecycle();
        let signer = SigningKey::from_bytes(&[23; 32]);
        let trust = PluginTrustStore::from_base64_keys(BTreeMap::from([(
            "test".to_string(),
            base64::engine::general_purpose::STANDARD.encode(signer.verifying_key().as_bytes()),
        )]))
        .unwrap();
        let installer = PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", trust)
            .with_lifecycle(lifecycle.clone());
        installer
            .install_bytes(&package("1.0.0", Some((&signer, "test")), false), PluginInstallPolicy::LocalSigned)
            .unwrap();
        let bytes = package("1.1.0", Some((&signer, "test")), false);
        let package_path = root.path().join("update.dbxp");
        std::fs::write(&package_path, &bytes).unwrap();
        let operation = lifecycle.begin_operation("sample.hello").unwrap();
        assert!(installer
            .install_file(&package_path, PluginInstallPolicy::LocalSigned)
            .unwrap_err()
            .contains("active operations"));
        let expectation = PluginPackageExpectation {
            repository_id: None,
            id: "sample.hello".to_string(),
            version: "1.1.0".to_string(),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "test".to_string(),
        };
        assert!(installer
            .install_marketplace_bytes(&bytes, &expectation, false)
            .unwrap_err()
            .contains("active operations"));
        drop(operation);
        installer.install_marketplace_bytes(&bytes, &expectation, false).unwrap();
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.1.0");
    }

    #[test]
    fn failed_runtime_update_releases_the_admission_guard() {
        let root = tempfile::tempdir().unwrap();
        let lifecycle = crate::plugins::PluginLifecycle::default();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default())
                .with_lifecycle(lifecycle.clone());
        installer.install_bytes(&package("1.0.0", None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        assert!(installer.rollback("sample.hello").is_err());
        assert!(lifecycle.begin_connection("sample.hello", "Retry").is_ok());
        assert!(installer.install_bytes(&package("1.1.0", None, true), PluginInstallPolicy::LocalDevelopment).is_err());
        assert!(lifecycle.begin_update("sample.hello").is_ok());
    }

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
    fn local_development_reinstalls_same_version_without_creating_a_self_rollback() {
        let root = tempfile::tempdir().unwrap();
        let installer =
            PluginPackageInstaller::with_trust_store(root.path().to_path_buf(), "0.5.67", PluginTrustStore::default());
        let package = package("1.0.0", None, false);

        installer.install_bytes(&package, PluginInstallPolicy::LocalDevelopment).unwrap();
        let reinstalled = installer.install_bytes(&package, PluginInstallPolicy::LocalDevelopment).unwrap();

        assert_eq!(reinstalled.previous_version, None);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
        assert_eq!(std::fs::read_dir(root.path().join("sample.hello").join(VERSIONS_DIR)).unwrap().count(), 1);
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
    fn retains_a_legacy_version_directory_when_the_legacy_version_is_not_semver() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("sample.hello");
        std::fs::create_dir_all(legacy.join("bin")).unwrap();
        std::fs::write(legacy.join("bin/plugin"), b"legacy").unwrap();
        std::fs::write(
            legacy.join("manifest.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "id": "sample.hello",
                "name": "Hello legacy",
                "version": "0.9",
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

        // A non-semver legacy version is migrated under a synthetic `0.0.0-legacy.<hash>` directory that
        // the manifest inside does not repeat, so the retained copy must still be recognised as the
        // rollback target instead of being pruned away as an unknown version.
        assert!(
            installed.previous_version.is_some(),
            "the migrated legacy version must be retained as the rollback target"
        );
        let container = root.path().join("sample.hello");
        let versions = sorted_version_dirs(&container);
        let legacy_storage_version = versions.iter().find(|version| version.as_str() != "1.0.0").unwrap();
        assert_eq!(installed.previous_version.as_deref(), Some(legacy_storage_version.as_str()));
        let mut expected = vec!["1.0.0".to_string(), legacy_storage_version.clone()];
        expected.sort();
        assert_eq!(versions, expected);
        assert!(container.join(VERSIONS_DIR).join(legacy_storage_version).join("manifest.json").is_file());
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
            repository_id: None,
            id: "sample.hello".to_string(),
            version: "1.0.0".to_string(),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };
        let unsigned = package("1.0.0", None, false);
        assert!(installer.install_marketplace_bytes(&unsigned, &expectation, false).is_err());

        let signed = package("1.0.0", Some((&signing_key, "sample-key")), false);
        let result = installer.install_marketplace_bytes(&signed, &expectation, false).unwrap();
        assert_eq!(result.signature, PluginSignatureStatus::Trusted { key_id: "sample-key".to_string() });
    }

    #[test]
    fn local_installer_loads_official_keys_without_persisting_them() {
        let root = tempfile::tempdir().unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();

        assert!(installer.trust_store.keys.contains_key("dbx-store-release-2026"));
        assert!(installer.trust_store.keys.contains_key("dbx-store-preview-2026"));
        assert!(PluginTrustStore::list_base64_keys(root.path()).unwrap().is_empty());
        assert!(!root.path().join(".trust").exists());
    }

    #[test]
    fn local_installer_rejects_forged_official_signatures() {
        let root = tempfile::tempdir().unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();
        let forged_key = SigningKey::from_bytes(&[11u8; 32]);
        let package_path = root.path().join("forged.dbxp");
        std::fs::write(&package_path, package("1.0.0", Some((&forged_key, "dbx-store-release-2026")), false)).unwrap();

        for policy in [PluginInstallPolicy::LocalSigned, PluginInstallPolicy::LocalDevelopment] {
            let error = installer.install_file(&package_path, policy).unwrap_err();
            assert_eq!(error, "Plugin package signature verification failed");
        }
        assert!(!root.path().join("sample.hello").exists());
    }

    #[test]
    fn local_installer_preserves_custom_key_trust() {
        let root = tempfile::tempdir().unwrap();
        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes());
        PluginTrustStore::save_base64_key(root.path(), "sample-repository", &public_key).unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();
        let package_path = root.path().join("custom.dbxp");
        std::fs::write(&package_path, package("1.0.0", Some((&signing_key, "sample-repository")), false)).unwrap();

        let installed = installer.install_file(&package_path, PluginInstallPolicy::LocalSigned).unwrap();

        assert_eq!(installed.signature, PluginSignatureStatus::Trusted { key_id: "sample-repository".to_string() });
        assert!(installer.trust_store.keys.contains_key("dbx-store-release-2026"));
        assert_eq!(PluginTrustStore::list_base64_keys(root.path()).unwrap().len(), 1);
    }

    #[test]
    fn local_installer_rejects_unknown_signed_packages() {
        let root = tempfile::tempdir().unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();
        let signing_key = SigningKey::from_bytes(&[9u8; 32]);
        let package = package("1.0.0", Some((&signing_key, "unknown-release")), false);

        for policy in [PluginInstallPolicy::LocalSigned, PluginInstallPolicy::LocalDevelopment] {
            let error = installer.install_bytes(&package, policy).unwrap_err();
            assert_eq!(error, "Plugin package is signed by untrusted key 'unknown-release'");
        }
        assert!(!root.path().join("sample.hello").exists());
    }

    #[test]
    fn local_installer_rejects_official_key_conflicts() {
        let root = tempfile::tempdir().unwrap();
        let forged_key = SigningKey::from_bytes(&[11u8; 32]);
        let public_key = base64::engine::general_purpose::STANDARD.encode(forged_key.verifying_key().as_bytes());
        PluginTrustStore::save_base64_key(root.path(), "dbx-store-release-2026", &public_key).unwrap();

        let error = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67")
            .err()
            .expect("a custom key must not override an official signing key");

        assert!(error.contains("'dbx-store-release-2026' already exists with a different public key"));
    }

    #[test]
    fn local_installer_accepts_matching_official_keys() {
        let root = tempfile::tempdir().unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();
        let official_key = installer.trust_store.keys.get("dbx-store-release-2026").unwrap();
        let public_key = base64::engine::general_purpose::STANDARD.encode(official_key.as_bytes());
        PluginTrustStore::save_base64_key(root.path(), "dbx-store-release-2026", &public_key).unwrap();

        let reloaded = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();

        assert_eq!(reloaded.trust_store.keys.get("dbx-store-release-2026"), Some(official_key));
        assert_eq!(PluginTrustStore::list_base64_keys(root.path()).unwrap().len(), 1);
    }

    #[test]
    fn local_installer_enforces_unsigned_policy() {
        let root = tempfile::tempdir().unwrap();
        let installer = PluginPackageInstaller::new(root.path().to_path_buf(), "0.5.67").unwrap();
        let unsigned = package("1.0.0", None, false);

        assert!(installer.install_bytes(&unsigned, PluginInstallPolicy::LocalSigned).is_err());
        let installed = installer.install_bytes(&unsigned, PluginInstallPolicy::LocalDevelopment).unwrap();
        assert_eq!(installed.signature, PluginSignatureStatus::Unsigned);
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
            repository_id: None,
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

    fn signed_installer(root: &Path, seed: [u8; 32]) -> (PluginPackageInstaller, SigningKey) {
        let signing_key = SigningKey::from_bytes(&seed);
        let mut keys = BTreeMap::new();
        keys.insert(
            "sample-key".to_string(),
            base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().as_bytes()),
        );
        let installer = PluginPackageInstaller::with_trust_store(
            root.to_path_buf(),
            "0.5.67",
            PluginTrustStore::from_base64_keys(keys).unwrap(),
        );
        (installer, signing_key)
    }

    #[test]
    fn rejects_source_changed_update_unless_confirmed() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [21u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);
        let expectation = |repository: &str, version: &str| PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: version.to_string(),
            repository_id: Some(repository.to_string()),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        installer.install_marketplace_bytes(&signed("1.0.0"), &expectation("repo-a", "1.0.0"), false).unwrap();

        // The recorded install came from repo-a; a repo-b update needs the explicit confirmation.
        let rejected =
            installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("repo-b", "1.1.0"), false).unwrap_err();
        assert!(rejected.contains("source change requires confirmation"), "{rejected}");
        assert_eq!(read_install_identity(root.path(), "sample.hello").unwrap().unwrap().version, "1.0.0");

        let confirmed =
            installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("repo-b", "1.1.0"), true).unwrap();
        assert_eq!(
            confirmed.plugin.provenance.as_ref().and_then(|provenance| provenance.repository_id.clone()).as_deref(),
            Some("repo-b")
        );

        // A downgrade below the confirmed active version needs the same explicit confirmation.
        let downgraded =
            installer.install_marketplace_bytes(&signed("1.0.5"), &expectation("repo-b", "1.0.5"), false).unwrap_err();
        assert!(downgraded.contains("downgrade"), "{downgraded}");
    }

    #[test]
    fn rollback_carries_the_target_versions_provenance_forward() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [22u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);
        let expectation = |repository: &str, version: &str| PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: version.to_string(),
            repository_id: Some(repository.to_string()),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        installer.install_marketplace_bytes(&signed("1.0.0"), &expectation("repo-a", "1.0.0"), false).unwrap();
        installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("repo-b", "1.1.0"), true).unwrap();
        assert_eq!(installer.rollback("sample.hello").unwrap().previous_version, "1.0.0");

        // After rolling back to the repo-a version, the recorded provenance is repo-a again, so a
        // repo-a update proceeds without confirmation while repo-b still requires one.
        let identity = read_install_identity(root.path(), "sample.hello").unwrap().unwrap();
        assert_eq!(identity.version, "1.0.0");
        assert_eq!(identity.provenance.and_then(|provenance| provenance.repository_id), Some("repo-a".to_string()));
        installer.install_marketplace_bytes(&signed("1.2.0"), &expectation("repo-a", "1.2.0"), false).unwrap();
        let rejected =
            installer.install_marketplace_bytes(&signed("1.3.0"), &expectation("repo-b", "1.3.0"), false).unwrap_err();
        assert!(rejected.contains("source change requires confirmation"), "{rejected}");
    }

    /// Rewrites the newest activation record without its `provenance` field: the on-disk shape an
    /// activation written by a build that predates provenance has.
    fn strip_latest_activation_provenance(container: &Path) {
        let mut records = std::fs::read_dir(container.join(ACTIVATIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| is_activation_record_file(path))
            .collect::<Vec<_>>();
        records.sort();
        let path = records.pop().expect("activation record");
        let mut value: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert!(value.as_object_mut().unwrap().remove("provenance").is_some());
        std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
    }

    #[test]
    fn a_pre_provenance_activation_stays_unconstrained_until_the_next_install() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [23u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);
        let expectation = |repository: &str, version: &str| PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: version.to_string(),
            repository_id: Some(repository.to_string()),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        installer.install_marketplace_bytes(&signed("1.0.0"), &expectation("repo-a", "1.0.0"), false).unwrap();
        strip_latest_activation_provenance(&root.path().join("sample.hello"));

        // An activation record without provenance still parses (serde default) and records no source.
        let identity = read_install_identity(root.path(), "sample.hello").unwrap().unwrap();
        assert_eq!(identity.version, "1.0.0");
        assert!(identity.provenance.is_none());

        // Nothing was recorded, so the next install from any repository proceeds without a
        // confirmation and starts recording provenance again.
        let updated =
            installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("repo-b", "1.1.0"), false).unwrap();
        assert_eq!(
            updated.plugin.provenance.and_then(|provenance| provenance.repository_id).as_deref(),
            Some("repo-b")
        );
    }

    #[test]
    fn updating_a_plugin_leaves_its_data_directory_untouched() {
        let root = tempfile::tempdir().unwrap();
        // The registry root sits beside plugin-data/, exactly like the app layout, so
        // `PluginRegistry::plugin_data_dir("sample.hello")` resolves to the path below.
        let plugins_root = root.path().join("plugins");
        let (installer, signing_key) = signed_installer(&plugins_root, [24u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);
        let expectation = |repository: &str, version: &str| PluginPackageExpectation {
            id: "sample.hello".to_string(),
            version: version.to_string(),
            repository_id: Some(repository.to_string()),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        installer.install_marketplace_bytes(&signed("1.0.0"), &expectation("repo-a", "1.0.0"), false).unwrap();
        let data_dir = root.path().join("plugin-data").join("sample.hello");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::write(data_dir.join("state.json"), b"{\"rows\":1}").unwrap();

        installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("repo-a", "1.1.0"), false).unwrap();
        installer.rollback("sample.hello").unwrap();

        // Plugin user data lives outside the versioned container and must survive update + rollback.
        assert_eq!(std::fs::read(data_dir.join("state.json")).unwrap(), b"{\"rows\":1}");
    }

    fn activation_record_count(container: &Path) -> usize {
        std::fs::read_dir(container.join(ACTIVATIONS_DIR))
            .unwrap()
            .filter(|entry| entry.as_ref().is_ok_and(|entry| is_activation_record_file(&entry.path())))
            .count()
    }

    fn sorted_version_dirs(container: &Path) -> Vec<String> {
        let mut versions = std::fs::read_dir(container.join(VERSIONS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        versions.sort();
        versions
    }

    #[test]
    fn reinstalls_retained_rollback_version_after_rollback_under_signed_policy() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [13u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);
        let expectation = |version: &str| PluginPackageExpectation {
            repository_id: None,
            id: "sample.hello".to_string(),
            version: version.to_string(),
            publisher: "sample".to_string(),
            permissions: BTreeSet::from(["host.events".to_string()]),
            signing_key_id: "sample-key".to_string(),
        };

        installer.install_marketplace_bytes(&signed("1.0.0"), &expectation("1.0.0"), false).unwrap();
        installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("1.1.0"), false).unwrap();
        assert_eq!(installer.rollback("sample.hello").unwrap().previous_version, "1.0.0");

        // 1.1.0 is installed but inactive after the rollback: reinstalling it has to replace the
        // retained directory instead of failing with "already installed".
        let reinstalled = installer.install_marketplace_bytes(&signed("1.1.0"), &expectation("1.1.0"), false).unwrap();

        assert_eq!(reinstalled.previous_version.as_deref(), Some("1.0.0"));
        let container = root.path().join("sample.hello");
        assert_eq!(sorted_version_dirs(&container), ["1.0.0", "1.1.0"]);
        assert_eq!(activation_record_count(&container), 2);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.1.0");
        assert_eq!(installer.rollback("sample.hello").unwrap().previous_version, "1.0.0");
    }

    #[test]
    fn rejects_reinstall_of_active_version_without_touching_the_store() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [19u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);

        installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();
        let error = installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap_err();

        assert!(error.contains("is already installed"), "{error}");
        let container = root.path().join("sample.hello");
        assert_eq!(sorted_version_dirs(&container), ["1.0.0"]);
        assert_eq!(activation_record_count(&container), 1);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn reinstalls_active_version_whose_manifest_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [23u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);

        installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();
        let container = root.path().join("sample.hello");
        let version_dir = container.join(VERSIONS_DIR).join("1.0.0");
        std::fs::remove_file(version_dir.join("manifest.json")).unwrap();

        let repaired = installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();

        assert_eq!(repaired.previous_version, None);
        assert!(version_dir.join("manifest.json").is_file());
        assert_eq!(sorted_version_dirs(&container), ["1.0.0"]);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn reinstalls_active_version_whose_manifest_identity_is_wrong() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [27u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);

        installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();
        let container = root.path().join("sample.hello");
        let version_dir = container.join(VERSIONS_DIR).join("1.0.0");
        let manifest_path = version_dir.join("manifest.json");
        let mismatched_manifest = std::fs::read_to_string(&manifest_path)
            .unwrap()
            .replace("\"version\": \"1.0.0\"", "\"version\": \"1.0.1\"");
        std::fs::write(&manifest_path, mismatched_manifest).unwrap();

        // A parseable manifest with the wrong identity cannot be activated or rolled back to, so
        // it must be repaired rather than satisfying the already-installed guard.
        let repaired = installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();

        assert_eq!(repaired.previous_version, None);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn does_not_record_a_rollback_target_whose_directory_is_missing() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [29u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);

        installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();
        installer.install_bytes(&signed("1.1.0"), PluginInstallPolicy::LocalSigned).unwrap();
        assert_eq!(installer.rollback("sample.hello").unwrap().previous_version, "1.0.0");

        let container = root.path().join("sample.hello");
        std::fs::remove_dir_all(container.join(VERSIONS_DIR).join("1.0.0")).unwrap();

        let recovered = installer.install_bytes(&signed("1.1.0"), PluginInstallPolicy::LocalSigned).unwrap();

        assert_eq!(recovered.previous_version, None);
        assert_eq!(sorted_version_dirs(&container), ["1.1.0"]);
        let registry = PluginRegistry::new_with_app_version(root.path().to_path_buf(), "0.5.67");
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.1.0");
        assert!(installer.rollback("sample.hello").unwrap_err().contains("does not have a rollback version"));
    }

    #[test]
    fn reinstalls_orphan_version_directory_without_activation_record() {
        let root = tempfile::tempdir().unwrap();
        let (installer, signing_key) = signed_installer(root.path(), [31u8; 32]);
        let signed = |version: &str| package(version, Some((&signing_key, "sample-key")), false);

        installer.install_bytes(&signed("1.0.0"), PluginInstallPolicy::LocalSigned).unwrap();
        let container = root.path().join("sample.hello");
        let orphan = container.join(VERSIONS_DIR).join("1.1.0");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("stale.txt"), b"interrupted").unwrap();

        let installed = installer.install_bytes(&signed("1.1.0"), PluginInstallPolicy::LocalSigned).unwrap();

        assert_eq!(installed.previous_version.as_deref(), Some("1.0.0"));
        assert!(!orphan.join("stale.txt").exists());
        assert_eq!(sorted_version_dirs(&container), ["1.0.0", "1.1.0"]);
        assert_eq!(activation_record_count(&container), 2);
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

    #[test]
    #[cfg(windows)]
    fn transient_lock_retry_recovers_from_windows_lock_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        for code in [5, 32] {
            let attempts = AtomicUsize::new(0);
            let result = retry_transient_lock(&[Duration::ZERO, Duration::ZERO, Duration::ZERO], || {
                if attempts.fetch_add(1, Ordering::SeqCst) < 2 {
                    Err(std::io::Error::from_raw_os_error(code))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_ok());
            assert_eq!(attempts.load(Ordering::SeqCst), 3);
        }
    }

    #[test]
    #[cfg(windows)]
    fn transient_lock_retry_returns_last_error_after_exhausting_delays() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(5))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(5));
    }

    #[test]
    fn transient_lock_retry_does_not_retry_other_errors() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO; 3], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(2))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(2));
    }

    #[test]
    #[cfg(unix)]
    fn transient_lock_retry_treats_windows_lock_codes_as_final_on_unix() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        // Raw code 5 on Unix is EIO, not a Windows lock error, so the retry gate must leave it final.
        let attempts = AtomicUsize::new(0);
        let result: std::io::Result<()> = retry_transient_lock(&[Duration::ZERO; 3], || {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err(std::io::Error::from_raw_os_error(5))
        });
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert_eq!(result.unwrap_err().raw_os_error(), Some(5));
    }

    /// Sorted `.trash` entries, so tombstone assertions are deterministic.
    fn trash_entries(root: &Path) -> Vec<String> {
        let mut names = std::fs::read_dir(root.join(PLUGIN_TRASH_DIR))
            .map(|entries| {
                entries
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// Installs `sample.hello` into a store rooted at `<temp>/plugins`, so `<temp>/plugin-data`
    /// sits next to it exactly like the real registry layout does.
    fn uninstall_fixture(temp: &tempfile::TempDir, version: &str) -> (PluginPackageInstaller, PathBuf) {
        let root = temp.path().join("plugins");
        let installer = PluginPackageInstaller::with_trust_store(root.clone(), "0.5.67", PluginTrustStore::default());
        installer.install_bytes(&package(version, None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        (installer, root)
    }

    #[test]
    fn uninstall_commits_logically_and_sweeps_its_own_tombstone() {
        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");
        let plugin_data = temp.path().join("plugin-data").join("sample.hello");
        std::fs::create_dir_all(&plugin_data).unwrap();
        std::fs::write(plugin_data.join("preferences.json"), "{}").unwrap();
        let container = root.join("sample.hello");
        assert!(container.join(VERSIONS_DIR).join("1.0.0").join("manifest.json").is_file());

        installer.uninstall("sample.hello").unwrap();

        assert!(!container.exists(), "the official container must be gone");
        assert!(trash_entries(&root).is_empty(), "a successful uninstall sweeps its own tombstone");
        assert!(root.join(INSTALL_LOCK_FILE).is_file(), "the store lock file stays in place");
        assert!(plugin_data.join("preferences.json").is_file(), "plugin data survives an uninstall");
        let registry = PluginRegistry::new_with_app_version(root, "0.5.67");
        assert!(registry.list_installed().unwrap().is_empty());
        assert!(registry.find_plugin("sample.hello").unwrap().is_none());

        // Uninstalling a plugin that is already gone stays idempotent.
        installer.uninstall("sample.hello").unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn uninstall_retries_transient_windows_locks_on_the_commit_rename() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");
        let attempts = AtomicUsize::new(0);
        installer
            .uninstall_with_ops(
                "sample.hello",
                &[Duration::ZERO, Duration::ZERO, Duration::ZERO],
                |src: &Path, dst: &Path| match attempts.fetch_add(1, Ordering::SeqCst) {
                    0 => Err(std::io::Error::from_raw_os_error(5)),
                    1 => Err(std::io::Error::from_raw_os_error(32)),
                    _ => std::fs::rename(src, dst),
                },
                |path: &Path| std::fs::remove_dir_all(path),
            )
            .unwrap();

        assert_eq!(attempts.load(Ordering::SeqCst), 3, "two lock errors then one successful rename");
        assert!(!root.join("sample.hello").exists());
        assert!(trash_entries(&root).is_empty());
    }

    #[test]
    fn uninstall_reports_a_clean_failure_and_keeps_the_container_when_the_rename_keeps_failing() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");
        let container = root.join("sample.hello");
        let attempts = AtomicUsize::new(0);
        let error = installer
            .uninstall_with_ops(
                "sample.hello",
                &[Duration::ZERO, Duration::ZERO, Duration::ZERO],
                |_: &Path, _: &Path| {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err(std::io::Error::from_raw_os_error(32))
                },
                |path: &Path| std::fs::remove_dir_all(path),
            )
            .unwrap_err();

        assert!(error.contains("Failed to uninstall plugin 'sample.hello'"), "{error}");
        assert_eq!(attempts.load(Ordering::SeqCst), if cfg!(windows) { 4 } else { 1 });
        // A failed logical commit must leave the container exactly as it was: the plugin has to
        // stay installed, discoverable, and loadable after a restart.
        assert!(container.join(VERSIONS_DIR).join("1.0.0").join("manifest.json").is_file());
        assert_eq!(activation_record_count(&container), 1);
        assert!(trash_entries(&root).is_empty(), "a failed commit must not leave a tombstone behind");
        let registry = PluginRegistry::new_with_app_version(root, "0.5.67");
        assert_eq!(registry.list_installed().unwrap().len(), 1);
        assert_eq!(registry.find_plugin("sample.hello").unwrap().unwrap().manifest.version, "1.0.0");
    }

    #[test]
    fn uninstall_stays_a_logical_success_when_the_tombstone_cannot_be_deleted() {
        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");

        installer
            .uninstall_with_ops(
                "sample.hello",
                &[Duration::ZERO, Duration::ZERO, Duration::ZERO],
                |src: &Path, dst: &Path| std::fs::rename(src, dst),
                |_: &Path| Err(std::io::Error::from_raw_os_error(32)),
            )
            .unwrap();

        assert!(!root.join("sample.hello").exists());
        assert_eq!(trash_entries(&root), vec!["sample.hello".to_string()]);
        let registry = PluginRegistry::new_with_app_version(root, "0.5.67");
        assert!(registry.list_installed().unwrap().is_empty());
        assert!(registry.find_plugin("sample.hello").unwrap().is_none());
    }

    #[test]
    fn install_and_uninstall_sweep_tombstones_left_by_an_earlier_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");
        let stale = root.join(PLUGIN_TRASH_DIR).join("sample.hello");
        std::fs::create_dir_all(stale.join(VERSIONS_DIR).join("1.0.0")).unwrap();
        std::fs::write(stale.join(VERSIONS_DIR).join("1.0.0").join("manifest.json"), "{}").unwrap();

        installer.install_bytes(&package("1.1.0", None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        assert!(!stale.exists(), "an install sweeps leftovers of an earlier uninstall");

        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("leftover.bin"), b"still locked").unwrap();
        installer.uninstall("sample.hello").unwrap();
        assert!(!root.join("sample.hello").exists());
        assert!(!stale.exists(), "an uninstall sweeps old tombstones as well");
    }

    #[test]
    fn tombstone_containers_are_never_discovered_as_installed_plugins() {
        let temp = tempfile::tempdir().unwrap();
        let (installer, root) = uninstall_fixture(&temp, "1.0.0");
        let tombstone = root.join(PLUGIN_TRASH_DIR).join("sample.hello");
        std::fs::create_dir_all(root.join(PLUGIN_TRASH_DIR)).unwrap();
        std::fs::rename(root.join("sample.hello"), &tombstone).unwrap();
        // The tombstone still holds a complete container: versions/, activations/, manifest.json.
        assert!(tombstone.join(VERSIONS_DIR).join("1.0.0").join("manifest.json").is_file());
        assert_eq!(activation_record_count(&tombstone), 1);

        let registry = PluginRegistry::new_with_app_version(root.clone(), "0.5.67");
        assert!(registry.list_installed().unwrap().is_empty());
        assert!(registry.find_plugin("sample.hello").unwrap().is_none());

        // The store stays usable: a reinstall does not collide with the pending tombstone.
        installer.install_bytes(&package("1.0.0", None, false), PluginInstallPolicy::LocalDevelopment).unwrap();
        assert_eq!(registry.list_installed().unwrap().len(), 1);
    }
}
